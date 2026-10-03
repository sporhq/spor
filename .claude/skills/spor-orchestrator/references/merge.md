# Gate + merge, and the Spor-repo specifics

This is the orchestrator's merge step: how to take a finished agent's branch and
land it on `main` safely. Read this when an agent's node has been resolved on the
graph and you're ready to merge its worktree branch.

This flow is written to be executed by a **sonnet** merge subagent: every step
is either mechanical or verdict-shaped, and the moments that need real judgment
(a semantic rebase conflict, a review finding without an obvious small fix) exit
via `ESCALATE` instead of improvisation. If you're the subagent and a step
demands understanding you don't have, escalate — a wrong merge costs far more
than a bounced one.

**Run every step in the FOREGROUND, in one continuous pass.** Never background
a test suite, spawn a Monitor, or end your turn "waiting" for anything — a
merge subagent that pauses has no one to wake it, so it stalls indefinitely and
the orchestrator has to nudge it by hand (this was ~1/3 of merge subagents
before this rule, issue-spor-orchestrator-merge-subagent-stall). A long
`npm test` is still a foreground command — run it and read its exit. Your turn
ends exactly once, at the tight verdict (`MERGED`/`FAILED`/`ESCALATE`), never
before.

**Only ever kill processes you started — by the PID or process group you
recorded, never by pattern.** If you detach a long suite to a log (step 6),
give it its own group and record it — `setsid sh -c 'npm test > "$1" 2>&1;
echo "EXIT=$?" >> "$1"' sh "$LOG" & echo $! > "$LOG.pgid"` — and stop it with
`kill -- -"$(cat "$LOG.pgid")"`. Never `pkill -f`, `killall`, `pkill node`, or
`kill $(pgrep …)`: implementers' suites run concurrently on this box in their
own worktrees, and a pattern like `pkill -f "node --test"` kills theirs too
(issue-spor-orchestrator-agent-global-pkill-kills-other-agents). A process you
did not start that looks hung goes in your verdict, not under your `kill`.

## Why CAS, and why serialized

Agents implement in parallel, but you merge **one branch at a time**. The reason
to serialize your own merges is simple: it keeps `main` coherent and lets you run
the verification gate against a known tip. The reason to use a compare-and-swap
(`git update-ref`) rather than a plain push/fast-forward is that spor and
spor-server `main` are **contended** — other people and jobs move them out from
under you. CAS makes "merge onto the main I just tested" atomic: if main moved,
the swap fails and you re-rebase instead of clobbering someone's commit.

## The flow (per finished branch)

Run from the main checkout, not the worktree. `BR` is the agent's branch (= node
id, sanitized by dispatch).

1. **Rebase onto committed main.** Bring the branch up to the current tip so the
   merge is a fast-forward and the tests run against what main actually is.

   ```bash
   git fetch                      # if a remote moves main; skip in pure-local setups
   git -C <worktree> rebase main  # or: rebase onto origin/main, per your setup
   ```

   A rebase conflict you can't resolve mechanically → re-dispatch the agent to
   rebase and fix in its worktree, or escalate. Don't hand-resolve a semantic
   conflict you don't understand.

2. **Fast/targeted tests.** Run the tests that exercise this change — the full
   suite is the post-merge check, not the gate (it's too slow to serialize every
   merge behind). For this repo that's the relevant `node --test test/<x>.test.js`
   files; for a change touching the kernel or schema, include the conformance
   goldens.
   Before running them, read any test the change adds or edits that invokes an
   ops script (`scripts/*.sh`, prune/ack/erase, anything taking `--apply`): it
   must point every root it touches at a `mkdtemp` through an override the
   script honours, put stubs for every external binary it calls (`docker`,
   `fly`, `systemctl`, `sudo`, …) first on `PATH`, and pass `--no-restart` where
   offered. A test that would reach this box's real `/tmp`, Docker daemon, graph
   home or running server — including through a root the script hardcodes — is
   `FAILED` back to the implementer UNRUN: running it to find out is the damage
   (issue-spor-implementer-ran-destructive-host-script-during-test).

3. **The rigorous review lives HERE — run it ONCE on Codex (cross-model), gated
   behind step 2.** The implementer did only a *right-sized* `medium` self-review
   (see `agent-prompt.md`), so the merge gate is the single place the adversarial
   pass runs. Run it on **Codex (GPT-5.5)** rather than Claude `/code-review`: a
   different model reviewing Claude's code catches bug classes a same-model pass
   won't, AND it moves this token-heavy step onto the Codex subscription. **Pipe the
   diff into `codex exec` with a focused prompt** — NOT `codex exec review --base`
   (in codex v0.142.2 `--base` rejects a custom `[PROMPT]`, and the prompt-less
   `--base` form wanders the whole repo and exhausts its budget before emitting a
   verdict — observed at the inc-5 gate). The bounded piped form (≈18k tokens on a
   small diff, read-only so it can't edit) is the working shape:

       git -C <worktree> diff main...HEAD | codex exec -m gpt-5.5 -s read-only \
         -C <worktree> "Review the diff on stdin for correctness + security bugs
         ONLY: data-loss/durability, auth/identity, JWT/crypto, concurrency,
         streaming, error-envelope/contract regressions. Do NOT modify files.
         Cite file:line; end with a findings list or 'NO BUGS FOUND'."

   **Gate it behind step 2** — never review a red tree. Run it ONCE: *you*
   adjudicate Codex's findings, conservatively — fix a finding only when the fix
   is small, obviously correct, and re-verified by the tests; proceed on nits.
   Refuting a false positive or fixing anything deeper takes context a merge
   agent doesn't have — return `ESCALATE` with the finding rather than guessing
   in either direction. If a finding is real but not safely fixable here,
   `FAILED at code-review: <bug>`. This is also where a rebase that pulled in
   conflicts-of-meaning surfaces. (Fallback: if `codex` is unavailable/errors, run Claude's
   `/code-review` at **high** effort, escalating to `ultra` only for a risk-surface
   or large/novel diff.) Concentrating the depth here — one cross-model adversarial
   pass per increment, on the exact tree about to land, behind the cheap
   deterministic gate — is the token-for-quality trade.

4. **Land — ancestry guard + CAS, never INTO a checkout.** Land with the
   landing script, which lives only in the **spor client repo** (`<spor-repo>`
   below — e.g. `~/repos/spor` on this machine), so invoke it by that path
   whichever repo you are landing in:

   ```bash
   NEW=$(git -C <worktree> rev-parse HEAD)     # rebased branch tip
   git log main.."$NEW"   # sanity check by eye: should list only THIS branch's own commits
   <spor-repo>/.claude/skills/spor-orchestrator/scripts/land.sh --repo <shared root> --tip "$NEW"
   ```

   It prints one verdict line and does, in order:

   - **The ancestry guard** (mandatory, built in): `$NEW` must descend from
     main's current tip `$OLD` (`git merge-base --is-ancestor`).
     `update-ref <ref> <new> <old>` only asserts main is **still at** `$OLD` —
     it says nothing about whether `$NEW` builds on it, so a skipped or
     wrong-base rebase would CAS successfully and silently **rewind** main.
     That happened for real: a wave-7 merge subagent CAS'd spor `main` from
     `68b944e` to `9cb447a` (based on `8ebb3b6`, six commits behind) and main
     lost six wave-6 commits until the orchestrator re-CAS'd
     (issue-spor-orchestrator-merge-cas-lacks-ancestry-check). `REFUSED
     reason=not-descendant` → go back to step 1, never swap anyway.
   - **Parks any checkout that has main checked out** — detached at its OWN
     current commit (`git checkout --detach`, no commit argument: HEAD stops
     following main; index and working tree are untouched, nothing is
     discarded). This is what retired `scripts/heal-stale-root.js`: `update-ref`
     moves the ref and nothing else, so a checkout left ON main kept the old
     commit's content and `git status` showed every merged file as modified —
     indistinguishable from live WIP — and a hand-commit from it reverted merged
     work three times (inc-spor-npm-release-stale-index-revert-4801b52,
     inc-spor-triple-checkout-stale-revert-075adb2,
     inc-spor-orchestrator-stale-root-revert-26c9ef9). A parked checkout's
     `git status` is still exactly its own WIP, and a commit made there is off
     the old base — which the next land's ancestry guard refuses instead of
     silently reverting. The verdict line lists what it parked (`parked=…`).
   - **The CAS**: `git update-ref refs/heads/main "$NEW" "$OLD"`. `REFUSED
     reason=moved` → main moved under you: go back to step 1 (re-rebase onto
     the new main) and retry. This loop is the whole point — it's safe under
     concurrent committers. (A checkout parked before the refusal stays parked,
     listed in `parked=` — consistent, just detached.)
   - **Advances each parked checkout to `$NEW`** — and the shared root on
     every later land too, since it is already detached on main's line — with
     `git checkout --detach "$NEW"` — git's own checkout, which carries local changes to paths the
     land didn't touch and refuses the WHOLE checkout, writing nothing, when a
     change would be overwritten. It has to advance: `spor dispatch
     --worktree` cuts every new agent branch from the shared root's HEAD, so a
     root frozen at the first land would base every later dispatch on stale
     code. A checkout git refused is left detached at its old commit
     (consistent, only behind), listed as `behind=…`, and retried by the next
     land. A root a human detached onto their OWN commit (not an ancestor of
     main) is never moved.

   Exit 0 `LANDED`/`NOOP`; exit 1 `REFUSED reason=…` means main did not move.
   Keep the verdict line's `old=` as `$OLD` — step 6 and the reconcile use it.

5. **No root sync step — and no healer.** Never `git reset --hard` a shared
   checkout. Step 4 already left the shared root (and any checkout that
   followed main) either at `$NEW` or, where git refused, consistently
   detached behind it. A `behind=`
   checkout is not a merge failure: note it in your report for a human (whose
   local changes are in the way), and do not touch its paths. A root that was
   ALREADY stale before this land (left on main by a pre-`land.sh` ref-only
   merge) carries its stale blobs as local changes through the advance or is
   left behind; report it the same way rather than trying to clean it.

6. **Full `npm test` after the merge — in a fresh detached worktree, never the
   shared root.** Fold it into the land with `--verify` (step 4's command plus
   the flag), which checks the landed tip out into a throwaway detached
   worktree, runs the command there, and removes the worktree on success:

   ```bash
   <spor-repo>/.claude/skills/spor-orchestrator/scripts/land.sh --repo <shared root> --tip "$NEW" --verify "npm test"
   ```

   (Or run it yourself: `git worktree add --detach <dir> "$NEW"`, `npm test`
   there, then `git worktree remove <dir>`.) The worktree is bare: spor is
   zero-dep, but a repo with dependencies (spor-server) must stage them in the
   command — `--verify "<its worktreeSetup script> && npm test"` — or a
   missing `node_modules` reads as a regression. For a suite that may outlast the
   Bash tool's 10-minute cap, land without `--verify`, then run the suite in
   your own detached worktree detached-to-a-log and poll it in the foreground.
   `VERIFY-FAILED … worktree=<dir>` (exit 3) means the swap LANDED and the
   suite is red: you merged a regression — revert and re-dispatch the agent to
   fix, rather than leaving main broken. `git update-ref refs/heads/main "$OLD"
   "$NEW"` is only safe if `main` is STILL at `$NEW` (re-check `git rev-parse
   main` first — another committer may have advanced it since your CAS landed);
   if it moved, use `git revert` instead so you don't clobber their commit.
   Remove the kept `<dir>` worktree once you've read the failure.

   Once it's green, **reconcile the landed range** — the commits you just put on
   `main` may carry `Spor:` trailers naming OTHER open items (a drive-by fix, a
   follow-up folded in), which otherwise stay open forever because nothing writes
   their resolver (task-spor-landing-detect-shipped-resolver-draft):

   ```bash
   spor reconcile-landed --dir <shared root> --ref main --since "$OLD"   # $OLD = the verdict line's old=
   ```

   It only DRAFTS: each open task/issue a newly reachable commit names gets an
   unlinked `art-shipped-*` draft and a `find-shipped-on-main-*` finding; it
   never flips a status. The merged item itself is already resolved and is
   skipped. List any `filed:` finding ids in your report so the orchestrator can
   batch-confirm them (`spor reconcile-landed --confirm <ids…>`) or dismiss the
   ones where the commit only relates to the item. A failure here is not a merge
   failure — note it and move on.

7. **Clean up — ONLY the exact worktree you just merged.** Never target any
   other worktree, never glob or "clean up everything", and never force past
   uncommitted changes — issue-spor-orchestrator-cleanup-worktree-leak was
   exactly a cleanup routine hard-resetting a DIFFERENT agent's still-active
   worktree. Before removing, verify it's clean:

   ```bash
   git -C <worktree> status --porcelain   # must be EMPTY — refuse otherwise
   git worktree remove <worktree>         # never --force past a non-empty status
   git branch -D <BR>                     # optional; keep if you want the history handle
   ```

   If `status --porcelain` is non-empty, STOP and return `ESCALATE: worktree
   <worktree> has uncommitted changes post-merge` instead of forcing the
   removal — a dirty worktree at this point means something unexpected
   happened (a stray write, a concurrent session, the wrong path), never
   something safe to discard.

## Worktree prep: `dispatch.worktreeSetup`

A fresh worktree has no `node_modules`. The client (spor) is **zero-dep**, so its
worktrees need nothing. spor-server is **not** — its worktrees need
`node_modules` to run anything. Configure a `dispatch.worktreeSetup` hook (a
script path or command, in the target repo's committable `.spor.json` or your
machine-local config) that preps each worktree. It runs with `cwd=worktree` and
`SPOR_WORKTREE` / `SPOR_MAIN_CHECKOUT` / `SPOR_DISPATCH_SLUG|NODE` in the env —
e.g. symlink `node_modules` from the main checkout, and write a
`.claude/settings.local.json` with the env the agent needs. Without this, a
spor-server agent's tests fail for want of dependencies, not for want of correct
code — a false negative that wastes a whole dispatch.

## The `file:`-link cross-repo constraint

spor-server resolves the client `lib/` by a **`file:` link to the real checkout**
(`$SPOR_LIB` → `~/repos/spor/lib`), not to a worktree. So a change that must touch
*both* the client `lib/` and the server in lockstep **cannot** be validated inside
an isolated worktree: the server in the worktree still reads the client `lib/`
from the shared tree, so the two halves never see each other's edits.

Handle these items specially in the orchestrator:

- **Detect** them up front — the briefing spans both repos, or the change touches
  client `lib/` *and* server code together.
- **Run them solo, on the real checkout** (`--no-worktree`), with no other agent
  active in that repo at the same time, so the coordinated edit is internally
  consistent.
- A server-*only* change is fine in a worktree **if** the `worktreeSetup` hook
  symlinks `server/node_modules` — it's only the lockstep client+server change
  that has to serialize on the real tree.

When in doubt, an agent that discovers mid-task that its item is actually a
coordinated cross-repo change will leave the node unresolved and defer the
blocker (see `assets/agent-prompt.md`). Treat that as the signal to re-run the
item solo, not as a failure.

This is only the *lockstep* case. An item whose acceptance merely lists a file in
a second repo — halves that each pass their own suite with the other absent — is
not serialized but **split** into per-repo sibling items at selection time
(SKILL.md "Picking non-overlapping work"); a second worktree in the other repo is
never the answer, since its branch would sit outside the orchestrator's run table.

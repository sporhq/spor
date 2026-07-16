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

4. **CAS merge.** Fast-forward `main` to the rebased branch tip, but only if main
   is still where you tested:

   ```bash
   OLD=$(git rev-parse main)
   NEW=$(git -C <worktree> rev-parse HEAD)     # rebased branch tip
   git update-ref refs/heads/main "$NEW" "$OLD"  # fails if main moved
   ```

   If `update-ref` fails, main moved under you: go back to step 1 (re-rebase onto
   the new main) and retry. This loop is the whole point — it's safe under
   concurrent committers.

5. **Sync the shared root.** `update-ref` just moved the ref — the shared
   checkout's index and working tree still hold the old commit's content, which
   `git status` cannot tell apart from a parallel job's live WIP
   (norm-spor-orchestrator-cas-merge). Never blind `git reset --hard main` here;
   run the surgical heal instead — dry run first, `--apply` only once it
   confirms every modified path is safely behind HEAD
   (dec-spor-orchestrator-stale-root-heal-by-identity). The script itself lives
   only in the **spor client repo** (`<spor-repo>` below — e.g. `~/repos/spor`
   on this machine), not in spor-server or control-plane, so always invoke it
   by that path regardless of which repo's shared root you're syncing:

   ```bash
   node <spor-repo>/scripts/heal-stale-root.js --repo <shared root>            # dry run
   ```

   - Exit 0, verdict `IN-SYNC` → nothing was modified; the root already matches
     main.
   - Exit 1, verdict `STALE` → every modified path is stale-not-novel and safe
     to heal; re-run with `--apply` to actually check them out:
     ```bash
     node <spor-repo>/scripts/heal-stale-root.js --repo <shared root> --apply
     ```
     (exit 0 verdict `HEALED` on success).
   - Exit 1, verdict `ROOT-UNSYNCED` or `UNVERIFIED`, or exit 2 → real WIP is
     present, or the guard couldn't confirm the root either way. Do **not**
     reset, heal further, or touch those paths — leave the shared root as-is.
     This is not a merge failure (the CAS swap already succeeded); note it in
     your report so a human can look, and verify THIS merge in a throwaway
     detached worktree instead (`git worktree add --detach <dir> main`, per
     norm-spor-orchestrator-cas-merge) rather than trusting the stale shared
     root for step 6 below.

6. **Full `npm test` after the merge.** This is the safety net that catches what
   the targeted tests didn't. Run it from the shared root once step 5 confirms
   `IN-SYNC`/`HEALED`; otherwise run it in the throwaway detached worktree from
   step 5 instead, since the shared root can't be trusted to reflect `main` yet.
   If it's red, you merged a regression — revert the merge (`git update-ref`
   back to `$OLD`, or `git revert`) and re-dispatch the agent to fix, rather
   than leaving main broken.

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

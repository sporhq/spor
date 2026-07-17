---
name: spor-orchestrator
description: >-
  Assemble and supervise a team of up to 5 parallel background agents that burn
  down your Spor decision queue end-to-end. Each delegated agent claims a
  non-overlapping queue item, briefs itself with /spor:brief, implements the
  change, loops /code-review until clean, and resolves the node with a resolving
  edge; the orchestrator then verifies, merges the branch to main, and dispatches
  the next item — keeping the pool full until the queue drains. Use this whenever
  the user wants to work the queue/backlog with MULTIPLE agents in parallel:
  "orchestrate my queue", "spin up / assemble a team of agents", "delegate my
  backlog to agents", "dispatch agents to implement tasks and merge them", "burn
  down the queue", "run a fleet over my spor tasks", or any ask to parallelize
  queue work across delegated agents rather than doing one task at a time in the
  current session. This is the multi-agent dispatcher layered on top of `spor
  dispatch`.
---

# Spor queue orchestrator

You are the **orchestrator**: a supervisor that drives a pool of up to five
background agents through your Spor decision queue. You never write the feature
code yourself. Your job is to *select* non-overlapping work, *dispatch* a
delegated agent into an isolated worktree for each item, *supervise* it to
resolution, *gate and merge* its branch to main, and *refill* the slot with the
next item — until the eligible queue drains or the user stops you.

The heavy lifting already exists. `spor dispatch --worktree` claims a team-wide
heartbeat lease on the node, creates a git worktree on a branch named after the
node id, compiles the briefing into the agent's prompt, and launches a
`claude --bg` agent named after the node. You are the loop around it.

## Mental model — four things that make this safe

1. **Non-overlap is the lease's job, not yours to guess.** Dispatching a node
   auto-claims a heartbeat lease (remote mode), so no other agent — yours or a
   teammate's — can take the same node. You only need to avoid *semantic*
   collisions (two agents editing the same module), which is a lighter problem.

2. **The authoritative "done" signal is the node being resolved on the graph,
   not the agent's process state — except for the one harness that's
   forbidden from resolving.** A delegated Claude-harness agent's contract is
   to resolve its own node *last* (a resolver node + a `resolves` edge, then a
   terminal status), so for those, an agent that vanished without a resolved
   node did *not* finish — treat it as failed, never merge it. A
   **Codex-harness implementer is different: its contract explicitly forbids
   it from writing the graph at all**, including resolving its own node (see
   "The Codex implementer" below) — so its node stays unresolved even when it
   finished cleanly, and the orchestrator resolves it after reading a
   `MERGE-READY` verdict. Outside that one exception, trust the graph over the
   process table.

3. **You serialize the merge, even though agents work in parallel.** Agents
   implement concurrently in isolated worktrees, but merges go through you one at
   a time, CAS-guarded against anyone else moving main. That keeps main coherent
   without forcing the agents to coordinate. The *mechanical* gate+merge for one
   resolved branch is best handed to an **in-session `Agent`-tool subagent** (not
   `spor dispatch`) so the verbose diffs/test-logs stay out of your context — see
   "Gate + merge". You still decide *which* resolved node to merge and serialize
   them (one merge-subagent at a time).

4. **Infra/swamp items have a different completion model.** A `spor-infra`
   (swamp-managed) item is not finished by a CAS merge — it's finished by a
   **deploy** the agent performs via the `swamp` CLI. So infra runs as a
   dedicated agent on the *real* checkout (`--no-worktree`) that owns its own
   apply/deploy and resolves the node; you don't merge it, you verify+refill.
   Only ever ONE infra agent at a time (it shares the real checkout). See "The
   infra / swamp agent".

## Local-dev posture (deliberate, not portable)

This skill's live location is `~/.claude/skills/spor-orchestrator/`; this
directory in the repo is the versioned source of truth. Keep them in sync by
pointing the live location at this one:

```bash
rm -rf ~/.claude/skills/spor-orchestrator
ln -s <repo>/.claude/skills/spor-orchestrator ~/.claude/skills/spor-orchestrator
```

Run that once (after this change first lands, or on a fresh machine); after
that, edit the repo copy and the symlink picks it up immediately — never
hand-edit the live copy directly, or the two diverge again.
(`spor-orchestrator-workspace/`, if present alongside the live skill
directory, is scratch/snapshot space from past editing sessions — it is not
part of the versioned skill and stays local.)

A few assumptions baked into this skill only hold on a dedicated,
low-blast-radius dev VM, not a general workstation:

- **`--permission-mode bypassPermissions`** on every dispatch (see "Dispatch"
  and "The infra / swamp agent" below) — safe only because this machine has no
  human answering prompts and no other consequential use; elsewhere, use
  `acceptEdits` plus a pre-approved tool allowlist instead (spelled out at the
  `bypassPermissions` call site).
- **Absolute paths** to this machine's checkouts and tools —
  `~/.claude/skills/spor-orchestrator/...` template/script paths throughout
  this file, and in `assets/codex-agent-prompt.md` /
  `assets/infra-agent-prompt.md` (`/home/exedev/repos/spor`,
  `/home/exedev/.swamp/deno/deno`). Repoint these to match wherever you clone
  the repos and install the tools.

## Preflight (once, before launching anything)

1. `spor status` — confirm **remote mode**, your identity, and the project.
   Remote mode is what gives you the auto-claim lease and the team-wide
   dup-guard. In local mode there is no lease; fall back to strict
   orchestrator-side non-overlap and say so to the user.
2. Confirm a dispatch identity is set (`spor agent use <agent-id>`; visible in
   `spor status`). Dispatches attribute to that agent.
3. `spor repos` — confirm the slug→path map resolves the target repo(s) so
   dispatch lands in the right directory.
4. Pull the queue: `spor next --json` (widen with `--all-projects` or
   `--project <token>` if the user wants more than this repo). It comes already
   filtered, ranked, and annotated with `in_flight` — don't re-derive that.
5. **Present the plan and get a go-ahead before launching.** Show the user the
   top items you intend to delegate, the concurrency (≤5), and — stated plainly —
   that you will **merge to main autonomously** after each item passes the gate.
   Merging to shared main is high-consequence; the user invoked this workflow,
   but the specific items weren't named, so confirm them first. Once launched it
   runs autonomously; tell the user they can stop you at any time.

## The supervisor loop

```
CONCURRENCY = min(5, user's choice)
running = {}          # node_id -> { agent_name, branch, worktree_path, kind, ... }
                       #   kind: 'claude' (self-resolves — both code and infra
                       #   dispatches; infra is discriminated separately below by
                       #   node.repo) | 'codex' (orchestrator resolves, see "The
                       #   Codex implementer" — also record report_path there)
done, escalated = [], []

loop:
  # --- refill: keep the pool full ---
  q = `spor next --json`
  candidates = q.items where:
      in_flight == false
      and suggest not in {close, blocked}
      and type is actionable (task / issue / incident)
      and id not in running
  for item in pick_non_overlapping(candidates, CONCURRENCY - len(running)):
      dispatch(item)                      # see Dispatch

  if running is empty and no candidates:  # queue drained
      break
  if max_tasks reached or user asked to stop:
      break

  # --- supervise: wait for a change, then act ---
  wait_for_change()                       # see Waiting — don't spin
  for node in running whose agent is no longer active:
      if running[node].kind == 'codex' and not resolved_on_graph(node):
          report = read(running[node].report_path)   # NOT agent-report.sh — that
                                                       #   only reads claude session
                                                       #   transcripts; a codex process
                                                       #   never writes one. Read the
                                                       #   log file you redirected its
                                                       #   output to at launch instead.
          if report says MERGE-READY:
              resolve_on_graph(node)             # orchestrator writes the resolver
                                                  #   node + resolves edge + terminal
                                                  #   status HERE — before the status
                                                  #   check below runs, so it sees
                                                  #   "resolved" not "RECOVER". See
                                                  #   "The Codex implementer".
          # else: BLOCKED, or process died with no report — fall through to
          # recover() below unresolved, exactly like a self-resolving agent.

      if resolved_on_graph(node):
          if node.repo == 'spor-infra':
              verify_deploy(node)         # infra self-deployed — see The infra/swamp agent
          else:
              delegate_gate_and_merge(node)   # in-session merge-subagent — see Gate + merge
          done.append(node); drop node from running
      else:
          recover(node)                   # see Recover
```

The pool is **up to 5**: typically up to 4 worktree code agents + at most 1
infra/swamp agent on the real `spor-infra` checkout. The infra slot is opt-in —
only enable it once the user has explicitly delegated deploys and accepted the
prod blast radius.

### Dispatch

Dispatch the specific item you selected, in its own worktree, with the delegated
workflow as the prompt template:

```bash
spor dispatch --node <id> --worktree --model <sonnet|opus|fable> \
  --permission-mode bypassPermissions \
  --template ~/.claude/skills/spor-orchestrator/assets/agent-prompt.md
```

- `--model` right-sizes the implementer per item — your biggest token lever;
  pick it deliberately (see "Right-size the model per item" below).
- `--node <id>` runs the item *you* chose (so you control non-overlap). Use
  `--from-queue` instead if you just want the top not-in-flight item and don't
  need custom selection — it applies the same skip logic.
- `--worktree` isolates the checkout; the branch is the node id.
- `--permission-mode bypassPermissions` is **required** for unattended agents: a
  detached `claude --bg` agent has no human to answer permission prompts, so the
  default mode leaves it **stuck/blocked** the first time it wants to write, run a
  test, or commit — the whole point of the agent is to do those without asking.
  `bypassPermissions` is the right call on an **isolated dev VM** dedicated to
  this work (no blast radius). If you're somewhere with real blast radius, use
  `--permission-mode acceptEdits` plus a pre-approved tool allowlist in the repo's
  `.claude/settings.json` instead — but never leave a background agent on the
  interactive default, or it will silently hang on the first prompt.
- The template injects the compiled briefing **and** the agent's loop
  instructions (see `assets/agent-prompt.md`).
- Dispatch auto-claims the lease. If it **refuses** (already in flight or held),
  skip that item — something else owns it. Don't `--force` past a live lease.
- Record `{ node, agent_name (= node id), branch, worktree_path, kind }` in
  `running`. `kind` is `'claude'` for `agent-prompt.md`/`infra-agent-prompt.md`
  (self-resolving) or `'codex'` for `codex-agent-prompt.md` (orchestrator
  resolves after a `MERGE-READY` report — see "The Codex implementer"). Get
  this right at dispatch time; it's what tells the supervisor loop not to
  `RECOVER` a Codex node that's actually done.

### Right-size the model per item

A delegated agent pays its model on every step — brief, implement, test loops,
self-review — so `--model` on the dispatch is where most of the fleet's token
budget is decided. Most queue items don't need the frontier model. Read the
item's briefing and pick:

- **sonnet** — the default for well-briefed, scoped work: a bug fix with a
  clear repro, adding tests, docs/skill edits, config plumbing, a rote refactor
  that follows an existing pattern. If the briefing says what to change and the
  tests will catch a wrong turn, sonnet does it at a fraction of the cost.
- **opus** — real design judgment inside one subsystem: a new feature without
  an obvious template to follow, multi-file changes, debugging where the cause
  isn't already in the briefing.
- **fable** — reserve for the hardest few: cross-cutting kernel/schema/store
  changes, concurrency/auth/crypto-sensitive work, or an item a cheaper agent
  already failed (see Recover).

When torn between two tiers, take the cheaper one. The safety net is layered —
deterministic tests, the cross-model review at the merge gate, and you — so an
under-modeled dispatch fails *loudly and cheaply* and gets re-dispatched a tier
up, while an over-modeled dispatch just silently overpays. Tell the user which
tier each item got in your launch plan so they can veto.

### Picking non-overlapping work

The lease already guarantees no two agents take the *same* node. Beyond that,
avoid collisions that will fight at merge time:

- Skim each candidate's briefing for the files/modules it will touch, and prefer
  a batch that spreads across different subsystems.
- Don't run two agents that clearly target the same file/module at once — hold
  the second until the first merges.
- **Serialize coordinated cross-repo work.** An item that needs changes in
  *both* spor and spor-server can't run in an isolated worktree, because the
  server resolves the client `lib/` by a `file:` link to the real checkout (see
  `references/merge.md`). Detect these (the briefing spans both repos, or touches
  client `lib/` *and* server code), run them **alone** on the real checkout
  (`--no-worktree`, no other agent active in that repo), then merge.

### Waiting (don't burn turns spinning)

After dispatching, block until something actually changes rather than re-checking
in a tight loop. **Use the shipped helpers — do not hand-roll the poll:**

```bash
# Block until any tracked agent finishes (run via Bash run_in_background: true;
# its exit re-invokes you). Prints AGENT_DONE <node> or NODE_RESOLVED <node>.
~/.claude/skills/spor-orchestrator/scripts/watch-fleet.sh <node-id> [<node-id> ...]

# One-shot triangulated view: session status × graph status × verdict
# (RUNNING / FINISHED — gate+merge it / RECOVER — session gone, node unresolved).
~/.claude/skills/spor-orchestrator/scripts/fleet-status.sh [<node-id> ...]
```

The gotchas the scripts encode (so a hand-rolled replacement doesn't re-pay
them):

- `claude agents --json` emits a **bare array**, not `{agents: [...]}` — a
  wrong jq shape fails SILENT and the watcher spins to timeout while finished
  agents sit idle (the 2026-07-16 watcher bug).
- Watch the **`status` field, never `state` alone** — `state` can stick at
  `working` indefinitely after the agent finishes (the 2026-07-14 stuck-watcher
  incident, inc-spor-orchestration-watcher-stuck-state), while `status`
  correctly flips to `idle`. An agent can also vanish from the list entirely.
- The cheap authoritative check is the graph: **`status: idle` + the node
  resolved on the graph = finished**, even if `state` still says `working` —
  proceed to gate+merge and reap the session with an explicit
  `claude stop <agent>` so it can't linger.
- **Both scripts only see the Claude side of the fleet.** They read `claude
  agents --json`, and a Codex-harness implementer (`assets/codex-agent-prompt.md`)
  isn't a `claude --bg` agent at all — it never appears in that list, session
  or gone. Feed them a Codex node id and, absent a resolved node, you get
  `RECOVER` unconditionally — that's not a signal, it's a blind spot. Track a
  Codex node's completion by watching the process/job you spawned for it and
  reading its final report, not through these scripts; see "The Codex
  implementer" below.

To read a finished agent's final report, never `claude logs` (it replays raw
TUI escape frames — huge and unreadable). Use:

```bash
~/.claude/skills/spor-orchestrator/scripts/agent-report.sh <session-id>            # final message
~/.claude/skills/spor-orchestrator/scripts/agent-report.sh <session-id> --findings # just the FINDINGS block
```

(It reads the session transcript JSONL under `~/.claude/projects/`; the
session id is printed by `spor dispatch` at launch — an 8-char prefix works.)

### Gate + merge

When a **code** agent's node is resolved on the graph, you own the merge — but
*delegate the mechanical work to an in-session `Agent`-tool subagent* (a
`general-purpose` agent, NOT `spor dispatch`), and run it on **`model:
"sonnet"`**. The subagent has its own context window, so the verbose diffs and
full test logs never pollute yours — which is what lets the supervisor loop run
for a long "keep going until I stop" session without filling up. And the
contract is deliberately mechanical — rebase, targeted tests, pipe the diff to
Codex, CAS swap, full suite, cleanup — with every judgment-heavy moment given
an exit (`ESCALATE`), so a cheaper model executes it just as well as a frontier
one. You first do the cheap, judgment-bearing checks yourself (node really
resolved on the graph? branch has commits?), then hand off one branch.

Spawn the merge-subagent with the CAS flow from **`references/merge.md`** as its
contract: rebase the node branch onto committed main, run the fast/targeted
tests, confirm the cross-model review (Codex, or `/code-review` as its
fallback) is clean, merge via the `git update-ref` CAS loop
(retrying if main moved under it), run the full suite after, then
`git worktree remove`. Require it to return a **tight verdict** and nothing else:
either `MERGED <sha>` with the test pass/fail counts, or `FAILED at <step>:
<reason>` with main left untouched/reverted, or `ESCALATE: <reason>` for a
conflict or review finding it must not hand-resolve. Because it runs on sonnet,
hold it to conservative adjudication: it may fix a Codex finding only when the
fix is small, obviously correct, and re-verified by the tests — anything
needing deeper context comes back as `ESCALATE`, never a guess in either
direction. After it returns, **spot-check the SHA**
(`git -C <repo> log --oneline -1 main`) — cheap insurance that the report matches
reality.

**Serialize** these: only one merge-subagent in flight at a time (the CAS guard
makes it safe, and one-at-a-time keeps main coherent), even though the
implementer agents keep working in parallel. On a `FAILED`/`ESCALATE` verdict,
re-dispatch the implementer to rebase and fix in its worktree, or escalate to the
user — don't hand-resolve a semantic conflict you don't understand.

**Shut merge subagents down when done.** A merge subagent's contract ends at
its verdict — it must never idle on and autonomously claim or merge other
ready branches (a runaway idle merge subagent once did exactly that, and a
concurrent cleanup pass has hard-reset another agent's ACTIVE worktree —
issue-spor-orchestrator-cleanup-worktree-leak). Its cleanup is strictly scoped
to the one `{worktree_path, branch}` it was handed: never `git worktree
remove --force` or `reset --hard` a worktree it didn't merge, and refuse to
touch any worktree with uncommitted changes that isn't its own target.

Doing the merge inline yourself is still correct for a one-off; the subagent is
the move when you're running the full pool and want to stay lean.

### Recover (agent gone, node not resolved)

This is for **self-resolving** agents (`kind: 'claude'` — code or infra) whose
own contract was to resolve the node before exiting. For a Codex node, land
here only *after* you've confirmed via its final report that it did NOT reach
`MERGE-READY` (BLOCKED, or the process died with no report at all) — a
`MERGE-READY` Codex node gets orchestrator-resolved per "The Codex implementer"
below, never routed through Recover.

The agent finished or died without resolving its node, so the work is incomplete
or it deliberately bailed:

- Read its final message and worktree diff to see how far it got.
- If it **deferred a blocker** (a new capture in `spor next`, or it says so in
  its final message — e.g. the item needs a coordinated cross-repo change),
  escalate to the user and don't merge.
- Otherwise re-dispatch the node once (`--force` if a stale agent of that name
  lingers). If the failure looks like **capability** — thrashing, a shallow or
  wrong-headed approach, tests it couldn't make pass — re-dispatch **one model
  tier up** (sonnet → opus → fable); if it was **environment** (missing dep,
  flaky test, lease conflict, dead server), same tier — a bigger model won't
  fix a broken worktree. After two failed attempts, stop and hand the item to
  the user — a task that won't converge shouldn't loop forever.

### The Codex implementer (a self-resolution exception)

`assets/codex-agent-prompt.md` dispatches a **Codex-harness** implementer
(GPT-5.5 via the `codex` CLI — a different binary from `claude --bg`) for the
same kind of worktree item a code agent handles. Its contract differs from
`assets/agent-prompt.md` in exactly one load-bearing way: it is explicitly
forbidden from writing the graph at all — "Read the graph freely; never write
it… The orchestrator handles ALL graph updates, including resolving this
node." So a Codex node that finished cleanly looks, on the graph, identical
to one that never started: unresolved. That's expected, not a failure
signal — but it collides head-on with completion-detection paths built for
**self-resolving** agents: `fleet-status.sh`'s `RECOVER` branch and the
supervisor loop's default `recover()` fallthrough both read "unresolved" as
"didn't finish," and neither script can even see a Codex session in the
first place (they poll `claude agents --json`, which a Codex process never
enters).

Two things close the gap:

1. **Track which nodes are Codex-dispatched, and capture their output when
   you launch them.** Record `kind: 'codex'` alongside the node in `running`
   at dispatch time (see Dispatch, above). A Codex process isn't a `claude
   --bg` agent — `agent-report.sh` reads Claude session transcripts under
   `~/.claude/projects/`, which a `codex` CLI process never writes — so
   there's no equivalent "give me the final report by id" tool for it. Redirect
   its output to a log file when you launch it and record that path as
   `running[node].report_path`; that's what tells the supervisor loop both
   that this node's absence from `claude agents --json` means nothing on its
   own, and where to actually find its report once it exits. Watch the
   process itself finishing (it's a job you started directly), not
   `fleet-status.sh`/`watch-fleet.sh` — see the Waiting section's scope note.
2. **Resolve before you status-check.** When a tracked Codex process exits,
   read its final report from `running[node].report_path` — same shape as a
   Claude agent's: ends with `MERGE-READY` or `BLOCKED` and why, plus a `##
   FINDINGS FOR THE ORCHESTRATOR` block. On `MERGE-READY`: **you** write the
   resolver node (a `decision` or short `artifact` carrying a `resolves`
   edge) and flip the node to its terminal status yourself — *before*
   running `fleet-status.sh` or trusting `watch-fleet.sh` again for that
   node. Do the resolve first and the very next status check sees a resolved
   node like any other finished item, falling straight through to the normal
   gate-and-merge path — no special-casing needed downstream of the resolve.
   On `BLOCKED`, or if the process died without a final report, that's a
   genuine non-completion — route it through Recover (above) like any other
   unresolved node, not this exception.

Never resolve a Codex node preemptively — because it's been running a while,
or because it isn't in `claude agents --json`, or any signal short of a
`MERGE-READY` report. Resolving on a guess is exactly the failure mode
issue-spor-orchestrator-implementer-resolves-before-commit already paid for:
it must never happen before you know the work is actually done.

### The infra / swamp agent (the optional 5th slot)

`spor-infra` is **swamp-managed**: infrastructure is declared as swamp models in
`extensions/models/*.ts` and applied/deployed imperatively through the `swamp`
CLI — *not* by a git push, and (per that repo's CLAUDE.md) **not** in a git
worktree. So infra items do not fit the worktree → `npm test` → CAS-merge gate
the code agents use. Run them through a **dedicated infra agent** instead, and
dedicate at most ONE pool slot to it:

```bash
spor dispatch --node <infra-id> --no-worktree --permission-mode bypassPermissions \
  --template ~/.claude/skills/spor-orchestrator/assets/infra-agent-prompt.md
```

- **Don't down-model the infra agent.** A deploy is judgment plus prod blast
  radius, there's at most one infra agent, and no merge gate backstops it —
  leave `--model` at the session default (or `fable` for a risky change); the
  savings from a cheaper model aren't worth it here.
- `--no-worktree` — it works the **real** `spor-infra` checkout, because swamp's
  state/vault and per-model locks live with the repo, and a model apply is the
  deploy. **Only one infra agent at a time** — two would tangle the shared
  checkout (no worktree isolation to protect them).
- The infra template (`assets/infra-agent-prompt.md`) tells the agent to load the
  `swamp` skill, change the model, **perform the deploy itself** (authorized — get
  explicit user sign-off that deploys are delegated and prod disruption is
  acceptable *before* enabling this slot), verify it, resolve the node, and commit
  the model change. "Done" = node resolved on the graph (deploy performed or the
  node's own "accept the gap" path taken), exactly like a code agent.
- **You do not merge infra** — there's no CAS merge and no merge-subagent. When
  the infra agent's node resolves, read its report to confirm what it deployed (or
  why it accepted the gap / deferred), then stop the agent and refill the infra
  slot with the next `spor-infra` item.
- **Not every infra-named item is a swamp deploy.** A pure operational action
  (e.g. "revoke an API key") or a secrets task whose values the agent can't reach
  isn't a deploy — surface those to the user rather than burning the slot; the
  agent will `/spor:defer` and leave the node unresolved if it hits that, which is
  your signal to escalate.

## Reporting

Keep the user oriented without spamming the channel: one line per merge (node +
what landed), one line per infra deploy (node + what was applied), and one line
per escalation (node + why it's stuck). When the queue drains or you stop,
summarize what merged, what was deployed, what was escalated, and what was
skipped.

## Triage each agent's FINDINGS into the graph

Both implementer prompts (`agent-prompt.md`, `codex-agent-prompt.md`) end with a
`## FINDINGS FOR THE ORCHESTRATOR` block: out-of-scope discoveries the agent did
**not** file itself — latent bugs, smells/refactors, missing tests, and
**places where it followed the task literally though a better approach exists**.
Agents do NOT write these to the graph (so the graph isn't flooded with
uncurated, duplicated defer nodes, and so Codex — which can't write the graph at
all — can still surface them). **You curate them.** Pull the block with
`scripts/agent-report.sh <session-id> --findings` for a Claude agent; for a
Codex node, read `running[node].report_path` directly instead —
`agent-report.sh` only resolves Claude session transcripts, it has no id to
look up a Codex process by. When you read an agent's final report (at
merge/recover time), triage its FINDINGS: drop dupes/noise,
then `put_node` each keeper as the right type (`issue` for a bug/hazard, `task`
for a refactor/improvement) linked `relates-to`/`derived-from` the node it came
from. A "better-approach" finding usually becomes a `task`; a real latent bug an
`issue`. Mention notable ones in your status line so the user can veto. This is
how the fleet's discoveries become durable work instead of evaporating.

## What each delegated agent does

There are three per-agent workflows, all supplied as the dispatch `--template`:

- **Code agents** — `assets/agent-prompt.md`: brief → implement in its worktree →
  loop `/code-review` until clean → verify → resolve the node (resolver node +
  `resolves` edge, then terminal status) → commit on its branch (it does **not**
  merge — your merge-subagent does).
- **Codex implementer** — `assets/codex-agent-prompt.md`: brief (read-only) →
  implement in its worktree → self-review → verify → commit on its branch,
  ending with a `MERGE-READY`/`BLOCKED` verdict. It does **not** write the
  graph at all — not even to resolve its own node; see "The Codex implementer"
  for the orchestrator-resolves-before-status-check contract this requires.
- **Infra/swamp agent** — `assets/infra-agent-prompt.md`: brief → change the
  swamp model on the real checkout → **deploy via the `swamp` CLI** → verify →
  resolve the node → commit the model change (it owns the deploy; you don't
  merge).

Edit those files to tune what each kind of agent does; edit this SKILL.md to tune
how you schedule, gate, merge, and deploy them.

## Reference

- **`references/merge.md`** — the CAS merge against the contended spor /
  spor-server mains, the `dispatch.worktreeSetup` hook for worktree prep
  (symlinking `node_modules` for spor-server), and the `file:`-link cross-repo
  constraint that forces some items to run solo.
- **`assets/agent-prompt.md`** — the code-agent prompt (worktree, CAS-merged by
  you).
- **`assets/codex-agent-prompt.md`** — the Codex implementer prompt (worktree,
  CAS-merged by you; forbidden from writing the graph — you resolve its node
  after a `MERGE-READY` report, see "The Codex implementer").
- **`assets/infra-agent-prompt.md`** — the infra/swamp-agent prompt (real
  checkout, owns its deploy; one at a time).

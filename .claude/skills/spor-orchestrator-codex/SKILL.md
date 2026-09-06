---
name: spor-orchestrator-codex
description: >-
  Work the Spor queue with parallel OpenAI Codex agents: select non-overlapping
  items, dispatch isolated implementers, review, serialize merges, and refill
  slots. Use when the user asks to orchestrate a Spor backlog using Codex or
  OpenAI models only. GPT-6 Astra handles complex work and final review.
---

# Spor queue orchestrator — Codex only

Adapted from `../spor-orchestrator/`. Run this supervisor in Codex. Every model
call under this workflow — implementer, reviewer, merge helper, recovery agent,
and any nested delegation — must use OpenAI through Codex. Pass this requirement
into each delegate's instructions. A skill cannot switch its own host model:
if the current supervisor is not an OpenAI model, have the user open this skill
in Codex before launching the fleet.

## Model routing

| Work | Model | Reasoning when the launch surface supports it |
|---|---|---|
| Supervisor; complex design, cross-cutting changes, concurrency, identity/security, difficult debugging | **GPT-6 Astra** (`gpt-6-astra`) | `high`; `xhigh` for the hardest cases |
| Routine scoped implementation, tests, well-understood bug fixes; mechanical merge helper | GPT-5.6 Sol (`gpt-5.6-sol`) | `medium` |
| Small mechanical edits or narrow read-only investigation | GPT-5.4 Mini (`gpt-5.4-mini`) | `medium` |
| Independent final correctness review | **GPT-6 Astra** (`gpt-6-astra`) | `high` |

Astra is the highest tier. Escalate capability failures Mini → Sol → Astra.
Use Astra from the start for complex work; don't send a known hard problem to
Mini to save tokens. If Astra implemented the change, still use a fresh Astra
review session with the diff and acceptance criteria, without the author's
reasoning. Independence comes from a fresh context; it need not be another vendor.

Verify the selected models are available on the dispatch host. If a model is
unavailable, report it; never fall back to another provider or silently lower a
complex task's tier. Model IDs above are explicit, not aliases such as `latest`.
`spor dispatch` supports `--model` but currently has no reasoning-effort flag;
do not invent one. The reasoning column applies to supported native Codex
launch options, such as the review command in [references/merge.md](references/merge.md).

## Preflight and scope

1. Load the Spor operating skill and query the live graph for this work. Run
   `spor status`, `spor repos`, and `spor next --json` (scope with
   `--project <token>` as requested). Confirm repo paths, identity and dispatch
   agent. Remote mode supplies heartbeat leases; in local mode enforce strict
   non-overlap yourself and disclose that leases are unavailable.
2. Confirm `codex` is installed and authenticated. Inspect
   `spor get profile-codex-sol --json`: it must be an active profile with
   `harness: codex` and satisfiable requirements on this machine. Use another
   verified Codex profile if needed; never rely on an unprofiled dispatch's
   default harness. Run `spor capabilities` for local capability information.
3. Present the chosen items, repo ownership, model per item, concurrency (up to
   five implementers, within host limits), and merge/deploy scope. Reuse the
   user's existing authorization. If shared-main merges or deploys have not
   been authorized, prepare and validate the concrete changes first, then
   request the missing approval before that action.
4. Resolve templates relative to this skill's installed directory. There are no
   machine-specific checkout paths or dependencies on another variant's fleet
   scripts. Set `SKILL_DIR` below to this skill directory's absolute path.

For a named program, traverse its complete membership and prerequisites first,
not just the first queue page. Record included repositories and excluded lanes;
excluded work stays unresolved and cannot be counted as completed. Active
standing decisions in the view are context, not implementer tasks. Before
recovery work, identify original candidate SHAs, source findings and whether
those commits already landed. Never manufacture a change to obtain a nonempty
diff: review the original committed range and verify its presence at current main.

Select actionable, ready items that are not already in flight, resolved,
blocked, or held by another agent. Read their briefings to avoid two agents
editing the same module concurrently. Leases prevent duplicate node ownership;
you still own semantic non-overlap.

When acceptance spans independently testable work in multiple repos, split it
before dispatch using [references/split.md](references/split.md). When testing
requires simultaneous changes in linked client/server checkouts, run it solo
using the in-place workflow below, with every affected checkout explicitly
named. Never let a worktree implementer improvise a second repo branch.

Serialize full acceptance suites across the fleet separately from implementation
concurrency. Supply a shared acceptance-lock path to workers (on this host use
`flock` around the full suite), preserve complete logs and their exit status,
and allow focused tests to proceed independently. A timeout with a green tail
is incomplete evidence. Existing model-backed tests may use fake provider
servers; actual paid model calls must remain OpenAI-only.

## Dispatch and track

For routine implementation (change only `--model` for another tier):

```bash
spor dispatch --node <id> --worktree --profile profile-codex-sol \
  --model gpt-5.6-sol \
  --template "$SKILL_DIR/assets/agent-prompt.md"
```

For complex work, pass `--model gpt-6-astra`; for a small mechanical item,
`--model gpt-5.4-mini`. Always retain a verified Codex profile. Do not add
`--bg`, `--agent`, or `--permission-mode`. Codex dispatch is supervised in the
background already and defaults to `workspace-write` / approval policy `never`.
Do not widen permissions merely to bypass an environment failure.

Dispatch creates the worktree, compiles the briefing, claims the lease, and
captures JSONL logs and the final report. Record the exact node, repo, branch,
worktree, model, run identity, log path and `report_path` printed at launch.
These identify the attempt: never substitute the latest run of the same node
without checking its identity. Respect live leases; do not force past a refusal.

Implementers read graph context, implement, test, self-review and commit with a
`Spor: <node-id>` trailer. They do not merge, push or mutate graph nodes.
**You own graph writes and resolution.** A successful implementer therefore
leaves its task unresolved and returns `MERGE-READY` with evidence and a SHA.
For already-landed work, accept `ALREADY-IMPLEMENTED` with original commit ranges
and fresh verification as a request for independent evidence review; never
merge an empty branch or resolve it without reviewing that original range.
Spor's supervisor may record a report artifact; that is not task completion.

## Supervise, gate, resolve, refill

Use the harness-neutral run surface:

```bash
spor runs --node <id> --json
```

Match the recorded attempt in `.runs`, then inspect its process state and
terminal outcome. Wait between reads using the host's interruptible wait
facility (30–60 seconds); do not busy-poll. Continue concise progress updates.
Do not use the original skill's `fleet-status.sh`, `watch-fleet.sh`, or
`agent-report.sh`: they depend on another harness's session discovery.

For each completed attempt:

1. Read its recorded `report_path` and inspect its actual commit/worktree.
   Always process `FINDINGS FOR THE ORCHESTRATOR` and `HANDED BACK`, even if
   another actor has resolved the graph node meanwhile. A successful process
   exit or a `reported` terminal outcome is not a merge verdict. A graph
   resolution alone is not proof that this run's branch passes the gate.
2. A `MERGE-READY` report with unfinished cross-repo acceptance first runs the
   split contract. Keep the branch pending if the graph write fails; do not
   reimplement already finished code. Retry the idempotent graph operation
   up to three loop turns, then escalate with the report path.
3. For worktree code, verify the reported SHA, clean worktree, acceptance, tests and self-review.
   Queue this branch for the serialized gate in
   [references/merge.md](references/merge.md). Only one merge runs at a time;
   other isolated implementers can continue. A merge helper, if useful, must
   be a Codex Sol agent, scoped to this exact branch, and its final review
   must use Astra. You can also execute the merge procedure yourself.
   For in-place `READY-FOR-VERIFICATION` or infrastructure `DEPLOYED` reports,
   use the corresponding in-place/deploy verification below instead of merging.
4. After the applicable gate, authorized merge/deploy and verification succeed,
   write an artifact with a `resolves` edge to the task, the landed SHA and
   validation evidence, then set the terminal status. Do not resolve merely
   because the implementer said `MERGE-READY`. If already resolved, reconcile
   the existing evidence rather than minting a duplicate resolver.
5. Capture meaningful findings with their source task, concrete acceptance and
   repo; deduplicate against the graph. Record real prerequisites as `blocks`
   edges. Make eligible keepers agent-ready using the Spor triage workflow;
   refill with them only within the user's authorized scope.
6. Remove the finished attempt from the running table and refill the slot with
   the next non-overlapping item. Keep graph-write failures and merge failures
   visible as pending work, not as successful completion.

Stop when the eligible queue drains, a requested task limit is reached, or the
user stops the run. Stop dispatching immediately on a stop request; report any
still-active exact runs and handle their shutdown through the host's supported
process controls without killing unrelated sessions.

## Recovery

For an existing unmerged candidate, prepare it in the task worktree before
redispatch. An explicitly scoped candidate merge/rebase inside that worktree is
allowed; shared-main integration remains supervisor-owned. Record both source
SHAs and preserve all prior fixes when reconciling conflicts.

When nested CLI execution fails for host/sandbox reasons, compare a focused
check in the supervisor environment before classifying a code failure. A native
Codex subagent is a supported recovery path: verify the old attempt ended,
retain its exact worktree/evidence, acquire or renew the task claim, assign
exclusive file ownership and model, and record the native agent ID. Renew its
lease explicitly while it works and release on handback. Never widen sandbox
permissions, run two writers, or force past another live owner to recover.


An unresolved task is normal for a finished Codex implementer. Recover only
when the report is blocked/missing, the run failed, or verification fails.
Inspect the final report and logs first. Fix environment problems at the same
tier; escalate capability problems one tier, with Astra as the ceiling.

Allow one recovery attempt per item, then escalate. Verify the old attempt
has ended and its lease permits recovery. Preserve its commits and dirty work;
never reset or delete them to get a fresh run. Inspect `spor dispatch --print`
before redispatch if branch/worktree reuse is uncertain. Supply the previous
attempt's evidence in the recovery template, and explicitly identify the
checkout that holds it. There is no assumed cross-session messaging channel.

## In-place and deploy work

For authorized solo shared-checkout work:

```bash
spor dispatch --node <id> --no-worktree --profile profile-codex-sol \
  --model gpt-6-astra \
  --template "$SKILL_DIR/assets/agent-prompt-inplace.md"
```

Drain conflicting agents first, inspect existing WIP, and pin every affected
repo path before dispatch. No `worktreeSetup` hook runs here. Use path-scoped
commits and preserve other people's changes. The deliverable is a commit on
the existing branch; do not CAS-merge a nonexistent worktree branch. Verify
and independently review the actual changed commits before resolving.

For an explicitly authorized swamp deploy, use the same command with
`assets/infra-agent-prompt.md`, always Astra, at most one deploy agent across
shared affected checkouts. Discover the current infrastructure repo from the
briefing and `spor repos`; do not assume the retired `spor-infra` repo is still
the deployment home. The agent loads the swamp skill, performs only the
specified deploy, verifies it and reports `DEPLOYED` or `BLOCKED`. You verify
runtime evidence and record the graph resolution; a committed config alone
is not a deployment. If deploy permission is missing, prepare the change and
request approval for the concrete action first.

## Reporting

Report meaningful completions, failures and required user actions. On stopping,
summarize landed commits, verified deployments, pending reviews/graph writes,
escalations, skipped items and any active runs. After a substantial session,
file one outcome artifact linking its results. Never claim work landed based
only on a worker report.

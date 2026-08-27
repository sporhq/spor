# Spor worker protocol

Spor is the durable substrate of a software factory, not the factory itself
(dec-spor-software-factory-substrate). A coding-agent harness — Claude Code,
Codex, OpenCode, GitHub Copilot CLI, or anything else that can read a prompt
and write code — is a fungible **worker** behind a protocol this document
specifies precisely enough that a **third party can implement a conforming
Spor worker without our client**. Everything here reduces to REST calls
(API.md §3) plus the sequencing and shapes those calls compose into.
`spor dispatch`/`spor work` (`bin/spor.js`, `lib/shell/agent-dispatch-runner.js`,
`lib/shell/dispatch-terminal.js`) are **one reference implementation** of this
protocol, not the protocol itself — the adapter boundary in
dec-spor-dispatch-harness-adapter-contract exists precisely so new harnesses
are additive registry entries, never a new fork in the orchestration layer.
Companion specs: [GRAPH.md](GRAPH.md) (node/edge format), [API.md](API.md)
(the full REST/MCP contract this document is built from), [QUEUE.md](QUEUE.md)
(the decision queue).

## 1. What a worker is

A worker is any process that, over one unit of work:

1. **claims** a node from the queue (§3),
2. **reads** the compiled context for it (§4),
3. **does the work** — out of this protocol's scope; write code, run tests,
   whatever the task requires,
4. **reports** back onto the graph in exactly one of three terminal shapes
   (§6), and
5. **releases** the lease so the item returns to (or leaves) the pool, in an
   order that can never lose the work (§6).

Nothing here requires the Spor CLI, the Claude Code plugin, or any particular
model. A worker is identified to the graph by an **agent node** (§2) carrying
its own bearer token; every write it makes is attributed through that token,
independent of which binary is doing the writing.

## 2. Agent identity and attribution

A worker writes to the graph as an **`agent`** node — a person-owned
principal, not a person. Create one (self-serve, no admin needed):

```
POST /v1/agents {label}                       →  agent-<slug>, owned-by <you>
POST /v1/agents/{id}/token {session?}          →  a bearer token scoped to it
```

Every write under an agent-scoped token is stamped `authored_by_agent:
<agent-id>` and `session: <id>`, with `authored_via: dispatch`; `author:`
stays the agent's **owning person**, so the node reads "agent on behalf of
person" (API.md §1). This is the token a worker process should hold — never
a person's own account-scoped token or connector session, which would
attribute the work to the human instead of the agent that did it.

**Two token shapes**, both minted by the same endpoint:

- **Per-session** (default): a short-TTL token for one run. `session` may be
  **omitted** and bound later (below) — the launcher usually cannot know a
  harness's real session id before the harness allocates it itself
  (dec-spor-dispatch-bg-session-late-bind). Writes made before the bind carry
  no `session` (honest — never a phantom id); writes after trace to the real
  run.
- **Standing** (`{standing: true}`): a long-lived `spor_pat_` for a headless
  worker with no per-launch minting step (e.g. a persistent queue-polling
  process). User-set expiry, capped at 1 year.

**Late session binding.** If the worker's own session id isn't known at
token-mint time, bind it once the harness reports it:

```
POST /v1/agents/session {session}     — authenticated by the AGENT TOKEN ITSELF
```

Write-once: idempotent on the same value, `409 conflict` on a different one
(a token's session is provenance, not a mutable field). A worker that never
calls this simply keeps writing with no `session` stamped — degraded
attribution, not a broken one.

## 3. The pool and the claim

**Eligibility.** `GET /v1/queue?project=<slug>` (API.md §3) returns the
ranked, live queue for a project. Each item's `readiness` field
(`agent`/`human`/`untriaged`) says whether it is meant for an autonomous
worker at all — `readiness: human` always wins over any stamp (a `requires:
human` node, an explicit assignment, held-task churn, an open neighborhood
question). Strictness here splits by surface
(dec-spor-worker-strictness-split-interactive-lenient): an **autonomous
worker** — an unattended loop picking its own work from the pool, such as
`spor work` — **must not claim** a `readiness: human` item; it skips it in
selection and moves on. An **explicit human-initiated dispatch** — a person
naming this exact node, such as `spor dispatch <id>` — **may**: it warns and
proceeds, since a person choosing to point an agent at flagged work is
itself the human step the readiness gap exists to route through. `suggest`
on each item (`do`/`dispatch`/`blocked`/`triage`/`close`/`approve`) is a
further hint; `blocked` means a live `blocks` edge still gates it — claiming
it is legal but the item cannot resolve until its blocker does.

**Claim.** Take the heartbeat-renewed lease before starting work:

```
POST /v1/nodes/{id}/claim {session?, dispatch?}
```

writes the durable `assigned` edge once (attributed to `$viewer` from the
token — never a body field) and creates an ephemeral lease
(dec-cc-task-claim-lease). Response: `{ok, status, lease: {node_id, by,
expires, expires_at, session, claimed_at}, expires_in_ms, edge}`.
`expires_in_ms` is the renewal horizon *relative to when this call ran* — a
worker should renew at roughly half of it, never hardcode a TTL: the bound is
graph-resident **tenant policy**, not a client constant, and varies per repo.
A live lease held by someone else is `409 conflict` naming the holder and
expiry; re-claiming your own live lease is an idempotent renew.

`session` may be omitted pre-launch (person/agent-scoped; any of the
claimant's sessions may renew it) and bound later via `renew` once the real
session is known — the same late-bind pattern as §2.

`dispatch` is an optional opaque nonce a launcher can tag its claim with so
the server can tell **a second concurrent launch of the same node by the same
identity** apart from an idempotent re-claim/renew — without it, a
same-identity double-launch just renews and silently starts two workers on
one node. Pass a fresh value (e.g. a UUID) per launch attempt; omit it for a
deliberate re-attach to an already-running claim.

**Renew / extend / release / reserve** — the rest of the same lease family,
one REST route each (`POST /v1/nodes/{id}/<action>`, API.md §3):

| Action | When | Effect |
|---|---|---|
| `renew {session?}` | on write activity, at < ½ the remaining TTL | bumps `expires`; auto-reclaims if the lease had lapsed |
| `extend {ms, session?}` | before a known long idle gap | stretches the live lease by `ms`, capped at the tenant's `claim_ttl_max` |
| `release` | work finished, or aborting before doing any | drops the lease and retires the `assigned` edge — idempotent |
| `reserve {session?}` | ending cleanly with work advanced but unfinished | converts the live claim into an owner-exclusive resumption reservation instead of a plain release |

A crashed worker needs to do nothing: the lease is **read-time
self-healing** — a lapsed lease demotes the claim and the node re-enters the
pool with zero sweep, zero scheduler (dec-cc-task-claim-lease). Bulk variants
(`POST /v1/queue/claim|renew|release`) exist for a worker carrying more than
one node at once (API.md §3) but are not required for a single-node worker.

## 4. The prompt contract

A worker's context is assembled from three parts, in this order — this is
the shape `spor dispatch` builds, and the one a third-party launcher should
reproduce so a worker sees the same standing context regardless of harness:

```
> **Spor session project:** `<slug>`. If you file a question with
> `ask_question` (or `POST /v1/questions`) that has no clear `mentions:`,
> pass `project: "<slug>"` so it is stamped to this project rather than
> defaulting to the asker's home project.

# Spor briefing (compiled for this task — your standing context)

<compiled neighborhood — from POST /v1/digest {root: <node-id>} or query>

---

# Task

Work on <node-id> — <title>. The compiled Spor briefing above is your
standing context. <any additional free-text task instructions>
```

1. **Session note.** One paragraph naming the session's project slug, so a
   worker filing a mention-less question stamps it correctly instead of
   defaulting to the asker's home project
   (issue-spor-dispatch-propagate-session-project-to-questions).
2. **Compiled briefing.** `POST /v1/digest {root: <node-id>}` (or `{query:
   <text>}` for a free-text task with no target node) — the same compiler
   `/spor:brief` uses, returning the node's neighborhood: prior decisions,
   constraints, dismissed approaches, related work. Omit this section
   entirely for a bare-bones launch (`--no-brief`'s effect) — never required,
   but every fleet worker benefits from it.
3. **Task.** What to do — the target node's id and title plus any additional
   instruction text, or free-text task instructions with no node at all.

There is no wire-level requirement that a worker consume this exact string;
what matters is that a conforming worker (a) is capable of reading a compiled
briefing before acting non-trivially, per AGENTS.md's standing instruction to
every session working this graph, and (b) knows which node it is working on,
so its terminal report (§6) can name it.

## 5. Machine capability declaration (optional, for routed dispatch)

A worker box may **publish** what it can run so a routing layer can pick a
satisfying host instead of a human hardcoding one:

```
POST /v1/agents/{id}/capabilities {harnesses?, reachable_mcp?, skills?, plugins?, deny?}
GET  /v1/agents/{id}/capabilities
POST /v1/agents/{id}/heartbeat            — cheap last_seen refresh, no re-publish
GET  /v1/profiles/{id}/hosts?owner=...    — which published agents satisfy a profile
```

Satisfiability is atomic-capability matching against a `type: profile`
node's runtime fields (`harness`, `mcp`, `skills`, `plugins`), never a flat
allowlist of profile ids, and dispatch never silently substitutes a profile
a box can't satisfy — it fails soft and loud instead
(dec-spor-machine-profile-satisfiability). This whole section is optional:
a worker that never publishes capabilities simply never appears in a
`hosts` lookup: nothing above §1-§4 depends on it.

## 6. Terminal states — the outcome contract

This is the contract every worker must honor, however it is launched
(task-spor-dispatch-terminal-states-contract,
dec-spor-dispatch-terminal-state-outcome-layer). It answers a question the
process's own exit code cannot: **what did this run actually do to the
graph** — an agent can exit 0 having done nothing, and one that crashed after
writing its resolver still finished the job.

**`terminal_state` is exactly one of:**

| Value | Means | How it's earned |
|---|---|---|
| `resolved` | the target is genuinely done | re-reading the graph shows a **live inbound `resolves`/`answers` edge** onto the target node |
| `reported` | not done, but the work reached the graph | no resolving edge, but the worker's final report was filed as an artifact `relates-to` the target |
| `failed` | nothing usable reached the graph | no resolving edge and no usable report |

**`resolved` is a graph read, never an exit code, never the worker's own
claim.** Re-fetch the node — `GET /v1/nodes/{id}` — and check its
`resolution` enrichment (API.md §3, the `get()` hook the seed
`task`/`issue`/`question`/`incident` schemas attach): a live, visible,
inbound `resolves` or `answers` edge, carrying the resolver's id. Its absence
is the answer for a worker that *claims* success without writing one — that
absence reads as `reported` or `failed`, never `resolved`. This is the
single most important rule in this document: **a worker's own "I'm done" is
not evidence; a resolving edge on the graph is.**

**Report presence — not exit status — discriminates `reported` from
`failed`.** A run that crashed midway but had already produced a usable
final report is `reported`, not `failed`; the crash itself is a separate,
process-level fact (§8's `state`/`termination_*` fields), never conflated
with the outcome. The invariant a consumer keys on: whenever a report
artifact id is present, `terminal_state` is `reported` — always, whether the
verdict was fully verified or not (see "unverifiable targets" below).

**Unverifiable targets.** Only node types whose completion is a *resolving
edge* rather than a status flip — `task`, `issue`, `question`, `incident` —
can be judged for `resolved` at all. A `decision` or `finding` target (closed
by status, not by edge) is out of scope for the verdict: the filed report's
wording says "not verified" instead of "ended without resolving it" so it
never asserts something that type could never have satisfied, and
`terminal_enforced` reads `false` even when a report was filed. **This type
also changes the ordering below**: the lease is never released on the
strength of a verdict this contract cannot make — not on a successful report
filing, and not on a missing one either. It is left to lapse at its own TTL
in both cases; a lease on an unjudgeable target is simply not this runner's
to hand back on a guess.

**Ordering is the contract: file the report, THEN release the lease —
never the other way, and never both-or-neither on a failure.**

1. Re-read the target node; a live resolving edge → done, **`resolved`**,
   release nothing (the durable `assigned` edge already stands as the record
   of who did the work).
2. Target is an **unjudgeable type** (`decision`/`finding` — see above) →
   file the report if text exists, worded "not verified"; **release
   nothing either way** — `terminal_state` reads `reported` if a report was
   filed (report presence still governs, per the invariant above) or
   `failed` if there was none, but always with `terminal_enforced: false`
   and the lease left to lapse at its TTL.
3. Judgeable type, no resolving edge, a final report text exists → **file it
   as an artifact** (§7). If the write lands (or was already there — filing
   is idempotent), release the lease → **`reported`**. If the write is
   *refused* by the graph, the lease is deliberately left **held** rather
   than releasing a signal-free item back into the pool — it lapses at its
   own TTL instead, and the run's note says so.
4. Judgeable type, no resolving edge, no report text at all → release the
   lease → **`failed`**, with a `terminal_note` explaining why.

A crash between steps 3's two writes can therefore only ever leave the lease
held with the report already filed, or leave both undone — **never** a
released lease with no report to show for it.

**What "enforced" means, and where it doesn't apply yet.** `terminal_state`
is only as trustworthy as `terminal_enforced` says it is
(dec-spor-dispatch-terminal-states-supervised-first): it is `true` only when
the graph was actually re-read against a reachable server — and, for a
target with no resolving edge, the report actually filed there too (a
`resolved` verdict needs only the re-read; nothing is filed once a resolving
edge is already found). Every other case — no team graph configured (local-mode
dispatch), a free-text dispatch with no target node, an unreachable server,
an out-of-scope target type (above), or (v1) a **native-background** launch
whose termination this runner cannot deterministically observe — stamps
`terminal_enforced: false` and can never read `resolved`. A `reported` or
`failed` value on an unenforced record is a best-effort classification of the
*process* outcome, not a checked verdict; `terminal_enforced` is the field a
consumer must gate on before treating either as ground truth.

### What a third-party (non-reference-client) worker must do

If your launcher is not `spor dispatch`/`spor work`, reproduce the algorithm
above directly against REST once your worker process ends:

```
1. GET  /v1/nodes/{targetId}
2. if resolution.by present               → terminal_state = resolved; done, no release
3. elif targetId's type is decision/finding (an unjudgeable type, §6)
                                           → if final report text exists: POST /v1/nodes (file it, §7, if_exists: skip)
                                                → terminal_state = reported, terminal_enforced = false
                                             else
                                                → terminal_state = failed, terminal_enforced = false
                                             NEVER release the lease either way — it lapses at its own TTL
4. elif final report text exists          → POST /v1/nodes  (file the report, §7, if_exists: skip)
                                             if the write lands: POST /v1/nodes/{leaseNode}/release
                                                                  → terminal_state = reported
                                             if the write is refused: leave the lease held
                                                                  → terminal_state = failed (held)
5. else                                   → POST /v1/nodes/{leaseNode}/release
                                             → terminal_state = failed
```

`leaseNode` is whichever node your claim (§3) actually established the lease
on — normally the same as `targetId`, but not necessarily (a `--force`
re-dispatch that renewed someone else's lease releases nothing, since that
lease isn't yours to hand back).

## 7. The report artifact

The filed report is an ordinary `artifact` node, deliberately **not** a
resolver — it carries `relates-to`, never `resolves`, because filing a
report must never itself retire the item; the whole point is the work
returns to the queue *carrying* the report rather than vanishing.

```markdown
---
id: art-dispatch-report-<stem>-<short-run-id>
type: artifact
project: <slug>              # when known
title: Dispatch report — <target-node-id>
summary: Final report from the dispatched <harness> run on <target>, <ended without
  resolving it | whose outcome was not verified against the graph>: <first line of report>
date: <YYYY-MM-DD>
edges:
  - {type: relates-to, to: <target-node-id>}
---

Final report from dispatched run `<run-id>` (<harness>), which ended `<state>`.
It is filed here so the run's work reaches the graph instead of vanishing into
a dead run; nothing here resolves the target.

<one of:>
The run left no resolving edge on <target>, so the item returns to the queue
carrying this report.
<or, on an out-of-scope target type:>
Whether <target> is complete was NOT verified: a `<type>` node of this type is
retired by its status rather than by a resolving edge, which is the only
signal this runner checks.

<the worker's own final report text, verbatim>
```

**Deterministic, idempotent id.** `art-dispatch-report-<stem>-<short-run-id>`,
where `<stem>` is the target node id with its type prefix stripped
(≤ 40 chars) and `<short-run-id>` is the first 8 hex chars of the run id. The
same run filing the same report twice — a retry after a transient write
failure — lands one node, not two: write with `if_exists: "skip"` (API.md
§1). A **207** partial-success from the batch `POST /v1/nodes` door, or a
per-entry `status: "skipped"`, both count as **landed** — only a hard
transport failure or a rejected entry means the write did not happen.

**Size discipline.** The server caps a node's `summary` at 500 chars and its
body at 8192 bytes; a filed report stays comfortably under both so a long
final report is *truncated here*, never rejected wholesale (a rejected write
is a lost report): body truncated at **7000 bytes** (byte-exact, cut back to
the last clean UTF-8 boundary, with a trailing `[report truncated — see the
run log for the full text]` notice), summary at **460 chars**, id stem at
**40 chars**.

## 8. `spor runs --json` — the run-record schema

Every dispatched run gets one persistent JSON record. `spor runs --json`
prints `{reconciled: bool, count: N, runs: [<record>, ...]}` — `reconciled:
false` means a native-harness live-agent listing failed for this call, so
any shown native-background record that isn't yet terminal may be stale.
Each `<record>` spans two independent dimensions: **process** (how the run's
*process* ended — always present) and **outcome** (what the run did to the
*graph* — present once the terminal-state contract has run, §6). Consumers
should treat unlisted/absent fields as `null`/absent, not as a schema
violation — new fields may be added additively.

**Process dimension** (every record):

| Field | Type | Meaning |
|---|---|---|
| `run_id` | string (uuid) | this run's unique id |
| `node_id` | string \| null | the target node, or `null` for a free-text dispatch |
| `name` | string \| null | the launch name (defaults to the node id, or the first few words of free text) |
| `harness` | string | adapter id: `claude-code`, `codex`, `opencode`, `copilot`, … |
| `launch_mode` | string | `"native-background"` (detaches into the harness's own daemon) or `"supervised-jsonl"` (runs under a supervisor Spor owns) |
| `state` | string | `"launching"` → `"running"` → one of the **terminal** process states: `"done"`, `"failed"`, `"failed_launch"`, `"vanished"` |
| `cwd` | string | the run's working directory |
| `model` | string \| null | native runs only — model override, when set |
| `created_at` | ISO 8601 | when the record was opened |
| `started_at` | ISO 8601 | supervised runs only — when the child process actually started |
| `launched_at` | ISO 8601 | native runs only — when the launcher observed the harness hand off to its background daemon |
| `launcher_exit` | int \| null | native runs only — the foreground launcher process's own exit code |
| `finished_at` | ISO 8601 | when the record went terminal |
| `exit_code` | int \| null | supervised runs only |
| `signal` | string \| null | supervised runs only — the OS signal, if any |
| `termination_class` | string | a broad bucket: `"completed"`, `"environment"` (credit/rate/auth exhaustion — re-dispatchable, not a real failure), `"launch"`, `"failed"` (a supervised child that launched but exited nonzero for no recognized environment reason), or `"unknown"` — an open vocabulary; do not exhaustively `switch` on it |
| `termination_signal` | string | a short machine tag within the class, e.g. `"supervised-exit"`, `"nonzero-exit"`, `"credit-exhausted"`, `"supervisor-gone"`, `"launch-failed"` |
| `termination_reason` | string | a human-readable one-line explanation (≤ 300 chars) |
| `error` | string | optional — the raw underlying error message, when there was one |
| `session_id` | string \| null | the harness's own session/thread id, possibly bound after launch (§2) |
| `bound_at` | ISO 8601 | native runs only — when `session_id` was captured |
| `transcript_path` | string | native runs only, when a transcript was found |
| `log_path` | string | supervised runs only — the raw JSONL/stderr log |
| `report_path` | string | supervised runs only — where the harness's own final-message text landed, if any |
| `child_reaped` | bool | optional — an orphaned harness child was terminated at reconciliation time |

Fields like `runner_pid`, `child_pid`, `runner_started_ticks`,
`child_started_ticks`, and `contract_pending` also ride on supervised records;
they are internal bookkeeping — process identity for reconciliation (guarding
against pid reuse), and, for `contract_pending`, whether the outcome dimension
on a just-closed record is still the provisional placeholder rather than the
settled verdict (a record goes terminal synchronously, and §6 runs a beat
later). They are not meaningful to an external consumer, which should poll for
`terminal_state` rather than trying to interpret them.

**Outcome dimension** (present once §6 has run against this record; a
record still `launching`/`running` has none of these yet):

| Field | Type | Meaning |
|---|---|---|
| `terminal_state` | string | `"resolved"` \| `"reported"` \| `"failed"` — see §6 |
| `terminal_enforced` | bool | whether this was a *verified* verdict (re-read against a reachable graph) or a best-effort classification — **gate on this before trusting `terminal_state` as ground truth** |
| `resolved_by` | string | present only when `terminal_state === "resolved"` — the resolver node's id |
| `resolved_edge` | string | present only when resolved — `"resolves"` or `"answers"` |
| `report_node_id` | string | present only when a report was actually filed — its presence always implies `terminal_state === "reported"`, but an unenforced `reported` record (§6) may have none (§7) |
| `lease_released` | bool | optional — `true`/`false` reports whether a release attempt succeeded; **omitted** (not `false`) when no lease was this run's to release at all |
| `terminal_note` | string | a human-readable explanation of the outcome, always present once this dimension exists |

A record with `terminal_state` unset (or `state` still non-terminal) has not
finished; poll or watch the record file rather than assuming absence means
failure.

**Gate dimension** (gate-armed workers only, §10 — absent everywhere else, and
written only after the outcome dimension exists):

| Field | Type | Meaning |
|---|---|---|
| `gate_state` | string | `"running"` \| `"interrupted"` \| `"passed"` \| `"failed"` \| `"blocked"` — the last thing a gate pipeline said about this run. The three verdicts are SETTLED; the other two mean a pipeline started and never reported, which is what a later worker resumes from (§10.8) |
| `gate_worker` | string | the worker id that last touched it |
| `gate_at` | ISO 8601 | when that stamp was written |
| `gate_reason` | string | optional — the settled verdict's one-line reason |

A consumer reading `gate_state` as a verdict must check it is one of the three
settled values: `running` under a worker that is gone is a claim nobody
finished judging, not a pass.

**Retention.** Terminal records age out after `dispatch.runRetentionMs`
(default 14 days — a config-cascade key, set in `.spor.json` or
`$SPOR_HOME/config.json`; there is no env-var override) — read a record's
outcome before that window closes if it needs to outlive the run itself; the graph
(the report artifact, the resolving edge) is the durable copy, this record
is an operational journal.

## 9. Minimal conformance checklist

A worker (and its launcher, if separate) is a conforming Spor worker when it:

- [ ] authenticates as an **agent-scoped token** (§2), not a person's own
      credential, for every graph write it makes while doing the work
- [ ] **claims** its target node before starting (§3), and renews before the
      lease's `expires_in_ms` horizon closes if the work runs long
- [ ] reads the compiled briefing for its target before acting non-trivially
      (§4) — a worker that skips this reinvents decisions the graph already
      settled
- [ ] on finishing, checks the target for a **live resolving edge** rather
      than declaring victory itself (§6)
- [ ] if no resolving edge exists, **files its final report as an artifact**
      `relates-to` the target (§7) — never silently drops the work
- [ ] **releases the lease only after the report write is confirmed** — a
      refused write leaves the lease held, never released with nothing to
      show for it (§6)
- [ ] never routes a mention-less question without stamping the session's
      project (§4)
- [ ] if autonomous (picking its own work from the pool, not dispatched at a
      named node by a person), never claims a `readiness: human` item (§3)

## 10. The gate pipeline — enforcement between the claim and the resolve

Everything above says how a worker reports what it did. This section says how a
**factory** decides whether that is good enough
(task-spor-work-gate-pipeline, dec-spor-software-factory-substrate). The rule
it exists to keep is one sentence: **gates are enforced in code by the runner,
never handed to an orchestrator agent as prose instructions.** A prompt that
asks an agent to "run the review and act on it" is not a gate — it is a
suggestion with a plausible-looking transcript.

It is entirely OPT-IN. `spor work` with no factory declared runs exactly as §1-§9
describe. Point it at one — `spor work --factory <id>`, or the `work.factory`
config key — and the declared gates run between the run ending and the item
counting as done. There is no adoption cliff in either direction.

### 10.1 The factory definition is graph data

A `type: factory` node (candidate schema `schema-factory`; `spor schema adopt
schema-factory`) carries a fenced JSON payload:

```json
{
  "factory": "spor-default",
  "trusted_ref": "main",
  "protected_paths": ["test/**", "conformance/**"],
  "test_lane_profile": "profile-test-writer",
  "risk_classes": { "touches:auth": ["lib/auth.js", "**/auth/**"] },
  "gates": [
    {"id": "acceptance", "kind": "command", "command": "npm test", "timeout_ms": 900000},
    {"ref": "gate-adversarial-review", "cycles": 2},
    {"id": "security-approval", "kind": "human", "risk": ["touches:auth"]}
  ]
}
```

`gates` is ORDERED, and each entry is either written inline or referenced as a
shareable `type: gate` node (`schema-gate`) — org governance vets a
`gate-security-review` once and every factory references it. **The runner treats
the two shapes identically**: a reference is unwrapped into exactly the object an
inline gate would have been, with keys written beside the `ref` overriding it.
The only visible difference is the provenance stamped on the recorded outcome.

Writing one by hand is not the only door: the reference client ships a
factory-builder skill (`/spor:factory`, `skills/factory/`) that compiles a
definition from an operator interview plus a read of the repo, the graph and
the machine's capabilities, and maintains it afterwards from the `art-gate-*`
facts §10.6 leaves behind. It authors DATA only — the nodes below — and never
enforces anything, which is the same split this section exists to keep: skills
compile factories, code enforces them
(dec-spor-software-factory-substrate). A third-party client needs no such
skill; the node shapes here are the whole contract.

A definition that cannot be read, or that does not validate, **refuses to start
the worker** (exit 1, naming every problem). A mistyped factory must never
produce a worker that silently accepts everything, so the validation is
deliberately strict: an unknown gate kind, a command gate with no command, an
agent-review gate with no profile, a reference the graph cannot supply, a
duplicate gate id, `protected_paths` with no `test_lane_profile` to route to,
and a human gate naming a risk class the factory never declared are all fatal.

**`status` is enforced too**, not just read: the factory node itself, and every
`type: gate` node it references, must be `status: active` (or carry no
`status` at all — GRAPH.md's default-active convention) or the worker refuses
to start, naming the offending node and its status. Retiring a factory or a
shared gate by flipping its status to `retired` (or leaving it `proposed`) is
therefore enough on its own to decommission it — an operator does not also
have to go remove it from every `--factory`/`work.factory` reference or gate
list by hand.

### 10.2 What gets gated

Two run outcomes, and only two (`shouldGate`, lib/shell/work-loop.js):

- **`resolved`** — the run wrote a resolver and §6 verified the edge on the
  graph. That verified claim is precisely what the gates test.
- **an unenforced `reported`** — a run whose claim nobody could check at all
  (local-mode dispatch, an unreachable server, a native-background launch).
  The gates are then the only check there is, so skipping them would make
  gating quietly mode-dependent.

An ENFORCED `reported` run self-declares *not* done (the item is already back in
the pool carrying its report) and a `failed` run produced nothing to gate.

A gated item **keeps its worker slot** until the pipeline settles — a slot frees
on a settled outcome, and a gate verdict is part of that outcome. Its node is
also **out of candidate selection** for as long as it is gating — for every
worker on the box, not just the one holding it (§10.8): gating is unfinished
work, so a free slot never re-dispatches the item a gate is still judging. A
failed or blocked pipeline cools the item off for
`work.retryAfterMs`, so the worker walks on down the queue instead of
re-dispatching what its own gate just refused — and demotes it on the graph
(§10.7), because a cooldown is machine-local and a refusal must not be.

### 10.3 Command gates — the trusted-ref suite, and the protected-path lane

"Tests are more accurate than the code under test" only holds while the thing
under test cannot rewrite its own judge. So a command gate:

1. reads the change under judgement from the run's own working tree —
   `merge-base(trusted_ref, HEAD)..HEAD`, **committed work only** (uncommitted
   changes to TRACKED files refuse the gate rather than being judged: the tree
   the gate would take is then not the tree the agent produced. Untracked
   residue — a coverage dir, a build artifact a suite left behind — is ignored,
   since the gate builds its own tree from the commit. A `git status` that
   cannot be read is itself a refusal, never a clean tree);
2. **fails CLOSED** if that change touches any declared protected test path —
   the suite is not run at all, no fix cycle is offered, and the test change is
   filed as its own queue item naming the `test_lane_profile` (a different lane,
   which a `spor work --profile <lane>` worker or a person picks up). Same
   entity, same misunderstanding: the lane that writes the test may not be the
   lane that writes the code;
3. otherwise materializes a throwaway git worktree at the implementer's commit
   and **forces every protected path back to the trusted ref's copy** (files the
   branch added under a protected path are removed), then runs the declared
   command there.

Step 3 is belt and braces — step 2 already refuses a branch that touched those
paths — and that is the point: the guarantee that the suite is the trusted ref's
copy does not rest on the check having run.

### 10.4 Agent-review gates — a verdict that is read, not asserted

The runner composes the review dispatch itself: a free-text launch under the
gate's declared `profile` (cross-model by convention; the machine's own declared
harness binding still decides what actually executes — a graph write never
defines what a box runs), with a fixed prompt that ends:

```json
{"verdict": "pass" | "changes_requested", "findings": [{"severity": "...", "file": "...", "summary": "..."}]}
```

The runner then parses that block **in code** from the run's final report.
Fail-closed throughout: a review that could not be dispatched, that never
finished, that left no report to read (an agent-review gate must therefore route
to a SUPERVISED harness — a native-background launch has no report channel), or
whose verdict is unparseable or unrecognized is a gate FAILURE. An unread review
is not an approval.

On `changes_requested` with cycles left, the runner dispatches an implementer
**fix cycle** — the findings and the evidence, at the same node, in the same
tree — waits for it to reach a terminal state, re-reads the diff, and re-runs
the gate. This is the one place the worker passes `--force`: the node reads
resolved because the run resolved it, and the runner knows why it is going back.
The declared `cycles` cap bounds it; at the cap the gate **escalates** by filing
a `requires: [human]` queue item carrying the cycle history, and stops.

### 10.5 Human gates — approval keyed on declared risk

A human gate declares the `risk` classes that ARM it (a gate declaring none is
unconditional). If the change touched none of them, the gate is `skipped` and
recorded as such. If it did, the runner files an approval item — `requires:
[human]`, so no worker can ever claim it — naming the risk classes and the exact
paths, and **blocks the resolve** while polling it:

- the item gains a **live resolving edge** → **approved**, the gate passes.
  Only that; a bare status flip is not an approval, which is the same rule §6
  applies to a worker's own claim of completion;
- it reaches any other terminal status (`abandoned`, `closed`, `superseded`, …)
  → **refused**, the gate fails; the approval item itself is the human record,
  so nothing further is filed;
- nobody answers inside `approval_timeout_ms` (default 24h) → the pipeline
  reports **blocked**, the approval item stands, and the worker moves on rather
  than deciding on the person's behalf.

### 10.6 Every gate outcome is a graph fact

Each gate — passed, skipped, failed, fail-closed or blocking — writes one
artifact node `art-gate-<gate>-<stem>-<short-run-id>`, carrying `relates-to` the
work item (and the escalation, where there is one), the verdict, the cycle
history and the evidence. Deterministic and idempotent, exactly like the
dispatch report (§7): the same gate recorded twice for one run is one node.

`relates-to`, never `resolves` — a gate outcome records what the runner
enforced; it does not retire anything. A graph that refuses the write does not
change the verdict (the enforcement is not the bookkeeping), and the runner says
so rather than claiming a fact it could not write.

`spor work --status` reads the same story back per worker: what is gating now,
the passed/failed/blocked tally, and the reason a gated item was cooled off.

### 10.7 A refusal is graph state, not a machine-local cooldown

The gate necessarily runs AFTER the run wrote its resolver, so a refused claim
is one the graph is *already carrying as finished* — a `resolved` run means §6
verified the resolving edge. Cooling the node off is machine-local and says
nothing to any other reader. So a failed or blocked pipeline also **demotes the
item on the graph**, in two parts that do different jobs:

- the person's item the gate filed — escalation, approval, or test-change lane —
  carries **`blocks`** onto the work item, not `relates-to`. **This is the
  fail-closed half**: it is a live `requires: [human]` queue item that names the
  work item as its dependent, so the refusal is a graph fact any reader can
  follow and the person's own queue surfaces it. It is written into that node at
  file time, so the dependency lands in one validated write and can never be
  half-applied;
- the work item's own **completion status is rolled back** to `open`, so the
  status-derived surfaces stop reporting the refused claim as finished — `spor
  get`'s ⚠ for an open status contradicting a resolving edge, work analytics,
  and `spor work --status`. Only a claim of completion is touched (the type's
  declared `status.completion`, e.g. a task's `done`): an item that never left
  the queue is left exactly as it is, and a deliberately `abandoned` one is never
  reopened — a gate refuses "this is finished", it does not reverse a person's
  decision to drop the work.

What the rollback deliberately does **not** do is put the item back in the
queue. Queue liveness is derived from the resolving **edge**, not the status
(`lib/kernel/queue.js` retires a node with a live inbound `resolves`/`answers`
regardless of what `status` says), and this runner never retracts an edge: the
client has no edge-removal door, and the resolver node is the agent's own
durable record of what it did — deleting the link would destroy evidence in
order to express a verdict. That is the right shape for a refusal: the item must
NOT come back round to a worker behind a person's back. The escalation is the
live item now; a person who agrees with the gate retires the resolver themselves.

A **passing** gate never re-flips the status either. Writing `done` would be the
runner asserting completion, and a gate records what was enforced — it does not
retire anything. So an item demoted by one cycle and approved in a later one is
closed out by the person who approved it (the schema's read hook already flags
the open-status-with-a-resolving-edge state with a ⚠).

Fail-soft, like the fact write: a graph that refuses the demotion does not turn
a refusal into a pass. The runner says what it could not do — on the gate fact
(`Demotion: …`), in the log line, and as `demoted`/`demote_reason` on the
worker's `recent` entry.

### 10.8 An interrupted pipeline is resumed, not lost

A dispatched run is a detached process that owns its own terminal contract, so a
worker that stops leaves it to finish and self-report (§1). A **gate pipeline is
different**: it is the one piece of work the worker PROCESS owns, so a worker
that is stopped or killed abandons it — and the run it was judging is already
terminal and (for a `resolved` one) already out of every queue, so no candidate
poll would ever come back to it. Left there, the claim stands permanently
un-judged, which is the single outcome a factory exists to prevent.

Two durable records make it recoverable by any later worker on the box:

- each pipeline stamps **`gate_state`** on its run record — `running` when it
  starts, `interrupted` when a stop abandons it, and the settled verdict
  (`passed`/`failed`/`blocked`) when it reports. A settled verdict is FINAL for
  that run: nothing may overwrite it, so a duplicate pipeline (see below) can
  never launder a `failed` into a `passed`, and a stop cannot reopen one. On the
  way out of the loop the worker makes one last pass over its pipelines, so a
  verdict that landed while it was stopping is recorded rather than thrown away
  for the next worker to re-derive;
- the per-worker status file already records which slots that worker held, and
  `spor work --status` already reads a worker whose pid is gone as STALE.

A gate-armed worker joins the two at each pass, **before** taking new work: a
slot held by a worker that is not live, whose run record is terminal, carries a
claim worth gating (§10.2), and has no settled `gate_state`, is adopted and
re-gated.

Which slots count is a question of **provenance**, and the two lists differ. A
`gating` slot only ever exists on a gate-armed worker, so it is owed a verdict
by construction. An `active` slot exists on **every** worker, bare ones
included — and a bare worker (no factory: the shipped default, and the whole
"adoption has no cliff" guarantee) was never owed a gate at all. So an `active`
slot counts only when that dead worker's own status record says it ran
gate-armed, which its `gates` tally records iff a factory resolved. Without that
scoping a gate-armed worker would retroactively judge a bare worker's runs — and
on a refusal file a `blocks` edge and roll back the status of an item a person
may have deliberately closed.

**A resumed pipeline re-runs its gates from the first one.** `gate_state` is one
word about the whole pipeline; there is no per-gate progress record, so the
suite runs again, the review is dispatched again, and the fix loop is re-entered
from cycle 0. The fact *nodes* are idempotent (deterministic ids), so the graph
record does not double — but the side effects are not, and one of them matters:
a fix cycle dispatches an implementer at the node with `--force` and
`--no-worktree`, into the run's own checkout, and the abandoned pipeline may
have left exactly such an agent running (it is a detached process that outlived
its worker). So an orphan whose **node still has a non-terminal run record is
deferred**, not adopted — the next pass takes it once that agent's run is
terminal. A record aged past the worker's own watchdog ceiling is not evidence
of a live agent, so it cannot defer an orphan forever.

Scoping the candidate set to slots a work loop actually held is what keeps this
from becoming "gate every run ever dispatched on this box": a hand-run `spor
dispatch`, or a run from a worker that had no factory, was never owed a gate and
is never resumed. Resumption is bounded by the free slots, so a backlog is
worked down over passes rather than spawning a pipeline per orphan at once, and
it sits under the same wind-down guards as a dispatch — a worker past its
`--max`, or draining a `--once` run, leaves the orphans for the next worker,
which is exactly what they are for.

**The run record has no lock**, and one race is worth stating outright rather
than implying it away. The gate stamp is written out of band by the worker,
while the two in-process writers (a supervisor finishing its terminal-state
contract, a native launcher binding a session) write the *whole* record from an
in-memory copy. `carryGateFields` re-reads the `gate_*` namespace before those
writes, which closes the ordinary ordering — but a supervisor that READ before a
settle and RENAMED after it reverts a settled `failed`/`blocked` back to
`running`. Two things bound that, and neither is "it cannot happen":

- **the consequence is duplicated work, not a laundered verdict.** Every gate
  fact is written to the graph *before* the pipeline settles, and fact ids are
  deterministic; the refusal's durable half — the `blocks` edge and the status
  rollback (§10.7) — is on the graph and no run-record write touches it. A
  reverted record makes a later worker re-run the pipeline and re-record the
  same nodes: a wasted suite run or review dispatch, and no wrong answer;
- **a verify-and-reapply pass closes it in practice.** After writing a
  `gate_state` the worker reads the record back, and a value that is not the one
  it just wrote means something clobbered it — so it writes again, boundedly (an
  unbounded retry against a contended file is a spin, and giving up simply
  re-offers the run to the resume scan). The settled-verdict guard runs on every
  attempt, so a clobber that turns out to be *another worker legitimately
  settling first* is yielded to rather than fought.

**Two workers on one box** are kept off a single orphan by two independent
exclusions, because they see each other through two files that both lag: run ids
in a live worker's own published slots, and run records already claimed
`running` by a live `gate_worker` (stamped *before* the slot is published, so it
is the earlier signal). The residual is a genuine read-read race — both scanning
before either writes — which cannot be closed without a cross-process lock, so
its *damage* is bounded instead: the gate facts are idempotent, and a settled
`gate_state` is final, so a duplicate pipeline can never overwrite the winner's
`failed` with its own `passed`. A live worker's gating nodes are also subtracted
from every worker's candidate poll, so a second worker does not *dispatch* the
node a first is gating (a gated run is terminal, so the in-flight agent guard
cannot see it, and an unenforced `reported` one has already handed its lease
back).

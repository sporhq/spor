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
question) and a worker should never claim it. `suggest` on each item
(`do`/`dispatch`/`blocked`/`triage`/`close`/`approve`) is a further hint;
`blocked` means a live `blocks` edge still gates it — claiming it is legal
but the item cannot resolve until its blocker does.

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

Fields like `runner_pid`, `child_pid`, `runner_started_ticks`, and
`child_started_ticks` also ride on supervised records; they are internal
process-identity bookkeeping for reconciliation (guarding against pid reuse)
and are not meaningful to an external consumer.

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
- [ ] never claims a `readiness: human` item (§3), and never routes a
      mention-less question without stamping the session's project (§4)

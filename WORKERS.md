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

**No agent identity resolves, or minting one fails?** Per
dec-spor-worker-strictness-split-interactive-lenient this now HARD-FAILS,
naming the fix (`spor agent use <agent-id>`) — never a silent fall back to a
person-scoped token, which is exactly the human step agent attribution exists
to keep out of the loop. Unlike the readiness-gap split in §3, this one isn't
locked to a surface: both `spor dispatch` and the autonomous `spor work` loop
refuse by default, and both accept the SAME explicit escape hatch —
`--allow-person-token` (or the standing `dispatch.allowPersonToken` config
key) — with a loud warning on every fallback launch it permits. The escape
hatch exists for solo/local use where nobody has bothered to mint a machine
identity and that's a deliberate choice, not an accident; leaving it unset is
what keeps an unattended worker from ever silently misattributing agent work
to the person that happens to own its token.

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
itself the human step the readiness gap exists to route through.

**Acceptance policy** (`work.accept` / `--accept` / `SPOR_WORK_ACCEPT`;
dec-spor-work-accept-policy-configurable). On top of that floor, an
autonomous worker's pickup is configurable. `ready` — the **default** — is
explicit consent: it dispatches only items whose derived readiness is
`agent` (a person's `spor ready <id>` stamp, or an `assigned -> agent`
routing), so on a team nothing runs on a worker box without that green
light; an `untriaged` item is skipped with a visible reason (`not
agent-ready; work.accept ready`) on the worker's stdout and in `spor work
--status`, never silently hidden. `open` opts back into the original looser
pickup: everything except `readiness: human`. The human floor above is not
part of this knob — no policy value makes a worker claim a
`readiness: human` item. Resolution is the ordinary config cascade
(`--accept` > `SPOR_WORK_ACCEPT` > repo `.spor.json` > user config >
default `ready`); an unknown value refuses to start the worker rather than
silently falling back. `spor work --print` shows the effective policy.

**The page widens rather than starving.** Selection reads a fixed-size ranked
page, and the policy (and a factory's repo scope, §10.6) filters what comes
back — so a page filled entirely by items this worker may not take would hide
an eligible one ranked below it on every poll, forever. When nothing on the
page is dispatchable by this worker — un-consented, out of scope, already in
flight here, or cooling off after a refusal — the fetch is repeated with the
limit doubled, up to 200, until something is or the queue is exhausted. The
cooldowns count, deliberately: an item that refuses deterministically (a
profile this box cannot satisfy) would otherwise pin the page at its own rank
forever. A pass that finds a candidate on the first page pays nothing extra,
and in local mode a widened read re-ranks the graph it already loaded. The
skips themselves stay visible: the first five of a pass are named individually
on stdout and the rest are aggregated by reason (`...and 31 more skipped this
pass — 31 not agent-ready`); `spor work --status` and `--print` do the same,
with `--status --json` carrying every entry. The cooldowns a worker remembers
are bounded, and when it must forget one it forgets a policy or scope skip
before a refusal — the first is recomputed from the next page for free, while
the second is the only thing keeping a dispatch that already failed from being
run again.

`suggest`
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
4. **Worker contract** (`spor work` only). An unattended worker appends a
   standing contract as the task's instruction text
   (`lib/shell/worker-contract.js`): work only in the launched checkout and
   branch, never merge to or push the target ref, do not edit the factory's
   protected test paths, verify deterministically, **commit everything and
   leave the tree clean BEFORE resolving**, resolve the item LAST with a
   resolver node carrying a `resolves` edge, and if the item will not
   converge leave it unresolved with the blocker named in the report. The
   factory-specific lines (the integration target, the acceptance command,
   the protected paths and their lane, the cross-model review) appear only
   when the factory declares them; a bare worker's contract is the plain
   commit-then-resolve discipline. A person's one-off `spor dispatch` adds
   nothing — they write their own instructions.

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
| `gate_fix_run_id` | string | optional — the run id of the most recent fix cycle this pipeline dispatched at the same node, stamped the moment it was dispatched (not when it finishes). If a stop lands while that fix cycle is still going, this field is what turns "the pipeline was abandoned" into "here is the run to go check" — a fix cycle's own dispatched run is detached and keeps going regardless (§10.7), and this is the only durable pointer to it. `spor runs`/`spor work --status` surface it. |
| `gate_fix_at` | ISO 8601 | when `gate_fix_run_id` was stamped |
| `gate_progress` | object | optional — `{key, at, seq, gates: {<gate id>: {fixes, attempts, ledger, lastFix}}}`: each gate's own memory (§10.4), saved after every review verdict (with the fix it decided on as `lastFix.dispatched: false`) and again when the fix's launch is known (`fixes` counts LAUNCHED fixes only). `key` is the attempt's run key — a resumed pipeline of the same attempt reads it back; a `--regate` (a new attempt) ignores it. Best-effort like every `gate_*` stamp: a write that fails is logged and the pipeline goes on |

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
  "repos": ["spor"],
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

**`repos` is the scope a factory may judge, and the worker's `--project` is
not** (issue-spor-work-scope-union-factory-mismatch). A queue scope token is
deliberately union-y — a bare repo slug resolves UP to its home-project
grouping and unions the members, which is the right read for a human — so
`spor work --factory factory-x --project my-repo` is handed the SIBLING repos'
items too, and a command gate and an integration command authored for one
checkout would run against them anyway (agreeing only by luck, when the two
repos happen to build the same way). So:

- The declared `repos` bound what the pipeline gates. An item whose own repo
  stamp is not one of them is **skipped with the reason on stdout and in
  `--status`**, never gated — the same visible-skip treatment a policy skip
  gets, and never a silent drop.
- Undeclared, the factory NODE's own `repo:` stamp is the scope — a factory
  authored for one repo says so by living in it. A factory with neither is
  UNSCOPED and behaves exactly as it did before this field existed.
- An item carrying no repo stamp at all is outside every declared scope: a
  worker that cannot tell which repo an item belongs to must not run a
  repo-specific suite against it. Historical stamps under a repo's `slugs:`
  aliases are compared RAW, so an alias-stamped item is skipped rather than
  mis-gated — name the alias in `repos` to admit it.
- `repos` is a scope, not a page filter: with a single declared repo and no
  explicit `--project`, the worker's queue scope DEFAULTS to that repo's slug
  (union semantics and all — a wide read costs one filtered candidate, while a
  wrong-narrow token would cost the work).
- `"repos": []` is an error, not "judge everything": an empty scope reads
  exactly like the bug it exists to fix.
- A `repo-<slug>` node id is accepted and admits items stamped `<slug>`; the
  reverse is not, because a repo genuinely named `repo-tools` is a different
  repo from `tools` and admitting it would fail OPEN.
- **Resumption is scoped by factory, not by repo** (§10.8): an orphaned
  pipeline never passes through candidate selection, so a worker adopts one
  only when the dead worker's own factory id matches its own. An orphan left
  by another factory is named on stderr and left for a worker armed with that
  factory — the same argument that keeps a gate-armed worker off a BARE
  worker's runs.
- A scoped worker that discards a whole queue page says so once, rather than
  idling indistinguishably from an empty queue; in local mode a declared repo
  that names nothing in the graph is warned about at startup.
- Under a multi-repo factory the item's repo and the worker's scope token are
  different things, and every node the pipeline writes — the `art-gate-*` /
  `art-merge-*` facts, the escalation, the test-change-lane item, the approval
  item, the proposal tracker — is filed under the ITEM's, so a project-scoped
  queue shows the work it belongs to.

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
and a human gate naming a risk class the factory never declared are all fatal,
as is a `repos` list that names no repo.

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
   filed as its own queue item naming the `test_lane_profile` (a different
   lane). Same entity, same misunderstanding: the lane that writes the test may
   not be the lane that writes the code;
3. otherwise materializes a throwaway git worktree at the implementer's commit
   and **forces every protected path back to the trusted ref's copy** (files the
   branch added under a protected path are removed), stages that tree with the
   repo's own `dispatch.worktreeSetup` hook exactly as a dispatch worktree is
   staged (a `node_modules` symlink, a pinned sibling checkout — whatever the
   suite needs that is not in git; the hook's `.claude/settings.local.json`
   `env` block reaches the suite's environment too), then runs the declared
   command there. A hook that fails refuses the tree — the suite is never run
   on a half-staged one. Both hooks — `dispatch.worktreeSetup` and its twin
   `dispatch.worktreeTeardown`, run before a tree is removed — see
   `SPOR_TREE_ROLE` (`dispatch` | `gate` | `integration`) beside the rest of
   the hook env, so a repo can start a database only for the trees whose
   suite needs one and stop it again.

Two more things a command gate may declare, for a suite that owns something
outside git (a database on a fixed port, a `db reset`):

- **`risk`** — the same arming predicate a human gate has (§10.5): with risk
  classes declared, the gate runs only when the change touched one of them,
  and otherwise records `skipped` — a fact, not a pass by omission. An
  unreadable diff still fails closed.
- **`serialize: "repo"`** — the gate takes the repo's lease (the one the
  integration stage holds, keyed on the main checkout locally and the
  synthetic per-repo lock node remotely) before its suite and releases it
  after, so two gate trees, or a gate tree and a landing, never share the
  singleton. Fail-open like the integration lease: an unavailable lease is
  logged and the suite runs.

The suite's environment says what it is judging: `SPOR_GATE_BASE` and
`SPOR_GATE_HEAD` (the shas), `SPOR_TRUSTED_REF`, `SPOR_GATE_STAGE` (`gate`,
or `integration` for the candidate suite, where base/head are the target
ref's tip and the candidate), and `SPOR_GATE_NODE`, beside `CI=1` and
`SPOR_GATE=<id>` — enough for a script to diff and decide what to run.

Step 3 is belt and braces — step 2 already refuses a branch that touched those
paths — and that is the point: the guarantee that the suite is the trusted ref's
copy does not rest on the check having run.

**The lane item routes itself** (task-spor-test-change-lane-auto-routing): the
filed item carries the lane as `profile:` frontmatter (`buildGateWorkNode`), and
every queue item `dispatchableQueuePage`/`rankQueue` returns surfaces its
`profile:` frontmatter verbatim when set. Both dispatch entry points read it
back and pass it through as if `--profile <lane>` had been given for that one
dispatch, unless an explicit `--profile` on the CLI already pins one (which
wins — the same explicit-beats-inferred precedence `resolveDispatchProfile`
applies to a node's `assigned -> agent` edge):

- `spor work`'s continuous loop (`dispatchWorkItem`) — so a plain `spor work`
  (no `--profile`) only picks up the lane item on a box that can satisfy that
  profile, and refuses loudly and cools off everywhere else, same as an
  explicit `--profile` targeting an unsatisfiable profile would;
- `spor dispatch --from-queue`'s one-shot "take the top item" — without this
  the lane item (which carries no `assigned -> agent` edge for
  `resolveDispatchProfile` to fall back to) would dispatch with **no profile
  check at all**, silently defeating the separation the lane exists to
  enforce.

Either way the item is left for a `spor work --profile <lane>` worker, a
`spor dispatch --profile <lane>` run, or a person to take once a box that
satisfies the profile picks it up.

### 10.4 Agent-review gates — a verdict that is read, not asserted

The runner composes the review dispatch itself: a launch under the gate's
declared `profile` (cross-model by convention; the machine's own declared
harness binding still decides what actually executes — a graph write never
defines what a box runs), **read-only** (`spor dispatch --read-only`: Codex's
`--sandbox read-only`, Claude Code's plan permission mode, OpenCode's built-in
`plan` agent (edit denied everywhere), Copilot's `--deny-tool write --deny-tool
shell` (the file-writing tool AND the shell tool denied at the permission
layer — Copilot has no sandbox, and a shell command writes the live checkout as
freely as the write tool, so leaving `shell` open was a prompt-bounded posture,
not an enforced one; the named cost is that a Copilot-routed reviewer cannot run
commands and therefore cannot DEMONSTRATE a blocking finding — its verdicts are
advisory, and a gate that needs blocking power routes elsewhere) — the
reviewer reads the implementer's live checkout, so it must not be able to write
to it, and the posture overrides any write-capable `--sandbox`/
`--permission-mode` the worker's passthrough carries. A harness with NO
declared posture — a declared custom harness, by v1 scope — is **refused**
before launch, never run write-capable behind a warning: `--read-only` is a
promise, and a review gate has to route to a harness that can keep it), with a
prompt that carries everything the reviewer needs
rather than sending it to read a growing `base..head` diff on its own: the work
item's text, the diff itself (bounded; the git command for the rest), the gate's
`instructions`, and — on a fix cycle — the **prior findings** and the fix that
was dispatched at them (its run, its commits and their stat). It ends with the
verdict shape:

```json
{"verdict": "pass" | "changes_requested",
 "prior": [{"id": "F1", "status": "resolved" | "open", "note": "..."}],
 "findings": [{"severity": "blocking|major|minor", "file": "...", "summary": "...",
               "evidence": "the command/test run and what it showed", "introduced_by_fix": true | false}]}
```

The runner then parses that block **in code** from the run's final report
(`parseReviewVerdict`, lib/kernel/gates.js). Fail-closed throughout: a review
that could not be dispatched, that never finished, that left no report to read
(an agent-review gate must therefore route to a SUPERVISED harness — a
native-background launch has no report channel), or whose verdict is
unparseable or unrecognized is a gate FAILURE. An unread review is not an
approval. Nor is a review of nothing: a branch that carries **no committed
change against the trusted ref** (the implementer landed its work on the
trusted ref directly, or resolved with nothing behind it) fails the gate closed
and unretried, straight to a person — no reviewer is dispatched at an empty
diff, because a vacuous pass is exactly how an unreviewed change would launder
into an approval.

**The gate is stateful and bounded** (task-spor-review-gate-stateful-bounded).
The first live runs showed a memoryless reviewer raising a NEW blocking finding
on every cycle — four different ones by the escalation, none of them what the
fixer had been sent to fix — so the protocol the parser enforces is:

- **Only `blocking` blocks.** Every other severity (`major`, `minor`,
  `critical`, anything) is advisory: recorded on the fact, handed to the fixer
  as a note, never a reason to fail the gate. A `changes_requested` that rates
  nothing blocking is a pass with notes; a `pass` that reports a blocking
  finding is `changes_requested` (the findings win over the word, both ways).
  But a request for changes that SAYS NOTHING is not a pass with notes: a
  `changes_requested` with no findings list, with an empty list and no prior
  finding confirmed open, or with any entry the parser cannot read (not an
  object, or no summary — under either word) is **unreadable and fails
  closed**, for the prior set only. Unreadable findings are never filtered
  down to "nothing blocking".
- **A blocking finding must be demonstrated.** It carries `evidence` naming
  the command or test the reviewer ran and what it showed; one without it is
  downgraded to advisory (the record says why). But that downgrade is never
  laundered into an approval: a `changes_requested` backed ONLY by
  undemonstrated blocking findings is **unreadable and fails closed** (for the
  prior set only), with the downgraded findings recorded as advisory on the
  ledger and handed to the fixer — the reviewer asked for changes and named
  what it rated blocking, and the protocol's answer is "demonstrate it", not
  "passed". The next review is handed those entries as **raised** and may
  demonstrate one by ITS id; it then counts as raised at its original cycle
  (the ledger upgrades the entry in place), not as a goalpost. On a fix cycle
  any OTHER new blocking finding must be one the fix **introduced**
  (`introduced_by_fix: true`) — a defect available at the initial review and
  not raised then does not move the goalposts now; it is recorded for a person
  to weigh.
- **Every prior finding is answered first.** The runner keeps a **finding
  ledger** per gate — ids `F1, F2, …` minted in the order findings were first
  raised, never reused — and hands review N its open blocking entries as
  `prior`. The verdict must clear or confirm each one; a verdict that ignores
  any prior finding is **unreadable and counts as `changes_requested` for the
  prior set only**: the fixer is sent back at the still-open prior findings and
  nothing the memoryless verdict raised is admitted. (Replaying the four real
  reports of that first run through this protocol keeps every fix cycle and the
  escalation on the initial two findings; the fourth cycle's new findings never
  reach the record.)

On `changes_requested` with cycles left, the runner dispatches an implementer
**fix cycle** — the blocking findings by id, the advisory notes, what earlier
cycles already resolved (do not regress), at the same node, in the same tree —
waits for it to reach a terminal state, re-reads the diff, and re-runs the gate
with the ledger and that fix in hand. This is the one place the worker passes
`--force`: the node reads resolved because the run resolved it, and the runner
knows why it is going back. The declared `cycles` cap bounds it and counts
**fix dispatches**: `cycles: 3` is the initial review plus exactly three fix
cycles (four reviews), and the record says so — "4 attempts: the initial one
plus 3 fix cycles, cap 3", never "4 attempts, cap 3". At the cap the gate
**escalates** by filing a `requires: [human]` queue item carrying the cycle
history and the ledger, and stops. The `art-gate-*` fact carries the ledger too
(`Finding ledger:` — what was raised when, what cleared it, what still stands),
so the rescue lane and `/spor:factory`'s telemetry read convergence per gate
without re-reading every report. The ledger, the fix-cycle count, the attempt
history and the last fix are also **durable**: the runner saves them per gate
onto the pipeline's run record (`gate_progress`, §10.8) after every step that
changes them — a fix is recorded PENDING (`lastFix.dispatched: false`) in the
same save as the verdict that decided on it, and COUNTED the moment its launch
is known (the dispatch's launch callback, or its completion), never before —
so a pipeline a killed worker left behind resumes each review gate at the
cycle it reached with its prior findings intact: a worker killed before the
launch resumes INTO the unrun fix, one killed after it resumes past it, and a
cycle whose review ran but whose next step never landed is rolled out of the
ledger and re-run with fresh ids. The cap is a cap across interruptions rather
than a fresh allowance per one, and never one fix short. The kernel default is still `cycles: 0` (a
factory opts into re-dispatching an implementer); a factory that routes to a
review gate should declare at least one, since with the floor above the only
thing that reaches a person is a demonstrated blocking finding the implementer
never got to fix.

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

**A refusal can be re-judged.** A gate can refuse for a reason that is not
the item's — the trusted ref itself is red (a sibling-library drift, someone
else's landing), the suite flaked under contention, the reviewer's harness was
down. The shape above then leaves the item demoted and blocked by its
escalation, its work committed in a worktree, and nothing to re-dispatch. `spor
work --regate <run-id> --factory <id>` re-runs the factory's gates (and the
integration stage) on that same finished run once the cause is fixed outside
the item: the facts it writes carry the attempt in their ids (`…-r2-…`), so the
first verdict's record stands beside the second's and is never overwritten or
refused as a collision; on a pass it writes a resolving artifact onto the
escalation the refused attempt filed and restores the completion status that
attempt rolled back. Before judging, it merges the current trusted ref into
the run's checkout (a command gate judges the branch's own base, and the usual
reason to re-gate is that the trusted ref was red and has since been fixed);
a conflict is refused with the checkout named, a dirty tree is left for the
gate to refuse as before. It refuses a run that is still running, one that
carries no claim of completion, and one that already passed or parked. Only a re-gate
may move a settled `gate_state` on the run record — every other writer
(the loop, a resumed pipeline, a duplicate adopter) still cannot.

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

**A resumed pipeline re-runs its gates from the first one — with each gate's
memory intact.** `gate_state` is one word about the whole pipeline, so the suite
runs again and the review is dispatched again; but every gate's own progress —
its finding ledger, how many fix cycles it has dispatched, its attempt history
and the fix that was in flight — is saved on the run record as
`gate_progress` (keyed by the attempt's run key, so a `--regate` starts clean)
and read back, so a review gate resumes at the review AFTER the last fix it
dispatched, with the prior findings it had raised, and its `cycles` cap holds
across the interruption instead of being granted afresh by it
(task-spor-review-gate-stateful-bounded). The fact *nodes* are idempotent (deterministic ids), so the graph
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

### 10.9 The integration step — a code-enforced merge queue after every gate passes

Every gate above judges the implementer's **branch**. Something still has to
land it: dec-spor-factory-integration-step is the observation that a resolved,
gate-passed branch is not the same thing as shipped work, and that the
"someone runs the CAS merge by hand" step the spor-orchestrator skill performs
today is the last *instructed, not enforced* link in the factory line. The
`integration:` block closes it — a declarative merge queue the runner enforces
in code, never a prompt asking an agent to "merge when ready."

It is OPT-IN, exactly like the gate list: a factory that declares no
`integration:` block resolves work exactly as §10.1-§10.8 describe — there is
no adoption cliff here either. Declare one and it becomes the pipeline's LAST
stage, run only after every declared gate has passed:

```json
{
  "integration": {
    "target_ref": "main",
    "mode": "local",
    "command": "npm test",
    "strategy": "merge",
    "serialize": "repo"
  }
}
```

- **`target_ref`** — what "landed" means; defaults to the factory's own
  `trusted_ref`.
- **`mode`** — `local` CAS's a local ref with `git update-ref`; `push` pushes
  to a remote, whose own non-fast-forward rejection *is* the compare-and-swap;
  `propose` (task-spor-integration-propose-mode) opens a pull request instead
  of mutating `target_ref` at all, for orgs whose policy forbids a worker
  pushing straight onto it — see "Propose mode" below.
- **`command`** — the FULL suite, run on the merged CANDIDATE tree, never a
  "fast tier" deferred to a service after landing (the run's own agent context
  is what fixes a break, and it is only still around *before* the merge).
- **`strategy`** — `merge` | `squash` | `rebase`, how the candidate tree is
  built.
- **`serialize`** — the lease's scope; `repo` is the only value today (the
  merge queue is per-repo, not per-machine or per-org).

**The run holds its slot through integration.** The runner folds the
integration stage into the SAME promise `deps.gate` already returns (§10.2), so
every mechanic §10.2-§10.8 already describes — slot-holding, candidate
exclusion, cooldown on a refusal, resumption of an abandoned pipeline — applies
to integration with no separate machinery and no separate code path in the
loop itself. A factory with gates but no integration block is byte-identical
to what shipped before this stage existed.

**The candidate build.** A throwaway worktree at `merge(target_ref, branch)`
per the declared strategy — `merge` lands the branch onto the target,
`rebase` replays the branch's own commits onto it, `squash` folds the branch
into one commit on top of it. **A merge conflict is a fix-cycle event, not a
terminal error** — it is fed back to the same implementer, through the same
cycle-cap-then-escalate machinery §10.3's protected-path lane and §10.4's
review loop already use, because "the branch needs a rebase" is exactly the
kind of thing the implementer's own context is best placed to fix.

**Protected paths are forced, again.** The candidate tree gets the SAME
guarantee a command gate's tree gets (§10.3): every declared `protected_paths`
glob is forced back to the trusted ref's own copy before the suite runs, using
the identical matcher (`forceProtectedPaths`, shared by both). A command gate
already fails an implementer's protected-path edit CLOSED at claim time, so in
the ordinary case this is a no-op restoring what was never touched — the point
is that the guarantee does not rest on that earlier check having run.

That restore only rewrites the candidate worktree's WORKING DIRECTORY, though
— it creates no commit — so the sha `buildCandidate` produced still names the
pre-restoration tree. Landing that sha unchanged would ship exactly the
tampered edits the restore exists to strip, behind a suite that ran on (and
passed against) the *restored* tree
(issue-spor-integration-landed-sha-pre-restoration). So when the restore
changes anything, the stage re-commits the restored tree — amending the
candidate's own tip commit, which keeps its parents intact under every
strategy — and lands *that* sha instead (`reconcileCandidateSha` in
integration-runner.js). Belt-and-braces, same rationale as §10.3's own step 3:
this does not depend on the command gate's protected-path check having caught
the touch in the first place, and it never depends on suite success either —
the invariant is enforced on the tree that gets landed, not inferred from a
green run. A no-op restore costs nothing: the working tree already equals the
candidate sha's tree, so there is nothing to amend.

**The candidate suite runs on the merged tree**, full, every landing — never a
slow tier skipped here and deferred to a service after the merge (the
"replace your CI" observation dec-spor-factory-integration-step is built on: by
the time a post-merge check reports, the agent that could fix it is gone). A
failure is fed into the same fix-cycle machinery a conflict is.

**Landing is compare-and-swap**, and losing the race is nobody's mistake. Local
mode's `git update-ref target_ref new_sha old_sha` refuses if the ref moved
since the candidate was built (and, having moved it, brings the one checkout
that has `target_ref` checked out up to the landed commit — for the landed
paths only, and only where that checkout's index and working copy were
untouched since; a path someone edited there meanwhile is left alone and named
in the landing's note. `update-ref` alone leaves such a checkout reading as a
staged revert of everything just landed, which a plain `git commit` there would
then make real); push mode's rejection of a non-fast-forward push
is the same guarantee over a remote ref — and because the local
remote-tracking ref only moves when this box pushes or fetches, push mode
FETCHES the target branch before every candidate build (a fetch that cannot
run fails the build closed, never a race), so a rebuild after a lost race
really is against the live tip and not the same stale one. Either way, a **lost race rebuilds the
candidate against the ref's new tip and reruns** — automatically, bounded by a
small retry ceiling against the pathological case of a target that never stops
moving, and *never* charged against the fix-cycle cap: the implementer did
nothing wrong, another landing simply won first. This is what makes the
`serialize: repo` lease an optimization rather than a correctness requirement
— N workers on M machines racing the SAME target ref is made *rare* by the
lease (a server-held claim in remote mode, reusing dec-cc-task-claim-lease's
own door against a synthetic per-repo lock node; a machine-local lockfile,
scoped to the repo's own path, when there is no server to hold one against —
local mode has no lease pool at all, per §"Local mode" in
dec-cc-task-claim-lease) and made *harmless* by the CAS regardless. Every
failure acquiring the lease is fail-open: a note is logged and the stage
proceeds without one, the same posture every other best-effort dep in this
pipeline takes.

**Every landing or failure is a graph fact** (`art-merge-…`), the integration
stage's twin of §10.6's `art-gate-…` facts — same idempotent id scheme, same
`relates-to` (never `resolves`) edge onto the work item. A failure that
exhausts its fix cycles **demotes the item exactly as a failed gate does**
(§10.7): an escalation is filed, it `blocks` the work item, and the item's
completion status is rolled back if it claimed one — the run's resolver
already declared every gate passed, so the ONLY thing an integration failure
disputes is whether the change ever reached the target ref.

**Cleanup runs on a landing OR a proposal.** The candidate worktree is always
removed, win or lose (it is throwaway by construction); the implementer's own
dispatch worktree and branch are removed once their work has either actually
landed or been proposed — a `propose`-mode PR is already durable on the
remote once opened, so there is nothing left for the dispatch worktree to
hold — using the same worktree-of-this-repo safety check `spor dispatch`'s
own teardown uses, so a checkout that is not genuinely a dispatch worktree of
the repo in question, or one with uncommitted changes some *other* process
left, is refused rather than force-removed. Only an outright failure (a
conflict or a suite that never resolves, a PR that never opens) leaves the
dispatch worktree standing, exactly as before.

Everything here is drivable with fakes, mirroring the gate pipeline's own
testing discipline: `lib/shell/integration-runner.js` exports the pure
orchestration (`runIntegrationStage`) separately from the git plumbing
(`buildCandidateTree`, `landCandidate`) it is wired to, so the fix-cycle
sequencing and the race-retry bound are tested without a git checkout, and the
merge/conflict/CAS semantics are tested against a real throwaway repo without
faking git. See test/integration-step.test.js.

#### Propose mode — PR-landing for orgs whose policy requires review

`mode: propose` (task-spor-integration-propose-mode) runs the SAME candidate
build, protected-path restore, and full suite every other mode runs — the
whole point of running it pre-PR is that the PR is known-green the moment it
opens, the same evidence a human reviewer would otherwise have to wait on CI
for. Only the landing STEP itself differs: where `local`/`push` call
`deps.land` (a CAS mutating `target_ref`), propose calls `deps.propose`, which
**never touches `target_ref` at all** — it pushes the implementer's OWN branch
(`tree.head`, unmerged; never the throwaway candidate commit, which only ever
proved merging would be green) and opens a PR against it through the `gh` CLI,
the v1 backend. `gh` is a declared capability, checked through the SAME
machine-profile satisfiability layer a profile's harness/mcp/skills/plugins
already go through (dec-spor-machine-profile-satisfiability), not a one-off
startup PATH probe (task-spor-propose-gh-capability-satisfiability): loading a
factory that declares `propose` warns loudly, once, at the same load-time
check an unreadable factory already gets, but no longer kills the whole
worker — a mixed fleet may point several boxes at the same propose
factory/queue and only some have `gh`, and a box that can never land a
proposal should idle (skipping every candidate here, visibly, in `spor work
--status`, leaving them for a capable box) rather than crash-loop under a
service supervisor. The refusal that actually stops a claim runs per item,
right where `dispatchWorkItem` would otherwise launch it — no lease is ever
established on a box that can't finish the job. `proposeIntegrationPR` and
`ghPrStatus` keep their own `hasCmd("gh")` checks as the backstop at the exact
point `gh` is invoked, regardless of caller — the guarantee never rests on the
satisfiability check having run. Never a silent fallback to another mode. A
re-run (a fix cycle, or a resumed pipeline) reuses whatever PR is already open
for the branch rather than erroring on a duplicate.

**Opening the PR PARKS the item — it does not resolve it, and it frees the
slot immediately.** This is deliberately NOT the `human` gate's shape (§10.2's
`runOneGate`, human case): that gate polls a graph approval in-process, for up
to `approval_timeout_ms` (a day by default), holding a work-loop concurrency
slot the whole time — fine for an approval a person answers within a shift,
wrong for a PR review that can legitimately take days, where holding a slot
that long would starve the loop's throughput for nothing. So propose mode's
"parking" reuses only the GRAPH-STATE half of a blocked/failed gate's
demotion (§10.7: a tracking item is filed carrying `blocks` onto the work
item, and the work item's own completion status is rolled back if it claimed
one) — never the in-process poll. The pipeline returns a THIRD settled state,
`parked` (alongside `passed`/`failed`/`blocked`, all in
`gates.SETTLED_GATE_STATES` — this run's pipeline is genuinely done; a
resumed orphan re-running it from gate 0 would open a duplicate PR), and the
work-loop slot frees on that return exactly like any other settled verdict —
no special-casing needed in the loop itself (see the "PARKED... frees the
slot" test in test/gate-pipeline.test.js, which is the same assertion the
PASS/BLOCKED tests beside it already make).

**Composing with a `human` gate never double-files an approval.** A `human`
gate (§10.2) is a GATE — it runs, and is judged, BEFORE integration ever
starts (§10.1's ordered gate list), and its own approval item is a wholly
separate graph node from anything propose mode files. Propose mode's own
tracking item is filed by a DIFFERENT dep (`parkForReview`, not
`fileHumanItem`) and is never routed through `checkApproval`'s polling loop —
it is answered by a PULL REQUEST landing on GitHub, not a graph resolving
edge a person writes by hand. A factory can declare both: a `human` gate that
arms on some risk class judges the CHANGE itself pre-integration (an internal
"should we even try to land this" call), and `propose` mode's own PR is the
org's independent, external review-and-merge gate on the same change
afterward. Neither one knows the other exists, and neither files into the
other's item.

**Resolving is a SEPARATE later pass — `checkProposal`, never a resume of
this run.** Because a parked run's `gate_state` is settled, its own pipeline
can never be re-entered to ask "did the PR land yet" (`stampGateState`
refuses to touch a record once its `gate_state` reads a
`SETTLED_GATE_STATES` value — the correct behavior for THIS run, wrong for
the proposal's own separate lifecycle). So every field a later check needs —
the PR's number/repo/url/branch, and the tracking item's own id — is stamped
onto the run record ONCE, by `parkForReview`, in the one window before
settlement closes it. That stamp is UNCONDITIONAL — it happens whether or not
`parkForReview`'s own tracking-node write actually landed on the graph
(issue-spor-integration-park-orphan): the pull request already exists by the
time `parkForReview` runs, so `gate_proposal_number` is the durable fact
"there is a PR to check," and a transient graph-write failure must never make
that fact unreachable. `spor work`'s loop calls a NEW optional per-pass hook,
`deps.checkProposals` (present only under a factory whose integration
declares `propose` — absent, a bare/local/push factory's loop is
byte-identical to before this existed), which scans this box's own run
journal for `gate_state: "parked"` records carrying `gate_proposal_number`
(not also requiring the tracking-item field, for the same orphan reason),
HEALS the tracking item first if it is missing (`healProposalTracking`
recreates it, byte-for-byte identical to what `parkForReview` would have
written — `buildProposalTrackingNode` is the one builder both call, so the
two can never drift into a same-id content collision — and only when the node
is confirmed absent, never merely reading differently because it already
progressed to `done`), skips any whose tracking item is no longer pending
(`gateApprovalState` reads the GRAPH, not a local flag — the one place two
machines, or two passes, checking the same PR agree), and for the rest calls
`gh pr view` through `integration-runner.js`'s pure `checkProposal`:

- **Still open** — a no-op; nothing is written, nothing checked again until
  the next pass.
- **Merged** — writes a SECOND `art-merge-…` fact for the same run (a
  `-landed-` phase segment distinguishes its id from the earlier `-proposed-`
  one, so the two never collide under the same-id-same-content rule a gate
  fact write already enforces) carrying a `resolves` edge onto the tracking
  item — the PR landing IS what resolves it, the one point in this whole
  pipeline where an integration fact retires something rather than merely
  recording it — then restores the work item's own completion status
  (`gatePromoteItem`, the exact mirror of `gateDemoteItem`: only ever
  restores a status this mechanism could plausibly have rolled back, leaving
  alone a node a person independently moved on from since) and closes the
  tracking item. That restore is GATED on the fact write actually succeeding:
  task-cc-terminal-status-requires-resolver means the resolver has to exist
  before the tracking item's own status can validly flip terminal, so if the
  landed fact could not be recorded, `checkProposal` returns without calling
  `restore` at all — the tracking item stays open, which is exactly what
  makes the next `spor work` pass retry it (`blockerAlreadyClosed` keys on the
  tracking item's own STATUS, never the resolving edge). The fact's id is
  deterministic, so that retry's write is a safe no-op if it turns out to have
  landed the first time despite reporting failure.
- **Closed without merging** — writes a fact recording it, but restores
  nothing and leaves the tracking item open: the PR was rejected on GitHub's
  own review surface, and — same as a `human` gate's own rejected approval —
  a person decides what happens next, not the worker.

See the "propose mode" and "checkProposal" sections of
test/integration-step.test.js, and the two propose-specific tests in
test/gate-pipeline.test.js.

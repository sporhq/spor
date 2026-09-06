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

**Assignee filter.** A live `assigned -> agent` edge naming an agent that is
NOT this worker's own configured identity (`dispatch.agent`, or `--as`) is
someone else's work — most often the autonomous auto-route consumer's own
re-route target (§10.3) — so it is skipped from selection the same way a
person's `assigned -> person` edge already routes an item to `readiness:
human`, mirroring what the queue's `assignee=me` view does for a person
(issue-spor-auto-route-additive-assignment-two-assignees). Each queue item
carries every currently-assigned agent as `assigned_agents` (API.md §3); a
worker with no configured identity can't tell "someone else" from "me" and
leaves this filter a no-op, so an unconfigured box's selection is
byte-identical to before this existed.

**The page widens rather than starving.** Selection reads a fixed-size ranked
page, and the policy (and a factory's repo scope, §10.6) filters what comes
back — so a page filled entirely by items this worker may not take would hide
an eligible one ranked below it on every poll, forever. When nothing on the
page is dispatchable by this worker — un-consented, out of scope, already in
flight here, or cooling off after a refusal — the read is widened, doubling to
200 — or, remotely, to the server's own page ceiling of 100 — until something
is or the queue is exhausted. The
cooldowns count, deliberately: an item that refuses deterministically (a
profile this box cannot satisfy) would otherwise pin the page at its own rank
forever. A pass that finds a candidate on the first page pays nothing extra,
and in local mode a widened read re-ranks the graph it already loaded. Each
step of a widening read fetches only its own DELTA (`GET /v1/queue?offset=`,
the same paging contract `spor next` walks) and appends, and the width a pass
needed is carried to the next poll — so a worker starved behind a page of
items it may not take pays ONE `GET /v1/queue` per poll rather than re-walking
25 → 50 → 100 every 30 seconds. Only the width actually needed is
carried, so a queue whose front becomes dispatchable again narrows straight
back to the base. That one-read guarantee is why the ladder stops at the
server's page ceiling remotely (`limit` is clamped at 100, API.md §5): a
carried width no single page can serve would make every later poll cost two
round-trips, which is the problem the carry exists to remove. A caller's own
base ask may still exceed that ceiling (`spor work` sizes its base off
`--concurrency`); it is honoured in full, read across pages, and whether more
of the queue follows is taken from the response's `truncated`/`next_offset`
rather than from the page's length — a clamped page is the server rationing the
read, not the end of the queue. Against a server too old to honour `?offset`
(it re-serves its top page — detected by any OVERLAP with what has already been
read, since a window past everything read cannot repeat it, and a re-ranking
backend's repeat is never byte-identical), the read falls back to the
pre-offset behaviour, re-paging the whole width from the top at each rung, so
widening still reaches past the base page there. The
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

### 3.1 Preflight — what must be true BEFORE a worker claims anything

An unattended worker has nobody to answer a permission prompt and nobody to
notice two agents writing over each other. The Dartlane pilot lost a run to
each (art-spor-dartlane-factory-pilot-review-2026-09-05): `fe24cc97` launched
Claude Code with no unattended posture, so every write it tried came back
permission-blocked and the item was reported against work that never happened;
`4002ba00` put several concurrent writers straight into one shared checkout
because the repo declared `dispatch.worktreeSetup` and nobody had also set
`dispatch.worktree`. Both are decided before the claim now
(task-spor-worker-preflight-validation), on the ONE path `spor work` and a
one-shot `spor dispatch` share — per
dec-spor-work-loop-generalizes-dispatch the loop adds no guards of its own, so
the guard lives in `cmdDispatch` and the judgement in `lib/shell/preflight.js`,
where `--print` can ask for it without launching anything.

**Write posture.** A posture is spelled in one harness's flags but says
something harness-neutral: *read-only*, *attended* (it stops to ask),
*unattended* (it never asks). Preflight reads it from the adapter that OWNS the
flags — never through the cross-adapter `postureMeaning()` translator, whose
most-restrictive-of-everyone reading is right for re-expressing a posture in
another harness's vocabulary and wrong for judging one (every argv carries
Codex's effective sandbox/approval defaults, so a permission-mode-less Claude
Code launch would read as `unattended`). An unattended dispatch whose resolved
posture is not `unattended` is **refused**, with no `--force` override and no
claim: preflight never SETS a posture, because a worker that quietly grants
itself a permission bypass is exactly the silent substitution the refusal
exists to prevent. Three cases:

| resolved posture | unattended dispatch | interactive `spor dispatch` |
|---|---|---|
| `unattended` (`--permission-mode bypassPermissions`; Codex/OpenCode/Copilot by construction) | proceeds | proceeds |
| `attended`, or none resolved at all | **refused**, naming the flags that would fix it | proceeds — a person IS the answer to the prompt |
| `read-only` under `--read-only` (a review gate) | proceeds — no writes were requested | proceeds |

A **declared** custom harness (`dispatch.harness.<id>`) is operator-bound: its
fixed command/argv may declare `posture: unattended|attended|read-only`. This
metadata describes the configured launch; it does not add permission flags or
grant access. Declared postures use the same preflight checks as built-ins:
attended/read-only commands cannot satisfy unattended write work, and only a
read-only declaration can satisfy `--read-only`. Omission preserves the legacy
operator-bound warning, which never becomes a refusal reason for ordinary
implementation dispatch. Foreign harness-specific flags remain refused.

**Candidate workspace.** `dispatch.worktree` (repo `.spor.json` first, then the
standing config, then `--worktree`/`--no-worktree`) decides whether a dispatch
gets its own worktree under `.claude/worktrees/<name>` or writes into the main
checkout. `dispatch.worktreeSetup` is **not** an input to that and never will
be — a hook that says how to PREPARE an isolated tree does not say one is
wanted — but declaring the hook with isolation off is diagnosed rather than
silently honoured by halves: `spor dispatch` warns, and both `--print`
surfaces name it. With isolation off, every dispatch into a repo shares one
working tree and one index, so a candidate that already holds a **live,
write-capable run** is refused. Occupancy is read from the durable run records —
the same store the same-machine duplicate guard reads — so it can never disagree
with `spor runs`; supervised runs are believed only while
`supervisorStillWatching` says so, and a `read_only` launch is neither a writer
nor blocked by one (a review gate reads the implementer's checkout, and
gate-runner would score an undispatchable review as a gate FAILURE, §10.4).

`--force` overrides the refusal. The pull worker's OWN item dispatches never
pass it — that is what keeps two implementers out of one checkout — but its
gate **fix cycles** and its **rescue** do (they run in the run's own checkout,
whose implementer is already terminal; CLAUDE.md calls the fix cycle the one
place the worker forces). So a worker running `--concurrency` above 1 against a
shared checkout will hit this refusal on every candidate behind the one already
running there — with more than one slot, still turn `dispatch.worktree` on so
each run gets its own tree. What changed
(task-spor-work-loop-workspace-refusal-cooldown-on-worker-not-item) is what the
*loop* does with the SHARED-checkout half of that refusal (plus the
candidate-claim race below, which fires only when two launches race for the
very same path): it is recognized from its own text (`spor work`'s
`isWorkspaceRefusal`, matched on the "shared checkout" wording specifically —
a per-item **worktree** already occupied stays an ordinary item cooldown,
since under isolation every other candidate gets its own tree and is not
implicated) and never becomes an item cooldown — the
occupied checkout says nothing about the REFUSED item's own readiness, and
cooling it onto `work.retryAfterMs` (ten minutes by default) would walk the
rest of the page into the same cooldown, one refusal at a time, while the
occupying run finishes in seconds. Instead the loop leaves the item
un-cooled, stops trying the REST of that pass's candidates (every one of them
would contend for the same shared tree), and lets the ordinary next poll — at
`work.intervalMs`, never the idle backoff — retry the whole page once the
checkout frees up. It is worker-scoped, not item-scoped, so `spor work
--status` reports it on its own `workspace:` line rather than in the item
`skipped:` list.

**Acquisition is atomic.** The occupancy check reads the run records, and the
record that would make a SECOND dispatch see this one is written by the launch.
Two launchers racing through that window would both read an empty candidate. So
from just before the worktree is materialized until the run record exists, the
launch holds an exclusive machine-local claim on the candidate path, and asks
the occupancy question again under it.

That claim is NOT a well-known lock pathname: see-it, judge-it-stale,
unlink-it, re-create-it is not a claim (two contenders can both break one stale
lock and then delete each *other's*), so it takes the shape
`u.claimSpoolJob` already uses for the nudge spool
(dec-spor-nudge-drain-atomic-claim). Each contender creates only its own
uniquely-named
`$SPOR_HOME/journal/workspace/<key>.lock-<pid>-<start-ticks>-<ts>-<rand>` and
deletes only its own; everything a racer must judge is in the NAME, so there is
no create-then-write window to misread; and ownership is decided by a listing
taken AFTER the create, which two contenders can never both win (each creates
before it lists).

A lock whose HOLDER is gone contends with nobody — a dead launcher is not
launching — so a launcher killed mid-launch self-heals at once rather than after
a horizon, and its file is reaped once it is also expired (which, since every
racer already ignores it, can neither grant nor revoke ownership). "Gone" is
decided by **identity**, not by a pid: the name carries the holder's kernel
start-time tick count, so a recycled pid — which answers a liveness probe
exactly as readily as the real holder — is provably not our launcher and is
reaped at once, and conversely a **verified live holder keeps the candidate
however long it takes**, which matters because the claimed region includes an
operator's unbounded `dispatch.worktreeSetup` hook. The 30-minute TTL is only
the fallback for the case identity cannot be verified (off Linux, where the tick
count is unreadable), the same trade `supervisorStillWatching` already makes.

It degrades open twice over: a journal it cannot write or read loses the race
tiebreak rather than stopping a dispatch (said out loud, as a `warning:`), and
`--force` takes the same arm rather than being refused. This is the one refusal that comes after the claim,
because it exists only to break a tie the pre-claim check could not see; it
hands the lease straight back, exactly as a failed worktree setup does.

### 3.2 `--print` — the diagnostic preview

Both `spor dispatch --print` and `spor work --print` run the same resolution
path a real run does and perform none of its side effects: no claim, no child
process, no worktree, no configuration write (the capability probe is told not
to persist), and no credential in the output — a token is reported present or
missing, never echoed. An input that cannot be resolved is diagnosed rather
than previewed as a clean run: an explicit `--profile` that will not load still
exits non-zero.

`spor dispatch --print` reports:

```
tenant: acme @ https://api.sporhq.io  (via SPOR_ORG env; token present)
dir:    /home/dev/repos/demo  (slug: demo, via config)
worktree: /home/dev/repos/demo/.claude/worktrees/task-x  (branch task-x, off HEAD); setup: ./bin/wt-setup
workspace: /home/dev/repos/demo/.claude/worktrees/task-x  (isolated worktree); no live writers here
posture: unattended
harness: claude-code (profile profile-impl)
preflight: ok — write posture and candidate workspace are both fit for an unattended run
```

The `tenant` line names the effective tenant **and the selector that chose
it** (`--server`/`--org` flag, `SPOR_SERVER`/`SPOR_ORG` env, a repo `.spor`
`org:` marker, the credential-store default, or a legacy flat config) — the
half `spor status` never answered, and the first thing worth knowing when a
worker is writing into a graph you did not expect. `preflight` is always
judged for an UNATTENDED launch, so an interactive preview still tells you
what a worker would do rather than being silently exempted.

`spor work --print` adds the worker-level view: the same `tenant` line, the
posture flags this worker hands to every dispatch it makes and which built-in
harnesses that satisfies, the workspace isolation each in-scope repo resolves
to (with the orphaned-`worktreeSetup` diagnostic), and — under a factory — each
gate's **coverage**: armed or skipped, with the reason. A command gate runs on
every change; a human gate arms only on its declared risk classes; an
agent-review gate is coverage at all only if this box can dispatch its profile
read-only, since gate-runner treats an undispatchable review as a FAILURE and
never as a pass (§10.4).

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
   converge leave it unresolved with the blocker named in the report. It
   opens with the **one-turn notice** (`ONE_TURN_NOTICE`, the same string the
   fix-cycle, dirty-tree round-trip, integration-fix and rescue prompts
   carry): the session ends with the worker's final message and nothing wakes
   it later, so every verification runs in the FOREGROUND — never a
   backgrounded suite, never a turn ended "waiting" on a notification — and
   anything not committed before that message is lost, an uncommitted tree
   being a refusal (issue-spor-rescue-and-fix-sessions-end-turn-waiting-on-
   background-job: two headless sessions in one day authored correct fixes,
   backgrounded `npm test`, ended their turn waiting on it, and paged a person
   over a dirty tree). The contract reaches the agent whatever prompt
   template rides the loop's `--template` (or a personal `dispatch.template`):
   a worker's launch checks the rendered template for its task text and, when
   the template names neither `{{task}}` nor `{{default}}`, appends the task
   after it with a warning — a person's own `spor dispatch --template` keeps
   the template's full authority. The
   factory-specific lines (the integration target, the acceptance command,
   the protected paths and their lane, the cross-model review) appear only
   when the factory declares them; a bare worker's contract is the plain
   commit-then-resolve discipline, plus the **durable-debt checklist** — the
   four failure modes of a retry/debt flag (§10.4), which a change that
   introduces or extends one is asked to design against up front and answer
   row by row in its commit message. It also carries the two **fixed forms**
   for a first line of the final message, each read back in code, never from
   prose: `DECLINED: <reason>` (§6 — the item itself is wrong, nothing was
   done, route it to triage) and `SCOPED: <outcome> <node id> — <why>` (§10.11
   — the item's real work turned out to be a graph write, so the empty diff is
   the correct outcome and the runner verifies the claim before routing it).
   A person's one-off `spor dispatch` adds nothing — they write their own
   instructions.

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
| `resolved` | the target is genuinely done | re-reading the graph shows a **live inbound `resolves`/`answers` edge** onto the target node — or, for a type retired by status rather than by an edge, that the node's **own status** has reached its type's terminal partition |
| `reported` | not done, but the work reached the graph | no attestation of completion, but the worker's final report was filed as an artifact `relates-to` the target |
| `failed` | nothing usable reached the graph | no attestation of completion and no usable report |
| `declined` | the worker declared the ITEM wrong, not the work unfinished | no attestation of completion, and the final report's **first line** is `DECLINED: <reason>` — the reason is filed as a `finding` on the target, its `readiness: agent` stamp is cleared, and the lease is released; the item goes to triage, never to a gate |

**`resolved` is a graph read, never an exit code, never the worker's own
claim.** Re-fetch the node — `GET /v1/nodes/{id}` — and check its
`resolution` enrichment (API.md §3, the `get()` hook the seed
`task`/`issue`/`question`/`incident` schemas attach): a live, visible,
inbound `resolves` or `answers` edge, carrying the resolver's id. (A type
whose schema attaches no such hook is retired by its own status instead, and
is read that way — see "Two attestation paths" below; the rest of this
section applies unchanged to both.) The absence of the attestation
is the answer for a worker that *claims* success without writing one — that
absence reads as `reported` or `failed`, never `resolved`. This is the
single most important rule in this document: **a worker's own "I'm done" is
not evidence; the graph's own attestation is.**

**Report presence — not exit status — discriminates `reported` from
`failed`.** A run that crashed midway but had already produced a usable
final report is `reported`, not `failed`; the crash itself is a separate,
process-level fact (§8's `state`/`termination_*` fields), never conflated
with the outcome. The invariant a consumer keys on: whenever a report
artifact id is present, `terminal_state` is `reported` — always, whether the
verdict was enforced or not (see "What 'enforced' means" below).
The one thing that is NOT a report is the harness's own declaration that
the run failed: a supervised Claude Code stream whose terminal `result` event
carries `is_error: true` writes no report file at all — its text is the
reason the run stopped, not the agent's final message — so the run reads
`failed` (`termination_signal: "error-result"`, the error text retained in
`termination_reason`) whatever its exit code, and never enters the gates as
a clean `reported`. Only that declared text is read for an environment
signal (a credit or rate-limit phrase in it still classifies the run
`environment`); the assistant turns before it are never scanned, so prose
that merely quotes such a phrase cannot override the real error.

**A decline is a fixed form, not prose.** A worker that finds the item
itself wrong — its premise no longer holds, it is already done, the change
belongs in another repo — declines it: commits nothing, writes no resolver,
and makes the first non-blank line of its final message exactly `DECLINED:
<one-line reason>` (the rest of the message explains; a heading or bold
wrapper around the line is tolerated). The runner reads that line and nothing
else — "I declined" in a later paragraph is a report, not a declaration. Two
of the first live factory's eight human escalations were honest declines
misfiled this way (task-spor-worker-declined-outcome): the implementer refused
with a clean tree, the pipeline ran the review gate into its fail-closed
empty-diff rule, and a person was paged about a change that was never
proposed. A declined run:

- is never gated (§10.2) — it carries no claim of completion to test;
- has its reason filed as a **`finding`** node (`find-declined-<stem>-<run>`,
  `relates-to` the target, never `resolves`/`blocks`) with the full report in
  the body, so the item re-briefs with the decline attached the next time it
  is compiled — and, while that finding stays LIVE (not yet resolved/dismissed
  by a person), also GATES re-dispatch of the same node: `spor dispatch --node`
  refuses (naming the finding id; `--force` overrides) and the work loop skips
  it visibly, like a policy skip, under every accept policy (task-spor-
  decline-finding-gates-redispatch) — a second worker no longer pays the same
  investigation a standing decline already settled;
- has its **`readiness: agent` stamp cleared** (`POST
  /v1/nodes/{id}/readiness {readiness: "clear"}`) — the stamp was the claim the
  decline contradicts, and clearing it is what keeps a `work.accept: ready`
  worker from re-dispatching the item as written;
- releases the lease, in the same file-then-release order as a report.

Those three are what an *enforced* decline attempts, in that order; each leg
records its own verdict on the run record (`finding_node_id`,
`readiness_cleared`, `lease_released` — §8) instead of being implied by the
outcome, and none of them can unmake the `declined` state, which is the agent's
own declaration: a refused finding write leaves the lease deliberately held
(§6, step 1b), a refused readiness clear is recorded and never fatal, and an
unenforced decline performs none of the three.

The graph still wins over the words: a run whose target reads resolved is
`resolved` whatever its final line says, and is gated (where its empty diff
fails closed as before — a decline with a resolver behind it is judged as the
claim it makes). `finding_node_id` present ⇒ `terminal_state === "declined"`,
the twin of the `report_node_id` invariant above. An unreachable server or a
local-mode run still reads a decline as `declined` (unenforced: nothing filed,
nothing cleared) rather than as an unenforced `reported`, so a local factory
does not gate it either.

**Two attestation paths, one verdict.** Types differ in how completion is
*attested*, not in whether it can be judged. The seed types whose schema
attaches the `get()` resolution hook — `task`, `issue`, `question`,
`incident` — are attested by a **resolving edge**, above. Every other
dispatchable type (`decision`, `finding`, `capture-pending`, …) is retired by
its **own status**, and is judged against that instead: `resolved` once the
node's status has reached its type's terminal partition (a decision
`settled`, a finding `resolved`, a capture-pending `merged` — unioned with
the type-blind completion words), not resolved while it has not. Which of the
two paths applies is read off a **schema registry** — does this type's schema
declare the `get()` hook — never off a hardcoded type list
(norm-cc-registry-is-contract,
task-spor-dispatch-terminal-resolution-all-types). *Which* registry answers
that is part of the contract, not a detail: the reference client asks a
different one on each of its two verification legs, and only one of them is
the graph's own, so a resident `type: schema` override that moves a `get()`
hook is honored on one leg and **invisible** on the other. Read the next
paragraph before assuming either. A target whose type the graph does not echo
at all is treated as edge-verified: nothing short of a resolving edge attests
it, which is the fail-safe direction.

**The two legs, and the registry each one actually reads.** A registry is
only as live as the graph behind it:

- **Local-mode verification** loads the graph it is verifying against, so it
  asks that graph's own registry (`registry.attachesResolutionHook`). A
  resident `type: schema` override that attaches the hook to another type —
  or drops it — is honored there with no code change.
- **The remote leg** holds one node's JSON and no graph, and answers from the
  **shipped seed pack** (`attachesResolutionHookOffline`, `lib/graph.js`),
  which by construction cannot see a resident override — the same graph-less
  limitation API.md's reserved `inert` key names
  (issue-spor-type-blind-terminal-status-fallbacks). The seed answer is right
  for every graph that leaves the `get()` hooks where the seed pack puts them.
  Where an override moves one, this leg is wrong in **both** directions — the
  server's own `resolution` enrichment (read FIRST, and authoritative when it
  is there) covers only part of one of them:
  - an override that **adds** the hook to a status-only type: a real resolving
    edge still reads `resolved`, off the enrichment the override now produces.
    The residual is the node carrying no such edge whose own status happens to
    be terminal — the seed's status-only answer accepts that status and reads
    `resolved`, an **over-read** of an attestation the live registry would not
    have accepted.
  - an override that **drops** the hook from an edge-verified type: the
    enrichment goes with it, so nothing answers first, and the seed's
    edge-verified answer never consults the status at all — a node genuinely
    retired by its own terminal status reads as not attested, so the run files
    a report and hands the lease back on finished work (and a factory gates an
    item that is done). Fail-closed, but wrong.

  Both directions are tracked as
  issue-spor-remote-dispatch-ignores-resident-resolution-hooks; the bullet
  below is what a worker does about it today.
- **A third-party worker should do better than the reference client's remote
  leg**, and can: read the live answer from `GET /v1/schema` — the type's
  `hooks` array contains `get` (`spor schema <type> --json` prints the same
  registry snapshot) — which is exactly the "agents reverse-engineering the
  registry from `lib/seed/`" failure that endpoint exists to close.

**Both paths are fully enforced, and both run the ordering below unchanged**
— including the release. A status-only target whose status has *not* gone
terminal files its report and **releases the lease**, exactly as an
edge-verified one does. An earlier revision of this contract carved those
types out as *unjudgeable*: it hedged the report's wording, stamped
`terminal_enforced: false`, and released nothing on the grounds that the
verdict could not be made — which stranded the item for a whole lease TTL
with no handback, the opposite of what §3's lease contract promises
(issue-spor-unjudgeable-type-leases-never-released; it supersedes the
lease-and-enforcement half of dec-spor-dispatch-unjudgeable-type-reports,
whose file-the-report-anyway half stands). There is no unjudgeable arm left:
a target's TYPE never makes a run unenforced any more — only a posture where
nothing could be verified or filed does, and those are enumerated under "What
'enforced' means" below.

**Ordering is the contract: file the report, THEN release the lease —
never the other way, and never both-or-neither on a failure.**

1. Re-read the target node; **attested complete** — a live resolving edge on
   an edge-verified type, or a terminal own-status on a status-only one →
   **`resolved`**, release nothing (the durable `assigned` edge already
   stands as the record of who did the work, and an attested-complete node is
   out of every queue by that attestation already).
1b. Not attested complete, and the report's first line is `DECLINED:
   <reason>` → file the finding, clear the readiness stamp, release the lease
   → **`declined`**. A refused finding write leaves the lease held, as in
   step 2; a refused readiness clear is noted and never fatal.
2. Not attested complete, and a final report text exists → **file it
   as an artifact** (§7). If the write lands (or was already there — filing
   is idempotent), release the lease → **`reported`**. If the write is
   *refused* by the graph, the lease is deliberately left **held** rather
   than releasing a signal-free item back into the pool — it lapses at its
   own TTL instead, and the run's note says so.
3. Not attested complete, and no report text at all → release the
   lease → **`failed`**, with a `terminal_note` explaining why — naming the
   missing resolving edge, or the status that has not gone terminal,
   whichever this type is judged by.

A crash between step 2's two writes can therefore only ever leave the lease
held with the report already filed, or leave both undone — **never** a
released lease with no report to show for it.

**What "enforced" means, and where it doesn't apply yet.** `terminal_state`
is only as trustworthy as `terminal_enforced` says it is
(dec-spor-dispatch-terminal-states-supervised-first), and what it reports is
exactly one thing: **a graph answered the re-read**. Enforcement is a property
of the VERIFY leg alone — once a graph has answered, every arm below it is
enforced, the arms that file nothing included. A verified-not-done run with no
report to file (step 3), a report the graph refused, and a decline whose
finding the graph refused are all `terminal_enforced: true`: the graph was
asked and it answered, which is the whole of the claim. What those three lack
is a filed artifact, and the record says so on its own fields —
`report_node_id`/`finding_node_id` absent, `lease_released: false` for a lease
these two arms deliberately never attempted to hand back — never by demoting
`terminal_enforced` to stand in for them. (`false` is the weaker claim §8
spells out — "no confirmed handback". Only here, where no handback was
requested at all, is nothing in doubt about WHY: no release of ours was in
flight, so the lease stays ours until its own TTL lapses it or a person hands
it back. Everywhere else `false` covers a request whose answer never came,
which sits over a release the server may have committed.)
Nothing is filed on the `resolved` arm either, for the opposite reason:
completion is attested, so there is nothing left to file. Read the flag as
"and the paperwork landed" and a checked verdict reports itself as a guess;
the list below is the whole of what unenforced means, and none of those arms
is in it.

**Two graphs can answer that re-read, and local mode is not excluded from
it.** Against a reachable server the whole contract runs: verify, file,
release. In local mode there is no server door to file a report or hand a
lease back through — but there IS a graph to verify against: the run's own
local graph home, resolved by the launcher (not re-derived by the detached
supervisor) and handed over as `local_nodes_dir`
(task-spor-work-local-mode-resolver-check). The VERIFY leg runs there, over
**both** attestation paths, so a local-mode target that reads attested
complete is `resolved` with `terminal_enforced: true`. That is the one
enforced local reading; every other local outcome is unenforced, because
nothing was filed and no lease was handed back.

`terminal_enforced: false` — and never `resolved` — is what every other
reading gets:

- a local-mode run whose target is not attested complete on that local graph,
  or whose graph home is missing or unreadable (a free-text dispatch outside
  any repo);
- a dispatch with no target node to verify, report against, or release;
- an unreachable — or unauthenticated — server;
- a **native-background** launch whose run this box could not judge to be over
  — the harness listing could not be read at all, or the run named no target
  node (a free-text `--bg` dispatch), or the record was closed with no
  attributable transcript to classify it from. A native launch that IS judged
  over now gets the whole contract, same as a supervised one — see below.

**A native-background launch is inside the contract now**
(task-spor-dispatch-native-bg-terminal-detection). It was excluded in v1 for
one reason: a `claude --bg` run's termination could not be deterministically
observed. It can be. A finished background agent does **not** leave the
harness daemon — it sits at `status: "idle"` while `state` still reads
`"working"` — which is why such a run used to hold its worker's slot until the
24-hour watchdog (two factory pipelines stalled five hours on exactly this on
2026-09-02, released only by a manual `claude stop`). A run is judged over when
three independent signals agree: every listed agent that identifies as it reads
`status: "idle"`, its transcript's LAST turn closed with an end-of-turn marker,
and nothing has been appended for a short quiet window. Idle with a mid-turn
transcript is a waiting tool call, and stays live; a listing with no `status` at
all never satisfies the first signal. `state: "done"` remains an independent
terminal signal, as before.

Two consequences ride with it. The daemon slot is freed — the agent is stopped
through its harness adapter's own declared stop argv, and the record says
`stopped_for: "turn-complete"` with `agent_stopped` reporting whether that
took. And the contract then runs against the run's target: the record is closed
FIRST, synchronously, carrying a provisional unenforced outcome plus
`contract_pending` (the run store is synchronous and holds no credential), and
the verified verdict merges in a beat later from whoever holds a graph door —
the same two-write shape a supervised run already uses. The agent's final
report is the LAST assistant text in its own session transcript, by the same
`--output-last-message` rule the supervised stream applies (subagent sidechain
records excluded, which that stream never sees either), so a native run can
reach `reported` with its hand-back filed and a `DECLINED:` one routes to
triage instead of every unresolved run reading `failed`.

Three rules bound that second write, because unlike a supervisor it has no
owning process and runs from whichever client next reconciles the record:

- **The debt is spent only when it is discharged.** An unreachable or
  unauthenticated graph leaves `contract_pending` set (and the honest
  unenforced verdict written) for the next caller, rather than losing the
  report and the lease handback permanently — bounded at `contract_attempts`
  = 3, after which the unenforced reading stands.
- **The record names the graph it was launched against** (`server` + `org`, or
  `local_nodes_dir` for a local launch), and a client resolving a different
  one SKIPS it — matching the org too, since a hosted deployment gives every
  tenant the same front door. On a multi-tenant box the same node id exists in more than
  one graph, and settling through the wrong one files a report where the run
  never ran and releases a lease that is not the run's.
- **A filtered read settles only what it asked about.** `spor runs --node x`
  and a worker following its own runs settle those; an unfiltered `spor runs`
  is the whole store's reconciler and settles everything it just closed. And
  the lease handback is skipped once the record has been terminal longer than
  the lease's own 45m TTL — by then the item may legitimately belong to
  someone else.

A `reported` or `failed` value on an unenforced record is a best-effort
classification of the *process* outcome, not a checked verdict;
`terminal_enforced` is the field a consumer must gate on before treating
either as ground truth.

### What a third-party (non-reference-client) worker must do

If your launcher is not `spor dispatch`/`spor work`, reproduce the algorithm
above directly against REST once your worker process ends:

```
1. GET  /v1/nodes/{targetId}
2. if resolution.by present               → terminal_state = resolved; done, no release
2a. elif the target's type attaches no resolution hook (GET /v1/schema)
       and its own status is terminal for that type
                                           → terminal_state = resolved; done, no release
2b. elif report's first line is `DECLINED: <reason>`
                                           → POST /v1/nodes (file the finding, if_exists: skip)
                                             if the write lands: POST /v1/nodes/{targetId}/readiness {readiness: "clear"}
                                                                 POST /v1/nodes/{leaseNode}/release
                                                                  → terminal_state = declined
                                             if the write is refused: leave the lease held
                                                                  → terminal_state = declined (held)
3. elif final report text exists          → POST /v1/nodes  (file the report, §7, if_exists: skip)
                                             if the write lands: POST /v1/nodes/{leaseNode}/release
                                                                  → terminal_state = reported
                                             if the write is refused: leave the lease held
                                                                  → terminal_state = failed (held)
4. else                                   → POST /v1/nodes/{leaseNode}/release
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
summary: Final report from the dispatched <harness> run on <target>, which ended
  without resolving it: <first line of report>
date: <YYYY-MM-DD>
edges:
  - {type: relates-to, to: <target-node-id>}
---

Final report from dispatched run `<run-id>` (<harness>), which ended `<state>`.
It is filed here so the run's work reaches the graph instead of vanishing into
a dead run; nothing here resolves the target.

The run ended with <one of: `no resolving edge on <target>` | `<target>'s
status ('<status>') has not reached a terminal <type> status`>, so the item
returns to the queue carrying this report.

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
| `item_repo` | string \| null | optional, supervised node-mode runs only — the target ITEM's own `repo:`/`project:` stamp **as claimed**, recorded at launch. It is the "before" value the no-code-outcome re-stamp check compares against (§10.11), so it must not be re-read from the item later, and it is deliberately not the dispatch's launch target (which `--slug` overrides for a cross-repo dispatch). Absent on a record predating it, on a free-text dispatch, and on a node carrying no stamp |
| `item_commits` | string[] | optional, supervised node-mode runs only — the target ITEM's own `commits:` stamps **as claimed**, recorded at launch. The stale-premise check (§10.11) reads only this, never the item's current `commits:` — `commits:` is an ordinary editable field, and re-reading it live would let a run with graph-write access append its own already-landed sha to its own item and manufacture the "predates the run" evidence the check exists to require. Absent (read as no stamps to check) on a record predating it, on a free-text dispatch, and on a node carrying none |
| `model` | string \| null | **native-background records only** — the model override this launch resolved (`--model`, else the profile's), `null` when none did; the key is always present on a native record. A supervised record does not carry the field at all — its model is fixed into the harness argv at launch |
| `created_at` | ISO 8601 | when the record was opened |
| `started_at` | ISO 8601 | supervised runs only — when the child process actually started |
| `launched_at` | ISO 8601 | native runs only — when the launcher observed the harness hand off to its background daemon |
| `launcher_exit` | int \| null | native runs only — the foreground launcher process's own exit code |
| `finished_at` | ISO 8601 | when the record went terminal |
| `exit_code` | int \| null | supervised runs only |
| `signal` | string \| null | supervised runs only — the OS signal, if any |
| `termination_class` | string | a broad bucket: `"completed"`, `"environment"` (credit/rate/auth exhaustion — re-dispatchable, not a real failure), `"launch"`, `"failed"` (a supervised child that launched but exited nonzero for no recognized environment reason), `"idle"` (a run that stopped writing anything and was stopped for it), or `"unknown"` — an open vocabulary; do not exhaustively `switch` on it |
| `termination_signal` | string | a short machine tag within the class, e.g. `"supervised-exit"`, `"nonzero-exit"`, `"error-result"`, `"credit-exhausted"`, `"supervisor-gone"`, `"launch-failed"`, `"idle-timeout"` |
| `termination_reason` | string | a human-readable one-line explanation (≤ 300 chars) |
| `error` | string | optional — the raw underlying error message, when there was one |
| `session_id` | string \| null | the harness's own session/thread id, possibly bound after launch (§2) |
| `bound_at` | ISO 8601 | native runs only — when `session_id` was captured |
| `transcript_path` | string | native runs only, when a transcript was found |
| `log_path` | string | supervised runs only — the raw JSONL/stderr log |
| `report_path` | string | supervised runs only — where the harness's own final-message text landed, if any |
| `child_reaped` | bool | optional — an orphaned harness child was terminated at reconciliation time |
| `stopped_for` | string | optional, native runs only — why this run's agent was stopped rather than merely observed to end. `"turn-complete"` is the only value today: the agent was still registered in the harness daemon, idle, with a finished last turn |
| `agent_stopped` | bool | optional, native runs only — whether the stop above actually took. `false` means the record is terminal anyway and an idle agent may still be registered |
| `release_node` | string | optional, native runs only — the lease THIS dispatch established, and therefore the only one §6 may hand back. Absent when the dispatch claimed nothing (`--no-claim`, a `--force` re-dispatch over someone else's live lease) |
| `local_nodes_dir` | string | optional, native runs only, local mode — the graph home the LAUNCHER resolved, which a repo `graph:` binding can make differ from the reconciling process's own |
| `project` | string | optional, native runs only — the project slug the run resolved into, stamped onto any report artifact §6 files |
| `server` | string | optional, native runs only, remote mode — the graph base URL this run was launched against; §6 refuses to settle it through any other |
| `org` | string | optional, native runs only, remote mode — the tenant org that base URL was resolved under. A hosted deployment routes every tenant through ONE front door and separates them by the token's org claim, so §6 matches this too when the record names one |
| `contract_attempts` | int | optional, native runs only — how many times §6 has been attempted for this record (see the debt rule above) |
| `contract_settled_at` | ISO 8601 | optional, native runs only — when the outcome dimension stopped being provisional |

**The two launch modes carry different fields, and that asymmetry IS the
schema — not an omission to read around.** A `native-background` record
carries `launched_at` (never `started_at`: the launcher observes the hand-off
to the harness's daemon, not the child's own start), plus `launcher_exit`,
`bound_at`, `transcript_path`, and `model`. A `supervised-jsonl` record
carries `started_at`, `exit_code`, `signal`, `log_path`, and `report_path` —
and no `model`. Absent fields read as `null`/absent per the rule above rather
than as a violation. The asymmetry is pinned by a test against both real
launch paths (`test/claude-supervised-dispatch.test.js`), so this table and
the two record writers cannot drift apart.

**Which record omits `model`.** The **supervised** one. A native launch writes
the resolved model onto its record at `beginNativeRun`
(`lib/shell/agent-dispatch-runner.js`) — the key is always present there,
`null` when nothing overrode it — because that launcher never sees the child
again and the record is the only place the resolved model is written down. A
supervised launch fixes the model into the harness argv instead, and
`launchSupervisedHarness` (`bin/spor.js`) writes no such key. Both halves, and
the `launched_at`/`started_at` split above, are asserted against the two real
launch paths in the test named above and again at the `spor runs --json` door
they ride out through.

The mirrored reading — that a *native* record is the one omitting `model` — is
wrong about the shipped writers in both directions, and it is not a reading
this table may be edited into. The field is documented and emitted, so dropping
it from native records is a **removal** from a published record schema: the
additive-only rule above forbids it, and a consumer already reading `model` off
a native run breaks. That is a decided position rather than an editorial one —
**`dec-spor-keep-native-run-record-model-field`**, which weighed unifying the
two records against that rule and kept the field. Retiring it remains available
as a schema change with a deprecation window; it is not available as a
correction here.

Fields like `runner_pid`, `child_pid`, `runner_started_ticks`, and
`child_started_ticks` ride on supervised records, and `contract_pending` on
both (a native record carries it between the reconcile that closes it and the
settle that verifies it);
they are internal bookkeeping — process identity for reconciliation (guarding
against pid reuse), and, for `contract_pending`, whether the outcome dimension
on a just-closed record is still the provisional placeholder rather than the
settled verdict (a record goes terminal synchronously, and §6 runs a beat
later). They are not meaningful to an external consumer, which should poll for
`terminal_state` rather than trying to interpret them.

**A `contract_pending` record is verified before it is believed.** A supervisor
killed inside that window — or a process that closed a native record and then
died before settling it — never lands the real verdict, so the placeholder — an
unenforced `reported`, or `failed` — would otherwise be filed as the outcome of
a run that genuinely resolved its target, and then gated and cooled off for it.
Whoever harvests such a record re-runs §6's verify leg itself (`spor work`
does), and only a POSITIVE reading overwrites the placeholder: a graph it
cannot reach leaves the record exactly as it was, still flagged pending. The
same read classifies a run stopped for **idleness** — a run whose log and
transcript have both stopped moving for `work.runIdleMs` (`--run-idle`, default
45 minutes) is stopped and recorded `failed` / `termination_class: "idle"`,
because a wedged agent otherwise holds its worker's slot, its lease and its
worktree until the 24-hour `--run-max` watchdog. Its *outcome* is still a graph
read: an agent that wrote its resolver and then hung reads `resolved`, and
being stopped is not evidence otherwise. A wedged run never reaches §6's
release leg on its own, so the worker that stopped it runs that leg on the
contract's behalf, under the contract's own guards: only the lease **this**
dispatch established is handed back (`release_node`, never a `--force`
re-dispatch's borrowed one), never after a `resolved` reading (the resolver
already took the item out of the pool), only for a run that actually
**ended** — where the worker merely stopped *following* it (nothing of ours
to signal, or a process that survived SIGKILL) the lease stays held, since it
is what keeps a second agent out of a checkout the first may still occupy, and
lapses at its TTL — and only against the graph the run was dispatched on (a
record stamped with another server is left to that tenant's TTL). The record
carries the result as `lease_released` exactly as a contract-filed run does,
and a refused release is a `spor release <id>` hint, never a lost verdict.

What the ceiling measures is **silence**, not idleness. A run's observable
output — the supervisor's JSONL log, or a native launch's session transcript —
only moves when a tool result comes back, so a single tool call that runs longer
than the ceiling (a full test matrix, a slow image build) is indistinguishable
from a wedged agent and is stopped mid-work. Raise `--run-idle` (or set it to
`0`) for a lane whose steps genuinely run that long. A run with **no** observable
channel at all — a native launch whose session was never bound — is never judged
idle; it falls through to the 24-hour watchdog, which frees the slot without
making any claim about the run.

**Outcome dimension** (present once §6 has run against this record; a
record still `launching`/`running` has none of these yet):

| Field | Type | Meaning |
|---|---|---|
| `terminal_state` | string | `"resolved"` \| `"reported"` \| `"failed"` \| `"declined"` — see §6 |
| `terminal_enforced` | bool | whether this was a *verified* verdict (re-read against a reachable graph) or a best-effort classification — **gate on this before trusting `terminal_state` as ground truth** |
| `resolved_by` | string | present only when `terminal_state === "resolved"` — the resolver node's id |
| `resolved_edge` | string | present only when resolved — `"resolves"` or `"answers"` |
| `report_node_id` | string | present only when a report was actually filed (§7). The invariant to key on is DIRECTIONAL: its presence always implies `terminal_state === "reported"`. The converse is **not** a contract. Under the current writer filing sits downstream of a successful re-read (§6, step 1 precedes step 2), so a record written today carries one only when `terminal_enforced` is `true` — but the unjudgeable arm §6 describes above filed the report and stamped the verdict `terminal_enforced: false` in the same record, and records written by it stay readable for the whole retention window below. So reach for the artifact by testing THIS KEY'S presence; gate on `terminal_enforced` to decide whether to trust `terminal_state`, never to decide whether an artifact id is there |
| `declined_reason` | string | present only when `terminal_state === "declined"` — the reason off the report's `DECLINED:` line |
| `finding_node_id` | string | present only when a decline's finding was actually filed — its presence always implies `terminal_state === "declined"`; an unenforced declined record has none. Here the converse holds for every record ever written, unlike `report_node_id` above: the `declined` outcome post-dates the unjudgeable arm, so no retained record pairs a finding id with an unenforced verdict |
| `readiness_cleared` | bool | declined only — whether the target's `readiness: agent` stamp was cleared |
| `lease_released` | bool | optional — `true` once the server CONFIRMED the handback. `false` means it was **not confirmed**, which is strictly weaker than "still held" and is all a client can honestly record: it covers a release deliberately never attempted (the report or finding write was refused, §6), one the server refused, and one whose answer never came back at all — and that last case sits over a release the server may well have committed and lost the ack for. Read it as "nobody has seen this lease come back", and act on it the same way either way: `spor release <id>`, or wait out the TTL. That remedy reconciles rather than assuming — release is idempotent, and a claim someone else now holds answers `409` naming the holder (API.md §3) instead of being yanked out from under a live agent. **Omitted** (not `false`) when no lease was this run's to release at all |
| `terminal_note` | string | a human-readable explanation of the outcome, always present once this dimension exists |
| `terminal_unreachable` | bool | optional — the §6 contract could not REACH the graph to verify this run, so its outcome is unverified for a TRANSPORT reason rather than an agent one. `terminal_enforced: false` alone cannot say that (a never-started run and the runner's own provisional patch are unenforced too), and the execution classifier (§10.4) reads an outage off this rather than off a note string |

A record with `terminal_state` unset (or `state` still non-terminal) has not
finished; poll or watch the record file rather than assuming absence means
failure.

**Gate dimension** (gate-armed workers only, §10 — absent everywhere else, and
written only after the outcome dimension exists):

| Field | Type | Meaning |
|---|---|---|
| `gate_state` | string | `"running"` \| `"interrupted"` \| `"passed"` \| `"failed"` \| `"blocked"` \| `"superseded"` \| `"scoped"` \| `"mismatch"` — the last thing a gate pipeline said about this run. The three verdicts, `superseded` (an adopted pipeline whose item was already landed by hand, §10.8 — no gate ran), `scoped` (a verified no-code outcome, §10.11 — no gate ran) and `mismatch` (the branch stopped carrying the pinned candidate its gates judged, §10.9 — nothing was built) are SETTLED; `running`/`interrupted` mean a pipeline started and never reported, which is what a later worker resumes from (§10.8). Propose-mode integration adds `parked` (§10.9) |
| `gate_worker` | string | the worker id that last touched it |
| `gate_at` | ISO 8601 | when that stamp was written |
| `gate_settle_id` | string | the settler's random ownership nonce, minted with a settled verdict (§10.10); every evidence field stamped after the verdict lands only through it |
| `gate_reason` | string | optional — the settled verdict's one-line reason |
| `gate_fix_run_id` | string | optional — the run id of the most recent fix cycle this pipeline dispatched at the same node, stamped the moment it was dispatched (not when it finishes). If a stop lands while that fix cycle is still going, this field is what turns "the pipeline was abandoned" into "here is the run to go check" — a fix cycle's own dispatched run is detached and keeps going regardless (§10.7), and this is the only durable pointer to it. `spor runs`/`spor work --status` surface it. |
| `gate_fix_at` | ISO 8601 | when `gate_fix_run_id` was stamped |
| `gate_progress` | object | optional — `{key, at, seq, gates: {<gate id>: {fixes, attempts, ledger, lastFix}}, rescue, pools}`: each gate's own memory (§10.4), saved after every review verdict (with the fix it decided on as `lastFix.dispatched: false`) and again when the fix's launch is known (`fixes` counts LAUNCHED fixes only). `key` is the attempt's run key — a resumed pipeline of the same attempt reads it back; a `--regate` (a new attempt) ignores it. Best-effort like every `gate_*` stamp: a write that fails is logged and the pipeline goes on. `pools` is the pipeline's shared INFRASTRUCTURE pool — `{retry: {spent}}`, §10.4 — carried by every other save under the same key; unlike the rest of the stamp its write is NOT best-effort, since a retry nobody recorded is one the next resume would grant again |
| `gate_escalation_failed` | boolean | optional — set when the refusal (a gate's, or the integration stage's, §10.9) could not file the escalation that carries it, so nothing was written to the graph and (§10.7) nothing was demoted either. The verdict is still settled; this is what says the refusal is readable only on this box, and that the bounded auto-retry below — or `spor work --regate` once it gives up — is the door back. Cleared (`false`) once an escalation lands, by hand or by the auto-retry |
| `gate_escalation_pending` | object | optional (§10.7) — the exact args `deps.escalate` needs to replay the failed write. A gate refusal's: `{gateId, attempt, attempts, detail, evidence, findings, ledger, factId, rescue?, rescues?}`; the integration stage's (§10.9): `{stage: "integration", gateId: "integration", attempt, attempts, detail, evidence, factId}` — `stage` is what routes the replay to the stage's own escalation (a declared gate may be named `integration` too), and `factId` names the refusal's own `art-gate-…`/`art-merge-…` fact so a landed retry can close it. What the bounded auto-retry reads; absent for a blocked human gate (no escalate call to replay). Cleared (`null`) once the escalation lands |
| `gate_escalation_retry_count` | number | optional — how many times the bounded auto-retry has attempted this refusal's escalation write, landed or not. `0` the moment `gate_escalation_pending` is first stamped |
| `gate_escalation_retry_at` | ISO 8601 | optional — the earliest time the next auto-retry attempt may run (exponential backoff from `work.escalationRetryBackoffMs`, capped at `work.escalationRetryMaxBackoffMs`). Absent means "due now" |
| `gate_escalation_retry_exhausted` | boolean | optional — the auto-retry spent `work.escalationRetryMaxAttempts` attempts without landing the escalation and gave up loudly (one log line); `spor work --regate` is the only door left |
| `gate_demote_pending` | boolean | optional, propose mode only (§10.9) — `true` while a parked item's rollback is still owed: its tracking item filed but the demotion's own write failed (at park time, or during a heal pass). The per-pass proposal check retries the demotion on this flag and writes it back `false` once it lands (in the same stamp that owes `gate_restore_pending`, if the rollback has to be undone); left standing against a tracker that is already terminal, it is recovered — the item restored if the proposal's landed fact exists — before it is cleared. A park that never filed its tracker needs no flag, since healing the tracker is itself what triggers the rollback; and a debt this flag failed to record is re-derived from the graph (open tracker, no landed fact, item still at completion) on every later pass |
| `gate_restore_pending` | boolean | optional, propose mode only (§10.9) — `true` while the UNDO of a rollback is still owed: the demotion above landed against a proposal that had settled between the tracker read that licensed it and the write itself (the tracker closed, or the landed fact written, by another pass or a person), and the promotion that undoes it failed. The per-pass proposal check retries the promotion on this flag and writes it back `false` once it lands |

**Implementation dimension** (factories declaring an `implementation:` stage
only — absent on every legacy run, and on every run of a factory that declares
no stage; written beside the gate dimension). These fields are ADDITIVE per the
rule above: **a record carrying none of them is a legacy run and reads as
`completion.by: agent`** — it wrote its own resolver, `shouldGate` still gates
it, and §10.7 still demotes it on a refusal. No record is ever rewritten, and
`journal/work/*.work.json` does not change shape for this stage.

| Field | Type | Meaning |
|---|---|---|
| `impl_state` | string | the stage's own state, mirroring `gate_state`: `"candidate"`, `"declined"`, `"exhausted"`, `"escalated"`, `"unroutable"`, `"mismatch"` are **settled**; `"dispatched"`, `"running"`, `"interrupted"` mean a stage started and never reported. Read it exactly as `gate_state` is read — an **unrecognized** value RESUMES rather than counting as a verdict (`SETTLED_IMPL_STATES` in `lib/kernel/candidate.js` is the list), and **absence** is not an unfinished stage but a legacy run |
| `impl_attempt` | int | which attempt of the code pool produced this record's tree (1-based) |
| `impl_pool` | string | which budget pool that attempt belongs to — `"implementation"` (the code pool) or `"retry"` (the shared infrastructure/publish pool) |
| `impl_run_id` | string | the run that submitted the candidate — the stage's own run, never a fix cycle's |
| `impl_candidate` | object | the **tip** candidate: the pinned commit plus the tree it resolves to, plus provenance and a portable reference. See the table below |
| `impl_candidates` | object[] | the **chain** of pins, oldest first, **ending at the tip**. A fix cycle or a rescue moves HEAD, and each re-pin onto a new tree appends here; a re-pin onto the SAME tree updates the last entry in place (it is the same candidate — the new commit joins its `commits_seen`). A tree can come back (a fix that reverts a one-hunk change reproduces it exactly), so **one `candidate_id` may appear more than once** — read the chain as an ordered list of pin events, never as a map keyed by id (§10.12) |
| `impl_claim` | object | **controller completion only** (§10.13) — the claim pins, riding the record's CREATION write in ONE stamp with the initial `impl_state: "dispatched"`, so a record either has all of it or was not created by a stage launch: `{execution_id, claimed_at, completion: {by, after}, publish: {kind, bundle_store, remote}, factory: {node_id, revision}, item_revision, resolving_snapshot, status_snapshot}`. Everything the pipeline enforces is pinned HERE — an edit to the factory node mid-pipeline changes nothing. **A record with no `impl_claim` is a legacy run and reads as `completion.by: agent`.** |
| `impl_claim.store` | string | **controller completion only, additive** (§10.15) — which EXECUTION STORE holds this pipeline's execution: `"remote"` (the server's `/v1/executions`) or `"local"` (the machine-local store under `journal/executions/`). Stamped by the claim, read by every resume so the pipeline drives the store it was opened in. **A controller record with no `store` was claimed before the adapter existed and reports nothing to any store** — it runs exactly as before |
| `impl_claim.tenant` `.pipeline_attempt` `.fence` `.lease_expires_at` `.worker` `.machine` `.gates` | mixed | the execution's partition, the attempt its id is addressed by, the FENCE this worker holds (re-stamped on every re-claim that advances it), the lease it was handed, the owner principal the store derived, and the pinned gate ids the reporter filters on (a synthetic scoping gate is never reported) |
| `gates_state` | string | `"passed"` \| `"failed"` \| `"blocked"` — the settled verdict of the gate LIST alone, stamped when the list settles and before the integration stage starts. Stamped for every gated run; the fold into `gate_state` stays for legacy readers, but `gate_state: passed` cannot say WHICH boundary was passed and the completion predicate must (§10.13) |
| `integration_state` | string | `"running"` \| `"landed"` \| `"parked"` \| `"failed"` \| `"refused"` \| `"mismatch"` — the integration stage's own verdict, stamped as it runs and settles. `mismatch` is the one that spent nothing: the branch no longer carries the pinned candidate, so no worktree was cut and no fix cycle ran (§10.9) |
| `completion_debt` | string \| null | **controller completion only** — ONE field, never a set of booleans: `"write"` (the boundary was reached and the edge + status are owed), `"retract"` (a premature resolving edge is owed its retype), `"withdraw"` (our edge stands on an item abandoned under us and is owed its retype back), or `null`. Every transition is a single overwriting stamp (owe-first), and every pass RE-DERIVES the debt from `impl_claim.completion.after` against `gates_state`/`integration_state` and the graph rather than trusting the flag (§10.13) |
| `completion_written_at` / `completion_withdrawn_at` / `completion_consumed_at` | ISO 8601 | when the completion settled, and how: written (the CAS landed), withdrawn (a person abandoned or released the item under us; our edge retyped back), consumed (the item was already terminal and released — resolved elsewhere, nothing written). Exactly one is ever set |
| `completion_resolver` | string | the id of the completion record the controller wrote (`art-completion-<stem>-<candidate>`), content-addressed to the candidate it completed |
| `completion_boundary` | string | `"gates"` \| `"integration"` — which declared boundary the completion was written at |
| `completion_premature` | string[] | the source node ids of resolving edges that were written under the hold and retyped `relates-to` as evidence (§10.13) |
| `completion_facts` | string[] | the gate/merge fact ids the pipeline filed, carried so a completion re-driven by a later pass can still link them |
| `completion_note` | string | optional — the one-line reason a completion was withdrawn or consumed |
| `publish_pending` | object \| null | the publish a candidate still **owes** (`{reason, classification, at}`), stamped whenever a pin could not publish and cleared by the publish that verifies. `classification` is `infrastructure` (an outage — re-attempted from the workspace on the next pin, never by re-dispatching the implementer), `candidate-mismatch` (the published evidence does not describe the candidate) or `publish-conflict` (the id already holds a different object). A pin never FAILS on it: the tree is judged regardless, but the stage stays unsettled |

**The candidate object** (`impl_candidate`, and every entry of
`impl_candidates`), minted by `lib/kernel/candidate.js`:

| Field | Type | Meaning |
|---|---|---|
| `candidate_id` | string | `cand-` + the first 16 hex of `sha256(repo, node_id, tree)` — **and nothing else**: not the commit, not the attempt, not the run. The TREE is the content a gate judges; the commit is one of possibly several labels on it |
| `spec_version` | int | the object's own version (`1` today) |
| `repo`, `node_id` | string | the two identity fields beside the tree — one tree in two repos, or for two items, is two candidates |
| `commit` | string | the pinned commit, **immutable once published: first published wins** |
| `tree` | string | what `commit^{tree}` resolves to — the identity, and what "we already judged this" means |
| `base` | object | `{ref, commit, merge_base}` — the trusted ref, its tip at pin time, and the merge base a bundle is cut from |
| `branch` | string \| null | the branch the checkout was on, or `null` for a detached HEAD |
| `commits_seen` | string[] | every OTHER commit seen carrying this same tree — an amend, a same-tree re-commit. A re-submission with a different commit appends here and changes **nothing else** |
| `clean` | bool | the `require_clean` verdict at submission, computed with the same `git status` read a command gate uses — an **unreadable** status is `false`, never `true` (§10.3) |
| `changed_paths_sha256` | string | the digest of the changed-path list, in git's own order |
| `supersedes` | string \| null | the `candidate_id` this one re-pinned over |
| `submitted_by` | object | `{stage, cycle, rescue}` — which step produced this pin: `"implementation"` (the first submission), `"fix"`, `"rescue"` or `"integration-fix"` |
| `provenance` | object | `{run_id, attempt, pool, harness, profile, agent, worker, machine, cwd, started_at, finished_at}`. **`cwd` is provenance, not a reference** — nothing in the pipeline follows it, and a controller on another machine never sees it as a way to obtain the commit |
| `reference` | object \| null | the ONE door a reader uses to obtain the commit: `{kind: "bundle"\|"branch", locator, commit, …}`. `null` means the publish is still **owed** — there is no `publish: none`, so "unpublished" has exactly one meaning, and a candidate is not SUBMITTED until its reference verified |
| `resolver` | object | `{node, written, resolves_edge}` — the implementer's own resolver node. `resolves_edge: false` is the point under controller completion: the node exists and the edge that retires the item is not on it yet |

A consumer reading `impl_state` as a verdict must check it is settled, exactly
as for `gate_state`. A consumer reading `impl_candidate` must consume the
**pinned** `commit`, never a branch head: a head that is a same-tree relabel of
the pinned commit is not what was judged.

**Publishing the candidate** (`lib/shell/candidate-publish.js`). Every
candidate carries a portable reference — **there is no `publish: none`** — so
that a controller which does not share a filesystem with the implementer can
obtain `commit` and prove it resolves to `tree`. The factory declares which
door(s) under `implementation.candidate`:

| `publish` | what is written | `reference` fields |
|---|---|---|
| `bundle` (default) | `git bundle create` of `base.merge_base..commit`, under `refs/spor/candidates/<candidate_id>`, into `candidate.bundle_store` (default `file://<userConfigHome>/candidates` — machine-local, **not** a marker-resolved shared graph home; gitignored in whichever directory the store itself resolves to, if that's a git working tree — task-spor-candidate-store-home-vs-shared-graph-home-trap) | `{kind, store, key, locator, commit, sha256, bytes, verified_at}` |
| `branch` | `git push <resolved url> <commit>:refs/spor/candidates/<candidate_id> --force-with-lease=<ref>:` — the empty expectation, i.e. **create only if absent**, never `--force` | `{kind, locator, ref, commit, verified_at}` |
| `both` | both, with the bundle as `reference` and `references[]` carrying both doors | as above |

Four properties the publisher is built around:

- **The published object is immutable and keyed by `candidate_id`.** A re-pin
  onto the same tree publishes nothing (its commit joins `commits_seen`); a
  re-pin onto a new tree is a new candidate with its own object. A store that
  already holds the id is never overwritten — it is FETCHED and asked what it
  resolves to: our pinned commit and tree is this publish replayed (a crash
  after a landed put, or a retry from the workspace), anything else is a
  `publish-conflict`. Deliberately **not** a byte comparison: `git bundle
  create` is not byte-reproducible (threaded delta search repacks differently
  run to run), so comparing bytes would call the designed retry corruption and
  poison the id permanently. A `file://` put is a hardlink of a FINISHED temp
  file into place (`wx` reservation + rename where hardlinks are unavailable),
  never a copy into the target — a copy is observable half-written.
- **The producer verifies its own publish by fetching it back**, into a scratch
  repository, from the locator — never by reading its working tree. `commit`
  and `commit^{tree}` must match what the candidate pins, or the publish is a
  `candidate-mismatch` caught on the machine that can still fix it.
  `reference.verified_at` is stamped only by that round trip, and a candidate is
  not SUBMITTED (`impl_state: candidate`) until it is.
- **A locator is an absolute `file://` or `https://` URI — or, for a `branch`
  reference only, `ssh://`** (issue-spor-candidate-reference-locator-vocabulary-lacks-ssh:
  a `bundle` reference's locator is always the declared/default `bundle_store`,
  which stays `file://`/`https://` only, so `ssh://` is admitted exactly where
  §3.4's `branch` door already resolves a git remote). An scp-style spelling
  (`git@host:org/repo.git` — what `git remote get-url` most often answers for
  an `origin` cloned over ssh) is normalized to its canonical `ssh://` form
  before it is ever stamped as a locator, since a bare `user@host:path` is not
  an absolute URI on its own; the normalization does not reproduce git's own
  home-relative-path distinction (`git@host:path` vs `git@host:/path`) because
  every host this matters for in practice — GitHub, GitLab, Bitbucket,
  self-hosted forges — routes on the path text itself, so both spellings
  collapse to the same `ssh://user@host/path`. A remote NAME, a bare sha, a
  relative path and anything under the producing run's own working tree or
  inside a `.git` directory are still refused — they resolve only on the
  machine that is about to disappear.
- **A worker refuses at startup what a parse could not read**: an `https://`
  store in local mode (there is no candidate door without a server), a
  `file://` store it cannot write, and a `branch` publish whose remote does not
  exist — or resolves to a scheme no reader can fetch — in every checkout it
  knows about. This is FATAL, unlike the `gh`/propose warning: a box that
  cannot publish can submit nothing at all, so dispatching implementers there
  burns spend to produce nothing.
- **A refused reference SHAPE is `unpublishable`, never `infrastructure`.**
  Every reason the shape check above can give — a locator under the
  producing run's own working tree included — is a structural fact about the
  declared store/remote, not an outage: retrying changes nothing, so it
  spends no pool and escalates naming the shape rather than being retried
  until the retry pool drains
  (issue-spor-unpublishable-reference-shape-classified-infrastructure-until-
  pool-drains). Two of the three refused shapes are knowable without a
  checkout and are caught by the startup refusal above; the third — a store
  resolving under the producing run's own working tree — needs a run's `cwd`,
  which a startup check never has, so it is caught here, on the first
  publish attempt, and only once. `gates.js`'s `publishOutcomePool` is the
  one table that says which publish classifications may charge
  `implementation.retry.attempts` — the same shared per-pipeline pool §10.4
  charges a review or fix outage against — so the two questions ("did the
  dispatch run", "did the candidate reach a reader") are never answered by
  two disagreeing copies.

A consumer reading `gate_state` as a verdict must check it is one of the
settled values (`passed`/`failed`/`blocked`/`superseded`/`scoped`, or `parked`
under propose mode — `SETTLED_GATE_STATES` in `lib/kernel/gates.js` is the
list):
`running` under a worker that is gone is a claim nobody finished judging, not a
pass.

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
- [ ] on finishing, checks the target's own **attestation of completion** —
      a live resolving edge, or a terminal own-status for a type retired by
      status — rather than declaring victory itself (§6)
- [ ] if the target is not attested complete, **files its final report as an
      artifact** `relates-to` the target (§7) — never silently drops the
      work, whichever of the two attestation paths its type takes
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

The same payload may declare optional blocks BESIDE `gates`, each parsed the
same fail-closed way and each inert when absent: `integration:`, the
merge-queue landing stage that runs once every gate has passed (§10.9);
`rescue:`, the strong-model step before any human escalation (§10.10); and
`implementation:` / `completion:`, the stage that produces the candidate the
gates judge and the boundary at which the resolving edge is written (§10.12-
§10.14).

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
the pool carrying its report) and a `failed` run produced nothing to gate. A
`declined` run (§6) is never gated, enforced or not: it declared the item wrong
and its route is triage — the finding it filed re-briefs the item, and its
readiness stamp is gone, so it does not come straight back to a worker either.

Under **controller completion** (§10.13) there is a third case, and it is the
whole point of the stage: the implementer never writes the resolving edge, so
its run can never read `resolved` — the graph, under the item's execution
hold, answers "not resolved" and §6 files an ENFORCED `reported`. That run IS
the candidate submission, so a record whose claim pins `completion.by:
controller` (`impl_claim`) is gated on every terminal state but `declined`; the
pipeline's own empty-diff and dirty-tree refusals then judge whether a
candidate is actually there. A legacy record (no `impl_claim`) reads exactly as
the two cases above.

A gated run whose diff is EMPTY may still be a correct outcome — the item's
real work was scoping, not code. That is not a fourth gated outcome but a
ROUTE inside the pipeline, taken only when the run declared it and the runner
verified the declaration against the graph: §10.11.

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
   cannot be read is itself a refusal, never a clean tree). A tree that is
   dirty in exactly that way gets **one commit-or-discard round-trip** before
   any gate judges it (task-spor-worker-declined-outcome): a fix-cycle
   dispatch into the run's own checkout, told to commit what belongs to the
   item, discard what does not, and leave the tree clean. The tree is then
   re-read; if it is clean the gates run normally, and if it is still dirty
   the first gate refuses it unretried as before, with the round-trip on the
   escalation so the person sees it was tried. Only the dirty-tree refusal
   earns this — a missing checkout, an unresolvable trusted ref, or a failed
   `git status` is about the checkout, not the work, and escalates directly.
   A rescue pass (§10.10) gets the same one round-trip, keyed by pass: a
   rescue that leaves its fix uncommitted is an implementer that forgot to
   commit, and the original pass's spent round-trip never denies it;
2. **fails CLOSED on an EMPTY diff** — a branch carrying no committed change
   against the trusted ref — before the suite, the serialize lease, and
   arming, exactly as the review gate does (§10.4) and unretried, straight to
   a person (task-spor-command-gate-empty-diff-short-circuit). With no change
   under it a suite result is a statement about the trusted ref, not about the
   item: a pass is vacuous and a failure (a red trusted ref, box contention) is
   not the item's. The first live case (2026-09-05, run `d6a89bfe`) gated a
   data-only item — the deliverable was a graph write and the tree sat at the
   trusted ref — ran `npm test` on what was literally `main`, timed out under
   load, and spent the one rescue on a stale premise. The refusal says the
   deliverable was not code and asks the person to verify the graph write; a
   declared no-code outcome that did not check out (§10.11) rides along with
   why. It is never rescued (§10.10): the tree carries no change for a rescue
   to work on. Before arming for the reason §10.4 gives: an empty diff arms
   nothing, so a risk-declaring gate evaluated for arming first would read
   `skipped` and pass;
3. **fails CLOSED** if that change touches any declared protected test path —
   the suite is not run at all, no fix cycle is offered, and the test change is
   filed as its own queue item naming the `test_lane_profile` (a different
   lane). Same entity, same misunderstanding: the lane that writes the test may
   not be the lane that writes the code;
4. otherwise materializes a throwaway git worktree at the implementer's commit
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

- **`risk`** — the same arming predicate a human gate (§10.5) and an
  agent-review gate (§10.4) have: with risk
  classes declared, the gate runs only when the change touched one of them,
  and otherwise records `skipped` — a fact, not a pass by omission. An
  unreadable diff still fails closed.
- **`serialize: "repo"`** — the gate takes the repo's lease (the one the
  integration stage holds, keyed on the main checkout locally and the
  synthetic per-repo lock node remotely) before its suite and releases it
  after, so two gate trees, or a gate tree and a landing, never share the
  singleton. Fail-open like the integration lease: an unavailable lease is
  logged and the suite runs.
- **`reruns`** (default 0, at most 3) — how many times the gate re-runs the
  SAME command on the SAME tree before a failure counts
  (task-spor-factory-spor-flaky-command-gate-needs-fix-cycle-or-rerun). A
  full suite that flakes under parallel load used to cost either a fix cycle
  (an implementer re-dispatched at a change that was never wrong) or, at
  `cycles: 0`, a rescue or a person; a rerun costs one more suite run and
  nothing else. It is never a laundering step: a pass on a rerun is recorded
  on the `art-gate-*` fact WITH the first attempt's failure as evidence and
  an outcome line that names it a rerun, so the flakes stay countable in the
  gate telemetry — and a suite that fails on every run is charged as one
  failure whose outcome says how many runs it failed. "The same tree" is
  literal: the judged worktree is prepared ONCE for the whole loop (the
  protected paths forced back, the repo's worktree-setup hook run) and every
  rerun executes in that one checkout, torn down after the last run. The
  lease, when declared, is held across the reruns. The suite sees `SPOR_GATE_ATTEMPT`
  (1 for the declared run, N+1 for the Nth rerun) beside the rest of its
  environment.
- **`isolate`** — a command template carrying a `{files}` token, e.g. `node
  --test {files}`, and the gate's answer to a failure the change is
  demonstrably not the cause of
  (task-spor-factory-flake-rescue-should-not-burn-when-failure-is-off-diff).
  After every declared rerun and before the failure is charged, the runner
  reads the FILE PATHS the failure named and asks whether the change is
  implicated in them at all. Only when it is demonstrably not are the failing
  test files re-run through this template on that same prepared tree — and if
  they pass alone, the whole-suite failure is an **off-diff flake**: the gate
  PASSES, and the flake is filed as its own `issue-flake-*` node rather than
  spending the item's fix cycles, its rescue lane and finally a person on work
  that was never wrong. ONE issue per failing FILE, keyed on that file alone —
  a flake belongs to the file that flakes, not to the set it happened to fail
  beside (a set that shifts with load and ordering, and whose every permutation
  would otherwise be its own near-duplicate). The pass needs every one of them
  to land: a file with no durable record is the one thing it may not trade
  away, and a filing that fails charges the failure as before.

  "Off-diff" is TWO claims, and both must hold. First, no failed run named a
  file the change edits — every run, not just the last, since a declared
  `reruns` budget means a charged failure is several samples of one tree and
  they need not fail the same way. Second, the failing tests do not
  **reference** the change either: not appearing in a diff is a coincidence,
  not an argument, and a test that never appears in one can still import,
  spawn or read a file that does (the refusal that prompted this feature is
  exactly that shape — test/codex-dispatch.test.js spawns `bin/spor.js`,
  which the change had edited). So the files the failure named, and everything
  reachable from them through the local files they name, are READ and asked
  that question two ways — because one spelling misses the other's shape. TEXTUALLY: any
  spelling of a changed path in the source — the path itself, its basename as
  a token (what a `path.join(ROOT, "bin", "spor.js")` leaves behind), an
  extensionless quoted specifier. And by RESOLVED IMPORT EDGE: every local file
  the source names, resolved against its own directory and compared to the
  change set exactly, which is what catches a segmented spelling whose text
  contains no repo-relative path at all (`lib/index.js` requiring
  `./kernel/queue.js` references `lib/kernel/queue.js` while spelling neither).
  The edge question is asked of every file the walk reads, the last one
  included.

  HOW FAR it looks is the whole transitive closure, not a fixed number of hops.
  "Imported or executed by the failing test" is a transitive claim — a test that
  reaches the change through two helpers executes it exactly as much as one that
  requires it directly — and a walk that simply STOPPED at a depth limit would
  answer "no reference" in a voice indistinguishable from having looked
  everywhere. So the frontier is followed to exhaustion, and the only bounds
  left are read budgets that fail CLOSED: a file the walk still had to read
  when it ran out of budget is `unknown`, and the failure is charged.

  WHICH files are asked is likewise two sets. The test files the isolation
  would re-RUN are HARD seeds: anything that stops us reading one stops the
  pass, since we would otherwise re-run a file we could not judge. The other
  files the failure named ride along as soft seeds — the failure went THROUGH
  them, so what they import is as much part of the question, but a path
  scraped out of a stack frame need not exist in this tree and one that does
  not is importing nothing. That softness is about ABSENCE only: once a file
  is here, not reading it leaves the question open exactly as much as for a
  hard seed, so an existing file the walk cannot read (too large, a permission
  error, an I/O fault) is `unknown` whichever kind of seed it is. That check is
  deliberately over-inclusive and bounded: a reference it cannot rule out, a
  hard seed that is not there, a file it cannot read, and a walk that would
  exceed its budget all read as "not demonstrably off-diff". The practical
  consequence is that the pass is NARROW — in a repo whose tests drive one
  large entry point, most changes are implicated in most failures and the
  failure is charged as it always was. That is the intended trade: the
  `reruns` budget is the broad flake mitigation, and this is the one case
  where the gate can say the change had nothing to do with it.

  Bounded and conservative in every other direction too:

  - it reads paths and nothing else — no verdicts, no counts, no test names.
    A harness's RESULT structure is the harness's (that is why
    dec-spor-command-gate-bounded-same-tree-rerun dismissed "re-run what
    failed"); a file path is printed the same way by all of them, and the
    verdict still comes from the isolated run's own exit code. What it does
    read from the output's shape is only WHERE a path may be taken from: the
    failure's own region (a `not ok`/`✖`/`FAIL`/Error/traceback line and the
    indented block under it), never a line the run marked as a PASS — a whole
    suite prints one line per file it ran, and a set of passing files is
    trivially off-diff and trivially passes in isolation;
  - a failure that named no readable path, or named one the change touches,
    is **not** off-diff and is charged exactly as before. So is one whose
    isolated re-run fails too — off-diff is a reason to look, never to pass;
  - only files a harness would recognize as TESTS are re-run (a `lib/` path
    scraped out of a stack frame handed to `node --test` would exit 0 for
    having no tests in it), and at most five of them: six files failing at
    once is a breakage, not a load-sensitive flake;
  - the isolated run happens inside the SAME prepared tree, before it is torn
    down and under the same lease, so a pass means "these files pass HERE",
    never "on some fresh checkout at the same sha". A failure output exceeding
    the path collection limit cannot certify off-diff isolation. Package or
    directory entry imports whose targets were not resolved also keep the
    failure charged, because an entry may load changed source. It sees
    `SPOR_GATE_ISOLATE=1`;
  - it is never a laundering step: the whole-suite failure rides the
    `art-gate-*` fact as evidence, the outcome line names the flake, and the
    fact carries a `relates-to` edge to the flake issue. The pass is
    CONDITIONAL on that flake issue landing — a gate fact write is
    best-effort, so a flake that could be filed nowhere would be a pass over a
    red suite that nothing records; when the filing fails the failure is
    charged instead, and the outcome says the isolated run passed and why it
    was charged anyway. The filings that DID land before one failed still ride
    that charged fact as `relates-to` edges: each is this run's occurrence of
    that file's flake, and an issue no fact links to has no provenance and no
    occurrence to its name. That edge is a DEBT, tracked PER ISSUE on the
    flake payload itself and discharged only by a landing the pipeline
    OBSERVED — a write that CREATED the fact, or, when the write door reported
    the id already occupied (`if_exists: skip` remotely, identical-content
    adoption locally, neither of which is this markdown landing), a read of
    that occupant which saw the edge, or an edge written straight onto that
    occupant. A write door's bare success never discharges it, and neither
    does the mere presence of a fact id. That read-back answers TWO questions,
    not one. Is the node under this deterministic id THIS record? Another
    actor — a resumed pipeline, a second worker, a heal pass — can have
    written this gate run's fact between the check and the write, and what a
    race changes under us is the VERDICT, which is what the frontmatter
    `title:` carries; a title that differs means this markdown did not land,
    so the verdict is not reported as recorded and the fact is not offered to
    the rescue as its `derived-from` anchor. (A byte compare is the wrong
    instrument for the remote half: the server stamps `author`/`authored_via`
    onto what it stores, and a legitimate earlier incarnation of the same
    record — one written before a filing landed — differs in body and detail
    while being the same verdict with a smaller debt.) And which edges are on
    it, read TYPED: an occurrence is a `relates-to`, so a `mentions` or a
    `derived-from` pointing at the same issue from the same fact names it
    without recording an occurrence of it, and counting it would silently lose
    one from the file's count. An edge the fact could not carry is then paid
    ONTO that fact, through the idempotent add_edge door, at the moment the
    debt is known — a PASSING gate and the final refusal have no later fact of
    that pass to carry it, so a debt deferred there is a debt that sinks. The
    payment is recorded only from the door's own success. Before the first
    issue filing, the exact isolated classification and failing evidence are
    saved as a filing intent. A failed first save writes no graph node; a
    crash after issue filing resumes that intent without rerunning the suite.
    The intent is replaced atomically by the exact outcome and judged head in the gate's
    `gate_progress` evidence entry, bound to the original graph server and
    tenant (or canonical local nodes directory). A missing or mismatched
    origin refuses replay and leaves the obligation intact. A failed fact write, edge payment, or
    receipt save leaves the attempt **interrupted**, with its debt retained.
    Partial payment receipts are stored separately from the original outcome:
    replay renders exactly the same fact body while paying only missing edges.
    Removing or renaming a gate with an unpaid evidence entry or filing intent
    refuses the pipeline before candidate pinning, tests, or fixes. Restore its
    original declaration and settle the debt before changing that factory.
    Resume retries that evidence without running commands or spending another
    fix or rescue cycle. A completed receipt is reused, including across a
    restart; an edge that landed just before a failed receipt save is recovered
    by reading the fact. Legacy rescue entries still carry their per-issue
    discharge state, so they remain resumable without double counting.

    Fresh facts omit occurrence edges from their initial publication. Every
    occurrence is paid through the guarded edge door, including fresh facts:
    remotely `POST /v1/nodes/:id/edges/live`, with a `target_guard: live`
    acknowledgement. An older server returns 404 without mutating the graph.
    The server tests liveness inside its mutation queue. Local mode refuses
    fresh payments because its graph writers share no atomic mutation door;
    the attempt remains interrupted with its evidence intact. Existing local
    historical receipts can still be acknowledged. A target that
    settled after selection advances to a live recurrence rung. A historical
    edge remains paid after its target settles, so replay never manufactures
    another occurrence on the next rung. The fact's body, head and gate
    definition must still match; only the known occurrence edges are ignored
    when reconciling that evidence identity.

  The flake issue is the one node a gate files whose id and body are keyed on
  the failing FILES rather than on the run — a flake is a property of the
  file, so the same file flaking on ten dispatches converges on ONE issue
  instead of ten near-duplicates. The occurrence count is that issue's inbound
  `relates-to` edges from the gate facts, each of which carries the run, the
  item and the evidence. It is routed to the factory's `test_lane_profile`,
  because fixing a flaky test is a test change and must not come from the
  implementer's lane. The convergence is RECONCILED against settled state
  rather than taken on the strength of the id: the candidate is read first,
  and an id occupied by LIVE work is linked (never rewritten — for every other
  node a gate files an occupied id is a refusal, since adopting a stranger's
  approval item would pass a gate nobody looked at, but this id is keyed on
  the failing files and on nothing else, so the occupant is this flake's issue
  by construction), while an id whose occupant is already RESOLVED or CLOSED
  advances to a recurrence rung (`…-r2`, `…-r3`) that links back to it — a
  fresh occurrence hung on a terminal node is no signal at all. A file that
  has been closed and reopened past every rung is reported unfiled, which
  charges the failure and gets a person, the right answer for a test that
  keeps coming back.

  That reconciliation is only as good as the read behind it, so a read that
  did not HAPPEN settles nothing. "No such node" and "could not look" are
  different answers (a 404 versus a transport error or a 5xx; ENOENT versus an
  I/O fault), and an occupant that could not be read is reported unfiled — not
  written past as if absent, not linked as if live, not climbed over as if
  settled. The write is not a second chance at that question: its door reports
  an id that was already occupied as a SUCCESS (`if_exists: skip` remotely,
  identical-content adoption locally), so believing it would adopt whatever is
  there unread — which for a resolved occupant is the very thing this
  reconciliation exists to prevent. A write that created NOTHING therefore
  sends the id back through the read once and lets the same live / settled /
  unreadable rule decide. That also covers the check-then-write RACE: two
  workers tripping over the same flaky file both read the id as free, and the
  loser's skip is read back rather than reported as a filing.

  Declaring nothing keeps the pre-existing behaviour exactly: with no
  `isolate` the runner never runs an extra command. What it DOES do for every
  command gate, declared or not, is put the failing file paths on the charged
  failure's outcome — flake telemetry aggregatable by file, where before the
  record said only that `npm test` exited 1.

The suite's environment says what it is judging: `SPOR_GATE_BASE` and
`SPOR_GATE_HEAD` (the shas), `SPOR_TRUSTED_REF`, `SPOR_GATE_STAGE` (`gate`,
or `integration` for the candidate suite, where base/head are the target
ref's tip and the candidate), and `SPOR_GATE_NODE`, beside `CI=1` and
`SPOR_GATE=<id>` — enough for a script to diff and decide what to run.
`SPOR_GATE_ISOLATE=1` is set only for an `isolate` re-run, so a suite that
wants to skip its own setup for a single-file pass can tell the two apart.

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

**Or it routes itself across the fleet.** `--auto-route` (`dispatch.autoRoute`,
off by default — task-spor-fleet-autoroute-auto-tier-consumer) turns that
"left for" into a handoff: on the same unsatisfiable-here refusal, a NODE
dispatch asks the fleet scheduler which of the caller's OWN boxes satisfy
*this* profile (`GET /v1/profiles/{id}/hosts?owner=me`) and hands the item to
the freshest one by writing `assigned -> <host agent>` with the same profile
pinned on the edge — so that box's own `spor work` picks it up on its next
poll with nobody re-routing it by hand. It is a re-route, never a substitution:
the profile id on the edge is the one that was refused here, and when no host
satisfies it the refusal still escalates to the owner rather than downgrading.
The dispatching box still refuses (exit 1) and its worker cools the item off,
because nothing ran *here*; `dispatch.autoRouteMaxAge` (default `24h`) bounds
how stale a target's last contact may be, and `--no-auto-route` opts one run
back out. The handoff also retracts the refusing box's OWN `assigned` edge
once the target's edge lands (`spor edge --remove`, the `remove_edge`
micro-mutation, API.md §1/§3) — best-effort and idempotent, never touching
anyone else's edge — so the node carries exactly one live assignment
afterwards; without it the refusing box's own `spor work` would re-select the
item every `work.retryAfterMs` and re-run this whole routine (harmless, since
the write is idempotent, but noisy), which the assignee filter above (§3)
backstops in any case.

### 10.4 Agent-review gates — a verdict that is read, not asserted

The runner composes the review dispatch itself: a launch under the gate's
declared `profile` (cross-model by convention; the machine's own declared
harness binding still decides what actually executes — a graph write never
defines what a box runs), **read-only** (`spor dispatch --read-only`: Codex's
`--sandbox read-only`, Claude Code's plan permission mode, OpenCode's built-in
`plan` agent (edit denied everywhere) PLUS a `bash: deny` for that agent
handed to the run as `OPENCODE_CONFIG_CONTENT` by the adapter's `prepareRun`
(the plan agent's own table leaves `bash` at `allow *`, so plan mode alone
left the shell write-capable — the same hole Copilot's had), Copilot's
`--deny-tool write --deny-tool shell` (the file-writing tool AND the shell
tool denied at the permission layer — Copilot has no sandbox, and a shell
command writes the live checkout as freely as the write tool, so leaving
`shell` open was a prompt-bounded posture, not an enforced one). The named
cost of the OpenCode and Copilot postures is the same: a reviewer routed
there cannot run commands and therefore cannot DEMONSTRATE a blocking finding —
its verdicts are advisory, and a gate that needs blocking power routes to a
harness whose read-only posture still runs commands (Codex's sandbox, Claude
Code's plan mode) — the
reviewer reads the implementer's live checkout, so it must not be able to write
to it, and the posture overrides any write-capable `--sandbox`/
`--permission-mode` the worker's passthrough carries. A harness with NO
read-only posture — including a custom harness without `posture: read-only` — is **refused**
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
 "prior": [{"id": "F1", "status": "resolved" | "open", "note": "...",
            "category": "correctness|unmet-condition|unrequested-mechanism — optional, only to reclassify it"}],
 "findings": [{"severity": "blocking|major|minor", "category": "correctness|unmet-condition|unrequested-mechanism",
               "file": "...", "summary": "...",
               "evidence": "the command/test run and what it showed", "introduced_by_fix": true | false}]}
```

A finding raised fresh under `findings` carries no `id` — the ledger mints one when the verdict folds in. The
only findings named by id are a `prior` answer (naming that entry's own id) and an upgrade of an earlier
undemonstrated finding, re-raised under `findings` with its id (the "raised" entries described further down
in this section).

The runner then parses that block **in code** from the run's final report
(`parseReviewVerdict`, lib/kernel/gates.js). Fail-closed throughout: a review
that could not be dispatched, that never finished, that left no report to read
(an agent-review gate needs a harness whose report is readable — a supervised
run's `report_path`, or a native-background run's own session transcript
through the same last-assistant-text reading that `nativeRunReportText`
applies elsewhere, dec-spor-native-bg-turn-complete-and-contract,
task-spor-agent-review-gate-accept-native-bg-reviewer. Every built-in launches
supervised by default and a worker's own dispatches are always supervised, so
this stays a run-time failure rather than a load-time refusal either way — a
native record with no bound transcript to read is exactly as unreadable as a
supervised run whose report file never landed), or whose verdict is
unparseable or unrecognized is a gate FAILURE. An unread review is not an
approval. Nor is a review of nothing: a branch that carries **no committed
change against the trusted ref** (the implementer landed its work on the
trusted ref directly, or resolved with nothing behind it) fails the gate closed
and unretried, straight to a person — no reviewer is dispatched at an empty
diff, because a vacuous pass is exactly how an unreviewed change would launder
into an approval. A command gate refuses an empty diff the same way, before its
suite (§10.3, item 2), and neither refusal is rescued (§10.10).

**Arming by risk class** (task-spor-review-gate-risk-arming). A review gate may
declare `risk` against the factory's `risk_classes`, exactly as a command gate
(§10.3) or a human gate (§10.5) does — the same predicate, the same `skipped`
verdict, the same recorded fact. A gate declaring none is unconditional and
runs on every gated item, which is what every review gate did before. The
saving is the largest of the three kinds: an unarmed command gate skips a suite
run on the worker's own box, while an unarmed review skips a whole agent
dispatch — a model call, a lease, and an `await_ms` window up to the 1h default
— for a review that had no diff in its subject area to reason about. An
exploratory reviewer that drives a built UI, for instance, has nothing to
explore in a docs-only or repo-tooling change.

Three boundaries it does not relax. The empty-diff refusal above runs BEFORE
arming, because an empty diff arms nothing and evaluating arming first would
convert that fail-closed failure into a silent pass. An UNREADABLE diff fails a
gate that declares risk closed — a risk class is a path predicate, and "assume
it isn't armed" is the fail-open direction — but leaves a gate declaring none
exactly as it was, since that gate consults no paths and its reviewer reads the
live checkout itself. And a gate whose finding **ledger** holds an open
blocking finding runs regardless of arming: the diff moves across fix cycles,
so a fix that reverts the arming paths could otherwise disarm the gate
mid-pipeline, and `skipped` passes. A demonstrated defect is retired by a
reviewer clearing it, never by the paths that raised it going away.

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
  downgraded to advisory (the record says why). Evidence is a non-empty
  STRING naming what was run — a boolean `true`, a number, an object or a
  bare "yes"/"n/a" is not a demonstration. A `changes_requested` backed ONLY
  by undemonstrated blocking findings therefore does NOT fail the gate: the
  contract is demonstrated-only, and charging a fix cycle (and at the cap a
  person) to findings nobody demonstrated is the goalpost-moving it exists to
  stop. It passes, with the downgraded findings recorded as advisory on the
  ledger and the fact, and the record says what the reviewer claimed and
  could not back. A LATER review (another cycle, a re-gate) is handed those
  entries as **raised** and may demonstrate one by ITS id — provided it is
  the same finding: the entry's file must match, and the upgrade takes the
  ledger's file and summary as its identity (the reviewer's wording rides
  beside them as a restatement). A borrowed id under a different file is
  stripped and the finding read as the new one it is, subject to the
  fix-cycle floor. It then counts as raised at its original cycle (the ledger
  upgrades the entry in place), not as a goalpost. On a fix cycle
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

**A durable retry/debt flag is reviewed whole, in one verdict**
(task-spor-review-gate-durable-debt-flag-checklist). The stateful protocol
above stops a reviewer raising a NEW finding per cycle, but a single design
can still be walked one failure mode at a time: the first live run to ship a
`gate_*_pending` run-record flag spent all three fix cycles on one mechanism —
F2 the retry, F3 the closed tracker, F4 the check-then-write race, F5 the
non-atomic pair of writes — each fix exposing the next row, until the item
escalated with the design still one step short. So the review prompt carries
a fixed checklist (`DURABLE_FLAG_FAILURE_MODES`, lib/kernel/gates.js, rendered
by `renderDurableFlagChecklist`) and asks that when a change introduces or
extends such a flag — a `*_pending` field on a run record, a journal line, a
cooldown file, an outbox entry: anything one pass writes so a later pass owes
an action — the reviewer walk EVERY row and file every open one in the SAME
verdict, each as its own finding naming the row:

- (a) **the flag write itself fails** — the stamp is best-effort; is the debt
  still owed, and by what, when the write that records it did not land?
- (b) **clear-before-owe ordering and the crash window** — clearing one flag
  and owing the next as two writes loses the debt on a crash or a failed
  second write; owe first, or write both in one stamp.
- (c) **the check-then-write race** — another actor (a second worker, the heal
  pass, a resumed pipeline) settles the same state between the check and the
  write.
- (d) **a stale flag against already-settled state** — a later pass finds the
  flag but what it guards is already resolved or closed; reconcile, do not
  act blindly.

The same table goes to the implementer: the worker contract (§4) and the
fix-cycle prompt ask for the flag to be designed against all four rows up
front and for the commit message to say how each is handled, so the reviewer
reads a design and the fix closes the mechanism rather than its next row. The
fix-cycle prompt (and the dirty-tree round-trip's, which is a fix cycle with a
different detail) also ends with the one-turn notice (§4): a fix that
backgrounds the suite and ends its turn waiting on it leaves the gate the very
dirty tree it was dispatched to clean. On
a fix cycle the fix-introduced floor still applies: a row the fix INTRODUCED is
blocking, one open at the initial review and not raised then is advisory.
The checklist is prose — nothing parses it; the parser's protocol is unchanged.

**A carried finding names the mechanism, not the next row**
(task-spor-review-gate-carried-finding-names-the-mechanism-not-the-next-row).
The checklist above tables one mechanism's rows in advance; the general case
cannot be. The first live rescue spent its whole cycle budget on one finding —
"an early rescue diagnosis does not survive truncation" — because each fix
closed the one harness row the reviewer had probed (the Claude stream, the
Codex stream, a declared harness's job file, a declared `report: file`
harness) and the reviewer named the next; every cycle was right in isolation
and nobody was asked to enumerate the rows. So when a review confirms a prior
finding open it is asked to name the MECHANISM the finding is an instance of
and list every remaining row it can see as `rows` on that `prior` entry (one
string per row — the cases one fix would have to close together), saying
which rows the fix must close. The prompt tells the reviewer how many fix
cycles each prior finding has already survived, and once one has been carried
`ROW_BY_ROW_CARRY` (two) fix cycles the list is REQUIRED: a confirmation that
still names fewer than two rows is recorded **row-by-row** on the finding, on
the gate's fact (`[blocking, row-by-row]`) and in the refusal's detail
(`gates.rowByRowFindings`). The rows ride the finding ledger (folded by
`applyReviewToLedger`, cleared when the entry resolves, restored by
`rollbackCycle`, replayed to the next review) — and they are always the LAST
review's own enumeration: a confirmation that names no rows carries none (so
the row-by-row check reads what that review said, never a list an earlier
review made), and the earlier list moves to `earlierRows`, stamped with the
cycle it was enumerated at (`earlierRowsCycle`), replayed to the reviewer, the
fixer and the fact as history ("enumerated at cycle N, not re-confirmed") —
never as the current mechanism enumeration. A fresh enumeration supersedes it
(`gates.carriedRowsOf`). Only a CONFIRMATION does any of this: a prior finding
the review did not answer at all (ignored under rule 3, or in a verdict that
could not be read) is carried exactly as it stood — its last enumeration stays
current, its ledger entry is not folded (not recorded as answered this cycle),
and it is never tagged row-by-row, since it was not confirmed row-by-row but
not confirmed at all (`answered: false` on the carried finding). The fix-cycle prompt hands
the fixer the same list under the finding, says how many cycles it has
survived, and asks it to enumerate the rows ITSELF — whether or not the
review listed them — and to state in the commit message which rows the fix
closes and which it deliberately leaves, so the next review reads a design
rather than the next probe. Like the checklist this is prose for the reader
and a tag for the record: pass/fail is decided exactly as before, and the
`cycles` cap is unchanged (the budget was fine; the framing was not).

**An unmet done condition is not a defect**
(task-spor-review-gate-item-done-condition-vs-implementer-conclusion). The two
rules above bound a reviewer that keeps moving; this one bounds an implementer
that keeps arguing. The first item to hit it burned all three fix cycles AND
the rescue lane on ONE carried finding: the reviewer correctly held the item's
literal done condition (a classifier prompt inside a 6% budget) while each fix
cycle asserted the failure more firmly — a README verdict, a test pinning the
miss, a second measurement read as "the rate is real" — and none re-attempted
it. The rescue met the condition in one materially different revision. So a
finding now carries a **`category`**, asked for in the verdict and folded onto
the ledger:

- `correctness` (the default): the change is WRONG — a defect, silent data
  loss, a contract break. A fixer fixes it.
- `unmet-condition`: the change is not wrong, it does not do what the WORK ITEM
  ASKED — its stated done condition is unmet. A fixer does not fix that: it
  makes a fresh, materially different attempt at the condition, or a person
  re-scopes the item.

Unstated reads as `correctness` (only the unmet reading short-circuits the
budget, so the default must not be the short-circuit), a `prior` answer may
RECLASSIFY a carried finding by carrying `category`, and silence on a prior
entry leaves the ledger's category alone. **An upgrade by id inherits the
entry's category** the same way — a finding raised undemonstrated as an unmet
condition and demonstrated on a later cycle is still one, and a review that
restates no category has not reclassified it. Only the two vocabularies count
as a statement (`gates.findingCategory`, matched exactly); a `category` in
neither — an echo of the verdict shape's own `"correctness|unmet-condition"`
placeholder, a word nobody taught the parser — is read as no statement at all,
so it can never reclassify a carried finding by accident. Pass/fail is
untouched: an unmet condition blocks on exactly the same demonstrated-only
terms as anything else, and the tag rides the fact, the prior/undemonstrated
lines of the review prompt, and the fixer's prompt (`[blocking,
unmet-condition]`) the way `row-by-row` does.

Both prompts change with it. The reviewer is told the two are answered
differently, that a fix which ARGUES the condition is unattainable — or files a
decision re-scoping the item — has not met it, and that accepting a re-scope is
not a reviewer's call: confirm the finding open, name the decision in the note.
The fixer, handed an `unmet-condition` finding, is told to do exactly one of
(1) a fresh attempt materially different from the one that missed, saying in
the commit message what changed about the approach, or (2) file a Spor
`decision` re-scoping the item, `relates-to` the work item, named in the commit
message — and that (2) does not clear the gate and is not meant to.

And the runner stops paying for the argument: once such a finding has been
confirmed open through `UNMET_CONDITION_CARRY` (two) fix cycles
(`gates.unmetConditionFindings`, the same `answered !== false` and `prior`
guards the row-by-row check keeps), the refusal is returned `noRetry` — no
further implementer is dispatched at it, and it goes where a scope dispute can
actually be settled: the rescue lane if the factory declares one (§10.10), else
the human escalation. The declared `cycles` cap is untouched; this only ever
spends FEWER of them, and the refusal's detail and the gate fact say which
finding ended them and why.

**Unrequested mechanism is answered by deletion, not by a fix cycle**
(task-spor-factory-review-gate-fix-cycles-grow-unrequested-mechanism). The rule
above bounds an implementer that keeps arguing; this one bounds a reviewer and
an implementer growing surface together. The item that named it asked for
selection guidance plus a mid-task rule in a skill — docs only — and the
initial diff met that acceptance. All three fix cycles then went on findings
against a derived sibling-id scheme the FIX CYCLES had introduced: its retry
durability, the concurrency of the sibling write, the injectivity of the
derived id, the id length limit. Each finding was true, each cleared the
introduced-by-fix floor, and each cycle added the surface the next review
attacked; the rescue closed it by REMOVING that surface (a hashed fixed-length
id), not by hardening it once more. The floor could not stop it, because the
findings were correct about code that should not have existed.

So a finding carries a third `category`:

- `unrequested-mechanism`: the defect is real, it is in mechanism the work
  item's acceptance does not require, and REMOVING that mechanism would also
  satisfy the finding. The removal test is the whole category — if deleting
  the surface would not close what the reviewer found, it is `correctness`.

Such a finding is recorded **advisory, never blocking**, however well it is
demonstrated, at both doors: a fresh one never blocks (`normalizeFinding`, the
acceptance floor, checked before the evidence floor) so it never enters a later
review's `prior` set, and a carried one a `prior` answer RECLASSIFIES to it
goes advisory on the ledger in the same fold (`applyReviewToLedger`) — the
escape valve for a loop already running, since a demonstrated finding raised
before this existed can still be released by the reviewer that recognizes it.
A RELEASED entry is not an entry awaiting demonstration, so its id is not
claimable as an upgrade and it is not offered back to a later review as
`raised` (`gates.upgradableEntry`, the shared half of `advisoryIdSet` and
`raisedUndemonstrated`): no evidence can make it blocking, and taking a
reviewer's id collision as an upgrade re-opened it as a blocking
`correctness` finding — restarting the very cycles the release ends. A fresh
finding reusing the id mints a new entry instead, exactly as it does against
an open or resolved one.
The mechanism is not thereby blessed: the finding stands on the ledger and the
fact, and the fixer's prompt asks for it to be DELETED — the surface removed,
or reduced to the simplest thing the item asked for, with the commit message
saying what went and why the item does not need it — explicitly NOT hardened,
since every guard added to unrequested surface is more surface for the next
review. It simply cannot spend a fix cycle any more, and an item whose
acceptance is met lands instead of escalating on surface its own fixes grew.

Both prompts change with it. The reviewer is told the removal test, that a
blocking finding must name what it fails — a line of the item's ACCEPTANCE, or
a defect this DIFF introduces into behaviour that worked before; anything else
is `major`/`minor` — and, on a fix cycle, to ask the removal question of any
finding against mechanism a previous fix added and answer it in the note.
(`self-inflicted` is deliberately NOT one of the category's spellings: it is
the natural English for "my own fix caused this" — `introduced_by_fix`, the
qualifier that makes a fix-cycle finding blocking — and reading it as a scope
statement would pass a demonstrated fix-introduced regression as advisory. A
word in no vocabulary costs nothing; one in the wrong vocabulary costs the
gate.) The pass note the gate's fact records names the acceptance release
rather than rule 5's "demonstrated nothing", which is false of exactly this
case. The
fixer is handed the unrequested findings under their own heading with the
delete-don't-extend instruction, and on any fix cycle is told to ask whether a
previous cycle added the thing a finding attacks and to prefer deleting or
simplifying it to guarding it, keeping the change inside what the item asked
for. Categories stay prose for the prompts and a tag for the record
(`gates.categoryTag` renders any non-default category on the fact, the ledger
and the prior lines); the only mechanical effect is the advisory fold above,
and pass/fail is otherwise decided exactly as before.

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
history and the ledger, and stops — unless the factory declares a **rescue
lane** (§10.10), which runs first and escalates only if it also fails, with its
diagnosis on top. The `art-gate-*` fact carries the ledger too
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

#### An OUTAGE is not a rejection

A reviewer that never answered is not information about the change. Every
dispatch a pipeline makes — the review, its fix cycles — is read through ONE
shared classifier, `classifyExecutionOutcome` in `lib/kernel/gates.js`
(FACTORY-IMPLEMENTATION-STAGE.md §5.3,
task-spor-factory-execution-outcome-classifier), which separates an
**infrastructure** outage from a **code** failure over what the run record
already carries — `state`, `termination_class`, `termination_signal`,
`terminal_state`, `terminal_enforced` — or, where no record was ever created,
over the dispatch refusal itself:

| what the record says | class | pool |
|---|---|---|
| `termination_class: environment` (credit / rate / auth exhaustion) | `infrastructure` | `implementation.retry` |
| `state: failed_launch` — a record exists and the harness died at boot | `infrastructure` | `implementation.retry` |
| `termination_signal: supervisor-gone` | `infrastructure` | `implementation.retry` |
| the terminal contract could not REACH the graph (`terminal_unreachable`) | `infrastructure` | `implementation.retry` |
| a nonzero exit for no recognized environment reason | `failed` | `implementation.budget.attempts` |
| the idle watchdog stopped it | `cancelled` | `implementation.budget.attempts` |
| the report opens `DECLINED:` | `declined` | neither — triage, never a retry |
| ended its turn cleanly | `completed` | neither — the outcome is what it PRODUCED |
| refused before any run record (unsatisfiable profile, launcher that does not resolve, refused claim, out-of-scope item) | `unroutable` | neither — a refusal is not an attempt |

Two rules bound it. **Ambiguity classifies `failed`, not `infrastructure`** — an
infrastructure reading spends a pool that does not consume the item's attempts,
so a misclassification there loops, while the same misclassification the other
way costs one attempt and stops; only the readings above are infrastructure, and
a signal this client does not recognize is `failed`. And **a refusal is not an
attempt** — anything refused before a run record exists spends neither pool, and
the item cools off and waits for a box (or a config) that can run the profile,
exactly as a satisfiability refusal does today.

So an `infrastructure` reading of a review dispatch **charges no fix cycle,
folds no finding and dispatches no fixer**. The runner asks the SAME gate again
at the SAME cycle after `implementation.retry.backoff_ms`, paid for out of the
**shared infrastructure pool**: `implementation.retry.attempts` is ONE pool per
PIPELINE — implementation, reviews, fixes and rescues together — which is what
keeps the dispatch bound a sum and not a product. The count rides
`gate_progress.pools` (§8), keyed to the attempt, so an outage that outlives a
worker cannot be handed a fresh allowance by every resume, and a charge that
does not land REFUSES the retry it was paying for rather than spending an
unrecorded one. When the pool is spent the gate refuses and the escalation names
the **outage**, not the code — and the rescue lane (§10.10) is never entered: it
diagnoses a defect, and a reviewer whose harness never answered found none.

An `unroutable` reading is off that ladder entirely: waiting buys nothing for a
dispatch this box refused, so it refuses at once, still without charging a fix
cycle. Whichever way it stops, the refusal records WHY it did not ask again —
the pool is spent, the factory declared none, the charge would not land, the
worker was asked to stop — and the escalation says that rather than reporting
every reason as an exhausted budget.

A FIXER's own dispatch is read through the same classifier, and what its class
means depends on what it left behind: a fix whose harness died on the
environment and left HEAD exactly where it was produced nothing to judge, so the
gate stops there instead of re-reviewing an unchanged tree and spending the rest
of its cycles (and then its whole refusal) on the outage; a fix that COMMITTED
before it died did produce work, and that work is judged like any other fix. A
fix REFUSED before any run record existed is `unroutable`, spends neither pool
and — like a review outage — is never handed to the rescue lane.

The same reading is what the loop's own surfaces report: a terminal run whose
class is not `completed` carries `execution_class` on its `spor work --status`
entry (and in `--status --json`), so a box whose runs are all dying on credit
exhaustion does not read as a box whose code keeps failing. It is a READING
only — the pools are spent by the pipeline that owns the dispatch, never by
the loop's bookkeeping.

A factory that declares no `implementation:` block has no pool (cap 0): an
outage there stops immediately instead of being charged to the code — which is
still the fix, since what was burning fix cycles, a rescue and a human
escalation was reading an outage as `changes_requested`. And a reviewer that
RAN and wrote garbage is unchanged: that is still a judgement of the change,
and the fail-closed rule above stands.

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

A worker runs the code it LOADED. A long-running `spor work` keeps executing
the lib/bin it required at startup however far the checkout it was loaded from
moves afterwards — a gate fix that lands on `main` at noon does not reach a
worker started at nine until it is restarted (a worker ran a whole day on code
predating the rescue-pass round-trip that had landed hours earlier). So the
worker says at startup which code it runs — the checkout's commit and branch
when the package root is a SOURCE checkout (its own `package.json` is tracked
from there — git walks up, so an npm install nested under a consumer's
`node_modules/` would otherwise answer with the consumer's commit), the
package version when it is an install — and, once per pass, logs a one-line notice the first time the
watched ref has moved PAST the loaded commit (once per new tip, never once per
pass). "Moved past" is a statement about a ref and its ancestry, never about
HEAD: the worker watches the factory's declared integration `target_ref` when
it resolves in the code checkout (a self-hosting factory lands onto it), else
the branch the code was loaded from, else HEAD only when it was loaded detached
with nothing declared — and it reports a move only when that ref's tip is a
different commit that DESCENDS from the loaded one (`merge-base
--is-ancestor`). A branch switch or bisect checkout in a linked worker
checkout, a rewound branch, or a ref forced to an unrelated history changes
HEAD without anything having landed, and says nothing. Every git read here goes
through the env-scrubbed spawn the rest of the CLI uses, so an ambient
`GIT_DIR`/`GIT_WORK_TREE` cannot make the worker announce or watch another
repository's commits. It never restarts itself: which code a worker runs is
the operator's call; the notice only makes the drift visible in the log rather
than discoverable after a pipeline ran stale.

The operator can make that call once, up front: `--restart-on-land`
(`work.restartOnLand`, `SPOR_WORK_RESTART_ON_LAND=1`; off by default) is for a
self-hosting factory whose worker runs from the very checkout its own pipelines
land onto. The first time the watched ref moves past the loaded code (a
descendant tip — the same test as the notice, so a branch switch or rewind in
the checkout never drains the worker), the worker
stops taking new work and exits cleanly once every run and gate pipeline in
flight has settled — a drain, not a stop, so no pipeline is abandoned for the
restarted worker to re-run from gate 0 — with `stop_reason` naming the tip it
was moved past, and a supervisor (a systemd unit, a shell loop) restarts it on
the new code. The latch never clears: a further move before the drain finishes
is logged like any other but changes nothing. On an npm install there is no
checkout to watch, so the flag says so once at startup and is otherwise inert.

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

**The two parts are one act, in that order.** The rollback is attempted only
once the escalation exists; a rollback on its own is not half a refusal, it is
the worst state on the graph. The item would read `open`, keep its agent-ready
stamp, carry no `blocks` edge, and still carry the resolving edge the run
wrote — fresh-looking agent work with a stale resolver, which no reader can
tell apart from a genuinely open item and which the next worker may pick up.
So when the escalation write fails (the server is down, the write is rejected):
the item's status is left exactly as the run left it, the gate fact records
that the demotion was `not attempted` and why, and the run record carries
`gate_escalation_failed: true` beside its verdict — the marker that says this
refusal exists nowhere but on this box.

The verdict is still **settled**, deliberately. The obvious-looking alternative
— stamp something un-settled so the resume scan (§10.8) re-attempts the
escalation on a later pass — does not work: resumption re-runs the WHOLE
pipeline (the suite, a fresh review dispatch, a fix cycle forced into the run's
own checkout), it re-offers a run on every pass with no cooldown behind it, and
it can only ever see a run its worker's status file still lists. So it would
loop that pipeline for as long as the graph stayed unwritable in exactly the
case it could reach, and would not reach the ordinary case at all. `spor
work --status` says so on the run's line, because until someone (or the
bounded auto-retry below) does, this refusal exists nowhere else.

**A bounded auto-retry re-attempts the WRITE, never the pipeline**
(task-spor-gate-escalation-bounded-auto-retry). The run record also carries
the exact args `deps.escalate` was handed (`gate_escalation_pending`) — every
poll, a gate-armed worker's loop re-attempts ONLY that call, and the `demote`
that follows it, for any of this box's own settled-but-unescalated runs whose
backoff has elapsed (`gate_escalation_retry_count`/`_retry_at`, doubling from
`work.escalationRetryBackoffMs`, default 5m, capped at
`work.escalationRetryMaxBackoffMs`, default 1h). Both writes are idempotent —
`writeGateNode`'s deterministic id skips a matching existing node, and
`gateDemoteItem` reads the item's current status before writing — so a retry
can only ever finish what the first attempt started, never double-file the
escalation or double-demote the item; nothing here re-runs the suite, a
review, or a fix cycle. The same door serves an integration-stage refusal
(§10.9): its payload carries `stage: "integration"` and replays through the
stage's own escalation, so there is one retry machine, not two. Once the
write lands, the refusal's own fact (`art-gate-…`, or `art-merge-…` for the
stage) still reads "no escalation could be filed" — a fact is never
rewritten — so the retry writes a small closing artifact beside it
(`art-gate-retry-…`, idempotent by run and gate) that `relates-to` the fact,
the escalation and the item, and resolves nothing: the escalation it names is
still a person's open item. That artifact is a prose correction, not a debt —
it is written after the run record is stamped landed and a failed write is
only logged, since a flag that held the retry pending on it would, on a
persistent artifact failure, spend the budget and then give up claiming the
escalation never landed. After `work.escalationRetryMaxAttempts` attempts
(default 5) it gives up loudly — one log line, `gate_escalation_retry_exhausted:
true` on the record — and the door back is the one below, `spor work --regate
<run-id>`, exactly as if the auto-retry had never run.

The recorded manual door is `spor work --regate <run-id>` (below): it judges
the RUN record, which a failed escalation leaves untouched, so the whole
pipeline — escalation included — can be re-run by hand once the graph is
writable, or once the auto-retry above has given up (a factory whose gate was
renamed or removed since the refusal, say — the auto-retry cannot replay a
gate it can no longer find, and gives up rather than waiting on one that will
never reappear on its own).

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
carries no claim of completion, and one that already passed or parked. Only a
re-gate may move a settled `gate_state` on the run record — every other
writer (the loop, a resumed pipeline, a duplicate adopter) still cannot. The
auto-retry above is not an exception: it never touches `gate_state` itself,
only the escalation/demotion fields beside a verdict that stays exactly what
it was.

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
  (`passed`/`failed`/`blocked`, or `superseded` — see below) when it reports. A settled verdict is FINAL for
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

**An adopted pipeline first asks whether the work was already landed by hand.**
An orphan can sit un-judged for hours, and in that window a person may have
merged its branch onto the trusted ref and removed its worktree (an
orchestrator's ordinary close-out). Re-gating that is worse than wasted spend:
the acceptance gate refuses on the missing directory, the rescue cannot dispatch
into it, and the pipeline escalates and DEMOTES an item that is done and on the
trusted ref (issue-spor-work-adopts-orphaned-pipeline-of-hand-landed-run). So
before any gate runs on a resumed pipeline — or on any pipeline whose run
checkout is gone — the runner reads two facts, and BOTH must hold: the graph
says the item is resolved (the same verify leg the harvest uses), and git says
the run's head is contained in `trusted_ref` (read from the checkout, or, when
it is gone, from the branch the dispatch worktree was cut on — `git worktree
remove` leaves it standing). Then the pipeline settles **`superseded`**: a
settled `gate_state` (never re-offered, `--regate` has nothing to re-judge),
no gate fact, no escalation, no demotion, no cooldown. Every doubt falls
CLOSED to the ordinary judgement — an unreachable graph, a deleted branch, a
head not yet on the ref — and a run whose checkout is gone but whose item is
NOT landed refuses its first gate as before, except that the rescue lane is
skipped (a rescue works in the run's own tree, and there is none) and the
escalation says so. The accepted residual: a resumed run that resolved its
item without committing anything has a head trivially contained in the
trusted ref and reads as superseded; a pipeline the worker starts off its own
harvest is never checked, so that reading never hides a fresh no-work claim.

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
- **`reruns`** (default 0, at most 3) — the same bounded same-tree rerun a
  command gate has (§10.3): the candidate suite runs again on the ONE
  candidate worktree (never rebuilt) before a failure becomes a fix cycle,
  a rerun-rescued pass lands — or, in `propose` mode, opens its PR — with
  the first failure's evidence on its `art-merge-*` fact beside the PR url,
  and a suite that fails every run is charged one failure whose outcome
  says how many runs it failed.

**The run holds its slot through integration.** The runner folds the
integration stage into the SAME promise `deps.gate` already returns (§10.2), so
every mechanic §10.2-§10.8 already describes — slot-holding, candidate
exclusion, cooldown on a refusal, resumption of an abandoned pipeline — applies
to integration with no separate machinery and no separate code path in the
loop itself. A factory with gates but no integration block is byte-identical
to what shipped before this stage existed.

**The candidate build.** A throwaway worktree at `merge(target_ref, <what is
being integrated>)` per the declared strategy — `merge` lands it onto the
target, `rebase` replays its own commits onto the target, `squash` folds it
into one commit on top. **A merge conflict is a fix-cycle event, not a
terminal error** — it is fed back to the same implementer, through the same
cycle-cap-then-escalate machinery §10.3's protected-path lane and §10.4's
review loop already use, because "the branch needs a rebase" is exactly the
kind of thing the implementer's own context is best placed to fix.

**What is integrated is the PINNED CANDIDATE, not the branch head.** Under a
declared implementation stage (§10.13) the judged object is the candidate —
content-addressed on its tree, published under its pinned commit, and named by
every `art-gate-…` fact that passed it — so the candidate worktree is built at
`merge(target_ref, impl_candidate.commit)`. A branch that moved on after the
pin therefore lands nothing extra: the commits on top of the pin were never
judged, and integration is not the place they first become someone's. **A
factory with no implementation stage pins nothing, so its build is
`merge(target_ref, branch)` exactly as it always was** — byte-identical, along
with a pipeline whose fail-soft pins never landed a candidate at all.

The stage checks, before every build, that the branch it is standing on still
carries the pinned candidate:

- a branch that merely **advanced** past the pin is fine — the pinned commit is
  still contained, and it is what lands;
- a head that is a **same-tree relabel** of the pinned commit (an amend, a
  re-commit of the same files) is fine too, and deliberately: first-published-
  wins means the *published* commit is what lands, and its tree is the head's;
- anything else — a rebase, a reset, a rewrite onto different content, a pinned
  commit that no longer resolves to its pinned tree, or a reading git could not
  make at all — is a **`mismatch`**: refused before a lease is taken or a
  worktree is cut, with **no fix cycle and no budget spent on it**, and
  escalated to a person naming the candidate, both shas and the locator its
  reference publishes. It is a settled verdict, not a retry: the evidence is
  what is wrong, not the code, so re-offering the run would only re-refuse it.
  The door back is a person, or `spor work --regate <run>` once the branch (or
  the pin) is put right.

In `propose` mode the bar is higher, because what lands there is the **branch**
— the PR is opened from the branch head, not from a tree this stage builds — so
a head that merely *contains* the candidate is a `mismatch` too: it would put
unjudged commits into the merge.

**Only this stage's own fix cycles re-pin.** An integration fix cycle commits in
the implementer's checkout, so the per-cycle tree refresh re-pins the candidate
(stage `integration-fix`, §10.12) and the rebuild merges the commit that re-pin
named. A re-pin that could not be made leaves no tip, and the refreshed head is
integrated instead — never the pre-fix candidate, which would silently drop the
very commit the fix cycle was run to produce. A lost landing race is not a
re-pin: the rebuild is against the ref's new tip with the same candidate.

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
integration-runner.js). Belt-and-braces, same rationale as §10.3's own step 4:
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
disputes is whether the change ever reached the target ref. The two are one
act in that order here too: the rollback runs only once the escalation
exists. An escalation write that fails leaves the item's status exactly as
the run left it, the `art-merge-…` fact records `Demotion: not attempted`
and why, and the run record carries `gate_escalation_failed: true` beside
the settled verdict — the same marker, and the same doors back, as a gate
refusal: the bounded auto-retry (§10.7) reads the `gate_escalation_pending`
payload this refusal leaves too (`stage: "integration"`, replayed through the
stage's own escalation, closed over the `art-merge-…` fact by the same
`art-gate-retry-…` artifact), and `spor work --regate <run-id>` — which
re-runs the gates AND this stage off the run record — once it gives up.

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
one) — never the in-process poll. The pair is atomic in that order for a park
as well: with no tracking item on the graph the rollback is withheld and the
`proposed` fact says so, and it is the per-pass proposal check (below) that
completes it — the moment it heals the missing tracking item from the run
record's `gate_proposal_*` stamps, the blocker exists, so the demotion runs
then. Nothing is marked for a person: the heal is the retry. The same pass is
also the retry for a demotion that FAILED beside a tracker that did file (a
transient write error, at park time or during the heal itself): the run record
carries `gate_demote_pending: true` until the rollback lands, and every
proposal check re-attempts it on that flag — otherwise the next pass would find
the tracker present, heal nothing, and leave the item at its completion status
for as long as the proposal stayed open. The retry runs only while the tracker
is still OPEN: a pass reads the tracker's own status first, and a tracker that
is already terminal (closed by the merged PR's restore, or by a person) means
the proposal is settled and the debt is simply cleared — re-demoting there
would roll the completed item back to `open` behind a blocker no longer live,
and nothing would ever restore it. That read is not atomic with the demotion
(a status write has no compare-and-swap), so a rollback that actually flipped
the item re-reads the settled evidence afterwards — the tracker terminal, or
the landed fact (which a settling pass writes before it promotes and closes)
present — and one that landed against a proposal settled meanwhile is undone
on the spot by the same promotion the landing restore uses; an undo that fails
is owed on the run record as `gate_restore_pending: true` and retried by every
later pass. The flags themselves are best-effort writes, so a pass records a
demotion's whole outcome in ONE stamp (never "clear the demotion, then owe
the undo" as two — a second write that fails, or a crash between them, would
leave the item open behind a closed tracker with no debt on the record), a
stamp that fails is logged and leaves the previous debt standing, and a
`gate_demote_pending` still set against a tracker that is already terminal is
read as "the rollback MAY have landed": when the proposal's landed fact is on
the graph the item is restored first and the flag cleared only once that
holds; with no landed fact (a tracker a person closed) the flag is simply
cleared, as above. And because a demotion AND its flag can both fail in one
pass (the record's directory unwritable at that moment) — leaving the next
pass a present tracker and no flag, i.e. nothing to retry — the record is
not the debt's only ledger: when neither the heal nor the flag says a
rollback is owed, the pass re-derives it from the graph, where it is always
legible — an open tracker whose proposal has no landed fact, beside an item
still at its completion status, is a withheld rollback whatever the record
says, and it is demoted through the same path a flagged retry takes. The
probe is one read in the ordinary case (the item already `open`), needs no
flag of its own (it runs again next pass), and skips a proposal whose landed
fact exists, since a tracker whose close failed sits open beside a
legitimately completed item. That landed-fact read licenses a rollback only
on a CONFIRMED absence (a 404, or ENOENT in local mode) — a server error,
timeout or unreadable file is "unknown", not "absent", and unknown never
demotes: the probe waits for the next pass. The pipeline returns a THIRD settled state,
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

### 10.10 The rescue lane — a strong-model step before any human escalation

The first two days of live factory runs deferred agent-resolvable work to a
person (task-spor-factory-robustness-program): a review that would not
converge, a suite red for a reason the item never touched, a fixer patching
around a defect it never understood. Every one of those refusals reached
§10.7's escalation with nothing between the spent fix cycles and the page. The
**rescue lane** (task-spor-factory-rescue-lane) is that something. It is
OPTIONAL and FACTORY-level — one lane covers every gate's exhaustion, never a
per-gate block — declared beside `gates` and `integration`:

```json
"rescue": {"profile": "profile-claude-fable", "attempts": 1, "await_ms": 3600000, "instructions": "…"}
```

- **`profile`** (required) — the profile the rescue dispatches under; a strong
  model by intent. Profile-routed ONLY, like an agent-review gate: the graph
  names the lane and the machine's own binding decides what runs. The
  diagnosis is read off the run's final report, which a worker's dispatches
  always have (they run supervised regardless of `dispatch.claudeLaunchMode`).
- **`attempts`** (default 1, at most 3) — rescue attempts per pipeline. A second
  attempt is handed the first's diagnosis and asked why it did not land.
- **`await_ms`** (default 1h) — how long the runner follows the rescue run.
- **`instructions`** — optional factory-specific guidance added to the prompt.

**When it runs:** when a pipeline would otherwise ESCALATE — a gate has spent
its fix cycles, or refused unretried for a reason that is not already a
person's item. Not every refusal is rescuable: a protected-path hit already
filed its test-change lane item (§10.3), a rejected approval is the person's own
answer and a BLOCKED one is waiting on it (§10.5) — those go on exactly as
before. A `declined` run is never gated at all (§10.2), so it is never rescued:
a stale premise is triage's, not the lane's. Nor is an **empty-diff** refusal
(§10.3 item 2, §10.4), from either gate kind: a rescue works in the run's own
tree on a change a gate refused, and an empty diff gives it no change to work
on — no rescue can turn that refusal into a pass short of authoring the whole
item, which is an implementer's job, not a fix. Both live empty-diff rescues
before this spent a strong-model dispatch re-deriving by hand what the graph
already recorded; the deterministic routes that read that evidence (§10.11 and
its stale-premise sibling) now run before any gate, so a diff that is still
empty at a gate escalates straight to a person, who verifies the graph write.

**What the runner does**, in code (lib/shell/gate-runner.js), in order:

1. Writes the refused gate's `art-gate-*` fact FIRST — verdict `failed`, no
   escalation, a `Rescue: attempt n of N … follows this refusal` line — so the
   rescue can link what it files to the fact that refused it.
2. Dispatches the rescue under `rescue.profile`, into the run's OWN checkout
   (`--no-worktree --force`, like a fix cycle; NOT read-only — the rescue
   writes). A rescue is an IMPLEMENTER, so unlike a review it keeps the
   worker's unattended POSTURE — `--permission-mode` / `--sandbox` /
   `--approval-policy`, without which a claude-code rescue stalls on its first
   write prompt on an unattended box — filtered to what the lane's own harness
   accepts: Claude Code takes the permission mode, Codex takes it too (its
   adapter translates `bypassPermissions` into `--sandbox danger-full-access
   --approval-policy never`, exactly as it does for a fix cycle), and
   OpenCode/Copilot take neither because they are unattended by default. A
   flag the lane's harness cannot read is never simply dropped: it is
   **translated by meaning**. The adapters that own the worker's flags read
   the whole posture as one of `read-only` / `attended` / `unattended`
   (`postureMeaning` in lib/shell/dispatch-harnesses.js — Claude Code's
   `plan` / other / `bypassPermissions`, Codex's `--sandbox read-only` / an
   approval policy other than `never` / the rest; the most restrictive reading
   wins across a mixed posture), and the runner re-expresses that reading in
   the lane harness's own declarations: read-only becomes the lane's
   `--read-only` posture (Codex's read-only sandbox, Claude Code's plan mode)
   and displaces every posture flag — a rescue can then diagnose but not fix,
   which is the point: a worker deliberately held to `--sandbox read-only`
   never gets a `bypassPermissions` rescue; unattended fills in the lane
   harness's declared unattended posture (`adapter.unattended`, beside
   `readOnly`; empty for every harness that needs no flag, `--permission-mode
   bypassPermissions` for Claude Code); attended first DISPLACES every
   surviving posture flag (a bypass that rode beside a foreign approval
   policy gating on prompts must not be left standing) and then fills in the
   lane harness's declared attended posture (`adapter.attended`: empty on
   claude-code, where every mode but plan/bypass asks, so the rescue runs
   attended and stalls on its first write; `--approval-policy on-request` on
   Codex, whose argv otherwise defaults to never asking) — and where the lane
   declares NO attended posture (OpenCode/Copilot, whose `--auto` /
   `--allow-all` cannot be unsaid) it narrows to the lane's `--read-only`,
   the next reading DOWN, never up to that harness's unattended default. In
   every case the more restrictive posture, said out loud rather than widened.
   Only an EMPTY posture — a worker on a harness that needs no posture flag at
   all — takes the lane's unattended posture without a reading, because
   otherwise a claude-code rescue launches attended and stalls exactly as the
   un-postured dispatch did. Every drop, translation and substitution is
   warned about, since it changes what an unattended agent may do. Since
   §3.1, the worker preflight also judges this dispatch's write posture — but
   a translation that lands on ATTENDED does not trip it: the runner has
   already read the worker's foreign posture, translated it BY MEANING, and
   deliberately chosen not to widen it, so it hands preflight that
   acknowledgement (never a general `--force` — an ordinary worker with no
   posture at all still refuses) and the dispatch proceeds under the warned
   posture instead of being hard-refused before it ever runs
   (issue-spor-rescue-posture-attended-translation-hard-refuses). It may still
   stall on its first write and be discovered only by the idle ceiling — the
   same risk a pre-preflight rescue always ran — but a hard refusal here would
   have thrown the rescue away outright, where a stall at least leaves the
   diagnosis file and whatever the rescue committed before the stall. Only the
   narrowed-to-read-only reading needs no such acknowledgement: it already
   proceeds on its own, since a read-only run was never judged for write
   posture in the first place.
   What never rides is the worker's ROUTING — `--model` and `--agent` — because the
   lane's profile is what names the strong model, and a worker's `--model`
   would override it.
   The prompt the runner composes carries: the work item, the diff, EVERY commit on the branch
   (the implementer's and each fix cycle's), the refused gate's detail and
   evidence, the cycle history, the whole finding ledger, the gate facts on the
   graph, and any earlier rescue's diagnosis. It is asked to (1) **diagnose**
   in one of four categories — `reviewer-drift`, `real-defect`,
   `stale-premise`, `environment`; (2) **fix** in that checkout and commit,
   naming the finding ids it addressed, or change nothing it cannot justify;
   (3) **file** at least one Spor task proposing the factory / gate / prompt /
   item change that would have prevented the pattern, `derived-from` the gate
   fact — the input `/spor:factory`'s maintenance mode reads. It is told, and
   it is true, that it never marks a gate passed. The fenced diagnosis block
   is MANDATORY and asked for EARLY — the moment the diagnosis exists, before
   any fix or long verification, restated at the end once `fixed`/`filed` are
   known (the parser takes the LAST block) — so a session cut short still
   yields a category. It is also told to write that same object to a named
   DIAGNOSIS FILE in its own checkout (`.spor-rescue/<run name>.json`,
   git-excluded through the repo's `info/exclude` before the launch, so it
   is neither tracked nor untracked-visible and can never be committed) the
   moment it has diagnosed — the channel that does not depend on what the
   harness's stream looks like; and the prompt ends with the one-turn notice (§4):
   verify in the foreground, never background a suite and end the turn
   waiting on it, an uncommitted tree is a refusal.
3. Reads the rescue's final report in code (`parseRescueReport`,
   lib/kernel/gates.js): the fenced `{"diagnosis", "category", "fixed",
   "filed"}` block. The supervisor keeps only the LAST assistant text as the
   report, so a block emitted early and then overwritten by a final "I'll
   commit once the suite notifies me" is only on the run log; when the report
   carries no block, the read falls back to the last block of any EARLIER
   message on that log (`runReportTexts`, through the harness adapter's own
   report hook — or, on a harness that writes its report file itself and so
   declares no report hook, its read-only `messageFromEvent`: Codex's
   `agent_message` items; a DECLARED harness's declaration rides the run
   record — the supervisor stamps it there before it deletes the job file, so
   a finished run's log is still readable), newest first, and logs that it
   did. Between the report and the stream sits the diagnosis FILE the rescue
   was told to write: the stream read can only cover a harness whose events
   carry a text path the client knows, and a declared harness that writes its
   own report (`report: file`) describes no message shape at all, so its
   stream is unreadable by construction — the file is what closes that row,
   since whatever the harness or its sandbox, an implementer can write into
   its workspace. The order is the final report's last block, then the file,
   then the stream (`gateRescueDiagnosis`, bin/spor.js), each logged when it
   is the one that answered — so the truncated session the early block exists
   for still yields its category whichever harness the rescue profile names. This read
   is deliberately FAIL-SOFT, unlike a review
   verdict: it feeds only the escalation body and the rescue fact, so a rescue
   that fixed the tree and forgot the block still gets its fix judged. A rescue
   that could not be dispatched, or never reached a terminal state inside
   `await_ms`, is recorded as unrun and the refusal it was handed escalates
   exactly as it would have without a lane — the escalation says so.
4. Writes the rescue's own fact, `art-rescue-<stem>-<run>-x<n>-<hash>`: the
   diagnosis and category, whether it committed a fix, what it filed —
   `relates-to` the item, the refused gate's fact and each filed task, never
   `resolves` (WORKERS.md §10.6's rule holds: a record, not a retirement).
5. Re-reads the change and re-runs the **whole gate list as a rescue pass**:
   every gate, from the first, on the tree the rescue left — after the same
   one commit-or-discard round-trip a dirty implementer tree gets (§10.3),
   keyed to the rescue pass, so a rescue that committed nothing but left the
   fix in the tree is not refused unretried on the tree that carries it. Each gate gets a
   FRESH fix-cycle budget (its declared `cycles`, counted from the rescue), but
   the finding ledger is CARRIED and the cycle index CONTINUES — so the review
   after the rescue is a fix-cycle review under §10.4's stateful protocol:
   handed the same prior findings by the same ids, required to clear or
   confirm each, and bound by the introduced-by-fix floor for anything new. A
   rescue must not itself restart the drift it exists to cure. Everything a
   rescue pass writes — facts, a lane item, an approval item, the escalation,
   its progress — is keyed one segment deeper (`-x<n>` in the readable id,
   `#x<n>` in the hash input, `<gate>#x<n>` in `gate_progress`), so it never
   collides with, or silently adopts, the original pass's node.
6. If the rescue pass passes, the item **stands**: nothing is escalated,
   nothing demoted, and the integration stage (§10.9) follows as usual. If it
   refuses and attempts remain, the next rescue is handed everything above plus
   the earlier diagnoses. Otherwise the escalation fires (§10.7, demotion and
   all) — and its body **opens with the rescue's diagnosis**: the category, the
   sentence, the rescue's run, whether it committed a fix, what it filed. The
   person reads what a strong model already concluded before deciding.

Durable like the rest (§10.8): the rescue's state — the refusal it was handed,
the per-gate seed its pass starts from, its run id and its diagnosis — rides on
the run record's `gate_progress` beside the gates' own entries, saved BEFORE
the dispatch and again at launch (`gate_rescue_run_id` / `gate_rescue_attempt`
are stamped the moment the run exists), so a killed worker resumes INSIDE the
rescue — adopting the launched run by its unique name (`rescue-<run>-<n>`), or
re-judging its pass — and never re-runs the original pass to page the person
the rescue was about to spare. The run record and `spor work --status` carry
`gate_rescues`, the number of attempts the pipeline made.

A factory without a `rescue:` block behaves byte-identically to before the
lane existed. See test/gate-pipeline.test.js ("the rescue lane") and
test/gates.test.js.

### 10.11 No-code outcomes — a scoping result the pipeline routes, not refuses

A run that reads the ground and finds its item's premise stale legitimately
ends with an **empty diff**. The first live case (2026-09-02,
`task-spor-queue-api-offset-paging`, run `0b1b5dd2`) did exactly the work the
item needed: it found the server half already shipped, recorded that as an
artifact, re-stamped the task to the client repo with the remainder as its
scope, and committed nothing. The review gate cannot tell that from a run that
did nothing, so it failed closed on the empty diff (§10.4,
issue-spor-review-gate-empty-diff-vacuous-pass) and paged a person, who agreed
with the run (art-res-gate-escalation-offset-paging-scoping-accepted). That
refusal was right in the absence of any other signal. What was missing was the
signal.

So a run may **declare** a no-code outcome, and the runner **checks** the
declaration against the graph — never takes it
(dec-spor-gates-enforced-in-code-factory-is-data). The declaration has two
halves and needs both:

- **A node**, an `artifact`, carrying `outcome: rescoped | premise-stale |
  duplicate` in its frontmatter, a `resolves`/`relates-to`/`answers`/
  `derived-from` edge to the work item, and — for `premise-stale` and
  `duplicate` — a `derived-from`/`supersedes` edge to the node that makes the
  item stale. This is the durable half a person reads later.
- **The fixed line** the worker contract prescribes, FIRST in the run's final
  message: `SCOPED: <outcome> <the node id> — <one-line reason>`. This is what
  binds the claim to THIS RUN. A node alone could not: a scoping artifact an
  earlier run left on the item would then launder a later run that did nothing
  into the same route. It is also the only way to FIND the node in remote mode
  — `GET /v1/nodes/{id}` carries `resolution` and `superseded_by`, never a
  general inbound-edge list, so the runner cannot go looking for a declaring
  node it was not handed.

`SCOPED:` and `DECLINED:` (§6) are mutually exclusive by construction (one
first line) and by meaning. A decline says *the item is wrong*: nothing was
done, nothing is claimed, and its route is triage. A scoping result says *the
item's real work is done and it was a graph write*: it claims completion, and
it has to show for it.

**What the runner verifies**, before any gate runs and before the dirty-tree
round-trip (`verifyNoCodeOutcome` in `lib/kernel/gates.js`, routed by
`gate-runner.js`):

1. the change under judgement read cleanly and is **empty** — no committed
   diff against the trusted ref, and no uncommitted changes to tracked files
   (a dirty tree fails the read, so it never reaches here);
2. the run's final report carries the fixed line, and its outcome word is one
   of the three;
3. the node it names is readable, declares the **same** `outcome:`, and
   carries an edge to the work item;
4. the item **moved**. For `rescoped` that means one thing only: its `repo:`
   now differs from the repo this pipeline claimed it under — the re-stamp the
   worker contract asks for. `premise-stale` and `duplicate` may show that or a
   **supersession asserted by some other node** (the item's `superseded_by`,
   which the server reports and the local graph indexes);
5. and for `premise-stale`/`duplicate`, the node **names what it found** — a
   `derived-from`/`supersedes` edge to a node that is neither the item nor the
   resolver, and that **exists on the graph**: a dangling edge is a shape the
   graph accepts by design, so its presence demonstrates nothing.

Check 4 asks for a write that is **not free** — one a run that did nothing has
no reason to make, and that is not a side effect of being gated. Two things are
deliberately excluded for being exactly that:

- **"the item reads resolved."** A live resolving edge is the *precondition for
  being gated at all* (§10.2), so a run that did nothing but write its resolver
  already has one. Counting it would let a single extra frontmatter key route
  exactly the "resolved with nothing behind it" run the empty-diff refusal names
  in its own text.
- **a supersession asserted by the declaring node itself.** The resolver is the
  one node the run certainly authored, so `art-x supersedes task-a` is one more
  self-write — and locally it is the *same fact*, since the graph's
  `supersededBy` index is fed by any node's own `supersedes` edge.

The re-stamp branch is run-relative on top of that: it cannot be satisfied
twice, because the next pipeline claims the item under the repo the first one
moved it to. That "claimed under" value is the repo stamp **the item itself**
carried at dispatch — carried on the worker's slot, and on the run record as
`item_repo` so `spor work --regate` compares against the same thing rather than
against the item's own current stamp (or against a `--slug` launch target it
never had).

**What this check is, and is not.** It is a *conformance* check, not an
anti-forgery one, and it cannot be otherwise: an agent has write access to the
graph, so every fact above is ultimately a write it could make. What the checks
buy is that none of them is free and none rides along on being gated — each is a
deliberate, consequential, auditable write that a run which did nothing has no
reason to make, and every one is named in the `art-gate-scoping-…` fact. A
determined agent authoring a second node purely to satisfy check 4 is the
accepted residual; the point is that an empty diff now carries a *signal*, where
before it carried none and a correct scoping was indistinguishable from a run
that did nothing. Read the `scoped` facts the way you read any other gate
telemetry — a rising count is a queue signal worth looking at, not a verdict
nobody ever has to check.

**If it checks out**, the pipeline settles **`scoped`**: an idempotent
`art-gate-scoping-…` fact is recorded with verdict `scoped` (`relates-to` the
item, like every gate fact — a gate records, it does not retire; `scoping` is a
**reserved** gate id, and a factory declaring a gate of that name refuses to
parse rather than minting a colliding fact), **no code gate runs**, **no integration stage runs** (`runGateAndIntegration` follows a
`passed` state only), no escalation is filed and nothing is demoted. The item
is left exactly where the scoping put it: open under the repo that now owns it,
or retired. The verdict is deliberately **not** `passed` — no gate ran and
nothing was reviewed, and the telemetry has to be able to tell the two apart.
It IS settled (`SETTLED_GATE_STATES`), so it is final for the run: a later
worker never re-offers it, and `spor work --regate` refuses a run that already
read `scoped`, like a pass. The other direction is open — a run REFUSED on its
empty diff can be re-gated once the graph says what it should have said, and a
re-judgement that settles `scoped` closes the escalation exactly as a pass does
(§10.7). It does **not** restore a completion status the refusal rolled back:
the claim it just verified is that the item is where the scoping put it —
re-stamped and still open, or superseded — so promoting it back to `done` would
mark work complete that the verified outcome says is outstanding. The
`art-regate-…` node it writes says a scoping result, not "passed every gate",
because none ran.

Unlike `superseded` (§10.8), a `scoped` item **cools off** for
`work.retryAfterMs`: it may still be open under its new repo, and this worker
has just spent a run establishing there is nothing here to do, so it walks on
down the queue rather than re-dispatching what it has just scoped.

**If it does not check out** — no node, the wrong `outcome:`, no edge to the
item, an item that did not move — the pipeline falls straight through to the
empty-diff refusal it would have got anyway, and that refusal now carries the
run's own account plus the check that broke it, so the escalation says why. A
declaration can therefore only ever REMOVE a wrong escalation; it can never
manufacture a pass.

Telemetry: `spor work --status` and the loop's closing summary count `scoped`
alongside `passed`/`failed`/`blocked`, and the facts are
`spor query --type artifact --id-prefix art-gate-scoping- --summary`.

A run that declares nothing behaves byte-identically to before this route
existed. See test/gate-pipeline.test.js ("no-code outcomes") and
test/gates.test.js.

#### Stale premise — the same route, no declaration needed

`scoped` above needs a run to *declare* the outcome, because the claim is
about what the run itself found. A different case needs no declaration at
all: an item's own `commits:` stamps are **already landed on the trusted
ref before the run was ever dispatched** — typically because a different
task's fix happened to touch the same code. The first live case
(2026-09-05, `issue-spor-codex-handshake-stub-reads-job-after-abandon-
unlink`, run `b000ee69`): the issue's `commits:` named spor `0efea66`,
which had already landed on main as part of
`task-spor-queue-api-offset-paging`'s own fix — a sibling task's commit
happened to also resolve this issue's problem. The branch this run cut
for the issue therefore carried nothing to add, and the run made no claim
about it because there was nothing for it to find: the review gate failed
closed on the empty diff (correctly, absent a signal) and the rescue lane
had to re-derive by hand what the graph already recorded before the
dispatch ever happened.

There is nothing to declare here because the evidence **predates the
run**: it either checks out or it doesn't, and there is nothing for a run
to launder by asserting it. So the runner checks it automatically, before
the declared `SCOPED:` claim above (`verifyStalePremise` in
`lib/kernel/gates.js`, the git half `gateCommitsLanded` in
`lib/shell/gate-runner.js`):

1. the change under judgement is empty, exactly as above;
2. the item's own `commits:` stamps **as claimed** — `item_commits` on the
   run record, a snapshot taken at launch, never a live re-read of the
   item's current `commits:` (that is an ordinary editable field, and a run
   with graph-write access could otherwise append its own already-landed
   sha to its own item mid-run and manufacture the very "predates the run"
   evidence this check exists to require — the same hazard `item_repo`
   already avoids for the declared route's re-stamp check) — filtered to
   the ones this checkout can even verify (a stamp for a sibling repo is
   silently excluded, never counted either way) — are **non-empty**: an
   item with no stamps has made no claim that something already covered
   it, so a vacuously "nothing to check" reading never routes as a stale
   premise;
3. and every one of those stamps is an **ancestor of the trusted ref**
   (`git merge-base --is-ancestor`, read from the run's own checkout with
   the same gone-checkout-falls-back-to-the-dispatch-worktree's-branch
   handling `gateHeadLanded` (§10.8) uses).

If it checks out, the pipeline settles **`scoped`** exactly as the declared
route does — same reserved `scoping` gate id, same `art-gate-scoping-…`
fact shape, same non-completion semantics (the item is left open; a person
still decides whether to write a real resolver), same cooldown. The
outcome label is `already-landed` rather than one of the three declared
words, since nothing declared it. If any part of the check fails —
unreadable evidence, no verifiable stamps, a stamp that is not an
ancestor — the pipeline falls straight through to the declared-claim check
above and, from there, to the ordinary empty-diff refusal: this can only
ever remove a wrong escalation, never manufacture a pass.

A run whose item carries no `commits:` at all — the overwhelming case — is
unaffected: `deps.commitsLanded` still runs (a few git probes against
`item_commits`, no new graph read) but finds nothing to check, and the
declared-claim check and the refusal below it are exactly as before. See
test/gate-pipeline.test.js ("stale premise").

### 10.12 The candidate — what a pipeline is judging, pinned

A `type: factory` may declare an `implementation:` stage beside its
`integration:` block (`dec-spor-factory-implementation-stage-contract`); its
keys, and which of them the shipped runner acts on, are §10.14. A
factory that declares none is unaffected by everything below: nothing is
pinned, no `impl_*` field is written, and the pipeline is byte-identical to
before the stage existed.

Where one is declared, the pipeline pins a **candidate** for the tree it is
judging — a pinned commit plus the tree it resolves to, plus provenance, plus a
reference something other than this process can follow. It is never an agent's
claim of resolution: the point of the stage is that the implementer submits one
of these and the *runner* writes the resolving edge at the declared completion
boundary, so a pending or refused pipeline releases nothing.

**Identity is the tree, not the commit.** `candidate_id` is `cand-` plus the
first 16 hex of `sha256(repo, node_id, tree)` — nothing else goes into the key.
An amend that changes only the message, a retry that re-commits the same files,
and a rebase that happens to reproduce the same tree all yield the *same*
candidate; a rebase onto a moved trusted ref changes the tree and is correctly a
*new* one, because the merged-in base is content the gates have not judged.

**A candidate is superseded, never mutated.** HEAD moves after submission — a
fix cycle commits, a rescue amends — so the pipeline **re-pins at exactly the
point it already re-reads the tree** (`readChanged`, after every fix cycle and
after every rescue pass). The fold is the whole rule:

- the same tree is the same candidate: the new commit is a relabel and is
  appended to `commits_seen`; **nothing else changes** — not `commit`, not
  `reference`, not the published object. This is what lets a published object be
  keyed by `candidate_id` *and* be immutable;
- a different tree is a new candidate carrying `supersedes: <prior id>`,
  appended to the chain.

The run record carries the tip as `impl_candidate` and the chain as
`impl_candidates` (§8) — an ordered list of pin events whose LAST entry is
always the tip. A tree that comes back after being superseded is appended
again rather than folded onto its ancestor: folding would destroy the record of
who first produced it, move the tip off the end, and leave two entries naming
each other in `supersedes` so a reader walking back to the first submission
never terminated. So the same `candidate_id` may appear twice, and a consumer
must read the chain as a list, not as a map keyed by id.

A re-pin never touches `impl_state`: the stage settled at the first candidate,
and a moved HEAD is not a new verdict.

**Pinning is fail-soft — except for the one thing it exists to guarantee.** A
tree that could not be read is logged and the pipeline judges the tree
regardless for every RE-pin (a fix cycle, a rescue pass): the candidate is a
record *of* what was judged, never a precondition for judging it. The
SUBMISSION pin is the one exception (issue-spor-gate-start-not-conditional-on-
candidate-submitted): submission is not complete until the reference verified
(§10.14's `candidate.publish`), so gate 0 never starts on a candidate that
could not be pinned at all, or whose publish never verified — a candidate no
reader could obtain is not a candidate. That check runs once, right where the
gate list would otherwise begin, and is refused the same way any other gate
failure is: an escalation `blocks` the item and its completion status is
rolled back (§10.7), under the reserved gate id `candidate`. A factory
declaring no `implementation:` block pins nothing and never reaches this
check, so it is byte-identical to before the check existed.

`spor runs` prints the stage line and the tip candidate (with the chain length
when it was re-pinned); `spor work --status` prints the tip beside the slot that
is gating it, read off the run record — `journal/work/*.work.json` deliberately
does not change shape for this stage. See `lib/kernel/candidate.js`,
`pinCandidate` in `lib/shell/gate-runner.js`, and test/candidate.test.js.

### 10.13 Controller completion — the resolving edge written at a declared boundary

Under the shipped `by: agent` contract the gate necessarily runs AFTER the run
wrote its resolver, and queue liveness is derived from the resolving EDGE — so
every dependent of the item is released by a claim no gate has judged yet, and
stays released if the gates then refuse; §10.7's demotion exists to paper over
exactly that. A factory that declares an `implementation:` stage (or
`completion: {by: controller}` alone — FACTORY-IMPLEMENTATION-STAGE.md §2.4
E10) moves the completion off the implementer and onto the runner
(dec-spor-factory-implementation-stage-contract; task-spor-factory-controller-
completion-boundary). Nothing below runs for a factory declaring neither key:
its prompt, its records and its pipeline are byte-identical to before.

**The implementer submits a candidate; the controller completes.** The worker
contract's step 5 becomes a SUBMISSION (lib/shell/worker-contract.js): commit on
the launched branch, leave the tree clean, write the resolver node with a
`relates-to` edge — NOT `resolves` — never flip the status, and open the final
report with the fixed form `CANDIDATE: <resolver node id> — <why>` (read back by
`parseCandidateReport` so the completion record can link the implementer's own
account; a missing line is not a refusal, only an unlinked why). Under a
declared `implementation:` block, step 3 lists only the `author_checks` gates and
NAMES the suites the factory runs from the trusted ref after the run — a prompt
that merely omitted them invites an agent to run them anyway. The run therefore
ends as an ENFORCED `reported` (the graph answers "not resolved"), and §10.2's
third case gates it.

**The execution hold.** Before any dispatch the worker stamps the ITEM with
`execution: <execution_id>` (+ `execution_at:`) by compare-and-swap — H1
(`claimExecutionHold` in bin/spor.js, `stampHold` in lib/shell/completion.js):
`put_node` with the item's `revision` remotely, a blob-sha compare under the
machine-local integration lease locally, temp-file-plus-rename. It refuses (no
hold, no launch, the loop cools the item) when the item already carries a LIVE
resolving edge (not gateable), or a hold of a DIFFERENT execution — two
executions never hold one item, and a foreign hold is taken over only by a
same-factory resume (the record pins the id) or a person's explicit `spor
release <id> --execution <exec>`, never by a fresh claim. A dispatch refused
after the hold landed but before any run record (an unsatisfiable profile, a
launcher that does not resolve) clears the hold through the same door. The
claim pins ride the run record's CREATION write as `impl_claim` (§8) — one
stamp, so the boundary, the publish policy, the factory revision, the
resolving-edge snapshot and the status snapshot are what the pipeline enforces,
whatever the factory node says later.

**The hold is a READ rule, and it is the guarantee.** Between the stamp and the
completion write, `resolutionMap` (lib/kernel/resolution.js, the edge half)
counts NO inbound `resolves`/`answers` into a held item, and `queue.isLive`
(the status half) reads it live whatever its status says — every `blocks`
traversal, `liveBlockers`, `deriveReadiness`, `rankQueue`, the program view and
the briefing render go through those two functions, in both modes, on every
reader running this lib. An implementer that writes its `resolves` edge anyway,
or hand-flips `done`, has broken the contract, but the write is INERT from the
instant it lands: dependents stay blocked, and the window an earlier draft
admitted ("between the write and the next poll") does not exist. Write-side
hygiene sits on top: the seed schema-task/-issue `transitions()` refuse a
completion status on a proposed node still carrying `execution:` (the
controller's CAS removes the key in the same body and passes; a bare
`set_status done` is refused naming the execution), `setStatusLocal` is the
local twin, and their `get()` hook rides `execution_hold` — id, stamp time,
every inert inbound resolver, a note — INSTEAD of the `resolution` ride-along.
`spor get` prints a HELD note and, from this box's run journal, whether the
holding worker is live, gone (**stale** — fail-closed until released or
resumed, never read as done), or elsewhere. The hold keeps a COMPLETION inert,
not a person's decision to drop the work: a give-up status (`abandoned`,
`rejected` — the registry's non-resolving partition) is dead on the status half
even while held; the local status door ends the execution in the same write,
and the reconciler withdraws a hold that outlived an abandonment (and retypes
our edge back, if it stood) — `set_status abandoned` is the person's door out
of an execution, and the escalation a refusal files names both doors (`spor
work --regate <run>`, `spor release <id> --execution <exec>`).

**Premature resolution is retyped as evidence.** At submission (before any gate
runs) and at every reconciliation pass, every inbound resolving edge whose
source is not in the claim's `resolving_snapshot` — whoever wrote it — is
retyped `resolves` → `relates-to` on its source node (remote: `DELETE` then
`POST` on the edges door; local: `removeEdgeLine` + `appendEdgeLine`), and a
terminal status written under the hold is rolled back to the snapshot; the
retype is recorded on the record (`completion_premature`), on the candidate
(`premature_resolution: true`) and on the completion record. The node stays,
the link stays, only its type changes — §10.7's reason for never retracting
under `by: agent` is honored. None of this is load-bearing for dependents; the
hold is.

**The completion write, in forced order** (`writeCompletion`): the debt is
stamped `write` FIRST; the item is re-read and reconciled against settled
state; premature edges are retyped; then (1) the completion record — an
`artifact`, `art-completion-<stem>-<candidate>`, content-addressed to the
candidate, carrying the `resolves` edge onto the item in its own validated
write plus `relates-to` every gate/merge fact and the implementer's resolver —
and (2) ONE compare-and-swap `put_node` of the ITEM writing the terminal status
AND removing `execution:`/`execution_at:` on the revision step 0 read. The seed
completion gate refuses a terminal status with no resolver, so status-first
cannot land; `set_status` is deliberately not used (a read-modify-write with no
revision echo is exactly the window the CAS closes). The moment (2) lands the
hold is gone, our edge counts, and dependents are released — by this write and
by nothing before it. On a `409` the write re-reads and branches: the item went
`abandoned` → our edge is retyped back and the hold cleared alone (`withdrawn`;
a gate never reverses a person's decision to drop work); `done` with the hold
gone → consumed, nothing more written; `done` with our hold still present (a
person's `set_status` past the gate) → the CAS is retried writing the
hold-clear, the person's status stands; a DIFFERENT execution's hold → our edge
is withdrawn and nothing on the item is written; only a non-terminal field
moved → retry, bounded at 3, then the debt is left owed. The debt clears only
after the CAS landed; a crash between (1) and (2) leaves `write` set and the
next pass performs only (2), idempotently.

**Which boundary.** `completion.after: gates` completes when the gate list
settles `passed` (`gates_state`); with an integration block declared under
that boundary, integration runs AFTER the completion and a landing failure
files a `relates-to` item and never demotes — the item stays completed by
declaration. `after: integration` (the default whenever integration is
declared) completes only on `integration_state: landed`; a `parked` proposal
completes when the per-pass proposal check sees the merge (its landed fact is
the boundary's evidence, and `restoreProposal` writes the completion instead of
promoting a status that was never flipped). A refusal at any stage writes NO
edge and clears NO hold: the item stays open, held, blocked by the escalation
the gate filed (§10.7's fail-closed half, unchanged), and its dependents stay
blocked.

**`completion_debt` is designed against all four durable-flag failure modes at
once** (lib/kernel/completion.js `deriveCompletionDebt`, the per-pass
`reconcileCompletions` in the same slot as the proposal check): (a) a stamp that
fails is never the only record — the debt is re-derived every pass from the
PINNED boundary against `gates_state`/`integration_state` and the graph, and
`gate_state: passed` with `after: integration` and an integration still running
derives NOTHING; (b) owe-first — `write` is stamped before step (1) and cleared
only after the CAS, and moving from one debt to another is one overwrite; (c) a
status move on the item turns the CAS into a `409` with a branch, and a foreign
resolving edge — which does not move the item's revision — is inert under the
hold until the CAS that clears it, which is ours; (d) every pass re-reads
first: a `write` against an item already terminal and released is consumed, a
`retract` against an edge already gone is consumed, any debt on a `superseded`
record is consumed, and a pipeline that settled without reaching its boundary
(refused, blocked, superseded, scoped) is stamped consumed — once the item no
longer carries its hold, so a later abandonment is still seen — and the
per-pass journal read stops paying for it; a `--regate` re-opens it. The pass is
bounded in RECORDS EXAMINED, not in writes. `spor runs` prints the completion
line (boundary, state, debt, execution); `spor work --status` shows a held
gating slot's execution: the holder (execution id), the completion boundary
it is pinned to, when it was claimed, and the same live/STALE reading `spor
get`'s note uses (`describeExecutionHolder` in bin/spor.js, read fresh off the
gate run record's `impl_claim` — never restamped on the worker's own status
file) — `--status --json` carries it as a `hold` object on the gating entry,
absent under `completion.by: agent` or on a legacy run.

See test/completion-boundary.test.js.

### 10.14 Declaring the stage — the `implementation:` and `completion:` blocks

§10.12 says what a pipeline pins and §10.13 who writes the completion. This is
how a factory DECLARES both, and which half of the declaration the shipped
runner acts on. Both keys are optional and independent; a factory that declares
neither is byte-identical to one written before the stage existed
(dec-spor-factory-implementation-stage-contract, parsed by
`parseImplementation` in `lib/kernel/gates.js`).

```json
"implementation": {
  "profile": "profile-implementer",
  "instructions": "Prefer the smallest change that makes the acceptance suite honest.",
  "author_checks": ["typecheck"],
  "budget": {"run_max_ms": 5400000, "run_idle_ms": 2700000, "attempts": 1},
  "retry": {"attempts": 1, "backoff_ms": 60000},
  "candidate": {"require_clean": true, "publish": "bundle"}
},
"completion": {"by": "controller", "after": "integration"}
```

**The stage routes by PROFILE and by nothing else.** No `command`, `args`,
`argv`, `bin`, `exec`, `entrypoint`, `env`, `report`, `session`, `launch_mode`
or `identity_mode` (nor the `launchMode`/`identityMode` spellings) — the same
rule already enforced on profiles and kept by
agent-review gates and the rescue lane: a graph write must never define what a
machine executes (dec-spor-declarative-harness-machine-binds-execution). A
bespoke implementer is a `dispatch.harness.<id>` declaration on the MACHINE,
and the graph names only the id. Any of those keys present is a parse error
NAMING the key rather than a silent drop, because an author who wrote
`command` believes it is doing something. That is why the stage needs no
parallel runner: start, observe, cancel and recover all map onto the dispatch
path, the run record and the idle-stop that already own them.

- **`profile`** (default `""`) — the lane's default implementer. It is the
  LOWEST-precedence router: an explicit `--profile` on the worker wins, then
  the item's own `profile:` frontmatter (which is how the test-change lane of
  §10.3 self-routes — a factory default that overrode it would defeat the
  lane), then its `assigned -> agent` edge, and only then this. A lane default
  never overrides a per-item routing decision, and the stage never SUBSTITUTES
  on unsatisfiability: a box that cannot satisfy the resolved profile refuses
  loudly and leaves the assignment and the lease intact, exactly as `spor
  dispatch --profile` does.
- **`instructions`** (default `""`) — appended to the worker contract, never
  replacing it. A factory may add lane guidance; the commit-before-you-submit
  discipline is the runner's, not an operator's to delete.
- **`author_checks`** (default `[]`) — the command gate ids the implementer is
  asked to run itself. **No expensive suite is prescribed twice**: the gate
  re-runs the command from the trusted ref's copy regardless, so an author run
  of the same suite is pure duplicate spend — naming a cheap gate (a typecheck,
  a lint) buys an early failure at a price worth paying, and the operator makes
  that call per gate. The contract's step 3 then lists only these and NAMES the
  suites the factory withholds, because a prompt that merely omitted them
  invites an agent to run them anyway. A name that is not a declared gate id,
  or that names an agent-review or human gate, is fatal. Declaring no block at
  all keeps today's every-command-gate mapping, so an existing factory's prompt
  does not move.
- **`budget.run_max_ms` / `budget.run_idle_ms`** — default to INHERITING the
  worker's own `work.runMaxMs` (24h) / `work.runIdleMs` (45min). A factory that
  says nothing must not silently shorten a worker's watchdog, nor remove one:
  `run_max_ms` has no disabling value, so anything unreadable inherits, while
  `run_idle_ms: 0` IS the declared disable for a lane whose steps genuinely run
  that long (§8). Both are ceilings the loop applies per RUN RECORD at its
  poll, never a dispatch flag.
- **`budget.attempts`** (default 1, max 3) — the **code** pool. A second
  implementation attempt at the same item with the same prompt is the least
  informative retry available; the fix cycle, which carries the findings, is
  the mechanism that differs. So re-implementation is opt-in and capped.
- **`retry.attempts`** (default 1, max 3) / **`retry.backoff_ms`** (default
  60s) — the **infrastructure** pool, ONE per pipeline shared by every dispatch
  it makes, so an outage during a review cannot multiply the bound. One retry
  covers a blip; a real outage outlives any backoff, and the item's cooldown
  plus the next poll is the honest remedy.
- **`candidate.require_clean`** (default true) — refuse a dirty tree at
  submission rather than inside the first gate, where the round-trip already
  lives. Only an explicit `false` relaxes the pin's own check; the first
  command gate's dirty-tree refusal is unconditional regardless (§10.3), so
  `false` does not (yet) let a dirty tree reach a gate — it only removes the
  earlier, more specific refusal at the pin.
- **`candidate.publish`** (`bundle` | `branch` | `both`, default `bundle`) —
  how the pinned commit is made reachable to a controller that does not share a
  filesystem with the implementer. **A candidate always carries a portable
  reference; there is no `none`**, and writing one is an error — the
  machine-local workspace path is provenance, never the reference. `bundle` is
  the default because it is the one form that needs no credential and no
  network: a `git bundle` into `candidate.bundle_store`, a URI PREFIX that is
  `file://` (default `file://<SPOR_HOME>/candidates`; a shared filesystem
  reaches further) or `https://` (the server's candidate door, the remote-mode
  default) and nothing else — a zero-dependency client cannot sign an
  object-store request, so `s3://` and its kin are refused at parse rather than
  at the first publish. `branch` pushes an immutable candidate ref to
  `candidate.remote` (a remote NAME, resolved to its URL at publish; default
  `origin`); `both` publishes both. Two refusals a parse cannot make — an
  `https://` store in LOCAL mode, where there is no candidate door, and a
  `branch` publish with no usable remote — belong at worker startup beside the
  `gh` capability check `integration.mode: propose` makes: `spor work` runs
  `candidatePublish.publishSatisfiability` there (§2.4 E9/E14) and refuses to
  start the worker on a box that cannot publish (see "What runs today" below).
- **`gates[].rejudge_on_repin`** (command gates only, default true; read only
  under `completion.by: controller`) — the per-gate half of the stage.
  Acceptance is a property of the TIP (§10.12): the completion write asserts
  that every gate passed the candidate it completes, and a verdict on an
  ancestor tree is not that, so a command gate whose pass stands on an ancestor
  is re-run on the tip — a suite run, never a dispatch, so it moves no dispatch
  bound. `false` is the explicit opt-out for a suite the
  operator accepts standing on an ancestor. It is not declarable on an
  agent-review or human gate: reviews and approvals always re-judge a moved
  tip. Under agent completion, commands also keep the default re-judgement.
  A retained pass keeps its original head and candidate ID; the runner proves
  that head is an ancestor of the new tip. Unknown ancestry or missing original
  candidate identity causes a fresh command run. Same-attempt restarts may
  reuse a saved pass under the exact same pinned factory declaration. A new
  attempt (re-gate), rescue pass, or changed declaration reruns the command;
  unpaid flake evidence and filing intents are settled before cache reuse.
  Attestations preserve `head_consistent: false` for retained ancestor evidence
  and separately sign `policy_consistent: true`, the explicit pinned opt-out,
  the original candidate, and the tip for which ancestry was verified.
- **`completion.by`** (`agent` | `controller`) — `agent` is the shipped
  contract (the implementer writes the resolving edge and flips the status).
  `controller` is §10.13. It defaults to `controller` for a factory whose
  `implementation` block PARSES — the block is the opt-in and controller-written
  completion is the semantics it asks for — and to `agent` otherwise. A block
  that FAILS to parse adopted nothing, so it never moves the boundary either: a
  typo in the stage must not silently hold back every completion.
- **`completion.after`** (`gates` | `integration`) — the boundary, defaulting
  to the LAST stage the factory actually declares, so it is reachable by
  construction and a factory with no integration still completes. `gates` WITH
  an integration block is valid and means "complete on acceptance, then land":
  integration runs after the completion write and its failure cannot
  un-complete the item — an operator's explicit choice to release dependents
  before the change is on the target ref. Declaring `integration` with no
  integration block is FATAL, not coerced: a boundary that can never be reached
  leaves every item of the factory unresolved forever, which is
  indistinguishable from a worker that quietly stopped completing anything.

The two blocks are adoptable separately. `"implementation": {}` is valid and
takes every default above (and moves completion to the controller);
`"completion": {"by": "controller"}` with no `implementation` block is valid
too, and deliberately so — an operator may adopt the boundary alone, leaving
routing, budget and publication at their defaults. It is NOT byte-identical:
it changes the contract's step 5 to a candidate submission and arms the
controller's completion write.

Like every other factory error, a mistyped stage **refuses to start the
worker** (§10.1's fatal list). A stage that parsed wrong must never produce a
worker that dispatches unbudgeted, so the counts follow this file's standing
convention: a readable but out-of-range number CLAMPS (`attempts: 9` -> 3,
`attempts: -1` -> 0), while a value not readable as a number at all — a blank,
a `null`, a `false`, a list — takes the documented DEFAULT rather than the
floor, because a typo must never read as "no retries", "retry in a second", or
"no watchdog".

**What runs today.** The parse and its refusals, `author_checks` and
`instructions` in the worker contract (`lib/shell/worker-contract.js`),
everything `completion` governs — the execution hold, the `CANDIDATE:`
submission, the candidate pin and the controller's completion write (§10.12,
§10.13) — candidate publication (`lib/shell/candidate-publish.js`: `bundle`
| `branch` | `both`, the `spor work`-startup `publishSatisfiability` refusal
above, and the `publish_pending` debt of an outage), `candidate.require_clean`
(issue-spor-candidate-require-clean-parsed-never-read: the pin itself refuses,
with its own reason, on a checkout with uncommitted tracked changes — see
above), and the STAGE RUNNER itself (§10.16: `implementation.profile` routing,
`budget.attempts`, `retry.attempts`/`backoff_ms`, `budget.run_max_ms`/
`run_idle_ms`, and the dirty-tree round-trip the stage re-dispatches under
`require_clean` before the pin ever refuses) are shipped. The gate runner also
honors command `rejudge_on_repin: false` under controller completion, with the
retention checks and signed evidence described above. Reviews, human approvals,
and factories using agent completion continue to judge the current tip.

See test/gates.test.js (the validation table), test/worker-contract.test.js,
test/candidate.test.js and test/completion-boundary.test.js.

### 10.15 The execution store — server-authoritative in team mode, a compatible local store in personal mode

§10.13's hold and completion write are the client's half of a two-sided
contract. The other half shipped in spor-server (`EXECUTION-STATE.md`,
dec-spor-hosted-execution-state-server-authoritative): a versioned,
tenant-partitioned EXECUTION record per (item, factory, pipeline attempt) with
the definition PINNED at open, a lease with a FENCE, a durable ordered event
log, and the one refusal a client structurally cannot make — a `resolves`/
`answers` edge into an item whose live execution has not reached its pinned
boundary does not land (`409 execution_boundary`). This section is the
client adapter (task-spor-client-execution-store-adapter): how `spor work`
drives that store in remote mode, what it keeps instead in personal mode, and
what it never does while it cannot confirm it still owns the execution.

**One contract, two homes.** `lib/kernel/execution.js` is a port of the
server's reducer — the same `spec_version: 1` record shape, the same
content-addressed ids byte-for-byte (`exec-<16 hex>` of the NUL-joined
`(tenant, node_id, factory, pipeline_attempt)`; a local execution's tenant is
the literal `local`, the word the server falls back to for an identity with no
org), the same event vocabulary and idempotency keys, the same fence
arithmetic and the same `boundary_reached` predicate — with the hash injected
like every kernel module. `lib/shell/execution-store.js` is one interface
with two backings, and `openExecutionStore` picks by mode:

- **Remote** drives `/v1/executions` (API.md §3): `POST` opens (or
  idempotently re-reads) the execution and hands back the fence; the fenced
  `claim`/`renew`/`release`/`events` verbs move it; the `GET`s read it. The
  server pins the definition and derives the tenant and the worker principal
  from the identity — the client never names itself, only its machine.
- **Local** keeps the server's own layout under
  `$SPOR_HOME/journal/executions/<tenant>/` (`exec/<id>.json`,
  `exec/<id>.events.jsonl`, `item/<node_id>.json`), the same log-BEFORE-record
  discipline (a torn write is repairable by replay, never a view of an event
  nobody recorded), the item pointer that makes "does this item have a live
  execution?" one read, and the same engine the server runs — so a record
  written here can be READ by anything that reads the hosted one, and the
  log rebuilds it byte-for-byte. `journal/` is machine-local and never
  enters the graph's commit history.

**Where the pipeline touches it.** The claim (`claimExecutionHold`, H1) opens
the execution FIRST and stamps the store's id on the item's hold — the same id
in both modes — then records the claim on the run record additively
(`impl_claim.store`, `.tenant`, `.pipeline_attempt`, `.fence`,
`.lease_expires_at`, `.worker`, `.machine`, `.gates`; §8). An existing live
execution this caller does not own is claimed plainly: an EXPIRED lease (a
dead worker's orphan) is taken and the fence advances, fencing that worker
out; a live one loses with `already_owned` — exactly the foreign hold H2
refuses — and an unexpired lease is never stolen. A hold refused after the
open ENDS the execution (the pool-spent terminal, `stage.observed:
exhausted`), so neither the item pointer nor the server's write gate keeps
holding an item nothing will run under. Every pipeline pass (a launch, a
resumed orphan, a `--regate`) RE-CLAIMS at its start — a same-owner claim
keeps its fence — and a pass that cannot claim (a live foreign lease) judges
nothing: it settles `blocked` naming the holder. The §7.3 events ride the
seams the pipeline already has, wrapped in `bin/spor.js`
(`reportingGateDeps`) so gate-runner.js and integration-runner.js learn
nothing about the store: `stage.started` at the claim, `stage.observed`
with the run id at launch, `candidate.submitted` on a created/superseded pin,
`gate.settled` per recorded gate fact (verdict → state: passed, skipped,
failed/fail-closed/dirty-tree/scoped → `failed`, unrun/infrastructure/unroutable → `infrastructure`;
`blocked` is not settled; a synthetic scoping gate is not in the pinned list
and is not reported), `rescue.started` per rescue fact, `escalation.filed`
for a gate escalation and a human-gate approval item (never `terminal`: a
refusal leaves the item HELD under the same execution, which is what
`--regate` re-judges), `integration.started`/`.settled` around the
integration stage, and `completion.written` after the completion CAS. A
withdrawn, consumed or person-released completion ENDS the execution the same
way the refused hold does. The lease is renewed once per `spor work` pass
for every execution this process holds (`renewLiveExecutions`, the same slot
as the proposal check and the completion reconciler) — a pass is 30s to 5min,
a lease 15min (`execution.leaseTtlMs`), so no timer is needed. `spor
executions` reads the store (`--node`, `--stage`, one id, `--events`,
`--json`; `--local` reads the machine-local store in either mode), and `spor
runs` prints the store, attempt, fence and lease on the completion line.

**Partitions (EXECUTION-STATE.md §8 rule 3).** A remote event is spooled to a
per-execution OUTBOX (`exec/<id>.outbox.jsonl`) BEFORE the attempt — the
durable local evidence — and un-spooled only once the server answered for it
(recorded or replayed). Every event carries the deterministic idempotency key
its first attempt carried, so re-delivery after a crash between the answer
and the un-spool is a no-op. The outbox is replayed IN ORDER ahead of every
later event, so the reducer's own ordering rules (a gate cannot settle before
its candidate, integration cannot start before the gates) hold across the
outage; a permanent refusal of one spooled event (`422`, an off-state `409`)
drops that event with a log line and keeps replaying, a terminal execution
drops the rest, and an ownership refusal (`fence_stale`, `not_owned`,
`lease_expired`) KEEPS the spool as evidence and stops. What the client never
does is write the resolving edge on the strength of local state:
`writeCompletion` runs the store's `confirm` between the premature-edge
retype and step (1) — flush the outbox, then `renew` under the fence — and
only an `ok` confirms. Unreachable, taken over, expired: the completion stays
OWED (`completion_debt: write`) for a later pass, whose reconciler re-claims
and tries again. In local mode the same check runs against the local engine,
so a second worker on one box that took over an expired execution is refused
identically.

**What stays as it was.** A run record with no `impl_claim` is a legacy run
(`completion.by: agent`) and opens no execution; a controller record claimed
before this adapter (an `impl_claim` with no `store`) reports nothing and
completes exactly as §10.13 describes; no record is rewritten and
`journal/work/*.work.json` does not change shape. A remote server that does
not serve `/v1/executions` (an older version) or has no store configured
(`503 unavailable`) is not a refusal: the claim falls back to the local store
and stamps `store: local`, with one log line; a server that is merely
unreachable IS a refusal (nothing authoritative starts without an execution
nobody else can be holding), and the loop cools the item like any other.
Local-main integration stays on its owning machine: the store holds
coordination state and the candidate's portable reference, and never merges.

See test/execution-store.test.js (the kernel's id pinned against the literal
the server's reducer mints; the local store's durability and rebuild; the
remote adapter against a `node:http` fake whose oracle is the request bodies —
the fence on every transition, the outbox on a partition, in-order replay,
idempotent re-delivery, a takeover refusing the resolving edge through the
completion write's fence check; the CLI claim in both modes and the unserved
fallback; the legacy no-op).
### 10.16 The implementation stage runner — spending the budget and the retry pool

§10.14 declares the stage; this is what `spor work` DOES with it
(task-spor-factory-implementation-stage-runner, FACTORY-IMPLEMENTATION-STAGE.md
§4.2 rows I2-I11, §5.3, §6.5; `lib/shell/implementation-stage.js`, its
launcher and stamps in `bin/spor.js` `makeGateDeps` beside the fix cycle's and
the rescue's). Under `completion.by: controller` every terminal implementer run
is gated (§10.2), and the stage runs FIRST — between the loop's harvest and the
first gate — inside the same pipeline promise, so the slot-holding, cooldown
and resume machinery of §10.8 need no changes: only a CANDIDATE reaches the
gates, and everything else is a refusal of the stage. A factory that declares
no `implementation:` block never enters it and is byte-identical.

**The ledger.** The pipeline's run record carries `impl_attempts[]`, one entry
per implementer dispatch: `{index, run_id, outcome, pool, started_at,
finished_at, reason}`. Attempt 1 is the run the loop dispatched, RESERVED on
the record's creation write (`claimExecutionHold`: `outcome: "pending", pool:
null` — a reservation charges nothing, I1). Every entry is SETTLED in one
stamp at classification, outcome and pool together (`kernel/gates.js`
`settleImplAttempt`), and a settled entry is never re-settled — so a resumed
worker beside a not-quite-dead one charges once, and a stamp that did not
land leaves the entry `pending` for the next pass to re-classify (the
classifier is pure over the run record, which is the debt). The pool caps are
read against SETTLED entries, never against launches: `implementation.budget.
attempts` against the entries whose `pool` is `implementation`, and the
shared infrastructure pool against the SAME `gate_progress.pools.retry`
counter the review and fix gates' outage retries spend (§10.4) — one pool per
pipeline, so a retry the implementation took is not available to a review.

**The classification.** The one shared `classifyExecutionOutcome` reads the
run first: `declined` (I6 — triage, neither pool, no escalation),
`infrastructure` (an environment termination, a harness dead at boot, a
vanished supervisor, an unreachable terminal contract — the RETRY pool),
`cancelled` (the idle stop — the code pool), `failed` (a nonzero exit for no
recognized reason, and every ambiguity — the code pool). A run that ended
CLEANLY is then judged on what it produced, through the same `changedPaths`
read the gates make in the run's own checkout: a commit past the trusted ref
is a `candidate` (I3 — the attempt was used, whatever the publish then costs,
and the entry settles BEFORE any pin or publish); an empty diff is
`no-candidate` (I5); a tree with uncommitted TRACKED changes under
`require_clean` is `failed` with the dirty-tree flag (I4). Four readings are
HANDED to the pipeline as a candidate rather than settled here, because the
pipeline already settles them deterministically before any gate and can only
ever remove a wrong refusal: an empty diff whose item's recorded commits
already landed on the trusted ref (the stale-premise route, §10.11's
sibling), an empty diff the run DECLARED as a no-code outcome (`SCOPED:`,
verified there whichever way it comes out), a dirty tree the factory
tolerates (`require_clean: false` — the pipeline's commit-or-discard
round-trip is the declared remedy), and a checkout that is gone or unreadable
(re-dispatching into a tree this box cannot read would spend an attempt at
the same tree).

**The loop.** After each settle the stage decides (`implAttemptDecision`):
`candidate` hands to the gates; `declined` stops; a code outcome with attempts
left RE-DISPATCHES the implementer (I4, I5, I9, I10) and with none left
settles `exhausted` (I11); an outage with headroom on the shared pool charges
it, waits out `retry.backoff_ms` (sliced, so a stop is answered inside the
wait) and re-dispatches (I7), and with none settles `escalated` (I8). A
re-dispatch is reserved on the ledger BEFORE it is launched (owe before you
clear), stamps `impl_attempt` and `impl_state: running`, and goes through the
same `dispatchThrough` door as everything else: into the run's OWN checkout
(`--no-worktree` — the tree the prior attempt left is what it continues
from), under the profile the original launch resolved
(`record.resolved_profile`, the lane default where that is unknown — the same
routing decision, never a substitution), carrying the worker's own posture
(§5.2: an implementation dispatch is not read-only), `--force` for the
reason the fix cycle passes it (the item is held by this pipeline's
execution), `--no-auto-route`, the worker contract, the lane's
`instructions`, and a preamble naming the attempt and what the prior one left
(nothing committed; a dirty tree to commit-or-discard; a harness that ended
`<outcome>`). It is NAMED `impl-<short>-<n>` (`shortRunAttempt`'s key, so a
`--regate` keys one segment deeper) and ADOPTED by that name on resume, exactly
as `fix-…` and `rescue-…` runs are: a worker killed between the launch and its
durable record joins the run rather than dispatching a second implementer into
one checkout. A re-dispatch the box REFUSES before any run record (an
unsatisfiable profile, a launcher that does not resolve) is `unroutable` (I2):
the reservation is withdrawn — a refusal is not an attempt — nothing is
escalated, and the caller CLEARS the execution hold, since nothing is judging
the item (T1). On the retry pool the order is charge, then RESERVE the next
attempt, then wait out the backoff — so a worker stopped during the wait
leaves a pending reservation the resume launches, never a charge with nothing
behind it. A worker asked to stop reports `interrupted` with the ledger
standing; the record stays unsettled, so the §10.8 resume scan re-offers it
and the ledger picks up where it stopped. `interrupted` is reserved for a
STOP: a re-dispatched attempt this box could not follow to its end (the
watchdog gave up, an idle stop did not take) is settled `cancelled` and the
stage ESCALATES rather than dispatch another agent into a checkout something
may still hold, and a ledger stamp that fails escalates too (the gate
runner's rule for a pool charge that could not land: an uncounted attempt is
an unbounded one) — on a live worker there is no later pass to re-classify
it, so the item is never parked on a promise. The re-dispatched attempts are
followed under the worker's own `--run-max`/`--run-idle` (with the record's
`impl_budget` overriding them, below), so a silent attempt 2 is idle-stopped
exactly as attempt 1 is. The no-code claim (`SCOPED:`) and the candidate
pin's provenance are read off the attempt that actually RAN — the ledger's
last settled entry — never off attempt 1's report.

**What a refusal writes.** `exhausted`, `escalated` and `mismatch` settle
`impl_state` on the record and file ONE `requires: [human]` item that `blocks`
the work item — `task-impl-<state>-<stem>-<short>-<suffix>`, deterministic on
the pipeline's run key and composed from the ledger (never from the pass that
happened to file it; a non-pool reason rides the segment's last entry as
`stop_reason`), so a settled stage re-entered by a resume re-files the
identical node and never a second one. The body says which pool ran out, lists
every attempt with its outcome and pool, and — the `escalated` case — that no
code was judged wrong. A write that fails leaves the same replayable payload a
gate refusal does (`escalation_retry`, `stage: "implementation"`), and the
bounded escalation auto-retry re-files it through the stage's own door. The
hold STAYS (T1): the item is neither completed nor released, and the doors
back are `spor work --regate <run>` or `spor release <item> --execution
<exec>`. **A re-gate is a new segment of the ledger**: `cmdWorkRegate`
reopens a settled stage refusal (`exhausted`/`escalated`/`unroutable`/
`mismatch` — never `candidate` or `declined`) to `running`, and the stage
re-judges the run under the new attempt key with a fresh code pool beside
the fresh infrastructure pool; the earlier segment stays as history (each
entry carries its `attempt`), the caps read only the current one, and the
re-dispatch names key one segment deeper (`impl-<short>-r2-<n>`). The one
exception: an earlier segment that still OWES a launched attempt its
classification (a worker killed while following `impl-<short>-2`, the entry
pending with its run id) is ADOPTED under its original key and name — the
agent behind it may still be editing the checkout, and a fresh segment there
would put a second one in it. The loop
cools the item on the same window a gate refusal gets, `--status` shows the
stage verdict beside the gate's, and `spor runs <id>` prints the ledger as
an `attempts:` line.

**The per-run budget** (§5.1). A stage launch stamps `impl_budget:
{run_max_ms, run_idle_ms}` on the record — only the ceilings the factory
DECLARED; an inherited one is not written — and the loop's poll
(`pollWorkRuns`) reads them per record in place of the worker's own
`--run-max`/`--run-idle`. A record with no stamp (every legacy run, every gate
dispatch) takes the worker's ceilings exactly as before, and a stamp NARROWS a
ceiling, never arms one the operator disabled. The re-dispatched attempts ride
the same stamp, so the whole lane is bounded by its budget whichever attempt
is running.

**Routing** (§2.3). `implementation.profile` is applied by `dispatchWorkItem`
at the LOWEST precedence: only when no `--profile` was passed, the item
carries no `profile:` of its own, and the queue reports no `assigned -> agent`
edge (which `cmdDispatch` resolves itself). It is never a substitution — an
unsatisfiable lane profile refuses loudly like any other.

See test/gate-pipeline.test.js ("the implementation stage": every row with a
fake dispatcher, plus the real doors end to end), test/completion-boundary.
test.js (the claim-time reservation and budget stamp) and
test/work-loop.test.js (the per-record ceiling).
### 10.10 The attestation — a commit-bound, config-checksummed record per run

A gate fact that says only "gate `acceptance` passed" cannot be validated by
anyone who did not watch it run: nothing in it names the commit it judged, the
definition that judged it, or whether the commit that later landed is the one
it judged. Paul Stack's pre-PR verification loop
(stack72.dev/ai-broke-the-assumptions-behind-ci) and the swamp `verification/`
reference implementation close exactly that gap — a fresh worktree at the
verified commit, config checksums, one attestation JSON a CI
`validate-attestation` job checks (commit == PR head, all steps green, fresh,
checksums match) instead of re-running the suite. The pipeline now leaves the
same evidence chain (task-spor-factory-gate-attestation), in four pieces:

1. **Every gate fact is commit-bound.** `gateChangeSet` already reads
   `head`/`base` from the run's checkout; every `art-gate-*` fact now carries
   them as `gate_head:`/`gate_base:` frontmatter plus the trusted ref and its
   own sha (`git rev-parse <trusted_ref>`, which can lead the merge-base) and
   the branch in the body ("Judged commit: …"). An unreadable change says
   "Judged commit: unknown" rather than inventing one. The pipeline's result
   hands the same chain back (`head`, `base`, `trusted_ref`, `trusted_sha`,
   `branch`) and each step carries the head IT judged. **Every step judges the
   same head**: a fix cycle that moves the head (it committed) sends the
   pipeline back to the FIRST gate, and each earlier gate is re-run against the
   moved head — a gate whose recorded pass already judged the current head
   stands (a review is never re-dispatched at a head it approved), fix cycles
   are charged against each gate's cap cumulatively across restarts (so the
   whole pipeline runs at most the sum of the caps), and the superseded fact
   stays on the graph under its own id: fact ids are commit-bound too
   (`gateFactId` folds the judged head into the hash), so gate A at H1 and gate
   A at H2 are two facts, never one adopting the other. An unreadable change
   fails EVERY gate kind closed — command, human, and agent-review alike — so
   no passing fact is ever minted with no head to bind it to.
2. **Every gate fact is definition-bound.** `parseFactory` attaches
   `definition` provenance to the parsed factory: a `sha256:` digest of the
   normalized factory (canonical JSON — sorted keys, no whitespace — so
   authored key order never changes it) and of each normalized gate — over
   the RUNTIME-EFFECTIVE definition only: a gate's `source` (inline, or the
   shareable gate node it was folded in from) is provenance the runner never
   branches on, so it is stripped before hashing (`effectiveGate`/
   `effectiveFactory`) and an inline gate and the same gate referenced by id
   digest identically at both levels, exactly as the runner cannot tell them
   apart; `source` still rides beside the digest as provenance — and
   `loadFactoryDefinition` stamps the node **revision** (blob sha) of the
   factory node and of every referenced gate node beside them
   (`stampDefinitionRevisions`; an inline gate inherits the factory node's).
   Each fact's body names both ("Definition: factory `…` rev `…` digest `…`;
   gate `…` digest `…`"), so a fact says which revision of which rules judged
   it. A validator recomputes the digest from the graph node with the kernel's
   own `definitionDigest` (`lib/kernel/gates.js`) and compares.
3. **Head equality at integration.** The integration stage re-reads the
   implementer's tree independently; a FIRST read whose head differs from the
   head the last passing gate judged (`gatedHead`, handed in by
   `runGateAndIntegration`) REFUSES — settled `failed`, escalated to a person,
   the item demoted per §10.7 — with no candidate built and nothing pushed.
   Whatever moved the checkout between the verdict and the landing produced a
   head no gate has judged. This is deliberately NOT a fix cycle: a fix cycle
   commits, so it produces a new head by construction and can never restore
   the equality; only `spor work --regate <run>` can (the refusal names it).
   The stage's OWN fix cycles (a conflict, a red candidate suite, a failed
   landing) move the head afterwards by construction, and the same rule holds
   there: after every fix cycle the stage re-reads the tree and, when the head
   is no longer `gatedHead`, hands it back to the gate pipeline through
   `deps.regate` (wired by `runGateAndIntegration` to re-run the REAL pipeline)
   — only a PASS at exactly that head advances `gatedHead` and lets the
   rebuilt candidate be judged and landed; a re-gate that fails settles the
   stage `failed` with the re-gate's own escalation standing in (no second
   person's item for one refusal), a re-gate that passed at some other head is
   not a pass for the moved one, and a wiring with no re-gate door fails
   closed. The `art-merge-*` fact records the head it landed and the head the
   gates judged ("Integrated commit: `…` (the head the gates judged)") plus the
   landed sha (`gate_head:`/`landed_sha:` frontmatter).
4. **One attestation artifact per run** — `art-attest-<stem>-<short-run[-aN]>-
   <hash>`, deterministic and idempotent like every gate-minted node (a re-gate
   attests separately by attempt), `relates-to` the work item and every
   `art-gate-*`/`art-merge-*` fact it summarizes, never `resolves`. Its body
   carries the attestation as fenced JSON (`schema: spor.attestation/1`):
   `subject` {node, run, attempt, repo, commit, branch, base, trusted_ref,
   trusted_sha}, `factory` {id, revision, digest}, `gate` {allPassed, state,
   head, steps[] with per-step verdict/head/digest/revision/fact/timing},
   `integration` {mode, strategy, state, target_ref, target_sha, head,
   gated_head, head_matches_gated, landed_sha, candidate, proposal, timing} or
   null, `configIntegrity` {factory, gates[], trusted_ref, trusted_sha,
   protected_paths, protected_paths_count, protected_paths_digest}, `timing`,
   `environment` {spor_version, worker, host, platform, node, mode}. `gate.allPassed` is true only when every step passed
   AND every step judged the gated head AND that head is known
   (`gate.head_consistent` — checked here, not assumed from the runner);
   `passed` additionally needs the integration (if any) landed or parked with
   `head_matches_gated` not false. `subject.commit` is the head the STAGE saw
   when one ran (what would have landed), else the gated head — so a validator
   comparing it against a PR head sees the truth when they differ. The node
   body is capped (the REST door's 8KB) but the JSON is NEVER cut: the
   rendering steps down — pretty, compact, free-text dropped, steps thinned to
   id/kind/verdict/head/digest/fact (`abridged` says so), fewer linked edges,
   and at the floor every list (steps, gates, protected paths) REMOVED —
   never left as an empty list beside a nonzero count, which the validator
   refuses as a disagreement — and replaced by
   its count — so every rung is whole JSON carrying what a validator checks;
   the full object still rides the run's in-process result. The floor is
   bounded by construction (ids, shas, digests, counts — no list rides the
   bound core, see below) and it is MEASURED, not assumed: a rendering that
   still does not fit is refused as a build error, and an attestation that
   could not be built or recorded is stamped on the run record
   (`gate_attestation_missing`, `gate_attestation_error`) through the
   settler's own door, never lost behind a log line. OWNERSHIP comes before
   the first gate: `claimGateRecord` mints the run's ownership nonce
   (`gate_settle_id`) under the record lock BEFORE the pipeline runs — a
   record another pipeline already settled, or one a still-live worker is
   gating, refuses the claim and the worker runs NOTHING for it (no fact, no
   escalation, no demotion, no attestation; its result carries `not_run` and
   `superseded` with the record's own verdict), while a dead owner's record is
   taken over, which is what orphan resumption is — so two adopters of one
   orphan can never both mutate the graph and leave the loser's escalation or
   demotion standing against the winner's verdict. ORDER: the run record is settled FIRST
   (`gate_state` and the verdict fields, read-back verified) and the
   attestation node written second, so no window holds a graph artifact
   claiming a verdict the record does not. The evidence fields (`gate_head`,
   `gate_base`, `gate_trusted_sha`, `gate_factory_digest`, `gate_landed_sha`)
   ride IN that settle stamp — one write, one writer — through the claim's
   own door (`own: <gate_settle_id>`: a re-gate or another owner in between
   re-opened the record, and the settle does not land) — and the settle is a
   **locked compare-and-swap**, not a read-modify-rename: `stampGateState`
   takes a per-record `<record>.lock` (O_EXCL; a lock older than 30s is a
   dead writer's corpse and is broken; a lock that cannot be taken within the
   bounded wait is a stamp that did NOT land) around the read-guard-write, and
   returns the record READ BACK FROM DISK after its write — never the
   in-memory merge — so two pipelines for one run cannot both pass the
   unsettled guard and both believe they own the verdict. The settle keeps
   the claim's `gate_settle_id` (a random nonce — two settlers in the same
   millisecond cannot share it the way they could share `gate_at`; a record
   that had none to claim gets a fresh one at settle time) and
   reports whether it LANDED by that id: when the guard yielded to an earlier
   writer (a duplicate pipeline for the same run — a resumed orphan, a second
   adopter — settled first), this pipeline's verdict is not the record's, so
   it writes NO attestation and touches NO evidence field (its result carries
   `superseded: true` plus `settled` — the record's own verdict, head,
   attestation and worker — and the log names the winner; the work loop then
   PUBLISHES the record's verdict on `--status`, keeps the loser's under
   `superseded_verdict`, stamps nothing for it, and cools the node by the
   record's verdict). `gate_attestation` is stamped afterwards through the
   settler's OWN door (`stampGateState`'s `own: <gate_settle_id>` — lands only
   while the record still holds this pipeline's settle id, falling back to
   `gate_at` only for a record settled without one; `force` stays
   `--regate`'s door alone), so the graph and the record can never describe
   two verdicts or two heads for one run.
   Read back by `spor runs` ("gated head:", "attested:" — or "attested:
   MISSING — <reason>" from `gate_attestation_missing`/`_error`, and
   "proposal: PR body carries a STALE attestation" from
   `gate_proposal_attestation_stale`) and `spor work --status` (whose
   `gate_head` is the GATED head, not the stage's, and whose entries carry
   `attestation_missing`/`attestation_error`/`proposal_attestation_stale`/
   `proposal_attestation_error` for both a settled and a superseded
   pipeline). And every
   gate-minted node — fact, escalation, approval, attestation — is written
   `if_exists: skip` in BOTH modes with the same rule: a skip means the id
   exists, not that this write landed, so the existing node is read back and
   compared (frontmatter minus the server's own stamps and the day, plus the
   body); a different node under the same id is refused, never adopted as
   this run's evidence. Fail-soft like every fact write: the verdict is the
   enforcement, the attestation is its record.

**Every attestation is BOUND: a digest, and a signature when the pipeline holds
a key.** A PR body is mutable text its author can edit, so the JSON in it is
not evidence by itself. `bindAttestation` stamps `digest` — sha256 over the
canonical JSON of the attestation's bound core: subject, factory, per-step
verdicts/heads/digests (through `gate.steps_digest`), the config lists
(through `configIntegrity.gates_digest`, and the protected paths through
`protected_paths_count`/`protected_paths_digest` — a count and a digest, never
the list, so a factory protecting hundreds of globs neither overflows the
node nor escapes the binding), the integration stage's bound
fields — mode, strategy, state, target ref and sha, head, gated head, landed
sha, the **candidate-suite evidence** (`candidate` {base, sha, suite,
command}: a validator trusting a propose-mode PR is trusting "merge(target,
head) was green under <command>", so that block is as tamper-evident as the
verdicts) and the proposal's identity (`proposal` {number, repo, branch,
url}) — `passed`, `issued_at`, the artifact
`id`; free text and the box's host/worker are outside it, so the core survives
every rung of the node-body ladder including the floor that elides the lists —
and, when `attestation.signingKey` (`SPOR_ATTESTATION_KEY`; a secret, so
stripped from a committable repo `.spor.json` — env, user or global config
only; `attestation.keyId` names it) is configured, `signature`
{alg: hmac-sha256, key_id, value} over those same bytes. Two trust anchors
follow: the GRAPH ARTIFACT the runner wrote — a copy is genuine only if its
`digest` equals the artifact's, AND the artifact is checked as an attestation
in its own right (its digest recomputes from its own content; under a key its
signature verifies) AND its server-stamped provenance shows the judged code
could not have written it: a dispatched agent holds graph-write authority
(its agent-scoped token), so without a key a graph copy the server stamped
`authored_by_agent`, or one read from a LOCAL graph (a directory on the box
the implementer ran on), or one whose provenance is unknown, is NO anchor
(`anchor` fails) — and the shared key, for a CI that cannot reach the graph
or whose runner writes the graph under an agent identity. `spor attestation
verify (--pr-body <file>|--file <file>|-) [--commit <sha>] [--max-age <dur>]
[--factory <id>|--factory-digest <d>] [--require-signature] [--no-graph]` is
the validator (`verifyAttestation`, every check fail-closed, exit 1 on any
failure): schema, digest recomputation, signature (a key on the box and no
signature is a failure), the graph binding (fetches `art-attest-*` by id;
missing/unreadable fails unless `--no-graph` is passed deliberately),
`passed`, **the evidence beneath it** (`verdicts`: `gate.allPassed`,
`gate.state`, `gate.head_consistent`, every listed step passed AT the gated
head — the list's length agreeing with `steps_count` — and, where a stage ran,
a state the attestation may vouch for, `head_matches_gated`, the stage head
equal to the gated head, and the candidate suite `passed`; a copy whose flag
says passed over explicitly failed evidence is refused whatever bound it),
commit equality, **the target binding** (`--target <sha>`: the tip the
candidate was merged with — `integration.candidate.base`, else the stage's
`target_sha`, else for a stage-less run `subject.trusted_sha` — must equal
it, so an attestation over merge(old tip, head) goes stale when the base
advances and one made for another base is not reusable against this one;
`--target-ref <ref>`: the stage's `target_ref` names it, a short name
matching the remote-tracking spelling), freshness, and the factory digest AS
IT STANDS (`--factory` loads it through the worker's own loader). The digest
alone is never a pass: whoever edits the body recomputes it, so a verification with
NEITHER anchor — no key on the box and no graph copy — fails (`anchor`), and
`--no-graph`, which drops the artifact, therefore REQUIRES a verified
signature: it implies `--require-signature`, and on a box with no key
configured it is refused outright rather than passed on a self-authored
digest.

A change read that fails AFTER a fix cycle (the tree moved and the re-read
could not say where to) leaves the judged commit UNKNOWN — the fact says so
and the chain carries no head — never the pre-fix head standing in as what
was judged.

`issued_at` is DERIVED from the judgement — the moment the last gate step (or
the integration stage) finished — never minted from the clock: the id is
stable per run and the node is written `if_exists: skip` with a read-back
comparison, so an attestation rebuilt from the same results (a retried write,
a resumed pipeline) must reproduce the same bytes rather than collide with
its own earlier copy. The clock is the fallback only for a result carrying no
timestamps.

**The judged code never sees the judge's credentials.** A command gate's
suite and the integration candidate's suite are the judged repository's own
code running on the judge's box, so `runGateCommand` scrubs the attestation
signing key and every graph credential (`SPOR_ATTESTATION_KEY`,
`SPOR_TOKEN`/`SUBSTRATE_TOKEN`, refresh/admin tokens — `scrubSecretEnv`, one
list) from the inherited environment AND from the tree's declared setup env
before spawning; otherwise a branch could sign its own forged attestation or
write the `art-attest-*` anchor as the runner. Unrelated keys the suite needs
are left alone. The same holds one level up and one level down. UP: the
dispatched implementer never inherits the judge's secrets either — the
supervisor strips `SPOR_ATTESTATION_KEY`, `SPOR_ADMIN_TOKEN` and
`SPOR_REFRESH_TOKEN` — under their legacy `SUBSTRATE_*` spellings too, which
the config cascade dual-reads (`JUDGE_ONLY_ENV`, agent-dispatch-runner.js) —
from every harness child, whatever the harness, on top of the agent-scoped
token that replaces the person's graph bearer. SIDEWAYS: the repo's
`dispatch.worktreeSetup`/`worktreeTeardown` hooks are resolved from the
tree's own checkout — the commit under judgement — and run under the same
`judgeGitEnv` as the judge's git (secrets scrubbed, hooks off), for every
tree role, so candidate-controlled staging code never sees the key or a
graph credential before the scrubbed suite does. DOWN: every git call the JUDGE makes over
the judged tree (`git worktree add`, the protected-path checkout, the
candidate merge/rebase) runs under `judgeGitEnv` — the same secret scrub plus
every git HOOK disabled, `core.hooksPath` forced through git's env-config door
to a path no hook can live under (`/dev/null/…` on POSIX; a fresh private
empty directory on Windows) — because a commit can point `core.hooksPath` at
a tracked directory and a `post-checkout` in the change under judgement would
otherwise run as the judge before a single gate had looked at it.

**The trusted tree is pinned once.** `gateChangeSet` resolves
`trusted_sha` and REFUSES when the ref does not resolve; `prepareGateTree`
and the integration candidate's protected-path restore then force from that
sha, never from the symbolic ref — so a ref that advances between the read
and the restore cannot put a different suite in the tree than the fact
names. The candidate block carries the sha it was forced from
(`candidate.trusted_sha`, inside the bound core).

**Every whole-record writer takes the record lock.** The settle is a locked
compare-and-swap, but the two in-process writers that rewrite the WHOLE run
record from memory (`updateRun`, the supervisor's `update`) carried the
on-disk `gate_*` fields OUTSIDE that lock — a settle landing between their
read and their rename was renamed over, erasing a verdict and attestation the
settler's read-back had verified. They, `closeRun` and `mergeTerminalOutcome`
now do their read-carry-write under the same per-record lock
(`writeRecordCarryingGate`), and NONE of them has an unlocked fallback: a
write that cannot take the lock does not happen (`null`, or a throw the
caller's own fail-soft handling absorbs — the supervisor keeps its in-memory
record and carries the patch on its next update). The lock's bounded wait
OUTLASTS the stale window (`RECORD_LOCK_ATTEMPTS × RECORD_LOCK_WAIT_MS` >
`RECORD_LOCK_STALE_MS`), so a settler that died holding it costs a wait,
never a write. Breaking a corpse is OWNERSHIP-SAFE: a breaker never unlinks
the lock path (two waiters unlinking one stale lock let the second remove
the first's fresh lock — two holders); it RENAMES the corpse to a name only
it knows (one breaker wins), judges the file it actually took, deletes it if
stale and hands it back (a hard link, never replacing a lock taken in the
meantime) if it turned out live. The rename leaves the lock path empty for a
moment, so the break runs under a BREAKER LOCK (`<lock>.break`, one breaker
at a time, held until the moved lock is back at its path or deleted) and an
acquirer whose O_EXCL open succeeds while that breaker lock exists does not
hold — it releases what it took and goes round again — so a lock opened in
the break window never becomes a second holder beside the live one whose
lock was moved aside. Release is checked: the holder wrote a random token
into its lock and removes the lock path only while that token is still what
it holds.

**In `propose` mode the PR body carries the attestation — or there is no PR.**
A body that cannot be built (the attestation object throws, or renders
empty) is a FAILED proposal, routed like any other stage failure (§10.9),
never a PR opened with a generic description: the attestation-bearing body
is the contract a PR-policy repo's CI validates, and a PR without it would
pass through that repo's merge queue with nothing to check. `proposeIntegrationPR`
writes `renderPrBody`'s text — the step list, the candidate suite that just
passed on merge(target, head), the artifact id and digest it is bound to, the
rule that the text alone is not evidence, and the JSON between
`<!-- spor-attestation:begin -->`/`<!-- spor-attestation:end -->` markers
(`extractPrAttestation` is the reader). It is built at PROPOSE time, bound to
the head being proposed, with `integration.state: "proposing"` and
`integration.candidate` {base, sha, suite, command, trusted_sha} — and it is
a PASSING attestation as it stands (`proposing` is a state the builder vouches
for when every gate passed at that head and the candidate suite is green; the
proposal's identity is the one thing it cannot yet carry), signed when a key
is held, so a validator triggered on PR creation checks it by SIGNATURE and
passes rather than failing for good on a body the runner only repairs later;
the body says so. A reused PR gets its body
refreshed (`gh pr edit`), and that refresh is NOT best-effort — a PR
re-proposed at a new head but still describing the old head's verdicts is
stale evidence under a "success", so a failed edit is a failed proposal (fix
cycle, then a person) with gh's reason verbatim. Because the graph artifact is
minted only after the run SETTLES, the propose-time body predates it; once the
run is settled and attested, `refreshProposalAttestation` replaces the PR body
with the final, digest-bound copy the graph holds (the copy a validator
compares against). A refresh that fails is logged loudly and stamped on the
record (`gate_proposal_attestation_stale`, `gate_proposal_attestation_error`,
through the settler's own door) — never reported as success; a validator
comparing the stale body to the artifact refuses on the digest mismatch anyway.
A repo's CI can then run `spor attestation verify --pr-body … --commit <PR
head> --target <base tip> --target-ref <base> --max-age 24h --factory <id>` —
instead of re-running the suite (a validator comparing against the graph
artifact runs on the post-settle body edit, or re-runs; the creation-time
body verifies by signature). Making
any particular repo's CI do so is that repo's work, not the runner's; this is
what makes `propose` mode worth adopting for a PR-policy team.

See test/attestation.test.js, the provenance assertions in
test/gate-pipeline.test.js and test/gates.test.js, and the head-equality tests
plus the local end-to-end attestation check in test/integration-step.test.js.


### Attestation settlement recovery and ownership (2026-09 repair)

The run-record claim precedes every pipeline mutation. The work loop does not
pre-stamp `gate_worker`: a losing adopter must not overwrite the live owner's
nonce before the claim check. Proposal pushes and trusted-ref re-gate merges disable repository hooks.
Native and supervised judged children both strip
`SPOR_ATTESTATION_KEY` and `SUBSTRATE_ATTESTATION_KEY` from their environments.

Settlement atomically writes the verdict and `gate_attestation_pending`, an
outbox containing the exact artifact bytes and signature (never the signing
key). `gate_attestation_missing` remains true until publication succeeds.
Subsequent worker passes replay this debt without rerunning the gates or
resigning evidence. Replay requires the original server and effective
credential fingerprint, or the canonical local nodes directory. The raw token
is never stored. A conflicting JWT organization refuses the binding; opaque
tokens bind by fingerprint rather than stored tenant metadata. Publication
freezes that exact bearer/server and disables automatic token refresh, so an
environment override or credential rotation cannot redirect pending evidence.
Changed or unknown credentials leave the debt owed for manual reconciliation. An old outbox without an origin binding
is retained for manual reconciliation and is never published through an ambient
graph selection. A parked proposal retains its debt until its PR body is
refreshed successfully. Pending debt prevents run retention from pruning the
record. Gate, implementation, completion, native/contract settlement and final
run bookkeeping all share the same record lock, including their read/merge.
The launcher also merges its post-spawn PID stamp through this lock: a paused
launcher cannot restore its original record over a completed supervisor or
subsequent re-gate.

A re-gate publishes its PID and process start ticks before atomically reopening
the prior verdict. Reopening refuses while the prior judgement still owes an
attestation outbox; replay that evidence through its original graph first.
Other workers therefore recognize its live ownership. Its
final bookkeeping and recovery mutations retain the same ownership nonce; a
losing re-gate cannot overwrite the successor. Human approval requests name
and key their identity on the exact judged commit, so a fix that changes the
candidate requires a fresh approval even when its risk paths stay unchanged.

A stale breaker lock is deliberately fail-closed: age alone cannot authorize
unlinking its pathname because that pathname may already name a live successor.
If a worker dies while holding `<run-record>.lock.break`, stop all writers of
that run record before removing that abandoned breaker and resuming work.
Ordinary stale record locks still use the serialized rename-and-recheck path;
no observer automatically removes an abandoned breaker lock.

PR refresh first reads the current body and replaces only Spor's managed
`spor-proposal` block (or the legacy `spor-attestation` block). Human text and
other automation outside that block survive byte-for-byte. Ambiguous or
unterminated markers refuse the update. GitHub provides no compare-and-swap
operation for this body edit, so truly concurrent external edits between the
read and update remain an API limitation.

// kernel/queue.js — Spor decision queue: rankQueue, pure kernel
// (QUEUE.md §4/§5; REFACTOR.md §1). Data in, data out: the graph, the
// activity/front maps, the clock, and the sandbox engine for attached code
// all arrive as inputs — the only host default is `now` falling back to
// Date.now() when the caller doesn't pin it (conformance fixtures always do).
// The CLI lives in the lib/queue.js façade.
//
// The queue is a compile mode, not a new store: collect resident nodes whose
// schema says queueable: true (the seed marks task and capture-pending; orgs
// add their own) and whose status is live, compute advisory signals, blend,
// and return ranked items each carrying a one-line *why*. "Live" is judged
// by edges before status: an item with a live inbound resolves/answers edge
// is already done however its status field reads (lib/kernel/resolution.js,
// issue-cc-status-lags-resolution-edges), and open gardener findings about
// an item ride along on it as `findings`.
//
// Signals (QUEUE.md §4) — derived, advisory; humans override via priority:
//   blocking  — live nodes transitively reachable over outbound `blocks`
//               edges (completing this unblocks them).
//   front     — the viewer's own write-class activity on the node (puts,
//               edges, status flips, captures during it) over a rolling
//               window (`frontDays`, default 7), INJECTED per-identity:
//               remote mode by the server from its request journal
//               (store.writeActivity); LOCAL mode by reconstructing the same
//               {nodeId: count} map from git history — commits by the local
//               git identity touching nodes/<id>.md in the window
//               (lib/queue.js gitFront, task-cc-local-front-productionize).
//               Counts the node itself only — no neighborhood propagation —
//               so provenance hubs can't ride it, and the blend caps it below
//               the p1 bump: human priority > demonstrated front > structure
//               > ambient heat. Working a node keeps it surfaced; finishing it
//               still retires it via resolves edges, so the continuity loop
//               terminates (dec-cc-queue-front-from-attribution) — EXCEPT for a
//               task held open on an external gate, which has nothing to resolve,
//               so each held pass re-raises front and re-surfaces it. The
//               held-task self-limit breaks that loop
//               (task-spor-queue-front-loop-self-limit-on-held-tasks): an OPEN
//               task carrying a non-resolving outcome (artifact/decision) with no
//               live resolving edge and no live blocker damps front to 0 in the
//               score and flips its suggestion do->triage (close the loop), the
//               same shape staleness uses. Two guards keep that flip OFF ready,
//               never-started work (task-spor-queue-held-guard-residual-reference-
//               and-priority-front): the inbound outcome must be a real work
//               product, not a bare relates-to/derived-from/mentions REFERENCE
//               (fix a), and front must clear HELD_FRONT_FLOOR — a lone create +
//               a priority bump is metadata, not churn (fix b). signals.front
//               stays the raw count for the queue-policy seam. The why-line states
//               the actual window (`frontDays`), not a fixed "this week".
//   blocked_by — live nodes with a `blocks` edge INTO this one (it cannot
//               proceed until they do). The boost above needs this inverse
//               or blocked work outranks its own unblocker
//               (issue-cc-queue-ranking-asymmetry): each live blocker
//               subtracts what a blocked target adds, the suggestion flips
//               to "blocked", and when the blocker is itself in the ranking
//               the blocked item is capped just below it so the unblocker
//               always surfaces first. A blocker that is terminal,
//               superseded, or retired by a live resolves edge doesn't
//               count — same liveness the rest of the queue uses.
//   heat      — recent activity in the node's 1-hop neighborhood. The
//               activity map ({nodeId: touchCount}) is INJECTED — the server
//               builds it from journal/server.log (§11); local callers may
//               pass nothing and heat is 0. Raw counts run into the
//               hundreds on a live server and drowned every other signal
//               (issue-cc-queue-blend-heat-dominance), so the blend takes
//               log2(1+heat) — heat still orders items (strictly monotone,
//               no ties introduced) but lands in the same single-digit
//               range as priority/blocking/age. signals.heat stays the raw
//               count for display and for queue-policy rank() authors.
//   staleness — fraction of the node's edges whose targets are superseded or
//               gone. High staleness suggests CLOSING, not doing (§8), so it
//               flips the item's suggestion rather than boosting its score.
//   age_days  — days since the node's date.
//
// Default blend (QUEUE.md §8, "leaning opinionated" — shipped opinionated):
//   score = priorityBump(p1=6,p2=3,p3=1) + 3*blocking - 3*blocked_by
//           + min(log2(1+front), 5) + log2(1+heat) + min(age/30, 3)
//           + neededByUrgency(needed_by),   // 0..5, ramps toward a deadline
//           then capped below any live blocker in the list
//   (the front term is damped to 0 for a held-on-a-gate task — the self-limit,
//    task-spor-queue-front-loop-self-limit-on-held-tasks)
// No scoring formula owns the ranking: an org replaces the blend with a
// `kind: queue-policy` schema node whose attached rank(items) returns new
// scores (QUEUE.md §4/§8). The policy runs once per rankQueue over the full
// item list (signals already computed), in the same sandbox as all attached
// code, and is fail-soft — a broken policy annotates the result and the
// built-in blend stands.

const resolution = require("./resolution.js");
// graph.js owns the shared slug->grouping scope resolver (scopeFor); no cycle —
// kernel/graph.js requires only registry.js + resolution.js, never queue.js.
const kgraph = require("./graph.js");
// Pure cold-in-hot-neighborhood fold over the injected git-derived timestamp
// index (task-spor-git-derived-timestamp-index); a no-op (returns 0) when no
// index is injected, so the prompt/conformance paths are byte-identical.
const tsKernel = require("./timestamps.js");

const PRIORITY_BUMP = { p1: 6, p2: 3, p3: 1 };
const STALE_SUGGEST_THRESHOLD = 0.5;
const DEFAULT_LIMIT = 20;
// Held-guard front floor (task-spor-queue-held-guard-residual-reference-and-priority-
// front, fix b): a lone create plus a single `priority:` bump — two write-class ops,
// both pure metadata — must not, alone, satisfy the held check, or a never-started
// task that picked up a triage-pass priority bump reads as churning and flips
// do->triage. Require front STRICTLY above that two-write floor (front > 2). The raw
// count still rides `signals.front` for ranking and the queue-policy seam
// (dec-cc-queue-front-from-attribution); only the held gate consults the floor.
// Genuine churn (a held task re-dispatched repeatedly, each pass writing outcomes)
// clears it by an order of magnitude.
const HELD_FRONT_FLOOR = 2;
// Rolling window the `front` signal is measured over, in days. The default
// matches the server's request-log window and the local git-history default
// (task-cc-local-front-productionize, dec-cc-queue-front-from-attribution);
// the why-line states whatever window was actually used. Injected via
// rankQueue({ frontDays }); only the why-line wording depends on it (the
// count itself is precomputed by the caller over the same window).
const FRONT_DEFAULT_DAYS = 7;

// needed_by urgency (task-cc-xproject-dependency-loop): a deadline that ramps
// the item UP as it nears — the inverse of wake's hide-until. Kept in the same
// single-digit band as the other advisory terms (issue-cc-queue-blend-heat-
// dominance, resolved by dec-cc-queue-heat-log-compression): it never
// dominates, and HARD overdue escalation past the cap is the gardener's job
// (task-cc-dormancy-escalation), not the score's. Window mirrors the age/30
// month scale; cap = NEAR + OVERDUE = 5, matching the `front` cap.
const NEEDED_BY_WINDOW_DAYS = 30; // ramp horizon: beyond this, no urgency yet
const NEEDED_BY_NEAR = 3;         // contribution when due today (== a p2 bump / one blocked node)
const NEEDED_BY_OVERDUE = 2;      // extra contribution once overdue, up to the window again

// A node is live when its status isn't terminal and nothing supersedes it.
// Missing status counts as live (the validator doesn't require status).
// Terminal vocabulary is owned by lib/kernel/resolution.js
// (dec-cc-terminal-status-single-source), registry-backed off `graph` when
// passed (issue-spor-coupling-resolution-terminal-status-divergence) and
// type-aware — the node's type selects the registry's per-type inert overlay
// (dec-spor-status-inert-third-partition) — no local list.
function isLive(node, supersededBy, graph) {
  if (supersededBy[node.id]) return false;
  return !resolution.isTerminalStatus(node.status, node.type, graph);
}

// Distinct live nodes transitively reachable over OUTBOUND `blocks` edges
// (GRAPH.md: `n blocks t` == t cannot proceed until n does). The result is a
// pure function of the graph's HEAD (structure + status/supersession liveness),
// so an optional `memo` (Map id->count) caches it across rankQueue calls on a
// resident graph (task-cc-rankqueue-memoization) — this per-item traversal is
// the dominant queue-build cost at scale. The cache lives on the graph object
// (queueIndex below) and is invalidated by reload/applyNode, so a memoized hit
// is byte-identical to a fresh traversal (norm-cc-byte-identical-refactor).
function blockingCount(graph, id, memo) {
  if (memo) { const c = memo.get(id); if (c !== undefined) return c; }
  const seen = new Set();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    for (const e of graph.nodes[cur]?.edges ?? []) {
      if (e.type !== "blocks" || seen.has(e.to)) continue;
      const t = graph.nodes[e.to];
      if (!t) continue;
      seen.add(e.to);
      if (isLive(t, graph.supersededBy, graph)) stack.push(e.to);
    }
  }
  let live = 0;
  for (const tid of seen) if (isLive(graph.nodes[tid], graph.supersededBy, graph)) live++;
  if (memo) memo.set(id, live);
  return live;
}

// Personal mutes: the viewer's person node may carry a queue_mute register
// (flat inline list, the only shape the frontmatter parser speaks):
//   queue_mute: [my-project, task-noisy-job@2026-07-01]
// Each entry names a project slug or node id; an optional @YYYY-MM-DD expiry
// makes the mute temporary — past the date (or unparseable) the entry is
// simply inactive, so a "sideline this project for now" lever can't rot
// into a permanent blind spot silently. Muting is per-viewer presentation
// at queue-compile time, NOT graph state: items stay live for everyone
// else, and the result carries a muted count so the hiding is never silent.
// The org-wide counterpart is the queue-policy rank() override; this is the
// person-sized one.
function activeMutes(viewer, now) {
  const raw = viewer?.queue_mute;
  if (!Array.isArray(raw) || !raw.length) return new Set();
  const out = new Set();
  for (const entry of raw) {
    const [target, until] = String(entry).split("@");
    if (!target) continue;
    if (until !== undefined) {
      const t = Date.parse(until);
      if (Number.isNaN(t) || now >= t) continue;
    }
    out.add(target);
  }
  return out;
}

// Scheduled dormancy: a queueable node may carry `wake: YYYY-MM-DD` —
// "nothing to do against this until that date" as GRAPH STATE, unlike the
// per-viewer queue_mute (which dies with the person — the Outlook-reminder
// failure mode: the cert owner leaves, the calendar item leaves with them,
// the expiry becomes an incident). Before the date the queue counts the
// item as `dormant` instead of ranking it; from the date on it surfaces to
// EVERY viewer with its priority and signals intact. No scheduler anywhere:
// the queue is recomputed against `now` on every read, so waking is free.
// Same date semantics as mute expiry (Date.parse, UTC midnight); an
// unparseable date means AWAKE — bad data must never hide work (the
// validator warns instead).
function wakeTime(node) {
  if (!node.wake) return null;
  const t = Date.parse(node.wake);
  return Number.isNaN(t) ? null : t;
}

// Task claim-lease intersection (dec-cc-task-claim-lease,
// dec-cc-task-resumption-reservation). A claim is a DURABLE `assigned` edge
// (work→person, committed) intersected at READ TIME with an EPHEMERAL,
// server-held lease table — one more injected rankQueue input alongside
// activity/front/heat, NEVER part of graph state. Injection contract
// (rankQueue({ leases })):
//
//   leases: { nodeId -> { by, expires, reserved? } }   // other keys ignored
//     by       — the holder's person node id (matched against viewer.id), or an
//                 email for an unbound/legacy identity.
//     expires  — epoch ms; the entry is IN FORCE iff now < expires. Compared
//                 against the injected `now` HERE (the wake/dormancy law,
//                 dec-cc-queue-wake-dormancy: no scheduler — read-time only),
//                 so a lapsed entry self-heals to the pool with zero sweep even
//                 if the server hasn't pruned it.
//     reserved — true marks a Tier-2 owner-exclusive RESUMPTION RESERVATION
//                 (a clean SessionEnd converted the active lease to a
//                 grace-window expiry, no heartbeat); absent/false is a Tier-1
//                 live (heartbeat-renewed) lease. Both are owner-exclusive; the
//                 flag only colors the steward-view label and the item's
//                 lease_state signal.
//
// This is EXACTLY the shape server/leases.js `snapshot(now)` emits (extra keys
// like expires_at/session/claimed_at ride along harmlessly), so the server
// passes `leaseEngine.snapshot(now)` straight through. Absent/empty `leases` ->
// no intersection at all -> byte-identical to before this input existed
// (norm-cc-byte-identical-refactor; the common local-mode-without-server case).
//
// Three states per item carrying an in-force lease entry, viewer-relative:
//   - held by the VIEWER (live or reserved) -> kept in the viewer's own queue
//     (their `front` floats it up for free); not demoted, tagged lease_state.
//   - held by ANOTHER -> owner-exclusive: dropped from this viewer's actionable
//     list and COUNTED as `leased` (live) / `reserved` (Tier-2) — the
//     counted-not-silent law of dec-cc-queue-personal-mutes, mirroring
//     muted/dormant/archived, never a silent erase. A capacity/steward read
//     (assignee set) is exempt — it deliberately surfaces someone's carried
//     work, so the lease is shown ("in progress / reserved by X"), not hidden.
//   - expired past `now` -> NOT in force: ignored, the item is full pool at
//     normal priority for everyone (the grace-window-exceeded escalation; the
//     server already drops these from snapshot, this is the defensive backstop).
function leaseState(leases, nodeId, now) {
  if (!leases) return null;
  const l = leases[nodeId];
  if (!l || typeof l.expires !== "number" || l.expires <= now) return null;
  return { by: l.by ?? null, reserved: !!l.reserved };
}

// needed_by: a deadline rendered as graph state, the INVERSE primitive to wake
// (dec-cc-queue-wake-dormancy). wake HIDES a node until its date; needed_by
// keeps it visible from creation and ramps its score as the date nears — so a
// cross-cutting dependency surfaces in the serving team's queue early, not at
// the last minute (the failure task-cc-xproject-dependency-loop targets). The
// two are independent axes and coexist (can't-start-until vs needed-by). Same
// date parsing as wake (Date.parse, UTC midnight); bad data means NO urgency —
// the mirror of wake's "bad data must never hide": here it must never boost,
// and the validator warns instead.
function neededByTime(node) {
  if (!node.needed_by) return null;
  const t = Date.parse(node.needed_by);
  return Number.isNaN(t) ? null : t;
}

// Days until the deadline (negative once overdue), or null when absent/unparseable.
function neededByDays(neededBy, now) {
  if (neededBy == null) return null;
  return Math.floor((neededBy - now) / 86_400_000);
}

// Urgency contribution in [0, NEEDED_BY_NEAR + NEEDED_BY_OVERDUE]: zero beyond
// the window, ramping linearly to NEAR at the date, then on to the cap once
// overdue. Continuous at d=0 and strictly decreasing in d, so the why-line's
// raw needed_by_days always explains the score. Exactly 0 when absent, so a
// node without needed_by scores byte-identically to before this term existed.
function neededByUrgency(days) {
  if (days == null || days >= NEEDED_BY_WINDOW_DAYS) return 0;
  if (days >= 0) return (NEEDED_BY_NEAR * (NEEDED_BY_WINDOW_DAYS - days)) / NEEDED_BY_WINDOW_DAYS;
  return NEEDED_BY_NEAR + (NEEDED_BY_OVERDUE * Math.min(-days, NEEDED_BY_WINDOW_DAYS)) / NEEDED_BY_WINDOW_DAYS;
}

// Per-person scope (task-cc-queue-assignee-filtering): the set of node ids a
// person carries — the union of work pointing an `assigned` edge AT them
// (work→person, schema-edge-assigned) and the nodes they steward (person→node,
// schema-edge-stewards). This is the per-person filter the seed schemas always
// promised ("per-person queues filter on it" — GRAPH.md, QUEUE.md §5), finally
// wired through. `assignee` is a person node id; null/absent means no filter
// (the queue is byte-identical to before this parameter existed). An id that
// no node is assigned to / stewarded by yields an EMPTY set — an empty queue,
// never an error — so a manager naming an unknown or departed person gets a
// truthful "nothing" rather than the whole team's work.
function assigneeScope(graph, assignee) {
  if (!assignee) return null;
  const set = new Set();
  // stewarded: the person node's own outbound `stewards` edges (person→node)
  for (const e of graph.nodes[assignee]?.edges ?? []) {
    if (e.type === "stewards" && graph.nodes[e.to]) set.add(e.to);
  }
  // assigned: any node pointing an `assigned` edge at this person (work→person)
  for (const n of Object.values(graph.nodes)) {
    for (const e of n.edges ?? []) {
      if (e.type === "assigned" && e.to === assignee) { set.add(n.id); break; }
    }
  }
  return set;
}

function personDisplayName(graph, id) {
  const n = graph && graph.nodes && graph.nodes[id];
  return n && n.type === "person" ? (n.name || n.title || n.email || id) : id;
}

// Reverse index of `blocks` edges: blockersOf[target] -> [sourceId, ...].
// Built once per rankQueue; blockers can be any node type, not just
// queueable ones.
function blockersIndex(graph) {
  const out = {};
  for (const n of Object.values(graph.nodes)) {
    for (const e of n.edges ?? []) {
      if (e.type === "blocks" && graph.nodes[e.to]) (out[e.to] ??= []).push(n.id);
    }
  }
  return out;
}

// Live blockers of a node: sources of inbound `blocks` edges that are live
// by status/supersession AND not retired by a live resolves edge — an
// already-resolved blocker gates nothing (cf. the gardener's inert-gate
// finding, which asks a human to retire the edge).
function liveBlockers(graph, id, blockersOf, resolvedBy) {
  const out = [];
  for (const bid of blockersOf[id] ?? []) {
    const b = graph.nodes[bid];
    if (isLive(b, graph.supersededBy, graph) && !resolvedBy[bid]) out.push(bid);
  }
  return out;
}

// Direct live targets of a node's OUTBOUND `blocks` edges — the requesters a
// blocker serves. Distinct from blockingCount's transitive total: this names
// the immediate work the dependency unblocks, which is what cross-project
// provenance renders (task-cc-xproject-dependency-loop). Returns node objects
// so the caller can read project/title.
function directLiveBlocks(graph, node, resolvedBy) {
  const out = [];
  for (const e of node.edges ?? []) {
    if (e.type !== "blocks") continue;
    const t = graph.nodes[e.to];
    if (t && isLive(t, graph.supersededBy, graph) && !resolvedBy[e.to]) out.push(t);
  }
  return out;
}

// Bare-reference inbound edges (task-spor-queue-held-guard-residual-reference-and-
// priority-front, fix a): relates-to / derived-from / mentions denote a weak
// association or loose provenance — a prior-art citation, an "informed by", a
// passing mention — NOT a work product produced while holding this task. Counting
// them as outcomes held-flagged ready, never-worked tasks that some unrelated
// artifact merely referenced, then `dispatch --from-queue` hard-skipped them (the
// residual the 194b252 referenced-resolver fix left, issue-spor-queue-held-guard-
// false-positive-referenced-outcome). The matched form is the canonical " (inbound)"
// mirror; aliases (related-to/derives-from) are already normalized to canonical
// before adj is built, so only the canonical spellings need listing here.
const REFERENCE_INBOUND_EDGES = new Set([
  "relates-to (inbound)",
  "derived-from (inbound)",
  "mentions (inbound)",
]);

// Held-task churn signature (task-spor-queue-front-loop-self-limit-on-held-tasks):
// does this node carry an inbound NON-resolving outcome — an artifact or decision
// recorded as a product of work ON the task? That is the structural mark of "work
// was recorded against this task, but nothing resolved it." Combined at the
// call site with the queue's standing guarantees — no live resolving edge (the
// node survived the resolvedBy retirement) and no live blocker — it identifies the
// front loop that never terminates (dec-cc-queue-front-from-attribution): a task
// held on an external gate has nothing to resolve, so each held pass writes a
// non-resolving outcome, which raises front, which re-surfaces the task, which
// triggers the next identical pass. Edge filtering, narrowest-first:
//   - `resolves`/`answers` inbound — a live resolving edge would already have
//     retired the node, and a pending (in-review, non-resolving-status) resolver is
//     a resolution in flight, not a held outcome (it keeps the task live by design,
//     dec-spor-definition-of-done-org-policy);
//   - `relates-to`/`derived-from`/`mentions` inbound — bare references, not outcomes
//     of work on the task (REFERENCE_INBOUND_EDGES, fix a). The surviving outcome
//     edge is `decided-in` (a choice reached while doing the task) and any future
//     strong work-product edge — a denylist so a new outcome edge counts by default.
// Superseded outcome nodes don't count — a withdrawn artifact records nothing. adj
// carries both directions (graph.js); the " (inbound)" suffix marks the reverse
// mirror, and `e.to` on a mirror is the edge's SOURCE.
function hasInboundOutcome(graph, id) {
  for (const e of graph.adj[id] ?? []) {
    if (!e.type.endsWith(" (inbound)")) continue;
    if (e.type === "resolves (inbound)" || e.type === "answers (inbound)") continue;
    if (REFERENCE_INBOUND_EDGES.has(e.type)) continue; // a bare reference, not a held outcome (fix a)
    const src = graph.nodes[e.to];
    if (!src || graph.supersededBy[src.id]) continue;
    if (src.type !== "artifact" && src.type !== "decision") continue;
    // ...but an inbound outcome that itself RESOLVES/ANSWERS another live node is a
    // completed work product of THAT node merely cross-referencing this task — e.g.
    // a sibling issue's resolution artifact naming this task as a related follow-up
    // — not a non-resolving outcome recorded against THIS task. Counting it held-
    // flags ready, never-worked work and then dispatch --from-queue hard-skips it
    // (issue-spor-queue-held-guard-false-positive-referenced-outcome). A genuine
    // held pass writes a NON-resolving artifact (no resolves edge), so it still counts.
    if (resolvesLiveNode(graph, src.id)) continue;
    return true;
  }
  return false;
}

// Outbound resolves/answers edge to a live (present, non-superseded) node?
// Outbound edges keep their plain type; inbound mirrors are " (inbound)"-suffixed,
// so a plain "resolves"/"answers" match is outbound-only. Used to tell a finished
// resolver of OTHER work from a loose non-resolving outcome (hasInboundOutcome).
function resolvesLiveNode(graph, id) {
  for (const e of graph.adj[id] ?? []) {
    if (e.type !== "resolves" && e.type !== "answers") continue;
    const tgt = graph.nodes[e.to];
    if (tgt && !graph.supersededBy[tgt.id]) return true;
  }
  return false;
}

// Agent-readiness (dec-spor-agent-readiness-derived-classification): a queue
// item carries a derived classification `readiness: agent|human|untriaged` plus
// `readiness_reasons[]`, computed STRUCTURALLY here in the render pass — never an
// LLM (the schema queueSignals hook can only add numbers to score, so it cannot
// carry this) and never graph state (a status overloads the lifecycle vocab, an
// edge has no natural target). It answers "can a coding agent complete this
// unattended, or does it need a human first?" Derivation, human-wins-over-agent:
//   human   — requires: human (the first consumer of the risk-class register,
//             schema-requires: work a human must do, unsatisfiable by any agent) ·
//             an `assigned → person` edge (it is that person's work) · held-task
//             state (the existing suggest:triage front self-limit — an outcome
//             recorded but nothing resolves it) · the item is itself an open
//             question or an unprocessed capture · an open (live, unanswered)
//             question node in its 1-hop neighborhood (a spec gap to close first).
//   agent   — an explicit `readiness: agent` stamp (with `readiness_by`
//             provenance, mirroring priority/priority_by, the ONE hand-set piece,
//             slice 2) · or an `assigned → agent` edge.
//   untriaged — otherwise. A deliberate third bucket: "nobody has checked the
//             spec" must default into neither agent nor human.
// human wins so a later open question or requires:human edit flips a stamped item
// back to human (derivation-with-override can't rot the way a pure hand flag
// would). `held` is the flag already computed in the scoring loop; `resolvedBy`
// retires answered questions so a neighbor question counts only while open.
//
// `withReasons` splits the two callers so the O(live-queue) scoring loop pays
// only for the enum it needs (the counts + filter), while the reason STRINGS —
// which surface only on the O(limit) rendered slice — are built lazily in the
// render pass (issue-cc-queue-percall-blend-latency-floor, whose deferred-render
// split this preserves). Without reasons the human path also short-circuits the
// neighborhood-question scan once human is already settled.
function deriveReadiness(graph, node, held, resolvedBy, withReasons = false) {
  const reasons = withReasons ? [] : null;
  let human = false;
  const addHuman = (r) => { human = true; if (reasons) reasons.push(r); };
  // requires: human — accept both the canonical list (`requires: [human]`) and a
  // bare scalar (`requires: human`, which the LIST_FIELDS parser leaves a string):
  // a human-only task misclassified as agent-ready is a risk-class SAFETY bypass
  // (schema-requires: `human` is unsatisfiable by any agent), so the guard must
  // not hinge on the author's list-vs-scalar spelling.
  if (requiresList(node).includes("human")) addHuman("requires human");
  // assigned → person / agent: the edge TARGET's node type decides the bucket.
  let assignedAgent = null;
  for (const e of node.edges ?? []) {
    if (e.type !== "assigned") continue;
    const t = graph.nodes[e.to];
    if (!t) continue;
    if (t.type === "person") addHuman(`assigned to ${e.to}`);
    else if (t.type === "agent") assignedAgent = assignedAgent ?? e.to;
  }
  if (held) addHuman("held task awaiting triage");
  if (node.type === "question") addHuman("open question awaiting an answer");
  else if (node.type === "capture-pending") addHuman("pending capture awaiting triage");
  // an open (live, unanswered) question in the 1-hop neighborhood — adj carries
  // both edge directions, so a question linked either way counts once. Skipped
  // once human is already settled and no reasons are being collected.
  if (!human || reasons) {
    const seenQ = new Set();
    for (const e of graph.adj[node.id] ?? []) {
      const nb = graph.nodes[e.to];
      if (!nb || nb.id === node.id || nb.type !== "question" || seenQ.has(nb.id)) continue;
      if (!isLive(nb, graph.supersededBy, graph) || resolvedBy[nb.id]) continue;
      seenQ.add(nb.id);
      addHuman(`open question ${nb.id} in neighborhood`);
    }
  }
  if (human) return { readiness: "human", reasons: reasons ?? [] };
  const agent = reasons;
  let isAgent = false;
  const stamp = typeof node.readiness === "string" ? node.readiness.trim().toLowerCase() : "";
  if (stamp === "agent") {
    isAgent = true;
    if (agent) {
      const by = typeof node.readiness_by === "string" ? node.readiness_by.trim() : "";
      agent.push(by ? `stamped agent-ready by ${by}` : "stamped agent-ready");
    }
  }
  if (assignedAgent) { isAgent = true; if (agent) agent.push(`assigned to agent ${assignedAgent}`); }
  if (isAgent) return { readiness: "agent", reasons: agent ?? [] };
  return { readiness: "untriaged", reasons: [] };
}

// A node's `requires:` risk-class list, tolerant of the author's spelling: the
// canonical LIST_FIELDS array (`requires: [human, shell]`), or a bare/comma
// scalar the parser left a string (`requires: human`). Empty when absent.
function requiresList(node) {
  const r = node.requires;
  if (Array.isArray(r)) return r;
  if (typeof r === "string") return r.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

// Single-node readiness (task-spor-dispatch-readiness-guard): the same
// classification rankQueue derives per item in its render pass, computed for
// ONE node outside a ranking pass — the shape `spor dispatch` needs to decide
// whether to warn or refuse before launching an agent at it. Recomputes
// exactly the two per-node inputs deriveReadiness needs (`held`, `resolvedBy`)
// the way the scoring loop does — front from the caller's `front` map (git-
// derived locally, lib/queue.js gitFront), live blockers from a fresh
// blockersIndex, hasInboundOutcome the same held-task churn signature — without
// any of the ranking loop's scoring/limit/filter machinery. Returns null for an
// unknown node id; otherwise `{readiness, reasons}` (deriveReadiness's shape,
// always with reasons — the render-pass cost this exists to pay once, not per
// queue slice).
function readinessOf(graph, nodeId, { front = null } = {}) {
  const node = graph.nodes[nodeId];
  if (!node) return null;
  const resolvedBy = resolution.resolutionMap(graph);
  const blockersOf = blockersIndex(graph);
  const blockers = liveBlockers(graph, nodeId, blockersOf, resolvedBy);
  const st = (node.status || "").toLowerCase();
  const held = (front?.[nodeId] ?? 0) > HELD_FRONT_FLOOR && node.type === "task" && (st === "" || st === "open")
    && blockers.length === 0 && hasInboundOutcome(graph, nodeId);
  return deriveReadiness(graph, node, held, resolvedBy, true);
}

// Readiness filter (dec-spor-agent-readiness-derived-classification "surfacing"):
// rankQueue({ readiness }) narrows the queue to items of the given derived
// class(es) — a string or array of agent|human|untriaged. A HARD scope filter
// like project/assignee/type (a non-matching item is out of scope, not counted).
// null/absent -> no filter, byte-identical to before this input existed. Unknown
// class names are dropped (an all-unknown filter yields an empty queue).
const READINESS_CLASSES = new Set(["agent", "human", "untriaged"]);
function readinessFilterSet(raw) {
  if (raw == null) return null;
  const list = (Array.isArray(raw) ? raw : [raw])
    .map((s) => String(s).trim().toLowerCase())
    .filter((s) => READINESS_CLASSES.has(s));
  return list.length ? new Set(list) : new Set(); // empty set => match nothing
}

// Activity on the node plus its direct (typed-edge) neighborhood.
function heatScore(graph, id, activity) {
  if (!activity) return 0;
  let h = activity[id] ?? 0;
  for (const e of graph.adj[id] ?? []) h += activity[e.to] ?? 0;
  return h;
}

// Fraction of this node's anchors that are superseded or missing. Like
// blockingCount this is a pure function of the graph's HEAD (edge structure +
// supersession), independent of every per-call input, so an optional `memo`
// (Map id->fraction) caches it across rankQueue calls on a resident graph
// (task-cc-rankqueue-staleness-date-memo). The cache lives on the graph object
// (queueIndex) and dies with reload/applyNode, so a hit returns the exact
// double a fresh scan produced (norm-cc-byte-identical-refactor).
function stalenessScore(graph, node, memo) {
  if (memo) { const c = memo.get(node.id); if (c !== undefined) return c; }
  const edges = node.edges ?? [];
  let v;
  if (!edges.length) v = 0;
  else {
    let stale = 0;
    for (const e of edges) {
      if (!graph.nodes[e.to] || graph.supersededBy[e.to]) stale++;
    }
    v = stale / edges.length;
  }
  if (memo) memo.set(node.id, v);
  return v;
}

// The node's `date` parsed to epoch ms, or null when absent/malformed/
// unparseable. HEAD-pure — only the `(now - t)` in ageDays is per-call — so the
// parse is cacheable by id (task-cc-rankqueue-staleness-date-memo). A cached
// `null` (no usable date) is distinguished from "uncached" by the `undefined`
// check, so a dateless node is parsed at most once.
function nodeDateMs(node, memo) {
  if (memo) { const c = memo.get(node.id); if (c !== undefined) return c; }
  let t = null;
  if (node.date && /^\d{4}-\d{2}-\d{2}/.test(node.date)) {
    const p = Date.parse(node.date);
    if (!Number.isNaN(p)) t = p;
  }
  if (memo) memo.set(node.id, t);
  return t;
}

function ageDays(node, now, memo) {
  const t = nodeDateMs(node, memo);
  if (t == null) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

// Priority attribution (issue-cc-priority-attribution-gap): the why-line used
// to hardcode "(human-set)" for any priority value, but `priority:` is
// ordinary frontmatter writable by any token-holder, so an agent-written p1
// silently masqueraded as human triage. The honest source is the optional
// `priority_by` stamp the server records when a priority is set (mirroring
// author/authored_via): "<name> via <door>". When it's present we attribute
// to it; when it's absent the source is simply unrecorded — never asserted to
// be human. A ranking dispute can now be audited from the why-line itself.
function priorityProvenance(node) {
  const by = typeof node.priority_by === "string" ? node.priority_by.trim() : "";
  return by ? `set by ${by}` : "source unrecorded";
}

// Cross-project provenance (task-cc-xproject-dependency-loop): a blocker/blocked
// relationship that crosses a project boundary names the OTHER side and its
// project, so a serving team sees who it serves and a requester sees its
// external dependency. Same-project relationships render exactly as before
// (id only, no "(project)" suffix), so existing why-lines and goldens are
// byte-identical. `blockerDescs` = [{id, project, cross}], `crossBlocking` =
// the cross-project subset of direct blocks targets = [{id, project}].
// `frontDays` is the rolling window the front count was measured over; the
// why-line states it verbatim ("N writes in the last D days") so a non-default
// window reads honestly instead of a hardcoded "this week"
// (task-cc-local-front-productionize).
function whyLine(signals, node, blockerDescs, crossBlocking, frontDays = FRONT_DEFAULT_DAYS, readiness = null) {
  const parts = [];
  // Agent-readiness leads the why-line when it is decisive (agent|human) — the
  // most actionable "can I dispatch this?" answer (dec-spor-agent-readiness-
  // derived-classification). untriaged rides no clause (byte-identical when no
  // readiness data exists), matching the ride-along posture of needed_by/heat.
  if (readiness && readiness.readiness === "human") parts.push(`needs human: ${readiness.reasons.join(", ")}`);
  else if (readiness && readiness.readiness === "agent") parts.push(`agent-ready: ${readiness.reasons.join(", ")}`);
  if (node.priority && PRIORITY_BUMP[node.priority]) parts.push(`priority ${node.priority} (${priorityProvenance(node)})`);
  if (blockerDescs?.length) {
    const names = blockerDescs.map((b) => (b.cross && b.project ? `${b.id} (${b.project})` : b.id)).join(", ");
    parts.push(`blocked by ${names} — do the unblocker first`);
  }
  if (signals.front > 0) parts.push(`your active front (${signals.front} write${signals.front === 1 ? "" : "s"} in the last ${frontDays} day${frontDays === 1 ? "" : "s"})`);
  if (signals.blocking > 0) {
    let s = `blocks ${signals.blocking} live node${signals.blocking === 1 ? "" : "s"}`;
    if (crossBlocking?.length) {
      const named = crossBlocking.slice(0, 3).map((t) => `${t.id} (${t.project})`).join(", ");
      const more = crossBlocking.length > 3 ? ` +${crossBlocking.length - 3} more` : "";
      s += ` across projects: ${named}${more}`;
    }
    parts.push(s);
  }
  if (signals.needed_by_days != null) {
    const d = signals.needed_by_days;
    parts.push(d < 0 ? `OVERDUE — needed by ${node.needed_by} (${-d}d ago)` : `needed by ${node.needed_by} (${d}d)`);
  }
  if (signals.heat > 0) parts.push(`neighborhood active (heat ${signals.heat})`);
  if (signals.cold_neighbors > 0) parts.push(`context moved around it (${signals.cold_neighbors} newer neighbor${signals.cold_neighbors === 1 ? "" : "s"})`);
  if (signals.age_days != null && signals.age_days > 0) parts.push(`${signals.age_days}d old`);
  if (signals.staleness >= STALE_SUGGEST_THRESHOLD) {
    parts.push(`${Math.round(signals.staleness * 100)}% of anchors superseded or gone — consider closing`);
  }
  if (node.type === "capture-pending") parts.push("unprocessed capture awaiting triage");
  return parts.join("; ") || "queueable and live";
}

// Org-specific signals: a schema's attached queueSignals(node, ctx) runs in
// the §2.4 sandbox (step 4) and may add named numeric signals; their sum
// joins the blend. Fail-soft — broken attached code annotates the item
// instead of sinking the queue. The sandbox engine is injected; a kernel
// caller that supplies none gets the same fail-soft annotation.
function attachedSignals(reg, node, baseSignals, neighbors, sandboxFor) {
  const schema = reg.nodeSchemas.get(node.type);
  if (!schema || !schema.code || !schema.code.queueSignals) return null;
  try {
    if (!sandboxFor) throw new Error("no sandbox engine provided");
    const out = sandboxFor(schema).call("queueSignals", [
      node,
      { neighbors, signals: baseSignals },
    ]);
    if (!out || typeof out !== "object") return null;
    const extra = {};
    for (const [k, v] of Object.entries(out)) {
      if (typeof v === "number" && Number.isFinite(v) && !(k in baseSignals)) extra[k] = v;
    }
    return Object.keys(extra).length ? { extra } : null;
  } catch (e) {
    return { error: String(e && e.message).slice(0, 120) };
  }
}

// HEAD-pure derived indexes the queue needs, memoized on the resident graph
// (task-cc-rankqueue-memoization). rankQueue rebuilt resolutionMap,
// openFindingsMap, blockersIndex, and a per-item transitive blockingCount on
// EVERY call — ~185ms at 50k nodes, dominated by the per-item work — even
// though every one of them is a pure function of the graph's HEAD, independent
// of the per-call inputs (now/leases/activity/viewer/project/filters). The
// server keeps the graph resident and only reloads when HEAD changes
// (dec-cc-defer-rust-rankqueue-kernel: the resident-graph principle, no wasm
// port), so these compute once and are reused across reads. Cache lifecycle is
// by graph identity, with no scheduler:
//   - a fresh buildGraph()/loadGraph() result carries no cache, so a full
//     reload self-invalidates (the new graph object simply has none);
//   - applyNode() — the in-place incremental write path — deletes the cache
//     (kernel/graph.js) since a mutation may change any blocks/resolves/
//     answers/finding edge, supersession, or status the maps depend on; the
//     next rankQueue rebuilds lazily.
// Keyed by a registry-global Symbol so it is invisible to Object.keys / JSON /
// spread (nothing enumerates the graph object) and graph.js can clear it
// without a require cycle back into queue.js. Outputs are byte-identical: the
// same pure functions over the same unchanged graph (norm-cc-byte-identical-
// refactor; the conformance queue goldens stand).
const QUEUE_INDEX = Symbol.for("spor.queue.derived-index");

function queueIndex(graph) {
  let idx = graph[QUEUE_INDEX];
  if (!idx) {
    idx = graph[QUEUE_INDEX] = {
      resolvedBy: resolution.resolutionMap(graph),
      findingsFor: resolution.openFindingsMap(graph),
      blockersOf: blockersIndex(graph),
      blockingCounts: new Map(), // id -> transitive live-blocking count, lazily filled
      stalenessScores: new Map(), // id -> edge-staleness fraction (HEAD-pure), lazily filled
      dateMs: new Map(), // id -> parsed node.date ms or null (HEAD-pure), lazily filled
    };
  }
  return idx;
}

// Eagerly populate the memoized index for a RESIDENT graph so the FIRST queue
// read after a HEAD change pays no index-build cost on the request path — the
// "compute at load/build time" half of task-cc-rankqueue-memoization. The
// server calls this from store.reload() (already an O(corpus) rebuild, so the
// warm is negligible against it and happens only when HEAD changes); the
// incremental write path deliberately does NOT warm — it invalidates and lets
// the next read rebuild lazily, keeping put_node latency flat
// (task-cc-spor-tier-2-scale). Fills blockingCounts plus the per-node HEAD-pure
// scoring pieces — edge-staleness and the parsed node.date
// (task-cc-rankqueue-staleness-date-memo) — for every queueable-live, unresolved
// node, the superset any project/assignee/type-filtered rankQueue draws from, so
// every later read is a pure cache hit. Returns the index.
function warmQueueIndex(graph) {
  const idx = queueIndex(graph);
  const reg = graph.registry;
  if (!reg || typeof reg.isQueueable !== "function") return idx;
  for (const node of Object.values(graph.nodes)) {
    if (!reg.isQueueable(node.type)) continue;
    if (!isLive(node, graph.supersededBy, graph)) continue;
    if (idx.resolvedBy[node.id]) continue; // retired by a live resolves/answers edge
    blockingCount(graph, node.id, idx.blockingCounts);
    stalenessScore(graph, node, idx.stalenessScores);
    nodeDateMs(node, idx.dateMs);
  }
  return idx;
}

// rankQueue(graph, { project?, assignee?, includeTypes?, excludeTypes?, readiness?, activity?, front?, leases?, now?, limit?, viewer?, sandboxFor?, timestamps? })
//   -> { items, count, counts_by_readiness?, muted?, dormant?, archived?, leased?, reserved?, blocked? }
// `includeTypes`/`excludeTypes` (task-cc-queue-filtering-enhancements) are
// node-type allow/deny lists applied as a HARD scope filter before scoring,
// like `project`/`assignee`: includeTypes keeps only those types, excludeTypes
// drops them (exclude wins on overlap), and a filtered-out node is out of scope,
// not counted. Empty/absent => no filter, byte-identical to before.
// `assignee` is a person node id (task-cc-queue-assignee-filtering): when set,
// the queue is scoped to the work that person carries — nodes with an outbound
// `assigned` edge to them, plus the nodes they `steward`. It answers a manager's
// "who is carrying what" / "what is X blocked on" from the ranked queue itself.
// A hard scope filter like `project` (not counted like mute/dormant); an
// unknown person id yields an empty queue, never an error.
// `archived` is the count of items hidden because their project node carries
// status: archived (issue-cc-project-lifecycle-queue-pollution) — graph-state
// retirement for every viewer, reported so the hiding is never silent.
// `blocked` is the count of items hidden because they have live inbound
// blockers (dec-spor-queue-hide-blocked, refining dec-cc-queue-blocked-
// demotion): a node gated by live work isn't actionable, so it leaves the
// queue rather than ranking demoted — `spor next` shouldn't list it and
// `spor dispatch --from-queue` must never pick it. Counted, not silent
// (parallel to leased/dormant); the capacity/steward read (assignee set) is
// EXEMPT, so "what is X blocked on" still surfaces blocked work there.
// `readiness` (dec-spor-agent-readiness-derived-classification) is an
// agent|human|untriaged value (or array) that HARD-filters the queue to items of
// that derived class, like `project`/`includeTypes` — a non-matching item is out
// of scope, not counted, and schema-approval items (outside the classification)
// are excluded. Every queue item is classified structurally in the render pass
// (requires:human / assigned→person / held / neighborhood questions / the item
// being a question or capture ⇒ human; a `readiness: agent` stamp or assigned→agent
// ⇒ agent; else untriaged), rides `readiness` + `readiness_reasons` on the item
// ONLY when decisive (agent|human), leads the why-line, and tallies the envelope's
// `counts_by_readiness` ({agent, human, untriaged}, over the WORK items only —
// schema-approval items are excluded — present only when there is readiness
// signal or a readiness filter). A graph with no readiness data yields no
// readiness fields, no clause, and no count — byte-identical to before.
// `viewer` is the authenticated caller's person node (viewerFor); its
// queue_mute register hides matching items for this viewer only, with the
// hidden count reported as `muted`. It is ALSO the lease-holder comparand:
// an in-force `leases` entry whose `by` is NOT this viewer is owner-exclusive
// (dec-cc-task-claim-lease) — dropped from the actionable list and counted as
// `leased` (Tier-1 live) / `reserved` (Tier-2 resumption reservation,
// dec-cc-task-resumption-reservation), unless this is a capacity/steward read
// (assignee set), which is exempt. `front` is the viewer's write-class
// activity map ({nodeId: count}, store.writeActivity) feeding the front
// signal; local callers may pass nothing and front is 0. `frontDays`
// (default 7) is the rolling window that map was measured over — it does not
// affect the count or score, only the why-line wording, which states it
// verbatim ("N writes in the last D days").
// `timestamps` is the git-derived per-node index ({id: {created_at, updated_at}},
// graph.timestamps from loadGraph, task-spor-git-derived-timestamp-index) the
// caller injects — like `front`, it is git-derived in the IO façade so the kernel
// stays pure. It feeds ONE signal, `cold_neighbors`: the count of an item's
// traversable neighbors whose updated_at is newer than its own ("cold node, hot
// neighborhood" — went cold while its neighborhood kept moving). It rides along
// ONLY when the index is injected AND the count is >0 (mirroring needed_by_days),
// so the signals shape, the score, and every why-line/golden are byte-identical
// when no index is passed (the conformance/buildGraph path injects none). It is
// surfaced-not-scored BY DECISION (dec-spor-cold-neighbors-suggestion-only,
// task-spor-cold-neighbors-weight-conformance): it contributes 0 to the default
// blend (signal + why-line only, the same posture staleness takes), because the
// direction is ambiguous (cold-with-moving-neighbors argues for revisit OR for
// closing) and the count scales with neighbor degree like heat once did
// (issue-cc-queue-blend-heat-dominance), so a default weight needs a chosen sign,
// log-compression, and empirical validation that the client has no harness for —
// the server gardener's cold-work finder already escalates genuine cold work as a
// ride-along finding. The raw count stays on signals.cold_neighbors so an org
// queue-policy rank() can weight it, and the conformance/cold-neighbors goldens
// lock the 0-weight contract (a future default weight is the change that moves
// them). `graph` is a buildGraph()/loadGraph() result (needs .registry). Items are
// ranked desc by the default blend; every item carries its raw signals so
// callers can re-rank. count is the pre-limit total.
// opts.sandboxFor: injectable sandbox engine for attached queueSignals()
// code — the server passes its hardened wasm engine (server/sandbox.js),
// the lib/queue.js façade defaults to the zero-dep node:vm engine.
function rankQueue(graph, opts = {}) {
  const { project = null, activity = null, front = null, leases = null, frontDays = FRONT_DEFAULT_DAYS, limit = DEFAULT_LIMIT, sandboxFor = null, viewer = null, assignee = null, timestamps = null } = opts;
  const now = opts.now ?? Date.now();
  // Agent-readiness filter (dec-spor-agent-readiness-derived-classification): a
  // hard scope narrow to agent|human|untriaged, applied at push time like
  // project/type. null => no filter, byte-identical to before this input existed.
  const readinessFilter = readinessFilterSet(opts.readiness);
  const reg = graph.registry;

  // Project identity (task-cc-project-identity-nodes): the filter, mute
  // entries, and each node's historical `project:` stamp all resolve through
  // the graph's slug-alias map before matching, so a rename heals queue
  // scoping without rewriting stamps. No project nodes -> identity, and the
  // queue behaves byte-for-byte as before.
  const rp = (s) => (s ? graph.projectAliases?.[s] ?? s : s);
  // Slug -> grouping up-resolution (dec-spor-queue-slug-resolves-to-grouping):
  // one shared resolver turns the filter into the Set of in-scope repo-node ids
  // (null = global) so the queue, the digest, and the brief inherit one
  // behavior — a BARE repo slug resolves UP to its home-project grouping and
  // unions the members (the intuitive token returns the product), a repo NODE
  // id pins the single repo (the escape hatch), a grouping id is used directly,
  // and an ungrouped repo (or unknown slug) falls back to itself. A graph with
  // no grouping layer yields a single-id set per slug — byte-for-byte as before.
  const scope = kgraph.scopeFor(graph, project);
  const inProject = (n) => !scope || scope.has(rp(n.project));
  // The single repo this read pins, or null when it spans a grouping (or is
  // global). Only an explicit single-repo look exempts an archived project from
  // hiding (below): a grouping view hides its archived members like the global
  // firehose does, and the repo-id escape hatch is how you still see one.
  const single = scope && scope.size === 1 ? scope.values().next().value : null;

  // Project end-of-life (issue-cc-project-lifecycle-queue-pollution): items
  // whose project node carries `status: archived` leave the queue for EVERY
  // viewer — one identity-level edit retires the project, vs the per-person
  // queue_mute that needs N people to each silence it. Excluded items are
  // counted as `archived` (parallel to muted/dormant) so the hiding is never
  // silent, and slug aliases still resolve so closed history stays reachable
  // in a project-scoped read. Explicitly asking for the archived project
  // (project=its slug) still ranks it — archival hides it from the firehose,
  // it doesn't make the project unviewable.
  const archived = graph.archivedProjects ?? new Set();
  const isArchived = (n) => archived.size > 0 && rp(n.project) !== single && archived.has(rp(n.project));

  const mutes = new Set([...activeMutes(viewer, now)].map(rp));
  const isMuted = (n) => mutes.has(rp(n.project)) || mutes.has(n.id);

  // Per-person scope (task-cc-queue-assignee-filtering): an `assignee` person id
  // narrows the queue to the work they carry (assigned/stewards). Null when
  // absent, so inAssignee is the identity filter and the queue is byte-identical
  // to before this parameter existed (norm-cc-byte-identical-refactor). Unlike
  // mute/dormant/archived, a non-matching node is simply out of scope (a hard
  // filter like `project`), so it isn't counted — the count describes this
  // person's queue, not what the filter hid from the firehose.
  const assigneeSet = assigneeScope(graph, assignee);
  const inAssignee = (n) => !assigneeSet || assigneeSet.has(n.id);

  // Node-type include/exclude (task-cc-queue-filtering-enhancements): whitelist
  // or blacklist node types FROM THE RANKING. `includeTypes` keeps only those
  // types; `excludeTypes` drops them; given both, the include set is narrowed
  // and then the excludes are removed from it (exclude wins on overlap). Like
  // `project`/`assignee` this is a HARD scope filter applied before scoring, so
  // a filtered-out node is simply out of scope — NOT counted like
  // mute/dormant/archived (the count describes the filtered queue, not what the
  // firehose hid). Empty/absent arrays => no filter, so the queue is
  // byte-identical to before these parameters existed
  // (norm-cc-byte-identical-refactor). The type compared is the type the item
  // surfaces AS: `schema` for a proposed-schema queue item, `node.type`
  // otherwise — so excluding `schema` hides schema-approval items too.
  const typeIncl = Array.isArray(opts.includeTypes) && opts.includeTypes.length ? new Set(opts.includeTypes) : null;
  const typeExcl = Array.isArray(opts.excludeTypes) && opts.excludeTypes.length ? new Set(opts.excludeTypes) : null;
  const inTypes = (t) => (!typeIncl || typeIncl.has(t)) && (!typeExcl || !typeExcl.has(t));

  // Task claim-lease (dec-cc-task-claim-lease / dec-cc-task-resumption-
  // reservation): an in-force `leases` entry held by ANOTHER viewer is
  // owner-exclusive — hidden from this viewer's actionable list, COUNTED. A
  // capacity/steward read (assignee set) is exempt: it deliberately surfaces a
  // named person's carried work, so the lease is shown there, not hidden.
  // `viewer.id` is the lease-holder comparand (the lease `by` is a person node
  // id, or an email for an unbound identity — same key holderFor() derives on
  // the server). No viewer + a populated table => every in-force lease is "held
  // by another," matching the firehose's they're-all-someone-else's read.
  const viewerHolder = viewer && viewer.id ? viewer.id : null;
  const stewardView = !!assigneeSet; // the capacity/steward read is lease-exempt

  let muted = 0;
  let dormant = 0;
  let archivedCount = 0;
  let leased = 0;   // hidden: Tier-1 live lease held by another viewer
  let reserved = 0; // hidden: Tier-2 resumption reservation held by another
  let blocked = 0;  // hidden: live inbound blockers (not actionable yet)

  // Actionability is a function of edges, not the hand-set status field
  // (issue-cc-status-lags-resolution-edges): an item retired by a live
  // inbound resolves/answers edge leaves the queue exactly as answered
  // questions already do — zero mutation, the status flip stays a human act
  // (the gardener's resolved-open finding nags for it). Open findings about
  // an item ride along so the consumer sees what the gardener already knows.
  // HEAD-pure derived indexes, memoized on the resident graph and reused across
  // reads (task-cc-rankqueue-memoization); recomputed lazily on a fresh/mutated
  // graph. Independent of the per-call inputs above, so caching is sound.
  const idx = queueIndex(graph);
  const { resolvedBy, findingsFor, blockersOf } = idx;

  const items = [];
  // Deferred per-item RENDER (issue-cc-queue-percall-blend-latency-floor,
  // lever 1): the presentation labels (suggest, the why-line and its blocker/
  // cross-project descriptors, the wake/lease/findings annotations) are built
  // AFTER sort+slice for just the `limit` items actually returned, not for every
  // live node. The only render input not cheap to recompute for the survivors is
  // each node's live-blocker set (already allocated for `blocked_by` and needed
  // for the cap pass over ALL items), so it rides in this id->blockers map; the
  // render pass recomputes node/lease/wake from the id. An entry's presence also
  // marks a normal (vs schema-approval) item for the render pass.
  const blockersById = new Map();
  // Held-task ids (task-spor-queue-front-loop-self-limit-on-held-tasks): computed
  // in the scoring loop (where the front damping is applied) and read in the
  // render pass to flip the suggestion do→triage. A Set, not a per-item field, so
  // a non-held item's serialized shape is byte-identical.
  const heldIds = new Set();
  // Agent-readiness (dec-spor-agent-readiness-derived-classification): the scoring
  // loop derives only the ENUM per pushed item — enough for the counts and the
  // hard filter — and the render pass re-derives the decisive items WITH reasons
  // for just the O(limit) slice, so the reason strings never allocate across the
  // whole live queue (issue-cc-queue-percall-blend-latency-floor). The tallies
  // feed the envelope's counts_by_readiness; schema-approval items are outside the
  // classification, so they are neither derived nor counted.
  const readinessCounts = { agent: 0, human: 0, untriaged: 0 };
  for (const node of Object.values(graph.nodes)) {
    // Schema-change proposals are queue items (§2.4/§5): a proposed schema
    // waits for a human to review the payload + attached code and flip its
    // status to active.
    if (node.type === "schema" && (node.status || "") === "proposed") {
      if (!inProject(node)) continue;
      if (!inAssignee(node)) continue;
      if (!inTypes("schema")) continue; // hard type scope, uncounted (like project)
      // Schema-approval items sit outside the readiness classification (they are
      // their own review lane, suggest:approve), so a readiness filter excludes
      // them — asking for agent|human|untriaged work never returns a schema.
      if (readinessFilter) continue;
      if (isArchived(node)) { archivedCount++; continue; }
      if (isMuted(node)) { muted++; continue; }
      const age = ageDays(node, now, idx.dateMs);
      items.push({
        id: node.id,
        title: node.title ?? null,
        type: "schema",
        status: "proposed",
        project: node.project ?? null,
        priority: null,
        score: Number((5 + Math.min((age ?? 0) / 30, 3)).toFixed(2)),
        signals: { blocking: 0, blocked_by: 0, front: front?.[node.id] ?? 0, heat: heatScore(graph, node.id, activity), staleness: 0, age_days: age },
        suggest: "approve",
        why: "schema change awaiting approval — review the payload and attached code, then set status: active",
      });
      continue;
    }
    if (!reg.isQueueable(node.type)) continue;
    if (!inProject(node)) continue;
    if (!inAssignee(node)) continue;
    if (!inTypes(node.type)) continue; // hard type scope, uncounted (like project)
    if (isArchived(node)) { archivedCount++; continue; } // counted, not silent
    if (!isLive(node, graph.supersededBy, graph)) continue;
    if (resolvedBy[node.id]) continue; // retired by a live resolves/answers edge
    const wake = wakeTime(node);
    if (wake != null && now < wake) { dormant++; continue; } // counted, not silent
    if (isMuted(node)) { muted++; continue; } // counted, not silent

    // Task claim-lease intersection (dec-cc-task-claim-lease,
    // dec-cc-task-resumption-reservation): an in-force lease held by ANOTHER
    // viewer is owner-exclusive — drop it from this viewer's actionable list and
    // COUNT it (leased = Tier-1 live, reserved = Tier-2 resumption reservation),
    // the same counted-not-silent demotion as mute/dormant/archived. A capacity/
    // steward read (assignee set) is exempt, so the lease is shown there ("in
    // progress / reserved by X"), not hidden. The viewer's OWN lease never hides
    // (their `front` floats it up); it only tags the item below.
    const lease = leaseState(leases, node.id, now);
    if (lease && lease.by !== viewerHolder && !stewardView) {
      if (lease.reserved) reserved++; else leased++;
      continue;
    }

    const blockers = liveBlockers(graph, node.id, blockersOf, resolvedBy);
    // Blocked items leave the ACTIONABLE queue (dec-spor-queue-hide-blocked,
    // refining the demote-but-show half of dec-cc-queue-blocked-demotion): a
    // node with live inbound blockers can't be worked until its unblocker
    // lands, so `spor next` shouldn't list it and `spor dispatch --from-queue`
    // must never pick it. Hidden and COUNTED (counted, not silent — parallel
    // to leased/dormant/archived); the unblocker still surfaces on its own.
    // The capacity/steward read (assignee set) is EXEMPT, the same exemption
    // leases use: "what is X blocked on" deliberately surfaces blocked work,
    // where the demotion/cap machinery below orders the unblocker first.
    if (blockers.length && !stewardView) { blocked++; continue; }
    const signals = {
      blocking: blockingCount(graph, node.id, idx.blockingCounts),
      blocked_by: blockers.length,
      front: front?.[node.id] ?? 0, // this node only — no neighborhood spread
      heat: heatScore(graph, node.id, activity),
      staleness: Number(stalenessScore(graph, node, idx.stalenessScores).toFixed(2)),
      age_days: ageDays(node, now, idx.dateMs),
    };
    // needed_by_days rides along ONLY when the node carries a deadline, so the
    // signals shape (and every existing why-line/golden) is unchanged without it.
    const nbDays = neededByDays(neededByTime(node), now);
    if (nbDays != null) signals.needed_by_days = nbDays;
    // cold_neighbors rides along the SAME way (task-spor-git-derived-timestamp-
    // index): only when a git-derived timestamp index was injected AND at least
    // one neighbor is newer than this node. Absent index -> key absent -> the
    // signals shape and goldens are byte-identical. Surfaced-not-scored by
    // decision (dec-spor-cold-neighbors-suggestion-only): it is NOT added to the
    // `score` below — it rides signals + the why-line only (see the rankQueue
    // doc). conformance/cold-neighbors locks that 0-weight contract.
    if (timestamps) {
      const cold = tsKernel.coldInHotNeighborhood(graph, node.id, timestamps);
      if (cold > 0) signals.cold_neighbors = cold;
    }
    // Held-task front self-limit (task-spor-queue-front-loop-self-limit-on-held-
    // tasks): an OPEN task (or status-less = live) with front from non-resolving
    // outcome writes — a recorded artifact/decision — but no live resolving edge
    // and no live blocker is held on an external gate with nothing to resolve, so
    // dec-cc-queue-front-from-attribution's "work X → X stays on top" loop never
    // terminates. Break it structurally: DON'T let front boost the score (damp it
    // to 0 — the way staleness contributes nothing to score and only flips the
    // suggestion), and the render pass flips its suggestion do→triage. Two guards
    // keep the flip off ready, never-started work (task-spor-queue-held-guard-
    // residual-reference-and-priority-front): front must clear HELD_FRONT_FLOOR (a
    // lone create + a priority bump is not churn — fix b) AND the inbound outcome
    // must be a real work product, not a bare relates-to/derived-from/mentions
    // reference (hasInboundOutcome, fix a). No live resolving edge is guaranteed
    // (resolvedBy retired those at the top of the loop); no live blocker holds in
    // the firehose (blocked items continue'd above) and is re-checked here for the
    // steward view. signals.front keeps the raw count so a queue-policy rank() can
    // still re-weight (the seam dec-cc-queue-front-from-attribution promised).
    const st = (node.status || "").toLowerCase();
    const held = signals.front > HELD_FRONT_FLOOR && node.type === "task" && (st === "" || st === "open")
      && blockers.length === 0 && hasInboundOutcome(graph, node.id);
    // Agent-readiness derivation (dec-spor-agent-readiness-derived-classification):
    // classify (enum only) before scoring so the readiness filter can skip a
    // non-matching item as a hard scope filter (uncounted, like project/type) and
    // never pays for its score/attached-code. `held` is available here; heldIds is
    // only stamped for items that survive the filter. Reasons are built in the
    // render pass for the sliced items, not here.
    const readiness = deriveReadiness(graph, node, held, resolvedBy).readiness;
    if (readinessFilter && !readinessFilter.has(readiness)) continue;
    if (held) heldIds.add(node.id);
    readinessCounts[readiness]++;
    const bump = PRIORITY_BUMP[node.priority] ?? 0;
    let score = bump + 3 * signals.blocking - 3 * signals.blocked_by +
      (held ? 0 : Math.min(Math.log2(1 + signals.front), 5)) +
      Math.log2(1 + signals.heat) +
      Math.min((signals.age_days ?? 0) / 30, 3) +
      neededByUrgency(nbDays);

    // org-specific signals from attached queueSignals() code, if any
    const attached = attachedSignals(reg, node, signals, (graph.adj[node.id] ?? []).map((e) => e.to), sandboxFor);
    if (attached?.extra) {
      Object.assign(signals, attached.extra);
      score += Object.values(attached.extra).reduce((a, b) => a + b, 0);
    }
    if (attached?.error) signals.queue_signals_error = attached.error;

    // Ranking fields only; the presentation labels (suggest/why/blocked_by/
    // lease/findings) are deferred to the post-slice render pass below
    // (issue-cc-queue-percall-blend-latency-floor). Keys are inserted in the
    // same order render later appends to, so the serialized item is unchanged.
    const item = {
      id: node.id,
      title: node.title ?? null,
      type: node.type,
      status: node.status ?? null,
      project: node.project ?? null,
      priority: node.priority ?? null,
      score: Number(score.toFixed(2)),
      signals,
    };
    blockersById.set(node.id, blockers);
    items.push(item);
  }

  // A blocked item never outranks a live blocker present in the same
  // ranking (issue-cc-queue-ranking-asymmetry): heat is neighborhood-shared,
  // so the additive penalty alone can't promise the unblocker surfaces
  // first — cap the blocked item's score just below its blocker's. Iterate
  // for blocks-chains; the pass bound also cuts pathological cycles.
  const byId = new Map(items.map((it) => [it.id, it]));
  for (let pass = 0; pass < 10; pass++) {
    let changed = false;
    for (const it of items) {
      // blockers ride in blockersById until render re-adds `blocked_by` post-slice
      // (deferred render); schema-approval items aren't in the map -> no blockers.
      for (const bid of blockersById.get(it.id) ?? []) {
        const blocker = byId.get(bid);
        if (blocker && it.score >= blocker.score) {
          it.score = Number((blocker.score - 0.01).toFixed(2));
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  // org-defined blend: a queue-policy schema's rank(items) re-scores the
  // whole list. Each item already carries its signals and default-blend
  // score, so a policy can blend, override, or pass through selectively.
  // Accepts [{id, score}] or a {id: score} map; non-finite or unknown ids
  // are ignored (an item the policy doesn't mention keeps its default).
  let policy = null;
  const policySchema = reg.queuePolicy;
  if (policySchema && policySchema.code && policySchema.code.rank) {
    policy = { id: policySchema.id, applied: false };
    try {
      if (!sandboxFor) throw new Error("no sandbox engine provided");
      const out = sandboxFor(policySchema).call("rank", [items]);
      const scores = Array.isArray(out)
        ? Object.fromEntries(out.filter((e) => e && typeof e.id === "string").map((e) => [e.id, e.score]))
        : out;
      if (!scores || typeof scores !== "object") {
        throw new Error("rank() must return [{id, score}] or a {id: score} map");
      }
      for (const it of items) {
        const s = scores[it.id];
        if (typeof s === "number" && Number.isFinite(s)) it.score = Number(s.toFixed(2));
      }
      policy.applied = true;
    } catch (e) {
      policy.error = String(e && e.message).slice(0, 160);
    }
  }

  items.sort((a, b) =>
    b.score - a.score ||
    (b.signals.age_days ?? 0) - (a.signals.age_days ?? 0) ||
    (a.id < b.id ? -1 : 1));

  // Render pass (issue-cc-queue-percall-blend-latency-floor, lever 1): build the
  // presentation labels for ONLY the items the slice returns. The same labels the
  // per-node loop used to build for every live node — suggest, the why-line with
  // its blocker/cross-project descriptors, the wake/lease/findings annotations,
  // and the re-added `blocked_by` — now cost O(limit), not O(live queue), cutting
  // the per-call string/array allocations that drove the p95/p99 GC tail. Each
  // appended key lands in its original position, so a returned item is
  // byte-identical (norm-cc-byte-identical-refactor). Schema-approval items carry
  // a constant why and aren't in blockersById, so they're left as rendered inline.
  const top = items.slice(0, Math.max(0, limit));
  for (const item of top) {
    const blockers = blockersById.get(item.id);
    if (blockers === undefined) continue; // schema-approval item: rendered inline
    const node = graph.nodes[item.id];
    // lease/wake are cheap to recompute for the survivors from the same `now`,
    // so they aren't retained per node; identical to the loop's computation.
    const lease = leaseState(leases, node.id, now);
    const wake = wakeTime(node);
    const signals = item.signals;
    // staleness wins (closing retires the item, blocked or not), then blocked —
    // an item gated by live work isn't actionable either way — then held (the
    // front self-limit: an outcome recorded but nothing resolves or gates it, so
    // close the loop rather than redo the work, task-spor-queue-front-loop-self-
    // limit-on-held-tasks). held requires no blocker, so it never collides with
    // "blocked"; "close" (staleness) still wins because closing IS one of the
    // triage actions and the stronger advice.
    item.suggest = signals.staleness >= STALE_SUGGEST_THRESHOLD ? "close"
      : blockers.length ? "blocked"
      : heldIds.has(item.id) ? "triage" : "do";
    // Agent-readiness ride-along (dec-spor-agent-readiness-derived-classification):
    // annotate, never hide — a needs-human item stays ranked (it is the owner's
    // work), it just carries the classification and its reasons. Re-derived WITH
    // reasons for this sliced item only (the enum matches the loop's — a pure
    // function of the same graph/held/resolvedBy). Emitted ONLY when decisive
    // (agent|human); an untriaged item adds no keys, so the item is byte-identical
    // when no readiness data exists (the needed_by/cold_neighbors ride-along
    // posture). The why-line clause is added via whyLine below.
    const rd = deriveReadiness(graph, node, heldIds.has(item.id), resolvedBy, true);
    if (rd.readiness !== "untriaged") {
      item.readiness = rd.readiness;
      item.readiness_reasons = rd.reasons;
    }
    // Agent-ready items suggest DISPATCH (dec-spor-agent-readiness-derived-
    // classification, issue-spor-suggest-dispatch-specified-not-emitted): an item
    // classified agent-ready and otherwise plain-actionable ("do") is exactly the
    // work to hand to an agent, so upgrade the disposition to "dispatch". Only when
    // the base suggestion is "do" — close/blocked/triage (and schema "approve") are
    // triage dispositions that stay supreme, never overridden by readiness.
    if (item.suggest === "do" && rd.readiness === "agent") item.suggest = "dispatch";
    // Cross-project provenance descriptors for the why-line: blockers carry their
    // project (annotated only when it differs), and the direct blocks targets in
    // another project name who this dependency serves.
    const ownProject = node.project ?? null;
    const blockerDescs = blockers.map((id) => {
      const p = graph.nodes[id]?.project ?? null;
      return { id, project: p, cross: p !== ownProject };
    });
    const crossBlocking = directLiveBlocks(graph, node, resolvedBy)
      .filter((t) => (t.project ?? null) !== ownProject)
      .map((t) => ({ id: t.id, project: t.project ?? null }));
    item.why = whyLine(signals, node, blockerDescs, crossBlocking, frontDays, rd);
    // Held-task self-limit note (task-spor-queue-front-loop-self-limit-on-held-
    // tasks): the relocated warning — front kept re-surfacing it, but nothing
    // resolves or gates it, so name the four de-queue actions rather than redo it.
    if (item.suggest === "triage") item.why += "; outcome recorded but nothing resolves it — close the loop (resolve, gate with blocked-by, set wake, or abandon)";
    if (wake != null) item.why += `; woke ${node.wake} (was dormant)`;
    if (blockers.length) item.blocked_by = blockers;
    // A surviving lease rides along as `lease_state` so the consumer can render
    // it (dec-cc-task-claim-lease's "demoted-not-erased" / the steward view's
    // "in progress by X"). Only two ways an item gets here with a lease: the
    // viewer holds it (their own queue), or this is the lease-exempt steward
    // read. Tier-1 live -> "in progress", Tier-2 reservation -> "reserved"; the
    // owner sees "yours", a steward sees "by <holder>". Counted demotions
    // (held by another, hidden) never reach here — they `continue`d above.
    if (lease) {
      const mine = lease.by === viewerHolder;
      item.lease_state = lease.reserved ? "reserved" : "in_progress";
      item.lease_by = lease.by;
      item.lease_by_name = personDisplayName(graph, lease.by);
      const label = lease.reserved ? "reserved" : "in progress";
      item.why += mine ? `; ${label} (your claim)` : `; ${label} by ${item.lease_by_name}`;
    }
    const flagged = findingsFor[node.id];
    if (flagged?.length) {
      item.findings = flagged.map((f) => f.id);
      item.why += `; ${flagged.length} open gardener finding${flagged.length === 1 ? "" : "s"}: ${item.findings.join(", ")}`;
    }
  }

  const r = { items: top, count: items.length };
  // counts_by_readiness (dec-spor-agent-readiness-derived-classification): the
  // aggregate readiness breakdown of the ranked WORK items — the headline answer
  // to "how much of my queue can an agent take right now?" Emitted only when the
  // breakdown is meaningful: at least one agent/human item, OR the caller asked
  // for a readiness facet. On a graph with no readiness data (all untriaged, no
  // filter) it is absent, so the envelope is byte-identical (parallel to
  // muted/blocked, which ride along only when > 0). It tallies the post-filter
  // WORK items only: schema-approval items ride their own approve lane and are
  // NOT classified, so agent+human+untriaged equals `count` MINUS any queued
  // proposed-schema items (equal to `count` on the common schema-free queue).
  if (readinessCounts.agent > 0 || readinessCounts.human > 0 || readinessFilter) {
    r.counts_by_readiness = { agent: readinessCounts.agent, human: readinessCounts.human, untriaged: readinessCounts.untriaged };
  }
  if (muted > 0) r.muted = muted;
  if (dormant > 0) r.dormant = dormant;
  if (archivedCount > 0) r.archived = archivedCount;
  // Owner-exclusive demotions (dec-cc-task-claim-lease): counted, not silent —
  // the steward/capacity view (assignee set) re-surfaces what these hid.
  if (leased > 0) r.leased = leased;
  if (reserved > 0) r.reserved = reserved;
  // Blocked-out demotions (dec-spor-queue-hide-blocked): counted, not silent —
  // the steward/capacity view (assignee set) re-surfaces what these hid.
  if (blocked > 0) r.blocked = blocked;
  if (policy) r.policy = policy;
  return r;
}

module.exports = {
  rankQueue, warmQueueIndex, wakeTime, PRIORITY_BUMP, DEFAULT_LIMIT, deriveReadiness, readinessOf,
  // Exposed for other pure kernels walking `blocks` topology (e.g.
  // kernel/program.js's gating-tree walk) so the live/blocked test stays ONE
  // definition rather than a second copy drifting from this one.
  blockersIndex, isLive, liveBlockers,
};

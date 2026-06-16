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
//               terminates (dec-cc-queue-front-from-attribution). The why-line
//               states the actual window (`frontDays`), not a fixed "this
//               week".
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

const PRIORITY_BUMP = { p1: 6, p2: 3, p3: 1 };
const STALE_SUGGEST_THRESHOLD = 0.5;
const DEFAULT_LIMIT = 20;
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
// (dec-cc-terminal-status-single-source) — no local list.
function isLive(node, supersededBy) {
  if (supersededBy[node.id]) return false;
  return !resolution.isTerminalStatus(node.status);
}

// Distinct live nodes transitively reachable over OUTBOUND `blocks` edges
// (GRAPH.md: `n blocks t` == t cannot proceed until n does).
function blockingCount(graph, id) {
  const seen = new Set();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    for (const e of graph.nodes[cur]?.edges ?? []) {
      if (e.type !== "blocks" || seen.has(e.to)) continue;
      const t = graph.nodes[e.to];
      if (!t) continue;
      seen.add(e.to);
      if (isLive(t, graph.supersededBy)) stack.push(e.to);
    }
  }
  let live = 0;
  for (const tid of seen) if (isLive(graph.nodes[tid], graph.supersededBy)) live++;
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
    if (isLive(b, graph.supersededBy) && !resolvedBy[bid]) out.push(bid);
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
    if (t && isLive(t, graph.supersededBy) && !resolvedBy[e.to]) out.push(t);
  }
  return out;
}

// Activity on the node plus its direct (typed-edge) neighborhood.
function heatScore(graph, id, activity) {
  if (!activity) return 0;
  let h = activity[id] ?? 0;
  for (const e of graph.adj[id] ?? []) h += activity[e.to] ?? 0;
  return h;
}

// Fraction of this node's anchors that are superseded or missing.
function stalenessScore(graph, node) {
  const edges = node.edges ?? [];
  if (!edges.length) return 0;
  let stale = 0;
  for (const e of edges) {
    if (!graph.nodes[e.to] || graph.supersededBy[e.to]) stale++;
  }
  return stale / edges.length;
}

function ageDays(node, now) {
  if (!node.date || !/^\d{4}-\d{2}-\d{2}/.test(node.date)) return null;
  const t = Date.parse(node.date);
  if (Number.isNaN(t)) return null;
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
function whyLine(signals, node, blockerDescs, crossBlocking, frontDays = FRONT_DEFAULT_DAYS) {
  const parts = [];
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

// rankQueue(graph, { project?, assignee?, includeTypes?, excludeTypes?, activity?, front?, leases?, now?, limit?, viewer?, sandboxFor? })
//   -> { items, count, muted?, dormant?, archived?, leased?, reserved? }
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
// `graph` is a buildGraph()/loadGraph() result (needs .registry). Items are
// ranked desc by the default blend; every item carries its raw signals so
// callers can re-rank. count is the pre-limit total.
// opts.sandboxFor: injectable sandbox engine for attached queueSignals()
// code — the server passes its hardened wasm engine (server/sandbox.js),
// the lib/queue.js façade defaults to the zero-dep node:vm engine.
function rankQueue(graph, opts = {}) {
  const { project = null, activity = null, front = null, leases = null, frontDays = FRONT_DEFAULT_DAYS, limit = DEFAULT_LIMIT, sandboxFor = null, viewer = null, assignee = null } = opts;
  const now = opts.now ?? Date.now();
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

  // Actionability is a function of edges, not the hand-set status field
  // (issue-cc-status-lags-resolution-edges): an item retired by a live
  // inbound resolves/answers edge leaves the queue exactly as answered
  // questions already do — zero mutation, the status flip stays a human act
  // (the gardener's resolved-open finding nags for it). Open findings about
  // an item ride along so the consumer sees what the gardener already knows.
  const resolvedBy = resolution.resolutionMap(graph);
  const findingsFor = resolution.openFindingsMap(graph);
  const blockersOf = blockersIndex(graph);

  const items = [];
  for (const node of Object.values(graph.nodes)) {
    // Schema-change proposals are queue items (§2.4/§5): a proposed schema
    // waits for a human to review the payload + attached code and flip its
    // status to active.
    if (node.type === "schema" && (node.status || "") === "proposed") {
      if (!inProject(node)) continue;
      if (!inAssignee(node)) continue;
      if (!inTypes("schema")) continue; // hard type scope, uncounted (like project)
      if (isArchived(node)) { archivedCount++; continue; }
      if (isMuted(node)) { muted++; continue; }
      const age = ageDays(node, now);
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
    if (!isLive(node, graph.supersededBy)) continue;
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
    const signals = {
      blocking: blockingCount(graph, node.id),
      blocked_by: blockers.length,
      front: front?.[node.id] ?? 0, // this node only — no neighborhood spread
      heat: heatScore(graph, node.id, activity),
      staleness: Number(stalenessScore(graph, node).toFixed(2)),
      age_days: ageDays(node, now),
    };
    // needed_by_days rides along ONLY when the node carries a deadline, so the
    // signals shape (and every existing why-line/golden) is unchanged without it.
    const nbDays = neededByDays(neededByTime(node), now);
    if (nbDays != null) signals.needed_by_days = nbDays;
    // Cross-project provenance descriptors for the why-line: blockers carry
    // their project (annotated only when it differs), and the direct blocks
    // targets in another project name who this dependency serves.
    const ownProject = node.project ?? null;
    const blockerDescs = blockers.map((id) => {
      const p = graph.nodes[id]?.project ?? null;
      return { id, project: p, cross: p !== ownProject };
    });
    const crossBlocking = directLiveBlocks(graph, node, resolvedBy)
      .filter((t) => (t.project ?? null) !== ownProject)
      .map((t) => ({ id: t.id, project: t.project ?? null }));
    const bump = PRIORITY_BUMP[node.priority] ?? 0;
    let score = bump + 3 * signals.blocking - 3 * signals.blocked_by +
      Math.min(Math.log2(1 + signals.front), 5) +
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

    const item = {
      id: node.id,
      title: node.title ?? null,
      type: node.type,
      status: node.status ?? null,
      project: node.project ?? null,
      priority: node.priority ?? null,
      score: Number(score.toFixed(2)),
      signals,
      // staleness wins (closing retires the item, blocked or not), then
      // blocked — an item gated by live work isn't actionable either way.
      suggest: signals.staleness >= STALE_SUGGEST_THRESHOLD ? "close"
        : blockers.length ? "blocked" : "do",
      why: whyLine(signals, node, blockerDescs, crossBlocking, frontDays),
    };
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
      const label = lease.reserved ? "reserved" : "in progress";
      item.why += mine ? `; ${label} (your claim)` : `; ${label} by ${lease.by}`;
    }
    const flagged = findingsFor[node.id];
    if (flagged?.length) {
      item.findings = flagged.map((f) => f.id);
      item.why += `; ${flagged.length} open gardener finding${flagged.length === 1 ? "" : "s"}: ${item.findings.join(", ")}`;
    }
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
      for (const bid of it.blocked_by ?? []) {
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

  const r = { items: items.slice(0, Math.max(0, limit)), count: items.length };
  if (muted > 0) r.muted = muted;
  if (dormant > 0) r.dormant = dormant;
  if (archivedCount > 0) r.archived = archivedCount;
  // Owner-exclusive demotions (dec-cc-task-claim-lease): counted, not silent —
  // the steward/capacity view (assignee set) re-surfaces what these hid.
  if (leased > 0) r.leased = leased;
  if (reserved > 0) r.reserved = reserved;
  if (policy) r.policy = policy;
  return r;
}

module.exports = { rankQueue, PRIORITY_BUMP, DEFAULT_LIMIT };

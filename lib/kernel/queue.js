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
//               edges, status flips, captures during it) over the last week,
//               INJECTED per-identity by the server from the same journal
//               (store.writeActivity). Counts the node itself only — no
//               neighborhood propagation — so provenance hubs can't ride it,
//               and the blend caps it below the p1 bump: human priority >
//               demonstrated front > structure > ambient heat. Working a
//               node keeps it surfaced; finishing it still retires it via
//               resolves edges, so the continuity loop terminates
//               (dec-cc-queue-front-from-attribution).
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
//           + min(log2(1+front), 5) + log2(1+heat) + min(age/30, 3),
//           then capped below any live blocker in the list
// No scoring formula owns the ranking: an org replaces the blend with a
// `kind: queue-policy` schema node whose attached rank(items) returns new
// scores (QUEUE.md §4/§8). The policy runs once per rankQueue over the full
// item list (signals already computed), in the same sandbox as all attached
// code, and is fail-soft — a broken policy annotates the result and the
// built-in blend stands.

const resolution = require("./resolution.js");

const PRIORITY_BUMP = { p1: 6, p2: 3, p3: 1 };
const STALE_SUGGEST_THRESHOLD = 0.5;
const DEFAULT_LIMIT = 20;

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

function whyLine(signals, node, blockerIds) {
  const parts = [];
  if (node.priority && PRIORITY_BUMP[node.priority]) parts.push(`priority ${node.priority} (human-set)`);
  if (blockerIds?.length) parts.push(`blocked by ${blockerIds.join(", ")} — do the unblocker first`);
  if (signals.front > 0) parts.push(`your active front (${signals.front} write${signals.front === 1 ? "" : "s"} this week)`);
  if (signals.blocking > 0) parts.push(`blocks ${signals.blocking} live node${signals.blocking === 1 ? "" : "s"}`);
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

// rankQueue(graph, { project?, activity?, front?, now?, limit?, viewer?, sandboxFor? })
//   -> { items, count, muted?, dormant? }
// `viewer` is the authenticated caller's person node (viewerFor); its
// queue_mute register hides matching items for this viewer only, with the
// hidden count reported as `muted`. `front` is the viewer's write-class
// activity map ({nodeId: count}, store.writeActivity) feeding the front
// signal; local callers may pass nothing and front is 0.
// `graph` is a buildGraph()/loadGraph() result (needs .registry). Items are
// ranked desc by the default blend; every item carries its raw signals so
// callers can re-rank. count is the pre-limit total.
// opts.sandboxFor: injectable sandbox engine for attached queueSignals()
// code — the server passes its hardened wasm engine (server/sandbox.js),
// the lib/queue.js façade defaults to the zero-dep node:vm engine.
function rankQueue(graph, opts = {}) {
  const { project = null, activity = null, front = null, limit = DEFAULT_LIMIT, sandboxFor = null, viewer = null } = opts;
  const now = opts.now ?? Date.now();
  const reg = graph.registry;

  // Project identity (task-cc-project-identity-nodes): the filter, mute
  // entries, and each node's historical `project:` stamp all resolve through
  // the graph's slug-alias map before matching, so a rename heals queue
  // scoping without rewriting stamps. No project nodes -> identity, and the
  // queue behaves byte-for-byte as before.
  const rp = (s) => (s ? graph.projectAliases?.[s] ?? s : s);
  const projectKey = rp(project);
  const inProject = (n) => !project || rp(n.project) === projectKey;

  const mutes = new Set([...activeMutes(viewer, now)].map(rp));
  const isMuted = (n) => mutes.has(rp(n.project)) || mutes.has(n.id);
  let muted = 0;
  let dormant = 0;

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
    if (!isLive(node, graph.supersededBy)) continue;
    if (resolvedBy[node.id]) continue; // retired by a live resolves/answers edge
    const wake = wakeTime(node);
    if (wake != null && now < wake) { dormant++; continue; } // counted, not silent
    if (isMuted(node)) { muted++; continue; } // counted, not silent

    const blockers = liveBlockers(graph, node.id, blockersOf, resolvedBy);
    const signals = {
      blocking: blockingCount(graph, node.id),
      blocked_by: blockers.length,
      front: front?.[node.id] ?? 0, // this node only — no neighborhood spread
      heat: heatScore(graph, node.id, activity),
      staleness: Number(stalenessScore(graph, node).toFixed(2)),
      age_days: ageDays(node, now),
    };
    const bump = PRIORITY_BUMP[node.priority] ?? 0;
    let score = bump + 3 * signals.blocking - 3 * signals.blocked_by +
      Math.min(Math.log2(1 + signals.front), 5) +
      Math.log2(1 + signals.heat) +
      Math.min((signals.age_days ?? 0) / 30, 3);

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
      why: whyLine(signals, node, blockers),
    };
    if (wake != null) item.why += `; woke ${node.wake} (was dormant)`;
    if (blockers.length) item.blocked_by = blockers;
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
  if (policy) r.policy = policy;
  return r;
}

module.exports = { rankQueue, PRIORITY_BUMP, DEFAULT_LIMIT };

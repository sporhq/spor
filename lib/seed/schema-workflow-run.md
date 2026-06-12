---
id: schema-workflow-run
type: schema
kind: node-schema
schema_version: 2026.06.11.1
title: Seed schema for workflow-run nodes
summary: Node schema for the workflow-run type — one node per execution, carrying the org-meaningful state of that run (per-step status, claimants, verdicts, outcome) and its lineage (performs the workflow, triggered-by the cause). Live runs are queueable so STUCK runs (held, or a step idle past a staleness threshold) surface in the decision queue. Seed-pack default; a graph-resident schema node overrides it.
date: 2026-06-11
---

Seed schema for the `workflow-run` node type (ontology in GRAPH.md; the
claim/complete run contract is API.md §3.1), shipped with
the plugin as a registry default (QUEUE.md §2). A `type: schema` node in the
graph with `kind: node-schema` and the same `node_type` overrides this entry.

Starting a workflow creates one run node, written through the ordinary
attributed path. Its body holds a fenced `json` block with the
org-meaningful state: `reducer_state` (per-step status, claimant identity,
gate verdicts, final outcome — the pure machine's state from the server's run reducer),
`lease_seq` (the monotonic lease-generation counter), and
`workflow_version` (the workflow node's revision, pinned at start so a
workflow edit mid-run does not change a live run).

`queueable: true` with `queueSignals()` surfacing *stuck* runs: a `held`
run (a crashed `route()`, fail-closed), or a step left
`claimed`/`ready` past a staleness threshold — the cold-work finding,
mechanized for automation. A completed run goes terminal (`succeeded` /
`failed` / `cancelled`) and leaves the queue like any done task.
`capturable: false` — runs are created by the engine, never from raw text.

```json
{
  "node_type": "workflow-run",
  "description": "one execution of a workflow — its org-meaningful state and lineage; live runs surface in the queue when stuck",
  "prefix": ["run-"],
  "queueable": true,
  "capturable": false,
  "fields": {
    "status": { "enum": ["running", "held", "succeeded", "failed", "cancelled"] }
  }
}
```

```js
// transitions(current, proposed, view) — the engine-managed guard
// (engine-managed — do not hand-edit; the run engine revision-checks every
// advance via the claim/complete API, API.md §3.1). Runs on every UPDATE in the §2.4 sandbox,
// JSON boundary, pure. view.actor is the authenticated identity performing the
// write; view.actor.via is the write channel the server stamps.
//
// Rule: a workflow-run node may only be UPDATED through the run engine, which
// writes with `via: "workflow"`. Any ordinary PUT /v1/nodes update (via
// "rest"/"mcp"/anything else) is denied, so the lease invariant ("only the
// live lease can complete") cannot be sidestepped by hand-rewriting
// reducer_state through the supported API — flipping a step to succeeded,
// forging completed_by, or erasing a lease (review finding 4). The trusted git
// hand-edit path bypasses this exactly as it bypasses every other attached
// gate (no via stamp, no server in the loop) — that is the acknowledged
// admin escape hatch, not a hole. CREATE is untouched (the engine creates run
// nodes); this gate only governs the in-flight UPDATE path.
export function transitions(current, proposed, view) {
  // No `current` means this is not an update of an existing run (creates are
  // handled by the store's create path, not this gate) — allow.
  if (!current) return { allow: true };
  const via = view && view.actor && view.actor.via;
  if (via === "workflow") return { allow: true };
  return {
    allow: false,
    reason: "workflow-run nodes are engine-managed: state advances only through the run engine (claim/complete), not direct node edits — a hand-written PUT cannot rewrite reducer_state, forge completed_by, or erase a lease (API.md §3.1). An admin may still hand-edit via the trusted git path.",
  };
}
```

```js
// queueSignals(node, ctx) — org-specific queue signals for live runs
// (stuck-run surfacing, API.md §3.1). Runs in the §2.4 sandbox, JSON boundary, pure: no clock.
// ctx = { neighbors, signals } where signals carries the base blend's
// numbers — notably signals.age_days and signals.staleness (recency of the
// run node's last write). rankQueue only calls this for LIVE (non-terminal)
// nodes, so reaching here already means the run is running or held.
//
// Modest by design: a held run is the loudest stuck signal; a running run
// whose node has not been touched in a while (high age / staleness) is the
// cold-run signal. Both add a numeric bump that joins the blend. Step-level
// detail is read from the reducer_state in the body when present.
export function queueSignals(node, ctx) {
  const out = {};

  if ((node.status || "") === "held") {
    // a crashed route() or operator hold — needs a human to clear it.
    out.run_held = 8;
  }

  const signals = (ctx && ctx.signals) || {};
  const age = typeof signals.age_days === "number" ? signals.age_days : 0;
  const stale = typeof signals.staleness === "number" ? signals.staleness : 0;

  // A live run whose node has gone quiet is a candidate stuck run. Scale the
  // bump with age/staleness, capped so a single old run never dominates.
  const coldness = Math.min(age, 14) * 0.3 + stale * 2;
  if (coldness > 0) out.run_cold = Number(coldness.toFixed(2));

  // If the body exposes the reducer_state, count steps sitting in a
  // mid-flight state (claimed or ready) — an idle worker seam. A modest
  // per-stuck-step bump, bounded.
  const body = typeof node.body === "string" ? node.body : "";
  const m = body.match(/```json\s*([\s\S]*?)```/);
  if (m) {
    let parsed = null;
    try { parsed = JSON.parse(m[1]); } catch (e) { parsed = null; }
    const state = parsed && parsed.reducer_state;
    if (state && state.steps && typeof state.steps === "object") {
      let inflight = 0;
      for (const id in state.steps) {
        const s = state.steps[id];
        if (s && (s.status === "claimed" || s.status === "ready")) inflight++;
      }
      // only meaningful once the run has gone cold — a fresh run with ready
      // steps is healthy, a stale one with ready steps is stuck.
      if (inflight > 0 && coldness > 1) out.run_inflight_stale = Math.min(inflight, 5);
    }
  }

  return out;
}
```

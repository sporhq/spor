---
id: schema-workflow
type: schema
kind: node-schema
schema_version: 2026.06.11.1
title: Seed schema for workflow nodes
summary: Node schema for the workflow type — a repeatable, reviewable automation definition (a DAG of steps) that lives in the graph like every other artifact. Created via the server it lands proposed and inert; a different identity must activate it (the self-approval ban extended, API.md §1). Seed-pack default; a graph-resident schema node for this type overrides it.
date: 2026-06-11
---

Seed schema for the `workflow` node type (ontology in GRAPH.md; the
proposal/activation contract is API.md §1), shipped with the
plugin as a registry default (QUEUE.md §2). A `type: schema` node in the
graph with `kind: node-schema` and the same `node_type` overrides this entry.

A workflow is written through the ordinary proposal flow: created via the
server it is forced to `status: proposed` (the store discards a payload-supplied
status on CREATE, exactly as it discards attribution — the tier-1 floor,
API.md §1) and inert until a *different* identity activates it. That
forced-proposed create is what makes the activation ban load-bearing: without
it a single identity could create a workflow `status: active` and run it
immediately, bypassing the gate. An agent may author a workflow; it may not
deploy one — activation is where org policy bites (§6). `queueable: true` so a
proposed workflow surfaces for review like a proposed schema;
`capturable: false` — workflows are authored, never ingested from raw text.

The body carries a fenced `json` block (the step DAG: `inputs`, `steps`,
`concurrency`) and an optional fenced `js` block exporting `route(run, view)`,
both parsed natively (zero-dep), the JSON at dispatch and the route() under
the §2.4 sandbox.

```json
{
  "node_type": "workflow",
  "description": "a repeatable, reviewable automation definition — a DAG of steps that lives in the graph, versioned and proposal-gated",
  "prefix": ["wf-"],
  "queueable": true,
  "capturable": false,
  "fields": {
    "status": { "enum": ["proposed", "active", "retired"] }
  }
}
```

```js
// transitions(current, proposed, view) — the activation gate (API.md §1
// schema-gating floor, extended one notch). Runs on every UPDATE in the §2.4
// sandbox, JSON boundary, pure. view.actor is the authenticated identity
// performing the write; current.author is "Name <email>" stamped by the store
// from the proposing identity's token.
//
// Rule: flipping a workflow proposed -> active requires an identity DIFFERENT
// from the node's last author — whoever last touched the proposal cannot be
// the one to activate it (the self-approval ban, mirrored from the store's
// hardcoded schema-activation floor for type:schema, which does not cover
// type:workflow). Proposers may still edit or retire their own workflow.
//
// NOTE ON SOLO: the store does NOT plumb SPOR_SOLO into the transitions
// view (it reads process.env directly only for the type:schema floor in
// store.js). Attached code has no clock/env and cannot see solo, so this gate
// enforces the ban UNCONDITIONALLY. A single-identity org activates a
// workflow via the trusted admin git path (hand-edit + commit), exactly as it
// would bypass any other attached gate — see the workflow-run engine notes.
export function transitions(current, proposed, view) {
  const wasProposed = current && (current.status || "") === "proposed";
  const nowActive = (proposed.status || "") === "active";
  if (!(wasProposed && nowActive)) return { allow: true };

  const author = (current && current.author) ? current.author : "";
  const actorEmail = (view && view.actor && view.actor.email) ? view.actor.email : "";
  // author is "Name <email>"; match the bracketed email exactly.
  const selfApproval = actorEmail && author.indexOf("<" + actorEmail + ">") !== -1;
  if (selfApproval) {
    return {
      allow: false,
      reason: "self-approval denied: a workflow's proposer (" + author +
        ") may not activate it — a different identity must (API.md §1)",
    };
  }
  return { allow: true };
}
```

---
id: schema-factory
type: schema
kind: node-schema
schema_version: 2026.08.28.1
title: Software-factory definition
summary: A factory definition — the ordered gate list a worker enforces between claim and resolve, plus the trusted ref, protected test paths, test-change lane, risk classes those gates key on, and an optional integration (merge-queue landing) stage. Candidate pack; adopt it into a graph to use `spor work --factory`.
date: 2026-08-26
edges:
  - {type: derived-from, to: dec-spor-software-factory-substrate}
  - {type: relates-to, to: task-spor-work-gate-pipeline}
  - {type: derived-from, to: dec-spor-factory-integration-step}
---

A `factory` node is a team's bespoke factory as DATA (dec-spor-software-factory-
substrate): what must be true before a piece of work counts as done here. The
runner (`spor work --factory <id>`, lib/shell/gate-runner.js) enforces it in
code; nothing in this node is an instruction to an orchestrator agent, and
nothing in it names a command line a machine must execute beyond the declared
acceptance suite — an agent-review gate routes by PROFILE, so the machine's own
declared binding still decides what actually runs (dec-spor-declarative-harness-
machine-binds-execution).

It ships in the CANDIDATE pack rather than the seed: a factory changes what a
worker will accept, so it arrives by deliberate adoption (`spor schema adopt
schema-factory`, landing `status: proposed` for a second identity to activate),
never active-everywhere-instantly.

The gate list is ordered and each entry is one of three kinds — `command`,
`agent-review`, `human` — written either INLINE or as `{"ref": "gate-<id>"}`
pointing at a shareable `type: gate` node (schema-gate), so an org can vet one
gate and reuse it product-wide. The runner treats the two shapes identically;
keys written beside a `ref` override the referenced gate's own.

The body carries the definition as a fenced ```json payload, the same
convention schema nodes use:

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

- `trusted_ref` — the ref a command gate's suite is taken from (default `main`).
  **The implementer branch's copy of the tests is never what runs.**
- `protected_paths` — test paths the implementer may not touch. A change that
  touches one fails its command gate CLOSED (unrun) and routes to
  `test_lane_profile`; declaring paths without a lane is an error, because
  "fails closed" must never mean "dropped on the floor".
- `risk_classes` — named path predicates a `human` gate keys on. A human gate
  naming an undeclared class is an error: a gate that can never arm reads
  exactly like an approved one.
- `gates[].cycles` — how many implementer fix cycles a failing gate gets before
  the runner escalates by filing a human queue item. Default 0.

```json
{
  "node_type": "factory",
  "description": "a software-factory definition: the ordered gate list a worker enforces between claim and resolve",
  "prefix": ["factory-"],
  "queueable": false,
  "always_on": false,
  "traversable": true,
  "capturable": false,
  "status": {
    "vocabulary": ["proposed", "active", "retired"],
    "terminal": ["retired"],
    "resolver_required": false
  }
}
```

```js
const STATUSES = ["proposed", "active", "retired"];

export function validate(node) {
  const errors = [];
  if (node.status && !STATUSES.includes(node.status)) {
    errors.push(`factory status must be one of: ${STATUSES.join(", ")}`);
  }
  const body = String(node.body || "");
  if (!/```json/.test(body)) {
    errors.push("a factory needs a fenced ```json payload declaring its gates");
  }
  return errors;
}

export function transitions(current, proposed) {
  const to = (proposed && proposed.status) || "";
  if (to && !STATUSES.includes(to)) {
    return { allow: false, reason: `factory status must be one of: ${STATUSES.join(", ")}` };
  }
  return { allow: true };
}
```

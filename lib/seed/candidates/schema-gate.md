---
id: schema-gate
type: schema
kind: node-schema
schema_version: 2026.08.26.1
title: Shareable factory gate
summary: One reusable gate — command, agent-review or human — that any factory definition can reference by id, so an org vets a gate once (a `gate-security-review`) and reuses it product-wide instead of copying it into every factory.
date: 2026-08-26
edges:
  - {type: derived-from, to: dec-spor-software-factory-substrate}
  - {type: relates-to, to: schema-factory}
---

A `gate` node is ONE gate, standing on its own so more than one factory can use
it: org governance writes a vetted `gate-security-review` once, and every
factory references it (`{"ref": "gate-security-review"}`) rather than carrying a
divergent copy. A factory may also write its gates inline; the runner
(lib/shell/gate-runner.js) treats the two shapes identically — a referenced gate
is unwrapped into exactly the object an inline one would have been, with any
keys written beside the `ref` overriding it.

The body carries the gate as a fenced ```json payload:

    {
      "id": "adversarial-review",
      "kind": "agent-review",
      "profile": "profile-codex-review",
      "cycles": 2,
      "instructions": "Hunt for correctness defects; ignore style."
    }

Keys by kind:

- **command** — `command` (the declared suite, run from the factory's TRUSTED
  ref), `timeout_ms`, optional `dir`, optional `serialize`, and optional
  `reruns` (default 0, at most 3): how many times a FAILED suite is run again
  on the SAME prepared tree before the failure is charged to a fix cycle, a
  rescue or a person. A rerun is the same command on the one checkout the
  declared run failed in (the tree is prepared once for the whole loop), it
  costs a suite run and never a fix dispatch, and a pass on a rerun PASSES
  but its `art-gate-*` fact names the rerun and carries the first failure as
  evidence, so a flaky suite stays countable in the telemetry instead of
  laundering into clean passes. There is deliberately no way to name a ref
  or a protected path here: those are the FACTORY's, so one shared gate
  cannot quietly relax another team's trusted boundary.
- **agent-review** — `profile` (required: the review lane, cross-model by
  convention; the machine's declared binding decides what that actually
  executes), `instructions`, `await_ms`. The reviewer answers with a fenced JSON
  verdict which the runner parses in code — an unreadable verdict is a failure,
  never a pass.
- **human** — `risk` (the factory-declared risk classes that ARM this gate; an
  empty list means always), `approval_timeout_ms`, `poll_ms`, `instructions`.

`cycles` is common to all three: how many implementer fix cycles a failure gets
before the runner escalates to a human queue item. Reruns come BEFORE fix
cycles: a command gate spends its `reruns` budget on one tree first, and only
a suite that failed every run is charged a cycle.

```json
{
  "node_type": "gate",
  "description": "a reusable factory gate (command, agent-review or human) referenced by factory definitions",
  "prefix": ["gate-"],
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
const KINDS = ["command", "agent-review", "human"];

export function validate(node) {
  const errors = [];
  if (node.status && !STATUSES.includes(node.status)) {
    errors.push(`gate status must be one of: ${STATUSES.join(", ")}`);
  }
  const body = String(node.body || "");
  if (!/```json/.test(body)) {
    errors.push("a gate needs a fenced ```json payload declaring its kind");
  } else if (!KINDS.some((k) => body.includes(`"${k}"`))) {
    errors.push(`a gate payload must declare a kind: ${KINDS.join(", ")}`);
  }
  return errors;
}

export function transitions(current, proposed) {
  const to = (proposed && proposed.status) || "";
  if (to && !STATUSES.includes(to)) {
    return { allow: false, reason: `gate status must be one of: ${STATUSES.join(", ")}` };
  }
  return { allow: true };
}
```

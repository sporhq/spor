---
id: schema-gate
type: schema
kind: node-schema
schema_version: 2026.10.15.1
title: Shareable factory gate
summary: One reusable gate — command, agent-review or human — that any factory definition can reference by id, so an org vets a gate once (a `gate-security-review`) and reuses it product-wide instead of copying it into every factory.
date: 2026-08-26
---

A `gate` node is ONE gate, standing on its own so more than one factory can use
it: org governance writes a vetted `gate-security-review` once, and every
factory references it (`{"ref": "gate-security-review"}`) rather than carrying a
divergent copy. A factory may also write its gates inline; the runner treats
the two shapes identically — a referenced gate is unwrapped into exactly the
object an inline one would have been, with any keys written beside the `ref`
overriding it.

The body carries the gate as a fenced ```json payload:

    {
      "id": "adversarial-review",
      "kind": "agent-review",
      "profile": "profile-codex-review",
      "cycles": 2,
      "instructions": "Hunt for correctness defects; ignore style."
    }

Keys by kind (the full contract is WORKERS.md §10.3-§10.5 in the spor repo):

- **command** — `command` (the declared suite, run from the factory's TRUSTED
  ref), `timeout_ms`, optional `dir` and `serialize`. There is deliberately no
  way to name a ref or a protected path here: those are the FACTORY's, so one
  shared gate cannot relax another team's trusted boundary.
  - `reruns` (default 0, max 3) — re-run a failed suite on the SAME tree before
    the failure is charged; a rerun-rescued pass keeps the first failure as
    evidence on its `art-gate-*` fact, so flakes stay countable.
  - `isolate` — a command template with a `{files}` token. When every failed
    run names only test files off the diff that reference nothing the change
    edits, those files are re-run alone; passing there is an off-diff FLAKE —
    the gate passes and each file is filed as its own `issue-flake-*`.
    Anything the runner cannot judge is charged as before.
  - `ci` — `{"workflow": "test.yaml"}` runs the suite on the repo's CI: the
    candidate is pushed to `spor/candidate/<node>`, the workflow's run for that
    exact commit is the verdict, and a CI that never judges it is an OUTAGE
    (never a pass or a fix cycle) unless `local_fallback: true`. Optional
    `repo`, `remote`, `poll_ms`, `discover_ms`. `.github/**` is protected on
    top of the factory's paths; `isolate` cannot be combined with it; the box
    needs `gh` and push credentials.
  - `rejudge_on_repin` (default true; read only under controller completion) —
    a pass on an ancestor of the completing candidate is re-run on the tip. An
    explicit `false` opts out; on any other gate kind the key is an error.
- **agent-review** — `profile` (required: the review lane, cross-model by
  convention), `instructions`, `await_ms`. The reviewer answers with a fenced
  JSON verdict parsed in code — unreadable is a failure, never a pass; only
  demonstrated blocking findings block. For a review that got NO verdict
  because its backend was out: `pause_max_ms` (default 48h) bounds how far a
  stated reset may park the pipeline; `fallback_profile` routes to a second
  lane after `fallback_after` (default 1, max 5) no-verdicts when its
  `model_family` differs from the implementer's; `reviewer_retries` (0..3)
  re-asks at 5m/15m/45m before escalating `reviewer-unavailable`. Pause is free;
  re-asks and fallback dispatches count against the factory's
  `implementation.retry` pool.
- **human** — `approval_timeout_ms`, `poll_ms`, `instructions`. Files an
  approval item and blocks until a resolving edge approves it or a terminal
  status refuses it; a timeout reports `blocked`, never decides.

Common to all three kinds:

- `risk` — factory-declared risk classes that ARM the gate (empty = always).
  Unarmed, the gate records `skipped` and runs nothing. An undeclared class is
  a load error: a gate that can never arm reads exactly like one that passed.
- `cycles` — implementer fix cycles a failure gets before the runner escalates
  to a human queue item (default 0). A command gate spends `reruns`, then its
  `isolate` pass, before a cycle is charged.

`resolution` declares `verified_by: status`: a gate's own terminal status
retires it; no inbound resolving edge attests it. Declaration only — no
stored-shape change, no upgrade chain.

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
  },
  "resolution": {
    "verified_by": "status"
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

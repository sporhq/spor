---
id: schema-factory
type: schema
kind: node-schema
schema_version: 2026.10.15.1
title: Software-factory definition
summary: A factory definition — the ordered gate list a worker enforces between claim and resolve, plus the trusted ref, the repos it may judge, protected test paths, test-change lane, risk classes those gates key on, an optional integration (merge-queue landing) stage, an optional rescue lane (a strong-model step before any human escalation), an optional implementation stage and the completion boundary that says who writes the resolving edge. Candidate pack; adopt it into a graph to use `spor work --factory`.
date: 2026-08-26
---

A `factory` node is a team's bespoke factory as DATA: what must be true before
a piece of work counts as done here. The runner (`spor work --factory <id>`)
enforces it in code; nothing in this node is an instruction to an agent, and
nothing in it names a command line a machine must execute beyond the declared
acceptance suite — review and implementation lanes route by PROFILE, so the
machine's own declared harness binding decides what actually runs.

It ships in the CANDIDATE pack rather than the seed: a factory changes what a
worker will accept, so it arrives by deliberate adoption (`spor schema adopt
schema-factory`, landing `status: proposed` for a second identity to
activate), never active-everywhere-instantly.

The gate list is ordered; each entry is a `command`, `agent-review` or `human`
gate, written INLINE or as `{"ref": "gate-<id>"}` pointing at a shareable
`type: gate` node (schema-gate). The runner treats the two shapes identically;
keys written beside a `ref` override the referenced gate's own.

The body carries the definition as a fenced ```json payload, the same
convention schema nodes use:

    {
      "factory": "spor-default",
      "trusted_ref": "main",
      "repos": ["spor"],
      "protected_paths": ["test/**", "conformance/**"],
      "test_lane_profile": "profile-test-writer",
      "risk_classes": { "touches:auth": ["lib/auth.js", "**/auth/**"] },
      "gates": [
        {"id": "typecheck", "kind": "command", "command": "npm run typecheck", "timeout_ms": 120000},
        {"id": "acceptance", "kind": "command", "command": "npm test", "timeout_ms": 900000},
        {"ref": "gate-adversarial-review", "cycles": 2},
        {"id": "security-approval", "kind": "human", "risk": ["touches:auth"]}
      ],
      "integration": {"command": "npm test", "target_ref": "main"},
      "rescue": {"profile": "profile-claude-fable", "attempts": 1},
      "implementation": {
        "profile": "profile-implementer",
        "author_checks": ["typecheck"],
        "budget": {"run_max_ms": 5400000, "run_idle_ms": 2700000, "attempts": 1},
        "retry": {"attempts": 1, "backoff_ms": 60000},
        "candidate": {"require_clean": true, "publish": "bundle"}
      },
      "completion": {"by": "controller", "after": "integration"}
    }

Keys (the full contract is WORKERS.md §10 in the spor repo; every block is
parsed fail-closed, so a mistyped factory refuses to start the worker rather
than running it ungated):

- `trusted_ref` (default `main`) — where a command gate's suite is taken from.
  The implementer branch's copy of the tests is never what runs (§10.3).
- `repos` — the repos this factory may judge; undeclared, the factory node's
  own `repo:` stamp, else unscoped. Out-of-scope items are skipped visibly,
  never gated. Declaring it EMPTY is an error (§10.1).
- `protected_paths` + `test_lane_profile` — a change touching a protected path
  fails its command gate CLOSED, unrun, and the test change is filed to the
  lane. Paths without a lane is an error (§10.3).
- `risk_classes` — named path predicates a gate of any kind keys on to ARM
  itself. A gate naming an undeclared class is an error (§10.5).
- `gates` — the ordered list; per-gate keys (`cycles`, `reruns`, `isolate`,
  `ci`, `rejudge_on_repin`, review fallbacks) are documented on schema-gate.
- `integration` (optional) — the merge-queue landing stage after every gate
  passes: a candidate merge of the branch into `target_ref` (`strategy`
  merge/squash/rebase), the suite run on it with protected paths forced to the
  trusted copy, and a compare-and-swap land — or `mode: propose`, which opens a
  PR via `gh` and parks the item. Accepts `reruns` and `ci` like a command gate
  (§10.9).
- `rescue` (optional) — `profile` (required), `attempts` (1..3, default 1),
  `await_ms` (default 1h), `instructions`. Before any human escalation, a
  strong-model lane diagnoses and fixes in the run's checkout, then the whole
  gate list is re-run under a fresh cycle budget (§10.10).
- `implementation` (optional) — the stage that PRODUCES the candidate. Routes
  by `profile` only (lowest precedence); any launch key (`command`, `args`,
  `argv`, `bin`, `exec`, `entrypoint`, `env`, `report`, `session`,
  `launch_mode`, `identity_mode`) is refused by name. `instructions` is
  appended to the worker contract; `author_checks` names command gate ids the
  implementer runs itself (default none). `budget` (`run_max_ms`/`run_idle_ms`
  inherit the worker's ceilings; `attempts` 1..3) is the code pool, `retry`
  (1 attempt, 60s backoff, max 3) the infrastructure pool. An unreadable count
  takes the default, never zero. `candidate.require_clean` (default true)
  refuses a dirty tree at submission; `candidate.publish` is `bundle` (default;
  `bundle_store` a `file://` or `https://` prefix), `branch` (to
  `candidate.remote`, default `origin`) or `both` — there is no `none`
  (§10.12, §10.14, §10.16).
- `completion` (optional) — who writes the resolving edge, and when. `by:
  agent` (default without an `implementation` block) leaves it to the
  implementer; `by: controller` (default when an implementation block parses)
  holds the item and has the runner write the edge and terminal status at
  `after: gates|integration`, defaulting to the last declared stage. Naming
  `integration` without the block is an error. `screenshots:
  optional|required` sets evidence policy under controller completion
  (§10.13, §10.14.1).

`resolution` declares `verified_by: status`: a factory's own terminal status
retires it; no inbound resolving edge attests it. Declaration only — no
stored-shape change, no upgrade chain.

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
  },
  "resolution": {
    "verified_by": "status"
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

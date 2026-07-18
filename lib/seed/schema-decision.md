---
id: schema-decision
type: schema
kind: node-schema
schema_version: 2026.07.16.1
title: Seed schema for decision nodes
summary: Node schema for the decision type — a choice that was made, with the why. Seed-pack mirror of the GRAPH.md ontology; a graph-resident schema node for this type overrides it.
date: 2026-06-10
---

Seed schema for the `decision` node type, shipped with the plugin as a
registry default (QUEUE.md §2). A `type: schema` node in the graph with
`kind: node-schema` and the same `node_type` overrides this entry.

`validate()` (2026.06.20.1, issue-spor-node-create-bypasses-status-vocabulary):
the status-vocabulary membership check moved to the `validate()` door so it runs
on **create as well as update** — `transitions()` runs on update only, so a
decision could be BORN with an off-vocabulary status that a later re-validating
write then rejected. `validate()` and `transitions()` SHARE one `VALID` list (no
drift). Backward-readable: write-time only, no node-shape change, no upgrade chain.

`transitions()` (2026.06.13.1): status is constrained to the decision
vocabulary (`active`/`superseded`/`rejected`, or none = live) so the
queue-terminal values are not shadowed by synonyms
(dec-cc-status-enforcement-via-transitions). `rejected` is how a dismissed
approach is filed (the distiller writes it, prompts/client/distill-local.md).
Write-time gate, backward-readable, no upgrade chain.

`status.non_resolving` (2026.06.15.1): a `rejected` decision — a recorded-then-
declined choice — resolves nothing, so as a resolver it does not retire its
targets. This is the registry-declared half of the resolving partition the
kernel reads off `graph.registry` (dec-spor-definition-of-done-org-policy);
resolution.js no longer hardcodes the `{rejected, abandoned}` set. Registry
behavior only, no node-shape change, backward-readable, no upgrade chain.

`settled` status + `reviewed_at` snooze stamp (2026.06.21.1,
task-spor-decision-settled-snooze-status, dec-spor-decision-lifecycle-surfacing):
a terminal **`settled`** status joins the vocab — "in force, acknowledged as
just context, exempt from the gardener decision-decay review-sweep,
permanently." It is RESOLVING (a settled decision still retires the targets it
resolves — only `rejected` sits in `non_resolving`) and it does NOT touch
queueability: decisions stay non-queueable (`queueable` is unset; norm-cc-blocks-
work-only), so `spor next` is byte-identical and `settled` is NOT added to the
kernel's `resolution.js` TERMINAL set — relevance-surfacing in the
digest/briefing stays untouched (dec-spor-decision-lifecycle-surfacing: a
settled decision SHOULD keep appearing when relevant). The companion
**`reviewed_at`** is an OPTIONAL flat ISO-timestamp scalar (snooze): the
server gardener stamps it when a human defers a decay-finding, resetting the
decay clock so the decision re-surfaces only after another cooling window. Like
the artifact `delivery_*` scalars, the kernel never reads `reviewed_at` — it
rides along on the node (the regex frontmatter parser already supports flat
`key: value` scalars) for the server sweep (task-spor-gardener-decision-decay-
sweep) to read. SNOOZE is the default, SETTLE the permanent escape. Additive/
backward-readable: one new optional status value + one new optional scalar, no
node-shape change, no upgrade chain.

`status.terminal` (2026.06.21.2, issue-spor-analytics-completion-ignores-schema-
terminal-status): the decision type's own-lifecycle terminal vocabulary —
`superseded`/`rejected`/`settled` — declared on the registry so work-analytics
counts a decision completed off `graph.registry.terminalStatuses()` (unioned with
the kernel's legacy type-blind set) rather than a hardcoded table
(dec-cc-registry-as-data). This is the lifecycle twin of `non_resolving`: that
partition governs whether a decision retires OTHERS (resolver semantics, only
`rejected`); this one governs whether the decision's OWN lifecycle is done.
`settled` is terminal for that lifecycle but is deliberately ABSENT from
`resolution.js`'s TERMINAL set (queue liveness / briefing surfacing must keep a
settled decision live, dec-spor-decision-lifecycle-surfacing), so without this
partition a settled decision lingered in analytics WIP and the oldest-open
bottleneck list forever. Registry behavior only, no node-shape change,
backward-readable, no upgrade chain.

`status.inert` (2026.07.16.1, dec-spor-status-inert-third-partition,
task-spor-terminal-status-type-aware-migration): the decision type is the
pinned EXCEPTION to the inert-inherits-terminal default. A schema that declares
no `inert` set inherits its `terminal` set as the per-type queue-liveness-dead
overlay the type-aware `isTerminalStatus(status, type, graph)` reads — but for
decisions the two partitions genuinely differ: `settled` is terminal
(own-lifecycle complete, analytics counts it done) yet must NOT be inert (a
settled decision keeps surfacing as live guidance in queues and briefings,
dec-spor-decision-lifecycle-surfacing). Declaring `inert: [superseded,
rejected]` blocks the inheritance of `settled` while changing nothing else —
both values are already in the type-blind terminal-status register the overlay
unions with, so decision liveness stays byte-identical. Registry behavior
only, no node-shape change, backward-readable, no upgrade chain.

```json
{
  "node_type": "decision",
  "description": "a choice that was made, with the why",
  "prefix": [
    "dec-"
  ],
  "status": {
    "non_resolving": [
      "rejected"
    ],
    "terminal": [
      "superseded",
      "rejected",
      "settled"
    ],
    "inert": [
      "superseded",
      "rejected"
    ]
  }
}
```

```js
// The decision status vocabulary, shared by validate() (the door, runs on
// create AND update) and transitions() (update only). Defining it ONCE is what
// makes the create path and the update path AGREE on the enum
// (issue-spor-node-create-bypasses-status-vocabulary): the membership check used
// to live only in the update-path gate, so a decision could be BORN with an
// off-vocabulary status that a later re-validating write then rejected.
const VALID = ["active", "superseded", "rejected", "settled"];
function statusReason(next) {
  return "invalid decision status '" + next + "': valid statuses are active " +
    "(in force), superseded (replaced by a newer decision), rejected " +
    "(recorded then declined/reversed — also how a dismissed approach is " +
    "filed), settled (in force but acknowledged as just-context — exempt from " +
    "the gardener decision-decay review-sweep, permanently) — or none, meaning " +
    "live. (dec-cc-status-enforcement-via-transitions)";
}

// validate(node) — the door, runs on EVERY write (create AND update) in the
// §2.4 sandbox. Enforce the status-vocabulary MEMBERSHIP here so a decision
// cannot be BORN with an off-vocabulary status that the update-path
// transitions() gate would later reject
// (issue-spor-node-create-bypasses-status-vocabulary). Empty status
// (status-less = live, the common case for an in-force decision) is allowed.
export function validate(node) {
  const s = ((node && node.status) || "").toLowerCase();
  if (s === "" || VALID.indexOf(s) !== -1) return [];
  return [statusReason(s)];
}

// transitions(current, proposed, view) — decision status vocabulary gate
// (dec-cc-status-enforcement-via-transitions). Runs on every UPDATE in the
// §2.4 sandbox, JSON boundary, pure. Empty status (status-less = live) and the
// create path are always allowed; the SHARED check above also enforces this on
// create now, and transitions() keeps it as the update-path guard.
export function transitions(current, proposed, view) {
  const next = ((proposed && proposed.status) || "").toLowerCase();
  if (next === "" || VALID.indexOf(next) !== -1) return { allow: true };
  return { allow: false, reason: statusReason(next) };
}
```

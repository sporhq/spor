---
id: schema-decision
type: schema
kind: node-schema
schema_version: 2026.06.20.1
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
const VALID = ["active", "superseded", "rejected"];
function statusReason(next) {
  return "invalid decision status '" + next + "': valid statuses are active " +
    "(in force), superseded (replaced by a newer decision), rejected " +
    "(recorded then declined/reversed — also how a dismissed approach is " +
    "filed) — or none, meaning live. (dec-cc-status-enforcement-via-transitions)";
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

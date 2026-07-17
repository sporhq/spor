---
id: schema-artifact
type: schema
kind: node-schema
schema_version: 2026.07.17.1
title: Seed schema for artifact nodes
summary: Node schema for the artifact type — a document, spec, module, or build product worth referencing, optionally carrying a delivery-stage status when it represents a change. Seed-pack mirror of the GRAPH.md ontology; a graph-resident schema node for this type overrides it.
date: 2026-06-10
---

Seed schema for the `artifact` node type, shipped with the plugin as a
registry default (QUEUE.md §2). A `type: schema` node in the graph with
`kind: node-schema` and the same `node_type` overrides this entry.

Delivery-stage vocab (2026.06.15.1, dec-spor-definition-of-done-org-policy):
an artifact that represents a *change* (a PR, a branch, a release) — rather than
a static doc or spec — may carry an OPTIONAL delivery-stage `status`:

| status      | resolving? | meaning                                            |
|-------------|------------|----------------------------------------------------|
| `in-review` | no         | change submitted, under review — keeps its task live |
| `approved`  | no         | reviewed and approved, not yet landed — task still live |
| `merged`    | yes        | landed on the default branch — retires its task    |
| `released`  | yes        | shipped/released                                   |

The non-resolving stages are declared in `status.non_resolving`, the artifact's
half of the resolving partition the kernel reads off `graph.registry`: a
resolver in `in-review`/`approved` does not retire its targets, so a task whose
only resolver is a change still in review stays live (this is what dissolves the
overnight-review smell — no `open` status to hand-manage). `merged`/`released`
and any unlisted/empty status resolve, so existing artifacts (no delivery stage)
are unaffected and the seed is byte-identical with the prior hardcoded set.

The stage is one half of a **source-blind** resolver contract (so a GitHub
reflection adapter and a native Spor review surface write the same shape). The
other half is flat scalar frontmatter the regex parser already supports — no
inline-list generalization:

- `delivery_ref` — the change's address (PR url, commit sha, tag).
- `delivery_source` — where it lives (e.g. `github`, `spor`).
- `size`, `labels`, `paths` — diff metadata as comma-scalars
  (`paths: lib/x.js, lib/y.js`).

The kernel never reads these keys; it reads `status` against the partition only.
The **trust seam** — *who* may assert `merged`/`released` (the self-approval
floor: an author cannot land their own change) — is policy that lands in a later
stage (the policy kind + the reflection adapter), not here. The stages are
optional — an artifact remains free to be a plain doc with no status — but as
of 2026.07.17.1 they are no longer merely *recognized*: `validate()` below gates
status MEMBERSHIP on every write. Nothing gates ORDER (there is no
`transitions()` on this type).

`status.terminal` (2026.07.16.1, issue-spor-coupling-resolution-terminal-
status-divergence): the artifact type's own-lifecycle terminal vocabulary —
`merged`/`released`/`done` — declared on the registry so work-analytics counts
a delivered or otherwise-finished artifact as completed off
`graph.registry.terminalStatuses()`, the lifecycle twin of `non_resolving`
above. `done` joins `merged`/`released` here because artifacts also use it as
a general non-delivery completion status (a finished doc/spec/build product,
not a change going through review) — the live graph carries many artifacts at
each of `done`, `merged`, and `released`. `in-review`/`approved` and any
unlisted/empty status (the live default: a plain reference doc with no
status, or one mid-review) are NOT terminal — they, and any other status,
stay OUT of this partition, so the artifact keeps reading as work in progress.
Separately, `merged`/`done` are also part of the type-blind `terminal-status`
register (GRAPH.md) that `lib/kernel/resolution.js` and
`lib/kernel/coupling.js` read for queue liveness and briefing surfacing.
`released` is NOT: it is artifact-scoped, reaching queue liveness only
through this partition — the per-type `status.inert` overlay inherits this
`terminal` set (no `inert` declared here, the inheritance default of
dec-spor-status-inert-third-partition), so a released ARTIFACT retires from
queues and briefings while a non-artifact marked `released` stays live
(task-spor-terminal-status-type-aware-migration; it sat in the type-blind
register for one version, 2026.07.16.1, before the inert partition existed).
Registry behavior only, no node-shape change, backward-readable, no upgrade
chain.

`validate()` (2026.07.17.1, issue-spor-off-vocab-artifact-statuses): the
artifact type gains the status-vocabulary MEMBERSHIP door every other gated type
already has (dec-spor-status-membership-in-validate-hook). Until now this type
had NO status gate at all — the stages were "optional recognized values" that
nothing enforced — so the live graph accrued off-vocabulary statuses that read
as neither live nor terminal: 13 `complete`, 6 `shipped`, 1 `landed`, 1
`resolved`, 1 `open` (the 2026-07-17 census). Because none of them are in the
`status.terminal`/`status.inert` partition above, those artifacts never retired
from queue liveness — a delivered piece of work that reads as forever in
flight. They are normalized to the vocabulary below (`complete`/`resolved` →
`done`, `shipped` → `released`, `landed` → `merged`, `open` → `approved`) in the
same change; the door is what stops the drift recurring.

The vocabulary is the delivery stages PLUS the two general non-delivery
lifecycle values, because an artifact is only *sometimes* a change:

- `in-review`/`approved`/`merged`/`released` — the delivery stages above.
- `done` — general non-delivery completion (a finished doc/spec/build product,
  not a change going through review). Already declared terminal above for
  exactly this reason.
- `active` — general non-delivery IN-PROGRESS: a living/current reference doc.
  The in-flight twin of `done`, and by far the most common non-empty artifact
  status in the wild (79 live nodes at the census, plus 37 in the conformance
  corpus). Non-terminal, so it never had the retirement bug the off-vocabulary
  values did. It is admitted rather than normalized precisely because it is a
  real, load-bearing convention — rejecting it would strand those nodes, since
  an edge write re-validates the whole node and would 422 on the stored status.
- none/empty — the live default (a plain reference doc), always allowed.

`open` is deliberately NOT admitted: it is a task/issue spelling that reached
exactly one artifact, carries no delivery meaning, and its one holder was
staged-but-not-live work — `approved` ("reviewed, not yet landed") says that in
the artifact's own vocabulary. Both are non-resolving, so the correction moved
nothing across the live/retired line.

There is still no `transitions()` on this type — the stages are not a state
machine (a change may be born `merged`, and a doc may go `active` → `done` and
back), so there is nothing to gate on ORDER. Membership is a property of the
node in isolation, which is exactly what belongs at the `validate()` door.
Write-time only, no stored-shape change, backward-readable, no upgrade chain.

```json
{
  "node_type": "artifact",
  "description": "a document, spec, module, or build product worth referencing",
  "prefix": [
    "spec-",
    "art-"
  ],
  "status": {
    "non_resolving": [
      "in-review",
      "approved"
    ],
    "terminal": [
      "merged",
      "released",
      "done"
    ]
  },
  "display": {
    "statuses": {
      "in-review": "active",
      "approved": "active",
      "merged": "positive",
      "released": "positive"
    }
  }
}
```

```js
// The artifact status vocabulary (issue-spor-off-vocab-artifact-statuses). This
// type has no transitions() — the stages are not a state machine (a change may
// be born `merged`; a doc may go `active` -> `done` and back), so there is
// nothing to gate on ORDER and the door is the ONLY status gate here. The list
// is the four delivery stages PLUS the two general non-delivery lifecycle
// values an artifact uses when it is a doc rather than a change: `done`
// (finished — already declared terminal in the payload above for this reason)
// and `active` (living/current — its in-flight twin, and the most common
// non-empty artifact status in the live graph). Off-vocabulary statuses
// (`complete`/`shipped`/`landed`/`resolved`/`open`) read as neither live nor
// terminal, so the artifacts carrying them never retired from queue liveness;
// they were normalized to this vocabulary in the same change.
const VALID = ["in-review", "approved", "merged", "released", "done", "active"];
function statusReason(next) {
  return "invalid artifact status '" + next + "': valid statuses are the " +
    "delivery stages in-review (submitted, under review), approved (reviewed, " +
    "not yet landed), merged (landed on the default branch), released " +
    "(shipped) — plus done (a finished doc/spec/build product that is not a " +
    "change) and active (a living/current document) — or none, meaning a plain " +
    "reference doc. (issue-spor-off-vocab-artifact-statuses)";
}

// validate(node) — the door, runs on EVERY write (create AND update) in the
// §2.4 sandbox. Status-vocabulary MEMBERSHIP is a property of the node in
// isolation, so it belongs here rather than in a transition gate
// (dec-spor-status-membership-in-validate-hook). Without it this type had no
// status gate at all, and the live graph accrued off-vocabulary statuses that,
// being absent from the status.terminal/status.inert partition, left delivered
// work reading as forever in flight. Empty status (status-less = live, the
// common case for a plain doc) is allowed.
export function validate(node) {
  const s = ((node && node.status) || "").toLowerCase();
  if (s === "" || VALID.indexOf(s) !== -1) return [];
  return [statusReason(s)];
}
```

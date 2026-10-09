---
id: schema-artifact
type: schema
kind: node-schema
schema_version: 2026.10.09.1
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

`status` (2026.08.22.1, task-spor-registry-declarative-terminal-status-policy):
the status vocabulary `validate()` enforces is now also DECLARED as registry
data (`status.vocabulary`). Deliberately NO `status.completion`: the delivery
stages are not a state machine and `merged`/`released`/`done` are distinct
landing outcomes, so no single value is THE mechanical close — and the generic
`resolved` a reader used to fall back to is off this vocabulary entirely
(issue-spor-gardener-terminal-status-fallback-off-vocab). Enforcement is
unchanged — `validate()` is still the only status gate this type has;
`test/seed-declarative-status-policy.test.js` pins the hook and this payload
together. Backward-readable: declaration only, no stored-shape change, no
upgrade chain.

`resolution` (2026.09.06.1, issue-spor-offline-check-get-hook-resolution-proxy):
the attestation path for this type's completion, DECLARED as registry data.
`verified_by: status` — an artifact's own terminal status retires it; no inbound
resolving edge attests it. Readers (remote dispatch's terminal-state verify,
`spor schema`) used to infer this from the ABSENCE of a `get()` hook on this
schema, which is the general-purpose read-time enrichment verb and says
nothing about resolution — so adopting one here for any other purpose would
have silently flipped this type to edge-verified and read genuinely
status-retired work as unattested. Declaration only — enforcement stays in the
hooks — no stored-shape change, no upgrade chain.

Rich content and asset descriptors (2026.10.09.1,
task-spor-chatgpt-content-contracts): OPTIONAL flat-scalar keys an artifact may
carry; a node with none of them is exactly what it was. `validate()` refuses
inconsistent values; `lib/kernel/content.js` is the readable twin of these
rules (sandboxed code cannot require it), pinned to the same verdicts by
`test/content.test.js`. GRAPH.md "Rich content and assets" is the contract.

- `content_format` — `markdown` (CommonMark + GFM; `spor-asset:` inline image
  embeds mean something) or `text` (plain). Absent = a legacy body, read as
  before, embedding nothing.
- Asset descriptor — `asset_digest` (`sha256:<64 hex>` over the BYTES, which
  live outside graph Git), `asset_media_type` (`image/png|jpeg|gif|webp`; no
  SVG), `asset_bytes`, `asset_width`, `asset_height` (positive integers):
  all five or none, plus optional `asset_alt`. Any other `asset_*` key is a
  typo and is refused.
- Document stamps — `doc_sha256` + `doc_bytes` together (a generation root),
  `doc_generation` (a part: needs `continuation_of`, never beside
  `doc_sha256`), each 64 lowercase hex. Shape only: the exact-body check needs
  the reassembled document and stays with the reader.
- `selection` — one canonical `spor-source:` or `spor-image:` selection URI
  (UTF-16 source range of an exact document revision, or a pixel region of an
  exact asset digest).

Write-time only, every key optional, no stored-shape change: backward-readable,
no upgrade chain.

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
    "vocabulary": [
      "in-review",
      "approved",
      "merged",
      "released",
      "done",
      "active"
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
  },
  "resolution": {
    "verified_by": "status"
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
  const errs = s === "" || VALID.indexOf(s) !== -1 ? [] : [statusReason(s)];
  return errs.concat(contentErrors(node || {}));
}

// The content contract (task-spor-chatgpt-content-contracts) — an inline
// mirror of lib/kernel/content.js validateContentFields, same rules and same
// messages; test/content.test.js pins the two together. Every key is optional:
// a node carrying none of them returns [].
const FORMATS = ["markdown", "text"];
const MEDIA = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const ASSET_REQ = ["asset_digest", "asset_media_type", "asset_bytes", "asset_width", "asset_height"];
const ASSET_ALL = ASSET_REQ.concat(["asset_alt"]);
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const HEX64 = /^[0-9a-f]{64}$/;
const REV_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const UINT = /^(?:0|[1-9][0-9]*)$/;
function str(v) { return v == null ? "" : String(v); }
function present(v) { return v != null && String(v) !== ""; }
function validId(id) { return typeof id === "string" && id.length <= 200 && ID_RE.test(id); }
function uint(v, allowZero) {
  const t = typeof v === "number" ? (Number.isInteger(v) ? String(v) : "") : str(v);
  if (!UINT.test(t)) return null;
  const n = Number(t);
  if (!Number.isSafeInteger(n) || (!allowZero && n === 0)) return null;
  return n;
}
function selectionError(uri) {
  const src = /^spor-source:([^@?#]+)@([^?#]+)(?:\?doc=([^#]*))?#utf16=([^,]*),(.*)$/.exec(uri);
  const img = src ? null : /^spor-image:([^@#]+)@(sha256:[^#]*)(?:#xywh=([^,]*),([^,]*),([^,]*),(.*))?$/.exec(uri);
  if (!src && !img) return "'" + uri + "' is not a spor-source: or spor-image: selection URI";
  const errs = [];
  let canon;
  if (src) {
    if (!validId(src[1])) errs.push("selection node '" + src[1] + "' is not a node id");
    if (!REV_RE.test(src[2])) errs.push("selection revision '" + src[2] + "' must be a git blob sha (40 or 64 hex)");
    if (present(src[3]) && !HEX64.test(src[3])) errs.push("selection doc_sha256 must be 64 lowercase hex");
    const a = uint(src[4], true), b = uint(src[5], true);
    if (a === null || b === null) errs.push("selection start/end must be non-negative integer UTF-16 offsets");
    else if (a >= b) errs.push("selection range [" + a + ", " + b + ") is empty or reversed");
    if (errs.length) return errs.join("; ");
    canon = "spor-source:" + src[1] + "@" + src[2] + (present(src[3]) ? "?doc=" + src[3] : "") + "#utf16=" + a + "," + b;
  } else {
    if (!validId(img[1])) errs.push("selection asset '" + img[1] + "' is not a node id");
    if (!DIGEST_RE.test(img[2])) errs.push("selection digest must be sha256:<64 lowercase hex>");
    let region = "";
    if (img[3] !== undefined) {
      const x = uint(img[3], true), y = uint(img[4], true), w = uint(img[5], false), h = uint(img[6], false);
      if (x === null || y === null || w === null || h === null) errs.push("selection region needs integer x,y >= 0 and w,h >= 1");
      else region = "#xywh=" + x + "," + y + "," + w + "," + h;
    }
    if (errs.length) return errs.join("; ");
    canon = "spor-image:" + img[1] + "@" + img[2] + region;
  }
  return canon === uri ? null : "'" + uri + "' is not in canonical form";
}
function contentErrors(f) {
  const errs = [];
  if (present(f.content_format) && FORMATS.indexOf(str(f.content_format)) === -1) {
    errs.push("content_format '" + str(f.content_format) + "' is not one of " + FORMATS.join(", ") + " (omit it for a legacy body)");
  }
  const keys = Object.keys(f).filter(function (k) { return k.indexOf("asset_") === 0 && present(f[k]); });
  if (keys.length) {
    keys.forEach(function (k) {
      if (ASSET_ALL.indexOf(k) === -1) errs.push("unknown asset key '" + k + "' (known: " + ASSET_ALL.join(", ") + ")");
    });
    const missing = ASSET_REQ.filter(function (k) { return !present(f[k]); });
    if (missing.length) errs.push("asset descriptor is missing " + missing.join(", ") + " (an asset descriptor carries all of " + ASSET_REQ.join(", ") + ")");
    if (present(f.asset_digest) && !DIGEST_RE.test(str(f.asset_digest))) errs.push("asset_digest '" + str(f.asset_digest) + "' must be sha256:<64 lowercase hex>");
    if (present(f.asset_media_type) && MEDIA.indexOf(str(f.asset_media_type)) === -1) {
      errs.push("asset_media_type '" + str(f.asset_media_type) + "' is not one of " + MEDIA.join(", "));
    }
    ["asset_bytes", "asset_width", "asset_height"].forEach(function (k) {
      if (present(f[k]) && uint(f[k], false) === null) errs.push(k + " '" + str(f[k]) + "' must be a positive integer");
    });
    if (present(f.asset_alt) && str(f.asset_alt).length > 1000) errs.push("asset_alt is over 1000 chars");
  }
  const hasDigest = present(f.doc_sha256), hasBytes = present(f.doc_bytes);
  if (hasDigest !== hasBytes) errs.push("doc_sha256 and doc_bytes come together (a generation root carries both)");
  if (hasDigest && !HEX64.test(str(f.doc_sha256))) errs.push("doc_sha256 '" + str(f.doc_sha256) + "' must be 64 lowercase hex");
  if (hasBytes && uint(f.doc_bytes, true) === null) errs.push("doc_bytes '" + str(f.doc_bytes) + "' must be a non-negative integer");
  if (present(f.doc_generation)) {
    if (!HEX64.test(str(f.doc_generation))) errs.push("doc_generation '" + str(f.doc_generation) + "' must be 64 lowercase hex");
    if (!present(f.continuation_of)) errs.push("doc_generation marks a generation PART and needs continuation_of");
    if (hasDigest) errs.push("doc_generation (a part) and doc_sha256 (a root) are mutually exclusive");
  }
  if (present(f.selection)) {
    const e = selectionError(str(f.selection));
    if (e) errs.push("selection: " + e);
  }
  return errs;
}
```

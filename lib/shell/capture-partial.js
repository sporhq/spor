"use strict";
// capture-partial.js — the ONE client reading of a PARTIAL capture
// (task-spor-client-capture-partial-unsaved-handling). A capture mints its
// drafts one at a time, so a write that fails after an earlier draft landed
// cannot be refused as a retryable busy (the re-send would mint the landed
// draft twice). spor-server answers it one of two ways
// (dec-spor-rest-busy-retryable-verdict-server-owned-2026-10-10):
//
//   200 { status: "captured", partial: true, landed, deferred, pending_id, ... }
//       the unlanded drafts' text was filed as capture-pending `pending_id`
//       for triage — a success, but never a FULL one, so it is surfaced.
//   503 { error: { code: "partial_unsaved", retryable: false, landed, deferred,
//                  deferred_drafts: [{id, type, title, summary, body, edges, raw}] } }
//       the capture-pending fallback failed too, so the deferred drafts exist
//       only in this body. FINAL: the capture is never re-sent (a same-key
//       replay answers the identical pinned body) and never busy-retried; the
//       client re-submits each `deferred_drafts[].raw` as an explicit node
//       write (`POST /v1/nodes`, `if_exists: skip` — replay-safe, so that
//       batch MAY be spooled and re-sent).
//
// Callers: `spor add` (bin/spor.js) and the hook engines' capture writers and
// outbox drain (scripts/engines/util.js settlePartialUnsaved). Pure: no IO.

const { entryLanded } = require("./busy.js");

// A partial_unsaved refusal's payload from a parsed response body, or null.
// -> { message, landed: [ids], deferred: [ids], drafts: [{id, raw}] } — only
// drafts carrying a non-empty `raw` (the node markdown) are re-submittable.
function partialUnsaved(json) {
  const e = json && typeof json === "object" ? json.error : null;
  if (!e || typeof e !== "object" || e.code !== "partial_unsaved") return null;
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  const drafts = (Array.isArray(e.deferred_drafts) ? e.deferred_drafts : [])
    .filter((d) => d && typeof d === "object" && typeof d.raw === "string" && d.raw.trim())
    .map((d) => ({ id: typeof d.id === "string" && d.id ? d.id : null, raw: d.raw }));
  return { message: typeof e.message === "string" ? e.message : "", landed: list(e.landed), deferred: list(e.deferred), drafts };
}

// The replay-safe node batch that re-submits the deferred drafts.
function deferredNodesBody(drafts) {
  return { nodes: drafts.map((d) => d.raw), if_exists: "skip" };
}

// A 200 capture marked partial -> { landed, deferred, pending_id }, else null.
function partialCapture(json) {
  if (!json || typeof json !== "object" || json.partial !== true) return null;
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  return { landed: list(json.landed), deferred: list(json.deferred), pending_id: typeof json.pending_id === "string" ? json.pending_id : null };
}

const joinOr = (ids, none) => (ids.length ? ids.join(", ") : none);

// One human line for a partial 200.
function describePartialCapture(p) {
  return (
    `partial capture: ${joinOr(p.landed, "nothing")} landed; ${joinOr(p.deferred, "the rest")} not written` +
    (p.pending_id ? ` — the text is preserved as ${p.pending_id} for triage` : "")
  );
}

// One human line for a partial_unsaved refusal.
function describePartialUnsaved(p) {
  return `partial capture: ${joinOr(p.landed, "nothing")} landed; ${joinOr(p.deferred, "the rest")} not written and not preserved server-side`;
}

// Split a `POST /v1/nodes` answer's per-entry results over the batch that was
// sent. -> null when the answer carries no usable per-entry results (the
// caller keeps its whole-request reading), else { landed: n, retry: body|null,
// dead: body|null } — `retry` the entries a re-send may still land (a `busy`
// entry, or any entry the server marks `retryable: true`; its per-entry
// `retryable: false` is honored),
// `dead` the entries the server refused on their content, each rebuilt as a
// batch over the original's other keys (the order of the survivors is kept:
// a born-terminal entry needs its resolver ahead of it).
function splitNodesResults(json, body) {
  const nodes = body && Array.isArray(body.nodes) ? body.nodes : null;
  const results = json && Array.isArray(json.results) ? json.results : null;
  if (!nodes || !results || results.length !== nodes.length) return null;
  const retry = [];
  const dead = [];
  let landed = 0;
  results.forEach((e, i) => {
    if (entryLanded(e)) landed++;
    // a busy entry wrote nothing; a gated entry the server marks
    // `retryable: true` (its in-batch resolver was busy, `retry_with`)
    // follows that resolver, which is itself in `retry`
    else if (e.retryable === true || (e.code === "busy" && e.retryable !== false)) retry.push(nodes[i]);
    else dead.push(nodes[i]);
  });
  const rebuild = (list) => (list.length ? { ...body, nodes: list } : null);
  return { landed, retry: rebuild(retry), dead: rebuild(dead) };
}

module.exports = {
  partialUnsaved,
  deferredNodesBody,
  partialCapture,
  describePartialCapture,
  describePartialUnsaved,
  splitNodesResults,
};

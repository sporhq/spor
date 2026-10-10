"use strict";
// busy.js — the ONE client reading of the server's retryable "busy" refusal
// (task-spor-client-honor-retry-after-on-503-busy). spor-server answers a
// state-db write-lock it lost under its loop budget, and a shed of its shared
// buffered-body budget, with a refusal that wrote NOTHING and carries a
// `Retry-After` (dec-spor-rest-body-budget-503-busy-and-3x-document-cap-2026-10-10;
// the server's "a lock lost under the loop budget is a retryable refusal at
// every door"):
//
//   REST   503 { error: { code: "busy" } }
//   OAuth  503 { error: "temporarily_unavailable" }   (RFC 6749 §5.2 reading)
//
// A bare 503 (a proxy mid-deploy, `ingestion_unavailable`, an unconfigured
// store) is NOT busy — it carries no promise that a prompt retry will land,
// and its callers already have their own outage handling.
//
// Retrying is bounded so a server that stays busy cannot hold a CLI verb for
// long: at most BUSY_MAX_RETRIES re-sends, each wait the server's Retry-After
// (else 1s·2^n) capped at BUSY_WAIT_CAP_MS, and never past a caller's abort
// signal.

const BUSY_MAX_RETRIES = 3;
const BUSY_WAIT_CAP_MS = 5000;

// Parse a Retry-After header to milliseconds. HTTP allows two forms: a
// non-negative integer of seconds, or an HTTP-date. Returns null when the
// header is absent or unparseable (caller falls back to exponential backoff).
function parseRetryAfter(value) {
  if (value == null || value === "") return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(value);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return null;
}

// Is this response the server's retryable busy refusal? Takes the
// remote.js/auth.js result shape ({status, json}).
function isBusy(r) {
  if (!r || r.status !== 503 || !r.json || typeof r.json !== "object") return false;
  const e = r.json.error;
  if (e === "temporarily_unavailable") return true;
  return !!(e && typeof e === "object" && e.code === "busy");
}

// The wait before busy retry `attempt` (0-based): the server's Retry-After
// when it sent one, else 1s·2^attempt — always capped.
function busyDelayMs(r, attempt, capMs = BUSY_WAIT_CAP_MS) {
  const h = r && r.headers ? r.headers["retry-after"] : undefined;
  const hinted = parseRetryAfter(h);
  return Math.min(hinted != null ? hinted : 1000 * 2 ** attempt, capMs);
}

function sleepUnless(ms, signal) {
  if (signal && signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      if (signal) signal.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    if (signal) signal.addEventListener("abort", done, { once: true });
  });
}

// Run `once()` and re-run it while it answers busy, up to `retries` times.
// The LAST answer is returned as-is (a still-busy 503 included), so the
// caller reports it exactly as it would have without the retry. `sleep` is
// injectable for tests.
async function withBusyRetry(once, { retries = BUSY_MAX_RETRIES, capMs = BUSY_WAIT_CAP_MS, signal, sleep = sleepUnless } = {}) {
  let r = await once();
  for (let attempt = 0; attempt < retries && isBusy(r); attempt++) {
    if (signal && signal.aborted) break;
    await sleep(busyDelayMs(r, attempt, capMs), signal);
    if (signal && signal.aborted) break;
    r = await once();
  }
  return r;
}

// The positions of a batch response's PER-ENTRY busy refusals. `POST
// /v1/nodes` applies its entries one at a time and answers a 207 whose
// `results[i]` is `{ok:false, code:"busy"}` for an entry whose own write lost
// the state-db lock — that entry wrote nothing, but its neighbours may have
// (issue-spor-client-busy-retry-gaps).
function busyEntryIndexes(r) {
  if (!r || r.status !== 207 || !r.json || !Array.isArray(r.json.results)) return [];
  const out = [];
  r.json.results.forEach((e, i) => {
    if (e && typeof e === "object" && e.ok === false && e.code === "busy") out.push(i);
  });
  return out;
}

// withBusyRetry for a `{nodes: [...]}` batch, under the same bound and pacing.
// `send(body)` runs one request. Two busy shapes are re-sent:
//   - a 207 carrying per-entry busy results: ONLY those entries are re-sent
//     (in their original order, with the batch's other keys), and each answer
//     is spliced back into its entry's position;
//   - a top-level busy 503: the entries in flight are re-sent only when
//     `resendSafe(entries)` says so — a multi-entry batch commits entry by
//     entry, so a lock lost on entry k is not "wrote nothing" for entries
//     before it, and a re-send of a landed entry under `if_exists: error` or a
//     revision CAS would report it as a conflict.
// With no per-entry busy ever seen the last answer is returned as-is; once one
// was, the merged answer is `{status: 207|200, json: {...json, results}}` over
// the ORIGINAL entry list. An entry whose re-send got no per-entry answer (a
// still-busy 503, a transport error) keeps its last per-entry result.
async function withBusyBatchRetry(send, body, { retries = BUSY_MAX_RETRIES, capMs = BUSY_WAIT_CAP_MS, signal, sleep = sleepUnless, resendSafe = () => false } = {}) {
  const nodes = body.nodes;
  let idx = nodes.map((_, i) => i); // request position -> original position
  let merged = null; // a response carrying per-entry results, and its results
  let results = null;
  let r = await send(body);
  for (let attempt = 0; ; attempt++) {
    let pending = null;
    if (isBusy(r)) {
      if (resendSafe(idx.map((i) => nodes[i]))) pending = idx;
    } else if (r && r.json && Array.isArray(r.json.results) && r.json.results.length === idx.length) {
      const b = busyEntryIndexes(r);
      if (b.length || results) {
        results = results || new Array(nodes.length).fill(null);
        r.json.results.forEach((e, j) => (results[idx[j]] = e));
        merged = r;
      }
      if (b.length) pending = b.map((j) => idx[j]);
    }
    if (!pending || attempt >= retries || (signal && signal.aborted)) break;
    await sleep(busyDelayMs(r, attempt, capMs), signal);
    if (signal && signal.aborted) break;
    idx = pending;
    r = await send({ ...body, nodes: idx.map((i) => nodes[i]) });
  }
  if (!results) return r;
  // `ok` keeps the HTTP layer's reading (a 207 is ok, as fetch reads it), so
  // a merged answer looks like the plain one; `status` carries the outcome.
  const allOk = results.every((e) => e && e.ok !== false);
  const json = { ...merged.json, results };
  return { ...merged, ok: true, status: allOk ? 200 : 207, json, jsonError: null, text: JSON.stringify(json) };
}

module.exports = {
  BUSY_MAX_RETRIES,
  BUSY_WAIT_CAP_MS,
  parseRetryAfter,
  isBusy,
  busyDelayMs,
  withBusyRetry,
  busyEntryIndexes,
  withBusyBatchRetry,
};

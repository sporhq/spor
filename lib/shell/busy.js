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

// What a re-send that came back WITHOUT per-entry results says about each
// not-yet-landed entry it carried (issue-spor-client-busy-retry-stale-results-
// and-resolver-ordering): the earlier busy result is stale either way, so it
// is never kept. A 4xx refused the whole request — wrote nothing — and is the
// real error; a lone entry answered busy wrote nothing; anything else (a 5xx,
// a transport error, a top-level busy over several entries, a malformed 207)
// may have landed some of them, which is `code: "unknown"`.
function resendOutcome(r, inFlight) {
  const status = r && typeof r.status === "number" ? r.status : null;
  const err = r && r.json && typeof r.json === "object" ? r.json.error : undefined;
  const errMsg = err && typeof err === "object" && typeof err.message === "string" ? err.message : null;
  if (isBusy(r) && inFlight === 1) return { ok: false, code: "busy", status, message: errMsg || "the server is busy; retry shortly" };
  if (status != null && status >= 400 && status < 500) {
    const code = (err && typeof err === "object" && err.code) || (typeof err === "string" && err) || `http_${status}`;
    return { ok: false, code, status, message: errMsg || `the re-send was refused (HTTP ${status})` };
  }
  const why = status != null ? `HTTP ${status}` : (r && r.error) || "no response";
  return { ok: false, code: "unknown", status, message: `the re-send answered ${why}; whether this entry was written is unknown` };
}

// withBusyRetry for a `{nodes: [...]}` batch, under the same bound and pacing.
// `send(body)` runs one request. The server applies entries IN ORDER, one at a
// time, and that order is load-bearing — a born-terminal entry passes the
// completion gate only once its resolver earlier in the batch has landed
// (dec-spor-batch-create-gate-resolver-first-ordering), and with a duplicate
// id the later entry's content is the one meant to win. So a re-send never
// reorders: it is always the TAIL of the batch from the first entry that
// wrote nothing, in the original order, with the batch's other keys.
//   - a 207 carrying per-entry busy results: the tail from the FIRST busy
//     entry is re-sent (an entry after it that failed — e.g. the gate, its
//     resolver having been the busy one — is re-tried in order behind it),
//     but only when every entry in that tail that already LANDED re-reads as
//     success (`landedResendSafe(entry)`: `if_exists: skip`), else the busy
//     result is reported as-is. An entry LANDED when it answered ok and was
//     not `skipped`, or when it failed with `landed: true` (or its id in
//     `landed_ids`) — the server's "node file written, but its git object or
//     journal entry was not; re-read before retrying" — so such an entry
//     blocks an unsafe re-send and keeps that result, re-read signal intact;
//   - a top-level busy 503: the entries in flight are re-sent only when one
//     entry is in flight (one entry is one atomic write) or every one of them
//     is landedResendSafe — entries commit one by one, so a lock lost on entry
//     k is not "wrote nothing" for entries before it.
// With no per-entry result ever seen the last answer is returned as-is; once
// one was, the merged answer is `{status: 207|200, json: {...json, results}}`
// over the ORIGINAL entry list. An entry that landed keeps its first result
// whatever a re-send of it answers (a skip re-send would otherwise read
// "skipped" for a node this batch created, a busy one "wrote nothing"), save
// when an earlier entry of that re-send wrote its id over it. A re-send answered with no
// per-entry results replaces every not-landed entry's result with
// resendOutcome() — the real error, or `unknown` — never the stale busy.
// Did this per-entry result write its node? An ok result did, unless it was
// `skipped` (which writes nothing). A failure did when the server says its
// node file stands anyway: `landed: true` (store-persist's not-durable
// `internal`), or the entry's id among a door refusal's `landed_ids`.
function entryLanded(e) {
  if (!e || typeof e !== "object") return false;
  if (e.ok !== false) return true;
  if (e.landed === true) return true;
  return e.id != null && Array.isArray(e.landed_ids) && e.landed_ids.includes(e.id);
}

// The ids a per-entry result wrote (empty for a skip or a plain failure).
function entryWroteIds(e) {
  if (!entryLanded(e) || e.status === "skipped") return [];
  const ids = e.id != null ? [e.id] : [];
  if (Array.isArray(e.landed_ids)) for (const id of e.landed_ids) if (!ids.includes(id)) ids.push(id);
  return ids;
}

async function withBusyBatchRetry(send, body, { retries = BUSY_MAX_RETRIES, capMs = BUSY_WAIT_CAP_MS, signal, sleep = sleepUnless, landedResendSafe = () => false } = {}) {
  const nodes = body.nodes;
  let start = 0; // the original position of the first entry in flight
  let merged = null; // a response carrying per-entry results, and the results
  let results = null;
  const first = new Array(nodes.length).fill(null); // an entry's first LANDED result (entryLanded)
  const landed = (i) => first[i] != null;
  let r = await send(body);
  for (let attempt = 0; ; attempt++) {
    const inFlight = nodes.length - start;
    let next = null;
    if (r && !isBusy(r) && r.json && Array.isArray(r.json.results) && r.json.results.length === inFlight) {
      results = results || new Array(nodes.length).fill(null);
      const wrote = new Set(); // ids an earlier entry of THIS send wrote
      r.json.results.forEach((e, j) => {
        const i = start + j;
        const now = entryLanded(e);
        // A landed entry's re-send answering ok, busy or any other failure
        // leaves its first landing standing — unless an earlier entry of this
        // same send wrote its id (a duplicate), which replaced it: then it is
        // no longer landed until a re-send of it lands again.
        if (landed(i) && !now && entryWroteIds(first[i]).some((id) => wrote.has(id))) first[i] = null;
        results[i] = landed(i) ? first[i] : e;
        if (now && !landed(i)) first[i] = e;
        // a skip wrote nothing, so it never un-lands a duplicate
        for (const id of entryWroteIds(e)) wrote.add(id);
      });
      merged = r;
      const b = busyEntryIndexes(r)[0];
      if (b != null) {
        const k = start + b;
        let safe = true;
        for (let i = k + 1; i < nodes.length; i++) if (landed(i) && !landedResendSafe(nodes[i])) safe = false;
        if (safe) next = k;
      }
    } else {
      if (isBusy(r) && (inFlight === 1 || nodes.slice(start).every((e) => landedResendSafe(e)))) next = start;
      if (results) {
        const out = resendOutcome(r, inFlight);
        for (let i = start; i < nodes.length; i++) if (!landed(i)) results[i] = out;
      }
    }
    if (next == null || attempt >= retries || (signal && signal.aborted)) break;
    await sleep(busyDelayMs(r, attempt, capMs), signal);
    if (signal && signal.aborted) break;
    start = next;
    r = await send({ ...body, nodes: nodes.slice(start) });
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
  resendOutcome,
  entryLanded,
  withBusyBatchRetry,
};

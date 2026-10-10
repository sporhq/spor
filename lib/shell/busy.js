"use strict";
// busy.js — the ONE client reading of the server's retryable "busy" refusal
// (task-spor-client-honor-retry-after-on-503-busy). spor-server answers a
// state-db write-lock it lost under its loop budget, and a shed of its shared
// buffered-body budget, with a refusal that wrote NOTHING and carries a
// `Retry-After` (dec-spor-rest-body-budget-503-busy-and-3x-document-cap-2026-10-10;
// the server's "a lock lost under the loop budget is a retryable refusal at
// every door"):
//
//   REST   503 { error: { code: "busy", retryable, retry_after } }
//   /mcp   503 { error: { code: -32000, data: { error: "busy", retryable, retry_after } } }
//   OAuth  503 { error: "temporarily_unavailable" }   (RFC 6749 §5.2 reading)
//
// A bare 503 (a proxy mid-deploy, `ingestion_unavailable`, an unconfigured
// store) is NOT busy — it carries no promise that a prompt retry will land,
// and its callers already have their own outage handling.
//
// WHETHER a busy refusal may be re-sent verbatim is the SERVER's verdict
// (dec-spor-rest-busy-retryable-verdict-server-owned-2026-10-10): a REST busy
// body carries a boolean `error.retryable` (and `error.retry_after`, seconds),
// a request-level /mcp busy carries them under the JSON-RPC `error.data`, and
// a `POST /v1/nodes` 207 carries them per entry. busyVerdict() reads it; the
// caller's own rule (`replaySafe`, lib/remote.js's per-route table) is only
// the FALLBACK for an older server whose body lacks the field.
//
// Retrying is bounded so a server that stays busy cannot hold a CLI verb for
// long: at most BUSY_MAX_RETRIES re-sends, each wait the server's retry_after
// (else Retry-After, else 1s·2^n) capped at BUSY_WAIT_CAP_MS, and never past
// a caller's abort signal.

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

// The busy envelope's verdict-carrying object: the REST `error`, or the
// JSON-RPC `error.data` of a request-level /mcp busy. null when `r` is not a
// 503 carrying one.
function busyEnvelope(r) {
  if (!r || r.status !== 503 || !r.json || typeof r.json !== "object") return null;
  const e = r.json.error;
  if (!e || typeof e !== "object") return null;
  if (e.code === "busy") return e;
  if (e.data && typeof e.data === "object" && e.data.error === "busy") return e.data;
  return null;
}

// Is this response the server's retryable busy refusal? Takes the
// remote.js/auth.js result shape ({status, json}).
function isBusy(r) {
  if (!r || r.status !== 503 || !r.json || typeof r.json !== "object") return false;
  if (r.json.error === "temporarily_unavailable") return true;
  return busyEnvelope(r) != null;
}

// The server's replay verdict on a busy refusal: true/false when its body
// carries a boolean `retryable`, else null (an older server, or OAuth's
// `temporarily_unavailable`, which states none).
function busyVerdict(r) {
  const e = busyEnvelope(r);
  return e && typeof e.retryable === "boolean" ? e.retryable : null;
}

// A body's `retry_after` (seconds) as milliseconds, or null.
function retryAfterField(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v * 1000 : null;
}

// The wait before busy retry `attempt` (0-based): the server's retry_after
// (the body field, else the Retry-After header) when it sent one, else
// 1s·2^attempt — always capped.
function busyDelayMs(r, attempt, capMs = BUSY_WAIT_CAP_MS) {
  const e = busyEnvelope(r);
  const body = e ? retryAfterField(e.retry_after) : null;
  const h = r && r.headers ? r.headers["retry-after"] : undefined;
  const hinted = body != null ? body : parseRetryAfter(h);
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

// Run `once()` and re-run it while it answers a busy the server says is safe
// to re-send (busyVerdict, else the caller's fallback `replaySafe`), up to
// `retries` times. `transportRetries` folds a caller's own resend-on-transport-
// failure into the SAME budget (the asset upload: a refusal mid-stream can
// surface as a reset), so one call makes at most 1 + `retries` attempts
// whatever mix of busy and transport failures it meets; a transport re-send
// is immediate, a caller's abort is never re-sent. The LAST answer is returned
// as-is (a still-busy 503 included), so the caller reports it exactly as it
// would have without the retry. `sleep` is injectable for tests.
async function withBusyRetry(once, { retries = BUSY_MAX_RETRIES, capMs = BUSY_WAIT_CAP_MS, signal, sleep = sleepUnless, replaySafe = true, transportRetries = 0 } = {}) {
  let r = await once();
  let transportLeft = transportRetries;
  for (let attempt = 0; attempt < retries; attempt++) {
    if (signal && signal.aborted) break;
    if (isBusy(r)) {
      const verdict = busyVerdict(r);
      if (!(verdict != null ? verdict : replaySafe)) break;
      await sleep(busyDelayMs(r, attempt, capMs), signal);
      if (signal && signal.aborted) break;
    } else if (r && r.transport && !r.aborted && transportLeft > 0) {
      transportLeft--;
    } else break;
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
// a transport error, a top-level busy over several entries — even one the
// server marks `retryable`, which promises only that a re-send cannot
// double-apply, not that the earlier entries wrote nothing — a malformed 207)
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

// Did this per-entry result leave its node standing? An ok result did (a
// `skipped` one included: the node it found stands, and a re-send of it would
// answer `skipped` again). A failure did when the server says its node file
// stands anyway: `landed: true` (store-persist's not-durable `internal`), or
// the entry's id among a door refusal's `landed_ids`.
function entryLanded(e) {
  if (!e || typeof e !== "object") return false;
  if (e.ok !== false) return true;
  if (e.landed === true) return true;
  return e.id != null && Array.isArray(e.landed_ids) && e.landed_ids.includes(e.id);
}

// The positions (within the response) a 207 asks to be re-sent, by the
// server's per-entry verdict — or null when the response carries none (an
// older server: some busy entry has no boolean `retryable`), so the caller
// falls back to the tail rule. A busy entry is re-sent when it says
// `retryable: true`; a gated entry (`transition_denied` only because an
// EARLIER in-batch resolver was busy) carries `retryable: true` +
// `retry_with: [positions]` and is re-sent only together with every entry it
// names, which must themselves be re-sent.
function verdictResendPositions(r) {
  const busyAt = busyEntryIndexes(r);
  if (!busyAt.length) return [];
  const results = r.json.results;
  if (!busyAt.every((i) => typeof results[i].retryable === "boolean")) return null;
  const out = new Set(busyAt.filter((i) => results[i].retryable === true));
  results.forEach((e, i) => {
    if (!e || typeof e !== "object" || e.ok !== false || e.code === "busy" || e.retryable !== true) return;
    const w = e.retry_with;
    if (Array.isArray(w) && w.length && w.every((j) => Number.isInteger(j) && j < i && out.has(j))) out.add(i);
  });
  return [...out].sort((x, y) => x - y);
}

// The pacing for a re-send of `positions` of a 207: the longest per-entry
// `retry_after` among them, else the response's own Retry-After/backoff.
function entryDelayMs(r, positions, attempt, capMs) {
  let ms = null;
  for (const i of positions) {
    const v = retryAfterField(r.json.results[i] && r.json.results[i].retry_after);
    if (v != null && (ms == null || v > ms)) ms = v;
  }
  return ms != null ? Math.min(ms, capMs) : busyDelayMs(r, attempt, capMs);
}

// withBusyRetry for a `{nodes: [...]}` batch, under the same bound and pacing.
// `send(body)` runs one request. The server applies entries IN ORDER, one at a
// time, and that order is load-bearing — a born-terminal entry passes the
// completion gate only once its resolver earlier in the batch has landed
// (dec-spor-batch-create-gate-resolver-first-ordering). So a re-send never
// reorders: it carries entries in their original order, with the batch's
// other keys.
//   - a 207 carrying per-entry busy results, from a server that states its
//     verdict per entry: exactly the entries it marks `retryable: true` are
//     re-sent — each busy one, and each gated entry beside the busy resolvers
//     its `retry_with` names (verdictResendPositions) — paced by their
//     `retry_after`. An entry that landed is never re-sent;
//   - the same 207 from an older server (no per-entry `retryable`): the TAIL
//     from the FIRST busy entry is re-sent (an entry after it that failed —
//     e.g. the gate, its resolver having been the busy one — is re-tried in
//     order behind it), but only when every entry in that tail that already
//     LANDED (entryLanded) re-reads as success (`landedResendSafe(entry)`:
//     `if_exists: skip`), else the busy result is reported as-is. A landed
//     failure (`landed: true` / `landed_ids`: the server's "node file written,
//     but its git object or journal entry was not; re-read before retrying")
//     therefore blocks an unsafe re-send and keeps its result, re-read signal
//     intact;
//   - a top-level busy 503: the entries in flight are re-sent when the
//     server's `error.retryable` says so — or, from an older server, when one
//     entry is in flight (one entry is one atomic write) or every one of them
//     is landedResendSafe, since entries commit one by one and a lock lost on
//     entry k is not "wrote nothing" for entries before it.
// With no per-entry result ever seen the last answer is returned as-is; once
// one was, the merged answer is `{status: 207|200, json: {...json, results}}`
// over the ORIGINAL entry list. An entry that landed keeps its first result
// whatever a re-send of it answers (a skip re-send would otherwise read
// "skipped" for a node this batch created, a busy one "wrote nothing"). A
// re-send answered with no per-entry results replaces every not-landed
// entry's result it carried with resendOutcome() — the real error, or
// `unknown` — never the stale busy.
async function withBusyBatchRetry(send, body, { retries = BUSY_MAX_RETRIES, capMs = BUSY_WAIT_CAP_MS, signal, sleep = sleepUnless, landedResendSafe = () => false } = {}) {
  const nodes = body.nodes;
  let sent = nodes.map((_, i) => i); // the original positions of the entries in flight
  let merged = null; // a response carrying per-entry results, and the results
  let results = null;
  const first = new Array(nodes.length).fill(null); // an entry's first LANDED result (entryLanded)
  const landed = (i) => first[i] != null;
  let r = await send(body);
  for (let attempt = 0; ; attempt++) {
    let next = null;
    let delay = null;
    if (r && !isBusy(r) && r.json && Array.isArray(r.json.results) && r.json.results.length === sent.length) {
      results = results || new Array(nodes.length).fill(null);
      r.json.results.forEach((e, j) => {
        const i = sent[j];
        results[i] = landed(i) ? first[i] : e;
        if (entryLanded(e) && !landed(i)) first[i] = e;
      });
      merged = r;
      const byVerdict = verdictResendPositions(r);
      if (byVerdict) {
        const pick = byVerdict.filter((j) => !landed(sent[j]));
        if (pick.length) {
          next = pick.map((j) => sent[j]);
          delay = entryDelayMs(r, pick, attempt, capMs);
        }
      } else {
        const b = busyEntryIndexes(r)[0];
        if (b != null) {
          const tail = sent.slice(b);
          if (tail.every((i) => !landed(i) || landedResendSafe(nodes[i]))) next = tail;
        }
      }
    } else {
      if (isBusy(r)) {
        const verdict = busyVerdict(r);
        if (verdict != null ? verdict : sent.length === 1 || sent.every((i) => landedResendSafe(nodes[i]))) next = sent;
      }
      if (results) {
        const out = resendOutcome(r, sent.length);
        for (const i of sent) if (!landed(i)) results[i] = out;
      }
    }
    if (next == null || attempt >= retries || (signal && signal.aborted)) break;
    await sleep(delay != null ? delay : busyDelayMs(r, attempt, capMs), signal);
    if (signal && signal.aborted) break;
    sent = next;
    r = await send({ ...body, nodes: sent.map((i) => nodes[i]) });
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
  busyVerdict,
  busyDelayMs,
  withBusyRetry,
  busyEntryIndexes,
  resendOutcome,
  entryLanded,
  verdictResendPositions,
  withBusyBatchRetry,
};

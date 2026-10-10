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

module.exports = { BUSY_MAX_RETRIES, BUSY_WAIT_CAP_MS, parseRetryAfter, isBusy, busyDelayMs, withBusyRetry };

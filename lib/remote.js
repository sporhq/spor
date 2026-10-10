"use strict";
// remote.js — minimal zero-dependency REST client for the Spor server, used by
// the bin/spor CLI in remote mode (dec-cc-spor-cli-universal-surface step 3).
// `fetch` is a Node 20+ global (package.json engines), so no dependency.
//
// Fail-open parity with the hooks (dec-cc-fail-open-hooks): a transport error
// (DNS, refused, timeout) resolves to { ok:false, transport:true } rather than
// throwing, so a CLI verb can degrade — fall back to the local graph or print a
// clear OFFLINE line — instead of crashing with a stack trace.

const home = require("./shell/home.js");
const auth = require("./auth.js");
const { untilAborted } = require("./shell/abort.js");
const busy = require("./shell/busy.js");

// Server base + token resolve through the active-tenant selector
// (Config.server()/token(), dec-spor-client-cli-mode-tenant-resolution), which is
// byte-identical to the prior flat get("server")/get("token") when no credential
// store / org selector is in play. Falls back to a raw env dual-read when called
// without a config (standalone helpers, unit tests).
function base(cfg) {
  const v = cfg ? cfg.server() : home.envDual("SERVER");
  return (v || "").replace(/\/+$/, "");
}
function token(cfg) {
  const v = cfg ? cfg.token() : home.envDual("TOKEN");
  return v || "";
}
function isRemote(cfg) {
  return base(cfg).length > 0;
}

const REFRESH_SKEW_S = 5 * 60;

// A refresh goes through the store entry the tenant was resolved FROM, named
// by its exact `key`. There is no fallback to tenantKey(server, org): a tenant
// with no key is not a store entry's own bearer (Config's flat() withholds the
// key exactly then, an agent tenant never has one), and refreshTenant()
// resolves its selector by exact key OR bare org slug, so a synthesized key
// could swap in a SIBLING entry's credential — or, for a key-less tenant whose
// org is "", refresh some other "<server>/" entry. Byte-identical for every
// tenant Config builds today (refresh_token rides only beside a key); this
// makes the invariant structural (issue-spor-tenant-resolution-gaps).
function refreshableTenant(cfg) {
  if (!cfg || typeof cfg.tenant !== "function") return null;
  const t = cfg.tenant();
  return t && t.key && t.refresh_token ? t : null;
}

function shouldRefresh(t, nowS = Math.floor(Date.now() / 1000)) {
  if (!t || !t.refresh_token) return false;
  if (!t.token) return true;
  return Number.isFinite(t.exp) && t.exp <= nowS + REFRESH_SKEW_S;
}

// The proactive refresh is raced against the caller's signal: on abort, fall
// back to the current token (the request then aborts on the same signal).
async function bearerForRequest(cfg, tokenOverride, signal) {
  if (tokenOverride) return tokenOverride;
  const t = refreshableTenant(cfg);
  if (shouldRefresh(t)) {
    const fresh = await untilAborted(auth.refreshTenant(cfg.userConfigHome(), t.key, { signal }), signal);
    if (fresh) return fresh;
  }
  return token(cfg);
}

// `opts.busyRetries` bounds the token endpoint's busy re-sends (auth.js
// oauthPost); the hook engines pass 0 — their refresh rides a hook's latency
// budget with no deadline signal of its own. `opts.signal` (a caller's
// deadline) stops those re-sends once it aborts, so an abandoned refresh does
// not keep re-sending behind the caller's back; the attempt already in flight
// is left to finish, since a rotated refresh_token it mints is only kept if
// its answer is read.
async function refreshAfterAuthFailure(cfg, opts) {
  const t = refreshableTenant(cfg);
  if (!t) return null;
  return auth.refreshTenant(cfg.userConfigHome(), t.key, opts);
}

// HTTP methods that are safe to repeat by definition (GET/PUT/DELETE/HEAD —
// re-sending them has the same effect as sending them once). A POST is NOT in
// this set — it's only safe to retry when the caller says so (`idempotent:
// true`) or the body itself carries an `idempotency_key` the server dedupes on
// (API.md's capture/executions convention).
const IDEMPOTENT_METHODS = new Set(["GET", "PUT", "DELETE", "HEAD"]);

function safeToRepeat(method, { body, idempotent } = {}) {
  if (IDEMPOTENT_METHODS.has(method)) return true;
  if (idempotent) return true;
  return !!(body && typeof body === "object" && body.idempotency_key != null);
}

// A request the server answered `503 busy` is re-sent (lib/shell/busy.js)
// when the SERVER says so: every REST busy body carries a boolean
// `error.retryable` decided by the route's own replay declaration
// (dec-spor-rest-busy-retryable-verdict-server-owned-2026-10-10), and that
// verdict wins. What follows is only the FALLBACK, for an older server whose
// busy body lacks the field: it is re-sent when it is safeToRepeat() OR it is
// one of these routes. The table is narrowed to routes whose re-send is
// harmless even if a busy refusal had written something — the worst case is
// a misreported outcome, never a duplicate or an invisible state change:
//   /v1/nodes            put_node by explicit id: if_exists skip/update is a
//                        revision CAS, `error` answers conflict, never a dupe.
//                        A multi-entry batch commits entry by entry, so it
//                        goes through busy.withBusyBatchRetry, which re-sends
//                        a landed entry only when it would re-read as success
//                        (entryResendSafe)
//   /v1/nodes/batch      a read (hydrate ids)
//   /v1/digest           a read
//   /v1/nodes/{id}/edges, /edges/live   adding an existing edge is a no-op
//   /v1/nodes/{id}/{status,priority,readiness}   set-to-value: re-setting the
//                        value a node already holds changes nothing
//   /v1/nodes/{id}/release, /v1/queue/release    hand back a lease: releasing
//                        a released lease is a no-op
//   /v1/agents/{id}/capabilities   a wholesale replace
// and PATCH /v1/nodes/{id} (`spor patch`: key=value scalars, revision-CAS'd
// when a revision is passed — re-setting a value is a no-op).
// Deliberately NOT here: capture/questions/corrections without an
// idempotency_key (an append — a re-send is a second node), token mints (a
// second credential), claim/extend (unlike a set-to-value, a re-sent claim
// whose first send landed is refused against the caller's OWN lease, which
// then sits held with no lease in hand until its TTL), merge, gardener,
// workflow runs, journal erase — a busy answer there is reported, never
// re-sent.
const BUSY_SAFE_POSTS = [
  /^\/v1\/nodes(\/batch)?$/,
  /^\/v1\/digest$/,
  /^\/v1\/nodes\/[^/]+\/(edges|edges\/live|status|priority|readiness|release)$/,
  /^\/v1\/queue\/release$/,
  /^\/v1\/agents\/[^/]+\/capabilities$/,
];

// May a `POST /v1/nodes` entry that may already have LANDED be re-sent? Only
// under `if_exists: skip`: a landed entry re-sent answers `skipped`, which the
// batch retry reads as success. Under `error` a landed entry re-reads as a
// conflict, and an `update` must carry a revision (the server answers an
// unrevisioned update not_found for a missing node and conflict for an
// existing one, so it never lands) — re-sent after landing, that revision is
// stale and it too re-reads as a conflict.
function entryResendSafe(body, e) {
  const obj = e && typeof e === "object" ? e : {};
  return (obj.if_exists || body.if_exists || "skip") === "skip";
}

// May a `POST /v1/nodes` be re-sent after a stale-socket failure, whose
// outcome is unknown? Only when every entry is entryResendSafe() (`if_exists:
// skip`): an entry the lost attempt landed re-reads as `skipped`, never a
// conflict or a duplicate. This is what set-status/edge/get already had and
// put-node lacked, so a connection reset by a proxy or a restarting server
// failed only the write (issue-spor-cli-put-node-offline-fetch-failed).
function nodesWriteResendSafe(method, apiPath, body) {
  if (method !== "POST" || String(apiPath || "").split("?")[0] !== "/v1/nodes") return false;
  if (!body || typeof body !== "object" || !Array.isArray(body.nodes) || !body.nodes.length) return false;
  return body.nodes.every((e) => entryResendSafe(body, e));
}

// The FALLBACK busy-replay rule (BUSY_SAFE_POSTS above), read only when the
// server's busy body carries no `error.retryable` of its own.
function busyRetryable(method, apiPath, opts = {}) {
  if (safeToRepeat(method, opts)) return true;
  const p = String(apiPath || "").split("?")[0];
  if (method === "PATCH") return /^\/v1\/nodes\/[^/]+$/.test(p);
  if (method !== "POST") return false;
  return BUSY_SAFE_POSTS.some((re) => re.test(p));
}

// A transport failure that happened before any byte of a response arrived,
// and whose shape matches a POOLED KEEP-ALIVE SOCKET the server already closed
// out from under us (issue-spor-remote-stale-socket-after-blocking-spawn): a
// caller that blocks the event loop (a synchronous spawnSync launching a
// harness, ~1-10s) can come back to find undici's free socket already FIN'd by
// the server's keepAliveTimeout, with no chance to have evicted it from the
// pool while blocked. Node's fetch (undici) surfaces this as a `TypeError:
// fetch failed` whose `cause` carries the real signal — `UND_ERR_SOCKET` /
// "other side closed", or a bare ECONNRESET/EPIPE when a proxy in front resets
// the connection outright — so check the cause, not just the outer message.
function isStaleSocketError(r) {
  if (!r || r.ok || r.status != null || !r.transport) return false;
  if (r.code === "UND_ERR_SOCKET") return true;
  const text = `${r.error || ""} ${r.cause || ""}`;
  return /other side closed/i.test(text) || /ECONNRESET/i.test(text) || /EPIPE/i.test(text);
}

// The transport-error shape every attempt returns
// (issue-spor-cli-put-node-offline-fetch-failed). undici's outer message is a
// bare `fetch failed` for EVERY socket-level failure — a refused connect, a DNS
// miss, a connection the server or a proxy reset mid-request — so the real
// signal (its `cause`, often an AggregateError for a dual-stack connect) is
// folded into `error` where every caller already prints it. Our own timeout is
// named as one, instead of undici's "This operation was aborted", and so is a
// caller's abort (its signal fired): neither is a failed connection.
function causeOf(e) {
  const c = e && e.cause;
  if (!c) return { message: null, code: null, syscall: null };
  const inner = Array.isArray(c.errors) && c.errors.length ? c.errors[0] : null;
  return {
    message: c.message || (inner && inner.message) || null,
    code: c.code || (inner && inner.code) || null,
    syscall: c.syscall || (inner && inner.syscall) || null,
  };
}
function transportError(e, { timedOut, timeoutMs, aborted } = {}) {
  const { message: cause, code, syscall } = causeOf(e);
  let error = e && e.message ? e.message : String(e);
  if (timedOut) error = `timed out after ${timeoutMs}ms`;
  else if (aborted) error = "aborted by the caller";
  else if (cause && !error.includes(cause)) error = `${error}: ${cause}${code && !cause.includes(code) ? ` (${code})` : ""}`;
  else if (code && !error.includes(code)) error = `${error} (${code})`;
  const r = { ok: false, transport: true, error, cause: cause || undefined, code: code || undefined, syscall: syscall || undefined };
  if (timedOut) r.timedOut = true;
  else if (aborted) r.aborted = true;
  return r;
}

// Did this transport failure happen before the request could have reached the
// server — no connection was ever made? Only then is "offline — could not reach
// server" true, and only then is a write certain not to have landed. A reset,
// a closed socket or a timeout happened on a connection the server may already
// have acted on.
//
// A refused connect and a DNS miss can only happen before a connection exists.
// The ROUTE errors (EHOSTUNREACH/ENETUNREACH/EHOSTDOWN/ENETDOWN) can also hit
// an ESTABLISHED socket — a route that drops mid-request, after the body went
// out — so they read as never-connected only when the failing syscall was the
// connect itself (the cause's `syscall`, or its "connect <CODE>" message);
// with neither, the request is treated as one that may have reached the server.
const NEVER_CONNECTED_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "ERR_INVALID_URL"]);
const ROUTE_CODES = new Set(["ENETUNREACH", "EHOSTUNREACH", "EHOSTDOWN", "ENETDOWN"]);
function isUnreachable(r) {
  if (!r || !r.transport || r.timedOut || r.aborted || r.reachedServer) return false;
  const text = `${r.error || ""} ${r.cause || ""}`;
  if (r.code && NEVER_CONNECTED_CODES.has(r.code)) return true;
  if (r.code && ROUTE_CODES.has(r.code)) return r.syscall ? r.syscall === "connect" : new RegExp(`\\bconnect ${r.code}\\b`).test(text);
  // fetch refuses a blocked port ("bad port") before it ever dials
  return /\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN)\b|\bconnect (ENETUNREACH|EHOSTUNREACH|EHOSTDOWN|ENETDOWN)\b|\bbad port\b/.test(text);
}

// The one-line description of a transport failure for a CLI verb. `write`
// (a hint string) marks a request that may have changed state: a failure on a
// connection that was made appends it, since the write may have landed.
function describeTransport(r, { write } = {}) {
  if (isUnreachable(r)) return `offline — could not reach server (${r.error})`;
  const head = r && r.timedOut ? "server did not answer" : r && r.aborted ? "request aborted" : "connection to server failed";
  return `${head} (${(r && r.error) || "no response"})${write ? ` — the write may have landed; ${write}` : ""}`;
}

// A single HTTP attempt with an explicit bearer. `retry` gates the ONE
// stale-socket retry below — pass a truthy value only when the request is
// safe to repeat (safeToRepeat()); `_retried` prevents a second retry from
// itself retrying, so a request is attempted at most twice regardless of how
// many stale-socket errors it hits.
async function _attempt(cfg, method, apiPath, { body, timeoutMs, bearer, retry, _retried, signal }) {
  const url = base(cfg) + apiPath;
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  // A caller's shared deadline aborts this request too.
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        ...(body != null ? { "Content-Type": "application/json" } : {}),
      },
      body: body != null ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    let jsonError = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch (e) {
        // `ok`/`status` still reflect the HTTP layer alone — an empty or
        // malformed body on an otherwise-2xx response is not an HTTP-layer
        // error. But a caller reading the PARSED body (verifyRunResolution's
        // `node.resolution`) needs to tell "the body failed to parse" apart
        // from "the body legitimately parsed to null/{}" — collapsing the two
        // into `json: null` let a failed read silently pass as a confidently-
        // empty node (issue-spor-verify-run-resolution-silent-json-parse-failure),
        // the same class of bug dec-spor-dispatch-terminal-verify-jsonerror-
        // fail-closed already fixed for lib/shell/dispatch-terminal.js's own
        // httpJson. `json`/`ok` are unchanged so existing callers that only
        // ever read those two fields stay byte-identical.
        jsonError = (e && e.message) || "invalid JSON body";
      }
    }
    const headers = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return { ok: res.ok, status: res.status, json, jsonError, text, headers };
  } catch (e) {
    const err = transportError(e, { timedOut, timeoutMs, aborted: !!(signal && signal.aborted) });
    if (retry && !_retried && isStaleSocketError(err)) {
      const again = await _attempt(cfg, method, apiPath, { body, timeoutMs, bearer, retry, _retried: true, signal });
      // The first attempt was on a connection the server may have acted on:
      // a failed retry is never "could not reach server", whatever it hit,
      // and whatever the retry answered, the first attempt's outcome is
      // unknown (a `skipped` re-send may be that attempt's own create).
      if (again.transport) return { ...again, reachedServer: true, earlierAttemptUnknown: true, error: `${again.error}; after an earlier attempt failed with ${err.error}` };
      return { ...again, reachedServer: true, earlierAttemptUnknown: true };
    }
    return err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

// One request. Returns { ok, status, json, text } on an HTTP response (any
// status), or { ok:false, transport:true, error } when the request never
// completed. Never throws. `opts.token` overrides the cfg-resolved bearer for
// this one call — `spor dispatch` uses it to authenticate as the freshly-minted
// agent token (not the person token) when late-binding the run session
// (issue-spor-dispatch-bg-session-late-bind). `opts.idempotent` marks a POST
// that is safe to repeat verbatim (a "set" endpoint, not an "append"/"create"
// one) so it can be retried on a stale-socket error same as an idempotent
// method; a POST that isn't marked is still retried if its body carries an
// `idempotency_key` the server dedupes on.
//
// Transparent per-tenant refresh (dec-spor-client-cli-mode-tenant-resolution):
// before a request, if the active store tenant carries a refresh_token and its
// access token is absent/near-expiry, refresh it proactively. If the server still
// answers 401/403, refresh once and retry. The flat/env path has no refresh_token,
// so this is a no-op there — byte-identical.
async function request(cfg, method, apiPath, { body, timeoutMs = 6000, token: tokenOverride, idempotent, signal } = {}) {
  let bearer = await bearerForRequest(cfg, tokenOverride, signal);
  const retry = safeToRepeat(method, { body, idempotent }) || nodesWriteResendSafe(method, apiPath, body);
  // What every attempt so far says, carried across the auth refresh, the
  // stale-socket retry and the busy re-sends (busy.js): once any attempt may
  // have reached the server, a later attempt that cannot connect is never
  // "offline", and once any attempt's outcome is unknown, every later answer
  // says so (a `skipped` re-send may be that attempt's own write).
  const seen = { reached: false, unknown: false };
  const attempt = async (b) => {
    let r = await _attempt(cfg, method, apiPath, { body: b, timeoutMs, bearer, retry, signal });
    if (seen.reached && r.transport && !r.reachedServer) r = { ...r, reachedServer: true, error: `${r.error}; after an earlier attempt reached the server` };
    if (seen.unknown && !r.earlierAttemptUnknown) r = { ...r, earlierAttemptUnknown: true };
    if (!isUnreachable(r)) seen.reached = true;
    if (r.earlierAttemptUnknown || (r.transport && !isUnreachable(r))) seen.unknown = true;
    // a top-level busy over several entries may have committed the ones
    // before the lock was lost (busy.js withBusyBatchRetry)
    if (busy.isBusy(r) && b && Array.isArray(b.nodes) && b.nodes.length > 1) seen.unknown = true;
    return r;
  };
  const once = async (b = body) => {
    const r = await attempt(b);
    if ((r.status === 401 || r.status === 403) && !tokenOverride && !(signal && signal.aborted)) {
      const fresh = await untilAborted(refreshAfterAuthFailure(cfg, { signal }), signal);
      if (fresh && !(signal && signal.aborted)) {
        bearer = fresh;
        return attempt(b);
      }
    }
    return r;
  };
  if (method === "POST" && String(apiPath).split("?")[0] === "/v1/nodes" && body && Array.isArray(body.nodes) && body.idempotency_key == null) {
    return busy.withBusyBatchRetry(once, body, { signal, landedResendSafe: (e) => entryResendSafe(body, e) });
  }
  return busy.withBusyRetry(once, { signal, replaySafe: busyRetryable(method, apiPath, { body, idempotent }) });
}

const get = (cfg, p, opts) => request(cfg, "GET", p, opts);
const post = (cfg, p, body, opts) => request(cfg, "POST", p, { ...(opts || {}), body });
const del = (cfg, p, opts) => request(cfg, "DELETE", p, opts);

// A binary-safe GET for endpoints that stream non-JSON bodies — the
// /v1/export tarball (`spor export`, task-spor-export-cli-verb). request()
// reads res.text(), which corrupts binary; this reads the body as an
// arrayBuffer and returns it as a Buffer alongside the response headers
// (export rides x-substrate-head / x-substrate-node-count there, not the body).
async function _download(cfg, apiPath, { timeoutMs, bearer, signal }) {
  const url = base(cfg) + apiPath;
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  // A caller's shared deadline aborts this download too (post-tool's one budget).
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${bearer}` },
      signal: ctrl.signal,
    });
    const buffer = Buffer.from(await res.arrayBuffer());
    const headers = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return { ok: res.ok, status: res.status, buffer, headers };
  } catch (e) {
    return transportError(e, { timedOut, timeoutMs, aborted: !!(signal && signal.aborted) });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

// Returns { ok, status, buffer, headers } on an HTTP response, or
// { ok:false, transport:true, error } when it never completed. Never throws.
// Mirrors request()'s proactive + refresh-once-on-401 behavior for store-based
// tenants; a flat/env token has no refresh_token, so that branch is a no-op there.
// Default timeout is generous — an export can be large.
async function download(cfg, apiPath, { timeoutMs = 60000, token: tokenOverride, signal } = {}) {
  let bearer = await bearerForRequest(cfg, tokenOverride, signal);
  // A GET, so a busy refusal is always safe to re-send. The body is binary,
  // so the busy envelope is parsed here, only for a 503.
  const once = async () => {
    let r = await _download(cfg, apiPath, { timeoutMs, bearer, signal });
    if ((r.status === 401 || r.status === 403) && !tokenOverride && !(signal && signal.aborted)) {
      const fresh = await untilAborted(refreshAfterAuthFailure(cfg, { signal }), signal);
      if (fresh && !(signal && signal.aborted)) {
        bearer = fresh;
        r = await _download(cfg, apiPath, { timeoutMs, bearer, signal });
      }
    }
    if (r.status === 503 && r.buffer) {
      try {
        return { ...r, json: JSON.parse(r.buffer.toString("utf8")) };
      } catch {
        return r;
      }
    }
    return r;
  };
  return busy.withBusyRetry(once, { signal });
}

// A STREAMING exchange for the byte routes (`spor asset`, task-spor-chatgpt-
// asset-cli): the request body is streamed rather than JSON-encoded, and a 2xx
// response body is handed to `consume(res)` (a fetch Response) instead of being
// buffered, so neither direction ever holds an image in memory. `body` is a
// FACTORY returning a fresh body per attempt (a stream cannot be re-sent), and
// the timeout covers the whole exchange, consumption included. A non-2xx answer
// is read as text/json like request(). Never throws on transport: resolves
// { ok:false, transport:true, error }. A throw from `consume` (a verification
// refusal) propagates to the caller. Refreshes a store tenant once on 401/403.
async function _exchangeAttempt(cfg, method, apiPath, { body, headers, timeoutMs, bearer, signal, consume }) {
  const url = base(cfg) + apiPath;
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  let res;
  try {
    const b = body ? body() : undefined;
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${bearer}`, ...(headers || {}) },
      body: b,
      ...(b != null ? { duplex: "half" } : {}),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
    return transportError(e, { timedOut, timeoutMs, aborted: !!(signal && signal.aborted) });
  }
  try {
    const hdrs = {};
    res.headers.forEach((v, k) => {
      hdrs[k] = v;
    });
    if (res.ok && consume) {
      try {
        return { ok: true, status: res.status, headers: hdrs, value: await consume(res) };
      } catch (e) {
        // A refusal mid-body (verification, an over-long stream): tear the
        // connection down rather than leave the server streaming at nobody.
        ctrl.abort();
        throw e;
      }
    }
    const text = await res.text();
    let json = null;
    let jsonError = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch (e) {
        // The same split request() makes: a body that failed to parse is not
        // a body that parsed to null.
        jsonError = (e && e.message) || "invalid JSON body";
      }
    }
    return { ok: res.ok, status: res.status, json, jsonError, text, headers: hdrs };
  } catch (e) {
    if (e && e.name === "AbortError") {
      if (!timedOut && signal && signal.aborted) return { ok: false, transport: true, aborted: true, error: "aborted by the caller" };
      return { ok: false, transport: true, timedOut: true, error: `timed out after ${timeoutMs}ms` };
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

async function exchange(cfg, method, apiPath, { body, headers, timeoutMs = 120000, token: tokenOverride, signal, consume, transportRetries = 0, retries = busy.BUSY_MAX_RETRIES } = {}) {
  let bearer = await bearerForRequest(cfg, tokenOverride, signal);
  const attempt = () => _exchangeAttempt(cfg, method, apiPath, { body, headers, timeoutMs, bearer, signal, consume });
  // The first attempt that may have reached the server: once one did, a later
  // re-send's refused connect is NOT "offline" — the upload may have landed
  // (issue-spor-cli-offline-wording-residuals), as request() carries it.
  let reached = null;
  const once = async () => {
    let r = await attempt();
    if ((r.status === 401 || r.status === 403) && !tokenOverride && !(signal && signal.aborted)) {
      const fresh = await untilAborted(refreshAfterAuthFailure(cfg, { signal }), signal);
      if (fresh && !(signal && signal.aborted)) {
        bearer = fresh;
        r = await attempt();
      }
    }
    if (reached && r.transport && !r.reachedServer) {
      r = { ...r, reachedServer: true, error: `${r.error}; ${reached.transport ? `after an earlier attempt failed with ${reached.error}` : "after an earlier attempt reached the server"}` };
    }
    if (!reached && !isUnreachable(r)) reached = r;
    return r;
  };
  // `body` is a factory, so a re-send streams fresh bytes. A busy refusal is
  // re-sent on the server's verdict; absent one, when the method is safe to
  // repeat or the upload carries an Idempotency-Key the server reconciles a
  // retry onto (the asset import). `transportRetries` folds a caller's
  // resend-on-transport-failure into the same bounded budget of `retries`
  // re-sends (busy.js).
  const keyed = Object.keys(headers || {}).some((k) => k.toLowerCase() === "idempotency-key");
  return busy.withBusyRetry(once, { signal, retries, replaySafe: safeToRepeat(method) || keyed, transportRetries });
}

// The deterministic org for an OPAQUE foreign bearer on a multi-org server
// (task-spor-client-config-tenant-unification-and-refresh,
// issue-spor-foreign-bearer-incorrect-tenant-stamping). The selector is
// synchronous and cannot ask the server, so it reads a cached `GET /v1/me`
// `org` echo (auth.echoedBearerOrg) and, absent one, leaves the org unknown
// rather than borrowing the first same-server tenant's. This is the async half
// that asks and records. It only spends the round trip when the answer is
// genuinely ambiguous: a bearer that is no store entry's own (`key` null), has
// no JWT `org` claim, on a server the store holds MORE than one org for, with
// no answer cached (a recorded failure is retried after
// auth.BEARER_ORG_RETRY_MS). Not in a dispatched agent run — its tenant takes
// its org from the JWT claim alone. Fail-open: any error records nothing
// durable beyond the failure stamp and resolves null. Returns the echoed org
// (or null) and re-resolves the config's memoized tenant when one landed.
function bearerOrgEchoWanted(cfg, now = Date.now()) {
  if (!cfg || typeof cfg.tenant !== "function") return null;
  if (typeof cfg.agentRun === "function" && cfg.agentRun()) return null;
  const t = cfg.tenant();
  if (!t || t.key || !t.token || !t.server || auth.jwtOrg(t.token)) return null;
  const home = cfg.userConfigHome();
  const store = auth.readStore(home);
  const orgs = new Set(
    Object.values(store.tenants)
      .filter((x) => auth.normServer(x.server) === t.server)
      .map((x) => x.org || ""),
  );
  if (orgs.size < 2) return null;
  const e = auth.bearerOrgEntry(home, t.server, t.token);
  if (e && (e.org || now - Number(e.at || 0) < auth.BEARER_ORG_RETRY_MS)) return null;
  return { t, home };
}

async function echoBearerOrg(cfg, { timeoutMs = 3000, now = Date.now() } = {}) {
  const want = bearerOrgEchoWanted(cfg, now);
  if (!want) return null;
  const { t, home } = want;
  const r = await _attempt(cfg, "GET", "/v1/me", { timeoutMs, bearer: t.token, retry: false });
  const org = r && r.ok && r.json && typeof r.json.org === "string" && r.json.org ? r.json.org : null;
  // A transport failure is not the server's answer: leave nothing cached so
  // the next call asks again.
  if (!r || r.transport) return null;
  try {
    auth.recordBearerOrg(home, t.server, t.token, org, now);
  } catch {
    return org;
  }
  if (org && "_tenant" in cfg) cfg._tenant = undefined;
  return org;
}

module.exports = {
  base,
  token,
  isRemote,
  request,
  get,
  post,
  del,
  download,
  exchange,
  // the hook engines' auth-failure retry (u.curlWithRefresh) refreshes through
  // the same door as request(), so the two surfaces can't drift on which
  // tenant a 401/403 refreshes
  refreshAfterAuthFailure,
  entryResendSafe,
  // the opaque-foreign-bearer org echo (GET /v1/me), cached for the selector
  echoBearerOrg,
  bearerOrgEchoWanted,
  // exported for direct unit test of the stale-socket retry rule (isStaleSocketError,
  // safeToRepeat) without standing up a real server
  isStaleSocketError,
  safeToRepeat,
  nodesWriteResendSafe,
  // one reading of a transport failure for every CLI verb
  transportError,
  isUnreachable,
  describeTransport,
  busyRetryable,
};

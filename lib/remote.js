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

function refreshableTenant(cfg) {
  if (!cfg || typeof cfg.tenant !== "function") return null;
  const t = cfg.tenant();
  return t && t.refresh_token ? t : null;
}

function shouldRefresh(t, nowS = Math.floor(Date.now() / 1000)) {
  if (!t || !t.refresh_token) return false;
  if (!t.token) return true;
  return Number.isFinite(t.exp) && t.exp <= nowS + REFRESH_SKEW_S;
}

async function bearerForRequest(cfg, tokenOverride) {
  if (tokenOverride) return tokenOverride;
  const t = refreshableTenant(cfg);
  if (shouldRefresh(t)) {
    const key = t.key || auth.tenantKey(t.server, t.org);
    const fresh = await auth.refreshTenant(cfg.userConfigHome(), key);
    if (fresh) return fresh;
  }
  return token(cfg);
}

async function refreshAfterAuthFailure(cfg) {
  const t = refreshableTenant(cfg);
  if (!t) return null;
  const key = t.key || auth.tenantKey(t.server, t.org);
  return auth.refreshTenant(cfg.userConfigHome(), key);
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

// A single HTTP attempt with an explicit bearer. `retry` gates the ONE
// stale-socket retry below — pass a truthy value only when the request is
// safe to repeat (safeToRepeat()); `_retried` prevents a second retry from
// itself retrying, so a request is attempted at most twice regardless of how
// many stale-socket errors it hits.
async function _attempt(cfg, method, apiPath, { body, timeoutMs, bearer, retry, _retried }) {
  const url = base(cfg) + apiPath;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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
    const cause = e && e.cause;
    const err = {
      ok: false,
      transport: true,
      error: e && e.message ? e.message : String(e),
      cause: cause && cause.message,
      code: cause && cause.code,
    };
    if (retry && !_retried && isStaleSocketError(err)) {
      return _attempt(cfg, method, apiPath, { body, timeoutMs, bearer, retry, _retried: true });
    }
    return err;
  } finally {
    clearTimeout(timer);
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
async function request(cfg, method, apiPath, { body, timeoutMs = 6000, token: tokenOverride, idempotent } = {}) {
  const bearer = await bearerForRequest(cfg, tokenOverride);
  const retry = safeToRepeat(method, { body, idempotent });
  const r = await _attempt(cfg, method, apiPath, { body, timeoutMs, bearer, retry });
  if ((r.status === 401 || r.status === 403) && !tokenOverride) {
    const fresh = await refreshAfterAuthFailure(cfg);
    if (fresh) return _attempt(cfg, method, apiPath, { body, timeoutMs, bearer: fresh, retry });
  }
  return r;
}

const get = (cfg, p, opts) => request(cfg, "GET", p, opts);
const post = (cfg, p, body, opts) => request(cfg, "POST", p, { ...(opts || {}), body });
const del = (cfg, p, opts) => request(cfg, "DELETE", p, opts);

// A binary-safe GET for endpoints that stream non-JSON bodies — the
// /v1/export tarball (`spor export`, task-spor-export-cli-verb). request()
// reads res.text(), which corrupts binary; this reads the body as an
// arrayBuffer and returns it as a Buffer alongside the response headers
// (export rides x-substrate-head / x-substrate-node-count there, not the body).
async function _download(cfg, apiPath, { timeoutMs, bearer }) {
  const url = base(cfg) + apiPath;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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
    return { ok: false, transport: true, error: e && e.message ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// Returns { ok, status, buffer, headers } on an HTTP response, or
// { ok:false, transport:true, error } when it never completed. Never throws.
// Mirrors request()'s proactive + refresh-once-on-401 behavior for store-based
// tenants; a flat/env token has no refresh_token, so that branch is a no-op there.
// Default timeout is generous — an export can be large.
async function download(cfg, apiPath, { timeoutMs = 60000, token: tokenOverride } = {}) {
  const bearer = await bearerForRequest(cfg, tokenOverride);
  const r = await _download(cfg, apiPath, { timeoutMs, bearer });
  if ((r.status === 401 || r.status === 403) && !tokenOverride) {
    const fresh = await refreshAfterAuthFailure(cfg);
    if (fresh) return _download(cfg, apiPath, { timeoutMs, bearer: fresh });
  }
  return r;
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
  // the hook engines' auth-failure retry (u.curlWithRefresh) refreshes through
  // the same door as request(), so the two surfaces can't drift on which
  // tenant a 401/403 refreshes
  refreshAfterAuthFailure,
  // the opaque-foreign-bearer org echo (GET /v1/me), cached for the selector
  echoBearerOrg,
  bearerOrgEchoWanted,
  // exported for direct unit test of the stale-socket retry rule (isStaleSocketError,
  // safeToRepeat) without standing up a real server
  isStaleSocketError,
  safeToRepeat,
};

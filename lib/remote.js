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

// A single HTTP attempt with an explicit bearer.
async function _attempt(cfg, method, apiPath, { body, timeoutMs, bearer }) {
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
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        /* non-JSON body left as text */
      }
    }
    return { ok: res.ok, status: res.status, json, text };
  } catch (e) {
    return { ok: false, transport: true, error: e && e.message ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// One request. Returns { ok, status, json, text } on an HTTP response (any
// status), or { ok:false, transport:true, error } when the request never
// completed. Never throws. `opts.token` overrides the cfg-resolved bearer for
// this one call — `spor dispatch` uses it to authenticate as the freshly-minted
// agent token (not the person token) when late-binding the run session
// (issue-spor-dispatch-bg-session-late-bind).
//
// Transparent per-tenant refresh (dec-spor-client-cli-mode-tenant-resolution):
// before a request, if the active store tenant carries a refresh_token and its
// access token is absent/near-expiry, refresh it proactively. If the server still
// answers 401/403, refresh once and retry. The flat/env path has no refresh_token,
// so this is a no-op there — byte-identical.
async function request(cfg, method, apiPath, { body, timeoutMs = 6000, token: tokenOverride } = {}) {
  const bearer = await bearerForRequest(cfg, tokenOverride);
  const r = await _attempt(cfg, method, apiPath, { body, timeoutMs, bearer });
  if ((r.status === 401 || r.status === 403) && !tokenOverride) {
    const fresh = await refreshAfterAuthFailure(cfg);
    if (fresh) return _attempt(cfg, method, apiPath, { body, timeoutMs, bearer: fresh });
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

module.exports = { base, token, isRemote, request, get, post, del, download };

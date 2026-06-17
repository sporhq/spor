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

// Server base + token resolve through the same precedence as everything else:
// the config cascade value (which already folds in the SPOR_*/SUBSTRATE_* env
// layer), falling back to a raw env dual-read when called without a config.
function base(cfg) {
  const v = cfg ? cfg.get("server") : home.envDual("SERVER");
  return (v || "").replace(/\/+$/, "");
}
function token(cfg) {
  const v = cfg ? cfg.get("token") : home.envDual("TOKEN");
  return v || "";
}
function isRemote(cfg) {
  return base(cfg).length > 0;
}

// One request. Returns { ok, status, json, text } on an HTTP response (any
// status), or { ok:false, transport:true, error } when the request never
// completed. Never throws. `opts.token` overrides the cfg-resolved bearer for
// this one call — `spor dispatch` uses it to authenticate as the freshly-minted
// agent token (not the person token) when late-binding the run session
// (issue-spor-dispatch-bg-session-late-bind).
async function request(cfg, method, apiPath, { body, timeoutMs = 6000, token: tokenOverride } = {}) {
  const url = base(cfg) + apiPath;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${tokenOverride || token(cfg)}`,
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

const get = (cfg, p, opts) => request(cfg, "GET", p, opts);
const post = (cfg, p, body, opts) => request(cfg, "POST", p, { ...(opts || {}), body });
const del = (cfg, p, opts) => request(cfg, "DELETE", p, opts);

module.exports = { base, token, isRemote, request, get, post, del };

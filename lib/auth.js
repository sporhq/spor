"use strict";
// auth.js — the multi-tenant credential store (task-cc-spor-client-multitenant-
// credential-store, dec-spor-client-cli-mode-tenant-resolution).
//
// Spor server tokens are ORG-SCOPED (the `org` claim is the routing + isolation
// key — dec-spor-hosting-single-host-token-routing), so a person in N orgs holds
// N credentials. This module is the zero-dependency store + per-tenant token
// refresh that holds them: `$SPOR_HOME/auth/credentials.json` (0600), keyed by
// `(issuer, org)` where the issuer is the server base URL. It mirrors the
// server's own `auth/tokens.json` and closes the export/restore secret-loss gap
// that a flat `config.json {server, token}` had.
//
// Store shape:
//   { version: 1,
//     tenants: { "<server>/<org>": { server, org, label?, person?, email?,
//                                    access_token, refresh_token?, exp?, jwks_uri? } },
//     default: "<server>/<org>" | null }
//
// The TENANT SELECTOR (which entry is active for a given cwd/env) lives in
// lib/config.js — this module is pure storage + the OAuth refresh/device calls.
// Fail-open like the rest of the client (dec-cc-fail-open-hooks): a missing or
// malformed store reads as empty, never throws.

const fs = require("fs");
const path = require("path");

const STORE_VERSION = 1;

function authDir(userConfigHome) {
  return path.join(userConfigHome, "auth");
}
function credentialsPath(userConfigHome) {
  return path.join(authDir(userConfigHome), "credentials.json");
}

function emptyStore() {
  return { version: STORE_VERSION, tenants: {}, default: null };
}

// Read the store. Missing file -> empty store (no error); malformed -> empty
// store (fail-open, so a corrupt file never costs the user the CLI — they can
// re-login). Always returns a well-formed { version, tenants, default }.
function readStore(userConfigHome) {
  let raw;
  try {
    raw = fs.readFileSync(credentialsPath(userConfigHome), "utf8");
  } catch {
    return emptyStore(); // absent
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return emptyStore(); // malformed — do not throw
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return emptyStore();
  const tenants =
    data.tenants && typeof data.tenants === "object" && !Array.isArray(data.tenants) ? data.tenants : {};
  return {
    version: typeof data.version === "number" ? data.version : STORE_VERSION,
    tenants,
    default: typeof data.default === "string" && tenants[data.default] ? data.default : null,
  };
}

// Persist the store, 0600 (it holds bearer tokens). Creates auth/ if needed.
// The dir lives under the machine-local user config home, which is already in
// the shared-graph .gitignore (util.GRAPH_IGNORES carries /auth/), so it never
// rides a shared graph's git flow.
function writeStore(userConfigHome, store) {
  const dir = authDir(userConfigHome);
  fs.mkdirSync(dir, { recursive: true });
  const file = credentialsPath(userConfigHome);
  const body =
    JSON.stringify(
      { version: STORE_VERSION, tenants: store.tenants || {}, default: store.default || null },
      null,
      2,
    ) + "\n";
  fs.writeFileSync(file, body, { mode: 0o600 });
  // writeFileSync's mode only applies on CREATE; chmod to enforce 0600 on an
  // existing file too (best-effort — a noop/failure on Windows is harmless).
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* platform without POSIX perms */
  }
  return file;
}

function normServer(s) {
  return (s || "").replace(/\/+$/, "");
}
// The (issuer, org) key. org may be "" (a single-tenant / self-host server with
// no org claim) — then the key is just "<server>/", one tenant per server.
function tenantKey(server, org) {
  return `${normServer(server)}/${org || ""}`;
}

// Decode the `org` claim from a JWT access token without verifying it (we only
// read it to KEY the credential locally; the server is the only verifier). A
// connector JWT (dec-spor-hosting-connector-jwt-frontdoor-mint) carries org;
// an opaque `spor_oat_`/`spor_pat_` token is not a JWT -> null.
function decodeJwt(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
function jwtOrg(token) {
  const p = decodeJwt(token);
  return p && typeof p.org === "string" && p.org ? p.org : null;
}
function jwtExp(token) {
  const p = decodeJwt(token);
  return p && Number.isFinite(p.exp) ? p.exp : null;
}

// All tenants matching an org slug (an org may exist on more than one server).
function findByOrg(store, org) {
  return Object.keys(store.tenants)
    .filter((k) => store.tenants[k].org === org)
    .map((k) => ({ key: k, ...store.tenants[k] }));
}

// Resolve a user-supplied selector (an exact "<server>/<org>" key, or a bare org
// slug) to a single tenant key. Returns { key } | { ambiguous: [keys] } |
// { notFound: true }.
function resolveKey(store, selector) {
  if (!selector) return { notFound: true };
  if (store.tenants[selector]) return { key: selector };
  const matches = findByOrg(store, selector);
  if (matches.length === 1) return { key: matches[0].key };
  if (matches.length > 1) return { ambiguous: matches.map((m) => m.key) };
  return { notFound: true };
}

// ADD or replace a tenant entry (the `spor auth login` / `spor join` acquirer).
// Keys by (server, org) where org is the given org, else the JWT claim, else "".
// Never clobbers a SIBLING tenant. Sets the default per `makeDefault`:
//   true  -> always become default
//   false -> never change the default
//   undefined (default) -> become default only when it is the first tenant OR no
//                          default is currently set (so a fresh store/login is
//                          immediately usable, but a bulk import does not steal
//                          an existing active choice).
// Returns { key, org, isFirst, becameDefault }.
function upsertTenant(userConfigHome, entry, { makeDefault } = {}) {
  const store = readStore(userConfigHome);
  const org = entry.org || jwtOrg(entry.access_token) || "";
  const key = tenantKey(entry.server, org);
  const isFirst = Object.keys(store.tenants).length === 0;
  store.tenants[key] = {
    server: normServer(entry.server),
    org,
    ...(entry.label ? { label: entry.label } : {}),
    ...(entry.person ? { person: entry.person } : {}),
    ...(entry.email ? { email: entry.email } : {}),
    access_token: entry.access_token || "",
    ...(entry.refresh_token ? { refresh_token: entry.refresh_token } : {}),
    ...(entry.exp != null ? { exp: entry.exp } : {}),
    ...(entry.jwks_uri ? { jwks_uri: entry.jwks_uri } : {}),
  };
  let becameDefault = false;
  if (makeDefault === true || (makeDefault !== false && (isFirst || !store.default))) {
    store.default = key;
    becameDefault = true;
  }
  writeStore(userConfigHome, store);
  return { key, org, isFirst, becameDefault };
}

// Remove one tenant (by key or org slug). Repicks the default to the first
// remaining tenant when the removed one was default. Returns { ok, key } or
// { ok:false, notFound } / { ok:false, ambiguous:[keys] }.
function removeTenant(userConfigHome, selector) {
  const store = readStore(userConfigHome);
  const r = resolveKey(store, selector);
  if (!r.key) return { ok: false, ...r };
  delete store.tenants[r.key];
  if (store.default === r.key) store.default = Object.keys(store.tenants)[0] || null;
  writeStore(userConfigHome, store);
  return { ok: true, key: r.key };
}

// Clear every tenant.
function clearAll(userConfigHome) {
  const store = readStore(userConfigHome);
  const n = Object.keys(store.tenants).length;
  writeStore(userConfigHome, emptyStore());
  return n;
}

// Set the default (active) tenant by key or org slug.
function setDefault(userConfigHome, selector) {
  const store = readStore(userConfigHome);
  const r = resolveKey(store, selector);
  if (!r.key) return { ok: false, ...r };
  store.default = r.key;
  writeStore(userConfigHome, store);
  return { ok: true, key: r.key };
}

// ---------------------------------------------------------------------------
// OAuth calls (RFC 8628 device grant + RFC 6749 refresh). Zero-dep: `fetch` is a
// Node 20+ global. Plain JSON bodies — the Spor front door's token endpoint is
// lenient (accepts form OR JSON). Fail-soft: transport errors return
// { ok:false, transport:true } rather than throwing, like lib/remote.js.
// ---------------------------------------------------------------------------

async function oauthPost(server, apiPath, params, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(normServer(server) + apiPath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
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

const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

// RFC 8628 §3.1 — start a device authorization. Returns the oauthPost result;
// on ok the json carries { device_code, user_code, verification_uri,
// verification_uri_complete, expires_in, interval }.
//
// `resource` is the RFC 8707 resource indicator — the resource server this token will
// call (the `server` origin the CLI is logging in for). Sending it lets the issuer
// scope the minted token's `aud` to that resource (task-spor-app-api-strict-audience-
// restriction). It is a no-op against an issuer that doesn't allowlist the origin
// (self-host / un-armed hosted), so it is always safe to send.
function deviceAuthorize(server, { clientId = "spor-cli", scope, resource } = {}) {
  return oauthPost(server, "/oauth/device_authorization", {
    client_id: clientId,
    ...(scope ? { scope } : {}),
    ...(resource ? { resource } : {}),
  });
}

// RFC 8628 §3.4 — one poll of the token endpoint with a device_code. While
// pending the server answers 400 { error: "authorization_pending" | "slow_down" }
// and on approval 200 { access_token, refresh_token, expires_in, scope? }.
function devicePoll(server, deviceCode) {
  return oauthPost(server, "/oauth/token", { grant_type: DEVICE_GRANT_TYPE, device_code: deviceCode });
}

// Transparent per-tenant refresh (RFC 6749 §6). POSTs the tenant's refresh_token
// to its issuer, and on success updates the stored access_token (and the rotated
// refresh_token) + exp in place. Returns the new access token, or null on any
// failure (caller falls back to the stale token / surfaces the 401). Re-reads
// the store before writing so it never clobbers a concurrent login.
async function refreshTenant(userConfigHome, selector) {
  const store = readStore(userConfigHome);
  const r = resolveKey(store, selector);
  if (!r.key) return null;
  const t = store.tenants[r.key];
  if (!t || !t.refresh_token) return null;
  const resp = await oauthPost(t.server, "/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: t.refresh_token,
  });
  if (!resp.ok || !resp.json || !resp.json.access_token) return null;
  const fresh = readStore(userConfigHome);
  if (!fresh.tenants[r.key]) return null;
  fresh.tenants[r.key].access_token = resp.json.access_token;
  if (resp.json.refresh_token) fresh.tenants[r.key].refresh_token = resp.json.refresh_token;
  const exp =
    resp.json.expires_in != null
      ? Math.floor(Date.now() / 1000) + Number(resp.json.expires_in)
      : jwtExp(resp.json.access_token);
  if (exp) fresh.tenants[r.key].exp = exp;
  writeStore(userConfigHome, fresh);
  return resp.json.access_token;
}

module.exports = {
  STORE_VERSION,
  authDir,
  credentialsPath,
  emptyStore,
  readStore,
  writeStore,
  normServer,
  tenantKey,
  decodeJwt,
  jwtOrg,
  jwtExp,
  findByOrg,
  resolveKey,
  upsertTenant,
  removeTenant,
  clearAll,
  setDefault,
  oauthPost,
  deviceAuthorize,
  devicePoll,
  refreshTenant,
  DEVICE_GRANT_TYPE,
};

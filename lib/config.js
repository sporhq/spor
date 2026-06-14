"use strict";
// config.js — client configuration cascade (dec-spor-client-config-cascade).
//
// A zero-dependency JSON layer that resolves local/remote/off mode and every
// client setting, consumed by the hook engines and the bin/spor CLI. This is
// the concrete "mode via a lib/config cascade" decided in
// dec-cc-spor-cli-universal-surface.
//
// Precedence, highest wins:
//   1. CLI flags                (passed in by the caller)
//   2. environment              SPOR_* || legacy SUBSTRATE_* (home.envDual,
//                               dec-cc-spor-rename-compat-dual-read)
//   3. repo .spor.json          nearest-ancestor walk, deepest wins
//   4. user   $SPOR_HOME/config.json
//   5. global $XDG_CONFIG_HOME/spor/config.json (~/.config/spor/config.json)
//   6. built-in defaults
//
// Env sits ABOVE the config files on purpose: with no config files present
// every resolved value equals today's env-or-hardcoded default, so existing
// behavior is byte-identical (norm-cc-byte-identical-refactor). For migrated
// settings the caller still passes its current literal as the get() fallback,
// so a mismatch in the DEFAULTS table can never change behavior.
//
// Fail-open like the hook engines (dec-cc-fail-open-hooks): a malformed config
// file is skipped with a recorded warning, never thrown.

const fs = require("fs");
const os = require("os");
const path = require("path");
const home = require("./shell/home.js");

// Genuinely-new structural defaults only. Migrated env values are intentionally
// absent here — callers pass their existing inline literal as the get()
// fallback, keeping byte-identical behavior independent of this table.
const DEFAULTS = {
  mode: "auto", // auto | local | remote | off
  enabled: true, // per-repo no-op disable
  search: { projects: { include: [], exclude: [], boost: {} } },
};

// The repo layer is committable, so it must never carry a secret. token is
// honored only from env/user/global; a repo-level token is dropped + warned.
const REPO_FORBIDDEN_KEYS = ["token"];

// Recognized top-level keys — an unknown one (a typo, a stale key) earns a
// warning so a silently-ignored setting is visible rather than mysterious.
const KNOWN_KEYS = new Set([
  "mode", "server", "token", "home", "nodes", "enabled",
  "search", "distill", "nudge", "inferCommits",
]);

// Map of env var (sans SPOR_/SUBSTRATE_ prefix) -> config key path. Only vars
// that are CLIENT configuration; server-side ops (GARDENER_MS, INGEST_CMD,
// SANDBOX, SOLO, ROOT_ID), worker IPC (STEP), and the recursion guard
// (DISTILLING) are deliberately excluded — they stay pure env.
const ENV_MAP = [
  ["SERVER", "server"],
  ["TOKEN", "token"],
  ["HOME", "home"],
  ["NODES", "nodes"],
  ["DISTILL_CMD", "distill.cmd"],
  ["DISTILL_MODEL", "distill.model"],
  ["DEBOUNCE", "distill.debounce"],
  ["DISTILL", "distill.enabled"], // SPOR_DISTILL=0 disables
  ["NUDGE", "nudge.enabled"], // SPOR_NUDGE=0 disables
  ["NUDGE_CMD", "nudge.cmd"],
  ["INFER_COMMITS", "inferCommits.enabled"],
  ["INFER_THRESHOLD", "inferCommits.threshold"],
];

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

// Deep-merge src onto dst (mutates dst). Objects merge recursively; arrays and
// scalars replace wholesale (a higher layer's list overrides, never appends).
function deepMerge(dst, src) {
  for (const k of Object.keys(src)) {
    const sv = src[k];
    if (isPlainObject(sv) && isPlainObject(dst[k])) deepMerge(dst[k], sv);
    else dst[k] = isPlainObject(sv) ? deepMerge({}, sv) : sv;
  }
  return dst;
}

// Set a dotted path on an object, creating intermediate objects.
function setPath(obj, dotted, value) {
  const parts = dotted.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isPlainObject(cur[parts[i]])) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

// Read first defined value along a dotted path, or undefined.
function getPath(obj, dotted) {
  let cur = obj;
  for (const p of dotted.split(".")) {
    if (!isPlainObject(cur) || !(p in cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

// Parse a JSON config file. Returns {data, warning}. Missing file -> {} with no
// warning; malformed -> {} with a warning (fail-open).
function readJsonFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { data: {} }; // absent
  }
  try {
    const data = JSON.parse(text);
    return { data: isPlainObject(data) ? data : {} };
  } catch (e) {
    return { data: {}, warning: `ignored malformed config ${file}: ${e.message}` };
  }
}

// Strip secrets the repo layer must not carry, recording a warning per hit.
function sanitizeRepoLayer(data, file, warnings) {
  for (const k of REPO_FORBIDDEN_KEYS) {
    if (k in data) {
      delete data[k];
      warnings.push(`ignored '${k}' in committable repo config ${file} (secrets belong in env or user/global config)`);
    }
  }
  return data;
}

// All .spor.json files from cwd up to the filesystem root, shallowest first
// (so a deeper/nearer file overrides an ancestor when merged in order). Mirrors
// the nearest-ancestor `.spor` marker walk in scripts/engines/util.js.
function repoConfigFiles(cwd) {
  const files = [];
  const seen = new Set();
  for (let dir = cwd || ""; dir; dir = path.dirname(dir)) {
    if (seen.has(dir)) break;
    seen.add(dir);
    const f = path.join(dir, ".spor.json");
    if (fs.existsSync(f)) files.push(f);
    if (dir === path.dirname(dir)) break; // hit fs root
  }
  return files.reverse(); // shallowest first
}

function userConfigFile(env) {
  return path.join(home.graphHome(env), "config.json");
}

function globalConfigFile(env = process.env) {
  const xdg = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim();
  const base = xdg || path.join(os.homedir(), ".config");
  return path.join(base, "spor", "config.json");
}

// Build the env layer object from ENV_MAP, including a key only when the env
// var is actually set (envDual returns undefined for unset/empty) so it never
// clobbers a lower layer with undefined.
function envLayer(env = process.env) {
  const layer = {};
  for (const [name, keyPath] of ENV_MAP) {
    const v = home.envDual(name, env);
    if (v !== undefined) setPath(layer, keyPath, v);
  }
  return layer;
}

// Load and merge every layer. Returns a Config with a typed accessor.
//   opts.cwd   — directory to anchor the repo-config walk (default process.cwd)
//   opts.env   — environment object (default process.env)
//   opts.cli   — already-parsed CLI overrides as a config-shaped object
function loadConfig(opts = {}) {
  const env = opts.env || process.env;
  const cwd = opts.cwd || process.cwd();
  const warnings = [];

  const merged = deepMerge({}, DEFAULTS);

  // 5 global, 4 user (low precedence first)
  for (const file of [globalConfigFile(env), userConfigFile(env)]) {
    const { data, warning } = readJsonFile(file);
    if (warning) warnings.push(warning);
    deepMerge(merged, data);
  }

  // 3 repo .spor.json, shallowest first so nearest wins; secrets stripped
  for (const file of repoConfigFiles(cwd)) {
    const { data, warning } = readJsonFile(file);
    if (warning) warnings.push(warning);
    deepMerge(merged, sanitizeRepoLayer(data, file, warnings));
  }

  // 2 environment
  deepMerge(merged, envLayer(env));

  // 1 CLI flags (highest)
  if (isPlainObject(opts.cli)) deepMerge(merged, opts.cli);

  for (const k of Object.keys(merged)) {
    if (!KNOWN_KEYS.has(k)) warnings.push(`unknown config key '${k}' ignored`);
  }

  return new Config(merged, { warnings, env, cwd });
}

class Config {
  constructor(values, meta) {
    this.values = values;
    this.warnings = meta.warnings || [];
    this._env = meta.env;
    this._cwd = meta.cwd;
  }

  // Raw resolved value at a dotted path, else fallback. Pass the caller's
  // existing inline literal as fallback to stay byte-identical when unset.
  get(dotted, fallback = undefined) {
    const v = getPath(this.values, dotted);
    return v === undefined ? fallback : v;
  }

  // Boolean coercion preserving the shell convention: the string "0" and
  // "false" are false, an explicit boolean passes through, everything else set
  // is truthy. Honors the existing SPOR_NUDGE=0 / SPOR_DISTILL=0 semantics.
  getBool(dotted, fallback) {
    const v = this.get(dotted, undefined);
    if (v === undefined) return fallback;
    if (typeof v === "boolean") return v;
    const s = String(v).trim().toLowerCase();
    return !(s === "0" || s === "false" || s === "");
  }

  getNum(dotted, fallback) {
    const v = this.get(dotted, undefined);
    if (v === undefined) return fallback;
    const n = typeof v === "number" ? v : parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  }

  getList(dotted, fallback = []) {
    const v = this.get(dotted, undefined);
    return Array.isArray(v) ? v : fallback;
  }

  // Effective graph home / nodes dir, honoring config then the existing
  // home.graphHome() fallback so unset behavior is unchanged.
  graphHome() {
    return this.get("home", undefined) || home.graphHome(this._env);
  }
  nodesDir() {
    return this.get("nodes", undefined) || path.join(this.graphHome(), "nodes");
  }

  // Resolved mode: explicit unless "auto", in which case a server URL means
  // remote, otherwise local. "off" makes the plugin a no-op.
  mode() {
    const m = this.get("mode", "auto");
    if (m && m !== "auto") return m;
    return this.get("server", undefined) ? "remote" : "local";
  }
  enabled() {
    return this.get("mode", "auto") !== "off" && this.getBool("enabled", true);
  }
}

module.exports = { loadConfig, Config, DEFAULTS, ENV_MAP };

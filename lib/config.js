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
  // `enabled` is intentionally ABSENT from the defaults: the plugin is opt-IN
  // per repo (task-spor-plugin-opt-in-default). Leaving it unset lets
  // Config.enabled() tell "no one set this" (fall back to repo-marker presence)
  // apart from an explicit true/false anywhere in the cascade. See enabled().
  search: { projects: { include: [], exclude: [], boost: {} } },
  // Local-mode `front` queue signal reconstructed from git history
  // (task-cc-local-front-productionize, dec-cc-queue-front-from-attribution):
  // `enabled` toggles the reconstruction (off => byte-identical pre-front
  // ordering), `days` is the rolling window, matching the server's request-log
  // window. Remote mode ignores both — there the server owns front. These are
  // genuinely-new structural defaults (the CLI flags they replace had these
  // same literals), so they live here rather than as get() fallbacks.
  queue: { front: { enabled: true, days: 7 } },
};

// The repo layer is committable, so it must never carry a secret. token is
// honored only from env/user/global; a repo-level token is dropped + warned.
const REPO_FORBIDDEN_KEYS = ["token"];

// Recognized top-level keys — an unknown one (a typo, a stale key) earns a
// warning so a silently-ignored setting is visible rather than mysterious.
const KNOWN_KEYS = new Set([
  "mode", "server", "token", "home", "nodes", "enabled",
  "search", "queue", "distill", "nudge", "claimNudge", "inferCommits", "dispatch",
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
  ["ENABLED", "enabled"], // SPOR_ENABLED=1 opts a repo in (=0 disables) via the cascade
  ["DISTILL_CMD", "distill.cmd"],
  ["DISTILL_MODEL", "distill.model"],
  ["DEBOUNCE", "distill.debounce"],
  ["DISTILL", "distill.enabled"], // SPOR_DISTILL=0 disables
  ["DISTILL_TIMEOUT", "distill.timeoutMs"], // bound a hung distill backend (ms)
  ["NUDGE", "nudge.enabled"], // SPOR_NUDGE=0 disables
  ["NUDGE_CMD", "nudge.cmd"],
  ["NUDGE_MAX", "nudge.maxCalls"], // per-session ceiling on classifier calls
  ["NUDGE_TIMEOUT", "nudge.timeoutMs"], // bound a hung nudge backend (ms)
  ["CLAIM_NUDGE", "claimNudge.enabled"], // SPOR_CLAIM_NUDGE=0 disables the claim heartbeat+nudge
  ["CLAIM_NUDGE_TIMEOUT", "claimNudge.timeoutMs"], // bound the lease-lookup/heartbeat curls (ms)
  ["INFER_COMMITS", "inferCommits.enabled"],
  ["INFER_THRESHOLD", "inferCommits.threshold"],
  ["QUEUE_FRONT", "queue.front.enabled"], // SPOR_QUEUE_FRONT=0 disables local git-derived front
  ["QUEUE_FRONT_DAYS", "queue.front.days"], // rolling front window (days)
  ["QUEUE_PROJECT", "queue.project"], // default --project scope for `spor next` (both modes); explicit --project wins
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

// True when a repo-level opt-in MARKER exists anywhere from cwd up to the
// filesystem root: either a flat `.spor` identity marker or a `.spor.json`
// config file. Presence is the opt-in signal Config.enabled() falls back to
// when no explicit `enabled` flag is set anywhere in the cascade
// (task-spor-plugin-opt-in-default) — it marks a repo that `spor enable`,
// `spor link`, or `spor dispatch --backfill` has touched. Mirrors the
// nearest-ancestor walks used for `.spor.json` config and the `.spor` graph
// binding. Fail-open: existsSync never throws, so an unreadable level reads as
// absent rather than erroring.
function repoMarkerPresent(cwd) {
  const seen = new Set();
  for (let dir = cwd || ""; dir; dir = path.dirname(dir)) {
    if (seen.has(dir)) break;
    seen.add(dir);
    if (fs.existsSync(path.join(dir, ".spor")) || fs.existsSync(path.join(dir, ".spor.json"))) return true;
    if (dir === path.dirname(dir)) break; // hit fs root
  }
  return false;
}

// A per-repo `.spor` marker may bind this repo to a specific graph home via a
// `graph: <path>` key (issue-cc-local-mode-graph-sharing-gap,
// dec-spor-local-mode-sharing-boundary) — free local mode's async, git-shared
// graph. Unlike `.spor.json` config (which sits BELOW env, per this same
// cascade), this is an IDENTITY-LEVEL binding — the deliberate, committed "this
// repo's graph lives here" — so it OVERRIDES SPOR_HOME (the decision's
// requirement: a contributor with a personal global SPOR_HOME must still
// inherit the SHARED graph inside a shared-graph repo, or the feature is
// useless for them). It loses only to an explicit CLI --home. The flat `.spor`
// marker stays key:value (the same file projectSlug reads `repo:`/`project:`
// from); the value is a PATH, not a slug, resolved relative to the marker's own
// directory so a committed relative path like `../team-graph` is stable
// regardless of cwd. Nearest ancestor with a `graph:` key wins, mirroring the
// `.spor` / `.spor.json` walks; a deeper identity-only marker (`repo:` but no
// `graph:`) does not shadow an ancestor's binding. Fail-open: any read error
// skips that level. Returns { path, markerDir, raw } or null.
function repoMarkerGraph(cwd) {
  const seen = new Set();
  for (let dir = cwd || ""; dir; dir = path.dirname(dir)) {
    if (seen.has(dir)) break;
    seen.add(dir);
    let text = null;
    try {
      text = fs.readFileSync(path.join(dir, ".spor"), "utf8");
    } catch {
      /* no marker at this level */
    }
    if (text != null) {
      const m = text.match(/^graph:[ \t]*(.+?)[ \t]*$/m);
      if (m && m[1]) return { path: path.resolve(dir, m[1]), markerDir: dir, raw: m[1] };
    }
    if (dir === path.dirname(dir)) break; // hit fs root
  }
  return null;
}

// The PERSONAL user-config home — the env/default graph home (SPOR_HOME ||
// legacy || ~/.spor), independent of any per-repo `.spor` marker `graph:`
// override. The user config.json (server, token, and the machine-local
// dispatch.repos map) lives here and is read AND written here, even when a
// marker home redirects the GRAPH (nodes/history): the marker shares the graph
// over git, but config.json is machine-specific state that must never ride into
// the shared home (issue-spor-config-desync-shared-graph-home,
// dec-spor-client-config-cascade — "never a committable .spor.json, since paths
// are machine-specific"). graphHome() may differ (it follows the marker);
// userConfigHome() never does.
function userConfigHomeFor(env) {
  return home.graphHome(env);
}

function userConfigFile(env) {
  return path.join(userConfigHomeFor(env), "config.json");
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

  // 1.5 per-repo `.spor` marker graph binding (between env and CLI in spirit:
  // it overrides SPOR_HOME but never an explicit CLI --home). LOCAL mode only —
  // in remote mode the server is the graph and a local-sharing binding is
  // irrelevant (honoring it would merely relocate the cache dir). Resolve mode
  // from the already-merged values, mirroring Config.mode(). With no marker the
  // home is untouched, so unset behavior is byte-identical
  // (norm-cc-byte-identical-refactor).
  let markerGraph = null;
  const candidate = repoMarkerGraph(cwd);
  if (candidate) {
    const cliHome = isPlainObject(opts.cli) && opts.cli.home;
    const m = merged.mode && merged.mode !== "auto" ? merged.mode : merged.server ? "remote" : "local";
    if (m === "local" && !cliHome) {
      merged.home = candidate.path;
      markerGraph = candidate;
    }
  }

  for (const k of Object.keys(merged)) {
    if (!KNOWN_KEYS.has(k)) warnings.push(`unknown config key '${k}' ignored`);
  }

  // Opt-in marker presence (task-spor-plugin-opt-in-default): computed from the
  // same cwd ancestry as the config/graph walks. enabled() uses it only when no
  // explicit `enabled` flag was resolved above.
  const repoMarker = repoMarkerPresent(cwd);

  return new Config(merged, { warnings, env, cwd, markerGraph, repoMarker });
}

class Config {
  constructor(values, meta) {
    this.values = values;
    this.warnings = meta.warnings || [];
    this._env = meta.env;
    this._cwd = meta.cwd;
    this._markerGraph = meta.markerGraph || null;
    this._repoMarker = !!meta.repoMarker;
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
  // home.graphHome() fallback so unset behavior is unchanged. When a per-repo
  // `.spor` marker bound a `graph:` home, this is that shared home (the GRAPH —
  // nodes/history — follows the marker).
  graphHome() {
    return this.get("home", undefined) || home.graphHome(this._env);
  }
  // The PERSONAL user-config home — where the user config.json (server, token,
  // and the machine-local dispatch.repos map) is READ AND WRITTEN. Anchored at
  // the env/default home, INDEPENDENT of a marker `graph:` override: that
  // override redirects the shared GRAPH, not this machine-local config file
  // (issue-spor-config-desync-shared-graph-home). Equals graphHome() unless a
  // marker (or an explicit `home`/`.spor.json home`) moved the graph elsewhere;
  // it is the single anchor every config WRITE path must use so writes land
  // where the read layer (userConfigFile) will find them. The cascade's user
  // layer is read from exactly this home, so writes here round-trip.
  userConfigHome() {
    return userConfigHomeFor(this._env);
  }
  nodesDir() {
    return this.get("nodes", undefined) || path.join(this.graphHome(), "nodes");
  }

  // The per-repo shared graph home if this repo's `.spor` marker bound one via
  // `graph:` and it was applied (local mode only), else null
  // (issue-cc-local-mode-graph-sharing-gap). session-start uses it to ensure the
  // shared graph's .gitignore for machine-local state; equals graphHome() when
  // non-null. null in remote mode and for ordinary `.spor.json` home settings,
  // so neither triggers shared-graph hygiene.
  sharedGraphHome() {
    return this._markerGraph ? this._markerGraph.path : null;
  }

  // Resolved mode: explicit unless "auto", in which case a server URL means
  // remote, otherwise local. "off" makes the plugin a no-op.
  mode() {
    const m = this.get("mode", "auto");
    if (m && m !== "auto") return m;
    return this.get("server", undefined) ? "remote" : "local";
  }
  // Opt-in activation (task-spor-plugin-opt-in-default). Installing the npm
  // package + Claude Code plugin must NOT make every repo you open participate:
  // a markerless side project stays a full no-op so it never injects context or
  // distills nodes into the shared graph just because you ran an agent there. A
  // repo is active when, checked in order:
  //   1. mode is not "off" (an explicit mode:off is the hard kill, unchanged); AND
  //   2a. an `enabled` flag was resolved anywhere in the cascade — repo
  //       `.spor.json`, user/global config.json, SPOR_ENABLED env, or a CLI
  //       flag — honored verbatim (true activates, false disables); OR
  //   2b. no explicit flag, in which case the repo is active iff a repo-level
  //       opt-in marker (`.spor` or `.spor.json`) sits in the cwd ancestry,
  //       i.e. `spor enable` / `spor link` / `spor dispatch --backfill` touched
  //       it.
  // Default — no flag, no marker — is OFF. This is a deliberate behavior change
  // from the prior default-on (so the activation gate is NOT byte-identical);
  // every other resolved value stays byte-identical (norm-cc-byte-identical-
  // refactor).
  enabled() {
    if (this.get("mode", "auto") === "off") return false;
    const explicit = this.get("enabled", undefined);
    if (explicit !== undefined) return this.getBool("enabled", true);
    return this._repoMarker;
  }
}

module.exports = { loadConfig, Config, DEFAULTS, ENV_MAP, repoMarkerGraph, repoMarkerPresent };

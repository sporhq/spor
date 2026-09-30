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
const { gitToplevelAndCommonDir } = require("./shell/git-exec.js");
const home = require("./shell/home.js");
const auth = require("./auth.js");

// The hosted Spor service's REST base — the dedicated `api` resource host stood
// up by the host-role split (dec-spor-hosting-hostname-role-separation,
// task-spor-api-dedicated-host). This is the CLIENT-REPO ONBOARDING DEFAULT
// (task-spor-api-cli-default-server-base): the server URL `spor join` writes
// when the user opts into the hosted service without naming a URL, so onboarding
// is `spor join <token>` instead of `spor join https://api.sporhq.io <token>`.
//
// It is DELIBERATELY NOT a member of DEFAULTS: putting `server` there would make
// Config.mode() resolve to "remote" for EVERY repo with no config (flipping the
// local default for everyone and breaking norm-cc-byte-identical-refactor). The
// default applies ONLY at the explicit onboarding-write step; read-time mode
// resolution stays "local unless a server is configured", byte-identical.
const DEFAULT_SERVER = "https://api.sporhq.io";

// Every key's type, default, env spelling and repo-layer ban is declared ONCE,
// in lib/config-keys.js (task-spor-client-config-typed-key-table-and-explain);
// the tables below are DERIVED from it, never hand-extended.
const { KEYS, lookup: lookupKey, isNamespace, typeMatches } = require("./config-keys.js");

// The built-in defaults LAYER: only the structural defaults the table marks
// `applied` (mode, search.projects, queue.front — the set that predates the
// table). Every other key's default is still passed by its caller as the get()
// fallback, so the resolved value with no config files present is byte-identical
// (norm-cc-byte-identical-refactor); test/config-keys.test.js holds each caller
// literal equal to the table's declared default.
//
// `enabled` is intentionally NOT applied: the plugin is opt-IN per repo
// (task-spor-plugin-opt-in-default). Leaving it unset lets Config.enabled() tell
// "no one set this" (fall back to repo-marker presence) apart from an explicit
// true/false anywhere in the cascade. See enabled().
//
// Local-mode `front` queue signal reconstructed from git history
// (task-cc-local-front-productionize, dec-cc-queue-front-from-attribution):
// `queue.front.enabled` toggles the reconstruction (off => byte-identical
// pre-front ordering), `days` is the rolling window, matching the server's
// request-log window. Remote mode ignores both — there the server owns front.
const DEFAULTS = {};
for (const e of KEYS) {
  if (e.applied) setPath(DEFAULTS, e.key, Array.isArray(e.default) ? [...e.default] : isPlainObject(e.default) ? { ...e.default } : e.default);
}

// The repo layer is committable, so it must never carry a secret. token is
// honored only from env/user/global; a repo-level token is dropped + warned.
// (Declared as `noRepo: "secret"` in lib/config-keys.js.)
const REPO_FORBIDDEN_KEYS = KEYS.filter((e) => e.noRepo && !e.key.includes(".")).map((e) => e.key);

// Dotted paths the repo layer must not carry either — not because they are
// secrets, but because they are machine-local policy the repo layer must
// never define (task-spor-dispatch-declarative-custom-harness).
// `dispatch.harness.<id>` binds a harness id to a command plus a full argv
// template, and `dispatch.bin.<harness>` re-points a built-in launcher; both
// are documented as machine-local, belonging in the user
// `$SPOR_HOME/config.json`. Honoring them from a committable `.spor.json`
// would mean cloning a repo — or pulling a PR branch into one — is enough to
// choose the command a later `spor dispatch` on this box runs, and (with
// `dispatch.agent` set) enough to get that harness id auto-published to the
// fleet scheduler as a capability this box advertises.
// `dispatch.allowPersonToken` (task-spor-dispatch-person-token-hard-fail) is
// the same class of hazard from the other direction: it is the escape hatch
// that lets a mint failure fall back to attributing an agent's writes to the
// person instead of hard-failing. Left honorable from a committable repo
// layer, cloning a repo (or pulling a PR branch into one) would be enough to
// silently disable that hard-fail for anyone dispatching from the checkout —
// exactly the mis-attribution the flag exists to prevent by default.
//
// `distill.cmd`/`nudge.cmd`/`digest.intentCmd`
// (issue-spor-repo-layer-config-can-name-executables) join the list for a
// sharper reason than the three above: they name the backend spawned on the
// stdin-prompt/stdout-verdict contract for the distiller, the capture-nudge
// classifier, and the digest intent classifier, and those fire on the
// PASSIVE hook path — SessionEnd/PostToolUse/UserPromptSubmit of any session
// that merely opens the repo, no explicit `spor dispatch` required — with
// real prompt/transcript content piped to the backend's stdin. A
// repo-committed value here is not just an arbitrary-exec vector like the
// ones above but an EXFILTRATION vector: cloning a repo (or pulling a PR
// branch into one) would be enough to point a teammate's own passive hook
// calls at a script that ships their transcript content elsewhere.
//
// `dispatch.worktreeSetup`/`dispatch.worktreeTeardown` are DELIBERATELY NOT
// in this list, even though a repo-committed `.spor.json` can also set them
// to a shell command: they run only on an EXPLICIT `spor dispatch
// --worktree` into that repo — the same trust boundary as running the
// repo's own build script right after a clone — never on the passive hook
// path above, and carry no prompt/transcript content.
// dec-spor-dispatch-worktree-config-target-anchored already settled that a
// repo declaring its own worktree-setup script is the INTENDED shape of
// that feature, not an oversight; do not fold these two in here.
//
// All six listed are dropped with a warning, the same way a repo-level
// token is: the rule these enforce is that a WRITE SOMEONE ELSE CAN MAKE
// never defines machine-local dispatch/backend policy, of which "a graph
// write must never define what a machine executes" is the sibling half.
// (Declared as `noRepo` on the dotted keys in lib/config-keys.js.)
const REPO_FORBIDDEN_PATHS = KEYS.filter((e) => e.noRepo && e.key.includes(".")).map((e) => e.key);

// Recognized top-level keys — an unknown one (a typo, a stale key) earns a
// warning so a silently-ignored setting is visible rather than mysterious. The
// set is every declared key's first segment, so a new namespace can no longer
// be honored by ENV_MAP while warned about here
// (issue-spor-config-loader-work-namespace-warning).
const KNOWN_KEYS = new Set(KEYS.map((e) => e.key.split(".")[0]));

// Map of env var (sans SPOR_/SUBSTRATE_ prefix) -> config key path. Only vars
// that are CLIENT configuration; server-side ops (GARDENER_MS, INGEST_CMD,
// SANDBOX, SOLO, ROOT_ID), worker IPC (STEP), and the recursion guard
// (DISTILLING) are deliberately excluded — they stay pure env. SPOR_ORG is a
// TENANT selector, read by _resolveTenant, not a config value.
const ENV_MAP = KEYS.filter((e) => e.env).map((e) => [e.env, e.key]);

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

// True iff `p` is a regular file (follows symlinks). Fail-open: any stat error
// (absent, unreadable, EPERM) reads as "not a file" rather than throwing.
function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
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
  for (const dotted of REPO_FORBIDDEN_PATHS) {
    const segs = dotted.split(".");
    const leaf = segs.pop();
    let cur = data;
    for (const seg of segs) {
      cur = isPlainObject(cur) && Object.prototype.hasOwnProperty.call(cur, seg) ? cur[seg] : null;
      if (!cur) break;
    }
    if (isPlainObject(cur) && Object.prototype.hasOwnProperty.call(cur, leaf)) {
      delete cur[leaf];
      warnings.push(`ignored '${dotted}' in committable repo config ${file} (this is machine-local dispatch policy — declare it in $SPOR_HOME/config.json)`);
    }
  }
  return data;
}

// The main checkout's directory when `cwd` sits inside a LINKED git worktree,
// else null (issue-spor-cli-status-worktree-enable-detection). `--git-common-
// dir` always points at the main repo's `.git`, even from a linked worktree, so
// dirname(...) resolves to the main checkout regardless of where the worktree
// lives on disk — nested under the repo (`.claude/worktrees/<branch>`, the
// `spor dispatch`/`claude --worktree` convention) or entirely elsewhere (`git
// worktree add ../x`). This matters because the ordinary cwd-ancestor walk
// below can miss the main checkout's marker two ways: the worktree may share no
// directory ancestry with it at all, and even a NESTED worktree only inherits
// the main checkout's COMMITTED tree at worktree-add time — a `.spor`/
// `.spor.json` written (e.g. by `spor enable`) but not yet committed in the
// main working tree stays invisible to every linked worktree, nested or not.
// Mirrors scripts/engines/util.js's inferenceRoot() (same --git-common-dir
// resolution for the same worktree-collapsing problem), duplicated rather than
// imported: util.js sits ABOVE lib/ (it already requires this module for
// loadConfig), so lib/ reaching back up into scripts/engines/ would invert the
// layering, and inferenceRoot()'s contract differs anyway — it always returns
// A root (cwd's own, absent a linked worktree), where callers here need null
// specifically to mean "no extra fallback dir to probe". Fail-open: any git
// failure (no git, not a repo, cwd unset) returns null, so a plain checkout's
// ancestor walk is unaffected.
// Memoized per cwd — loadConfig() probes several marker walks against the same
// cwd in one call. gitToplevelAndCommonDir (shell/git-exec.js) is itself a
// process-lifetime cache keyed by cwd, shared with scripts/engines/util.js's
// identical probe (inferenceRoot/linkedWorktreeMainRoot) — previously each
// spawned its own `git rev-parse`, with swapped argument order, for the same
// cwd (task-spor-cli-lazy-load-modules). Env-scrubbed (gitSpawn, shell/git-
// exec.js) so an ambient GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR can't misdirect
// this worktree-root probe at a different repo
// (issue-spor-gittime-git-env-inheritance).
function gitMainRoot(cwd) {
  if (!cwd) return null;
  const { top, common } = gitToplevelAndCommonDir(cwd);
  const mainTop = common ? path.dirname(common) : null;
  return mainTop && top && mainTop !== top ? mainTop : null;
}

// True iff `dir` is `stop` itself or nested underneath it. Both are resolved
// first so a trailing slash / `..` segment can't make a sibling look nested.
function withinBoundary(dir, stop) {
  const d = path.resolve(dir);
  return d === stop || d.startsWith(stop.endsWith(path.sep) ? stop : stop + path.sep);
}

// Directories to probe for a `.spor`/`.spor.json` marker, in walk order: cwd's
// own ancestor chain up to the filesystem root, then — only when it isn't
// already on that chain — the main checkout's root from gitMainRoot(). Shared
// by every marker walk (repoConfigFiles, repoMarkerPresent, repoMarkerGraph,
// repoMarkerOrg) so a linked worktree resolves markers identically across all
// four (issue-spor-cli-status-worktree-enable-detection). The main root is
// appended LAST — lowest precedence — so anything nearer to cwd still wins;
// outside a linked worktree this is a no-op and the list is exactly the prior
// cwd-ancestor walk.
//
// `boundary` (loadConfig's opts.boundary) CONTAINS that walk: when set to an
// absolute directory, only `boundary` itself and directories nested under it
// are ever probed — the chain stops AT the boundary and the gitMainRoot()
// fallback is skipped entirely, since a linked worktree's main checkout is by
// definition outside the boundary subtree. The caller is
// `createDispatchWorktree` (bin/spor.js): a dispatch worktree nests at
// `<repoDir>/.claude/worktrees/<name>`, so the ordinary ancestor walk climbs
// straight back into the main checkout and reads its LIVE, possibly
// uncommitted `.spor.json` — the exact file
// issue-spor-dispatch-worktree-config-live-file-race must never consult when
// resolving the worktree's own `dispatch.worktreeSetup`. Absent the option
// nothing changes: every branch below is a no-op when `stop` is null, so the
// default walk stays byte-identical (norm-cc-byte-identical-refactor).
function markerSearchDirs(cwd, boundary) {
  const stop = boundary ? path.resolve(boundary) : null;
  const dirs = [];
  const seen = new Set();
  for (let dir = cwd || ""; dir; dir = path.dirname(dir)) {
    if (seen.has(dir)) break;
    seen.add(dir);
    if (stop && !withinBoundary(dir, stop)) break; // above/outside the boundary
    dirs.push(dir);
    if (stop && path.resolve(dir) === stop) break; // boundary included, nothing above it
    if (dir === path.dirname(dir)) break; // hit fs root
  }
  if (stop) return dirs; // the main checkout is outside the boundary by construction
  const mainRoot = gitMainRoot(cwd);
  if (mainRoot && !seen.has(mainRoot)) dirs.push(mainRoot);
  return dirs;
}

// All .spor.json files from cwd up to the filesystem root (plus the main
// checkout's root when cwd is in a linked worktree — see markerSearchDirs),
// shallowest first (so a deeper/nearer file overrides an ancestor when merged
// in order). Mirrors the nearest-ancestor `.spor` marker walk in
// scripts/engines/util.js.
function repoConfigFiles(cwd, boundary) {
  const files = [];
  for (const dir of markerSearchDirs(cwd, boundary)) {
    const f = path.join(dir, ".spor.json");
    if (fs.existsSync(f)) files.push(f);
  }
  return files.reverse(); // shallowest (incl. any main-root fallback) first
}

// True when a repo-level opt-in MARKER exists anywhere from cwd up to the
// filesystem root (plus the main checkout's root when cwd is in a linked
// worktree — see markerSearchDirs): either a flat `.spor` identity marker or a
// `.spor.json` config file. Presence is the opt-in signal Config.enabled()
// falls back to when no explicit `enabled` flag is set anywhere in the cascade
// (task-spor-plugin-opt-in-default) — it marks a repo that `spor enable`,
// `spor link`, or `spor dispatch --backfill` has touched. Mirrors the
// nearest-ancestor walks used for `.spor.json` config and the `.spor` graph
// binding.
//
// A marker is only ever a regular FILE: the flat `.spor` identity marker is
// `key: value` text (what repoMarkerGraph/repoMarkerOrg/projectSlug read) and
// `.spor.json` is a JSON config file. The default LOCAL graph home is itself a
// DIRECTORY named `.spor` (`~/.spor`), so a bare existsSync would treat the
// graph home as a repo marker and falsely opt-in EVERY markerless repo nested
// under it (issue-spor-home-dir-marker-opt-in-leak). Requiring a regular file
// excludes the graph-home directory (and any other `.spor` directory, e.g. a
// `graph:` binding target) while still matching every real opt-in marker.
// Fail-open: isFile() swallows stat errors, so an unreadable level reads as
// absent rather than erroring.
function repoMarkerPresent(cwd, boundary) {
  for (const dir of markerSearchDirs(cwd, boundary)) {
    if (isFile(path.join(dir, ".spor")) || isFile(path.join(dir, ".spor.json"))) return true;
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
function repoMarkerGraph(cwd, boundary) {
  for (const dir of markerSearchDirs(cwd, boundary)) {
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
  }
  return null;
}

// A per-repo `.spor` marker may also pin which TENANT (org) this repo talks to
// via an `org: <slug>` key — the remote-mode sibling of the `graph:` local-home
// binding (dec-spor-client-cli-mode-tenant-resolution: "where is this repo
// homed" answers either a local path via `graph:` or a tenant slug via `org:`).
// Committable and read by the NEAREST ancestor, so a monorepo subtree can pin a
// different org than its root. It selects a credential-store tenant by org slug;
// it loses to an explicit `--org` flag and to SPOR_*/SPOR_ORG env (the tenant
// selector precedence). Fail-open: any read error skips that level. Returns the
// slug string or null.
function repoMarkerOrg(cwd, boundary) {
  const hit = repoMarkerOrgAt(cwd, boundary);
  return hit ? hit.org : null;
}
// repoMarkerOrg() plus WHICH marker file bound it — the refusal for an
// unavailable bound org names the file to fix.
function repoMarkerOrgAt(cwd, boundary) {
  for (const dir of markerSearchDirs(cwd, boundary)) {
    let text = null;
    try {
      text = fs.readFileSync(path.join(dir, ".spor"), "utf8");
    } catch {
      /* no marker at this level */
    }
    if (text != null) {
      const m = text.match(/^org:[ \t]*(.+?)[ \t]*$/m);
      if (m && m[1]) return { org: m[1], file: path.join(dir, ".spor") };
    }
  }
  return null;
}

// The org slugs a credential store actually holds, sorted and de-duplicated —
// the "known orgs" a refused `--org` is reported against
// (issue-spor-cli-unrecognized-org-fallback). An opaque-token tenant may carry
// no org (its key is "<server>/"), so it is listed by KEY: that is the spelling
// `spor auth switch` takes for it, and omitting it entirely would report an
// empty store to someone who has a credential.
function storedOrgs(store) {
  const seen = new Set();
  for (const key of Object.keys(store.tenants || {}).sort()) {
    seen.add(store.tenants[key].org || key);
  }
  return [...seen];
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

// Check one FILE layer against the key table, recording a warning per nested
// key the table does not declare and per value whose shape cannot be the
// declared type (a typo'd `nudge.maxcalls` used to be merged and silently
// never read). Warn-only, like every other config problem (fail-open): the
// value still merges, and the typed getters still coerce or fall back.
// Top-level unknowns are left to the merged-view check in loadConfig, which
// has always reported them.
function validateLayer(data, file, warnings, prefix = "") {
  for (const k of Object.keys(data)) {
    const dotted = prefix ? `${prefix}.${k}` : k;
    const v = data[k];
    const entry = lookupKey(dotted);
    if (entry) {
      if (!typeMatches(entry, v)) {
        const want = entry.type === "enum" ? `one of ${entry.choices.join("|")}` : `a ${entry.type}`;
        // Secret keys (token, attestation.signingKey) are redacted wherever
        // displayed (config-keys.js `secret: true`) — a type-mismatch warning
        // must not become a side channel that prints the raw misconfigured
        // value (e.g. a token accidentally nested as an object/array).
        const shown = entry.secret ? "<redacted>" : JSON.stringify(v);
        warnings.push(`config key '${dotted}' in ${file} should be ${want}, got ${shown}`);
      }
      continue;
    }
    if (isNamespace(dotted)) {
      if (isPlainObject(v)) validateLayer(v, file, warnings, dotted);
      else if (v !== null) warnings.push(`config key '${dotted}' in ${file} should be an object, got ${JSON.stringify(v)}`);
      continue;
    }
    if (prefix) warnings.push(`unknown config key '${dotted}' in ${file} ignored`);
  }
}

// The env var that actually supplied `name` (SPOR_ wins over legacy
// SUBSTRATE_, mirroring home.envDual), for `spor config explain`.
function envVarName(name, env) {
  const v = env[`SPOR_${name}`];
  return v != null && v !== "" ? `SPOR_${name}` : `SUBSTRATE_${name}`;
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
//   opts.boundary — absolute dir that CONTAINS every repo-file-layer ancestor
//                walk (the `.spor.json` config walk and the `.spor` marker
//                walks): the boundary dir itself is consulted, nothing above
//                it ever is, and the linked-worktree gitMainRoot() fallback is
//                skipped. The env / user `$SPOR_HOME/config.json` / global
//                layers are unaffected — only the REPO-FILE layers are fenced.
//                Absent (the default) the walks are byte-identical to before.
//                See markerSearchDirs and
//                issue-spor-dispatch-worktree-config-live-file-race.
function loadConfig(opts = {}) {
  const env = opts.env || process.env;
  const cwd = opts.cwd || process.cwd();
  const boundary = opts.boundary ? path.resolve(opts.boundary) : null;
  const warnings = [];

  const merged = deepMerge({}, DEFAULTS);
  // Every layer that contributed, low precedence first, kept for
  // Config.explain() (`spor config explain`) — the answer to "which layer set
  // this?" that the merged view alone cannot give.
  const layers = [{ source: "default", origin: "built-in", data: DEFAULTS }];

  // 5 global, 4 user (low precedence first)
  for (const [source, file] of [["global", globalConfigFile(env)], ["user", userConfigFile(env)]]) {
    const { data, warning } = readJsonFile(file);
    if (warning) warnings.push(warning);
    validateLayer(data, file, warnings);
    layers.push({ source, origin: file, data });
    deepMerge(merged, data);
  }

  // 3 repo .spor.json, shallowest first so nearest wins; secrets stripped.
  // The `briefs` manifest (dec-spor-monorepo-path-scoped-briefs) resolves like
  // the `.spor` marker walk it mirrors: the NEAREST-ANCESTOR .spor.json that
  // declares it wins WHOLESALE, anchored to its own directory — a deeper
  // manifest SHADOWS an ancestor's rather than deep-merging into it. Unioning
  // the maps but keeping one anchor would mis-locate the ancestor's relative
  // paths (it was authored relative to its own dir, not the deeper one). Files
  // iterate shallowest first, so the last hit is the nearest manifest.
  let briefsBase = null;
  let briefsMap = null;
  for (const file of repoConfigFiles(cwd, boundary)) {
    const { data, warning } = readJsonFile(file);
    if (warning) warnings.push(warning);
    const clean = sanitizeRepoLayer(data, file, warnings);
    validateLayer(clean, file, warnings);
    if (isPlainObject(clean.briefs)) { briefsMap = clean.briefs; briefsBase = path.dirname(file); }
    layers.push({ source: "repo", origin: file, data: clean });
    deepMerge(merged, clean);
  }

  // 2 environment
  const envData = envLayer(env);
  validateLayer(envData, "the environment", warnings);
  layers.push({ source: "env", origin: null, data: envData });
  deepMerge(merged, envData);

  // 1 CLI flags (highest)
  if (isPlainObject(opts.cli)) {
    layers.push({ source: "cli", origin: "flag", data: opts.cli });
    deepMerge(merged, opts.cli);
  }

  // 1.5 per-repo `.spor` marker graph binding (between env and CLI in spirit:
  // it overrides SPOR_HOME but never an explicit CLI --home). LOCAL mode only —
  // in remote mode the server is the graph and a local-sharing binding is
  // irrelevant (honoring it would merely relocate the cache dir). Resolve mode
  // from the already-merged values, mirroring Config.mode(). With no marker the
  // home is untouched, so unset behavior is byte-identical
  // (norm-cc-byte-identical-refactor).
  let markerGraph = null;
  const candidate = repoMarkerGraph(cwd, boundary);
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
  const repoMarker = repoMarkerPresent(cwd, boundary);

  return new Config(merged, { warnings, env, cwd, boundary, markerGraph, repoMarker, briefsBase, briefsMap, layers, cli: opts.cli || {} });
}

class Config {
  constructor(values, meta) {
    this.values = values;
    this.warnings = meta.warnings || [];
    this._env = meta.env;
    this._cwd = meta.cwd;
    this._boundary = meta.boundary || null; // fences the repo-file marker walks (see loadConfig)
    this._markerGraph = meta.markerGraph || null;
    this._repoMarker = !!meta.repoMarker;
    this._briefsBase = meta.briefsBase || null;
    this._briefsMap = meta.briefsMap || null;
    this._cli = meta.cli || {};
    this._layers = meta.layers || [];
    this._tenant = undefined; // memoized resolved tenant (computed lazily)
    this._tenantError = null; // set by _resolveTenant when it REFUSES (see tenantError)
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
    if (v === undefined || v === null) return fallback;
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

  // Plain-object accessor for a declared map value (e.g. `coupling.aliases`):
  // rejects an array or scalar authored where an object was expected, rather
  // than passing it through — a malformed `.spor.json` value degrades to
  // `fallback` instead of silently corrupting the consumer.
  getObj(dotted, fallback = {}) {
    const v = this.get(dotted, undefined);
    return isPlainObject(v) ? v : fallback;
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

  // Path-scoped sub-briefs (dec-spor-monorepo-path-scoped-briefs): the
  // relative-subtree-path -> brief-id map from the NEAREST-ANCESTOR `.spor.json`
  // that declared one, taken wholesale (NOT a deep-merge union across the walk —
  // a deeper manifest shadows an ancestor's, mirroring the `.spor` marker walk),
  // so the map always agrees with briefsBase()'s anchor. null when no repo
  // manifest declares one, so session-start's routing/surfacing is
  // byte-identical for a markerless repo. NOTE: read the map through THIS
  // accessor, never `get("briefs")` — the latter returns the cascade's
  // deep-merged UNION across files, whose entries would be mis-anchored under
  // the single briefsBase() (the very bug this wholesale resolution avoids).
  briefs() {
    return isPlainObject(this._briefsMap) ? this._briefsMap : null;
  }
  // The directory the briefs() map's relative paths are anchored to — the
  // nearest-ancestor `.spor.json` that carried the `briefs` key, or null when
  // none did. session-start matches cwd against the subtree paths relative to
  // this anchor.
  briefsBase() {
    return this._briefsBase;
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

  // Which layer set each declared key (`spor config explain`,
  // task-spor-client-config-typed-key-table-and-explain). One row per key in
  // lib/config-keys.js (or just `only`, a declared key or namespace prefix):
  //   { key, type, value, source, origin, default, doc, secret, shadowed }
  // `source` is the WINNING layer — cli | env | repo | user | global | default
  // | marker (a `.spor` graph: binding, `home` only) | unset (no layer set it
  // and the table declares no default) — and `origin` the
  // flag, env var or file it came from. `shadowed` lists every lower layer that
  // also set the key: a `map` key deep-merges across them (all contribute),
  // any other key is replaced wholesale by the winner. `briefs` reports the
  // nearest manifest, which is what briefs() actually uses. Values are raw
  // (secret keys included); the renderer redacts `secret` rows.
  explain(only = null) {
    const envName = new Map(KEYS.filter((e) => e.env).map((e) => [e.key, e.env]));
    const rows = [];
    for (const e of KEYS) {
      if (only && e.key !== only && !e.key.startsWith(`${only}.`)) continue;
      const hits = [];
      for (let i = this._layers.length - 1; i >= 0; i--) {
        const L = this._layers[i];
        const v = getPath(L.data, e.key);
        if (v === undefined) continue;
        const origin = L.source === "env" ? envVarName(envName.get(e.key), this._env || {}) : L.origin;
        hits.push({ source: L.source, origin, value: v });
      }
      if (e.key === "home" && this._markerGraph) {
        hits.unshift({ source: "marker", origin: path.join(this._markerGraph.markerDir, ".spor"), value: this._markerGraph.path });
      }
      let win = hits[0] || null;
      if (e.key === "briefs") win = this._briefsMap ? { source: "repo", origin: path.join(this._briefsBase, ".spor.json"), value: this._briefsMap } : null;
      rows.push({
        key: e.key, type: e.type, doc: e.doc, secret: !!e.secret, default: e.default,
        value: win ? this.get(e.key) : e.default,
        source: win ? win.source : e.default !== undefined ? "default" : "unset",
        origin: win ? win.origin : null,
        shadowed: hits.filter((h) => h !== win && !(win && h.source === win.source && h.origin === win.origin)).map(({ source, origin }) => ({ source, origin })),
      });
      if (e.key === "home" && this._markerGraph) rows[rows.length - 1].value = this._markerGraph.path;
      if (e.key === "briefs") rows[rows.length - 1].value = this.briefs();
    }
    return rows;
  }

  // Resolved mode: explicit unless "auto", in which case a resolved server URL
  // (the active tenant's, dec-spor-client-cli-mode-tenant-resolution) means
  // remote, otherwise local. "off" makes the plugin a no-op. Byte-identical when
  // no credential store and no org selector are in play: this.server() then
  // reduces to the prior get("server") (norm-cc-byte-identical-refactor).
  mode() {
    const m = this.get("mode", "auto");
    if (m && m !== "auto") return m;
    return this.server() ? "remote" : "local";
  }

  // The active TENANT (dec-spor-client-cli-mode-tenant-resolution): the
  // (server, token, org, identity) triple chosen from the credential store +
  // cascade, first match wins:
  //   1. --server / --org CLI flag
  //   2. SPOR_SERVER (+ SPOR_TOKEN) env  — the flat single-tenant path
  //   3. SPOR_ORG env                    — selects a store tenant by org
  //   4. repo .spor `org:` marker        — selects a store tenant by org
  //   5. store `default`                 — the user's chosen active tenant
  //   6. legacy flat config.json server+token (migrate-on-read)
  //   7. none -> null (local mode)
  // Every ORG selector (steps 1, 3, 4) REFUSES rather than falls through when it
  // names an org with no stored credential — see tenantError().
  // Byte-identical guarantee: with no credential store AND no org selector this
  // reduces to { server: get('server'), token: get('token') } — the prior
  // flat-or-env behavior (norm-cc-byte-identical-refactor). Memoized; returns
  // null in local mode.
  tenant() {
    if (this._tenant !== undefined) return this._tenant;
    this._tenant = this._resolveTenant();
    return this._tenant;
  }

  // Non-null when the cascade REFUSED to resolve a tenant rather than falling
  // through to a different one: `{ kind, org, orgs, source, origin }`, where
  // `orgs` lists the credentials actually stored
  // (issue-spor-cli-unrecognized-org-fallback), `source` is the selector that
  // named the org (`cli-org` | `env-org` | `repo-marker`) and `origin` the flag,
  // env var or marker file it came from. An org selector is an assertion of
  // WHICH tenant this command is for, so honoring it as a hint and running
  // against the store default instead reads the wrong graph and — worse —
  // writes into it while the operator believes they are scoped elsewhere:
  //   • `unknown-org` — it names an org with no stored credential;
  //   • `empty-org`   — it was given an EMPTY value, i.e. no org was named at
  //     all (a shell's unset `$ORG`). Malformed input, distinguished from
  //     `unknown-org` because there is nothing an acquisition verb could do
  //     with it either, so bin/spor exempts nothing from it;
  //   • `server-mismatch` — not an org selector at all: a committed repo
  //     `.spor.json` named `server` (`server`, `origin` = that file) and the
  //     only credential on hand was recorded for a different server
  //     (`credential_server`, null when none was recorded). Sending it would
  //     hand the user's token to a server a repo chose
  //     (dec-spor-repo-server-key-requires-matching-credential). `org` is the
  //     ambient org selector that routed here, or "".
  // The AMBIENT selectors (SPOR_ORG, a repo `.spor` `org:` marker) refuse too
  // (issue-spor-ambient-org-selector-silent-fallback, decided 2026-09-26):
  // they used to fall through to the store default, so a repo bound `org:
  // dartlane` on a box holding only a `spor` credential read and WROTE the spor
  // tenant. Only `unknown-org` can come from them (an empty env var or an empty
  // `org:` line selects nothing).
  // The refusal is a REPORT, not a throw — tenant() stays a total function
  // returning null (so no wrong-tenant server/token ever leaks out). The CLI
  // turns it into a loud exit-1 refusal in bin/spor's main(); the hook
  // dispatcher (and the detached workers that re-resolve the cascade) turn it
  // into "inject nothing, write nothing to EITHER graph" plus a journaled
  // warning — never the local-graph fallthrough the null tenant would
  // otherwise resolve to. An ambient refusal is moot under an explicit
  // `mode: local`/`off` (no tenant is consulted), so it is not reported there;
  // an explicit `--org` is reported regardless, as before.
  // describeTenantRefusal() is the one-line rendering every surface shares.
  tenantError() {
    this.tenant(); // force the (memoized) resolution that records it
    const te = this._tenantError;
    if (te && te.source !== "cli-org") {
      const m = this.get("mode", "auto");
      if (m === "local" || m === "off") return null;
    }
    return te;
  }

  // The highest-precedence layer that set `dotted` ({ source, origin, value }),
  // skipping the layer sources in `skip`; null when none did.
  _layerFor(dotted, skip = null) {
    for (let i = this._layers.length - 1; i >= 0; i--) {
      const L = this._layers[i];
      if (skip && skip.includes(L.source)) continue;
      const v = getPath(L.data, dotted);
      if (v !== undefined && v !== null && v !== "") return { source: L.source, origin: L.origin, value: v };
    }
    return null;
  }

  // `ignoreOrgSelectors` re-resolves as if no org selector had been given at
  // all — the cascade a credential-ACQUIRING verb defaults its server from
  // (serverForNewTenant).
  _resolveTenant({ ignoreOrgSelectors = false } = {}) {
    const env = this._env || {};
    const cli = this._cli || {};
    const store = auth.readStore(this.userConfigHome());

    const byKey = (key, source) => {
      const t = store.tenants[key];
      if (!t) return null;
      return {
        key, source, server: auth.normServer(t.server), org: t.org || "",
        token: t.access_token || "", refresh_token: t.refresh_token || null,
        person: t.person || null, email: t.email || null, exp: t.exp || null,
      };
    };
    const byOrg = (org, source) => {
      const m = auth.findByOrg(store, org);
      if (!m.length) return null;
      const pick = m.find((x) => x.key === store.default) || m[0]; // prefer the default among matches
      return byKey(pick.key, source);
    };
    // A flat {server, token} selection (env / CLI / legacy config) — attaches the
    // store tenant for that server when one exists, so an env SPOR_SERVER pointing
    // at a known tenant still carries its refresh token + org + identity.
    // The refresh credential and the identity ride along ONLY when the bearer IS
    // the store tenant's own access_token (or none was supplied and the store's
    // is used). An explicit token that differs is somebody else's credential —
    // a dispatched agent's scoped child token under the person's HOME is exactly
    // this shape — and carrying the person's refresh_token beside it would let
    // any 401/403 (or a near-expiry proactive refresh) swap the agent's bearer
    // for the PERSON's, retrying past the agent's scope and attribution
    // (issue-spor-agent-token-scope-escalation-via-refresh-and-store-default).
    // lib/remote.js and u.curlWithRefresh both refresh only through
    // `refresh_token`, so withholding it here closes every refresh door at once.
    // One server hosts several orgs (the store is keyed (server, org)), so the
    // tenant a supplied bearer is "own" of is found BY THAT TOKEN, not by the
    // first same-server entry; a foreign bearer takes its org from its own JWT
    // claim first and carries no store `key` (the key means "this entry's
    // bearer"), so a multi-org box never stamps an agent with a sibling org.
    const flat = (server, token, source) => {
      const s = auth.normServer(server);
      if (!s) return null;
      const same = Object.keys(store.tenants).filter((kk) => auth.normServer(store.tenants[kk].server) === s);
      const ownKey = token ? same.find((kk) => store.tenants[kk].access_token === token) : same[0];
      const own = !token || !same.length || !!ownKey;
      const k = ownKey || same[0] || null;
      const t = k ? store.tenants[k] : null;
      return {
        key: own ? k : null, source, server: s,
        org: own ? (t && t.org) || auth.jwtOrg(token) || "" : auth.jwtOrg(token) || (t && t.org) || "",
        token: token || (t && t.access_token) || "", refresh_token: (own && t && t.refresh_token) || null,
        person: (own && t && t.person) || null, email: (own && t && t.email) || null, exp: (own && t && t.exp) || null,
      };
    };
    const tokenForServer = (server) => {
      const s = auth.normServer(server);
      const k = Object.keys(store.tenants).find((kk) => auth.normServer(store.tenants[kk].server) === s);
      return k ? store.tenants[k].access_token || "" : "";
    };

    // 1. explicit CLI --server / --org (highest)
    if (cli.server) {
      return flat(cli.server, cli.token || home.envDual("TOKEN", env) || tokenForServer(cli.server), "cli-server");
    }
    // `!= null`, not truthiness: an `--org` typed with an EMPTY value is an
    // asserted-but-unusable selector, not an absent one, and falling past it to
    // the store default is the same wrong-tenant hazard by a different door.
    if (cli.org != null && !ignoreOrgSelectors) {
      // Emptiness is judged on the trimmed value (`--org "  "` names nothing
      // either) but the LOOKUP keeps the raw value: trimming there would widen
      // `--org " acme"` from a refusal into a match, which is not this fix.
      if (!String(cli.org).trim()) {
        this._tenantError = { kind: "empty-org", org: String(cli.org), orgs: storedOrgs(store), source: "cli-org", origin: "--org" };
        return null;
      }
      const t = byOrg(cli.org, "cli-org");
      if (t) return t;
      // No credential for the named org: REFUSE (see tenantError) instead of
      // continuing down the cascade to the store default or the legacy flat
      // config. Recorded, not thrown, so this stays a total function.
      this._tenantError = { kind: "unknown-org", org: cli.org, orgs: storedOrgs(store), source: "cli-org", origin: "--org" };
      return null;
    }

    // 2. flat SPOR_SERVER (+ SPOR_TOKEN) env — the single-tenant path; byte-identical
    const envServer = home.envDual("SERVER", env);
    if (envServer) {
      const envToken = home.envDual("TOKEN", env);
      return flat(envServer, envToken || this.get("token", "") || tokenForServer(envServer), "env");
    }

    // The config-file `server` + flat `token` pair (the legacy step-6 tenant,
    // and flatForOrg below). A committed repo `.spor.json` may name `server`
    // (it is how a repo points contributors at a team server), but the flat
    // `token` is never repo-sourced — it was recorded beside the server the
    // NON-repo cascade names (user/global config.json). So when the repo layer
    // WON `server`, the token rides along only if that recorded server is the
    // same one; otherwise the store credential recorded for exactly that server
    // (flat() looks it up by server), else a `server-mismatch` refusal naming
    // both — never the user's token sent to a server a repo chose
    // (dec-spor-repo-server-key-requires-matching-credential). With no repo
    // `server`, or no flat token to protect, this is the prior pairing verbatim.
    // `org` (flatForOrg) records the refusal only when the pairing would have
    // satisfied that org — otherwise the selector's own unknown-org stands.
    let serverRefusal = null;
    const fromConfig = (org = null) => {
      const fileServer = this.get("server", "");
      if (!fileServer) return null;
      const token = this.get("token", "");
      const won = this._layerFor("server");
      if (!token || !won || won.source !== "repo") return flat(fileServer, token, "flat-config");
      const own = this._layerFor("server", ["repo"]);
      const recorded = own ? auth.normServer(own.value) : "";
      if (recorded && recorded === auth.normServer(fileServer)) return flat(fileServer, token, "flat-config");
      const stored = flat(fileServer, "", "flat-config");
      // A tokenless tenant for the acquisition re-resolve (serverForNewTenant
      // reads only .server) — and the store's own credential for this server.
      if (ignoreOrgSelectors || (stored && stored.token)) return stored;
      const paired = flat(fileServer, token, "flat-config");
      if (org === null || (paired && paired.org === org)) {
        serverRefusal = {
          kind: "server-mismatch", org: org || "", server: auth.normServer(fileServer),
          credential_server: recorded || null, orgs: storedOrgs(store), source: "repo-server", origin: won.origin,
        };
      }
      return null;
    };

    // An ambient org selector is satisfied by the legacy flat config.json
    // server+token too, when THAT credential is for the named org (its store
    // twin's org, or the JWT `org` claim) — a pre-store single-tenant box must
    // not be locked out of its own org by the fail-closed rule below.
    const flatForOrg = (org) => {
      const t = fromConfig(org);
      return t && t.org === org ? t : null;
    };

    // 3. SPOR_ORG env selects a store tenant by org — and REFUSES when it
    //    names none (see tenantError), never falling on to the store default.
    const envOrg = ignoreOrgSelectors ? undefined : home.envDual("ORG", env);
    if (envOrg) {
      const t = byOrg(envOrg, "env-org") || flatForOrg(envOrg);
      if (t) return t;
      this._tenantError = serverRefusal || { kind: "unknown-org", org: envOrg, orgs: storedOrgs(store), source: "env-org", origin: envVarName("ORG", env) };
      return null;
    }

    // 4. repo .spor `org:` marker — same refusal.
    const marker = ignoreOrgSelectors ? null : repoMarkerOrgAt(this._cwd, this._boundary);
    if (marker) {
      const t = byOrg(marker.org, "repo-marker") || flatForOrg(marker.org);
      if (t) return t;
      this._tenantError = serverRefusal || { kind: "unknown-org", org: marker.org, orgs: storedOrgs(store), source: "repo-marker", origin: marker.file };
      return null;
    }

    // 5. store default
    if (store.default) {
      const t = byKey(store.default, "store-default");
      if (t) return t;
    }

    // 6. legacy flat config.json server+token (migrate-on-read). By here neither
    //    env nor CLI set a server, so get('server') is the file value — the
    //    prior behavior, surfaced as an implicit tenant — except that a REPO
    //    `server` meeting a token recorded for another server refuses (fromConfig).
    const t = fromConfig();
    if (t) return t;
    if (serverRefusal) this._tenantError = serverRefusal;

    // 7. local
    return null;
  }

  // Resolved server base URL (trailing slash stripped) for the active tenant, or
  // "" in local mode. The single resolver lib/remote.js + the hook engines read.
  server() {
    const t = this.tenant();
    return t ? t.server : "";
  }
  // Resolved bearer token for the active tenant, or "".
  token() {
    const t = this.tenant();
    return t ? t.token : "";
  }
  // The server URL a tenant-ESTABLISHING verb (`spor auth login`) should default
  // to. Normally just server(), but "log me into an org I have no credential for
  // yet" is the one legitimate use of an unresolvable org selector (an `empty-org`
  // refusal never reaches here — bin/spor refuses it for every verb), and there the
  // refusal above leaves server() empty. Re-resolve the cascade with that flag
  // ignored so `spor auth login --org <new>` still defaults to the server the
  // rest of the cascade names — the self-hosted "add my second org on the same
  // box" case — instead of silently jumping to the hosted front door.
  serverForNewTenant() {
    // The RAW refusal, not tenantError(): under an explicit mode local/off the
    // accessor hides an ambient refusal, but the null tenant it left behind
    // would still make server() empty here.
    this.tenant();
    if (!this._tenantError) return this.server();
    // Signing in to the repo-named server is exactly how that refusal is cured:
    // the new credential is recorded FOR it.
    if (this._tenantError.kind === "server-mismatch") return this._tenantError.server;
    const t = this._resolveTenant({ ignoreOrgSelectors: true });
    return t ? t.server : "";
  }
  // The explicit `--org` CLI flag value (lifted to a global flag in bin/spor),
  // or null. The auth verbs read it to label/select the tenant they create.
  flagOrg() {
    return (this._cli && this._cli.org) || null;
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
    // `!= null`: an explicit `enabled: null` reads as UNSET here exactly as it
    // does in getBool (issue-spor-config-enabled-explicit-null-inconsistency),
    // so it falls back to marker presence instead of meaning "on".
    const explicit = this.get("enabled", undefined);
    if (explicit != null) return this.getBool("enabled", true);
    return this._repoMarker;
  }
  // True iff the plugin is inactive purely by the opt-in DEFAULT — no explicit
  // `enabled` flag anywhere in the cascade, no mode:off, no repo marker
  // (issue-spor-opt-in-silent-disable-no-indication). This is the one inactive
  // state where a discovery hint is appropriate: an explicit opt-out
  // (enabled:false, SPOR_ENABLED=0, mode:off) is a deliberate choice and must
  // stay silent.
  disabledByDefault() {
    return (
      this.get("mode", "auto") !== "off" &&
      this.get("enabled", undefined) == null &&
      !this._repoMarker
    );
  }
}

// One line saying why the cascade refused a tenant (a tenantError() report),
// shared by `spor config explain`, preflight and the hook journal so the
// surfaces cannot drift apart.
function describeTenantRefusal(te) {
  if (te.kind === "server-mismatch") {
    return `${te.origin} sets server ${te.server}, but the stored credential is for ${te.credential_server || "(no recorded server)"} — not sending it to a server the repo chose`;
  }
  if (te.kind === "empty-org") return "--org given an empty value";
  return `org '${te.org}' (from ${te.origin}) has no stored credential`;
}

module.exports = { describeTenantRefusal, loadConfig, Config, DEFAULTS, DEFAULT_SERVER, ENV_MAP, KNOWN_KEYS, REPO_FORBIDDEN_KEYS, REPO_FORBIDDEN_PATHS, repoMarkerGraph, repoMarkerOrg, repoMarkerPresent };

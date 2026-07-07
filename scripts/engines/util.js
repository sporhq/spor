"use strict";
// Shared helpers for the Node hook engines (task-cc-node-port-hook-engines).
// Each helper preserves the exact observable semantics of the bash+jq+curl
// constructs it replaces — timestamp formats, byte-precise truncation, word
// counting, curl-style http codes — so engine output stays byte-identical.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync, spawnSync, spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const CODEX_NUDGE_MODEL = "gpt-5.4-mini";

const home = require(path.join(ROOT, "lib", "shell", "home.js"));
// The harness vocabulary the capability probe emits — owned by the pure matcher
// so the probe, the matcher, and the future fleet scheduler agree on one set of
// names (dec-spor-machine-profile-satisfiability). Never re-hardcode it here.
const { HARNESS_BINARIES, SPOR_MCP_NAME } = require(path.join(ROOT, "lib", "kernel", "satisfiability.js"));

// Active client config for this run (dec-spor-client-config-cascade). The
// dispatcher builds it once with the session cwd; engines then read settings
// through the cascade (CLI > env > .spor.json > user > global > defaults). When
// no config is active — standalone util calls, direct unit tests — every read
// falls back to the exact env dual-read it replaced, so those paths stay
// byte-identical (norm-cc-byte-identical-refactor).
let _config = null;
let _host = null;
function useConfig(opts) {
  _host = opts && opts.host ? opts.host : null;
  _config = require(path.join(ROOT, "lib", "config.js")).loadConfig(opts);
  return _config;
}
// Adopt an ALREADY-resolved Config as the active cascade. useConfig() builds one
// from opts (the hook path); the `spor` CLI resolves cfg once in main() and hands
// the engines that SAME tenant/cwd/marker resolution via this, so an engine read
// (serverBase/bearer/graphHome) honors a file-config or --org tenant instead of
// silently falling back to raw env.
function setConfig(cfg) {
  _host = null;
  _config = cfg;
  return cfg;
}
function config() {
  return _config;
}
function clearConfig() {
  _host = null;
  _config = null; // test hook
}
// Config-aware string read: the active cascade value, else env dual-read.
// Returns undefined when neither is set, matching the old envDual() contract.
function cfgStr(keyPath, envName) {
  return _config ? _config.get(keyPath) : home.envDual(envName);
}
// Config-aware numeric read with a fallback, for the same cascade. Used for
// the bound knobs (nudge.maxCalls, nudge.timeoutMs, distill.timeoutMs): the
// active config's getNum, else the env dual-read parsed as a finite number,
// else the fallback. A blank or non-numeric value degrades to the fallback.
function cfgNum(keyPath, envName, fallback) {
  if (_config) return _config.getNum(keyPath, fallback);
  const v = home.envDual(envName);
  if (v === undefined) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}
// Config-aware boolean read, same cascade and the shell "0"/"false"/"" ⇒ false
// convention as Config.getBool. Standalone (no active config) falls back to the
// env dual-read, so a direct call is byte-identical to the raw env test it
// replaces. Fallback returned when neither config nor env is set.
function cfgBool(keyPath, envName, fallback) {
  if (_config) return _config.getBool(keyPath, fallback);
  const v = home.envDual(envName);
  if (v === undefined) return fallback;
  const s = String(v).trim().toLowerCase();
  return !(s === "0" || s === "false" || s === "");
}

function hostDefaultBackendCmd(kind) {
  if (_host === "codex" && kind === "nudge") return `codex exec --model ${CODEX_NUDGE_MODEL} -`;
  if (_host === "codex" && kind === "distill") return "codex exec -";
  return undefined;
}

function graphHome() {
  return _config ? _config.graphHome() : home.graphHome();
}

// The PERSONAL user-config home — where the machine-local user config.json
// (server/token + the dispatch.repos slug->path map) is read and written.
// Anchored at the env/default home, INDEPENDENT of a per-repo `.spor` marker
// `graph:` override (which redirects only the shared GRAPH, not this
// machine-local file). Equals graphHome() unless a marker moved the graph
// (issue-spor-config-desync-shared-graph-home). Standalone fallback matches
// graphHome()'s, since with no config the two homes coincide.
function userConfigHome() {
  return _config ? _config.userConfigHome() : home.graphHome();
}

// jq `now | todate`: UTC, second precision, trailing Z.
function jqNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

// `date -u +%Y-%m-%dT%H:%M:%S.%3NZ`: UTC with milliseconds.
function isoMs() {
  return new Date().toISOString();
}

// `date -Iseconds`: local time with seconds and numeric timezone offset.
function isoSeconds(d = new Date()) {
  const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  );
}

// `date +%Y-%m-%d` / `date -I`: local date.
function localDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// `head -c N` on a string: byte-precise truncation.
function byteHead(s, n) {
  const b = Buffer.from(String(s), "utf8");
  return b.length <= n ? String(s) : b.subarray(0, n).toString("utf8");
}

// `tail -c N` on a string.
function byteTail(s, n) {
  const b = Buffer.from(String(s), "utf8");
  return b.length <= n ? String(s) : b.subarray(b.length - n).toString("utf8");
}

// `wc -w`: whitespace-delimited word count.
function wordCount(s) {
  const m = String(s).match(/\S+/g);
  return m ? m.length : 0;
}

// `$(...)` command substitution strips trailing newlines.
function stripTrailingNewlines(s) {
  return String(s).replace(/\n+$/, "");
}

// Read a `.spor` marker's REPO slug from a directory, or null. The identity
// key is `repo:` (dec-cc-repo-project-two-layer-identity); the legacy
// `project:` key is still read as the repo slug for back-compat — markers
// written before the rename name the repo under `project:` — and `repo:` wins
// when both are present. The value must already be canonical (the server's
// SLUG_RE); a non-matching value is ignored rather than normalized, so a typo
// degrades to inference instead of minting a new identity.
function readMarker(dir) {
  try {
    const marker = fs.readFileSync(path.join(dir, ".spor"), "utf8");
    const repo = marker.match(/^repo:[ \t]*([a-z0-9][a-z0-9-]*)[ \t]*$/m);
    if (repo) return repo[1];
    const legacy = marker.match(/^project:[ \t]*([a-z0-9][a-z0-9-]*)[ \t]*$/m);
    return legacy ? legacy[1] : null;
  } catch {
    return null;
  }
}

// Read a `.spor` marker's active-PROJECT grouping from a directory, or null
// (dec-cc-active-project-declared-default). This is only meaningful in the
// post-rename marker format, where `repo:` names the identity and `project:`
// names the home/active grouping. If the marker carries no `repo:` key it is
// legacy and its `project:` value is the REPO slug (read by readMarker), not a
// grouping, so this returns null to avoid mis-reading a legacy marker. Same
// canonical-or-ignore rule as readMarker.
function readMarkerProject(dir) {
  try {
    const marker = fs.readFileSync(path.join(dir, ".spor"), "utf8");
    if (!/^repo:[ \t]*[a-z0-9]/m.test(marker)) return null; // legacy format: project: is the repo slug
    const m = marker.match(/^project:[ \t]*([a-z0-9][a-z0-9-]*)[ \t]*$/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// The directory whose basename names the project, and the floor for the
// nearest-ancestor marker search. Plain `cwd` when not a git repo; the git
// toplevel for a single-repo checkout; and — crucially — the MAIN worktree's
// directory when `cwd` is inside a linked git worktree
// (issue-cc-project-identity-monorepo-worktree). A linked worktree's
// `--show-toplevel` is its own (markerless, bogus-basename) directory, yet it
// shares the main repo's root-commit sha and remotes; inferring identity from
// it both mints a wrong slug and makes the server's fingerprint flow file
// false rename evidence (same fingerprints, different checkout dir). Resolving
// to the main worktree — `dirname(--git-common-dir)`, which points at the main
// repo's `.git` even from a linked worktree — collapses every worktree onto
// the one project identity, so no bogus slug and no false rename. Fail-open:
// any git failure falls back to `cwd`.
function inferenceRoot(cwd) {
  const top = (git(cwd, ["rev-parse", "--show-toplevel"]) ?? "").trim();
  if (!top) return cwd || "";
  const common = (git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) ?? "").trim();
  // In a linked worktree git-common-dir is the main repo's `.git`, sitting
  // one level under the main worktree; in the main checkout it is `<top>/.git`
  // and dirname() returns `top` unchanged, so the single-repo path is intact.
  if (common) {
    const mainTop = path.dirname(common);
    if (mainTop && mainTop !== top) return mainTop;
  }
  return top;
}

// Normalize a raw string to the canonical project slug (the server's SLUG_RE,
// ^[a-z0-9][a-z0-9-]*$): lowercased, runs of non-alphanumerics collapsed to a
// single '-', and leading/trailing '-' trimmed. This is the ONE normalization
// projectSlug() applies to a basename, factored out so a hand-passed slug — an
// explicit `spor add --project My_Repo` — gets the SAME treatment as an inferred
// one instead of being stamped verbatim and mis-filing the node
// (issue-spor-local-add-ask-project-normalization-edge-validation). Empty when
// the input carries no alphanumerics (the caller decides how to handle that).
function slugify(raw) {
  return String(raw == null ? "" : raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Project slug (see CLAUDE.md): basename of the git root, normalized to
// kebab-case. Identity for names that are already kebab-case. A committed
// `.spor` marker file (`project: <id>`) beats all inference — it survives
// rename, move, fork, and history rewrite (task-cc-project-identity-nodes).
// The marker is read by NEAREST ancestor: the search walks up from `cwd` to
// the inference root, so a monorepo subtree can carry its own marker
// (`services/api/.spor` -> `my-api`) that beats the repo root's, splitting one
// repo into distinct project identities
// (issue-cc-project-identity-monorepo-worktree). With no subtree marker the
// search reaches the root and behavior is unchanged.
function projectSlug(cwd, fallback = "project") {
  const root = inferenceRoot(cwd);
  // Nearest-ancestor marker: deepest (closest to cwd) `.spor` wins. Walk from
  // cwd up to and including the inference root; stop at the filesystem root so
  // a markerless tree is one cheap stat per level. When cwd is below the root
  // (the normal case) the walk covers the subtree; when it isn't (or git
  // failed), it still checks cwd and root.
  const seen = new Set();
  for (let dir = cwd || root || ""; dir; dir = path.dirname(dir)) {
    if (seen.has(dir)) break;
    seen.add(dir);
    const hit = readMarker(dir);
    if (hit) return hit;
    if (dir === root || dir === path.dirname(dir)) break;
  }
  if (root) {
    const rootHit = readMarker(root);
    if (rootHit) return rootHit;
  }
  const slug = slugify(path.basename(root || cwd || ""));
  return slug || fallback;
}

// Active-project grouping for a session (dec-cc-active-project-declared-default),
// or null when the session does not DECLARE one. Read by NEAREST ancestor from
// the `.spor` marker's `project:` key, exactly like projectSlug reads the repo
// slug — so a monorepo subtree marker (`services/api/.spor` with `project:
// platform`) sets the active grouping for that subtree, beating an ancestor
// marker. null is the common single-project case: the caller falls back to the
// repo's ONE home project (its `grouped-under` edge), which is graph state, not
// a cwd fact, so it is resolved by the server/distiller, not here.
function projectGrouping(cwd) {
  const root = inferenceRoot(cwd);
  const seen = new Set();
  for (let dir = cwd || root || ""; dir; dir = path.dirname(dir)) {
    if (seen.has(dir)) break;
    seen.add(dir);
    const hit = readMarkerProject(dir);
    if (hit) return hit;
    if (dir === root || dir === path.dirname(dir)) break;
  }
  if (root) {
    const rootHit = readMarkerProject(root);
    if (rootHit) return rootHit;
  }
  return null;
}

// Match cwd against a path-scoped briefs map (dec-spor-monorepo-path-scoped-
// briefs). `briefs` is the relative-subtree-path -> brief-id map declared in a
// repo's .spor.json; `base` is the directory those relative paths are anchored
// to (the repo-root manifest's directory); `cwd` is the session directory.
// Returns { active, siblings }:
//   active   — the NEAREST-ANCESTOR match: the { area, id } whose subtree is the
//              deepest prefix containing cwd (deepest wins, mirroring the .spor
//              marker walk and projectSlug() semantics), or null when cwd is in
//              no declared subtree (e.g. at the repo root).
//   siblings — every OTHER declared { area, id }, in declaration order, for the
//              discovery line session-start surfaces so they stay
//              /spor:brief-reachable without injecting their bodies.
// `area` is the path key as a label (trailing slash and leading "./" stripped).
// Pure + fail-open: a non-object map or malformed entry yields no match.
function matchBriefs(briefs, base, cwd) {
  if (!briefs || typeof briefs !== "object" || Array.isArray(briefs)) return { active: null, siblings: [] };
  const c = path.resolve(cwd || "");
  const entries = [];
  for (const [rel, id] of Object.entries(briefs)) {
    if (typeof rel !== "string" || !id || typeof id !== "string") continue;
    const area = rel.replace(/^\.\//, "").replace(/\/+$/, "");
    if (!area) continue; // "", "/", "./" — not a real subtree label, skip
    const abs = path.resolve(base || c, rel);
    // cwd is in this subtree when it IS the subtree dir or sits under it; the
    // trailing separator stops `…/a` from matching a sibling `…/a-b`.
    const match = c === abs || c.startsWith(abs + path.sep);
    entries.push({ area, id, depth: abs.length, match });
  }
  let active = null;
  for (const e of entries) if (e.match && (!active || e.depth > active.depth)) active = e;
  const siblings = entries.filter((e) => e !== active).map((e) => ({ area: e.area, id: e.id }));
  return { active: active ? { area: active.area, id: active.id } : null, siblings };
}

// Repo fingerprints (task-cc-project-identity-nodes): root-commit shas and
// normalized remote URLs, the rename evidence a project node accumulates.
// Remote normalization strips scheme, userinfo (never ship credentials),
// and `.git`, and folds scp-style `host:path` into `host/path`, so the ssh
// and https spellings of one repo converge on one fingerprint. Entries are
// prefixed `root:`/`remote:` — the same flat-string register format the
// project node's `fingerprints:` list uses. Fail-open: not a repo -> [].
function repoFingerprints(cwd) {
  const out = [];
  const roots = git(cwd, ["rev-list", "--max-parents=0", "HEAD"]);
  for (const sha of (roots ?? "").trim().split("\n").filter(Boolean).slice(0, 3)) {
    out.push(`root:${sha}`);
  }
  const seen = new Set();
  for (const line of (git(cwd, ["remote", "-v"]) ?? "").trim().split("\n")) {
    const url = line.split(/\s+/)[1];
    if (!url) continue;
    const norm = url
      .toLowerCase()
      .replace(/^[a-z+]+:\/\//, "")
      .replace(/^[^@/]+@/, "")
      .replace(":", "/")
      .replace(/\.git$/, "")
      .replace(/\/+$/, "");
    if (norm && !seen.has(norm)) { seen.add(norm); out.push(`remote:${norm}`); }
  }
  return out;
}

// Process-level cached graph load (issue-cc-local-mode-hook-load-latency).
// loadGraph does a linear per-file scan of every node (300-650ms at 5k nodes,
// multi-second by 50k) with no cache, and the local hooks reload it from
// scratch on every invocation — silent latency that never trips the 30s budget
// because the hooks fail open. This memoizes the loaded graph in-process,
// keyed by a cheap directory fingerprint (file count + newest mtime), so the
// SAME process that loads the graph more than once (and any future caller that
// loops over it) pays the scan once and reuses it while the dir is unchanged.
// The fingerprint is a stat-per-file walk — orders of magnitude cheaper than
// reading + parsing every file — and any change to the set or to any file's
// mtime busts the cache, so a stale graph is never served. Fail-open: if
// loadGraph throws, the error propagates exactly as a direct call would (the
// engines wrap their loads in try/catch); a fingerprint failure forces a fresh
// load rather than serving stale. Returns { graph, loadMs, cached }.
let _graphCache = null; // { dir, fp, graph }
function dirFingerprint(dir) {
  let count = 0;
  let newest = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    count++;
    const m = fs.statSync(path.join(dir, f)).mtimeMs;
    if (m > newest) newest = m;
  }
  return `${count}:${newest}`;
}
function loadGraphCached(nodesDir) {
  const dir = path.resolve(nodesDir);
  let fp = null;
  try {
    fp = dirFingerprint(dir);
  } catch {
    /* unreadable dir -> no fingerprint, never cache */
  }
  if (fp && _graphCache && _graphCache.dir === dir && _graphCache.fp === fp) {
    return { graph: _graphCache.graph, loadMs: 0, cached: true };
  }
  const t0 = Date.now();
  const graph = require(path.join(ROOT, "lib", "graph.js")).loadGraph(dir);
  const loadMs = Date.now() - t0;
  if (fp) _graphCache = { dir, fp, graph };
  else _graphCache = null;
  return { graph, loadMs, cached: false };
}

// Stamp a load-latency telemetry line into the per-session journal
// (issue-cc-local-mode-hook-load-latency). This is the missing SIGNAL for
// silent local-mode latency creep — operators can grep the journal for
// load_ms over time and gate tier-2 scale work on it. Journal-only by design:
// the injected additionalContext stays byte-identical (no visible warning), so
// local mode is unchanged except for this side-channel and the cache above.
// Best-effort; never blocks or throws.
function journalLoadMs(graph, session, engine, loadMs, extra = {}) {
  try {
    const dir = path.join(graph, "journal");
    if (!ensureDir(dir)) return;
    const rec = { ts: jqNow(), engine, session: session || "unknown", load_ms: loadMs, ...extra };
    appendLine(path.join(dir, "load-latency.jsonl"), JSON.stringify(rec));
  } catch {
    /* best-effort telemetry */
  }
}

// Durable journal files that collide with a per-session prune pattern and so
// must be named-excluded from the sweep. Only load-latency.jsonl needs this: it
// is a root-level *.jsonl (the append-only load-latency telemetry) that would
// otherwise be bucketed as a "session" by the .jsonl matcher below. The rest of
// the durable state — distill.log / remote.log, the llm-calls/ telemetry dir, the
// pending-distill control file, the .gc-stamp, the enable-hint-* stamps — matches
// no prune suffix and is skipped structurally (see gcJournal), so it is NOT
// listed here. Add an entry only when a new durable file would match a suffix.
const GC_KEEP = new Set(["load-latency.jsonl"]);

// Prune stale per-session subdirectories under a journal spool dir — shared by
// journal/pending-nudges/ (the async-classifier pending-result dirs,
// task-cc-async-classifier-pending-result-injection) and journal/pending-digests/
// (the async digest-intent-gate spool, dec-spor-digest-async-intent-gate-
// implementation) — keyed by session and otherwise orphaned once that session
// ends. `liveSessions` is the same concurrently-live set gcJournal derived from
// the root-level bucket sweep (a session whose OTHER journal artifacts are
// fresh) — a spool <session> dir is exempted if EITHER its own mtime is fresh OR
// the session is live by that bucket signal, because a detached worker can be
// mid-flight (spooled, not yet written back) for a session that hasn't touched
// this specific directory recently (review finding: relying on the directory's
// own mtime alone missed a concurrently-live OTHER session).
function gcSpoolDir(dir, cutoff, session, stat, liveSessions) {
  let subs;
  try {
    subs = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const s of subs) {
    if (!s.isDirectory()) continue;
    if (session && s.name === session) continue; // never sweep the live session
    if (liveSessions && liveSessions.has(s.name)) continue; // concurrently-live elsewhere
    const full = path.join(dir, s.name);
    let m;
    try {
      m = fs.statSync(full).mtimeMs;
    } catch {
      continue;
    }
    if (m >= cutoff) continue;
    try {
      fs.rmSync(full, { recursive: true, force: true });
      stat.removed++;
    } catch {
      /* a dir that vanished mid-sweep just doesn't count */
    }
  }
}

// Age-bounded garbage collection of the per-session journal artifacts that
// otherwise accumulate forever (task-spor-client-journal-gc): the
// <session>.jsonl event logs, the .nudged / .claim-nudged / .coupling-nudged /
// .heartbeat cooldown markers, the prompt-context-<hash>.json digest caches, and
// the pending-nudges/<session>/ and pending-digests/<session>/ spool dirs.
// Without this a long-lived box grows unbounded disk + inodes in journal/.
// Throttled to run at most once per gc.intervalMs via a journal/.gc-stamp
// cooldown (stamped after a successful readdir, before the per-file loop, so a
// huge first sweep can't repeat every session); entries older than gc.maxAgeMs
// are removed. Durable state is
// preserved (GC_KEEP, the llm-calls/ telemetry dir, the enable-hint stamps, and
// every non-per-session file), and a live session's own files are always kept:
// the triggering session by name, a CONCURRENTLY-live session by bucketing its
// files and keeping the whole bucket while its newest artifact is fresh.
// Side-effect-only and fail-open — it never blocks or throws; returns a small
// { ran, removed } stat for logging/tests. opts { now, session, maxAgeMs,
// intervalMs, force } override the resolved config for tests (force bypasses only
// the throttle, never the enabled/age gates).
function gcJournal(graph, opts = {}) {
  const stat = { ran: false, removed: 0 };
  try {
    const enabled = _config
      ? _config.getBool("gc.enabled", true)
      : (home.envDual("GC") ?? "1") !== "0";
    if (!enabled) return stat;
    const dir = path.join(graph, "journal");
    const now = opts.now ?? Date.now();
    const intervalMs = opts.intervalMs ?? cfgNum("gc.intervalMs", "GC_INTERVAL", 86400000); // 1d
    const stamp = path.join(dir, ".gc-stamp");
    if (!opts.force) {
      let last = 0;
      try {
        last = parseInt(fs.readFileSync(stamp, "utf8"), 10) || 0;
      } catch {
        /* no stamp yet — first sweep is due */
      }
      if (now - last < intervalMs) return stat; // throttled: not due yet
    }
    // Read the directory FIRST. A failure here (absent dir, EACCES, EMFILE) must
    // NOT consume the interval — return without stamping so the next session
    // retries, rather than silently skipping a whole interval of cleanup.
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return stat;
    }
    // Stamp only now that the dir is readable, and before the (potentially long)
    // per-file stat/unlink loop, so a huge first sweep can't repeat every session.
    try {
      fs.writeFileSync(stamp, `${now}\n`);
    } catch {
      /* best-effort — an unwritable stamp just means we re-scan next time */
    }
    stat.ran = true;
    const maxAgeMs = opts.maxAgeMs ?? cfgNum("gc.maxAgeMs", "GC_MAX_AGE", 1209600000); // 14d
    const cutoff = now - maxAgeMs;
    const session = opts.session || null;
    // The live session's own prompt-context digest-dedup cache is named by a hash
    // of the session id (prompt-context.js statePath), NOT <session>.*, so the
    // filename bucketing below can't see it. Protect it explicitly: recompute the
    // hash so a clock step / restored-backup mtime can't reap the RUNNING
    // session's follow-up-suppression state (review finding).
    const liveCtx = session
      ? `prompt-context-${crypto.createHash("sha256").update(String(session), "utf8").digest("hex").slice(0, 16)}.json`
      : null;
    // Per-session cooldown/marker suffixes, ordered longest-first for the ones
    // sharing a tail (…coupling-nudged / …claim-nudged before …nudged) so the
    // session id is stripped correctly.
    const SUFFIXES = [".jsonl", ".coupling-nudged", ".claim-nudged", ".nudged", ".heartbeat"];

    // Bucket every per-session file under its session id. A whole bucket is kept
    // or pruned by its NEWEST mtime, because a write-once cooldown marker's mtime
    // is not a liveness signal — the session's still-growing <session>.jsonl event
    // log (or any fresher sibling) is. This shields a CONCURRENTLY-live session on
    // a shared SPOR_HOME from having its markers reaped mid-life under a low
    // gc.maxAgeMs (review finding), not just the session that triggered the sweep.
    const buckets = new Map(); // session -> [full path]
    const promptCtx = []; // prompt-context-<hash>.json — hash-keyed, can't be bucketed
    const spoolDirs = []; // journal/pending-nudges, journal/pending-digests — swept separately
    for (const ent of entries) {
      const name = ent.name;
      if (GC_KEEP.has(name)) continue;
      if (name.startsWith("enable-hint-")) continue; // per-slug one-time suppression
      if (ent.isDirectory()) {
        if (name === "pending-nudges" || name === "pending-digests") spoolDirs.push(path.join(dir, name));
        continue; // llm-calls/ and any other dir is not per-session scratch
      }
      if (!ent.isFile()) continue;
      if (name.startsWith("prompt-context-") && name.endsWith(".json")) {
        if (name !== liveCtx) promptCtx.push(path.join(dir, name));
        continue;
      }
      const suf = SUFFIXES.find((sfx) => name.endsWith(sfx));
      if (!suf) continue; // not a per-session artifact — leave it alone
      const sess = name.slice(0, name.length - suf.length);
      if (session && sess === session) continue; // the live session, always kept
      if (!buckets.has(sess)) buckets.set(sess, []);
      buckets.get(sess).push(path.join(dir, name));
    }

    // Prune a session bucket only when its newest file is older than the cutoff.
    // Track which OTHER sessions are concurrently live by this signal, so the
    // pending-nudges sweep below can extend the same protection to a session's
    // spool dir even when the dir's own mtime looks stale (review finding).
    const liveSessions = new Set();
    for (const [sess, files] of buckets) {
      let newest = 0;
      for (const f of files) {
        try {
          const m = fs.statSync(f).mtimeMs;
          if (m > newest) newest = m;
        } catch {
          /* a file that vanished mid-sweep doesn't affect the bucket's age */
        }
      }
      if (newest === 0 || newest >= cutoff) {
        liveSessions.add(sess);
        continue; // active bucket (or all unreadable)
      }
      for (const f of files) {
        try {
          fs.unlinkSync(f);
          stat.removed++;
        } catch {
          /* vanished mid-sweep */
        }
      }
    }
    // Hash-keyed prompt-context caches can't be bucketed by session id; prune by
    // their own mtime, which repeatedFollowup() rewrites every prompt, so a stale
    // one is genuinely from an idle/ended session (the live one is exempt above).
    for (const f of promptCtx) {
      try {
        if (fs.statSync(f).mtimeMs < cutoff) {
          fs.unlinkSync(f);
          stat.removed++;
        }
      } catch {
        /* vanished / unreadable */
      }
    }
    for (const spoolDir of spoolDirs) gcSpoolDir(spoolDir, cutoff, session, stat, liveSessions);
  } catch {
    /* fail-open — GC must never cost the session */
  }
  return stat;
}

// Global git flags that force commit signing OFF, spread in BEFORE the `commit`
// subcommand at every automated-commit site (graph snapshots, the SessionEnd
// distiller, `spor init`/`migrate`). A user with a global commit.gpgsign=true
// but no usable signing key/agent would otherwise have these housekeeping
// commits fail SILENTLY — the workflow reports success but nothing lands in git
// history (issue-spor-local-commit-gpgsign-silent-failure). The graph home is
// machine-local plumbing, so signing it buys nothing and only risks that failure.
const NO_GPGSIGN = ["-c", "commit.gpgsign=false"];

function git(cwd, args, opts = {}) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      ...opts,
    });
  } catch {
    return null;
  }
}

// True when the graph home and the session cwd resolve to the SAME git repo
// (same toplevel) — i.e. the graph lives INSIDE the code repo being worked on,
// the nested-repo hazard of issue-cc-local-mode-graph-sharing-gap /
// dec-spor-local-mode-sharing-boundary. A per-repo `graph:` marker can point the
// home at e.g. `.` (the code repo itself); auto-committing nodes/ — or rewriting
// git identity — there would land on the code branch instead of letting the
// graph ride the human PR flow. Separate graph repos — the standard standalone
// home and the sibling / nested-own-repo sharing layouts — return false and
// commit as before (byte-identical). Fail-open: any git failure returns false.
function graphInsideCodeRepo(graph, cwd) {
  if (!cwd) return false;
  const gTop = (git(graph, ["rev-parse", "--show-toplevel"]) || "").trim();
  const cTop = (git(cwd, ["rev-parse", "--show-toplevel"]) || "").trim();
  if (!gTop || !cTop) return false;
  try {
    return fs.realpathSync(gTop) === fs.realpathSync(cTop);
  } catch {
    return path.resolve(gTop) === path.resolve(cTop);
  }
}

// Canonicalize a path to its physical long form — resolving Windows 8.3 short
// names (os.tmpdir() hands out `…\RUNNER~1\…` on the windows-latest CI runner)
// and macOS /var->/private/var symlinks — so a path built from os.tmpdir() and
// one from `git rev-parse --show-toplevel` (which returns the long, resolved
// form) share a common prefix and path.relative() stays INSIDE the repo instead
// of walking out to `..\..\..\…` (issue-spor-windows-ci-short-path-mismatch).
// Only realpathSync.native expands 8.3 names (the JS fs.realpathSync only
// follows symlinks); it needs the path to EXIST, so for a not-yet-created file
// (a Write's target, or a synthetic hook payload) we canonicalize the nearest
// existing ancestor and re-attach the remaining tail. Fail-open: an
// unresolvable path falls back to path.resolve (byte-identical to the old
// behavior wherever nothing needs canonicalizing — Linux tmp has no short
// names or symlinks, so realpath is idempotent there).
function canonPath(p) {
  const abs = path.resolve(String(p ?? ""));
  let cur = abs;
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      // realpath failed for `cur` — a not-yet-created leaf, or an unreadable
      // (EACCES) / cyclic (ELOOP) component. Walk up to the nearest RESOLVABLE
      // ancestor and re-attach the tail, so an accessible short-name/symlink
      // ancestor STILL gets expanded (bailing to the fully-literal path here
      // would canonicalize nothing and re-expose the short-vs-long gap). At the
      // filesystem root with nothing resolvable, fall back to path.resolve.
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

// Forward-slash path of `file` relative to git toplevel `top`, preferring the
// LITERAL spelling: plain path.relative on the paths as given. Only when that
// walks OUT of the repo (a `..`/absolute result) do we canonicalize both sides
// and retry — that walk-out is exactly the Windows 8.3 short-vs-long split,
// where os.tmpdir()'s `…\RUNNER~1\…` can't prefix-match git's long
// --show-toplevel (issue-spor-windows-ci-short-path-mismatch). Literal-first
// keeps the common path byte-identical (Linux/macOS, matching spellings) and
// deliberately PRESERVES in-repo symlink spellings — a tracked
// `frontend -> packages/web` still reads as `frontend/…`, since that literal
// path never walks out, so a coupling glob authored against the alias keeps
// matching (only a genuine walk-out triggers canonicalization).
//   TRADEOFF: an in-repo symlink has two valid spellings and no single
//   derivation matches both — literal-first favors the alias, so conversely a
//   glob authored against the RESOLVED subtree (`packages/web/**`) won't match
//   an edit reached via the alias. That case is rare (a tracked symlinked
//   subtree AND a coupling glob on it); matching both spellings at once would be
//   a matcher-level change, left as a follow-up.
function toRepoRel(top, file) {
  const lit = path.relative(top, file).split(path.sep).join("/");
  if (lit === "" || (!lit.startsWith("../") && lit !== ".." && !path.isAbsolute(lit))) return lit;
  return path.relative(canonPath(top), canonPath(file)).split(path.sep).join("/");
}

// toRepoRel rejected to null when the file resolves OUTSIDE the repo (a `..`
// walk-out or an absolute remainder) or onto the repo root itself — the in-repo
// repo-relative path the post-tool coupling nudge needs. (`spor check` calls
// toRepoRel directly: a genuinely out-of-repo --files entry stays a `../…` path
// rather than being dropped.)
function repoRelative(top, file) {
  const rel = toRepoRel(top, file);
  if (!rel || rel.startsWith("../") || rel === ".." || path.isAbsolute(rel)) return null;
  return rel;
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

// Count and oldest-mtime (epoch ms) of the *.json files directly in `dir`
// (non-recursive — outbox/dead/ is a subdir whose name doesn't end in .json, so
// it never leaks into the parent's count). The shape both the session-start
// degradation nudge and `spor-hook doctor` read to gauge outbox / dead-letter
// health (task-cc-client-hook-operability-diagnostics). Fail-open: an
// unreadable or absent dir is { count: 0, oldestMs: null }.
function spoolStats(dir) {
  let count = 0;
  let oldestMs = null;
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return { count: 0, oldestMs: null };
  }
  for (const f of files) {
    count++;
    try {
      const m = fs.statSync(path.join(dir, f)).mtimeMs;
      if (oldestMs == null || m < oldestMs) oldestMs = m;
    } catch {
      /* a file that vanished mid-scan just doesn't count toward oldest */
    }
  }
  return { count, oldestMs };
}

// Machine-local / ephemeral state inside a graph home that must NEVER ride a
// SHARED graph repo's git flow (issue-cc-local-mode-graph-sharing-gap,
// dec-spor-local-mode-sharing-boundary): journal/cache/outbox are runtime
// scratch, and auth/ + config.json hold tokens, so this doubles as a
// secret-leak guard (broader than the decision's "journal/cache/outbox"). The
// durable graph — nodes/ and history/ — is intentionally NOT ignored. Anchored
// with a leading slash to the home root so a same-named dir under nodes/ is
// unaffected.
const GRAPH_IGNORES = ["/journal/", "/cache/", "/outbox/", "/auth/", "/config.json"];

// Ensure a shared graph home carries a .gitignore covering GRAPH_IGNORES.
// Idempotent and ADDITIVE: writes the full block (with a header) when absent,
// else appends only the missing lines — never clobbering a contributor's own
// entries. Only invoked for marker-resolved shared homes (Config.sharedGraphHome),
// so a personal ~/.spor is never touched. Best-effort; returns true when it
// wrote, false otherwise (already complete, or any IO error — fail-open).
function ensureGraphGitignore(graphHomeDir) {
  try {
    if (!graphHomeDir) return false;
    const file = path.join(graphHomeDir, ".gitignore");
    let existing = null;
    try {
      existing = fs.readFileSync(file, "utf8");
    } catch {
      existing = null; // absent
    }
    if (existing === null) {
      if (!ensureDir(graphHomeDir)) return false;
      const header =
        "# Spor machine-local / ephemeral state — not part of the shared graph\n" +
        "# (issue-cc-local-mode-graph-sharing-gap). Safe to edit; spor only appends missing lines.\n";
      fs.writeFileSync(file, header + GRAPH_IGNORES.join("\n") + "\n");
      return true;
    }
    const present = new Set(existing.split("\n").map((l) => l.trim()));
    const missing = GRAPH_IGNORES.filter((ig) => !present.has(ig));
    if (missing.length === 0) return false;
    const sep = existing === "" || existing.endsWith("\n") ? "" : "\n";
    fs.appendFileSync(file, sep + missing.join("\n") + "\n");
    return true;
  } catch {
    return false;
  }
}

// --- local repo map (slug -> checkout path) -------------------------------
// Which directory a project slug lives in on THIS machine. Per-machine and
// machine-specific: it is NEVER in the shared graph (every teammate clones to a
// different path — repo nodes carry slugs/fingerprints, never a local path).
// It lives in the client config cascade under `dispatch.repos`
// (dec-spor-client-config-cascade), so it composes with the env/global/repo
// override layers and is READ via Config.get('dispatch.repos'). Writes target
// the USER config ($SPOR_HOME/config.json) — the same machine-local,
// never-committed file that holds server/token — so they never land in a
// committable repo .spor.json. Learned passively by session-start and written
// explicitly by `spor repos`/`spor dispatch`; fail-open throughout.
function userConfigPath(graphHomeDir) {
  return path.join(graphHomeDir, "config.json");
}
// Read-modify-write $SPOR_HOME/config.json, applying `mutate(repos)` to the
// nested dispatch.repos object. Preserves every other key. Returns true only
// when it actually wrote. Refuses to clobber a present-but-malformed config
// (returns false) so a syntax error never costs the user their settings.
function editRepoMap(graphHomeDir, mutate) {
  try {
    const file = userConfigPath(graphHomeDir);
    let raw = null;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      raw = null; // absent — start fresh
    }
    let data = {};
    if (raw != null) {
      try {
        data = JSON.parse(raw);
      } catch {
        return false; // malformed — do NOT overwrite
      }
      if (data == null || typeof data !== "object" || Array.isArray(data)) data = {};
    }
    if (data.dispatch == null || typeof data.dispatch !== "object" || Array.isArray(data.dispatch)) data.dispatch = {};
    const d = data.dispatch;
    if (d.repos == null || typeof d.repos !== "object" || Array.isArray(d.repos)) d.repos = {};
    if (!mutate(d.repos)) return false; // unchanged — skip the write
    if (!ensureDir(graphHomeDir)) return false;
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}
// Record slug -> dir (last-writer-wins, so a re-clone or worktree updates it).
// No-op when unchanged, to avoid rewriting config.json on every session.
//
// `opts.verify` is for the passive SESSION-START re-probe: it refuses to CLOBBER
// an existing-but-different mapping unless `dir` authoritatively IS this slug's
// repo (its own inferred slug matches). A dispatched agent's session-start runs
// from its worktree cwd, and a confused/cross-repo cwd could otherwise overwrite
// a correct slug->path with the WRONG checkout (e.g. spor-server -> the client
// repo), silently retargeting every later dispatch in that session
// (issue-spor-dispatch-repos-corruption-worktree-session-start). A brand-new slug
// still registers (first-contact, including a monorepo subtree slug whose dir is
// the shared root), and for a normal single-repo checkout a re-clone/move still
// auto-updates and a corrupted entry self-heals (projectSlug(dir) === slug there).
// The one case it can't auto-update is a monorepo SUBTREE slug after the repo
// MOVES — projectSlug(root) is the root slug, not the subtree slug, so it won't
// clobber; that fails loud at dispatch ("target dir does not exist") and an
// explicit `spor repos add` repairs it. Explicit callers (`spor repos add`, the
// dispatch self-register) pass no opts and keep plain last-writer-wins.
function registerRepo(graphHomeDir, slug, dir, opts = {}) {
  if (!slug || !dir || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) return false;
  return editRepoMap(graphHomeDir, (repos) => {
    if (repos[slug] === dir) return false;
    if (opts.verify && slug in repos && projectSlug(dir) !== slug) return false;
    repos[slug] = dir;
    return true;
  });
}
function forgetRepo(graphHomeDir, slug) {
  return editRepoMap(graphHomeDir, (repos) => {
    if (!(slug in repos)) return false;
    delete repos[slug];
    return true;
  });
}

// Record this machine's default dispatch identity (`dispatch.agent`) into the
// SAME user config.json as the repo map — the per-machine key `spor dispatch`
// reads to attribute a dispatched session "agent on behalf of person". Scalar
// sibling of registerRepo: agentId is an `agent-...` node id, or null/"" to
// clear. Returns true only when it actually wrote; refuses to clobber a
// present-but-malformed config (same fail-safe as editRepoMap).
function setDispatchAgent(graphHomeDir, agentId) {
  try {
    const file = userConfigPath(graphHomeDir);
    let raw = null;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      raw = null; // absent — start fresh
    }
    let data = {};
    if (raw != null) {
      try {
        data = JSON.parse(raw);
      } catch {
        return false; // malformed — do NOT overwrite
      }
      if (data == null || typeof data !== "object" || Array.isArray(data)) data = {};
    }
    if (data.dispatch == null || typeof data.dispatch !== "object" || Array.isArray(data.dispatch)) data.dispatch = {};
    const next = agentId || null;
    if ((data.dispatch.agent || null) === next) return false; // unchanged — skip the write
    if (next == null) delete data.dispatch.agent;
    else data.dispatch.agent = next;
    if (!ensureDir(graphHomeDir)) return false;
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

// --- machine capability map (dispatch.capabilities) -----------------------
// What this BOX can run, the machine-local half of profile satisfiability
// (dec-spor-machine-profile-satisfiability). A sibling of dispatch.repos under
// the same never-committed USER config.json: probe-populated and
// config-overridable, machine-specific exactly as the slug->path map is. The
// matcher (lib/kernel/satisfiability.js) reads the EFFECTIVE union of the probed
// and declared sets; here we PROBE the cheap deterministic axes and READ/WRITE
// the file. Fail-open throughout, like registerRepo.

// A pure, no-spawn `which`: the resolved path of an executable named `cmd` on
// PATH, or null. Scans $PATH (and $PATHEXT on Windows), stat-ing candidates —
// no child process, so it is cheap enough for the fail-open session-start
// side-effect path (spawning `cmd --version` per harness would not be).
function whichSync(cmd) {
  if (!cmd || typeof cmd !== "string") return null;
  const exts =
    process.platform === "win32"
      ? ["", ...(process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)]
      : [""];
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      try {
        const st = fs.statSync(candidate);
        // Windows has no executable bit; POSIX requires one (owner/group/other).
        if (st.isFile() && (process.platform === "win32" || st.mode & 0o111)) return candidate;
      } catch {
        /* not here — keep scanning */
      }
    }
  }
  return null;
}

// Harnesses whose launcher binary is on PATH — the primary, most deterministic
// capability axis (you cannot launch a profile whose harness binary is absent;
// `spor dispatch` already degrades on exactly this for `claude`). The harness
// NAMES are the schema-profile vocabulary, read from HARNESS_BINARIES.
function probeHarnesses() {
  const found = [];
  for (const [name, bin] of Object.entries(HARNESS_BINARIES)) {
    if (whichSync(bin)) found.push(name);
  }
  return found;
}

// Plugins and skills the claude-code harness has installed, read with NO spawn
// from `~/.claude/plugins/installed_plugins.json` (the manifest Claude Code
// writes). A plugin's name is the id before '@'; the skills it ships are the
// subdirs of its installPath/skills/, recorded both bare (`brief`) and
// namespaced (`spor:brief`) so a profile may reference whichever form. Best
// effort: a missing/malformed manifest or skills dir yields empty, never throws.
function probeClaudePluginsSkills() {
  const out = { plugins: [], skills: [] };
  try {
    const hd = process.env.HOME || process.env.USERPROFILE || os.homedir();
    const manifest = path.join(hd, ".claude", "plugins", "installed_plugins.json");
    const data = JSON.parse(fs.readFileSync(manifest, "utf8"));
    const map = data && typeof data.plugins === "object" && data.plugins ? data.plugins : {};
    const plugins = new Set();
    const skills = new Set();
    for (const [key, installs] of Object.entries(map)) {
      const name = String(key).split("@")[0];
      if (!name) continue;
      plugins.add(name);
      for (const inst of Array.isArray(installs) ? installs : []) {
        const ip = inst && typeof inst.installPath === "string" ? inst.installPath : null;
        if (!ip) continue;
        let entries = [];
        try {
          entries = fs.readdirSync(path.join(ip, "skills"), { withFileTypes: true });
        } catch {
          entries = [];
        }
        for (const e of entries) {
          if (e.isDirectory()) {
            skills.add(e.name);
            skills.add(`${name}:${e.name}`);
          }
        }
      }
    }
    out.plugins = [...plugins];
    out.skills = [...skills];
  } catch {
    /* no claude plugin manifest on this box — leave empty */
  }
  return out;
}

// Read-modify-write $SPOR_HOME/config.json, applying `mutate(cap)` to the nested
// dispatch.capabilities object (creating it). Same fail-safe shape as
// editRepoMap/setDispatchAgent: preserves every other key, refuses to clobber a
// present-but-malformed config, returns true only when it actually wrote.
function editCapabilities(graphHomeDir, mutate) {
  try {
    const file = userConfigPath(graphHomeDir);
    let raw = null;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      raw = null; // absent — start fresh
    }
    let data = {};
    if (raw != null) {
      try {
        data = JSON.parse(raw);
      } catch {
        return false; // malformed — do NOT overwrite
      }
      if (data == null || typeof data !== "object" || Array.isArray(data)) data = {};
    }
    if (data.dispatch == null || typeof data.dispatch !== "object" || Array.isArray(data.dispatch)) data.dispatch = {};
    const d = data.dispatch;
    if (d.capabilities == null || typeof d.capabilities !== "object" || Array.isArray(d.capabilities)) d.capabilities = {};
    if (!mutate(d.capabilities)) return false; // unchanged — skip the write
    if (!ensureDir(graphHomeDir)) return false;
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

// Probe THIS machine's atomic capabilities and cache them under
// `dispatch.capabilities.probed`. Cheap and deterministic (PATH stat + one JSON
// read + a few readdirs, no child process, no network), so it is safe on the
// fail-open session-start side-effect path. The probed sets are written
// WHOLESALE so an uninstalled harness drops out on the next refresh (no upward
// drift); user declarations under `dispatch.capabilities.declared` are untouched
// and survive every refresh (dec-spor-machine-profile-satisfiability).
//
// `reachable_mcp` is the one axis seeded from CONFIGURED-ness rather than a probe
// of installed state: when a Spor server/connector is bound (opts.sporReachable,
// i.e. remote mode), the spor MCP is reachable BY CONSTRUCTION in a dispatched
// session, so the probe seeds `reachable_mcp: [spor]` deterministically — no
// network ping, honouring the no-flaky-probe rule while removing the fresh-box
// friction that left an `mcp: [spor]` profile unsatisfiable until a manual
// `allow-mcp` (task-spor-mcp-reachability-deterministic-seed). It rides `.probed`
// (not `.declared`), so it drops out the moment the server is unconfigured. OTHER
// MCP reachability (e.g. mcp-prod over a VPN) and deny-flags remain DECLARED — a
// probe still can't decide a flaky network reach or a policy opt-out. No-op when
// unchanged. Returns the probed map (for `spor capabilities probe`).
function probeCapabilities(graphHomeDir, opts) {
  const ps = probeClaudePluginsSkills();
  const probed = { harnesses: probeHarnesses(), plugins: ps.plugins, skills: ps.skills };
  if (opts && opts.sporReachable) probed.reachable_mcp = [SPOR_MCP_NAME];
  editCapabilities(graphHomeDir, (cap) => {
    if (JSON.stringify(cap.probed || null) === JSON.stringify(probed)) return false;
    cap.probed = probed;
    return true;
  });
  return probed;
}

function appendLine(file, line) {
  try {
    fs.appendFileSync(file, line + "\n");
  } catch {
    /* best-effort */
  }
}

function makeLogger(file, prefix) {
  return (msg) => appendLine(file, `[${isoSeconds()}] ${prefix}${msg}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

// Delay before the next retry: honor a server-supplied Retry-After when
// present, else exponential backoff (250ms · 2^attempt). Always capped so a
// hostile or huge Retry-After can't blow the caller's wall-clock budget.
function backoffMs(attempt, retryAfterMs, capMs) {
  const base = retryAfterMs != null ? retryAfterMs : 250 * 2 ** attempt;
  return Math.min(base, capMs);
}

// curl-shaped HTTP: resolves to {http: "200", body: "..."} with "000" on any
// transport failure (timeout, refused, DNS). Never throws. Like bare curl,
// redirects are not followed. Transient failures (transport, 429, 5xx) are
// retried up to `retry` times; between retries we honor a 429 Retry-After
// header and otherwise back off exponentially (capped at backoffCapMs). With
// retry=0 (the session-start hook budget) no backoff ever runs.
async function curl(
  url,
  { method = "GET", headers = {}, body, timeoutMs = 6000, retry = 0, backoffCapMs = 8000 } = {}
) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      if (attempt < retry) {
        await sleep(backoffMs(attempt, null, backoffCapMs));
        continue;
      }
      return { http: "000", body: "" };
    }
    const text = await res.text().catch(() => "");
    const transient = res.status === 429 || res.status >= 500;
    if (transient && attempt < retry) {
      const retryAfterMs = res.status === 429 ? parseRetryAfter(res.headers.get("retry-after")) : null;
      await sleep(backoffMs(attempt, retryAfterMs, backoffCapMs));
      continue;
    }
    return { http: String(res.status), body: text };
  }
}

// Token + server resolve through the active-tenant selector (Config.token()/
// server(), dec-spor-client-cli-mode-tenant-resolution) so a multi-tenant box's
// remote-mode hooks authenticate as the active tenant, not a flat config field.
// Byte-identical when no credential store / org selector is in play.
function bearer() {
  const v = _config ? _config.token() : home.envDual("TOKEN");
  return { Authorization: `Bearer ${v || ""}` };
}

function serverBase() {
  const v = _config ? _config.server() : home.envDual("SERVER");
  return (v || "").replace(/\/+$/, "");
}

// `sed -E 's#^https?://##; s#/.*$##'` over the server URL.
function serverHost() {
  return serverBase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

// jq over a transcript that is either JSONL or one multi-line JSON document.
function parseJsonStream(text) {
  const docs = [];
  let whole = null;
  try {
    whole = JSON.parse(text);
  } catch {
    /* not a single document */
  }
  if (whole !== null) return [whole];
  for (const line of String(text).split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      docs.push(JSON.parse(t));
    } catch {
      /* skip unparseable lines, as jq -r ... 2>/dev/null did */
    }
  }
  return docs;
}

// `.. | objects | .text? // empty | strings` — document-order recursive
// collection of string .text fields.
function collectTextFields(value, out = []) {
  if (Array.isArray(value)) {
    for (const v of value) collectTextFields(v, out);
  } else if (value && typeof value === "object") {
    if (typeof value.text === "string") out.push(value.text);
    for (const k of Object.keys(value)) {
      if (k !== "text") collectTextFields(value[k], out);
    }
  }
  return out;
}

function sha256Head(file, n = 12) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(file));
  return h.digest("hex").slice(0, n);
}

// {{VAR}} template interpolation, same as the bash ${PROMPT//"{{X}}"/$X}.
function fillTemplate(text, vars) {
  let out = text;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{{${k}}}`).join(v);
  }
  return out;
}

// Graph index lines "id — title", local mode: first `title:` line of each
// node file (grep -m1 -H '^title:' | sed ... | head -150).
function localTitleIndex(nodesDir, maxLines = 150) {
  let files;
  try {
    files = fs.readdirSync(nodesDir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return "";
  }
  const lines = [];
  for (const f of files) {
    if (lines.length >= maxLines) break;
    let raw;
    try {
      raw = fs.readFileSync(path.join(nodesDir, f), "utf8");
    } catch {
      continue;
    }
    const m = raw.match(/^title: *(.*)$/m);
    if (m) lines.push(`${f.slice(0, -3)} — ${m[1]}`);
  }
  return lines.join("\n");
}

// jq '(.titles // [])[] | "\(.id) — \(.title // "")"' | head -150
function remoteTitleIndex(respBody, maxLines = 150) {
  try {
    const titles = JSON.parse(respBody).titles || [];
    return titles
      .slice(0, maxLines)
      .map((t) => `${t.id} — ${t.title ?? ""}`)
      .join("\n");
  } catch {
    return "";
  }
}

// Run a user-supplied backend command (SPOR_DISTILL_CMD / SPOR_NUDGE_CMD):
// prompt on stdin -> response on stdout, with the recursion guard in the
// environment (both spellings, so plugin installs that lag the rename still
// see it). Returns null on failure. `timeoutMs` (when > 0) bounds a hung
// backend so the synchronous nudge/distill call can't block the host past its
// own budget — SIGKILL because the whole point is to survive a wedged child
// that would ignore SIGTERM (a killed run lands in r.error and fails open).
function runBackendCmd(cmd, prompt, { timeoutMs } = {}) {
  const opts = {
    input: prompt,
    encoding: "utf8",
    env: { ...process.env, SPOR_DISTILLING: "1", SUBSTRATE_DISTILLING: "1" },
    maxBuffer: 16 * 1024 * 1024,
    ...(timeoutMs > 0 ? { timeout: timeoutMs, killSignal: "SIGKILL" } : {}),
  };
  const r = process.platform === "win32"
    ? spawnSync(cmd, { ...opts, shell: true })
    : spawnSync("sh", ["-c", cmd], opts);
  if (r.status !== 0 || r.error) return null;
  // RESPONSE=$(...) — command substitution strips trailing newlines.
  return stripTrailingNewlines(r.stdout);
}

// Parse a `claude -p --output-format json` envelope into the response text
// plus token/cost telemetry (task-cc-spor-client-spend-visibility). The CLI
// reports `usage` and a CLI-computed `total_cost_usd` (cache-aware actual
// cost), so the default backend carries exact spend for free. Falls back to
// the raw stdout as text with null telemetry if the output isn't the expected
// JSON shape — distillation must never break on a format surprise.
function parseClaudeResult(stdout) {
  const text = stripTrailingNewlines(stdout);
  try {
    const j = JSON.parse(text);
    const u = j.usage || {};
    return {
      text: typeof j.result === "string" ? j.result : text,
      usage: {
        input_tokens: u.input_tokens ?? null,
        output_tokens: u.output_tokens ?? null,
        cache_read_input_tokens: u.cache_read_input_tokens ?? null,
        cache_creation_input_tokens: u.cache_creation_input_tokens ?? null,
      },
      cost_usd: typeof j.total_cost_usd === "number" ? j.total_cost_usd : null,
      model: j.modelUsage ? Object.keys(j.modelUsage)[0] ?? null : null,
    };
  } catch {
    return { text, usage: null, cost_usd: null, model: null };
  }
}

// Default backend: headless `claude -p --model haiku --max-turns 1 <prompt>`,
// JSON output so the call's token usage and cost are recorded. Returns
// { text, usage, cost_usd, model } or null on process failure. `timeoutMs`
// (when > 0) SIGKILLs a hung CLI so the call can't block the host past its
// budget; a killed run lands in r.error and fails open like any other failure.
function runClaudeBackend(prompt, { timeoutMs } = {}) {
  const r = spawnSync(
    "claude",
    ["-p", "--model", "haiku", "--max-turns", "1", "--output-format", "json", prompt],
    {
      encoding: "utf8",
      env: { ...process.env, SPOR_DISTILLING: "1", SUBSTRATE_DISTILLING: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
      shell: process.platform === "win32",
      ...(timeoutMs > 0 ? { timeout: timeoutMs, killSignal: "SIGKILL" } : {}),
    }
  );
  if (r.status !== 0 || r.error) return null;
  return parseClaudeResult(r.stdout);
}

// Detached child that survives the hook process (replaces nohup setsid).
function spawnDetached(nodeArgs, env = process.env) {
  const child = spawn(process.execPath, nodeArgs, {
    detached: true,
    stdio: "ignore",
    env,
  });
  child.unref();
  return child;
}

// bash $RANDOM: 0..32767.
function bashRandom() {
  return Math.floor(Math.random() * 32768);
}

module.exports = {
  ROOT,
  graphHome,
  userConfigHome,
  envDual: home.envDual,
  useConfig,
  setConfig,
  config,
  clearConfig,
  cfgStr,
  cfgNum,
  cfgBool,
  hostDefaultBackendCmd,
  jqNow,
  isoMs,
  isoSeconds,
  localDate,
  byteHead,
  byteTail,
  wordCount,
  stripTrailingNewlines,
  inferenceRoot,
  slugify,
  projectSlug,
  projectGrouping,
  matchBriefs,
  repoFingerprints,
  git,
  NO_GPGSIGN,
  graphInsideCodeRepo,
  canonPath,
  toRepoRel,
  repoRelative,
  ensureDir,
  spoolStats,
  ensureGraphGitignore,
  registerRepo,
  forgetRepo,
  setDispatchAgent,
  whichSync,
  editCapabilities,
  probeCapabilities,
  appendLine,
  makeLogger,
  loadGraphCached,
  journalLoadMs,
  gcJournal,
  curl,
  bearer,
  serverBase,
  serverHost,
  parseJsonStream,
  collectTextFields,
  sha256Head,
  parseRetryAfter,
  backoffMs,
  fillTemplate,
  localTitleIndex,
  remoteTitleIndex,
  runBackendCmd,
  runClaudeBackend,
  parseClaudeResult,
  spawnDetached,
  bashRandom,
};

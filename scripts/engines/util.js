"use strict";
// Shared helpers for the Node hook engines (task-cc-node-port-hook-engines).
// Each helper preserves the exact observable semantics of the bash+jq+curl
// constructs it replaces — timestamp formats, byte-precise truncation, word
// counting, curl-style http codes — so engine output stays byte-identical.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync, spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const CODEX_NUDGE_MODEL = "gpt-5.4-mini";

const home = require(path.join(ROOT, "lib", "shell", "home.js"));
const { writeFileAtomic } = require(path.join(ROOT, "lib", "shell", "atomic-write.js"));
const spool = require(path.join(ROOT, "lib", "shell", "spool.js"));
const { gitEnv, gitSpawn, gitToplevelAndCommonDir } = require(path.join(ROOT, "lib", "shell", "git-exec.js"));
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
// Config-aware plain-object read — no env fallback (a declared map like
// `coupling.aliases` has no single-value env spelling): the active cascade's
// value when it's a plain object, else `fallback`. Standalone (no active
// config) always returns `fallback`, so a direct call stays byte-identical to
// "nothing declared" (issue-spor-coupling-matcher-reverse-symlink-gap).
function cfgObj(keyPath, fallback = {}) {
  return _config ? _config.getObj(keyPath, fallback) : fallback;
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

// Structural fallback for the `.claude/worktrees/<name>` dispatch convention
// (bin/spor.js dispatchWorktreeDir, and the same layout Claude Code's own
// worktree isolation uses): the directory holding `.claude/worktrees/<name>`,
// derived from the PATH alone, no git involved. This is what inferenceRoot()
// falls back on when git itself can't resolve the worktree at all — a linked
// worktree whose admin state (`.git/worktrees/<name>`) was pruned or removed
// out from under a still-running session, e.g. by a concurrent orchestrator
// cleanup (issue-spor-capture-worktree-repo-stamp-task-id). When git fails
// that completely, `--show-toplevel` returns nothing and cwd IS the worktree
// dir — a bogus, node-id-shaped basename — so without this, projectSlug()
// mints the dispatched task's id as the project slug instead of the repo's.
// Returns null when cwd carries no such segment (the ordinary case).
function structuralWorktreeRoot(cwd) {
  const parts = path.resolve(String(cwd || "")).split(path.sep);
  for (let i = 1; i < parts.length - 1; i++) {
    if (parts[i] === ".claude" && parts[i + 1] === "worktrees") {
      return parts.slice(0, i).join(path.sep) || path.sep;
    }
  }
  return null;
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
// the one project identity, so no bogus slug and no false rename.
//
// Both rev-parse queries ride ONE spawn (`--show-toplevel` then
// `--git-common-dir`, one line each — the same trick pre-tool.js's
// detectWorktreeSession uses) rather than two separate ones: a dispatched
// worktree can be torn down by a concurrent orchestrator cleanup at any
// moment (removeDispatchWorktree), and two independent spawns leave a window
// where the first succeeds and the second observes the now-pruned worktree —
// silently discarding the main-checkout resolution mid-call
// (issue-spor-capture-worktree-repo-stamp-task-id). One spawn makes that
// interleaving impossible.
//
// Fail-open, but not blindly to `cwd`: when git can't resolve the worktree at
// all (both lines empty — a totally broken/orphaned admin dir), cwd's own
// basename is the worktree's node-id-shaped directory name, not a repo name,
// so structuralWorktreeRoot() recovers the enclosing checkout from the path
// convention before falling back to raw cwd.
function inferenceRoot(cwd) {
  const { top, common } = gitToplevelAndCommonDir(cwd);
  if (!top) return structuralWorktreeRoot(cwd) || cwd || "";
  // In a linked worktree git-common-dir is the main repo's `.git`, sitting
  // one level under the main worktree; in the main checkout it is `<top>/.git`
  // and dirname() returns `top` unchanged, so the single-repo path is intact.
  if (common) {
    const mainTop = path.dirname(common);
    if (mainTop && mainTop !== top) return mainTop;
  }
  return top;
}

// Narrower predicate than inferenceRoot(): is `dir` ITSELF sitting inside a
// LINKED worktree (its own toplevel, whether `dir` names that toplevel exactly
// or a subdirectory below it)? Returns the main checkout's directory if so,
// else null — including for an ordinary subdirectory of a MAIN checkout, which
// inferenceRoot's `!== cwd` would misflag (show-toplevel already collapses a
// subdirectory to its checkout's root, so `top` and `mainTop` agree there; they
// diverge only when `top` is a linked worktree's own root). Used where a caller
// holds an explicit directory — `spor dispatch --dir`, `dispatch.repos` — and
// must tell "this literally IS/is-in a worktree" from "this is merely not the
// repo root" before refusing or self-healing it
// (issue-spor-dispatch-dir-inside-worktree-nesting). A git SUBMODULE also
// makes `--show-toplevel`/`--git-common-dir` diverge (common-dir resolves to
// the superproject's `.git/modules/<name>` admin dir, not a working tree at
// all), so the divergence alone isn't sufficient — a linked worktree's
// common-dir is always the main checkout's OWN `.git` directly (basename
// `.git`); a submodule's is nested one level deeper under `modules/`, whose
// basename is the submodule's name, never literally `.git`. One spawn, same
// TOCTOU-safe trick as inferenceRoot. Fail-open to null (not a worktree, not
// git, or git couldn't resolve it at all) — never invented from a path alone.
function linkedWorktreeMainRoot(dir) {
  const { top, common } = gitToplevelAndCommonDir(dir);
  if (!top || !common || path.basename(common) !== ".git") return null;
  // git prints `C:/...` on Windows; resolve both to the platform's own form so
  // the root this hands back reads (and persists) like every other path we print.
  const mainTop = path.resolve(path.dirname(common));
  return mainTop !== path.resolve(top) ? mainTop : null;
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
    const intervalMs = opts.intervalMs ?? cfgNum("gc.intervalMs", "GC_INTERVAL", spool.SPOOL_TTL.gcInterval);
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
    const maxAgeMs = opts.maxAgeMs ?? cfgNum("gc.maxAgeMs", "GC_MAX_AGE", spool.SPOOL_TTL.gcMaxAge);
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

// Git takes its repository LOCATION from the environment before it ever
// discovers one from the working directory, so an ambient GIT_DIR/GIT_WORK_TREE
// (a git hook, `git rebase --exec`, a wrapper script that exported one) beats
// both `-C <dir>` and cwd — the same precedence pre-tool.js already models for
// the commands it inspects. Every git call in this codebase names its repo by
// directory, so a leaked var silently retargets it at the ambient repo: `spor
// dispatch --worktree` then attached the target repo's worktree to the
// LAUNCHER's repo, checking out the launcher's code at the target's path
// (issue-spor-dispatch-worktree-wrong-repo-location). gitEnv (lib/shell/
// git-exec.js, the one shared definition — bin/spor.js's own git spawn and
// lib/shell/gittime.js's both build on it too) strips those vars from the
// child env and lets the directory be authoritative. Byte-identical when none
// are set, which is the normal case.
function git(cwd, args, opts = {}) {
  const r = gitSpawn(cwd, args, { stdio: ["ignore", "pipe", "ignore"], ...opts });
  return r.error || r.status !== 0 ? null : r.stdout;
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
//   An in-repo symlink has two valid spellings and this single-value
//   derivation can only ever return one of them at a time (literal-first
//   favors the alias). See repoRelativeCandidates below for the matcher-level
//   fix that hands the coupling matcher BOTH spellings at once
//   (task-spor-coupling-matcher-symlink-alias).
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

// Every valid repo-relative spelling for `file` — the literal (alias) spelling
// AND the canonical (git-resolved) spelling, deduped, IN-REPO ONLY (empty
// array when neither stays inside the repo — mirrors repoRelative's null
// contract for the single-candidate case). For an ordinary file the two
// spellings coincide and this returns one entry; for a file reached through a
// tracked in-repo symlink (`frontend -> packages/web`) it returns both
// `frontend/app.js` and `packages/web/app.js`, so a consumer that tests every
// candidate (the coupling matcher's couplingHit) matches a glob authored
// against either side of the symlink (task-spor-coupling-matcher-symlink-alias).
function repoRelativeCandidates(top, file) {
  const inRepo = (rel) => rel !== "" && rel !== ".." && !rel.startsWith("../") && !path.isAbsolute(rel);
  const lit = path.relative(top, file).split(path.sep).join("/");
  const canon = path.relative(canonPath(top), canonPath(file)).split(path.sep).join("/");
  const out = [];
  if (inRepo(lit)) out.push(lit);
  else {
    // The literal spelling walked out of the repo. When that walk-out is only
    // a BASE-spelling mismatch — the windows-latest 8.3 short-vs-long split
    // (os.tmpdir()'s RUNNER~1 prefix vs git's long --show-toplevel,
    // issue-spor-windows-ci-short-path-mismatch), or an aliased mount of the
    // repo's own ancestry — canonicalizing the WHOLE file path would also
    // resolve any in-repo symlink and silently lose the alias spelling
    // (issue-spor-windows-ci-symlink-alias-candidates-lost). Recover it
    // instead: walk `file`'s ancestors up to the one that IS the repo top
    // under canonicalization; the tail below that ancestor is the in-repo
    // part, kept exactly as spelled.
    const alias = literalTailUnderTop(top, file);
    if (alias && inRepo(alias)) out.push(alias);
  }
  if (inRepo(canon) && !out.includes(canon)) out.push(canon);
  return out;
}

// The literal spelling of `file`'s path BELOW the repo top, tolerating a
// base-spelling mismatch between the two: ancestors of `file` are compared to
// `top` by canonical identity (canonPath both sides), while the components
// below the matching ancestor — the in-repo tail, where a symlink alias may
// live — are returned exactly as spelled. Null when no ancestor of `file` is
// the repo top (a genuinely out-of-repo path).
function literalTailUnderTop(top, file) {
  const canonTop = canonPath(top);
  let cur = path.resolve(String(file ?? ""));
  const tail = [];
  for (;;) {
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    tail.unshift(path.basename(cur));
    cur = parent;
    if (canonPath(cur) === canonTop) return tail.join("/");
  }
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
// durable graph — nodes/ and history/ — is intentionally NOT ignored.
// Anchored with a leading slash to the home root so a same-named dir under
// nodes/ is unaffected.
//
// candidates/ (factory candidate BUNDLES — binary git artifacts,
// FACTORY-IMPLEMENTATION-STAGE.md §2.1) is deliberately NOT in this list: the
// default `implementation.candidate.bundle_store` is machine-local, under
// userConfigHome() rather than this marker-resolved shared home, so a static
// `/candidates/` line here would be dead weight almost always and cover an
// operator override only by accident
// (task-spor-candidate-store-home-vs-shared-graph-home-trap). Instead
// `ensureStoreGitignore` in lib/shell/candidate-publish.js runs at the point
// the store is actually resolved and writes the ignore line into WHICHEVER
// directory the store lands in — the default userConfigHome(), or this shared
// home when an operator declares `bundle_store` inside it — so the ignore
// line always follows the store's real home instead of a fixed guess.
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
// committable repo .spor.json. Written only by explicit verbs — `spor enable`,
// `spor repos`, `spor dispatch` — never by a hook; fail-open throughout.
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
function probeHarnesses(cfg) {
  // A harness counts as present when its launcher is reachable AT ALL — the
  // bare name on PATH, or the explicit `dispatch.bin.<harness>` /
  // SPOR_<X>_CMD override a box uses when its install prefix never reaches a
  // non-interactive PATH (task-spor-dispatch-adapters-opencode-copilot).
  // Without this the probe would report the harness missing and dispatch would
  // refuse on satisfiability BEFORE the launcher it was told about is ever
  // tried. Required lazily so the hook hot path doesn't load the adapter
  // registry it never uses; with no override configured the answer is the same
  // whichSync() this always returned.
  //
  // The cascade is PASSED IN, not read from the module-level active config:
  // the `spor` CLI resolves a Config per command and never installs it here,
  // so reading `config()` would silently see null on exactly the CLI paths
  // that matter (dispatch, capabilities) and drop the config route — leaving
  // dispatch to refuse on satisfiability for a launcher it had been told
  // about. Falls back to the active config for the hook engines, which do
  // install one.
  const { harnessAvailable, declaredHarnessIds } = require(path.join(ROOT, "lib", "shell", "dispatch-harnesses.js"));
  const resolved = cfg || config();
  const found = [];
  // Built-ins first, in their shipped order; then this machine's own
  // `dispatch.harness.<id>` bindings (task-spor-dispatch-declarative-custom-
  // harness), so `spor capabilities` reflects a declared harness and an org
  // profile naming one satisfies only on the boxes whose OWNER bound it. Each
  // is checked the same way — the declared command must exist where it says,
  // or resolve on PATH if it is a bare name — so declaring a harness whose
  // launcher is absent does NOT report it available. A machine with no
  // declarations answers exactly what it always did.
  for (const name of Object.keys(HARNESS_BINARIES).concat(declaredHarnessIds(resolved))) {
    if (harnessAvailable(name, { cfg: resolved, which: whichSync })) found.push(name);
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
  // `opts.cfg` is the caller's resolved cascade — see probeHarnesses.
  const probed = { harnesses: probeHarnesses(opts && opts.cfg), plugins: ps.plugins, skills: ps.skills };
  if (opts && opts.sporReachable) probed.reachable_mcp = [SPOR_MCP_NAME];
  // gh — the v1 backend a propose-mode factory's integration stage needs to
  // open pull requests (task-spor-propose-gh-capability-satisfiability). A
  // plain PATH stat, same cost class as the harness probe above (no spawn),
  // so it is always cheap enough for this fail-open session-start path.
  probed.gh = whichSync("gh") != null;
  // `persist: false` computes the same map and writes NOTHING — for a caller
  // that must be side-effect free (`spor dispatch --print`, whose whole promise
  // is that a preview mutates no configuration,
  // task-spor-worker-preflight-validation). Every other caller keeps the
  // refresh-on-read behavior byte-identically.
  if (opts && opts.persist === false) return probed;
  persistProbedCapabilities(graphHomeDir, probed);
  return probed;
}

// Write a probe taken earlier with `persist: false` — for a caller that has to
// decide on it BEFORE it may write anything (`spor dispatch`'s plan phase,
// task-spor-extract-dispatch-and-work-from-bin-spor). Same no-op-when-unchanged
// refresh probeCapabilities does itself.
function persistProbedCapabilities(graphHomeDir, probed) {
  editCapabilities(graphHomeDir, (cap) => {
    if (JSON.stringify(cap.probed || null) === JSON.stringify(probed)) return false;
    cap.probed = probed;
    return true;
  });
}

// Best-effort by default — every caller that ignores the return value behaves
// exactly as it did. It RETURNS whether the line landed for the one caller that
// cannot treat the write as free: drainPendingNudges consumes a
// classifier-verified finding on the strength of its `.nudged-injected` marker,
// so a silently failed marker write would discharge a debt nothing recorded.
// Test polling a plain-appended file (e.g. journal/llm-calls) for a torn
// read: use test/helpers/llm-calls.js's tryLlmCalls, not a raw JSON.parse.
function appendLine(file, line) {
  try {
    fs.appendFileSync(file, line + "\n");
    return true;
  } catch {
    return false;
  }
}

function makeLogger(file, prefix) {
  return (msg) => appendLine(file, `[${isoSeconds()}] ${prefix}${msg}`);
}

// The claim-heartbeat journal record: a protocol, not just an operability log,
// shared between post-tool.js's claim-heartbeat branch (writer) and
// distill.js's sessionEndLease (reader, replayed in journal order — see
// task-spor-heartbeat-journal-protocol-shape-guard). Both ends go through
// these two functions so a field rename on either side breaks the shape test
// in test/heartbeat-journal-shape.test.js instead of silently diverging.
// The replay is now only sessionEndLease's FALLBACK for a server without POST
// /v1/queue/session-end (task-split-spor-411451419762); retire these helpers
// and the shape test once every tenant runs a server with that door.
const HEARTBEAT_TOOL = "claim-heartbeat";

function appendHeartbeatRecord(journalPath, { project, renewed, dropped, skippedOtherProject }) {
  appendLine(
    journalPath,
    JSON.stringify({
      ts: jqNow(),
      project,
      tool: HEARTBEAT_TOOL,
      renewed,
      ...(dropped && dropped.length ? { dropped } : {}),
      // A count, not ids (mirrors server/leases.js renewAll's own
      // skipped_other_project — only present when nonzero, same convention as
      // `dropped`'s length check above). Purely observability, and NOT
      // redundant with `dropped`: `dropped` only ever names ids drawn from
      // this project's own scoped lookup, while the leases this count names
      // are OUTSIDE that scope entirely and never appear as ids anywhere in
      // this record. readHeartbeatHeldIds never reads this field
      // (task-split-spor-5affee1c0338) — it records WHY the beat's `renewed`
      // set stayed narrow: leases deliberately left out of project scope,
      // not lost track of.
      ...(skippedOtherProject ? { skipped_other_project: skippedOtherProject } : {}),
    })
  );
}

// Replays a session's claim-heartbeat entries in journal ORDER into the set of
// node ids this session currently holds a live lease on: `renewed` ADDS an id
// this beat confirmed, `dropped` REMOVES one it no longer holds — a
// point-in-time reading, not a cumulative one (see distill.js sessionEndLease
// for why order matters: a node dropped mid-session must not linger in the
// set just because an earlier beat renewed it). `project`, when given,
// restricts the replay to entries recorded under that project — each beat's
// `renewed`/`dropped` lists are already scoped to the ids visible in that
// beat's project-scoped `assignee=me` lookup (post-tool.js's claimNudge), so
// this lets a caller ask "what does this session hold IN THIS PROJECT so
// far" without picking up ids a heartbeat in a different repo happened to
// renew in the same session (issue-spor-sessionend-reserve-retakes-released-lease).
function readHeartbeatHeldIds(entries, project) {
  const ids = new Set();
  for (const e of entries) {
    if (!e || e.tool !== HEARTBEAT_TOOL) continue;
    if (project !== undefined && e.project !== project) continue;
    if (Array.isArray(e.renewed)) for (const id of e.renewed) if (id) ids.add(id);
    if (Array.isArray(e.dropped)) for (const id of e.dropped) if (id) ids.delete(id);
  }
  return ids;
}

// The distinct projects a session's claim-heartbeat entries were recorded
// under — a session that edited more than one repo can hold leases in more
// than one project's pool, and each needs its own project-scoped
// `assignee=me` lookup (readHeartbeatHeldIds already scopes the replay itself
// per project; this is just "which projects did it ever touch").
function heartbeatJournalProjects(entries) {
  const projects = new Set();
  for (const e of entries) {
    if (e && e.tool === HEARTBEAT_TOOL && typeof e.project === "string") projects.add(e.project);
  }
  return projects;
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

// The ONE reading of a curl()-shaped status for every remote engine
// (session-start, drain-outbox, distill), so no engine re-derives its own set
// and drifts (issue-cc-auth-transport-conflation-silent-loss,
// issue-cc-401-429-contract-gap — each engine had grown a different list, and
// distill still re-POSTed a 403 the drain then dead-lettered). Kinds:
//   ok         — 2xx.
//   auth       — 401/403: the token is revoked, expired or mis-pasted. NOT an
//                outage, and it does not recover by waiting, so it is
//                PERMANENT and must be named loudly. Callers that write send
//                through curlWithRefresh, which refreshes a store tenant's
//                token once and retries first — so an auth verdict here has
//                already survived the one refresh that could have fixed it.
//   rejected   — 400/413/422: the server's verdict on these exact bytes; a
//                re-POST can only be rejected again, so PERMANENT.
//   rate-limit — 429: transient, retried only after its Retry-After/backoff.
//   transport  — "000": no response at all (timeout, refused, DNS, abort).
//   server     — anything else (5xx, an unexpected 404/409): transient.
// API.md §5: mechanical writers dead-letter the permanent kinds to
// outbox/dead/ and keep the transient ones spooled.
function classifyHttpFailure(http) {
  const s = http == null ? "000" : String(http);
  if (s === "000" || s === "") return "transport";
  const n = Number(s);
  if (n >= 200 && n < 300) return "ok";
  if (n === 401 || n === 403) return "auth";
  if (n === 429) return "rate-limit";
  if (n === 400 || n === 413 || n === 422) return "rejected";
  return "server";
}

// Permanent kinds: dead-letter, never re-POST (API.md §5).
function isPermanentHttpFailure(kind) {
  return kind === "auth" || kind === "rejected";
}

// A headless invocation the system itself spawned (the distiller, the capture
// ingester, the nudge/digest-intent classifiers — every spawn site exports
// SPOR_DISTILLING, client and server). Hooks firing inside one must not nudge,
// digest, drain or distill: nobody reads that output, and the distiller's own
// SessionEnd would recurse. The ONE spelling of the check (legacy
// SUBSTRATE_DISTILLING dual-read included).
function isSystemSession(env = process.env) {
  return Boolean(env.SPOR_DISTILLING || env.SUBSTRATE_DISTILLING);
}

// A signal that aborts when EITHER does — the per-call timeout, or a caller's
// shared deadline (session-start's one budget over its concurrent reads).
function anySignal(signals) {
  const live = signals.filter(Boolean);
  if (live.length <= 1) return live[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(live);
  const ctl = new AbortController();
  for (const sig of live) {
    if (sig.aborted) {
      ctl.abort(sig.reason);
      break;
    }
    sig.addEventListener("abort", () => ctl.abort(sig.reason), { once: true });
  }
  return ctl.signal;
}

// sleep() that ends early when `signal` aborts, so a retry backoff never
// outlives the caller's deadline.
function sleepUnless(ms, signal) {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

// curl-shaped HTTP: resolves to {http: "200", body: "...", headers: {...}}
// with "000" on any transport failure (timeout, refused, DNS). Never throws.
// `headers` is a plain lowercased-key object (fetch's Headers normalizes
// names on iteration) — absent (undefined) on transport failure, since there
// is no response to read it from. Like bare curl, redirects are not
// followed. Transient failures (transport, 429, 5xx) are retried up to
// `retry` times; between retries we honor a 429 Retry-After header and
// otherwise back off exponentially (capped at backoffCapMs). With retry=0
// (the session-start hook budget) no backoff ever runs. An optional `signal`
// is a caller-owned DEADLINE layered over the per-call timeout: whichever
// fires first aborts the request (reported as transport, "000"), and it also
// cuts a retry backoff short and stops further attempts.
async function curl(
  url,
  { method = "GET", headers = {}, body, timeoutMs = 6000, retry = 0, backoffCapMs = 8000, signal } = {}
) {
  for (let attempt = 0; ; attempt++) {
    const canRetry = attempt < retry && !(signal && signal.aborted);
    let res;
    let text;
    try {
      res = await fetch(url, {
        method,
        headers,
        body,
        redirect: "manual",
        signal: anySignal([AbortSignal.timeout(timeoutMs), signal]),
      });
      text = await res.text().catch(() => "");
    } catch {
      if (canRetry) {
        await sleepUnless(backoffMs(attempt, null, backoffCapMs), signal);
        if (!(signal && signal.aborted)) continue;
      }
      return { http: "000", body: "" };
    }
    const kind = classifyHttpFailure(res.status);
    const transient = kind === "rate-limit" || res.status >= 500;
    if (transient && canRetry) {
      const retryAfterMs = kind === "rate-limit" ? parseRetryAfter(res.headers.get("retry-after")) : null;
      await sleepUnless(backoffMs(attempt, retryAfterMs, backoffCapMs), signal);
      if (!(signal && signal.aborted)) continue;
    }
    const respHeaders = {};
    res.headers.forEach((v, k) => {
      respHeaders[k] = v;
    });
    return { http: String(res.status), body: text, headers: respHeaders };
  }
}

// Token + server resolve through the active-tenant selector (Config.token()/
// server(), dec-spor-client-cli-mode-tenant-resolution) so a multi-tenant box's
// remote-mode hooks authenticate as the active tenant, not a flat config field.
// Byte-identical when no credential store / org selector is in play.
function bearer() {
  const v = _refreshed && _refreshed.config === _config ? _refreshed.token : _config ? _config.token() : home.envDual("TOKEN");
  return { Authorization: `Bearer ${v || ""}` };
}

// One token refresh per run, then a retry (issue-spor-hook-engines-dead-letter-
// on-401-without-token-refresh). A capture answered 401/403 is PERMANENT to
// classifyHttpFailure and gets dead-lettered, so an expired short-lived
// device-grant token would strand facts a refresh delivers. curlWithRefresh is
// curl() for an authenticated call: on 401/403 it refreshes the active tenant
// through lib/remote.js's own door (the CLI's refresh-once-on-401) and retries
// ONCE with the fresh bearer; the caller classifies whatever comes back, so a
// still-rejected token dead-letters exactly as before. The refresh is attempted
// at most once per active config — a distill loop over N facts must not POST N
// refresh grants against a dead refresh token — and a fresh token is remembered
// so every later bearer() in the run sends it (Config memoizes its tenant, so
// its token() would keep answering the stale one). The flat/env path carries no
// refresh_token, so there the refresh is a no-op and the call is byte-identical
// to curl(). Callers pass their headers WITHOUT Authorization; it is supplied
// here so the retry can swap it.
//
// Only the store tenant's OWN token is refreshed. A dispatched agent run has a
// flat env SPOR_TOKEN that is an agent-scoped child token while HOME — and so
// the person's credentials.json — is unchanged. Refreshing there would retry the
// agent's rejected POST as the PERSON (a 403 retried past the agent's scope) and
// hand every later bearer() in the run the person's token. Config's flat()
// selection now withholds the store's refresh_token from such a tenant at
// resolution (issue-spor-agent-token-scope-escalation-via-refresh-and-store-
// default), so `t.refresh_token` is already null there; the check below stays
// as the second guard, judged on the bearer actually SENT: a tenant the selector
// took FROM the store (by key: the default, or an org selector) is always
// eligible — its bearer is the store's own even when another process has since
// refreshed the file under us — while a flat server+token selection is eligible
// only when the bearer we sent IS the stored access_token.
const STORE_TENANT_SOURCES = new Set(["store-default", "cli-org", "env-org", "repo-marker"]);
let _refreshed = null; // { config, token } — the fresh bearer for this run
let _refreshTried = null; // the config a refresh was already attempted under
// The refresh in flight, so CONCURRENT auth failures in one run (session-start
// fires its briefing/queue/capabilities calls in one Promise.all) all wait on
// the one refresh and retry with its token, instead of the losers seeing
// `_refreshTried` set and giving up on a 401 the winner is about to fix.
let _refreshInflight = null; // { config, promise }
function sentIsStoreToken(sent) {
  try {
    const t = _config.tenant();
    if (!t || !t.key || !t.refresh_token) return false;
    if (STORE_TENANT_SOURCES.has(t.source)) return true;
    const auth = require(path.join(ROOT, "lib", "auth.js"));
    const stored = auth.readStore(_config.userConfigHome()).tenants[t.key];
    return !!(stored && stored.access_token === sent);
  } catch {
    return false;
  }
}
async function refreshBearer(sent) {
  if (_refreshInflight && _refreshInflight.config === _config) return _refreshInflight.promise;
  if (!_config || _refreshTried === _config) return null;
  if (!sentIsStoreToken(sent)) return null;
  const cfg = _config;
  _refreshTried = cfg;
  const promise = (async () => {
    let fresh = null;
    try {
      fresh = await require(path.join(ROOT, "lib", "remote.js")).refreshAfterAuthFailure(cfg);
    } catch {
      fresh = null;
    }
    if (fresh) _refreshed = { config: cfg, token: fresh };
    return fresh;
  })();
  _refreshInflight = { config: cfg, promise };
  try {
    return await promise;
  } finally {
    if (_refreshInflight && _refreshInflight.promise === promise) _refreshInflight = null;
  }
}
async function curlWithRefresh(url, opts = {}) {
  const headers = opts.headers || {};
  const sentBearer = bearer().Authorization;
  const r = await curl(url, { ...opts, headers: { ...bearer(), ...headers } });
  if (classifyHttpFailure(r.http) !== "auth") return r;
  // A caller's DEADLINE (`opts.signal`, session-start's one budget over its
  // batch) bounds the refresh too: the token grant has its own 8s timeout and
  // must not stretch a bounded batch past its deadline, after which the retry
  // would only fail on the aborted signal anyway. The refresh itself is left
  // running, so the store still gets the fresh token if it lands.
  const signal = opts.signal;
  if (signal && signal.aborted) return r;
  // A sibling call in this run may already have refreshed: retry with that
  // token rather than refreshing again.
  const fresh =
    bearer().Authorization !== sentBearer ? true : await untilAborted(refreshBearer(sentBearer.replace(/^Bearer /, "")), signal);
  if (!fresh || (signal && signal.aborted)) return r;
  return curl(url, { ...opts, headers: { ...bearer(), ...headers } });
}

// `promise`, or null as soon as `signal` aborts (whichever is first).
function untilAborted(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve) => {
    const onAbort = () => resolve(null);
    if (signal.aborted) return resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve(null);
      }
    );
  });
}

function serverBase() {
  const v = _config ? _config.server() : home.envDual("SERVER");
  return (v || "").replace(/\/+$/, "");
}

// The shared "what does this person hold in this project's queue right now"
// lookup — GET /v1/queue?project=<slug>&assignee=me — used both by
// post-tool.js's claim heartbeat (per-write) and distill.js's sessionEndLease
// (the SessionEnd-time re-check, issue-spor-sessionend-reserve-release-as-
// last-event-still-retaken). Returns the raw `items` array (any lease state,
// not just held) on a parseable 200, or null on anything that can't be
// trusted — non-200, dead/slow server, unparseable body — so every caller
// fails open the exact same way instead of re-deriving the same try/catch.
async function fetchAssigneeMineItems(slug, timeoutMs) {
  const mine = await curlWithRefresh(`${serverBase()}/v1/queue?project=${encodeURIComponent(slug)}&assignee=me`, {
    timeoutMs,
  });
  if (mine.http !== "200") return null;
  try {
    const body = JSON.parse(mine.body);
    return Array.isArray(body.items) ? body.items : null;
  } catch {
    return null;
  }
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
// `failure`, when given, is filled on a failed run with what the process
// said about itself (backendFailure) so the caller can record WHY rather than
// a bare "cmd failed" (issue-spor-nudge-cmd-failed-majority).
function runBackendCmd(cmd, prompt, { timeoutMs, failure } = {}) {
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
  if (r.status !== 0 || r.error) {
    if (failure) Object.assign(failure, backendFailure(r));
    return null;
  }
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

// What a failed backend spawn said about itself, for the llm-calls record:
// the exit code, the killing signal (a SIGKILL is the timeout), a spawn error
// code (ENOENT: the command does not exist), and the head of stderr. Only the
// fields that carry something are present.
function backendFailure(r) {
  const f = {};
  if (typeof r.status === "number") f.exit_code = r.status;
  if (r.signal) f.signal = r.signal;
  if (r.error && r.error.code) f.spawn_error = r.error.code;
  const err = stripTrailingNewlines(String(r.stderr || ""));
  if (err) f.stderr = byteHead(err, 1000);
  return f;
}

// "nudge cmd failed" plus the one-line reason a reader of `spor-hook doctor`
// needs to act on it: "(exit 127: sh: 1: gemini: not found)". The label stays
// the prefix, so anything grouping failures by label still groups them.
function describeBackendFailure(label, f) {
  if (!f) return label;
  const how =
    f.spawn_error ? `spawn ${f.spawn_error}` : f.signal ? `signal ${f.signal}` : f.exit_code != null ? `exit ${f.exit_code}` : "";
  const why = f.stderr ? byteHead(f.stderr.split("\n").find((l) => l.trim()) || "", 200).trim() : "";
  if (!how && !why) return label;
  return `${label} (${[how, why].filter(Boolean).join(": ")})`;
}

// A classifier/distiller response is a NOTHING verdict only when it parsed no
// fact/node block AND one of its lines is exactly `NOTHING`. A substring test
// read any fact that merely MENTIONED the word ("returns NOTHING when…") as
// "no facts" and dropped the whole response (issue-spor-nudge-cmd-failed-majority).
function isNothingVerdict(response, parsedCount) {
  if (parsedCount > 0) return false;
  return String(response)
    .split("\n")
    .some((l) => l.trim() === "NOTHING");
}

// Default backend: headless `claude -p --model haiku --max-turns 1 <prompt>`,
// JSON output so the call's token usage and cost are recorded. Returns
// { text, usage, cost_usd, model } or null on process failure. `timeoutMs`
// (when > 0) SIGKILLs a hung CLI so the call can't block the host past its
// budget; a killed run lands in r.error and fails open like any other failure.
function runClaudeBackend(prompt, { timeoutMs, failure } = {}) {
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
  if (r.status !== 0 || r.error) {
    if (failure) Object.assign(failure, backendFailure(r));
    return null;
  }
  return parseClaudeResult(r.stdout);
}

// Shared classifier-backend invocation, used by the capture nudge
// (post-tool.js's classifyForNudge) and the digest-intent classifier
// (prompt-context.js's classifyDigestIntent): pick a backend (a configured
// cmd, else `claude -p --model haiku`), run it bounded by timeoutMs, and
// record the call to journal/llm-calls in the one shape both sources feed the
// nightly Haiku-quality review loop with. Returns { response, backend, usage,
// cost_usd, model } on success, or null on backend failure (still recorded,
// with `error` set). Callers own all response PARSING (===FACT=== blocks vs
// WARRANTED/UNWARRANTED) and all cooldown/journal STATE — this function's
// only side effect is the llm-calls record.
function runClassifierBackend({ prompt, tplSha, session, project, graph, source, template, timeoutMs, cmd, vars }) {
  const llmDir = path.join(graph, "journal", "llm-calls");
  const t0 = Date.now();
  let backend = "";
  let usage = null;
  let cost_usd = null;
  let model = null;
  const recordLlm = (response, error, failure) => {
    if (!ensureDir(llmDir)) return;
    const rec = {
      id: `llm-${Date.now()}-${bashRandom()}`,
      ts: isoMs(),
      source,
      backend,
      template,
      template_sha: tplSha,
      session,
      project,
      latency_ms: Date.now() - t0,
      usage,
      cost_usd,
      model,
      prompt,
      vars,
      response: error === "" ? response : null,
      error: error === "" ? null : describeBackendFailure(error, failure),
      ...(failure || {}),
    };
    appendLine(path.join(llmDir, `${localDate()}.jsonl`), JSON.stringify(rec));
  };

  let response;
  const failure = {};
  if (cmd) {
    backend = `cmd:${cmd}`;
    response = runBackendCmd(cmd, prompt, { timeoutMs, failure });
    if (response === null) {
      recordLlm("", `${source} cmd failed`, failure);
      return null;
    }
  } else {
    backend = "cli:claude -p --model haiku";
    const res = runClaudeBackend(prompt, { timeoutMs, failure });
    if (res === null) {
      recordLlm("", "claude -p failed", failure);
      return null;
    }
    response = res.text;
    usage = res.usage;
    cost_usd = res.cost_usd;
    model = res.model;
  }
  recordLlm(response, "");
  return { response, backend, usage, cost_usd, model };
}

// Shared detached-worker main routine, used by nudge-worker.js and
// digest-worker.js (task-spor-client-classifier-backend-refactor): read the
// spool INPUT file, delete it immediately (so a duplicate worker can't re-run
// the same classification), run the caller's `classify(job)`, and — when
// `buildOutput(job, result)` returns a truthy record — write it atomically
// (tmp file + rename, so the prompt-time drainer's `*.out.json` glob never
// sees a half-written file) as `<job.hash>.out.json` beside the input. Always
// exits 0 (workers are fire-and-forget; a thrown classify() fails open —
// leaves the file reserved, injects nothing). `buildOutput` returning a
// falsy value (or a missing `job.hash`) writes nothing.
function runSpoolWorker(inFile, classify, buildOutput) {
  if (!inFile) process.exit(0);

  let job;
  try {
    job = JSON.parse(fs.readFileSync(inFile, "utf8"));
  } catch {
    // Unreadable/malformed input: nothing to classify. Leave it — a transient
    // read failure is indistinguishable from a corrupt one here, and the
    // drain's orphan sweep bounds the spool either way.
    process.exit(0);
  }

  // OWE BEFORE YOU CLEAR. The `.in.json` IS this job's durable debt — it is
  // already on disk, so owing it costs no write of ours that could itself fail
  // — and it is not cleared until the classifier's verdict is durable
  // somewhere else. The old order (unlink, then classify, then write the
  // result) had two holes this closes: a crash after classification but before
  // the result landed lost the job with nothing left to retry, and a FAILED
  // `.out.json` write was swallowed silently, discarding a classifier-verified
  // finding that had already been paid for. Both now leave the input in place.
  let result = null;
  let threw = false;
  try {
    result = classify(job);
  } catch {
    threw = true;
  }
  // Both classifiers share one contract: `null` means the BACKEND failed (a
  // SIGKILLed timeout, a non-zero exit) — no verdict was reached. Anything else
  // is the classifier's answer. Only an answer settles the job.
  const definitive = !threw && result !== null;

  // Cleared only on a DEFINITIVE outcome: a verdict whose result landed
  // durably, or a verdict with nothing to write (a NOTHING classification is
  // settled, not lost — re-running it would spend another backend call to
  // reach the same answer). A backend failure settles nothing, so its input
  // stays owed for the drain's bounded re-drive.
  let settled = false;
  const out = threw ? null : buildOutput(job, result);
  if (out && job.hash) {
    const outFile = path.join(path.dirname(inFile), `${job.hash}.out.json`);
    try {
      spool.writeSpoolFile(outFile, JSON.stringify(out));
      settled = true;
    } catch {
      /* the result did NOT land — keep the input as the debt to re-run */
    }
  } else if (definitive) {
    settled = true;
  }
  if (settled) {
    try {
      fs.unlinkSync(inFile);
    } catch {}
  }

  process.exit(0);
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
  cfgObj,
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
  linkedWorktreeMainRoot,
  slugify,
  projectSlug,
  projectGrouping,
  matchBriefs,
  repoFingerprints,
  git,
  gitEnv,
  NO_GPGSIGN,
  graphInsideCodeRepo,
  canonPath,
  toRepoRel,
  repoRelative,
  repoRelativeCandidates,
  ensureDir,
  spoolStats,
  ensureGraphGitignore,
  registerRepo,
  forgetRepo,
  setDispatchAgent,
  whichSync,
  editCapabilities,
  persistProbedCapabilities,
  probeCapabilities,
  appendLine,
  makeLogger,
  HEARTBEAT_TOOL,
  appendHeartbeatRecord,
  readHeartbeatHeldIds,
  heartbeatJournalProjects,
  loadGraphCached,
  journalLoadMs,
  gcJournal,
  curl,
  classifyHttpFailure,
  curlWithRefresh,
  isPermanentHttpFailure,
  isSystemSession,
  anySignal,
  bearer,
  serverBase,
  fetchAssigneeMineItems,
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
  backendFailure,
  describeBackendFailure,
  isNothingVerdict,
  runClaudeBackend,
  parseClaudeResult,
  runClassifierBackend,
  runSpoolWorker,
  // The spool primitives live in lib/shell/spool.js
  // (task-spor-client-spool-single-module); re-exported so engines keep
  // reaching them through `u`.
  SPOOL_TTL: spool.SPOOL_TTL,
  writeSpoolFile: spool.writeSpoolFile,
  createExclusive: spool.createExclusive,
  claimSpoolResult: spool.claimSpoolResult,
  claimAndReadJson: spool.claimAndReadJson,
  claimSpoolJob: spool.claimSpoolJob,
  spoolResultHash: spool.spoolResultHash,
  spawnDetached,
  bashRandom,
  writeFileAtomic,
};

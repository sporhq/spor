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

const home = require(path.join(ROOT, "lib", "shell", "home.js"));

function graphHome() {
  return home.graphHome();
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
  const slug = path
    .basename(root || cwd || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
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

function bearer() {
  return { Authorization: `Bearer ${home.envDual("TOKEN") || ""}` };
}

function serverBase() {
  return (home.envDual("SERVER") || "").replace(/\/+$/, "");
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
// see it). Returns null on failure.
function runBackendCmd(cmd, prompt) {
  const r = spawnSync("sh", ["-c", cmd], {
    input: prompt,
    encoding: "utf8",
    env: { ...process.env, SPOR_DISTILLING: "1", SUBSTRATE_DISTILLING: "1" },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0 || r.error) return null;
  // RESPONSE=$(...) — command substitution strips trailing newlines.
  return stripTrailingNewlines(r.stdout);
}

// Default backend: headless `claude -p --model haiku --max-turns 1 <prompt>`.
function runClaudeBackend(prompt) {
  const r = spawnSync("claude", ["-p", "--model", "haiku", "--max-turns", "1", prompt], {
    encoding: "utf8",
    env: { ...process.env, SPOR_DISTILLING: "1", SUBSTRATE_DISTILLING: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  if (r.status !== 0 || r.error) return null;
  return stripTrailingNewlines(r.stdout);
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
  envDual: home.envDual,
  jqNow,
  isoMs,
  isoSeconds,
  localDate,
  byteHead,
  byteTail,
  wordCount,
  stripTrailingNewlines,
  projectSlug,
  projectGrouping,
  repoFingerprints,
  git,
  ensureDir,
  appendLine,
  makeLogger,
  loadGraphCached,
  journalLoadMs,
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
  spawnDetached,
  bashRandom,
};

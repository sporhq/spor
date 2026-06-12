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

// Project slug (see CLAUDE.md): basename of the git root, normalized to
// kebab-case. Identity for names that are already kebab-case. A committed
// `.spor` marker file at the repo root (`project: <id>`) beats all
// inference — it survives rename, move, fork, and history rewrite
// (task-cc-project-identity-nodes). The marker value must already be
// canonical (the server's SLUG_RE); a non-matching value is ignored rather
// than normalized, so a typo degrades to inference instead of minting a
// new identity.
function projectSlug(cwd, fallback = "project") {
  let top = cwd || "";
  try {
    top = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    /* not a git repo: use cwd */
  }
  try {
    const marker = fs.readFileSync(path.join(top || cwd || "", ".spor"), "utf8");
    const m = marker.match(/^project:[ \t]*([a-z0-9][a-z0-9-]*)[ \t]*$/m);
    if (m) return m[1];
  } catch {
    /* no marker: infer from the basename */
  }
  const slug = path
    .basename(top || cwd || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
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

// curl-shaped HTTP: resolves to {http: "200", body: "..."} with "000" on any
// transport failure (timeout, refused, DNS). Never throws. Like bare curl,
// redirects are not followed.
async function curl(url, { method = "GET", headers = {}, body, timeoutMs = 6000, retry = 0 } = {}) {
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
      if (attempt < retry) continue;
      return { http: "000", body: "" };
    }
    const text = await res.text().catch(() => "");
    const transient = res.status === 429 || res.status >= 500;
    if (transient && attempt < retry) continue;
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
  repoFingerprints,
  git,
  ensureDir,
  appendLine,
  makeLogger,
  curl,
  bearer,
  serverBase,
  serverHost,
  parseJsonStream,
  collectTextFields,
  sha256Head,
  fillTemplate,
  localTitleIndex,
  remoteTitleIndex,
  runBackendCmd,
  runClaudeBackend,
  spawnDetached,
  bashRandom,
};

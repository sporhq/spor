// shell/files.js — the filesystem half of the kernel/shell split
// (REFACTOR.md §1). Every fs read the old lib modules did inline lives here
// as a small adapter returning plain data; the kernel never sees a path it
// has to dereference. Plain Node, zero deps.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Directory of .md files -> { filename: rawText }, preserving readdir order
// (the kernel iterates insertion order, so build order is contract).
//
// A file listed by readdirSync can still fail to read — EACCES, or an ENOENT
// race against a live graph home the server/gardener writes concurrently
// (issue-spor-read-graph-files-single-file-abort). That must not abort the
// whole directory any more than one unparseable node aborts buildGraph
// (dec-spor-buildgraph-per-node-fault-isolation): with `onSkip` given, a
// failing file is left out of the result and reported via onSkip({file,
// error}) instead of thrown; loadGraph feeds those into the same
// graph.skipped record buildGraph's own parse faults land on. Without
// `onSkip` the read failure still throws, exactly as before — callers that
// don't opt in (the seed pack, `spor validate`'s re-parse) keep their
// original fail-loud behavior.
function readGraphFiles(dir, { onSkip } = {}) {
  const files = {};
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    try {
      files[f] = fs.readFileSync(path.join(dir, f), "utf8");
    } catch (e) {
      if (!onSkip) throw e;
      onSkip({ file: f, error: e.message });
    }
  }
  return files;
}

// One jsonl file -> [entry]; a missing file is an empty journal, a torn
// trailing line is skipped (the writer may be mid-append).
function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip torn line */ }
  }
  return out;
}

// All .jsonl files under dir, concatenated in readdir order. A missing dir
// is an empty journal (capture-metrics' llm-calls fallback).
function readJsonlDir(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    out.push(...readJsonl(path.join(dir, f)));
  }
  return out;
}

// Prompt template read (lib/template.js): re-read on every call so a
// template edit (e.g. by the nightly review job) takes effect on the next
// LLM call without a server restart. The sha ties journal/llm-calls records
// and eval results to the exact template version that produced them.
function loadTemplate(dir, name) {
  const text = fs.readFileSync(path.join(dir, name), "utf8");
  const sha = crypto.createHash("sha256").update(text).digest("hex").slice(0, 12);
  return { name, text, sha };
}

// Briefing-skeleton versioning (lib/graph.js renderSkeleton): archive the
// prior brief to history/ and return the bumped version number. parse is the
// kernel's parseFrontmatter, injected to keep this module logic-free.
function archiveBrief(nodesDir, briefId, parse) {
  const historyDir = path.join(nodesDir, "..", "history");
  fs.mkdirSync(historyDir, { recursive: true });
  let version = 1;
  const briefPath = path.join(nodesDir, `${briefId}.md`);
  if (fs.existsSync(briefPath)) {
    const old = parse(fs.readFileSync(briefPath, "utf8"), `${briefId}.md`);
    version = (parseInt(old.version, 10) || 1) + 1;
    fs.copyFileSync(briefPath, path.join(historyDir, `${briefId}.v${old.version || 1}.md`));
  }
  return version;
}

module.exports = { readGraphFiles, readJsonl, readJsonlDir, loadTemplate, archiveBrief };

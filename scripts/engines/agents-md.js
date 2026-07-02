"use strict";
// agents-md: write/refresh the Spor section of AGENTS.md at the git
// root. Node port of agents-md.sh — same managed marker block, same remote/
// local briefing sources, same append-or-replace semantics. The session-start
// floor for hosts without hooks; status goes to stderr (hook hosts treat
// stdout as the hook's response).

const fs = require("fs");
const path = require("path");
const u = require("./util");

const BEGIN = "<!-- spor:begin -->";
const END = "<!-- spor:end -->";
// dual-read: blocks written before the Spor rename use the old markers; we
// replace either pair but always write the new one.
const LEGACY_BEGIN = "<!-- substrate:begin -->";
const LEGACY_END = "<!-- substrate:end -->";

function toolsLine() {
  const server = u.serverBase();
  const mcp = server ? ` It is reachable over MCP at ${server}/mcp (bearer token).` : "";
  return `A team knowledge graph (Spor) holds prior decisions, constraints, dismissed approaches, and deferred work.${mcp} Before designing or deciding anything non-trivial, check it (query_graph). When you defer discovered work or make a decision worth keeping, record it (capture — 2-3 sentences; the server types and links it). Ask show_queue what to work on next. When a git commit implements a tracked node (a task, decision, or issue), add a 'Spor: <node-id>' trailer to the commit message, in the final trailer block alongside any Co-Authored-By (no blank line between trailers) — git then records which node the commit serves, and the graph records the commit's sha.`;
}

// Body after the second '---' line (awk), head -c 7000, $() newline strip.
function nodeBody(raw) {
  const lines = raw.split("\n");
  let dashes = 0;
  const out = [];
  for (const line of lines) {
    if (dashes >= 2) out.push(line);
    if (line === "---") dashes++;
  }
  const awkOut = out.length ? out.join("\n") + "\n" : "";
  return u.stripTrailingNewlines(u.byteHead(awkOut, 7000));
}

async function agentsMd(input, args = []) {
  const graph = u.graphHome();
  let cwd = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--cwd") cwd = args[i + 1] ?? "";
  }
  if (!cwd && input && input.cwd) cwd = input.cwd;
  if (!cwd) cwd = process.cwd();

  const root = u.git(cwd, ["rev-parse", "--show-toplevel"])?.trim() || cwd;
  const slug = u.projectSlug(root);

  let body = "";
  let meta = "";
  if (u.serverBase()) {
    const resp = await u.curl(`${u.serverBase()}/v1/briefing/${slug}`, {
      headers: u.bearer(),
      timeoutMs: 6000,
    });
    try {
      const parsed = JSON.parse(resp.body);
      if (parsed.found === true) {
        // jq -r emits a trailing newline; head -c counts it; $() strips it.
        body = u.stripTrailingNewlines(u.byteHead((parsed.body ?? "") + "\n", 7000));
        const version = parsed.version ?? 1;
        meta = `brief-${slug} v${version} @ ${u.serverHost()}`;
      }
    } catch {}
  } else {
    const brief = path.join(graph, "nodes", `brief-${slug}.md`);
    if (fs.existsSync(brief)) {
      let raw = "";
      try {
        raw = fs.readFileSync(brief, "utf8");
      } catch {}
      body = nodeBody(raw);
      const version = raw.match(/^version: *(.*)$/m)?.[1] ?? "";
      meta = `brief-${slug} v${version || "1"} (local)`;
    }
  }

  const tools = toolsLine();
  const section = body
    ? `## Spor team graph

${tools}

### Standing project briefing (${meta}, machine-compiled ${u.localDate()} — do not hand-edit this section; refresh with \`spor-hook agents-md\`)

${body}`
    : `## Spor team graph

${tools}`;

  const file = path.join(root, "AGENTS.md");
  const block = `${BEGIN}\n${section}\n${END}`;

  let out;
  let existing = null;
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch {}
  if (existing !== null && (existing.includes(BEGIN) || existing.includes(LEGACY_BEGIN))) {
    // awk: replace the marker block (inclusive) with the new block; every
    // emitted line gets a trailing newline.
    const lines = existing.split("\n");
    // A trailing newline in the file yields one empty final element; awk
    // never saw that pseudo-line.
    if (lines[lines.length - 1] === "") lines.pop();
    const kept = [];
    let skip = false;
    for (const line of lines) {
      if (line === BEGIN || line === LEGACY_BEGIN) {
        kept.push(block);
        skip = true;
        continue;
      }
      if (line === END || line === LEGACY_END) {
        skip = false;
        continue;
      }
      if (!skip) kept.push(line);
    }
    out = kept.join("\n") + "\n";
  } else {
    // { cat FILE (if present); echo; printf '%s\n' NEW }
    out = (existing !== null ? existing + "\n" : "") + block + "\n";
  }

  const tmp = file + `.spor-tmp-${process.pid}`;
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, file);
  process.stderr.write(`updated ${file} (${meta || "no briefing yet, MCP pointers only"})\n`);
  return null;
}

module.exports = { agentsMd };

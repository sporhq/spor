"use strict";
// agents-md: write/refresh the Spor section of AGENTS.md at the git
// root. Node port of agents-md.sh — same managed marker block, same remote/
// local briefing sources, same append-or-replace semantics. The session-start
// floor for hosts without hooks; status goes to stderr (hook hosts treat
// stdout as the hook's response).
//
// Two callers, two shapes (task-spor-agents-md-capture-discipline-directive):
//   - `spor-hook agents-md` (adapter session-start floor): directive +
//     standing-briefing embed — hook-less hosts get their briefing here.
//   - `spor agents-md` (CLI verb, also ridden by `spor enable` / `spor
//     upgrade`): directive only by default — hooked hosts already get the
//     briefing at session start, and the committed block should carry the
//     durable instruction, not a briefing snapshot that stales between
//     refreshes.

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
  return `A team knowledge graph (Spor) holds prior decisions, constraints, dismissed approaches, and deferred work.${mcp} Before designing or deciding anything non-trivial, check it (query_graph). Ask show_queue what to work on next. When a git commit implements a tracked node (a task, decision, or issue), add a 'Spor: <node-id>' trailer to the commit message, in the final trailer block alongside any Co-Authored-By (no blank line between trailers) — git then records which node the commit serves, and the graph records the commit's sha.`;
}

// The capture-discipline directive — user-voice standing instructions that
// make graph upkeep part of the work instead of an afterthought. One source
// of truth, versioned with the package: the hook floor, the CLI verb, and
// `spor enable`/`spor upgrade` all write THIS text, so a wording change ships
// to every managed block on the next refresh. Each bullet encodes a failure
// mode observed in the 2026-07-04 capture retrospective
// (art-cc-capture-discipline-results-2): work discovered but never filed,
// fix-before-issue, decisions kept only in chat, durable facts leaking to
// private auto-memory, bare status flips, a cohort of work nodes whose build
// order stayed in prose instead of becoming `blocks` edges
// (issue-spor-agent-missing-dependency-edges — the gardener's unedged-gate
// detector catches it, but only on the next sweep and only as advice, so the
// creation-time guarantee has to live here), and a substantial multi-node
// session whose connective outcome artifact never got filed until the human
// asked (issue-spor-session-outcome-artifact-capture-gap) — nothing triggers
// the session-level provenance hub the way the terminal-status gate triggers a
// resolver.
const DIRECTIVE = `Keep the graph current as you work — do these unprompted:

- The moment work is discovered that you won't do right now (an out-of-scope
  bug, a follow-up, a dismissed approach), capture it before moving on:
  /spor:defer (or \`spor add "..."\`) — 2-3 sentences in your own words; the
  server types and links it.
- Found a defect you ARE about to fix? File it first, fix second — the issue
  node is the lineage the fix resolves.
- Made a decision worth keeping (approach chosen, alternative ruled out,
  gotcha paid for)? Capture it at the moment it is made, not at session end.
- Filing more than one piece of work at once? If you know the order they must
  happen in — even if you only said it in prose ("keystone", "do this first",
  "gated on") — write that order as \`blocks\` edges between them before you move
  on. The queue takes its dependency signal only from \`blocks\` edges and never
  from prose, so an unwired cohort surfaces in the wrong order.
- Durable, team-relevant facts belong in the graph, never only in private
  auto-memory or scratch notes. If you are about to "remember" something a
  teammate or future session could need, capture it to Spor as well.
- When tracked work finishes, close the loop: record the resolution (a
  decision or artifact node with a \`resolves\` edge), not a bare status flip.
- After a substantial multi-node session (several nodes produced, or a real
  investigation/build/scoping run), file ONE outcome artifact that links what
  you produced — a provenance hub, \`resolves\` what it closed and
  \`relates-to\`/\`mentions\` the rest — so the "what did this accomplish, why do
  these nodes belong together" record exists without a human asking. Ad-hoc work
  that never flips a task to done has no other capture trigger; don't leave the
  connective record unwritten.`;

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

// Core writer: compose the managed block and splice it into AGENTS.md at the
// repo root. `briefing: false` skips the standing-briefing fetch/embed
// entirely (no server round-trip). Returns { file, meta, hadBriefing }.
async function writeAgentsBlock({ cwd, briefing = true }) {
  const graph = u.graphHome();
  const root = u.git(cwd, ["rev-parse", "--show-toplevel"])?.trim() || cwd;
  const slug = u.projectSlug(root);

  let body = "";
  let meta = "";
  if (briefing) {
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
  }

  const directive = `## Spor team graph

${toolsLine()}

${DIRECTIVE}`;
  const section = body
    ? `${directive}

### Standing project briefing (${meta}, machine-compiled ${u.localDate()} — do not hand-edit this section; refresh with \`spor agents-md --briefing\`)

${body}`
    : directive;

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

  u.writeFileAtomic(file, out);
  return { file, meta, hadBriefing: !!body };
}

async function agentsMd(input, args = []) {
  let cwd = "";
  let briefing = true;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--cwd") cwd = args[i + 1] ?? "";
    if (args[i] === "--directive-only") briefing = false;
  }
  if (!cwd && input && input.cwd) cwd = input.cwd;
  if (!cwd) cwd = process.cwd();

  const { file, meta } = await writeAgentsBlock({ cwd, briefing });
  process.stderr.write(
    `updated ${file} (${briefing ? meta || "no briefing yet, MCP pointers only" : "directive only"})\n`
  );
  return null;
}

module.exports = { agentsMd, writeAgentsBlock, DIRECTIVE };

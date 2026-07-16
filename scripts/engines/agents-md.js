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

// Parse one dotted-decimal segment honoring the WHATWG URL host-parsing
// radix rules — the same rules the fetch/URL machinery that actually
// connects to SPOR_SERVER applies to its hostname: a `0x`/`0X` prefix reads
// as hex, a bare leading `0` (with more digits following) reads as octal,
// otherwise decimal. Without this, an octal/hex spelling of a loopback
// octet (`0177`, `0x7f`) parses as its decimal digits instead — a real
// loopback address that the matcher would then miss. Returns null for
// anything that isn't a valid, unambiguous segment.
function parseIPv4Segment(str) {
  if (!str) return null;
  let radix = 10;
  let digits = str;
  let maxLen = 10;
  if (/^0[xX]/.test(str)) {
    radix = 16;
    digits = str.slice(2);
    maxLen = 8;
  } else if (str.length > 1 && str[0] === "0") {
    radix = 8;
    digits = str.slice(1);
    maxLen = 11;
  }
  // Insignificant zero-padding doesn't count against maxLen (a bound meant
  // to keep the parsed value within safe-integer precision) — real URL
  // host-parsing accepts arbitrarily zero-padded literals.
  digits = digits.replace(/^0+(?=.)/, "");
  const validDigits = radix === 16 ? /^[0-9a-f]+$/i : radix === 8 ? /^[0-7]+$/ : /^[0-9]+$/;
  if (!digits.length || digits.length > maxLen || !validDigits.test(digits)) return null;
  return parseInt(digits, radix);
}

// Parse an IPv4 host into its 32-bit value, honoring the inet_aton
// shorthand forms (`127.1`, `127.0.1`, a bare integer) that a developer's
// SPOR_SERVER might use — not just the canonical 4-octet decimal form.
// Returns null for anything that isn't a valid IPv4 literal.
function parseIPv4(str) {
  let parts = str.split(".");
  // WHATWG URL host parsing drops exactly one trailing empty label before
  // the IPv4 parse (a root-label dot: `127.1.`, `0177.0.0.1.`,
  // `2130706433.` all resolve to loopback) — without this a fetch/URL call
  // against SPOR_SERVER would classify the host as loopback while this
  // string-only parser missed it, letting a machine-local address slip
  // into the committed tools line.
  if (parts.length > 1 && parts[parts.length - 1] === "") parts = parts.slice(0, -1);
  const n = parts.length;
  if (n < 1 || n > 4) return null;
  const nums = parts.map(parseIPv4Segment);
  if (nums.some((v) => v == null)) return null;
  for (let i = 0; i < n - 1; i++) {
    if (nums[i] > 255) return null;
  }
  const lastBits = 8 * (5 - n);
  if (nums[n - 1] > 2 ** lastBits - 1) return null;
  let value = 0;
  for (let i = 0; i < n - 1; i++) value = value * 256 + nums[i];
  value = value * 2 ** lastBits + nums[n - 1];
  return value > 0xffffffff ? null : value >>> 0;
}

// A parsed IPv4 address is loopback (127.0.0.0/8) or the "any" address
// (0.0.0.0) — both are machine-local, never a peer's reachable endpoint.
function isLoopbackIPv4Value(value) {
  return (value >>> 24) === 127 || value === 0;
}

// Expand an IPv6 literal (bare hostname, no brackets) to its 8 16-bit
// groups, handling "::" compression and a trailing embedded-IPv4 tail
// (`::ffff:127.0.0.1`, the deprecated `::127.0.0.1`). Returns null if the
// literal doesn't parse.
function expandIPv6(addr) {
  // A trailing dotted-quad (mapped `::ffff:127.0.0.1` or the deprecated
  // compatible `::127.0.0.1`) rewrites to two hex groups first, so the rest
  // of the parse only ever deals in plain hex groups. `.*:` is greedy, so it
  // captures up through the LAST colon — the one separating the embedded
  // IPv4 from whatever precedes it, "::" compression included.
  let body = addr;
  const tail = addr.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (tail) {
    const v4 = parseIPv4(tail[2]);
    if (v4 == null) return null;
    body = tail[1] + (v4 >>> 16).toString(16) + ":" + (v4 & 0xffff).toString(16);
  }

  const doubleColon = body.indexOf("::");
  let groups;
  if (doubleColon !== -1) {
    if (body.indexOf("::", doubleColon + 1) !== -1) return null;
    const left = body.slice(0, doubleColon).split(":").filter(Boolean);
    const right = body.slice(doubleColon + 2).split(":").filter(Boolean);
    const missing = 8 - (left.length + right.length);
    if (missing < 0) return null;
    groups = [...left, ...Array(missing).fill("0"), ...right];
  } else {
    groups = body === "" ? [] : body.split(":");
  }
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

// A parsed IPv6 host is loopback in three forms: the canonical/expanded
// `::1`, an IPv4-mapped address (`::ffff:a.b.c.d`) whose embedded IPv4 is
// loopback, or the deprecated all-zero-prefix IPv4-compatible form.
function isLoopbackIPv6(hostname) {
  const groups = expandIPv6(hostname);
  if (!groups) return false;
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;
  const embeddedIPv4 = (groups[6] << 16) | groups[7];
  if (groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0 || groups[5] === 0xffff)) {
    return isLoopbackIPv4Value(embeddedIPv4 >>> 0);
  }
  return false;
}

// Loopback hosts — 127.0.0.0/8 (any spelling: `127.1`, `127.0.0.2`, …),
// 0.0.0.0, `localhost`, and ::1 (any spelling: fully-expanded,
// IPv4-mapped/-compatible) — are machine-local; baking one into a COMMITTED
// file leaks a developer's dev-server address to every other contributor
// (issue-spor-agents-md-local-mcp-leak). `host` is u.serverHost()'s output
// (scheme/path already stripped); peel the bracket/port a hostname carries.
// Brackets are checked before a bare port strip, and a bare host with more
// than one colon is left alone, because an unbracketed IPv6 address's
// colons would otherwise be misread as a port.
function isLocalServer(host) {
  const bracketed = host.match(/^\[([^\]]+)\]/);
  const hostname = bracketed
    ? bracketed[1]
    : (host.match(/:/g) || []).length > 1
      ? host
      : host.replace(/:\d+$/, "");
  if (/^localhost$/i.test(hostname)) return true;
  if (hostname.includes(":")) return isLoopbackIPv6(hostname);
  const v4 = parseIPv4(hostname);
  return v4 != null && isLoopbackIPv4Value(v4);
}

function toolsLine({ noServerLine = false } = {}) {
  const server = u.serverBase();
  const showServer = server && !noServerLine && !isLocalServer(u.serverHost());
  const mcp = showServer ? ` It is reachable over MCP at ${server}/mcp (bearer token).` : "";
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
async function writeAgentsBlock({ cwd, briefing = true, noServerLine = false }) {
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
          const host = u.serverHost();
          // Same loopback guard as toolsLine(): the briefing heading is also
          // part of the COMMITTED block, so a machine-local host must not
          // ride along here either (issue-spor-agents-md-local-mcp-leak).
          meta = isLocalServer(host) ? `brief-${slug} v${version}` : `brief-${slug} v${version} @ ${host}`;
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

${toolsLine({ noServerLine })}

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

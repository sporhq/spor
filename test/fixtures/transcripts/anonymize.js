#!/usr/bin/env node
// Turn a real `~/.claude/projects/<project>/<session>.jsonl` transcript tail into
// a fixture safe to check into this PUBLIC repo: every field the classifier does
// not read is scrubbed or dropped, and every field it does read (type, subtype,
// timestamp, message.content SHAPE, version) is kept verbatim — that shape is
// the whole point of a real fixture (see README.md in this directory).
//
// Usage: node anonymize.js <source.jsonl> [lineCount] > fixture.jsonl
// lineCount defaults to 40 (the tail; a full session is irrelevant — only the
// end says how the run finished).
"use strict";
const fs = require("fs");

const PLACEHOLDER_SESSION_ID = "00000000-0000-0000-0000-000000000000";
const PLACEHOLDER_CWD = "/workspace/demo-repo";
const PLACEHOLDER_BRANCH = "demo-branch";

function scrubContentBlock(block) {
  if (!block || typeof block !== "object") return { type: typeof block };
  switch (block.type) {
    case "tool_use":
      return { type: "tool_use", name: "redacted_tool" };
    case "tool_result":
      return { type: "tool_result", is_error: !!block.is_error };
    case "text":
      return { type: "text" };
    case "thinking":
      return { type: "thinking" };
    default:
      return { type: block.type || "unknown" };
  }
}

// Only ever called with a parsed JSON object (main() filters bare scalars).
function scrubRecord(rec) {
  const out = { type: rec.type };
  if (rec.subtype) out.subtype = rec.subtype;
  if (rec.timestamp) out.timestamp = rec.timestamp;
  if (rec.version) out.version = rec.version;
  if (typeof rec.durationMs === "number") out.durationMs = rec.durationMs;
  if (typeof rec.messageCount === "number") out.messageCount = rec.messageCount;
  if (typeof rec.hookCount === "number") out.hookCount = rec.hookCount;
  if (rec.sessionId) out.sessionId = PLACEHOLDER_SESSION_ID;
  if (rec.cwd) out.cwd = PLACEHOLDER_CWD;
  if (rec.gitBranch) out.gitBranch = PLACEHOLDER_BRANCH;

  if (rec.message && typeof rec.message === "object") {
    const content = rec.message.content;
    out.message = {
      role: rec.message.role,
      content: Array.isArray(content)
        ? content.map(scrubContentBlock)
        : "[redacted]",
    };
  }

  // Bookkeeping records that carry a single freeform label — keep the record
  // recognizable without keeping the actual text.
  if (rec.type === "custom-title" || rec.type === "ai-title") out.title = "[redacted]";
  if (rec.type === "agent-name") out.name = "[redacted]";
  if (rec.type === "last-prompt") out.lastPrompt = "[redacted]";
  if (rec.type === "mode" && rec.mode) out.mode = rec.mode;
  if (rec.type === "permission-mode" && rec.permissionMode) out.permissionMode = rec.permissionMode;
  if (rec.type === "queue-operation" && rec.operation) out.operation = rec.operation;
  if (rec.type === "pr-link") out.url = "https://example.invalid/pr/1";
  if (rec.type === "system" && rec.subtype === "local_command") out.content = "[redacted]";

  return out;
}

function main() {
  const [, , src, countArg] = process.argv;
  if (!src) {
    console.error("usage: node anonymize.js <source.jsonl> [lineCount]");
    process.exit(1);
  }
  const count = countArg ? Number(countArg) : 40;
  const lines = fs.readFileSync(src, "utf8").split("\n").filter((l) => l.trim());
  const tail = lines.slice(-count);
  for (const line of tail) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // an unparseable line carries nothing a real fixture needs
    }
    if (!rec || typeof rec !== "object") continue; // a bare scalar has no type to classify and nothing worth publishing
    process.stdout.write(JSON.stringify(scrubRecord(rec)) + "\n");
  }
}

main();

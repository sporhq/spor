"use strict";
// What the UserPromptSubmit digest retrieves for a prompt
// (issue-spor-digest-query-anchoring-dispatch-notification-bare-id): a bare
// node id is a root walk, an orchestrator dispatch prompt queries on its
// `## Your item` title + id instead of the template, and a harness
// `<task-notification>` turn retrieves nothing. Unit-level over digestRequest,
// then end-to-end through the hook against a stub /v1/digest that records the
// body it was sent.
require("./helpers/tmp-cleanup"); // scratch-home leak guard (issue-spor-test-mkdtemp-inode-exhaustion)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawnHook, runHook } = require("./helpers/portable");
const { digestRequest, stripTaskNotifications } = require("../scripts/engines/prompt-context.js");

const DISPATCH = [
  "You are a delegated implementation agent. You own ONE Spor queue item and your",
  "job is to carry it all the way to \"resolved on the graph\", autonomously.",
  "",
  "## Your item",
  "",
  "**Client IP trusts the Fly header unconditionally** — `issue-spor-client-ip-trusts-fly-header`",
  "",
  "Run a long full suite detached to a log and poll it in the foreground until EXIT= appears.",
].join("\n");

test("digestRequest: a bare node id is a root walk, below the word floor or not", () => {
  assert.deepEqual(digestRequest("art-spor-download-inspector-block-2026-10-11", "spor"),
    { root: "art-spor-download-inspector-block-2026-10-11", project: "spor" });
  assert.deepEqual(digestRequest("`task-foo-bar`.", null), { root: "task-foo-bar" });
  // An id inside a sentence is still a free-text query.
  assert.deepEqual(digestRequest("please look at task-foo-bar and tell me what blocks it", null),
    { query: "please look at task-foo-bar and tell me what blocks it" });
});

test("digestRequest: a dispatch prompt queries on its item, not the template", () => {
  assert.deepEqual(digestRequest(DISPATCH, "spor-server"), {
    query: "Client IP trusts the Fly header unconditionally issue-spor-client-ip-trusts-fly-header",
    project: "spor-server",
  });
  // The codex template drops the bold and backticks.
  const codex = "Intro line for the codex agent prompt here.\n\n## Your item\nFix the thing — task-spor-codex-thing\nWorktree (work ONLY here): /x";
  assert.deepEqual(digestRequest(codex, null), { query: "Fix the thing task-spor-codex-thing" });
});

test("digestRequest: the trivial-prompt gates still skip", () => {
  assert.equal(digestRequest("continue", null), null);
  assert.equal(digestRequest("/spor:next", null), null);
  assert.equal(digestRequest("commit it", null), null);
  assert.deepEqual(digestRequest("why does the digest fire on dispatch prompts so often", null),
    { query: "why does the digest fire on dispatch prompts so often" });
});

test("stripTaskNotifications drops notification blocks and keeps typed text", () => {
  const note = "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command finished</summary>\n</task-notification>";
  assert.equal(stripTaskNotifications(note), "");
  assert.equal(stripTaskNotifications(`${note}\nnow merge the branch into main and push it`),
    "now merge the branch into main and push it");
});

function recordingServer() {
  const bodies = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.method === "POST" && req.url === "/v1/digest") {
        bodies.push(JSON.parse(body));
        res.end(JSON.stringify({
          found: true,
          text: "- **issue-spor-client-ip-trusts-fly-header — Client IP trusts the Fly header** (issue, spor, 2026-10-10): The front door trusts Fly-Client-IP.",
        }));
      } else {
        res.end(JSON.stringify({ found: false }));
      }
    });
  });
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () => resolve({ srv, bodies, base: `http://127.0.0.1:${srv.address().port}` }))
  );
}

function env(home, extra = {}) {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/^(SPOR_|SUBSTRATE_)/.test(k)) delete e[k];
  delete e.GEMINI_API_KEY;
  delete e.ANTHROPIC_API_KEY;
  return { ...e, SPOR_HOME: home, SPOR_ENABLED: "1", ...extra };
}

async function remoteHook(prompt) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spor-digest-request-"));
  const home = path.join(root, "graph");
  const cwd = path.join(root, "projx");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cwd);
  const { srv, bodies, base } = await recordingServer();
  try {
    const payload = { cwd, session_id: "s1", hook_event_name: "UserPromptSubmit", prompt };
    const stdout = await new Promise((resolve, reject) => {
      const c = spawnHook(["prompt-context", "--host", "claude-code"], JSON.stringify(payload),
        env(home, { SPOR_SERVER: base, SPOR_TOKEN: "spor_pat_test" }), { stdio: ["pipe", "pipe", "ignore"] });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.on("error", reject);
      c.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
    });
    return { stdout, bodies };
  } finally {
    srv.close();
  }
}

test("hook, remote: a dispatch prompt posts the anchored query", async () => {
  const { stdout, bodies } = await remoteHook(DISPATCH);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].query, "Client IP trusts the Fly header unconditionally issue-spor-client-ip-trusts-fly-header");
  assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /issue-spor-client-ip-trusts-fly-header/);
});

test("hook, remote: a bare node id posts a root digest", async () => {
  const { stdout, bodies } = await remoteHook("issue-spor-client-ip-trusts-fly-header");
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].root, "issue-spor-client-ip-trusts-fly-header");
  assert.equal(bodies[0].query, undefined);
  assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /issue-spor-client-ip-trusts-fly-header/);
});

test("hook, remote: a task-notification turn makes no digest call", async () => {
  const note = "<task-notification>\n<task-id>b7</task-id>\n<output-file>/tmp/x.output</output-file>\n<status>completed</status>\n<summary>Background command \"Run full test suite detached\" completed (exit code 0)</summary>\n</task-notification>";
  const { stdout, bodies } = await remoteHook(note);
  assert.equal(bodies.length, 0);
  assert.equal(stdout.trim(), "");
});

// A root digest is the node's neighborhood (the root itself is the briefing's
// subject, not a listed line) — same shape as the server's root walk.
test("hook, local: a bare node id compiles that node's root neighborhood", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spor-digest-request-local-"));
  const home = path.join(root, "graph");
  const cwd = path.join(root, "projx");
  fs.mkdirSync(path.join(home, "nodes"), { recursive: true });
  fs.mkdirSync(cwd);
  const node = (id, title, summary, edges = "") => `---
id: ${id}
type: task
project: projx
title: ${title}
summary: ${summary}
date: 2026-10-10
${edges}---

${summary}
`;
  fs.writeFileSync(path.join(home, "nodes", "task-root-thing.md"),
    node("task-root-thing", "Root thing", "The root task the prompt names by id.",
      "edges:\n  - {type: relates-to, to: task-neighbor-thing}\n"));
  fs.writeFileSync(path.join(home, "nodes", "task-neighbor-thing.md"),
    node("task-neighbor-thing", "Neighbor thing", "A neighbor reached only through the root's edge."));
  fs.writeFileSync(path.join(home, "nodes", "task-unrelated.md"),
    node("task-unrelated", "Unrelated", "Billing webhook retries with exponential backoff."));
  const payload = { cwd, session_id: "s1", hook_event_name: "UserPromptSubmit", prompt: "task-root-thing" };
  const r = runHook(["prompt-context", "--host", "claude-code"], JSON.stringify(payload), env(home));
  assert.equal(r.status, 0, r.stderr);
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /task-neighbor-thing/);
  assert.doesNotMatch(ctx, /task-unrelated/);
});

// The anchor is coupled to the orchestrator's dispatch templates: a template
// whose `## Your item` line drifts off the DISPATCH_ITEM shape would silently
// fall back to querying on the whole template.
test("digestRequest: every orchestrator dispatch template's item line anchors", () => {
  const dir = path.join(__dirname, "..", ".claude", "skills", "spor-orchestrator", "assets");
  const files = fs.readdirSync(dir).filter((f) => /-prompt.*\.md$/.test(f));
  assert.ok(files.length > 0);
  for (const f of files) {
    const tpl = fs.readFileSync(path.join(dir, f), "utf8");
    if (!/^## Your item/m.test(tpl)) continue;
    const filled = tpl.replace(/\{\{title\}\}/g, "Some item title here").replace(/\{\{node\}\}/g, "task-some-item")
      .replace(/\{\{[a-z_]+\}\}/g, "x");
    const req = digestRequest(filled, null);
    assert.deepEqual(req, { query: "Some item title here task-some-item" }, f);
  }
});

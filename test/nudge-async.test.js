// Async capture classifier (task-cc-async-classifier-pending-result-injection):
// SPOR_NUDGE_ASYNC=1 runs the classifier OFF the tool loop in a detached
// worker. PostToolUse returns immediately with no injection and reserves the
// file (phase-1 cooldown); the worker drops a pending-result file (phase-2);
// the NEXT UserPromptSubmit drains it and injects a merged capture nudge with
// NO LLM call. Classifier stubbed via SUBSTRATE_NUDGE_CMD, everything against a
// throwaway SUBSTRATE_HOME in local mode.
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runHook, spawnHook, writeNodeScript, nodeCommand } = require("./helpers/portable");

const PROSE = Array.from({ length: 8 }, (_, i) =>
  `Finding ${i}: the retry path in server X was dismissed because the upstream ` +
  `proxy already retries idempotent calls twice, so a client retry tripled load.`
).join("\n");

const FACT_RESPONSE =
  "===FACT===\nThe retry-path approach was dismissed because the proxy already retries idempotent calls.\n===END===\n";

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spor-nudge-async-"));
  const home = path.join(root, "graph");
  fs.mkdirSync(path.join(home, "nodes"), { recursive: true });
  const cwd = path.join(root, "projx");
  fs.mkdirSync(cwd);
  return { root, home, cwd };
}

function backend(root, name, body) {
  return nodeCommand(writeNodeScript(path.join(root, name), body));
}

function factStub(root) {
  return backend(root, "fact-backend.js", `
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write(${JSON.stringify(FACT_RESPONSE)}));
`);
}

function nothingStub(root) {
  return backend(root, "nothing-backend.js", `
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write("NOTHING\\n"));
`);
}

function env(home, stub, extra = {}) {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/^(SPOR_|SUBSTRATE_)/.test(k)) delete e[k];
  delete e.GEMINI_API_KEY;
  delete e.ANTHROPIC_API_KEY;
  e.SUBSTRATE_HOME = home;
  e.SPOR_ENABLED = "1";
  e.SPOR_NUDGE_ASYNC = "1";
  if (stub) e.SUBSTRATE_NUDGE_CMD = stub;
  return { ...e, ...extra };
}

function postTool(home, cwd, stub, { file, content, session = "s1", tool = "Write", extraEnv = {} } = {}) {
  const payload = {
    cwd,
    session_id: session,
    hook_event_name: "PostToolUse",
    tool_name: tool,
    tool_input: tool === "Edit" ? { file_path: file, new_string: content } : { file_path: file, content },
  };
  const r = runHook(["post-tool", "--host", "claude-code"], JSON.stringify(payload), env(home, stub, extraEnv));
  assert.strictEqual(r.status, 0, `exit 0 expected: ${r.stderr}`);
  return r.stdout;
}

function promptContext(home, cwd, { prompt = "ok", session = "s1", stub = null, extraEnv = {} } = {}) {
  const payload = { cwd, session_id: session, hook_event_name: "UserPromptSubmit", prompt };
  const r = runHook(["prompt-context", "--host", "claude-code"], JSON.stringify(payload), env(home, stub, extraEnv));
  assert.strictEqual(r.status, 0, `exit 0 expected: ${r.stderr}`);
  return r.stdout;
}

function spoolDir(home, session = "s1") {
  return path.join(home, "journal", "pending-nudges", session);
}

function nudgedLines(home, session = "s1") {
  const p = path.join(home, "journal", `${session}.nudged`);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
}

function llmCalls(home) {
  const dir = path.join(home, "journal", "llm-calls");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap((f) =>
    fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
  );
}

function journal(home, session = "s1") {
  const p = path.join(home, "journal", `${session}.jsonl`);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll until `pred()` is true or the deadline passes (the detached worker
// finishes out of band with the post-tool call that spawned it).
async function waitFor(pred, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(50);
  }
  return false;
}

function outFiles(home, session = "s1") {
  try {
    return fs.readdirSync(spoolDir(home, session)).filter((f) => f.endsWith(".out.json"));
  } catch {
    return [];
  }
}

// Drop a completed classifier result straight into the spool, as the worker
// would — lets the drain-side caps be tested deterministically without racing
// detached workers.
function seedOut(home, session, name, file, facts = "1. seeded finding", nfacts = 1) {
  const dir = spoolDir(home, session);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.out.json`), JSON.stringify({ file, facts, nfacts, ts: "2026-01-01T00:00:00Z" }));
}

test("async: post-tool returns immediately, worker drops a result, next prompt injects it", async () => {
  const { root, home, cwd } = scratch();
  const file = path.join(cwd, "reports", "findings.md");
  const out = postTool(home, cwd, factStub(root), { file, content: PROSE });
  // One-turn-delayed: nothing injected in the tool loop.
  assert.strictEqual(out.trim(), "");
  // Phase-1 cooldown: the file is reserved with the `pending` sentinel.
  assert.deepStrictEqual(nudgedLines(home), [`pending\t${file}`]);
  // A spawn was journaled.
  assert.strictEqual(journal(home).filter((e) => e.tool === "nudge-async-spawn").length, 1);

  // Phase-2: the detached worker classifies and drops a result file. On
  // failure, surface the recorded llm call (its error field distinguishes a
  // dead backend from a slow worker — issue-spor-windows-ci-async-nudge-flake).
  assert.ok(
    await waitFor(() => outFiles(home).length === 1),
    `worker never wrote a result; llm-calls: ${JSON.stringify(llmCalls(home))}`
  );
  // The classifier call was recorded to llm-calls by the worker.
  const calls = llmCalls(home);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].source, "nudge");
  assert.strictEqual(calls[0].vars.FILE, file);

  // Next UserPromptSubmit drains it — NO LLM, injects the merged nudge.
  const ctx = promptContext(home, cwd, { prompt: "ok" });
  const json = JSON.parse(ctx);
  assert.strictEqual(json.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  const text = json.hookSpecificOutput.additionalContext;
  assert.match(text, /capture nudge/);
  assert.match(text, /The retry-path approach was dismissed/);
  assert.match(text, /findings\.md/);
  // No new classifier call on the prompt path.
  assert.strictEqual(llmCalls(home).length, 1);
  // Result consumed; fired nudge journaled with async marker.
  assert.strictEqual(outFiles(home).length, 0);
  const fired = journal(home).filter((e) => e.tool === "nudge" && e.async);
  assert.strictEqual(fired.length, 1);
  assert.strictEqual(fired[0].file, file);
  // Injected-count recorded for the fired cap.
  assert.ok(fs.existsSync(path.join(home, "journal", "s1.nudged-injected")));

  // A second prompt injects nothing (already drained).
  assert.strictEqual(promptContext(home, cwd, { prompt: "carry on with the plan" }).trim(), "");
});

test("async NOTHING verdict: worker drops no result, prompt injects nothing, file stays reserved", async () => {
  // A transiently failed backend spawn on a slow runner (windows-latest:
  // Defender locks on the freshly-written stub, spawn transients) is recorded
  // by the worker as error + response:null — the same no-result outcome as a
  // real NOTHING verdict, but no evidence about the NOTHING path. Retry such
  // environmental misses in a FRESH scratch (the failed attempt's file stays
  // reserved, by design) and assert strictly on the run where the stub
  // actually executed (issue-spor-windows-ci-async-nudge-flake).
  let root, home, cwd, file, call;
  for (let attempt = 0; ; attempt++) {
    ({ root, home, cwd } = scratch());
    file = path.join(cwd, "notes.md");
    postTool(home, cwd, nothingStub(root), { file, content: PROSE });
    // Wait for the worker to record its (NOTHING) llm call.
    assert.ok(await waitFor(() => llmCalls(home).length === 1), "worker never ran");
    call = llmCalls(home)[0];
    if (call.error == null || attempt >= 2) break;
  }
  assert.strictEqual(call.error, null, `backend never executed: ${JSON.stringify(call)}`);
  assert.match(call.response, /NOTHING/);
  assert.strictEqual(outFiles(home).length, 0);
  // Still reserved so a re-edit doesn't reclassify.
  assert.deepStrictEqual(nudgedLines(home), [`pending\t${file}`]);
  assert.strictEqual(promptContext(home, cwd, { prompt: "ok" }).trim(), "");
});

test("async merges multiple pending results into one injection", async () => {
  const { root, home, cwd } = scratch();
  const files = [0, 1].map((i) => path.join(cwd, `doc${i}.md`));
  for (const f of files) postTool(home, cwd, factStub(root), { file: f, content: PROSE });
  assert.ok(
    await waitFor(() => outFiles(home).length === 2),
    `both workers should finish; llm-calls: ${JSON.stringify(llmCalls(home))}`
  );
  const text = JSON.parse(promptContext(home, cwd, { prompt: "ok" })).hookSpecificOutput.additionalContext;
  // One envelope naming both files.
  assert.match(text, /doc0\.md/);
  assert.match(text, /doc1\.md/);
  assert.strictEqual((text.match(/capture nudge/g) || []).length, 1);
  assert.strictEqual(outFiles(home).length, 0);
});

test("async re-edit of the same file does not spawn a second classifier", async () => {
  const { root, home, cwd } = scratch();
  const file = path.join(cwd, "doc.md");
  postTool(home, cwd, factStub(root), { file, content: PROSE });
  assert.ok(await waitFor(() => outFiles(home).length === 1));
  // Second write of the same path: reserved already, no new spawn.
  postTool(home, cwd, factStub(root), { file, content: PROSE });
  await sleep(400);
  assert.strictEqual(llmCalls(home).length, 1, "the second edit must not re-classify");
  assert.strictEqual(nudgedLines(home).length, 1);
});

test("drain fired cap: at most 3 nudges inject per session; extras are consumed and dropped", () => {
  const { home, cwd } = scratch();
  // Four completed results waiting; drain injects the first 3 (sorted) and
  // consumes all four so the 4th can't re-inject next prompt.
  for (let i = 0; i < 4; i++) seedOut(home, "s1", `r${i}`, path.join(cwd, `f${i}.md`), `1. finding ${i}`);
  const text = JSON.parse(promptContext(home, cwd, { prompt: "ok" })).hookSpecificOutput.additionalContext;
  const named = [0, 1, 2, 3].filter((i) => text.includes(`f${i}.md`));
  assert.strictEqual(named.length, 3, "exactly 3 files injected");
  assert.strictEqual(outFiles(home).length, 0, "every result consumed (4th dropped)");
  assert.strictEqual(journal(home).filter((e) => e.tool === "nudge" && e.async).length, 3);
});

test("async spawn is suppressed once 3 nudges have already injected this session", async () => {
  const { root, home, cwd } = scratch();
  // Seed the injected-count at the cap.
  fs.mkdirSync(path.join(home, "journal"), { recursive: true });
  fs.writeFileSync(path.join(home, "journal", "s1.nudged-injected"), "a.md\nb.md\nc.md\n");
  postTool(home, cwd, factStub(root), { file: path.join(cwd, "new.md"), content: PROSE });
  await sleep(400);
  // No spawn, no reservation, no classifier call.
  assert.strictEqual(nudgedLines(home).length, 0);
  assert.strictEqual(llmCalls(home).length, 0);
  assert.strictEqual(journal(home).filter((e) => e.tool === "nudge-async-spawn").length, 0);
});

test("async spawn is suppressed once 3 results already wait in the spool (pre-drain)", async () => {
  const { root, home, cwd } = scratch();
  // Three finished-but-undrained results already cap the fired proxy, so a new
  // edit doesn't pay for a 4th classifier before the next prompt drains them.
  for (let i = 0; i < 3; i++) seedOut(home, "s1", `w${i}`, path.join(cwd, `w${i}.md`));
  postTool(home, cwd, factStub(root), { file: path.join(cwd, "new.md"), content: PROSE });
  await sleep(400);
  assert.strictEqual(nudgedLines(home).length, 0, "no reservation");
  assert.strictEqual(llmCalls(home).length, 0, "no classifier spawned");
});

test("session_id absent: writer and drainer agree on the 'unknown' spool key", async () => {
  const { root, home, cwd } = scratch();
  // A payload with no session_id — post-tool keys the spool on "unknown"; the
  // drain must resolve the same key or the nudge is silently lost.
  const write = { cwd, hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: path.join(cwd, "d.md"), content: PROSE } };
  const r = runHook(["post-tool", "--host", "claude-code"], JSON.stringify(write), env(home, factStub(root)));
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), "");
  assert.ok(await waitFor(() => outFiles(home, "unknown").length === 1), "worker should spool under 'unknown'");
  const prompt = { cwd, hook_event_name: "UserPromptSubmit", prompt: "ok" };
  const out = runHook(["prompt-context", "--host", "claude-code"], JSON.stringify(prompt), env(home, factStub(root)));
  assert.match(JSON.parse(out.stdout).hookSpecificOutput.additionalContext, /capture nudge/);
});

test("SPOR_NUDGE=0 suppresses the drain even with results waiting", () => {
  const { home, cwd } = scratch();
  seedOut(home, "s1", "r0", path.join(cwd, "f.md"));
  const out = promptContext(home, cwd, { prompt: "ok", extraEnv: { SPOR_NUDGE: "0" } });
  assert.strictEqual(out.trim(), "", "a disabled nudge must not inject a pending result");
  // Not drained/consumed while disabled — it stays for when the nudge is on.
  assert.strictEqual(outFiles(home).length, 1);
});

test("pending nudge injects even when the digest gate would suppress (trivial prompt)", async () => {
  const { root, home, cwd } = scratch();
  postTool(home, cwd, factStub(root), { file: path.join(cwd, "x.md"), content: PROSE });
  assert.ok(await waitFor(() => outFiles(home).length === 1));
  // "ok" is a continuation prompt — the digest half returns nothing, but the
  // pending nudge still injects.
  const text = JSON.parse(promptContext(home, cwd, { prompt: "ok" })).hookSpecificOutput.additionalContext;
  assert.match(text, /capture nudge/);
});

// issue-spor-async-nudge-session-final-loss: the SessionEnd half. A finding
// classified as the session's LAST action has no next UserPromptSubmit to run
// drainPendingNudges, so it would otherwise sit stranded in the spool forever.
// SessionEnd (bin/spor-hook distill) must drain it and write it through the
// capture path directly, with no further LLM call.

function sessionEndPayload(cwd, session = "s1") {
  return JSON.stringify({ cwd, session_id: session, hook_event_name: "SessionEnd" });
}

function nodeFiles(home) {
  try {
    return fs.readdirSync(path.join(home, "nodes")).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
}

// async spawn — spawnSync would block the event loop and starve an in-process
// stub server while the hook's curl waits on it (same rationale as the other
// suites' runAsync helpers).
function runAsync(args, input, env) {
  return new Promise((resolve, reject) => {
    const c = spawnHook(args, input, env, { stdio: ["pipe", "ignore", "ignore"] });
    c.on("error", reject);
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });
}

function stubCaptureServer(status = 200) {
  const http = require("node:http");
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, body });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(status === 200 ? { status: "ok", ids: ["task-stub"] } : { error: "invalid_capture" }));
    });
  });
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` }))
  );
}

test("SessionEnd: a session-final async nudge finding lands durably with no subsequent prompt (local mode)", async () => {
  const { root, home, cwd } = scratch();
  const file = path.join(cwd, "reports", "findings.md");
  postTool(home, cwd, factStub(root), { file, content: PROSE });
  assert.ok(await waitFor(() => outFiles(home).length === 1), "worker never wrote a result");

  // No subsequent UserPromptSubmit — go straight to SessionEnd. Disable the
  // LLM distiller (SPOR_DISTILL=0) so this exercises the nudge-drain branch in
  // isolation, exactly like session-lease.test.js isolates sessionEndLease.
  const out = runHook(["distill", "--host", "claude-code"], sessionEndPayload(cwd), env(home, null, { SPOR_DISTILL: "0" }));
  assert.strictEqual(out.status, 0, out.stderr);

  // Consumed from the spool...
  assert.strictEqual(outFiles(home).length, 0, "the stranded result is drained at session end");
  // ...and written through the capture path as a durable node.
  const written = nodeFiles(home);
  assert.strictEqual(written.length, 1, `expected exactly one captured node; found: ${JSON.stringify(written)}`);
  const md = fs.readFileSync(path.join(home, "nodes", written[0]), "utf8");
  assert.match(md, /^id: task-nudge-sessionend-/m);
  assert.match(md, /authored_via: capture/);
  assert.match(md, /The retry-path approach was dismissed/);
  assert.match(md, /findings\.md/);
});

test("SessionEnd: a finding already recorded in <session>.nudged-injected is not double-captured", async () => {
  const { home, cwd } = scratch();
  const file = path.join(cwd, "doc.md");
  seedOut(home, "s1", "r0", file, "1. a finding already injected in-session");
  fs.mkdirSync(path.join(home, "journal"), { recursive: true });
  fs.writeFileSync(path.join(home, "journal", "s1.nudged-injected"), `${file}\n`);

  const out = runHook(["distill", "--host", "claude-code"], sessionEndPayload(cwd), env(home, null, { SPOR_DISTILL: "0" }));
  assert.strictEqual(out.status, 0, out.stderr);

  // Consumed (never left to linger)...
  assert.strictEqual(outFiles(home).length, 0);
  // ...but NOT captured a second time.
  assert.strictEqual(nodeFiles(home).length, 0);
});

test("SessionEnd: SPOR_NUDGE=0 suppresses the drain exactly like the prompt-time one", () => {
  const { home, cwd } = scratch();
  const file = path.join(cwd, "doc.md");
  seedOut(home, "s1", "r0", file);

  const out = runHook(
    ["distill", "--host", "claude-code"],
    sessionEndPayload(cwd),
    env(home, null, { SPOR_DISTILL: "0", SPOR_NUDGE: "0" })
  );
  assert.strictEqual(out.status, 0, out.stderr);
  assert.strictEqual(outFiles(home).length, 1, "a disabled nudge must not drain a pending result at session end either");
  assert.strictEqual(nodeFiles(home).length, 0);
});

test("SessionEnd: nudge.async off leaves the spool untouched (byte-identical default path)", () => {
  const { home, cwd } = scratch();
  const file = path.join(cwd, "doc.md");
  seedOut(home, "s1", "r0", file);

  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/^(SPOR_|SUBSTRATE_)/.test(k)) delete e[k];
  delete e.GEMINI_API_KEY;
  delete e.ANTHROPIC_API_KEY;
  e.SUBSTRATE_HOME = home;
  e.SPOR_ENABLED = "1";
  e.SPOR_DISTILL = "0"; // nudge.async deliberately NOT set

  const out = runHook(["distill", "--host", "claude-code"], sessionEndPayload(cwd), e);
  assert.strictEqual(out.status, 0, out.stderr);
  assert.strictEqual(outFiles(home).length, 1, "the spool is untouched when nudge.async is unset");
  assert.strictEqual(nodeFiles(home).length, 0);
});

test("SessionEnd: SPOR_DISTILLING recursion guard still short-circuits the nudge drain", () => {
  const { home, cwd } = scratch();
  const file = path.join(cwd, "doc.md");
  seedOut(home, "s1", "r0", file);

  const out = runHook(
    ["distill", "--host", "claude-code"],
    sessionEndPayload(cwd),
    env(home, null, { SPOR_DISTILL: "0", SPOR_DISTILLING: "1" })
  );
  assert.strictEqual(out.status, 0, out.stderr);
  assert.strictEqual(outFiles(home).length, 1, "the recursion guard skips the drain too — nothing consumed");
  assert.strictEqual(nodeFiles(home).length, 0);
});

test("SessionEnd (remote): posts an undrained finding to /v1/capture", async () => {
  const { home, cwd } = scratch();
  fs.rmSync(path.join(home, "nodes"), { recursive: true }); // pure remote, same gate as distill's own remote tests
  const file = path.join(cwd, "notes.md");
  seedOut(home, "s1", "r0", file, "1. a session-final finding");

  const { srv, hits, base } = await stubCaptureServer();
  try {
    const e = env(home, null, {
      SPOR_SERVER: base,
      SPOR_TOKEN: "spor_pat_test",
      SPOR_DISTILL: "0",
      SPOR_SESSION_LEASE: "0",
    });
    await runAsync(["distill", "--host", "claude-code"], sessionEndPayload(cwd), e);
    const cap = hits.find((h) => h.url === "/v1/capture");
    assert.ok(cap, `expected a /v1/capture POST; hits: ${JSON.stringify(hits.map((h) => h.method + " " + h.url))}`);
    const sent = JSON.parse(cap.body);
    assert.strictEqual(sent.source, "nudge-sessionend");
    assert.strictEqual(sent.context.project_explicit, false);
    assert.match(sent.text, /a session-final finding/);
    assert.match(sent.text, /notes\.md/);
    assert.match(sent.idempotency_key, /^[0-9a-f]{64}$/);
  } finally {
    srv.close();
  }
});

test("SessionEnd (remote): a transport failure spools the finding to the outbox", async () => {
  const { home, cwd } = scratch();
  fs.rmSync(path.join(home, "nodes"), { recursive: true });
  const file = path.join(cwd, "notes.md");
  seedOut(home, "s1", "r0", file, "1. a session-final finding");

  const e = env(home, null, {
    SPOR_SERVER: "http://127.0.0.1:1", // nothing listening -> transport failure
    SPOR_TOKEN: "spor_pat_test",
    SPOR_DISTILL: "0",
    SPOR_SESSION_LEASE: "0",
  });
  await runAsync(["distill", "--host", "claude-code"], sessionEndPayload(cwd), e);
  const outbox = fs.existsSync(path.join(home, "outbox")) ? fs.readdirSync(path.join(home, "outbox")) : [];
  assert.strictEqual(outbox.length, 1, `expected one spooled capture; found: ${JSON.stringify(outbox)}`);
  const spooled = JSON.parse(fs.readFileSync(path.join(home, "outbox", outbox[0]), "utf8"));
  assert.strictEqual(spooled.source, "nudge-sessionend");
  assert.match(spooled.text, /a session-final finding/);
});

// issue-spor-session-end-pending-nudges-data-loss: this drain is a finding's
// LAST chance, so the spool file is consumed only once the finding is durably
// somewhere else — or is provably uncapturable. A transient failure must leave
// it where a later sweep can retry it, and that retry must not double-capture.

function distillLog(home) {
  const p = path.join(home, "journal", "distill.log");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

test("SessionEnd: a transient local failure keeps the finding in the spool instead of destroying it", () => {
  const { home, cwd } = scratch();
  fs.rmSync(path.join(home, "nodes"), { recursive: true }); // graph home not initialized yet
  const file = path.join(cwd, "doc.md");
  seedOut(home, "s1", "r0", file, "1. a finding worth keeping");

  const out = runHook(["distill", "--host", "claude-code"], sessionEndPayload(cwd), env(home, null, { SPOR_DISTILL: "0" }));
  assert.strictEqual(out.status, 0, out.stderr);
  assert.strictEqual(outFiles(home).length, 1, "an uncaptured finding must survive in the spool");
  assert.match(distillLog(home), /kept in the spool: no local graph/);

  // ...and the retry lands it, once the graph exists.
  fs.mkdirSync(path.join(home, "nodes"), { recursive: true });
  const again = runHook(["distill", "--host", "claude-code"], sessionEndPayload(cwd), env(home, null, { SPOR_DISTILL: "0" }));
  assert.strictEqual(again.status, 0, again.stderr);
  assert.strictEqual(outFiles(home).length, 0);
  assert.strictEqual(nodeFiles(home).length, 1);
});

test("SessionEnd: a re-drained finding resolves to the node it already wrote, never a second one", () => {
  const { home, cwd } = scratch();
  const file = path.join(cwd, "doc.md");
  seedOut(home, "s1", "r0", file, "1. a finding worth keeping");

  const first = runHook(["distill", "--host", "claude-code"], sessionEndPayload(cwd), env(home, null, { SPOR_DISTILL: "0" }));
  assert.strictEqual(first.status, 0, first.stderr);
  const written = nodeFiles(home);
  assert.strictEqual(written.length, 1);

  // The crash window the deferred consume opens: the node landed but the
  // spool file outlived it, so the next sweep re-drains the same finding.
  seedOut(home, "s1", "r0", file, "1. a finding worth keeping");
  const second = runHook(["distill", "--host", "claude-code"], sessionEndPayload(cwd), env(home, null, { SPOR_DISTILL: "0" }));
  assert.strictEqual(second.status, 0, second.stderr);
  assert.deepStrictEqual(nodeFiles(home), written, "a replay must not mint a second node");
  assert.strictEqual(outFiles(home).length, 0, "and it consumes the file, since the finding is already durable");
  assert.match(distillLog(home), /already written as task-nudge-sessionend-/);

  // A DIFFERENT finding out of the same file still gets its own node.
  seedOut(home, "s1", "r1", file, "1. a second, unrelated finding");
  const third = runHook(["distill", "--host", "claude-code"], sessionEndPayload(cwd), env(home, null, { SPOR_DISTILL: "0" }));
  assert.strictEqual(third.status, 0, third.stderr);
  assert.strictEqual(nodeFiles(home).length, 2);
});

test("SessionEnd: an unreadable result is still consumed (retention is bounded to retryable failures)", () => {
  const { home, cwd } = scratch();
  const dir = spoolDir(home, "s1");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "r0.out.json"), "{ not json");

  const out = runHook(["distill", "--host", "claude-code"], sessionEndPayload(cwd), env(home, null, { SPOR_DISTILL: "0" }));
  assert.strictEqual(out.status, 0, out.stderr);
  assert.strictEqual(outFiles(home).length, 0, "a result no sweep could ever capture must not linger");
  assert.strictEqual(nodeFiles(home).length, 0);
});

test("SessionEnd (remote): an unwritable outbox keeps the finding in the spool", async () => {
  const { home, cwd } = scratch();
  fs.rmSync(path.join(home, "nodes"), { recursive: true });
  const file = path.join(cwd, "notes.md");
  seedOut(home, "s1", "r0", file, "1. a session-final finding");
  fs.writeFileSync(path.join(home, "outbox"), "not a directory"); // ensureDir fails

  const e = env(home, null, {
    SPOR_SERVER: "http://127.0.0.1:1", // nothing listening -> transport failure
    SPOR_TOKEN: "spor_pat_test",
    SPOR_DISTILL: "0",
    SPOR_SESSION_LEASE: "0",
  });
  await runAsync(["distill", "--host", "claude-code"], sessionEndPayload(cwd), e);
  assert.strictEqual(outFiles(home).length, 1, "with nowhere durable to put it, the finding stays spooled");
});

test("SessionEnd (remote): a permanent rejection is dead-lettered, not discarded", async () => {
  const { home, cwd } = scratch();
  fs.rmSync(path.join(home, "nodes"), { recursive: true });
  const file = path.join(cwd, "notes.md");
  seedOut(home, "s1", "r0", file, "1. a session-final finding");

  const { srv, hits, base } = await stubCaptureServer(422);
  try {
    const e = env(home, null, {
      SPOR_SERVER: base,
      SPOR_TOKEN: "spor_pat_test",
      SPOR_DISTILL: "0",
      SPOR_SESSION_LEASE: "0",
    });
    await runAsync(["distill", "--host", "claude-code"], sessionEndPayload(cwd), e);
    assert.ok(hits.find((h) => h.url === "/v1/capture"), "expected the capture attempt");
    assert.strictEqual(outFiles(home).length, 0, "a rejected body reaches the same verdict on every retry");
    // API.md §5: a mechanical writer dead-letters a permanent reject rather
    // than dropping it — the payload stays inspectable and doctor/session-start
    // already count and surface outbox/dead/.
    const dead = fs.readdirSync(path.join(home, "outbox", "dead"));
    assert.strictEqual(dead.length, 1, "the rejected payload must be preserved for inspection");
    assert.match(dead[0], /\.capture\.json$/);
    assert.match(JSON.parse(fs.readFileSync(path.join(home, "outbox", "dead", dead[0]), "utf8")).text, /session-final finding/);
    const spooled = fs.readdirSync(path.join(home, "outbox")).filter((f) => f.endsWith(".capture.json"));
    assert.strictEqual(spooled.length, 0, "a rejection is not a transport failure — nothing is queued for replay");
  } finally {
    srv.close();
  }
});

test("SessionEnd (remote): an unwritable dead-letter dir keeps the rejected finding in the spool", async () => {
  const { home, cwd } = scratch();
  fs.rmSync(path.join(home, "nodes"), { recursive: true });
  const file = path.join(cwd, "notes.md");
  seedOut(home, "s1", "r0", file, "1. a session-final finding");
  fs.mkdirSync(path.join(home, "outbox"), { recursive: true });
  fs.writeFileSync(path.join(home, "outbox", "dead"), "not a directory"); // ensureDir fails

  const { srv, base } = await stubCaptureServer(400);
  try {
    const e = env(home, null, {
      SPOR_SERVER: base,
      SPOR_TOKEN: "spor_pat_test",
      SPOR_DISTILL: "0",
      SPOR_SESSION_LEASE: "0",
    });
    await runAsync(["distill", "--host", "claude-code"], sessionEndPayload(cwd), e);
    assert.strictEqual(outFiles(home).length, 1, "with nowhere to preserve it, the finding stays spooled");
  } finally {
    srv.close();
  }
});

test("SessionEnd: a read failure is not a malformed result — the finding survives", () => {
  const { home, cwd } = scratch();
  const dir = spoolDir(home, "s1");
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, "r0.out.json");
  fs.writeFileSync(fp, JSON.stringify({ file: path.join(cwd, "doc.md"), facts: "1. a finding", nfacts: 1 }));
  fs.chmodSync(fp, 0o000); // EACCES on read — transient, not corrupt

  const out = runHook(["distill", "--host", "claude-code"], sessionEndPayload(cwd), env(home, null, { SPOR_DISTILL: "0" }));
  fs.chmodSync(fp, 0o600);
  assert.strictEqual(out.status, 0, out.stderr);
  assert.strictEqual(outFiles(home).length, 1, "an unreadable-right-now result must not be destroyed");
  assert.strictEqual(nodeFiles(home).length, 0);
  assert.match(distillLog(home), /kept in the spool: read failed/);

  // ...and it lands once the read succeeds again.
  const again = runHook(["distill", "--host", "claude-code"], sessionEndPayload(cwd), env(home, null, { SPOR_DISTILL: "0" }));
  assert.strictEqual(again.status, 0, again.stderr);
  assert.strictEqual(outFiles(home).length, 0);
  assert.strictEqual(nodeFiles(home).length, 1);
});

test("SessionEnd: an unrelated node squatting the capture id is reconciled, not mistaken for the capture", () => {
  const { home, cwd } = scratch();
  const file = path.join(cwd, "doc.md");
  seedOut(home, "s1", "r0", file, "1. a finding worth keeping");

  // Learn the id this finding would take, then hand it to a DIFFERENT node.
  const probe = runHook(["distill", "--host", "claude-code"], sessionEndPayload(cwd), env(home, null, { SPOR_DISTILL: "0" }));
  assert.strictEqual(probe.status, 0, probe.stderr);
  const taken = nodeFiles(home)[0];
  const mine = fs.readFileSync(path.join(home, "nodes", taken), "utf8");
  assert.match(mine, /^capture_key: [0-9a-f]{64}$/m, "the node carries the full capture key it is reconciled by");
  fs.writeFileSync(
    path.join(home, "nodes", taken),
    mine.replace(/^capture_key: .*$/m, "capture_key: 0000000000000000000000000000000000000000000000000000000000000000")
  );

  // Same finding again: the pathname is occupied by something that is NOT this
  // capture, so it must land under its own id rather than be dropped as done.
  seedOut(home, "s1", "r0", file, "1. a finding worth keeping");
  const out = runHook(["distill", "--host", "claude-code"], sessionEndPayload(cwd), env(home, null, { SPOR_DISTILL: "0" }));
  assert.strictEqual(out.status, 0, out.stderr);
  assert.strictEqual(outFiles(home).length, 0);
  assert.strictEqual(nodeFiles(home).length, 2, "an occupied id is not proof this finding was captured");
});

// ---------------------------------------------------------------------------
// The spool WORKER's own durable debt (util.runSpoolWorker). The `.in.json` is
// the job's only copy; clearing it before the classifier's verdict is durable
// somewhere else loses a classification the tool loop already paid for.

const WORKER = path.join(__dirname, "..", "scripts", "engines", "nudge-worker.js");

function seedIn(home, session, hash, file, extra = {}) {
  const dir = spoolDir(home, session);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `${hash}.in.json`);
  fs.writeFileSync(
    fp,
    JSON.stringify({
      prompt: "classify this",
      tplSha: "deadbeef",
      session,
      slug: "projx",
      file,
      graph: home,
      timeoutMs: 30000,
      hash,
      vars: { SLUG: "projx", FILE: file },
      ...extra,
    })
  );
  return fp;
}

function runWorker(inFile, e) {
  return require("node:child_process").spawnSync(process.execPath, [WORKER, inFile], {
    env: e,
    encoding: "utf8",
  });
}

test("worker: a durable result clears the input; a NOTHING verdict clears it too", () => {
  const { root, home, cwd } = scratch();
  const e = env(home, factStub(root));
  const fp = seedIn(home, "s1", "h1", path.join(cwd, "doc.md"), { nudgeCmd: e.SUBSTRATE_NUDGE_CMD });
  const r = runWorker(fp, e);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(fp), "the debt is settled once the result is durable");
  assert.deepStrictEqual(outFiles(home), ["h1.out.json"]);

  // A NOTHING verdict is SETTLED, not lost — re-running it would only spend
  // another backend call to reach the same answer.
  const e2 = env(home, nothingStub(root));
  const fp2 = seedIn(home, "s1", "h2", path.join(cwd, "other.md"), { nudgeCmd: e2.SUBSTRATE_NUDGE_CMD });
  const r2 = runWorker(fp2, e2);
  assert.strictEqual(r2.status, 0, r2.stderr);
  assert.ok(!fs.existsSync(fp2), "a definitive no-facts verdict owes nothing");
  assert.deepStrictEqual(outFiles(home), ["h1.out.json"]);
});

test("worker: a failed result write keeps the input as the debt instead of swallowing it", () => {
  const { root, home, cwd } = scratch();
  const e = env(home, factStub(root));
  const fp = seedIn(home, "s1", "h3", path.join(cwd, "doc.md"), { nudgeCmd: e.SUBSTRATE_NUDGE_CMD });
  // Block the result write (rename onto a directory) — the classifier-verified
  // finding never lands, so the job must stay owed.
  fs.mkdirSync(path.join(spoolDir(home, "s1"), "h3.out.json"));

  const r = runWorker(fp, e);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(fp), "an undelivered verdict must leave its input behind to re-run");
});

test("worker: a backend failure keeps the input owed rather than dropping the job", () => {
  const { root, home, cwd } = scratch();
  const e = env(home, backend(root, "dead-backend.js", `process.stdin.resume(); process.exit(7);`));
  const fp = seedIn(home, "s1", "h4", path.join(cwd, "doc.md"), { nudgeCmd: e.SUBSTRATE_NUDGE_CMD });
  const r = runWorker(fp, e);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(fp), "no verdict was reached, so nothing is settled");
  assert.strictEqual(outFiles(home).length, 0);
});

test("drain: a stale input is re-driven once, then pruned", async () => {
  const { root, home, cwd } = scratch();
  const e = env(home, factStub(root));
  const fp = seedIn(home, "s1", "h5", path.join(cwd, "doc.md"), { nudgeCmd: e.SUBSTRATE_NUDGE_CMD });
  const old = Date.now() / 1000 - 7200; // 2h — past the orphan horizon
  fs.utimesSync(fp, old, old);

  promptContext(home, cwd, { prompt: "six words minimum to pass gate", extraEnv: { SUBSTRATE_NUDGE_CMD: e.SUBSTRATE_NUDGE_CMD } });
  assert.ok(await waitFor(() => outFiles(home).length === 1), "the orphaned job was dropped instead of re-driven");
  assert.ok(!fs.existsSync(fp), "the re-driven worker settled and cleared its own input");

  // The bound: a job that already had its retry is pruned, never spun again.
  const dir = spoolDir(home, "s1");
  seedIn(home, "s1", "h6", path.join(cwd, "doc2.md"), { nudgeCmd: e.SUBSTRATE_NUDGE_CMD });
  const fp2 = path.join(dir, "h6.redriven.in.json");
  fs.renameSync(path.join(dir, "h6.in.json"), fp2);
  fs.utimesSync(fp2, old, old);
  promptContext(home, cwd, { prompt: "six words minimum to pass gate", session: "s1" });
  assert.ok(!fs.existsSync(fp2), "a job past its one retry must not linger");
  await sleep(300);
  assert.strictEqual(outFiles(home).filter((f) => f === "h6.out.json").length, 0, "and must not be classified again");
});

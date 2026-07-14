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
const { runHook, writeNodeScript, nodeCommand } = require("./helpers/portable");

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

// Async digest intent gate (dec-spor-digest-noise-needs-async-semantic-intent,
// issue-spor-user-prompt-submit-digest-noise): SPOR_DIGEST_ASYNC=1 gates the
// UserPromptSubmit digest behind a semantic intent classifier that runs OFF the
// prompt path in a detached worker. The prompt that computed the digest injects
// nothing; the worker classifies WARRANTED/UNWARRANTED; the NEXT
// UserPromptSubmit drains a passing result and injects it with NO LLM call.
// Only an explicit UNWARRANTED suppresses — backend failure fails open to
// inject. Classifier stubbed via SPOR_DIGEST_INTENT_CMD, everything against a
// throwaway SPOR_HOME in local mode.
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runHook, writeNodeScript, nodeCommand } = require("./helpers/portable");
const { llmCalls, tryLlmCalls } = require("./helpers/llm-calls");

// A prompt that reliably fires the local digest against the corpus below.
const PROMPT = "what is our widget thumbnail caching strategy in redis for gallery page";

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spor-digest-async-"));
  const home = path.join(root, "graph");
  fs.mkdirSync(path.join(home, "nodes"), { recursive: true });
  const cwd = path.join(root, "projx");
  fs.mkdirSync(cwd);
  // Small corpus so tf-idf has non-zero idf (a single node collapses to sim 0).
  const node = (id, type, title, summary) => `---
id: ${id}
type: ${type}
project: projx
title: ${title}
summary: ${summary}
date: 2026-06-20
---

${summary}
`;
  fs.writeFileSync(
    path.join(home, "nodes", "dec-widget-cache.md"),
    node("dec-widget-cache", "decision", "Widget thumbnail caching",
      "Widget thumbnail caching in Redis for the gallery page uses short TTL keys and avoids regenerating thumbnails during repeated browsing.")
  );
  fs.writeFileSync(
    path.join(home, "nodes", "spec-widget-gallery.md"),
    node("spec-widget-gallery", "artifact", "Gallery rendering spec",
      "Gallery rendering keeps thumbnail cache keys stable so Redis lookups stay cheap during browsing.")
  );
  fs.writeFileSync(
    path.join(home, "nodes", "dec-billing-webhooks.md"),
    node("dec-billing-webhooks", "decision", "Billing webhook retries",
      "Billing webhook retries use idempotency keys and exponential backoff for payment provider callbacks.")
  );
  return { root, home, cwd };
}

function stub(root, name, body) {
  return nodeCommand(writeNodeScript(path.join(root, name), body));
}

// Stubs must consume stdin first or the prompt pipe SIGPIPEs.
const warrantedStub = (root) => stub(root, "warranted.js", `
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write("WARRANTED\\n"));
`);
const unwarrantedStub = (root) => stub(root, "unwarranted.js", `
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write("UNWARRANTED\\n"));
`);
const failStub = (root) => stub(root, "fail.js", `
process.stdin.resume();
process.stdin.on("end", () => process.exit(1));
`);

function env(home, intentCmd, extra = {}) {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/^(SPOR_|SUBSTRATE_)/.test(k)) delete e[k];
  delete e.GEMINI_API_KEY;
  delete e.ANTHROPIC_API_KEY;
  e.SPOR_HOME = home;
  e.SPOR_ENABLED = "1";
  e.SPOR_DIGEST_ASYNC = "1";
  if (intentCmd) e.SPOR_DIGEST_INTENT_CMD = intentCmd;
  return { ...e, ...extra };
}

function promptContext(home, cwd, { prompt = PROMPT, session = "s1", intentCmd = null, extraEnv = {} } = {}) {
  const payload = { cwd, session_id: session, hook_event_name: "UserPromptSubmit", prompt };
  const r = runHook(["prompt-context", "--host", "claude-code"], JSON.stringify(payload), env(home, intentCmd, extraEnv));
  assert.strictEqual(r.status, 0, `exit 0 expected: ${r.stderr}`);
  return r.stdout;
}

function spoolDir(home, session = "s1") {
  return path.join(home, "journal", "pending-digests", session);
}

function outFiles(home, session = "s1") {
  try {
    return fs.readdirSync(spoolDir(home, session)).filter((f) => f.endsWith(".out.json"));
  } catch {
    return [];
  }
}

function journal(home, session = "s1") {
  const p = path.join(home, "journal", `${session}.jsonl`);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(50);
  }
  return false;
}

// Drop a completed worker result straight into the spool — lets the drain side
// be tested deterministically without racing detached workers.
function seedOut(home, session, name, digest, sig, slug) {
  const dir = spoolDir(home, session);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.out.json`),
    JSON.stringify({ digest, sig, ...(slug ? { slug } : {}), verdict: "WARRANTED", ts: "2026-01-01T00:00:00Z" })
  );
}

test("default (flag unset): digest injects synchronously, no async side effects", () => {
  const { home, cwd } = scratch();
  const out = promptContext(home, cwd, { extraEnv: { SPOR_DIGEST_ASYNC: "0" } });
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
  assert.match(ctx, /^Spor context \(top matches; run \/spor:brief for full\):/);
  assert.match(ctx, /dec-widget-cache/);
  // None of the async machinery's files exist on the default path.
  assert.ok(!fs.existsSync(path.join(home, "journal", "pending-digests")), "no spool dir");
  assert.ok(!fs.existsSync(path.join(home, "journal", "s1.digest-intent")), "no spawn state");
  assert.strictEqual(llmCalls(home).length, 0);
});

test("async: prompt spools + injects nothing; WARRANTED worker result injects one turn late", async () => {
  const { root, home, cwd } = scratch();
  // One-turn-delayed: the prompt that computed the digest injects nothing.
  const first = promptContext(home, cwd, { intentCmd: warrantedStub(root) });
  assert.strictEqual(first.trim(), "");
  // The spawn was journaled and counted against the per-session cap.
  assert.strictEqual(journal(home).filter((e) => e.tool === "digest-intent-spawn").length, 1);
  assert.strictEqual(
    fs.readFileSync(path.join(home, "journal", "s1.digest-intent"), "utf8").split("\n").filter(Boolean).length,
    1
  );

  // The detached worker classifies and drops a result file.
  assert.ok(await waitFor(() => outFiles(home).length === 1), "worker never wrote a result");
  const calls = llmCalls(home);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].source, "digest-intent");
  assert.match(calls[0].vars.PROMPT, /widget thumbnail caching/);
  assert.match(calls[0].response, /WARRANTED/);

  // Next UserPromptSubmit drains it — NO LLM — even on a continuation prompt.
  const ctx = JSON.parse(promptContext(home, cwd, { prompt: "ok" })).hookSpecificOutput.additionalContext;
  assert.match(ctx, /^Spor context \(top matches; run \/spor:brief for full\):/);
  assert.match(ctx, /dec-widget-cache/);
  assert.strictEqual(llmCalls(home).length, 1, "no classifier call on the prompt path");
  assert.strictEqual(outFiles(home).length, 0, "result consumed");
  assert.strictEqual(journal(home).filter((e) => e.tool === "digest" && e.async).length, 1);
  assert.ok(fs.existsSync(path.join(home, "journal", "s1.digest-injected")));

  // A third prompt injects nothing (already drained).
  assert.strictEqual(promptContext(home, cwd, { prompt: "ok" }).trim(), "");
});

test("async UNWARRANTED verdict: no result file, nothing ever injects", async () => {
  const { root, home, cwd } = scratch();
  assert.strictEqual(promptContext(home, cwd, { intentCmd: unwarrantedStub(root) }).trim(), "");
  assert.ok(await waitFor(() => tryLlmCalls(home)?.length === 1), "worker never ran");
  assert.match(llmCalls(home)[0].response, /UNWARRANTED/);
  assert.strictEqual(outFiles(home).length, 0, "an UNWARRANTED verdict writes no result");
  assert.strictEqual(promptContext(home, cwd, { prompt: "ok" }).trim(), "");
});

test("async backend failure fails open: the digest still injects next prompt", async () => {
  const { root, home, cwd } = scratch();
  assert.strictEqual(promptContext(home, cwd, { intentCmd: failStub(root) }).trim(), "");
  assert.ok(await waitFor(() => outFiles(home).length === 1), "failure must still spool the digest");
  assert.strictEqual(llmCalls(home)[0].response, null);
  assert.match(llmCalls(home)[0].error, /digest-intent cmd failed/);
  const ctx = JSON.parse(promptContext(home, cwd, { prompt: "ok" })).hookSpecificOutput.additionalContext;
  assert.match(ctx, /dec-widget-cache/, "a broken classifier must not eat digests");
});

test("drain keeps only the newest pending result and consumes the rest", () => {
  const { home, cwd } = scratch();
  seedOut(home, "s1", "1000-old", "OLD-DIGEST body", "sig-old");
  seedOut(home, "s1", "2000-new", "NEW-DIGEST body", "sig-new");
  const ctx = JSON.parse(promptContext(home, cwd, { prompt: "ok" })).hookSpecificOutput.additionalContext;
  assert.match(ctx, /NEW-DIGEST/);
  assert.doesNotMatch(ctx, /OLD-DIGEST/, "superseded snapshot must not inject");
  assert.strictEqual(outFiles(home).length, 0, "every result consumed");
});

test("drain dedupes against the last injected signature", () => {
  const { home, cwd } = scratch();
  seedOut(home, "s1", "1000-a", "SAME-DIGEST body", "sig-same");
  assert.match(JSON.parse(promptContext(home, cwd, { prompt: "ok" })).hookSpecificOutput.additionalContext, /SAME-DIGEST/);
  // An identical follow-up snapshot (same signature) drains silently.
  seedOut(home, "s1", "2000-b", "SAME-DIGEST body", "sig-same");
  assert.strictEqual(promptContext(home, cwd, { prompt: "ok" }).trim(), "");
  assert.strictEqual(outFiles(home).length, 0, "duplicate consumed, not left to retry");
});

test("spawn cap: at digest.intentMaxCalls the digest falls open to synchronous injection", () => {
  const { root, home, cwd } = scratch();
  fs.mkdirSync(path.join(home, "journal"), { recursive: true });
  fs.writeFileSync(path.join(home, "journal", "s1.digest-intent"), Array.from({ length: 20 }, (_, i) => `sig${i}`).join("\n") + "\n");
  const ctx = JSON.parse(promptContext(home, cwd, { intentCmd: warrantedStub(root) })).hookSpecificOutput.additionalContext;
  assert.match(ctx, /dec-widget-cache/, "capped session injects synchronously, not silently");
  assert.strictEqual(outFiles(home).length, 0);
  assert.strictEqual(journal(home).filter((e) => e.tool === "digest-intent-spawn").length, 0, "no spawn past the cap");
});

test("a fresh synchronous digest suppresses a stale pending one (no double injection)", () => {
  const { root, home, cwd } = scratch();
  // Cap forces the fresh digest down the synchronous path while a pending
  // result waits — the pending one must be consumed, not injected beside it.
  fs.mkdirSync(path.join(home, "journal"), { recursive: true });
  fs.writeFileSync(path.join(home, "journal", "s1.digest-intent"), Array.from({ length: 20 }, (_, i) => `sig${i}`).join("\n") + "\n");
  seedOut(home, "s1", "1000-stale", "STALE-DIGEST body", "sig-stale");
  const ctx = JSON.parse(promptContext(home, cwd, { intentCmd: warrantedStub(root) })).hookSpecificOutput.additionalContext;
  assert.match(ctx, /dec-widget-cache/);
  assert.doesNotMatch(ctx, /STALE-DIGEST/);
  assert.strictEqual(outFiles(home).length, 0, "stale pending result consumed");
  assert.strictEqual(journal(home).filter((e) => e.tool === "digest" && e.async).length, 0);
});

test("verdict parsing: only an unambiguous UNWARRANTED suppresses", () => {
  const { classifyDigestIntent } = require("../scripts/engines/prompt-context");
  const { home } = scratch();
  const cases = [
    ["UNWARRANTED", "UNWARRANTED"],
    ["WARRANTED", "WARRANTED"],
    ["Reply: WARRANTED.", "WARRANTED"],
    // Both tokens = ambiguous = fail-open (null), never a suppression.
    ["WARRANTED — definitely not UNWARRANTED", null],
    ["gibberish", null],
  ];
  for (const [reply, want] of cases) {
    const cmd = nodeCommand(writeNodeScript(path.join(home, `v-${Buffer.from(reply).toString("hex").slice(0, 8)}.js`), `
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write(${JSON.stringify(reply)}));
`));
    const got = classifyDigestIntent({
      prompt: "p", tplSha: "t", session: "s", slug: "projx", graph: home,
      timeoutMs: 10000, cmd, vars: {},
    });
    assert.strictEqual(got, want, `reply ${JSON.stringify(reply)}`);
  }
});

test("drain drops a pending result spooled for a different project", () => {
  const { home, cwd } = scratch();
  seedOut(home, "s1", "1000-x", "OTHER-PROJECT digest", "sig-x", "other-project");
  assert.strictEqual(promptContext(home, cwd, { prompt: "ok" }).trim(), "", "cross-project context must not inject");
  assert.strictEqual(outFiles(home).length, 0, "mismatched result still consumed");
  // A matching-slug result injects normally.
  seedOut(home, "s1", "2000-y", "SAME-PROJECT digest", "sig-y", "projx");
  assert.match(JSON.parse(promptContext(home, cwd, { prompt: "ok" })).hookSpecificOutput.additionalContext, /SAME-PROJECT/);
});

test("a fallback synchronous injection records its signature for the drain dedup", () => {
  const { root, home, cwd } = scratch();
  fs.mkdirSync(path.join(home, "journal"), { recursive: true });
  fs.writeFileSync(path.join(home, "journal", "s1.digest-intent"), Array.from({ length: 20 }, (_, i) => `sig${i}`).join("\n") + "\n");
  // Cap → synchronous fallback injection of the widget digest.
  const ctx = JSON.parse(promptContext(home, cwd, { intentCmd: warrantedStub(root) })).hookSpecificOutput.additionalContext;
  assert.match(ctx, /dec-widget-cache/);
  const injState = path.join(home, "journal", "s1.digest-injected");
  assert.ok(fs.existsSync(injState), "fallback injection must record its signature");
  const sig = fs.readFileSync(injState, "utf8").trim();
  // A late-landing pending result with the SAME signature must not re-inject.
  seedOut(home, "s1", "3000-late", "LATE duplicate", sig, "projx");
  assert.strictEqual(promptContext(home, cwd, { prompt: "ok" }).trim(), "");
});

test("session_id absent: spool writer and drainer agree on the 'unknown' key", async () => {
  const { root, home, cwd } = scratch();
  const first = { cwd, hook_event_name: "UserPromptSubmit", prompt: PROMPT };
  const r = runHook(["prompt-context", "--host", "claude-code"], JSON.stringify(first), env(home, warrantedStub(root)));
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), "");
  assert.ok(await waitFor(() => outFiles(home, "unknown").length === 1), "worker should spool under 'unknown'");
  const second = { cwd, hook_event_name: "UserPromptSubmit", prompt: "ok" };
  const out = runHook(["prompt-context", "--host", "claude-code"], JSON.stringify(second), env(home, warrantedStub(root)));
  assert.match(JSON.parse(out.stdout).hookSpecificOutput.additionalContext, /dec-widget-cache/);
});

// ---------------------------------------------------------------------------
// Server-computed intent (task-spor-digest-intent-jev-gate): /v1/digest may
// return `intent: {warranted, needs_history, digest_helps, source}` — the Jev
// verdict the tenant server computed over the prompt it was already sent. The
// client decides THIS prompt with it, synchronously, never spawning the Haiku
// classifier. Absent/malformed intent falls through to the behavior without it.
// ---------------------------------------------------------------------------
const { spawnHook } = require("./helpers/portable");
const { INTENT_GATE_DEFAULT } = require("../scripts/engines/prompt-context.js");

const TEAM_TEXT =
  "- **dec-widget-cache — Widget thumbnail caching** (decision, projx, 2026-06-20): Widget thumbnail caching in Redis uses short TTL keys.";

function digestServer(intent, found = true) {
  const http = require("node:http");
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, body });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.method === "POST" && req.url === "/v1/digest") {
        res.end(JSON.stringify({ found, ...(found ? { text: TEAM_TEXT } : {}), ...(intent === undefined ? {} : { intent }) }));
      } else {
        res.end(JSON.stringify({ found: false }));
      }
    });
  });
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` }))
  );
}

// Remote mode, pure: no local nodes/ dir, so the only digest is the server's.
// `asyncFlag` undefined leaves SPOR_DIGEST_ASYNC UNSET (the default).
async function remotePrompt(intent, { asyncFlag, intentCmd = null, found = true, keepLocal = false, seed = null, extraEnv = {} } = {}) {
  const { root, home, cwd } = scratch();
  if (!keepLocal) fs.rmSync(path.join(home, "nodes"), { recursive: true });
  if (seed) seed(home);
  const { srv, hits, base } = await digestServer(intent, found);
  try {
    const e = env(home, intentCmd, { SPOR_SERVER: base, SPOR_TOKEN: "spor_pat_test", ...extraEnv });
    if (asyncFlag === undefined) delete e.SPOR_DIGEST_ASYNC;
    else e.SPOR_DIGEST_ASYNC = asyncFlag;
    const payload = { cwd, session_id: "s1", hook_event_name: "UserPromptSubmit", prompt: PROMPT };
    const stdout = await new Promise((resolve, reject) => {
      const c = spawnHook(["prompt-context", "--host", "claude-code"], JSON.stringify(payload), e, {
        stdio: ["pipe", "pipe", "ignore"],
      });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.on("error", reject);
      c.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
    });
    return { root, home, stdout, hits };
  } finally {
    srv.close();
  }
}

const JEV_NO = { warranted: false, needs_history: 0.12, digest_helps: 0.2, source: "jev" };
const JEV_YES = { warranted: true, needs_history: 0.91, digest_helps: 0.64, source: "jev" };

test("server intent, explicit async: warranted:false suppresses THIS prompt, no spool, no classifier", async () => {
  const { root, home, stdout } = await remotePrompt(JEV_NO, { asyncFlag: "1", intentCmd: "false" });
  assert.strictEqual(stdout.trim(), "");
  assert.ok(!fs.existsSync(path.join(home, "journal", "s1.digest-intent")), "no classifier spawn counted");
  assert.strictEqual(outFiles(home).length, 0);
  assert.ok(
    !fs.existsSync(spoolDir(home)) || fs.readdirSync(spoolDir(home)).every((f) => !f.endsWith(".in.json")),
    "nothing spooled"
  );
  assert.strictEqual(llmCalls(home).length, 0);
  assert.ok(!fs.existsSync(path.join(home, "journal", "s1.digest-injected")), "a suppressed digest records no signature");
  const j = journal(home).filter((x) => x.tool === "digest-intent");
  assert.strictEqual(j.length, 1);
  assert.deepStrictEqual(
    { source: j[0].source, warranted: j[0].warranted, needs_history: j[0].needs_history, digest_helps: j[0].digest_helps },
    { source: "jev", warranted: false, needs_history: 0.12, digest_helps: 0.2 }
  );
  void root;
});

test("server intent, explicit async: warranted:true injects synchronously (no one-turn delay)", async () => {
  const { home, stdout } = await remotePrompt(JEV_YES, { asyncFlag: "1" });
  const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /dec-widget-cache/);
  assert.ok(!fs.existsSync(path.join(home, "journal", "s1.digest-intent")), "no classifier spawn");
  // Recorded for the drain dedup, exactly like a synchronous fallback injection.
  assert.ok(fs.existsSync(path.join(home, "journal", "s1.digest-injected")));
  assert.strictEqual(journal(home).filter((x) => x.tool === "digest-intent")[0].warranted, true);
});

test("server intent, explicit async off: the verdict is ignored and the digest injects", async () => {
  const { home, stdout } = await remotePrompt(JEV_NO, { asyncFlag: "0" });
  assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /dec-widget-cache/);
  assert.strictEqual(journal(home).filter((x) => x.tool === "digest-intent").length, 0);
});

test("server intent, flag UNSET: honored iff INTENT_GATE_DEFAULT, never a classifier spawn", async () => {
  const { home, stdout } = await remotePrompt(JEV_NO, {});
  if (INTENT_GATE_DEFAULT) assert.strictEqual(stdout.trim(), "");
  else assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /dec-widget-cache/);
  assert.ok(!fs.existsSync(path.join(home, "journal", "pending-digests")), "no spool dir on the default path");
  assert.ok(!fs.existsSync(path.join(home, "journal", "s1.digest-intent")));
  assert.strictEqual(llmCalls(home).length, 0);
});

test("no intent field (older server), flag UNSET: synchronous injection with no async side effects", async () => {
  const { home, stdout } = await remotePrompt(undefined, {});
  assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /dec-widget-cache/);
  assert.ok(!fs.existsSync(path.join(home, "journal", "pending-digests")));
  assert.strictEqual(journal(home).filter((x) => x.tool === "digest-intent").length, 0);
});

test("malformed intent (non-boolean warranted) is ignored — fails open to the path without it", async () => {
  // Explicit async + no usable verdict = the Haiku spool path, exactly as before.
  const { home, stdout } = await remotePrompt({ warranted: "no", source: "jev" }, { asyncFlag: "1", intentCmd: "false" });
  assert.strictEqual(stdout.trim(), "", "spooled for the classifier, injects next turn");
  assert.strictEqual(journal(home).filter((x) => x.tool === "digest-intent-spawn").length, 1);
  assert.strictEqual(journal(home).filter((x) => x.tool === "digest-intent").length, 0);
});

test("server intent, explicit async: a stale pending result is consumed, never injected beside the verdict", async () => {
  const STALE = "Spor context (top matches; run /spor:brief for full):\n- dec-stale-pending: an older prompt's digest";
  const seed = (home) => seedOut(home, "s1", "0000-old", STALE, "stale-sig", "projx");
  for (const intent of [JEV_NO, JEV_YES]) {
    const { home, stdout } = await remotePrompt(intent, { asyncFlag: "1", seed });
    assert.ok(!stdout.includes("dec-stale-pending"), "the stale pending digest never injects");
    assert.strictEqual(outFiles(home).length, 0, "the stale result was consumed");
    if (intent.warranted) assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /dec-widget-cache/);
    else assert.strictEqual(stdout.trim(), "");
  }
});

test("server intent on found:false is ignored — it never judged the personal-graph digest", async () => {
  // Team graph finds nothing; the local personal graph does. The verdict's
  // digest_helps was scored against an EMPTY team digest, so it must not
  // suppress the personal digest the server never saw.
  const { stdout, home } = await remotePrompt(JEV_NO, { asyncFlag: "1", found: false, keepLocal: true, intentCmd: "false" });
  assert.strictEqual(journal(home).filter((x) => x.tool === "digest-intent").length, 0);
  // Falls through to the explicit async gate exactly as without an intent.
  assert.strictEqual(stdout.trim(), "");
  assert.strictEqual(journal(home).filter((x) => x.tool === "digest-intent-spawn").length, 1);
});

// issue-spor-prompt-context-repeat-record-before-gate: the repeat-suppression
// bookkeeping used to write inside computeDigest, BEFORE the intent gate
// decided whether to inject — so a digest the gate suppressed still got
// recorded as "shown", and a later low-signal follow-up asking about the same
// thing was wrongly treated as a repeat of context the user never actually
// saw. Fixed by recording only once a digest clears the gate and is actually
// injected.
async function oneShotRemotePrompt({ home, cwd, session, prompt, intent, found = true, asyncFlag, intentCmd = null }) {
  const { srv, base } = await digestServer(intent, found);
  try {
    const e = env(home, intentCmd, { SPOR_SERVER: base, SPOR_TOKEN: "spor_pat_test" });
    if (asyncFlag === undefined) delete e.SPOR_DIGEST_ASYNC;
    else e.SPOR_DIGEST_ASYNC = asyncFlag;
    const payload = { cwd, session_id: session, hook_event_name: "UserPromptSubmit", prompt };
    return await new Promise((resolve, reject) => {
      const c = spawnHook(["prompt-context", "--host", "claude-code"], JSON.stringify(payload), e, {
        stdio: ["pipe", "pipe", "ignore"],
      });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.on("error", reject);
      c.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
    });
  } finally {
    srv.close();
  }
}

test("intent gate suppresses prompt 1's digest; a low-signal follow-up prompt 2 still gets its digest", async () => {
  const { home, cwd } = scratch();
  fs.rmSync(path.join(home, "nodes"), { recursive: true }); // pure remote: only the team digest matters
  const session = "s1";

  // Prompt 1: the server says the digest is not warranted for this prompt —
  // it is computed but suppressed, never shown to the user.
  const out1 = await oneShotRemotePrompt({
    home, cwd, session, prompt: PROMPT, intent: JEV_NO, asyncFlag: "1", intentCmd: "false",
  });
  assert.strictEqual(out1.trim(), "", "prompt 1's digest is suppressed by the intent gate");
  // Nothing was recorded as "already shown" — the bug wrote this file here.
  const journalDir = path.join(home, "journal");
  const stateFiles = fs.existsSync(journalDir)
    ? fs.readdirSync(journalDir).filter((f) => f.startsWith("prompt-context-"))
    : [];
  assert.deepStrictEqual(stateFiles, [], "a suppressed digest must not be recorded as shown");

  // Prompt 2: a short, low-signal follow-up asking about the same topic —
  // exactly what the repeat-suppression gate targets. With the intent gate
  // off this turn, the team digest (identical text, same server stub) injects
  // synchronously unless wrongly suppressed as a "repeat" of prompt 1's
  // (never-shown) digest.
  const out2 = await oneShotRemotePrompt({
    home, cwd, session, prompt: "what about widget caching once more please", intent: undefined, asyncFlag: "0",
  });
  assert.match(
    JSON.parse(out2).hookSpecificOutput.additionalContext,
    /dec-widget-cache/,
    "prompt 2 must still get its digest — prompt 1's suppressed digest was never actually shown"
  );
});

// ---------------------------------------------------------------------------
// Cheap default backend (task-spor-digest-intent-cheap-default-backend): with an
// API key and no digest.intentCmd the worker classifies with ONE raw Messages
// API call (no `claude` spawn); with no key it spawns exactly what it always
// did. A fake Anthropic API (test/helpers/fake-anthropic.js) and a PATH-resident
// fake `claude` are the two oracles.
// ---------------------------------------------------------------------------
const { startFakeAnthropic } = require("./helpers/fake-anthropic");
const { writeFakePathNodeBin } = require("./helpers/portable");

function claudeStubDir(root) {
  const dir = path.join(root, "bin");
  const log = path.join(root, "claude-spawned");
  writeFakePathNodeBin(dir, "claude", `
require("fs").appendFileSync(${JSON.stringify(log)}, "spawn\\n");
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write(JSON.stringify({ result: "WARRANTED", usage: {}, total_cost_usd: 0 })));
`);
  return { dir, log };
}

test("api key + no intentCmd: one raw Messages API call, no claude spawn, same result file", async () => {
  const { root, home, cwd } = scratch();
  const fake = await startFakeAnthropic({ handler: () => ({ text: "WARRANTED" }) });
  const { dir, log } = claudeStubDir(root);
  try {
    const extraEnv = {
      SPOR_DIGEST_INTENT_API_KEY: "sk-test-key",
      ANTHROPIC_BASE_URL: fake.url,
      PATH: `${dir}${path.delimiter}${process.env.PATH}`,
    };
    assert.strictEqual(promptContext(home, cwd, { extraEnv }).trim(), "");
    assert.ok(await waitFor(() => outFiles(home).length === 1), "worker never wrote a result");
    assert.strictEqual(fake.requests.length, 1, "exactly one API call");
    const req = fake.requests[0];
    assert.strictEqual(req.url, "/v1/messages");
    assert.strictEqual(req.headers["x-api-key"], "sk-test-key");
    assert.strictEqual(req.body.stream, undefined);
    assert.match(req.body.model, /haiku/);
    assert.match(req.body.messages[0].content, /widget thumbnail caching/);
    assert.ok(!fs.existsSync(log), "claude was never spawned");
    const calls = llmCalls(home);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].source, "digest-intent");
    assert.match(calls[0].backend, /^api:/);
    assert.match(calls[0].response, /WARRANTED/);
    // The secret is never spooled.
    const spooled = fs.readdirSync(spoolDir(home)).map((f) => fs.readFileSync(path.join(spoolDir(home), f), "utf8")).join("");
    assert.ok(!spooled.includes("sk-test-key"));
    // Same result file as any backend: the next prompt drains and injects it.
    const ctx = JSON.parse(promptContext(home, cwd, { prompt: "ok", extraEnv })).hookSpecificOutput.additionalContext;
    assert.match(ctx, /dec-widget-cache/);
  } finally {
    await fake.close();
  }
});

test("api key: an UNWARRANTED API verdict suppresses; an API failure fails open", async () => {
  const { root, home, cwd } = scratch();
  const fake = await startFakeAnthropic({ handler: () => ({ text: "UNWARRANTED" }) });
  try {
    const extraEnv = { SPOR_DIGEST_INTENT_API_KEY: "k", ANTHROPIC_BASE_URL: fake.url };
    promptContext(home, cwd, { extraEnv });
    assert.ok(await waitFor(() => tryLlmCalls(home)?.length === 1), "worker never ran");
    assert.strictEqual(outFiles(home).length, 0);
  } finally {
    await fake.close();
  }
  // Dead endpoint: the call fails, the digest still spools.
  const b = scratch();
  const dead = await startFakeAnthropic();
  const deadUrl = dead.url;
  await dead.close();
  promptContext(b.home, b.cwd, { extraEnv: { SPOR_DIGEST_INTENT_API_KEY: "k", ANTHROPIC_BASE_URL: deadUrl } });
  assert.ok(await waitFor(() => outFiles(b.home).length === 1), "failure must still spool the digest");
  assert.match(llmCalls(b.home)[0].error, /anthropic api failed/);
});

test("an explicit intentCmd beats an API key", async () => {
  const { root, home, cwd } = scratch();
  const fake = await startFakeAnthropic();
  try {
    promptContext(home, cwd, {
      intentCmd: warrantedStub(root),
      extraEnv: { SPOR_DIGEST_INTENT_API_KEY: "k", ANTHROPIC_BASE_URL: fake.url },
    });
    assert.ok(await waitFor(() => outFiles(home).length === 1));
    assert.strictEqual(fake.requests.length, 0, "no API call when a cmd is configured");
    assert.match(llmCalls(home)[0].backend, /^cmd:/);
  } finally {
    await fake.close();
  }
});

test("no key: spawns exactly the claude -p backend it always did", async () => {
  const { root, home, cwd } = scratch();
  const { dir, log } = claudeStubDir(root);
  promptContext(home, cwd, { extraEnv: { PATH: `${dir}${path.delimiter}${process.env.PATH}` } });
  assert.ok(await waitFor(() => outFiles(home).length === 1));
  assert.ok(fs.existsSync(log), "claude was spawned");
  assert.strictEqual(llmCalls(home)[0].backend, "cli:claude -p --model haiku");
});

test("api key + a Jev-carrying response still decides synchronously, no API call", async () => {
  const fake = await startFakeAnthropic();
  try {
    const { home, stdout } = await remotePrompt(JEV_NO, {
      asyncFlag: "1",
      extraEnv: { SPOR_DIGEST_INTENT_API_KEY: "k", ANTHROPIC_BASE_URL: fake.url },
    });
    assert.strictEqual(stdout.trim(), "");
    assert.strictEqual(fake.requests.length, 0);
    assert.strictEqual(llmCalls(home).length, 0);
  } finally {
    await fake.close();
  }
});

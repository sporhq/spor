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
  assert.ok(await waitFor(() => llmCalls(home).length === 1), "worker never ran");
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

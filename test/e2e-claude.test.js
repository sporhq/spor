"use strict";
// End-to-end tests: drive the REAL `claude` binary with the Spor plugin loaded against a
// zero-dep fake Anthropic API (task-spor-e2e-integration-tests). These complement the
// hand-built-payload contract suite in hookcli.test.js by replaying genuine client paths
// (norm-qa-replay-genuine-paths): every hook fires the way a live session fires it, so a
// new claude version that breaks the hook contract is caught here, not in production.
//
// LOCAL-MODE tier only — Tier 0 (spec-correct SSE text) and Tier 1 (one tool_use
// round-trip). The remote-mode tier (claim nudge/heartbeat, dispatch, agent identity)
// needs a live Spor REST server and lives in spor-server (task-spor-server-e2e-remote-mode-
// tier), reusing this repo's fake-anthropic helper.
//
// The regression ORACLE is deliberately NOT claude's responses (we script those). It is:
//   (1) the REQUEST BODIES claude sends — hook-injected additionalContext (briefing,
//       digest, nudge) lands in the next POST /v1/messages `messages`, captured by the
//       fake; and
//   (2) SPOR_HOME SIDE EFFECTS — nodes written, journal nudge entries, .nudged cooldowns.
// Both are stable across claude versions; we never assert on claude's own framing/wording.
//
// Self-skips when the claude binary is absent (CI runs `npm test` without it) or
// SPOR_E2E=0. Each test is hermetic: a scratch SPOR_HOME + a throwaway CLAUDE_CONFIG_DIR
// and HOME, so a configured dev box's installed plugin / SPOR_SERVER env can't leak in and
// the live team graph is never touched (norm-cc-scratch-home-for-tests).

require("./helpers/tmp-cleanup"); // scratch-home leak guard (issue-spor-test-mkdtemp-inode-exhaustion)
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { startFakeAnthropic, allInjectedText, toolNames, hasToolResult } = require("./helpers/fake-anthropic");
const {
  claudeSkipReason,
  claudeVersion,
  makeScratchGraph,
  runClaude,
  waitFor,
  journalEntries,
  llmCalls,
} = require("./helpers/claude-e2e");

// false → run; a string → node:test skips with that reason (binary absent, SPOR_E2E=0, or
// an unresolvable SPOR_E2E_CLAUDE override).
const skip = claudeSkipReason() || false;
// Record which Claude Code version actually ran — the point of the SPOR_E2E_CLAUDE override
// (task-spor-e2e-claude-version-matrix-sandbox) is a version matrix, so log it.
if (!skip) console.error(`# e2e: Claude Code ${claudeVersion() || "(version unknown)"}`);

// A small multi-node corpus tagged to the project slug. The digest is tf-idf, so it needs
// idf signal: a single-node corpus scores 0 for every term and never clears the relevance
// gate. One node (dec-widget-caching) is the target the relevant-prompt test fishes for;
// the briefing node carries a sentinel proving the SCRATCH graph (not a leaked live one)
// reached the model.
function corpus(slug) {
  const nodes = ["auth", "logging", "routing", "metrics"].map((t) => ({
    id: `dec-${t}`,
    type: "decision",
    repo: slug,
    title: `${t} decision`,
    summary: `A decision about the ${t} subsystem and how we handle ${t} in production.`,
  }));
  nodes.push({
    id: "dec-widget-caching",
    type: "decision",
    repo: slug,
    title: "widget thumbnail caching strategy",
    summary: "We cache widget thumbnails in Redis with a sliding TTL to cut latency on the gallery page.",
  });
  nodes.push({
    id: `brief-${slug}`,
    type: "briefing",
    title: slug,
    version: 1,
    summary: "Standing briefing.",
    body: "Standing briefing for the project. SPOR_E2E_BRIEF_SENTINEL marks the scratch graph.",
  });
  return nodes;
}

// ~60 words of finding-shaped prose, so a .md Write of it clears the capture-nudge prose
// word gate.
const PROSE = Array.from(
  { length: 10 },
  (_, i) =>
    `Finding ${i}: the retry path in service X was dismissed because the upstream proxy ` +
    `already retries idempotent calls twice, so a client-side retry tripled the load.`
).join("\n");

test(
  "Tier 0: SessionStart briefing + UserPromptSubmit digest reach the model request (hermetic local mode)",
  { skip },
  async () => {
    const g = makeScratchGraph({ slug: "e2eproj", nodes: corpus("e2eproj") });
    const fake = await startFakeAnthropic();
    try {
      // distilling:true suppresses the async SessionEnd distill (tested separately) so this
      // run has no background noise.
      const { rc, stderr } = await runClaude({
        home: g.home,
        cwd: g.cwd,
        baseUrl: fake.url,
        prompt: "what is our widget thumbnail caching strategy in redis for the gallery page",
        distilling: true,
      });
      assert.strictEqual(rc, 0, `claude should exit 0 (stderr: ${stderr})`);
      assert.ok(fake.requests.some((r) => r.url.startsWith("/v1/messages")), "claude should hit POST /v1/messages");

      const injected = allInjectedText(fake.requests);
      // (1) SessionStart briefing reached the request, FROM THE SCRATCH GRAPH.
      assert.match(injected, /SPOR_E2E_BRIEF_SENTINEL/, "scratch SessionStart briefing should reach the request");
      // (2) UserPromptSubmit digest reached the request for a relevant prompt.
      assert.match(injected, /Spor context \(top matches; run \/spor:brief for full\)/, "a relevant prompt should inject a digest");
      assert.match(injected, /widget thumbnail caching/, "the digest should surface the matching node");
      // (3) Hermeticity: the live team graph banner must NOT appear (no settings.json leak).
      assert.doesNotMatch(injected, /127\.0\.0\.1:8787|team graph:/, "must not leak the live team graph");
    } finally {
      await fake.close();
      g.cleanup();
    }
  }
);

test("Tier 0: the digest relevance gate suppresses a digest for an off-topic prompt", { skip }, async () => {
  const g = makeScratchGraph({ slug: "e2eproj", nodes: corpus("e2eproj") });
  const fake = await startFakeAnthropic();
  try {
    const { rc } = await runClaude({
      home: g.home,
      cwd: g.cwd,
      baseUrl: fake.url,
      // six+ words (clears the trivial-prompt gate) but lexically unrelated to the corpus,
      // so it must fall below the --min-sim cosine floor.
      prompt: "kangaroo trampoline saxophone volcano umbrella espresso",
      distilling: true,
    });
    assert.strictEqual(rc, 0);
    const injected = allInjectedText(fake.requests);
    // The session-start briefing still rides along (it is not prompt-gated)...
    assert.match(injected, /SPOR_E2E_BRIEF_SENTINEL/, "briefing rides every session");
    // ...but the prompt digest must be absent — the gate emitted nothing.
    assert.doesNotMatch(injected, /nodes relevant to this prompt/, "off-topic prompt must inject no digest");
    assert.doesNotMatch(injected, /widget thumbnail caching/, "no digest means no matching node");
  } finally {
    await fake.close();
    g.cleanup();
  }
});

test("Tier 1: a tool_use round-trip executes a real Write and fires the PostToolUse capture nudge", { skip }, async () => {
  const g = makeScratchGraph({ slug: "e2eproj", nodes: corpus("e2eproj") });
  const writeTarget = path.join(g.cwd, "findings.md");
  // Matcher-based script: first turn (claude offers the Write tool, no tool_result yet) →
  // return a Write tool_use of prose to a .md; the follow-up turn (carrying the
  // tool_result) → close with end_turn text. Robust to retries and extra probe calls.
  const fake = await startFakeAnthropic({
    handler: (body) => {
      if (toolNames(body).includes("Write") && !hasToolResult(body)) {
        return { tool: { name: "Write", input: { file_path: writeTarget, content: PROSE } } };
      }
      return { text: "done" };
    },
  });
  try {
    const { rc } = await runClaude({
      home: g.home,
      cwd: g.cwd,
      baseUrl: fake.url,
      prompt: "please write the findings to a markdown file in this project",
      skipPermissions: true, // headless: let the Write actually execute (PostToolUse fires only on real execution)
      // NOT distilling: the SPOR_DISTILLING guard would suppress the nudge. Distill is
      // stubbed to NOTHING (default) and the short transcript skips it anyway.
      nudgeCmd:
        "cat >/dev/null; printf '===FACT===\\nThe retry-path approach was dismissed because the proxy already retries idempotent calls.\\n===END===\\n'",
    });
    assert.strictEqual(rc, 0);
    // The tool round-trip actually executed (genuine path, not a synthesized payload).
    assert.ok(fs.existsSync(writeTarget), "the scripted Write tool_use should have created findings.md");
    assert.ok(
      fake.requests.filter((r) => r.url.startsWith("/v1/messages") && hasToolResult(r.body)).length >= 1,
      "claude should send a follow-up turn carrying the tool_result"
    );

    // Oracle: the capture nudge's SPOR_HOME side effects. The classifier runs synchronously
    // in the tool loop, so they are present the moment claude exits.
    const nudges = journalEntries(g.home).filter((e) => e.tool === "nudge");
    assert.strictEqual(nudges.length, 1, "exactly one fired nudge should be journaled");
    assert.strictEqual(nudges[0].file, writeTarget, "the nudge should be tagged with the written file");
    // A .nudged cooldown file was dropped so the file is not re-classified this session.
    const cooldowns = fs.readdirSync(path.join(g.home, "journal")).filter((f) => f.endsWith(".nudged"));
    assert.ok(cooldowns.length >= 1, "a .nudged cooldown file should be written");
    // The classifier call was recorded for the review loop.
    const calls = llmCalls(g.home).filter((c) => c.source === "nudge");
    assert.ok(calls.length >= 1, "the nudge classifier call should be recorded to llm-calls");
  } finally {
    await fake.close();
    g.cleanup();
  }
});

test("SessionEnd distill writes a node into the scratch graph (async, real SessionEnd)", { skip }, async () => {
  const g = makeScratchGraph({ slug: "e2eproj", nodes: corpus("e2eproj") });
  // A long fake response so the session transcript clears the distiller's 80-word gate.
  const long =
    Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ") +
    " and we durably decided to dismiss the retry path because the proxy already retries.";
  const fake = await startFakeAnthropic({ handler: () => ({ text: long }) });
  // The distill CMD seam returns a valid decision node block (the fake never has to
  // emulate the distiller). The node id/type/prefix must validate or distill logs an error.
  const distillCmd =
    "cat >/dev/null; printf '===NODE dec-e2e-distilled.md===\\n" +
    "---\\nid: dec-e2e-distilled\\ntype: decision\\nrepo: e2eproj\\n" +
    "title: e2e distilled decision\\nsummary: A decision distilled by the SessionEnd hook during the e2e run.\\n" +
    "date: 2026-06-17\\n---\\nBody.\\n===END===\\n'";
  try {
    const { rc } = await runClaude({
      home: g.home,
      cwd: g.cwd,
      baseUrl: fake.url,
      prompt: "please write a long answer about the retry path decision we made today",
      distillCmd, // distilling stays OFF so the SessionEnd distill actually runs
    });
    assert.strictEqual(rc, 0);
    // SessionEnd is async — the distiller writes the node after claude exits. Poll for it.
    const distilledFile = path.join(g.nodesDir, "dec-e2e-distilled.md");
    const written = await waitFor(() => fs.existsSync(distilledFile), { timeoutMs: 20000 });
    assert.ok(written, "the SessionEnd distiller should write the scripted node into the scratch graph");
    const md = fs.readFileSync(distilledFile, "utf8");
    assert.match(md, /type: decision/);
    assert.match(md, /distilled by the SessionEnd hook/);
  } finally {
    await fake.close();
    g.cleanup();
  }
});

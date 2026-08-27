// Validates scripts/run-skill-evals.js's trigger-detection logic against the REAL `claude`
// binary + the fake Anthropic API (task-spor-skill-evals-in-ci) — the same "drive the real
// binary, script the responses" approach as test/e2e-claude.test.js
// (norm-cc-qa-replay-genuine-paths), applied to the skill-eval runner instead of the hook
// contract. This proves the harness itself (spawn, stream-json parsing, tool_use
// detection) is correct WITHOUT spending real API money — the scheduled workflow
// (.github/workflows/skill-evals.yaml) is what points this same runCase()/detectTrigger()
// pair at the live API for a real trigger-accuracy signal. Self-skips like every other E2E
// tier when the claude binary isn't available.
require('./helpers/tmp-cleanup');
const test = require('node:test');
const assert = require('node:assert');
const { claudeAvailable, claudeSkipReason, makeScratchGraph } = require('./helpers/claude-e2e.js');
const skip = claudeSkipReason() || false;
const { startFakeAnthropic } = require('./helpers/fake-anthropic.js');
const { detectTrigger, runCase } = require('../scripts/run-skill-evals.js');

test('detectTrigger reads a matching Skill tool_use as a trigger', () => {
  const stdout = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'spor:factory' } }] },
    }),
    JSON.stringify({ type: 'result' }),
  ].join('\n');
  assert.strictEqual(detectTrigger(stdout, 'spor:factory'), true);
});

test('detectTrigger reads a non-matching tool_use as no trigger', () => {
  const stdout = [
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
    }),
    JSON.stringify({ type: 'result' }),
  ].join('\n');
  assert.strictEqual(detectTrigger(stdout, 'spor:factory'), false);
});

test('detectTrigger reads a plain-text reply with no tool_use as no trigger', () => {
  const stdout = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Sure, here is an explanation.' }] } }),
    JSON.stringify({ type: 'result' }),
  ].join('\n');
  assert.strictEqual(detectTrigger(stdout, 'spor:factory'), false);
});

test('detectTrigger returns null (inconclusive) on a transcript with no result and no tool_use', () => {
  assert.strictEqual(detectTrigger(JSON.stringify({ type: 'system', subtype: 'init' }), 'spor:factory'), null);
});

test('runCase against the real claude binary: a scripted Skill tool_use is detected as a trigger', { skip }, async () => {
  const scratch = makeScratchGraph({ slug: 'skill-eval-runner-e2e' });
  const fake = await startFakeAnthropic({
    handler: (body, requests) => {
      const sawToolResult = requests.some((r) => JSON.stringify((r.body || {}).messages || []).includes('"tool_result"'));
      if (sawToolResult) return { text: 'Done.' };
      return { tool: { name: 'Skill', input: { skill: 'spor:factory' } } };
    },
  });
  try {
    const { stdout, timedOut } = await runCase({
      cwd: scratch.cwd,
      prompt: 'Set up a factory for this repo with a test gate.',
      extraEnv: { ANTHROPIC_BASE_URL: fake.url, ANTHROPIC_API_KEY: 'dummy-e2e-key', SPOR_HOME: scratch.home },
      timeoutMs: 30000,
    });
    assert.strictEqual(timedOut, false);
    assert.strictEqual(detectTrigger(stdout, 'spor:factory'), true);
  } finally {
    await fake.close();
    scratch.cleanup();
  }
});

test('runCase against the real claude binary: a scripted plain-text reply is detected as no trigger', { skip }, async () => {
  const scratch = makeScratchGraph({ slug: 'skill-eval-runner-e2e-2' });
  const fake = await startFakeAnthropic({ handler: () => ({ text: "There's no meaningful difference to report here." }) });
  try {
    const { stdout, timedOut } = await runCase({
      cwd: scratch.cwd,
      prompt: 'What is the capital of France?',
      extraEnv: { ANTHROPIC_BASE_URL: fake.url, ANTHROPIC_API_KEY: 'dummy-e2e-key', SPOR_HOME: scratch.home },
      timeoutMs: 30000,
    });
    assert.strictEqual(timedOut, false);
    assert.strictEqual(detectTrigger(stdout, 'spor:factory'), false);
  } finally {
    await fake.close();
    scratch.cleanup();
  }
});

test('claudeAvailable() sentinel is a boolean (documents the self-skip contract used above)', () => {
  assert.strictEqual(typeof claudeAvailable(), 'boolean');
});

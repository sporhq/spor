// Client LLM spend visibility (task-cc-spor-client-spend-visibility):
//   1. parseClaudeResult — claude -p --output-format json envelope -> text+usage
//   2. lib/cost.js summarize — aggregate journal/llm-calls rows
//   3. SPOR_DISTILL=0 kill switch — distill short-circuits before the paid call
require("./helpers/tmp-cleanup"); // scratch-home leak guard (issue-spor-test-mkdtemp-inode-exhaustion)
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const u = require('../scripts/engines/util.js');
const { summarize } = require('../lib/cost.js');
const BIN = path.join(__dirname, '..', 'bin', 'spor-hook');

// ---- 1. parseClaudeResult ----
test('parseClaudeResult pulls text, usage, cost and model from the JSON envelope', () => {
  const envelope = JSON.stringify({
    type: 'result',
    result: 'the model text',
    total_cost_usd: 0.0311133,
    usage: {
      input_tokens: 10,
      output_tokens: 107,
      cache_read_input_tokens: 17503,
      cache_creation_input_tokens: 14409,
    },
    modelUsage: { 'claude-haiku-4-5-20251001': {} },
  });
  const r = u.parseClaudeResult(envelope + '\n');
  assert.strictEqual(r.text, 'the model text');
  assert.strictEqual(r.cost_usd, 0.0311133);
  assert.strictEqual(r.model, 'claude-haiku-4-5-20251001');
  assert.deepStrictEqual(r.usage, {
    input_tokens: 10,
    output_tokens: 107,
    cache_read_input_tokens: 17503,
    cache_creation_input_tokens: 14409,
  });
});

test('parseClaudeResult falls back to raw text with null telemetry on non-JSON', () => {
  const r = u.parseClaudeResult('===FACT===\nplain text\n===END===\n');
  assert.strictEqual(r.text, '===FACT===\nplain text\n===END===');
  assert.strictEqual(r.usage, null);
  assert.strictEqual(r.cost_usd, null);
  assert.strictEqual(r.model, null);
});

test('parseClaudeResult tolerates a JSON envelope missing usage/cost', () => {
  const r = u.parseClaudeResult(JSON.stringify({ result: 'hi' }));
  assert.strictEqual(r.text, 'hi');
  assert.strictEqual(r.cost_usd, null);
  assert.deepStrictEqual(r.usage, {
    input_tokens: null,
    output_tokens: null,
    cache_read_input_tokens: null,
    cache_creation_input_tokens: null,
  });
});

// ---- 2. summarize ----
const ROWS = [
  { ts: '2026-06-10T00:00:00.000Z', source: 'distill', project: 'spor', cost_usd: 0.02, usage: { input_tokens: 100, output_tokens: 50 } },
  { ts: '2026-06-12T00:00:00.000Z', source: 'distill', project: 'spor', cost_usd: 0.03, usage: { input_tokens: 200, output_tokens: 60 } },
  { ts: '2026-06-12T00:00:00.000Z', source: 'nudge', project: 'other', cost_usd: 0.01, usage: { input_tokens: 30, output_tokens: 10 } },
  { ts: '2026-06-13T00:00:00.000Z', source: 'nudge', project: 'spor', cost_usd: null, usage: null, error: 'claude -p failed' },
];

test('summarize totals tokens and cost, and separates known vs unknown cost', () => {
  const s = summarize(ROWS);
  assert.strictEqual(s.matched, 4);
  assert.strictEqual(s.total.calls, 4);
  assert.strictEqual(s.total.errors, 1);
  assert.strictEqual(s.total.input_tokens, 330);
  assert.strictEqual(s.total.output_tokens, 120);
  assert.ok(Math.abs(s.total.cost_usd - 0.06) < 1e-9);
  assert.strictEqual(s.total.cost_known, 3);
  assert.strictEqual(s.total.cost_unknown, 1); // the null-cost nudge row
  assert.deepStrictEqual(s.sources, ['distill', 'nudge']);
  assert.strictEqual(s.bySource.distill.calls, 2);
});

test('summarize honors the since filter', () => {
  const s = summarize(ROWS, { since: '2026-06-12' });
  assert.strictEqual(s.matched, 3); // drops the 06-10 row
  assert.ok(Math.abs(s.total.cost_usd - 0.04) < 1e-9);
});

test('summarize honors the project filter', () => {
  const s = summarize(ROWS, { project: 'spor' });
  assert.strictEqual(s.matched, 3); // drops the 'other' nudge row
  assert.ok(!s.bySource.nudge || s.bySource.nudge.calls === 1);
});

// ---- 3. SPOR_DISTILL=0 kill switch ----
function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-cost-'));
  const home = path.join(root, 'graph');
  fs.mkdirSync(path.join(home, 'nodes'), { recursive: true });
  const cwd = path.join(root, 'projx');
  fs.mkdirSync(cwd);
  // a transcript with >=80 words so the size gate passes
  const line = (role, text) => JSON.stringify({ type: role, message: { content: [{ type: 'text', text }] } });
  const word = 'word '.repeat(120);
  const tx = path.join(root, 'tx.jsonl');
  fs.writeFileSync(tx, line('user', word) + '\n' + line('assistant', word) + '\n');
  return { root, home, cwd, tx };
}

function env(home, extra) {
  const e = { ...process.env, SPOR_HOME: home };
  for (const k of ['SPOR_SERVER', 'SPOR_TOKEN', 'SPOR_DISTILLING', 'SUBSTRATE_DISTILLING', 'SPOR_DISTILL', 'SUBSTRATE_HOME'])
    delete e[k];
  // Opt the scratch repo in (task-spor-plugin-opt-in-default): the distill cost
  // accounting only runs when the hook is active for the repo.
  e.SPOR_ENABLED = '1';
  // a stub backend that would record an llm-call and write a node if reached
  e.SPOR_DISTILL_CMD = 'cat >/dev/null; echo NOTHING';
  return Object.assign(e, extra || {});
}

function runDistill(home, cwd, tx, extra) {
  const r = spawnSync('bash', [BIN, 'distill'], {
    input: JSON.stringify({ cwd, session_id: 's1', transcript_path: tx }),
    env: env(home, extra),
    encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0, `exit 0 expected (fail-open): ${r.stderr}`);
  return r;
}

test('SPOR_DISTILL=0 short-circuits the distiller before any LLM call', () => {
  const { home, cwd, tx } = scratch();
  runDistill(home, cwd, tx, { SPOR_DISTILL: '0' });
  // no llm-calls recorded, no distill.log activity
  assert.strictEqual(fs.existsSync(path.join(home, 'journal', 'llm-calls')), false);
});

test('distiller runs (records the sweep) when not disabled — control', () => {
  const { home, cwd, tx } = scratch();
  runDistill(home, cwd, tx, {}); // SPOR_DISTILL unset
  // the stub returns NOTHING, but the call IS made and recorded
  assert.strictEqual(fs.existsSync(path.join(home, 'journal', 'llm-calls')), true);
});

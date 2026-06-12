// scripts/post-tool.sh capture nudge (task-cc-posttool-capture-nudge):
// deterministic prefilter -> Haiku classifier -> additionalContext nudge.
// The classifier is stubbed via SUBSTRATE_NUDGE_CMD (prompt stdin -> response
// stdout, same contract as SUBSTRATE_DISTILL_CMD). Everything runs against a
// throwaway SUBSTRATE_HOME in local mode.
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'bin', 'spor-hook');

// 60+ words of finding-shaped prose so the word gate passes.
const PROSE = Array.from({ length: 8 }, (_, i) =>
  `Finding ${i}: the retry path in server X was dismissed because the upstream ` +
  `proxy already retries idempotent calls twice, so a client retry tripled load.`
).join('\n');

const FACT_STUB =
  'cat >/dev/null; printf "===FACT===\\nThe retry-path approach was dismissed because the proxy already retries idempotent calls.\\n===END===\\n"';
const NOTHING_STUB = 'cat >/dev/null; echo NOTHING';

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'substrate-nudge-'));
  const home = path.join(root, 'graph');
  fs.mkdirSync(path.join(home, 'nodes'), { recursive: true });
  const cwd = path.join(root, 'projx');
  fs.mkdirSync(cwd);
  return { root, home, cwd };
}

function env(home, stub) {
  const e = { ...process.env, SUBSTRATE_HOME: home };
  delete e.SUBSTRATE_SERVER;
  delete e.SUBSTRATE_TOKEN;
  delete e.SUBSTRATE_DISTILLING;
  delete e.SUBSTRATE_NUDGE;
  // Also clear the current SPOR_* spellings, or an ambient SPOR_SERVER/TOKEN
  // (remote mode) or SPOR_NUDGE/SPOR_NUDGE_CMD on the host derails the stub.
  delete e.SPOR_SERVER;
  delete e.SPOR_TOKEN;
  delete e.SPOR_DISTILL_CMD;
  delete e.SPOR_NUDGE;
  delete e.SPOR_NUDGE_CMD;
  if (stub) e.SUBSTRATE_NUDGE_CMD = stub;
  else delete e.SUBSTRATE_NUDGE_CMD;
  return e;
}

function postTool(home, cwd, stub, { file, content, session = 's1', tool = 'Write' } = {}) {
  const payload = {
    cwd,
    session_id: session,
    hook_event_name: 'PostToolUse',
    tool_name: tool,
    tool_input: tool === 'Edit'
      ? { file_path: file, new_string: content }
      : { file_path: file, content },
  };
  const r = spawnSync('bash', [BIN, 'post-tool', '--host', 'claude-code'], {
    input: JSON.stringify(payload),
    env: env(home, stub),
    encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0, `exit 0 expected (fail-open): ${r.stderr}`);
  return r.stdout;
}

function journal(home, session = 's1') {
  const p = path.join(home, 'journal', `${session}.jsonl`);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

function llmCalls(home) {
  const dir = path.join(home, 'journal', 'llm-calls');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap((f) =>
    fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  );
}

test('prose .md write outside the graph fires a nudge with the extracted fact', () => {
  const { home, cwd } = scratch();
  const file = path.join(cwd, 'reports', 'findings.md');
  const out = postTool(home, cwd, FACT_STUB, { file, content: PROSE });
  const json = JSON.parse(out);
  assert.strictEqual(json.hookSpecificOutput.hookEventName, 'PostToolUse');
  const ctx = json.hookSpecificOutput.additionalContext;
  assert.match(ctx, /capture nudge/);
  assert.match(ctx, /1\. The retry-path approach was dismissed/);
  assert.match(ctx, /spor:defer/);
  // Fired nudge journaled for accept/dismiss correlation.
  const nudges = journal(home).filter((e) => e.tool === 'nudge');
  assert.strictEqual(nudges.length, 1);
  assert.strictEqual(nudges[0].file, file);
  assert.strictEqual(nudges[0].facts, 1);
  // LLM call recorded for the nightly review, template-versioned.
  const calls = llmCalls(home);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].source, 'nudge');
  assert.strictEqual(calls[0].template, 'nudge.md');
  assert.match(calls[0].template_sha, /^[0-9a-f]{12}$/);
  assert.strictEqual(calls[0].vars.FILE, file);
});

test('NOTHING response nudges nothing but still records the llm call', () => {
  const { home, cwd } = scratch();
  const out = postTool(home, cwd, NOTHING_STUB, {
    file: path.join(cwd, 'notes.md'),
    content: PROSE,
  });
  assert.strictEqual(out.trim(), '');
  assert.strictEqual(journal(home).filter((e) => e.tool === 'nudge').length, 0);
  const calls = llmCalls(home);
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0].response, /NOTHING/);
});

test('cooldown: a file is classified at most once per session', () => {
  const { home, cwd } = scratch();
  const file = path.join(cwd, 'doc.md');
  postTool(home, cwd, FACT_STUB, { file, content: PROSE });
  const again = postTool(home, cwd, FACT_STUB, { file, content: PROSE });
  assert.strictEqual(again.trim(), '');
  assert.strictEqual(llmCalls(home).length, 1); // second write never reached the classifier
});

test('cap: after 3 fired nudges the classifier stops for the session', () => {
  const { home, cwd } = scratch();
  for (let i = 0; i < 4; i++) {
    postTool(home, cwd, FACT_STUB, { file: path.join(cwd, `doc${i}.md`), content: PROSE });
  }
  assert.strictEqual(llmCalls(home).length, 3);
  assert.strictEqual(journal(home).filter((e) => e.tool === 'nudge').length, 3);
});

test('prefilter: non-md, graph-home, /nodes/, instruction files, and short prose are skipped', () => {
  const { home, cwd } = scratch();
  const cases = [
    { file: path.join(cwd, 'app.js'), content: PROSE },
    { file: path.join(home, 'cache.md'), content: PROSE },            // under SUBSTRATE_HOME
    { file: path.join(cwd, 'nodes', 'task-x.md'), content: PROSE },   // a graph repo's nodes/
    { file: path.join(cwd, 'CLAUDE.md'), content: PROSE },
    { file: path.join(cwd, 'tiny.md'), content: 'too few words here' },
  ];
  for (const c of cases) {
    const out = postTool(home, cwd, FACT_STUB, c);
    assert.strictEqual(out.trim(), '', `expected no nudge for ${c.file}`);
  }
  assert.strictEqual(llmCalls(home).length, 0); // none reached the classifier
  // ...but file touches were still journaled (nudge never eats journaling).
  assert.strictEqual(journal(home).filter((e) => e.file).length, cases.length);
});

test('Edit new_string is classified like Write content', () => {
  const { home, cwd } = scratch();
  const out = postTool(home, cwd, FACT_STUB, {
    file: path.join(cwd, 'report.md'),
    content: PROSE,
    tool: 'Edit',
  });
  assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /retry-path/);
});

test('SUBSTRATE_NUDGE=0 disables the nudge entirely', () => {
  const { home, cwd } = scratch();
  const payload = {
    cwd, session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Write',
    tool_input: { file_path: path.join(cwd, 'doc.md'), content: PROSE },
  };
  const e = env(home, FACT_STUB);
  e.SUBSTRATE_NUDGE = '0';
  const r = spawnSync('bash', [BIN, 'post-tool', '--host', 'claude-code'], {
    input: JSON.stringify(payload), env: e, encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '');
  assert.strictEqual(llmCalls(home).length, 0);
});

test('headless guard: SUBSTRATE_DISTILLING suppresses the nudge', () => {
  const { home, cwd } = scratch();
  const payload = {
    cwd, session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Write',
    tool_input: { file_path: path.join(cwd, 'doc.md'), content: PROSE },
  };
  const e = env(home, FACT_STUB);
  e.SUBSTRATE_DISTILLING = '1';
  const r = spawnSync('bash', [BIN, 'post-tool', '--host', 'claude-code'], {
    input: JSON.stringify(payload), env: e, encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '');
});

test('fail-open: a dying classifier exits 0, no output, error journaled', () => {
  const { home, cwd } = scratch();
  const out = postTool(home, cwd, 'cat >/dev/null; exit 7', {
    file: path.join(cwd, 'doc.md'),
    content: PROSE,
  });
  assert.strictEqual(out.trim(), '');
  const calls = llmCalls(home);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].response, null);
  assert.match(calls[0].error, /failed/);
  // The failed file still lands in cooldown state — no retry storm.
  const again = postTool(home, cwd, FACT_STUB, { file: path.join(cwd, 'doc.md'), content: PROSE });
  assert.strictEqual(again.trim(), '');
  assert.strictEqual(llmCalls(home).length, 1);
});

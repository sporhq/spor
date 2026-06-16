// bin/spor-hook — host-agnostic dispatcher over the scripts/ engines.
// Everything runs against a throwaway graph home in local mode; the
// distiller backend is stubbed via the DISTILL_CMD env. Most tests drive the
// legacy SUBSTRATE_* env spelling on purpose — the dual-read window
// (SPLIT.md) must keep it working; the SPOR_* arm and the substrate-hook
// stub get their own tests.
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'bin', 'spor-hook');
const LEGACY_BIN = path.join(__dirname, '..', 'bin', 'substrate-hook');

function freshEnv(home) {
  const env = { ...process.env, SUBSTRATE_HOME: home };
  for (const k of Object.keys(env)) {
    if (k.startsWith('SUBSTRATE_') && k !== 'SUBSTRATE_HOME') delete env[k];
    if (k.startsWith('SPOR_')) delete env[k];
  }
  // Spor is opt-in per repo (task-spor-plugin-opt-in-default); the scratch cwd
  // carries no .spor marker, so opt it in via the cascade or every hook no-ops.
  env.SPOR_ENABLED = '1';
  return env;
}

// One scratch area per test: SUBSTRATE_HOME with a nodes/ dir, plus a fake
// project cwd named projx (not a git repo, so the slug is its basename).
function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'substrate-hookcli-'));
  const home = path.join(root, 'graph');
  fs.mkdirSync(path.join(home, 'nodes'), { recursive: true });
  const cwd = path.join(root, 'projx');
  fs.mkdirSync(cwd);
  return { root, home, cwd };
}

function run(args, input, env) {
  const r = spawnSync('bash', [BIN, ...args], { input, env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `exit 0 expected (fail-open): ${r.stderr}`);
  return r.stdout;
}

const BRIEF = `---
id: brief-projx
type: briefing
project: projx
title: Standing briefing for projx
summary: Test briefing.
version: 3
---

The projx standing briefing body.
`;

test('session-start: local briefing in claude-code envelope', () => {
  const { home, cwd } = scratch();
  fs.writeFileSync(path.join(home, 'nodes', 'brief-projx.md'), BRIEF);
  const out = run(
    ['session-start', '--host', 'claude-code'],
    JSON.stringify({ cwd, hook_event_name: 'SessionStart' }),
    freshEnv(home)
  );
  const json = JSON.parse(out);
  assert.strictEqual(json.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(json.hookSpecificOutput.additionalContext, /brief-projx v3/);
  assert.match(json.hookSpecificOutput.additionalContext, /projx standing briefing body/);
});

test('session-start: a git repo with graph content but no repo node gets an ungrouped identity node (issue-spor-onboard-no-repo-identity-node)', () => {
  const { home, cwd } = scratch();
  gitCommit(cwd); // make cwd a real git repo so repoFingerprints() is non-empty
  // graph content stamped under the slug (projx), but no type:repo node yet
  fs.writeFileSync(path.join(home, 'nodes', 'task-x.md'), `---
id: task-x
type: task
repo: projx
title: A task in projx
summary: Standalone summary giving projx graph content before its identity node exists.
status: open
date: 2026-06-15
---
Some work in projx.
`);
  const repoFile = path.join(home, 'nodes', 'repo-projx.md');
  assert.ok(!fs.existsSync(repoFile), 'precondition: no repo node yet');

  run(['session-start', '--host', 'claude-code'], JSON.stringify({ cwd, hook_event_name: 'SessionStart' }), freshEnv(home));

  assert.ok(fs.existsSync(repoFile), 'repo identity node was not registered');
  const raw = fs.readFileSync(repoFile, 'utf8');
  assert.match(raw, /^type: repo$/m);
  assert.match(raw, /^slugs: \[projx\]$/m);
  assert.match(raw, /^fingerprints: \[root:[0-9a-f]{40}.*\]$/m);
  assert.ok(!/^edges:/m.test(raw), 'new repo must start ungrouped (no edges block)');

  // Idempotent: a second run does not clobber or duplicate it.
  const before = fs.readFileSync(repoFile, 'utf8');
  run(['session-start', '--host', 'claude-code'], JSON.stringify({ cwd, hook_event_name: 'SessionStart' }), freshEnv(home));
  assert.strictEqual(fs.readFileSync(repoFile, 'utf8'), before, 'repo node must not be rewritten on re-run');
});

test('session-start: a non-git cwd does NOT get a repo identity node (no fingerprints)', () => {
  const { home, cwd } = scratch(); // cwd is not a git repo
  fs.writeFileSync(path.join(home, 'nodes', 'task-y.md'), `---
id: task-y
type: task
repo: projx
title: A task
summary: projx has content but cwd is not a git repo, so there are no fingerprints to register.
status: open
date: 2026-06-15
---
body
`);
  run(['session-start', '--host', 'claude-code'], JSON.stringify({ cwd, hook_event_name: 'SessionStart' }), freshEnv(home));
  assert.ok(!fs.existsSync(path.join(home, 'nodes', 'repo-projx.md')), 'no fingerprints => no identity node');
});

test('session-start: an empty local graph emits the onboarding line, not "0 nodes" (issue-cc-local-mode-session-start-empty-graph-fallback)', () => {
  const { home, cwd } = scratch(); // nodes/ dir exists but is empty
  const out = run(
    ['session-start', '--host', 'claude-code'],
    JSON.stringify({ cwd, hook_event_name: 'SessionStart' }),
    freshEnv(home)
  );
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
  assert.match(ctx, /No Spor briefing for projx yet/);
  assert.match(ctx, /\/spor:backfill/);
  assert.ok(!/0 nodes/.test(ctx), 'must not claim "0 nodes active" during onboarding');
});

test('session-start: a graph home with no nodes/ dir emits the onboarding line, not silence (the claude --bg backfill repro)', () => {
  const { cwd } = scratch();
  const home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'substrate-nodir-')), 'graph'); // never created → no nodes/ dir
  const out = run(
    ['session-start', '--host', 'claude-code'],
    JSON.stringify({ cwd, hook_event_name: 'SessionStart' }),
    freshEnv(home)
  );
  assert.notStrictEqual(out.trim(), '', 'onboarding home must not be silent');
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
  assert.match(ctx, /No Spor briefing for projx yet/);
  assert.match(ctx, /\/spor:backfill/);
});

test('session-start: no brief-<slug> node falls back to an auto-compiled project digest', () => {
  const { home, cwd } = scratch();
  // project-tagged nodes but NO brief-projx node, and a foreign-project node
  // so tf-idf is non-degenerate and project scoping is observable.
  fs.writeFileSync(path.join(home, 'nodes', 'dec-ledger.md'), `---
id: dec-ledger
type: decision
project: projx
title: Use event sourcing for the ledger
summary: The ledger service uses event sourcing with a Kafka log for audit.
date: 2026-06-01
---
We chose event sourcing for the ledger to get a replayable audit trail.
`);
  fs.writeFileSync(path.join(home, 'nodes', 'task-replay.md'), `---
id: task-replay
type: task
project: projx
title: Build the ledger replay tool
summary: Tooling to replay the Kafka event log and rebuild ledger projections.
date: 2026-06-05
edges:
  - {type: derived-from, to: dec-ledger}
---
Build a CLI that replays the event-sourced ledger log.
`);
  fs.writeFileSync(path.join(home, 'nodes', 'dec-elsewhere.md'), `---
id: dec-elsewhere
type: decision
project: otherproj
title: Marketing site framework
summary: Picked Svelte for the unrelated marketing site.
date: 2026-06-01
---
Svelte marketing site decision, nothing to do with the ledger.
`);
  const out = run(
    ['session-start', '--host', 'claude-code'],
    JSON.stringify({ cwd, hook_event_name: 'SessionStart' }),
    freshEnv(home)
  );
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
  assert.match(ctx, /Project digest for projx \(auto-compiled/);
  assert.match(ctx, /dec-ledger/);
  assert.ok(!/Standing project briefing/.test(ctx), 'no standing briefing should be claimed');
  assert.ok(!/dec-elsewhere/.test(ctx), 'foreign-project node must not leak into the project digest');
});

test('session-start: a brief-<slug> node still wins over the fallback digest', () => {
  const { home, cwd } = scratch();
  fs.writeFileSync(path.join(home, 'nodes', 'brief-projx.md'), BRIEF);
  fs.writeFileSync(path.join(home, 'nodes', 'dec-ledger.md'), `---
id: dec-ledger
type: decision
project: projx
title: Use event sourcing for the ledger
summary: The ledger service uses event sourcing with a Kafka log for audit.
date: 2026-06-01
---
We chose event sourcing for the ledger.
`);
  const out = run(
    ['session-start', '--host', 'claude-code'],
    JSON.stringify({ cwd, hook_event_name: 'SessionStart' }),
    freshEnv(home)
  );
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
  assert.match(ctx, /Standing project briefing \(brief-projx v3/);
  assert.ok(!/Project digest for projx \(auto-compiled/.test(ctx), 'fallback must not fire when a brief exists');
});

test('envelope echoes the host event name from the payload (gemini BeforeAgent)', () => {
  const { home, cwd } = scratch();
  fs.writeFileSync(path.join(home, 'nodes', 'brief-projx.md'), BRIEF);
  const out = run(
    ['session-start', '--host', 'gemini'],
    JSON.stringify({ cwd, hook_event_name: 'BeforeAgent' }),
    freshEnv(home)
  );
  const json = JSON.parse(out);
  assert.strictEqual(json.hookSpecificOutput.hookEventName, 'BeforeAgent');
});

test('prompt-context: trivial prompts inject nothing', () => {
  const { home, cwd } = scratch();
  fs.writeFileSync(path.join(home, 'nodes', 'brief-projx.md'), BRIEF);
  const out = run(
    ['prompt-context', '--host', 'codex'],
    JSON.stringify({ cwd, prompt: 'thanks', hook_event_name: 'UserPromptSubmit' }),
    freshEnv(home)
  );
  assert.strictEqual(out, '');
});

test('post-tool: journals the touched file under the session id', () => {
  const { home, cwd } = scratch();
  run(
    ['post-tool', '--host', 'claude-code'],
    JSON.stringify({
      cwd, session_id: 'sess-a', tool_name: 'Write',
      tool_input: { file_path: '/x/y.js' }, hook_event_name: 'PostToolUse',
    }),
    freshEnv(home)
  );
  const line = JSON.parse(fs.readFileSync(path.join(home, 'journal', 'sess-a.jsonl'), 'utf8').trim());
  assert.strictEqual(line.file, '/x/y.js');
  assert.strictEqual(line.project, 'projx');
  assert.strictEqual(line.tool, 'Write');
});

// --- opt-in gate (task-spor-plugin-opt-in-default): the dispatcher no-ops every
// hook in a repo that hasn't opted in (no .spor/.spor.json marker, no enable
// flag), so running an agent in an unrelated repo injects nothing and writes
// nothing — even with a brief node present and a non-trivial prompt.
test('opt-in gate: a markerless repo with no enable flag is a full no-op', () => {
  const { home, cwd } = scratch();
  fs.writeFileSync(path.join(home, 'nodes', 'brief-projx.md'), BRIEF);
  const bare = freshEnv(home);
  delete bare.SPOR_ENABLED; // remove the opt-in the helper adds

  // session-start and prompt-context emit nothing (exit 0, empty stdout)
  assert.strictEqual(
    run(['session-start', '--host', 'claude-code'],
      JSON.stringify({ cwd, hook_event_name: 'SessionStart' }), bare),
    '', 'session-start no-ops when not opted in');
  assert.strictEqual(
    run(['prompt-context', '--host', 'claude-code'],
      JSON.stringify({ cwd, prompt: 'six or more words to clear the gate', hook_event_name: 'UserPromptSubmit' }), bare),
    '', 'prompt-context no-ops when not opted in');

  // post-tool has no side effect: no per-session journal line is written
  run(['post-tool', '--host', 'claude-code'],
    JSON.stringify({ cwd, session_id: 'gate-s', tool_name: 'Write',
      tool_input: { file_path: '/x/y.js' }, hook_event_name: 'PostToolUse' }), bare);
  assert.ok(!fs.existsSync(path.join(home, 'journal', 'gate-s.jsonl')),
    'post-tool writes no journal when not opted in');

  // dropping a .spor marker into the cwd flips the SAME bare env on
  fs.writeFileSync(path.join(cwd, '.spor'), 'repo: projx\n');
  const out = run(['session-start', '--host', 'claude-code'],
    JSON.stringify({ cwd, hook_event_name: 'SessionStart' }), bare);
  assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /brief-projx/,
    'a .spor marker opts the repo in');
});

test('post-tool: codex tool_input.path is normalized to file_path', () => {
  const { home, cwd } = scratch();
  run(
    ['post-tool', '--host', 'codex'],
    JSON.stringify({
      cwd, session_id: 'sess-b', tool_name: 'apply_patch',
      tool_input: { path: '/x/z.js' }, hook_event_name: 'PostToolUse',
    }),
    freshEnv(home)
  );
  const line = JSON.parse(fs.readFileSync(path.join(home, 'journal', 'sess-b.jsonl'), 'utf8').trim());
  assert.strictEqual(line.file, '/x/z.js');
});

test('post-tool: tool calls without a file path are skipped, not journaled', () => {
  const { home, cwd } = scratch();
  run(
    ['post-tool', '--host', 'codex'],
    JSON.stringify({
      cwd, session_id: 'sess-c', tool_name: 'shell',
      tool_input: { command: 'ls' }, hook_event_name: 'PostToolUse',
    }),
    freshEnv(home)
  );
  assert.ok(!fs.existsSync(path.join(home, 'journal', 'sess-c.jsonl')));
});

const STUB_RESPONSE = `===NODE dec-test-hookcli.md===
---
id: dec-test-hookcli
type: decision
project: projx
title: Test decision
summary: A decision emitted by the stubbed distiller backend.
date: 2026-06-11
---

Body of the stub decision.
===END===
`;

function makeStub(root) {
  const stub = path.join(root, 'stub-distill.sh');
  const resp = path.join(root, 'stub-response.txt');
  fs.writeFileSync(resp, STUB_RESPONSE);
  fs.writeFileSync(stub, `#!/bin/sh\ncat > /dev/null\ncat "${resp}"\n`);
  fs.chmodSync(stub, 0o755);
  return stub;
}

function words(n, w) {
  return Array.from({ length: n }, (_, i) => `${w}${i}`).join(' ');
}

test('distill: SUBSTRATE_DISTILL_CMD replaces the claude backend (claude transcript)', () => {
  const { root, home, cwd } = scratch();
  const transcript = path.join(root, 'transcript.jsonl');
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: words(60, 'alpha') }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: words(60, 'beta') }] } }),
  ].join('\n') + '\n');
  const env = freshEnv(home);
  env.SUBSTRATE_DISTILL_CMD = makeStub(root);
  run(
    ['distill', '--host', 'claude-code'],
    JSON.stringify({ cwd, session_id: 'sess-d', transcript_path: transcript, hook_event_name: 'SessionEnd' }),
    env
  );
  const node = fs.readFileSync(path.join(home, 'nodes', 'dec-test-hookcli.md'), 'utf8');
  assert.match(node, /id: dec-test-hookcli/);
  const llmDir = path.join(home, 'journal', 'llm-calls');
  const rec = JSON.parse(fs.readFileSync(path.join(llmDir, fs.readdirSync(llmDir)[0]), 'utf8').trim());
  assert.ok(rec.backend.startsWith('cmd:'), `backend records the cmd: ${rec.backend}`);
  assert.ok(rec.response.includes('dec-test-hookcli'));
});

test('distill: non-claude transcript shapes fall back to generic .text extraction', () => {
  const { root, home, cwd } = scratch();
  const transcript = path.join(root, 'rollout.json');
  fs.writeFileSync(transcript, JSON.stringify({
    history: [{ entry: { text: words(50, 'gamma') } }, { entry: { text: words(50, 'delta') } }],
  }));
  const env = freshEnv(home);
  env.SUBSTRATE_DISTILL_CMD = makeStub(root);
  run(
    ['distill', '--host', 'codex'],
    JSON.stringify({ cwd, session_id: 'sess-e', transcript_path: transcript, hook_event_name: 'Stop' }),
    env
  );
  assert.ok(fs.existsSync(path.join(home, 'nodes', 'dec-test-hookcli.md')));
  const llmDir = path.join(home, 'journal', 'llm-calls');
  const rec = JSON.parse(fs.readFileSync(path.join(llmDir, fs.readdirSync(llmDir)[0]), 'utf8').trim());
  assert.match(rec.vars.CONVO, /gamma1/);
});

test('cursor session-start: payload mapped, output is flat {additional_context}', () => {
  const { home, cwd } = scratch();
  fs.writeFileSync(path.join(home, 'nodes', 'brief-projx.md'), BRIEF);
  const out = run(
    ['session-start', '--host', 'cursor'],
    JSON.stringify({ conversation_id: 'conv-1', workspace_roots: [cwd], hook_event_name: 'sessionStart' }),
    freshEnv(home)
  );
  const json = JSON.parse(out);
  assert.strictEqual(json.hookSpecificOutput, undefined, 'no claude envelope for cursor');
  assert.match(json.additional_context, /projx standing briefing body/);
});

test('cursor afterFileEdit: file_path synthesized into tool_input, keyed by conversation_id', () => {
  const { home, cwd } = scratch();
  run(
    ['post-tool', '--host', 'cursor'],
    JSON.stringify({ conversation_id: 'conv-2', workspace_roots: [cwd], file_path: '/x/c.ts', hook_event_name: 'afterFileEdit' }),
    freshEnv(home)
  );
  const line = JSON.parse(fs.readFileSync(path.join(home, 'journal', 'conv-2.jsonl'), 'utf8').trim());
  assert.strictEqual(line.file, '/x/c.ts');
  assert.strictEqual(line.tool, 'edit');
});

test('copilot postToolUse: camelCase payload and toolArgs.path normalized', () => {
  const { home, cwd } = scratch();
  run(
    ['post-tool', '--host', 'copilot'],
    JSON.stringify({ sessionId: 'sess-g', cwd, toolName: 'write', toolArgs: { path: '/x/d.js' }, hook_event_name: 'postToolUse' }),
    freshEnv(home)
  );
  const line = JSON.parse(fs.readFileSync(path.join(home, 'journal', 'sess-g.jsonl'), 'utf8').trim());
  assert.strictEqual(line.file, '/x/d.js');
  assert.strictEqual(line.tool, 'write');
});

test('copilot distill: transcriptPath mapped to transcript_path', () => {
  const { root, home, cwd } = scratch();
  const transcript = path.join(root, 'transcript.jsonl');
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: words(60, 'iota') }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: words(60, 'kappa') }] } }),
  ].join('\n') + '\n');
  const env = freshEnv(home);
  env.SUBSTRATE_DISTILL_CMD = makeStub(root);
  run(
    ['distill', '--host', 'copilot'],
    JSON.stringify({ sessionId: 'sess-h', cwd, transcriptPath: transcript, hook_event_name: 'agentStop' }),
    env
  );
  assert.ok(fs.existsSync(path.join(home, 'nodes', 'dec-test-hookcli.md')));
});

test('agents-md as a hook: cwd read from the stdin payload', () => {
  const { home, cwd } = scratch();
  fs.writeFileSync(path.join(home, 'nodes', 'brief-projx.md'), BRIEF);
  const out = run(['agents-md'], JSON.stringify({ cwd, hook_event_name: 'sessionStart' }), freshEnv(home));
  assert.strictEqual(out, '', 'hook stdout stays clean');
  const md = fs.readFileSync(path.join(cwd, 'AGENTS.md'), 'utf8');
  assert.match(md, /projx standing briefing body/);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('distill --debounce: spools, returns immediately, distills after quiesce', async () => {
  const { root, home, cwd } = scratch();
  const transcript = path.join(root, 'transcript.jsonl');
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: words(60, 'epsilon') }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: words(60, 'zeta') }] } }),
  ].join('\n') + '\n');
  const env = freshEnv(home);
  env.SUBSTRATE_DISTILL_CMD = makeStub(root);
  const t0 = Date.now();
  run(
    ['distill', '--host', 'codex', '--debounce', '1'],
    JSON.stringify({ cwd, session_id: 'sess-f', transcript_path: transcript, hook_event_name: 'Stop' }),
    env
  );
  assert.ok(Date.now() - t0 < 5000, 'hook returns without waiting for the distill');
  const pending = path.join(home, 'journal', 'pending-distill', 'sess-f.json');
  assert.ok(fs.existsSync(pending), 'payload spooled');
  const node = path.join(home, 'nodes', 'dec-test-hookcli.md');
  for (let i = 0; i < 40 && !fs.existsSync(node); i++) await sleep(250);
  assert.ok(fs.existsSync(node), 'watcher ran the distill after quiesce');
  for (let i = 0; i < 20 && fs.existsSync(pending); i++) await sleep(250);
  assert.ok(!fs.existsSync(pending), 'spooled payload cleaned up');
  assert.ok(!fs.existsSync(`${pending.slice(0, -5)}.lock`), 'watcher lock released');
});

test('agents-md: creates and idempotently refreshes the managed section', () => {
  const { home, cwd } = scratch();
  fs.writeFileSync(path.join(home, 'nodes', 'brief-projx.md'), BRIEF);
  fs.writeFileSync(path.join(cwd, 'AGENTS.md'), '# projx\n\nExisting content.\n');
  const env = freshEnv(home);
  run(['agents-md', '--cwd', cwd], '', env);
  let md = fs.readFileSync(path.join(cwd, 'AGENTS.md'), 'utf8');
  assert.match(md, /Existing content/);
  assert.match(md, /<!-- spor:begin -->/);
  assert.match(md, /projx standing briefing body/);
  run(['agents-md', '--cwd', cwd], '', env);
  md = fs.readFileSync(path.join(cwd, 'AGENTS.md'), 'utf8');
  assert.strictEqual(md.match(/<!-- spor:begin -->/g).length, 1, 'refresh replaces, not appends');
});

test('agents-md: a pre-rename substrate-marker block is replaced, not duplicated', () => {
  const { home, cwd } = scratch();
  fs.writeFileSync(path.join(home, 'nodes', 'brief-projx.md'), BRIEF);
  fs.writeFileSync(
    path.join(cwd, 'AGENTS.md'),
    '# projx\n\n<!-- substrate:begin -->\nold managed block\n<!-- substrate:end -->\nTrailing content.\n'
  );
  run(['agents-md', '--cwd', cwd], '', freshEnv(home));
  const md = fs.readFileSync(path.join(cwd, 'AGENTS.md'), 'utf8');
  assert.match(md, /<!-- spor:begin -->/);
  assert.doesNotMatch(md, /old managed block/);
  assert.doesNotMatch(md, /<!-- substrate:begin -->/);
  assert.match(md, /Trailing content/);
});

// ---------------- post-tool commit linking (task-cc-commit-linking) ----------------

// Make cwd a git repo with one commit. trailers: array of node ids for the
// trailer (key `trailerKey`, default the current `Spor:`; pass `Substrate`
// to exercise the legacy back-compat read); ageSeconds backdates the
// committer date (the hook's freshness guard reads %ct).
function gitCommit(cwd, { trailers = [], ageSeconds = 0, message = 'work', trailerKey = 'Spor' } = {}) {
  const g = (args, env = {}) => {
    const r = spawnSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com', ...env,
      },
    });
    assert.strictEqual(r.status, 0, r.stderr);
    return r.stdout;
  };
  g(['init', '-q']);
  fs.writeFileSync(path.join(cwd, 'f.txt'), String(Math.random()));
  g(['add', 'f.txt']);
  const msg = message + (trailers.length ? '\n\n' + trailers.map((t) => `${trailerKey}: ${t}`).join('\n') : '');
  const date = new Date(Date.now() - ageSeconds * 1000).toISOString();
  g(['commit', '-q', '-m', msg], { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date });
  return g(['rev-parse', 'HEAD']).trim();
}

test('post-tool: a fresh git commit is journaled with its sha and trailer nodes', () => {
  const { home, cwd } = scratch();
  const sha = gitCommit(cwd, { trailers: ['task-cl-one', 'task-cl-two'] });
  run(
    ['post-tool', '--host', 'claude-code'],
    JSON.stringify({
      cwd, session_id: 'sess-g', tool_name: 'Bash',
      tool_input: { command: 'git commit -m work' }, hook_event_name: 'PostToolUse',
    }),
    freshEnv(home)
  );
  const line = JSON.parse(fs.readFileSync(path.join(home, 'journal', 'sess-g.jsonl'), 'utf8').trim());
  assert.strictEqual(line.tool, 'git-commit');
  assert.strictEqual(line.sha, sha);
  assert.strictEqual(line.project, 'projx');
  assert.deepStrictEqual(line.nodes, ['task-cl-one', 'task-cl-two']);
});

test('post-tool: a stale HEAD (failed or old commit) is not journaled', () => {
  const { home, cwd } = scratch();
  gitCommit(cwd, { ageSeconds: 300 });
  run(
    ['post-tool', '--host', 'claude-code'],
    JSON.stringify({
      cwd, session_id: 'sess-h', tool_name: 'Bash',
      tool_input: { command: 'git commit -m nope' }, hook_event_name: 'PostToolUse',
    }),
    freshEnv(home)
  );
  assert.ok(!fs.existsSync(path.join(home, 'journal', 'sess-h.jsonl')));
});

test('post-tool: non-commit commands are ignored even in a fresh repo', () => {
  const { home, cwd } = scratch();
  gitCommit(cwd);
  run(
    ['post-tool', '--host', 'claude-code'],
    JSON.stringify({
      cwd, session_id: 'sess-i', tool_name: 'Bash',
      tool_input: { command: 'ls -la' }, hook_event_name: 'PostToolUse',
    }),
    freshEnv(home)
  );
  assert.ok(!fs.existsSync(path.join(home, 'journal', 'sess-i.jsonl')));
});

// Stub substrate server: records every request, answers everything 200 with
// a body shaped well enough for both the briefing fetch and the stamp.
function stubServer() {
  const http = require('node:http');
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'updated', found: false, graph_status: { node_count: 0 } }));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () =>
    resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}

// async spawn — spawnSync would block the event loop and starve the stub
// server while the hook's curl waits on it.
function runAsync(args, input, env) {
  const { spawn } = require('node:child_process');
  return new Promise((resolve, reject) => {
    const c = spawn('bash', [BIN, ...args], { env, stdio: ['pipe', 'ignore', 'ignore'] });
    c.on('error', reject);
    c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    c.stdin.end(input);
  });
}

test('post-tool: remote mode stamps trailered commits, range-scans past a parallel commit, marker makes re-runs no-ops', async () => {
  const { home, cwd } = scratch();
  // remote mode must not require a local graph dir (same gate as distill)
  fs.rmSync(path.join(home, 'nodes'), { recursive: true });
  // two commits land before the hook fires — the second simulates a parallel
  // session advancing HEAD past ours; both must be journaled and stamped.
  // sha1 uses the current `Spor:` trailer; sha2 uses the legacy `Substrate:`
  // key, so this also pins the dual-read back-compat path.
  const sha1 = gitCommit(cwd, { trailers: ['task-cl-mine'], message: 'mine' });
  const sha2 = gitCommit(cwd, { trailers: ['task-cl-theirs'], message: 'theirs', trailerKey: 'Substrate' });
  const { srv, hits, base } = await stubServer();
  try {
    const env = freshEnv(home);
    env.SUBSTRATE_SERVER = base;
    env.SUBSTRATE_TOKEN = 'sub_pat_test';
    const payload = JSON.stringify({
      cwd, session_id: 'sess-j', tool_name: 'Bash',
      tool_input: { command: 'git commit -m mine' }, hook_event_name: 'PostToolUse',
    });
    await runAsync(['post-tool', '--host', 'claude-code'], payload, env);
    const stamped = hits.map((h) => [h.url, JSON.parse(h.body).sha]).sort();
    assert.deepStrictEqual(stamped, [
      ['/v1/nodes/task-cl-mine/commits', sha1],
      ['/v1/nodes/task-cl-theirs/commits', sha2],
    ].sort());
    assert.strictEqual(hits[0].auth, 'Bearer sub_pat_test');
    assert.ok(hits.every((h) => JSON.parse(h.body).repo === 'projx'));
    // journaled too, even in remote mode (no local nodes/ dir required)
    const lines = fs.readFileSync(path.join(home, 'journal', 'sess-j.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l));
    assert.deepStrictEqual(lines.map((l) => l.sha).sort(), [sha1, sha2].sort());
    assert.deepStrictEqual(lines.find((l) => l.sha === sha1).nodes, ['task-cl-mine']);
    // marker: a second invocation scans marker..HEAD (empty) — no new stamps
    const before = hits.length;
    await runAsync(['post-tool', '--host', 'claude-code'], payload, env);
    assert.strictEqual(hits.length, before);
  } finally {
    srv.close();
  }
});

test('session-start: detached catch-up stamps commits made outside any session', async () => {
  const { home, cwd } = scratch();
  const sha = gitCommit(cwd, { trailers: ['task-cl-outside'] });
  const { srv, hits, base } = await stubServer();
  try {
    const env = freshEnv(home);
    env.SUBSTRATE_SERVER = base;
    env.SUBSTRATE_TOKEN = 'sub_pat_test';
    await runAsync(
      ['session-start', '--host', 'claude-code'],
      JSON.stringify({ cwd, hook_event_name: 'SessionStart' }),
      env
    );
    // the catch-up is detached from the hook; poll for its stamp
    const deadline = Date.now() + 8000;
    let stamp;
    while (!stamp && Date.now() < deadline) {
      stamp = hits.find((h) => h.method === 'POST' && h.url === '/v1/nodes/task-cl-outside/commits');
      if (!stamp) await sleep(100);
    }
    assert.ok(stamp, `catch-up never stamped; hits: ${JSON.stringify(hits.map((h) => h.url))}`);
    assert.deepStrictEqual(JSON.parse(stamp.body), { repo: 'projx', sha });
  } finally {
    srv.close();
  }
});

// A stub server that answers every request with a fixed HTTP status (and a
// minimal JSON body), for the fail-open banner tests below.
function statusServer(code) {
  const http = require('node:http');
  const srv = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () =>
    resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` })));
}

// issue-cc-auth-transport-conflation-silent-loss: a 401/403 on the briefing
// fetch must NOT masquerade as an OFFLINE outage. session-start must name the
// auth failure (so the user re-mints the token) while still failing open.
test('session-start: 401 surfaces an AUTH-FAILED banner, not OFFLINE (no cache)', async () => {
  const { home, cwd } = scratch();
  fs.rmSync(path.join(home, 'nodes'), { recursive: true });
  const { srv, base } = await statusServer(401);
  try {
    const env = freshEnv(home);
    env.SPOR_SERVER = base;
    env.SPOR_TOKEN = 'spor_pat_bad';
    let out = '';
    await runAsync2(['session-start', '--host', 'claude-code'],
      JSON.stringify({ cwd, hook_event_name: 'SessionStart' }), env, (s) => (out += s));
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    assert.match(ctx, /AUTH FAILED/);
    assert.match(ctx, /SPOR_TOKEN/);
    assert.doesNotMatch(ctx, /OFFLINE/);
    const log = fs.readFileSync(path.join(home, 'journal', 'remote.log'), 'utf8');
    assert.match(log, /auth failure \(http=401\)/);
  } finally {
    srv.close();
  }
});

test('session-start: a transport failure (000/dead port) still says OFFLINE, not AUTH', async () => {
  const { home, cwd } = scratch();
  // brief cache present so we get a body either way
  fs.mkdirSync(path.join(home, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(home, 'cache', 'brief-projx.md'),
    '<!-- spor cache: brief-projx version=2 fetched=2026-01-01 host=x -->\ncached body\n');
  const env = freshEnv(home);
  env.SPOR_SERVER = 'http://127.0.0.1:1'; // dead port
  env.SPOR_TOKEN = 'spor_pat_test';
  let out = '';
  await runAsync2(['session-start', '--host', 'claude-code'],
    JSON.stringify({ cwd, hook_event_name: 'SessionStart' }), env, (s) => (out += s));
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
  assert.match(ctx, /OFFLINE/);
  assert.doesNotMatch(ctx, /AUTH FAILED/);
});

// async spawn that captures stdout (runAsync above discards it).
function runAsync2(args, input, env, onData) {
  const { spawn } = require('node:child_process');
  return new Promise((resolve, reject) => {
    const c = spawn('bash', [BIN, ...args], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    c.stdout.on('data', (d) => onData(String(d)));
    c.on('error', reject);
    c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    c.stdin.end(input);
  });
}

// issue-cc-fail-open-degradation-telemetry-gap /
// task-cc-client-hook-operability-diagnostics piece 1: a crashing engine and a
// quiet success look identical from outside. The dispatcher's crash handler
// must append one line to journal/remote.log before honoring the fail-open
// exit-0 contract, so an operator can tell the two apart after the fact.
test('dispatcher: logCrash writes one line to remote.log and never throws', () => {
  const { home } = scratch();
  const prevHome = process.env.SPOR_HOME;
  const prevSub = process.env.SUBSTRATE_HOME;
  process.env.SPOR_HOME = home;
  delete process.env.SUBSTRATE_HOME;
  try {
    const { logCrash } = require('../bin/spor-hook.js');
    // Must not throw, even on a weird error value.
    assert.doesNotThrow(() => logCrash(new Error('boom in engine')));
    assert.doesNotThrow(() => logCrash('a bare string'));
    const log = fs.readFileSync(path.join(home, 'journal', 'remote.log'), 'utf8');
    assert.match(log, /dispatcher .*crashed \(fail-open, exit 0\):.*boom in engine/);
    // Only the first line of a multi-line stack is logged (one line per crash).
    assert.strictEqual(log.trim().split('\n').length, 2);
  } finally {
    if (prevHome === undefined) delete process.env.SPOR_HOME; else process.env.SPOR_HOME = prevHome;
    if (prevSub !== undefined) process.env.SUBSTRATE_HOME = prevSub;
  }
});

// ---------------------------------------------------------------------------
// Spor rename (SPLIT.md): the SPOR_* env arm, and the substrate-hook stub.
// ---------------------------------------------------------------------------

test('rename: SPOR_HOME drives the graph home (no SUBSTRATE_HOME set)', () => {
  const { home, cwd } = scratch();
  fs.writeFileSync(path.join(home, 'nodes', 'brief-projx.md'), BRIEF);
  const env = freshEnv(home);
  delete env.SUBSTRATE_HOME;
  env.SPOR_HOME = home;
  const out = run(
    ['session-start', '--host', 'claude-code'],
    JSON.stringify({ cwd, hook_event_name: 'SessionStart' }),
    env
  );
  assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /brief-projx v3/);
});

test('rename: SPOR_HOME wins over a stale SUBSTRATE_HOME', () => {
  const { home, cwd } = scratch();
  const decoy = scratch().home; // empty graph — must NOT be used
  fs.writeFileSync(path.join(home, 'nodes', 'brief-projx.md'), BRIEF);
  const env = freshEnv(decoy);
  env.SPOR_HOME = home;
  const out = run(
    ['session-start', '--host', 'claude-code'],
    JSON.stringify({ cwd, hook_event_name: 'SessionStart' }),
    env
  );
  assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /brief-projx v3/);
});

test('rename: the substrate-hook stub still dispatches (back-compat window)', () => {
  const { home, cwd } = scratch();
  fs.writeFileSync(path.join(home, 'nodes', 'brief-projx.md'), BRIEF);
  const r = spawnSync('bash', [LEGACY_BIN, 'session-start', '--host', 'claude-code'], {
    input: JSON.stringify({ cwd, hook_event_name: 'SessionStart' }),
    env: freshEnv(home),
    encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0, `exit 0 expected: ${r.stderr}`);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /brief-projx v3/);
});

test('rename: SPOR_DISTILL_CMD replaces the claude backend', () => {
  const { root, home, cwd } = scratch();
  const transcript = path.join(root, 'transcript.jsonl');
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: words(60, 'epsilon') }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: words(60, 'zeta') }] } }),
  ].join('\n') + '\n');
  const env = freshEnv(home);
  env.SPOR_DISTILL_CMD = makeStub(root);
  run(
    ['distill', '--host', 'claude-code'],
    JSON.stringify({ cwd, session_id: 'sess-spor', transcript_path: transcript, hook_event_name: 'SessionEnd' }),
    env
  );
  assert.ok(fs.existsSync(path.join(home, 'nodes', 'dec-test-hookcli.md')), 'distiller (SPOR_DISTILL_CMD) wrote no nodes');
});

// ---------------------------------------------------------------------------
// task-cc-client-hook-operability-diagnostics piece 3: `spor-hook doctor`, the
// client health surface (and piece 2: the session-start degradation nudge).
// ---------------------------------------------------------------------------

// Drop a dead-lettered capture into outbox/dead/ (the strand the fail-open path
// leaves behind — what both the nudge and doctor must surface).
function deadLetter(home, name) {
  fs.mkdirSync(path.join(home, 'outbox', 'dead'), { recursive: true });
  fs.writeFileSync(path.join(home, 'outbox', 'dead', name), '{}');
}

test('doctor (local): reports local mode, node count, and exits 0', () => {
  const { home, cwd } = scratch();
  fs.writeFileSync(path.join(home, 'nodes', 'a.md'), 'title: x\n');
  const out = run(['doctor', '--cwd', cwd], '', freshEnv(home));
  assert.match(out, /spor doctor/);
  assert.match(out, /mode:\s+local/);
  assert.match(out, /graph:\s+.*\(1 nodes\)/);
});

test('doctor (remote, 200): names the server, reachable, token valid', async () => {
  const { home, cwd } = scratch();
  const { srv, base } = await statusServer(200);
  try {
    const env = freshEnv(home);
    env.SPOR_SERVER = base;
    env.SPOR_TOKEN = 'spor_pat_good';
    let out = '';
    await runAsync2(['doctor', '--cwd', cwd], '', env, (s) => (out += s));
    assert.match(out, /mode:\s+remote/);
    assert.match(out, /server:\s+http:\/\/127\.0\.0\.1:/);
    assert.match(out, /reachable:\s+yes/);
    assert.match(out, /token:\s+valid/);
  } finally {
    srv.close();
  }
});

test('doctor (remote, 401): token REJECTED, not an outage', async () => {
  const { home, cwd } = scratch();
  const { srv, base } = await statusServer(401);
  try {
    const env = freshEnv(home);
    env.SPOR_SERVER = base;
    env.SPOR_TOKEN = 'spor_pat_bad';
    let out = '';
    await runAsync2(['doctor', '--cwd', cwd], '', env, (s) => (out += s));
    assert.match(out, /reachable:\s+yes/);
    assert.match(out, /token:\s+REJECTED \(http 401\)/);
    assert.doesNotMatch(out, /reachable:\s+NO/);
  } finally {
    srv.close();
  }
});

test('doctor (remote): surfaces dead-lettered captures with their count', async () => {
  const { home, cwd } = scratch();
  deadLetter(home, 'd1.capture.json');
  deadLetter(home, 'd2.capture.json');
  const { srv, base } = await statusServer(200);
  try {
    const env = freshEnv(home);
    env.SPOR_SERVER = base;
    env.SPOR_TOKEN = 'spor_pat_good';
    let out = '';
    await runAsync2(['doctor', '--cwd', cwd], '', env, (s) => (out += s));
    assert.match(out, /dead-letter:\s+2 in outbox\/dead\//);
    assert.match(out, /PERMANENT rejects/);
  } finally {
    srv.close();
  }
});

// Piece 2: the session-start nudge rides the SAME channel as the OFFLINE banner.
test('session-start (remote): a dead-lettered capture surfaces a nudge to run doctor', async () => {
  const { home, cwd } = scratch();
  deadLetter(home, 'd1.capture.json');
  const { srv, base } = await statusServer(200); // 200 + empty body => no-briefing path
  try {
    const env = freshEnv(home);
    env.SPOR_SERVER = base;
    env.SPOR_TOKEN = 'spor_pat_good';
    let out = '';
    await runAsync2(['session-start', '--host', 'claude-code'],
      JSON.stringify({ cwd, hook_event_name: 'SessionStart' }), env, (s) => (out += s));
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    assert.match(ctx, /dead-lettered in outbox\/dead\//);
    assert.match(ctx, /spor-hook doctor/);
  } finally {
    srv.close();
  }
});

test('session-start (remote): the nudge rides the OFFLINE banner when the server is unreachable', async () => {
  const { home, cwd } = scratch();
  deadLetter(home, 'd1.capture.json');
  const env = freshEnv(home);
  env.SPOR_SERVER = 'http://127.0.0.1:1'; // dead port, no cache
  env.SPOR_TOKEN = 'spor_pat_x';
  let out = '';
  await runAsync2(['session-start', '--host', 'claude-code'],
    JSON.stringify({ cwd, hook_event_name: 'SessionStart' }), env, (s) => (out += s));
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
  assert.match(ctx, /OFFLINE/);
  assert.match(ctx, /dead-lettered in outbox\/dead\//);
});

test('session-start (remote): a healthy outbox adds no nudge', async () => {
  const { home, cwd } = scratch();
  const { srv, base } = await statusServer(200);
  try {
    const env = freshEnv(home);
    env.SPOR_SERVER = base;
    env.SPOR_TOKEN = 'spor_pat_good';
    let out = '';
    await runAsync2(['session-start', '--host', 'claude-code'],
      JSON.stringify({ cwd, hook_event_name: 'SessionStart' }), env, (s) => (out += s));
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /dead-lettered/);
    assert.doesNotMatch(ctx, /spooled and undelivered/);
  } finally {
    srv.close();
  }
});

// Local-mode git-shared graph (issue-cc-local-mode-graph-sharing-gap): a `.spor`
// marker `graph:` key overrides SPOR_HOME and the home gets a .gitignore.
test('session-start: a `.spor` graph: marker overrides the env home and writes the shared .gitignore', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'substrate-share-'));
  const personal = path.join(root, 'personal'); // env SPOR_HOME — must be ignored
  const shared = path.join(root, 'shared'); // the per-repo graph the marker points at
  const code = path.join(root, 'code'); // the session cwd (slug "code")
  fs.mkdirSync(path.join(personal, 'nodes'), { recursive: true });
  fs.writeFileSync(path.join(personal, 'nodes', 'dec-decoy.md'), '---\nid: dec-decoy\ntype: decision\nproject: other\ntitle: decoy\n---\nbody\n');
  fs.mkdirSync(path.join(shared, 'nodes'), { recursive: true });
  fs.writeFileSync(
    path.join(shared, 'nodes', 'brief-code.md'),
    '---\nid: brief-code\ntype: briefing\nproject: code\ntitle: Shared briefing for code\nsummary: s\nversion: 9\n---\n\nThe shared-graph briefing body.\n'
  );
  fs.mkdirSync(code);
  fs.writeFileSync(path.join(code, '.spor'), 'repo: code\ngraph: ../shared\n');

  const out = run(
    ['session-start', '--host', 'claude-code'],
    JSON.stringify({ cwd: code, hook_event_name: 'SessionStart' }),
    freshEnv(personal)
  );
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
  // Briefing came from the SHARED home (the marker), not the personal env home.
  assert.match(ctx, /brief-code v9/);
  assert.match(ctx, /shared-graph briefing body/);
  assert.ok(ctx.includes(path.join(shared, 'nodes')), 'briefing should name the shared nodes dir');
  // The shared home got a .gitignore covering machine-local state.
  const gi = fs.readFileSync(path.join(shared, '.gitignore'), 'utf8');
  for (const ig of ['/journal/', '/cache/', '/outbox/', '/auth/', '/config.json']) {
    assert.ok(gi.includes(ig), `shared .gitignore missing ${ig}`);
  }
  // The personal env home was untouched (no .gitignore generated there).
  assert.ok(!fs.existsSync(path.join(personal, '.gitignore')), 'personal home must not get a .gitignore');
});

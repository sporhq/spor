// adapters/opencode/spor.js — the OpenCode plugin, loaded in-process
// against stubbed OpenCode surfaces. The plugin captures SUBSTRATE_HOME and
// SUBSTRATE_DEBOUNCE at import time, so env is pinned before the import and
// all tests share one scratch graph.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'substrate-opencode-'));
const HOME = path.join(ROOT, 'graph');
const CWD = path.join(ROOT, 'projx');
fs.mkdirSync(path.join(HOME, 'nodes'), { recursive: true });
fs.mkdirSync(CWD);
fs.writeFileSync(path.join(HOME, 'nodes', 'brief-projx.md'), `---
id: brief-projx
type: briefing
project: projx
title: Standing briefing for projx
summary: Test briefing.
version: 3
---

The projx standing briefing body.
`);

const STUB_RESPONSE = `===NODE dec-test-opencode.md===
---
id: dec-test-opencode
type: decision
project: projx
title: Test decision
summary: A decision emitted by the stubbed distiller backend.
date: 2026-06-11
---

Body of the stub decision.
===END===
`;
const stub = path.join(ROOT, 'stub-distill.sh');
fs.writeFileSync(path.join(ROOT, 'stub-response.txt'), STUB_RESPONSE);
fs.writeFileSync(stub, `#!/bin/sh\ncat > /dev/null\ncat "${path.join(ROOT, 'stub-response.txt')}"\n`);
fs.chmodSync(stub, 0o755);

process.env.SUBSTRATE_HOME = HOME;
process.env.SUBSTRATE_DEBOUNCE = '1';
process.env.SUBSTRATE_DISTILL_CMD = stub;
// Spor is opt-in per repo (task-spor-plugin-opt-in-default); the stub project
// dir carries no .spor marker, so opt it in via the cascade or distill no-ops.
process.env.SPOR_ENABLED = '1';
delete process.env.SUBSTRATE_SERVER;
delete process.env.SUBSTRATE_TOKEN;
delete process.env.SUBSTRATE_DISTILLING;
// Also clear the current SPOR_* spellings, or an ambient SPOR_SERVER/TOKEN on
// the host flips the engines into remote mode and the suite fails spuriously.
delete process.env.SPOR_SERVER;
delete process.env.SPOR_TOKEN;
delete process.env.SPOR_DISTILL_CMD;
delete process.env.SPOR_NUDGE_CMD;

const PLUGIN = path.join(__dirname, '..', 'adapters', 'opencode', 'spor.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const words = (n, w) => Array.from({ length: n }, (_, i) => `${w}${i}`).join(' ');

async function load(client) {
  const { SporPlugin } = await import(PLUGIN);
  return SporPlugin({ client, directory: CWD });
}

test('chat.message: briefing injected once per session as a synthetic part', async () => {
  const hooks = await load({});
  const parts = [{ type: 'text', text: 'please explain the substrate briefing for me' }];
  await hooks['chat.message']({ sessionID: 's1' }, { message: {}, parts });
  const synthetic = parts.filter((p) => p.synthetic);
  assert.ok(synthetic.length >= 1, 'a synthetic part was appended');
  assert.match(synthetic[0].text, /projx standing briefing body/);

  const parts2 = [{ type: 'text', text: 'a second message in this same session here' }];
  await hooks['chat.message']({ sessionID: 's1' }, { message: {}, parts: parts2 });
  assert.ok(!parts2.some((p) => p.synthetic && /standing briefing/i.test(p.text)),
    'briefing not re-injected for the same session');
});

test('tool.execute.after: write/edit journaled, other tools ignored', async () => {
  const hooks = await load({});
  await hooks['tool.execute.after'](
    { tool: 'write', sessionID: 's2', callID: 'c1', args: { filePath: '/x/y.js' } },
    { title: '', output: '', metadata: {} }
  );
  await hooks['tool.execute.after'](
    { tool: 'bash', sessionID: 's2', callID: 'c2', args: { command: 'ls' } },
    { title: '', output: '', metadata: {} }
  );
  const journal = fs.readFileSync(path.join(HOME, 'journal', 's2.jsonl'), 'utf8').trim().split('\n');
  assert.strictEqual(journal.length, 1, 'only the write call journaled');
  assert.strictEqual(JSON.parse(journal[0]).file, '/x/y.js');
});

test('session.idle: SDK transcript export feeds the debounced distiller', async () => {
  const client = {
    session: {
      messages: async () => ({
        data: [
          { info: { role: 'user' }, parts: [{ type: 'text', text: words(60, 'eta') }] },
          { info: { role: 'assistant' }, parts: [{ type: 'text', text: words(60, 'theta') }] },
        ],
      }),
    },
  };
  const hooks = await load(client);
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 's3' } } });

  const transcript = path.join(HOME, 'journal', 'opencode-s3.transcript.jsonl');
  assert.ok(fs.existsSync(transcript), 'transcript exported');
  const first = JSON.parse(fs.readFileSync(transcript, 'utf8').trim().split('\n')[0]);
  assert.strictEqual(first.type, 'user');
  assert.match(first.message.content[0].text, /eta1/);

  const node = path.join(HOME, 'nodes', 'dec-test-opencode.md');
  for (let i = 0; i < 40 && !fs.existsSync(node); i++) await sleep(250);
  assert.ok(fs.existsSync(node), 'debounced distill produced the node');
});

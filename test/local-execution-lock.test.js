require('./helpers/tmp-cleanup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const store = require('../lib/shell/execution-store');
const lockModule = require.resolve('../lib/shell/local-execution-lock');
const engineModule = require.resolve('../lib/shell/execution-store');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFile(file) { for (let n = 0; n < 300; n++) { if (fs.existsSync(file)) return; await delay(10); } throw new Error(`timed out waiting for ${file}`); }
function child(code, args) {
  const proc = spawn(process.execPath, ['-e', code, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  proc.stdout.on('data', b => out += b); proc.stderr.on('data', b => err += b);
  const done = once(proc, 'exit').then(([code, signal]) => ({ code, signal, out, err }));
  return { proc, done };
}
function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-local-lock-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('separate local openers serialize the entire pin and initial journal transaction', async t => {
  const home = setup(t), entered = path.join(home, 'entered'), release = path.join(home, 'release');
  const code = `const fs=require('fs');const st=require(process.argv[1]);const home=process.argv[2];const label=process.argv[3];const e=st.localExecutionEngine({home,worker:label,machine:label,pinRead:()=>{if(label==='first'){fs.writeFileSync(process.argv[4],'');while(!fs.existsSync(process.argv[5]))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}return {revision:label};}});e.open({node_id:'task-lock',factory:'factory-lock',gates:[]}).then(r=>process.stdout.write(JSON.stringify(r)));`;
  const a = child(code, [engineModule, home, 'first', entered, release]); t.after(() => a.proc.kill('SIGKILL'));
  await waitFile(entered);
  const b = child(code, [engineModule, home, 'second', entered, release]); t.after(() => b.proc.kill('SIGKILL'));
  const lock = `${store.itemPath(home, 'local', 'task-lock')}.lock`;
  const old = new Date(0); fs.utimesSync(lock, old, old);
  await delay(150); assert.equal(b.proc.exitCode, null, 'old mtime cannot revoke a live writer');
  fs.writeFileSync(release, '');
  const [ar, br] = await Promise.all([a.done, b.done]);
  assert.equal(ar.code, 0, ar.err); assert.equal(br.code, 0, br.err);
  const first = JSON.parse(ar.out), second = JSON.parse(br.out);
  assert.equal(first.ok, true); assert.equal(second.ok, true);
  assert.equal(second.execution.execution_id, first.execution.execution_id);
  assert.equal(second.execution.item.revision, 'first');
  assert.equal(second.execution.owner.worker, 'first');
  assert.equal(second.fence, undefined);
  assert.equal(store.readEvents(home, 'local', first.execution.execution_id).length, 2);
});

test('dead local lock owner recovers; an abandoned breaker and unknown owner fail closed', async t => {
  const home = setup(t), file = path.join(home, 'item'), entered = path.join(home, 'entered');
  const code = `const fs=require('fs');require(process.argv[1]).withLocalExecutionLock(process.argv[2],()=>{fs.writeFileSync(process.argv[3],'');for(;;)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);});`;
  const a = child(code, [lockModule, file, entered]); await waitFile(entered); a.proc.kill('SIGKILL'); await a.done;
  const { withLocalExecutionLock } = require(lockModule);
  assert.equal((await withLocalExecutionLock(file, () => 'recovered')).value, 'recovered');
  fs.writeFileSync(`${file}.lock`, '{unknown');
  assert.equal((await withLocalExecutionLock(file, () => assert.fail('unknown owner'), { attempts: 2, waitMs: 1 })).ok, false);
  assert.equal(fs.readFileSync(`${file}.lock`, 'utf8'), '{unknown'); fs.unlinkSync(`${file}.lock`);
  fs.writeFileSync(`${file}.lock.break`, '{unknown breaker');
  assert.equal((await withLocalExecutionLock(file, () => assert.fail('abandoned breaker'), { attempts: 2, waitMs: 1 })).ok, false);
  assert.equal(fs.readFileSync(`${file}.lock.break`, 'utf8'), '{unknown breaker');
});

for (const operation of ['open', 'claim', 'renew', 'release', 'event', 'forceRelease']) {
  test(`separate-process ${operation} waits for the item's filesystem transaction`, async t => {
    const home = setup(t), engine = store.localExecutionEngine({ home, worker: 'worker', machine: 'box', person: 'person-test' });
    const args = { node_id: 'task-lock', factory: 'factory-lock', gates: [] }, opened = await engine.open(args), id = opened.execution.execution_id;
    const file = store.itemPath(home, 'local', args.node_id), entered = path.join(home, 'entered'), release = path.join(home, 'release'), started = path.join(home, 'started');
    const holder = child(`const fs=require('fs');require(process.argv[1]).withLocalExecutionLock(process.argv[2],()=>{fs.writeFileSync(process.argv[3],'');while(!fs.existsSync(process.argv[4]))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);});`, [lockModule, file, entered, release]);
    t.after(() => holder.proc.kill('SIGKILL')); await waitFile(entered);
    const payload = operation === 'open' ? args : operation === 'forceRelease' ? { node_id: args.node_id, request_id: 'force-test', reason: 'Operator cancellation', expected_revision: opened.execution.release_revision } : { fence: opened.fence, event: { type: 'stage.started', attempt: 1, run_id: 'run' } };
    const mutator = child(`const fs=require('fs');const e=require(process.argv[1]).localExecutionEngine({home:process.argv[2],worker:'worker',machine:'box',person:'person-test'});fs.writeFileSync(process.argv[6],'');const operation=process.argv[3], args=JSON.parse(process.argv[5]);(operation==='open'?e.open(args):e[operation](process.argv[4],args)).then(r=>process.stdout.write(JSON.stringify(r)));`, [engineModule, home, operation, id, JSON.stringify(payload), started]);
    t.after(() => mutator.proc.kill('SIGKILL')); await waitFile(started);
    const log = store.eventsPath(home, 'local', id), before = fs.readFileSync(log, 'utf8');
    await delay(70); assert.equal(mutator.proc.exitCode, null); assert.equal(fs.readFileSync(log, 'utf8'), before);
    fs.writeFileSync(release, ''); const [held, changed] = await Promise.all([holder.done, mutator.done]);
    assert.equal(held.code, 0, held.err); assert.equal(changed.code, 0, changed.err);
    assert.equal(JSON.parse(changed.out).ok, true, changed.out);
  });
}


test('filesystem exclusion survives awaited callbacks and a rejected callback releases only its own lock', async t => {
  const home = setup(t), file = path.join(home, 'async-item');
  const { withLocalExecutionLock } = require(lockModule);
  let entered, release;
  const ready = new Promise(resolve => entered = resolve), paused = new Promise(resolve => release = resolve);
  const first = withLocalExecutionLock(file, async () => { entered(); await paused; throw new Error('injected async failure'); });
  await ready;
  let secondEntered = false;
  const second = withLocalExecutionLock(file, async () => { secondEntered = true; await delay(10); return 'next'; });
  await delay(30); assert.equal(secondEntered, false);
  const rejected = assert.rejects(first, /injected async failure/); release(); await rejected;
  assert.equal((await second).value, 'next');
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

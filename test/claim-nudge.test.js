// task-cc-claim-nudge-hook — the post-tool claim heartbeat ∪ claim-nudge
// branch (dec-cc-task-claim-lease). A no-LLM boolean lease lookup over
// GET /v1/queue?assignee=me: a live claim renews (heartbeat), no claim nudges
// once. Driven through the real dispatcher (bin/spor-hook post-tool) against an
// in-process stub server on an ephemeral port. The cwd is a real git repo so
// the in-repo gate passes; everything writes to a throwaway SPOR_HOME.
require("./helpers/tmp-cleanup"); // scratch-home leak guard (issue-spor-test-mkdtemp-inode-exhaustion)
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnHook } = require('./helpers/portable');

function freshEnv(home, extra = {}) {
  const env = { ...process.env, SPOR_HOME: home };
  for (const k of Object.keys(env)) {
    if (k.startsWith('SUBSTRATE_')) delete env[k];
    if (k.startsWith('SPOR_') && k !== 'SPOR_HOME') delete env[k];
  }
  // Opt the scratch repo in (task-spor-plugin-opt-in-default) so the claim
  // heartbeat/nudge path runs; the cwd is a git repo but carries no .spor marker.
  env.SPOR_ENABLED = '1';
  return { ...env, ...extra };
}

// A git-repo cwd named `projx`, so projectSlug resolves to a real repo slug and
// the in-repo gate passes. SPOR_HOME points at a separate scratch graph home.
function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-claimnudge-'));
  const home = path.join(root, 'graph');
  fs.mkdirSync(path.join(home, 'nodes'), { recursive: true });
  const cwd = path.join(root, 'projx');
  fs.mkdirSync(cwd);
  const g = (args) => {
    const r = spawnSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com',
      },
    });
    assert.strictEqual(r.status, 0, r.stderr);
  };
  g(['init', '-q']);
  fs.writeFileSync(path.join(cwd, 'f.txt'), 'x');
  g(['add', 'f.txt']);
  g(['commit', '-q', '-m', 'init']);
  return { root, home, cwd };
}

// Stub server: records hits, and answers GET /v1/queue from `queueFor(url)` and
// POST /v1/nodes/{id}/renew with 200 {status:"renewed"}. `queueFor` returns the
// {items:[...]} object for a given request url (assignee=me vs the pool query).
// POST /v1/queue/renew models renewAll's two arms: an explicit `ids` list is
// echoed back, an OMITTED one enumerates — by default every in_progress item
// `queueFor` reports for assignee=me, exactly what the real enumerate arm would
// find for a single-project holder. `renewAllIds` overrides that enumeration to
// stage a lease that lapsed out of the set (the blanket arm never reclaims).
// `renewExtra` merges additional fields into the renew response (e.g.
// `{ skipped_other_project: 2 }`, server/leases.js renewAll's own
// only-when-nonzero convention — see dec-spor-renewall-adopts-optional-project-scope).
function stubServer(queueFor, renewAllIds, renewExtra) {
  const enumerate = renewAllIds ||
    (() => ((queueFor('/v1/queue?project=projx&assignee=me').items) || [])
      .filter((i) => i.lease_state === 'in_progress')
      .map((i) => i.id));
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      if (req.method === 'GET' && req.url.startsWith('/v1/queue')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(queueFor(req.url)));
        return;
      }
      if (req.method === 'POST' && /^\/v1\/nodes\/[^/]+\/renew$/.test(req.url)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status: 'renewed' }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/queue/renew') {
        const ids = (() => {
          let parsed;
          try { parsed = JSON.parse(body || '{}'); } catch { return []; }
          return Array.isArray(parsed.ids) ? parsed.ids : enumerate();
        })();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status: 'renewed', count: ids.length, renewed: ids, leases: [], failed: [], ...renewExtra }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () =>
    resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}

// async spawn — spawnSync would block the event loop and starve the stub
// server while the hook's curl waits on it. Resolves with stdout.
function runAsync(args, input, env) {
  return new Promise((resolve, reject) => {
    let out = '';
    const c = spawnHook(args, input, env, { stdio: ['pipe', 'pipe', 'ignore'] });
    c.stdout.on('data', (d) => (out += d));
    c.on('error', reject);
    c.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
  });
}

function editPayload(cwd, session = 's1', file = 'code.js') {
  return JSON.stringify({
    cwd, session_id: session, hook_event_name: 'PostToolUse',
    tool_name: 'Edit', tool_input: { file_path: path.join(cwd, file), new_string: 'x' },
  });
}

function journal(home, session = 's1') {
  const p = path.join(home, 'journal', `${session}.jsonl`);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

function isAssigneeMe(url) {
  return url.includes('assignee=me');
}

test('no live claim -> claim-nudge fires once, naming the top eligible pool items', async () => {
  const { home, cwd } = scratch();
  const { srv, hits, base } = await stubServer((url) =>
    isAssigneeMe(url)
      ? { items: [] } // person holds no claim
      : { items: [
          { id: 'task-alpha', title: 'Do alpha', why: 'blocks two' },
          { id: 'task-beta', title: 'Do beta' },
        ] }
  );
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test' });
    const out = await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd), env);
    const json = JSON.parse(out);
    assert.strictEqual(json.hookSpecificOutput.hookEventName, 'PostToolUse');
    const ctx = json.hookSpecificOutput.additionalContext;
    assert.match(ctx, /claim nudge/);
    assert.match(ctx, /no task claimed/);
    assert.match(ctx, /task-alpha — Do alpha \(blocks two\)/);
    assert.match(ctx, /task-beta — Do beta/);
    assert.match(ctx, /spor:defer/);
    // bearer rode the lookup
    assert.strictEqual(hits[0].auth, 'Bearer spor_pat_test');
    // no renew was attempted (no claim held)
    assert.ok(!hits.some((h) => h.method === 'POST'));
    // cooldown file written + journaled
    assert.ok(fs.existsSync(path.join(home, 'journal', 's1.claim-nudged')));
    assert.strictEqual(journal(home).filter((e) => e.tool === 'claim-nudge').length, 1);
  } finally {
    srv.close();
  }
});

// issue-spor-claim-nudge-fires-on-out-of-tree-writes: the cwd having a git
// root is not enough — a Write/Edit whose target resolves OUTSIDE that repo
// (a /tmp scratchpad, say) is not "editing this repo" and must not nudge,
// even though the session's cwd is a real repo with a claimable pool.
test('cwd is a repo but the edited file is outside it -> no claim-nudge, no lookup', async () => {
  const { home, cwd, root } = scratch();
  const { srv, hits, base } = await stubServer((url) =>
    isAssigneeMe(url) ? { items: [] } : { items: [{ id: 'task-alpha', title: 'Alpha' }] }
  );
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test' });
    const outsideFile = path.join(root, 'scratch.txt'); // sibling of cwd, outside the repo
    const payload = JSON.stringify({
      cwd, session_id: 's1', hook_event_name: 'PostToolUse',
      tool_name: 'Write', tool_input: { file_path: outsideFile, content: 'x' },
    });
    const out = await runAsync(['post-tool', '--host', 'claude-code'], payload, env);
    assert.strictEqual(out.trim(), '', 'an out-of-tree write must not nudge');
    assert.ok(!hits.length, 'the lease lookup must not even fire for an out-of-tree write');
    assert.strictEqual(journal(home).filter((e) => e.tool === 'claim-nudge').length, 0);
    assert.ok(!fs.existsSync(path.join(home, 'journal', 's1.claim-nudged')));
  } finally {
    srv.close();
  }
});

test('cooldown: a second write in the same session does not nudge again', async () => {
  const { home, cwd } = scratch();
  const { srv, hits, base } = await stubServer((url) =>
    isAssigneeMe(url) ? { items: [] } : { items: [{ id: 'task-alpha', title: 'Alpha' }] }
  );
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test' });
    const first = await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd, 's1', 'a.js'), env);
    assert.match(JSON.parse(first).hookSpecificOutput.additionalContext, /claim nudge/);
    const second = await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd, 's1', 'b.js'), env);
    assert.strictEqual(second.trim(), '');
    assert.strictEqual(journal(home).filter((e) => e.tool === 'claim-nudge').length, 1);
  } finally {
    srv.close();
  }
});

test('live claim held by this person -> blanket renew (heartbeat) fires, no nudge', async () => {
  const { home, cwd } = scratch();
  const { srv, hits, base } = await stubServer((url) =>
    isAssigneeMe(url)
      ? { items: [
          { id: 'task-mine', title: 'Mine', lease_state: 'in_progress', lease_by: 'person-t' },
        ] }
      : { items: [{ id: 'task-alpha', title: 'Alpha' }] }
  );
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test' });
    const out = await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd), env);
    assert.strictEqual(out.trim(), '', 'a held-claim write must not nudge');
    // one blanket renew — no ids, no session (in the enumerate arm `session` is
    // a FILTER, and a lease claimed outside a session would be skipped by it),
    // and never the singular door, whose auto-reclaim a heartbeat must not use
    // (dec-spor-heartbeat-adopts-blanket-renew-arm)
    const bulk = hits.filter((h) => h.method === 'POST' && h.url === '/v1/queue/renew');
    assert.strictEqual(bulk.length, 1, `expected one blanket renew; hits: ${JSON.stringify(hits.map((h) => h.method + ' ' + h.url))}`);
    assert.deepStrictEqual(JSON.parse(bulk[0].body), { project: 'projx' });
    assert.ok(!hits.some((h) => h.method === 'POST' && /^\/v1\/nodes\//.test(h.url)), 'no per-node renew fired');
    // no claim-nudge journaled; a claim-heartbeat line was
    assert.strictEqual(journal(home).filter((e) => e.tool === 'claim-nudge').length, 0);
    const hb = journal(home).filter((e) => e.tool === 'claim-heartbeat');
    assert.strictEqual(hb.length, 1);
    assert.deepStrictEqual(hb[0].renewed, ['task-mine']);
    // no cooldown file (the nudge branch was never reached)
    assert.ok(!fs.existsSync(path.join(home, 'journal', 's1.claim-nudged')));
  } finally {
    srv.close();
  }
});

test('multiple live claims held -> one blanket POST /v1/queue/renew, not N single renews', async () => {
  const { home, cwd } = scratch();
  const { srv, hits, base } = await stubServer((url) =>
    isAssigneeMe(url)
      ? { items: [
          { id: 'task-mine', title: 'Mine', lease_state: 'in_progress', lease_by: 'person-t' },
          { id: 'task-mine-2', title: 'Mine 2', lease_state: 'in_progress', lease_by: 'person-t' },
        ] }
      : { items: [{ id: 'task-alpha', title: 'Alpha' }] }
  );
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test' });
    const out = await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd), env);
    assert.strictEqual(out.trim(), '', 'a held-claim write must not nudge');
    // exactly one blanket renew, no per-node renews
    const bulk = hits.filter((h) => h.method === 'POST' && h.url === '/v1/queue/renew');
    assert.strictEqual(bulk.length, 1, `expected exactly one bulk renew; hits: ${JSON.stringify(hits.map((h) => h.method + ' ' + h.url))}`);
    assert.deepStrictEqual(JSON.parse(bulk[0].body), { project: 'projx' });
    assert.ok(!hits.some((h) => h.method === 'POST' && /^\/v1\/nodes\//.test(h.url)), 'no per-node renew fired alongside the batch');
    // no claim-nudge journaled; a claim-heartbeat line names both nodes
    assert.strictEqual(journal(home).filter((e) => e.tool === 'claim-nudge').length, 0);
    const hb = journal(home).filter((e) => e.tool === 'claim-heartbeat');
    assert.strictEqual(hb.length, 1);
    assert.deepStrictEqual(hb[0].renewed, ['task-mine', 'task-mine-2']);
  } finally {
    srv.close();
  }
});

// issue-spor-blanket-renew-not-project-scoped-stall-detection /
// task-split-spor-5affee1c0338: the enumerate arm's `skipped_other_project`
// count (server/leases.js renewAll) must be journaled alongside `dropped`,
// not folded into `renewed` and not ignored, so SessionEnd's replay never
// mistakes a lease the beat deliberately left out of project scope for one
// it still holds.
test('server-reported skipped_other_project is journaled on the claim-heartbeat record', async () => {
  const { home, cwd } = scratch();
  const { srv, hits, base } = await stubServer(
    (url) =>
      isAssigneeMe(url)
        ? { items: [{ id: 'task-mine', title: 'Mine', lease_state: 'in_progress', lease_by: 'person-t' }] }
        : { items: [{ id: 'task-alpha', title: 'Alpha' }] },
    undefined,
    { skipped_other_project: 2 }
  );
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test' });
    const out = await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd), env);
    assert.strictEqual(out.trim(), '');
    const bulk = hits.filter((h) => h.method === 'POST' && h.url === '/v1/queue/renew');
    assert.strictEqual(bulk.length, 1);
    assert.deepStrictEqual(JSON.parse(bulk[0].body), { project: 'projx' }, 'the heartbeat sends the same slug the lookup used');
    const hb = journal(home).filter((e) => e.tool === 'claim-heartbeat');
    assert.strictEqual(hb.length, 1);
    assert.deepStrictEqual(hb[0].renewed, ['task-mine']);
    assert.strictEqual(hb[0].skipped_other_project, 2);
  } finally {
    srv.close();
  }
});

test('skipped_other_project absent from the response -> the field is omitted from the journal, never written as 0', async () => {
  const { home, cwd } = scratch();
  const { srv, hits, base } = await stubServer((url) =>
    isAssigneeMe(url)
      ? { items: [{ id: 'task-mine', title: 'Mine', lease_state: 'in_progress', lease_by: 'person-t' }] }
      : { items: [{ id: 'task-alpha', title: 'Alpha' }] }
  );
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test' });
    await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd), env);
    const hb = journal(home).filter((e) => e.tool === 'claim-heartbeat');
    assert.strictEqual(hb.length, 1);
    assert.strictEqual('skipped_other_project' in hb[0], false);
  } finally {
    srv.close();
  }
});

test('a held lease the blanket beat did not renew is journaled as dropped, never re-claimed', async () => {
  const { home, cwd } = scratch();
  // the person's queue still shows both as in_progress (the read is a snapshot),
  // but the server's enumerate arm only renews one — the other lapsed or was
  // taken, and the blanket arm never re-acquires it.
  const { srv, hits, base } = await stubServer(
    (url) =>
      isAssigneeMe(url)
        ? { items: [
            { id: 'task-mine', title: 'Mine', lease_state: 'in_progress', lease_by: 'person-t' },
            { id: 'task-lapsed', title: 'Lapsed', lease_state: 'in_progress', lease_by: 'person-t' },
          ] }
        : { items: [{ id: 'task-alpha', title: 'Alpha' }] },
    () => ['task-mine']
  );
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test' });
    const out = await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd), env);
    assert.strictEqual(out.trim(), '');
    // no singular renew chased the lapsed node (that door reclaims)
    assert.ok(!hits.some((h) => h.method === 'POST' && /^\/v1\/nodes\//.test(h.url)), 'a dropped lease is not re-claimed');
    const hb = journal(home).filter((e) => e.tool === 'claim-heartbeat');
    assert.strictEqual(hb.length, 1);
    assert.deepStrictEqual(hb[0].renewed, ['task-mine']);
    assert.deepStrictEqual(hb[0].dropped, ['task-lapsed']);
  } finally {
    srv.close();
  }
});

// issue-spor-sessionend-reserve-retakes-released-lease: the case above only
// covers a lease that stays VISIBLE this beat but doesn't renew. A node can
// also vanish from the assignee=me lookup ENTIRELY between beats — a `spor
// release` (or a reassignment) from another terminal retires the durable
// `assigned` edge — which the beat must journal as dropped too, or
// SessionEnd's replay (distill.js sessionEndLease) still believes this
// session holds it and `reserve`s (and the server auto-reclaims) a lease
// that was deliberately handed back. (An ORDINARY lapse is different and
// must NOT be treated this way — see the next test.)
test('a lease that vanishes entirely from the lookup between beats is journaled as dropped, not silently forgotten', async () => {
  const { home, cwd } = scratch();
  let phase = 1;
  const { srv, hits, base } = await stubServer((url) =>
    isAssigneeMe(url)
      ? phase === 1
        ? { items: [{ id: 'task-mine', title: 'Mine', lease_state: 'in_progress', lease_by: 'person-t' }] }
        : { items: [] } // released or reassigned elsewhere — gone from `myItems` entirely
      : { items: [{ id: 'task-alpha', title: 'Alpha' }] }
  );
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test' });
    // beat 1: holds and renews task-mine
    const first = await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd, 's1', 'a.js'), env);
    assert.strictEqual(first.trim(), '');
    let hb = journal(home).filter((e) => e.tool === 'claim-heartbeat');
    assert.strictEqual(hb.length, 1);
    assert.deepStrictEqual(hb[0].renewed, ['task-mine']);
    assert.ok(!('dropped' in hb[0]));

    // beat 2: task-mine no longer appears at all -> no live claim this beat,
    // but the vanish must still be journaled as a drop before falling
    // through toward the nudge path.
    phase = 2;
    await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd, 's1', 'b.js'), env);
    hb = journal(home).filter((e) => e.tool === 'claim-heartbeat');
    assert.strictEqual(
      hb.length, 2,
      `expected a second heartbeat record recording the drop; hits: ${JSON.stringify(hits.map((h) => h.method + ' ' + h.url))}`
    );
    assert.deepStrictEqual(hb[1].renewed, []);
    assert.deepStrictEqual(hb[1].dropped, ['task-mine']);

    // a third beat, still vanished, must not repeat the same drop record —
    // it was already recorded once and priorHeld no longer carries it.
    await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd, 's1', 'c.js'), env);
    assert.strictEqual(journal(home).filter((e) => e.tool === 'claim-heartbeat').length, 2, 'no repeat drop record once already journaled');
  } finally {
    srv.close();
  }
});

// dec-spor-lease-auto-reclaim-and-deadline-exposure: an ORDINARY lapse (no
// renew within the TTL, nobody else reclaimed it) must NOT be journaled as
// dropped — the decided behavior is that SessionEnd still `reserve`s
// (auto-reclaims) a claim that merely lapsed. `assigneeScope`
// (lib/kernel/queue.js) lists a node here off its durable `assigned` edge
// regardless of live lease state, so a lapsed-but-still-assigned node stays
// in `myItems` with no `lease_state` — present, just not `held`. Only a
// genuine disappearance from `myItems` (the previous test) is a real drop;
// this pins the distinction the other way, guarding against a regression
// that diffs against `held` instead of the full `myItems` set.
test('an ordinary lapse (still assigned, no lease_state) is NOT journaled as dropped — the decided lapse-reclaim behavior survives', async () => {
  const { home, cwd } = scratch();
  let phase = 1;
  const { srv, hits, base } = await stubServer((url) =>
    isAssigneeMe(url)
      ? phase === 1
        ? { items: [{ id: 'task-mine', title: 'Mine', lease_state: 'in_progress', lease_by: 'person-t' }] }
        : { items: [{ id: 'task-mine', title: 'Mine' }] } // still assigned, lease merely lapsed — no lease_state
      : { items: [{ id: 'task-alpha', title: 'Alpha' }] }
  );
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test' });
    const first = await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd, 's1', 'a.js'), env);
    assert.strictEqual(first.trim(), '');
    let hb = journal(home).filter((e) => e.tool === 'claim-heartbeat');
    assert.strictEqual(hb.length, 1);
    assert.deepStrictEqual(hb[0].renewed, ['task-mine']);

    // beat 2: task-mine is still assigned (still in myItems) but no longer
    // has a live lease_state -> falls out of `held`, so this beat looks like
    // "no live claim" and may nudge, but must NOT journal task-mine as
    // dropped, since it never left `myItems` entirely.
    phase = 2;
    await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd, 's1', 'b.js'), env);
    hb = journal(home).filter((e) => e.tool === 'claim-heartbeat');
    assert.strictEqual(
      hb.length, 1,
      `an ordinary lapse must not add a heartbeat record at all; hits: ${JSON.stringify(hits.map((h) => h.method + ' ' + h.url))}`
    );
  } finally {
    srv.close();
  }
});

// Fail-open on the beat itself: the lookup succeeded, the renew did not (a
// dead/older server, a 404, an unreadable body). The hook still exits 0 with no
// output and journals the optimistic set, so SessionEnd keeps its evidence of
// what this session held rather than losing a live lease to a blip.
test('a renew the server refuses -> no output, exit 0, journal keeps the held set', async () => {
  const { home, cwd } = scratch();
  const { srv, hits, base } = await stubServer((url) =>
    isAssigneeMe(url)
      ? { items: [{ id: 'task-mine', title: 'Mine', lease_state: 'in_progress', lease_by: 'person-t' }] }
      : { items: [{ id: 'task-alpha', title: 'Alpha' }] }
  );
  try {
    // swap in a handler with no bulk-renew route, so the POST 404s the way an
    // older server (or a deploy skew) would
    srv.removeAllListeners('request');
    srv.on('request', (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        hits.push({ method: req.method, url: req.url, body });
        if (req.method === 'GET' && req.url.startsWith('/v1/queue')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(isAssigneeMe(req.url)
            ? { items: [{ id: 'task-mine', title: 'Mine', lease_state: 'in_progress', lease_by: 'person-t' }] }
            : { items: [{ id: 'task-alpha', title: 'Alpha' }] }));
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test' });
    const out = await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd), env);
    assert.strictEqual(out.trim(), '');
    // the beat was really attempted — without this the assertions below would
    // pass just as well against a build that never issued the renew at all
    assert.ok(hits.some((h) => h.method === 'POST' && h.url === '/v1/queue/renew'), 'the beat fired');
    const hb = journal(home).filter((e) => e.tool === 'claim-heartbeat');
    assert.strictEqual(hb.length, 1);
    assert.deepStrictEqual(hb[0].renewed, ['task-mine']);
    assert.ok(!('dropped' in hb[0]), 'an unanswered beat is not reported as a drop');
  } finally {
    srv.close();
  }
});

test('Tier-2 reservation held -> suppresses the nudge but does NOT renew (no heartbeat)', async () => {
  const { home, cwd } = scratch();
  const { srv, hits, base } = await stubServer((url) =>
    isAssigneeMe(url)
      ? { items: [{ id: 'task-resv', title: 'Reserved', lease_state: 'reserved', lease_by: 'person-t' }] }
      : { items: [{ id: 'task-alpha', title: 'Alpha' }] }
  );
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test' });
    const out = await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd), env);
    assert.strictEqual(out.trim(), '');
    assert.ok(!hits.some((h) => h.method === 'POST'), 'a Tier-2 reservation is not heartbeated');
    assert.ok(!fs.existsSync(path.join(home, 'journal', 's1.claim-nudged')));
  } finally {
    srv.close();
  }
});

test('SPOR_CLAIM_NUDGE=0 disables the branch entirely (no lookup, no nudge)', async () => {
  const { home, cwd } = scratch();
  const { srv, hits, base } = await stubServer((url) =>
    isAssigneeMe(url) ? { items: [] } : { items: [{ id: 'task-alpha', title: 'Alpha' }] }
  );
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test', SPOR_CLAIM_NUDGE: '0' });
    const out = await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd), env);
    assert.strictEqual(out.trim(), '');
    // no queue lookup was made (the disable gate is checked before any curl)
    assert.ok(!hits.some((h) => h.url.startsWith('/v1/queue')));
  } finally {
    srv.close();
  }
});

test('local mode (no SPOR_SERVER) is a no-op — no claim lookup, no nudge', async () => {
  const { home, cwd } = scratch();
  // a local graph dir exists, so the post-tool engine runs (and journals), but
  // the claim branch returns before any network or nudge.
  const env = freshEnv(home); // no SPOR_SERVER / SPOR_TOKEN
  const out = await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd), env);
  assert.strictEqual(out.trim(), '');
  // the file touch was still journaled (local-mode behavior unchanged), but no
  // claim-nudge / claim-heartbeat lines exist.
  const j = journal(home);
  assert.ok(j.some((e) => e.file), 'file touch still journaled in local mode');
  assert.strictEqual(j.filter((e) => e.tool === 'claim-nudge' || e.tool === 'claim-heartbeat').length, 0);
  assert.ok(!fs.existsSync(path.join(home, 'journal', 's1.claim-nudged')));
});

test('fail-open: a dead server yields no output and no crash (exit 0)', async () => {
  const { home, cwd } = scratch();
  const env = freshEnv(home, { SPOR_SERVER: 'http://127.0.0.1:1', SPOR_TOKEN: 'spor_pat_test', SPOR_CLAIM_NUDGE_TIMEOUT: '400' });
  const out = await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd), env);
  assert.strictEqual(out.trim(), '');
  assert.ok(!fs.existsSync(path.join(home, 'journal', 's1.claim-nudged')));
});

test('non-200 lookup -> never nudge (cannot verify lease state)', async () => {
  const { home, cwd } = scratch();
  const srv = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{}'); });
  });
  const base = await new Promise((resolve) => srv.listen(0, '127.0.0.1', () =>
    resolve(`http://127.0.0.1:${srv.address().port}`)));
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test' });
    const out = await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd), env);
    assert.strictEqual(out.trim(), '');
    assert.ok(!fs.existsSync(path.join(home, 'journal', 's1.claim-nudged')));
  } finally {
    srv.close();
  }
});

test('empty eligible pool -> no nudge (nothing worth offering)', async () => {
  const { home, cwd } = scratch();
  const { srv, base } = await stubServer(() => ({ items: [] })); // both queries empty
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test' });
    const out = await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd), env);
    assert.strictEqual(out.trim(), '');
    assert.ok(!fs.existsSync(path.join(home, 'journal', 's1.claim-nudged')));
  } finally {
    srv.close();
  }
});

test('not a git repo -> in-repo gate skips the claim branch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spor-claimnudge-nogit-'));
  const home = path.join(root, 'graph');
  fs.mkdirSync(path.join(home, 'nodes'), { recursive: true });
  const cwd = path.join(root, 'loose');
  fs.mkdirSync(cwd);
  let touched = false;
  const { srv, base } = await stubServer((url) => { touched = isAssigneeMe(url) || touched; return { items: [{ id: 'task-alpha', title: 'Alpha' }] }; });
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: 'spor_pat_test' });
    const out = await runAsync(['post-tool', '--host', 'claude-code'], editPayload(cwd), env);
    assert.strictEqual(out.trim(), '');
    assert.strictEqual(touched, false, 'no assignee=me lookup outside a git repo');
  } finally {
    srv.close();
  }
});

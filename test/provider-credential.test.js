"use strict";
// The attempt token's hand-off (task-spor-provider-deliver-credential-op,
// dec-spor-provider-credential-review-signoff-2026-10-09 (g), PROVIDERS.md
// §4.3): the contract's `deliver_credential` operation, the worker's mint-and-
// deliver door (provider-attempts.js deliverAttemptToken) over the execution
// store's attempt-token door, the conformance scenario that pins delivery /
// rotation on re-fence / the old token refused, and the runner reading
// SPOR_TOKEN_FILE first. The stdio binding's exemption is in
// test/provider-stdio.test.js.

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const pc = require("../lib/kernel/provider-contract");
const conf = require("../lib/shell/provider-conformance");
const providerAttempts = require("../lib/shell/provider-attempts");
const executionStore = require("../lib/shell/execution-store");
const attemptRunner = require("../lib/shell/attempt");
const { createSyntheticProvider } = require("./fixtures/providers/synthetic");

const dirs = [];
function scratch(prefix = "spor-provider-credential-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const EXEC = "exec-0123456789abcdef";
const TOKEN = "spor_att_v1_acme_0123456789abcdefABCDEF";
const handle = { provider: "synthetic", id: "syn-1", slot: 1 };
const req = (params) => ({ contract_version: 1, id: "r-1", op: "deliver_credential", params });

// ------------------------------------------------------------ the contract

test("deliver_credential is an optional, advertised operation carrying exactly one attempt token", () => {
  assert.ok(pc.OPTIONAL_OPERATIONS.includes("deliver_credential"));
  assert.ok(!pc.REQUIRED_OPERATIONS.includes("deliver_credential"));
  assert.ok(pc.LIFECYCLE_CAPABILITIES.includes("deliver_credential"), "a provider advertises it under lifecycle");
  assert.ok(pc.ERROR_CODES.includes("stale_credential"));
  const ok = pc.validateRequest(req({ handle, credential: { kind: "spor-attempt-token", ref: `spor-attempt-token://${EXEC}/2`, value: TOKEN, fence: 2, expires_at: "2026-10-09T12:00:00Z" } }));
  assert.deepEqual(ok, { ok: true, errors: [] });
  const bad = pc.validateRequest(req({ handle, credential: { kind: "spor-attempt-token", ref: `spor-attempt-token://${EXEC}/2`, value: "spor_pat_0123456789abcdef0123", fence: 2 } }));
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join("; "), /credential\.value: \(value withheld\) is not an attempt-scoped Spor token/);
  assert.doesNotMatch(bad.errors.join("; "), /spor_pat_/, "a refused value is never quoted");
  const fence = pc.validateRequest(req({ handle, credential: { kind: "spor-attempt-token", ref: `spor-attempt-token://${EXEC}/1`, value: TOKEN, fence: 2 } }));
  assert.match(fence.errors.join("; "), /credential\.fence: 2 is not the fence its reference names \(1\)/);
  assert.equal(pc.validateResponse({ contract_version: 1, id: "r-1", ok: true, result: { delivered: true } }, "deliver_credential").ok, true);
  assert.equal(pc.validateResponse({ contract_version: 1, id: "r-1", ok: true, result: {} }, "deliver_credential").ok, false);
});

// --------------------------------------------------------- the conformance

test("credential-rotation: a provider that does not advertise deliver_credential is skipped, not failed", async () => {
  const { provider, driver } = createSyntheticProvider({ credentials: false });
  const r = await conf.runScenario(provider, "credential-rotation", { home: scratch(), driver });
  assert.match(r.skipped, /does not advertise lifecycle 'deliver_credential'/);
});

test("credential-rotation: a provider that takes the old fence's token after the new one fails the scenario", async () => {
  const { provider, driver } = createSyntheticProvider({ brokenCredential: "accept-stale" });
  await assert.rejects(
    conf.runScenario(provider, "credential-rotation", { home: scratch(), driver }),
    /\[credential-rotation\]: re-delivering the old fence's token after the new fence's: deliver_credential succeeded/,
  );
});

test("credential-rotation: an environment left holding the old token after re-delivery fails the scenario", async () => {
  const { impl, driver } = createSyntheticProvider();
  // Accepts every delivery but keeps only the FIRST one.
  const sticky = conf.bindInProcess({
    ...impl,
    deliver_credential(p) {
      if (impl.fixture.credential(p.handle)) return { delivered: true };
      return impl.deliver_credential(p);
    },
  });
  await assert.rejects(conf.runScenario(sticky, "credential-rotation", { home: scratch(), driver }), /\[credential-rotation\]: after re-delivery under the new fence: the environment holds a different token/);
});

test("the token authority refuses the old fence's token once a newer fence mints, and one live token per fence", () => {
  const a = new conf.TokenAuthority();
  const t1 = a.mint(EXEC, 1);
  assert.equal(t1.ok, true);
  assert.match(t1.token, new RegExp(pc.ATTEMPT_TOKEN_PATTERN));
  assert.equal(a.mint(EXEC, 1).code, "attempt_token_issued");
  const t2 = a.mint(EXEC, 2);
  assert.equal(a.check(t1.token).code, "token_fence_stale");
  assert.equal(a.check(t2.token).ok, true);
  assert.equal(a.mint(EXEC, 1).code, "fence_stale");
});

// ------------------------------------------------- the worker's door

function fakeClient({ refuse = null, lose = 0 } = {}) {
  const sent = [];
  return {
    id: "fake",
    sent,
    async deliverCredential(params) {
      sent.push(params);
      if (lose > 0) {
        lose--;
        throw new conf.LostReply("deliver_credential");
      }
      if (refuse) throw new conf.ProviderError(refuse, "no");
      return { delivered: true };
    },
  };
}

function fakeStore({ issued = false } = {}) {
  const calls = [];
  let n = 0;
  let live = issued;
  return {
    calls,
    async mintAttemptToken(id, { fence }) {
      calls.push(["mint", id, fence]);
      if (live) return { ok: false, code: "attempt_token_issued", message: "issued" };
      live = true;
      return { ok: true, token: `spor_att_minted_${fence}_${++n}_0123456789abcdef`, attempt_token: { token_id: `tid${n}`, token_ref: `spor-attempt-token://${id}/${fence}`, exp: "2026-10-09T12:00:00.000Z" } };
    },
    async revokeAttemptToken(id, { fence }) {
      calls.push(["revoke", id, fence]);
      live = false;
      return { ok: true };
    },
  };
}

test("deliverAttemptToken mints for the held fence and delivers the token at the credential field — never in its result", async () => {
  const store = fakeStore();
  const client = fakeClient();
  const r = await providerAttempts.deliverAttemptToken({ store, executionId: EXEC, fence: 3, handle, client });
  assert.deepEqual(r, { ok: true, token_id: "tid1", expires_at: "2026-10-09T12:00:00.000Z", reissue_of: null });
  assert.deepEqual(store.calls, [["mint", EXEC, 3]]);
  assert.deepEqual(client.sent, [{ handle, credential: { kind: "spor-attempt-token", ref: `spor-attempt-token://${EXEC}/3`, value: "spor_att_minted_3_1_0123456789abcdef", fence: 3, expires_at: "2026-10-09T12:00:00.000Z" } }]);
  assert.equal(pc.validateRequest(req(client.sent[0])).ok, true);
  assert.doesNotMatch(JSON.stringify(r), /spor_att_/);
});

test("deliverAttemptToken: a lost reply re-sends the SAME token (no second mint); an issued-but-unheld token is revoked and re-minted", async () => {
  const store = fakeStore();
  const client = fakeClient({ lose: 1 });
  const first = await providerAttempts.deliverAttemptToken({ store, executionId: EXEC, fence: 4, handle, client });
  assert.equal(first.ok, false);
  assert.equal(first.transient, true);
  const second = await providerAttempts.deliverAttemptToken({ store, executionId: EXEC, fence: 4, handle, client });
  assert.equal(second.ok, true);
  assert.deepEqual(store.calls, [["mint", EXEC, 4]], "one mint for the fence");
  assert.equal(client.sent[0].credential.value, client.sent[1].credential.value);
  // Another process (another store object) never saw the plaintext: the
  // fence's one-shot slot is freed by revoking, then minted again.
  const other = fakeStore({ issued: true });
  const r = await providerAttempts.deliverAttemptToken({ store: other, executionId: EXEC, fence: 4, handle, client: fakeClient() });
  assert.equal(r.ok, true);
  assert.deepEqual(other.calls, [["mint", EXEC, 4], ["revoke", EXEC, 4], ["mint", EXEC, 4]]);
});

test("deliverAttemptToken: a provider that takes no credential, or a store that mints none, is a no-op; a refusal is reported, not retried", async () => {
  const store = fakeStore();
  const none = await providerAttempts.deliverAttemptToken({ store, executionId: EXEC, fence: 1, handle, client: { id: "local" } });
  assert.equal(none.unsupported, true);
  assert.deepEqual(store.calls, [], "nothing is minted for a provider that cannot take it");
  const local = await providerAttempts.deliverAttemptToken({ store: {}, executionId: EXEC, fence: 1, handle, client: fakeClient() });
  assert.equal(local.unsupported, true);
  const refused = await providerAttempts.deliverAttemptToken({ store: fakeStore(), executionId: EXEC, fence: 1, handle, client: fakeClient({ refuse: "stale_credential" }) });
  assert.equal(refused.refused, true);
  assert.equal(refused.code, "stale_credential");
  const fenced = await providerAttempts.deliverAttemptToken({ store: { mintAttemptToken: async () => ({ ok: false, code: "fence_stale", message: "moved" }) }, executionId: EXEC, fence: 1, handle, client: fakeClient() });
  assert.equal(fenced.ok, false);
  assert.equal(fenced.transient, false, "a fence this worker no longer holds is not retried");
});

test("the in-process client exposes deliverCredential only for an impl that implements it (local does not)", () => {
  assert.equal(typeof providerAttempts.inProcessClient("local", { submit() {}, observe() {} }).deliverCredential, "undefined");
  assert.equal(typeof providerAttempts.inProcessClient("x", { submit() {}, observe() {}, deliver_credential() {} }).deliverCredential, "function");
  // An envelope provider is offered the operation only when it advertises it.
  assert.equal(typeof providerAttempts.envelopeClient("x", { request() {} }).deliverCredential, "undefined");
  assert.equal(typeof providerAttempts.envelopeClient("x", { request() {} }, { capabilities: { lifecycle: ["cancel"] } }).deliverCredential, "undefined");
  assert.equal(typeof providerAttempts.envelopeClient("x", { request() {} }, { capabilities: { lifecycle: ["deliver_credential"] } }).deliverCredential, "function");
});

test("deliverAttemptToken fails closed and never leaks: an unadvertised provider is not minted for, a non-token mint answer is not delivered, a provider message echoing the token is masked, an older server is not retried", async () => {
  const store = fakeStore();
  const client = fakeClient();
  const unadvertised = await providerAttempts.deliverAttemptToken({ store, executionId: EXEC, fence: 1, handle, client, capabilities: { lifecycle: ["cancel"] } });
  assert.equal(unadvertised.unsupported, true);
  assert.deepEqual(store.calls, [], "no mint for a provider that does not advertise deliver_credential");
  assert.deepEqual(client.sent, []);
  const junk = await providerAttempts.deliverAttemptToken({ store: { mintAttemptToken: async () => ({ ok: true, token: "spor_pat_personal_0123456789abcdef" }) }, executionId: EXEC, fence: 1, handle, client });
  assert.equal(junk.ok, false);
  assert.equal(junk.transient, false);
  assert.doesNotMatch(junk.reason, /spor_pat_/);
  assert.deepEqual(client.sent, [], "a non-token is never delivered");
  // The reference is the worker's own, whatever the server echoed.
  const echoStore = { mintAttemptToken: async () => ({ ok: true, token: TOKEN, attempt_token: { token_ref: "spor-attempt-token://exec-ffffffffffffffff/9" } }) };
  await providerAttempts.deliverAttemptToken({ store: echoStore, executionId: EXEC, fence: 2, handle, client });
  assert.equal(client.sent[0].credential.ref, `spor-attempt-token://${EXEC}/2`);
  const echoing = {
    id: "echo",
    async deliverCredential(p) {
      throw new conf.ProviderError("stale_credential", `refusing ${p.credential.value}`);
    },
  };
  const masked = await providerAttempts.deliverAttemptToken({ store: { mintAttemptToken: async () => ({ ok: true, token: TOKEN }) }, executionId: EXEC, fence: 3, handle, client: echoing });
  assert.equal(masked.refused, true);
  assert.doesNotMatch(masked.reason, new RegExp(TOKEN));
  assert.match(masked.reason, /spor_att_\(redacted\)/);
  const old = await providerAttempts.deliverAttemptToken({ store: { mintAttemptToken: async () => ({ ok: false, code: "not_found", message: "no such route", unserved: true }) }, executionId: EXEC, fence: 1, handle, client: fakeClient() });
  assert.equal(old.unsupported, true);
  // A server that is briefly unavailable (503) is owed a retry, not settled.
  const busy = await providerAttempts.deliverAttemptToken({ store: { mintAttemptToken: async () => ({ ok: false, code: "unavailable", message: "busy", unserved: true, transient: true }) }, executionId: EXEC, fence: 1, handle, client: fakeClient() });
  assert.equal(busy.unsupported, undefined);
  assert.equal(busy.transient, true);
});

test("the sweep re-delivers an owed token each pass until it lands", async () => {
  const home = scratch();
  const engine = executionStore.localExecutionEngine({ home, tenant: "t", worker: "w", machine: "m", instance: "i1" });
  const opened = await engine.open({ node_id: "task-x", factory: "factory-x", gates: [] });
  const id = opened.execution.execution_id;
  const store = { ...engine, ...fakeStore() };
  const client = { ...fakeClient({ lose: 1 }), observe: async () => ({ state: "running", since: new Date().toISOString() }) };
  const owned = new Map([[id, { store, fence: opened.fence, attempt: 1, client, node_id: "task-x", handle, credentialPending: true }]]);
  const lines = [];
  await providerAttempts.sweepProviderAttempts({ store: engine, owned, log: (l) => lines.push(l) });
  assert.equal(owned.get(id).credentialPending, true);
  assert.match(lines.join("\n"), /the attempt token was not delivered .*retried next pass/);
  assert.doesNotMatch(lines.join("\n"), /spor_att_/);
  await providerAttempts.sweepProviderAttempts({ store: engine, owned, log: (l) => lines.push(l) });
  assert.equal(owned.get(id).credentialPending, false);
  assert.equal(client.sent.length, 2);
});

// --------------------------------------------- the execution store's door

test("remote store: the mint posts {fence, machine, instance} to the attempt-token door and answers the server's token; revoke posts {fence, machine}", async () => {
  const posts = [];
  const remote = {
    post: async (cfg, p, body) => {
      posts.push([p, body]);
      if (p.endsWith("/attempt-token")) return { ok: true, status: 200, json: { ok: true, token: TOKEN, attempt_token: { token_id: "abc", token_ref: `spor-attempt-token://${EXEC}/2` } } };
      if (p.endsWith("/revoke")) return { ok: true, status: 200, json: { ok: true, revoked: 1 } };
      return { ok: false, status: 409, json: { error: { code: "fence_stale", message: "moved" } } };
    },
    get: async () => ({ ok: false, status: 404, json: null }),
  };
  const cfg = { mode: () => "remote", get: () => undefined, tenant: () => ({ org: "acme" }) };
  const store = executionStore.openExecutionStore(cfg, { home: scratch(), mode: "remote", machine: "box-1", instance: "inst-1", remote });
  const r = await store.mintAttemptToken(EXEC, { fence: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.token, TOKEN);
  assert.deepEqual(posts[0], [`/v1/executions/${EXEC}/attempt-token`, { fence: 2, instance: "inst-1", machine: "box-1" }]);
  assert.equal((await store.revokeAttemptToken(EXEC, { fence: 2 })).ok, true);
  assert.deepEqual(posts[1], [`/v1/executions/${EXEC}/attempt-token/revoke`, { fence: 2, machine: "box-1" }]);
  // Local mode has no server to honour a token: no mint door at all.
  const local = executionStore.openExecutionStore({ mode: () => "local", get: () => undefined }, { home: scratch(), mode: "local", instance: "i" });
  assert.equal(typeof local.mintAttemptToken, "undefined");
});

// ------------------------------------------------- the runner's token

test("the runner reads SPOR_TOKEN_FILE first, falls back to the environment, and waits (bounded) for a delivery", async () => {
  const dir = scratch();
  const file = path.join(dir, "spor-token");
  const resolve = (env, opts = {}) => attemptRunner.resolveAttemptToken(env, { waitMs: 0, pollMs: 1, ...opts });
  // env fallback when no file is named
  assert.deepEqual(await resolve({ SPOR_TOKEN: "env-token" }), { token: "env-token", source: "env" });
  assert.deepEqual(await resolve({ SPOR_DISPATCH_CHILD_TOKEN: "child", SPOR_TOKEN: "env" }), { token: "child", source: "env" });
  // the file wins over the environment
  fs.writeFileSync(file, `${TOKEN}\n`, { mode: 0o600 });
  assert.deepEqual(await resolve({ SPOR_TOKEN_FILE: file, SPOR_TOKEN: "env-token" }), { token: TOKEN, source: "file" });
  // anything but an attempt token in the file is refused, never echoed
  fs.writeFileSync(file, "spor_pat_0123456789abcdef0123\n", { mode: 0o600 });
  const bad = await resolve({ SPOR_TOKEN_FILE: file });
  assert.match(bad.error, /does not hold an attempt-scoped Spor token/);
  assert.doesNotMatch(bad.error, /spor_pat_0123/);
  assert.match((await resolve({ SPOR_TOKEN_FILE: "relative/token" })).error, /must be an absolute path/);
  // a delivery that lands while the runner waits is picked up
  const late = path.join(dir, "late-token");
  let slept = 0;
  const got = await attemptRunner.resolveAttemptToken({ SPOR_TOKEN_FILE: late }, {
    waitMs: 60000,
    pollMs: 1,
    sleep: async () => {
      if (++slept === 3) fs.writeFileSync(late, TOKEN, { mode: 0o600 });
    },
  });
  assert.deepEqual(got, { token: TOKEN, source: "file" });
  // one that never lands refuses — unless the attempt needs no token (a file:// graph)
  const missing = path.join(dir, "never");
  assert.match((await resolve({ SPOR_TOKEN_FILE: missing })).error, /the attempt token never arrived/);
  assert.deepEqual(await resolve({ SPOR_TOKEN_FILE: missing }, { needed: false }), { token: "", source: "file" });
});

test("the runner refuses a SPOR_TOKEN_FILE readable beyond its owner, without reading or echoing it", { skip: process.platform === "win32" && "no POSIX mode bits" }, async () => {
  const dir = scratch();
  const file = path.join(dir, "spor-token");
  fs.writeFileSync(file, `${TOKEN}\n`, { mode: 0o600 });
  const resolve = (env) => attemptRunner.resolveAttemptToken(env, { waitMs: 0, pollMs: 1 });
  assert.deepEqual(await resolve({ SPOR_TOKEN_FILE: file }), { token: TOKEN, source: "file" });
  fs.chmodSync(file, 0o400);
  assert.deepEqual(await resolve({ SPOR_TOKEN_FILE: file }), { token: TOKEN, source: "file" });
  for (const mode of [0o644, 0o640, 0o604, 0o620]) {
    fs.chmodSync(file, mode);
    const r = await resolve({ SPOR_TOKEN_FILE: file });
    assert.match(r.error, new RegExp(`grants access beyond its owner \\(mode ${mode.toString(8).padStart(4, "0")}\\) — the attempt token must be written 0600`), mode.toString(8));
    assert.doesNotMatch(r.error, /spor_att_/);
  }
  // a directory is not a token file
  assert.match((await resolve({ SPOR_TOKEN_FILE: dir })).error, /is not a regular file/);
});

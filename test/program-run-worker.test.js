// `spor work --serve program` — the worker half of program run requests
// (task-spor-chatgpt-run-worker-adapter; spor-server PROGRAM-RUN-WORKER.md).
//
// Three layers, all in-process and hermetic (no live server, no graph home):
//
//   1. the REST client + one-run SOURCE (lib/shell/program-runs.js) against a
//      stub of the server's run protocol that keeps the parts the worker relies
//      on — the (worker, machine, instance) parent lease, fence advance on
//      every acquisition after a release, terminal/pause/drain states, the
//      admission door's refusals, and the advisory event log;
//   2. the LOOP (lib/shell/work-loop.js) driven over that source with a fake
//      queue and the real admission wrapper (`admitThrough`), proving the
//      `admitting` predicate gates fresh dispatch only, local stops release
//      instead of halting, and a local no-work reading never ends a run;
//   3. the remote execution adapter's open carrying the admission binding.
const test = require("node:test");
const assert = require("node:assert");

const programRuns = require("../lib/shell/program-runs.js");
const workLoop = require("../lib/shell/work-loop.js");
const executionStore = require("../lib/shell/execution-store.js");

// ------------------------------------------------------------- the stub --

const TTL = 15 * 60 * 1000;
const PIN = { factory_revision: "f".repeat(40), gates: [{ id: "tests", node_id: null, revision: null }, { id: "review", node_id: "gate-review", revision: "a".repeat(40) }] };

function stubServer({ clock, runs = [], workers = { "tok-a": "agent-a", "tok-b": "agent-b" } } = {}) {
  const state = { runs: new Map(), events: [], requests: [], admissions: [], down: false };
  for (const r of runs) {
    state.runs.set(r.run_id, {
      run_id: r.run_id,
      program_id: r.program_id || "task-prog",
      factory: { node_id: r.factory || "factory-x" },
      state: r.state || "requested",
      admitted: (r.admitted || ["task-a", "task-b"]).map((id) => ({ node_id: id, revision: null })),
      done: new Set(r.done || []),
      released: [],
      factory_pins: [{ ...PIN, pinned_at: "2026-10-08T00:00:00Z", by: "person-p", via: "start" }],
      owner: null,
      fence: 0,
      children: [],
    });
  }
  const now = () => clock.now;
  const live = (o) => !!o && Date.parse(o.lease_expires_at) > now();
  const same = (o, w) => !!o && o.worker === w.worker && o.machine === w.machine && o.instance === w.instance;
  const view = (r) => ({
    run_id: r.run_id,
    program_id: r.program_id,
    factory: r.factory,
    state: r.state,
    admitted: r.admitted,
    released: r.released,
    remaining: r.admitted.map((a) => a.node_id).filter((id) => !r.done.has(id)),
    factory_pins: r.factory_pins,
    pin: r.factory_pins[r.factory_pins.length - 1],
    owner: r.owner ? { ...r.owner, live: live(r.owner) } : null,
    terminal: ["completed", "drained", "cancelled"].includes(r.state),
  });
  const err = (status, code, message, extra = {}) => ({ status, json: { error: { code, message, details: [] }, ...extra } });
  const ok = (body) => ({ status: 200, json: { ok: true, ...body } });
  const refusal = (r, w, fence, { requireLive = true } = {}) => {
    const o = r.owner;
    if (!o) return err(409, "not_owned", "the run has no live controller");
    if (!same(o, w)) return err(409, "not_owned", "another instance", { holder: { ...o } });
    if (Number(fence) !== o.fence) return err(409, "fence_stale", `fence ${fence} is stale`, { holder: { ...o } });
    if (requireLive && !live(o)) return err(409, "lease_expired", "expired", { holder: { ...o } });
    return null;
  };
  function handle(method, p, body, bearer) {
    state.requests.push({ method, path: p, body, bearer });
    if (state.down) return { transport: true, error: "connect ECONNREFUSED" };
    const worker = workers[bearer];
    const u = new URL(p, "http://stub");
    const m = u.pathname.match(/^\/v1\/program-runs(?:\/([^/]+)(?:\/([a-z-]+))?)?$/);
    if (!m) return { status: 404, json: null };
    const [, id, verb] = m;
    if (method === "GET" && !id) {
      const factory = u.searchParams.get("factory");
      const list = [...state.runs.values()].filter((r) => (!factory || r.factory.node_id === factory) && !["completed", "drained", "cancelled"].includes(r.state) && !live(r.owner));
      return ok({ runs: list.map(view), count: list.length });
    }
    const r = state.runs.get(decodeURIComponent(id || ""));
    if (!r) return err(404, "not_found", `no such program run '${id}'`);
    if (method === "GET" && !verb) return ok({ run: view(r) });
    const w = { worker, machine: body && body.machine, instance: body && body.instance };
    const terminal = ["completed", "drained", "cancelled"].includes(r.state);
    if (verb === "claim") {
      if (terminal) return err(409, "run_terminal", `run is ${r.state}`, { run: view(r) });
      const isLive = live(r.owner);
      const mine = same(r.owner, w);
      if (isLive && !mine) return err(409, "already_owned", `run is controlled by ${r.owner.worker}`, { holder: { ...r.owner } });
      const fence = isLive && mine ? r.owner.fence : r.fence + 1;
      r.fence = fence;
      r.owner = { ...w, fence, lease_expires_at: new Date(now() + TTL).toISOString(), capabilities: body.capabilities || null };
      if (r.state === "requested") r.state = "running";
      return ok({ run: view(r), fence });
    }
    if (verb === "renew") {
      if (terminal) return err(409, "run_terminal", `run is ${r.state}`, { run: view(r) });
      const no = refusal(r, w, body.fence);
      if (no) return no;
      r.owner.lease_expires_at = new Date(now() + TTL).toISOString();
      return ok({ run: view(r), fence: r.owner.fence });
    }
    if (verb === "release") {
      if (!r.owner) return ok({ run: view(r), replayed: true });
      const no = refusal(r, w, body.fence, { requireLive: false });
      if (no) return no;
      r.owner = null; // NOT terminal; the fence counter is kept on the run
      return ok({ run: view(r) });
    }
    if (verb === "events") {
      if (terminal) return err(409, "run_terminal", `run is ${r.state}`);
      const no = refusal(r, w, body.fence);
      if (no) return no;
      state.events.push({ run_id: r.run_id, ...body.event, worker, machine: w.machine, instance: w.instance });
      if (body.event.type === "drift.observed") {
        // The server re-reads the factory ITSELF; the worker's word is a trigger.
        const drifted = JSON.stringify(state.actualPin || PIN) !== JSON.stringify({ factory_revision: r.factory_pins.at(-1).factory_revision, gates: r.factory_pins.at(-1).gates });
        if (drifted && r.state === "running") r.state = "paused";
        return ok({ run: view(r), drifted });
      }
      return ok({ run: view(r) });
    }
    if (verb === "factory") return ok({ pin: r.factory_pins[r.factory_pins.length - 1], factory: { node_id: r.factory.node_id, revision: PIN.factory_revision, raw: "---\n---\n" }, gates: [] });
    return err(404, "not_found", "no such route");
  }
  // The admission door (POST /v1/executions with program_run), as the
  // dispatcher's execution open reaches it: the same ownership check, then the
  // run state, then membership.
  state.admit = (item, binding, bearer) => {
    const r = state.runs.get(binding.run_id);
    state.admissions.push({ node_id: item.id, binding });
    if (!r) return { ok: false, code: "not_found", message: "no such run" };
    const no = refusal(r, { worker: workers[bearer], machine: binding.machine || "box-1", instance: binding.instance }, binding.fence);
    if (no) return { ok: false, code: no.json.error.code, message: no.json.error.message };
    if (r.state !== "running") return { ok: false, code: r.state === "paused" ? "run_paused" : r.state === "draining" ? "run_draining" : "run_terminal", message: `run is ${r.state}` };
    if (!r.admitted.some((a) => a.node_id === item.id)) return { ok: false, code: "not_admitted", message: "not admitted" };
    r.children.push({ node_id: item.id, fence: binding.fence });
    return { ok: true };
  };
  state.handle = handle;
  return state;
}

// A `remote` stand-in that routes through the stub with one bearer, shaped
// exactly like lib/remote.js's answers ({ok, status, json} or {transport}).
function remoteFor(server, bearer) {
  const call = async (method, p, body) => {
    const r = server.handle(method, p, body, bearer);
    if (r.transport) return { ok: false, transport: true, error: r.error };
    return { ok: r.status < 300, status: r.status, json: r.json };
  };
  return { get: (_cfg, p) => call("GET", p, null), post: (_cfg, p, body) => call("POST", p, body) };
}

function sourceFor(server, { bearer = "tok-a", machine = "box-1", instance = "inst-1", clock, eligible = null, recheck = null, log = [], cooldownMs = 60_000 } = {}) {
  const client = programRuns.createProgramRunClient({}, { remote: remoteFor(server, bearer), machine, instance });
  const source = programRuns.createRunSource({
    client,
    factoryId: "factory-x",
    capabilities: () => ({ factory: { node_id: "factory-x", revision: PIN.factory_revision }, concurrency: 2, machine: { harnesses: ["claude-code"], reachable_mcp: ["spor"], skills: [], plugins: [], deny: [], gh: true } }),
    eligible,
    recheck,
    log: (l) => log.push(l),
    now: () => clock.now,
    cooldownMs,
  });
  return { client, source, log };
}

// ------------------------------------------------------- pins and tuples --

test("pinTupleOf spells a parsed factory exactly as the server's pinFactory does", () => {
  const factory = {
    revision: PIN.factory_revision,
    gates: [{ id: "tests", source: "inline" }, { id: "review", source: "gate-review" }],
    definition: { factory: { revision: PIN.factory_revision }, gates: [{ id: "tests", revision: PIN.factory_revision }, { id: "review", revision: "a".repeat(40) }] },
  };
  const tuple = programRuns.pinTupleOf(factory);
  assert.deepStrictEqual(tuple, { factory_revision: PIN.factory_revision, gates: [{ id: "tests", node_id: null, revision: null }, { id: "review", node_id: "gate-review", revision: "a".repeat(40) }] });
  // The server's pin carries provenance and per-gate flags; they never count.
  assert.ok(programRuns.sameTuple(tuple, { ...PIN, pinned_at: "x", by: "y", via: "start", gates: PIN.gates.map((g) => ({ ...g, rejudge_on_repin: true })) }));
  // A gate-node edit (same factory blob) IS drift.
  assert.ok(!programRuns.sameTuple(tuple, { ...PIN, gates: [PIN.gates[0], { ...PIN.gates[1], revision: "b".repeat(40) }] }));
});

test("the advertisement stays under the server's bound by shedding the long lists first", () => {
  const big = { factory: { node_id: "f", revision: "r" }, concurrency: 1, code: { stamp: "s" }, machine: { harnesses: ["claude-code"], skills: Array.from({ length: 2000 }, (_, i) => `skill-${i}`), plugins: [] } };
  const bounded = programRuns.boundAdvertisement(big);
  assert.ok(JSON.stringify(bounded).length <= programRuns.MAX_ADVERTISEMENT_BYTES);
  assert.deepStrictEqual(bounded.machine.harnesses, ["claude-code"], "the profile-matching atoms survive");
  assert.strictEqual(bounded.machine.truncated, true);
  assert.deepStrictEqual(bounded.factory, big.factory);
});

// ------------------------------------------------- the source (one run) --

test("claim: the first claimable run is taken with (machine, instance) and the advertisement; renew reads its state", async () => {
  const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
  const server = stubServer({ clock, runs: [{ run_id: "prun-0000000000000001" }] });
  const { source } = sourceFor(server, { clock });
  const v = await source.pass();
  assert.strictEqual(v.owned, true);
  assert.strictEqual(v.run_id, "prun-0000000000000001");
  assert.strictEqual(v.fence, 1);
  assert.strictEqual(v.admitting, true, "Start -> first claim -> running");
  assert.deepStrictEqual([...v.remaining], ["task-a", "task-b"]);
  const claim = server.requests.find((r) => r.path.endsWith("/claim"));
  assert.strictEqual(claim.body.machine, "box-1");
  assert.strictEqual(claim.body.instance, "inst-1");
  assert.deepStrictEqual(claim.body.capabilities.machine.harnesses, ["claude-code"], "capabilities ride the claim in satisfies()' atom vocabulary");
  assert.deepStrictEqual(source.binding(), { run_id: "prun-0000000000000001", fence: 1, instance: "inst-1" });
  const listing = server.requests.find((r) => r.method === "GET");
  assert.match(listing.path, /claimable=true&factory=factory-x/);
  // The next pass RENEWS — it never claims a second run.
  clock.now += 30_000;
  await source.pass();
  assert.strictEqual(server.requests.filter((r) => r.path.endsWith("/claim")).length, 1);
  assert.strictEqual(server.requests.filter((r) => r.path.endsWith("/renew")).length, 1);
});

test("duplicate controllers are fenced: a second instance (same agent, same box) cannot claim a live run", async () => {
  const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
  const server = stubServer({ clock, runs: [{ run_id: "prun-0000000000000001" }] });
  const a = sourceFor(server, { clock, instance: "inst-1" });
  const b = sourceFor(server, { clock, instance: "inst-2" });
  assert.strictEqual((await a.source.pass()).owned, true);
  // The listing hides a live-owned run; even a direct claim is refused.
  assert.strictEqual((await b.source.pass()).owned, false);
  const direct = await b.client.claim("prun-0000000000000001", {});
  assert.strictEqual(direct.ok, false);
  assert.strictEqual(direct.code, "already_owned");
  assert.strictEqual(direct.holder.instance, "inst-1");
  // ...and its admission under a borrowed fence is refused too.
  const forged = server.admit({ id: "task-a" }, { run_id: "prun-0000000000000001", fence: 1, instance: "inst-2" }, "tok-a");
  assert.strictEqual(forged.code, "not_owned");
});

test("restart: a released run is re-claimed by the NEW instance at the next fence, and the old fence is dead", async () => {
  const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
  const server = stubServer({ clock, runs: [{ run_id: "prun-0000000000000001" }] });
  const first = sourceFor(server, { clock, instance: "inst-1" });
  await first.source.pass();
  const oldBinding = first.source.binding();
  await first.source.release("local.signal");
  const ev = server.events.find((e) => e.type === "worker.observed");
  assert.strictEqual(ev.local_reason, "local.signal", "the local reason is reported before the release");
  assert.strictEqual(server.runs.get("prun-0000000000000001").state, "running", "a local stop never changes the run's global state");
  const restarted = sourceFor(server, { clock, instance: "inst-2" });
  const v = await restarted.source.pass();
  assert.strictEqual(v.owned, true);
  assert.strictEqual(v.fence, 2, "an acquisition after a release always advances the fence");
  assert.strictEqual(server.admit({ id: "task-a" }, oldBinding, "tok-a").code, "not_owned", "the predecessor can no longer admit");
  assert.strictEqual(server.admit({ id: "task-a" }, restarted.source.binding(), "tok-a").ok, true);
});

test("restart after a hard kill waits out the predecessor's lease, then claims", async () => {
  const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
  const server = stubServer({ clock, runs: [{ run_id: "prun-0000000000000001" }] });
  await sourceFor(server, { clock, instance: "inst-1" }).source.pass(); // then SIGKILL: no release
  const next = sourceFor(server, { clock, instance: "inst-2" });
  assert.strictEqual((await next.source.pass()).owned, false, "a live lease is never stolen");
  clock.now += TTL + 1000;
  const v = await next.source.pass();
  assert.strictEqual(v.owned, true);
  assert.strictEqual(v.fence, 2);
});

test("lease lost on renew: ownership is dropped without a release, and nothing more is admitted", async () => {
  const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
  const server = stubServer({ clock, runs: [{ run_id: "prun-0000000000000001" }] });
  const a = sourceFor(server, { clock, instance: "inst-1" });
  await a.source.pass();
  clock.now += TTL + 1000; // stalled past the TTL
  const b = sourceFor(server, { clock, instance: "inst-2", machine: "box-2" });
  assert.strictEqual((await b.source.pass()).fence, 2, "takeover of the expired lease");
  const v = await a.source.pass();
  assert.strictEqual(v.owned, false);
  assert.strictEqual(a.source.binding(), null);
  assert.ok(!server.requests.some((r) => r.path.endsWith("/release")), "a lost lease is not released over the new owner");
  assert.strictEqual(a.source.status().local_reason.reason, "local.lease_lost");
  assert.ok(a.log.some((l) => /lost the run lease \(not_owned/.test(l)), a.log.join("\n"));
});

test("pause stops admitting (fresh dispatch only); resume restores it; a server-ended run is dropped and polling resumes", async () => {
  const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
  const server = stubServer({ clock, runs: [{ run_id: "prun-0000000000000001" }, { run_id: "prun-0000000000000002" }] });
  const { source, log } = sourceFor(server, { clock });
  assert.strictEqual((await source.pass()).run_id, "prun-0000000000000001");
  server.runs.get("prun-0000000000000001").state = "paused";
  assert.strictEqual((await source.pass()).admitting, false);
  assert.strictEqual(source.status().state, "paused");
  server.runs.get("prun-0000000000000001").state = "running";
  assert.strictEqual((await source.pass()).admitting, true);
  server.runs.get("prun-0000000000000001").state = "completed";
  const v = await source.pass();
  assert.strictEqual(v.run_id, "prun-0000000000000002", "a completed run is the server's word; the worker moves on to the next");
  assert.ok(log.some((l) => /the server ended the run \(completed\)/.test(l)), log.join("\n"));
});

test("an unreachable server keeps the claim but admits nothing until it answers", async () => {
  const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
  const server = stubServer({ clock, runs: [{ run_id: "prun-0000000000000001" }] });
  const { source } = sourceFor(server, { clock });
  await source.pass();
  server.down = true;
  const v = await source.pass();
  assert.strictEqual(v.owned, true);
  assert.strictEqual(v.admitting, false);
  assert.strictEqual(source.status().local_reason.reason, "local.server_unreachable");
  server.down = false;
  assert.strictEqual((await source.pass()).admitting, true);
});

test("the local filter: a run this box cannot run is not claimed and is cooled", async () => {
  const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
  const server = stubServer({ clock, runs: [{ run_id: "prun-0000000000000001" }] });
  let asked = 0;
  const { source, log } = sourceFor(server, { clock, eligible: async () => (asked++, { ok: false, reason: "factory not satisfiable here: gh missing", localReason: "local.no_capable_member" }) });
  assert.strictEqual((await source.pass()).owned, false);
  assert.ok(!server.requests.some((r) => r.path.endsWith("/claim")));
  await source.pass();
  assert.strictEqual(asked, 1, "cooled: not re-asked inside the cooldown");
  assert.ok(log.some((l) => /not claiming program run prun-0000000000000001 .* gh missing/.test(l)));
});

test("local.no_capable_member: reported, released for another machine, and cooled here", async () => {
  const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
  const server = stubServer({ clock, runs: [{ run_id: "prun-0000000000000001" }] });
  const { source } = sourceFor(server, { clock });
  await source.pass();
  await source.release("local.no_capable_member", "task-b (profile-x not satisfiable)");
  assert.strictEqual(server.runs.get("prun-0000000000000001").owner, null);
  assert.strictEqual(server.runs.get("prun-0000000000000001").state, "running", "local unsatisfiability is not global");
  assert.strictEqual(server.events.at(-1).local_reason, "local.no_capable_member");
  assert.strictEqual((await source.pass()).owned, false, "not re-claimed by this box inside the cooldown");
  const other = sourceFor(server, { clock, instance: "inst-9", machine: "box-9" });
  assert.strictEqual((await other.source.pass()).owned, true, "a capable machine claims it at once");
});

test("factory drift seen on reload: reported once as drift.observed, and admissions stop", async () => {
  const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
  const server = stubServer({ clock, runs: [{ run_id: "prun-0000000000000001" }] });
  const { source } = sourceFor(server, { clock });
  await source.pass();
  assert.strictEqual(await source.checkPin(PIN), false, "HEAD equals the pin: no drift");
  const moved = { ...PIN, factory_revision: "e".repeat(40) };
  server.actualPin = moved; // the server's own re-read sees the edit too
  assert.strictEqual(await source.checkPin(moved), true);
  assert.strictEqual(await source.checkPin(moved), true);
  assert.strictEqual(server.events.filter((e) => e.type === "drift.observed").length, 1, "reported once per (run, fence, target)");
  assert.strictEqual(source.admitting(), false);
  assert.match(source.status().holding, /^factory_changed: ffffffffffff -> eeeeeeeeeeee$/);
  assert.strictEqual(server.runs.get("prun-0000000000000001").state, "paused", "the server paused the run on drift it saw itself");
});

test("admission refusals: run-state codes stop admitting, ownership codes drop the run, item codes stay the item's", async () => {
  const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
  const server = stubServer({ clock, runs: [{ run_id: "prun-0000000000000001" }] });
  const { source } = sourceFor(server, { clock });
  await source.pass();
  assert.strictEqual(source.admissionRefused("not_admitted", "x"), false);
  assert.strictEqual(source.admissionRefused("run_draining", "draining"), true);
  assert.strictEqual(source.admitting(), false);
  await source.pass(); // the renew reads it running again
  assert.strictEqual(source.admitting(), true);
  assert.strictEqual(source.admissionRefused("fence_stale", "stale"), true);
  assert.strictEqual(source.binding(), null);
});

test("admitThrough: carries the binding, and turns the run's own refusal into stopAdmitting", async () => {
  const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
  const server = stubServer({ clock, runs: [{ run_id: "prun-0000000000000001" }] });
  const { source } = sourceFor(server, { clock });
  const door = programRuns.admitThrough(source, async (item, binding) => {
    const r = server.admit(item, binding, "tok-a");
    return r.ok ? { ok: true, run: { run_id: `run-${item.id}` } } : { ok: false, reason: `execution store refused ${item.id}: ${r.code}: ${r.message}`, admission_code: r.code, message: r.message };
  });
  assert.deepStrictEqual(await door({ id: "task-a" }), { ok: false, stopAdmitting: true, reason: "no program run is owned any more" });
  await source.pass();
  assert.strictEqual((await door({ id: "task-a" })).ok, true);
  assert.deepStrictEqual(server.admissions.at(-1).binding, { run_id: "prun-0000000000000001", fence: 1, instance: "inst-1" });
  const outsider = await door({ id: "task-zzz" });
  assert.strictEqual(outsider.admission_code, "not_admitted");
  assert.ok(!outsider.stopAdmitting, "a non-member is the item's refusal, cooled like any other");
  server.runs.get("prun-0000000000000001").state = "paused";
  const paused = await door({ id: "task-b" });
  assert.strictEqual(paused.stopAdmitting, true);
});

// ---------------------------------------------------------------- the loop --

// The loop over the real source and admission wrapper, with a fake queue: a
// dispatched member finishes (and is done by graph truth) on the next wait.
const observed = (server) => server.events.filter((e) => e.type === "worker.observed").map((e) => e.local_reason);

// `readiness` (id -> readiness) overrides the page's "agent" for a member, and
// is what the source's `recheck` reads while a released run cools.
function loopHarness({ server, clock, members = ["task-a", "task-b"], human = [], unsatisfiable = [], extraQueue = [], refuse = () => null, opts = {}, maxPasses = 12, onTick = () => {}, pendingGates = null, readiness = () => "agent" } = {}) {
  const state = { dispatched: [], runs: new Map(), sleeps: [], candidateCalls: 0, pendingGateCalls: 0, published: [], rechecks: [] };
  const recheck = async (ids) => {
    state.rechecks.push(ids);
    return ids.filter((id) => members.includes(id) && readiness(id) === "agent");
  };
  const { source, log } = sourceFor(server, { clock, recheck, cooldownMs: 10_000 });
  const control = { stopping: false, reason: null, wake: () => {} };
  const done = () => {
    const r = [...server.runs.values()][0];
    return r ? r.done : new Set();
  };
  const program = async () => {
    const v = source.view();
    if (!v.owned) return { error: "no program run owned" };
    const snap = {
      found: true,
      root_id: v.program_id,
      truncated: false,
      members: [...members, ...human, ...unsatisfiable].map((id) => ({ id, bucket: done().has(id) ? "done" : "open", status: done().has(id) ? "done" : "open", human: human.includes(id) ? "requires human" : null, blockers: [] })),
    };
    return programRuns.scopeSnapshotToRun(snap, v.run);
  };
  const deps = {
    now: () => clock.now,
    log: (l) => log.push(l),
    publish: (s) => state.published.push(JSON.parse(JSON.stringify(s))),
    runSource: source,
    program,
    candidates: async () => {
      state.candidateCalls += 1;
      const taken = new Set(state.dispatched.map((d) => d.id));
      const page = [...members, ...unsatisfiable, ...human].filter((id) => !done().has(id) && !taken.has(id)).map((id) => ({ id, readiness: human.includes(id) ? "human" : readiness(id), ...(human.includes(id) ? { readiness_reasons: ["requires human"] } : {}) }));
      return page.concat(extraQueue.map((id) => ({ id, readiness: "agent" })));
    },
    dispatch: programRuns.admitThrough(source, async (item, binding) => {
      if (unsatisfiable.includes(item.id)) return { ok: false, reason: `profile for ${item.id} not satisfiable here` };
      const refused = refuse(item, state);
      if (refused) return refused;
      const r = server.admit(item, binding, "tok-a");
      if (!r.ok) return { ok: false, reason: `execution store refused ${item.id}: ${r.code}: ${r.message}`, admission_code: r.code, message: r.message };
      const runId = `run-${item.id}`;
      state.runs.set(runId, { run_id: runId, node_id: item.id, terminal: false });
      state.dispatched.push({ id: item.id, run_id: runId });
      return { ok: true, run: { run_id: runId, harness: "fake" } };
    }),
    pollRuns: async (ids) => ids.map((id) => ({ run_id: id, terminal: !!state.runs.get(id).terminal, record: { ...state.runs.get(id), state: state.runs.get(id).terminal ? "done" : "running", terminal_state: "resolved", terminal_enforced: true } })),
    ...(pendingGates ? { gate: async () => ({ state: "passed" }), pendingGates: async () => (state.pendingGateCalls++, pendingGates()) } : {}),
    sleep: async (ms) => {
      state.sleeps.push(ms);
      clock.now += ms;
      for (const r of state.runs.values()) {
        if (!r.terminal) {
          r.terminal = true;
          done().add(r.node_id);
        }
      }
      onTick(state, state.sleeps.length);
      if (state.sleeps.length >= maxPasses) {
        control.stopping = true;
        control.reason = control.reason || "stopped by the test driver";
      }
    },
  };
  state.run = () => workLoop.runWorkLoop({ opts: { workerId: "inst-1", pid: 4242, intervalMs: 1000, maxIntervalMs: 4000, retryAfterMs: 10_000, concurrency: 2, accept: "open", ...opts }, control, deps });
  state.log = log;
  state.control = control;
  state.source = source;
  return state;
}

test("loop: only admitted members are dispatched; a local 'all done' never ends the run or the worker", async () => {
  const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
  const server = stubServer({ clock, runs: [{ run_id: "prun-0000000000000001", admitted: ["task-a", "task-b"] }] });
  // task-c is in the program and on the queue, but NOT admitted; task-out is neither.
  const h = loopHarness({ server, clock, members: ["task-a", "task-b", "task-c"], extraQueue: ["task-out"], maxPasses: 5 });
  const status = await h.run();
  assert.deepStrictEqual(h.dispatched.map((d) => d.id).sort(), ["task-a", "task-b"]);
  assert.strictEqual(status.stop_code, "signal", "the worker kept polling until the driver stopped it — no program-terminal exit");
  assert.ok(h.log.some((l) => /every admitted member reads terminal here; waiting for the server to complete the run/.test(l)), h.log.join("\n"));
  assert.ok(!status.program, "a serve worker carries no --program status block");
  assert.strictEqual(status.serve.run_id, null, "the stop released the run");
  assert.strictEqual(server.runs.get("prun-0000000000000001").owner, null);
  assert.strictEqual(server.events.at(-1).local_reason, "local.signal");
  assert.strictEqual(server.runs.get("prun-0000000000000001").state, "running", "local completion is never global completion");
});

test("loop: with no owned run the worker takes NO queue work at all", async () => {
  const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
  const server = stubServer({ clock, runs: [] });
  const h = loopHarness({ server, clock, extraQueue: ["task-out"], maxPasses: 3 });
  await h.run();
  assert.strictEqual(h.candidateCalls, 0);
  assert.deepStrictEqual(h.dispatched, []);
});

test("loop: an idle serve worker with no owned run polls at the base interval, never the idle backoff", async () => {
  const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
  const server = stubServer({ clock, runs: [] });
  const h = loopHarness({ server, clock, maxPasses: 6 });
  await h.run();
  assert.deepStrictEqual(h.sleeps, [1000, 1000, 1000, 1000, 1000, 1000], "a Start is claimed within one intervalMs, not after a backoff to maxIntervalMs");
});

test("loop: an unowned serve worker whose run listing is FAILING keeps the idle backoff", async () => {
  const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
  const server = stubServer({ clock, runs: [] });
  server.down = true;
  const h = loopHarness({ server, clock, maxPasses: 4 });
  await h.run();
  assert.deepStrictEqual(h.sleeps, [1000, 2000, 4000, 4000], "a dead server is not polled every interval");
});

test("loop: a member skipped as not agent-ready and stamped ready inside the cooldown is dispatched next pass — no release on the stale verdict", async () => {
  const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
  const server = stubServer({ clock, runs: [{ run_id: "prun-0000000000000001", admitted: ["task-f"] }] });
  let ready = false;
  const h = loopHarness({
    server,
    clock,
    members: ["task-f"],
    readiness: () => (ready ? "agent" : "untriaged"),
    opts: { accept: "ready", concurrency: 1 },
    maxPasses: 3,
    // t1 = t0 + 1s, well inside retryAfterMs (10s).
    onTick: (_s, n) => { if (n === 1) ready = true; },
  });
  await h.run();
  assert.ok(h.log.some((l) => /skipping task-f — not agent-ready/.test(l)), h.log.join("\n"));
  assert.deepStrictEqual(h.dispatched.map((d) => d.id), ["task-f"], h.log.join("\n"));
  assert.ok(!observed(server).includes("local.no_capable_member"), `never released on the stale verdict:\n${h.log.join("\n")}`);
});

test("loop: a run released over a not-agent-ready member is re-claimed on the next pass once it reads ready", async () => {
  const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
  const server = stubServer({ clock, runs: [{ run_id: "prun-0000000000000001", admitted: ["task-f"] }] });
  let ready = false;
  let readyAtPass = null;
  const h = loopHarness({
    server,
    clock,
    members: ["task-f"],
    readiness: () => (ready ? "agent" : "untriaged"),
    opts: { accept: "ready", concurrency: 1 },
    maxPasses: 6,
    onTick: (_s, n) => {
      if (!ready && observed(server).includes("local.no_capable_member")) {
        ready = true;
        readyAtPass = n;
      }
    },
  });
  await h.run();
  assert.ok(readyAtPass, `the run was released first:\n${h.log.join("\n")}`);
  assert.deepStrictEqual(h.dispatched.map((d) => d.id), ["task-f"], h.log.join("\n"));
  assert.deepStrictEqual(h.rechecks[0], ["task-f"], "the cooled run re-reads the member it was released over");
  assert.ok(h.log.some((l) => /released over now reads runnable here .*lifting its cooldown/.test(l)), h.log.join("\n"));
  const claims = server.requests.filter((r) => r.path.endsWith("/claim"));
  assert.strictEqual(claims.length, 2, "re-claimed once, inside the 10s cooldown");
  // Re-claimed on the very next pass after readiness: ready was set at the end
  // of sleep `readyAtPass`, and the claim's clock is one interval later.
  assert.ok(h.log.findIndex((l) => /claimed program run .* at fence 2/.test(l)) > -1, h.log.join("\n"));
});

test("a release over only capability/profile refusals keeps the full cooldown; a re-derivable one lifts when the recheck says so", async () => {
  const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
  const server = stubServer({ clock, runs: [{ run_id: "prun-0000000000000001" }] });
  const asked = [];
  let runnable = false;
  const { source } = sourceFor(server, { clock, recheck: async (ids) => (asked.push(ids), runnable ? ids : []) });
  await source.pass();
  await source.release("local.no_capable_member", "task-b (profile-x not satisfiable)");
  assert.strictEqual((await source.pass()).owned, false);
  assert.deepStrictEqual(asked, [], "nothing to re-read: a capability refusal is not changed by the graph");

  await source.release("local.no_capable_member"); // no-op: not owned
  const other = sourceFor(server, { clock, instance: "inst-2", recheck: async (ids) => (asked.push(ids), runnable ? ids : []) });
  assert.strictEqual((await other.source.pass()).owned, true);
  await other.source.release("local.no_capable_member", "task-a (not agent-ready); task-b (profile)", { recheck: ["task-a"] });
  assert.strictEqual((await other.source.pass()).owned, false, "still not ready: cooled");
  assert.deepStrictEqual(asked, [["task-a"]]);
  runnable = true;
  assert.strictEqual((await other.source.pass()).owned, true, "ready now: the cooldown lifts and the run is claimed this pass");
});

test("cooled runs share ONE recheck read per claim attempt; a failed listing, claim or recheck read marks the pass an outage", async () => {
  const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
  const server = stubServer({ clock, runs: [{ run_id: "prun-0000000000000001" }, { run_id: "prun-0000000000000002" }] });
  const asked = [];
  let runnable = [];
  let fail = false;
  const { source } = sourceFor(server, {
    clock,
    recheck: async (ids) => {
      asked.push(ids);
      if (fail) throw new Error("queue down");
      return ids.filter((id) => runnable.includes(id));
    },
  });
  assert.strictEqual((await source.pass()).run_id, "prun-0000000000000001");
  await source.release("local.no_capable_member", "task-a (not agent-ready)", { recheck: ["task-a"] });
  assert.strictEqual((await source.pass()).run_id, "prun-0000000000000002", "the first run cools; the second is claimed");
  await source.release("local.no_capable_member", "task-c (not agent-ready)", { recheck: ["task-c"] });
  asked.length = 0;
  let v = await source.pass();
  assert.strictEqual(v.owned, false);
  assert.strictEqual(v.outage, false);
  assert.deepStrictEqual(asked, [["task-a", "task-c"]], "one read over both cooled runs' members, not one per run");
  asked.length = 0;
  runnable = ["task-c"];
  v = await source.pass();
  assert.strictEqual(v.run_id, "prun-0000000000000002", "only the run whose member reads runnable lifts");
  assert.deepStrictEqual(asked, [["task-a", "task-c"]]);
  await source.release("local.no_capable_member", "task-c (not agent-ready)", { recheck: ["task-c"] });
  runnable = [];
  fail = true;
  v = await source.pass();
  assert.strictEqual(v.owned, false);
  assert.strictEqual(v.outage, true, "a failed recheck read is an outage: the idle backoff holds");
  fail = false;
  assert.strictEqual((await source.pass()).outage, false);
  server.down = true;
  assert.strictEqual((await source.pass()).outage, true, "a failed listing is an outage");
  server.down = false;
  // A listing that answers but a claim that does not (transport) is one too.
  clock.now += 120_000; // both cooldowns lapse
  const handle = server.handle;
  server.handle = (method, p, body, bearer) => (p.endsWith("/claim") ? (server.requests.push({ method, path: p }), { transport: true, error: "ECONNRESET" }) : handle(method, p, body, bearer));
  v = await source.pass();
  assert.strictEqual(v.owned, false);
  assert.strictEqual(v.outage, true, "a transient claim failure is an outage");
});

test("selectWorkCandidates / classifyProgramMember: a re-derivable cooldown never hides a fresh page reading; an attempt cooldown still does", () => {
  const now = Date.parse("2026-10-09T12:00:00Z");
  const cooledAs = (kind) => new Map([["task-a", { reason: "earlier", kind, until: now + 600_000 }]]);
  const ready = { id: "task-a", readiness: "agent" };
  for (const kind of ["policy", "scope", "human", "invalid", "declined", "assigned-elsewhere"]) {
    const cleared = [];
    const out = workLoop.selectWorkCandidates([ready], { skipped: cooledAs(kind), now, accept: "ready", onClear: (it) => cleared.push(it.id) });
    assert.deepStrictEqual(out.map((it) => it.id), ["task-a"], kind);
    assert.deepStrictEqual(cleared, ["task-a"], kind);
    const m = workLoop.programStanding({ members: [{ id: "task-a", bucket: "open", status: "open" }], queue: { complete: true, located: new Map([["task-a", ready]]) } }, { page: new Map([["task-a", ready]]), policy: { accept: "ready" }, skipped: cooledAs(kind), now });
    assert.strictEqual(m.members[0].bucket, "runnable", kind);
  }
  // Still ineligible under the SAME kind: skipped quietly (logged once, when cooled).
  const skips = [];
  const untriaged = { id: "task-a", readiness: "untriaged" };
  assert.deepStrictEqual(workLoop.selectWorkCandidates([untriaged], { skipped: cooledAs("policy"), now, accept: "ready", onSkip: (it, r, k) => skips.push(k) }), []);
  assert.deepStrictEqual(skips, []);
  // ...and its standing is this pass's reading, not the cooldown's.
  const st = workLoop.programStanding({ members: [{ id: "task-a", bucket: "open", status: "open" }], queue: { complete: true, located: new Map([["task-a", untriaged]]) } }, { page: new Map([["task-a", untriaged]]), policy: { accept: "ready" }, skipped: cooledAs("policy"), now });
  assert.strictEqual(st.members[0].bucket, "ineligible");
  assert.strictEqual(st.members[0].kind, "policy");
  // An attempt cooldown (a dispatch refusal) still decides.
  assert.deepStrictEqual(workLoop.selectWorkCandidates([ready], { skipped: cooledAs("refusal"), now, accept: "ready" }), []);
  const rf = workLoop.programStanding({ members: [{ id: "task-a", bucket: "open", status: "open" }], queue: { complete: true, located: new Map([["task-a", ready]]) } }, { page: new Map([["task-a", ready]]), policy: { accept: "ready" }, skipped: cooledAs("refusal"), now });
  assert.strictEqual(rf.members[0].bucket, "cooling");
});

test("loop: a paused run admits nothing, but open gate pipelines are still resumed", async () => {
  const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
  const server = stubServer({ clock, runs: [{ run_id: "prun-0000000000000001", state: "paused" }] });
  const h = loopHarness({ server, clock, maxPasses: 3, pendingGates: () => [] });
  await h.run();
  assert.deepStrictEqual(h.dispatched, []);
  assert.strictEqual(h.candidateCalls, 0, "fresh dispatch (3b) is gated by admitting");
  assert.ok(h.pendingGateCalls >= 1, "the resume scan (3a) still runs under pause");
});

test("loop: members unsatisfiable on THIS machine release the run as local.no_capable_member; a human member does not", async () => {
  const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
  const server = stubServer({ clock, runs: [{ run_id: "prun-0000000000000001", admitted: ["task-x"] }] });
  const h = loopHarness({ server, clock, members: [], unsatisfiable: ["task-x"], maxPasses: 4 });
  await h.run();
  const reasons = server.events.filter((e) => e.type === "worker.observed").map((e) => e.local_reason);
  assert.deepStrictEqual(reasons, ["local.no_capable_member"]);
  assert.strictEqual(server.runs.get("prun-0000000000000001").state, "running");

  const clock2 = { now: Date.parse("2026-10-09T12:00:00Z") };
  const server2 = stubServer({ clock: clock2, runs: [{ run_id: "prun-0000000000000002", admitted: ["task-h"] }] });
  const h2 = loopHarness({ server: server2, clock: clock2, members: [], human: ["task-h"], maxPasses: 4 });
  await h2.run();
  assert.deepStrictEqual(h2.dispatched, [], "a human member is never claimed");
  assert.deepStrictEqual(server2.events.filter((e) => e.type === "worker.observed").map((e) => e.local_reason), ["local.signal"], "held until the local stop; the human block is global, not local");
  assert.ok(h2.log.some((l) => /nothing admissible: task-h \(requires human\)\. The run stays held and visible/.test(l)), h2.log.join("\n"));
});

test("loop: a run paused mid-pass stops admissions without cooling the member, then resumes", async () => {
  const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
  const server = stubServer({ clock, runs: [{ run_id: "prun-0000000000000001", admitted: ["task-a"] }] });
  const run = server.runs.get("prun-0000000000000001");
  const realAdmit = server.admit;
  let first = true;
  server.admit = (item, binding, bearer) => {
    if (first) {
      first = false;
      run.state = "paused"; // a person paused between the renew and the open
    }
    return realAdmit(item, binding, bearer);
  };
  const h = loopHarness({ server, clock, members: ["task-a"], opts: { concurrency: 1 }, maxPasses: 6, onTick: (_s, n) => { if (n === 2) run.state = "running"; } });
  const status = await h.run();
  assert.deepStrictEqual(h.dispatched.map((d) => d.id), ["task-a"], "admitted once the run is running again — never cooled for the run's pause");
  assert.ok(h.log.some((l) => /task-a — execution store refused task-a: run_paused/.test(l)), h.log.join("\n"));
  assert.ok(!status.skipped.some((s) => s.id === "task-a"));
});

test("loop: --once and --max stops release with their own local reasons", async () => {
  for (const [opts, reason] of [[{ once: true }, "local.once"], [{ max: 1, concurrency: 1 }, "local.max"]]) {
    const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
    const server = stubServer({ clock, runs: [{ run_id: "prun-0000000000000001" }] });
    const h = loopHarness({ server, clock, opts });
    await h.run();
    assert.strictEqual(server.events.at(-1).local_reason, reason);
    assert.strictEqual(server.runs.get("prun-0000000000000001").owner, null);
  }
});

// ------------------------------------------------- the admission open body --

test("the remote execution adapter's open carries program_run only when admitting", async () => {
  const sent = [];
  const remote = {
    get: async () => ({ ok: false, status: 404, json: null }),
    post: async (_cfg, p, body) => {
      sent.push({ p, body });
      return { ok: true, status: 200, json: { ok: true, fence: 1, execution: { execution_id: "exec-0000000000000001", tenant: "acme", item: { node_id: body.node_id }, owner: { worker: "agent-a", machine: "box-1", fence: 1, lease_expires_at: "2026-10-09T13:00:00Z" } } } };
    },
  };
  const os = require("node:os");
  const fs = require("node:fs");
  const path = require("node:path");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-prw-"));
  try {
    const cfg = { mode: () => "remote", get: (_k, d) => d, getNum: (_k, d) => d, userConfigHome: () => home };
    const store = executionStore.openExecutionStore(cfg, { home, mode: "remote", tenant: "acme", machine: "box-1", instance: "pid-1", remote });
    await store.open({ node_id: "task-a", factory: "factory-x", gates: [], boundary: "gates" });
    await store.open({ node_id: "task-b", factory: "factory-x", gates: [], boundary: "gates", program_run: { run_id: "prun-0000000000000001", fence: 3, instance: "inst-1" } });
    const opens = sent.filter((s) => s.p === "/v1/executions");
    assert.ok(!("program_run" in opens[0].body), "a plain open is byte-identical");
    assert.deepStrictEqual(opens[1].body.program_run, { run_id: "prun-0000000000000001", fence: 3, instance: "inst-1" });
    assert.strictEqual(opens[1].body.machine, "box-1");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("localReasonForStop maps every local stop to the server's vocabulary", () => {
  assert.strictEqual(programRuns.localReasonForStop("signal"), "local.signal");
  assert.strictEqual(programRuns.localReasonForStop("restart-on-land"), "local.restart_on_land");
  assert.strictEqual(programRuns.localReasonForStop("drained", { max: true }), "local.max");
  assert.strictEqual(programRuns.localReasonForStop("drained"), "local.once");
  assert.strictEqual(programRuns.localReasonForStop("error"), null);
  for (const r of ["local.signal", "local.restart_on_land", "local.max", "local.once"]) assert.ok(programRuns.LOCAL_REASONS.includes(r));
});

// ------------------------------------------- the pinned definition + CLI --

const fsx = require("node:fs");
const osx = require("node:os");
const pathx = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { hermeticEnv } = require("./helpers/env.js");
const { loadConfig } = require("../lib/config.js");

const factoryRaw = (id, { by = "controller", command = "npm test" } = {}) =>
  `---\nid: ${id}\ntype: factory\ntitle: Pinned factory\nsummary: A factory for program run tests.\nstatus: active\ndate: 2026-10-09\n---\n` +
  ["```json", JSON.stringify({ gates: [{ id: "acceptance", kind: "command", command }], completion: { by } }, null, 2), "```"].join("\n") + "\n";

test("a run's PINNED definition is parsed from the served bytes, never from HEAD", async () => {
  const sporCli = require("../bin/spor.js");
  const home = fsx.mkdtempSync(pathx.join(osx.tmpdir(), "spor-prw-pin-"));
  try {
    fsx.mkdirSync(pathx.join(home, "nodes"), { recursive: true });
    fsx.writeFileSync(pathx.join(home, "nodes", "factory-x.md"), factoryRaw("factory-x", { command: "npm run head-suite" }));
    const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_MODE: "local" } });
    const head = await sporCli.loadFactoryDefinition(cfg, "factory-x");
    assert.strictEqual(head.factory.gates[0].command, "npm run head-suite");
    const pinnedRaw = factoryRaw("factory-x", { command: "npm run pinned-suite" });
    const pinned = await sporCli.loadFactoryDefinition(cfg, "factory-x", { nodes: new Map([["factory-x", { raw: pinnedRaw, revision: "p".repeat(40) }]]) });
    assert.strictEqual(pinned.factory.gates[0].command, "npm run pinned-suite");
    assert.strictEqual(programRuns.pinTupleOf(pinned.factory).factory_revision, "p".repeat(40), "the pin tuple names the served revision");
    const missing = await sporCli.loadFactoryDefinition(cfg, "factory-x", { nodes: new Map() });
    assert.strictEqual(missing.factory, null, "a served set without the factory never falls back to HEAD");
  } finally {
    fsx.rmSync(home, { recursive: true, force: true });
  }
});

// A minimal team server: one factory node, nothing else.
function nodeServer(nodes) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const m = req.url.match(/^\/v1\/nodes\/([^/?]+)/);
      const raw = m && nodes[decodeURIComponent(m[1])];
      res.writeHead(raw ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify(raw ? { id: m[1], raw } : { error: { code: "not_found", message: "no such node" } }));
    });
    server.listen(0, "127.0.0.1", () => resolve({ base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }));
  });
}

function cliRun(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [require.resolve("../bin/spor.js"), ...args], { env: hermeticEnv(env), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (status) => resolve({ status, stdout, stderr }));
  });
}

test("CLI: --serve refuses an unbuilt scope, local mode, --program, and an agent-completion factory", async () => {
  const home = fsx.mkdtempSync(pathx.join(osx.tmpdir(), "spor-prw-cli-"));
  const srv = await nodeServer({ "factory-agent": factoryRaw("factory-agent", { by: "agent" }) });
  try {
    fsx.mkdirSync(pathx.join(home, "nodes"), { recursive: true });
    const local = { SPOR_HOME: home, XDG_CONFIG_HOME: home };
    let r = await cliRun(["work", "--serve", "queue"], local);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /--serve queue — only the 'program' scope is served yet/);
    r = await cliRun(["work", "--program-runs"], local);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /--serve program needs a team server — program run requests are server-held \(this graph resolves to local mode\)/);
    r = await cliRun(["work", "--program-runs", "--program", "task-x"], local);
    assert.match(r.stderr, /--serve takes its program from the run it owns; it contradicts --program/);
    const remoteEnv = { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: srv.base, SPOR_TOKEN: "tok" };
    r = await cliRun(["work", "--program-runs"], remoteEnv);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /--serve program needs --factory <id>/);
    r = await cliRun(["work", "--program-runs", "--factory", "factory-agent"], remoteEnv);
    assert.strictEqual(r.status, 1, r.stderr);
    assert.match(r.stderr, /factory 'factory-agent' completes by the AGENT — a program run admits members only through a controller-completion factory/);
  } finally {
    await srv.close();
    fsx.rmSync(home, { recursive: true, force: true });
  }
});

// ------------------------------------------------ review-driven edge cases --

test("an execution-level refusal about ONE item (a locally handed-off execution) never reads as losing the run", async () => {
  const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
  const server = stubServer({ clock, runs: [{ run_id: "prun-0000000000000001" }] });
  const { source } = sourceFor(server, { clock });
  await source.pass();
  // claimExecutionHold's shape for a handed-off execution: no admission_code.
  const door = programRuns.admitThrough(source, async () => ({ ok: false, kind: "foreign-hold", handed_off: true, reason: "execution store refused task-a: fence_stale: handed off" }));
  const res = await door({ id: "task-a" });
  assert.ok(!res.stopAdmitting, "the item's refusal is cooled like any other");
  assert.strictEqual(source.view().owned, true, "the run is still ours");
  assert.strictEqual(source.admitting(), true);
});

test("a renew refused for a non-ownership reason (a store conflict) keeps the claim and admits nothing", async () => {
  const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
  const server = stubServer({ clock, runs: [{ run_id: "prun-0000000000000001" }] });
  const { source } = sourceFor(server, { clock });
  await source.pass();
  const real = server.handle;
  server.handle = (method, p, body, bearer) => (p.endsWith("/renew") ? { status: 409, json: { error: { code: "conflict", message: "log unreplayable" } } } : real(method, p, body, bearer));
  const v = await source.pass();
  assert.strictEqual(v.owned, true, "not forgotten — forgetting would hide the run from every worker for a TTL");
  assert.strictEqual(v.admitting, false);
  server.handle = real;
  assert.strictEqual((await source.pass()).admitting, true);
});

test("drift the SERVER does not see is not held on: its re-read wins over this worker's tuple", async () => {
  const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
  const server = stubServer({ clock, runs: [{ run_id: "prun-0000000000000001" }] });
  const { source, log } = sourceFor(server, { clock });
  await source.pass();
  const misread = { ...PIN, gates: [PIN.gates[0], { ...PIN.gates[1], revision: null }] }; // a client-side reading gap
  assert.strictEqual(await source.checkPin(misread), false);
  assert.strictEqual(source.admitting(), true);
  assert.strictEqual(server.runs.get("prun-0000000000000001").state, "running");
  assert.ok(log.some((l) => /sees NO drift from its pin; trusting it/.test(l)), log.join("\n"));
  assert.strictEqual(await source.checkPin(misread), false, "and it stays trusted without re-sending");
  assert.strictEqual(server.events.filter((e) => e.type === "drift.observed").length, 1);
});

test("loop: a member held for triage (undispatchable) is GLOBAL — the run is held, not released", async () => {
  const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
  const server = stubServer({ clock, runs: [{ run_id: "prun-0000000000000001", admitted: ["task-t"] }] });
  const { source, log } = sourceFor(server, { clock });
  const control = { stopping: false, reason: null, wake: () => {} };
  let sleeps = 0;
  await workLoop.runWorkLoop({
    opts: { workerId: "inst-1", pid: 1, intervalMs: 1000, maxIntervalMs: 2000, retryAfterMs: 10_000, concurrency: 1, accept: "open" },
    control,
    deps: {
      now: () => clock.now,
      log: (l) => log.push(l),
      runSource: source,
      program: async () => {
        const v = source.view();
        if (!v.owned) return { error: "no run" };
        return { found: true, root_id: "task-prog", truncated: false, members: [{ id: "task-t", bucket: "open", status: "open", human: null, blockers: [] }], queue: { complete: true, located: new Map([["task-t", { id: "task-t", suggest: "triage" }]]) } };
      },
      candidates: async () => [],
      dispatch: async () => ({ ok: false, reason: "unexpected" }),
      pollRuns: async () => [],
      sleep: async (ms) => {
        clock.now += ms;
        if (++sleeps >= 3) control.stopping = true;
      },
    },
  });
  assert.deepStrictEqual(server.events.filter((e) => e.type === "worker.observed").map((e) => e.local_reason), ["local.signal"]);
  assert.ok(log.some((l) => /nothing admissible: task-t \(held for triage/.test(l)), log.join("\n"));
});

test("a REPLAYED drift report (first reply lost) reads the server's verdict off the returned run", async () => {
  const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
  const server = stubServer({ clock, runs: [{ run_id: "prun-0000000000000001" }] });
  const { source } = sourceFor(server, { clock });
  await source.pass();
  const real = server.handle;
  let lost = true;
  server.handle = (method, p, body, bearer) => {
    if (p.endsWith("/events") && lost) {
      lost = false;
      real(method, p, body, bearer); // committed server-side...
      return { transport: true, error: "socket hang up" }; // ...but the reply never arrived
    }
    if (p.endsWith("/events")) return { status: 200, json: { ok: true, run: real("GET", "/v1/program-runs/prun-0000000000000001", null, bearer).json.run, replayed: true } };
    return real(method, p, body, bearer);
  };
  const misread = { ...PIN, factory_revision: "e".repeat(40) };
  assert.strictEqual(await source.checkPin(misread), true, "unknown yet: held, and re-asked next reload");
  assert.strictEqual(await source.checkPin(misread), false, "the replay's run is still running: the server saw no drift");
  assert.strictEqual(source.admitting(), true);
});

// --------------------- cooling is split by WHY (issue-spor-work-settle-run-
// standing-cooling-is-global): a member cooled after a refusal every machine
// would hit is a GLOBAL halt — the run stays held and visible — while a
// machine-local refusal releases it as local.no_capable_member.

// The refusal shapes the dispatcher hands the loop (bin/spor.js
// claimExecutionHold / dispatchWorkItem / makeFactoryAvailabilityCheck).
const GLOBAL_REFUSALS = {
  "a foreign execution hold (execution_open)": (id) => ({ ok: false, kind: "foreign-hold", code: "execution_open", reason: `execution store refused ${id}: execution_open: a live execution holds it (execution exec-0123)` }),
  "a live lease held by another worker": (id) => ({ ok: false, kind: "foreign-hold", code: "lease_live", reason: `execution exec-1 on ${id} is held by agent-b on box-2 until 2026-10-09T13:00:00Z (lease_live: live)` }),
  "the item hold another execution stamped": (id) => ({ ok: false, kind: "foreign-hold", reason: `execution hold refused on ${id}: ${id} is held by execution exec-9` }),
  "admitted_to_run through the admission door": (id) => ({ ok: false, kind: "store", code: "admitted_to_run", admission_code: "admitted_to_run", message: "bound to another run", reason: `execution store refused ${id}: admitted_to_run: '${id}' is admitted to program run prun-other (running)` }),
  "admitted_to_run from a claim guard's free text": (id) => ({ ok: false, reason: `cannot dispatch ${id}: admitted_to_run: '${id}' is admitted to program run prun-other (running); claim it through that run` }),
  "not_admitted (an item the run did not admit)": (id) => ({ ok: false, kind: "store", code: "not_admitted", admission_code: "not_admitted", message: "not admitted", reason: `execution store refused ${id}: not_admitted: not admitted` }),
  "an item already resolved (not gateable)": (id) => ({ ok: false, kind: "not-gateable", reason: `execution hold refused on ${id}: ${id} already carries a live resolving edge` }),
};

for (const [label, refusal] of Object.entries(GLOBAL_REFUSALS)) {
  test(`loop: a member cooled after ${label} is a GLOBAL halt — the run is held, never released as local.no_capable_member`, async () => {
    const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
    const server = stubServer({ clock, runs: [{ run_id: "prun-0000000000000001", admitted: ["task-g"] }] });
    const h = loopHarness({ server, clock, members: ["task-g"], refuse: (item) => refusal(item.id), opts: { concurrency: 1 }, maxPasses: 4 });
    const status = await h.run();
    assert.deepStrictEqual(observed(server), ["local.signal"], `held until the local stop:\n${h.log.join("\n")}`);
    assert.ok(h.log.some((l) => /nothing admissible: task-g .*The run stays held and visible; this is not a local stop/.test(l)), h.log.join("\n"));
    assert.ok(status.skipped.some((s) => s.id === "task-g"), "the member is still cooled here — retrying it every poll would only re-refuse");
  });
}

test("loop: a member cooled after a MACHINE-LOCAL refusal (capability availability) releases the run", async () => {
  const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
  const server = stubServer({ clock, runs: [{ run_id: "prun-0000000000000001", admitted: ["task-l"] }] });
  const h = loopHarness({ server, clock, members: ["task-l"], refuse: (item) => ({ ok: false, kind: "availability", reason: `cannot dispatch ${item.id} here: gh is not installed on this machine` }), opts: { concurrency: 1 }, maxPasses: 4 });
  await h.run();
  assert.deepStrictEqual(observed(server), ["local.no_capable_member"], h.log.join("\n"));
  assert.strictEqual(server.runs.get("prun-0000000000000001").state, "running", "a local release never changes run state");
});

test("loop: one machine-local member releases even beside a globally-refused one", async () => {
  const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
  const server = stubServer({ clock, runs: [{ run_id: "prun-0000000000000001", admitted: ["task-g", "task-x"] }] });
  const h = loopHarness({ server, clock, members: ["task-g"], unsatisfiable: ["task-x"], refuse: (item) => (item.id === "task-g" ? GLOBAL_REFUSALS["a foreign execution hold (execution_open)"](item.id) : null), maxPasses: 4 });
  await h.run();
  assert.deepStrictEqual(observed(server), ["local.no_capable_member"], h.log.join("\n"));
  const release = h.log.find((l) => /released \(local\.no_capable_member/.test(l));
  assert.ok(release && /task-x/.test(release) && !/task-g/.test(release), `only the machine-local member is named:\n${h.log.join("\n")}`);
});

for (const [label, refusal] of Object.entries({
  "an unserved execution store (not_served)": (id) => ({ ok: false, kind: "store", code: "not_served", transient: true, reason: `the server does not serve /v1/executions (HTTP 404); a program run cannot admit ${id}` }),
  "an execution-store outage (5xx / dead socket)": (id) => ({ ok: false, kind: "store", code: "transport", transient: true, reason: `execution store refused ${id}: transport: offline — ECONNREFUSED` }),
})) {
  test(`loop: ${label} under a program run is transient and global — retried, never cooled, never a release`, async () => {
    const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
    const server = stubServer({ clock, runs: [{ run_id: "prun-0000000000000001", admitted: ["task-s"] }] });
    let outage = 2; // the first two attempts hit the outage (under the cool-after bound), then the store answers
    const attempts = [];
    const h = loopHarness({
      server,
      clock,
      members: ["task-s"],
      refuse: (item) => {
        attempts.push(item.id);
        return outage-- > 0 ? refusal(item.id) : null;
      },
      opts: { concurrency: 1 },
      maxPasses: 6,
    });
    const status = await h.run();
    assert.strictEqual(attempts.length, 3, `retried on every poll, not held off for a cooldown window:\n${h.log.join("\n")}`);
    assert.deepStrictEqual(h.dispatched.map((d) => d.id), ["task-s"], "admitted once the store answers");
    assert.deepStrictEqual(observed(server), ["local.signal"], "never released as local.no_capable_member");
    assert.ok(h.log.some((l) => /task-s — .* \(transient: not cooling the member; retrying next poll\)/.test(l)), h.log.join("\n"));
    assert.ok(!status.skipped.some((s) => s.id === "task-s"));
  });
}

test("loop: a member whose store open keeps failing transiently is cooled as an OUTAGE after a bounded streak — the run is held, never released", async () => {
  const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
  const server = stubServer({ clock, runs: [{ run_id: "prun-0000000000000001", admitted: ["task-s"] }] });
  const attempts = [];
  const h = loopHarness({
    server,
    clock,
    members: ["task-s"],
    refuse: (item) => (attempts.push(item.id), { ok: false, kind: "store", code: "not_served", transient: true, reason: `the server does not serve /v1/executions (HTTP 503); a program run cannot admit ${item.id}` }),
    opts: { concurrency: 1, retryAfterMs: 120_000 },
    maxPasses: 6,
  });
  const status = await h.run();
  assert.strictEqual(attempts.length, 3, `retried up to the bound, then cooled:\n${h.log.join("\n")}`);
  assert.ok(h.log.some((l) => /task-s — .*transient 3 times running: cooled as an outage; the run stays held/.test(l)), h.log.join("\n"));
  assert.strictEqual(status.skipped.find((s) => s.id === "task-s").kind, "outage");
  assert.deepStrictEqual(observed(server), ["local.signal"], "an outage is global: never local.no_capable_member");
  assert.ok(h.log.some((l) => /nothing admissible: task-s .*The run stays held and visible/.test(l)), h.log.join("\n"));
});

test("loop: a 5xx about ONE member's open moves on to the next member instead of stalling the pass", async () => {
  const clock = { now: Date.parse("2026-10-09T12:00:00Z") };
  const server = stubServer({ clock, runs: [{ run_id: "prun-0000000000000001", admitted: ["task-bad", "task-ok"] }] });
  const h = loopHarness({
    server,
    clock,
    members: ["task-bad", "task-ok"],
    refuse: (item) => (item.id === "task-bad" ? { ok: false, kind: "store", code: "server_error", transient: true, reason: `execution store refused ${item.id}: server_error: HTTP 500` } : null),
    opts: { concurrency: 2 },
    maxPasses: 2,
  });
  await h.run();
  assert.deepStrictEqual(h.dispatched.map((d) => d.id), ["task-ok"], h.log.join("\n"));
});

test("refusalKind: run-admission refusals about the item are `admitted` whichever door they came through", () => {
  assert.strictEqual(workLoop.refusalKind({ admission_code: "admitted_to_run", kind: "store" }), "admitted");
  assert.strictEqual(workLoop.refusalKind({ code: "not_admitted", kind: "store" }), "admitted");
  assert.strictEqual(workLoop.refusalKind({ kind: "store", code: "factory_mismatch" }), "store", "a mismatch is about the WORKER's factory: machine-local");
  assert.strictEqual(workLoop.refusalKind({ reason: "cannot dispatch task-a: admitted_to_run: bound elsewhere" }), "admitted");
  assert.strictEqual(workLoop.refusalKind({ kind: "foreign-hold", code: "execution_open" }), "foreign-hold");
  assert.strictEqual(workLoop.refusalKind({ kind: "availability" }), "availability");
  assert.strictEqual(workLoop.refusalKind({ reason: "profile not satisfiable here" }), "refusal");
  assert.strictEqual(workLoop.refusalKind(null), "refusal");
});

test("machineLocalStuck: only cooling/ineligible members with a machine-local kind count", () => {
  for (const kind of ["refusal", "availability", "policy", "scope", "workspace", "gate", "outcome", "store", null, undefined]) {
    assert.strictEqual(workLoop.machineLocalStuck({ id: "t", bucket: "cooling", kind }), true, `cooling/${kind}`);
  }
  assert.strictEqual(workLoop.machineLocalStuck({ id: "t", bucket: "ineligible", kind: "scope" }), true);
  for (const kind of ["foreign-hold", "admitted", "outage", "not-gateable", "human", "declined", "invalid"]) {
    assert.strictEqual(workLoop.machineLocalStuck({ id: "t", bucket: "cooling", kind }), false, `cooling/${kind}`);
    assert.strictEqual(workLoop.machineLocalStuck({ id: "t", bucket: "ineligible", kind }), false, `ineligible/${kind}`);
  }
  for (const bucket of ["human", "blocked", "undispatchable", "claim-stale", "off-queue"]) {
    assert.strictEqual(workLoop.machineLocalStuck({ id: "t", bucket, kind: "refusal" }), false, bucket);
  }
});

test("programStanding carries the cooldown kind on a cooling member", () => {
  const now = Date.parse("2026-10-09T12:00:00Z");
  const standing = workLoop.programStanding(
    { members: [{ id: "task-a", bucket: "open", status: "open", human: null, blockers: [] }], queue: { complete: true, located: new Map() } },
    { page: new Map(), policy: { accept: "open" }, skipped: new Map([["task-a", { reason: "held", kind: "foreign-hold", until: now + 1000 }]]), busy: new Set(), now, selfAgent: null, foreignSince: new Map(), foreignHoldMs: 1000 }
  );
  assert.deepStrictEqual(standing.members.find((m) => m.id === "task-a"), { id: "task-a", bucket: "cooling", why: "held", kind: "foreign-hold" });
});

// ------------- end to end through work.js's wiring (createWorker + bindWork +
// executeWork over the REAL remote client, the real program read and the real
// per-pass factory reload): the run source re-binds the gates to the run's
// PINNED definition on every pass, and a HEAD edit is caught by the reload and
// reported as drift (issue-spor-work-settle-run-standing-cooling-is-global).

const { createWorker, HOST_FUNCTIONS } = require("../lib/shell/work.js");

const E2E_HEAD = "h".repeat(40);
// A parsed factory whose pin tuple is `rev` (+ the stub's two gates).
const factoryAt = (rev, label) => ({
  id: "factory-x",
  revision: rev,
  label,
  repos: [],
  gates: [{ id: "tests", kind: "command", command: `npm test # ${label}`, source: "inline" }, { id: "review", kind: "agent-review", source: "gate-review" }],
  definition: { factory: { revision: rev }, gates: [{ id: "review", revision: PIN.gates[1].revision }] },
  integration: null,
  completion: { by: "controller", after: "gates" },
  implementation: null,
});

function e2eServer(server, { members }) {
  const program = {
    found: true,
    root_id: "task-prog",
    root: { id: "task-prog", title: "Program" },
    tree: members.map((id) => ({ id, parent: "task-prog", edge: "member-of-program", bucket: "open", type: "task", title: id })),
  };
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const json = body ? JSON.parse(body) : null;
        const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
        const send = (status, payload) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        if (req.url.startsWith("/v1/program/")) return send(200, program);
        if (req.url.startsWith("/v1/nodes/batch")) return send(200, { nodes: json.ids.map((id) => ({ id, type: "task", status: server.runs.values().next().value.done.has(id) ? "done" : "open" })) });
        if (req.url.startsWith("/v1/program-runs")) {
          const r = server.handle(req.method, req.url, json, bearer);
          if (r.transport) return req.socket.destroy();
          return send(r.status, r.json);
        }
        send(404, { error: { code: "not_found", message: "no such route" } });
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve({ base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) }));
  });
}

async function serveEndToEnd({ serverSeesDrift, values }) {
  // The real loop sleeps on the real clock, so the stub's leases read it too.
  const server = stubServer({ clock: { get now() { return Date.now(); } }, runs: [{ run_id: "prun-0000000000000001", admitted: ["task-a", "task-b"] }] });
  const srv = await e2eServer(server, { members: ["task-a", "task-b"] });
  const home = fsx.mkdtempSync(pathx.join(osx.tmpdir(), "spor-prw-e2e-"));
  const lines = { out: [], err: [] };
  const dispatches = [];
  const runs = new Map();
  let head = factoryAt(PIN.factory_revision, "head"); // HEAD agrees with the pin at Start
  const headEdit = factoryAt(E2E_HEAD, "head-edited");
  if (serverSeesDrift) server.actualPin = programRuns.pinTupleOf(headEdit);
  const host = {};
  for (const k of HOST_FUNCTIONS) host[k] = () => null;
  Object.assign(host, {
    out: (s) => (process.env.E2E_DEBUG && process.stderr.write(`OUT ${s}\n`), lines.out.push(s)),
    err: (s) => (process.env.E2E_DEBUG && process.stderr.write(`ERR ${s}\n`), lines.err.push(s)),
    dispatchAgentId: () => null,
    isAgentId: (s) => /^agent-[a-z0-9-]+$/.test(String(s)),
    factoryScopeSlug: () => null,
    integrationSatisfiability: () => ({ ok: true, reasons: [] }),
    // HEAD from the graph, or — given served `nodes` — the PINNED bytes.
    loadFactoryDefinition: async (_cfg, id, { nodes } = {}) => {
      if (nodes) {
        const n = nodes.get(id);
        return n ? { factory: factoryAt(n.revision, "pinned"), revision: n.revision } : { factory: null, errors: ["missing"] };
      }
      return { factory: head, revision: head.revision };
    },
    makeFactoryAvailabilityCheck: () => async () => ({ ok: true }),
    makeCodeMovedNotice: () => () => null,
    workerCodeIdentity: () => ({ stamp: null, commit: null, branch: null, repo: null }),
    dispatchedAgents: () => new Map(),
    workerAlive: () => false,
    annotateInFlight: (items) => ({ items }),
    programQueueEntries: async (_cfg, _slug, ids) => {
      const items = ids.map((id) => ({ id, readiness: "agent" }));
      return { complete: true, located: new Map(items.map((it) => [it.id, it])), items };
    },
    dispatchSatisfiableWorkItem: async (_cfg, item, _passthrough, ctx) => {
      dispatches.push({ id: item.id, factory: ctx.factory && ctx.factory.label, revision: ctx.factory && ctx.factory.revision, programRun: ctx.programRun });
      const admitted = server.admit(item, { ...ctx.programRun, machine: osx.hostname() }, "tok-a");
      if (!admitted.ok) return { ok: false, reason: `execution store refused ${item.id}: ${admitted.code}`, admission_code: admitted.code };
      head = headEdit; // a person edits the factory on HEAD while this child runs
      const runId = `run-${item.id}`;
      runs.set(runId, item.id);
      return { ok: true, run: { run_id: runId, harness: "fake" } };
    },
    pollWorkRuns: async (_cfg, ids) => ids.map((id) => ({ run_id: id, terminal: true, record: { run_id: id, node_id: runs.get(id), state: "done", terminal_state: "failed", terminal_enforced: true } })),
    reconcileCompletions: async () => {},
    reconcileWithdrawnExecutions: async () => {},
    replayAttestationDebts: async () => {},
    renewLiveExecutions: async () => {},
  });
  try {
    const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: srv.base, SPOR_TOKEN: "tok-a", SPOR_MODE: "remote" } });
    const worker = createWorker(host);
    const plan = await worker.planWork(cfg, { values: { "program-runs": true, factory: "factory-x", interval: "1", "max-interval": "1", accept: "open", concurrency: "1", ...values } });
    assert.strictEqual(typeof plan, "object", lines.err.join("\n"));
    const code = await worker.bindWork(cfg, plan).executeWork();
    return { code, server, lines, dispatches };
  } finally {
    await srv.close();
    fsx.rmSync(home, { recursive: true, force: true });
  }
}

test("e2e (work.js): a HEAD edit is caught by the REAL per-pass reload and reported as drift, and the server pauses the run", async () => {
  const { server, lines, dispatches } = await serveEndToEnd({ serverSeesDrift: true, values: { once: true } });
  const log = lines.out.join("\n");
  assert.deepStrictEqual(dispatches.map((d) => [d.id, d.revision]), [["task-a", PIN.factory_revision]], log);
  assert.strictEqual(dispatches[0].programRun.run_id, "prun-0000000000000001", "the admission carried the run binding");
  const drift = server.events.filter((e) => e.type === "drift.observed");
  assert.strictEqual(drift.length, 1, log);
  assert.strictEqual(server.runs.get("prun-0000000000000001").state, "paused", "the server re-read the factory itself and paused the run");
  assert.match(log, /the factory changed since it was pinned \(factory_changed: fffffffffff\w -> hhhhhhhhhhh\w\)/);
}, { timeout: 60_000 });

test("e2e (work.js): every pass re-binds the gates to the run's PINNED definition — never to the edited HEAD", async () => {
  const { server, lines, dispatches } = await serveEndToEnd({ serverSeesDrift: false, values: { max: "2" } });
  const log = lines.out.join("\n");
  assert.deepStrictEqual(dispatches.map((d) => d.id), ["task-a", "task-b"], log);
  assert.strictEqual(dispatches[0].factory, "head", "HEAD agreed with the pin at Start");
  assert.strictEqual(dispatches[1].factory, "pinned", `HEAD moved: the second child is judged by the pinned bytes the server served:\n${log}`);
  assert.strictEqual(dispatches[1].revision, PIN.factory_revision);
  assert.strictEqual(server.events.filter((e) => e.type === "drift.observed").length, 1, "the reload reported it once");
  assert.match(log, /sees NO drift from its pin; trusting it/);
  assert.match(log, /is pinned behind HEAD — judging its children by the pinned definition @ fffffffffff/);
  assert.strictEqual(server.runs.get("prun-0000000000000001").state, "running");
}, { timeout: 60_000 });

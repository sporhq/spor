"use strict";
// lib/shell/fleet-presence.js — `spor work`'s publish-then-heartbeat presence
// (issue-spor-work-does-not-publish-capabilities-or-heartbeat).
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { startFleetPresence, fleetPresenceOptions } = require(path.join(__dirname, "..", "lib", "shell", "fleet-presence.js"));

function fakeRemote(replies) {
  const calls = [];
  return {
    calls,
    isRemote: () => true,
    post: async (_cfg, url, body, opts) => {
      calls.push({ url, body, timeoutMs: opts && opts.timeoutMs });
      const next = replies.length ? replies.shift() : { ok: true, status: 200 };
      return next;
    },
  };
}

function fakeTimer() {
  const t = { fn: null, ms: null, cleared: false, unrefed: false };
  return {
    t,
    setTimer: (fn, ms) => {
      t.fn = fn;
      t.ms = ms;
      return { unref: () => (t.unrefed = true) };
    },
    clearTimer: () => (t.cleared = true),
  };
}

const base = (over) => ({ cfg: {}, agent: "agent-w", capabilities: () => ({ harnesses: ["x"] }), intervalMs: 240000, ...over });

test("publishes first, then heartbeats on every tick, on an unref'd timer", async () => {
  const remote = fakeRemote([]);
  const tm = fakeTimer();
  const p = startFleetPresence(base({ remote, ...tm, publishTimeoutMs: 1111, heartbeatTimeoutMs: 2222 }));
  await p.ready;
  assert.strictEqual(tm.t.ms, 240000);
  assert.ok(tm.t.unrefed, "the timer never holds the process open");
  await tm.t.fn();
  await tm.t.fn();
  assert.deepStrictEqual(remote.calls.map((c) => [c.url, c.timeoutMs]), [
    ["/v1/agents/agent-w/capabilities", 1111],
    ["/v1/agents/agent-w/heartbeat", 2222],
    ["/v1/agents/agent-w/heartbeat", 2222],
  ]);
  assert.deepStrictEqual(remote.calls[0].body, { harnesses: ["x"] });
  p.stop();
  assert.ok(tm.t.cleared);
  await p.tick();
  assert.strictEqual(remote.calls.length, 3, "a stopped presence sends nothing — the agent goes stale on the server's clock");
});

test("a failed startup publish is retried on the next tick, and logged once per distinct failure", async () => {
  const remote = fakeRemote([{ transport: true, error: "ECONNREFUSED" }, { transport: true, error: "ECONNREFUSED" }, { ok: true, status: 200 }]);
  const tm = fakeTimer();
  const log = [];
  const p = startFleetPresence(base({ remote, ...tm, log: (l) => log.push(l) }));
  await p.ready;
  assert.strictEqual(p.state.published, false);
  await tm.t.fn();
  await tm.t.fn();
  assert.strictEqual(p.state.published, true);
  assert.deepStrictEqual(remote.calls.map((c) => c.url.split("/").pop()), ["capabilities", "capabilities", "capabilities"]);
  assert.strictEqual(log.length, 2, log.join("\n"));
  assert.match(log[0], /fleet capabilities publish for agent-w failed \(ECONNREFUSED\)/);
  assert.match(log[1], /landed again/);
});

test("a heartbeat 404 (nothing published server-side) re-publishes on the next tick", async () => {
  const remote = fakeRemote([{ ok: true, status: 200 }, { ok: false, status: 404, json: { error: { code: "not_found" } } }]);
  const tm = fakeTimer();
  const p = startFleetPresence(base({ remote, ...tm }));
  await p.ready;
  await tm.t.fn();
  assert.strictEqual(p.state.published, false);
  await tm.t.fn();
  assert.deepStrictEqual(remote.calls.map((c) => c.url.split("/").pop()), ["capabilities", "heartbeat", "capabilities"]);
});

test("ticks never overlap: a tick while one is in flight joins it", async () => {
  let release;
  const remote = { isRemote: () => true, calls: 0, post: () => (remote.calls++, new Promise((r) => (release = () => r({ ok: true, status: 200 })))) };
  const tm = fakeTimer();
  const p = startFleetPresence(base({ remote, ...tm }));
  const again = tm.t.fn();
  assert.strictEqual(again, p.ready);
  assert.strictEqual(remote.calls, 1);
  release();
  await p.ready;
});

test("a throwing capabilities probe is a logged failure, never a throw", async () => {
  const remote = fakeRemote([]);
  const log = [];
  const p = startFleetPresence(base({ remote, ...fakeTimer(), log: (l) => log.push(l), capabilities: () => { throw new Error("probe broke"); } }));
  await p.ready;
  assert.strictEqual(remote.calls.length, 0);
  assert.match(log[0], /capabilities probe for agent-w failed \(probe broke\)/);
});

test("publish:false heartbeats from the first tick (the operator publishes by hand)", async () => {
  const remote = fakeRemote([]);
  const p = startFleetPresence(base({ remote, ...fakeTimer(), publish: false }));
  await p.ready;
  assert.deepStrictEqual(remote.calls.map((c) => c.url), ["/v1/agents/agent-w/heartbeat"]);
});

test("fleetPresenceOptions: remote + agent opt in; each half has its config switch", () => {
  const cfg = (vals) => ({ getBool: (k, d) => (k in vals ? vals[k] : d), get: (k, d) => (k in vals ? vals[k] : d) });
  const remote = { isRemote: () => true };
  assert.strictEqual(fleetPresenceOptions(cfg({}), { remote, agent: null }), null);
  assert.strictEqual(fleetPresenceOptions(cfg({}), { remote: { isRemote: () => false }, agent: "agent-w" }), null);
  assert.deepStrictEqual(fleetPresenceOptions(cfg({}), { remote, agent: "agent-w" }), {
    agent: "agent-w", publish: true, heartbeat: true, intervalMs: 300000, publishTimeoutMs: 3000, heartbeatTimeoutMs: 3000,
  });
  assert.strictEqual(fleetPresenceOptions(cfg({ "dispatch.capabilitiesPublish": false, "dispatch.heartbeat": false }), { remote, agent: "agent-w" }), null);
  assert.strictEqual(fleetPresenceOptions(cfg({ "dispatch.heartbeatIntervalMs": 60000 }), { remote, agent: "agent-w" }).intervalMs, 60000);
});

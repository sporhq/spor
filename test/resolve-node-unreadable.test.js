"use strict";
// issue-spor-resolve-node-unguarded-json-reads-null-as-unknown: resolveNode()
// (bin/spor.js) used to read a REMOTE 2xx response whose body failed to parse
// as an ordinary node with every enrichment key (resolution/held/inert/
// supersededBy) silently `null` — indistinguishable from a node that genuinely
// carries none of them. The fix returns a distinguished `{ unreadable: true }`
// marker instead, and every verification-critical caller must treat that
// marker the way ITS OWN contract requires a failed read to be treated: a
// dispatch guard refuses, a poll retries, a display reads as absent/unknown
// rather than a confident negative. This file pins that per caller class,
// each against a REAL 2xx-with-malformed-body response (the same shape a real
// server misbehavior would produce), not just a hand-built `{unreadable:true}`.
//
// The dispatch guard itself (cmdDispatch's node-mode resolveNode call) is
// covered end-to-end in test/dispatch.test.js ("a 2xx with an unparseable node
// body refuses the dispatch, never silently proceeds") — this file covers the
// other exported caller classes named in the issue: gateApprovalState (a poll
// that must retry, never approve/reject off a bad read), gateDemoteItem /
// gatePromoteItem (a write door that must refuse, never report a false
// no-op success), blockerAlreadyClosed / proposalSettledMeanwhile (a settle
// check that must never read a failed fetch as settled), and the `node` dep
// makeGateDeps hands the no-code-outcome check (must never manufacture an
// all-empty-but-ok node).

require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const sporCli = require("../bin/spor.js");
const { loadConfig } = require("../lib/config.js");
const remoteLib = require("../lib/remote.js");

// A remote-mode cfg with no local nodes dir — every read must go through
// `remote.get`, which the tests below stub per node id.
function remoteCfg() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-unreadable-"));
  return loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: "http://127.0.0.1:1", SPOR_TOKEN: "t" } });
}

// Stubs `remote.get` for the life of `fn`, answering `GET /v1/nodes/<id>` for
// each id in `bodies` — `"malformed"` hands back exactly the shape the real
// request()/_attempt() JSON.parse failure produces (ok:true, json:null,
// jsonError set — pinned against a live HTTP server in
// test/auth.test.js and test/dispatch.test.js's own malformed-body fixture),
// an object sends that as a parsed JSON node. Anything else 404s.
async function withNodeBodies(bodies, fn) {
  const original = remoteLib.get;
  remoteLib.get = async (cfg, p) => {
    const m = /^\/v1\/nodes\/([^/]+)$/.exec(p);
    const id = m && decodeURIComponent(m[1]);
    const spec = id && Object.prototype.hasOwnProperty.call(bodies, id) ? bodies[id] : undefined;
    if (spec === undefined) return { ok: false, status: 404, json: { error: { code: "not_found" } }, jsonError: null };
    if (spec === "malformed") return { ok: true, status: 200, json: null, jsonError: "Unexpected end of JSON input", text: "not valid json{{{" };
    return { ok: true, status: 200, json: spec, jsonError: null };
  };
  try {
    return await fn();
  } finally {
    remoteLib.get = original;
  }
}

test("gateApprovalState: a 2xx with an unparseable body reads 'pending' — never approved/rejected off a failed read", async () => {
  const cfg = remoteCfg();
  await withNodeBodies({ "task-approve-z": "malformed" }, async () => {
    assert.deepStrictEqual(await sporCli.gateApprovalState(cfg, "task-approve-z"), { state: "pending" });
  });
  // Pin the contrast: the SAME id with a body that parses fine and carries a
  // resolution reads 'approved' — proving the malformed case above is really
  // being vetoed, not just coincidentally landing on 'pending'.
  await withNodeBodies({ "task-approve-z": { id: "task-approve-z", type: "task", status: "open", resolution: { by: "dec-x" } } }, async () => {
    assert.strictEqual((await sporCli.gateApprovalState(cfg, "task-approve-z")).state, "approved");
  });
});

test("gateDemoteItem: a 2xx with an unparseable body refuses (ok:false) — never a false 'nothing to roll back' success", async () => {
  const cfg = remoteCfg();
  await withNodeBodies({ "task-demote-z": "malformed" }, async () => {
    const r = await sporCli.gateDemoteItem(cfg, "task-demote-z", { blockerId: "task-blocker" });
    assert.strictEqual(r.ok, false, "an unreadable body must not report ok:true");
    assert.match(r.reason, /could not be re-read/);
  });
});

test("gatePromoteItem: a 2xx with an unparseable body refuses (ok:false) — never a false 'nothing to restore' success", async () => {
  const cfg = remoteCfg();
  await withNodeBodies({ "task-promote-z": "malformed" }, async () => {
    const r = await sporCli.gatePromoteItem(cfg, "task-promote-z");
    assert.strictEqual(r.ok, false, "an unreadable body must not report ok:true");
    assert.match(r.reason, /could not be re-read/);
  });
});

test("blockerAlreadyClosed: a 2xx with an unparseable body is not evidence of closure — reads false, not true", async () => {
  const cfg = remoteCfg();
  await withNodeBodies({ "task-blocker-z": "malformed" }, async () => {
    assert.strictEqual(await sporCli.blockerAlreadyClosed(cfg, "task-blocker-z"), false);
  });
});

test("proposalSettledMeanwhile: an unparseable landed-fact body is not evidence of settlement — reads false, not true", async () => {
  const cfg = remoteCfg();
  const integrationRunner = require("../lib/shell/integration-runner.js");
  const r = { node_id: "task-item-z", run_id: "run-z" };
  const landedFact = integrationRunner.integrationFactId(r.node_id, r.run_id, "landed");
  await withNodeBodies(
    {
      // blockerAlreadyClosed's own read: an open tracker, not settled.
      "blocker-z": { id: "blocker-z", type: "task", status: "open" },
      // the landed-fact read: a 2xx that fails to parse — must NOT be read as
      // "the fact is present" (a bare `!!(await resolveNode(...))` would).
      [landedFact]: "malformed",
    },
    async () => {
      assert.strictEqual(await sporCli.proposalSettledMeanwhile(cfg, r, "blocker-z"), false);
    }
  );
});

test("makeGateDeps().node: a 2xx with an unparseable body fails the read — never an ok:true all-empty node", async () => {
  const cfg = remoteCfg();
  const deps = sporCli.makeGateDeps(cfg, {
    record: { node_id: "task-noco-z", run_id: "run-z", cwd: process.cwd() },
    entry: { node_id: "task-noco-z", run_id: "run-z", attempt: 1, project: "demo" },
    factory: { id: "factory-demo", gates: [] },
    slug: "demo",
    passthrough: {},
    warn: () => {},
    sleep: async () => {},
    log: () => {},
  });
  await withNodeBodies({ "art-shipped-z": "malformed" }, async () => {
    const r = await deps.node({ id: "art-shipped-z" });
    assert.strictEqual(r.ok, false, "an unreadable body must not report ok:true with a fabricated empty node");
    assert.match(r.reason, /could not be read from the graph/);
  });
});

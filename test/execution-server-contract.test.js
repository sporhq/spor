// Opt-in paired-repository acceptance against a real scratch Spor server.
// SPOR_EXECUTION_SERVER_ROOT names a built server checkout; SPOR_LIB points
// that server at this checkout. No deployed service or real graph is used.
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { loadConfig } = require("../lib/config.js");
const client = require("../lib/shell/execution-store.js");
const kernel = require("../lib/kernel/execution.js");
const serverRoot = process.env.SPOR_EXECUTION_SERVER_ROOT;
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");

test("real server: client machine fencing, parsed factory pins, candidate repin and explicit release agree", { skip: !serverRoot && "set SPOR_EXECUTION_SERVER_ROOT for paired acceptance" }, async () => {
  const { startServer, quiesceCommits, adminInstall } = require(path.join(serverRoot, "server/test/helpers.js"));
  const s = await startServer();
  try {
    await quiesceCommits(s.store);
    const node = (id, type, extra = "", body = "Work.") => `---\nid: ${id}\ntype: ${type}\nproject: demo\ntitle: ${id}\nsummary: Paired execution acceptance fixture.\ndate: 2026-09-06\n${extra}---\n${body}\n`;
    adminInstall(s.home, "person-pair.md", node("person-pair", "person", "email: alice@example.com\n"));
    adminInstall(s.home, "task-pair.md", node("task-pair", "task", "status: open\n"));
    adminInstall(s.home, "factory-pair.md", node("factory-pair", "artifact", "", '```json\n' + JSON.stringify({ factory: "pair", gates: [
      { id: "portable", kind: "command", command: "true", rejudge_on_repin: false },
      { id: "review", kind: "command", command: "true" },
    ] }) + '\n```'));
    s.store.reload();
    const openClient = machine => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-paired-client-"));
      const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_SERVER: s.base, SPOR_TOKEN: s.token } });
      return client.openExecutionStore(cfg, { home, machine });
    };
    const a = openClient("pair-a");
    const b = openClient("pair-b");
    const opened = await a.open({ node_id: "task-pair", factory: "factory-pair", gates: [{id: "portable", rejudge_on_repin: true}, {id: "review", rejudge_on_repin: false}], boundary: "gates" });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    const id = opened.execution.execution_id, fence = opened.fence;
    assert.equal(opened.execution.factory.gates[0].rejudge_on_repin, false, "server pins parsed definition, ignoring caller gates");
    assert.equal(opened.execution.completion.boundary, "gates", "server pins completion boundary");
    assert.equal((await a.claim(id, {})).fence, fence);
    for (const r of [await b.claim(id, {}), await b.renew(id, { fence }), await b.release(id, { fence }), await b.event(id, { fence, event: { type: "stage.started", attempt: 1 } })]) {
      assert.equal(r.ok, false, JSON.stringify(r));
    }
    const send = async event => {
      const r = await a.event(id, { fence, event });
      assert.equal(r.ok, true, JSON.stringify(r));
      return (await a.get(id)).execution;
    };
    const candidate = (hex, supersedes) => {
      const tree = hex.repeat(40), commit = hex.repeat(40);
      return { candidate_id: kernel.serverCandidateIdFor({ repo: "demo", node_id: "task-pair", tree }, sha256), spec_version: 1, repo: "demo", node_id: "task-pair", tree, commit, clean: true, base: { merge_base: "0".repeat(40) }, provenance: { attempt: 1, run_id: "run-pair" }, ...(supersedes ? { supersedes } : {}) };
    };
    const first = candidate("a");
    await send({ type: "candidate.submitted", candidate: first });
    const publish = c => send({ type: "candidate.published", candidate_id: c.candidate_id, reference: { kind: "branch", locator: "https://example.com/demo.git", commit: c.commit, ref: "refs/spor/candidates/" + c.candidate_id, verified_at: new Date().toISOString() } });
    await publish(first);
    for (const gate_id of ["portable", "review"]) await send({ type: "gate.settled", gate_id, attempt: 1, candidate_id: first.candidate_id, state: "passed" });
    const second = candidate("b", first.candidate_id);
    await send({ type: "candidate.superseded", candidate: second });
    let rec = await publish(second);
    assert.equal(rec.candidates.length, 2);
    assert.equal(kernel.boundaryReached(rec), false, "new tip still requires review");
    rec = await send({ type: "gate.settled", gate_id: "review", attempt: 2, candidate_id: first.candidate_id, state: "passed" });
    assert.equal(kernel.boundaryReached(rec), false, "late ancestor review cannot accept new tip");
    rec = await send({ type: "gate.settled", gate_id: "review", attempt: 3, candidate_id: second.candidate_id, state: "passed" });
    assert.equal(kernel.boundaryReached(rec), true, "explicit portable opt-out retains acceptance");
    await send({ type: "stage.observed", attempt: 1, state: "exhausted" });
    assert.equal((await a.get(id)).execution.stage, "refused");
    assert.equal((await a.open({ node_id: "task-pair", factory: "factory-pair", gates: [{id:"portable"},{id:"review"}], boundary:"gates" })).execution.execution_id, id, "refusal retains hold for regate");
    assert.equal((await a.release(id, { fence })).ok, true);
    assert.equal((await a.release(id, { fence })).replayed, true);
    const next = await a.open({ node_id: "task-pair", factory: "factory-pair", gates: [{id:"portable"},{id:"review"}], boundary:"gates" });
    assert.equal(next.ok, true, JSON.stringify(next));
    assert.notEqual(next.execution.execution_id, id);
  } finally { await s.stop(); }
});

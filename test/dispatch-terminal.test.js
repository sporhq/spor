// The dispatch terminal-state contract
// (task-spor-dispatch-terminal-states-contract): every supervised run ends in
// exactly one of `resolved` / `reported` / `failed`, `resolved` is proved
// against the graph rather than taken from the agent's word, an unresolved run
// leaves its report on the graph BEFORE its lease goes back to the pool, and a
// native-background run is marked unenforced rather than silently covered.
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const terminal = require("../lib/shell/dispatch-terminal.js");
const runner = require("../lib/shell/agent-dispatch-runner.js");
const { parseFrontmatter } = require("../lib/graph.js");

const RUNNER = path.join(__dirname, "..", "lib", "shell", "agent-dispatch-runner.js");

function scratch(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A recording transport: `plan` maps "<METHOD> <path-prefix>" to the verdict
// that leg should return (or a function, so a leg can throw). Everything it is
// asked is retained in order — the ORDERING assertions below are the point.
function transport(plan = {}) {
  const calls = [];
  const call = async ({ method, path: p, body }) => {
    calls.push({ method, path: p, body });
    const key = Object.keys(plan).find((k) => `${method} ${p}`.startsWith(k));
    const verdict = key ? plan[key] : { ok: true, status: 200, json: {} };
    return typeof verdict === "function" ? verdict() : verdict;
  };
  return { call, calls };
}

const BASE = { base: "https://graph.test", token: "t", runId: "run-1234abcd", harness: "codex", project: "demo" };

test("resolved is emitted only against a live resolving edge on the graph", async () => {
  const t = transport({
    "GET /v1/nodes/task-x": { ok: true, status: 200, json: { id: "task-x", resolution: { by: "dec-y", edge: "resolves" } } },
  });
  const patch = await terminal.applyTerminalContract({
    ...BASE, nodeId: "task-x", releaseNode: "task-x", state: "done",
    reportText: "I finished the work and resolved the node.", request: t.call,
  });
  assert.strictEqual(patch.terminal_state, "resolved");
  assert.strictEqual(patch.terminal_enforced, true);
  assert.strictEqual(patch.resolved_by, "dec-y");
  // A resolved run files nothing and releases nothing: the resolver is already
  // on the graph and the durable `assigned` edge is the record of who did it.
  assert.deepStrictEqual(t.calls.map((c) => c.method), ["GET"]);
});

test("an agent that claims success without the edge classifies as reported, never resolved", async () => {
  const t = transport({
    "GET /v1/nodes/task-x": { ok: true, status: 200, json: { id: "task-x", status: "done" } },
    "POST /v1/nodes": { ok: true, status: 200, json: { results: [{ ok: true, status: "created" }] } },
  });
  const patch = await terminal.applyTerminalContract({
    ...BASE, nodeId: "task-x", releaseNode: "task-x", state: "done",
    reportText: "DONE. I resolved task-x and everything passes.", request: t.call,
  });
  assert.strictEqual(patch.terminal_state, "reported");
  assert.strictEqual(patch.terminal_enforced, true);
  assert.strictEqual(patch.report_node_id, terminal.reportArtifactId("task-x", BASE.runId));
  assert.strictEqual(patch.lease_released, true);
  assert.ok(!("resolved_by" in patch));
});

test("the report is filed BEFORE the lease is released", async () => {
  const t = transport({
    "GET /v1/nodes/task-x": { ok: true, status: 200, json: { id: "task-x" } },
    "POST /v1/nodes": { ok: true, status: 200, json: { results: [{ ok: true, status: "created" }] } },
  });
  await terminal.applyTerminalContract({
    ...BASE, nodeId: "task-x", releaseNode: "task-x", state: "done",
    reportText: "Partial progress; blocked on the server half.", request: t.call,
  });
  const order = t.calls.map((c) => `${c.method} ${c.path}`);
  assert.deepStrictEqual(order, [
    "GET /v1/nodes/task-x",
    "POST /v1/nodes",
    "POST /v1/nodes/task-x/release",
  ]);
});

test("a crash between filing and releasing leaves the report filed and the lease HELD", async () => {
  // The crash simulated at the ONE boundary the contract exists to protect:
  // the report write has landed, the release does not happen.
  const t = transport({
    "GET /v1/nodes/task-x": { ok: true, status: 200, json: { id: "task-x" } },
    "POST /v1/nodes/task-x/release": () => { throw new Error("supervisor died"); },
    "POST /v1/nodes": { ok: true, status: 200, json: { results: [{ ok: true, status: "created" }] } },
  });
  const patch = await terminal.applyTerminalContract({
    ...BASE, nodeId: "task-x", releaseNode: "task-x", state: "done",
    reportText: "Work in progress notes worth keeping.", request: t.call,
  });
  assert.strictEqual(patch.terminal_state, "reported");
  assert.ok(patch.report_node_id, "the report id survives a failed release");
  assert.strictEqual(patch.lease_released, false);
  assert.match(patch.terminal_note, /spor release task-x/);
});

test("a report that cannot be filed leaves the lease held — never a released lease with no report", async () => {
  const t = transport({
    "GET /v1/nodes/task-x": { ok: true, status: 200, json: { id: "task-x" } },
    "POST /v1/nodes": { ok: true, status: 207, json: { results: [{ ok: false, code: "invalid_node" }] } },
  });
  const patch = await terminal.applyTerminalContract({
    ...BASE, nodeId: "task-x", releaseNode: "task-x", state: "done",
    reportText: "Notes that the graph refused.", request: t.call,
  });
  assert.strictEqual(patch.terminal_state, "failed");
  assert.strictEqual(patch.lease_released, false);
  assert.ok(!t.calls.some((c) => /\/release$/.test(c.path)), "no release is even attempted");
  assert.match(patch.terminal_note, /left HELD/);
});

test("a transport that THROWS on the report write fails closed — never a reported with no artifact id", async () => {
  const t = transport({
    "GET /v1/nodes/task-x": { ok: true, status: 200, json: { id: "task-x" } },
    "POST /v1/nodes/task-x/release": { ok: true, status: 200, json: {} },
    "POST /v1/nodes": () => { throw new Error("socket hang up"); },
  });
  const patch = await terminal.applyTerminalContract({
    ...BASE, nodeId: "task-x", releaseNode: "task-x", state: "done",
    reportText: "Notes worth keeping.", request: t.call,
  });
  assert.strictEqual(patch.terminal_state, "failed");
  assert.ok(!patch.report_node_id, "reported always names a node; this is not reported");
  assert.strictEqual(patch.lease_released, false);
  assert.ok(!t.calls.some((c) => /\/release$/.test(c.path)));
});

test("failed: no resolution and no report releases the lease with a failure note", async () => {
  const t = transport({
    "GET /v1/nodes/task-x": { ok: true, status: 200, json: { id: "task-x" } },
  });
  const patch = await terminal.applyTerminalContract({
    ...BASE, nodeId: "task-x", releaseNode: "task-x", state: "failed", reportText: "   ", request: t.call,
  });
  assert.strictEqual(patch.terminal_state, "failed");
  assert.strictEqual(patch.terminal_enforced, true);
  assert.strictEqual(patch.lease_released, true);
  assert.match(patch.terminal_note, /no usable final report/);
  assert.ok(!t.calls.some((c) => c.path === "/v1/nodes"), "nothing is written to the graph");
});

test("a --force re-dispatch never releases a lease it did not establish", async () => {
  const t = transport({
    "GET /v1/nodes/task-x": { ok: true, status: 200, json: { id: "task-x" } },
  });
  const patch = await terminal.applyTerminalContract({
    ...BASE, nodeId: "task-x", releaseNode: null, state: "failed", reportText: "", request: t.call,
  });
  assert.strictEqual(patch.terminal_state, "failed");
  // Omitted, not false: false means "tried and failed", which `spor runs`
  // renders as a hint to release it by hand.
  assert.ok(!("lease_released" in patch));
  assert.ok(!t.calls.some((c) => /\/release$/.test(c.path)));
});

test("an unreachable graph is reported unenforced, never resolved", async () => {
  const t = transport({ "GET /v1/nodes/task-x": { ok: false, status: 0, error: "ECONNREFUSED" } });
  const patch = await terminal.applyTerminalContract({
    ...BASE, nodeId: "task-x", releaseNode: "task-x", state: "done", reportText: "x", request: t.call,
  });
  assert.strictEqual(patch.terminal_enforced, false);
  assert.notStrictEqual(patch.terminal_state, "resolved");
  assert.match(patch.terminal_note, /could not re-read task-x/);
});

test("local mode and free-text dispatch are unenforced, with the reason on the record", async () => {
  const local = await terminal.applyTerminalContract({ ...BASE, base: null, nodeId: "task-x", state: "done" });
  assert.strictEqual(local.terminal_enforced, false);
  assert.match(local.terminal_note, /local-mode dispatch is unenforced/);

  const t = transport();
  const free = await terminal.applyTerminalContract({ ...BASE, nodeId: null, state: "done", request: t.call });
  assert.strictEqual(free.terminal_enforced, false);
  assert.strictEqual(t.calls.length, 0);
  assert.match(free.terminal_note, /free-text dispatch/);
});

test("a target retired by STATUS is unenforced — but its report is still filed, without a false 'did not resolve' claim", async () => {
  const written = [];
  const t = transport({
    "GET /v1/nodes/dec-x": { ok: true, status: 200, json: { id: "dec-x", type: "decision", status: "settled" } },
    "POST /v1/nodes": { ok: true, status: 200, json: { results: [{ ok: true, status: "created" }] } },
  });
  const patch = await terminal.applyTerminalContract({
    ...BASE, nodeId: "dec-x", releaseNode: "dec-x", state: "done",
    reportText: "I settled the decision; here are the tradeoffs and the rationale.",
    request: async (req) => { if (req.path === "/v1/nodes") written.push(req.body.nodes[0].node); return t.call(req); },
  });
  assert.strictEqual(patch.terminal_enforced, false);
  assert.notStrictEqual(patch.terminal_state, "resolved");
  // The work reaches the graph — losing it to the 14-day run-journal prune is a
  // strictly worse trade than the false claim this scoping exists to prevent.
  assert.strictEqual(patch.report_node_id, terminal.reportArtifactId("dec-x", BASE.runId));
  assert.strictEqual(written.length, 1);
  assert.match(written[0], /tradeoffs and the rationale/);
  assert.doesNotMatch(written[0], /without resolving it|without a resolving edge/);
  assert.match(written[0], /NOT verified/);
  // A lease we cannot judge is not ours to hand back on a guess.
  assert.ok(!t.calls.some((c) => /\/release$/.test(c.path)));
  assert.ok(!("lease_released" in patch));
  assert.match(patch.terminal_note, /completion is a status rather than a resolving edge/);
});

test("a filed report always reads `reported`, even when the run crashed and the target is out of scope", async () => {
  // The invariant a consumer keys on: report_node_id present => reported. Without
  // it, identical evidence gives a `task` `reported` and a `decision` `failed`
  // purely by target type, and `spor runs` prints "failed" over an artifact id.
  const t = transport({
    "GET /v1/nodes/dec-x": { ok: true, status: 200, json: { id: "dec-x", type: "decision" } },
    "POST /v1/nodes": { ok: true, status: 200, json: { results: [{ ok: true, status: "created" }] } },
  });
  const patch = await terminal.applyTerminalContract({
    ...BASE, nodeId: "dec-x", releaseNode: "dec-x", state: "failed",
    reportText: "Got most of the way; the final check failed.", request: t.call,
  });
  assert.strictEqual(patch.terminal_state, "reported");
  assert.strictEqual(patch.terminal_enforced, false);
  assert.strictEqual(patch.report_node_id, terminal.reportArtifactId("dec-x", BASE.runId));
  assert.ok(!t.calls.some((c) => /\/release$/.test(c.path)));
});

test("an out-of-scope target with no report files nothing and says why", async () => {
  const t = transport({
    "GET /v1/nodes/find-x": { ok: true, status: 200, json: { id: "find-x", type: "finding" } },
  });
  const patch = await terminal.applyTerminalContract({
    ...BASE, nodeId: "find-x", releaseNode: "find-x", state: "failed", reportText: "", request: t.call,
  });
  assert.strictEqual(patch.terminal_enforced, false);
  assert.strictEqual(patch.terminal_state, "failed");
  assert.ok(!t.calls.some((c) => c.path === "/v1/nodes"));
});

test("an out-of-scope report artifact still parses and links the target", () => {
  const { id, markdown } = terminal.buildReportArtifact({
    nodeId: "dec-x", runId: "r1", harness: "codex", project: "spor", verified: false, type: "decision",
    reportText: "The rationale.", state: "done", date: "2026-08-26",
  });
  const node = parseFrontmatter(markdown, `${id}.md`);
  assert.deepStrictEqual(node.edges, [{ type: "relates-to", to: "dec-x" }]);
  assert.ok(node.summary.length <= 500);
  assert.match(node.summary, /not verified against the graph/);
});

test("a server that does not echo a type still enforces (absent evidence of a mismatch)", async () => {
  const t = transport({
    "GET /v1/nodes/task-x": { ok: true, status: 200, json: { id: "task-x" } },
    "POST /v1/nodes": { ok: true, status: 200, json: { results: [{ ok: true, status: "created" }] } },
  });
  const patch = await terminal.applyTerminalContract({
    ...BASE, nodeId: "task-x", releaseNode: "task-x", state: "done", reportText: "notes", request: t.call,
  });
  assert.strictEqual(patch.terminal_state, "reported");
  assert.strictEqual(patch.terminal_enforced, true);
});

test("the report artifact parses, links the target with relates-to, and resolves nothing", () => {
  const { id, markdown } = terminal.buildReportArtifact({
    nodeId: "task-spor-thing", runId: "abcd1234-ef", harness: "codex", project: "spor",
    reportText: "Line one of the report.\n\nAnd a second paragraph.", state: "done", date: "2026-08-26",
  });
  const node = parseFrontmatter(markdown, `${id}.md`);
  assert.strictEqual(node.id, id);
  assert.strictEqual(node.type, "artifact");
  assert.strictEqual(node.project, "spor");
  assert.ok(node.summary.length > 0 && node.summary.length <= 500);
  assert.deepStrictEqual(node.edges, [{ type: "relates-to", to: "task-spor-thing" }]);
  assert.ok(!node.status, "a report artifact carries no resolving delivery stage");
  assert.match(node.body, /Line one of the report\./);
});

test("an oversized report is truncated to fit the node body cap rather than rejected wholesale", () => {
  const big = "x".repeat(40000);
  const { markdown } = terminal.buildReportArtifact({
    nodeId: "task-x", runId: "r", harness: "codex", project: null, reportText: big, state: "done", date: "2026-08-26",
  });
  assert.ok(Buffer.byteLength(markdown, "utf8") < 8192, "the whole node stays under the server's body cap headroom");
  assert.match(markdown, /report truncated/);
});

test("capBytes never leaves a mangled codepoint at the cut", () => {
  const cut = terminal.capBytes("é".repeat(100), 51); // 51 bytes lands mid-character
  assert.ok(!cut.includes("\uFFFD"));
});

test("a native-background run reconciles to an UNENFORCED outcome and never reads resolved", () => {
  const home = scratch("spor-terminal-native-");
  const dir = path.join(home, "journal", "dispatch");
  fs.mkdirSync(dir, { recursive: true });
  const created = new Date(Date.now() - 600000).toISOString();
  runner.atomicJson(path.join(dir, "n1.run.json"), {
    run_id: "n1", node_id: "task-x", name: "task-x", harness: "claude-code",
    launch_mode: "native-background", state: "running", cwd: home, created_at: created,
  });
  const [record] = runner.reconcileRuns(home, { agents: [], enumerated: true, env: { CLAUDE_CONFIG_DIR: home } });
  assert.ok(runner.TERMINAL_STATES.has(record.state));
  assert.strictEqual(record.terminal_enforced, false);
  assert.ok(terminal.TERMINAL_OUTCOMES.includes(record.terminal_state));
  assert.notStrictEqual(record.terminal_state, "resolved");
  assert.match(record.terminal_note, /outside the terminal-state contract/);
});

test("a supervised run whose supervisor died reconciles unenforced too", () => {
  const home = scratch("spor-terminal-super-");
  const dir = path.join(home, "journal", "dispatch");
  fs.mkdirSync(dir, { recursive: true });
  runner.atomicJson(path.join(dir, "s1.run.json"), {
    run_id: "s1", node_id: "task-x", harness: "codex", launch_mode: "supervised-jsonl",
    state: "running", cwd: home, runner_pid: 2, created_at: new Date(Date.now() - 600000).toISOString(),
  });
  const [record] = runner.reconcileRuns(home, { agents: [], enumerated: true });
  assert.ok(runner.TERMINAL_STATES.has(record.state));
  assert.strictEqual(record.terminal_enforced, false);
  assert.strictEqual(record.terminal_state, "failed");
  assert.match(record.terminal_note, /the supervisor died before/);
});

test("an already-terminal record with no outcome is backfilled unenforced on the next read", () => {
  const home = scratch("spor-terminal-backfill-");
  const dir = path.join(home, "journal", "dispatch");
  fs.mkdirSync(dir, { recursive: true });
  // Exactly the shape the NATIVE launch-failure path used to leave behind, and
  // what a supervisor that dies between its process write and the contract
  // leaves now: terminal, but with no outcome on it. `finalizeRun` refuses a
  // terminal record, so without the backfill nothing would ever repair this.
  runner.atomicJson(path.join(dir, "b1.run.json"), {
    run_id: "b1", node_id: "task-x", harness: "codex", launch_mode: "supervised-jsonl",
    state: "failed_launch", cwd: home, runner_pid: 2,
    created_at: new Date(Date.now() - 600000).toISOString(), finished_at: new Date().toISOString(),
  });
  const [record] = runner.reconcileRuns(home, { agents: [], enumerated: true });
  assert.strictEqual(record.state, "failed_launch");
  assert.strictEqual(record.terminal_state, "failed");
  assert.strictEqual(record.terminal_enforced, false);
  // durable, not just in the returned copy
  assert.strictEqual(runner.readJson(path.join(dir, "b1.run.json")).terminal_state, "failed");
});

test("the backfill never overwrites an outcome the supervisor already recorded", () => {
  const home = scratch("spor-terminal-nobackfill-");
  const dir = path.join(home, "journal", "dispatch");
  fs.mkdirSync(dir, { recursive: true });
  runner.atomicJson(path.join(dir, "b2.run.json"), {
    run_id: "b2", node_id: "task-x", harness: "codex", launch_mode: "supervised-jsonl",
    state: "done", cwd: home, runner_pid: 2, terminal_state: "resolved", terminal_enforced: true,
    resolved_by: "dec-y", created_at: new Date(Date.now() - 600000).toISOString(),
  });
  const [record] = runner.reconcileRuns(home, { agents: [], enumerated: true });
  assert.strictEqual(record.terminal_state, "resolved");
  assert.strictEqual(record.resolved_by, "dec-y");
});

// --- the whole supervised path, end to end -------------------------------
// The real runner process against a real (fake) graph server: the run record it
// leaves behind is the WORKERS.md-facing surface, so it is worth proving from
// the outside rather than only through the injected transport above.

function graphServer(handler) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, body });
      handler(req, res, body);
    });
  });
  return { srv, hits };
}

function jsonlStub(dir, lines) {
  const file = path.join(dir, "stub.js");
  fs.writeFileSync(file, `${lines.map((l) => `process.stdout.write(${JSON.stringify(JSON.stringify(l))} + "\\n");`).join("\n")}\n`);
  return file;
}

async function runSupervisor(home, job, env) {
  const jobFile = path.join(home, "journal", "dispatch", `${job.run_id}.job.json`);
  fs.mkdirSync(path.dirname(jobFile), { recursive: true });
  fs.writeFileSync(jobFile, JSON.stringify(job, null, 2));
  fs.writeFileSync(job.prompt_path, "do the work");
  runner.atomicJson(job.record_path, {
    run_id: job.run_id, node_id: job.node_id, harness: job.harness,
    launch_mode: "supervised-jsonl", state: "launching", cwd: job.cwd,
    created_at: new Date().toISOString(), log_path: job.log_path, report_path: job.report_path,
  });
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNNER, jobFile], {
      stdio: "ignore",
      env: { ...process.env, ...env },
    });
    child.on("exit", resolve);
    child.on("error", resolve);
  });
  return runner.readJson(job.record_path);
}

test("end to end: an unresolved supervised run files its report and releases its lease", async () => {
  const home = scratch("spor-terminal-e2e-");
  const cwd = scratch("spor-terminal-e2e-cwd-");
  const written = [];
  const { srv, hits } = graphServer((req, res, body) => {
    if (req.method === "GET" && req.url === "/v1/nodes/task-x") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "task-x", type: "task" })); // no resolution: unresolved
      return;
    }
    if (req.method === "POST" && req.url === "/v1/nodes") {
      written.push(JSON.parse(body).nodes[0].node);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ results: [{ ok: true, status: "created" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/nodes/task-x/release") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: "released" }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const runId = "e2e-0001";
    const p = runner.runPaths(home, runId);
    const stub = jsonlStub(cwd, [
      { type: "text", part: { text: "Made progress, did not resolve it." } },
    ]);
    const record = await runSupervisor(home, {
      run_id: runId, harness: "opencode", command: process.execPath, args: [stub], cwd,
      record_path: p.record, prompt_path: p.prompt, log_path: p.log, report_path: p.report,
      scratch_path: p.scratch, server: base, renew_node: "task-x",
      node_id: "task-x", release_node: "task-x", project: "demo",
    }, { SPOR_DISPATCH_RENEW_TOKEN: "agent-token" });

    assert.strictEqual(record.state, "done");
    assert.strictEqual(record.terminal_state, "reported");
    assert.strictEqual(record.terminal_enforced, true);
    assert.strictEqual(record.lease_released, true);
    assert.strictEqual(record.report_node_id, terminal.reportArtifactId("task-x", runId));
    assert.strictEqual(written.length, 1);
    assert.match(written[0], /Made progress, did not resolve it\./);
    const order = hits.map((h) => `${h.method} ${h.url}`);
    assert.ok(order.indexOf("POST /v1/nodes") < order.indexOf("POST /v1/nodes/task-x/release"));
    assert.ok(order.indexOf("POST /v1/nodes") > order.indexOf("GET /v1/nodes/task-x"));
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

test("end to end: a resolving edge on the graph makes the same run resolved, with nothing written", async () => {
  const home = scratch("spor-terminal-e2e2-");
  const cwd = scratch("spor-terminal-e2e2-cwd-");
  const { srv, hits } = graphServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/nodes/task-x") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "task-x", resolution: { by: "art-done", edge: "resolves" } }));
      return;
    }
    res.writeHead(500, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const runId = "e2e-0002";
    const p = runner.runPaths(home, runId);
    const stub = jsonlStub(cwd, [
      { type: "text", part: { text: "Done." } },
    ]);
    const record = await runSupervisor(home, {
      run_id: runId, harness: "opencode", command: process.execPath, args: [stub], cwd,
      record_path: p.record, prompt_path: p.prompt, log_path: p.log, report_path: p.report,
      scratch_path: p.scratch, server: base, renew_node: "task-x",
      node_id: "task-x", release_node: "task-x", project: "demo",
    }, { SPOR_DISPATCH_RENEW_TOKEN: "agent-token" });

    assert.strictEqual(record.terminal_state, "resolved");
    assert.strictEqual(record.terminal_enforced, true);
    assert.strictEqual(record.resolved_by, "art-done");
    assert.deepStrictEqual(hits.map((h) => `${h.method} ${h.url}`), ["GET /v1/nodes/task-x"]);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

test("a launch failure goes terminal within the launcher's poll window even when the graph hangs", async () => {
  // The launcher polls the run record for `failed_launch` for ONE SECOND before
  // deciding a dispatch got off the ground (launchSupervisedHarness). The
  // terminal-state contract is up to three bounded HTTP round-trips, so it must
  // NOT gate that write: gating it made `spor dispatch` report success and skip
  // its claim release for a harness binary that does not exist.
  const home = scratch("spor-terminal-poll-");
  const cwd = scratch("spor-terminal-poll-cwd-");
  const held = [];
  const srv = http.createServer((req, res) => { held.push(res); }); // accept, never answer
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const runId = "poll-0001";
  const p = runner.runPaths(home, runId);
  const jobFile = path.join(home, "journal", "dispatch", `${runId}.job.json`);
  fs.mkdirSync(path.dirname(jobFile), { recursive: true });
  fs.writeFileSync(jobFile, JSON.stringify({
    run_id: runId, harness: "opencode", command: path.join(cwd, "no-such-binary"), args: [], cwd,
    record_path: p.record, prompt_path: p.prompt, log_path: p.log, report_path: p.report,
    scratch_path: p.scratch, server: base, node_id: "task-x", release_node: "task-x", project: "demo",
  }, null, 2));
  fs.writeFileSync(p.prompt, "do the work");
  runner.atomicJson(p.record, {
    run_id: runId, node_id: "task-x", harness: "opencode", launch_mode: "supervised-jsonl",
    state: "launching", cwd, created_at: new Date().toISOString(), log_path: p.log, report_path: p.report,
  });
  const child = spawn(process.execPath, [require("node:path").join(__dirname, "..", "lib", "shell", "agent-dispatch-runner.js"), jobFile], {
    stdio: "ignore", env: { ...process.env, SPOR_DISPATCH_RENEW_TOKEN: "agent-token" },
  });
  const exited = new Promise((resolve) => { child.on("exit", resolve); child.on("error", resolve); });
  try {
    let seen = null;
    for (let i = 0; i < 20 && !seen; i++) { // the launcher's exact 20 x 50ms window
      const state = runner.readJson(p.record);
      if (state && state.state === "failed_launch") seen = state;
      else await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(seen, "the record goes terminal inside the launcher's poll window");
    // ...and is never terminal-without-an-outcome, even mid-contract.
    assert.strictEqual(seen.terminal_state, "failed");
    assert.strictEqual(seen.terminal_enforced, false);
    for (const res of held) { try { res.destroy(); } catch { /* already gone */ } }
    await exited;
    const final = runner.readJson(p.record);
    assert.strictEqual(final.state, "failed_launch");
    assert.strictEqual(final.terminal_state, "failed");
  } finally {
    for (const res of held) { try { res.destroy(); } catch { /* already gone */ } }
    await new Promise((resolve) => srv.close(resolve));
  }
});

test("end to end: a supervised launch failure still records a terminal outcome", async () => {
  const home = scratch("spor-terminal-e2e3-");
  const cwd = scratch("spor-terminal-e2e3-cwd-");
  const { srv } = graphServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/nodes/task-x") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "task-x" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const runId = "e2e-0003";
    const p = runner.runPaths(home, runId);
    const record = await runSupervisor(home, {
      run_id: runId, harness: "opencode", command: path.join(cwd, "definitely-not-a-command"), args: [], cwd,
      record_path: p.record, prompt_path: p.prompt, log_path: p.log, report_path: p.report,
      scratch_path: p.scratch, server: base, renew_node: "task-x",
      node_id: "task-x", release_node: "task-x", project: "demo",
    }, { SPOR_DISPATCH_RENEW_TOKEN: "agent-token" });

    assert.strictEqual(record.state, "failed_launch");
    assert.strictEqual(record.terminal_state, "failed");
    assert.strictEqual(record.terminal_enforced, true);
    assert.strictEqual(record.lease_released, true);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

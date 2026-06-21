// run.test.js — `spor run <workflow-id> [--inputs <json>]` and `spor run status
// <run-id>` (task-spor-workflow-run-cli-verbs): the CLI wrappers for the
// workflow-run REST surface (POST /v1/workflows/{id}/run, GET /v1/runs/{id}),
// the shell twin of the run_workflow MCP tool. Workflow execution is server-
// side only, so this verb is remote-only and degrades cleanly in local mode.
//
// Oracle = the REQUEST the CLI makes in remote mode (method/url/body — never the
// server's framing, which we script) + the exit code and rendered lines. Mirrors
// priority.test.js's bare-env / fake-server harness.
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "bin", "spor.js");

// Env with no SPOR_*/SUBSTRATE_* leakage and isolated config homes, so the dev
// box's real ~/.spor/config.json can't flip a local-mode test to remote.
const ISO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "spor-run-iso-"));
function bare(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("SPOR_") || k.startsWith("SUBSTRATE_") || k === "XDG_CONFIG_HOME") continue;
    env[k] = v;
  }
  env.SPOR_HOME = ISO_HOME;
  env.XDG_CONFIG_HOME = ISO_HOME;
  return Object.assign(env, extra);
}
// Sync runner for local mode (no in-process server to talk to).
function run(args, extra) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: bare(extra) });
}
// Async runner for remote mode — a blocking spawnSync deadlocks against the
// in-process fake server (the event loop can't accept the connection).
function runAsync(args, extra) {
  return new Promise((resolve) => {
    let out = "", errOut = "";
    const c = spawn(process.execPath, [CLI, ...args], { env: bare(extra), stdio: ["ignore", "pipe", "pipe"] });
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (errOut += d));
    c.on("close", (code) => resolve({ status: code, stdout: out, stderr: errOut }));
  });
}

// Records every request. POST /v1/workflows/{id}/run echoes a run-start summary
// (state.steps[id] = status STRING, per runStateSummary); GET /v1/runs/{id}
// echoes a full run record (state.steps[id] = object with .status). Configurable
// failure: { runStatus, runErr } for the POST, { getStatus, getErr } for the GET.
function runStub(opts = {}) {
  const {
    runStatus: rs = 200, runErr = { code: "conflict", message: "x" },
    getStatus: gs = 200, getErr = { code: "not_found", message: "x" },
  } = opts;
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, body });
      const j = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
      const mRun = req.url.match(/^\/v1\/workflows\/([^/]+)\/run$/);
      const mGet = req.url.match(/^\/v1\/runs\/([^/]+)$/);
      if (mRun && req.method === "POST") {
        if (rs !== 200) return j(rs, { error: { details: [], ...runErr } });
        const id = decodeURIComponent(mRun[1]);
        return j(200, {
          run_id: `run-${id}-20260620`,
          revision: "r1",
          workflow: id,
          workflow_version: 3,
          state: { status: "running", steps: { build: "ready", deploy: "pending" } },
        });
      }
      if (mGet && req.method === "GET") {
        if (gs !== 200) return j(gs, { error: { details: [], ...getErr } });
        const id = decodeURIComponent(mGet[1]);
        return j(200, {
          run_id: id,
          status: "running",
          project: "spor",
          title: "Run of Release pipeline",
          initiator: "anthony@example.com",
          workflow: "wf-release-pipeline",
          workflow_version: 3,
          lineage: [{ type: "performs", to: "wf-release-pipeline" }],
          state: { status: "running", steps: { build: { status: "succeeded" }, deploy: { status: "claimed" } } },
          revision: "r2",
          timestamps: { started_at: "2026-06-20T10:00:00Z", last_event_at: "2026-06-20T10:05:00Z" },
        });
      }
      return j(404, { error: { code: "not_found" } });
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}
const remoteEnv = (base, extra = {}) => bare({ SPOR_SERVER: base, SPOR_TOKEN: "test-token", ...extra });

// ---------------- local mode (remote-only verb degrades) ----------------

test("run (local) degrades with a clear remote-needed line, exit 0", () => {
  const r = run(["run", "wf-release-pipeline"]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /workflow runs need a team graph/);
  assert.match(r.stdout, /SPOR_SERVER/);
});

test("run status (local) also degrades, exit 0", () => {
  const r = run(["run", "status", "run-x"]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /workflow runs need a team graph/);
});

test("run --help prints the command page (table-driven, both forms + flags)", () => {
  const r = run(["run", "--help"]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^spor run <workflow-id> \[--inputs <json>\] \| status <run-id>/m);
  assert.match(r.stdout, /spor run status <run-id>/);
  assert.match(r.stdout, /--inputs <json>/);
});

// ---------------- remote: run start ----------------

test("run (remote) POSTs an empty body to /v1/workflows/{id}/run and renders the run", async () => {
  const { srv, hits, base } = await runStub();
  try {
    const r = await runAsync(["run", "wf-release-pipeline"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    const post = hits.find((h) => h.method === "POST" && h.url === "/v1/workflows/wf-release-pipeline/run");
    assert.ok(post, "POSTed to the workflow run endpoint");
    assert.deepStrictEqual(JSON.parse(post.body), {}, "no --inputs => empty body");
    assert.match(r.stdout, /run started: run-wf-release-pipeline-20260620/);
    assert.match(r.stdout, /workflow: wf-release-pipeline \(v3\)/);
    assert.match(r.stdout, /state: running/);
    assert.match(r.stdout, /build: ready/);
    assert.match(r.stdout, /deploy: pending/);
    assert.match(r.stdout, /inspect: spor run status run-wf-release-pipeline-20260620/);
  } finally {
    srv.close();
  }
});

test("run (remote) --inputs sends {inputs: <obj>}", async () => {
  const { srv, hits, base } = await runStub();
  try {
    const r = await runAsync(["run", "wf-x", "--inputs", '{"ref":"v1.2.0","dry":true}'], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    const post = hits.find((h) => h.method === "POST" && h.url === "/v1/workflows/wf-x/run");
    assert.deepStrictEqual(JSON.parse(post.body), { inputs: { ref: "v1.2.0", dry: true } });
  } finally {
    srv.close();
  }
});

test("run (remote) --json prints the raw run record", async () => {
  const { srv, base } = await runStub();
  try {
    const r = await runAsync(["run", "wf-x", "--json"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.strictEqual(j.run_id, "run-wf-x-20260620");
    assert.strictEqual(j.workflow_version, 3);
  } finally {
    srv.close();
  }
});

test("run (remote) rejects non-JSON --inputs client-side, never reaching the server", async () => {
  const { srv, hits, base } = await runStub();
  try {
    const r = await runAsync(["run", "wf-x", "--inputs", "not json"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /--inputs is not valid JSON/);
    assert.strictEqual(hits.length, 0, "no request for a bad --inputs");
  } finally {
    srv.close();
  }
});

test("run (remote) rejects a non-object --inputs (array/scalar) client-side", async () => {
  const { srv, hits, base } = await runStub();
  try {
    for (const bad of ["[1,2]", "42", '"a string"']) {
      const r = await runAsync(["run", "wf-x", "--inputs", bad], remoteEnv(base));
      assert.strictEqual(r.status, 1, `${bad} should be rejected`);
      assert.match(r.stderr, /--inputs must be a JSON object/);
    }
    assert.strictEqual(hits.length, 0, "no request for any non-object --inputs");
  } finally {
    srv.close();
  }
});

test("run (remote) maps a 404 to a clean 'no such workflow'", async () => {
  const { srv, base } = await runStub({ runStatus: 404, runErr: { code: "not_found", message: "workflow 'wf-nope' not found" } });
  try {
    const r = await runAsync(["run", "wf-nope"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /no such workflow: wf-nope/);
  } finally {
    srv.close();
  }
});

test("run (remote) surfaces a 409 not-active message verbatim", async () => {
  const msg = "workflow 'wf-x' is proposed, not active — a different identity must activate it";
  const { srv, base } = await runStub({ runStatus: 409, runErr: { code: "conflict", message: msg } });
  try {
    const r = await runAsync(["run", "wf-x"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /run error 409 \(conflict\): workflow 'wf-x' is proposed, not active/);
  } finally {
    srv.close();
  }
});

test("run (remote) fails open against an unreachable server (no stack trace)", async () => {
  const r = await runAsync(["run", "wf-x"], remoteEnv("http://127.0.0.1:1"));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /offline/);
  assert.doesNotMatch(r.stderr, /at Object|Error:/);
});

// ---------------- remote: run status ----------------

test("run status (remote) GETs /v1/runs/{id} and renders the record + step states", async () => {
  const { srv, hits, base } = await runStub();
  try {
    const r = await runAsync(["run", "status", "run-release-20260620"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    const get = hits.find((h) => h.method === "GET" && h.url === "/v1/runs/run-release-20260620");
    assert.ok(get, "GET to the run endpoint");
    assert.match(r.stdout, /run run-release-20260620 — running/);
    assert.match(r.stdout, /Run of Release pipeline/);
    assert.match(r.stdout, /workflow: wf-release-pipeline \(v3\)/);
    assert.match(r.stdout, /project: spor/);
    assert.match(r.stdout, /initiator: anthony@example\.com/);
    // full reducer_state shape: steps[id] is an object with .status
    assert.match(r.stdout, /build: succeeded/);
    assert.match(r.stdout, /deploy: claimed/);
    assert.match(r.stdout, /started: 2026-06-20T10:00:00Z/);
    assert.match(r.stdout, /last event: 2026-06-20T10:05:00Z/);
  } finally {
    srv.close();
  }
});

test("run status (remote) --json prints the raw record", async () => {
  const { srv, base } = await runStub();
  try {
    const r = await runAsync(["run", "status", "run-x", "--json"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.strictEqual(j.run_id, "run-x");
    assert.ok(j.lineage, "raw record includes lineage");
  } finally {
    srv.close();
  }
});

test("run status (remote) maps a 404 to a clean 'no such run'", async () => {
  const { srv, base } = await runStub({ getStatus: 404, getErr: { code: "not_found", message: "run 'run-gone' not found" } });
  try {
    const r = await runAsync(["run", "status", "run-gone"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /no such run: run-gone/);
  } finally {
    srv.close();
  }
});

test("run status (remote) with no run-id exits 1 with usage", async () => {
  const { srv, hits, base } = await runStub();
  try {
    const r = await runAsync(["run", "status"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /usage: spor run status <run-id>/);
    assert.strictEqual(hits.length, 0, "no request for a missing run-id");
  } finally {
    srv.close();
  }
});

test("run (remote) with no workflow id exits 1 with usage", async () => {
  const { srv, hits, base } = await runStub();
  try {
    const r = await runAsync(["run"], remoteEnv(base));
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /usage: spor run <workflow-id>/);
    assert.strictEqual(hits.length, 0, "no request for a missing workflow id");
  } finally {
    srv.close();
  }
});

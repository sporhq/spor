// schema-adopt.test.js — the packaged candidate schema pack and its adoption
// surface (task-spor-resident-schema-adoption-upgrade-path): `spor schema
// candidates` / `spor schema adopt`. Candidates ship in lib/seed/candidates/
// but never enter the registry until adopted as graph-resident schema nodes;
// adoption writes through the validated node surface with provenance stamps
// (adopted_from / adopted_sha) that make CalVer-aware upgrades safe — a
// pristine older copy upgrades in place, a diverged or unstamped resident
// refuses without --force.
require("./helpers/tmp-cleanup");
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const SCHEMA_CLI = path.join(__dirname, "..", "lib", "schema.js");
const graphLib = require("../lib/graph.js");
const candLib = require("../lib/candidates.js");

// The pack's own parse guard (the candidates twin of the seed loud-throw):
// loadCandidates() throws on any malformed packaged candidate, so calling it
// IS the assertion. The shipped pack is also this suite's fixture.
const CANDS = candLib.loadCandidates();
const MOP = CANDS.find((c) => c.id === "schema-edge-member-of-program");

const ISO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "spor-schema-adopt-iso-"));
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
function run(args, extra) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: bare(extra) });
}
function runAsync(args, extra) {
  return new Promise((resolve) => {
    let out = "", errOut = "";
    const c = spawn(process.execPath, [CLI, ...args], { env: bare(extra), stdio: ["ignore", "pipe", "pipe"] });
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (errOut += d));
    c.on("close", (code) => resolve({ status: code, stdout: out, stderr: errOut }));
  });
}

function fixtureGraph() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-schema-adopt-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  fs.writeFileSync(
    path.join(nodes, "task-x.md"),
    "---\nid: task-x\ntype: task\ntitle: Task X\nsummary: a task\ndate: 2026-08-25\n---\nbody\n"
  );
  return { home, nodes };
}
const residentFile = (nodes) => path.join(nodes, `${MOP.id}.md`);
const readResident = (nodes) => fs.readFileSync(residentFile(nodes), "utf8");

// Rewrite the adopted resident as a pristine adoption of an OLDER candidate:
// drop the version and restamp adopted_sha over the rewritten content, exactly
// what an adopt from the older package would have produced.
function fabricateOlderPristine(nodes, oldVersion) {
  let raw = readResident(nodes).replace(/^schema_version: .*$/m, `schema_version: ${oldVersion}`);
  const node = graphLib.parseFrontmatter(raw, "x.md");
  raw = raw.replace(/^adopted_sha: .*$/m, `adopted_sha: ${candLib.canonicalSha(node)}`);
  fs.writeFileSync(residentFile(nodes), raw);
}

// ---------------- the pack itself ----------------

test("candidates pack: parses loudly, ships member-of-program, stays out of the seed registry", () => {
  assert.ok(MOP, "schema-edge-member-of-program ships as a candidate");
  assert.equal(MOP.kind, "edge-schema");
  assert.equal(MOP.declaredType, "member-of-program");
  assert.match(MOP.sha, /^[0-9a-f]{16}$/);
  assert.equal(MOP.node.status, undefined, "candidates ship without a status line");
  assert.ok(!MOP.inSeed, "member-of-program is not (yet) promoted to the seed pack");
  // The seed registry must NOT see the candidates subdir.
  const snap = graphLib.seedRegistry().snapshot();
  assert.ok(!snap.edge_types.some((e) => e.type === "member-of-program"), "candidate absent from seed registry");
});

test("canonicalSha covers schema_version + body only (attribution-stamp immune)", () => {
  const a = { schema_version: "2026.08.21.1", body: "b" };
  assert.equal(candLib.canonicalSha(a), candLib.canonicalSha({ ...a, author: "x", status: "active", adopted_sha: "y" }));
  assert.notEqual(candLib.canonicalSha(a), candLib.canonicalSha({ ...a, body: "b2" }));
  assert.notEqual(candLib.canonicalSha(a), candLib.canonicalSha({ ...a, schema_version: "2026.08.22.1" }));
});

test("candidateState: the full classification table", () => {
  const cand = { inSeed: false, version: "2026.08.21.1", id: "schema-x" };
  assert.equal(candLib.candidateState(cand, null).state, "not-adopted");
  assert.equal(candLib.candidateState({ ...cand, inSeed: true }, null).state, "superseded-by-seed");
  const current = { schema_version: "2026.08.21.1", status: "active", body: "b" };
  assert.equal(candLib.candidateState(cand, current).state, "current");
  assert.equal(candLib.candidateState(cand, { ...current, schema_version: "2026.09.01.1" }).state, "current");
  const older = { schema_version: "2026.08.01.1", status: "active", body: "b" };
  assert.equal(candLib.candidateState(cand, older).state, "unstamped");
  const pristine = { ...older, adopted_sha: candLib.canonicalSha(older) };
  assert.equal(candLib.candidateState(cand, pristine).state, "outdated");
  assert.equal(candLib.candidateState(cand, { ...pristine, body: "edited" }).state, "diverged");
});

// ---------------- local mode: list / adopt / upgrade ----------------

test("schema candidates (local) reports not-adopted, then current after adopt", () => {
  const { home } = fixtureGraph();
  let r = run(["schema", "candidates"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /schema-edge-member-of-program/);
  assert.match(r.stdout, /not adopted — adopt with: spor schema adopt schema-edge-member-of-program/);

  assert.strictEqual(run(["schema", "adopt", MOP.id], { SPOR_HOME: home }).status, 0);
  r = run(["schema", "candidates", "--json"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  const row = JSON.parse(r.stdout).find((x) => x.id === MOP.id);
  assert.equal(row.state, "current");
  assert.equal(row.resident_status, "proposed");
  assert.equal(row.package_version, MOP.version);
});

test("schema adopt (local) writes a proposed resident with provenance stamps, by id or declared type", () => {
  const { home, nodes } = fixtureGraph();
  const r = run(["schema", "adopt", "member-of-program"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /adopted: schema-edge-member-of-program @ \d{4}\.\d{2}\.\d{2}\.\d+ \(status: proposed\)/);
  assert.match(r.stdout, new RegExp(`-> local ${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  const raw = readResident(nodes);
  assert.match(raw, /^status: proposed$/m);
  assert.match(raw, /^adopted_from: spor@\d+\.\d+\.\d+/m);
  assert.match(raw, new RegExp(`^adopted_sha: ${MOP.sha}$`, "m"));
  // Proposed = inert: the registry must not load it (schemaActive gate).
  const reg = graphLib.loadGraph(nodes).registry.snapshot();
  assert.ok(!reg.edge_types.some((e) => e.type === "member-of-program"), "proposed resident stays out of the registry");
});

test("schema adopt --activate (local) registers the type and clears the overview footer", () => {
  const { home, nodes } = fixtureGraph();
  // Before adoption the overview footers the unadopted candidate (both the
  // spor CLI and the direct lib/schema.js CLI — mode-parity bytes).
  let r = run(["schema"], { SPOR_HOME: home });
  // Count-agnostic: the pack grows (schema-factory/schema-gate joined it with
  // task-spor-work-gate-pipeline), and this test is about the FOOTER, not the
  // size of the pack.
  assert.match(r.stdout, /\d+ candidate schemas? ships? with this package but (is|are) not in this registry — see: spor schema candidates/);
  const before = Number(r.stdout.match(/(\d+) candidate schemas? ship/)[1]);
  const direct = spawnSync(process.execPath, [SCHEMA_CLI, "--nodes", nodes], { encoding: "utf8", env: bare() });
  assert.match(direct.stdout, /candidate schemas? ships? with this package/);

  r = run(["schema", "adopt", MOP.id, "--activate"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /\(status: active\)/);
  const reg = graphLib.loadGraph(nodes).registry.snapshot();
  const e = reg.edge_types.find((x) => x.type === "member-of-program");
  assert.ok(e, "active resident enters the registry");
  assert.equal(e.source, "graph");

  r = run(["schema"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  const after = r.stdout.match(/(\d+) candidate schemas? ship/);
  assert.strictEqual(after ? Number(after[1]) : 0, before - 1, "the adopted type drops out of the footer");
});

test("schema adopt (local) is idempotent — a current resident is a no-op", () => {
  const { home, nodes } = fixtureGraph();
  run(["schema", "adopt", MOP.id], { SPOR_HOME: home });
  const before = readResident(nodes);
  const r = run(["schema", "adopt", MOP.id], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /up to date: schema-edge-member-of-program/);
  assert.strictEqual(readResident(nodes), before, "no-op rewrites nothing");
});

test("schema adopt (local) upgrades a pristine older resident in place, preserving its status", () => {
  const { home, nodes } = fixtureGraph();
  run(["schema", "adopt", MOP.id, "--activate"], { SPOR_HOME: home });
  fabricateOlderPristine(nodes, "2026.08.01.1");
  let r = run(["schema", "candidates"], { SPOR_HOME: home });
  assert.match(r.stdout, /adopted @ 2026\.08\.01\.1, package has \S+ — upgrade with: spor schema adopt/);
  r = run(["schema", "adopt", MOP.id], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /upgraded: schema-edge-member-of-program @ \S+ \(status: active\)/);
  const raw = readResident(nodes);
  assert.match(raw, new RegExp(`^schema_version: ${MOP.version}$`, "m"));
  assert.match(raw, /^status: active$/m, "status preserved across the upgrade");
});

test("schema adopt (local) refuses a diverged resident without --force, overwrites with it", () => {
  const { home, nodes } = fixtureGraph();
  run(["schema", "adopt", MOP.id], { SPOR_HOME: home });
  fabricateOlderPristine(nodes, "2026.08.01.1");
  // Local edit after adoption -> the recomputed hash no longer matches the stamp.
  fs.writeFileSync(residentFile(nodes), readResident(nodes).replace("Program membership", "Program membership EDITED"));
  let r = run(["schema", "adopt", MOP.id], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /locally modified since adoption — upgrade needs --force/);
  assert.match(readResident(nodes), /EDITED/, "refusal leaves the resident untouched");

  r = run(["schema", "adopt", MOP.id, "--force"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /upgraded: schema-edge-member-of-program/);
  assert.ok(!/EDITED/.test(readResident(nodes)), "--force replaced the diverged copy");
});

test("schema adopt (local) refuses an unstamped hand-copied resident without --force", () => {
  const { home, nodes } = fixtureGraph();
  // A pre-feature test box: someone hand-copied an older node file, no stamps.
  const older = MOP.raw.replace(/^schema_version: .*$/m, "schema_version: 2026.08.01.1");
  fs.writeFileSync(residentFile(nodes), older.replace(/^---\n/, "---\n").replace(/\n---\n/, "\nstatus: active\n---\n"));
  const r = run(["schema", "adopt", MOP.id], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /no adoption stamp/);
  assert.strictEqual(run(["schema", "adopt", MOP.id, "--force"], { SPOR_HOME: home }).status, 0);
});

test("schema adopt errors on an unknown candidate and names the available ones", () => {
  const { home } = fixtureGraph();
  const r = run(["schema", "adopt", "schema-no-such"], { SPOR_HOME: home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /no packaged candidate 'schema-no-such' — available: .*schema-edge-member-of-program/);
});

// ---------------- remote mode ----------------

function remoteStub({ resident = null } = {}) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, body });
      const j = (code, b) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(b));
      };
      if (req.method === "GET" && req.url.startsWith("/v1/nodes/")) {
        if (!resident) return j(404, { error: { code: "not_found" } });
        return j(200, { raw: resident, revision: "rev-1" });
      }
      if (req.method === "POST" && req.url === "/v1/nodes") {
        return j(200, { results: [{ ok: true, status: resident ? "updated" : "created", id: MOP.id, revision: "rev-2", warnings: [] }] });
      }
      return j(404, { error: { code: "not_found" } });
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` })));
}
const remoteEnv = (base, extra = {}) => bare({ SPOR_SERVER: base, SPOR_TOKEN: "test-token", ...extra });

test("schema adopt (remote) POSTs a one-entry validated batch for a fresh adoption", async () => {
  const { srv, hits, base } = await remoteStub();
  try {
    const r = await runAsync(["schema", "adopt", MOP.id], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /adopted: schema-edge-member-of-program @ \S+ \(status: proposed\) rev rev-2/);
    assert.match(r.stdout, /-> remote /);
    const post = hits.find((h) => h.method === "POST" && h.url === "/v1/nodes");
    assert.ok(post, "POST /v1/nodes");
    const entry = JSON.parse(post.body).nodes[0];
    assert.equal(entry.if_exists, "error");
    assert.equal(entry.revision, undefined);
    assert.match(entry.node, /^adopted_sha: /m);
    assert.match(entry.node, /^status: proposed$/m);
  } finally {
    srv.close();
  }
});

test("schema adopt (remote) upgrades a pristine older resident with revision-CAS", async () => {
  // Build the resident the OLD package would have written, via the real stamp math.
  let older = candLib.adoptMarkdown(MOP, { status: "active", pkgVersion: "0.0.1" }).replace(/^schema_version: .*$/m, "schema_version: 2026.08.01.1");
  older = older.replace(/^adopted_sha: .*$/m, `adopted_sha: ${candLib.canonicalSha(graphLib.parseFrontmatter(older, "x.md"))}`);
  const { srv, hits, base } = await remoteStub({ resident: older });
  try {
    const r = await runAsync(["schema", "adopt", MOP.id], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /upgraded: schema-edge-member-of-program @ \S+ \(status: active\) rev rev-2/);
    const entry = JSON.parse(hits.find((h) => h.method === "POST").body).nodes[0];
    assert.equal(entry.if_exists, "update");
    assert.equal(entry.revision, "rev-1");
    assert.match(entry.node, /^status: active$/m, "status preserved");
  } finally {
    srv.close();
  }
});

test("schema candidates (remote) reads adoption state from GET /v1/nodes", async () => {
  const { srv, hits, base } = await remoteStub();
  try {
    const r = await runAsync(["schema", "candidates", "--json"], remoteEnv(base));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).find((x) => x.id === MOP.id).state, "not-adopted");
    assert.ok(hits.some((h) => h.method === "GET" && h.url === `/v1/nodes/${MOP.id}`));
  } finally {
    srv.close();
  }
});

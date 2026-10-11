// mode-parity.test.js — norm-spor-cli-mode-parity as a TEST, not a review
// checklist (task-spor-local-remote-single-renderer-conformance).
//
// Every dual-mode read verb runs twice over ONE fixture graph: in local mode
// against the nodes dir, and in remote mode against test/helpers/stub-spor-
// server.js serving the same dir with the server's envelope shaping. The two
// runs must agree:
//   - human output byte-for-byte (one renderer per verb, fed the canonical
//     envelope in both modes),
//   - stderr byte-for-byte (the zero-match project warning is ONE string),
//   - --json field-for-field, with only the server's per-viewer routing fields
//     (SERVER_ONLY_QUEUE_FIELDS) set aside — so a field one arm grows and the
//     other does not fails here.
// What this does NOT prove: the stub shapes its envelopes with the client's own
// helpers (shapeQueueEnvelope, unknownProjectWarning, analyze), so drift between
// those and the real server's handlers is out of reach here — the server's side
// of that contract is to call the same helpers. This file pins everything the
// CLIENT does with an envelope: flag forwarding, paging, warning lifting, and the
// one renderer.
// Never the live graph: scratch homes only, hermetic env.

require("./helpers/tmp-cleanup"); // scratch-home leak guard
const { hermeticEnv } = require("./helpers/env.js");
const { startStubServer } = require("./helpers/stub-spor-server.js");
const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const CORPORA = path.join(__dirname, "..", "conformance", "corpora");
const { SERVER_ONLY_QUEUE_FIELDS } = require("../lib/queue.js");

// Fixture: the queue ranking corpus (blocks, staleness, mutes, findings,
// priority, two projects) plus the readiness corpus (agent-ready / needs-human /
// untriaged), so every counted line the renderer can print is exercised.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "spor-mode-parity-"));
const NODES = path.join(HOME, "nodes");
fs.mkdirSync(NODES);
for (const corpus of ["queue", "queue-readiness"]) {
  const dir = path.join(CORPORA, corpus, "nodes");
  for (const f of fs.readdirSync(dir)) fs.copyFileSync(path.join(dir, f), path.join(NODES, f));
}
// A cwd outside any repo, so remote's cwd-inferred scope is a guess the stub
// rejects and the CLI drops (the silent unscoped fallback) — the same global read
// local mode makes from here.
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "spor-mode-parity-cwd-"));

function run(args, env) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...args], {
      cwd: CWD,
      env: hermeticEnv({ SPOR_HOME: HOME, XDG_CONFIG_HOME: HOME, ...env }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    // Decode as a stream: a pipe read can end mid-character (the document
    // fixture's emoji), and `+= Buffer` would decode each chunk alone.
    c.stdout.setEncoding("utf8");
    c.stderr.setEncoding("utf8");
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

let stub;
test.before(async () => {
  stub = await startStubServer({ nodesDir: NODES });
});
test.after(async () => {
  if (stub) await stub.close();
});

async function bothModes(args) {
  const local = await run(args, { SPOR_MODE: "local" });
  const before = stub.requests.length;
  const remote = await run(args, { SPOR_SERVER: stub.base, SPOR_TOKEN: "t" });
  // Guards the harness per row: a remote run that silently answered locally
  // would make its diff pass vacuously.
  assert.ok(stub.requests.length > before, `remote 'spor ${args.join(" ")}' reached the stub`);
  return { local, remote };
}

const withoutServerOnly = (json) => {
  const o = JSON.parse(json);
  for (const k of SERVER_ONLY_QUEUE_FIELDS) delete o[k];
  return o;
};

// The verbs and flag shapes under parity. Each row is one argv; every row is run
// both as human text and (where the verb has one) as --json.
const CASES = [
  { verb: "next", args: ["next"] },
  { verb: "next", args: ["next", "--limit", "3"] },
  { verb: "next", args: ["next", "--limit", "0"] },
  { verb: "next", args: ["next", "--project", "alpha"] },
  { verb: "next", args: ["next", "--project", "beta", "--limit", "1"] },
  { verb: "next", args: ["next", "--project", "zzz-unknown"] },
  // projectKnown/unknownProjectWarning parity (task-spor-project-known-client-server-parity-shared-predicate):
  // "alpha" above is a stamp-only token (no repo node) — known via the stamped half;
  // an arbitrary node id and a prototype key are neither identity nor stamp.
  { verb: "next", args: ["next", "--project", "task-blocked"] },
  { verb: "next", args: ["next", "--project", "constructor"] },
  { verb: "next", args: ["next", "--readiness", "agent"] },
  { verb: "next", args: ["next", "--readiness", "human,untriaged", "--limit", "2"] },
  { verb: "next", args: ["next", "--type", "task", "--exclude-type", "question"] },
  { verb: "next", args: ["next", "--hide-dispatched"] },
  { verb: "analytics", args: ["analytics"] },
  { verb: "analytics", args: ["analytics", "--project", "alpha", "--weeks", "4"] },
  { verb: "analytics", args: ["analytics", "--project", "zzz-unknown"] },
  { verb: "analytics", args: ["analytics", "--project", "task-blocked"] },
  { verb: "analytics", args: ["analytics", "--project", "constructor"] },
  { verb: "analytics", args: ["analytics", "--type", "task", "--top", "3"] },
  { verb: "program", args: ["program", "task-blocked"] },
  { verb: "program", args: ["program", "task-blocked", "--max-depth", "0"] },
  { verb: "program", args: ["program", "task-blocked", "--max-nodes", "1"] },
  { verb: "program", args: ["program", "task-unblocker"] },
  { verb: "program", args: ["program", "task-blocked", "--max-depth", "-1"] },
  { verb: "program", args: ["program", "task-blocked", "--max-nodes", "abc"] },
];

for (const c of CASES) {
  test(`mode parity: spor ${c.args.join(" ")} — human output`, async () => {
    const { local, remote } = await bothModes(c.args);
    assert.strictEqual(local.status, 0, local.stderr);
    assert.strictEqual(remote.status, 0, remote.stderr);
    assert.ok(local.stdout.length > 0, "local printed something");
    assert.strictEqual(remote.stdout, local.stdout, "stdout identical across modes");
    assert.strictEqual(remote.stderr, local.stderr, "stderr identical across modes");
  });

  test(`mode parity: spor ${c.args.join(" ")} --json — envelope`, async () => {
    const { local, remote } = await bothModes([...c.args, "--json"]);
    assert.strictEqual(local.status, 0, local.stderr);
    assert.strictEqual(remote.status, 0, remote.stderr);
    assert.strictEqual(remote.stderr, local.stderr, "stderr identical across modes");
    if (c.verb === "next") {
      assert.deepStrictEqual(withoutServerOnly(remote.stdout), withoutServerOnly(local.stdout));
      // Same serialization, not just the same fields: both pretty-print.
      assert.match(local.stdout, /^\{\n {2}"items"/);
      assert.match(remote.stdout, /^\{\n {2}"items"/);
    } else if (c.verb === "program") {
      // Byte-identical once the CLI's own generated_at stamp is pinned.
      const pin = (s) => s.replace(/"generated_at": "[^"]*"/, '"generated_at": "<pinned>"');
      assert.strictEqual(pin(remote.stdout), pin(local.stdout), "program --json byte-identical");
      assert.match(remote.stdout, /"found": true/);
    } else {
      // Byte-identical once the report's own clock stamp (window.now — the
      // instant each arm ran analyze()) is pinned to one value.
      const pin = (s) => s.replace(/"now": "[^"]*"/, '"now": "<pinned>"');
      assert.strictEqual(pin(remote.stdout), pin(local.stdout), "analytics --json byte-identical");
    }
  });
}

test("mode parity: remote actually went through the stub for every verb", () => {
  // Guards the harness itself: a remote run that silently fell back to local
  // would make every diff above pass vacuously.
  assert.ok(stub.requests.some((p) => p.startsWith("/v1/queue?")), "queue was requested");
  assert.ok(stub.requests.some((p) => p.startsWith("/v1/analytics")), "analytics was requested");
  assert.ok(stub.requests.some((p) => p.startsWith("/v1/program/") && p.includes("format=envelope")), "program envelope was requested");
  assert.ok(stub.requests.some((p) => /[?&]readiness=agent\b/.test(p)), "--readiness forwarded");
  assert.ok(stub.requests.some((p) => /[?&]type=task\b/.test(p) && /[?&]exclude_type=question\b/.test(p)), "type filters forwarded");
});

test("mode parity: the fixture exercises every counted line the queue renderer prints", async () => {
  const { local } = await bothModes(["next", "--limit", "3"]);
  assert.match(local.stdout, /more — raise --limit, or --limit 0 for all\)/);
  assert.match(local.stdout, /blocked — gated by live work/);
  assert.match(local.stdout, /^readiness: \d+ agent-ready, \d+ need human, \d+ untriaged$/m);
  const unknown = await bothModes(["next", "--project", "zzz-unknown"]);
  assert.match(unknown.local.stderr, /project 'zzz-unknown' matched no repo, grouping, or project stamp/);
});

// ---------- complete documents: spor get --document / spor put-document ----------
// (task-spor-chatgpt-document-cli) The same diff over GET|PUT /v1/documents:
// local mode runs lib/shell/document.js over a nodes dir, remote mode the stub's
// document routes over an identical copy, and the read answers (source, digest,
// completeness, snapshot) and publication results must agree byte-for-byte.
const documentShell = require("../lib/shell/document.js");
const { spawnSync } = require("node:child_process");
const { gitEnv } = require("./helpers/git.js");

const DOC_DATE = "2026-10-09";
function docSource(id, edit = "") {
  const paras = [];
  for (let i = 1; i <= 500; i++) paras.push(`Paragraph ${i}${i === 7 ? edit : ""} — design text ünïcode 😀 and a \`code\` span.`);
  return `---\nid: ${id}\ntype: artifact\ntitle: Parity document\nsummary: A long document for the parity diff.\nstatus: active\ndate: ${DOC_DATE}\n---\n\n${paras.join("\n\n")}\n`;
}
function docHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-mode-parity-doc-"));
  fs.mkdirSync(path.join(home, "nodes"));
  spawnSync("git", ["init", "-q"], { cwd: home, env: gitEnv() });
  return home;
}
const publishLocal = (home, node, snapshot = null) =>
  documentShell.putDocument(path.join(home, "nodes"), { node, snapshot, journalDir: path.join(home, "journal", "documents") });

function runIn(home, args, env, input) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...args], {
      cwd: CWD,
      env: hermeticEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home, ...env }),
      stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    // Decode as a stream: a pipe read can end mid-character (the document
    // fixture's emoji), and `+= Buffer` would decode each chunk alone.
    c.stdout.setEncoding("utf8");
    c.stderr.setEncoding("utf8");
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (status) => resolve({ status, stdout, stderr }));
    if (input != null) c.stdin.end(input);
  });
}

// One read fixture: art-doc published twice (v1 pinned by revision), a broken
// document (a part deleted), and a legacy spill (prefix stamp, mutable parts).
const DOC_HOME = docHome();
const DOC_NODES = path.join(DOC_HOME, "nodes");
const v1 = publishLocal(DOC_HOME, docSource("art-doc"));
const v2 = publishLocal(DOC_HOME, docSource("art-doc", " (edited)"), v1.snapshot);
const broken = publishLocal(DOC_HOME, docSource("art-broken"));
fs.unlinkSync(path.join(DOC_NODES, `${broken.parts[1]}.md`));
fs.writeFileSync(path.join(DOC_NODES, "art-legacy.md"),
  "---\nid: art-legacy\ntype: artifact\ntitle: Legacy\nsummary: s\nstatus: active\ndate: 2026-10-01\n---\n\nhead text\n_(continues in art-legacy-2)_\n");
fs.writeFileSync(path.join(DOC_NODES, "art-legacy-2.md"),
  "---\nid: art-legacy-2\ntype: artifact\ntitle: Legacy 2\nsummary: s\nstatus: active\ndate: 2026-10-01\ncontinuation_of: art-legacy\nedges:\n  - {type: derived-from, to: art-legacy}\n---\n\n_(continued from art-legacy)_\ntail text\n");
const LEGACY_REV = documentShell.readNodeFile(DOC_NODES, "art-legacy").revision;

let docStub;
test.before(async () => {
  docStub = await startStubServer({ nodesDir: DOC_NODES });
});
test.after(async () => {
  if (docStub) await docStub.close();
});

const DOC_CASES = [
  { args: ["get", "art-doc", "--document"], status: 0 },
  { args: ["get", "art-doc", "--document", "--revision", v1.revision], status: 0 },
  { args: ["get", "art-broken", "--document"], status: 1 },
  { args: ["get", "art-legacy", "--document"], status: 0 },
  { args: ["get", "art-legacy", "--document", "--revision", LEGACY_REV], status: 1 },
  { args: ["get", "art-nope", "--document"], status: 1 },
  { args: ["get", "art-doc", "--document", "--revision", "0".repeat(40)], status: 1 },
  { args: ["get", "art-doc", "--document", "--revision", "nothex"], status: 1 },
];
for (const c of DOC_CASES) {
  for (const json of [false, true]) {
    const args = json ? [...c.args, "--json"] : c.args;
    test(`mode parity: spor ${args.join(" ")}`, async () => {
      const local = await runIn(DOC_HOME, args, { SPOR_MODE: "local" });
      const before = docStub.requests.length;
      const remote = await runIn(DOC_HOME, args, { SPOR_SERVER: docStub.base, SPOR_TOKEN: "t" });
      assert.ok(docStub.requests.length > before, "remote reached the stub");
      assert.strictEqual(local.status, c.status, local.stderr);
      assert.strictEqual(remote.status, c.status, remote.stderr);
      assert.strictEqual(remote.stdout, local.stdout, "stdout identical across modes");
      assert.strictEqual(remote.stderr, local.stderr, "stderr identical across modes");
    });
  }
}

test("mode parity: document reads carry the contract's source, digest and completeness", async () => {
  const cur = JSON.parse((await runIn(DOC_HOME, ["get", "art-doc", "--document", "--json"], { SPOR_MODE: "local" })).stdout);
  assert.strictEqual(cur.complete, true);
  assert.strictEqual(cur.managed, true);
  assert.strictEqual(cur.revision, v2.revision);
  assert.strictEqual(cur.generation, v2.generation);
  assert.strictEqual(cur.doc_sha256, v2.generation, "a complete generation's digest is its generation");
  assert.deepStrictEqual(cur.snapshot, v2.snapshot);
  assert.ok(cur.parts.length >= 2 && cur.parts.every((p, i) => p.id.endsWith(`-g${v2.generation.slice(0, 8)}-${i + 2}`)));
  assert.match(cur.body, /Paragraph 7 \(edited\)/);
  const old = JSON.parse((await runIn(DOC_HOME, ["get", "art-doc", "--document", "--revision", v1.revision, "--json"], { SPOR_MODE: "local" })).stdout);
  assert.doesNotMatch(old.body, /\(edited\)/);
  assert.strictEqual(old.doc_sha256, v1.generation);
  const bad = await runIn(DOC_HOME, ["get", "art-broken", "--document", "--json"], { SPOR_MODE: "local" });
  const b = JSON.parse(bad.stdout);
  assert.strictEqual(b.complete, false);
  assert.strictEqual(b.missing, broken.parts[1]);
  assert.strictEqual(b.doc_sha256, undefined, "an incomplete read carries no document digest");
  assert.match(bad.stderr, /INCOMPLETE — continuation .* could not be followed/);
});

test("mode parity: spor put-document — create, retry, update, stale and over-existing conflicts", async () => {
  const homes = { local: docHome(), remote: docHome() };
  const stubR = await startStubServer({ nodesDir: path.join(homes.remote, "nodes") });
  const envs = { local: { SPOR_MODE: "local" }, remote: { SPOR_SERVER: stubR.base, SPOR_TOKEN: "t" } };
  const both = async (args, input) => {
    const out = {};
    for (const m of ["local", "remote"]) out[m] = await runIn(homes[m], args, envs[m], input);
    assert.strictEqual(out.remote.status, out.local.status, `${args.join(" ")}: ${out.local.stderr} / ${out.remote.stderr}`);
    assert.strictEqual(out.remote.stderr, out.local.stderr, "stderr identical across modes");
    return out;
  };
  try {
    const src1 = docSource("art-put");
    const created = await both(["put-document", "-", "--json"], src1);
    assert.strictEqual(created.local.status, 0, created.local.stderr);
    assert.strictEqual(created.remote.stdout, created.local.stdout, "create result identical");
    const r1 = JSON.parse(created.local.stdout);
    assert.strictEqual(r1.status, "created");
    // Human output: the publication line agrees; the target line names the mode.
    const again = await both(["put-document", "-"], src1);
    assert.strictEqual(again.remote.stdout.split("\n")[0], again.local.stdout.split("\n")[0]);
    assert.match(again.local.stdout, /^put-document unchanged: art-put @ /);
    const over = await both(["put-document", "-"], docSource("art-put", " x"));
    assert.strictEqual(over.local.status, 1);
    assert.match(over.local.stderr, /already exists; pass the snapshot/);
    const snapFile = path.join(homes.local, "read.json");
    fs.writeFileSync(snapFile, JSON.stringify({ snapshot: r1.snapshot }));
    const upd = await both(["put-document", "-", "--snapshot", snapFile, "--json"], docSource("art-put", " (v2)"));
    assert.strictEqual(upd.local.status, 0, upd.local.stderr);
    assert.strictEqual(upd.remote.stdout, upd.local.stdout, "update result identical");
    assert.strictEqual(JSON.parse(upd.local.stdout).status, "updated");
    const stale = await both(["put-document", "-", "--snapshot", JSON.stringify(r1.snapshot)], docSource("art-put", " (v3)"));
    assert.strictEqual(stale.local.status, 1);
    assert.match(stale.local.stderr, /stale revision for 'art-put'; re-read and retry \(conflict\)/);
    // The two graphs are byte-identical afterwards.
    const files = (h) => fs.readdirSync(path.join(h, "nodes")).sort();
    assert.deepStrictEqual(files(homes.remote), files(homes.local));
    for (const f of files(homes.local)) {
      assert.strictEqual(fs.readFileSync(path.join(homes.remote, "nodes", f), "utf8"), fs.readFileSync(path.join(homes.local, "nodes", f), "utf8"), f);
    }
    assert.ok(stubR.requests.some((p) => p === "/v1/documents/art-put"), "PUT reached the stub");
  } finally {
    await stubR.close();
  }
});

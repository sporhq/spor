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

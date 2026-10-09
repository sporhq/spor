"use strict";
// The execution-provider contract v1 (task-spor-execution-provider-contract-spec):
// every JSON example in PROVIDERS.md validates against lib/kernel/provider-contract.js,
// and the schemas refuse what the contract forbids.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const pc = require("../lib/kernel/provider-contract");

const DOC = fs.readFileSync(path.join(__dirname, "..", "PROVIDERS.md"), "utf8");

// Every ```json fence in the doc, with its info-string tag.
function examples() {
  const out = [];
  const re = /```json([^\n]*)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(DOC))) out.push({ info: m[1].trim(), body: m[2], line: DOC.slice(0, m.index).split("\n").length });
  return out;
}

const clone = (v) => JSON.parse(JSON.stringify(v));
const firstOf = (tag) => JSON.parse(examples().find((e) => e.info === `provider-contract=${tag}`).body);

function attemptSpec() {
  return firstOf("attempt-spec");
}
function submitRequest() {
  return clone(examples().map((e) => ({ e, v: e.info === "provider-contract=request" ? JSON.parse(e.body) : null })).find(({ v }) => v && v.op === "submit").v);
}
function manifest() {
  return clone(firstOf("collect-result").manifest);
}

test("every json example in PROVIDERS.md is tagged and validates against its schema", () => {
  const all = examples();
  assert.ok(all.length >= 10, `expected the doc's examples, found ${all.length}`);
  const seen = new Set();
  for (const { info, body, line } of all) {
    const ctx = `PROVIDERS.md:${line} (${info || "untagged"})`;
    const m = /^provider-contract(-refused)?=(\S+)$/.exec(info);
    assert.ok(m, `${ctx}: every json example must carry a provider-contract= tag so this test can check it`);
    const value = JSON.parse(body);
    if (m[1]) continue; // refused examples are asserted below
    const tag = m[2];
    seen.add(tag.split(":")[0]);
    let r;
    if (tag === "request") r = pc.validateRequest(value);
    else if (tag.startsWith("response:")) r = pc.validateResponse(value, tag.slice("response:".length));
    else r = pc.validate(tag, value);
    assert.deepEqual(r.errors, [], `${ctx}`);
    assert.equal(r.ok, true, ctx);
  }
  for (const want of ["request", "response", "attempt-spec", "describe-result", "submit-result", "observe-result", "collect-result"]) {
    assert.ok(seen.has(want), `PROVIDERS.md carries no ${want} example`);
  }
});

test("the doc's refused secret example is refused inside an attempt spec", () => {
  const refused = examples().find((e) => e.info === "provider-contract-refused=secret-entry");
  assert.ok(refused);
  const spec = attemptSpec();
  spec.secrets = [JSON.parse(refused.body)];
  const r = pc.validate("attempt-spec", spec);
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /secrets\[0\]\.ref/);
});

test("a hand-written secret value in secrets[] is refused, under any value key", () => {
  for (const key of pc.$defs.secretRef.not.anyOf.map((s) => s.required[0])) {
    const spec = attemptSpec();
    spec.secrets = [{ name: "GITHUB_TOKEN", ref: "vault://acme/gh", [key]: "ghp_abc" }];
    const r = pc.validate("attempt-spec", spec);
    assert.equal(r.ok, false, key);
    assert.match(r.errors.join("\n"), /by reference only/, key);
  }
  const spec = attemptSpec();
  spec.secrets = [{ name: "GITHUB_TOKEN", ref: "GITHUB_TOKEN=ghp_abc" }];
  assert.equal(pc.validate("attempt-spec", spec).ok, false);
  // the spor block is a reference too: a raw token is refused there as well
  const s2 = attemptSpec();
  s2.spor.token = "spor_pat_123";
  assert.match(pc.validate("attempt-spec", s2).errors.join("\n"), /spor: must not carry/);
  const s3 = attemptSpec();
  s3.spor.token_ref = "spor_pat_123";
  assert.equal(pc.validate("attempt-spec", s3).ok, false);
});

test("a submit missing its idempotency_key is refused", () => {
  const req = submitRequest();
  delete req.params.idempotency_key;
  const r = pc.validateRequest(req);
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ["params.idempotency_key: is required"]);
  const short = submitRequest();
  short.params.idempotency_key = "k";
  assert.equal(pc.validateRequest(short).ok, false);
});

test("a submit carries its attempt spec's checks into the request", () => {
  const req = submitRequest();
  req.params.attempt.secrets = [{ name: "A", ref: "vault://x/a" }, { name: "A", ref: "vault://x/b" }];
  assert.match(pc.validateRequest(req).errors.join("\n"), /params\.attempt\.secrets\[1\]\.name: duplicate/);
  const bad = submitRequest();
  delete bad.params.attempt.execution_id;
  assert.match(pc.validateRequest(bad).errors.join("\n"), /params\.attempt\.execution_id: is required/);
});

test("an unknown observe state is refused, and exit rides only a terminal state", () => {
  let r = pc.validate("observe-result", { state: "succeeded", since: "2026-10-09T10:00:00Z" });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /state: "succeeded" is not one of pending, provisioning, running, suspended, stopping, finished, failed, lost/);
  r = pc.validate("observe-result", { state: "running", since: "2026-10-09T10:00:00Z", exit: { code: 0 } });
  assert.equal(r.ok, false);
  for (const state of pc.OBSERVE_STATES) {
    const body = { state, since: "2026-10-09T10:00:00Z" };
    assert.equal(pc.validate("observe-result", body).ok, true, state);
  }
  // an unknown state inside a response envelope is refused too
  r = pc.validateResponse({ contract_version: 1, id: "x", ok: true, result: { state: "done", since: "2026-10-09T10:00:00Z" } }, "observe");
  assert.equal(r.ok, false);
});

test("a manifest without a candidate reference is refused", () => {
  const noCandidate = manifest();
  delete noCandidate.candidate;
  assert.deepEqual(pc.validate("result-manifest", noCandidate).errors, ["candidate: is required"]);

  const noRef = manifest();
  delete noRef.candidate.reference;
  assert.deepEqual(pc.validate("result-manifest", noRef).errors, ["candidate.reference: is required"]);
  // ...and the same refusal through collect, where a null manifest is the
  // only way to say "nothing produced"
  const r = pc.validate("collect-result", { manifest: noRef });
  assert.deepEqual(r.errors, ["manifest.candidate.reference: is required"]);
  assert.equal(pc.validate("collect-result", { manifest: null }).ok, false, "a null manifest must say why");

  const otherCommit = manifest();
  otherCommit.candidate.reference.commit = "a".repeat(40);
  assert.match(pc.validate("result-manifest", otherCommit).errors.join("\n"), /must equal candidate\.commit/);

  const localPath = manifest();
  localPath.candidate.reference.locator = "/home/me/repo/.git";
  assert.equal(pc.validate("result-manifest", localPath).ok, false);

  const inEnv = manifest();
  inEnv.candidate.reference.locator = "file:///var/lib/ctr/acme-api";
  assert.match(pc.validate("result-manifest", inEnv).errors.join("\n"), /file:\/\/ is not/);

  const both = { manifest: manifest(), no_candidate: { reason: "x" } };
  assert.match(pc.validate("collect-result", both).errors.join("\n"), /must be absent/);

  const bundleNoKey = manifest();
  bundleNoKey.candidate.reference = { kind: "bundle", locator: "https://store/x.bundle", commit: bundleNoKey.candidate.commit };
  assert.match(pc.validate("result-manifest", bundleNoKey).errors.join("\n"), /needs the object 'key'/);
});

test("unknown fields are ignored at every level (forward compatibility)", () => {
  const spec = attemptSpec();
  spec.future_top_level = { anything: [1, 2] };
  spec.harness.sandbox_profile = "strict";
  spec.repos[0].sparse = ["lib/"];
  spec.secrets[0].rotation = "daily";
  assert.deepEqual(pc.validate("attempt-spec", spec).errors, []);

  const req = submitRequest();
  req.trace_id = "abc";
  req.params.priority_hint = 3;
  assert.deepEqual(pc.validateRequest(req).errors, []);

  const resp = { contract_version: 1, id: "r", ok: true, result: { state: "running", since: "2026-10-09T10:00:00Z", progress: 0.4 }, server_time: "x" };
  assert.deepEqual(pc.validateResponse(resp, "observe").errors, []);

  const d = firstOf("describe-result");
  d.capabilities.gpu = ["a100"];
  d.region = "eu";
  assert.deepEqual(pc.validate("describe-result", d).errors, []);

  const m = manifest();
  m.cost = { usd: 0.4 };
  assert.deepEqual(pc.validate("result-manifest", m).errors, []);
});

test("envelopes: version, op, and exactly the result/error the ok flag names", () => {
  assert.equal(pc.validateRequest({ contract_version: 2, id: "a", op: "describe", params: {} }).ok, false);
  assert.equal(pc.validateRequest({ contract_version: 1, id: "a", op: "teleport", params: {} }).ok, false);
  assert.equal(pc.validateRequest({ contract_version: 1, id: "a", op: "describe", params: {} }).ok, true);
  assert.equal(pc.validateRequest({ contract_version: 1, id: "a", op: "observe", params: {} }).ok, false);
  assert.equal(pc.validateRequest({ contract_version: 1, id: "a", op: "restore", params: { handle: { provider: "p", id: "h" }, checkpoint_id: "c" } }).ok, false);
  assert.equal(pc.validateResponse({ contract_version: 1, id: "a", ok: true }, "describe").ok, false);
  assert.equal(pc.validateResponse({ contract_version: 1, id: "a", ok: false }, "describe").ok, false);
  assert.equal(pc.validateResponse({ contract_version: 1, id: "a", ok: false, error: { code: "Bad Code", message: "m" } }, "describe").ok, false);
  assert.equal(pc.validateResponse({ contract_version: 1, id: "a", ok: true, result: { released: true } }, "release").ok, true);
  const err = { code: "internal", message: "m" };
  assert.equal(pc.validateResponse({ contract_version: 1, id: "a", ok: false, result: { released: true }, error: err }, "release").ok, false);
  assert.equal(pc.validateResponse({ contract_version: 1, id: "a", ok: true, result: { released: true }, error: err }, "release").ok, false);
  assert.throws(() => pc.validateResponse({}, "teleport"));
  assert.deepEqual([...pc.OPERATIONS], [...pc.REQUIRED_OPERATIONS, ...pc.OPTIONAL_OPERATIONS]);
  for (const op of pc.OPERATIONS) {
    assert.ok(pc.PARAMS[op], op);
    assert.ok(pc.SCHEMAS[pc.RESULTS[op]], op);
  }
});

test("describe: secret delivery has no plaintext env class; isolation and lifecycle are closed vocabularies", () => {
  const d = firstOf("describe-result");
  d.capabilities.secret_delivery = ["env"];
  assert.equal(pc.validate("describe-result", d).ok, false);
  const d2 = firstOf("describe-result");
  d2.capabilities.isolation = [];
  assert.equal(pc.validate("describe-result", d2).ok, false);
  const d3 = firstOf("describe-result");
  d3.capabilities.lifecycle = ["teleport"];
  assert.equal(pc.validate("describe-result", d3).ok, false);
});

test("attempt spec field rules: pinned commits, exec id, fence, deadline, isolation", () => {
  const cases = [
    ["repos[0].commit", (s) => (s.repos[0].commit = "4b825dc")],
    ["repos", (s) => (s.repos = [])],
    ["execution_id", (s) => (s.execution_id = "exec-xyz")],
    ["fence", (s) => (s.fence = 1.5)],
    ["fence", (s) => (s.fence = -1)],
    ["deadline", (s) => (s.deadline = "tomorrow")],
    ["isolation", (s) => (s.isolation = "chroot")],
    ["prompt_bundle_ref", (s) => (s.prompt_bundle_ref = "prompt.txt")],
    ["contract_version", (s) => (s.contract_version = 2)],
    ["harness.id", (s) => delete s.harness.id],
    ["egress", (s) => delete s.egress],
  ];
  for (const [field, mutate] of cases) {
    const spec = attemptSpec();
    mutate(spec);
    const r = pc.validate("attempt-spec", spec);
    assert.equal(r.ok, false, field);
    assert.ok(r.errors.some((e) => e.startsWith(field)), `${field}: ${r.errors.join("; ")}`);
  }
  const optional = attemptSpec();
  delete optional.model;
  delete optional.resources;
  assert.deepEqual(pc.validate("attempt-spec", optional).errors, []);
  const dup = attemptSpec();
  dup.repos.push(clone(dup.repos[0]));
  assert.match(pc.validate("attempt-spec", dup).errors.join("\n"), /duplicate repo/);
});

test("references carry no credentials in their userinfo", () => {
  const leaky = ["https://x-access-token:ghp_abc@github.com/a.git", "https://ghp_abc@github.com/a.git", "ssh://u:p@host/a.git", "https:///ghp_abc@github.com/a.git", "https:////ghp_abc@github.com/a.git", "https:\\\\ghp_abc@github.com/a.git"];
  for (const url of leaky) {
    const spec = attemptSpec();
    spec.repos[0].url = url;
    assert.equal(pc.validate("attempt-spec", spec).ok, false, url);
    const m = manifest();
    m.candidate.reference.locator = url;
    assert.equal(pc.validate("result-manifest", m).ok, false, url);
  }
  const spec = attemptSpec();
  spec.repos[0].url = "ssh://git@github.com/acme/acme-api.git";
  assert.deepEqual(pc.validate("attempt-spec", spec).errors, []);
});

test("date-times are real calendar dates", () => {
  assert.equal(pc.validate("observe-result", { state: "running", since: "2026-02-30T10:00:00Z" }).ok, false);
  assert.equal(pc.validate("observe-result", { state: "running", since: "2026-02-28T10:00:00.5+02:00" }).ok, true);
});

test("the observe state machine: terminal states never move, a poll may repeat", () => {
  for (const s of pc.TERMINAL_OBSERVE_STATES) {
    assert.equal(pc.observeTransitionAllowed(s, s), true);
    for (const t of pc.OBSERVE_STATES) if (t !== s) assert.equal(pc.observeTransitionAllowed(s, t), false, `${s}->${t}`);
  }
  assert.equal(pc.observeTransitionAllowed("pending", "running"), true);
  assert.equal(pc.observeTransitionAllowed("running", "provisioning"), false);
  assert.equal(pc.observeTransitionAllowed("running", "lost"), true);
  assert.equal(pc.observeTransitionAllowed("running", "done"), false);
  // a suspend/resume round trip is a legal sequence
  assert.equal(pc.observeTransitionAllowed("running", "suspended"), true);
  assert.equal(pc.observeTransitionAllowed("suspended", "running"), true);
  assert.equal(pc.observeTransitionAllowed("pending", "suspended"), false);
  for (const s of pc.OBSERVE_STATES) assert.ok(pc.OBSERVE_TRANSITIONS[s], s);
});

test("the module stays pure: only the kernel candidate import, no node builtins", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "kernel", "provider-contract.js"), "utf8");
  const requires = [...src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, ["./candidate"]);
});

"use strict";
// The execution-provider conformance suite (task-spor-execution-provider-
// conformance-suite): every scenario in lib/shell/provider-conformance.js runs
// against the synthetic in-process provider and the synthetic child-process
// one, and a deliberately broken provider fails it naming the scenario.

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const conf = require("../lib/shell/provider-conformance");
const candidate = require("../lib/kernel/candidate");
const sat = require("../lib/kernel/satisfiability");
const { createSyntheticProvider } = require("./fixtures/providers/synthetic");
const { startSyntheticStdio } = require("./fixtures/providers/synthetic-stdio");

const homes = [];
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-provider-conf-"));
  homes.push(dir);
  return dir;
}
after(() => {
  for (const d of homes) fs.rmSync(d, { recursive: true, force: true });
});

for (const name of conf.SCENARIO_NAMES) {
  test(`in-process synthetic provider: ${name}`, async () => {
    const { provider, driver } = createSyntheticProvider();
    const r = await conf.runScenario(provider, name, { home: scratch(), driver });
    assert.equal(r.skipped, undefined, `${name} was skipped: ${r.skipped}`);
  });
}

test("the subprocess synthetic provider passes every scenario", async () => {
  const p = startSyntheticStdio();
  try {
    const report = await conf.runConformance(p.provider, { home: scratch(), driver: p.driver });
    assert.deepEqual(report.results.filter((r) => !r.ok || r.skipped), []);
    assert.equal(report.ok, true);
    assert.deepEqual(report.results.map((r) => r.name), [...conf.SCENARIO_NAMES]);
  } finally {
    await p.close();
  }
});

test("a non-idempotent submit fails the suite with a message naming the scenario", async () => {
  const { provider, driver } = createSyntheticProvider({ brokenIdempotency: true });
  const report = await conf.runConformance(provider, { home: scratch(), driver });
  assert.equal(report.ok, false);
  const row = report.results.find((r) => r.name === "idempotent-submit");
  assert.equal(row.ok, false);
  assert.match(row.error, /^provider conformance \[idempotent-submit\]: a second submit under the same idempotency key returned a different handle/);
  // The lost-reply reconcile and adoption rest on the same promise.
  assert.equal(report.results.find((r) => r.name === "lost-submit-reply").ok, false);
  assert.equal(report.results.find((r) => r.name === "adopt-new-instance").ok, false);
  await assert.rejects(conf.runScenario(provider, "idempotent-submit", { home: scratch(), driver }), (err) => {
    assert.ok(err instanceof conf.ConformanceFailure);
    assert.equal(err.scenario, "idempotent-submit");
    return true;
  });
});

test("the broken fixture also fails across the process boundary", async () => {
  const p = startSyntheticStdio({ args: ["--broken-idempotency"] });
  try {
    const report = await conf.runConformance(p.provider, { home: scratch(), driver: p.driver, only: ["idempotent-submit"] });
    assert.equal(report.ok, false);
    assert.match(report.results[0].error, /\[idempotent-submit\]/);
  } finally {
    await p.close();
  }
});

test("a provider that never surfaces lost on a crash fails crash-lost", async () => {
  const { provider, driver } = createSyntheticProvider();
  const ignoringCrash = { ...driver, crash() {} };
  await assert.rejects(
    conf.runScenario(provider, "crash-lost", { home: scratch(), driver: { ...ignoringCrash, maxPolls: 5 } }),
    /\[crash-lost\]: waiting for a crashed environment to surface lost, still running after 5 observes/,
  );
});

test("a graceful cancel that kills outright fails cancel-graceful; a forced one that lingers fails cancel-force", async () => {
  const { impl, driver } = createSyntheticProvider();
  const killAlways = conf.bindInProcess({ ...impl, cancel: (p) => impl.cancel({ ...p, force: true }) });
  await assert.rejects(conf.runScenario(killAlways, "cancel-graceful", { home: scratch(), driver }), /\[cancel-graceful\].*expected stopping/);
  const softAlways = conf.bindInProcess({ ...impl, cancel: (p) => impl.cancel({ ...p, force: false }) });
  await assert.rejects(conf.runScenario(softAlways, "cancel-force", { home: scratch(), driver }), /\[cancel-force\].*expected a terminal state/);
});

test("a release that is not idempotent fails release-idempotent", async () => {
  const { impl, driver } = createSyntheticProvider();
  const released = new Set();
  const once = conf.bindInProcess({
    ...impl,
    release(p) {
      if (released.has(p.handle.id)) throw new conf.ProviderError("unknown_handle", "already released");
      released.add(p.handle.id);
      return impl.release(p);
    },
  });
  await assert.rejects(conf.runScenario(once, "release-idempotent", { home: scratch(), driver }), /\[release-idempotent\]: release refused: unknown_handle/);
});

test("a manifest naming another candidate, or a file:// reference, fails observe-collect", async () => {
  const { provider, driver } = createSyntheticProvider();
  const wrong = { ...driver, candidate: () => ({ commit: "f".repeat(40) }) };
  await assert.rejects(conf.runScenario(provider, "observe-collect", { home: scratch(), driver: wrong }), /\[observe-collect\]: manifest candidate commit/);
  const { impl } = createSyntheticProvider();
  const local = conf.bindInProcess({
    ...impl,
    collect(p) {
      const r = impl.collect(p);
      if (r.manifest) r.manifest.candidate.reference = { kind: "bundle", locator: "file:///var/tmp/env/c.bundle", key: "c.bundle", commit: r.manifest.candidate.commit };
      return r;
    },
  });
  await assert.rejects(conf.runScenario(local, "observe-collect", { home: scratch(), driver }), /\[observe-collect\]: collect answered an invalid response: .*file:\/\/ is not/);
});

test("a provider that never answers fails the scenario naming the op, never hangs", async () => {
  const silent = { request: () => new Promise(() => {}) };
  await assert.rejects(
    conf.runScenario(silent, "describe", { home: scratch(), driver: { requestTimeoutMs: 20 } }),
    /\[describe\]: describe did not answer within 20ms/,
  );
});

test("an observe that breaks the state machine fails the scenario", async () => {
  const { impl, driver } = createSyntheticProvider();
  let n = 0;
  const jumpy = conf.bindInProcess({
    ...impl,
    observe(p) {
      const r = impl.observe(p);
      return ++n === 2 ? { state: "pending", since: r.since } : r;
    },
  });
  await assert.rejects(conf.runScenario(jumpy, "observe-collect", { home: scratch(), driver }), /\[observe-collect\]: observe moved provisioning -> pending/);
});

test("refuse-unsatisfiable: the matcher refuses before submit, and a permissive matcher fails the scenario", async () => {
  const { provider, driver } = createSyntheticProvider();
  await conf.runScenario(provider, "refuse-unsatisfiable", { home: scratch(), driver });
  await assert.rejects(
    conf.runScenario(provider, "refuse-unsatisfiable", { home: scratch(), driver, matcher: () => ({ ok: true }) }),
    /\[refuse-unsatisfiable\]: the matcher accepted an attempt asking for isolation worktree/,
  );
  // A provider offering every isolation kind is refused on an absent tool.
  const all = createSyntheticProvider({ capabilities: { isolation: ["worktree", "container", "vm"] } });
  await conf.runScenario(all.provider, "refuse-unsatisfiable", { home: scratch(), driver: all.driver });
});

test("the suite's default matcher is the real satisfiesAttempt, and the derived attempt carries what it reads", async () => {
  const { provider, driver } = createSyntheticProvider();
  const seen = [];
  const spy = (caps, attempt) => (seen.push(attempt), sat.satisfiesAttempt(caps, attempt));
  await conf.runScenario(provider, "refuse-unsatisfiable", { home: scratch(), driver, matcher: spy });
  const [base] = seen;
  assert.equal(base.profile, "profile-conformance");
  assert.deepEqual(base.secret_delivery, ["file"]);
  assert.deepEqual(base.lifecycle, []);
  assert.equal(base.repos.length, 1);
  assert.match(base.repos[0].commit, /^[0-9a-f]{40}$/);
  assert.ok(base.repos[0].branch && base.repos[0].url, "a `*` provider is handed a pinned repo with a url");
  // Under no explicit matcher, a provider that cannot check out the repo fails the base check — the real matcher is in force.
  const noRepos = createSyntheticProvider({ capabilities: { repos: [] } });
  await assert.rejects(
    conf.runScenario(noRepos.provider, "refuse-unsatisfiable", { home: scratch(), driver: noRepos.driver }),
    /\[refuse-unsatisfiable\]: the matcher refuses even the attempt derived from describe\(\): repos: cannot check out conformance/,
  );
  // A provider naming a concrete repo is handed THAT repo, with no url.
  const named = createSyntheticProvider({ capabilities: { repos: ["acme-api"] } });
  await conf.runScenario(named.provider, "refuse-unsatisfiable", { home: scratch(), driver: named.driver });
});

test("cancel-graceful runs even when lifecycle does not list cancel — cancel is a required operation", async () => {
  const { provider, driver } = createSyntheticProvider({ capabilities: { lifecycle: [] } });
  const r = await conf.runScenario(provider, "cancel-graceful", { home: scratch(), driver });
  assert.equal(r.skipped, undefined);
  // force-cancel IS a lifecycle capability, and stays gated on it.
  assert.match((await conf.runScenario(provider, "cancel-force", { home: scratch(), driver })).skipped, /force-cancel/);
});

test("a manifest naming a repo the attempt did not ask for fails the suite", async () => {
  const { provider, driver } = createSyntheticProvider({ manifestRepo: "someone-elses-repo" });
  const report = await conf.runConformance(provider, { home: scratch(), driver });
  for (const name of ["observe-collect", "manifest-before-release", "adopt-new-instance"]) {
    const row = report.results.find((r) => r.name === name);
    assert.equal(row.ok, false, name);
    assert.match(row.error, /manifest candidate repo "someone-elses-repo" is not a repo the attempt named \(conformance\)/);
  }
});

test("AttemptJournal writes are durable and whole: a reader sees the previous or the next state, never a torn file", () => {
  const file = path.join(scratch(), "deep", "j.json");
  const j = new conf.AttemptJournal(file);
  j.write("submitting", { idempotency_key: "k" });
  j.write("submitted", { handle: { provider: "x", id: "1" } });
  assert.deepEqual(j.read(), { submitting: { idempotency_key: "k" }, submitted: { handle: { provider: "x", id: "1" } } });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["j.json"], "no temp file is left behind");
});

test("adoption under a new instance: the re-derived attempt is a conflict and the manifest keeps the submitter's attempt_id", async () => {
  const { provider, driver } = createSyntheticProvider();
  const home = scratch();
  await conf.runScenario(provider, "adopt-new-instance", { home, driver });
  const dir = path.join(home, "provider-conformance", "adopt-new-instance");
  const [file] = fs.readdirSync(dir);
  const rec = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
  assert.equal(rec.submitting.request.attempt.attempt_id, "conf-worker-a:1");
  assert.equal(rec.submitted.existing, true);
});

test("submitMatched never sends an attempt the matcher refuses", async () => {
  const sent = [];
  const client = { call: async (op, params) => (sent.push(op), { handle: { provider: "x", id: "1" }, accepted_at: "2026-10-09T00:00:00Z" }) };
  const journal = new conf.AttemptJournal(path.join(scratch(), "j.json"));
  const r = await conf.submitMatched(client, sat.satisfiesAttempt, { isolation: ["vm"], harnesses: ["codex"], lifecycle: [] }, journal, { isolation: "container", harness: { id: "codex" } }, "key-12345678");
  assert.equal(r.submitted, false);
  assert.deepEqual(r.verdict.missing, ["isolation: 'container' is not offered (this provider offers: vm)"]);
  assert.deepEqual(sent, []);
  assert.deepEqual(journal.read(), {});
});

test("referenceRefusal with foreign: a file:// candidate needs a declared store", () => {
  const ref = { kind: "bundle", locator: "file:///var/tmp/anywhere/c.bundle", key: "c.bundle", commit: "a".repeat(40) };
  // The producer-side default is unchanged: shape alone.
  assert.equal(candidate.referenceRefusal(ref), null);
  assert.match(candidate.referenceRefusal(ref, { foreign: true }), /no bundle store was declared/);
  assert.equal(candidate.referenceRefusal({ ...ref, locator: "file:///store/c.bundle" }, { foreign: true, bundleStore: "file:///store" }), null);
  assert.match(candidate.referenceRefusal(ref, { foreign: true, bundleStore: "file:///store" }), /does not resolve under the declared bundle store/);
  // A network reference is unaffected.
  const branch = { kind: "branch", locator: "https://example.invalid/r.git", ref: "refs/heads/x", commit: "a".repeat(40) };
  assert.equal(candidate.referenceRefusal(branch, { foreign: true }), null);
});

test("bindInProcess answers envelope errors for a bad version, a malformed request and an unimplemented op", async () => {
  const p = conf.bindInProcess({ describe: () => ({}) });
  assert.equal((await p.request({ contract_version: 2, id: "a", op: "describe", params: {} })).error.code, "contract_version_unsupported");
  assert.equal((await p.request({ contract_version: 1, id: "b", op: "observe", params: {} })).error.code, "invalid_request");
  assert.equal((await p.request({ contract_version: 1, id: "c", op: "release", params: { handle: { provider: "x", id: "1" } } })).error.code, "unsupported_operation");
});

// The `ci` suite mode (task-spor-command-gate-waits-on-ci-run,
// dec-spor-command-gate-ci-mode): a command gate — or the integration
// candidate suite — whose verdict is the repo's CI run for the candidate
// commit, not a suite spawned on the worker box. Four layers:
//
//   1. the PARSE (lib/kernel/gates.js): the `ci` block, its refusals, and that
//      a factory declaring none digests exactly as before;
//   2. the EXECUTOR (lib/shell/ci-gate.js) against a real bare remote for the
//      git half and a scripted `gh` for the GitHub half: push, discover, wait,
//      map the conclusion, rerun, delete;
//   3. the PIPELINE (lib/shell/gate-runner.js) with fakes: an outage is never a
//      pass and never a fix cycle, `.github/**` is protected, a CI verdict is
//      named on the fact;
//   4. the machine capability: a factory with a `ci` suite needs gh.
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const gates = require("../lib/kernel/gates.js");
const sat = require("../lib/kernel/satisfiability.js");
const gateRunner = require("../lib/shell/gate-runner.js");
const ciGate = require("../lib/shell/ci-gate.js");
const { gitEnv } = require("./helpers/git.js");

function factoryOf(payload) {
  const body = ["```json", JSON.stringify(payload), "```"].join("\n");
  return gates.parseFactory(body, { id: "factory-test" });
}

const BASE = {
  factory: "test",
  trusted_ref: "main",
  protected_paths: ["test/**"],
  test_lane_profile: "profile-test-writer",
};

// ------------------------------------------------------------------ parse --

test("a command gate's `ci` block parses to its defaults, and only when declared", () => {
  const { factory, errors } = factoryOf({ ...BASE, gates: [{ id: "acceptance", kind: "command", command: "npm test", ci: { workflow: "test.yaml" } }] });
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(factory.gates[0].ci, { workflow: "test.yaml", remote: "origin", pollMs: 30000, discoverMs: 300000, localFallback: false });
  const plain = factoryOf({ ...BASE, gates: [{ id: "acceptance", kind: "command", command: "npm test" }] }).factory;
  assert.strictEqual("ci" in plain.gates[0], false, "an undeclared ci block leaves the parsed gate — and so its definition digest — untouched");
});

test("the integration block carries `ci` too", () => {
  const { factory, errors } = factoryOf({ ...BASE, gates: [{ id: "acceptance", kind: "command", command: "npm test" }], integration: { command: "npm test", ci: { workflow: "test.yaml", local_fallback: true, repo: "sporhq/spor" } } });
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(factory.integration.ci.localFallback, true);
  assert.strictEqual(factory.integration.ci.repo, "sporhq/spor");
});

test("a malformed `ci` block refuses the factory rather than running the suite somewhere it did not mean", () => {
  const bad = (ci, extra = {}) => factoryOf({ ...BASE, gates: [{ id: "acceptance", kind: "command", command: "npm test", ci, ...extra }] }).errors.join("\n");
  assert.match(bad({}), /'workflow' is required/);
  assert.match(bad("test.yaml"), /must be a JSON object/);
  assert.match(bad({ workflow: "t.yaml", local_fallback: "yes" }), /local_fallback must be true or false/);
  assert.match(bad({ workflow: "t.yaml", repo: "nope" }), /must be 'owner\/name'/);
  assert.match(bad({ workflow: "t.yaml", remote: "a b" }), /must be a git remote name/);
  assert.match(bad({ workflow: "t.yaml", command: "rm -rf /" }), /unknown key 'command'/);
  assert.match(bad({ workflow: "t.yaml" }, { isolate: "node --test {files}" }), /isolate cannot be declared on a ci gate/);
});

test("a CI conclusion is a verdict only when it is success, failure or timed_out — everything else is an outage", () => {
  assert.strictEqual(gates.ciConclusionVerdict("success"), "passed");
  assert.strictEqual(gates.ciConclusionVerdict("failure"), "failed");
  assert.strictEqual(gates.ciConclusionVerdict("timed_out"), "failed");
  for (const c of ["cancelled", "skipped", "stale", "neutral", "action_required", "startup_failure", "", null, "whatever"]) {
    assert.strictEqual(gates.ciConclusionVerdict(c), "outage", `${c} is not a verdict on the change`);
  }
});

test("the candidate branch lives under spor/candidate/, with a distinct integration branch", () => {
  assert.strictEqual(gates.ciCandidateBranch("task-foo"), "spor/candidate/task-foo");
  assert.strictEqual(gates.ciCandidateBranch("task-foo", "integration"), "spor/candidate/task-foo-integration");
  assert.deepStrictEqual(gates.suiteProtectedPaths({ ci: {} }, ["test/**"]), ["test/**", ".github/**"]);
  assert.deepStrictEqual(gates.suiteProtectedPaths({}, ["test/**"]), ["test/**"], "a local suite's protected set is the factory's, unchanged");
});

// --------------------------------------------------------------- executor --

// A real repo with a real bare remote, so the push and the lease-guarded
// delete are git's own behaviour; `gh` is scripted.
function repoWithRemote() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spor-ci-gate-"));
  const remote = path.join(root, "remote.git");
  const work = path.join(root, "work");
  const env = gitEnv();
  const g = (cwd, ...args) => {
    const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    assert.strictEqual(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return (r.stdout || "").trim();
  };
  fs.mkdirSync(work);
  g(root, "init", "-q", "--bare", remote);
  g(work, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(work, "a.txt"), "a\n");
  g(work, "add", ".");
  g(work, "commit", "-q", "-m", "a");
  g(work, "remote", "add", "origin", remote);
  const sha = g(work, "rev-parse", "HEAD");
  const remoteRef = (branch) => {
    const r = spawnSync("git", ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], { cwd: remote, env, encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  return { root, work, remote, sha, g, remoteRef };
}

// `gh` answers from `script(args)`; git runs for real under a scrubbed env.
function execWith(script, calls) {
  return async (cmd, args, opts = {}) => {
    calls.push([cmd, ...args]);
    if (cmd === "git") {
      const r = spawnSync("git", args, { cwd: opts.cwd, env: gitEnv({}, opts.env || process.env), encoding: "utf8" });
      return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "", error: r.error || null };
    }
    return script(args);
  };
}

const json = (v) => ({ status: 0, stdout: JSON.stringify(v), stderr: "", error: null });

// `gh run list` answering NOTHING for its first (pre-push) read and `runs`
// after — the run this push started did not exist before it.
function afterPush(runs) {
  let n = 0;
  return () => (n++ === 0 ? json([]) : json(runs));
}

function clock() {
  let t = 1_700_000_000_000;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

const CI = { workflow: "test.yaml", remote: "origin", pollMs: 5000, discoverMs: 60000, localFallback: false };

test("a CI suite pushes the candidate, waits on the workflow's run for that commit, passes on success, and deletes the branch", async () => {
  const repo = repoWithRemote();
  const calls = [];
  let views = 0;
  const list = afterPush([{ databaseId: 42, headSha: repo.sha, status: "queued", conclusion: "", url: "https://ci/42", attempt: 1 }]);
  const exec = execWith((args) => {
    if (args[1] === "list") return list();
    if (args[1] === "view") {
      views += 1;
      return json(views < 3 ? { status: "in_progress", conclusion: "", attempt: 1 } : { status: "completed", conclusion: "success", url: "https://ci/42", attempt: 1 });
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  }, calls);
  const branch = gates.ciCandidateBranch("task-demo");
  const suite = await ciGate.openCiSuite({ top: repo.work, sha: repo.sha, branch, ci: CI, timeoutMs: 600000, exec, ...clock() });
  assert.strictEqual(suite.ok, true);
  assert.strictEqual(repo.remoteRef(branch), repo.sha, "the candidate commit is on the remote under spor/candidate/");
  const r = await suite.run(1);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.ci.run_id, 42);
  assert.strictEqual(r.ci.url, "https://ci/42");
  const listCall = calls.find((c) => c[0] === "gh" && c[2] === "list");
  assert.ok(listCall.includes("--commit") && listCall.includes(repo.sha), "the run is looked up by the exact commit");
  assert.ok(listCall.includes("--workflow") && listCall.includes("test.yaml"));
  await suite.close();
  assert.strictEqual(repo.remoteRef(branch), null, "the candidate branch is gone once the verdict is read");
});

test("a failed CI run is a charged failure carrying the failed jobs' log; a rerun re-runs the SAME run and waits for its new attempt", async () => {
  const repo = repoWithRemote();
  const calls = [];
  let attempt = 1;
  let reran = false;
  let stale = 0;
  const list = afterPush([{ databaseId: 7, headSha: repo.sha, status: "completed", conclusion: "failure", url: "https://ci/7", attempt: 1 }]);
  const exec = execWith((args) => {
    if (args[1] === "list") return list();
    if (args[1] === "rerun") {
      reran = true;
      return json({});
    }
    if (args[1] === "view" && args.includes("--log-failed")) return { status: 0, stdout: "test (1/4)\tnot ok 3 - the sync worker drops records\n", stderr: "", error: null };
    if (args[1] === "view") {
      // GitHub answers the OLD attempt for a moment after a rerun.
      if (reran && stale < 2) {
        stale += 1;
        return json({ status: "completed", conclusion: "failure", url: "https://ci/7", attempt: 1 });
      }
      if (reran) attempt = 2;
      return json({ status: "completed", conclusion: attempt === 2 ? "success" : "failure", url: "https://ci/7", attempt });
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  }, calls);
  const suite = await ciGate.openCiSuite({ top: repo.work, sha: repo.sha, branch: "spor/candidate/task-demo", ci: CI, timeoutMs: 600000, exec, ...clock() });
  const first = await suite.run(1);
  assert.strictEqual(first.ok, false);
  assert.strictEqual(first.outage, undefined, "a failure is a verdict, not an outage");
  assert.match(first.reason, /concluded failure/);
  assert.match(first.output, /the sync worker drops records/);
  const second = await suite.run(2);
  assert.strictEqual(second.ok, true, "the stale attempt-1 answer was not read as the rerun's verdict");
  assert.strictEqual(second.ci.attempt, 2);
  assert.ok(calls.some((c) => c[0] === "gh" && c[1] === "run" && c[2] === "rerun" && c[3] === "7"));
  await suite.close();
});

test("cancelled, a run that never appears, an unreachable gh, a failed push and a wait past the timeout are all OUTAGES", async () => {
  const repo = repoWithRemote();
  const open = (script, extra = {}) => ciGate.openCiSuite({ top: repo.work, sha: repo.sha, branch: "spor/candidate/task-demo", ci: CI, timeoutMs: 120000, exec: execWith(script, []), ...clock(), ...extra });

  const listed = () => afterPush([{ databaseId: 1, headSha: repo.sha, attempt: 1 }]);
  const l1 = listed();
  const cancelled = await (await open((a) => (a[1] === "list" ? l1() : json({ status: "completed", conclusion: "cancelled", attempt: 1 })))).run(1);
  assert.strictEqual(cancelled.ok, false);
  assert.strictEqual(cancelled.outage.outcome, "infrastructure");
  assert.match(cancelled.reason, /cancelled/);

  const never = await (await open(() => json([]))).run(1);
  assert.strictEqual(never.outage.outcome, "infrastructure");
  assert.match(never.reason, /no run of .* appeared/);

  const noGh = await open(() => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }) }));
  assert.strictEqual(noGh.ok, false, "no gh: refused before anything is pushed");
  assert.strictEqual(noGh.outage.outcome, "infrastructure");
  assert.match(noGh.reason, /gh.*not on PATH/);

  const l2 = listed();
  const hung = await (await open((a) => (a[1] === "list" ? l2() : json({ status: "in_progress", attempt: 1 })))).run(1);
  assert.strictEqual(hung.outage.outcome, "infrastructure");
  assert.match(hung.reason, /did not finish within 120s/);

  const badRemote = { ...CI, remote: "nowhere" };
  const pushed = await ciGate.openCiSuite({ top: repo.work, sha: repo.sha, branch: "spor/candidate/task-demo", ci: badRemote, timeoutMs: 120000, exec: execWith(() => json([]), []), ...clock() });
  assert.strictEqual(pushed.ok, false);
  assert.strictEqual(pushed.outage.outcome, "infrastructure");
  assert.match(pushed.reason, /could not be pushed/);
});

test("a run that existed BEFORE the push — a finished one for the same commit, or a pull_request run — is never read as this push's verdict", async () => {
  const repo = repoWithRemote();
  let lists = 0;
  const old = { databaseId: 3, headSha: repo.sha, headBranch: "spor/candidate/task-demo", event: "push", status: "completed", conclusion: "cancelled", attempt: 1 };
  const pr = { databaseId: 4, headSha: repo.sha, headBranch: "task-demo", event: "pull_request", status: "completed", conclusion: "success", attempt: 1 };
  const fresh = { databaseId: 9, headSha: repo.sha, headBranch: "spor/candidate/task-demo", event: "push", status: "queued", attempt: 1 };
  const exec = execWith((a) => {
    if (a[1] === "list") {
      lists += 1;
      // The pre-push read, then two polls before the new run shows up.
      return json(lists <= 3 ? [old] : [fresh, pr, old]);
    }
    if (a[1] === "view") return json({ status: "completed", conclusion: a[2] === "9" ? "success" : "cancelled", url: `https://ci/${a[2]}`, attempt: 1 });
    throw new Error(`unexpected gh ${a.join(" ")}`);
  }, []);
  const suite = await ciGate.openCiSuite({ top: repo.work, sha: repo.sha, branch: "spor/candidate/task-demo", ci: CI, timeoutMs: 600000, exec, ...clock() });
  const r = await suite.run(1);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.ci.run_id, 9, "the run THIS push started");
  assert.ok(lists >= 4, "it kept polling while only the old run was listed");
});

test("a CI that cannot even be listed before the push is unreachable — an outage, and nothing is pushed", async () => {
  const repo = repoWithRemote();
  const suite = await ciGate.openCiSuite({ top: repo.work, sha: repo.sha, branch: "spor/candidate/task-demo", ci: CI, timeoutMs: 60000, exec: execWith(() => ({ status: 1, stdout: "", stderr: "HTTP 503", error: null }), []), ...clock() });
  assert.strictEqual(suite.ok, false);
  assert.strictEqual(suite.outage.outcome, "infrastructure");
  assert.match(suite.reason, /HTTP 503/);
  assert.strictEqual(repo.remoteRef("spor/candidate/task-demo"), null);
});

test("a candidate branch left standing at the SAME commit is taken down first, so the push is a real one that starts a run", async () => {
  const repo = repoWithRemote();
  const branch = "spor/candidate/task-demo";
  repo.g(repo.work, "push", "-q", "origin", `${repo.sha}:refs/heads/${branch}`);
  const calls = [];
  const suite = await ciGate.openCiSuite({ top: repo.work, sha: repo.sha, branch, ci: CI, timeoutMs: 60000, exec: execWith(() => json([]), calls), ...clock() });
  assert.strictEqual(suite.ok, true);
  const pushes = calls.filter((c) => c[0] === "git" && c[1] === "push");
  assert.strictEqual(pushes.length, 2, "a delete, then the push");
  assert.ok(pushes[0].includes(`:refs/heads/${branch}`), "the first push deletes the stale branch");
  assert.strictEqual(repo.remoteRef(branch), repo.sha);
});

test("closing deletes the candidate branch only while it still names OUR commit", async () => {
  const repo = repoWithRemote();
  const branch = "spor/candidate/task-demo";
  const suite = await ciGate.openCiSuite({ top: repo.work, sha: repo.sha, branch, ci: CI, timeoutMs: 60000, exec: execWith(() => json([]), []), ...clock() });
  // A later pipeline pushed a newer candidate for the same node.
  fs.writeFileSync(path.join(repo.work, "b.txt"), "b\n");
  repo.g(repo.work, "add", ".");
  repo.g(repo.work, "commit", "-q", "-m", "b");
  const newer = repo.g(repo.work, "rev-parse", "HEAD");
  repo.g(repo.work, "push", "-q", "--force", "origin", `${newer}:refs/heads/${branch}`);
  await suite.close();
  assert.strictEqual(repo.remoteRef(branch), newer, "someone else's candidate is not ours to delete");
});

// --------------------------------------------------------------- pipeline --

const ITEM = { node_id: "task-demo", run_id: "run-abcdef12", project: "demo" };

function fakes({ changed = ["lib/x.js"], suite, pools = null }) {
  const seen = { facts: [], lane: [], escalations: [], fixes: [], runs: 0, opened: [], pools: pools ? { ...pools } : null };
  let t = 1_700_000_000_000;
  const deps = {
    now: () => t,
    sleep: async (ms) => { t += ms; },
    changedPaths: async () => ({ ok: true, paths: changed, head: "h".repeat(40), base: "b".repeat(40), trustedRef: "main", trustedSha: "t".repeat(40), branch: "task-demo" }),
    openSuite: async (args) => {
      seen.opened.push(args);
      return { ok: true, dir: "", run: async (attempt) => { seen.runs += 1; return suite(attempt, seen); }, close: async () => {} };
    },
    fix: async () => { seen.fixes.push(1); return { ok: true }; },
    recordFact: async ({ id, markdown }) => { seen.facts.push({ id, markdown }); return { ok: true, id }; },
    fileTestLaneItem: async (args) => { seen.lane.push(args); return { ok: true, id: "task-test-lane-x" }; },
    escalate: async (args) => { seen.escalations.push(args); return { ok: true, id: `task-gate-${args.gate.id}` }; },
    demote: async () => ({ ok: true, demoted: true }),
    ...(pools ? { loadGatePools: async () => seen.pools, saveGatePools: async ({ pools: next }) => { seen.pools = next; } } : {}),
  };
  return { deps, seen };
}

const CI_GATE = { id: "acceptance", kind: "command", command: "npm test", ci: { workflow: "test.yaml" }, cycles: 2, reruns: 1 };

test("a CI pass passes the gate and names the run on the fact", async () => {
  const { factory } = factoryOf({ ...BASE, gates: [CI_GATE] });
  const { deps, seen } = fakes({ suite: () => ({ ok: true, code: 0, output: "", ci: { run_id: 42, url: "https://ci/42" } }) });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "passed");
  assert.match(seen.facts[0].markdown, /judged on CI \(https:\/\/ci\/42\)/);
  assert.ok(seen.opened[0].protectedPaths.includes(".github/**"), "the suite is opened with the CI definition protected");
});

test("a CI OUTAGE is never a pass, never a rerun and never a fix cycle — it refuses naming the outage", async () => {
  const { factory } = factoryOf({ ...BASE, gates: [CI_GATE] });
  const outage = { ok: false, code: null, reason: "CI workflow `test.yaml` run https://ci/1 concluded 'cancelled'", outage: { outcome: "infrastructure", reason: "cancelled", pool: "retry" } };
  const { deps, seen } = fakes({ suite: () => outage });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "failed", "fail closed");
  assert.strictEqual(res.gates[0].verdict, "infrastructure");
  assert.strictEqual(seen.runs, 1, "a declared rerun is not spent on an outage");
  assert.strictEqual(seen.fixes.length, 0, "no fixer is dispatched at a change nobody judged");
  assert.match(seen.escalations[0].detail, /not a verdict on the change/);
});

test("a CI outage is paid from the infrastructure retry pool when the factory declares one", async () => {
  const { factory } = factoryOf({ ...BASE, gates: [CI_GATE], implementation: { profile: "profile-impl", retry: { attempts: 1, backoff_ms: 1000 } } });
  const { deps, seen } = fakes({
    pools: { retry: { spent: 0 } },
    suite: (attempt, s) => (s.opened.length === 1 ? { ok: false, reason: "cancelled", outage: { outcome: "infrastructure", reason: "cancelled" } } : { ok: true, ci: { run_id: 2 } }),
  });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "passed");
  assert.strictEqual(seen.pools.retry.spent, 1);
  assert.strictEqual(seen.fixes.length, 0);
});

test("a CI failure is charged like a local one — a fix cycle, with the CI log as evidence", async () => {
  const { factory } = factoryOf({ ...BASE, gates: [{ ...CI_GATE, reruns: 0, cycles: 1 }] });
  const { deps, seen } = fakes({ suite: (attempt, s) => (s.fixes.length ? { ok: true } : { ok: false, code: 1, reason: "CI run https://ci/9 concluded failure", output: "not ok 3 - drops records\n" }) });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "passed");
  assert.strictEqual(seen.fixes.length, 1);
});

test("a change touching .github fails a CI gate CLOSED, unrun, into the test-change lane", async () => {
  const { factory } = factoryOf({ ...BASE, gates: [CI_GATE] });
  const { deps, seen } = fakes({ changed: ["lib/x.js", ".github/workflows/test.yaml"], suite: () => ({ ok: true }) });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "failed");
  assert.strictEqual(res.gates[0].verdict, "fail-closed");
  assert.strictEqual(seen.runs, 0, "the suite never ran");
  assert.deepStrictEqual(seen.lane[0].paths, [".github/workflows/test.yaml"]);
});

test("a LOCAL command gate does not treat .github as protected", async () => {
  const { factory } = factoryOf({ ...BASE, gates: [{ id: "acceptance", kind: "command", command: "npm test" }] });
  const { deps } = fakes({ changed: [".github/workflows/test.yaml"], suite: () => ({ ok: true }) });
  const res = await gateRunner.runGatePipeline({ item: ITEM, factory, deps });
  assert.strictEqual(res.state, "passed");
});

// ------------------------------------------------------------- capability --

test("a factory with a `ci` suite needs gh on the machine; one without does not", () => {
  const ci = factoryOf({ ...BASE, gates: [CI_GATE] }).factory;
  const integ = factoryOf({ ...BASE, gates: [{ id: "acceptance", kind: "command", command: "npm test" }], integration: { command: "npm test", ci: { workflow: "test.yaml" } } }).factory;
  const plain = factoryOf({ ...BASE, gates: [{ id: "acceptance", kind: "command", command: "npm test" }] }).factory;
  assert.strictEqual(sat.satisfiesIntegration({}, plain).ok, true);
  for (const f of [ci, integ]) {
    const r = sat.satisfiesIntegration({}, f);
    assert.strictEqual(r.ok, false);
    assert.match(r.reasons[0], /'ci'/);
    assert.strictEqual(sat.satisfiesIntegration({ gh: true }, f).ok, true);
  }
});

// --------------------------------------------------------- the real door --
//
// bin/spor.js `makeGateDeps().openSuite` for a `ci` gate, against a REAL repo
// and bare remote with a scripted `gh` on PATH: the commit CI is asked about
// is the judged head with the protected paths forced to the TRUSTED copy —
// never the branch's own tree when the trusted ref has moved its tests on.
// Skipped on Windows: the scripted `gh` there is a .cmd stub, which a non-shell
// spawn does not resolve (the real gh.exe does).
test("the real openSuite pushes the head with the trusted copy of the protected paths, and CI judges exactly that commit", { skip: process.platform === "win32" }, async (t) => {
  const { writeFakePathNodeBin } = require("./helpers/portable");
  const sporCli = require("../bin/spor.js");
  const { loadConfig } = require("../lib/config.js");
  const repo = repoWithRemote();
  t.after(() => fs.rmSync(repo.root, { recursive: true, force: true }));
  const { g, work } = repo;
  fs.mkdirSync(path.join(work, "test"));
  fs.mkdirSync(path.join(work, "lib"));
  fs.writeFileSync(path.join(work, "test", "a.test.js"), "v1\n");
  fs.writeFileSync(path.join(work, "lib", "x.js"), "x0\n");
  g(work, "add", ".");
  g(work, "commit", "-q", "-m", "base");
  g(work, "checkout", "-q", "-b", "task-x");
  fs.writeFileSync(path.join(work, "lib", "x.js"), "x1\n");
  g(work, "commit", "-q", "-am", "the change");
  const head = g(work, "rev-parse", "HEAD");
  g(work, "checkout", "-q", "main");
  fs.writeFileSync(path.join(work, "test", "a.test.js"), "v2\n");
  g(work, "commit", "-q", "-am", "trusted tests move on");
  g(work, "checkout", "-q", "task-x");

  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-fake-gh-"));
  const asked = path.join(binDir, "asked.txt");
  writeFakePathNodeBin(binDir, "gh", `
    const fs = require("fs");
    const a = process.argv.slice(2);
    if (a[1] === "list") {
      const sha = a[a.indexOf("--commit") + 1];
      const first = !fs.existsSync(${JSON.stringify(asked)});
      fs.appendFileSync(${JSON.stringify(asked)}, sha + "\\n");
      process.stdout.write(JSON.stringify(first ? [] : [{ databaseId: 5, headSha: sha, status: "queued", attempt: 1 }]));
    } else {
      process.stdout.write(JSON.stringify({ status: "completed", conclusion: "success", url: "https://ci/5", attempt: 1 }));
    }
  `);
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath}`;
  t.after(() => {
    process.env.PATH = oldPath;
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-ci-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_MODE: "local" } });
  const gate = { id: "acceptance", kind: "command", command: "npm test", timeoutMs: 60000, ci: { workflow: "test.yaml", remote: "origin", pollMs: 5000, discoverMs: 60000, localFallback: false } };
  const factory = { trustedRef: "main", protectedPaths: ["test/**"], gates: [gate] };
  const deps = sporCli.makeGateDeps(cfg, { record: { cwd: work, run_id: "run-1", harness: "claude-code" }, entry: { run_id: "run-1", node_id: "task-x", project: "demo" }, factory, slug: "demo", log: () => {}, warn: () => {}, home });
  const change = await deps.changedPaths({ trustedRef: "main" });
  assert.strictEqual(change.ok, true, change.reason);
  const suite = await deps.openSuite({ gate, trustedRef: "main", protectedPaths: gates.suiteProtectedPaths(gate, factory.protectedPaths) });
  assert.strictEqual(suite.ok, true, suite.reason);
  const branch = "spor/candidate/task-x";
  const pushed = repo.remoteRef(branch);
  assert.ok(pushed && pushed !== head, "the head was re-committed with the trusted protected paths");
  const show = (p) => spawnSync("git", ["show", `${pushed}:${p}`], { cwd: repo.remote, env: gitEnv(), encoding: "utf8" }).stdout;
  assert.strictEqual(show("test/a.test.js"), "v2\n", "the trusted ref's copy of the test");
  assert.strictEqual(show("lib/x.js"), "x1\n", "the change itself");
  const r = await suite.run(1);
  assert.strictEqual(r.ok, true, r.reason);
  assert.deepStrictEqual([...new Set(fs.readFileSync(asked, "utf8").trim().split("\n"))], [pushed], "CI was asked about exactly the pushed candidate");
  await suite.close();
  assert.strictEqual(repo.remoteRef(branch), null);
});

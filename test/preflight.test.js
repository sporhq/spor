// Worker preflight validation + the diagnostic --print
// (task-spor-worker-preflight-validation).
//
// The regression fixtures here are the Dartlane pilot's two runtime failures
// (art-spor-dartlane-factory-pilot-review-2026-09-05), plus the guarantees the
// fix must not trade away:
//
//   - `fe24cc97` launched Claude Code with NO unattended write posture, so every
//     write came back permission-blocked and the item was reported against work
//     that never happened. An unattended worker must refuse that BEFORE it
//     claims anything;
//   - `4002ba00` put several concurrent writers straight into /home/exedev/
//     dartlane because the repo declared `dispatch.worktreeSetup` and nobody
//     had also set `dispatch.worktree`. A setup hook must still not be read as
//     enabling isolation — it must be DIAGNOSED — and two live writers in one
//     candidate must be refused;
//   - an explicit single run, and genuinely isolated concurrent candidates,
//     keep working exactly as they did;
//   - `--print` resolves through the same path and mutates nothing: no claim,
//     no child, no worktree, no config write, no credential in its output.
//
// Everything runs against a throwaway graph home with SPOR_*/SUBSTRATE_*
// routing cleared (norm-cc-scratch-home-for-tests).
require("./helpers/tmp-cleanup"); // scratch-home leak guard (issue-spor-test-mkdtemp-inode-exhaustion)
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync, spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const preflight = require("../lib/shell/preflight.js");
const dispatchHarnesses = require("../lib/shell/dispatch-harnesses.js");
const { writeSpawnableNodeStub, pathWithOnlyGitAndNode } = require("./helpers/portable");
const { waitForFile } = require("./helpers/launch.js");

// ------------------------------------------------------------- pure layer --

test("the posture MEANING is read from the adapter that owns the flags, never the cross-adapter translator", () => {
  const claude = dispatchHarnesses.getHarness("claude-code");
  const codex = dispatchHarnesses.getHarness("codex");
  // The trap this exists to avoid: every dispatch carries Codex's effective
  // sandbox/approval defaults, so the cross-adapter postureMeaning() would read
  // a permission-mode-less Claude Code launch as `unattended`.
  const asLaunched = { permissionMode: null, sandbox: "workspace-write", approvalPolicy: "never" };
  assert.strictEqual(dispatchHarnesses.postureMeaning(asLaunched), "unattended", "the translator's own reading (correct for translation)");
  assert.strictEqual(preflight.launchPostureMeaning(claude, asLaunched), null, "but Claude Code itself resolves NO posture from it");
  assert.strictEqual(preflight.launchPostureMeaning(codex, asLaunched), "unattended");
  assert.strictEqual(preflight.launchPostureMeaning(claude, { permissionMode: "bypassPermissions" }), "unattended");
  assert.strictEqual(preflight.launchPostureMeaning(claude, { permissionMode: "acceptEdits" }), "attended");
  assert.strictEqual(preflight.launchPostureMeaning(claude, { permissionMode: "plan" }), "read-only");
  assert.strictEqual(preflight.launchPostureMeaning(codex, { sandbox: "workspace-write", approvalPolicy: "on-request" }), "attended");
  // OpenCode owns no posture flags at all but declares an EMPTY unattended
  // posture: `--auto` is in its argv builder and cannot be unsaid.
  assert.strictEqual(preflight.launchPostureMeaning(dispatchHarnesses.getHarness("opencode"), {}), "unattended");
});

test("checkWritePosture refuses an unattended run with no posture, and never judges an interactive one", () => {
  const claude = dispatchHarnesses.getHarness("claude-code");
  const none = { permissionMode: null, sandbox: "workspace-write", approvalPolicy: "never" };
  const interactive = preflight.checkWritePosture({ adapter: claude, options: none, unattended: false });
  assert.strictEqual(interactive.ok, true, "a person IS the answer to a permission prompt — the supported single-run behavior");

  const worker = preflight.checkWritePosture({ adapter: claude, options: none, unattended: true });
  assert.strictEqual(worker.ok, false);
  assert.match(worker.reason, /no write posture resolved/);
  assert.match(worker.hint, /--permission-mode bypassPermissions/, "the fix is named in the operator's own flag vocabulary");

  const attended = preflight.checkWritePosture({ adapter: claude, options: { permissionMode: "acceptEdits" }, unattended: true });
  assert.strictEqual(attended.ok, false);
  assert.match(attended.reason, /ATTENDED/);

  const fine = preflight.checkWritePosture({ adapter: claude, options: { permissionMode: "bypassPermissions" }, unattended: true });
  assert.strictEqual(fine.ok, true);
  // A review gate never asked to write, so read-only IS the appropriate posture.
  const review = preflight.checkWritePosture({ adapter: claude, options: { permissionMode: "plan" }, unattended: true, readOnly: true });
  assert.strictEqual(review.ok, true);
  assert.strictEqual(review.meaning, "read-only");
});

test("a DECLARED custom harness is operator-bound: warned about, never refused (this client expresses no posture for it)", () => {
  const adapter = dispatchHarnesses.declaredAdapter({
    id: "myfake", label: "My Fake", command: "/bin/true", args: [], session: [], report: { from: "lastText", text: ["text"] },
  });
  assert.strictEqual(preflight.posturePolicy(adapter), "operator-bound");
  const v = preflight.checkWritePosture({ adapter, options: {}, unattended: true, harnessId: "myfake" });
  assert.strictEqual(v.ok, true, "v1 scope fixes the argv the operator declared — there is nothing here to check");
  assert.match(v.warning, /^warning: /, "but it is said out loud, and as a `warning:` so it never becomes a refusal reason");
  assert.match(v.warning, /dispatch\.harness\.myfake\.args/);
});

test("liveWorkspaceWriters counts only live, write-capable runs in the exact candidate", () => {
  const dir = path.resolve("/tmp/candidate");
  const watching = (r) => r.runner_pid === 111;
  const now = () => Date.parse("2026-09-05T12:00:00Z");
  const records = [
    { run_id: "a", state: "running", cwd: dir, runner_pid: 111, node_id: "task-a" },
    { run_id: "b", state: "running", cwd: dir, runner_pid: 222 }, // supervisor gone
    { run_id: "c", state: "reported", cwd: dir, runner_pid: 111 }, // terminal
    { run_id: "d", state: "running", cwd: dir, runner_pid: 111, read_only: true }, // a reader is not a writer
    { run_id: "e", state: "running", cwd: path.resolve("/tmp/other"), runner_pid: 111 },
    { run_id: "f", state: "running", cwd: dir, launch_mode: "native-background", created_at: "2026-09-05T11:59:00Z" },
    { run_id: "g", state: "running", cwd: dir, launch_mode: "native-background", created_at: "2026-09-04T00:00:00Z" }, // past the native horizon
  ];
  const ids = preflight.liveWorkspaceWriters(records, { dir, watching, now }).map((w) => w.run_id);
  assert.deepStrictEqual(ids, ["a", "f"]);
  assert.deepStrictEqual(
    preflight.liveWorkspaceWriters(records, { dir, watching, now, excludeRunId: "a" }).map((w) => w.run_id),
    ["f"],
    "a run never occupies its own candidate"
  );
});

test("a supervised writer is believed only while its supervisor is still WATCHING, not while its pid merely answers", () => {
  // Off Linux (and on an older record) the start-time tick count is unknowable,
  // so a bare `isSameSupervisor` collapses to a pid probe a RECYCLED pid answers
  // just as readily — which here would occupy a shared checkout forever and
  // starve a worker that has no `--force`
  // (issue-spor-dispatch-supervisor-liveness-check-divergence).
  const dir = path.resolve("/tmp/candidate");
  const record = { run_id: "a", state: "running", cwd: dir, runner_pid: 4242 };
  assert.deepStrictEqual(
    preflight.liveWorkspaceWriters([record], { dir, watching: () => true }).map((w) => w.run_id),
    ["a"]
  );
  assert.deepStrictEqual(
    preflight.liveWorkspaceWriters([record], { dir, watching: () => false }).map((w) => w.run_id),
    [],
    "a supervisor that is alive-but-silent past the stale window no longer occupies the candidate"
  );
});

test("planWorkspace reports a worktreeSetup hook declared without isolation — and never interprets it as enabling one", () => {
  const shared = preflight.planWorkspace({ repoDir: "/repo", worktreeDir: "/repo/.claude/worktrees/x", useWorktree: false, worktreeSetup: "/repo/setup.sh" });
  assert.strictEqual(shared.dir, "/repo");
  assert.strictEqual(shared.isolation, "shared");
  assert.strictEqual(shared.setupOrphaned, true);
  // Asked for explicitly, the mismatch is the operator's own choice, not a slip.
  const asked = preflight.planWorkspace({ repoDir: "/repo", worktreeDir: "/repo/.claude/worktrees/x", useWorktree: false, worktreeSetup: "/repo/setup.sh", explicitNoWorktree: true });
  assert.strictEqual(asked.setupOrphaned, false);
  const isolated = preflight.planWorkspace({ repoDir: "/repo", worktreeDir: "/repo/.claude/worktrees/x", useWorktree: true, worktreeSetup: "/repo/setup.sh" });
  assert.strictEqual(isolated.dir, "/repo/.claude/worktrees/x");
  assert.strictEqual(isolated.isolation, "worktree");
  assert.strictEqual(isolated.setupOrphaned, false);
});

test("acquireWorkspace is exclusive per candidate, self-heals an expired dead holder, and degrades open on an unwritable journal", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-preflight-lock-"));
  const dir = path.join(home, "candidate");
  const first = await preflight.acquireWorkspace(home, dir, { waitMs: 0 });
  assert.strictEqual(first.ok, true);
  assert.ok(first.token, "held");
  const second = await preflight.acquireWorkspace(home, dir, { waitMs: 0, holder: () => ({ reallyAlive: true, identityKnown: true }) });
  assert.strictEqual(second.ok, false, "a second launcher into the same candidate is refused, not admitted");
  // A DIFFERENT candidate is unaffected — isolated concurrent dispatches never contend.
  const other = await preflight.acquireWorkspace(home, path.join(home, "candidate-2"), { waitMs: 0 });
  assert.strictEqual(other.ok, true);
  preflight.releaseWorkspace(other.token);

  // A holder whose process is GONE contends with nobody — a dead launcher is
  // not launching — so the candidate self-heals at once rather than after a
  // horizon. Expiry governs only whether the dead file is also REAPED, which,
  // since every racer already ignores it, can neither grant nor revoke
  // ownership. An alive-but-expired holder is still ours to wait for.
  const gone = { reallyAlive: false, identityKnown: false };
  const dead = await preflight.acquireWorkspace(home, dir, { waitMs: 0, holder: () => gone });
  assert.strictEqual(dead.ok, true, "a holder that is gone blocks nobody");
  assert.strictEqual(
    fs.readdirSync(path.join(home, "journal", "workspace")).filter((f) => f.startsWith(preflight.workspaceLockPrefix(dir))).length,
    2,
    "...and, its identity being unverifiable, its file is left alone until it is ALSO expired"
  );
  preflight.releaseWorkspace(dead.token);
  const reaped = await preflight.acquireWorkspace(home, dir, { waitMs: 0, holder: () => gone, staleMs: -1 });
  assert.strictEqual(reaped.ok, true);
  assert.deepStrictEqual(
    fs.readdirSync(path.join(home, "journal", "workspace")).filter((f) => f.startsWith(preflight.workspaceLockPrefix(dir))),
    [path.basename(reaped.token.file)],
    "gone AND expired is reaped"
  );
  preflight.releaseWorkspace(reaped.token);
  // Re-take it so the ownership checks below have a live holder to contend with.
  const first2 = await preflight.acquireWorkspace(home, dir, { waitMs: 0 });
  assert.strictEqual(first2.ok, true);

  // Release destroys ONLY its own uniquely-named file, so a late or repeated
  // release can never take a successor's live claim.
  preflight.releaseWorkspace(first.token); // the original holder releasing late
  const successor = await preflight.acquireWorkspace(home, dir, { waitMs: 0, holder: () => gone });
  assert.strictEqual(successor.ok, true);
  preflight.releaseWorkspace(first.token); // ...and again, after a successor exists
  preflight.releaseWorkspace(first2.token);
  assert.ok(fs.existsSync(successor.token.file), "the successor's claim survived a foreign release");
  assert.strictEqual(
    (await preflight.acquireWorkspace(home, dir, { waitMs: 0, holder: () => ({ reallyAlive: true, identityKnown: true }) })).ok,
    false,
    "and still excludes a third contender"
  );
  preflight.releaseWorkspace(successor.token);

  // An unwritable journal loses the race tiebreak; it never stops a dispatch.
  const degraded = await preflight.acquireWorkspace(path.join(home, "nope", "\0bad"), dir, { waitMs: 0 });
  assert.strictEqual(degraded.ok, true);
  assert.strictEqual(degraded.token, null);
  assert.ok(degraded.degraded);
  fs.rmSync(home, { recursive: true, force: true });
});

test("a lock's TTL bounds only an UNVERIFIABLE holder — a verified live one keeps the candidate however long its setup hook runs", () => {
  // The claimed region includes `dispatch.worktreeSetup`, an operator's hook
  // with no bound of its own, so a live holder must not lose the candidate to
  // the clock: that would put a second writer in one checkout inside exactly
  // the window the guard exists for. Identity (the start-tick stamp in the
  // name) is what makes that safe — a RECYCLED pid, which answers a liveness
  // probe just as readily, is provably not the holder and is reaped at once.
  const stamp = (age) => `4242-99-${Date.now() - age}-abcdef01`;
  const DAY = 86400000;
  const verifiedLive = () => ({ reallyAlive: true, identityKnown: true });
  const recycled = () => ({ reallyAlive: false, identityKnown: true });
  const unverifiable = () => ({ reallyAlive: true, identityKnown: false });

  assert.deepStrictEqual(preflight.workspaceLockContends(stamp(DAY), { holder: verifiedLive }), { contends: true, prunable: false }, "verified live, a day old: still the holder");
  assert.deepStrictEqual(preflight.workspaceLockContends(stamp(0), { holder: recycled }), { contends: false, prunable: true }, "a recycled pid never blocks a worker that has no --force");
  assert.deepStrictEqual(preflight.workspaceLockContends(stamp(0), { holder: unverifiable }), { contends: true, prunable: false }, "unverifiable but fresh: honored");
  assert.deepStrictEqual(preflight.workspaceLockContends(stamp(DAY), { holder: unverifiable }), { contends: false, prunable: false }, "unverifiable and past the TTL: age is the only bound left");
  assert.deepStrictEqual(preflight.workspaceLockContends("not-one-of-ours"), { contends: false, prunable: false }, "a foreign file is never touched");
});

test("two CONCURRENT processes racing for one candidate: exactly one holds it", async () => {
  // The same-process test above cannot see the real hazard — a `wx` create is
  // open-then-write, so a cross-process racer can read a live lock as empty,
  // and a well-known lock pathname lets two contenders break one stale lock and
  // then delete each other's. Race real processes instead.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-preflight-race-"));
  const dir = path.join(home, "candidate");
  const script = path.join(home, "contend.js");
  fs.writeFileSync(
    script,
    `const preflight = require(${JSON.stringify(path.join(__dirname, "..", "lib", "shell", "preflight.js"))});
(async () => {
  const r = await preflight.acquireWorkspace(process.argv[2], process.argv[3], { waitMs: 0 });
  process.stdout.write(JSON.stringify({ ok: r.ok, held: !!r.token, degraded: r.degraded || null }));
  // Hold it: the point is whether BOTH believe they own it at the same moment.
  await new Promise((res) => setTimeout(res, 1500));
})();
`
  );
  const contend = () =>
    new Promise((resolve) => {
      let out = "";
      const c = spawn(process.execPath, [script, home, dir], { stdio: ["ignore", "pipe", "ignore"] });
      c.stdout.on("data", (d) => (out += d));
      c.on("close", () => resolve(JSON.parse(out || "{}")));
    });
  for (let attempt = 0; attempt < 5; attempt++) {
    const [a, b] = await Promise.all([contend(), contend()]);
    const holders = [a, b].filter((r) => r.held).length;
    assert.strictEqual(holders, 1, `exactly one contender may hold the candidate, saw ${JSON.stringify([a, b])}`);
    // A stale lock from the previous round must not let both in next time.
    for (const f of fs.readdirSync(path.join(home, "journal", "workspace"))) {
      fs.rmSync(path.join(home, "journal", "workspace", f), { force: true });
    }
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test("liveWorkspaceWriters keys a candidate by its real path, so two spellings of one checkout are one candidate", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-preflight-link-"));
  const real = path.join(home, "repo");
  fs.mkdirSync(real);
  const link = path.join(home, "repo-link");
  try {
    fs.symlinkSync(real, link, "dir");
  } catch {
    fs.rmSync(home, { recursive: true, force: true });
    return; // no symlink privilege (Windows without developer mode) — nothing to assert
  }
  const records = [{ run_id: "a", state: "running", cwd: real, runner_pid: 1, node_id: "task-a" }];
  const seen = preflight.liveWorkspaceWriters(records, { dir: link, watching: () => true });
  assert.deepStrictEqual(seen.map((w) => w.run_id), ["a"], "a writer reached through a symlinked spelling is still the same writer");
  fs.rmSync(home, { recursive: true, force: true });
});

test("describeTenant reports the selector that chose the tenant, and never the credential", () => {
  const t = preflight.describeTenant({ mode: () => "remote", tenant: () => ({ org: "acme", server: "https://api.example", token: "secret-token", source: "env-org" }), tenantError: () => null });
  assert.strictEqual(t.org, "acme");
  assert.strictEqual(t.provenance, "SPOR_ORG env");
  assert.strictEqual(t.token, true);
  const line = preflight.tenantLine(t);
  assert.match(line, /acme @ https:\/\/api\.example/);
  assert.match(line, /via SPOR_ORG env/);
  assert.match(line, /token present/);
  assert.doesNotMatch(line, /secret-token/, "a diagnostic reports a credential present/missing, never its value");
});

// -------------------------------------------------------------- CLI layer --

function bare(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("SPOR_") || k.startsWith("SUBSTRATE_") || k === "XDG_CONFIG_HOME") continue;
    env[k] = v;
  }
  env.SPOR_FAKE_AGENTS_JSON = "[]";
  env.PATH = pathWithOnlyGitAndNode();
  return Object.assign(env, extra);
}
function cli(args, env, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: bare(env), cwd });
}
function cliAsync(args, env, cwd) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const c = spawn(process.execPath, [CLI, ...args], { cwd, env: bare(env), stdio: ["ignore", "pipe", "pipe"] });
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

// A scratch graph home with ONE agent-ready task routed to a claude-code
// profile — the harness whose posture the pilot got wrong — plus a git repo the
// slug maps to and a `claude` stub that records every invocation.
function fixture({ repoSporJson = null, profileHarness = "claude-code", dispatchConfig = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-preflight-home-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-preflight-repo-"));
  const git = (...args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: bare() });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  fs.writeFileSync(path.join(repo, "README.md"), "demo\n");
  // A committed identity marker, so the checkout legitimately hosts the `demo`
  // slug the dispatch.repos map points at (otherwise the corrupt-mapping guard
  // refuses first and nothing under test is ever reached).
  fs.writeFileSync(path.join(repo, ".spor"), "project: demo\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  if (repoSporJson) fs.writeFileSync(path.join(repo, ".spor.json"), `${JSON.stringify(repoSporJson, null, 2)}\n`);

  const node = (id, front, body) => fs.writeFileSync(path.join(nodes, `${id}.md`), `---\nid: ${id}\n${front}date: 2026-09-05\n---\n${body}\n`);
  node(
    "task-ready",
    "type: task\nrepo: demo\ntitle: Add bounded retry to the sync worker\nsummary: Add bounded retry with backoff to the sync worker so transient failures never drop records.\nstatus: open\nreadiness: agent\nedges:\n  - {type: assigned, to: agent-prebox, profile: profile-pre}\n",
    "Add bounded retry to the sync worker."
  );
  node("agent-prebox", "type: agent\ntitle: The preflight test box\nsummary: An agent identity for the preflight test fixture.\n", "Test agent.");
  node("profile-pre", `type: profile\ntitle: Preflight test profile\nsummary: A profile selecting the harness the preflight fixture dispatches under.\nharness: ${profileHarness}\n`, "Test profile.");

  const claude = writeSpawnableNodeStub(home, "claude-preflight-stub", `
const fs = require("node:fs");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { prompt += c; });
process.stdin.on("end", () => {
  fs.appendFileSync(process.env.PREFLIGHT_OUTFILE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
  const w = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  w({ type: "system", subtype: "init", cwd: process.cwd(), session_id: "11111111-2222-3333-4444-555555555555" });
  w({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "fake report" }] }, session_id: "11111111-2222-3333-4444-555555555555" });
  w({ type: "result", subtype: "success", session_id: "11111111-2222-3333-4444-555555555555" });
  process.exit(0);
});
`);
  fs.writeFileSync(
    path.join(home, "config.json"),
    `${JSON.stringify({ dispatch: { repos: { demo: repo }, ...(dispatchConfig || {}) } }, null, 2)}\n`
  );
  return {
    home,
    repo,
    nodes,
    outfile: path.join(home, "invocations.jsonl"),
    env: { SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_CLAUDE_CMD: claude, PREFLIGHT_OUTFILE: path.join(home, "invocations.jsonl") },
  };
}

function runRecords(home) {
  const dir = path.join(home, "journal", "dispatch");
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".run.json"));
  } catch {
    return [];
  }
}

// A live, write-capable run record parked in `cwd` — what a concurrent writer
// looks like to the guard. `runner_pid` is THIS process, which is alive and
// whose start-ticks match, so it reads as a genuinely live supervised run.
function parkRunIn(home, cwd, extra = {}) {
  const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");
  const dir = path.join(home, "journal", "dispatch");
  fs.mkdirSync(dir, { recursive: true });
  const runId = `park-${Math.random().toString(16).slice(2, 10)}`;
  fs.writeFileSync(
    path.join(dir, `${runId}.run.json`),
    JSON.stringify({
      run_id: runId, node_id: "task-other", name: "task-other", harness: "claude-code",
      launch_mode: "supervised-jsonl", state: "running", cwd,
      runner_pid: process.pid, runner_started_ticks: dispatchRuns.processStartTicks(process.pid),
      created_at: new Date().toISOString(), ...extra,
    }, null, 2)
  );
  return runId;
}

test("the pilot's missing-posture case: an unattended worker refuses a claude-code item with no write posture — no claim, no launch", () => {
  const { home, env, outfile } = fixture();
  const r = cli(["work", "--once", "--max", "1", "--interval", "1", "--no-brief"], env);
  assert.strictEqual(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.match(r.stdout, /work: skipping task-ready — /);
  assert.match(r.stdout, /no write posture resolved/, "the refusal's own first line is the recorded reason");
  assert.ok(!fs.existsSync(outfile), "nothing was launched");
  assert.strictEqual(
    runRecords(home).length,
    0,
    "and no run was opened"
  );
});

test("...and the same item dispatches once the worker is given an unattended posture", async () => {
  const { env, outfile } = fixture();
  const r = await cliAsync(["work", "--once", "--max", "1", "--interval", "1", "--no-brief", "--permission-mode", "bypassPermissions"], env);
  assert.strictEqual(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.match(r.stdout, /work: dispatched task-ready/);
  assert.ok(await waitForFile(outfile), "the launch reached the stub");
  const invocations = fs.readFileSync(outfile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.strictEqual(invocations.length, 1);
  assert.ok(invocations[0].args.includes("bypassPermissions"), "the posture the operator declared is the one the child ran under");
});

test("an INTERACTIVE dispatch of the same item is never posture-refused — a person is the answer to the prompt", () => {
  const { env, outfile } = fixture();
  const r = cli(["dispatch", "--node", "task-ready", "--no-brief", "--print"], env);
  assert.strictEqual(r.status, 0, r.stderr);
  // --print says what an unattended worker WOULD do, without imposing it here.
  assert.match(r.stdout, /preflight: a worker dispatch here would REFUSE:/);
  assert.match(r.stdout, /posture — no write posture resolved/);
  assert.ok(!fs.existsSync(outfile), "--print launched nothing");
});

test("the pilot's shared-checkout case: a second writer into one candidate is refused, and --force still admits it", () => {
  const f = fixture();
  parkRunIn(f.home, f.repo);
  const r = cli(["dispatch", "--node", "task-ready", "--no-brief", "--permission-mode", "bypassPermissions"], f.env);
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(r.stderr, /already has 1 live writer\(s\) on this box/);
  assert.match(r.stderr, /dispatch\.worktree/, "and names the isolation that would make it safe");
  assert.ok(!fs.existsSync(f.outfile), "nothing was launched");

  const forced = cli(["dispatch", "--node", "task-ready", "--no-brief", "--permission-mode", "bypassPermissions", "--force", "--print"], f.env);
  assert.strictEqual(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /1 live writer\(s\)/, "--print still reports the occupancy it would override");
});

test("a READ-ONLY run (a review gate reading the implementer's checkout) is not a writer and blocks nothing", () => {
  const f = fixture();
  parkRunIn(f.home, f.repo, { read_only: true });
  const r = cli(["dispatch", "--node", "task-ready", "--no-brief", "--permission-mode", "bypassPermissions", "--print"], f.env);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /no live writers here/);
  assert.match(r.stdout, /preflight: ok/);
});

test("a READ-ONLY dispatch into an occupied checkout is not refused — a review gate must never be turned into a gate failure", () => {
  // The review gate dispatches `--read-only --no-worktree` into the
  // implementer's own checkout and passes no --force. gate-runner scores an
  // undispatchable review as a gate FAILURE, never a pass (WORKERS.md §10.4),
  // so an unrelated concurrent writer there must not refuse it.
  const f = fixture();
  parkRunIn(f.home, f.repo);
  const r = cli(["dispatch", "--node", "task-ready", "--no-brief", "--no-worktree", "--read-only", "--print"], f.env);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /posture: read-only/);
  assert.match(r.stdout, /preflight: ok/, "a reader is neither a writer nor blocked by one");
});

test("--force gets past the candidate CLAIM too, not just the occupancy check — a gate fix cycle must not be refused by a lock", async () => {
  // Both worker launches that pass --force (a gate fix cycle and a rescue) run
  // in the run's own checkout; refusing them at the acquisition arm would spend
  // a cycle from a bounded budget on a purely local contention.
  const f = fixture({ dispatchConfig: { workspaceLockWaitMs: 1 } });
  const lockDir = path.join(f.home, "journal", "workspace");
  fs.mkdirSync(lockDir, { recursive: true });
  // A live contender's claim on this candidate, in the real name shape.
  fs.writeFileSync(
    path.join(lockDir, `${preflight.workspaceLockPrefix(f.repo)}${process.pid}-0-${Date.now()}-abcdef01`),
    ""
  );
  // Unforced, that contention refuses — the lock arm, not the occupancy check
  // (nothing has launched yet, so there is no live writer to see).
  const plain = cli(["dispatch", "--node", "task-ready", "--no-brief", "--no-worktree", "--permission-mode", "bypassPermissions"], f.env);
  assert.strictEqual(plain.status, 1, plain.stdout);
  assert.match(plain.stderr, /another dispatch on this box is launching into/);
  assert.ok(!fs.existsSync(f.outfile), "and launches nothing");

  // Forced, the same contention degrades to "no tiebreak" and the launch proceeds.
  const started = Date.now();
  const forced = await cliAsync(
    ["dispatch", "--node", "task-ready", "--no-brief", "--no-worktree", "--permission-mode", "bypassPermissions", "--force"],
    f.env
  );
  assert.strictEqual(forced.status, 0, `${forced.stderr}\n${forced.stdout}`);
  assert.ok(Date.now() - started < 15000, "and it does not first stall out the lock wait");
  // The supervised harness child is a DETACHED grandchild, so a launch is
  // observed by waiting for the stub's marker rather than by reading it the
  // instant the CLI returns.
  assert.ok(await waitForFile(f.outfile), "the forced dispatch launched");
});

test("isolated concurrent candidates are safe: a live writer in the repo does not block a dispatch that gets its own worktree", () => {
  const f = fixture({ repoSporJson: { dispatch: { worktree: true } } });
  parkRunIn(f.home, f.repo);
  const r = cli(["dispatch", "--node", "task-ready", "--no-brief", "--permission-mode", "bypassPermissions", "--print"], f.env);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /workspace: .*worktrees.task-ready {2}\(isolated worktree\); no live writers here/);
  assert.match(r.stdout, /preflight: ok/);
});

test("worktreeSetup alone is NOT read as enabling dispatch.worktree — it is diagnosed, on --print and on a real run", async () => {
  const f = fixture({ repoSporJson: { dispatch: { worktreeSetup: "./setup.sh" } } });
  const printed = cli(["dispatch", "--node", "task-ready", "--no-brief", "--permission-mode", "bypassPermissions", "--print"], f.env);
  assert.strictEqual(printed.status, 0, printed.stderr);
  assert.match(printed.stdout, /SHARED checkout/, "the effective setting is still 'off' — a setup hook never turns isolation on");
  assert.match(printed.stdout, /dispatch\.worktreeSetup is declared but dispatch\.worktree is not/);

  const real = await cliAsync(["dispatch", "--node", "task-ready", "--no-brief", "--permission-mode", "bypassPermissions"], f.env);
  assert.strictEqual(real.status, 0, real.stderr);
  assert.match(real.stderr, /declares dispatch\.worktreeSetup but not dispatch\.worktree/);
  assert.ok(!fs.existsSync(path.join(f.repo, ".claude", "worktrees")), "and no worktree was created behind the operator's back");
});

test("cross-repo config: the TARGET repo's .spor.json decides isolation, not the launcher's cwd", () => {
  const f = fixture({ repoSporJson: { dispatch: { worktree: true } } });
  const launcher = fs.mkdtempSync(path.join(os.tmpdir(), "spor-preflight-launcher-"));
  fs.writeFileSync(path.join(launcher, ".spor.json"), `${JSON.stringify({ dispatch: { worktree: false } }, null, 2)}\n`);
  const r = cli(["dispatch", "--node", "task-ready", "--no-brief", "--permission-mode", "bypassPermissions", "--print"], f.env, launcher);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /isolated worktree/, "the target repo asked for isolation, and it is dispatched FROM a repo that did not");
  fs.rmSync(launcher, { recursive: true, force: true });
});

test("an unavailable profile refuses with the reason, and claims/launches nothing", () => {
  const f = fixture({ profileHarness: "no-such-harness" });
  const r = cli(["work", "--once", "--max", "1", "--interval", "1", "--no-brief", "--permission-mode", "bypassPermissions"], f.env);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /work: skipping task-ready — /);
  assert.ok(!fs.existsSync(f.outfile), "a profile this box cannot satisfy launches nothing");
});

test("--print diagnoses an unknown profile rather than printing a falsely-successful preflight", () => {
  const f = fixture();
  const r = cli(["dispatch", "--node", "task-ready", "--no-brief", "--profile", "profile-does-not-exist", "--print"], f.env);
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(r.stderr, /could not load profile profile-does-not-exist/);
  assert.doesNotMatch(r.stdout, /preflight: ok/);
});

test("--print is read-only: no claim, no child, no worktree, no config write, no credential", async () => {
  const f = fixture({ repoSporJson: { dispatch: { worktree: true } } });
  const claims = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      claims.push(`${req.method} ${req.url}`);
      const j = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
      if (req.method === "GET" && /^\/v1\/nodes\/task-ready$/.test(req.url)) {
        return j(200, { raw: fs.readFileSync(path.join(f.nodes, "task-ready.md"), "utf8") });
      }
      if (req.method === "GET" && /^\/v1\/nodes\/profile-pre$/.test(req.url)) {
        return j(200, { raw: fs.readFileSync(path.join(f.nodes, "profile-pre.md"), "utf8") });
      }
      return j(404, { error: { code: "not_found" } });
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const configBefore = fs.readFileSync(path.join(f.home, "config.json"), "utf8");
  const r = await cliAsync(
    ["dispatch", "--node", "task-ready", "--no-brief", "--permission-mode", "bypassPermissions", "--print"],
    { ...f.env, SPOR_SERVER: base, SPOR_TOKEN: "sekrit-token-value", SPOR_ALLOW_PERSON_TOKEN: "1" }
  );
  srv.close();
  assert.strictEqual(r.status, 0, r.stderr);
  // No org claim to read off an opaque test token, so the tenant is named by
  // its server; the SELECTOR that chose it is the point of the line.
  assert.match(r.stdout, /^tenant: http:\/\/127\.0\.0\.1:\d+ {2}\(via SPOR_SERVER env; token present\)$/m);
  assert.doesNotMatch(r.stdout, /sekrit-token-value/, "a preview never emits a credential");
  assert.ok(!claims.some((c) => /\/claim$/.test(c)), `no claim was made: ${claims.join(", ")}`);
  assert.ok(!fs.existsSync(f.outfile), "no child was launched");
  assert.ok(!fs.existsSync(path.join(f.repo, ".claude", "worktrees")), "no worktree was materialized");
  assert.strictEqual(
    runRecords(f.home).length,
    0,
    "no run record was opened"
  );
  assert.strictEqual(fs.readFileSync(path.join(f.home, "config.json"), "utf8"), configBefore, "and the capability probe wrote nothing back to config");
});

test("spor work --print reports the tenant, the posture it will pass, and the workspace isolation per in-scope repo", () => {
  const f = fixture({ repoSporJson: { dispatch: { worktreeSetup: "./setup.sh" } } });
  const r = cli(["work", "--print"], f.env);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^tenant: {2}local mode/m);
  assert.match(r.stdout, /^posture: \(none passed\) — unattended on .*a claude-code.* would be REFUSED before its claim/m);
  assert.match(r.stdout, /^workspace: demo -> .*SHARED checkout \(dispatch\.worktree off\)/m);
  assert.match(r.stdout, /dispatch\.worktreeSetup is declared but does NOT enable isolation/);

  const armed = cli(["work", "--print", "--permission-mode", "bypassPermissions"], f.env);
  assert.match(armed.stdout, /^posture: --permission-mode bypassPermissions — unattended on/m);
  assert.doesNotMatch(armed.stdout, /would be REFUSED before its claim/);
});

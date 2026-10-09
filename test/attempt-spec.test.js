"use strict";
// The attempt spec is DERIVED, never hand-written
// (task-spor-work-derive-attempt-spec-on-dispatch, PROVIDERS.md §4):
//   1. lib/kernel/attempt-spec.js derives every axis from the profile, the
//      pinned factory, the item and the request — one test per axis;
//   2. the dispatch plan -> attempt inputs door (lib/shell/dispatch.js) and
//      deriveDispatchAttempt pin the checkout and feed the same derivation;
//   3. a real `spor dispatch` whose attempt the chosen provider does not offer
//      is REFUSED before any worktree, run record or lease exists, naming the
//      axis (the golden for the accepted path is
//      test/dispatch-local-provider.test.js).
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const spec = require("../lib/kernel/attempt-spec.js");
const pc = require("../lib/kernel/provider-contract.js");
const sat = require("../lib/kernel/satisfiability.js");
const dispatchLib = require("../lib/shell/dispatch.js");
const local = require("../lib/shell/providers/local.js");
const mcpConfig = require("../lib/shell/mcp-config.js");
const { gitEnv } = require("./helpers/git.js");
const { hermeticEnv } = require("./helpers/env.js");
const { writeSpawnableNodeStub } = require("./helpers/portable");

const ROOT = path.join(__dirname, "..");
const CLI = path.join(ROOT, "bin", "spor.js");
const NOW = Date.parse("2026-10-09T10:00:00Z");
const SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function base(over = {}) {
  return {
    nodeId: "task-acme-rate-limit",
    harness: "claude-code",
    repos: [{ slug: "acme-api", commit: SHA, branch: "spor/task-acme-rate-limit", url: "https://github.com/acme/acme-api.git" }],
    server: "https://api.sporhq.io",
    now: NOW,
    defaultRunMaxMs: 86400000,
    ...over,
  };
}

const EXECUTION = { attempt_id: "wrk-a1b2:4211", execution_id: "exec-3f9c0a1b2c3d4e5f", fence: 3, tenant: "acme" };

// ------------------------------------------------------------- per axis

test("harness and model: the adapter the dispatcher resolved, the effective model when there is one", () => {
  assert.deepEqual(spec.deriveAttemptSpec(base()).harness, { id: "claude-code" });
  assert.equal(spec.deriveAttemptSpec(base()).model, undefined);
  assert.equal(spec.deriveAttemptSpec(base({ model: "claude-opus-5-5" })).model, "claude-opus-5-5");
});

test("profile: its id rides for the provider's deny list; its mcp/skills/plugins become the axes, deduplicated", () => {
  const s = spec.deriveAttemptSpec(base({ profile: { id: "profile-impl", mcp: ["spor", "spor", "linear"], skills: ["brief"], plugins: ["spor@spor"] } }));
  assert.equal(s.profile, "profile-impl");
  assert.deepEqual(s.mcp, ["spor", "linear"]);
  assert.deepEqual(s.skills, ["brief"]);
  assert.deepEqual(s.plugins, ["spor@spor"]);
  const bare = spec.deriveAttemptSpec(base());
  assert.equal(bare.profile, undefined);
  assert.deepEqual([bare.mcp, bare.skills, bare.plugins], [[], [], []]);
});

test("mcp: an agent identity that wires the Spor MCP names it on the axis even when the profile does not", () => {
  assert.deepEqual(spec.deriveAttemptSpec(base({ sporMcp: true })).mcp, ["spor"]);
  assert.deepEqual(spec.deriveAttemptSpec(base({ sporMcp: true, profile: { mcp: ["linear"] } })).mcp, ["linear", "spor"]);
});

test("tools: git always (an attempt commits its candidate), plus what the request asks for", () => {
  assert.deepEqual(spec.deriveAttemptSpec(base()).tools, ["git"]);
  assert.deepEqual(spec.deriveAttemptSpec(base({ request: { tools: ["npm", "git", "gh"] } })).tools, ["git", "npm", "gh"]);
});

test("repos: pinned at the commit, the branch the attempt commits to, and the portable url; an unreadable pin is left out", () => {
  assert.deepEqual(spec.deriveAttemptSpec(base()).repos, base().repos);
  assert.deepEqual(spec.deriveAttemptSpec(base({ repos: [{ slug: "scratch", commit: null, branch: null, url: null }] })).repos, [{ slug: "scratch" }]);
});

test("egress and secrets: the request's allow list; secrets is empty because no source names one", () => {
  const s = spec.deriveAttemptSpec(base({ request: { egress: ["api.anthropic.com", "github.com"] } }));
  assert.deepEqual(s.egress, { allow: ["api.anthropic.com", "github.com"] });
  assert.deepEqual(spec.deriveAttemptSpec(base()).egress, { allow: [] });
  assert.deepEqual(s.secrets, []);
});

test("isolation: worktree unless the request names one", () => {
  assert.equal(spec.deriveAttemptSpec(base()).isolation, "worktree");
  assert.equal(spec.deriveAttemptSpec(base({ request: { isolation: "vm" } })).isolation, "vm");
});

test("deadline: the request's, else the pinned factory's implementation budget, else the worker's ceiling", () => {
  const factory = { implementation: { budget: { runMaxMs: 2 * 3600 * 1000 } } };
  assert.equal(spec.deriveAttemptSpec(base()).deadline, "2026-10-10T10:00:00Z");
  assert.equal(spec.deriveAttemptSpec(base({ factory })).deadline, "2026-10-09T12:00:00Z");
  assert.equal(spec.deriveAttemptSpec(base({ factory, request: { deadlineMs: 30 * 60 * 1000 } })).deadline, "2026-10-09T10:30:00Z");
  // A factory that inherits the ceiling (null budget) leaves the worker's.
  assert.equal(spec.deriveAttemptSpec(base({ factory: { implementation: { budget: { runMaxMs: null } } } })).deadline, "2026-10-10T10:00:00Z");
});

test("spor + identity: the graph by reference; binding the execution adds the identity and the attempt token's reference", () => {
  const unbound = spec.deriveAttemptSpec(base());
  assert.deepEqual(unbound.spor, { server: "https://api.sporhq.io" });
  assert.equal(unbound.execution_id, undefined);
  const bound = spec.bindExecution(unbound, EXECUTION);
  assert.deepEqual(Object.keys(bound).slice(0, 6), ["contract_version", "attempt_id", "execution_id", "fence", "tenant", "node_id"]);
  assert.equal(bound.spor.token_ref, "spor-attempt-token://exec-3f9c0a1b2c3d4e5f/3");
  assert.equal(bound.prompt_bundle_ref, "spor-bundle://prompt/");
  // An adopted spec keeps the SUBMITTING instance's identity.
  assert.equal(spec.bindExecution(bound, { ...EXECUTION, attempt_id: "other", fence: 9 }), bound);
});

test("the bound spec validates against the contract schema; an unbound one is checked without its identity", () => {
  const bound = spec.deriveAttemptSpec(base({ execution: EXECUTION, profile: { id: "profile-impl", mcp: ["spor"] }, model: "claude-opus-5-5" }));
  assert.deepEqual(spec.attemptSpecErrors(bound), []);
  assert.ok(pc.validate("attempt-spec", bound).ok);
  assert.deepEqual(spec.attemptSpecErrors(spec.deriveAttemptSpec(base())), []);
  // A pin that is not a full object name is an error either way.
  const bad = spec.deriveAttemptSpec(base({ repos: [{ slug: "acme-api", commit: "abc", branch: "b" }] }));
  assert.match(spec.attemptSpecErrors(bad).join("; "), /repos\[0\]\.commit/);
  assert.match(spec.attemptSpecErrors(spec.bindExecution(spec.deriveAttemptSpec(base({ repos: [{ slug: "acme-api" }] })), EXECUTION)).join("; "), /repos\[0\]\.commit: is required/);
});

test("the derived spec matches a provider offering it, and each unoffered axis refuses by name", () => {
  const s = spec.deriveAttemptSpec(base({ profile: { id: "profile-impl", mcp: ["spor"] } }));
  const caps = { harnesses: ["claude-code"], reachable_mcp: ["spor"], tools: ["git"], repos: ["*"], egress: ["*"], isolation: ["worktree"], lifecycle: ["cancel"] };
  assert.deepEqual(sat.satisfiesAttempt(caps, s), { ok: true, reasons: [], axes: [] });
  assert.deepEqual(sat.satisfiesAttempt({ ...caps, isolation: ["container"] }, s).axes, ["isolation"]);
  assert.deepEqual(sat.satisfiesAttempt({ ...caps, reachable_mcp: [] }, s).axes, ["reachable_mcp"]);
  assert.deepEqual(sat.satisfiesAttempt({ ...caps, deny: ["profile-impl"] }, s).axes, ["deny"]);
});

// ------------------------------------------------- the dispatch plan door

function gitRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const g = (args) => {
    const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...gitEnv(), GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  g(["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(dir, "f.txt"), "x\n");
  g(["add", "f.txt"]);
  g(["commit", "-q", "-m", "root"]);
  return { dir: fs.realpathSync(dir), g };
}

function fakeCfg({ mode = "local", nodes = "/tmp/spor-nodes", caps = {}, repos = {}, home = os.tmpdir() } = {}) {
  const values = { "dispatch.capabilities": caps, "dispatch.repos": repos };
  return {
    mode: () => mode,
    nodesDir: () => nodes,
    userConfigHome: () => home,
    get: (k, d) => (k in values ? values[k] : d),
    getNum: (k, d) => d,
    server: () => "https://spor.example",
    token: () => "",
  };
}

test("pinCheckout pins HEAD, the checked-out branch and a credential-free origin; a plain directory pins nothing", () => {
  const { dir, g } = gitRepo("spor-attspec-pin-");
  g(["remote", "add", "origin", "https://x-access-token:ghs_secret@github.com/acme/acme-api.git"]);
  const pin = dispatchLib.pinCheckout(dir);
  assert.equal(pin.commit, g(["rev-parse", "HEAD"]));
  assert.equal(pin.branch, "main");
  assert.equal(pin.url, "https://github.com/acme/acme-api.git");
  assert.equal(pin.credentialed, true);
  assert.equal(dispatchLib.pinCheckout(dir, { branch: "spor/x" }).branch, "spor/x");
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "spor-attspec-plain-"));
  assert.deepEqual(dispatchLib.pinCheckout(plain), { commit: null, branch: null, url: null, credentialed: false });
});

test("attemptInputs + deriveDispatchAttempt: a plan's profile, identity and worktree become the spec's axes", () => {
  const { dir, g } = gitRepo("spor-attspec-plan-");
  const host = Object.fromEntries(dispatchLib.HOST_FUNCTIONS.map((k) => [k, () => null]));
  host.worktreeName = (n) => `spor/dispatch-${n}`;
  const d = dispatchLib.createDispatcher(host);
  const plan = {
    nodeId: "task-x", name: "run-1", harness: "claude-code", harnessAdapter: { id: "claude-code" }, effectiveModel: "claude-opus-5-5",
    profileCheck: { id: "profile-impl", probed: { harnesses: ["claude-code"] } },
    profileRuntime: { mcp: ["linear"], skills: ["brief"], plugins: ["spor@spor"] }, identityAgent: "agent-x",
    res: { dir, slug: "acme-api" }, useWorktree: true, isolation: "worktree",
    permMode: "bypassPermissions", postureCheck: { ok: true }, prompt: "P", sessionNote: "S", brief: "B", instruction: "T",
  };
  const cfg = fakeCfg({ mode: "remote" });
  const inputs = d.attemptInputs(cfg, plan);
  assert.equal(inputs.sporMcp, true);
  assert.deepEqual(inputs.harnessSettings, { permission_mode: "bypassPermissions" });
  assert.deepEqual(inputs.parts, { session: "S", briefing: "B", task: "T" });
  const { spec: s } = dispatchLib.deriveDispatchAttempt(cfg, inputs, { now: NOW, factory: { implementation: { budget: { runMaxMs: 3600000 } } } });
  assert.deepEqual(s.repos, [{ slug: "acme-api", commit: g(["rev-parse", "HEAD"]), branch: "spor/dispatch-run-1" }]);
  assert.deepEqual(s.mcp, ["linear", "spor"]);
  assert.equal(s.profile, "profile-impl");
  assert.equal(s.model, "claude-opus-5-5");
  assert.equal(s.deadline, "2026-10-09T11:00:00Z");
  assert.deepEqual(s.spor, { server: "https://spor.example" });
  // In local mode the graph is the nodes dir by reference.
  assert.match(d.attemptInputs(fakeCfg(), plan).server, /^file:\/\//);
});

test("a checkout on a detached HEAD pins the dispatch's own branch, so the bound spec still validates", () => {
  const { dir, g } = gitRepo("spor-attspec-detached-");
  g(["checkout", "-q", "--detach"]);
  const host = Object.fromEntries(dispatchLib.HOST_FUNCTIONS.map((k) => [k, () => null]));
  host.worktreeName = (n) => `spor/dispatch-${n}`;
  const d = dispatchLib.createDispatcher(host);
  const plan = { nodeId: "task-x", name: "run-2", harness: "claude-code", harnessAdapter: { id: "claude-code" }, res: { dir, slug: "acme-api" }, useWorktree: false };
  const { spec: s } = dispatchLib.deriveDispatchAttempt(fakeCfg(), d.attemptInputs(fakeCfg(), plan), { now: NOW, execution: EXECUTION });
  assert.equal(s.repos[0].branch, "spor/dispatch-run-2");
  assert.deepEqual(spec.attemptSpecErrors(s), []);
});

test("gateAttempt: an attempt the work loop will SEND is schema-checked at the gate — a checkout git cannot pin is refused there", async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "spor-attspec-gate-"));
  const host = Object.fromEntries(dispatchLib.HOST_FUNCTIONS.map((k) => [k, () => null]));
  host.worktreeName = (n) => `spor/dispatch-${n}`;
  const d = dispatchLib.createDispatcher(host);
  const plan = { nodeId: "task-x", name: "run-3", harness: "claude-code", harnessAdapter: { id: "claude-code" }, res: { dir: plain, slug: "acme-api" }, useWorktree: false, provider: { id: "local" } };
  const cfg = fakeCfg();
  // gateAttempt runs at the top of executeDispatch, before the claim, the
  // token mint and every config write (the CLI refusal test below pins that
  // ordering end to end).
  const sent = await d.gateAttempt(cfg, plan, null, { submitAttempt: () => null });
  assert.equal(sent.invalid, true);
  assert.deepEqual(sent.refused, ["attempt spec: repos[0].commit: is required", "attempt spec: repos[0].branch: is required"]);
  // A person's own dispatch (no attempt driver) is match-only: the same plain
  // directory is matched on every other axis and accepted.
  assert.equal((await d.gateAttempt(cfg, plan, null, {})).refused, undefined);
});

test("the local provider's dispatch-time describe offers the harness it launches, the checkout it resolved and the Spor MCP in remote mode", () => {
  const cfg = fakeCfg();
  const plain = local.localProviderDescribe(cfg).capabilities;
  assert.ok(!plain.harnesses.includes("some-harness"));
  const facts = local.localProviderDescribe(cfg, { dispatchFacts: { harnesses: ["some-harness"], repos: ["acme-api"], sporReachable: true, probed: { skills: ["brief"] } } }).capabilities;
  assert.ok(facts.harnesses.includes("some-harness"));
  assert.ok(facts.repos.includes("acme-api"));
  assert.ok(facts.reachable_mcp.includes("spor"));
  assert.ok(facts.skills.includes("brief"));
  assert.deepEqual(facts.isolation, ["worktree"]);
});

test("mcp-config: the MCP axis decides what Spor wires — the Spor MCP with the token; other names are the environment's", () => {
  assert.deepEqual(mcpConfig.mcpConfigFor(["linear"], { server: "https://s", token: "t" }), { conf: null, wired: [], external: ["linear"] });
  const r = mcpConfig.mcpConfigFor(["spor", "linear"], { server: "https://s/", token: "t" });
  assert.deepEqual(r.wired, ["spor"]);
  assert.deepEqual(r.external, ["linear"]);
  assert.deepEqual(r.conf, { mcpServers: { spor: { type: "http", url: "https://s/mcp", headers: { Authorization: "Bearer t" } } } });
  assert.equal(mcpConfig.mcpConfigFor(["spor"], { server: "https://s", token: "" }).conf, null);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "spor-attspec-mcp-")), "m.json");
  mcpConfig.writeMcpConfigFile(file, r.conf);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => mcpConfig.writeMcpConfigFile(file, r.conf), /EEXIST/);
});

// ------------------------------------- refusal before any environment exists

test("spor dispatch refuses an attempt the provider does not offer — naming the axis — before any worktree, run or claim", () => {
  const { dir } = gitRepo("spor-attspec-refuse-repo-");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-attspec-refuse-home-"));
  fs.mkdirSync(path.join(home, "nodes"));
  const stub = writeSpawnableNodeStub(home, "claude-refuse", "process.exit(0)");
  const env = hermeticEnv({ SPOR_HOME: home, SPOR_CLAUDE_CMD: stub });
  env.XDG_CONFIG_HOME = home;
  const r = spawnSync(process.execPath, [CLI, "dispatch", "refusal before worktree", "--no-brief", "--worktree", "--name", "iso-run", "--isolation", "container", "--dir", dir], { encoding: "utf8", env, cwd: dir });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /the local execution provider cannot run this attempt/);
  assert.match(r.stderr, /isolation: 'container' is not offered \(this provider offers: worktree\)/);
  assert.match(r.stderr, /nothing was claimed, created or launched/);
  assert.ok(!fs.existsSync(path.join(dir, ".claude", "worktrees", "iso-run")), "no worktree was created");
  const runs = path.join(home, "journal", "dispatch");
  assert.ok(!fs.existsSync(runs) || !fs.readdirSync(runs).some((f) => f.endsWith(".run.json")), "no run was launched");
  // Not even the slug -> path registration a launching dispatch writes.
  const conf = fs.existsSync(path.join(home, "config.json")) ? JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")) : {};
  assert.equal(conf.dispatch && conf.dispatch.repos, undefined);
});

test("spor dispatch refuses an --isolation that is no isolation kind, before resolving anything", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-attspec-badiso-"));
  const env = hermeticEnv({ SPOR_HOME: home });
  env.XDG_CONFIG_HOME = home;
  const r = spawnSync(process.execPath, [CLI, "dispatch", "x y z", "--isolation", "sandbox", "--print"], { encoding: "utf8", env, cwd: home });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--isolation must be one of worktree, container, vm \(got 'sandbox'\)/);
});

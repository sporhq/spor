// Profile satisfiability — the pure matcher (lib/kernel/satisfiability.js), the
// machine-capability probe (util.probeCapabilities), and the `spor capabilities`
// CLI verb (task-spor-dispatch-capabilities-satisfiability,
// dec-spor-machine-profile-satisfiability). Everything runs against throwaway
// homes / a synthetic PATH — never the live graph or the dev's real ~/.claude.
require("./helpers/tmp-cleanup"); // scratch-home leak guard (issue-spor-test-mkdtemp-inode-exhaustion)
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const { hermeticEnv } = require("./helpers/env.js");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { writeFakePathBin } = require("./helpers/portable");

const sat = require(path.join(__dirname, "..", "lib", "kernel", "satisfiability.js"));
const u = require(path.join(__dirname, "..", "scripts", "engines", "util.js"));
const CLI = path.join(__dirname, "..", "bin", "spor.js");

// ---- the pure matcher ----------------------------------------------------

test("satisfies: harness present + skills/plugins ⊆ machine => ok", () => {
  const m = { harnesses: ["claude-code"], reachable_mcp: ["spor"], skills: ["brief"], plugins: ["spor"] };
  const p = { id: "profile-x", harness: "claude-code", mcp: ["spor"], skills: ["brief"], plugins: ["spor"] };
  const r = sat.satisfies(m, p);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.reasons, []);
});

test("satisfies: missing harness fails and names the binary", () => {
  const r = sat.satisfies({ harnesses: ["claude-code"] }, { id: "profile-c", harness: "codex" });
  assert.strictEqual(r.ok, false);
  assert.match(r.reasons.join("\n"), /harness 'codex' not available here \(codex not on PATH\)/);
});

test("satisfies: a missing MCP / skill / plugin each surfaces a reason", () => {
  const m = { harnesses: ["claude-code"], reachable_mcp: [], skills: [], plugins: [] };
  const p = { id: "profile-x", harness: "claude-code", mcp: ["mcp-prod"], skills: ["weed"], plugins: ["allium"] };
  const r = sat.satisfies(m, p);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reasons.length, 3);
  assert.match(r.reasons.join("\n"), /MCP server\(s\) not available here: mcp-prod/);
  assert.match(r.reasons.join("\n"), /skill\(s\) not available here: weed/);
  assert.match(r.reasons.join("\n"), /plugin\(s\) not available here: allium/);
});

test("satisfies: a denied profile is refused even when fully capable", () => {
  const m = { harnesses: ["claude-code"], deny: ["profile-prod-deploy"] };
  const r = sat.satisfies(m, { id: "profile-prod-deploy", harness: "claude-code" });
  assert.strictEqual(r.ok, false);
  assert.match(r.reasons[0], /deny list \(policy opt-out\)/);
});

test("satisfies: a profile with no runtime needs is trivially satisfiable", () => {
  assert.strictEqual(sat.satisfies({}, { id: "profile-empty" }).ok, true);
  assert.strictEqual(sat.satisfies({ harnesses: [] }, {}).ok, true);
});

test("graphLaunchFields: presence, not truthiness — '', 0, false are declared; null/undefined are absent", () => {
  // issue-spor-satisfiability-graph-launch-fields-exempts-empty-string: a
  // falsy-but-present launch field must be refused, since the rule is that
  // naming the key at all is what's forbidden.
  for (const falsy of ["", 0, false]) {
    assert.deepStrictEqual(
      sat.graphLaunchFields({ command: falsy }),
      ["command"],
      `command: ${JSON.stringify(falsy)} must count as present`
    );
  }
  assert.deepStrictEqual(sat.graphLaunchFields({ command: null }), [], "null stays absent");
  assert.deepStrictEqual(sat.graphLaunchFields({ command: undefined }), [], "undefined stays absent");
  assert.deepStrictEqual(sat.graphLaunchFields({}), [], "a missing key stays absent");
});

test("effectiveCapabilities: declared AUGMENTS probed; deny is union of top-level + declared", () => {
  const eff = sat.effectiveCapabilities({
    probed: { harnesses: ["claude-code"], plugins: ["spor"] },
    declared: { harnesses: ["codex"], reachable_mcp: ["mcp-prod"], deny: ["profile-a"] },
    plugins: ["extra-flat"], // a flat top-level axis (any cascade layer can set this)
    deny: ["profile-b"],
  });
  assert.deepStrictEqual(eff.harnesses, ["claude-code", "codex"]);
  assert.deepStrictEqual(eff.reachable_mcp, ["mcp-prod"]);
  assert.deepStrictEqual(eff.plugins, ["spor", "extra-flat"]);
  assert.deepStrictEqual(eff.deny.sort(), ["profile-a", "profile-b"]);
});

test("effectiveCapabilities: garbage / empty input yields empty axes, never throws", () => {
  for (const bad of [null, undefined, [], "x", 42]) {
    const eff = sat.effectiveCapabilities(bad);
    assert.deepStrictEqual(eff.harnesses, []);
    assert.deepStrictEqual(eff.deny, []);
  }
});

// task-spor-dispatch-adapter-follow-up-batch: HARNESS_BINARIES used to list
// gemini/cursor with no dispatch adapter behind them, so `spor capabilities`
// could report a harness satisfiable (the bare binary merely happened to be
// on PATH) that `spor dispatch` then refused outright (getHarness() === null).
// The two registries must name exactly the same harnesses.
test("HARNESS_BINARIES lists exactly the harnesses the dispatch adapter registry can launch", () => {
  const { harnesses } = require(path.join(__dirname, "..", "lib", "shell", "dispatch-harnesses.js"));
  const adapterIds = harnesses().map((a) => a.id).sort();
  assert.deepStrictEqual(Object.keys(sat.HARNESS_BINARIES).sort(), adapterIds);
  assert.deepStrictEqual(Object.keys(sat.HARNESS_BIN_ENV).sort(), adapterIds);
});

// ---- the probe (util.probeCapabilities) ----------------------------------

// Build a fake PATH dir with executable stub(s), and a fake HOME holding a
// claude installed_plugins.json. Restore process env after.
function withFakeMachine(fn, { harnessBins = ["claude"], plugins = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spor-cap-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  for (const b of harnessBins) {
    writeFakePathBin(bin, b);
  }
  const home = path.join(root, "home");
  const pluginsDir = path.join(home, ".claude", "plugins");
  fs.mkdirSync(pluginsDir, { recursive: true });
  if (plugins) {
    fs.writeFileSync(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
  }
  const graphHome = path.join(root, "graph");
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
  process.env.PATH = bin; // ONLY our stubs on PATH (deterministic)
  process.env.HOME = home;
  try {
    return fn({ root, graphHome });
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.HOME == null) delete process.env.HOME;
    else process.env.HOME = saved.HOME;
  }
}

test("probeCapabilities: detects harnesses on PATH and writes them to .probed", () => {
  withFakeMachine(({ graphHome }) => {
    const probed = u.probeCapabilities(graphHome);
    assert.deepStrictEqual(probed.harnesses, ["claude-code"]);
    const cfg = JSON.parse(fs.readFileSync(path.join(graphHome, "config.json"), "utf8"));
    assert.deepStrictEqual(cfg.dispatch.capabilities.probed.harnesses, ["claude-code"]);
  }, { harnessBins: ["claude"] });
});

test("probeCapabilities: reads installed plugins + their skills from the claude manifest", () => {
  withFakeMachine(({ root, graphHome }) => {
    // Give the spor plugin a skills/ dir so the probe enumerates it.
    const installPath = path.join(root, "home", ".claude", "plugins", "cache", "spor", "spor", "1.0.0");
    fs.mkdirSync(path.join(installPath, "skills", "brief"), { recursive: true });
    fs.mkdirSync(path.join(installPath, "skills", "next"), { recursive: true });
    // Re-write the manifest now that we know installPath.
    fs.writeFileSync(
      path.join(root, "home", ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "spor@spor": [{ scope: "user", installPath, version: "1.0.0" }] } })
    );
    const probed = u.probeCapabilities(graphHome);
    assert.deepStrictEqual(probed.plugins, ["spor"]);
    assert.ok(probed.skills.includes("brief"), "bare skill name");
    assert.ok(probed.skills.includes("spor:brief"), "namespaced skill name");
    assert.ok(probed.skills.includes("next"));
  }, { harnessBins: ["claude"], plugins: { "spor@spor": [{ installPath: "x" }] } });
});

test("probeCapabilities: refresh is WHOLESALE — an uninstalled harness drops out, declarations survive", () => {
  withFakeMachine(({ root, graphHome }) => {
    // First probe sees claude + codex.
    u.probeCapabilities(graphHome);
    // Declare an MCP (sticky) directly via the helper.
    u.editCapabilities(graphHome, (cap) => {
      cap.declared = { reachable_mcp: ["mcp-prod"] };
      return true;
    });
    // Now "uninstall" codex: remove its stub from the fake PATH dir.
    fs.rmSync(path.join(root, "bin", process.platform === "win32" ? "codex.cmd" : "codex"));
    const probed = u.probeCapabilities(graphHome);
    assert.deepStrictEqual(probed.harnesses, ["claude-code"], "codex dropped from probe");
    const cfg = JSON.parse(fs.readFileSync(path.join(graphHome, "config.json"), "utf8"));
    assert.deepStrictEqual(cfg.dispatch.capabilities.probed.harnesses, ["claude-code"]);
    assert.deepStrictEqual(cfg.dispatch.capabilities.declared.reachable_mcp, ["mcp-prod"], "declaration survived the refresh");
  }, { harnessBins: ["claude", "codex"] });
});

test("probeCapabilities: seeds reachable_mcp:[spor] from CONFIGURED-ness when a server is bound, satisfying an mcp:[spor] profile", () => {
  withFakeMachine(({ graphHome }) => {
    const probed = u.probeCapabilities(graphHome, { sporReachable: true });
    assert.deepStrictEqual(probed.reachable_mcp, ["spor"], "spor seeded into the probed map");
    const cap = JSON.parse(fs.readFileSync(path.join(graphHome, "config.json"), "utf8")).dispatch.capabilities;
    assert.deepStrictEqual(cap.probed.reachable_mcp, ["spor"], "rides .probed, not .declared");
    // It flows through the matcher: a fresh box now satisfies an mcp:[spor] profile.
    const eff = sat.effectiveCapabilities(cap);
    assert.ok(sat.satisfies(eff, { id: "profile-x", harness: "claude-code", mcp: ["spor"] }).ok, "mcp:[spor] profile satisfies with no manual allow-mcp");
  }, { harnessBins: ["claude"] });
});

test("probeCapabilities: no seed without a server (byte-identical .probed); the seed drops out on refresh, a declared mcp survives", () => {
  withFakeMachine(({ graphHome }) => {
    // No server bound → no reachable_mcp key probed (unchanged shape).
    const off = u.probeCapabilities(graphHome);
    assert.ok(!("reachable_mcp" in off), "no reachable_mcp probed when no server is configured");
    // Bind a server → seed appears; also declare a VPN-only MCP (sticky).
    u.probeCapabilities(graphHome, { sporReachable: true });
    u.editCapabilities(graphHome, (cap) => {
      cap.declared = { reachable_mcp: ["mcp-prod"] };
      return true;
    });
    let cap = JSON.parse(fs.readFileSync(path.join(graphHome, "config.json"), "utf8")).dispatch.capabilities;
    assert.deepStrictEqual(sat.effectiveCapabilities(cap).reachable_mcp, ["spor", "mcp-prod"], "seeded + declared union");
    // Unconfigure the server → the seed drops out of .probed (no upward drift),
    // but the declared MCP survives the wholesale refresh.
    const back = u.probeCapabilities(graphHome, { sporReachable: false });
    assert.ok(!("reachable_mcp" in back), "spor seed dropped when the server went away");
    cap = JSON.parse(fs.readFileSync(path.join(graphHome, "config.json"), "utf8")).dispatch.capabilities;
    assert.deepStrictEqual(cap.declared.reachable_mcp, ["mcp-prod"], "declaration survived");
    assert.deepStrictEqual(sat.effectiveCapabilities(cap).reachable_mcp, ["mcp-prod"], "only the declared MCP remains reachable");
  }, { harnessBins: ["claude"] });
});

// ---- the `spor capabilities` CLI verb ------------------------------------

const ISO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "spor-cap-iso-"));
function caps(args, home) {
  const env = hermeticEnv();
  env.SPOR_HOME = home;
  env.XDG_CONFIG_HOME = ISO_HOME;
  return spawnSync(process.execPath, [CLI, "capabilities", ...args], { encoding: "utf8", env });
}

test("spor capabilities: set/add/rm an axis, allow-mcp, deny — round-trip through config.json", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-cap-home-"));
  const cfgFile = path.join(home, "config.json");

  assert.strictEqual(caps(["set", "skills", "brief", "next"], home).status, 0);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(cfgFile, "utf8")).dispatch.capabilities.declared.skills, ["brief", "next"]);

  caps(["add", "skills", "weed"], home);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(cfgFile, "utf8")).dispatch.capabilities.declared.skills, ["brief", "next", "weed"]);

  caps(["rm", "skills", "next"], home);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(cfgFile, "utf8")).dispatch.capabilities.declared.skills, ["brief", "weed"]);

  caps(["allow-mcp", "spor", "mcp-prod"], home);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(cfgFile, "utf8")).dispatch.capabilities.declared.reachable_mcp, ["spor", "mcp-prod"]);

  caps(["deny", "profile-prod-deploy"], home);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(cfgFile, "utf8")).dispatch.capabilities.deny, ["profile-prod-deploy"]);

  // list --json reflects the effective union.
  const json = JSON.parse(caps(["list", "--json"], home).stdout);
  assert.deepStrictEqual(json.skills, ["brief", "weed"]);
  assert.deepStrictEqual(json.reachable_mcp, ["spor", "mcp-prod"]);
  assert.deepStrictEqual(json.deny, ["profile-prod-deploy"]);
});

test("spor capabilities probe: SPOR_SERVER set seeds reachable_mcp:[spor]; unset leaves it absent", () => {
  const baseEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("SPOR_") || k.startsWith("SUBSTRATE_") || k === "XDG_CONFIG_HOME") continue;
    baseEnv[k] = v;
  }
  const probe = (home, server) => {
    const env = { ...baseEnv, SPOR_HOME: home, XDG_CONFIG_HOME: ISO_HOME };
    if (server) env.SPOR_SERVER = server;
    return spawnSync(process.execPath, [CLI, "capabilities", "probe"], { encoding: "utf8", env });
  };

  const on = fs.mkdtempSync(path.join(os.tmpdir(), "spor-cap-srv-"));
  const r = probe(on, "http://127.0.0.1:8787");
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /probed reachable_mcp: spor/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(on, "config.json"), "utf8")).dispatch.capabilities.probed.reachable_mcp, ["spor"]);

  const off = fs.mkdtempSync(path.join(os.tmpdir(), "spor-cap-srv-"));
  const r2 = probe(off, null);
  assert.strictEqual(r2.status, 0);
  assert.doesNotMatch(r2.stdout, /reachable_mcp/);
  assert.ok(!("reachable_mcp" in JSON.parse(fs.readFileSync(path.join(off, "config.json"), "utf8")).dispatch.capabilities.probed));
});

test("spor capabilities: an unknown axis is rejected with usage", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-cap-home-"));
  const r = caps(["set", "bogus", "x"], home);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /usage: spor capabilities set <harnesses\|reachable_mcp\|skills\|plugins>/);
});

test("spor capabilities clear: resets declarations + probe cache", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-cap-home-"));
  caps(["allow-mcp", "spor"], home);
  caps(["deny", "profile-x"], home);
  assert.strictEqual(caps(["clear"], home).status, 0);
  const cap = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")).dispatch.capabilities;
  assert.deepStrictEqual(cap, {}, "capabilities object emptied");
});

// ---- attempt satisfiability: a provider's describe() vs an attempt spec ---
// (task-spor-execution-provider-capability-vocabulary, PROVIDERS.md §3-§4)

const pc = require(path.join(__dirname, "..", "lib", "kernel", "provider-contract.js"));
const NOW = Date.parse("2026-10-09T10:00:00Z");

function providerCaps(over) {
  return {
    harnesses: ["claude-code", "codex"],
    reachable_mcp: ["spor"],
    skills: ["brief"],
    plugins: ["spor@spor"],
    tools: ["git", "node", "npm"],
    repos: ["acme-api"],
    egress: ["api.anthropic.com", "github.com"],
    isolation: ["container"],
    secret_delivery: ["file", "egress-inject"],
    lifecycle: ["cancel", "force-cancel", "suspend"],
    resources: { cpu: 4, memory_mb: 8192, disk_mb: 20480 },
    max_deadline_ms: 6 * 3600 * 1000,
    ...over,
  };
}
function attempt(over) {
  return {
    contract_version: 1,
    attempt_id: "wrk-a1b2:4211:1696850000",
    execution_id: "exec-3f9c0a1b2c3d4e5f",
    fence: 3,
    tenant: "acme",
    node_id: "task-acme-rate-limit",
    profile: "profile-acme-impl",
    harness: { id: "claude-code" },
    mcp: ["spor"],
    skills: ["brief"],
    plugins: ["spor@spor"],
    tools: ["git", "node"],
    repos: [{ slug: "acme-api", commit: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", branch: "spor/task-acme-rate-limit" }],
    egress: { allow: ["github.com"] },
    secrets: [{ name: "GITHUB_TOKEN", ref: "vault://acme/ci/github-token" }],
    spor: { server: "https://api.sporhq.io", token_ref: "spor-attempt-token://exec-3f9c0a1b2c3d4e5f/3" },
    resources: { cpu: 2, memory_mb: 4096 },
    deadline: "2026-10-09T14:00:00Z",
    isolation: "container",
    prompt_bundle_ref: "https://bundles.acme.internal/p.tar",
    ...over,
  };
}

test("satisfiesAttempt: the test fixtures are contract-valid", () => {
  assert.deepStrictEqual(pc.validate("attempt-spec", attempt({ secret_delivery: ["egress-inject"], lifecycle: ["suspend"] })).errors, []);
  assert.deepStrictEqual(pc.validate("describe-result", { provider_id: "container", contract_version: 1, capabilities: providerCaps({ deny: ["profile-x"] }) }).errors, []);
});

test("satisfiesAttempt: a fully satisfiable attempt passes", () => {
  const r = sat.satisfiesAttempt(providerCaps(), attempt({ secret_delivery: ["egress-inject"], lifecycle: ["suspend"] }), { now: NOW });
  assert.deepStrictEqual(r, { ok: true, reasons: [], axes: [] });
  // A full describe-result is accepted as well as its bare capabilities.
  assert.ok(sat.satisfiesAttempt({ provider_id: "c", contract_version: 1, capabilities: providerCaps() }, attempt(), { now: NOW }).ok);
});

test("satisfiesAttempt: secret_delivery egress-inject against a provider declaring only env is refused, naming the axis", () => {
  const r = sat.satisfiesAttempt(providerCaps({ secret_delivery: ["env"] }), attempt({ secret_delivery: ["egress-inject"] }), { now: NOW });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.axes, ["secret_delivery"]);
  assert.match(r.reasons[0], /^secret_delivery: needs egress-inject; this provider delivers by: env$/);
  // ANY acceptable mode satisfies.
  assert.ok(sat.satisfiesAttempt(providerCaps({ secret_delivery: ["file"] }), attempt({ secret_delivery: ["egress-inject", "file"] }), { now: NOW }).ok);
  // Unstated: secrets need SOME mode; no secrets need none.
  assert.deepStrictEqual(sat.satisfiesAttempt(providerCaps({ secret_delivery: [] }), attempt(), { now: NOW }).axes, ["secret_delivery"]);
  assert.ok(sat.satisfiesAttempt(providerCaps({ secret_delivery: [] }), attempt({ secrets: [] }), { now: NOW }).ok);
});

test("satisfiesAttempt: isolation vm against the local provider is refused, and a stronger kind is never substituted", () => {
  const local = { harnesses: ["claude-code"], reachable_mcp: ["spor"], skills: ["brief"], plugins: ["spor@spor"], tools: ["git", "node"], repos: ["acme-api"], egress: ["*"], isolation: ["worktree"], secret_delivery: ["file"], lifecycle: ["cancel", "force-cancel"], resources: { cpu: 8, memory_mb: 16384 } };
  const r = sat.satisfiesAttempt(local, attempt({ isolation: "vm" }), { now: NOW });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.axes, ["isolation"]);
  assert.match(r.reasons[0], /^isolation: 'vm' is not offered \(this provider offers: worktree\)$/);
  // EXACT match: a vm provider does not take a container attempt.
  assert.deepStrictEqual(sat.satisfiesAttempt(providerCaps({ isolation: ["vm"] }), attempt(), { now: NOW }).axes, ["isolation"]);
});

test("satisfiesAttempt: deny still applies — first, regardless of capability", () => {
  const r = sat.satisfiesAttempt(providerCaps({ deny: ["profile-acme-impl"] }), attempt(), { now: NOW });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.axes, ["deny"]);
  assert.match(r.reasons[0], /^deny: profile profile-acme-impl is on this provider's deny list/);
});

test("satisfiesAttempt: every profile + environment axis names its own failure", () => {
  const r = sat.satisfiesAttempt(
    { isolation: ["container"], lifecycle: ["cancel"], resources: { cpu: 1 }, max_deadline_ms: 3600 * 1000 },
    attempt({ secret_delivery: ["file"], lifecycle: ["checkpoint"], resources: { cpu: 2, memory_mb: 1024 }, egress: { allow: ["github.com"] } }),
    { now: NOW }
  );
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.axes, ["harnesses", "reachable_mcp", "skills", "plugins", "tools", "repos", "egress", "secret_delivery", "resources", "lifecycle", "deadline"]);
  const text = r.reasons.join("\n");
  assert.match(text, /harnesses: harness 'claude-code' not offered/);
  assert.match(text, /tools: tool\(s\) on PATH not offered: git, node/);
  assert.match(text, /repos: cannot check out acme-api/);
  assert.match(text, /egress: host\(s\) not reachable: github.com/);
  assert.match(text, /resources: cpu >= 2 requested; this provider offers 1/);
  assert.match(text, /resources: memory_mb >= 1024 requested; this provider declares no memory_mb/);
  assert.match(text, /lifecycle: lifecycle operation\(s\) not offered: checkpoint/);
  assert.match(text, /deadline: 2026-10-09T14:00:00Z is past this provider's environment lifetime/);
});

test("satisfiesAttempt: repos and egress wildcards", () => {
  const withUrl = [{ slug: "other", commit: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", branch: "b", url: "https://github.com/acme/other.git" }];
  const noUrl = [{ slug: "other", commit: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", branch: "b" }];
  assert.ok(sat.satisfiesAttempt(providerCaps({ repos: ["*"] }), attempt({ repos: withUrl }), { now: NOW }).ok, "* clones any repo with a url");
  const r = sat.satisfiesAttempt(providerCaps({ repos: ["*"] }), attempt({ repos: noUrl }), { now: NOW });
  assert.deepStrictEqual(r.axes, ["repos"]);
  assert.match(r.reasons[0], /no url to clone from/);
  // egress: none is always satisfiable; unrestricted needs a "*" provider.
  assert.ok(sat.satisfiesAttempt(providerCaps({ egress: [] }), attempt({ egress: { allow: [] } }), { now: NOW }).ok);
  assert.match(sat.satisfiesAttempt(providerCaps(), attempt({ egress: { allow: ["*"] } }), { now: NOW }).reasons[0], /^egress: unrestricted egress not offered/);
  assert.ok(sat.satisfiesAttempt(providerCaps({ egress: ["*"] }), attempt({ egress: { allow: ["*", "x.example"] } }), { now: NOW }).ok);
});

test("satisfiesAttempt: secrets[] with an EXPLICITLY empty secret_delivery has no delivery path and is refused", () => {
  // Every mode the provider offers is beside the point: the attempt says none of them can serve it.
  const r = sat.satisfiesAttempt(providerCaps({ secret_delivery: ["file", "egress-inject"] }), attempt({ secret_delivery: [] }), { now: NOW });
  assert.deepStrictEqual(r.axes, ["secret_delivery"]);
  assert.match(r.reasons[0], /^secret_delivery: 1 secret\(s\) to deliver and the attempt names no delivery mode/);
  // With nothing to deliver, an empty list asks for nothing.
  assert.ok(sat.satisfiesAttempt(providerCaps({ secret_delivery: [] }), attempt({ secrets: [], secret_delivery: [] }), { now: NOW }).ok);
});

test("satisfiesAttempt: repo commit/branch pins are honoured, not matched by slug alone", () => {
  const caps = providerCaps({ repos: ["acme-api"] });
  const repo = (over) => [{ slug: "acme-api", commit: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", branch: "spor/x", ...over }];
  assert.ok(sat.satisfiesAttempt(caps, attempt({ repos: repo({}) }), { now: NOW }).ok);
  assert.ok(sat.satisfiesAttempt(caps, attempt({ repos: repo({ commit: "a".repeat(64) }) }), { now: NOW }).ok, "a sha-256 object name pins too");
  for (const commit of ["4b825dc", "HEAD", "main", "4B825DC642CB6EB9A060E54BF8D69288FBEE4904", 42]) {
    const r = sat.satisfiesAttempt(caps, attempt({ repos: repo({ commit }) }), { now: NOW });
    assert.deepStrictEqual(r.axes, ["repos"], `commit ${JSON.stringify(commit)} is not a pin`);
    assert.match(r.reasons[0], /^repos: acme-api pins commit .* not a full object name/);
  }
  for (const branch of ["", 7]) {
    const r = sat.satisfiesAttempt(caps, attempt({ repos: repo({ branch }) }), { now: NOW });
    assert.deepStrictEqual(r.axes, ["repos"]);
    assert.match(r.reasons[0], /^repos: acme-api pins a malformed branch/);
  }
  const twice = [...repo({}), ...repo({ commit: "b".repeat(40) })];
  const r = sat.satisfiesAttempt(caps, attempt({ repos: twice }), { now: NOW });
  assert.deepStrictEqual(r.axes, ["repos"]);
  assert.match(r.reasons[0], /^repos: acme-api is pinned twice to different commits\/branches/);
  // An unpinned entry (the matcher is also called on specs outside the contract validator) still matches on slug.
  assert.ok(sat.satisfiesAttempt(caps, attempt({ repos: [{ slug: "acme-api" }] }), { now: NOW }).ok);
});

test("satisfiesAttempt: a present-but-malformed attempt field refuses on its axis, never admits", () => {
  const caps2 = providerCaps({ isolation: ["worktree"] });
  const axesOf = (over) => sat.satisfiesAttempt(caps2, attempt({ isolation: "worktree", ...over }), { now: NOW }).axes;
  assert.deepStrictEqual(axesOf({ resources: { cpu: "64" } }), ["resources"]);
  assert.deepStrictEqual(axesOf({ isolation: ["vm"] }), ["isolation"]);
  assert.deepStrictEqual(axesOf({ isolation: undefined }), ["isolation"]);
  assert.deepStrictEqual(axesOf({ harness: { id: 5 } }), ["harnesses"]);
  assert.deepStrictEqual(axesOf({ deadline: "garbage" }), ["deadline"]);
  assert.deepStrictEqual(axesOf({ deadline: "2026" }), ["deadline"]);
  assert.deepStrictEqual(axesOf({ deadline: "2026-10-09T11:00:00" }), ["deadline"], "a zone-less time is not read in the host zone");
  assert.deepStrictEqual(axesOf({ deadline: "2026-10-09T13:00:00+02:00" }), []);
  assert.deepStrictEqual(axesOf({ tools: [5] }), ["tools"]);
  assert.deepStrictEqual(axesOf({ repos: "acme-api" }), ["repos"]);
  assert.deepStrictEqual(axesOf({ egress: ["github.com"] }), ["egress"]);
  assert.deepStrictEqual(axesOf({ secrets: "x" }), ["secret_delivery"]);
  assert.deepStrictEqual(axesOf({ profile: 7 }), ["deny"]);
  assert.deepStrictEqual(axesOf({}), [], "the well-formed baseline passes");
  assert.deepStrictEqual(sat.ATTEMPT_AXES, ["deny", "harnesses", "reachable_mcp", "skills", "plugins", "tools", "repos", "egress", "secret_delivery", "isolation", "resources", "lifecycle", "deadline"]);
});

test("satisfiesAttempt: satisfies() is untouched for the profile path", () => {
  assert.deepStrictEqual(sat.CAP_AXES, ["harnesses", "reachable_mcp", "skills", "plugins"]);
  assert.deepStrictEqual(sat.satisfies({ harnesses: ["claude-code"] }, { id: "p", harness: "claude-code" }), { ok: true, reasons: [], profile: "p" });
});

test("spor capabilities providers: the local describe() validates, and --attempt names the refusing axis", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-cap-home-"));
  caps(["set", "harnesses", "claude-code"], home);
  const list = caps(["providers", "--json"], home);
  assert.strictEqual(list.status, 0, list.stderr);
  const [local] = JSON.parse(list.stdout).providers;
  assert.strictEqual(local.provider_id, "local");
  assert.deepStrictEqual(pc.validate("describe-result", local).errors, []);
  assert.deepStrictEqual(local.capabilities.isolation, ["worktree"]);
  assert.ok(local.capabilities.resources.cpu >= 1 && local.capabilities.resources.memory_mb > 0);

  const spec = path.join(home, "attempt.json");
  fs.writeFileSync(spec, JSON.stringify(attempt({ isolation: "vm", secrets: [], mcp: [], skills: [], plugins: [], tools: [], egress: { allow: [] }, resources: undefined })));
  const r = caps(["providers", "--attempt", spec], home);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /attempt: +REFUSED \(repos, isolation\)/);
  assert.match(r.stdout, /- isolation: 'vm' is not offered \(this provider offers: worktree\)/);
  assert.match(r.stderr, /no configured provider can run this attempt/);

  fs.writeFileSync(spec, JSON.stringify({ not: "an attempt" }));
  const bad = caps(["providers", "--attempt", spec], home);
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /does not validate against the provider contract/);
});

test("spor capabilities providers --attempt never echoes a credential from a refused reference", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-cap-home-"));
  const spec = path.join(home, "attempt.json");
  const repos = [{ slug: "acme-api", commit: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", branch: "b", url: "https://ci-bot:hunter2-s3cr3t@github.com/acme/api.git" }];
  fs.writeFileSync(spec, JSON.stringify(attempt({ repos, prompt_bundle_ref: "ghp_bareTokenNotAReference0000000000" })));
  const r = caps(["providers", "--attempt", spec], home);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /repos\[0\]\.url: "https:\/\/<redacted>@github\.com\/acme\/api\.git" is not a reference/);
  assert.match(r.stderr, /prompt_bundle_ref: \(value withheld\) is not a reference/);
  assert.doesNotMatch(r.stdout + r.stderr, /hunter2|ci-bot|ghp_bareToken/);
});

test("the contract validator redacts refused references; stripReferenceUserinfo leaves a valid one alone", () => {
  const errs = pc.validate("attempt-spec", attempt({ prompt_bundle_ref: "https:///tok3n@bundles.example/p.tar" })).errors;
  assert.deepStrictEqual(errs, ['prompt_bundle_ref: "https:///<redacted>@bundles.example/p.tar" is not a reference — an absolute <scheme>://… URI with no credential (userinfo) in its authority']);
  assert.strictEqual(pc.stripReferenceUserinfo("https://user:tok@github.com/a.git"), "https://github.com/a.git");
  assert.strictEqual(pc.stripReferenceUserinfo("ssh://git@github.com/a.git"), "ssh://git@github.com/a.git", "a bare ssh login is an account, not a credential");
  assert.strictEqual(pc.stripReferenceUserinfo("ssh://ghp_abcdefghijklmnopqrstuvwxyz@github.com/a.git"), "ssh://github.com/a.git");
});

test("stripReferenceUserinfo fails CLOSED: a url it cannot prove credential-free is null, never passed through", () => {
  for (const v of [
    "https://user:tok @github.com/a.git", // whitespace hides the userinfo from the delimiter
    "https://user:tok@git hub.com/a.git", // still not a reference once stripped
    "user:ghp_abcdefghijklmnopqrstuvwxyz@github.com:o/r.git", // scp-style, no scheme
    "git@github.com:o/r.git", // scp-style, not a reference until normalized
    "ghp_abcdefghijklmnopqrstuvwxyz",
    "",
    null,
    42,
  ]) {
    assert.strictEqual(pc.stripReferenceUserinfo(v), null, JSON.stringify(v));
  }
  assert.strictEqual(pc.isCredentialFreeReference("https://github.com/a.git"), true);
  assert.strictEqual(pc.isCredentialFreeReference("https://tok@github.com/a.git"), false);
});

test("satisfiesAttempt: `*` repo admission refuses a credential-bearing url without quoting it", () => {
  const leak = "hunter2pass";
  for (const url of [`https://bob:${leak}@github.com/acme/other.git`, `https://bob:${leak} @github.com/acme/other.git`, `bob:${leak}@github.com:acme/other.git`]) {
    const repos = [{ slug: "other", commit: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", branch: "b", url }];
    const r = sat.satisfiesAttempt(providerCaps({ repos: ["*"] }), { ...attempt(), repos }, { now: NOW });
    assert.strictEqual(r.ok, false, url);
    assert.deepStrictEqual(r.axes, ["repos"], url);
    assert.match(r.reasons[0], /cannot check out other: its url is not a credential-free reference \(value withheld\)/);
    assert.ok(!r.reasons.join(" ").includes(leak), r.reasons.join("; "));
  }
  // A provider naming the slug outright checks it out by name: the url is not what admits it.
  const named = [{ slug: "acme-api", commit: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", branch: "b", url: "https://bob:x@github.com/acme/api.git" }];
  assert.ok(sat.satisfiesAttempt(providerCaps({ repos: ["acme-api", "*"] }), { ...attempt(), repos: named }, { now: NOW }).ok);
});

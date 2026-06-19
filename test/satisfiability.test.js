// Profile satisfiability — the pure matcher (lib/kernel/satisfiability.js), the
// machine-capability probe (util.probeCapabilities), and the `spor capabilities`
// CLI verb (task-spor-dispatch-capabilities-satisfiability,
// dec-spor-machine-profile-satisfiability). Everything runs against throwaway
// homes / a synthetic PATH — never the live graph or the dev's real ~/.claude.
require("./helpers/tmp-cleanup"); // scratch-home leak guard (issue-spor-test-mkdtemp-inode-exhaustion)
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

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

// ---- the probe (util.probeCapabilities) ----------------------------------

// Build a fake PATH dir with executable stub(s), and a fake HOME holding a
// claude installed_plugins.json. Restore process env after.
function withFakeMachine(fn, { harnessBins = ["claude"], plugins = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spor-cap-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  for (const b of harnessBins) {
    const f = path.join(bin, b);
    fs.writeFileSync(f, "#!/bin/sh\necho stub\n");
    fs.chmodSync(f, 0o755);
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

test("probeCapabilities: detects harnesses on PATH and writes them to .probed", { skip: process.platform === "win32" }, () => {
  withFakeMachine(({ graphHome }) => {
    const probed = u.probeCapabilities(graphHome);
    assert.deepStrictEqual(probed.harnesses, ["claude-code"]);
    const cfg = JSON.parse(fs.readFileSync(path.join(graphHome, "config.json"), "utf8"));
    assert.deepStrictEqual(cfg.dispatch.capabilities.probed.harnesses, ["claude-code"]);
  }, { harnessBins: ["claude"] });
});

test("probeCapabilities: reads installed plugins + their skills from the claude manifest", { skip: process.platform === "win32" }, () => {
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

test("probeCapabilities: refresh is WHOLESALE — an uninstalled harness drops out, declarations survive", { skip: process.platform === "win32" }, () => {
  withFakeMachine(({ root, graphHome }) => {
    // First probe sees claude + codex.
    u.probeCapabilities(graphHome);
    // Declare an MCP (sticky) directly via the helper.
    u.editCapabilities(graphHome, (cap) => {
      cap.declared = { reachable_mcp: ["mcp-prod"] };
      return true;
    });
    // Now "uninstall" codex: remove its stub from the fake PATH dir.
    fs.rmSync(path.join(root, "bin", "codex"));
    const probed = u.probeCapabilities(graphHome);
    assert.deepStrictEqual(probed.harnesses, ["claude-code"], "codex dropped from probe");
    const cfg = JSON.parse(fs.readFileSync(path.join(graphHome, "config.json"), "utf8"));
    assert.deepStrictEqual(cfg.dispatch.capabilities.probed.harnesses, ["claude-code"]);
    assert.deepStrictEqual(cfg.dispatch.capabilities.declared.reachable_mcp, ["mcp-prod"], "declaration survived the refresh");
  }, { harnessBins: ["claude", "codex"] });
});

test("probeCapabilities: seeds reachable_mcp:[spor] from CONFIGURED-ness when a server is bound, satisfying an mcp:[spor] profile", { skip: process.platform === "win32" }, () => {
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

test("probeCapabilities: no seed without a server (byte-identical .probed); the seed drops out on refresh, a declared mcp survives", { skip: process.platform === "win32" }, () => {
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
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("SPOR_") || k.startsWith("SUBSTRATE_") || k === "XDG_CONFIG_HOME") continue;
    env[k] = v;
  }
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

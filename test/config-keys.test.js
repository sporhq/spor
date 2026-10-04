// lib/config-keys.js — the typed key table, and what lib/config.js derives
// from it (task-spor-client-config-typed-key-table-and-explain): the env map,
// the known-namespace set, the repo-layer bans, nested-key/type warnings,
// Config.explain() / `spor config explain`, and the fail-closed tenant for the
// AMBIENT org selectors (issue-spor-ambient-org-selector-silent-fallback).
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const test = require("node:test");
const { scrubbedEnv } = require("./helpers/git.js");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const { KEYS, lookup } = require("../lib/config-keys.js");
const config = require("../lib/config.js");
const auth = require("../lib/auth.js");
const { hermeticEnv } = require("./helpers/env.js");

const CLI = path.join(ROOT, "bin", "spor.js");
const HOOK = path.join(ROOT, "bin", "spor-hook.js");

function tmp(p = "spor-keys-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}
function write(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
}
// A library-level load: scrubbed, but mode resolved (not pinned local) — mode
// is what these tests observe.
function load(home, { env = {}, cwd, cli } = {}) {
  const e = hermeticEnv({ SPOR_MODE: "auto", SPOR_HOME: home, XDG_CONFIG_HOME: home, ...env });
  return config.loadConfig({ cwd: cwd || home, env: e, cli });
}

// --- the table and what is derived from it ---------------------------------

test("table: every key is unique, typed, and an enum lists its choices", () => {
  const seen = new Set();
  for (const e of KEYS) {
    assert.ok(!seen.has(e.key), `duplicate key ${e.key}`);
    seen.add(e.key);
    assert.ok(["string", "number", "bool", "list", "map", "enum"].includes(e.type), `${e.key}: bad type ${e.type}`);
    if (e.type === "enum") assert.ok(Array.isArray(e.choices) && e.choices.includes(e.default), `${e.key}: enum default must be a choice`);
    if (e.applied) assert.notStrictEqual(e.default, undefined, `${e.key}: an applied key needs a default`);
    assert.ok(typeof e.doc === "string" && e.doc, `${e.key}: needs a doc line`);
  }
});

test("derived: ENV_MAP, KNOWN_KEYS and the repo bans come from the table", () => {
  assert.deepStrictEqual(config.ENV_MAP, KEYS.filter((e) => e.env).map((e) => [e.env, e.key]));
  for (const e of KEYS) assert.ok(config.KNOWN_KEYS.has(e.key.split(".")[0]));
  assert.deepStrictEqual(config.REPO_FORBIDDEN_KEYS, ["token"]);
  assert.deepStrictEqual(
    [...config.REPO_FORBIDDEN_PATHS].sort(),
    ["attestation.signingKey", "digest.intentCmd", "dispatch.allowPersonToken", "dispatch.bin", "dispatch.harness", "distill.cmd", "nudge.cmd"],
  );
  // The applied structural defaults are exactly the pre-table DEFAULTS literal.
  assert.deepStrictEqual(config.DEFAULTS, {
    mode: "auto",
    search: { projects: { include: [], exclude: [], boost: {} } },
    queue: { front: { enabled: true, days: 7 } },
  });
});

test("table: the work.* defaults mirror work-loop's WORK_DEFAULTS", () => {
  const { WORK_DEFAULTS } = require("../lib/shell/work-loop.js");
  for (const e of KEYS.filter((k) => k.key.startsWith("work.") && k.key.split(".")[1] in WORK_DEFAULTS)) {
    assert.deepStrictEqual(e.default, WORK_DEFAULTS[e.key.split(".")[1]], e.key);
  }
});

// Every LITERAL config read in the shipped tree must name a declared key, pass
// the table's default as its fallback literal, and (for the util cfg* readers)
// name the table's env spelling — so a key can no longer be honored in one
// place and unknown in another, and a default cannot drift between callers.
test("lint: every literal config read in the tree agrees with the table", () => {
  const walk = (d, acc = []) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, acc);
      else if (p.endsWith(".js")) acc.push(p);
    }
    return acc;
  };
  const files = ["bin", "lib", "scripts/engines", "adapters"].flatMap((d) => walk(path.join(ROOT, d)));
  const LIT = String.raw`("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null|undefined|\{\}|\[\])`;
  const reCfg = new RegExp(String.raw`\b(?:cfg|standingCfg|standing|targetStandingCfg|config\(\)|_config)\.(get|getBool|getNum|getList|getObj)\("([a-zA-Z][\w.]*)"(?:,\s*` + LIT + String.raw`)?\s*\)`, "g");
  const reU = new RegExp(String.raw`(?:\bu\.|[^.\w])(cfgStr|cfgNum|cfgBool|cfgObj)\("([a-zA-Z][\w.]*)"(?:,\s*"([A-Z_]+)")?(?:,\s*` + LIT + String.raw`)?\s*\)`, "g");
  const problems = [];
  let reads = 0;
  for (const f of files) {
    if (f === path.join(ROOT, "lib", "config.js")) continue;
    const s = fs.readFileSync(f, "utf8");
    const rel = path.relative(ROOT, f);
    for (const re of [reCfg, reU]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(s))) {
        reads++;
        const [, fn, key, a, b] = m;
        const e = lookup(key);
        if (!e) {
          problems.push(`${rel}: '${key}' is not declared in lib/config-keys.js`);
          continue;
        }
        const env = re === reU && fn !== "cfgObj" ? a : null;
        const lit = re === reCfg || fn === "cfgObj" ? a : b;
        if (env && e.env !== env) problems.push(`${rel}: '${key}' read with env ${env}, table says ${e.env}`);
        if (lit !== undefined && e.default !== undefined && e.key === key) {
          const v = lit === "undefined" ? undefined : JSON.parse(lit);
          if (JSON.stringify(v) !== JSON.stringify(e.default)) problems.push(`${rel}: '${key}' fallback ${lit} != table default ${JSON.stringify(e.default)}`);
        }
      }
    }
  }
  assert.deepStrictEqual(problems, []);
  assert.ok(reads > 60, `the lint must actually see the tree's config reads (saw ${reads})`);
});

// --- SPOR_MODE (it never existed before; the scratch-home recipe relied on it)

test("SPOR_MODE=local pins local mode even with a server configured (the scratch-home recipe)", () => {
  const home = tmp();
  write(path.join(home, "config.json"), { server: "https://live.example", token: "t" });
  assert.strictEqual(load(home).mode(), "remote");
  assert.strictEqual(load(home, { env: { SPOR_MODE: "local" } }).mode(), "local");
  assert.strictEqual(load(home, { env: { SPOR_MODE: "local", SPOR_SERVER: "https://env.example" } }).mode(), "local");
  assert.strictEqual(load(home, { env: { SPOR_MODE: undefined, SUBSTRATE_MODE: "off" } }).mode(), "off", "legacy dual-read");
});

// --- file-layer validation -------------------------------------------------

test("validation: a typo'd nested key and a mistyped value warn; map children and nulls do not", () => {
  const home = tmp();
  write(path.join(home, "config.json"), {
    nudge: { maxcalls: 5, timeoutMs: "soon" },
    dispatch: { repos: { "any-slug": "/x" }, harness: { mine: { command: "x" } }, worktree: null },
    mode: "remotely",
    work: "fast",
  });
  const w = load(home).warnings.join("\n");
  assert.match(w, /unknown config key 'nudge\.maxcalls' in .*config\.json ignored/);
  assert.match(w, /config key 'nudge\.timeoutMs' in .* should be a number, got "soon"/);
  assert.match(w, /config key 'mode' in .* should be one of auto\|local\|remote\|off/);
  assert.match(w, /config key 'work' in .* should be an object, got "fast"/);
  assert.doesNotMatch(w, /any-slug|mine|worktree/);
});

test("validation: a clean real-world config earns no warnings", () => {
  const home = tmp();
  const repo = tmp("spor-keys-repo-");
  write(path.join(home, "config.json"), { dispatch: { repos: { a: "/a" }, agent: "agent-x", capabilities: { probed: { gh: true } } } });
  write(path.join(repo, ".spor.json"), { enabled: true, dispatch: { worktree: true, worktreeSetup: "s.sh" } });
  assert.deepStrictEqual(load(home, { cwd: repo }).warnings, []);
});

// --- explain ------------------------------------------------------------------

test("explain: names the winning layer and what it shadows", () => {
  const root = tmp();
  const home = path.join(root, "home");
  const xdg = path.join(root, "xdg");
  const repo = path.join(root, "repo");
  write(path.join(xdg, "spor", "config.json"), { nudge: { maxCalls: 1 }, gc: { enabled: false } });
  write(path.join(home, "config.json"), { nudge: { maxCalls: 2 }, token: "user-secret" });
  write(path.join(repo, ".spor.json"), { nudge: { maxCalls: 3 }, enabled: true });
  const c = config.loadConfig({ cwd: repo, env: hermeticEnv({ SPOR_MODE: "auto", SPOR_HOME: home, XDG_CONFIG_HOME: xdg, SPOR_NUDGE_MAX: "4" }) });
  const row = (k) => c.explain(k).find((r) => r.key === k);
  const max = row("nudge.maxCalls");
  assert.strictEqual(max.value, "4");
  assert.deepStrictEqual([max.source, max.origin], ["env", "SPOR_NUDGE_MAX"]);
  assert.deepStrictEqual(max.shadowed.map((s) => s.source), ["repo", "user", "global"]);
  assert.deepStrictEqual([row("gc.enabled").source, row("gc.enabled").value], ["global", false]);
  assert.deepStrictEqual([row("enabled").source, row("enabled").origin], ["repo", path.join(repo, ".spor.json")]);
  assert.strictEqual(row("token").secret, true);
  assert.strictEqual(row("nudge.timeoutMs").source, "default");
  assert.strictEqual(row("nudge.timeoutMs").value, 30000);
  assert.strictEqual(row("queue.project").source, "unset");
  assert.deepStrictEqual([row("mode").source, row("mode").origin], ["env", "SPOR_MODE"]);
  assert.ok(c.explain("nudge").every((r) => r.key.startsWith("nudge.")), "a namespace prefix filters");
  assert.deepStrictEqual(c.explain("nudg"), [], "a partial segment is not a prefix");
});

test("explain: a `.spor` graph: marker is reported as the winner of `home`", () => {
  const root = tmp();
  const repo = path.join(root, "repo");
  write(path.join(repo, ".spor"), "repo: r\ngraph: ../team\n");
  const c = config.loadConfig({ cwd: repo, env: hermeticEnv({ SPOR_HOME: path.join(root, "personal") }) });
  const home = c.explain("home")[0];
  assert.deepStrictEqual([home.source, home.origin, home.value], ["marker", path.join(repo, ".spor"), path.join(root, "team")]);
  assert.deepStrictEqual(home.shadowed.map((s) => s.source), ["env"]);
});

test("spor config explain: prints the winning layer, redacts secrets, and --json round-trips", () => {
  const home = tmp();
  write(path.join(home, "config.json"), { token: "SEEKRIT", nudge: { maxCalls: 7 } });
  const env = hermeticEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home });
  let r = spawnSync(process.execPath, [CLI, "config", "explain", "--set"], { cwd: home, env, encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /nudge\.maxCalls\s+7\s+<- user\s+.*config\.json/);
  assert.match(r.stdout, /token\s+"<redacted>"/);
  assert.doesNotMatch(r.stdout + r.stderr, /SEEKRIT/);
  assert.match(r.stdout, /mode:\s+local/);
  r = spawnSync(process.execPath, [CLI, "config", "nudge.maxCalls", "--json"], { cwd: home, env, encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepStrictEqual(j.keys.map((k) => [k.key, k.value, k.source]), [["nudge.maxCalls", 7, "user"]]);
  r = spawnSync(process.execPath, [CLI, "config", "explain", "no.such.key"], { cwd: home, env, encoding: "utf8" });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /not a declared config key/);
});

// --- enabled: null is unset (issue-spor-config-enabled-explicit-null-inconsistency)

test("enabled: an explicit null reads as unset and falls back to marker presence", () => {
  const root = tmp();
  const bare = path.join(root, "bare");
  write(path.join(root, "home", "config.json"), { enabled: null });
  fs.mkdirSync(bare, { recursive: true });
  const home = path.join(root, "home");
  let c = load(home, { cwd: bare });
  assert.strictEqual(c.enabled(), false);
  assert.strictEqual(c.disabledByDefault(), true);
  const marked = path.join(root, "marked");
  write(path.join(marked, ".spor.json"), { enabled: null });
  c = load(home, { cwd: marked });
  assert.strictEqual(c.enabled(), true, "a marker still opts in");
  assert.strictEqual(c.disabledByDefault(), false);
});

// --- fail-closed ambient tenant (issue-spor-ambient-org-selector-silent-fallback)

function storeWith(home, ...orgs) {
  for (const org of orgs) auth.upsertTenant(home, { server: `https://${org}.example`, org, access_token: `T-${org}` });
}

test("tenant: SPOR_ORG naming an unstored org REFUSES instead of resolving the store default", () => {
  const home = tmp();
  storeWith(home, "spor");
  const c = load(home, { env: { SPOR_ORG: "dartlane" } });
  const te = c.tenantError();
  assert.deepStrictEqual([te.kind, te.org, te.source, te.origin], ["unknown-org", "dartlane", "env-org", "SPOR_ORG"]);
  assert.deepStrictEqual(te.orgs, ["spor"]);
  assert.strictEqual(c.tenant(), null);
  assert.strictEqual(c.server(), "");
  assert.strictEqual(c.token(), "", "no wrong-tenant credential leaks out");
  // A stored org still selects normally.
  assert.strictEqual(load(home, { env: { SPOR_ORG: "spor" } }).token(), "T-spor");
});

test("tenant: a repo .spor org: marker naming an unstored org REFUSES, naming the marker file", () => {
  const home = tmp();
  storeWith(home, "spor");
  const repo = tmp("spor-keys-repo-");
  write(path.join(repo, ".spor"), "repo: x\norg: dartlane\n");
  const te = load(home, { cwd: repo }).tenantError();
  assert.deepStrictEqual([te.kind, te.org, te.source, te.origin], ["unknown-org", "dartlane", "repo-marker", path.join(repo, ".spor")]);
});

test("tenant: past the refusal — the legacy flat config and an explicit local mode", () => {
  const home = tmp();
  write(path.join(home, "config.json"), { server: "https://flat.example", token: "flat" });
  const c = load(home, { env: { SPOR_ORG: "ghost" } });
  assert.strictEqual(c.tenantError().kind, "unknown-org", "no fallthrough to the legacy flat config either");
  assert.strictEqual(c.token(), "");
  // mode:local consults no tenant, so a stray ambient org is moot, not an error.
  assert.strictEqual(load(home, { env: { SPOR_ORG: "ghost", SPOR_MODE: "local" } }).tenantError(), null);
  // SPOR_SERVER still outranks SPOR_ORG (unchanged precedence).
  assert.strictEqual(load(home, { env: { SPOR_ORG: "ghost", SPOR_SERVER: "https://env.example" } }).tenantError(), null);
  // An acquiring verb defaults its server past every org selector.
  storeWith(home, "spor");
  assert.strictEqual(load(home, { env: { SPOR_ORG: "ghost" } }).serverForNewTenant(), "https://spor.example");
});

test("CLI: an unstored SPOR_ORG refuses a verb with exit 1, naming the source and the stored orgs", () => {
  const home = tmp();
  storeWith(home, "spor", "acme");
  const env = hermeticEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_ORG: "dartlane" });
  const r = spawnSync(process.execPath, [CLI, "get", "task-x"], { cwd: home, env, encoding: "utf8" });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /no credential stored for org 'dartlane' \(from SPOR_ORG\)/);
  assert.match(r.stderr, /stored orgs: acme, spor/);
  // …but `spor config explain` still runs, and shows the refusal.
  const x = spawnSync(process.execPath, [CLI, "config", "explain", "mode"], { cwd: home, env, encoding: "utf8" });
  assert.strictEqual(x.status, 0, x.stderr);
  assert.match(x.stdout, /tenant:\s+REFUSED — org 'dartlane' \(from SPOR_ORG\)/);
});

test("hooks: an unstored bound org injects nothing, writes no node to either graph, and journals why", () => {
  const home = tmp();
  storeWith(home, "spor");
  const repo = tmp("spor-keys-repo-");
  write(path.join(repo, ".spor"), "repo: bound\norg: dartlane\n");
  write(path.join(repo, ".spor.json"), { enabled: true });
  write(path.join(home, "nodes", "dec-seed.md"), "---\nid: dec-seed\ntype: decision\nproject: bound\ntitle: seed\nsummary: seed decision for the bound repo briefing test\n---\n\nbody\n");
  const transcript = path.join(repo, "t.jsonl");
  const words = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: [{ type: "text", text: words }] } }) + "\n");
  // A distill backend that would PROVE a write if it ever ran.
  const marker = path.join(repo, "distill-ran");
  const env = hermeticEnv({
    SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_MODE: "auto", SPOR_DEBOUNCE: "0",
    SPOR_DISTILL_CMD: `sh -c 'cat >/dev/null; touch ${marker}'`,
  });
  const hook = (event, payload) =>
    spawnSync(process.execPath, [HOOK, event, "--host", "claude-code"], { input: JSON.stringify(payload), env, encoding: "utf8" });
  const before = fs.readdirSync(path.join(home, "nodes")).sort();
  assert.strictEqual(hook("session-start", { cwd: repo, session_id: "s1", hook_event_name: "SessionStart" }).stdout, "");
  assert.strictEqual(hook("prompt-context", { cwd: repo, session_id: "s1", prompt: "tell me about the seed decision for bound", hook_event_name: "UserPromptSubmit" }).stdout, "");
  assert.strictEqual(hook("distill", { cwd: repo, session_id: "s1", transcript_path: transcript, hook_event_name: "SessionEnd" }).stdout, "");
  assert.deepStrictEqual(fs.readdirSync(path.join(home, "nodes")).sort(), before, "no node written to the local graph");
  assert.ok(!fs.existsSync(marker), "the distiller never ran");
  const log = fs.readFileSync(path.join(home, "journal", "remote.log"), "utf8");
  assert.match(log, /org 'dartlane' \(from .*\.spor\) has no stored credential — hook skipped/);
});

// --- repo registration is explicit, never a hook side effect ------------------

test("session-start never writes dispatch.repos; `spor enable` registers the checkout", () => {
  const home = tmp();
  const repo = path.join(tmp("spor-keys-reg-"), "myrepo");
  fs.mkdirSync(repo, { recursive: true });
  spawnSync("git", ["init", "-q"], { env: scrubbedEnv(), cwd: repo });
  write(path.join(repo, ".spor.json"), { enabled: true });
  const env = hermeticEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home });
  spawnSync(process.execPath, [HOOK, "session-start", "--host", "claude-code"], { input: JSON.stringify({ cwd: repo, session_id: "s", hook_event_name: "SessionStart" }), env, encoding: "utf8" });
  const repos = () => {
    try {
      return (JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")).dispatch || {}).repos || {};
    } catch {
      return {};
    }
  };
  assert.deepStrictEqual(repos(), {}, "the hook registered nothing");
  const r = spawnSync(process.execPath, [CLI, "enable", "--no-agents"], { cwd: repo, env, encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr);
  // git reports a long, forward-slash path on Windows; realpath.native expands 8.3 names
  const registered = repos();
  if (registered.myrepo) registered.myrepo = fs.realpathSync.native(path.normalize(registered.myrepo));
  assert.deepStrictEqual(registered, { myrepo: fs.realpathSync.native(repo) });
  assert.match(r.stdout, /registered myrepo -> /);
});

// --- the scratch-home recipe cannot reach a server (issue-spor-scratch-home-does-not-force-local-mode)

test("hermeticEnv pins local mode, so a scratch-home write never reaches a configured server", () => {
  const home = tmp();
  // Even with a server + credential in the scratch home's own config, the
  // helper's SPOR_MODE=local keeps a write local — a dead port proves no call.
  write(path.join(home, "config.json"), { server: "http://127.0.0.1:9", token: "t" });
  const env = hermeticEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home });
  assert.strictEqual(env.SPOR_MODE, "local");
  const r = spawnSync(process.execPath, [CLI, "status", "--quiet"], { cwd: home, env, encoding: "utf8" });
  assert.match(r.stdout, /mode:\s+local/);
  assert.strictEqual(hermeticEnv({ SPOR_SERVER: "http://x" }).SPOR_MODE, undefined, "remote intent opts out");
});


// --- a KNOWN --org binds the auth subcommands (issue-spor-cli-auth-known-org-ignored)

test("auth logout/switch --org act on the named tenant, never the active default", () => {
  const home = tmp();
  storeWith(home, "spor", "acme"); // spor is the default (first stored)
  const env = hermeticEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_MODE: "auto" });
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: home, env, encoding: "utf8" });
  assert.strictEqual(auth.readStore(home).default, "https://spor.example/spor");
  let r = run("auth", "switch", "--org", "acme");
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(auth.readStore(home).default, "https://acme.example/acme");
  run("auth", "switch", "spor");
  r = run("auth", "logout", "--org", "acme");
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /logged out of https:\/\/acme\.example\/acme/);
  const store = auth.readStore(home);
  assert.deepStrictEqual(Object.keys(store.tenants), ["https://spor.example/spor"], "acme removed, the default kept");
  assert.strictEqual(store.default, "https://spor.example/spor");
});

// --- review fixes -------------------------------------------------------------

test("tenant: an ambient org is satisfied by a legacy flat config whose token is for that org", () => {
  const home = tmp();
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const jwt = `${b64({ alg: "none" })}.${b64({ org: "acme" })}.sig`;
  write(path.join(home, "config.json"), { server: "https://a.example", token: jwt });
  const repo = tmp("spor-keys-repo-");
  write(path.join(repo, ".spor"), "repo: x\norg: acme\n");
  for (const c of [load(home, { cwd: repo }), load(home, { env: { SPOR_ORG: "acme" } })]) {
    assert.strictEqual(c.tenantError(), null);
    assert.strictEqual(c.server(), "https://a.example");
    assert.strictEqual(c.tenant().source, "flat-config");
  }
  // …but a flat credential for a DIFFERENT org still refuses.
  assert.strictEqual(load(home, { env: { SPOR_ORG: "other" } }).tenantError().kind, "unknown-org");
});

test("CLI: an ambient refusal still lets `spor auth list` and `spor disable` run", () => {
  const home = tmp();
  storeWith(home, "spor");
  const env = hermeticEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home, SPOR_ORG: "zzz" });
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: home, env, encoding: "utf8" });
  let r = run("auth", "list");
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /spor/);
  r = run("status", "--quiet");
  assert.strictEqual(r.status, 1, "a graph-facing verb still refuses");
  assert.match(r.stderr, /'spor config explain' shows which selector chose it/);
  // An explicit --org gets no such pass.
  r = spawnSync(process.execPath, [CLI, "auth", "list", "--org", "zzz"], { cwd: home, env: hermeticEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home }), encoding: "utf8" });
  assert.strictEqual(r.status, 1);
});

test("serverForNewTenant: an ambient refusal under explicit mode:local still defaults to the stored server", () => {
  const home = tmp();
  storeWith(home, "spor");
  assert.strictEqual(load(home, { env: { SPOR_ORG: "ghost", SPOR_MODE: "local" } }).serverForNewTenant(), "https://spor.example");
});

test("spor config explain <child of a map> explains the map", () => {
  const home = tmp();
  write(path.join(home, "config.json"), { dispatch: { capabilities: { probed: { gh: true } } } });
  const r = spawnSync(process.execPath, [CLI, "config", "explain", "dispatch.capabilities.probed"], { cwd: home, env: hermeticEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home }), encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^dispatch\.capabilities\s+\{"probed"/m);
});

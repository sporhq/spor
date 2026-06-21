// Path-scoped sub-briefs for monorepos (dec-spor-monorepo-path-scoped-briefs,
// task-spor-monorepo-path-scoped-briefs). A repo's .spor.json may carry a
// `briefs` map of relative-subtree-path -> brief-id; session-start routes to
// the NEAREST-ANCESTOR area for cwd and surfaces the sibling areas as a
// discovery line. Three surfaces under test:
//   - the pure matcher u.matchBriefs (deepest wins; no-match yields siblings);
//   - the config schema (Config.briefs()/briefsBase(), a known key);
//   - session-start end-to-end against a fixture .spor.json briefs map, from a
//     subtree, a sibling subtree, and the repo root, plus the byte-identical
//     no-briefs case (norm-cc-byte-identical-refactor).
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const u = require("../scripts/engines/util.js");
const { loadConfig } = require("../lib/config.js");

const HOOK = path.join(__dirname, "..", "bin", "spor-hook.js");

// ---------------------------------------------------------------------------
// the pure matcher
// ---------------------------------------------------------------------------

const MAP = {
  "auth/": "brief-s-auth",
  "auth/v2/": "brief-s-auth-v2",
  "frontend-router/": "brief-s-frontend-router",
};

test("matchBriefs: deepest ancestor wins", () => {
  const r = u.matchBriefs(MAP, "/repo", "/repo/auth/v2/handlers");
  assert.deepStrictEqual(r.active, { area: "auth/v2", id: "brief-s-auth-v2" });
  // siblings are every OTHER entry, in declaration order
  assert.deepStrictEqual(r.siblings, [
    { area: "auth", id: "brief-s-auth" },
    { area: "frontend-router", id: "brief-s-frontend-router" },
  ]);
});

test("matchBriefs: a shallower subtree matches when the deeper one does not", () => {
  const r = u.matchBriefs(MAP, "/repo", "/repo/auth/login");
  assert.deepStrictEqual(r.active, { area: "auth", id: "brief-s-auth" });
});

test("matchBriefs: no match at the repo root -> null active, all siblings", () => {
  const r = u.matchBriefs(MAP, "/repo", "/repo");
  assert.strictEqual(r.active, null);
  assert.strictEqual(r.siblings.length, 3);
});

test("matchBriefs: no match in an undeclared subtree", () => {
  const r = u.matchBriefs(MAP, "/repo", "/repo/docs/guide");
  assert.strictEqual(r.active, null);
  assert.strictEqual(r.siblings.length, 3);
});

test("matchBriefs: the separator guard stops a/ from matching a sibling a-b/", () => {
  const r = u.matchBriefs({ "a/": "brief-a", "a-b/": "brief-a-b" }, "/repo", "/repo/a-b/x");
  assert.deepStrictEqual(r.active, { area: "a-b", id: "brief-a-b" });
});

test("matchBriefs: a bare subtree dir (no trailing path) matches its own area", () => {
  const r = u.matchBriefs({ "auth/": "brief-s-auth" }, "/repo", "/repo/auth");
  assert.deepStrictEqual(r.active, { area: "auth", id: "brief-s-auth" });
});

test("matchBriefs: trailing slash and ./ prefix normalize to the same area label", () => {
  const r = u.matchBriefs({ "./auth/": "brief-s-auth" }, "/repo", "/repo/auth/x");
  assert.deepStrictEqual(r.active, { area: "auth", id: "brief-s-auth" });
});

test("matchBriefs: empty / whole-repo keys are skipped (no blank-label entries)", () => {
  const r = u.matchBriefs({ "": "brief-blank", "/": "brief-root", "auth/": "brief-s-auth" }, "/repo", "/repo/auth/x");
  assert.deepStrictEqual(r.active, { area: "auth", id: "brief-s-auth" });
  assert.deepStrictEqual(r.siblings, []); // the two empty-area entries were dropped, not listed
});

test("matchBriefs: a non-object map fails open to no match", () => {
  assert.deepStrictEqual(u.matchBriefs(null, "/repo", "/repo/x"), { active: null, siblings: [] });
  assert.deepStrictEqual(u.matchBriefs([], "/repo", "/repo/x"), { active: null, siblings: [] });
  assert.deepStrictEqual(u.matchBriefs({ "a/": 5 }, "/repo", "/repo/a/x"), { active: null, siblings: [] });
});

// ---------------------------------------------------------------------------
// the config schema
// ---------------------------------------------------------------------------

function bareEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("SPOR_") || k.startsWith("SUBSTRATE_") || k === "XDG_CONFIG_HOME") continue;
    env[k] = v;
  }
  return Object.assign(env, extra);
}
function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "spor-briefs-"));
}

test("config: briefs() returns the map and briefsBase() anchors at the manifest dir", () => {
  const root = tmp();
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(
    path.join(repo, ".spor.json"),
    JSON.stringify({ briefs: { "auth/": "brief-s-auth" } })
  );
  const cwd = path.join(repo, "auth", "handlers");
  fs.mkdirSync(cwd, { recursive: true });
  const c = loadConfig({ cwd, env: bareEnv({ SPOR_HOME: path.join(root, "home") }) });
  assert.deepStrictEqual(c.briefs(), { "auth/": "brief-s-auth" });
  assert.strictEqual(c.briefsBase(), repo);
  assert.deepStrictEqual(c.warnings, []); // `briefs` is a known key, no warning
});

test("config: no briefs map -> briefs()/briefsBase() are null (byte-identical)", () => {
  const root = tmp();
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  const c = loadConfig({ cwd: repo, env: bareEnv({ SPOR_HOME: path.join(root, "home") }) });
  assert.strictEqual(c.briefs(), null);
  assert.strictEqual(c.briefsBase(), null);
});

test("config: a nested .spor.json manifest SHADOWS the ancestor's (nearest wins wholesale, not a union)", () => {
  const root = tmp();
  const repo = path.join(root, "repo");
  const svc = path.join(repo, "services");
  fs.mkdirSync(svc, { recursive: true });
  fs.writeFileSync(path.join(repo, ".spor.json"), JSON.stringify({ briefs: { "auth/": "brief-s-auth" } }));
  fs.writeFileSync(path.join(svc, ".spor.json"), JSON.stringify({ briefs: { "api/": "brief-s-api" } }));
  const cwd = path.join(svc, "api", "x");
  fs.mkdirSync(cwd, { recursive: true });
  const c = loadConfig({ cwd, env: bareEnv({ SPOR_HOME: path.join(root, "home") }) });
  // The nearest manifest wins WHOLESALE — no union, so the map and the anchor
  // always agree (the ancestor's "auth/" is not mis-anchored under services/).
  assert.deepStrictEqual(c.briefs(), { "api/": "brief-s-api" });
  assert.strictEqual(c.briefsBase(), svc);
  // The map resolves correctly against its own anchor: cwd under services/api/.
  const m = u.matchBriefs(c.briefs(), c.briefsBase(), cwd);
  assert.deepStrictEqual(m.active, { area: "api", id: "brief-s-api" });
});

test("config: an ancestor-only manifest routes correctly from a deep cwd (no mis-anchor)", () => {
  const root = tmp();
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(
    path.join(repo, ".spor.json"),
    JSON.stringify({ briefs: { "services/api/": "brief-s-api" } })
  );
  const cwd = path.join(repo, "services", "api", "handlers");
  fs.mkdirSync(cwd, { recursive: true });
  const c = loadConfig({ cwd, env: bareEnv({ SPOR_HOME: path.join(root, "home") }) });
  // base is the repo root (the only manifest), so "services/api/" resolves to
  // repo/services/api and matches the cwd beneath it.
  const m = u.matchBriefs(c.briefs(), c.briefsBase(), cwd);
  assert.deepStrictEqual(m.active, { area: "services/api", id: "brief-s-api" });
});

// ---------------------------------------------------------------------------
// session-start, end-to-end (local mode, hermetic graph home)
// ---------------------------------------------------------------------------

const { spawnSync } = require("node:child_process");

// A scratch graph home + a repo tree carrying a .spor.json briefs map. The
// graph home (SPOR_HOME) holds the brief NODE files; the repo tree holds the
// committable manifest. They are deliberately separate dirs.
function fixture(briefsMap, nodeFiles = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spor-briefs-ss-"));
  const home = path.join(root, "graph");
  fs.mkdirSync(path.join(home, "nodes"), { recursive: true });
  for (const [id, body] of Object.entries(nodeFiles)) {
    fs.writeFileSync(path.join(home, "nodes", `${id}.md`), body);
  }
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(
    path.join(repo, ".spor.json"),
    JSON.stringify({ enabled: true, briefs: briefsMap })
  );
  return { root, home, repo };
}

function runSessionStart(home, cwd) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("SPOR_") || k.startsWith("SUBSTRATE_") || k === "XDG_CONFIG_HOME") continue;
    env[k] = v;
  }
  env.SPOR_HOME = home;
  const r = spawnSync(process.execPath, [HOOK, "session-start", "--host", "claude-code"], {
    input: JSON.stringify({ cwd, hook_event_name: "SessionStart" }),
    env,
    encoding: "utf8",
  });
  assert.strictEqual(r.status, 0, `exit 0 expected (fail-open): ${r.stderr}`);
  if (!r.stdout.trim()) return "";
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
}

const AUTH_BRIEF = `---
id: brief-spor-server-auth
type: briefing
project: spor-server
title: Auth area briefing
summary: Auth subtree.
version: 2
---

The auth area body — WorkOS device grant and the credential store.
`;

const BRIEFS = {
  "auth/": "brief-spor-server-auth",
  "frontend-router/": "brief-spor-server-frontend-router",
  "hosting/": "brief-spor-server-hosting",
};

test("session-start: in a subtree injects the active area brief body + sibling line", () => {
  const { home, repo } = fixture(BRIEFS, { "brief-spor-server-auth": AUTH_BRIEF });
  const cwd = path.join(repo, "auth", "handlers");
  fs.mkdirSync(cwd, { recursive: true });
  const ctx = runSessionStart(home, cwd);
  // active area body injected under its own header
  assert.match(ctx, /## Active area briefing \(brief-spor-server-auth, covering auth\//);
  assert.match(ctx, /The auth area body — WorkOS device grant/);
  // siblings surfaced (NOT the active one)
  assert.match(ctx, /This repo also has path-scoped briefs:/);
  assert.match(ctx, /frontend-router \(brief-spor-server-frontend-router\)/);
  assert.match(ctx, /hosting \(brief-spor-server-hosting\)/);
  assert.doesNotMatch(ctx, /also has path-scoped briefs:[^\n]*auth \(/); // auth is active, not a sibling
});

test("session-start: in a sibling subtree with no on-disk brief node points at /spor:brief", () => {
  const { home, repo } = fixture(BRIEFS, { "brief-spor-server-auth": AUTH_BRIEF });
  const cwd = path.join(repo, "frontend-router");
  fs.mkdirSync(cwd, { recursive: true });
  const ctx = runSessionStart(home, cwd);
  // the active area's brief node is not on disk -> pointer, not a body
  assert.match(
    ctx,
    /Active area for this subtree: frontend-router — load its briefing with \/spor:brief brief-spor-server-frontend-router\./
  );
  assert.doesNotMatch(ctx, /## Active area briefing/);
  // siblings are auth + hosting
  assert.match(ctx, /auth \(brief-spor-server-auth\)/);
  assert.match(ctx, /hosting \(brief-spor-server-hosting\)/);
});

test("session-start: at the repo root surfaces ALL briefs as a discovery line, no body", () => {
  const { home, repo } = fixture(BRIEFS, { "brief-spor-server-auth": AUTH_BRIEF });
  const ctx = runSessionStart(home, repo);
  assert.match(ctx, /This repo has path-scoped briefs:/);
  assert.match(ctx, /auth \(brief-spor-server-auth\)/);
  assert.match(ctx, /frontend-router \(brief-spor-server-frontend-router\)/);
  assert.match(ctx, /hosting \(brief-spor-server-hosting\)/);
  assert.doesNotMatch(ctx, /## Active area briefing/);
});

test("session-start: a repo with no briefs map injects no briefs block (byte-identical)", () => {
  // Same fixture shape but WITHOUT a briefs map — opt in via enabled flag only.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spor-briefs-none-"));
  const home = path.join(root, "graph");
  fs.mkdirSync(path.join(home, "nodes"), { recursive: true });
  fs.writeFileSync(path.join(home, "nodes", "brief-spor-server-auth.md"), AUTH_BRIEF);
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, ".spor.json"), JSON.stringify({ enabled: true }));
  const ctx = runSessionStart(home, repo);
  assert.doesNotMatch(ctx, /path-scoped briefs/);
  assert.doesNotMatch(ctx, /Active area/);
});

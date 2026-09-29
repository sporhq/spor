// A committed repo `.spor.json` may name `server:`, but a stored token is only
// sent to it when the credential's recorded server matches
// (task-spor-client-repo-server-credential-match,
// dec-spor-repo-server-key-requires-matching-credential): the legacy flat
// config.json token and the ambient-org flatForOrg path in lib/config.js.
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const config = require("../lib/config.js");
const auth = require("../lib/auth.js");
const { hermeticEnv } = require("./helpers/env.js");

const CLI = path.join(__dirname, "..", "bin", "spor.js");

function tmp(p = "spor-rsc-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}
function write(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
}
function envFor(home, env = {}) {
  return hermeticEnv({ SPOR_MODE: "auto", SPOR_HOME: home, XDG_CONFIG_HOME: home, ...env });
}
function load(home, { env = {}, cwd } = {}) {
  return config.loadConfig({ cwd: cwd || home, env: envFor(home, env) });
}
// A user home holding a flat credential for `server`, and a repo whose
// committed .spor.json names `repoServer`.
function fixture({ userServer = "https://mine.example", token = "USER-TOKEN", repoServer = "https://team.example" } = {}) {
  const home = tmp();
  const user = {};
  if (userServer) user.server = userServer;
  if (token) user.token = token;
  write(path.join(home, "config.json"), user);
  const repo = tmp("spor-rsc-repo-");
  write(path.join(repo, ".spor.json"), { enabled: true, server: repoServer });
  return { home, repo, repoFile: path.join(repo, ".spor.json") };
}

test("mismatch: a repo server never receives a token recorded for another server", () => {
  const { home, repo, repoFile } = fixture();
  const c = load(home, { cwd: repo });
  const te = c.tenantError();
  assert.deepStrictEqual(
    [te.kind, te.server, te.credential_server, te.source, te.origin],
    ["server-mismatch", "https://team.example", "https://mine.example", "repo-server", repoFile],
  );
  assert.strictEqual(c.tenant(), null);
  assert.strictEqual(c.token(), "", "the user's token does not leak out");
  assert.strictEqual(c.server(), "");
  assert.match(config.describeTenantRefusal(te), /sets server https:\/\/team\.example, but the stored credential is for https:\/\/mine\.example/);
  // Signing in to the repo's server is the cure, so an acquiring verb defaults to it.
  assert.strictEqual(c.serverForNewTenant(), "https://team.example");
});

test("mismatch: a flat token with NO recorded server is not paired with a repo server", () => {
  const { home, repo } = fixture({ userServer: null });
  const te = load(home, { cwd: repo }).tenantError();
  assert.strictEqual(te.kind, "server-mismatch");
  assert.strictEqual(te.credential_server, null);
  // …and SPOR_TOKEN alone is no different.
  const h2 = fixture({ userServer: null, token: null });
  const c = load(h2.home, { cwd: h2.repo, env: { SPOR_TOKEN: "ENV-TOKEN" } });
  assert.strictEqual(c.tenantError().kind, "server-mismatch");
  assert.strictEqual(c.token(), "");
});

test("match: the flat token rides along when its recorded server IS the repo server", () => {
  const { home, repo } = fixture({ userServer: "https://team.example/", repoServer: "https://team.example" });
  const c = load(home, { cwd: repo });
  assert.strictEqual(c.tenantError(), null);
  assert.strictEqual(c.server(), "https://team.example");
  assert.strictEqual(c.token(), "USER-TOKEN");
});

test("match: a store credential recorded for the repo server is used instead of the flat token", () => {
  const { home, repo } = fixture();
  auth.upsertTenant(home, { server: "https://team.example", org: "team", access_token: "TEAM-TOKEN" });
  // upsertTenant may have made it the default; clear that so the flat path is what resolves.
  const store = auth.readStore(home);
  store.default = null;
  auth.writeStore(home, store);
  const c = load(home, { cwd: repo });
  assert.strictEqual(c.tenantError(), null);
  assert.strictEqual(c.server(), "https://team.example");
  assert.strictEqual(c.token(), "TEAM-TOKEN");
});

test("no credential at all: a repo server resolves tokenless, no refusal", () => {
  const { home, repo } = fixture({ userServer: null, token: null });
  const c = load(home, { cwd: repo });
  assert.strictEqual(c.tenantError(), null);
  assert.strictEqual(c.server(), "https://team.example");
  assert.strictEqual(c.token(), "");
});

test("unaffected: a user- or env-layer server keeps its prior pairing", () => {
  // user layer only
  const home = tmp();
  write(path.join(home, "config.json"), { server: "https://mine.example", token: "USER-TOKEN" });
  let c = load(home);
  assert.strictEqual(c.tenantError(), null);
  assert.strictEqual(c.token(), "USER-TOKEN");
  // env SPOR_SERVER outranks the repo server and pairs as before
  const f = fixture();
  c = load(f.home, { cwd: f.repo, env: { SPOR_SERVER: "https://env.example" } });
  assert.strictEqual(c.tenantError(), null);
  assert.strictEqual(c.server(), "https://env.example");
  assert.strictEqual(c.token(), "USER-TOKEN");
  // explicit mode:local consults no tenant
  assert.strictEqual(load(f.home, { cwd: f.repo, env: { SPOR_MODE: "local" } }).tenantError(), null);
});

test("ambient org: a flat credential for that org is not sent to a mismatched repo server", () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const jwt = `${b64({ alg: "none" })}.${b64({ org: "acme" })}.sig`;
  const { home, repo } = fixture({ token: jwt });
  let te = load(home, { cwd: repo, env: { SPOR_ORG: "acme" } }).tenantError();
  assert.deepStrictEqual([te.kind, te.org], ["server-mismatch", "acme"]);
  // an org the credential does not carry stays an unknown-org refusal
  te = load(home, { cwd: repo, env: { SPOR_ORG: "other" } }).tenantError();
  assert.strictEqual(te.kind, "unknown-org");
});

test("CLI: graph verbs refuse, `spor config explain` shows the refusal", () => {
  const { home, repo } = fixture();
  const env = envFor(home);
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: repo, env, encoding: "utf8" });
  let r = run("status", "--quiet");
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /sets server https:\/\/team\.example, but your stored credential is for https:\/\/mine\.example/);
  assert.doesNotMatch(r.stderr + r.stdout, /USER-TOKEN/);
  r = run("config", "explain");
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /tenant: {3}REFUSED — .*\.spor\.json sets server https:\/\/team\.example, but the stored credential is for https:\/\/mine\.example/);
  r = run("config", "explain", "--json");
  const j = JSON.parse(r.stdout);
  assert.deepStrictEqual(
    [j.tenant.refused, j.tenant.server, j.tenant.credential_server],
    ["server-mismatch", "https://team.example", "https://mine.example"],
  );
});

test("CLI: `spor auth login` to the repo's server cures it without moving other repos", () => {
  const team = "http://127.0.0.1:9"; // a dead port: the identity probe fails fast, storing anyway
  const { home, repo } = fixture({ repoServer: team });
  const env = envFor(home);
  const run = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: "utf8" });
  let r = run(repo, "auth", "login", team, "TEAM-TOKEN");
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /not as your default tenant/);
  assert.strictEqual(auth.readStore(home).default || null, null, "the repo's server did not become the default");
  // In the repo: the credential recorded for its server now pairs with it.
  let c = load(home, { cwd: repo });
  assert.strictEqual(c.tenantError(), null);
  assert.deepStrictEqual([c.server(), c.token()], [team, "TEAM-TOKEN"]);
  // Anywhere else: still the user's own server and token.
  c = load(home);
  assert.deepStrictEqual([c.server(), c.token()], ["https://mine.example", "USER-TOKEN"]);
});

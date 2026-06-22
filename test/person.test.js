// person.test.js — `spor person create|list` (task-spor-onboard-cli-person-node):
// the deterministic LOCAL-mode path that creates the `type: person` node the
// queue's $viewer binding resolves to. Net-new because `spor agent create` needs
// a pre-existing person and `spor invite` (the only person-creating verb) is
// remote + admin-gated.
//
// Oracle = the on-disk frontmatter the CLI writes, plus the real lib/queue.js
// viewerFor binding it must resolve back to. Everything runs against throwaway
// git-init'd graph homes — never the live graph.
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const graphLib = require("../lib/graph.js");
const queueLib = require("../lib/queue.js");

// Env with no SPOR_*/SUBSTRATE_*/XDG leakage so a configured dev box can't flip a
// local-mode test to remote or leak a token (mirrors repos-tag.test.js).
function bare(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("SPOR_") || k.startsWith("SUBSTRATE_") || k === "XDG_CONFIG_HOME") continue;
    env[k] = v;
  }
  return Object.assign(env, extra);
}
function run(args, extra) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: bare(extra) });
}

// A scratch local graph home, git-init'd with a configured identity (the email
// is the $viewer binding key). Identity is set repo-locally so the test is
// independent of the runner's global git config. Pass identity:null for a home
// with NO git identity (the bootstrap-not-yet-done case).
function freshHome(identity = { name: "Jo Diaz", email: "jo@example.io" }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-person-"));
  spawnSync("git", ["init", "-q", home]);
  if (identity) {
    spawnSync("git", ["-C", home, "config", "user.name", identity.name]);
    spawnSync("git", ["-C", home, "config", "user.email", identity.email]);
  }
  return home;
}
// Isolate git from the runner's global/system config so a configured dev box
// can't leak a user.email into a home meant to have NO identity. GIT_CONFIG_GLOBAL
// at a nonexistent path makes git skip ~/.gitconfig + XDG; NOSYSTEM skips /etc.
// Repo-local config (set by freshHome) still wins for the identity homes.
function localEnv(home, extra = {}) {
  return Object.assign(
    {
      SPOR_HOME: home,
      XDG_CONFIG_HOME: home,
      SPOR_DISTILLING: "1",
      GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig-absent"),
      GIT_CONFIG_NOSYSTEM: "1",
    },
    extra
  );
}

test("person create (local): writes a valid person node that binds the git identity", () => {
  const home = freshHome();
  const r = run(["person", "create"], localEnv(home));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /created person person-jo-diaz <jo@example\.io>/);

  const file = path.join(home, "nodes", "person-jo-diaz.md");
  assert.ok(fs.existsSync(file), "node file written");
  const g = graphLib.loadGraph(path.join(home, "nodes"));
  const node = g.nodes["person-jo-diaz"];
  assert.strictEqual(node.type, "person");
  assert.strictEqual(node.title, "Jo Diaz");
  assert.strictEqual(node.email, "jo@example.io");
  assert.ok(graphLib.validateNode(g, node).ok, "node validates");

  // The whole point: the seeded email resolves back through the SAME viewerFor /
  // gitIdentityEmail path the queue uses to bind $viewer.
  const viewer = queueLib.viewerFor(g, queueLib.gitIdentityEmail(home));
  assert.ok(viewer && viewer.id === "person-jo-diaz", "git identity binds to the new node");
});

test("person create (local): idempotent — a re-run binding the same identity is a no-op success", () => {
  const home = freshHome();
  assert.strictEqual(run(["person", "create"], localEnv(home)).status, 0);
  const r = run(["person", "create"], localEnv(home));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /already represents <jo@example\.io>/);
  // No second node written.
  const people = fs.readdirSync(path.join(home, "nodes")).filter((f) => f.startsWith("person-"));
  assert.strictEqual(people.length, 1, "exactly one person node");
});

test("person create (local): explicit --name/--email/--id override the git seed", () => {
  const home = freshHome({ name: "Git Name", email: "git@x.io" });
  const r = run(["person", "create", "--name", "Kai Rio", "--email", "kai@x.io", "--id", "person-kai"], localEnv(home));
  assert.strictEqual(r.status, 0, r.stderr);
  const node = graphLib.loadGraph(path.join(home, "nodes")).nodes["person-kai"];
  assert.strictEqual(node.title, "Kai Rio");
  assert.strictEqual(node.email, "kai@x.io");
});

test("person create (local): a leading positional is the name", () => {
  const home = freshHome();
  const r = run(["person", "create", "Pat Lee"], localEnv(home));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(home, "nodes", "person-pat-lee.md")), r.stdout);
});

test("person create (local): no email and no git identity errors clearly, writes nothing", () => {
  const home = freshHome(null); // git-init'd but no user.email
  // ensureGraphHome (== spor init) seeds the spor@localhost commit fallback before
  // the guard reads the identity, so the refusal is the sentinel branch: the
  // fallback is for auto-commits and must not bind a junk person $viewer node.
  const r = run(["person", "create"], localEnv(home));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /spor@localhost commit fallback/);
  assert.ok(!fs.existsSync(path.join(home, "nodes")) || fs.readdirSync(path.join(home, "nodes")).length === 0);
});

test("person create (local): an --id without the person- prefix is rejected", () => {
  const home = freshHome();
  const r = run(["person", "create", "--id", "notperson"], localEnv(home));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /must be a kebab 'person-<slug>' id/);
});

test("person create (local): a non-canonical --id (spaces/uppercase) is rejected, writes nothing", () => {
  const home = freshHome();
  const r = run(["person", "create", "--id", "person-Foo Bar"], localEnv(home));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /must be a kebab 'person-<slug>' id/);
  assert.strictEqual(fs.readdirSync(path.join(home, "nodes")).length, 0, "no node file written");
});

test("person create: remote mode redirects to invite/whoami and writes no local file", () => {
  const home = freshHome();
  // A dead server is fine — the redirect returns before any network call.
  const r = run(["person", "create"], localEnv(home, { SPOR_SERVER: "http://127.0.0.1:1", SPOR_TOKEN: "x" }));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /remote mode/);
  assert.match(r.stderr, /spor invite/);
  assert.ok(!fs.existsSync(path.join(home, "nodes", "person-jo-diaz.md")), "no local node written in remote mode");
});

test("person list (local): lists people and marks the git-identity binding", () => {
  const home = freshHome();
  run(["person", "create"], localEnv(home)); // person-jo-diaz binds the git identity
  run(["person", "create", "--name", "Other One", "--email", "other@x.io", "--id", "person-other"], localEnv(home));
  const r = run(["person", "list"], localEnv(home));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /person-jo-diaz\tjo@example\.io\tJo Diaz\s+← you/);
  assert.match(r.stdout, /person-other\tother@x\.io\tOther One/);
  // Only the bound node is marked.
  assert.strictEqual((r.stdout.match(/← you/g) || []).length, 1);
});

test("person list (local): empty graph is a friendly no-op, exit 0", () => {
  const home = freshHome();
  const r = run(["person", "list"], localEnv(home));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /no graph yet|no person nodes/);
});

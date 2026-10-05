// Byte-identity pins for the node writers that moved onto serializeNode
// (task-spor-client-writers-adopt-serialize-node,
// issue-spor-serialize-node-writer-migration-not-byte-identical,
// norm-cc-byte-identical-refactor). Each EXPECTED string is the pre-migration
// writer's template literal, reproduced verbatim — so a drift in key order,
// body whitespace or quoting fails here. Inputs are ordinary values; a value the
// old string write could not round-trip (wrapping quotes, a trailing space the
// parser trims) is the one deliberate difference, pinned in the last test.
require("./helpers/tmp-cleanup");
const { hermeticEnv } = require("./helpers/env.js");
const { scrubbedEnv } = require("./helpers/git.js");
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { serializeNode } = require("../lib/kernel/frontmatter.js");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const DATE = /^date: \d{4}-\d\d-\d\d$/m;

function home(withPerson = false) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "spor-wbi-"));
  spawnSync("git", ["init", "-q", h], { env: scrubbedEnv() });
  spawnSync("git", ["-C", h, "config", "user.name", "Jo Diaz"], { env: scrubbedEnv() });
  spawnSync("git", ["-C", h, "config", "user.email", "jo@example.io"], { env: scrubbedEnv() });
  fs.mkdirSync(path.join(h, "nodes"), { recursive: true });
  if (withPerson) {
    fs.writeFileSync(path.join(h, "nodes", "person-jo.md"), "---\nid: person-jo\ntype: person\ntitle: Jo Diaz\nsummary: Team member Jo Diaz.\n---\nJo.\n");
  }
  return h;
}
function run(h, args) {
  const env = hermeticEnv({
    SPOR_HOME: h, XDG_CONFIG_HOME: h, SPOR_DISTILLING: "1",
    GIT_CONFIG_GLOBAL: path.join(h, ".gc-absent"), GIT_CONFIG_NOSYSTEM: "1",
  });
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env, cwd: h });
  assert.strictEqual(r.status, 0, r.stderr);
  return r;
}
const read = (h, id) => fs.readFileSync(path.join(h, "nodes", `${id}.md`), "utf8").replace(DATE, "date: D");

test("spor add --during --blocks: edges stay BEFORE date:, body verbatim", () => {
  const h = home();
  run(h, ["add", "Fix the flaky parser test soon.", "--id", "task-wbi-a", "--project", "wbi", "--during", "dec-x", "--blocks", "task-y", "--needed-by", "2026-12-01"]);
  assert.strictEqual(read(h, "task-wbi-a"),
    "---\nid: task-wbi-a\ntype: task\nrepo: wbi\ntitle: Fix the flaky parser test soon.\nsummary: Fix the flaky parser test soon.\nneeded_by: 2026-12-01\nedges:\n  - {type: derived-from, to: dec-x}\n  - {type: blocks, to: task-y}\ndate: D\n---\n\nFix the flaky parser test soon.\n");
});

test("spor add with no edges", () => {
  const h = home();
  run(h, ["add", "Plain capture.", "--id", "task-wbi-b", "--project", "wbi"]);
  assert.strictEqual(read(h, "task-wbi-b"),
    "---\nid: task-wbi-b\ntype: task\nrepo: wbi\ntitle: Plain capture.\nsummary: Plain capture.\ndate: D\n---\n\nPlain capture.\n");
});

test("spor ask with mentions: edges before date:", () => {
  const h = home();
  run(h, ["ask", "Does the queue union stewards edges?", "--id", "question-wbi", "--project", "wbi", "--mention", "task-a", "--mention", "task-b"]);
  assert.strictEqual(read(h, "question-wbi"),
    "---\nid: question-wbi\ntype: question\nrepo: wbi\ntitle: Does the queue union stewards edges?\nsummary: Does the queue union stewards edges?\nstatus: open\nedges:\n  - {type: mentions, to: task-a}\n  - {type: mentions, to: task-b}\ndate: D\n---\n\nDoes the queue union stewards edges?\n");
});

test("spor person create", () => {
  const h = home();
  const r = run(h, ["person", "create"]);
  const id = /\((person-[0-9a-f]+)\)/.exec(r.stdout)[1];
  assert.strictEqual(read(h, id),
    `---\nid: ${id}\ntype: person\ntitle: Jo Diaz\nname: Jo Diaz\nsummary: Org member Jo Diaz <jo@example.io> — the local $viewer identity anchor for this graph's queue.\nemail: jo@example.io\ndate: D\n---\n\nOrg member Jo Diaz <jo@example.io>. Created locally by \`spor person create\`; the git-identity ($viewer) anchor the local queue and queue_mute bind to (lib/queue.js viewerFor).\n`);
});

test("spor agent create: owned-by edges stay after date:", () => {
  const h = home(true);
  run(h, ["agent", "create", "jo-laptop", "--pubkey", "SHA256:abc"]);
  assert.strictEqual(read(h, "agent-jo-laptop"),
    "---\nid: agent-jo-laptop\ntype: agent\ntitle: jo-laptop\nsummary: Automation principal jo-laptop, owned by person-jo — its dispatched-session writes read \"agent on behalf of person\".\nspiffe: spiffe://spor.local/person/jo/agent/jo-laptop\npubkey: SHA256:abc\nstatus: active\ndate: D\nedges:\n  - {type: owned-by, to: person-jo}\n---\n\nPerson-owned automation principal (dec-spor-agent-identity-nodes). Created by `spor agent create`; reused across dispatches as this machine's durable identity.\n");
});

test("invite person stub and nudge capture shapes (serializeNode with rawBody)", () => {
  const stub = serializeNode({
    id: "person-a", type: "person", title: "A B", name: "A B",
    summary: "Team member A B.", email: "a@b.io", date: "2026-10-05",
    body: "Team member A B <a@b.io>.",
  }, { rawBody: true });
  assert.strictEqual(stub,
    "---\nid: person-a\ntype: person\ntitle: A B\nname: A B\nsummary: Team member A B.\nemail: a@b.io\ndate: 2026-10-05\n---\n\nTeam member A B <a@b.io>.\n");
  const body = "Classifier-verified findings from x.md:\n\nfact one\nfact two";
  const cap = serializeNode({
    id: "task-n", type: "task", repo: "r", title: "T", summary: "S",
    date: "2026-10-05", authored_via: "capture", capture_key: "k".repeat(8), body,
  }, { rawBody: true });
  assert.strictEqual(cap,
    `---\nid: task-n\ntype: task\nrepo: r\ntitle: T\nsummary: S\ndate: 2026-10-05\nauthored_via: capture\ncapture_key: kkkkkkkk\n---\n\n${body}\n`);
});

test("the one deliberate difference: a value the old write could not round-trip is quoted", () => {
  const h = home();
  run(h, ["add", '"Quoted" at both ends"', "--id", "task-wbi-q", "--project", "wbi", "--title", '"wrapped"']);
  assert.match(read(h, "task-wbi-q"), /^title: "\\"wrapped\\""$/m);
});

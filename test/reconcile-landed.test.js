// reconcile-landed.test.js — landed-work detection
// (task-spor-landing-detect-shipped-resolver-draft). An open task/issue a
// commit REACHABLE FROM main names — by `Spor:` trailer or `commits:` stamp —
// gets an unlinked draft resolver + a confirm-close finding; a commit only on
// a branch files nothing; nothing is ever auto-closed; a re-run is a no-op;
// `--confirm` closes a batch through the ordinary doors.
//
// Scratch git repos + scratch graph homes only — never the live graph.
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const { hermeticEnv } = require("./helpers/env.js");
const { gitEnv } = require("./helpers/git.js");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawnSync, spawn, execFileSync } = require("node:child_process");

const kernel = require("../lib/kernel/landed.js");
const graphLib = require("../lib/graph.js");
const resolution = require("../lib/kernel/resolution.js");

const CLI = path.join(__dirname, "..", "bin", "spor.js");

function bare(extra = {}) {
  return hermeticEnv({ ...extra });
}
function run(home, args, extra = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: bare({ SPOR_HOME: home, XDG_CONFIG_HOME: home, ...extra }) });
}
function runAsync(home, args, extra = {}) {
  return new Promise((resolve) => {
    let out = "", errOut = "";
    const c = spawn(process.execPath, [CLI, ...args], { env: bare({ SPOR_HOME: home, XDG_CONFIG_HOME: home, ...extra }), stdio: ["ignore", "pipe", "pipe"] });
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (errOut += d));
    c.on("close", (code) => resolve({ status: code, stdout: out, stderr: errOut }));
  });
}
function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], { env: gitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function commit(dir, subject, trailer = null) {
  const args = ["commit", "-q", "--allow-empty", "-m", subject];
  if (trailer) args.push("-m", trailer);
  git(dir, ...args);
  return git(dir, "rev-parse", "HEAD");
}

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spor-landed-"));
  const home = path.join(root, "home");
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });
  const repo = path.join(root, "demo-repo");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv(), stdio: "ignore" });
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "Test");
  commit(repo, "init");
  return { root, home, nodes, repo };
}
function node(nodes, id, { type = id.split("-")[0], status = "open", extra = "" } = {}) {
  fs.writeFileSync(path.join(nodes, `${id}.md`), `---\nid: ${id}\ntype: ${type}\nproject: demo-repo\ntitle: ${id} title\nsummary: ${id} summary sentence.\n${status ? `status: ${status}\n` : ""}date: 2026-09-26\n${extra}---\n\nBody of ${id}.\n`);
}
const files = (nodes, prefix) => fs.readdirSync(nodes).filter((f) => f.startsWith(prefix)).sort();
const load = (nodes) => graphLib.loadGraph(nodes);

// --- kernel ---------------------------------------------------------------

test("kernel: trailer values parse like link-commits (commas, lines, kebab ids only)", () => {
  assert.deepStrictEqual(kernel.trailerIds("task-a, issue-b\nNot An Id\ntask-a\n"), ["task-a", "issue-b"]);
  assert.deepStrictEqual(kernel.trailerIds(""), []);
});

test("kernel: commits-field shas are filtered to this repo and to well-formed hex", () => {
  const n = { commits: ["demo@abc1234", "other@def5678", "demo@NOTHEX", "garbage", "demo@ABC1234"] };
  assert.deepStrictEqual(kernel.commitsFieldShas(n, "demo"), ["abc1234"]);
});

test("kernel: ids are deterministic and bounded under the server's 200-char cap", () => {
  const h = (s) => require("node:crypto").createHash("sha1").update(s).digest("hex");
  assert.strictEqual(kernel.findingId("task-x", h), "find-shipped-on-main-task-x");
  assert.strictEqual(kernel.draftId("task-x", h), "art-shipped-task-x");
  const long = `task-${"y".repeat(190)}`;
  const fid = kernel.findingId(long, h);
  assert.ok(fid.length <= 200 && fid.startsWith(kernel.FINDING_PREFIX));
  assert.strictEqual(fid, kernel.findingId(long, h), "stable across runs");
  // and confirmTargets still maps the bounded finding back to its subject
  const f = { id: fid, type: "finding", edges: [{ type: "relates-to", to: long }, { type: "relates-to", to: kernel.draftId(long, h) }] };
  assert.deepStrictEqual(kernel.confirmTargets(f, h), { subject: long, draft: kernel.draftId(long, h) });
});

test("kernel: confirmTargets refuses a foreign or hand-edited finding rather than acting on it", () => {
  const h = (s) => require("node:crypto").createHash("sha1").update(s).digest("hex");
  assert.match(kernel.confirmTargets({ id: "find-cold-work-task-x", type: "finding", edges: [] }, h).error, /not a reconcile-landed finding/);
  assert.match(kernel.confirmTargets({ id: "find-shipped-on-main-task-x", type: "finding", edges: [{ type: "relates-to", to: "task-y" }, { type: "relates-to", to: "art-shipped-task-y" }] }, h).error, /does not match its subject/);
  assert.match(kernel.confirmTargets({ id: "find-shipped-on-main-task-x", type: "finding", edges: [{ type: "relates-to", to: "task-x" }] }, h).error, /does not name its draft/);
});

// --- acceptance 1: exactly one finding + draft for a trailer on main; none on a branch

test("a trailer commit reachable from main files exactly one finding + one draft; the same trailer only on a branch files none", () => {
  const { home, nodes, repo } = scratch();
  node(nodes, "task-landed");
  node(nodes, "task-branch-only");
  const onMain = commit(repo, "fix the landed thing", "Spor: task-landed");
  git(repo, "checkout", "-q", "-b", "topic");
  const onBranch = commit(repo, "fix on a branch", "Spor: task-branch-only");
  git(repo, "checkout", "-q", "main");

  const r = run(home, ["reconcile-landed", "--dir", repo]);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  assert.deepStrictEqual(files(nodes, "find-"), ["find-shipped-on-main-task-landed.md"]);
  assert.deepStrictEqual(files(nodes, "art-"), ["art-shipped-task-landed.md"]);
  assert.doesNotMatch(r.stdout, /task-branch-only/);
  assert.ok(!fs.readFileSync(path.join(nodes, "find-shipped-on-main-task-landed.md"), "utf8").includes(onBranch));

  // acceptance 3: the finding names the sha, the repo, and the reachability check
  const g = load(nodes);
  const f = g.nodes["find-shipped-on-main-task-landed"];
  const md = fs.readFileSync(path.join(nodes, "find-shipped-on-main-task-landed.md"), "utf8");
  assert.ok(md.includes(`demo-repo@${onMain}`), "names the full sha, repo-qualified");
  assert.match(md, /git merge-base --is-ancestor <sha> main/);
  assert.match(f.summary, /demo-repo/);
  assert.strictEqual(f.status, "open");

  // It DRAFTS, it never resolves: the draft is in-review with no resolves
  // edge, and the task is still live and unretired.
  const d = g.nodes["art-shipped-task-landed"];
  assert.strictEqual(d.status, "in-review");
  assert.ok(!(d.edges || []).some((e) => e.type === "resolves"), "no resolves edge");
  assert.deepStrictEqual(d.commits, [`demo-repo@${onMain}`]);
  assert.strictEqual(g.nodes["task-landed"].status, "open");
  assert.ok(!resolution.resolutionMap(g)["task-landed"], "the task is not retired by the draft");

  // The graph stays valid.
  const v = spawnSync(process.execPath, [path.join(__dirname, "..", "lib", "validate.js"), "--nodes", nodes], { encoding: "utf8" });
  assert.strictEqual(v.status, 0, v.stdout + v.stderr);
});

test("re-running over the same range files nothing new (idempotent)", () => {
  const { home, nodes, repo } = scratch();
  node(nodes, "task-landed");
  commit(repo, "fix", "Spor: task-landed");
  assert.strictEqual(run(home, ["reconcile-landed", "--dir", repo]).status, 0);
  const before = fs.readdirSync(nodes).map((f) => [f, fs.readFileSync(path.join(nodes, f), "utf8")]);
  const r = run(home, ["reconcile-landed", "--dir", repo, "--json"]);
  assert.strictEqual(r.status, 0, r.stderr);
  const res = JSON.parse(r.stdout);
  assert.strictEqual(res.hits.length, 1);
  assert.strictEqual(res.hits[0].finding.status, "skipped");
  assert.strictEqual(res.hits[0].draft.status, "skipped");
  assert.deepStrictEqual(fs.readdirSync(nodes).map((f) => [f, fs.readFileSync(path.join(nodes, f), "utf8")]), before, "byte-identical graph");
});

test("a `commits:` sha that later lands files one finding on the landing run, none before it", () => {
  const { home, nodes, repo } = scratch();
  git(repo, "checkout", "-q", "-b", "topic");
  const sha = commit(repo, "the stamped fix (no trailer)");
  git(repo, "checkout", "-q", "main");
  node(nodes, "issue-stamped", { extra: `commits: [demo-repo@${sha.slice(0, 10)}]\n` });

  let r = run(home, ["reconcile-landed", "--dir", repo]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(files(nodes, "find-"), [], "branch-only stamp files nothing");

  const oldMain = git(repo, "rev-parse", "main");
  git(repo, "merge", "-q", "--ff-only", "topic");
  r = run(home, ["reconcile-landed", "--dir", repo, "--since", oldMain]);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  assert.deepStrictEqual(files(nodes, "find-"), ["find-shipped-on-main-issue-stamped.md"]);
  const md = fs.readFileSync(path.join(nodes, "find-shipped-on-main-issue-stamped.md"), "utf8");
  assert.ok(md.includes(sha), "the full landed sha");
  assert.match(md, /`commits:` stamp/);

  // A stamp that landed BEFORE the --since range is not re-reported by a
  // land-time pass over a later range (the catch-up form finds it instead).
  const { home: h2, nodes: n2, repo: r2 } = scratch();
  const early = commit(r2, "early fix");
  node(n2, "task-early", { extra: `commits: [demo-repo@${early}]\n` });
  const mid = commit(r2, "unrelated");
  assert.strictEqual(run(h2, ["reconcile-landed", "--dir", r2, "--since", mid]).status, 0);
  assert.deepStrictEqual(files(n2, "find-"), []);
});

// --- acceptance 2: the catch-up verb reproduces the ~13 trailer cases on a fixture

test("catch-up over the last N commits reproduces the 13 trailer cases on a fixture, and none of the traps", () => {
  const { home, nodes, repo } = scratch();
  const shipped = [];
  for (let i = 1; i <= 13; i++) {
    const id = i % 3 === 0 ? `issue-shipped-${i}` : `task-shipped-${i}`;
    node(nodes, id);
    shipped.push(id);
  }
  // two items named by ONE commit, and one item named by two commits
  commit(repo, "fix 1 and 2", `Spor: ${shipped[0]}, ${shipped[1]}`);
  for (const id of shipped.slice(2)) commit(repo, `fix ${id}`, `Spor: ${id}`);
  commit(repo, "follow-up for 13", `Spor: ${shipped[12]}`);
  // legacy trailer spelling still reads
  node(nodes, "task-legacy");
  commit(repo, "legacy trailer", "Substrate: task-legacy");
  shipped.push("task-legacy");
  // traps: closed / resolved-by-edge / a decision / an unknown id / branch-only
  node(nodes, "task-closed", { status: "done" });
  node(nodes, "task-retired");
  node(nodes, "art-retirer", { type: "artifact", status: null, extra: "edges:\n  - {type: resolves, to: task-retired}\n" });
  node(nodes, "dec-policy", { type: "decision", status: null });
  node(nodes, "task-on-branch");
  commit(repo, "traps", "Spor: task-closed, task-retired, dec-policy, task-does-not-exist");
  git(repo, "checkout", "-q", "-b", "wip");
  commit(repo, "unmerged fix", "Spor: task-on-branch");
  git(repo, "checkout", "-q", "main");

  const r = run(home, ["reconcile-landed", "--dir", repo, "--last", "50", "--json"]);
  assert.strictEqual(r.status, 0, r.stderr);
  const res = JSON.parse(r.stdout);
  assert.deepStrictEqual(res.hits.map((h) => h.id).sort(), [...shipped].sort());
  assert.strictEqual(res.hits.length, 14, "13 fixture cases + the legacy-trailer case");
  assert.deepStrictEqual(files(nodes, "find-shipped-on-main-").length, 14);
  assert.strictEqual(res.hits.find((h) => h.id === shipped[12]).commits.length, 2, "both commits naming it are listed");
  const reasons = Object.fromEntries(res.skipped.map((s) => [s.id, s.reason]));
  assert.deepStrictEqual(reasons, { "task-closed": "closed", "task-retired": "resolved", "dec-policy": "not-work", "task-does-not-exist": "unknown" });
  assert.ok(!res.hits.some((h) => h.id === "task-on-branch"));

  // --last bounds the scan: only the newest commits are read
  const narrow = JSON.parse(run(home, ["reconcile-landed", "--dir", repo, "--last", "2", "--json", "--dry-run"]).stdout);
  assert.deepStrictEqual(narrow.hits.map((h) => h.id), ["task-legacy"]);
});

test("--dry-run writes nothing; a bad --since or --ref refuses cleanly", () => {
  const { home, nodes, repo } = scratch();
  node(nodes, "task-landed");
  commit(repo, "fix", "Spor: task-landed");
  const r = run(home, ["reconcile-landed", "--dir", repo, "--dry-run"]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /would file: find-shipped-on-main-task-landed/);
  assert.deepStrictEqual(files(nodes, "find-"), []);
  const bad = run(home, ["reconcile-landed", "--dir", repo, "--since", "no-such-ref"]);
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /--since 'no-such-ref' does not resolve/);
  const badRef = run(home, ["reconcile-landed", "--dir", repo, "--ref", "trunk"]);
  assert.strictEqual(badRef.status, 1);
  assert.match(badRef.stderr, /ref 'trunk' does not resolve/);
});

// --- confirm: the batch door ------------------------------------------------

test("--confirm closes a whole batch in one call: draft merged + resolves edge + completion status + finding resolved", () => {
  const { home, nodes, repo } = scratch();
  node(nodes, "task-one");
  node(nodes, "issue-two");
  node(nodes, "find-cold-work-task-one", { type: "finding" });
  commit(repo, "one", "Spor: task-one");
  commit(repo, "two", "Spor: issue-two");
  assert.strictEqual(run(home, ["reconcile-landed", "--dir", repo]).status, 0);

  const r = run(home, ["reconcile-landed", "--confirm", "find-shipped-on-main-task-one", "find-shipped-on-main-issue-two", "find-cold-work-task-one"]);
  assert.strictEqual(r.status, 1, "one refused id makes the batch exit non-zero");
  assert.match(r.stdout, /confirmed: find-shipped-on-main-task-one — art-shipped-task-one resolves task-one \(done\)/);
  assert.match(r.stdout, /confirmed: find-shipped-on-main-issue-two — art-shipped-issue-two resolves issue-two \(resolved\)/);
  assert.match(r.stderr, /not confirmed: find-cold-work-task-one — not a reconcile-landed finding/);
  const g = load(nodes);
  assert.strictEqual(g.nodes["task-one"].status, "done");
  assert.strictEqual(g.nodes["issue-two"].status, "resolved");
  assert.strictEqual(g.nodes["art-shipped-task-one"].status, "merged");
  assert.ok(g.nodes["art-shipped-task-one"].edges.some((e) => e.type === "resolves" && e.to === "task-one"));
  assert.strictEqual(g.nodes["find-shipped-on-main-task-one"].status, "resolved");
  assert.strictEqual(resolution.resolutionMap(g)["task-one"].by, "art-shipped-task-one");

  // a second confirm of an already-closed finding refuses rather than re-acting
  const again = run(home, ["reconcile-landed", "--confirm", "find-shipped-on-main-task-one"]);
  assert.strictEqual(again.status, 1);
  assert.match(again.stderr, /not open/);
  // and a re-scan files nothing for the now-closed items
  const rescan = JSON.parse(run(home, ["reconcile-landed", "--dir", repo, "--json"]).stdout);
  assert.deepStrictEqual(rescan.hits, []);
});

test("a dismissed finding is never re-filed and its subject stays open", () => {
  const { home, nodes, repo } = scratch();
  node(nodes, "task-relates");
  commit(repo, "touches it", "Spor: task-relates");
  assert.strictEqual(run(home, ["reconcile-landed", "--dir", repo]).status, 0);
  assert.strictEqual(run(home, ["set-status", "find-shipped-on-main-task-relates", "dismissed"]).status, 0);
  const r = JSON.parse(run(home, ["reconcile-landed", "--dir", repo, "--json"]).stdout);
  assert.strictEqual(r.hits[0].finding.status, "skipped");
  const g = load(nodes);
  assert.strictEqual(g.nodes["find-shipped-on-main-task-relates"].status, "dismissed");
  assert.strictEqual(g.nodes["task-relates"].status, "open");
});

// --- remote mode: judged against /v1/export, written through /v1/nodes -------

test("remote mode reads the team graph from /v1/export and writes the pair through POST /v1/nodes with if_exists skip", async () => {
  const { home, nodes, repo } = scratch();
  node(nodes, "task-remote");
  commit(repo, "remote fix", "Spor: task-remote");
  const tar = require("../lib/tar.js");
  const tarball = tar.exportNodesDir(nodes).buffer;
  fs.rmSync(nodes, { recursive: true, force: true }); // the client must not read a local graph
  const posts = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "GET" && req.url.startsWith("/v1/export")) {
        res.writeHead(200, { "Content-Type": "application/x-tar" });
        return res.end(tarball);
      }
      if (req.method === "POST" && req.url === "/v1/nodes") {
        const j = JSON.parse(body);
        posts.push(j);
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ results: j.nodes.map((n) => ({ ok: true, status: "created", id: /\nid: (\S+)/.exec(n.node)[1] })) }));
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: "not_found", message: req.url } }));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const r = await runAsync(home, ["reconcile-landed", "--dir", repo], { SPOR_SERVER: `http://127.0.0.1:${srv.address().port}`, SPOR_TOKEN: "t" });
    assert.strictEqual(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /filed: find-shipped-on-main-task-remote/);
    assert.strictEqual(posts.length, 1);
    assert.deepStrictEqual(posts[0].nodes.map((n) => n.if_exists), ["skip", "skip"]);
    assert.deepStrictEqual(posts[0].nodes.map((n) => /\nid: (\S+)/.exec(n.node)[1]), ["art-shipped-task-remote", "find-shipped-on-main-task-remote"], "draft before its finding");
  } finally {
    srv.close();
  }
});

test("--confirm refuses a subject a person has closed since the scan, rather than re-closing over their decision", () => {
  const { home, nodes, repo } = scratch();
  node(nodes, "task-changed-mind");
  commit(repo, "fix", "Spor: task-changed-mind");
  assert.strictEqual(run(home, ["reconcile-landed", "--dir", repo]).status, 0);
  assert.strictEqual(run(home, ["set-status", "task-changed-mind", "abandoned"]).status, 0);
  const r = run(home, ["reconcile-landed", "--confirm", "find-shipped-on-main-task-changed-mind"]);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /subject is closed — nothing to close; dismiss the finding/);
  const g = load(nodes);
  assert.strictEqual(g.nodes["task-changed-mind"].status, "abandoned");
  assert.strictEqual(g.nodes["art-shipped-task-changed-mind"].status, "in-review", "the draft was not promoted");
  assert.ok(!g.nodes["art-shipped-task-changed-mind"].edges.some((e) => e.type === "resolves"));
});

test("kernel: an item under a factory execution hold, or explicitly excluded, is never a candidate", () => {
  const { nodes, repo } = scratch();
  node(nodes, "task-held", { extra: "execution: exec-0123456789abcdef\nexecution_at: 2026-09-26T00:00:00Z\n" });
  node(nodes, "task-own-item");
  node(nodes, "task-other");
  const g = load(nodes);
  const trailered = [{ sha: "a".repeat(40), subject: "s", ids: ["task-held", "task-own-item", "task-other"] }];
  const { hits, skipped } = kernel.plan({ graph: g, repo: "demo-repo", trailered, exclude: ["task-own-item"] });
  assert.deepStrictEqual(hits.map((h) => h.id), ["task-other"]);
  assert.deepStrictEqual(Object.fromEntries(skipped.map((s) => [s.id, s.reason])), { "task-held": "held", "task-own-item": "excluded" });
  assert.ok(repo);
});

test("with --since, a `commits:` stamp is matched against the range's own commits (abbreviated stamps too), not the whole ref", () => {
  const { home, nodes, repo } = scratch();
  const before = commit(repo, "landed long ago");
  const base = git(repo, "rev-parse", "HEAD");
  const inRange = commit(repo, "landed now");
  node(nodes, "task-old-stamp", { extra: `commits: [demo-repo@${before.slice(0, 9)}]\n` });
  node(nodes, "task-new-stamp", { extra: `commits: [demo-repo@${inRange.slice(0, 9)}]\n` });
  const res = JSON.parse(run(home, ["reconcile-landed", "--dir", repo, "--since", base, "--json", "--dry-run"]).stdout);
  assert.deepStrictEqual(res.hits.map((h) => [h.id, h.commits[0].sha]), [["task-new-stamp", inRange]]);
});

test("--confirm resumes a half-run confirm (draft already the live resolver) instead of calling the subject closed", () => {
  const { home, nodes, repo } = scratch();
  node(nodes, "task-half");
  commit(repo, "fix", "Spor: task-half");
  assert.strictEqual(run(home, ["reconcile-landed", "--dir", repo]).status, 0);
  // simulate a confirm that died after steps 1-2
  assert.strictEqual(run(home, ["set-status", "art-shipped-task-half", "merged"]).status, 0);
  assert.strictEqual(run(home, ["edge", "art-shipped-task-half", "resolves", "task-half"]).status, 0);
  const r = run(home, ["reconcile-landed", "--confirm", "find-shipped-on-main-task-half"]);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  const g = load(nodes);
  assert.strictEqual(g.nodes["task-half"].status, "done");
  assert.strictEqual(g.nodes["find-shipped-on-main-task-half"].status, "resolved");
});

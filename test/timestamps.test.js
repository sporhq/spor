// Git-derived timestamp index (dec-spor-git-derived-timestamps,
// task-spor-git-derived-timestamp-index). Two layers:
//   1. the PURE kernel fold/merge/override + cold-in-hot-neighborhood
//      (lib/kernel/timestamps.js) — data in, data out, no git;
//   2. the loadGraph integration over a real scratch git repo — cold build,
//      fast-forward incremental fold, exact-HEAD cache hit, history-rewrite full
//      rebuild, the frontmatter override seam, and the non-git fail-open — plus
//      the queue's cold_neighbors consumer and its byte-identical absence.

require("./helpers/tmp-cleanup"); // scratch-home leak guard (issue-spor-test-mkdtemp-inode-exhaustion)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ts = require("../lib/kernel/timestamps.js");
const graphLib = require("../lib/graph.js");
const { rankQueue } = require("../lib/queue.js");

// ---------- pure kernel: foldGitTimestamps ----------

// One commit block as `git log --name-only --format=%ct` emits it (newest first).
const block = (epoch, ...files) => [String(epoch), "", ...files.map((f) => `nodes/${f}`)].join("\n");

test("foldGitTimestamps: first commit = created_at, last = updated_at", () => {
  // newest-first emit order: dec-b touched once (Mar), task-a touched Jan + Mar
  const log = [
    block(1769904000, "dec-b.md", "task-a.md"), // 2026-02-01
    block(1767225600, "task-a.md"),             // 2026-01-01
  ].join("\n");
  const out = ts.foldGitTimestamps(log, "nodes");
  assert.equal(out["task-a"].created_at, new Date(1767225600 * 1000).toISOString());
  assert.equal(out["task-a"].updated_at, new Date(1769904000 * 1000).toISOString());
  // dec-b seen once -> created_at == updated_at
  assert.equal(out["dec-b"].created_at, out["dec-b"].updated_at);
  assert.equal(out["dec-b"].created_at, new Date(1769904000 * 1000).toISOString());
});

test("foldGitTimestamps: empty / null input -> empty map", () => {
  assert.deepEqual(ts.foldGitTimestamps("", "nodes"), {});
  assert.deepEqual(ts.foldGitTimestamps(null, "nodes"), {});
});

test("foldGitTimestamps: a numeric commit line can never be mistaken for a node path", () => {
  // a node id is [a-z0-9-]; a bare epoch is the commit time, never a file
  const out = ts.foldGitTimestamps(block(1700000000, "task-x.md"), "nodes");
  assert.deepEqual(Object.keys(out), ["task-x"]);
});

test("foldGitTimestamps: honors a non-default nodes dir name", () => {
  const log = ["1700000000", "", "graph/task-y.md"].join("\n");
  assert.deepEqual(Object.keys(ts.foldGitTimestamps(log, "graph")), ["task-y"]);
  // wrong dir name -> no match
  assert.deepEqual(ts.foldGitTimestamps(log, "nodes"), {});
});

// ---------- pure kernel: mergeTimestampMaps ----------

test("mergeTimestampMaps: composes a range fold (earlier created, later updated)", () => {
  const base = { "task-a": { created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" } };
  const add = {
    "task-a": { created_at: "2026-03-01T00:00:00.000Z", updated_at: "2026-03-01T00:00:00.000Z" }, // newer touch
    "task-b": { created_at: "2026-03-02T00:00:00.000Z", updated_at: "2026-03-02T00:00:00.000Z" }, // brand new
  };
  const m = ts.mergeTimestampMaps(base, add);
  assert.equal(m["task-a"].created_at, "2026-01-01T00:00:00.000Z"); // earlier kept
  assert.equal(m["task-a"].updated_at, "2026-03-01T00:00:00.000Z"); // later advanced
  assert.deepEqual(m["task-b"], add["task-b"]); // new node added whole
  // base is not mutated
  assert.equal(base["task-a"].updated_at, "2026-01-01T00:00:00.000Z");
});

// ---------- pure kernel: mergeTimestampOverrides ----------

test("mergeTimestampOverrides: explicit created_at WINS over git; .date is only a fallback", () => {
  const gitTs = {
    pinned: { created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z" },
    plain: { created_at: "2026-05-01T00:00:00.000Z", updated_at: "2026-05-02T00:00:00.000Z" },
  };
  const nodes = {
    pinned: { id: "pinned", created_at: "2020-09-09T00:00:00.000Z", date: "2026-01-01" }, // explicit override
    plain: { id: "plain", date: "2026-01-01" },   // .date present but git history is real
    nogit: { id: "nogit", date: "2026-02-02" },   // no git entry -> .date fallback
    bare: { id: "bare" },                          // nothing -> omitted
  };
  const out = ts.mergeTimestampOverrides(gitTs, nodes);
  assert.equal(out.pinned.created_at, "2020-09-09T00:00:00.000Z"); // explicit wins
  assert.equal(out.plain.created_at, "2026-05-01T00:00:00.000Z");  // git kept, .date does NOT override
  assert.equal(out.nogit.created_at, "2026-02-02");                // .date fills the hole
  assert.equal(out.nogit.updated_at, "2026-02-02");
  assert.ok(!("bare" in out));                                     // no derivable time -> omitted
});

// ---------- pure kernel: coldInHotNeighborhood ----------

test("coldInHotNeighborhood: counts strictly-newer neighbors; 0 without an index", () => {
  const graph = { adj: { a: [{ to: "b" }, { to: "c" }, { to: "d" }] } };
  const index = {
    a: { updated_at: "2026-01-01T00:00:00.000Z" },
    b: { updated_at: "2026-03-01T00:00:00.000Z" }, // newer
    c: { updated_at: "2026-02-01T00:00:00.000Z" }, // newer
    d: { updated_at: "2026-01-01T00:00:00.000Z" }, // same -> not strictly newer
  };
  assert.equal(ts.coldInHotNeighborhood(graph, "a", index), 2);
  assert.equal(ts.coldInHotNeighborhood(graph, "a", null), 0);   // no index
  assert.equal(ts.coldInHotNeighborhood(graph, "z", index), 0);  // no self timestamp
});

// ---------- integration: loadGraph over a real git repo ----------

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), "spor-ts-")); }
function git(dir, ...args) { execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" }); }
function initGraph() {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, "nodes"));
  git(home, "init", "-q");
  git(home, "config", "user.email", "t@t");
  git(home, "config", "user.name", "t");
  return home;
}
function node(home, id, type, body = "body", extra = "") {
  fs.writeFileSync(path.join(home, "nodes", `${id}.md`),
    `---\nid: ${id}\ntype: ${type}\ntitle: ${id}\nsummary: ${id} summary.\nstatus: open\ndate: 2026-01-01\n${extra}---\n${body}\n`);
}
function commit(home, when, msg) {
  git(home, "add", "-A");
  execFileSync("git", ["-C", home, "commit", "-q", "-m", msg],
    { stdio: "ignore", env: { ...process.env, GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when } });
}
const ISO = (s) => new Date(s).toISOString();

test("loadGraph: cold build derives created_at/updated_at and writes the HEAD-keyed cache", () => {
  const home = initGraph();
  node(home, "task-a", "task");
  commit(home, "2026-01-10T00:00:00Z", "create A");
  fs.appendFileSync(path.join(home, "nodes", "task-a.md"), "\nmore");
  commit(home, "2026-03-01T00:00:00Z", "update A");

  const g = graphLib.loadGraph(path.join(home, "nodes"));
  assert.equal(g.timestamps["task-a"].created_at, ISO("2026-01-10T00:00:00Z"));
  assert.equal(g.timestamps["task-a"].updated_at, ISO("2026-03-01T00:00:00Z"));

  const cache = JSON.parse(fs.readFileSync(path.join(home, "cache", "timestamps.json"), "utf8"));
  assert.equal(cache.head, execFileSync("git", ["-C", home, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
  assert.ok(cache.ts["task-a"]); // PURE git values cached (no override layer)
});

test("loadGraph: fast-forward reload folds only OLD..NEW (created_at preserved, updated_at advances)", () => {
  const home = initGraph();
  node(home, "task-a", "task");
  commit(home, "2026-01-10T00:00:00Z", "create A");
  void graphLib.loadGraph(path.join(home, "nodes")).timestamps; // access -> seed the cache at OLD head
  const oldHead = execFileSync("git", ["-C", home, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  fs.appendFileSync(path.join(home, "nodes", "task-a.md"), "\nmore");
  commit(home, "2026-05-01T00:00:00Z", "update A");
  const g = graphLib.loadGraph(path.join(home, "nodes"));
  assert.equal(g.timestamps["task-a"].created_at, ISO("2026-01-10T00:00:00Z")); // preserved
  assert.equal(g.timestamps["task-a"].updated_at, ISO("2026-05-01T00:00:00Z")); // advanced

  const cache = JSON.parse(fs.readFileSync(path.join(home, "cache", "timestamps.json"), "utf8"));
  assert.notEqual(cache.head, oldHead); // cache re-keyed to NEW head
});

test("loadGraph: exact-HEAD reload reuses the cache verbatim", () => {
  const home = initGraph();
  node(home, "task-a", "task");
  commit(home, "2026-01-10T00:00:00Z", "create A");
  const g1 = graphLib.loadGraph(path.join(home, "nodes"));
  const first = JSON.stringify(g1.timestamps);
  // Poison the cache with a sentinel created_at; an exact-HEAD hit must reuse it
  // (proving no git re-fold happened — a fresh fold would overwrite the sentinel).
  const cf = path.join(home, "cache", "timestamps.json");
  const cache = JSON.parse(fs.readFileSync(cf, "utf8"));
  cache.ts["task-a"].created_at = "1999-12-31T00:00:00.000Z";
  fs.writeFileSync(cf, JSON.stringify(cache));
  const g2 = graphLib.loadGraph(path.join(home, "nodes"));
  assert.equal(g2.timestamps["task-a"].created_at, "1999-12-31T00:00:00.000Z");
  assert.notEqual(JSON.stringify(g2.timestamps), first); // it really used the poisoned cache
});

test("loadGraph: a stale (non-ancestor) cache head forces a full rebuild", () => {
  const home = initGraph();
  node(home, "task-a", "task");
  commit(home, "2026-01-10T00:00:00Z", "create A");
  void graphLib.loadGraph(path.join(home, "nodes")).timestamps; // access -> seed the cache dir
  // Simulate a history rewrite: a cached head that is NOT an ancestor of current,
  // carrying a bogus value. isAncestor fails -> full rebuild -> correct value.
  const cf = path.join(home, "cache", "timestamps.json");
  fs.writeFileSync(cf, JSON.stringify({ head: "0".repeat(40), ts: { "task-a": { created_at: "1999-01-01T00:00:00.000Z", updated_at: "1999-01-01T00:00:00.000Z" } } }));
  const g = graphLib.loadGraph(path.join(home, "nodes"));
  assert.equal(g.timestamps["task-a"].created_at, ISO("2026-01-10T00:00:00Z")); // rebuilt from git, not the bogus cache
  const cache = JSON.parse(fs.readFileSync(cf, "utf8"));
  assert.equal(cache.head, execFileSync("git", ["-C", home, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
});

test("loadGraph: explicit frontmatter created_at overrides the git-derived value", () => {
  const home = initGraph();
  node(home, "task-a", "task", "body", "created_at: 2020-09-09T00:00:00.000Z\n");
  commit(home, "2026-01-10T00:00:00Z", "create A");
  const g = graphLib.loadGraph(path.join(home, "nodes"));
  assert.equal(g.timestamps["task-a"].created_at, "2020-09-09T00:00:00.000Z"); // pin wins
  assert.equal(g.timestamps["task-a"].updated_at, ISO("2026-01-10T00:00:00Z")); // updated still git-derived
});

// Git resolves its repo from GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR before it ever
// discovers one from `-C repoDir`, so an ambient var — a git hook, `git rebase
// --exec`, a wrapper script that exported one — used to misdirect gittime's git
// spawns at a wholly different repo no matter which directory loadGraph named
// (issue-spor-gittime-git-env-inheritance). gitSpawn (lib/shell/git-exec.js)
// scrubs those vars now, so the named directory wins.
test("loadGraph: an ambient GIT_DIR pointing at a DIFFERENT repo does not misdirect the timestamp fold", () => {
  const home = initGraph();
  node(home, "task-a", "task");
  commit(home, "2026-01-10T00:00:00Z", "create A");

  // An unrelated repo, carrying a node with the SAME id but a different
  // history, as the ambient var would name if it leaked through.
  const decoy = initGraph();
  node(decoy, "task-a", "task");
  commit(decoy, "2020-06-01T00:00:00Z", "decoy create A");

  const saved = {
    GIT_DIR: process.env.GIT_DIR,
    GIT_WORK_TREE: process.env.GIT_WORK_TREE,
    GIT_COMMON_DIR: process.env.GIT_COMMON_DIR,
  };
  process.env.GIT_DIR = path.join(decoy, ".git");
  process.env.GIT_WORK_TREE = decoy;
  try {
    const g = graphLib.loadGraph(path.join(home, "nodes"));
    // resolves from `home` (the named repo), never the ambient decoy
    assert.equal(g.timestamps["task-a"].created_at, ISO("2026-01-10T00:00:00Z"));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("loadGraph: a non-git home -> graph.timestamps is null (fail-open)", () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, "nodes"));
  node(home, "task-a", "task");
  const g = graphLib.loadGraph(path.join(home, "nodes"));
  assert.equal(g.timestamps, null);
});

test("loadGraph: timestamps is non-enumerable (no spread/JSON triggers the git fold)", () => {
  const home = initGraph();
  node(home, "task-a", "task");
  commit(home, "2026-01-10T00:00:00Z", "create A");
  const g = graphLib.loadGraph(path.join(home, "nodes"));
  assert.ok(!Object.keys(g).includes("timestamps")); // not enumerable
  assert.ok(Object.getOwnPropertyDescriptor(g, "timestamps").get); // it's a getter
});

// ---------- integration: the queue cold_neighbors consumer ----------

test("rankQueue: cold_neighbors signal + why-line when the index is injected", () => {
  const home = initGraph();
  // A relates to B and C; A created early, B and C updated later -> A is cold.
  node(home, "task-a", "task", "body", "edges:\n  - {type: relates-to, to: task-b}\n  - {type: relates-to, to: task-c}\n");
  node(home, "task-b", "task");
  node(home, "task-c", "task");
  commit(home, "2026-01-10T00:00:00Z", "create all");
  fs.appendFileSync(path.join(home, "nodes", "task-b.md"), "\nx");
  commit(home, "2026-03-01T00:00:00Z", "update B");
  fs.appendFileSync(path.join(home, "nodes", "task-c.md"), "\nx");
  commit(home, "2026-03-15T00:00:00Z", "update C");

  const g = graphLib.loadGraph(path.join(home, "nodes"));
  const r = rankQueue(g, { timestamps: g.timestamps, now: Date.parse("2026-04-01T00:00:00Z") });
  const a = r.items.find((it) => it.id === "task-a");
  assert.equal(a.signals.cold_neighbors, 2);
  assert.match(a.why, /context moved around it \(2 newer neighbors\)/);
  // task-b's only structural neighbor (task-a) is older -> no cold_neighbors key
  const b = r.items.find((it) => it.id === "task-b");
  assert.ok(!("cold_neighbors" in b.signals));
});

test("rankQueue: WITHOUT a timestamps index the signals shape is byte-identical (no cold_neighbors key)", () => {
  const home = initGraph();
  node(home, "task-a", "task", "body", "edges:\n  - {type: relates-to, to: task-b}\n");
  node(home, "task-b", "task");
  commit(home, "2026-01-10T00:00:00Z", "create");
  fs.appendFileSync(path.join(home, "nodes", "task-b.md"), "\nx");
  commit(home, "2026-03-01T00:00:00Z", "update B");
  const g = graphLib.loadGraph(path.join(home, "nodes"));
  const withTs = rankQueue(g, { timestamps: g.timestamps, now: Date.parse("2026-04-01T00:00:00Z") });
  const without = rankQueue(g, { now: Date.parse("2026-04-01T00:00:00Z") }); // no index injected
  // the no-index path never emits cold_neighbors for any item
  for (const it of without.items) assert.ok(!("cold_neighbors" in it.signals));
  // and the index path DOES surface it on the cold node, proving the difference is the index
  assert.equal(withTs.items.find((it) => it.id === "task-a").signals.cold_neighbors, 1);
});

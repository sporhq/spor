// document.test.js — complete document IO (task-spor-chatgpt-document-cli):
// the kernel's generation builder and chain read (lib/kernel/content.js), the
// local root-last publication with its recovery journal (lib/shell/document.js),
// and the CLI doors (`spor get --document`, `spor put-document`). Mode parity
// against the server's shapes is test/mode-parity.test.js. Scratch homes only.

require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { hermeticEnv } = require("./helpers/env.js");
const { gitEnv } = require("./helpers/git.js");

const content = require("../lib/kernel/content.js");
const documentShell = require("../lib/shell/document.js");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const SHELL = path.join(__dirname, "..", "lib", "shell", "document.js");

function source(id, { edit = "", paras = 400, type = "artifact", extra = "" } = {}) {
  const ps = [];
  for (let i = 1; i <= paras; i++) ps.push(`Paragraph ${i}${i === 3 ? edit : ""} — text ünïcode 😀.`);
  return `---\nid: ${id}\ntype: ${type}\ntitle: Doc ${id}\nsummary: A long document.\nstatus: active\ndate: 2026-10-09\n${extra}---\n\n${ps.join("\n\n")}\n`;
}
function home({ git = false } = {}) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "spor-document-"));
  fs.mkdirSync(path.join(h, "nodes"));
  if (git) spawnSync("git", ["init", "-q"], { cwd: h, env: gitEnv() });
  return h;
}
const nodes = (h) => path.join(h, "nodes");
const journal = (h) => path.join(h, "journal", "documents");
const put = (h, node, snapshot = null, opts = {}) =>
  documentShell.putDocument(nodes(h), { node, snapshot, journalDir: journal(h), ...opts });
const get = (h, id, revision = null) => documentShell.getDocument(nodes(h), { id, revision });
const cli = (h, args, input) =>
  spawnSync(process.execPath, [CLI, ...args], {
    cwd: h, input, encoding: "utf8",
    env: hermeticEnv({ SPOR_HOME: h, XDG_CONFIG_HOME: h, SPOR_MODE: "local" }),
  });
const core = (s) => content.documentCore(s.split("\n---\n").slice(1).join("\n---\n"));

// ---------- kernel ----------

test("kernel: a generation is content-addressed, under the cap, and reassembles exactly", () => {
  const src = source("dec-big", { type: "decision", paras: 900 });
  const a = content.documentGeneration(src, { prefixes: ["dec-"] });
  const b = content.documentGeneration(src, { prefixes: ["dec-"] });
  assert.ok(a.ok);
  assert.deepStrictEqual(a, b, "same body, same pieces");
  assert.ok(a.parts.length >= 3);
  a.parts.forEach((p, i) => assert.strictEqual(p.id, `art-decision-big-g${a.digest.slice(0, 8)}-${i + 2}`));
  for (const raw of [a.root, ...a.parts.map((p) => p.raw)]) {
    const body = raw.split("\n---\n")[1];
    assert.ok(Buffer.byteLength(body, "utf8") <= content.DOC_BODY_CAP, "every piece fits the body cap");
  }
  const bodies = [a.root, ...a.parts.map((p) => p.raw)].map((r) => r.slice(r.indexOf("\n---\n") + 5));
  assert.strictEqual(content.documentCore(content.spillReassemble(bodies)), core(src));
  assert.strictEqual(a.digest, content.documentDigest(core(src)));
  const edited = content.documentGeneration(source("dec-big", { type: "decision", paras: 900, edit: "!" }), { prefixes: ["dec-"] });
  assert.ok(edited.parts.every((p) => !a.parts.some((q) => q.id === p.id)), "an edit is a disjoint generation");
});

test("kernel: a root may not carry a part's stamps; old spill stamps are replaced", () => {
  const r = content.documentGeneration(source("art-x", { extra: "continuation_of: art-y\n" }));
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /continuation_of/);
  const g = content.documentGeneration(source("art-x", { paras: 2, extra: "spill_sha256: ab\nspill_bytes: 2\n" }));
  assert.doesNotMatch(g.root, /spill_/);
  assert.match(g.root, /\ndoc_sha256: [0-9a-f]{64}\ndoc_bytes: \d+\n---\n/);
  assert.deepStrictEqual(g.parts, [], "a fitting body is a one-piece generation");
});

test("kernel: the chain read never substitutes — missing, foreign, edited, pinned legacy", () => {
  const g = content.documentGeneration(source("art-d", { paras: 700 }));
  const fm = (raw) => require("../lib/kernel/frontmatter.js").parseFrontmatter(raw, "x.md");
  const store = new Map(g.parts.map((p) => [p.id, { raw: p.raw, frontmatter: fm(p.raw) }]));
  const root = { raw: g.root, frontmatter: fm(g.root) };
  const read = () => content.readDocumentChain(root, (id) => store.get(id) || null);
  assert.deepStrictEqual({ ...read(), body: undefined }, { body: undefined, parts: g.parts.map((p) => p.id), complete: true, generation: g.digest });
  // an edited part: the chain still walks, the digest catches it
  const p2 = g.parts[0];
  store.set(p2.id, { raw: p2.raw.replace("Paragraph", "PARAGRAPH"), frontmatter: fm(p2.raw) });
  assert.deepStrictEqual([read().complete, read().integrity_failed], [false, true]);
  // a re-stamped (foreign) part reads as missing, never spliced in
  store.set(p2.id, { raw: p2.raw.replace(/doc_generation: \w+/, `doc_generation: ${"0".repeat(64)}`), frontmatter: fm(p2.raw.replace(/doc_generation: \w+/, `doc_generation: ${"0".repeat(64)}`)) });
  assert.deepStrictEqual([read().complete, read().missing, read().parts.length], [false, p2.id, 0]);
  store.delete(p2.id);
  assert.strictEqual(read().missing, p2.id);
  // a legacy root pinned to a revision cannot be reproduced
  const legacy = "---\nid: art-l\ntype: artifact\n---\n\nhead\n_(continues in art-l-2)_\n";
  const pinned = content.readDocumentChain({ raw: legacy, frontmatter: fm(legacy) }, () => null, { pinned: true });
  assert.strictEqual(pinned.history_unavailable, true);
});

// ---------- local publication ----------

test("local: create, read exactly, edit from the snapshot, pin the old revision", () => {
  const h = home({ git: true });
  const v1 = put(h, source("art-doc"));
  assert.strictEqual(v1.status, "created");
  const r1 = get(h, "art-doc");
  assert.ok(r1.ok && r1.document.complete);
  assert.strictEqual(content.documentCore(r1.document.body), core(source("art-doc")));
  assert.strictEqual(r1.document.doc_sha256, v1.generation);
  // edit FROM the returned source, as a client would
  const v2src = r1.document.source.replace("Paragraph 3 ", "Paragraph 3 (edited) ");
  const v2 = put(h, v2src, r1.document.snapshot);
  assert.strictEqual(v2.status, "updated");
  const r2 = get(h, "art-doc").document;
  assert.strictEqual(r2.body, r1.document.body.replace("Paragraph 3 ", "Paragraph 3 (edited) "), "the read returns the edited body exactly");
  assert.strictEqual(r2.source, fs.readFileSync(path.join(nodes(h), "art-doc.md"), "utf8").split("\n---\n")[0] + "\n---\n" + r2.body,
    "the source is the root's (restamped) frontmatter over the whole body");
  const old = get(h, "art-doc", v1.revision);
  assert.ok(old.ok, old.message);
  assert.strictEqual(old.document.source, r1.document.source, "the old root revision reproduces v1");
  // a lost-answer retry mints nothing
  const files = fs.readdirSync(nodes(h)).length;
  assert.strictEqual(put(h, v2src, r1.document.snapshot).status, "unchanged");
  assert.strictEqual(fs.readdirSync(nodes(h)).length, files);
});

test("local: long edits conflict safely — stale root, moved legacy part, squatted part, part id", () => {
  const h = home();
  const v1 = put(h, source("art-doc"));
  const a = put(h, source("art-doc", { edit: " A" }), v1.snapshot);
  assert.strictEqual(a.status, "updated");
  const b = put(h, source("art-doc", { edit: " B" }), v1.snapshot);
  assert.deepStrictEqual([b.ok, b.code, b.revision], [false, "conflict", a.revision], "the second edit from one snapshot is refused");
  assert.match(get(h, "art-doc").document.body, /Paragraph 3 A/, "and the first edit stands whole");
  assert.strictEqual(put(h, source("art-doc", { edit: " C" })).code, "conflict", "a create over an existing root");
  assert.strictEqual(put(h, source("art-new"), a.snapshot).code, "bad_request", "a snapshot of another document");
  assert.strictEqual(put(h, source("art-new"), { ...a.snapshot, root: "art-new" }).code, "not_found");

  // a legacy spill whose part moved under an unchanged root
  fs.writeFileSync(path.join(nodes(h), "art-legacy.md"), "---\nid: art-legacy\ntype: artifact\ntitle: L\nsummary: s\nstatus: active\ndate: 2026-10-01\n---\n\nhead\n_(continues in art-legacy-2)_\n");
  const partFile = path.join(nodes(h), "art-legacy-2.md");
  fs.writeFileSync(partFile, "---\nid: art-legacy-2\ntype: artifact\ntitle: L2\nsummary: s\nstatus: active\ndate: 2026-10-01\ncontinuation_of: art-legacy\nedges:\n  - {type: derived-from, to: art-legacy}\n---\n\n_(continued from art-legacy)_\ntail\n");
  const leg = get(h, "art-legacy").document;
  assert.deepStrictEqual([leg.complete, leg.managed, leg.parts.length], [true, false, 1]);
  fs.appendFileSync(partFile, "more\n");
  const moved = put(h, leg.source, leg.snapshot);
  assert.strictEqual(moved.code, "conflict");
  assert.match(moved.message, /legacy spill part vector differs/);
  const fresh = get(h, "art-legacy").document;
  assert.strictEqual(put(h, fresh.source, fresh.snapshot).status, "updated", "migrates to a generation from a fresh read");
  assert.strictEqual(get(h, "art-legacy").document.managed, true);

  // a squatted generation id is never adopted
  const src = source("art-sq");
  const gen = content.documentGeneration(src);
  fs.writeFileSync(path.join(nodes(h), `${gen.parts[0].id}.md`), gen.parts[0].raw.replace("Paragraph", "Squat"));
  const sq = put(h, src);
  assert.strictEqual(sq.code, "conflict");
  assert.ok(!fs.existsSync(path.join(nodes(h), "art-sq.md")), "nothing published");
  // a part is never published as a document of its own
  const part = put(h, fs.readFileSync(path.join(nodes(h), `${a.parts[0]}.md`), "utf8").replace(/continuation_of: .*\n|doc_generation: .*\n/g, ""));
  assert.strictEqual(part.code, "conflict");
  assert.match(part.message, /continuation part of 'art-doc'/);
});

test("local: a refused piece writes nothing", () => {
  const h = home();
  const r = put(h, source("art-v"), null, { validate: () => ({ errors: ["art-v.md: bogus"], warnings: [] }) });
  assert.deepStrictEqual([r.ok, r.code], [false, "invalid_node"]);
  assert.deepStrictEqual(fs.readdirSync(nodes(h)), []);
  assert.deepStrictEqual(fs.readdirSync(journal(h)).filter((f) => !f.endsWith(".lock")), []);
});

// ---------- restart recovery: the publisher really dies ----------

// Publish in a child process that exits at `stage` (the at() seam), as a kill
// would: no finally, no rollback.
function dieAt(h, node, snapshot, stage) {
  const script = `
    const d = require(${JSON.stringify(SHELL)});
    d.putDocument(${JSON.stringify(nodes(h))}, {
      node: ${JSON.stringify(node)}, snapshot: ${JSON.stringify(snapshot)}, journalDir: ${JSON.stringify(journal(h))},
      at: (s) => { if (s === ${JSON.stringify(stage)}) process.exit(137); },
    });
    process.exit(0);`;
  const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  assert.strictEqual(r.status, 137, r.stderr);
}

for (const stage of ["journaled", "parts", "hashed", "root"]) {
  test(`local restart recovery: death after ${stage} leaves the old or the whole new document, and the next publication recovers`, () => {
    const h = home({ git: true });
    const v1 = put(h, source("art-doc"));
    const before = new Set(fs.readdirSync(nodes(h)));
    const v2src = source("art-doc", { edit: " (v2)" });
    dieAt(h, v2src, v1.snapshot, stage);
    // A dead publisher's lock and intent are left behind.
    assert.ok(fs.readdirSync(journal(h)).some((f) => f.startsWith("art-doc.lock-")));
    assert.ok(fs.existsSync(path.join(journal(h), "art-doc.publish.json")));
    const mid = get(h, "art-doc").document;
    assert.strictEqual(mid.complete, true, "never a mix");
    const landed = stage === "root";
    assert.strictEqual(content.documentCore(mid.body), core(landed ? v2src : source("art-doc")));

    // The CLI's next publication (of anything) recovers it and says so.
    const r = cli(h, ["put-document", "-"], source("art-other", { paras: 2 }));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, new RegExp(`recovered an interrupted publication of 'art-doc' \\(${landed ? "landed" : "rolled-back"}`));
    assert.ok(!fs.existsSync(path.join(journal(h), "art-doc.publish.json")), "the intent is settled");
    const after = new Set(fs.readdirSync(nodes(h)).filter((f) => f !== "art-other.md"));
    if (!landed) assert.deepStrictEqual([...after].sort(), [...before].sort(), "orphaned parts removed");
    // and the edit (re)publishes cleanly against a fresh read
    const cur = get(h, "art-doc").document;
    const again = put(h, v2src, cur.snapshot);
    assert.strictEqual(again.status, landed ? "unchanged" : "updated");
    assert.strictEqual(content.documentCore(get(h, "art-doc").document.body), core(v2src));
    assert.strictEqual(content.documentCore(get(h, "art-doc", v1.revision).document.body), core(source("art-doc")), "v1 still pinned");
  });
}

test("local: a live publication's lock is a conflict; a dead holder's is ignored and pruned", () => {
  const h = home();
  fs.mkdirSync(journal(h), { recursive: true });
  const live = path.join(journal(h), `art-doc.lock-${process.ppid}-${Date.now()}-ab12`);
  fs.writeFileSync(live, "");
  const r = put(h, source("art-doc"));
  assert.strictEqual(r.code, "conflict");
  assert.match(r.message, /another publication of 'art-doc' is in progress/);
  assert.ok(!fs.existsSync(path.join(nodes(h), "art-doc.md")));
  assert.ok(fs.existsSync(live), "never another contender's lock to delete");
  fs.unlinkSync(live);
  // A dead pid past the horizon: ignored by every contender, then reaped.
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
  const stale = path.join(journal(h), `art-doc.lock-${dead}-${Date.now() - documentShell.LOCK_TTL_MS - 1000}-cd34`);
  fs.writeFileSync(stale, "");
  assert.strictEqual(put(h, source("art-doc")).status, "created");
  assert.ok(!fs.existsSync(stale));
  assert.deepStrictEqual(fs.readdirSync(journal(h)), [], "our own lock is released");
});

test("local: a second publisher arriving mid-publication is refused and cannot touch the first's parts", () => {
  const h = home();
  const v1 = put(h, source("art-doc"));
  let second = null;
  const first = put(h, source("art-doc", { edit: " A" }), v1.snapshot, {
    at: (stage) => {
      if (stage !== "parts") return;
      // Another process (a lock held by this pid is this pid's own to ignore).
      const script = `
        const d = require(${JSON.stringify(SHELL)});
        const r = d.putDocument(${JSON.stringify(nodes(h))}, {
          node: ${JSON.stringify(source("art-doc", { edit: " B" }))}, snapshot: ${JSON.stringify(v1.snapshot)},
          journalDir: ${JSON.stringify(journal(h))},
        });
        process.stdout.write(JSON.stringify(r));`;
      second = JSON.parse(spawnSync(process.execPath, ["-e", script], { encoding: "utf8" }).stdout);
    },
  });
  assert.deepStrictEqual([second.ok, second.code], [false, "conflict"]);
  assert.strictEqual(first.status, "updated");
  const read = get(h, "art-doc").document;
  assert.ok(read.complete, "the first publication's root names parts that all stand");
  assert.match(read.body, /Paragraph 3 A/);
});

test("local restart recovery: a root that landed and then moved keeps its parts (the landed revision stays whole)", () => {
  const h = home({ git: true });
  const v1 = put(h, source("art-doc"));
  const v2src = source("art-doc", { edit: " (v2)" });
  dieAt(h, v2src, v1.snapshot, "root");
  const landed = documentShell.readNodeFile(nodes(h), "art-doc").revision;
  // The root moves through another door before any publication recovers.
  fs.writeFileSync(path.join(nodes(h), "art-doc.md"), "---\nid: art-doc\ntype: artifact\ntitle: T\nsummary: s\n---\nreplaced\n");
  const rec = documentShell.recoverPublication(nodes(h), journal(h), "art-doc");
  assert.deepStrictEqual([rec.outcome, rec.removed], ["kept", []]);
  const pinned = get(h, "art-doc", landed);
  assert.ok(pinned.ok && pinned.document.complete, "the revision that landed still reads whole");
  assert.strictEqual(content.documentCore(pinned.document.body), core(v2src));
});

test("local: a git hash failure refuses the publication before the root is replaced (issue-spor-document-cli-root-written-before-hashed)", { skip: process.platform === "win32" && "a /bin/sh git shim and POSIX directory modes" }, () => {
  const h = home({ git: true });
  const v1 = put(h, source("art-doc"));
  const before = new Set(fs.readdirSync(nodes(h)));
  const rootBytes = fs.readFileSync(path.join(nodes(h), "art-doc.md"));
  const objects = path.join(h, ".git", "objects");
  const chmodAll = (dir, mode) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) chmodAll(path.join(dir, e.name), mode);
    fs.chmodSync(dir, mode);
  };
  const refused = (r, why) => {
    assert.deepStrictEqual([r.ok, r.code], [false, "internal"], JSON.stringify(r));
    assert.match(r.details.join("\n"), why);
    assert.ok(fs.readFileSync(path.join(nodes(h), "art-doc.md")).equals(rootBytes), "the old root is untouched");
    assert.deepStrictEqual([...fs.readdirSync(nodes(h))].sort(), [...before].sort(), "the parts already written are rolled back");
    assert.ok(!fs.existsSync(path.join(journal(h), "art-doc.publish.json")), "the intent is settled");
    assert.strictEqual(content.documentCore(get(h, "art-doc", v1.revision).document.body), core(source("art-doc")), "v1 still reads");
  };
  let r;
  if (process.getuid?.() !== 0) { // root ignores directory permissions
    chmodAll(objects, 0o555);
    try {
      r = put(h, source("art-doc", { edit: " (v2)" }), v1.snapshot);
    } finally {
      chmodAll(objects, 0o755);
    }
    refused(r, /git hash-object failed/);
  }
  // a git that fails hash-object, and one answering another id than the
  // bytes' revision, through a PATH shim
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  const shimmed = (hashObject, node) => {
    const fakeGit = fs.mkdtempSync(path.join(os.tmpdir(), "spor-document-git-"));
    fs.writeFileSync(path.join(fakeGit, "git"), `#!/bin/sh\nif [ "$1" = hash-object ]; then cat >/dev/null; ${hashObject}; fi\nexec ${realGit} "$@"\n`, { mode: 0o755 });
    const PATH = process.env.PATH;
    process.env.PATH = `${fakeGit}${path.delimiter}${PATH}`;
    try {
      return put(h, node, v1.snapshot);
    } finally {
      process.env.PATH = PATH;
    }
  };
  refused(shimmed("echo 'fatal: cannot write' >&2; exit 128", source("art-doc", { edit: " (v2)" })), /git hash-object failed: fatal: cannot write/);
  refused(shimmed(`echo ${"0".repeat(40)}; exit 0`, source("art-doc", { edit: " (v3)" })), /git hash-object answered/);
  // and the same edit publishes once git works
  assert.strictEqual(put(h, source("art-doc", { edit: " (v2)" }), v1.snapshot).status, "updated");
  assert.strictEqual(content.documentCore(get(h, "art-doc", v1.revision).document.body), core(source("art-doc")), "v1 pinned after the overwrite");
});

test("local: git failing to say whether the home is a repository refuses with nothing written", { skip: process.platform === "win32" && "a /bin/sh git shim and POSIX directory modes" }, () => {
  const h = home({ git: true });
  const v1 = put(h, source("art-doc"));
  const before = new Set(fs.readdirSync(nodes(h)));
  const fakeGit = fs.mkdtempSync(path.join(os.tmpdir(), "spor-document-git-"));
  fs.writeFileSync(path.join(fakeGit, "git"), "#!/bin/sh\necho 'fatal: something broke' >&2\nexit 128\n", { mode: 0o755 });
  const PATH = process.env.PATH;
  process.env.PATH = `${fakeGit}${path.delimiter}${PATH}`;
  let r;
  try {
    r = put(h, source("art-doc", { edit: " (v2)" }), v1.snapshot);
  } finally {
    process.env.PATH = PATH;
  }
  assert.deepStrictEqual([r.ok, r.code], [false, "internal"]);
  assert.match(r.details.join("\n"), /something broke/);
  assert.deepStrictEqual([...fs.readdirSync(nodes(h))].sort(), [...before].sort());
  assert.ok(!fs.existsSync(path.join(journal(h), "art-doc.publish.json")));
});

test("local: a root write that fails after the stage-root intent still rolls the parts back", () => {
  const h = home({ git: true });
  const v1 = put(h, source("art-doc"));
  const before = new Set(fs.readdirSync(nodes(h)));
  const rootFile = path.join(nodes(h), "art-doc.md");
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === rootFile) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    return rename(from, to);
  };
  let r;
  try {
    r = put(h, source("art-doc", { edit: " (v2)" }), v1.snapshot);
  } finally {
    fs.renameSync = rename;
  }
  assert.deepStrictEqual([r.ok, r.code], [false, "internal"]);
  assert.match(r.details.join("\n"), /ENOSPC/);
  assert.strictEqual(documentShell.readNodeFile(nodes(h), "art-doc").revision, v1.revision);
  assert.deepStrictEqual([...fs.readdirSync(nodes(h))].sort(), [...before].sort(), "no part left behind");
  assert.ok(!fs.existsSync(path.join(journal(h), "art-doc.publish.json")));
});

test("local restart recovery: a pre-stage intent (v1) still decides by the object store", () => {
  const h = home({ git: true });
  const v1 = put(h, source("art-doc"));
  const v2src = source("art-doc", { edit: " (v2)" });
  const gen = content.documentGeneration(v2src);
  for (const p of gen.parts) fs.writeFileSync(path.join(nodes(h), `${p.id}.md`), p.raw);
  fs.mkdirSync(journal(h), { recursive: true });
  fs.writeFileSync(path.join(journal(h), "art-doc.publish.json"), JSON.stringify({
    id: "art-doc", digest: gen.digest, prior: v1.revision, root: documentShell.gitBlobSha(Buffer.from(gen.root)),
    fresh: gen.parts.map((p) => ({ id: p.id, revision: documentShell.gitBlobSha(Buffer.from(p.raw)) })),
  }));
  const rec = documentShell.recoverPublication(nodes(h), journal(h), "art-doc");
  assert.deepStrictEqual([rec.outcome, rec.removed.length], ["rolled-back", gen.parts.length]);
});

test("local restart recovery: a death between the stage-root intent and the root write keeps the parts (not proof either way)", () => {
  const h = home({ git: true });
  const v1 = put(h, source("art-doc"));
  const v2src = source("art-doc", { edit: " (v2)" });
  // Die right after the stage-`root` intent lands: the root write is next.
  const script = `
    const fs = require("node:fs");
    const d = require(${JSON.stringify(SHELL)});
    const write = fs.renameSync;
    fs.renameSync = (from, to) => {
      write(from, to);
      if (to.endsWith("art-doc.publish.json") && JSON.parse(fs.readFileSync(to, "utf8")).stage === "root") process.exit(137);
    };
    d.putDocument(${JSON.stringify(nodes(h))}, {
      node: ${JSON.stringify(v2src)}, snapshot: ${JSON.stringify(v1.snapshot)}, journalDir: ${JSON.stringify(journal(h))},
    });
    process.exit(0);`;
  const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  assert.strictEqual(r.status, 137, r.stderr);
  const intent = JSON.parse(fs.readFileSync(path.join(journal(h), "art-doc.publish.json"), "utf8"));
  assert.strictEqual(intent.hashed.length, 1 + intent.fresh.length + 1, "the prior root, every fresh part and the new root were hashed");
  assert.strictEqual(intent.hashed.at(-1), intent.root);
  assert.strictEqual(documentShell.readNodeFile(nodes(h), "art-doc").revision, v1.revision);
  const rec = documentShell.recoverPublication(nodes(h), journal(h), "art-doc");
  assert.deepStrictEqual([rec.outcome, rec.removed], ["kept", []]);
  assert.strictEqual(content.documentCore(get(h, "art-doc").document.body), core(source("art-doc")));
});

// ---------- the CLI doors ----------

test("cli: get without --document is unchanged; --revision needs --document", () => {
  const h = home();
  put(h, source("art-doc"));
  const raw = fs.readFileSync(path.join(nodes(h), "art-doc.md"), "utf8");
  const plain = cli(h, ["get", "art-doc"]);
  assert.strictEqual(plain.status, 0);
  assert.strictEqual(plain.stdout, `${raw}\n`, "the raw root file, as before");
  const json = JSON.parse(cli(h, ["get", "art-doc", "--json"]).stdout);
  assert.deepStrictEqual(Object.keys(json), ["id", "frontmatter", "body", "edges", "revision"]);
  assert.strictEqual(json.revision, documentShell.readNodeFile(nodes(h), "art-doc").revision);
  const bad = cli(h, ["get", "art-doc", "--revision", json.revision]);
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /--revision is only valid with --document/);
});

test("cli: put-document validates pieces against the graph and takes a whole get --json answer as --snapshot", () => {
  const h = home();
  const created = cli(h, ["put-document", "-"], source("art-doc"));
  assert.strictEqual(created.status, 0, created.stderr);
  assert.match(created.stdout, /^put-document created: art-doc @ [0-9a-f]{40}, generation [0-9a-f]{8} \(\+ generation parts /);
  const read = cli(h, ["get", "art-doc", "--document", "--json"]);
  fs.writeFileSync(path.join(h, "read.json"), read.stdout);
  const upd = cli(h, ["put-document", "-", "--snapshot", path.join(h, "read.json"), "--json"], source("art-doc", { edit: " x" }));
  assert.strictEqual(upd.status, 0, upd.stderr);
  assert.strictEqual(JSON.parse(upd.stdout).status, "updated");
  const invalid = cli(h, ["put-document", "-"], source("art-bad").replace("summary: A long document.\n", ""));
  assert.strictEqual(invalid.status, 1);
  assert.match(invalid.stderr, /^put-document: document 'art-bad' refused \(invalid_node\)/);
  assert.ok(!fs.existsSync(path.join(nodes(h), "art-bad.md")));
  const badSnap = cli(h, ["put-document", "-", "--snapshot", "{\"root\":\"art-doc\"}"], source("art-doc"));
  assert.strictEqual(badSnap.status, 1);
  assert.match(badSnap.stderr, /invalid document snapshot/);
});

// ---------- goldens: the port answers what spor-server answers ----------
// Recorded from the server's OWN documentGeneration / readDocument by
// test/helpers/record-document-goldens.js; inputs are the cases beside them.
// The parity rows in mode-parity.test.js compare this module with itself
// through the stub, so THIS is what pins it to the server.
test("goldens: documentGeneration and the chain read match spor-server byte-for-byte", () => {
  const goldens = require("./fixtures/document-generations/goldens.json");
  const cases = require("./fixtures/document-generations/cases.js");
  const h = (t) => require("node:crypto").createHash("sha256").update(String(t), "utf8").digest("hex");
  const PREFIXES = { decision: ["dec-"], artifact: ["art-"], task: ["task-"], person: ["person-"] };
  assert.strictEqual(goldens.generations.length, cases.generations.length);
  cases.generations.forEach((c, i) => {
    const want = goldens.generations[i];
    assert.strictEqual(want.name, c.name);
    const type = /\ntype: (\w+)/.exec(c.source.replace(/\r/g, ""))[1];
    const r = content.documentGeneration(c.source, { prefixes: PREFIXES[type], today: c.today });
    const got = r.ok
      ? { ok: true, id: r.id, digest: r.digest, bytes: r.bytes, root_sha256: h(r.root), parts: r.parts.map((p) => ({ id: p.id, sha256: h(p.raw) })) }
      : { ok: false, message: r.message };
    assert.deepStrictEqual(got, want.expect, c.name);
  });
  const fm = require("../lib/kernel/frontmatter.js");
  const reads = cases.reads();
  assert.strictEqual(goldens.reads.length, reads.length);
  reads.forEach((c, i) => {
    const want = goldens.reads[i];
    assert.strictEqual(want.name, c.name);
    const node = (raw) => ({ raw, frontmatter: fm.parseFrontmatter(raw, "x.md") });
    const root = node(c.pinned || c.files[c.root]);
    const r = content.readDocumentChain(root, (id) => (c.files[id] ? node(c.files[id]) : null), { pinned: !!c.pinned });
    // The server names the pinned revision it read; the kernel leaves that to
    // the caller (the shell's answer carries it), so set it aside.
    const { revision: _rev, body_sha256, ...expect } = want.expect;
    const { body, ...got } = r;
    assert.deepStrictEqual(got, expect, c.name);
    assert.strictEqual(h(body), body_sha256, `${c.name}: body`);
  });
});

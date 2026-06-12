// Zero-dependency test suite for lib/graph.js. Run: node --test test/
//
// Builds scratch fixture graphs under os.tmpdir() (NEVER ~/.substrate), then
// exercises: frontmatter parsing (folded scalars, pin/exclude lists, edges),
// the digest relevance gate, supersession fixup + the ⚠ warning, correction
// pin/exclude, and validateNode/validateGraph accept/reject cases.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const graph = require(path.join(__dirname, "..", "lib", "graph.js"));

// ---------- fixture helpers ----------

function tmpGraph(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "substrate-test-"));
  const nodesDir = path.join(dir, "nodes");
  fs.mkdirSync(nodesDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(nodesDir, name), content);
  }
  return { dir, nodesDir, load: () => graph.loadGraph(nodesDir) };
}

// A small but format-exercising corpus reused by several tests.
function pricingFixture() {
  return tmpGraph({
    "spec-rc.md": `---
id: spec-rc
type: artifact
project: my-project
title: Reliability cost spec
summary: The reliability versus cost target spec that bounds catalogue
  pricing decisions and the recovery objectives every plan must respect.
date: 2026-06-01
---
Body of the reliability cost spec about pricing envelopes.
`,
    "dec-old.md": `---
id: dec-old
type: decision
project: my-project
title: Single provider pricing
summary: Old single-provider catalogue pricing decision, later superseded.
date: 2026-06-02
edges:
  - {type: derived-from, to: spec-rc}
---
We priced the catalogue against one provider. This is stale now.
`,
    "dec-new.md": `---
id: dec-new
type: decision
project: my-project
title: Provider neutral catalogue pricing
summary: The catalogue prices provider-neutral with composed and plan pricing.
date: 2026-06-09
edges:
  - {type: supersedes, to: dec-old}
  - {type: constrained-by, to: spec-rc}
---
The catalogue is now provider-neutral, removing single-provider lock-in.
`,
    "norm-ids.md": `---
id: norm-ids
type: norm
project: my-project
title: Kebab-case ids
summary: Node ids are kebab-case with a type prefix; rides along every compile.
date: 2026-05-20
---
Ids are kebab-case and prefixed by type.
`,
    "art-stale.md": `---
id: art-stale
type: artifact
project: my-project
title: Stale pricing notes
summary: Old pricing scratch notes that should be excluded from compiles.
date: 2026-04-01
---
Old pricing notes about the catalogue, kept only for history.
`,
    "spec-actor.md": `---
id: spec-actor
type: artifact
project: my-project
title: Actor model pricing engine spec
summary: The actor-model concurrency design used by the pricing engine.
date: 2026-05-25
---
An actor per plan serializes pricing recomputes.
`,
    "corr-global-1.md": `---
id: corr-global-1
type: correction
title: Pin actor spec, exclude stale notes
target: global
pin: [spec-actor]
exclude: [art-stale]
date: 2026-06-10
---
Always surface the actor-model spec and never the stale pricing notes.
`,
  });
}

// ---------- frontmatter parsing ----------

test("parseFrontmatter: folded multi-line summary is joined with single spaces", () => {
  const raw = `---
id: dec-x
type: decision
title: A thing
summary: line one
  line two
  line three
date: 2026-06-01
---
Body text.
`;
  const n = graph.parseFrontmatter(raw, "dec-x.md");
  assert.equal(n.summary, "line one line two line three");
  assert.equal(n.body, "Body text.");
  assert.equal(n.title, "A thing");
});

test("parseFrontmatter: pin and exclude inline lists parse to arrays", () => {
  const raw = `---
id: corr-x
type: correction
title: c
target: global
pin: [spec-a, spec-b ,spec-c]
exclude: [art-z]
date: 2026-06-01
---
guidance
`;
  const n = graph.parseFrontmatter(raw, "corr-x.md");
  assert.deepEqual(n.pin, ["spec-a", "spec-b", "spec-c"]);
  assert.deepEqual(n.exclude, ["art-z"]);
});

test("parseFrontmatter: empty pin/exclude lists parse to empty arrays", () => {
  const raw = `---
id: corr-y
type: correction
title: c
target: global
pin: []
exclude: []
date: 2026-06-01
---
g
`;
  const n = graph.parseFrontmatter(raw, "corr-y.md");
  assert.deepEqual(n.pin, []);
  assert.deepEqual(n.exclude, []);
});

test("parseFrontmatter: commits inline list parses to repo@sha strings", () => {
  const raw = `---
id: task-c
type: task
title: t
summary: s
commits: [wf@0123abc, spor@deadbeefcafe]
date: 2026-06-01
---
b
`;
  const n = graph.parseFrontmatter(raw, "task-c.md");
  assert.deepEqual(n.commits, ["wf@0123abc", "spor@deadbeefcafe"]);
});

test("parseFrontmatter: edge lines parse to {type,to} objects", () => {
  const raw = `---
id: dec-e
type: decision
title: t
summary: s
date: 2026-06-01
edges:
  - {type: supersedes, to: dec-old}
  - {type: derived-from, to: spec-rc}
---
b
`;
  const n = graph.parseFrontmatter(raw, "dec-e.md");
  assert.deepEqual(n.edges, [
    { type: "supersedes", to: "dec-old" },
    { type: "derived-from", to: "spec-rc" },
  ]);
});

test("parseFrontmatter: strips surrounding quotes from scalar values", () => {
  const raw = `---
id: dec-q
type: decision
title: "Quoted title"
summary: 's'
date: 2026-06-01
---
b
`;
  const n = graph.parseFrontmatter(raw, "dec-q.md");
  assert.equal(n.title, "Quoted title");
  assert.equal(n.summary, "s");
});

test("parseFrontmatter: throws when there is no frontmatter", () => {
  assert.throws(() => graph.parseFrontmatter("just a body\n", "bad.md"), /no frontmatter/);
});

// ---------- digest relevance gate ----------

test("digest gate: gibberish query returns relevant:false (nothing to inject)", () => {
  const g = pricingFixture().load();
  const r = graph.compile(g, { query: "gibberish zzz qqq wibble", digest: true });
  assert.equal(r.relevant, false);
  assert.equal(r.text, undefined);
});

test("digest gate: relevant query returns text and picks", () => {
  const g = pricingFixture().load();
  const r = graph.compile(g, { query: "provider neutral catalogue pricing", digest: true });
  assert.equal(r.relevant, true);
  assert.ok(r.text.includes("dec-new"));
  assert.ok(r.text.length > 0);
});

test("digest gate: minSim of 1 (impossible) gates out an otherwise-relevant query", () => {
  const g = pricingFixture().load();
  const r = graph.compile(g, { query: "provider neutral catalogue pricing", digest: true, minSim: 1.0 });
  assert.equal(r.relevant, false);
});

// ---------- supersession fixup + warning ----------

test("supersession: superseded node carries the inline ⚠ SUPERSEDED warning in full compile", () => {
  const g = pricingFixture().load();
  const r = graph.compile(g, { rootId: "dec-new", digest: false });
  assert.equal(r.relevant, true);
  // dec-old is superseded by dec-new; it must appear flagged.
  assert.match(r.text, /dec-old/);
  assert.match(r.text, /⚠ SUPERSEDED by dec-new/);
});

test("supersession: supersededBy map is built from supersedes edges", () => {
  const g = pricingFixture().load();
  assert.equal(g.supersededBy["dec-old"], "dec-new");
});

test("supersession: digest marks the stale node with the inline warning suffix", () => {
  const g = pricingFixture().load();
  const r = graph.compile(g, { rootId: "dec-new", digest: true });
  // root-mode digest includes structural picks; dec-old (superseded) shows up flagged.
  if (r.text.includes("dec-old")) {
    assert.match(r.text, /dec-old.*⚠ SUPERSEDED by dec-new — do not follow/);
  }
});

// ---------- correction pin / exclude ----------

test("correction: excluded node never appears in the compile", () => {
  const g = pricingFixture().load();
  const r = graph.compile(g, { query: "pricing notes catalogue", digest: false });
  if (r.relevant) {
    assert.ok(!r.text.includes("art-stale"), "excluded art-stale must not appear");
  }
});

test("correction: pinned node is forced into the neighborhood", () => {
  const g = pricingFixture().load();
  const r = graph.compile(g, { rootId: "dec-new", digest: false });
  assert.equal(r.relevant, true);
  assert.match(r.text, /spec-actor/);
  assert.match(r.text, /pinned by corr-global-1/);
});

test("correction: global correction body line is appended to the digest", () => {
  const g = pricingFixture().load();
  const r = graph.compile(g, { rootId: "dec-new", digest: true });
  assert.match(r.text, /Standing corrections:/);
});

// ---------- validateNode ----------

test("validateNode: accepts a well-formed node", () => {
  const node = graph.parseFrontmatter(`---
id: dec-ok
type: decision
title: t
summary: s
date: 2026-06-01
---
b
`, "dec-ok.md");
  const r = graph.validateNode(null, node);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test("validateNode: rejects missing summary", () => {
  const node = graph.parseFrontmatter(`---
id: dec-ns
type: decision
title: t
date: 2026-06-01
---
b
`, "dec-ns.md");
  const r = graph.validateNode(null, node);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /missing summary/.test(e)));
});

test("validateNode: rejects id != filename", () => {
  const node = graph.parseFrontmatter(`---
id: dec-mismatch
type: decision
title: t
summary: s
date: 2026-06-01
---
b
`, "dec-other.md");
  const r = graph.validateNode(null, node);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /!= filename/.test(e)));
});

test("validateNode: rejects correction without target", () => {
  const node = graph.parseFrontmatter(`---
id: corr-notarget
type: correction
title: t
summary: s
date: 2026-06-01
---
b
`, "corr-notarget.md");
  const r = graph.validateNode(null, node);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /correction without target/.test(e)));
});

// ---------- validateGraph ----------

test("validateGraph: clean graph reports zero errors", () => {
  // pricingFixture's corr-global-1 has no summary, which the validator flags;
  // build a clean variant here (all nodes carry a summary, corrections have targets).
  const fx = tmpGraph({
    "spec-a.md": `---
id: spec-a
type: artifact
title: A
summary: s
date: 2026-06-01
---
b
`,
    "dec-b.md": `---
id: dec-b
type: decision
title: B
summary: s
date: 2026-06-01
edges:
  - {type: derived-from, to: spec-a}
---
b
`,
  });
  const v = graph.validateGraph(fx.nodesDir);
  assert.deepEqual(v.errors, []);
  assert.equal(v.count, 2);
});

test("validateGraph: dangling edge is a warning, not an error", () => {
  const fx = tmpGraph({
    "dec-d.md": `---
id: dec-d
type: decision
title: D
summary: s
date: 2026-06-01
edges:
  - {type: derived-from, to: ghost-node}
---
b
`,
  });
  const v = graph.validateGraph(fx.nodesDir);
  assert.deepEqual(v.errors, []);
  assert.ok(v.warnings.some((w) => /dangling edge derived-from -> ghost-node/.test(w)));
});

test("validateGraph: duplicate id is an error", () => {
  const fx = tmpGraph({
    "dup.md": `---
id: dup-id
type: decision
title: A
summary: s
date: 2026-06-01
---
b
`,
    "dup-id.md": `---
id: dup-id
type: decision
title: B
summary: s
date: 2026-06-01
---
b
`,
  });
  const v = graph.validateGraph(fx.nodesDir);
  assert.ok(v.errors.some((e) => /duplicate id 'dup-id'/.test(e)));
});

test("validateGraph: unparseable file is an error, not a throw", () => {
  const fx = tmpGraph({ "bad.md": "no frontmatter here\n" });
  const v = graph.validateGraph(fx.nodesDir);
  assert.ok(v.errors.some((e) => /bad\.md: no frontmatter/.test(e)));
});

test("validateGraph: unknown node type and unknown edge type are warnings", () => {
  const fx = tmpGraph({
    "weird.md": `---
id: weird
type: contraption
title: W
summary: s
date: 2026-06-01
edges:
  - {type: invented-edge, to: weird}
---
b
`,
  });
  const v = graph.validateGraph(fx.nodesDir);
  assert.deepEqual(v.errors, []);
  assert.ok(v.warnings.some((w) => /unknown type 'contraption'/.test(w)));
  assert.ok(v.warnings.some((w) => /unknown edge type 'invented-edge'/.test(w)));
});

// ---------- loadGraph wiring ----------

test("loadGraph: briefing and correction nodes are non-traversable (excluded from adjacency)", () => {
  const g = pricingFixture().load();
  // corr-global-1 is a correction; it must not appear as an adjacency source.
  assert.equal(g.adj["corr-global-1"], undefined);
  // tf-idf docs exclude corrections/briefings.
  assert.ok(!g.docs.some((d) => d.id === "corr-global-1"));
});

// ---------- attribution fields (API.md §1 / GRAPH.md) ----------

test("validator accepts optional author / authored_via scalar fields", () => {
  const fx = tmpGraph({
    "dec-attributed.md": `---
id: dec-attributed
type: decision
project: my-project
title: An attributed decision
summary: A decision the server stamped with author and authored_via, which the validator must accept as ordinary scalar fields.
author: Alice Dev <alice@example.com>
authored_via: rest
date: 2026-06-10
---
Body.
`,
  });
  // parseFrontmatter exposes them as plain scalars.
  const g = fx.load();
  assert.equal(g.nodes["dec-attributed"].author, "Alice Dev <alice@example.com>");
  assert.equal(g.nodes["dec-attributed"].authored_via, "rest");
  // and the full-graph validator treats them as clean (no new error/warning).
  const v = graph.validateGraph(fx.nodesDir);
  assert.deepEqual(v.errors, []);
  assert.ok(!v.warnings.some((w) => /author/.test(w)));
});

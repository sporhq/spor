// lib/kernel/coupling.js — the pure coupled-artifact matcher
// (dec-spor-coupling-norms-declared-first): repo-qualified glob entries, the
// small glob dialect, engine-side norm scope, and the matchCouplings gate.
const test = require("node:test");
const assert = require("node:assert");
const c = require("../lib/kernel/coupling.js");

test("parseEntry: unqualified, repo-qualified, repo-id-qualified, junk", () => {
  assert.deepStrictEqual(c.parseEntry("src/**"), { repo: null, glob: "src/**" });
  assert.deepStrictEqual(c.parseEntry("spor-docs:src/content/**"), { repo: "spor-docs", glob: "src/content/**" });
  assert.deepStrictEqual(c.parseEntry("repo-spor:lib/**"), { repo: "repo-spor", glob: "lib/**" });
  // a non-slug prefix is not a qualifier (Windows-ish or odd paths stay whole)
  assert.deepStrictEqual(c.parseEntry("C:foo"), { repo: null, glob: "C:foo" });
  // a trailing colon with nothing after it is not a qualifier
  assert.deepStrictEqual(c.parseEntry("weird:"), { repo: null, glob: "weird:" });
  assert.deepStrictEqual(c.parseEntry("  padded/path.md  "), { repo: null, glob: "padded/path.md" });
});

test("globToRegExp: the documented dialect", () => {
  const hit = (glob, p) => c.globToRegExp(glob).test(p);
  // * stays within one segment
  assert.ok(hit("*.md", "API.md"));
  assert.ok(!hit("*.md", "docs/API.md"));
  // ** crosses segments
  assert.ok(hit("skills/**", "skills/spor/SKILL.md"));
  assert.ok(!hit("skills/**", "skills")); // the dir itself is not inside the subtree
  // **/ matches zero or more leading segments
  assert.ok(hit("**/AGENTS.md", "AGENTS.md"));
  assert.ok(hit("**/AGENTS.md", "a/b/AGENTS.md"));
  // ? is one non-separator char
  assert.ok(hit("f?o.js", "foo.js"));
  assert.ok(!hit("f?o.js", "f/o.js"));
  // trailing slash = whole subtree
  assert.ok(hit("skills/spor/", "skills/spor/references/concepts.md"));
  assert.ok(!hit("skills/spor/", "skills/sporx/f.md"));
  // bare filename anchors at the repo root
  assert.ok(hit("API.md", "API.md"));
  assert.ok(!hit("API.md", "docs/API.md"));
  // regex metachars in paths are literal
  assert.ok(hit("a+b/c.md", "a+b/c.md"));
  assert.ok(!hit("a+b/c.md", "aab/c.md"));
});

const NORM = (extra = {}) => ({
  id: "norm-x",
  type: "norm",
  title: "X couples",
  couples_when: ["src/**"],
  couples_also: ["API.md"],
  ...extra,
});

test("isCouplingNorm: type, liveness, and both-keys gates", () => {
  assert.ok(c.isCouplingNorm(NORM()));
  assert.ok(!c.isCouplingNorm(NORM({ type: "task" })));
  assert.ok(!c.isCouplingNorm(NORM({ status: "retired" })));
  assert.ok(!c.isCouplingNorm(NORM({ couples_also: [] })));
  assert.ok(!c.isCouplingNorm(NORM({ couples_when: undefined })));
  // the regex parser stores a malformed scalar as a string -> treated absent
  assert.ok(!c.isCouplingNorm(NORM({ couples_when: "src/**" })));
});

test("scope: unstamped = everywhere; stamped = own repo; applies_to_* narrows strictly", () => {
  const ctx = { slug: "projx", relPath: "src/a.js", repoTags: [] };
  // unstamped global norm fires anywhere
  assert.strictEqual(c.matchCouplings([NORM()], ctx).length, 1);
  // stamped to the session repo fires; stamped elsewhere does not
  assert.strictEqual(c.matchCouplings([NORM({ project: "projx" })], ctx).length, 1);
  assert.strictEqual(c.matchCouplings([NORM({ project: "other" })], ctx).length, 0);
  // applies_to_repos accepts slug or repo- id; declared-but-no-match strict-excludes
  assert.strictEqual(c.matchCouplings([NORM({ project: "other", applies_to_repos: ["projx"] })], ctx).length, 1);
  assert.strictEqual(c.matchCouplings([NORM({ applies_to_repos: ["repo-projx"] })], ctx).length, 1);
  assert.strictEqual(c.matchCouplings([NORM({ applies_to_repos: ["elsewhere"] })], ctx).length, 0);
  // applies_to_tags intersects the session repo's tags
  assert.strictEqual(c.matchCouplings([NORM({ applies_to_tags: ["python"] })], { ...ctx, repoTags: ["python"] }).length, 1);
  assert.strictEqual(c.matchCouplings([NORM({ applies_to_tags: ["python"] })], ctx).length, 0);
});

test("cross-repo: a qualified trigger pins its repo and bypasses the norm's scope", () => {
  // stamped to spor, but the trigger is qualified to spor-docs -> fires THERE
  const n = NORM({
    project: "spor",
    couples_when: ["spor-docs:src/content/**", "lib/**"],
    couples_also: ["spor:API.md"],
  });
  const inDocs = { slug: "spor-docs", relPath: "src/content/reference/mcp.md", repoTags: [] };
  const inSpor = { slug: "spor", relPath: "lib/graph.js", repoTags: [] };
  const elsewhere = { slug: "unrelated", relPath: "lib/graph.js", repoTags: [] };
  assert.strictEqual(c.matchCouplings([n], inDocs).length, 1, "qualified trigger fires in the pinned repo");
  assert.strictEqual(c.matchCouplings([n], inSpor).length, 1, "unqualified trigger fires where the norm applies");
  assert.strictEqual(c.matchCouplings([n], elsewhere).length, 0, "unqualified trigger stays scope-bound");
  // the qualified trigger does NOT fire in the stamping repo
  assert.strictEqual(c.matchCouplings([n], { slug: "spor", relPath: "src/content/x.md", repoTags: [] }).length, 0);
});

test("matchCouplings returns each hit norm once, non-norms and misses filtered", () => {
  const norms = [
    NORM({ id: "norm-a", couples_when: ["src/**", "src/deep/**"] }), // two triggers, one norm
    NORM({ id: "norm-b", couples_when: ["docs/**"] }),
    NORM({ id: "norm-c", type: "task" }),
  ];
  const out = c.matchCouplings(norms, { slug: "projx", relPath: "src/deep/f.js", repoTags: [] });
  assert.deepStrictEqual(out.map((n) => n.id), ["norm-a"]);
});

test("couplingHit: relPath as an array tests every candidate spelling (task-spor-coupling-matcher-symlink-alias)", () => {
  // An in-repo symlinked subtree has two valid spellings for the same edit —
  // the alias (`frontend/app.js`) and the git-resolved path
  // (`packages/web/app.js`). A caller unsure which one a glob was authored
  // against passes both; a hit on EITHER counts.
  const aliasNorm = NORM({ couples_when: ["frontend/**"] });
  const resolvedNorm = NORM({ couples_when: ["packages/web/**"] });
  const ctx = { slug: "projx", relPath: ["frontend/app.js", "packages/web/app.js"], repoTags: [] };
  assert.ok(c.couplingHit(aliasNorm, ctx), "glob on the alias spelling matches");
  assert.ok(c.couplingHit(resolvedNorm, ctx), "glob on the resolved spelling matches too");
  // a glob matching neither candidate still misses
  assert.ok(!c.couplingHit(NORM({ couples_when: ["docs/**"] }), ctx));
  // a bare string still works (back-compat single-spelling contract)
  assert.ok(c.couplingHit(aliasNorm, { ...ctx, relPath: "frontend/app.js" }));
});

test("expandAliasCandidates: declared aliases expand both directions; unrelated paths pass through untouched", () => {
  const aliases = { frontend: "packages/web" };
  assert.deepStrictEqual(
    c.expandAliasCandidates(["frontend/app.js"], aliases).sort(),
    ["frontend/app.js", "packages/web/app.js"]
  );
  assert.deepStrictEqual(
    c.expandAliasCandidates(["packages/web/app.js"], aliases).sort(),
    ["frontend/app.js", "packages/web/app.js"]
  );
  // the bare alias root itself (no trailing segment) also expands
  assert.deepStrictEqual(c.expandAliasCandidates(["frontend"], aliases).sort(), ["frontend", "packages/web"]);
  // a path that shares only a PREFIX (not a path-segment boundary) is untouched
  assert.deepStrictEqual(c.expandAliasCandidates(["frontend-other/x.js"], aliases), ["frontend-other/x.js"]);
  // no aliases declared -> identity (byte-identical when unset)
  assert.deepStrictEqual(c.expandAliasCandidates(["frontend/app.js"], {}), ["frontend/app.js"]);
  assert.deepStrictEqual(c.expandAliasCandidates(["frontend/app.js"], undefined), ["frontend/app.js"]);
  // unrelated paths never expand
  assert.deepStrictEqual(c.expandAliasCandidates(["docs/x.md"], aliases), ["docs/x.md"]);
});

test("couplingHit: a declared alias map resolves the REVERSE gap — a resolved-only path still matches a glob authored against its alias, and vice versa (issue-spor-coupling-matcher-reverse-symlink-gap)", () => {
  const aliases = { frontend: "packages/web" };
  const aliasNorm = NORM({ couples_when: ["frontend/**"] });
  const resolvedNorm = NORM({ couples_when: ["packages/web/**"] });
  // the caller only has the CANONICAL spelling (no alias derivable, e.g. no
  // symlink materialized on this filesystem, or a pre-resolved cwd) — without
  // a declared alias this can never match a glob authored against the alias.
  const resolvedOnly = { slug: "projx", relPath: "packages/web/app.js", repoTags: [] };
  assert.ok(!c.couplingHit(aliasNorm, resolvedOnly), "no aliases declared -> the documented limitation stands");
  assert.ok(c.couplingHit(aliasNorm, { ...resolvedOnly, aliases }), "declared alias recovers the match");
  // the reverse direction: an alias-only candidate still matches a glob
  // authored against the canonical spelling.
  const aliasOnly = { slug: "projx", relPath: "frontend/app.js", repoTags: [] };
  assert.ok(c.couplingHit(resolvedNorm, { ...aliasOnly, aliases }));
});

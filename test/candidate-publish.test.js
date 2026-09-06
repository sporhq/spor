// Publishing a factory CANDIDATE as a PORTABLE REFERENCE
// (task-spor-factory-candidate-portable-reference, FACTORY-IMPLEMENTATION-STAGE.md §3.4).
//
// The claim under test is §3.4's own: a controller that does not share a
// filesystem with the implementer can obtain `commit` from the reference alone
// and prove it resolves to `tree`. So the oracle is a REAL git round trip — a
// throwaway producer repo, a real bundle/push, and a SECOND scratch repository
// that has never seen the producer's worktree — plus the refusal table for
// everything that is not portable.
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { pathToFileURL, fileURLToPath } = require("node:url");

const candidate = require("../lib/kernel/candidate.js");
const publisher = require("../lib/shell/candidate-publish.js");
const gates = require("../lib/kernel/gates.js");

const sha256 = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");

function scratch(t, stem) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `spor-${stem}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A producer repo with a trusted `main` and one commit of work on a branch.
function producerRepo(t) {
  const dir = scratch(t, "cand-pub-repo");
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" });
  const g = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  g("config", "user.email", "t@t");
  g("config", "user.name", "Test");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  g("add", "-A");
  g("commit", "-q", "-m", "trusted");
  const base = g("rev-parse", "HEAD");
  g("checkout", "-q", "-b", "impl");
  fs.writeFileSync(path.join(dir, "b.txt"), "two\n");
  g("add", "-A");
  g("commit", "-q", "-m", "work");
  return { dir, g, base, commit: g("rev-parse", "HEAD"), tree: g("rev-parse", "HEAD^{tree}") };
}

function mintFor(repo, over = {}) {
  const r = candidate.mintCandidate(
    {
      repo: "spor",
      node_id: "task-x",
      commit: repo.commit,
      tree: repo.tree,
      base: { ref: "main", commit: repo.base, merge_base: repo.base },
      branch: "impl",
      clean: true,
      changed_paths: ["b.txt"],
      ...over,
    },
    { sha256 }
  );
  assert.deepStrictEqual(r.errors, [], r.errors.join("; "));
  return r.candidate;
}

// The reader half of §3.4, written the way a controller would: nothing but the
// reference's own locator, in a repository that has never seen the producer.
function readerObtains(t, reference, { candidateId, base = null, from = null }) {
  const dir = scratch(t, "cand-reader");
  const g = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "--bare", dir], { stdio: "ignore" });
  const locator = reference.locator.startsWith("file://") ? fileURLToPath(reference.locator) : reference.locator;
  // A reader has the trusted ref's history, which is what makes the bundle's
  // prerequisite present. `from` stands in for that history.
  if (reference.kind === "bundle" && from) g("fetch", "--no-tags", "-q", from, `+${base}:refs/reader/base`);
  g("fetch", "--no-tags", "-q", locator, `+${reference.ref || publisher.candidateRef(candidateId)}:refs/reader/tip`);
  return { commit: g("rev-parse", "refs/reader/tip"), tree: g("rev-parse", "refs/reader/tip^{tree}") };
}

// ------------------------------------------------------------ the bundle --

test("a bundle publish is fetchable and verifies from the locator alone, after the producer's worktree is gone", async (t) => {
  const repo = producerRepo(t);
  const store = pathToFileURL(scratch(t, "cand-store")).href;
  const cand = mintFor(repo);

  const r = await publisher.publishCandidate(cand, { cwd: repo.dir, publish: "bundle", bundleStore: store });
  assert.strictEqual(r.ok, true, r.reason);
  const ref = r.candidate.reference;
  assert.strictEqual(ref.kind, "bundle");
  assert.strictEqual(ref.key, `${cand.candidate_id}.bundle`);
  assert.strictEqual(ref.locator, `${store}/${cand.candidate_id}.bundle`);
  assert.strictEqual(ref.commit, repo.commit);
  assert.ok(ref.bytes > 0);
  assert.ok(ref.verified_at, "the publish is not a submission until it verified");
  assert.strictEqual(candidate.candidateSubmitted(r.candidate), true);
  assert.strictEqual(candidate.referenceRefusal(ref, { bundleStore: store, cwd: repo.dir }), null);

  // The bytes are content-addressed by their own sha256.
  const bytes = fs.readFileSync(fileURLToPath(ref.locator));
  assert.strictEqual(crypto.createHash("sha256").update(bytes).digest("hex"), ref.sha256);

  // A SECOND repository, holding only the trusted ref's history, obtains the
  // commit from the reference — the producer's own branch is deleted first, so
  // nothing but the store can be answering.
  execFileSync("git", ["-C", repo.dir, "checkout", "-q", "main"]);
  execFileSync("git", ["-C", repo.dir, "branch", "-q", "-D", "impl"]);
  const got = readerObtains(t, ref, { candidateId: cand.candidate_id, base: "main", from: repo.dir });
  assert.strictEqual(got.commit, repo.commit);
  assert.strictEqual(got.tree, repo.tree);
});

test("the producing checkout is left exactly as it was found — no candidate ref stays behind", async (t) => {
  const repo = producerRepo(t);
  const store = pathToFileURL(scratch(t, "cand-store")).href;
  const before = repo.g("for-each-ref", "--format=%(refname)");
  const r = await publisher.publishCandidate(mintFor(repo), { cwd: repo.dir, publish: "bundle", bundleStore: store });
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(repo.g("for-each-ref", "--format=%(refname)"), before);
});

test("a replayed bundle publish is a no-op, and a DIFFERENT object under the id is a publish-conflict", async (t) => {
  const repo = producerRepo(t);
  const store = pathToFileURL(scratch(t, "cand-store")).href;
  const cand = mintFor(repo);

  const first = await publisher.publishCandidate(cand, { cwd: repo.dir, publish: "bundle", bundleStore: store });
  assert.strictEqual(first.ok, true, first.reason);
  assert.strictEqual(first.candidate.publish_attempts[0].outcome, "published");

  // A crash after a landed publish, replayed: the store already holds our
  // bytes, so the exclusive create fails and the sha comparison settles it.
  const again = await publisher.publishCandidate(cand, { cwd: repo.dir, publish: "bundle", bundleStore: store });
  assert.strictEqual(again.ok, true, again.reason);
  assert.strictEqual(again.candidate.publish_attempts[0].outcome, "replayed");

  // Corruption, not a race: something under our id that is not our candidate.
  fs.writeFileSync(fileURLToPath(first.candidate.reference.locator), "not a bundle\n");
  const conflict = await publisher.publishCandidate(cand, { cwd: repo.dir, publish: "bundle", bundleStore: store });
  assert.strictEqual(conflict.ok, false);
  assert.strictEqual(conflict.classification, "publish-conflict");
  assert.match(conflict.reason, /already holds a DIFFERENT object/);
  assert.strictEqual(conflict.candidate.publish_attempts.at(-1).pool, null, "a conflict consumes no pool");
});

// The idempotency claim the whole CAS rests on. `git bundle create` is NOT
// byte-reproducible (threaded delta search alone repacks differently run to
// run), so an id that already holds an object cannot be judged by comparing
// bytes: the designed retry — a publish that landed and then failed afterwards,
// re-attempted from the workspace — would rebuild a different-byte bundle of
// the SAME content and be called corruption forever. What is under the id is
// settled by fetching it and asking what it resolves to.
test("an occupied id holding a DIFFERENT-BYTES bundle of the same commit is a replay, not a conflict", async (t) => {
  const repo = producerRepo(t);
  const storeDir = scratch(t, "cand-store");
  const store = pathToFileURL(storeDir).href;
  const cand = mintFor(repo);

  const first = await publisher.publishCandidate(cand, { cwd: repo.dir, publish: "bundle", bundleStore: store });
  assert.strictEqual(first.ok, true, first.reason);
  const target = fileURLToPath(first.candidate.reference.locator);

  // A bundle carrying the SAME ref at the SAME commit, packed differently —
  // exactly what a rebuild produces on a repo of any size.
  const ref = publisher.candidateRef(cand.candidate_id);
  repo.g("update-ref", ref, repo.commit);
  repo.g("update-ref", "refs/alt/extra", repo.commit);
  const alt = path.join(scratch(t, "cand-alt"), "alt.bundle");
  repo.g("bundle", "create", alt, `${repo.base}..${ref}`, `${repo.base}..refs/alt/extra`);
  repo.g("update-ref", "-d", "refs/alt/extra");
  repo.g("update-ref", "-d", ref);
  const altBytes = fs.readFileSync(alt);
  assert.notStrictEqual(
    crypto.createHash("sha256").update(altBytes).digest("hex"),
    first.candidate.reference.sha256,
    "the fixture must actually differ byte-wise, or it proves nothing"
  );
  fs.writeFileSync(target, altBytes);

  const again = await publisher.publishCandidate(cand, { cwd: repo.dir, publish: "bundle", bundleStore: store });
  assert.strictEqual(again.ok, true, again.reason);
  assert.strictEqual(again.candidate.publish_attempts.at(-1).outcome, "replayed");
  // …and the reference records the STORED object's digest, which is what a
  // reader will actually check the fetch against.
  assert.strictEqual(again.candidate.reference.sha256, crypto.createHash("sha256").update(altBytes).digest("hex"));
  assert.strictEqual(again.candidate.reference.bytes, altBytes.length);
});

test("a candidate whose pinned tree is not what the store returns is a candidate-mismatch, not an outage", async (t) => {
  const repo = producerRepo(t);
  const store = pathToFileURL(scratch(t, "cand-store")).href;
  // A candidate pinning the right commit and the WRONG tree — the shape a
  // corrupted store or a mis-derived pin produces.
  const cand = mintFor(repo, { tree: "d".repeat(40) });
  const r = await publisher.publishCandidate(cand, { cwd: repo.dir, publish: "bundle", bundleStore: store });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.classification, "candidate-mismatch");
  assert.match(r.reason, /resolves to tree/);
  assert.strictEqual(r.candidate.publish_attempts.at(-1).pool, null, "a mismatch consumes no pool");
});

test("a store that answers with bytes we did not publish is a candidate-mismatch, caught at submission", async (t) => {
  const repo = producerRepo(t);
  // The store ACCEPTS the put and then serves something else — a wrong object
  // entirely. The producer's own round trip is the only thing between that and
  // a controller fetching evidence that describes nothing.
  const http = {
    put: async () => ({ ok: true, status: 201 }),
    get: async () => ({ ok: true, status: 200, buffer: Buffer.from("not a bundle at all") }),
  };
  const r = await publisher.publishCandidate(mintFor(repo), { cwd: repo.dir, publish: "bundle", bundleStore: "https://api.example/candidates", http });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.classification, "candidate-mismatch");
  assert.strictEqual(r.candidate.publish_attempts.at(-1).pool, null, "a mismatch consumes no pool");
});

test("a TRUNCATED object we just published is a candidate-mismatch, not an outage that drains the retry pool", async (t) => {
  const repo = producerRepo(t);
  // The nastier shape: a bundle whose header and prerequisite list are intact,
  // so `git bundle verify` exits 0 and only the fetch fails. Without the
  // published-arm byte check that reads as "the store is down" and is retried
  // against a store that is up and holding something that will never fetch.
  let full = null;
  const http = {
    put: async (_url, bytes) => {
      full = Buffer.from(bytes);
      return { ok: true, status: 201 };
    },
    get: async () => ({ ok: true, status: 200, buffer: full.subarray(0, full.length - 40) }),
  };
  const r = await publisher.publishCandidate(mintFor(repo), { cwd: repo.dir, publish: "bundle", bundleStore: "https://api.example/candidates", http });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.classification, "candidate-mismatch");
  assert.match(r.reason, /did not keep what it was given/);
  assert.strictEqual(r.candidate.publish_attempts.at(-1).pool, null);
});

test("an unwritable store is an outage — re-attemptable from the workspace, charged to the retry pool", async (t) => {
  const repo = producerRepo(t);
  const storeDir = scratch(t, "cand-store");
  const store = pathToFileURL(storeDir).href;
  fs.chmodSync(storeDir, 0o500);
  try {
    const r = await publisher.publishCandidate(mintFor(repo), { cwd: repo.dir, publish: "bundle", bundleStore: store });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.classification, "infrastructure");
    assert.strictEqual(r.candidate.publish_attempts.at(-1).pool, "retry");
  } finally {
    fs.chmodSync(storeDir, 0o700);
  }
});

// ------------------------------------------------------------ the branch --

test("a branch publish records the RESOLVED url, never the remote name, and is create-only", async (t) => {
  const repo = producerRepo(t);
  const remoteDir = scratch(t, "cand-remote");
  execFileSync("git", ["init", "-q", "--bare", remoteDir], { stdio: "ignore" });
  const remoteUrl = pathToFileURL(remoteDir).href;
  repo.g("remote", "add", "origin", remoteUrl);
  const cand = mintFor(repo);

  const r = await publisher.publishCandidate(cand, { cwd: repo.dir, publish: "branch", remote: "origin" });
  assert.strictEqual(r.ok, true, r.reason);
  const ref = r.candidate.reference;
  assert.strictEqual(ref.kind, "branch");
  assert.strictEqual(ref.locator, remoteUrl, "the locator is the resolved URL — a remote name resolves only here");
  assert.strictEqual(ref.ref, `refs/spor/candidates/${cand.candidate_id}`);
  assert.ok(ref.verified_at);

  const listed = execFileSync("git", ["ls-remote", remoteDir, ref.ref], { encoding: "utf8" }).trim();
  assert.match(listed, new RegExp(`^${repo.commit}\\s`));

  // Replay: the ref is already ours.
  const again = await publisher.publishCandidate(cand, { cwd: repo.dir, publish: "branch", remote: "origin" });
  assert.strictEqual(again.ok, true, again.reason);

  // A DIFFERENT commit under the same id is corruption, never a force.
  execFileSync("git", ["-C", remoteDir, "update-ref", ref.ref, repo.base]);
  const conflict = await publisher.publishCandidate(cand, { cwd: repo.dir, publish: "branch", remote: "origin" });
  assert.strictEqual(conflict.ok, false);
  assert.strictEqual(conflict.classification, "publish-conflict");
  assert.strictEqual(
    execFileSync("git", ["ls-remote", remoteDir, ref.ref], { encoding: "utf8" }).trim().split(/\s/)[0],
    repo.base,
    "a conflicting ref is never overwritten"
  );
});

test("a branch publish with no such remote is an outage naming the remote, not a silent unpublished candidate", async (t) => {
  const repo = producerRepo(t);
  const r = await publisher.publishCandidate(mintFor(repo), { cwd: repo.dir, publish: "branch", remote: "origin" });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.classification, "infrastructure");
  assert.match(r.reason, /no git remote named 'origin'/);
});

test("publish 'both' carries the bundle as `reference` and both doors in `references[]`", async (t) => {
  const repo = producerRepo(t);
  const store = pathToFileURL(scratch(t, "cand-store")).href;
  const remoteDir = scratch(t, "cand-remote");
  execFileSync("git", ["init", "-q", "--bare", remoteDir], { stdio: "ignore" });
  repo.g("remote", "add", "origin", pathToFileURL(remoteDir).href);

  const r = await publisher.publishCandidate(mintFor(repo), { cwd: repo.dir, publish: "both", bundleStore: store, remote: "origin" });
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(r.candidate.reference.kind, "bundle");
  assert.deepStrictEqual(
    r.candidate.references.map((x) => x.kind),
    ["bundle", "branch"]
  );
  for (const ref of r.candidate.references) assert.ok(ref.verified_at);
});

// ------------------------------------------------------------- the store --

test("an already-verified candidate publishes nothing — a same-tree re-pin is the same published object", async (t) => {
  const repo = producerRepo(t);
  const store = pathToFileURL(scratch(t, "cand-store")).href;
  const first = await publisher.publishCandidate(mintFor(repo), { cwd: repo.dir, publish: "bundle", bundleStore: store });
  assert.strictEqual(first.ok, true, first.reason);
  const again = await publisher.publishCandidate(first.candidate, { cwd: repo.dir, publish: "bundle", bundleStore: store });
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.published, false);
  assert.strictEqual(again.candidate, first.candidate, "nothing is re-stamped");
});

test("an https bundle store speaks the hosted door's 201/200/409 (§7.5), and 409 is CONFIRMED by a read", async (t) => {
  const repo = producerRepo(t);
  const cand = mintFor(repo);
  const store = "https://api.example/v1/executions/exec-1/candidates";
  const held = new Map();
  let mode = "create";
  const http = {
    put: async (url, bytes) => {
      if (mode === "conflict") return { ok: false, status: 409 };
      if (held.has(url)) return { ok: true, status: 200 };
      held.set(url, Buffer.from(bytes));
      return { ok: true, status: 201 };
    },
    get: async (url) => (held.has(url) ? { ok: true, status: 200, buffer: held.get(url) } : { ok: false, status: 404 }),
  };

  const first = await publisher.publishCandidate(cand, { cwd: repo.dir, publish: "bundle", bundleStore: store, http });
  assert.strictEqual(first.ok, true, first.reason);
  assert.strictEqual(first.candidate.reference.locator, `${store}/${cand.candidate_id}.bundle`);
  assert.strictEqual(first.candidate.publish_attempts[0].outcome, "published");

  const replay = await publisher.publishCandidate(cand, { cwd: repo.dir, publish: "bundle", bundleStore: store, http });
  assert.strictEqual(replay.ok, true, replay.reason);
  assert.strictEqual(replay.candidate.publish_attempts[0].outcome, "replayed");

  // A 409 whose stored object IS our candidate is the replayed no-op; a 409
  // over an object that is not is the conflict. The test is what the object
  // RESOLVES TO, never its bytes.
  mode = "conflict";
  const sameContent = await publisher.publishCandidate(cand, { cwd: repo.dir, publish: "bundle", bundleStore: store, http });
  assert.strictEqual(sameContent.ok, true, sameContent.reason);
  assert.strictEqual(sameContent.candidate.publish_attempts.at(-1).outcome, "replayed");
  held.set(`${store}/${cand.candidate_id}.bundle`, Buffer.from("something else"));
  const conflict = await publisher.publishCandidate(cand, { cwd: repo.dir, publish: "bundle", bundleStore: store, http });
  assert.strictEqual(conflict.ok, false);
  assert.strictEqual(conflict.classification, "publish-conflict");
});

test("an https store with no client configured is an outage, never a silently local publish", async (t) => {
  const repo = producerRepo(t);
  const r = await publisher.publishCandidate(mintFor(repo), { cwd: repo.dir, publish: "bundle", bundleStore: "https://api.example/candidates" });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.classification, "infrastructure");
  assert.match(r.reason, /no HTTPS store client/);
});

test("an unusable store leaves the same publish_attempts trail every other failure does", async (t) => {
  const repo = producerRepo(t);
  const r = await publisher.publishCandidate(mintFor(repo), {
    cwd: repo.dir,
    publish: "bundle",
    bundleStore: null,
    bundleStoreReason: "the store is not writable from this machine",
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.classification, "infrastructure");
  assert.strictEqual(r.reason, "the store is not writable from this machine");
  // The trail is what the retry pool is charged against and what an escalation
  // names — a debt with no attempt reads as a stage that never tried.
  assert.strictEqual(r.candidate.publish_attempts.length, 1);
  assert.strictEqual(r.candidate.publish_attempts[0].pool, "retry");
});

// issue-spor-unpublishable-reference-shape-classified-infrastructure-until-
// pool-drains: a store under the producing run's own working tree is the ONE
// permanent shape resolveBundleStore cannot refuse at startup — it needs a
// cwd a startup check never has — so it was reaching this classification as
// `infrastructure` and being retried until the whole retry pool was spent,
// even though no retry could ever make it verify.
test("a bundle store under the producing run's OWN working tree is unpublishable, not an outage, and spends no retry", async (t) => {
  const repo = producerRepo(t);
  const store = pathToFileURL(path.join(repo.dir, "candidates")).href;
  const r = await publisher.publishCandidate(mintFor(repo), { cwd: repo.dir, publish: "bundle", bundleStore: store });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.classification, "unpublishable");
  assert.match(r.reason, /working tree/);
  // The same trail an outage leaves, but charging NEITHER pool — a shape a
  // retry can never fix must not drain the one budget an actual outage needs.
  assert.strictEqual(r.candidate.publish_attempts.length, 1);
  assert.strictEqual(r.candidate.publish_attempts[0].outcome, "unpublishable");
  assert.strictEqual(r.candidate.publish_attempts[0].pool, null);
});

test("a store shape that can NEVER verify is refused at startup, not retried until the pool is spent", (t) => {
  const home = scratch(t, "cand-home");
  for (const [store, re] of [
    ["file:///srv/repo/.git/candidates", /\.git directory/],
    ["file:///srv/../srv/candidates", /relative path segment/],
  ]) {
    const v = publisher.publishSatisfiability(factoryWith({ publish: "bundle", bundle_store: store }), { graphHome: home, mode: "local" });
    assert.strictEqual(v.ok, false, store);
    assert.match(v.errors[0], re);
  }
});

// ------------------------------------------------- startup refusals (E9, E14) --

function factoryBody(payload) {
  return ["Some prose about this factory.", "", "```json", JSON.stringify(payload, null, 2), "```", ""].join("\n");
}

function factoryWith(candidateBlock, extra = {}) {
  const { factory, errors } = gates.parseFactory(
    factoryBody({
      factory: "f",
      trusted_ref: "main",
      gates: [{ id: "t", kind: "command", command: "true" }],
      implementation: { candidate: candidateBlock },
      ...extra,
    }),
    { id: "factory-f" }
  );
  assert.deepStrictEqual(errors, [], errors.join("; "));
  return factory;
}

test("E14: an https bundle store in LOCAL mode is refused at startup, where a parse could not read the mode", (t) => {
  const home = scratch(t, "cand-home");
  const f = factoryWith({ publish: "bundle", bundle_store: "https://api.example/candidates" });
  const local = publisher.publishSatisfiability(f, { graphHome: home, mode: "local" });
  assert.strictEqual(local.ok, false);
  assert.match(local.errors[0], /needs a Spor server — local mode has no candidate door/);
  // The same store under a server is exactly what the key is for.
  assert.strictEqual(publisher.publishSatisfiability(f, { graphHome: home, mode: "remote" }).ok, true);
});

test("a file:// store that cannot be written is refused at startup, not at the first publish", (t) => {
  const home = scratch(t, "cand-home");
  const blocked = path.join(home, "no-write");
  fs.mkdirSync(blocked);
  fs.chmodSync(blocked, 0o500);
  try {
    const f = factoryWith({ publish: "bundle", bundle_store: pathToFileURL(path.join(blocked, "candidates")).href });
    const v = publisher.publishSatisfiability(f, { graphHome: home, mode: "local" });
    assert.strictEqual(v.ok, false);
    assert.match(v.errors[0], /is not writable from this machine/);
  } finally {
    fs.chmodSync(blocked, 0o700);
  }
});

test("the default store is file://<SPOR_HOME>/candidates and is created on demand", (t) => {
  const home = scratch(t, "cand-home");
  const f = factoryWith({});
  const v = publisher.publishSatisfiability(f, { graphHome: home, mode: "local" });
  assert.deepStrictEqual(v.errors, []);
  assert.strictEqual(v.store, publisher.defaultBundleStore(home));
  assert.ok(fs.existsSync(path.join(home, "candidates")));
});

// -------------------- gitignore follows the store's OWN resolved home --
// (task-spor-candidate-store-home-vs-shared-graph-home-trap): the default
// store lives under `graphHome` (userConfigHome() in real use, NEVER the
// marker-resolved shared graph home), so the ignore line belongs there, not
// in some other directory the store never touches.

test("a git-tracked default home gets its own /candidates/ .gitignore line", (t) => {
  const home = scratch(t, "cand-home");
  execFileSync("git", ["init", "-q", home], { stdio: "ignore" });
  const f = factoryWith({});
  const v = publisher.publishSatisfiability(f, { graphHome: home, mode: "local" });
  assert.deepStrictEqual(v.errors, []);
  const gi = fs.readFileSync(path.join(home, ".gitignore"), "utf8");
  assert.ok(gi.split("\n").some((l) => l.trim() === "/candidates/"), gi);
});

test("a NON-git-tracked home is left with no .gitignore at all", (t) => {
  const home = scratch(t, "cand-home");
  const f = factoryWith({});
  const v = publisher.publishSatisfiability(f, { graphHome: home, mode: "local" });
  assert.deepStrictEqual(v.errors, []);
  assert.strictEqual(fs.existsSync(path.join(home, ".gitignore")), false);
});

test("an operator-declared store elsewhere is gitignored in ITS OWN home, not the default graphHome", (t) => {
  const home = scratch(t, "cand-home"); // never touched by the store
  const shared = scratch(t, "cand-shared"); // the marker-resolved shared graph home, stands in
  execFileSync("git", ["init", "-q", shared], { stdio: "ignore" });
  const f = factoryWith({ publish: "bundle", bundle_store: pathToFileURL(path.join(shared, "candidates")).href });
  const v = publisher.publishSatisfiability(f, { graphHome: home, mode: "local" });
  assert.deepStrictEqual(v.errors, []);
  assert.strictEqual(fs.existsSync(path.join(home, ".gitignore")), false);
  const gi = fs.readFileSync(path.join(shared, ".gitignore"), "utf8");
  assert.ok(gi.split("\n").some((l) => l.trim() === "/candidates/"), gi);
});

test("ensureStoreGitignore is idempotent and fail-open on a bad path", () => {
  assert.strictEqual(publisher.ensureStoreGitignore(""), false);
  assert.strictEqual(publisher.ensureStoreGitignore(null), false);
});

test("a store nested several directories below the git root is found by walking up, and the ignore line is RELATIVE to the root", (t) => {
  const shared = scratch(t, "cand-shared-nested");
  execFileSync("git", ["init", "-q", shared], { stdio: "ignore" });
  const f = factoryWith({ publish: "bundle", bundle_store: pathToFileURL(path.join(shared, "data", "nested", "candidates")).href });
  const v = publisher.publishSatisfiability(f, { graphHome: scratch(t, "cand-home-unused"), mode: "local" });
  assert.deepStrictEqual(v.errors, []);
  const gi = fs.readFileSync(path.join(shared, ".gitignore"), "utf8");
  assert.ok(gi.split("\n").some((l) => l.trim() === "/data/nested/candidates/"), gi);
});

test("E9: a branch publish with no such remote in any known checkout is refused at startup", (t) => {
  const repo = producerRepo(t);
  const home = scratch(t, "cand-home");
  const f = factoryWith({ publish: "branch" }, { repos: ["spor"] });
  const missing = publisher.publishSatisfiability(f, { graphHome: home, mode: "local", repoPaths: { spor: repo.dir } });
  assert.strictEqual(missing.ok, false);
  assert.match(missing.errors[0], /no git remote named 'origin'/);

  repo.g("remote", "add", "origin", pathToFileURL(scratch(t, "cand-remote")).href);
  assert.strictEqual(publisher.publishSatisfiability(f, { graphHome: home, mode: "local", repoPaths: { spor: repo.dir } }).ok, true);
});

test("E9 cannot be PROVEN without a checkout, so an unknown one warns rather than refusing", (t) => {
  const home = scratch(t, "cand-home");
  const f = factoryWith({ publish: "branch" }, { repos: ["spor"] });
  const v = publisher.publishSatisfiability(f, { graphHome: home, mode: "local", repoPaths: {} });
  assert.strictEqual(v.ok, true);
  assert.match(v.warnings[0], /no checkout of spor is known on this machine/);
});

test("a declared remote URL needs no checkout at all — it is already the locator", (t) => {
  const home = scratch(t, "cand-home");
  const f = factoryWith({ publish: "branch", remote: "https://git.example/spor.git" }, { repos: ["spor"] });
  const v = publisher.publishSatisfiability(f, { graphHome: home, mode: "local", repoPaths: {} });
  assert.strictEqual(v.ok, true);
  assert.deepStrictEqual(v.warnings, []);
});

test("a factory that declares no implementation stage is satisfiable by construction — nothing publishes", (t) => {
  const home = scratch(t, "cand-home");
  const { factory } = gates.parseFactory(factoryBody({ factory: "f", gates: [{ id: "t", kind: "command", command: "true" }] }), { id: "factory-f" });
  const v = publisher.publishSatisfiability(factory, { graphHome: home, mode: "local" });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.store, null);
  assert.strictEqual(fs.existsSync(path.join(home, "candidates")), false);
});

// -------------------------------------------------------------- the words --

test("publishKinds reads the vocabulary, and the bundle is always the primary door", () => {
  assert.deepStrictEqual(publisher.publishKinds("bundle"), ["bundle"]);
  assert.deepStrictEqual(publisher.publishKinds("branch"), ["branch"]);
  assert.deepStrictEqual(publisher.publishKinds("both"), ["bundle", "branch"]);
  // There is no `none`: the parser refuses the word, and anything unrecognized
  // that reached here still publishes rather than silently omitting the door.
  assert.deepStrictEqual(publisher.publishKinds(""), ["bundle"]);
});

test("the locator is spelled ONE way, whatever the store's trailing slash", () => {
  assert.strictEqual(publisher.storeLocator("file:///s", "k.bundle"), "file:///s/k.bundle");
  assert.strictEqual(publisher.storeLocator("file:///s/", "k.bundle"), "file:///s/k.bundle");
});

test("an ssh or scp-style remote — the common git-over-ssh origin — is satisfiable at startup (issue-spor-candidate-reference-locator-vocabulary-lacks-ssh)", (t) => {
  const repo = producerRepo(t);
  const home = scratch(t, "cand-home");
  repo.g("remote", "add", "origin", "git@github.com:sporhq/spor.git");
  const f = factoryWith({ publish: "branch" }, { repos: ["spor"] });
  const v = publisher.publishSatisfiability(f, { graphHome: home, mode: "local", repoPaths: { spor: repo.dir } });
  assert.strictEqual(v.ok, true, v.errors.join("; "));

  const declared = factoryWith({ publish: "branch", remote: "ssh://git@github.com/sporhq/spor.git" }, { repos: ["spor"] });
  const dv = publisher.publishSatisfiability(declared, { graphHome: home, mode: "local", repoPaths: {} });
  assert.strictEqual(dv.ok, true, dv.errors.join("; "));

  const scpDeclared = factoryWith({ publish: "branch", remote: "git@github.com:sporhq/spor.git" }, { repos: ["spor"] });
  const sv = publisher.publishSatisfiability(scpDeclared, { graphHome: home, mode: "local", repoPaths: {} });
  assert.strictEqual(sv.ok, true, sv.errors.join("; "));
});

test("a git:// remote (or any other unreachable scheme) is still refused — only ssh:// was added", (t) => {
  const declared = factoryWith({ publish: "branch", remote: "git://git.example/spor.git" }, { repos: ["spor"] });
  const dv = publisher.publishSatisfiability(declared, { graphHome: scratch(t, "cand-home"), mode: "local", repoPaths: {} });
  assert.strictEqual(dv.ok, false);
  assert.match(dv.errors[0], /is a git:\/\/ remote/);
});

test("resolveRemoteUrl normalizes an scp-style remote to its canonical ssh:// spelling, treating a home-relative and an absolute path the same (the common forge case)", () => {
  assert.strictEqual(publisher.resolveRemoteUrl("git@github.com:sporhq/spor.git", null).url, "ssh://git@github.com/sporhq/spor.git");
  assert.strictEqual(publisher.resolveRemoteUrl("git@github.com:/sporhq/spor.git", null).url, "ssh://git@github.com/sporhq/spor.git");
  // Already a URI: left alone.
  assert.strictEqual(publisher.resolveRemoteUrl("ssh://git@github.com/sporhq/spor.git", null).url, "ssh://git@github.com/sporhq/spor.git");
  assert.strictEqual(publisher.resolveRemoteUrl("https://git.example/spor.git", null).url, "https://git.example/spor.git");
});

test("a checkout's own scp-style origin (git remote get-url) is normalized too, not just a declared remote", (t) => {
  const repo = producerRepo(t);
  repo.g("remote", "add", "origin", "git@github.com:sporhq/spor.git");
  const r = publisher.resolveRemoteUrl("origin", repo.dir);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.url, "ssh://git@github.com/sporhq/spor.git");
});

test("portableRemoteRefusal admits ssh:// (branch reference) beside file:// and https://", () => {
  assert.strictEqual(publisher.portableRemoteRefusal("ssh://git@github.com/sporhq/spor.git"), null);
  assert.strictEqual(publisher.portableRemoteRefusal("file:///store/x"), null);
  assert.strictEqual(publisher.portableRemoteRefusal("https://h/r.git"), null);
  assert.match(publisher.portableRemoteRefusal("git://h/r.git"), /is a git:\/\/ remote/);
  assert.match(publisher.portableRemoteRefusal("origin"), /not an absolute URI/);
});

// ------------------------------------------------------- the real wiring --

// The two tests above drive the publisher directly. This one drives the REAL
// `makeGateDeps().pinCandidate` closure — the one place a pipeline actually
// publishes — against a real repo and a real run record, because the claim
// that matters operationally is not "the publisher works" but "a submitted
// candidate reaches `impl_state: candidate` on the journal, and an unpublished
// one does not".
const sporCli = require("../bin/spor.js");
const { loadConfig } = require("../lib/config.js");
const dispatchRuns = require("../lib/shell/agent-dispatch-runner.js");

function pipelineFor(t, repo, implementation) {
  const home = scratch(t, "cand-wire-home");
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  const factory = factoryWith(implementation.candidate || {}, { repos: ["spor"] });
  // parseFactory built the candidate block; carry the rest of the stage over.
  Object.assign(factory.implementation, { profile: implementation.profile || "" });
  const entry = { node_id: "task-x", run_id: "run-abcdef12", project: "spor", attempt: 1 };
  const record = { run_id: entry.run_id, node_id: entry.node_id, cwd: repo.dir, item_repo: "spor", state: "done" };
  const paths = dispatchRuns.runPaths(home, entry.run_id);
  fs.mkdirSync(path.dirname(paths.record), { recursive: true });
  fs.writeFileSync(paths.record, JSON.stringify(record));
  const logs = [];
  const deps = sporCli.makeGateDeps(cfg, { record, entry, factory, slug: "spor", log: (l) => logs.push(l), warn: () => {}, home });
  return { home, deps, logs, entry, readRecord: () => JSON.parse(fs.readFileSync(paths.record, "utf8")) };
}

test("the pipeline's own pin publishes, and only then does the stage settle as a submission", async (t) => {
  const repo = producerRepo(t);
  const wired = pipelineFor(t, repo, { candidate: { publish: "bundle" } });
  assert.ok((await wired.deps.changedPaths({ trustedRef: "main" })).ok);
  const pinned = await wired.deps.pinCandidate({ submittedBy: { stage: "implementation", cycle: 0, rescue: 0 } });
  assert.strictEqual(pinned.ok, true, pinned.reason);
  assert.strictEqual(pinned.change, "created");

  const rec = wired.readRecord();
  assert.strictEqual(rec.impl_state, "candidate", "a verified reference is what makes the stage a submission (§3.4)");
  assert.strictEqual(rec.publish_pending, null, "no debt is owed once the publish verified");
  assert.ok(rec.impl_candidate.reference.verified_at);
  assert.strictEqual(rec.impl_candidate.reference.kind, "bundle");
  assert.strictEqual(rec.impl_candidate.reference.locator, `${publisher.defaultBundleStore(wired.home)}/${rec.impl_candidate.candidate_id}.bundle`);
  assert.ok(fs.existsSync(path.join(wired.home, "candidates", `${rec.impl_candidate.candidate_id}.bundle`)));
  assert.ok(wired.logs.some((l) => /published candidate/.test(l)));
});

test("a publish that fails leaves the stage UNSETTLED with the debt named — the tree is judged regardless", async (t) => {
  const repo = producerRepo(t);
  // `branch` with no remote configured: the publish cannot land, and there is
  // no `publish: none` to fall back to.
  const wired = pipelineFor(t, repo, { candidate: { publish: "branch" } });
  assert.ok((await wired.deps.changedPaths({ trustedRef: "main" })).ok);
  const pinned = await wired.deps.pinCandidate({ submittedBy: { stage: "implementation", cycle: 0, rescue: 0 } });
  assert.strictEqual(pinned.ok, true, "the pin still succeeds — a publish is how a controller OBTAINS the candidate, not what makes one");

  const rec = wired.readRecord();
  assert.strictEqual(rec.impl_state, "running", "an unpublished candidate is not a submission");
  assert.strictEqual(rec.impl_candidate.reference, null);
  assert.strictEqual(rec.publish_pending.classification, "infrastructure");
  assert.match(rec.publish_pending.reason, /no git remote named 'origin'/);
  assert.strictEqual(rec.impl_candidate.publish_attempts.at(-1).pool, "retry");
  assert.ok(wired.logs.some((l) => /is not published yet/.test(l)));
});

test("a declared bundle_store under the producing run's own cwd fails once and spends no retry, through the real pin", async (t) => {
  const repo = producerRepo(t);
  // A factory whose declared store happens to resolve INSIDE the checkout the
  // implementation stage runs from — the one shape resolveBundleStore cannot
  // refuse at startup, since it has no cwd to check against
  // (issue-spor-unpublishable-reference-shape-classified-infrastructure-
  // until-pool-drains). Every re-pin runs from the SAME cwd, so this is not a
  // transient outage a retry could clear — it fails identically forever.
  const store = pathToFileURL(path.join(repo.dir, "candidates")).href;
  const wired = pipelineFor(t, repo, { candidate: { publish: "bundle", bundle_store: store } });
  assert.ok((await wired.deps.changedPaths({ trustedRef: "main" })).ok);
  const pinned = await wired.deps.pinCandidate({ submittedBy: { stage: "implementation", cycle: 0, rescue: 0 } });
  assert.strictEqual(pinned.ok, true, "the pin still succeeds — a publish is how a controller OBTAINS the candidate, not what makes one");

  const rec = wired.readRecord();
  assert.strictEqual(rec.impl_state, "running", "an unpublished candidate is not a submission");
  assert.strictEqual(rec.publish_pending.classification, "unpublishable");
  assert.match(rec.publish_pending.reason, /working tree/);
  assert.strictEqual(rec.impl_candidate.publish_attempts.at(-1).pool, null, "a shape a retry can never fix must not charge the retry pool");
});

test("a re-pin of the SAME tree publishes nothing again and keeps the reference it already has", async (t) => {
  const repo = producerRepo(t);
  const wired = pipelineFor(t, repo, { candidate: { publish: "bundle" } });
  assert.ok((await wired.deps.changedPaths({ trustedRef: "main" })).ok);
  const first = await wired.deps.pinCandidate({ submittedBy: { stage: "implementation", cycle: 0, rescue: 0 } });
  const before = wired.readRecord().impl_candidate.reference;

  assert.ok((await wired.deps.changedPaths({ trustedRef: "main" })).ok);
  const again = await wired.deps.pinCandidate({ submittedBy: { stage: "fix", cycle: 1, rescue: 0 } });
  assert.strictEqual(again.change, "unchanged");
  const rec = wired.readRecord();
  assert.deepStrictEqual(rec.impl_candidate.reference, before, "the published object is immutable and keyed by candidate_id");
  assert.strictEqual(rec.impl_candidate.candidate_id, first.candidate.candidate_id);
  assert.strictEqual(rec.publish_pending, null);
});

test("a fix cycle that MOVES the tree supersedes the candidate and publishes the new one", async (t) => {
  const repo = producerRepo(t);
  const wired = pipelineFor(t, repo, { candidate: { publish: "bundle" } });
  assert.ok((await wired.deps.changedPaths({ trustedRef: "main" })).ok);
  const first = await wired.deps.pinCandidate({ submittedBy: { stage: "implementation", cycle: 0, rescue: 0 } });

  fs.writeFileSync(path.join(repo.dir, "c.txt"), "three\n");
  repo.g("add", "-A");
  repo.g("commit", "-q", "-m", "fix");
  assert.ok((await wired.deps.changedPaths({ trustedRef: "main" })).ok);
  const second = await wired.deps.pinCandidate({ submittedBy: { stage: "fix", cycle: 1, rescue: 0 } });
  assert.strictEqual(second.change, "superseded");
  assert.strictEqual(second.candidate.supersedes, first.candidate.candidate_id);

  const rec = wired.readRecord();
  assert.strictEqual(rec.impl_candidate.reference.kind, "bundle", "a new tree is a new candidate, and a new candidate owes its own publish");
  assert.ok(rec.impl_candidate.reference.verified_at);
  assert.strictEqual(rec.impl_state, "candidate", "§3.3: a re-pin never reopens a settled stage, and this one was already settled");
  // Both objects are in the store: the chain is auditable, not overwritten.
  for (const c of rec.impl_candidates) assert.ok(fs.existsSync(path.join(wired.home, "candidates", `${c.candidate_id}.bundle`)));
  assert.strictEqual(rec.impl_candidates.length, 2);
});

test("a publish that failed and then SUCCEEDS on a re-pin settles the stage — the retry path is not a dead end", async (t) => {
  const repo = producerRepo(t);
  const wired = pipelineFor(t, repo, { candidate: { publish: "branch" } });
  assert.ok((await wired.deps.changedPaths({ trustedRef: "main" })).ok);
  await wired.deps.pinCandidate({ submittedBy: { stage: "implementation", cycle: 0, rescue: 0 } });
  assert.strictEqual(wired.readRecord().impl_state, "running");

  // The outage clears — the remote appears — and the publish is re-attempted
  // FROM THE WORKSPACE on the next pin, with no second implementer dispatch.
  const remoteDir = scratch(t, "cand-remote");
  execFileSync("git", ["init", "-q", "--bare", remoteDir], { stdio: "ignore" });
  repo.g("remote", "add", "origin", pathToFileURL(remoteDir).href);

  assert.ok((await wired.deps.changedPaths({ trustedRef: "main" })).ok);
  const again = await wired.deps.pinCandidate({ submittedBy: { stage: "implementation", cycle: 0, rescue: 0 } });
  assert.strictEqual(again.change, "unchanged", "the same tree — a retry is by construction a re-pin");
  const rec = wired.readRecord();
  assert.ok(rec.impl_candidate.reference.verified_at, "the publish landed");
  assert.strictEqual(rec.publish_pending, null, "the debt is discharged");
  assert.strictEqual(rec.impl_state, "candidate", "…and the stage actually settles, rather than staying `running` forever");
});

test("publish_pending survives an in-process whole-record write, like the rest of the stage namespace", (t) => {
  const home = scratch(t, "cand-carry-home");
  const paths = dispatchRuns.runPaths(home, "run-1");
  fs.mkdirSync(path.dirname(paths.record), { recursive: true });
  fs.writeFileSync(paths.record, JSON.stringify({ run_id: "run-1", node_id: "task-x", state: "done" }));
  const handle = { paths, record: JSON.parse(fs.readFileSync(paths.record, "utf8")) };

  // The pin stamps the debt out of band, AFTER the handle's copy was taken…
  dispatchRuns.stampImplState(home, "run-1", {
    impl_state: "running",
    publish_pending: { reason: "the store is unreachable", classification: "infrastructure", at: "2026-09-06T00:00:00Z" },
  });
  // …and the supervisor then lands its verified outcome from that stale copy.
  dispatchRuns.updateRun(handle, { terminal_state: "reported" });

  const rec = JSON.parse(fs.readFileSync(paths.record, "utf8"));
  assert.strictEqual(rec.terminal_state, "reported");
  assert.strictEqual(rec.impl_state, "running");
  assert.strictEqual(rec.publish_pending.reason, "the store is unreachable", "the only record of WHY the candidate is unpublished is not erased by a later write");
});

for (const transport of ["environment", "repository", "environment-over-repository", "environment-relative", "repository-relative"]) {
  test(`branch publication preserves ${transport} SSH transport through push and isolated verification`, { skip: process.platform === "win32" }, async t => {
    const repo = producerRepo(t);
    const remote = scratch(t, "candidate-ssh-remote");
    execFileSync("git", ["init", "--bare", "-q", remote]);
    repo.g("remote", "add", "origin", "ssh://probe.invalid/remote.git");
    const log = path.join(scratch(t, "candidate-ssh-wrapper"), "calls.jsonl");
    const wrapper = path.join(path.dirname(log), "ssh wrapper");
    fs.writeFileSync(wrapper, `#!${process.execPath}\nconst fs=require('node:fs');\nconst args=process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(log)},JSON.stringify({cwd:process.cwd(),args,command:process.env.GIT_SSH_COMMAND,variant:process.env.GIT_SSH_VARIANT,terminal:process.env.GIT_TERMINAL_PROMPT,askpass:process.env.GIT_ASKPASS,signing:process.env.SPOR_ATTESTATION_KEY})+'\\n');\nconst mode=args.some(arg=>arg.includes('git-receive-pack'))?'receive-pack':'upload-pack';\nconst r=require('node:child_process').spawnSync('git',[mode,${JSON.stringify(remote)}],{stdio:'inherit'});process.exit(r.status??1);\n`, { mode: 0o700 });
    const commandPath = transport.endsWith("-relative") ? path.relative(repo.dir, wrapper) : wrapper;
    const command = `'${commandPath.replaceAll("'", "'\\''")}' --configured-wrapper`;
    const keys = ["GIT_SSH_COMMAND", "GIT_SSH", "GIT_SSH_VARIANT", "SPOR_ATTESTATION_KEY"];
    const old = Object.fromEntries(keys.map(k => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    t.after(() => { for (const k of keys) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } });
    if (transport.startsWith("repository")) {
      repo.g("config", "core.sshCommand", command);
      repo.g("config", "ssh.variant", "simple");
    } else {
      process.env.GIT_SSH_COMMAND = command;
      process.env.GIT_SSH_VARIANT = "simple";
      if (transport === "environment-over-repository") {
        repo.g("config", "core.sshCommand", "/this-configured-command-must-not-run");
        repo.g("config", "ssh.variant", "plink");
      }
    }
    process.env.SPOR_ATTESTATION_KEY = "must-not-leave-parent";
    const { gitSpawn } = require("../lib/shell/git-exec.js");
    const networkCalls = [];
    const git = (cwd, args, options) => {
      if (args.some(a => ["push", "fetch", "ls-remote"].includes(a))) networkCalls.push({ cwd, args, options });
      return gitSpawn(cwd, args, options);
    };
    const cand = mintFor(repo);
    const published = await publisher.publishCandidate(cand, { cwd: repo.dir, publish: "branch", remote: "origin", git });
    assert.equal(published.ok, true, published.reason);
    const replayed = await publisher.publishCandidate(cand, { cwd: repo.dir, publish: "branch", remote: "origin", git });
    assert.equal(replayed.ok, true, replayed.reason);
    assert.equal(replayed.candidate.reference.commit, repo.commit);
    const landed = execFileSync("git", ["-C", remote, "rev-parse", publisher.candidateRef(cand.candidate_id)], { encoding: "utf8" }).trim();
    assert.equal(landed, repo.commit);
    execFileSync("git", ["-C", remote, "update-ref", publisher.candidateRef(cand.candidate_id), repo.base]);
    const conflict = await publisher.publishCandidate(cand, { cwd: repo.dir, publish: "branch", remote: "origin", git });
    assert.equal(conflict.ok, false); assert.equal(conflict.classification, "publish-conflict");
    const calls = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(calls.some(c => c.cwd === repo.dir && c.args.some(a => a.includes("git-receive-pack"))));
    const fetchCalls = networkCalls.filter(c => c.args.includes("fetch"));
    assert.ok(fetchCalls.length >= 2, "fresh verification repositories used the same configured transport");
    for (const call of fetchCalls) {
      assert.equal(call.cwd, repo.dir, "relative transport paths retain producer cwd");
      assert.ok(call.args[0].startsWith("--git-dir="));
      assert.notEqual(call.args[0], `--git-dir=${path.join(repo.dir, ".git")}`, "verification has its own object database");
      assert.equal(call.options.env.GIT_SSH_COMMAND, command);
      assert.equal(call.options.env.GIT_SSH_VARIANT, "simple");
    }
    for (const call of calls) {
      assert.ok(call.args.includes("--configured-wrapper"));
      assert.equal(call.args.some(arg => arg.includes("BatchMode")), false);
      assert.equal(call.terminal, "0"); assert.equal(call.askpass, ""); assert.equal(call.signing, undefined);
    }
    assert.ok(networkCalls.some(c => c.args[0] === "ls-remote"), "existing ref replay checks use the same transport primitive");
    for (const call of networkCalls) {
      assert.equal(call.options.timeout, 300000, "publication retains its existing five-minute per-call budget");
      assert.equal(call.options.maxBuffer, undefined, "publication retains gitSpawn's existing default output bound");
    }
  });
}

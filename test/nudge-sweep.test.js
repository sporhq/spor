// The cross-session stranded-spool sweep
// (task-spor-nudge-async-cross-session-spool-sweep): the async capture nudge's
// two existing drains are both anchored on the OWNING session — its next
// prompt, or its own SessionEnd — so a dispatched agent session that fires
// neither strands classifier-verified findings nothing on the box comes back
// for. SessionStart spawns a DETACHED sweeper that recovers such a spool ONLY
// where a durable dispatch run record proves the owning session ended
// (dec-spor-stranded-spool-terminal-evidence-policy), under the ORIGIN's tenant
// and project, through the same atomic claim/consume protocol the other two
// drains share. Everything here runs against a throwaway SPOR_HOME.
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { runHook } = require("./helpers/portable");

const SWEEPER = path.join(__dirname, "..", "scripts", "engines", "spool-sweeper.js");
const sweeper = require("../scripts/engines/spool-sweeper.js");

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spor-nudge-sweep-"));
  const home = path.join(root, "graph");
  fs.mkdirSync(path.join(home, "nodes"), { recursive: true });
  fs.mkdirSync(path.join(home, "journal"), { recursive: true });
  const cwd = path.join(root, "projx");
  fs.mkdirSync(cwd);
  return { root, home, cwd };
}

function env(home, extra = {}) {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/^(SPOR_|SUBSTRATE_)/.test(k)) delete e[k];
  delete e.GEMINI_API_KEY;
  delete e.ANTHROPIC_API_KEY;
  e.SPOR_HOME = home;
  e.SPOR_ENABLED = "1";
  e.SPOR_NUDGE_ASYNC = "1";
  return { ...e, ...extra };
}

function spoolDir(home, session) {
  return path.join(home, "journal", "pending-nudges", session);
}

// A stranded spool: one classifier result, plus the origin record post-tool
// writes beside it. `origin: null` stages a LEGACY spool (written before the
// origin record shipped, or one whose write failed).
function seedSpool(home, session, { file, facts = "1. a stranded finding", hash = "r0", origin = {} } = {}) {
  const dir = spoolDir(home, session);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${hash}.out.json`),
    JSON.stringify({ file, facts, nfacts: 1, ts: "2026-09-05T00:00:00Z" })
  );
  if (origin) {
    fs.writeFileSync(
      path.join(dir, "origin.json"),
      JSON.stringify({
        session,
        slug: path.basename(path.dirname(file)),
        cwd: path.dirname(file),
        server: "",
        org: "",
        ts: "2026-09-05T00:00:00Z",
        ...origin,
      })
    );
  }
  return dir;
}

// The durable completion record `spor dispatch` writes. `state` is the run
// state vocabulary agent-dispatch-runner owns; only its terminal members are
// evidence that the bound session is over.
function seedRun(home, { runId = "run1", session, state = "done" } = {}) {
  const dir = path.join(home, "journal", "dispatch");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${runId}.run.json`),
    JSON.stringify({ run_id: runId, session_id: session, state, harness: "claude-code" })
  );
}

function runSweeper(home, cwd, session = "sweeper", extraEnv = {}) {
  const r = spawnSync(process.execPath, [SWEEPER, cwd, session], {
    env: env(home, extraEnv),
    encoding: "utf8",
  });
  assert.strictEqual(r.status, 0, `sweeper must exit 0: ${r.stderr}`);
  return r;
}

function outFiles(home, session) {
  try {
    return fs.readdirSync(spoolDir(home, session)).filter((f) => f.endsWith(".out.json"));
  } catch {
    return [];
  }
}

function nodeFiles(home) {
  return fs.readdirSync(path.join(home, "nodes")).filter((f) => f.endsWith(".md"));
}

function distillLog(home) {
  const p = path.join(home, "journal", "distill.log");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

function sweepJournal(home, session = "sweeper") {
  const p = path.join(home, "journal", `${session}.jsonl`);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse)
    .filter((l) => l.tool === "nudge-spool-sweep");
}

// -- terminal evidence -------------------------------------------------------

test("a terminated session's stranded spool is recovered, keyed on the ORIGIN session", () => {
  const { home, cwd } = scratch();
  const file = path.join(cwd, "notes.md");
  const facts = "1. the retry path was dismissed";
  seedSpool(home, "sA", { file, facts });
  seedRun(home, { session: "sA", state: "done" });

  runSweeper(home, cwd);

  assert.deepStrictEqual(outFiles(home, "sA"), [], "the recovered result is consumed");
  const nodes = nodeFiles(home);
  assert.strictEqual(nodes.length, 1, `one node expected, got ${JSON.stringify(nodes)}`);
  const md = fs.readFileSync(path.join(home, "nodes", nodes[0]), "utf8");
  // The capture is keyed on the ORIGIN session, so the id and the idempotency
  // key are the ones sA's OWN drain would have minted — a later SessionEnd
  // replay resolves to this node instead of writing a second one.
  const key = crypto.createHash("sha256").update(`sA\n${file}\n${facts}`).digest("hex");
  assert.match(md, new RegExp(`capture_key: ${key}`));
  assert.match(md, new RegExp(`^id: task-nudge-sessionend-notes-${key.slice(0, 16)}$`, "m"));
  assert.match(md, /1\. the retry path was dismissed/);

  const [line] = sweepJournal(home);
  assert.strictEqual(line.sessions, 1);
  assert.strictEqual(line.cleared, 1);
  assert.strictEqual(line.kept, 0);
});

test("a LIVE run record leaves the spool alone, and says so", () => {
  const { home, cwd } = scratch();
  seedSpool(home, "sA", { file: path.join(cwd, "notes.md") });
  seedRun(home, { session: "sA", state: "running" });

  runSweeper(home, cwd);

  assert.strictEqual(outFiles(home, "sA").length, 1, "a live session's finding is still its own to inject");
  assert.strictEqual(nodeFiles(home).length, 0);
  assert.deepStrictEqual(sweepJournal(home)[0].retained, { live: 1, unknown: 0, other_tenant: 0, unattributed: 0 });
});

test("age alone is never evidence: an ancient spool with no run record is retained and reported", () => {
  const { home, cwd } = scratch();
  const dir = seedSpool(home, "sA", { file: path.join(cwd, "notes.md") });
  const old = Date.now() - 30 * 24 * 3600 * 1000;
  fs.utimesSync(dir, old / 1000, old / 1000);

  runSweeper(home, cwd);

  assert.strictEqual(outFiles(home, "sA").length, 1, "no terminal evidence, no sweep — however old it is");
  assert.strictEqual(nodeFiles(home).length, 0);
  assert.deepStrictEqual(sweepJournal(home)[0].retained, { live: 0, unknown: 1, other_tenant: 0, unattributed: 0 });
  assert.match(distillLog(home), /no-terminal-evidence 1/);
});

test("a non-terminal state on the record is not evidence either", () => {
  const { home, cwd } = scratch();
  seedSpool(home, "sA", { file: path.join(cwd, "notes.md") });
  // A launched-but-unresolved record: the run is still the session's own.
  seedRun(home, { session: "sA", state: "launched" });
  runSweeper(home, cwd);
  assert.strictEqual(outFiles(home, "sA").length, 1);
  assert.strictEqual(sweepJournal(home)[0].retained.live, 1);
});

test("a record that never BOUND a session attributes to nobody", () => {
  const { home, cwd } = scratch();
  seedSpool(home, "sA", { file: path.join(cwd, "notes.md") });
  const dir = path.join(home, "journal", "dispatch");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "run1.run.json"), JSON.stringify({ run_id: "run1", state: "done" }));
  runSweeper(home, cwd);
  assert.strictEqual(outFiles(home, "sA").length, 1, "an unbound terminal record proves nothing about sA");
  assert.strictEqual(sweepJournal(home)[0].retained.unknown, 1);
});

// -- attribution -------------------------------------------------------------

test("two repos: each recovered finding is stamped to ITS OWN project, never the sweeper's", () => {
  const { root, home, cwd } = scratch();
  const other = path.join(root, "projy");
  fs.mkdirSync(other);
  seedSpool(home, "sA", { file: path.join(cwd, "a.md"), facts: "1. finding from projx" });
  seedSpool(home, "sB", { file: path.join(other, "b.md"), facts: "1. finding from projy" });
  seedRun(home, { runId: "r1", session: "sA" });
  seedRun(home, { runId: "r2", session: "sB" });

  // The sweeping session runs in a THIRD repo, so an ambient-slug stamp would
  // be visible as `repo: projz` on both nodes.
  const third = path.join(root, "projz");
  fs.mkdirSync(third);
  runSweeper(home, third);

  const bodies = nodeFiles(home).map((f) => fs.readFileSync(path.join(home, "nodes", f), "utf8"));
  assert.strictEqual(bodies.length, 2);
  const byRepo = Object.fromEntries(bodies.map((b) => [b.match(/^repo: (.+)$/m)[1], b]));
  assert.match(byRepo.projx, /finding from projx/);
  assert.match(byRepo.projy, /finding from projy/);
  assert.strictEqual(byRepo.projz, undefined, "the sweeping session's project must never be substituted");
});

test("the ORIGIN's project is the fallback when the classified file's checkout is gone", () => {
  const { root, home, cwd } = scratch();
  // A dispatch worktree that has since been torn down: the file's own directory
  // can no longer answer which project it belonged to.
  const gone = path.join(root, "worktrees", "projq");
  seedSpool(home, "sA", { file: path.join(gone, "notes.md"), origin: { slug: "projq" } });
  seedRun(home, { session: "sA" });

  runSweeper(home, cwd);

  const nodes = nodeFiles(home);
  assert.strictEqual(nodes.length, 1);
  assert.match(fs.readFileSync(path.join(home, "nodes", nodes[0]), "utf8"), /^repo: projq$/m);
});

test("another tenant's spool is retained, never captured into this graph", () => {
  const { home, cwd } = scratch();
  seedSpool(home, "sA", { file: path.join(cwd, "notes.md"), origin: { server: "https://api.example.test", org: "acme" } });
  seedRun(home, { session: "sA" });

  runSweeper(home, cwd); // local mode: server "", org ""

  assert.strictEqual(outFiles(home, "sA").length, 1, "a finding from another tenant is not this sweep's to file");
  assert.strictEqual(nodeFiles(home).length, 0);
  assert.strictEqual(sweepJournal(home)[0].retained.other_tenant, 1);
});

test("a remote sweeper does not adopt a LOCAL-mode spool either (and posts nothing)", () => {
  const { home, cwd } = scratch();
  seedSpool(home, "sA", { file: path.join(cwd, "notes.md") }); // origin server ""
  seedRun(home, { session: "sA" });

  runSweeper(home, cwd, "sweeper", { SPOR_SERVER: "http://127.0.0.1:1", SPOR_TOKEN: "spor_pat_test" });

  assert.strictEqual(outFiles(home, "sA").length, 1);
  assert.strictEqual(fs.existsSync(path.join(home, "outbox")), false, "nothing was posted or spooled for a foreign tenant");
});

test("a legacy spool with no origin record is retained and reported, never guessed at", () => {
  const { home, cwd } = scratch();
  seedSpool(home, "sA", { file: path.join(cwd, "notes.md"), origin: null });
  seedRun(home, { session: "sA" });

  runSweeper(home, cwd);

  assert.strictEqual(outFiles(home, "sA").length, 1);
  assert.strictEqual(nodeFiles(home).length, 0);
  assert.strictEqual(sweepJournal(home)[0].retained.unattributed, 1);
});

// -- the disposition matrix, unit-level (the org half of a tenant needs no
// credential store to be pinned) --------------------------------------------

test("classifySpools: every disposition, including an org-only tenant mismatch", () => {
  const { home, cwd } = scratch();
  seedSpool(home, "recover", { file: path.join(cwd, "a.md"), origin: { server: "https://api.x", org: "acme" } });
  seedSpool(home, "live", { file: path.join(cwd, "b.md"), origin: { server: "https://api.x", org: "acme" } });
  seedSpool(home, "unknown", { file: path.join(cwd, "c.md"), origin: { server: "https://api.x", org: "acme" } });
  seedSpool(home, "otherorg", { file: path.join(cwd, "d.md"), origin: { server: "https://api.x", org: "globex" } });
  seedSpool(home, "otherserver", { file: path.join(cwd, "e.md"), origin: { server: "https://api.y", org: "acme" } });
  seedSpool(home, "legacy", { file: path.join(cwd, "f.md"), origin: null });
  seedSpool(home, "empty", { file: path.join(cwd, "g.md"), origin: { server: "https://api.x", org: "acme" } });
  fs.unlinkSync(path.join(spoolDir(home, "empty"), "r0.out.json")); // nothing owed

  const got = Object.fromEntries(
    sweeper
      .classifySpools(home, "self", {
        tenant: { server: "https://api.x", org: "acme" },
        evidence: new Map([
          ["recover", { terminal: true, state: "done" }],
          ["live", { terminal: false, state: "running" }],
          ["otherorg", { terminal: true, state: "done" }],
          ["otherserver", { terminal: true, state: "done" }],
          ["legacy", { terminal: true, state: "done" }],
        ]),
      })
      .map((s) => [s.session, s.disposition])
  );
  assert.deepStrictEqual(got, {
    recover: "recover",
    live: "live",
    unknown: "unknown",
    otherorg: "other_tenant",
    otherserver: "other_tenant",
    legacy: "unattributed",
  });
});

test("terminalSessions: a session bound by both a live and a terminal record reads LIVE", () => {
  const { home } = scratch();
  seedRun(home, { runId: "r1", session: "sA", state: "done" });
  seedRun(home, { runId: "r2", session: "sA", state: "running" });
  seedRun(home, { runId: "r3", session: "sB", state: "vanished" });
  const ev = sweeper.terminalSessions(home);
  assert.strictEqual(ev.get("sA").terminal, false, "the conservative reading wins");
  assert.strictEqual(ev.get("sB").terminal, true, "a vanished run is over");
});

test("evidence is read from the USER-CONFIG home, which a shared-graph marker splits from the spool's", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spor-nudge-sweep-split-"));
  const personal = path.join(root, "personal");
  const shared = path.join(root, "shared");
  fs.mkdirSync(path.join(personal, "journal"), { recursive: true });
  fs.mkdirSync(path.join(shared, "nodes"), { recursive: true });
  const cwd = path.join(root, "projx");
  fs.mkdirSync(cwd);
  // A repo `.spor` marker binds the GRAPH home elsewhere; run records keep
  // living under the personal home every launcher writes them to.
  fs.writeFileSync(path.join(cwd, ".spor"), `project: projx\ngraph: ${shared}\n`);
  seedSpool(shared, "sA", { file: path.join(cwd, "notes.md") });
  seedRun(personal, { session: "sA" });

  runSweeper(personal, cwd);

  assert.deepStrictEqual(outFiles(shared, "sA"), [], "the record under the personal home is still the evidence");
  assert.strictEqual(nodeFiles(shared).length, 1, "and the capture lands in the SHARED graph");
});

// -- concurrency and retryability -------------------------------------------

test("a result CLAIMED by a live drain is left for its owner, not captured twice", () => {
  const { home, cwd } = scratch();
  const dir = seedSpool(home, "sA", { file: path.join(cwd, "notes.md") });
  seedRun(home, { session: "sA" });
  // The atomic claim the prompt-time and SessionEnd drains share
  // (dec-spor-nudge-drain-atomic-claim): this test process is a live owner, so
  // the sweeper must walk past the result rather than act on it.
  const claimed = `r0.claim-${process.pid}-${Date.now()}.out.json`;
  fs.renameSync(path.join(dir, "r0.out.json"), path.join(dir, claimed));

  runSweeper(home, cwd);

  assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".out.json")), [claimed], "the claim is honored");
  assert.strictEqual(nodeFiles(home).length, 0);
});

test("two sweepers over one spool capture each finding exactly once", async () => {
  const { home, cwd } = scratch();
  for (const [i, h] of ["r0", "r1", "r2"].entries()) {
    seedSpool(home, "sA", { file: path.join(cwd, "notes.md"), hash: h, facts: `1. finding number ${i}` });
  }
  seedRun(home, { session: "sA" });

  await Promise.all(
    [0, 1].map(
      (n) =>
        new Promise((resolve) => {
          const { spawn } = require("node:child_process");
          const c = spawn(process.execPath, [SWEEPER, cwd, `sweeper${n}`], { env: env(home), stdio: "ignore" });
          c.on("exit", resolve);
        })
    )
  );

  assert.deepStrictEqual(outFiles(home, "sA"), []);
  const bodies = nodeFiles(home).map((f) => fs.readFileSync(path.join(home, "nodes", f), "utf8"));
  assert.strictEqual(bodies.length, 3, `three findings, three nodes: ${JSON.stringify(nodeFiles(home))}`);
  for (const i of [0, 1, 2]) {
    assert.strictEqual(
      bodies.filter((b) => b.includes(`1. finding number ${i}`)).length,
      1,
      `finding ${i} must be captured exactly once`
    );
  }
});

test("a failed capture keeps the finding spooled, and the retry lands it with the ORIGIN's attribution", () => {
  const { root, home, cwd } = scratch();
  const other = path.join(root, "projy");
  fs.mkdirSync(other);
  fs.rmSync(path.join(home, "nodes"), { recursive: true }); // graph home not initialized yet
  seedSpool(home, "sA", { file: path.join(other, "notes.md") });
  seedRun(home, { session: "sA" });

  runSweeper(home, cwd);
  assert.strictEqual(outFiles(home, "sA").length, 1, "a transient failure must not destroy the only copy");
  assert.match(distillLog(home), /kept in the spool: no local graph/);
  assert.strictEqual(sweepJournal(home)[0].kept, 1, "and the tally reports it as kept, not cleared");

  fs.mkdirSync(path.join(home, "nodes"), { recursive: true });
  runSweeper(home, cwd);
  assert.deepStrictEqual(outFiles(home, "sA"), []);
  const nodes = nodeFiles(home);
  assert.strictEqual(nodes.length, 1);
  assert.match(fs.readFileSync(path.join(home, "nodes", nodes[0]), "utf8"), /^repo: projy$/m);
});

test("a re-swept finding resolves to the node it already wrote, never a second one", () => {
  const { home, cwd } = scratch();
  const file = path.join(cwd, "notes.md");
  seedSpool(home, "sA", { file });
  seedRun(home, { session: "sA" });
  runSweeper(home, cwd);
  const written = nodeFiles(home);
  assert.strictEqual(written.length, 1);

  // The crash window the deferred consume leaves open: the node landed but the
  // spool file outlived it.
  seedSpool(home, "sA", { file });
  runSweeper(home, cwd);
  assert.deepStrictEqual(nodeFiles(home), written, "a replay must not mint a second node");
  assert.deepStrictEqual(outFiles(home, "sA"), []);
});

test("the sweeper never touches the RUNNING session's own spool", () => {
  const { home, cwd } = scratch();
  seedSpool(home, "sA", { file: path.join(cwd, "notes.md") });
  seedRun(home, { session: "sA" }); // even with terminal evidence: it is ours now
  runSweeper(home, cwd, "sA");
  assert.strictEqual(outFiles(home, "sA").length, 1, "the running session's own drains own it");
  assert.strictEqual(nodeFiles(home).length, 0);
});

// -- the gates ---------------------------------------------------------------

test("SPOR_NUDGE=0 suppresses the sweep, like every other nudge path", () => {
  const { home, cwd } = scratch();
  seedSpool(home, "sA", { file: path.join(cwd, "notes.md") });
  seedRun(home, { session: "sA" });
  runSweeper(home, cwd, "sweeper", { SPOR_NUDGE: "0" });
  assert.strictEqual(outFiles(home, "sA").length, 1);
  assert.strictEqual(nodeFiles(home).length, 0);
});

test("nudge.async off is a no-op even when the sweeper is invoked directly", () => {
  const { home, cwd } = scratch();
  seedSpool(home, "sA", { file: path.join(cwd, "notes.md") });
  seedRun(home, { session: "sA" });
  runSweeper(home, cwd, "sweeper", { SPOR_NUDGE_ASYNC: "0" });
  assert.strictEqual(outFiles(home, "sA").length, 1);
  assert.strictEqual(nodeFiles(home).length, 0);
});

// -- the door: SessionStart ---------------------------------------------------

function sessionStart(home, cwd, session, extraEnv = {}) {
  const payload = JSON.stringify({ cwd, session_id: session, hook_event_name: "SessionStart", source: "startup" });
  const r = runHook(["session-start", "--host", "claude-code"], payload, env(home, extraEnv));
  assert.strictEqual(r.status, 0, `exit 0 expected: ${r.stderr}`);
  return r.stdout;
}

async function waitFor(pred, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

test("SessionStart spawns the sweep, and a stranded finding lands with no session of its own", async () => {
  const { home, cwd } = scratch();
  seedSpool(home, "sA", { file: path.join(cwd, "notes.md"), facts: "1. a finding no session came back for" });
  seedRun(home, { session: "sA" });

  sessionStart(home, cwd, "sNew");

  assert.ok(await waitFor(() => nodeFiles(home).length === 1), "the detached sweeper must recover the spool");
  assert.deepStrictEqual(outFiles(home, "sA"), []);
  assert.match(
    fs.readFileSync(path.join(home, "nodes", nodeFiles(home)[0]), "utf8"),
    /a finding no session came back for/
  );
});

test("SessionStart with nudge.async OFF leaves the spool untouched (the synchronous default)", async () => {
  const { home, cwd } = scratch();
  seedSpool(home, "sA", { file: path.join(cwd, "notes.md") });
  seedRun(home, { session: "sA" });

  sessionStart(home, cwd, "sNew", { SPOR_NUDGE_ASYNC: "0" });

  await new Promise((r) => setTimeout(r, 500));
  assert.strictEqual(outFiles(home, "sA").length, 1, "no sweep runs on the shipped sync path");
  assert.strictEqual(nodeFiles(home).length, 0);
});

test("SessionStart pays no spawn when there is nothing stranded", () => {
  const { home, cwd } = scratch();
  // Only the running session's own spool: hasSweepCandidates must say no.
  seedSpool(home, "sNew", { file: path.join(cwd, "notes.md") });
  assert.strictEqual(sweeper.hasSweepCandidates(home, "sNew"), false);
  seedSpool(home, "sA", { file: path.join(cwd, "notes.md") });
  assert.strictEqual(sweeper.hasSweepCandidates(home, "sNew"), true);
  // A spool with no result left is nothing to come back for.
  fs.unlinkSync(path.join(spoolDir(home, "sA"), "r0.out.json"));
  assert.strictEqual(sweeper.hasSweepCandidates(home, "sNew"), false);
});

test("the box sweeps at most once per interval, and stamps before it spawns", () => {
  const { home, cwd } = scratch();
  const stamp = path.join(home, "journal", "spool-swept");
  // Nothing stranded: no pass is due and no stamp is written, so the first real
  // candidate is not throttled by a pass that never happened.
  assert.strictEqual(sweeper.shouldSweep(home, "sNew"), false);
  assert.strictEqual(fs.existsSync(stamp), false);

  seedSpool(home, "sA", { file: path.join(cwd, "notes.md") });
  assert.strictEqual(sweeper.shouldSweep(home, "sNew"), true);
  assert.ok(fs.existsSync(stamp), "the stamp lands BEFORE the sweeper is spawned");
  assert.strictEqual(sweeper.shouldSweep(home, "sNew"), false, "a second session start inside the interval is throttled");
  assert.strictEqual(sweeper.shouldSweep(home, "sNew", { intervalMs: 0 }), true, "interval 0 disables the throttle");
  assert.strictEqual(
    sweeper.shouldSweep(home, "sNew", { now: Date.now() + 3600000 }),
    true,
    "and the next interval sweeps again"
  );
});

test("an unreadable stamp sweeps rather than skips (the safe side is doing the work)", () => {
  const { home, cwd } = scratch();
  seedSpool(home, "sA", { file: path.join(cwd, "notes.md") });
  fs.writeFileSync(path.join(home, "journal", "spool-swept"), "not a number\n");
  assert.strictEqual(sweeper.shouldSweep(home, "sNew"), true);
});

// -- the origin record post-tool writes --------------------------------------

test("post-tool records the spool's origin in async mode, and nothing in sync mode", () => {
  const { root, home, cwd } = scratch();
  const file = path.join(cwd, "doc.md");
  const content = Array.from({ length: 8 }, (_, i) => `Line ${i}: a durable finding about the retry path and why it was dismissed.`).join("\n");
  const payload = (session) =>
    JSON.stringify({
      cwd,
      session_id: session,
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: file, content },
    });
  // A backend that never answers is fine: the async path spools and returns
  // before any classification.
  const stub = path.join(root, "stub.js");
  fs.writeFileSync(stub, "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('NOTHING\\n'));\n");
  const cmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(stub)}`;

  let r = runHook(["post-tool", "--host", "claude-code"], payload("sAsync"), env(home, { SPOR_NUDGE_CMD: cmd }));
  assert.strictEqual(r.status, 0, r.stderr);
  const origin = JSON.parse(fs.readFileSync(path.join(spoolDir(home, "sAsync"), "origin.json"), "utf8"));
  assert.strictEqual(origin.session, "sAsync");
  assert.strictEqual(origin.slug, "projx");
  assert.strictEqual(origin.server, "");

  r = runHook(
    ["post-tool", "--host", "claude-code"],
    payload("sSync"),
    env(home, { SPOR_NUDGE_ASYNC: "0", SPOR_NUDGE_CMD: cmd })
  );
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.existsSync(spoolDir(home, "sSync")), false, "the sync path spools nothing at all");
});

// task-spor-work-reload-factory-end-to-end-test: the literal `reloadFactory`
// closure in bin/spor.js (cmdWork) — the one that reassigns cmdWork's own
// `factory` binding every poll pass — has two hand-written-fake tests today:
// a unit test of loadFactoryDefinition's revision (gate-pipeline.test.js) and
// a harness-level test of work-loop.js's *calling contract* for the
// `deps.reloadFactory` hook (work-loop.test.js), both driven with a fake dep.
// Neither one spawns the REAL CLI and edits a REAL factory node mid-run, so
// nothing exercises the actual wiring: that `spor work` (no --once) re-reads
// the factory node from the graph every pass, swaps its `factory` binding on
// a clean parse, keeps the last good one on a bad edit, and reports whichever
// one is live in `spor work --status` — end to end, through the graph file on
// disk and the worker's published status file, not through a fake.
//
// Kept hermetic (a scratch SPOR_HOME, no server) and bounded (`--interval 1`,
// a handful of 1s poll passes with a generous overall deadline) per the
// filing task's own instruction. No dispatch harness is declared and no task
// node exists in the scratch graph — the reload runs unconditionally at the
// top of every pass regardless of whether anything is eligible to dispatch,
// so an empty queue is enough to exercise it and keeps this test far cheaper
// than the full gate-pipeline dispatch fixtures.
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const { gitBlobSha } = require("../bin/spor.js");
const { pathWithOnlyGitAndNode } = require("./helpers/portable");

function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("SPOR_") || key.startsWith("SUBSTRATE_") || key === "XDG_CONFIG_HOME") continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

function cli(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], { env: cleanEnv(env), encoding: "utf8", timeout: 120000 });
}

// Writes the factory-demo node's markdown and returns its raw bytes so the
// test can compute the SAME git-blob-sha `loadFactoryDefinition` will (the
// exact oracle bin/spor.js uses for `revision`), rather than pattern-matching
// a truncated hex prefix out of --status text.
// Writes via a temp file + rename rather than a plain fs.writeFileSync: the
// worker under test is concurrently POLLING this exact path every ~1s
// (resolveNode's local branch does a plain readFileSync), and a truncate-
// then-write is not atomic against that reader — a rename is, so the reader
// only ever sees the old bytes or the new ones, never a half-written file
// that would surface as an unrelated "could not be read" error instead of
// the parse failure this test is deliberately provoking.
function writeFactory(nodes, payload, { status = "active", tag = "" } = {}) {
  const body = typeof payload === "string" ? payload : ["```json", JSON.stringify(payload), "```"].join("\n");
  const raw = `---\nid: factory-demo\ntype: factory\ntitle: The demo factory${tag}\nsummary: The gate pipeline this scratch worker enforces.\nstatus: ${status}\ndate: 2026-09-05\n---\n${body}\n`;
  const dest = path.join(nodes, "factory-demo.md");
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, raw);
  fs.renameSync(tmp, dest);
  return raw;
}

function noopGate(id) {
  return { id, kind: "command", command: `${JSON.stringify(process.execPath)} -e "process.exit(0)"` };
}

async function waitFor(fn, { deadlineMs = 15000, stepMs = 200, label = "condition" } = {}) {
  const deadline = Date.now() + deadlineMs;
  let last;
  for (;;) {
    last = fn();
    if (last && last.ok) return last;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}; last reading: ${JSON.stringify(last)}`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

// Reads back the one worker this scratch home ever runs, via the real CLI
// (`spor work --status --json`) — the same surface an operator watching a
// live worker would read, not a direct file peek at the status json.
function readWorker(env) {
  const r = cli(["work", "--status", "--json"], env);
  if (r.status !== 0) return { ok: false, error: r.stderr || r.status };
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    return { ok: false, error: `--status --json did not parse: ${e.message}\n${r.stdout}` };
  }
  const worker = (parsed.workers || [])[0];
  if (!worker) return { ok: false, error: "no worker recorded yet" };
  return { ok: true, worker };
}

test("a real `spor work` process reloads factory-demo every poll pass: a mid-run edit's revision reaches `--status`, a bad edit keeps the last good one and is surfaced as an error, and a later good edit recovers", { skip: process.platform === "win32" && "no SIGTERM to end the worker cleanly on Windows" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-work-reload-e2e-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes, { recursive: true });

  const raw1 = writeFactory(nodes, { factory: "demo", gates: [noopGate("acceptance")] });
  const rev1 = gitBlobSha(Buffer.from(raw1));

  const env = cleanEnv({ SPOR_HOME: home, XDG_CONFIG_HOME: home, PATH: pathWithOnlyGitAndNode() });
  // No --once: this is the long-running-worker case the filing task names —
  // the loop must keep re-reading the factory node pass after pass, with no
  // restart, for as long as it runs. An empty queue means it never dispatches
  // anything, which is exactly what keeps this test cheap: the reload runs
  // unconditionally before candidate selection.
  const child = spawn(process.execPath, [CLI, "work", "--interval", "1", "--no-brief", "--no-worktree", "--factory", "factory-demo"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (c) => (stdout += c));
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));

  try {
    // 1. Startup: the worker judges with the revision it booted with.
    await waitFor(
      () => {
        const r = readWorker(env);
        if (!r.ok) return r;
        return { ok: r.worker.gates && r.worker.gates.factory_revision === rev1, worker: r.worker };
      },
      { label: `startup revision to reach ${rev1.slice(0, 12)} (stdout so far: ${stdout} stderr: ${stderr})` }
    );

    // 2. A clean mid-run edit: the NEXT pass swaps the binding, with no
    // restart — the mechanism task-spor-work-reload-factory-definition-per-
    // pass added and this task exists to prove end to end.
    const raw2 = writeFactory(nodes, { factory: "demo", gates: [noopGate("acceptance"), noopGate("lint")] }, { tag: " v2" });
    const rev2 = gitBlobSha(Buffer.from(raw2));
    assert.notStrictEqual(rev2, rev1, "the edit must actually change the node's bytes, or this proves nothing");
    const afterGood = await waitFor(
      () => {
        const r = readWorker(env);
        if (!r.ok) return r;
        return { ok: r.worker.gates && r.worker.gates.factory_revision === rev2, worker: r.worker };
      },
      { label: `reloaded revision to reach ${rev2.slice(0, 12)} after the clean edit` }
    );
    assert.strictEqual(afterGood.worker.gates.factory_error, null, "a clean reload clears any prior error");

    // 3. A bad edit (malformed fenced JSON): the loop must keep enforcing the
    // LAST GOOD definition (rev2) rather than ever falling back to running
    // ungated, and must surface the rejection in --status.
    writeFactory(nodes, "```json\n{ this is not valid json,,, \n```", { tag: " v3 (broken)" });
    const BAD_EDIT_ERROR = /payload json block does not parse/;
    // Wait for the SPECIFIC rejection this edit provokes, not just any
    // truthy factory_error: a poll can land mid-write (even with the atomic
    // rename above, there is a window between this write and the next poll
    // where the OLD file is still what's read) and briefly report an
    // unrelated transient reading before the new file is picked up — looping
    // on the exact message is what makes this robust rather than a one-shot
    // check outside the retry loop.
    const afterBad = await waitFor(
      () => {
        const r = readWorker(env);
        if (!r.ok) return r;
        const err = r.worker.gates && r.worker.gates.factory_error;
        return { ok: !!err && BAD_EDIT_ERROR.test(err), worker: r.worker };
      },
      { label: "the malformed-json factory_error to appear after the broken edit" }
    );
    assert.strictEqual(afterBad.worker.gates.factory_revision, rev2, "a rejected reload must not overwrite the still-enforcing revision");
    assert.match(afterBad.worker.gates.factory_error, BAD_EDIT_ERROR);

    // 4. A later good edit recovers: a worker that survived a bad edit is not
    // stuck on it forever, and the error clears the moment a clean parse lands.
    const raw4 = writeFactory(nodes, { factory: "demo", gates: [noopGate("acceptance")] }, { tag: " v4 (fixed)" });
    const rev4 = gitBlobSha(Buffer.from(raw4));
    assert.notStrictEqual(rev4, rev2, "the recovery edit must also actually change the node's bytes");
    const afterRecovered = await waitFor(
      () => {
        const r = readWorker(env);
        if (!r.ok) return r;
        return { ok: r.worker.gates && r.worker.gates.factory_revision === rev4 && !r.worker.gates.factory_error, worker: r.worker };
      },
      { label: `recovered revision to reach ${rev4.slice(0, 12)} with the error cleared` }
    );
    assert.strictEqual(afterRecovered.worker.gates.factory_error, null);

    // The worker itself never crashed or exited across any of this.
    assert.strictEqual(child.exitCode, null, `the worker must still be running throughout\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        resolve();
      }, 5000);
      child.on("close", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
});

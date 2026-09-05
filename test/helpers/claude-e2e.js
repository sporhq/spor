"use strict";
// E2E driver: run the REAL `claude` binary with the Spor plugin loaded, hermetically,
// against the fake Anthropic API (task-spor-e2e-integration-tests).
//
// Hermeticity matters twice over. A configured dev box has the INSTALLED spor plugin and
// SPOR_* env (SPOR_SERVER/SPOR_TOKEN) in ~/.claude/settings.json, and claude merges that
// env into the hook environment — which would put the hooks in REMOTE mode against the
// LIVE team graph, both contaminating the assertions and risking writes to the real graph
// (norm-cc-scratch-home-for-tests). A fresh CLAUDE_CONFIG_DIR + a clean HOME + a curated
// env (we pass `env:` to spawnSync, which REPLACES rather than merges the environment)
// severs both leaks: no settings.json env, no installed plugins double-firing the hooks.

const { spawn, spawnSync, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

let _runSeq = 0;

// The plugin under test is this checkout (the worktree/repo root two levels up). Resolving
// it from the helper's own location means the E2E run exercises whatever tree the test
// file lives in, not a globally installed copy.
const PLUGIN_ROOT = path.resolve(__dirname, "..", "..");

// A distill/nudge CMD stub that consumes stdin and emits NOTHING — neutralizes a backend
// so the fake never has to emulate the distiller's node markdown or the classifier verdict
// (the brief's "cap fidelity by stubbing Spor's own CMD seams"). Must `cat >/dev/null`
// first or the prompt pipe SIGPIPEs.
const NOTHING_CMD = "cat >/dev/null; echo NOTHING";

// Resolve a SPOR_E2E_CLAUDE override (task-spor-e2e-claude-version-matrix-sandbox)
// to an existing binary, or null. The override picks WHICH Claude Code version the suite
// runs against — so a version matrix (CI or local) is just re-running with a different value.
// Two accepted forms:
//   - a path (anything with a separator, or that exists as a file) → used as-is if it exists;
//   - a bare version string (e.g. "2.1.177") → resolved to the native install layout
//     ~/.local/share/claude/versions/<version> (each version is a standalone binary there;
//     the active ~/.local/bin/claude is just a symlink to one), so a version can be selected
//     WITHOUT disturbing the operator's active symlink. Other layouts: pass a full path.
// The fake serves a dummy key, so any version runs offline — no auth, no real API.
function resolveClaudeOverride(v) {
  if (v.includes("/") || v.includes(path.sep) || fs.existsSync(v)) {
    return fs.existsSync(v) ? v : null;
  }
  const native = path.join(os.homedir(), ".local", "share", "claude", "versions", v);
  return fs.existsSync(native) ? native : null;
}

// Is the real claude binary usable for E2E? Tests self-skip when it is not: CI runs
// `npm test` on a runner without claude, and the suite must stay green there. SPOR_E2E=0
// force-skips even when the binary is present (a fast inner-loop escape hatch);
// SPOR_E2E_CLAUDE=<path|version> runs against a specific Claude Code version instead of PATH.
let _claudePath;
function claudePath() {
  if (_claudePath !== undefined) return _claudePath;
  const override = process.env.SPOR_E2E_CLAUDE;
  if (override) {
    _claudePath = resolveClaudeOverride(override);
    return _claudePath;
  }
  try {
    _claudePath = execFileSync("bash", ["-lc", "command -v claude"], { encoding: "utf8" }).trim() || null;
  } catch {
    _claudePath = null;
  }
  return _claudePath;
}

// Why the E2E tier should skip, or null when it can run — used as the node:test `skip`
// reason so a missing/unresolvable binary reads clearly in the output.
function claudeSkipReason() {
  if (process.env.SPOR_E2E === "0") return "SPOR_E2E=0";
  if (!claudePath()) {
    return process.env.SPOR_E2E_CLAUDE
      ? `SPOR_E2E_CLAUDE='${process.env.SPOR_E2E_CLAUDE}' did not resolve to an existing claude binary`
      : "claude binary not on PATH";
  }
  return null;
}
function claudeAvailable() {
  return claudeSkipReason() === null;
}

// The resolved binary's `--version` (best-effort) — handy as a one-line diagnostic so a
// matrix run records which Claude Code version it actually exercised.
function claudeVersion() {
  const bin = claudePath();
  if (!bin) return null;
  try {
    return execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 10000 }).trim() || null;
  } catch {
    return null;
  }
}

// Build one node's markdown from a spec ({ id, type, repo?, title, summary, version?,
// body?, date? }) or pass a raw markdown string through unchanged.
function nodeMarkdown(n) {
  if (typeof n === "string") return n;
  const fm = [`id: ${n.id}`, `type: ${n.type}`];
  if (n.repo) fm.push(`repo: ${n.repo}`);
  fm.push(`title: ${n.title}`);
  fm.push(`summary: ${n.summary}`);
  if (n.version != null) fm.push(`version: ${n.version}`);
  fm.push(`date: ${n.date || "2026-06-17"}`);
  return `---\n${fm.join("\n")}\n---\n${n.body || n.summary}\n`;
}

function git(dir, args) {
  spawnSync("git", ["-c", "user.email=e2e@test", "-c", "user.name=e2e", ...args], { cwd: dir, stdio: "ignore" });
}

// Find every process whose environment contains at least one of `markers` as a
// substring (Linux /proc only; returns [] anywhere else — best-effort, same
// posture as the rest of this file's process introspection). Used to find a
// detached grandchild that outlives the `claude` process we spawned: it
// inherited our unique scratch-dir env values at fork time, and keeps them
// even if it double-forks and reparents to init, which drops it out of any
// pid/ppid chain we could have recorded up front
// (task-spor-e2e-claude-scratch-home-leak).
function markedPids(markers) {
  let entries;
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return [];
  }
  const pids = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let environ;
    try {
      environ = fs.readFileSync(`/proc/${entry}/environ`, "utf8");
    } catch {
      continue; // exited between readdir and read, or not ours to read
    }
    if (markers.some((m) => environ.includes(m))) pids.push(Number(entry));
  }
  return pids;
}

function killSignal(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false; // already gone, or not permitted
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stop every process marked by `markers`, then remove `paths` — in that
// order, so a straggler that is still writing into one of `paths` cannot
// recreate it the instant after we delete it. SIGTERM first, escalate to
// SIGKILL for anything still alive past `deadlineMs`; two passes because a
// process that forks a beat late (a check-then-signal race) can still slip in
// between the first pass's scan and its own rmSync, and the second pass's
// scan catches exactly that (same reasoning as gate-pipeline's
// stopOrphanedRuns). Cheap when there is nothing to reap: each pass costs one
// /proc scan and no sleep unless it actually finds a pid.
// Wait (without killing anything) for any process tagged with `markers` to
// finish on its own, so a caller about to reclaim shared paths doesn't yank
// them out from under a detached grandchild that is still reading them —
// the opposite failure mode from reapAndClean below, which is for a caller
// that no longer cares whether the process survives. Bounded two ways: a
// `warmupMs` grace period to let a marked process even get scheduled/spawn
// under load before we conclude nothing is coming, and an overall `maxMs`
// cap so a process that genuinely never exits (crashed mid-write, wedged)
// can't wedge teardown forever. Cheap when nothing is tagged: one /proc scan
// per `stepMs` until warmupMs elapses, no sleep beyond that.
async function waitForMarkedQuiescence(markers, { warmupMs = 5000, maxMs = 20000, stepMs = 100 } = {}) {
  const start = Date.now();
  let sawAny = false;
  for (;;) {
    const elapsed = Date.now() - start;
    if (elapsed >= maxMs) return;
    const pids = markedPids(markers);
    if (pids.length) {
      sawAny = true;
    } else if (sawAny || elapsed >= warmupMs) {
      return; // it ran and finished, or nothing ever showed up
    }
    await sleep(stepMs);
  }
}

async function reapAndClean(markers, paths, { deadlineMs = 2000, stepMs = 100, passes = 2 } = {}) {
  for (let pass = 0; pass < passes; pass++) {
    let pids = markedPids(markers);
    const deadline = Date.now() + deadlineMs;
    while (pids.length && Date.now() < deadline) {
      for (const pid of pids) killSignal(pid, "SIGTERM");
      await sleep(stepMs);
      pids = markedPids(markers);
    }
    for (const pid of pids) killSignal(pid, "SIGKILL");
    for (const p of paths) {
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

// Create a scratch graph home (git-inited) plus a project checkout whose project slug is
// `slug`. The project dir is its own git repo so projectSlug() (git toplevel basename)
// resolves deterministically to `slug` rather than to some ancestor repo of os.tmpdir().
function makeScratchGraph({ slug = "e2eproj", nodes = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spor-e2e-"));
  const home = path.join(root, "graph");
  const nodesDir = path.join(home, "nodes");
  fs.mkdirSync(nodesDir, { recursive: true });
  for (const n of nodes) {
    const md = nodeMarkdown(n);
    const id = typeof n === "string" ? (md.match(/^id:\s*(\S+)/m) || [])[1] : n.id;
    fs.writeFileSync(path.join(nodesDir, `${id}.md`), md);
  }
  git(home, ["init", "-q"]);
  git(home, ["add", "-A"]);
  git(home, ["commit", "-qm", "seed", "--allow-empty"]);
  const cwd = path.join(root, slug);
  fs.mkdirSync(cwd, { recursive: true });
  git(cwd, ["init", "-q"]);
  git(cwd, ["commit", "-qm", "init", "--allow-empty"]);
  return {
    root,
    home,
    nodesDir,
    cwd,
    slug,
    // Async: a caller that had detached work outliving `claude` (the
    // SessionEnd distiller) should already have waited for it before calling
    // this, but a run that never finished in time still leaves a grandchild
    // writing into `home` — reap it (tagged by SPOR_HOME=home in its
    // environment) before removing `root`, or it recreates a `spor-e2e-*`
    // husk right after this deletes it (task-spor-e2e-claude-scratch-home-leak).
    cleanup: () => reapAndClean([home], [root]),
  };
}

// Run `claude --plugin-dir <root> -p <prompt>` against the fake. Async — resolves to
// { rc, result, stdout, stderr, timedOut }. The session distill/nudge backends are stubbed
// to NOTHING by default; pass distillCmd/nudgeCmd to script them. `distilling: true` sets
// the SPOR_DISTILLING recursion guard, which suppresses the SessionEnd distill, the
// PostToolUse nudge, AND the UserPromptSubmit digest
// (issue-spor-digest-fires-on-headless-backend-personas) — use it only for tests that
// exercise none of them and want no async noise.
//
// We use async spawn and resolve on the CHILD's `exit`, NOT spawnSync: claude 2.x leaves a
// persistent background daemon running, and spawnSync blocks on process-group/stdio
// teardown that the daemon keeps alive, hanging until its timeout even though `claude -p`
// itself exited in ~1s. `exit` fires when the direct child exits, regardless of the
// lingering daemon. stdout/stderr go to temp files (not pipes) so the daemon inheriting an
// fd can't keep a pipe open either.
function runClaude({
  home,
  cwd,
  baseUrl,
  prompt,
  model = "claude-sonnet-4-5",
  distillCmd = NOTHING_CMD,
  nudgeCmd = NOTHING_CMD,
  skipPermissions = false,
  distilling = false,
  extraEnv = {},
  timeoutMs = 60000,
}) {
  // Fresh, throwaway config + HOME per run: no user settings.json (env + installed
  // plugins) leaks in, and the run can't touch the operator's real ~/.claude.
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-e2e-cc-"));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "spor-e2e-home-"));
  const seq = _runSeq++;
  const outPath = path.join(os.tmpdir(), `spor-e2e-out-${process.pid}-${seq}.json`);
  const errPath = path.join(os.tmpdir(), `spor-e2e-err-${process.pid}-${seq}.log`);
  const env = {
    PATH: process.env.PATH,
    CLAUDE_CONFIG_DIR: configDir,
    HOME: fakeHome,
    // Git identity for the distiller's auto-commit of the scratch graph (a clean HOME has
    // no ~/.gitconfig, so without this the commit would fail — harmlessly, but noisily).
    GIT_AUTHOR_NAME: "e2e",
    GIT_AUTHOR_EMAIL: "e2e@test",
    GIT_COMMITTER_NAME: "e2e",
    GIT_COMMITTER_EMAIL: "e2e@test",
    // Anthropic endpoint hygiene: point at the fake, dummy key, pin the small/fast +
    // default-haiku models so an unstubbed distiller `claude -p --model haiku` would also
    // route to the fake. (Bedrock/Vertex/Foundry routing is absent from this curated env,
    // so claude takes the direct API path.)
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_API_KEY: "dummy-e2e-key",
    ANTHROPIC_SMALL_FAST_MODEL: "claude-haiku-4-5-20251001",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5-20251001",
    // Spor: scratch home, opt the markerless project in (the plugin is opt-in per repo),
    // stub the CMD seams.
    SPOR_HOME: home,
    SPOR_ENABLED: "1",
    SPOR_DISTILL_CMD: distillCmd,
    SPOR_NUDGE_CMD: nudgeCmd,
    ...(distilling ? { SPOR_DISTILLING: "1" } : {}),
    ...extraEnv,
  };
  const args = ["--plugin-dir", PLUGIN_ROOT, "--model", model, "-p", prompt, "--output-format", "json"];
  if (skipPermissions) args.push("--dangerously-skip-permissions");

  return new Promise((resolve) => {
    const outFd = fs.openSync(outPath, "w");
    const errFd = fs.openSync(errPath, "w");
    let settled = false;
    const finish = async (code, timedOut) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        fs.closeSync(outFd);
      } catch {
        /* */
      }
      try {
        fs.closeSync(errFd);
      } catch {
        /* */
      }
      let stdout = "";
      let stderr = "";
      try {
        stdout = fs.readFileSync(outPath, "utf8");
      } catch {
        /* */
      }
      try {
        stderr = fs.readFileSync(errPath, "utf8");
      } catch {
        /* */
      }
      let result = null;
      try {
        result = JSON.parse(stdout).result;
      } catch {
        /* non-JSON / crash */
      }
      // NOT KILLED here: the SessionEnd hook is declared `"async": true` in
      // hooks.json, so Claude Code does not wait for it before letting this
      // `claude` process exit — the `spor-hook distill` invocation it fires
      // inherits this same CLAUDE_CONFIG_DIR/HOME and can still be genuinely
      // at work the instant we get here. But we DO need to wait before
      // deleting configDir/fakeHome below: the transcript claude wrote this
      // session's turns to lives under CLAUDE_CONFIG_DIR
      // (`<configDir>/projects/.../<session>.jsonl`), and distill() reads it
      // by path with no retry — an unconditional early `return null` (silent,
      // no journal/distill.log line at all) the instant the file is missing.
      // Under heavy CPU contention (issue-spor-e2e-claude-distill-test-fails-
      // on-devbox) the detached hook process can take a beat just to get
      // scheduled/spawned; deleting configDir synchronously on `exit` (as
      // this used to) routinely won that race and silently discarded the
      // async distill before it ever read the transcript. Wait for any
      // process still tagged with this run's configDir/fakeHome to finish on
      // its own before reclaiming those paths — best-effort and bounded, so
      // a hook that never touches them (the NOTHING_CMD default) costs
      // nothing once it's gone, and a genuinely hung one doesn't wedge
      // teardown forever.
      await waitForMarkedQuiescence([configDir, fakeHome]);
      for (const p of [configDir, fakeHome, outPath, errPath]) {
        try {
          fs.rmSync(p, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
      resolve({ rc: timedOut ? null : code, result, stdout, stderr, timedOut: Boolean(timedOut) });
    };
    // stdin "ignore" == /dev/null: immediate EOF, no ~3s headless stdin wait.
    const child = spawn(claudePath(), args, { cwd, env, stdio: ["ignore", outFd, errFd] });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* */
      }
      finish(null, true);
    }, timeoutMs);
    child.on("exit", (code) => finish(code, false));
    child.on("error", () => finish(null, false));
  });
}

// Poll `fn` until it returns truthy or the deadline passes. Used for the async SessionEnd
// distill, which writes its node after claude has already exited.
async function waitFor(fn, { timeoutMs = 15000, stepMs = 200 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() >= end) return v;
    await sleep(stepMs);
  }
}

// Read a scratch home's per-session journal entries (the .jsonl files, excluding the
// engine-latency stream) as parsed objects.
function journalEntries(home) {
  const dir = path.join(home, "journal");
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl") && f !== "load-latency.jsonl" && f !== "llm-calls");
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    let raw = "";
    try {
      raw = fs.readFileSync(path.join(dir, f), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.trim().split("\n").filter(Boolean)) {
      try {
        out.push(JSON.parse(line));
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

// Recorded Haiku/CMD LLM calls in a scratch home (nudge + distill sweeps).
function llmCalls(home) {
  const dir = path.join(home, "journal", "llm-calls");
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return files.flatMap((f) =>
    fs
      .readFileSync(path.join(dir, f), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  );
}

module.exports = {
  PLUGIN_ROOT,
  NOTHING_CMD,
  claudePath,
  claudeAvailable,
  claudeSkipReason,
  claudeVersion,
  makeScratchGraph,
  runClaude,
  waitFor,
  journalEntries,
  llmCalls,
};

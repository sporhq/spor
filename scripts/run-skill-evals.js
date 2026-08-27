#!/usr/bin/env node
"use strict";
// Runs each shipped skill's evals/evals.json prompts against the REAL `claude` binary and
// a real model call, checking whether the Skill tool fires exactly when it should
// (task-spor-skill-evals-in-ci). This is a *trigger* eval — does the skill's description
// cause it to load on the right prompts and stay silent on the wrong ones — not a full
// LLM-judged content grade of `expected_output` (that's skill-creator's own
// executor+grader Test/Benchmark workflow, run by hand). It automates the specific gap the
// task named: "trigger-accuracy regressions are invisible until someone runs `claude
// plugin eval` by hand" — using this repo's own evals.json instead of `claude plugin
// eval`'s case.yaml format, which is early-access, needs an undocumented enablement
// setting, and isn't the format these skills ship in.
//
// Cost: one real model call per eval case (11 today). Deliberately NOT part of `npm test`
// — wired to .github/workflows/skill-evals.yaml on a schedule/workflow_dispatch instead.
// Self-skips (exit 0) when there's no claude binary or no ANTHROPIC_API_KEY, so a fork or a
// repo without the secret configured doesn't see a failing job — see CONTRIBUTING.md.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const { listSkillEvalManifests, loadManifest, skillId } = require("./skill-evals.js");
const { PLUGIN_ROOT, NOTHING_CMD, claudePath, claudeSkipReason, makeScratchGraph } = require("../test/helpers/claude-e2e.js");

const { expectedTrigger } = require("./skill-evals.js");

// Parse one case's full `claude -p --output-format stream-json --verbose` stdout (one JSON
// object per line) and decide whether the target skill fired. Mirrors the proven approach
// in skill-creator's own run_eval.py: scan assistant turns in order for the first tool_use;
// a match on Skill + this skillId is a trigger, any other tool_use (including a
// non-matching Skill call) is not, and reaching a `result` event with no tool_use at all is
// not. Returns true/false, or null if the transcript never reached a decidable point
// (crash, timeout, malformed output) — callers must treat null as inconclusive, not a pass.
function detectTrigger(stdout, targetSkillId) {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let evt;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (evt.type === "assistant") {
      const content = (evt.message && evt.message.content) || [];
      for (const item of content) {
        if (item.type !== "tool_use") continue;
        if (item.name === "Skill") {
          return (item.input || {}).skill === targetSkillId;
        }
        return false;
      }
    } else if (evt.type === "result") {
      return false;
    }
  }
  return null;
}

// Run one prompt through the real claude binary with this plugin loaded, hermetically
// (fresh CLAUDE_CONFIG_DIR + HOME, same isolation as test/helpers/claude-e2e.js — a
// configured dev box's settings.json must not leak SPOR_SERVER/installed plugins in here).
// Async spawn resolving on `exit`, stdout routed to a temp file: claude 2.x's lingering
// background daemon makes spawnSync/pipes hang past the process's own ~1s exit.
function runCase({ cwd, prompt, model = "claude-sonnet-4-5", timeoutMs = 120000, extraEnv = {} }) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-skill-eval-cc-"));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "spor-skill-eval-home-"));
  const outPath = path.join(os.tmpdir(), `spor-skill-eval-out-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  const env = {
    PATH: process.env.PATH,
    CLAUDE_CONFIG_DIR: configDir,
    HOME: fakeHome,
    GIT_AUTHOR_NAME: "skill-eval",
    GIT_AUTHOR_EMAIL: "skill-eval@test",
    GIT_COMMITTER_NAME: "skill-eval",
    GIT_COMMITTER_EMAIL: "skill-eval@test",
    SPOR_ENABLED: "1",
    SPOR_DISTILL_CMD: NOTHING_CMD,
    SPOR_NUDGE_CMD: NOTHING_CMD,
    SPOR_DISTILLING: "1", // no session distill/nudge/digest noise — only the trigger decision matters
    // Pass the real Anthropic endpoint through by default (extraEnv overrides this for
    // tests, pointing it at the fake instead).
    ...(process.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {}),
    ...(process.env.ANTHROPIC_BASE_URL ? { ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL } : {}),
    ...extraEnv,
  };
  const args = [
    "--plugin-dir", PLUGIN_ROOT,
    "--model", model,
    "-p", prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
  ];

  return new Promise((resolve) => {
    const outFd = fs.openSync(outPath, "w");
    let settled = false;
    const finish = (code, timedOut) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        fs.closeSync(outFd);
      } catch {
        /* */
      }
      let stdout = "";
      try {
        stdout = fs.readFileSync(outPath, "utf8");
      } catch {
        /* */
      }
      for (const p of [configDir, fakeHome, outPath]) {
        try {
          fs.rmSync(p, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
      resolve({ rc: timedOut ? null : code, stdout, timedOut: Boolean(timedOut) });
    };
    const child = spawn(claudePath(), args, { cwd, env, stdio: ["ignore", outFd, "ignore"] });
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

async function main() {
  const skipReason = claudeSkipReason();
  if (skipReason) {
    console.log(`skill-evals: skipping (${skipReason})`);
    return 0;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("skill-evals: skipping (no ANTHROPIC_API_KEY — see CONTRIBUTING.md)");
    return 0;
  }

  const manifests = listSkillEvalManifests();
  if (manifests.length === 0) {
    console.log("skill-evals: no skills/*/evals/evals.json found — nothing to run");
    return 0;
  }

  const scratch = makeScratchGraph({ slug: "skill-evals-scratch" });
  let failures = 0;
  let total = 0;
  try {
    for (const { skillDir, manifestPath } of manifests) {
      const manifest = loadManifest(manifestPath);
      const targetSkillId = skillId(skillDir);
      for (const evalCase of manifest.evals) {
        total++;
        const expected = expectedTrigger(evalCase);
        const { stdout, rc, timedOut } = await runCase({ cwd: scratch.cwd, prompt: evalCase.prompt, extraEnv: { SPOR_HOME: scratch.home } });
        const triggered = detectTrigger(stdout, targetSkillId);
        const ok = triggered === expected;
        const label = `${skillDir}#${evalCase.id}`;
        if (timedOut) {
          console.log(`FAIL ${label}: timed out`);
          failures++;
        } else if (triggered === null) {
          console.log(`FAIL ${label}: inconclusive transcript (rc=${rc})`);
          failures++;
        } else if (!ok) {
          console.log(`FAIL ${label}: expected trigger=${expected}, got ${triggered} — "${evalCase.prompt.slice(0, 70)}..."`);
          failures++;
        } else {
          console.log(`PASS ${label}: trigger=${triggered} as expected`);
        }
      }
    }
  } finally {
    scratch.cleanup();
  }

  console.log(`skill-evals: ${total - failures}/${total} passed`);
  return failures === 0 ? 0 : 1;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    }
  );
}

module.exports = { detectTrigger, runCase };

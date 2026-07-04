"use strict";
// One-time-per-repo discovery hint for the opt-in default
// (issue-spor-opt-in-silent-disable-no-indication). The dispatcher bails
// before any engine when a repo hasn't opted in (task-spor-plugin-opt-in-
// default) — correct for an unrelated side project, but the 2026-06-22
// rollout also went silently dark in repos Spor HAD been serving (spor-infra
// briefings stop crisply on 06-23; the user had zero indication for weeks).
//
// The boundary dec-spor-no-markerless-onboard-nudge draws — no onboarding
// nudges in repos Spor never knew — is preserved: this hint fires only on
// machine-local EVIDENCE of prior Spor activity for this repo's slug (a
// cached remote briefing under cache/, or the local graph carrying a
// brief-/repo- node for it), only when the disable is the silent DEFAULT
// (Config.disabledByDefault(); an explicit enabled:false / SPOR_ENABLED=0 /
// mode:off opt-out stays silent), and only ONCE per repo, stamped in
// journal/enable-hint-<slug>. Session-start only; fail-open like every hook.

const fs = require("fs");
const path = require("path");
const u = require("./util");

function enableHint(payload) {
  const cwd = payload.cwd;
  if (!cwd) return null;
  const cfg = u.config();
  if (!cfg || !cfg.disabledByDefault()) return null;
  const slug = u.projectSlug(cwd);
  if (!slug) return null;

  const graph = u.graphHome();
  const evidence = [
    path.join(graph, "cache", `brief-${slug}.md`),
    path.join(graph, "nodes", `brief-${slug}.md`),
    path.join(graph, "nodes", `repo-${slug}.md`),
  ].some((p) => fs.existsSync(p));
  if (!evidence) return null;

  const stamp = path.join(graph, "journal", `enable-hint-${slug}`);
  if (fs.existsSync(stamp)) return null;
  if (!u.ensureDir(path.join(graph, "journal"))) return null;
  try {
    fs.writeFileSync(stamp, `${u.jqNow()}\n`);
  } catch {
    return null; // no stamp => the hint could repeat every session; stay silent instead
  }

  const ctx =
    `Spor notice (shown once for this repo): Spor is installed and this machine has ` +
    `prior Spor history for '${slug}', but the repo is not enabled — since the per-repo ` +
    `opt-in default, every Spor hook no-ops here (no context briefing, no capture, no ` +
    `distillation). To re-enable, run \`spor enable\` in the repo root (or /spor:onboard); ` +
    `an explicit enabled:false or SPOR_ENABLED=0 opts out and silences this permanently. ` +
    `Surface this notice to the user in one sentence.`;
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ctx } };
}

module.exports = { enableHint };

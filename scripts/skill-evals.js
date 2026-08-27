"use strict";
// Shared helpers over the shipped skills' evals/evals.json manifests
// (task-spor-skill-evals-in-ci). Two consumers:
//   - test/skill-evals-manifest.test.js: cheap, per-PR structural validation (no model
//     calls) — the manifest half of the acceptance bar.
//   - scripts/run-skill-evals.js: the real trigger-accuracy run (real model calls,
//     scheduled/on-demand only).
//
// evals.json is skill-creator's own format (see its references/schemas.md), authored by
// `/skill-creator` for its own executor+grader Test/Benchmark workflow — NOT the
// `claude plugin eval` CLI's case.yaml/prompt.md format, which expects a different file
// layout entirely and is early-access + real-API-cost + requires converting every case.
// This module works with the format the skills actually ship (prompt/expected_output).

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SKILLS_DIR = path.join(ROOT, "skills");

// The plugin id skills are invoked under (the Skill tool's `input.skill` is
// `<plugin-name>:<skill-name>`, e.g. "spor:factory") — read from the manifest rather than
// hardcoded so a future rename doesn't silently desync this.
function pluginName() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  return manifest.name;
}

function skillId(skillDir) {
  return `${pluginName()}:${skillDir}`;
}

// Every skill directory carrying an evals/evals.json, in directory order.
function listSkillEvalManifests() {
  let entries;
  try {
    entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(SKILLS_DIR, entry.name, "evals", "evals.json");
    if (fs.existsSync(manifestPath)) out.push({ skillDir: entry.name, manifestPath });
  }
  return out.sort((a, b) => a.skillDir.localeCompare(b.skillDir));
}

// The `name:` frontmatter value from a skill's SKILL.md, or null if missing/unparsable.
function skillFrontmatterName(skillDir) {
  const skillMdPath = path.join(SKILLS_DIR, skillDir, "SKILL.md");
  let raw;
  try {
    raw = fs.readFileSync(skillMdPath, "utf8");
  } catch {
    return null;
  }
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const nameLine = match[1].split("\n").find((l) => /^name:\s*/.test(l));
  return nameLine ? nameLine.replace(/^name:\s*/, "").trim() : null;
}

// Validate one manifest's shape against skill-creator's documented schema plus the
// cross-checks that actually catch drift (skill_name/dir/SKILL.md mismatch, dangling
// file refs, duplicate ids). Returns an array of error strings — empty means valid.
function validateManifest(skillDir, data) {
  const errors = [];
  if (!data || typeof data !== "object") {
    return ["manifest is not a JSON object"];
  }
  if (typeof data.skill_name !== "string" || !data.skill_name) {
    errors.push("skill_name must be a non-empty string");
  } else {
    if (data.skill_name !== skillDir) {
      errors.push(`skill_name "${data.skill_name}" does not match its directory "${skillDir}"`);
    }
    const frontmatterName = skillFrontmatterName(skillDir);
    if (frontmatterName !== null && frontmatterName !== data.skill_name) {
      errors.push(`skill_name "${data.skill_name}" does not match SKILL.md's frontmatter name "${frontmatterName}"`);
    }
  }
  if (!Array.isArray(data.evals) || data.evals.length === 0) {
    errors.push("evals must be a non-empty array");
    return errors;
  }
  const seenIds = new Set();
  data.evals.forEach((evalCase, index) => {
    const where = `evals[${index}]`;
    if (!evalCase || typeof evalCase !== "object") {
      errors.push(`${where} is not an object`);
      return;
    }
    if (!Number.isInteger(evalCase.id)) {
      errors.push(`${where}.id must be an integer`);
    } else if (seenIds.has(evalCase.id)) {
      errors.push(`${where}.id ${evalCase.id} is a duplicate`);
    } else {
      seenIds.add(evalCase.id);
    }
    if (typeof evalCase.prompt !== "string" || !evalCase.prompt.trim()) {
      errors.push(`${where}.prompt must be a non-empty string`);
    }
    if (typeof evalCase.expected_output !== "string" || !evalCase.expected_output.trim()) {
      errors.push(`${where}.expected_output must be a non-empty string`);
    }
    if (evalCase.files !== undefined) {
      if (!Array.isArray(evalCase.files)) {
        errors.push(`${where}.files must be an array when present`);
      } else {
        for (const f of evalCase.files) {
          if (typeof f !== "string" || !fs.existsSync(path.join(SKILLS_DIR, skillDir, f))) {
            errors.push(`${where}.files references missing file "${f}"`);
          }
        }
      }
    }
  });
  return errors;
}

function loadManifest(manifestPath) {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

// Whether an eval case expects the skill to trigger at all — inferred from the
// house convention (see skills/*/evals/evals.json) that a negative case's expected_output
// starts with "Should NOT trigger". There's no separate structured field for this in
// skill-creator's evals.json schema, so the prose prefix IS the signal.
function expectedTrigger(evalCase) {
  return !/^should not trigger/i.test(evalCase.expected_output.trim());
}

module.exports = {
  ROOT,
  SKILLS_DIR,
  pluginName,
  skillId,
  listSkillEvalManifests,
  skillFrontmatterName,
  validateManifest,
  loadManifest,
  expectedTrigger,
};

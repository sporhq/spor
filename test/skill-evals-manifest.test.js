// Validates every shipped skill's evals/evals.json against skill-creator's documented
// schema (task-spor-skill-evals-in-ci): skills/factory/evals/ and skills/onboard/evals/
// exist but nothing checked their shape — a malformed manifest, a skill_name that drifted
// from its SKILL.md, a duplicate eval id, or a dangling `files` reference all silently rot
// until someone runs the suite by hand. This is the cheap, per-PR half of the acceptance
// bar; the real trigger-accuracy run (real model calls) is scripts/run-skill-evals.js,
// wired to a scheduled workflow instead (too costly for every push).
const test = require('node:test');
const assert = require('node:assert');
const { listSkillEvalManifests, loadManifest, validateManifest } = require('../scripts/skill-evals.js');

test('every skill with an evals/ dir ships a valid evals.json', () => {
  const manifests = listSkillEvalManifests();
  // Guard against the check quietly finding nothing to check (a moved evals/ dir, a
  // renamed skills/ root) — this must always cover at least the skills known to ship evals.
  const skillDirs = manifests.map((m) => m.skillDir);
  assert.ok(skillDirs.includes('factory'), `expected skills/factory/evals/evals.json to be found, saw: ${skillDirs}`);
  assert.ok(skillDirs.includes('onboard'), `expected skills/onboard/evals/evals.json to be found, saw: ${skillDirs}`);

  for (const { skillDir, manifestPath } of manifests) {
    let data;
    assert.doesNotThrow(() => {
      data = loadManifest(manifestPath);
    }, `${manifestPath} must be valid JSON`);
    const errors = validateManifest(skillDir, data);
    assert.deepStrictEqual(errors, [], `${manifestPath} has schema errors:\n${errors.join('\n')}`);
  }
});

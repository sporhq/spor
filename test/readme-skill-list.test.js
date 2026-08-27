// Guards README.md's day-to-day command list against skills/ drift
// (task-spor-readme-skill-list-complete): README.md is the only place a
// reader learns which /spor:<skill> commands exist, and nothing previously
// checked it against the skills/ directory — /spor:triage shipped without
// ever being added to the list. Cheap and deterministic — no shell, no graph.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const SKILLS_ROOT = path.join(REPO_ROOT, 'skills');
const README = path.join(REPO_ROOT, 'README.md');

function shippedSkillNames() {
  return fs.readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => fs.existsSync(path.join(SKILLS_ROOT, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
}

function readmeCommandListNames() {
  const text = fs.readFileSync(README, 'utf8');
  const section = text.match(/## Using Spor day to day\n([\s\S]*?)\n## /);
  assert.ok(section, 'expected a "## Using Spor day to day" section in README.md');
  const fenced = section[1].match(/```text\n(\/spor:[\s\S]*?)```/);
  assert.ok(fenced, 'expected a ```text fenced /spor: command list under "## Using Spor day to day"');
  const names = [...fenced[1].matchAll(/^\/spor:([a-z][a-z0-9-]*)/gm)].map((m) => m[1]);
  return [...new Set(names)].sort();
}

test('every skills/ directory with a SKILL.md is listed in README.md', () => {
  const shipped = shippedSkillNames();
  const listed = readmeCommandListNames();

  const missing = shipped.filter((name) => !listed.includes(name));
  assert.deepStrictEqual(missing, [],
    `skills/ directories missing from README.md's command list:\n${missing.join('\n')}`);
});

test("README.md's command list names only shipped skills", () => {
  const shipped = shippedSkillNames();
  const listed = readmeCommandListNames();

  const stale = listed.filter((name) => !shipped.includes(name));
  assert.deepStrictEqual(stale, [],
    `README.md's command list names skills that no longer exist under skills/:\n${stale.join('\n')}`);
});

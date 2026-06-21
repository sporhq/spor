// Guard the skills' prose against the shipped `spor` CLI verb surface
// (task-spor-skills-prose-cli-verb-audit). When a verb ships or is renamed but
// the skills that should use it aren't swept in lockstep, agents get steered to
// a stale write path — exactly what happened when `spor priority` shipped in
// 0.13.0 while /spor:triage and /spor:spor still told agents "no CLI verb, use
// put_node/REST" (fixed in 55ae871). These checks make that drift loud at CI.
//
// Source of truth is the LIVE CLI table — resolveVerb() from bin/spor.js, the
// same resolver the dispatcher uses — never a hardcoded list (CLAUDE.md: the
// registry/table is the contract; don't re-hardcode it). Requiring bin/spor.js
// runs no main() (guarded by require.main); hookcli.test.js relies on the same.

require('./helpers/tmp-cleanup'); // scratch-home leak guard, matching the suite
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { resolveVerb } = require('../bin/spor.js');

const SKILLS_DIR = path.join(__dirname, '..', 'skills');

function skillMarkdownFiles(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...skillMarkdownFiles(p));
    else if (ent.name.endsWith('.md')) out.push(p);
  }
  return out.sort();
}

const FILES = skillMarkdownFiles(SKILLS_DIR);

// `spor <verb>` mentions, capturing only the FIRST token after `spor ` (so
// `spor agent create` -> `agent`, a real verb; the subcommand is the CLI's own
// concern, not this guard's). Excluded by the negative lookbehind:
//  - `/spor <name>` — the slash-command family (/spor:triage), not the CLI
//  - `spor-hook` / `spor_pat_` / `aspor` — word/hyphen compounds
// Placeholders like `spor <verb>` / `spor <id>` never match (`<` isn't [a-z]),
// and `spor CLI`/`spor MCP`/`Spor` are skipped (uppercase next word).
const MENTION_RE = /(?<![/\w-])spor (?<verb>[a-z][a-z-]*)/g;

test('every `spor <verb>` named in a skill resolves to a real CLI verb', () => {
  const offenders = [];
  for (const file of FILES) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(MENTION_RE)) {
        if (resolveVerb(m.groups.verb) === null) {
          offenders.push(`${path.relative(SKILLS_DIR, file)}:${i + 1}  \`spor ${m.groups.verb}\``);
        }
      }
    });
  }
  assert.deepStrictEqual(
    offenders, [],
    'A skill names a `spor` verb the CLI does not have (renamed? typo? never shipped?). ' +
    'Fix the skill prose, or add the verb to bin/spor.js COMMANDS if it shipped.\n  ' +
    offenders.join('\n  ')
  );
});

// Regression guard for the exact drift that motivated this test: a skill must
// not claim an operation "has no CLI verb" / "no `spor` CLI form" when one now
// exists. Scoped to the micro-mutation operations that DO have a verb. NOTE:
// set-status / add-edge are deliberately NOT here — they have no CLI verb yet
// (task-spor-set-status-edge-cli-verbs), so disclaiming THOSE stays correct.
// Extend VERB_BACKED_OPS when a new micro-mutation verb ships.
const DISCLAIMER_RE = /no (?:dedicated )?(?:`spor` )?cli (?:verb|form)|has no\b[^.]{0,40}\bcli verb/i;
const VERB_BACKED_OPS = ['priority'];

test('no skill disclaims a CLI verb that exists', () => {
  // every op we guard must actually resolve, or the guard itself is stale
  for (const op of VERB_BACKED_OPS) {
    assert.notStrictEqual(resolveVerb(op), null, `VERB_BACKED_OPS lists \`${op}\` but it is not a CLI verb`);
  }
  const offenders = [];
  for (const file of FILES) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!DISCLAIMER_RE.test(line)) return;
      for (const op of VERB_BACKED_OPS) {
        if (line.toLowerCase().includes(op)) {
          offenders.push(`${path.relative(SKILLS_DIR, file)}:${i + 1}  disclaims \`spor ${op}\`: ${line.trim()}`);
        }
      }
    });
  }
  assert.deepStrictEqual(
    offenders, [],
    'A skill claims an operation has no CLI verb, but `spor ' + VERB_BACKED_OPS.join('`/`spor ') + '` exists:\n  ' +
    offenders.join('\n  ')
  );
});

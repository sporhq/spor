// Lints shipped skills' documented `spor <verb>` invocations against the
// live COMMANDS table (task-spor-skills-verb-lint): a renamed verb or flag
// would otherwise silently rot every skill's instructions with nothing to
// catch it. Cheap and deterministic — no shell, no graph.
require("./helpers/tmp-cleanup"); // scratch-home leak guard (issue-spor-test-mkdtemp-inode-exhaustion)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { COMMANDS } = require('../bin/spor.js');

const SKILLS_ROOT = path.join(__dirname, '..', 'skills');

// Prose mentions of "spor <word>" that read like a CLI invocation to a naive
// grep but aren't — the seam for the next false positive a new skill trips.
const PROSE_ALLOWLIST = new Set([
  'identity', // onboard/SKILL.md: "create my spor identity" (not `spor identity`)
]);

function knownVerbs() {
  const verbs = new Set(Object.keys(COMMANDS));
  for (const entry of Object.values(COMMANDS)) {
    for (const alias of entry.aliases || []) verbs.add(alias);
  }
  return verbs;
}

function findSkillFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findSkillFiles(full));
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

// Extracts every "spor <verb>" mention that reads as a CLI invocation:
// word-boundary before "spor" that isn't part of a `/spor:<skill>` or
// `x:spor` reference, a lowercase verb-shaped token after it, and not a
// contraction ("spor isn't doing anything"). Two forms of whitespace between
// "spor" and the verb: inside a backtick code span, `\s+` — this repo's
// skills prose hand-wraps at ~80 columns, so an invocation like
// `` `spor\nset-status <id>` `` routinely splits across the line break and
// must still be caught; outside code, a literal space only, else a wrapped
// prose/frontmatter line ("name: spor\ndescription: ...") would false-flag
// the next line's first word as an unknown verb.
function extractVerbMentions(text) {
  const found = [];
  const re = /(?:`spor\s+|(?:^|[^\w/:`])spor +)([a-z][a-z0-9-]*)/g;
  let m;
  while ((m = re.exec(text))) {
    const verb = m[1];
    const after = text[m.index + m[0].length];
    if (after === "'") continue; // contraction, e.g. "spor isn't"
    found.push(verb);
  }
  return found;
}

test('every `spor <verb>` mentioned in shipped skills exists in the COMMANDS table', () => {
  const verbs = knownVerbs();
  const files = findSkillFiles(SKILLS_ROOT);
  assert.ok(files.length > 0, 'expected to find skill markdown files under skills/');

  const unknown = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const verb of extractVerbMentions(text)) {
      if (verbs.has(verb) || PROSE_ALLOWLIST.has(verb)) continue;
      unknown.push(`${path.relative(SKILLS_ROOT, file)}: spor ${verb}`);
    }
  }
  assert.deepStrictEqual(unknown, [],
    `unknown spor verb(s) referenced in skills (renamed/removed CLI verb, or a ` +
    `new prose false positive that needs a PROSE_ALLOWLIST entry):\n${unknown.join('\n')}`);
});

test('extractVerbMentions ignores skill cross-references and contractions', () => {
  const text = "See /spor:spor and note spor isn't configured; the plugin: spor@spor X loaded.";
  assert.deepStrictEqual(extractVerbMentions(text), []);
});

test('extractVerbMentions catches a real CLI invocation, inline and fenced', () => {
  const text = "Run `spor status --quiet` to check, or:\n```bash\nspor next --project foo\n```\n";
  assert.deepStrictEqual(extractVerbMentions(text), ['status', 'next']);
});

test('extractVerbMentions catches a verb hand-wrapped across a markdown line break inside a code span', () => {
  const text = "if one becomes stale, `spor\nset-status <corr-id> applied` retires it.";
  assert.deepStrictEqual(extractVerbMentions(text), ['set-status']);
});

test('extractVerbMentions ignores a frontmatter value wrapping onto the next key', () => {
  const text = "---\nname: spor\ndescription: the operating manual\n---\n";
  assert.deepStrictEqual(extractVerbMentions(text), []);
});

test('the lint fails closed on a fabricated unknown verb (regression guard for the lint itself)', () => {
  const verbs = knownVerbs();
  const [bogus] = extractVerbMentions('Run `spor frobnicate --now` first.');
  assert.strictEqual(bogus, 'frobnicate');
  assert.ok(!verbs.has(bogus) && !PROSE_ALLOWLIST.has(bogus),
    'the bogus verb must not already be a real command or allowlisted');
});

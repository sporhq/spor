// Guard the skills' AND the repo docs' prose against the shipped `spor` CLI verb
// surface (task-spor-skills-prose-cli-verb-audit, widened to the docs by
// task-spor-cli-verb-guard-widen-to-docs). When a verb ships or is renamed but
// the prose that should use it isn't swept in lockstep, a reader is steered to a
// stale write path — exactly what happened when `spor priority` shipped in 0.13.0
// while /spor:triage and /spor:spor still told agents "no CLI verb, use
// put_node/REST" (fixed in 55ae871). These checks make that drift loud at CI,
// across skills/**/*.md AND the prose docs that also name CLI verbs (CLAUDE.md,
// README.md, API.md, GRAPH.md, QUEUE.md): a renamed/removed verb leaves a stale
// invocation in a doc and otherwise nothing catches it.
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

const REPO_ROOT = path.join(__dirname, '..');
const SKILLS_DIR = path.join(REPO_ROOT, 'skills');
// The prose docs that also name `spor <verb>` invocations (the task's list).
const DOC_FILES = ['CLAUDE.md', 'README.md', 'API.md', 'GRAPH.md', 'QUEUE.md']
  .map((f) => path.join(REPO_ROOT, f));

function skillMarkdownFiles(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...skillMarkdownFiles(p));
    else if (ent.name.endsWith('.md')) out.push(p);
  }
  return out.sort();
}

const SKILL_FILES = skillMarkdownFiles(SKILLS_DIR);
const FILES = [...SKILL_FILES, ...DOC_FILES];
const rel = (f) => path.relative(REPO_ROOT, f);

// `spor <verb>` mentions, capturing only the FIRST token after `spor ` (so
// `spor agent create` -> `agent`, a real verb; the subcommand is the CLI's own
// concern, not this guard's). Excluded by the negative lookbehind:
//  - `/spor <name>` — the slash-command family (/spor:triage), not the CLI
//  - `spor-hook` / `spor_pat_` / `aspor` — word/hyphen compounds
//  - `.spor` / `.spor.json` — the marker filenames, not the command (the `.`)
// Placeholders like `spor <verb>` / `spor <id>` never match (`<` isn't [a-z]),
// and `spor CLI`/`spor MCP`/`Spor` are skipped (uppercase next word).
const MENTION_RE = /(?<![/\w.-])spor (?<verb>[a-z][a-z-]*)/g;

const SHELL_FENCE_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'console', 'shell-session', 'shellsession']);

// Collect every `spor <verb>` written AS CODE in a markdown file — inside an
// inline `code span` or a shell-language ``` fence — paired with its source line.
//
// Why "as code"? In the skills, every command is already backticked, so this is
// a no-op: the same mentions are found whether you scan the raw lines or only
// the code. But the prose docs use the bare word "spor" as a product noun all
// over — `the spor plugin`, `substrate→spor rename`, a `.spor` marker, a node
// example's `summary:` line — and scanning their raw text the way skills are
// scanned would flag those noun-uses as nonexistent verbs (`spor plugin`,
// `spor rename`, `spor skills`). A real CLI invocation, by contrast, is always
// code-formatted. Restricting to code context is what lets the SAME existence
// check run over prose without false positives; the lookbehind exclusions above
// are kept verbatim on top of it.
function verbMentions(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const mentions = [];
  const scan = (text, firstLine) => {
    for (const m of text.matchAll(MENTION_RE)) {
      const line = firstLine + (text.slice(0, m.index).match(/\n/g) || []).length;
      mentions.push({ verb: m.groups.verb, line });
    }
  };
  let inFence = false, lang = '', body = [], bodyFirst = 0;
  let prose = [], proseFirst = 0, proseOpen = false;
  const flushProse = () => {
    if (!proseOpen) return;
    // An inline code span may wrap across lines (CommonMark), so scan the joined
    // blob, not line-by-line, to pair backticks in document order; record only
    // each span's interior, with its line of origin.
    const blob = prose.join('\n');
    for (const s of blob.matchAll(/`+([^`]*)`+/g)) {
      const spanLine = proseFirst + (blob.slice(0, s.index).match(/\n/g) || []).length;
      scan(s[1], spanLine);
    }
    prose = [];
    proseOpen = false;
  };
  lines.forEach((raw, i) => {
    const fence = raw.match(/^\s*```(\S*)/);
    if (fence) {
      if (!inFence) { flushProse(); inFence = true; lang = fence[1].toLowerCase(); body = []; bodyFirst = i + 2; }
      else { if (SHELL_FENCE_LANGS.has(lang)) scan(body.join('\n'), bodyFirst); inFence = false; lang = ''; }
      return;
    }
    if (inFence) body.push(raw);
    else { if (!proseOpen) { proseOpen = true; proseFirst = i + 1; } prose.push(raw); }
  });
  flushProse();
  return mentions;
}

test('every `spor <verb>` named in a skill or repo doc resolves to a real CLI verb', () => {
  const offenders = [];
  for (const file of FILES) {
    for (const { verb, line } of verbMentions(file)) {
      if (resolveVerb(verb) === null) {
        offenders.push(`${rel(file)}:${line}  \`spor ${verb}\``);
      }
    }
  }
  assert.deepStrictEqual(
    offenders, [],
    'A skill or doc names a `spor` verb the CLI does not have (renamed? typo? never shipped?). ' +
    'Fix the prose, or add the verb to bin/spor.js COMMANDS if it shipped.\n  ' +
    offenders.join('\n  ')
  );
});

// Guard the guard: the code-context scanner is non-trivial, so a regression that
// quietly returns nothing would make the existence check above pass vacuously.
// Assert it still finds a healthy crop of invocations on BOTH sides (skills and
// docs), so an extractor break reddens here instead of hiding.
test('the verb scanner finds invocations in both skills and docs', () => {
  const count = (files) => files.reduce((n, f) => n + verbMentions(f).length, 0);
  assert.ok(count(SKILL_FILES) >= 50, 'scanner found almost no `spor <verb>` in skills/ — extractor regressed?');
  assert.ok(count(DOC_FILES) >= 20, 'scanner found almost no `spor <verb>` in the repo docs — extractor regressed?');
});

// Regression guard for the exact drift that motivated this test: prose must not
// claim an operation "has no CLI verb" / "no `spor` CLI form" when one now
// exists. Scoped to the micro-mutation operations that DO have a verb. `edge`
// covers add_edge (the `spor edge` verb shipped in task-spor-set-status-edge-cli-
// verbs); remove_edge (DELETE /v1/nodes/{id}/edges) still has no verb, so a
// withdrawal disclaimer should be phrased without the bare word "edge". Extend
// VERB_BACKED_OPS when a new micro-mutation verb ships. This check is line-based
// (a disclaimer is prose, not a code span) and runs over docs too — verified
// false-positive-free (no skill or doc carries such a disclaimer line today).
const DISCLAIMER_RE = /no (?:dedicated )?(?:`spor` )?cli (?:verb|form)|has no\b[^.]{0,40}\bcli verb/i;
const VERB_BACKED_OPS = ['priority', 'set-status', 'edge'];

test('no skill or doc disclaims a CLI verb that exists', () => {
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
          offenders.push(`${rel(file)}:${i + 1}  disclaims \`spor ${op}\`: ${line.trim()}`);
        }
      }
    });
  }
  assert.deepStrictEqual(
    offenders, [],
    'A skill or doc claims an operation has no CLI verb, but `spor ' + VERB_BACKED_OPS.join('`/`spor ') + '` exists:\n  ' +
    offenders.join('\n  ')
  );
});

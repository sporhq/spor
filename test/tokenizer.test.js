// tokenizer.test.js — the ONE client text fold / tokenizer / slugifier
// (lib/kernel/tokenizer.js, task-spor-unicode-slugify-and-tokenizer). The
// byte-level edge-case corpus is the conformance `tokenizer-unicode` golden;
// this file pins the properties that golden relies on, so a regression names
// the property it broke rather than just a drifted JSON line.
require("./helpers/tmp-cleanup"); // scratch-home leak guard
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { fold, words, tokens, slugify, STOP } = require(path.join(__dirname, "..", "lib", "kernel", "tokenizer.js"));

// The inline tokenizer lib/kernel/graph.js carried before this module, kept
// here verbatim as the byte-identity oracle for ASCII text.
const legacy = (t) => t.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "")
  .split(/[^a-z0-9]+/).filter((x) => x.length > 2 && !STOP.has(x));

test("ASCII text (and ASCII plus separator-only punctuation) tokenizes byte-identically to the legacy split", () => {
  for (const s of [
    "",
    "The quick brown fox — jumps → over the lazy dog",
    "don't foo_bar 3.14 e.g. constructor toString __proto__ hasOwnProperty",
    "“Quoted” release notes … with ellipses and • bullets",
    "UPPER lower MiXeD 42 1234 abc-def ghi/jkl",
    // an emoji variation selector (U+FE0F, a \p{M}) touching a word
    "\u26a0\ufe0fwarning here, \u2714\ufe0fdone deal, Note:\u26a0\ufe0fCaution",
  ]) assert.deepEqual(tokens(s), legacy(s), s);
});

test("Swedish diacritics fold instead of separating (issue-spor-rankagainst-tokenizer-shreds-diacritics)", () => {
  assert.deepEqual(tokens("Omvärldsanalys för väg och låda"), ["omvarldsanalys", "vag", "och", "lada"]);
  // typed with or without the accents, the terms are the same
  assert.deepEqual(tokens("omvärldsanalys vägverket"), tokens("omvarldsanalys vagverket"));
  // decomposed and precomposed spellings are one word
  assert.deepEqual(words("été"), words("été"));
});

test("letters with no decomposition transliterate (ø æ œ ß ł đ þ ı)", () => {
  assert.deepEqual(words("Møte Æble Œuvre Straße Łódź Đuro Þórr ılık"),
    ["mote", "aeble", "oeuvre", "strasse", "lodz", "duro", "thorr", "ilik"]);
  assert.equal(fold("Øst"), "Ost", "fold is case-preserving");
});

test("NFKD compatibility forms fold inside a word, but a symbol still separates", () => {
  assert.deepEqual(words("ﬁle Ａｂｃ log₂"), ["file", "abc", "log2"]);
  assert.deepEqual(words("Spor™ launch"), ["spor", "launch"], "™ must not glue 'tm' onto its neighbour");
  assert.deepEqual(words("½"), ["1", "2"], "a fold that yields a separator is re-split");
});

test("non-Latin scripts are words, not separators", () => {
  assert.deepEqual(tokens("Привет мир, это тест"), ["привет", "мир", "это", "тест"]);
  assert.deepEqual(tokens("हिन्दी भाषा"), ["हिन्दी", "भाषा"], "Devanagari vowel signs are spelling, not diacritics");
  assert.deepEqual(tokens("한국어 문장"), ["한국어", "문장"], "Hangul recomposes after the fold");
});

test("Intl.Segmenter splits unspaced scripts; 2-char ideographic words survive the length floor", () => {
  const t = tokens("東京で会議をしました");
  assert.ok(t.includes("東京") && t.includes("会議"), JSON.stringify(t));
  assert.deepEqual(tokens("ภาษาไทยง่ายมาก"), ["ภาษา", "ไทย", "ง่าย", "มาก"]);
  // an alphabetic 2-letter word is still a fragment
  assert.deepEqual(tokens("ab мы"), []);
});

test("a prototype-key token is an ordinary term", () => {
  assert.deepEqual(tokens("constructor tostring"), ["constructor", "tostring"]);
});

test("slugify: ASCII id stem, transliterated, symbol-separated", () => {
  assert.equal(slugify("Sväljer fel"), "svaljer-fel");
  assert.equal(slugify("  My_Repo.AppHost  "), "my-repo-apphost");
  assert.equal(slugify("Spor™ launch"), "spor-launch");
  assert.equal(slugify("東京会議"), "", "no Latin spelling -> empty, caller falls back");
  assert.match(slugify("Møte på Østergaard"), /^[a-z0-9][a-z0-9-]*$/);
});

test("slugify(max) truncates on a word boundary, never mid-word", () => {
  assert.equal(slugify("alpha beta gamma delta", 13), "alpha-beta");
  assert.equal(slugify("alpha beta gamma delta", 10), "alpha-beta", "a cut landing exactly on a hyphen keeps the whole word");
  assert.equal(slugify("alpha beta", 48), "alpha-beta", "under the limit is untouched");
  assert.equal(slugify("supercalifragilistic word", 8), "supercal", "a single over-long first word is hard-cut");
  for (const [s, max] of [["one two three four five", 7], ["a-b c", 2], ["x yy zzz", 4]]) {
    const out = slugify(s, max);
    assert.ok(out.length <= max, `${s}/${max} -> ${out}`);
    assert.doesNotMatch(out, /^-|-$/);
  }
});

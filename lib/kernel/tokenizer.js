"use strict";
// tokenizer.js — the ONE Unicode-aware text fold, retrieval tokenizer and id
// slugifier of the client core (task-spor-unicode-slugify-and-tokenizer).
//
// Three ASCII-only copies of this used to live inline — `[^a-z0-9]+` as the
// word separator — and every non-ASCII letter became a word boundary: on a
// Swedish tenant 15.5% of word occurrences shredded into junk fragments
// ("omvärldsanalys" -> "omv" + "rldsanalys", "väg" dropped outright;
// issue-spor-rankagainst-tokenizer-shreds-diacritics), and a local capture
// titled "Sväljer fel" minted `task-sv-ljer-fel`. Zero-dep by the client's
// hard rule, so it is built on two builtins rather than a slugify package:
//
//   fold()     NFKD (compatibility decomposition: accents split off, ﬁ -> fi,
//              full-width Ａ -> A, ² -> 2), strip the DIACRITIC marks only,
//              transliterate the handful of Latin letters that have no
//              decomposition at all (ø, æ, ß, ł, …), then NFC so any script
//              whose marks were kept (Hangul jamo, kana voicing) recomposes.
//   words()    Intl.Segmenter word boundaries, so a script written without
//              spaces (Chinese, Japanese, Thai) splits into words at all; each
//              word-like segment is then split on anything that is not a
//              letter, mark or number — which, for ASCII text, is EXACTLY the
//              old `split(/[^a-z0-9]+/)` (the segmenter's own `don't`,
//              `foo_bar`, `3.14` still come apart the way they always did).
//   tokens()   the tf-idf terms: words() minus stopwords and short fragments.
//   slugify()  the id-safe ASCII kebab stem: fold, collapse, trim, and
//              truncate on a WORD boundary instead of mid-word.
//
// Byte-identity (norm-cc-byte-identical-refactor): an ASCII input takes the
// exact pre-existing regex path, so every English graph tokenizes and ranks as
// before; only text that carried non-ASCII letters changes, and it changes in
// the direction the issues asked for. The conformance `tokenizer` case pins the
// edge-case corpus (conformance/cases/tokenizer-unicode.json).

const STOP = new Set(("the a an and or of to in for on with is are was were be been this that " +
  "it as at by from we our their they you your has have had not no do does but if than then so " +
  "its into out over under all any per each").split(" "));

// The combining-DIACRITIC blocks, not all of \p{M}: a Devanagari vowel sign or
// a Thai tone mark is part of the word's spelling in its script, not an accent
// on a Latin base, and stripping it would conflate distinct words. The
// variation selectors ride along: they are marks with no spelling of their
// own, and the emoji selector U+FE0F right after "⚠️" must not glue itself
// onto the next word ("⚠️warning" -> "warning", as the old \p{M} strip gave).
const DIACRITICS = /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe00-\ufe0f\ufe20-\ufe2f\u{e0100}-\u{e01ef}]/gu;

// Latin letters with NO canonical/compatibility decomposition, so NFKD leaves
// them whole. Both cases, since fold() is case-preserving by contract and
// slugify() folds before it lowercases.
const TRANSLIT = {
  "ø": "o", "Ø": "O", "æ": "ae", "Æ": "AE", "œ": "oe", "Œ": "OE", "ß": "ss", "ẞ": "SS",
  "đ": "d", "Đ": "D", "ð": "d", "Ð": "D", "þ": "th", "Þ": "TH", "ł": "l", "Ł": "L",
  "ı": "i", "ħ": "h", "Ħ": "H", "ŧ": "t", "Ŧ": "T",
};
const TRANSLIT_RE = new RegExp(`[${Object.keys(TRANSLIT).join("")}]`, "g");

// Cyrillic and Greek spelled in Latin, for slugify() ONLY
// (task-spor-client-lib-exports-for-server-dedup). fold() keeps these scripts
// as-is on purpose — a Cyrillic word is a retrieval term in its own right, and
// romanizing it would conflate distinct words — but an id stem must be ASCII,
// so without this a Russian or Greek title slugged to "" and every caller fell
// back to its generic stem. The values are the server's former `slugify`
// package charmap (1.6.9) for these two scripts, quirks included (θ -> 8,
// ξ -> 3, х -> h, щ -> sh), so a stem minted here matches the ids the server
// already minted before it dropped that dependency for this table (ѝ -> u
// must be keyed: NFKD alone would spell it i). A letter the charmap lacks but
// that decomposes onto a table letter (ѓ, ќ, ў, and compatibility Greek
// like µ) now romanizes too, where the package dropped it. Lowercase keys
// only: slugify() lowercases before it looks a letter up.
const SCRIPT_TRANSLIT = {
  // Cyrillic (Russian, Ukrainian, Belarusian, Serbian/Macedonian, Kazakh)
  "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "yo", "ж": "zh", "з": "z",
  "и": "i", "й": "j", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o", "п": "p", "р": "r",
  "с": "s", "т": "t", "у": "u", "ф": "f", "х": "h", "ц": "c", "ч": "ch", "ш": "sh", "щ": "sh",
  "ъ": "u", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
  "ѝ": "u", "ђ": "dj", "є": "ye", "і": "i", "ї": "yi", "ј": "j", "љ": "lj", "њ": "nj", "ћ": "c", "џ": "dz",
  "ґ": "g", "ғ": "gh", "қ": "kh", "ң": "ng", "ү": "ue", "ұ": "u", "һ": "h", "ә": "ae", "ө": "oe",
  // Greek (the accented forms decompose to these under NFKD)
  "α": "a", "β": "b", "γ": "g", "δ": "d", "ε": "e", "ζ": "z", "η": "h", "θ": "8", "ι": "i",
  "κ": "k", "λ": "l", "μ": "m", "ν": "n", "ξ": "3", "ο": "o", "π": "p", "ρ": "r", "σ": "s",
  "ς": "s", "τ": "t", "υ": "y", "φ": "f", "χ": "x", "ψ": "ps", "ω": "w",
};
const SCRIPT_TRANSLIT_RE = new RegExp(`[${Object.keys(SCRIPT_TRANSLIT).join("")}]`, "g");
const romanize = (t) => t.replace(SCRIPT_TRANSLIT_RE, (c) => SCRIPT_TRANSLIT[c]);

// eslint-disable-next-line no-control-regex
const ASCII = /^[\x00-\x7f]*$/;

// Fold a string to its accent-free spelling. Case-preserving; identity on
// ASCII. Letters of scripts with no Latin spelling (Cyrillic, Greek, Han, …)
// are kept as-is — they are words, not separators.
function fold(s) {
  const t = String(s == null ? "" : s);
  if (ASCII.test(t)) return t;
  return t.normalize("NFKD").replace(DIACRITICS, "").replace(TRANSLIT_RE, (c) => TRANSLIT[c]).normalize("NFC");
}

// Pinned to the root locale: word-boundary rules must not vary with the
// host's LANG, or two machines would tokenize one graph differently. A Node
// built without Intl.Segmenter falls back to the letter/number split alone
// (spaced scripts identical; unspaced scripts stay one run per phrase).
const SEGMENTER = typeof Intl === "object" && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter("und", { granularity: "word" })
  : null;
const NON_WORD = /[^\p{L}\p{M}\p{N}]+/u;
const NON_WORD_G = /[^\p{L}\p{M}\p{N}]+/gu;
const NON_ASCII_WORD_CHAR = /(?![\x00-\x7f])[\p{L}\p{M}\p{N}]/u;
// Scripts written without spaces between words — the only text the segmenter
// changes the answer for. Everything else skips it: segmenting is several
// times the cost of a regex split, and buildGraph tokenizes every node.
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}]/u;
// Scripts whose dictionary words are routinely two characters (東京, 会議,
// 한국): the length floor below is an alphabetic-script heuristic.
const IDEOGRAPHIC = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

// Lowercased, folded words in document order (no filtering). Word boundaries
// are read off the ORIGINAL characters and each word is folded afterwards, so
// a symbol whose compatibility form is letters (™ -> TM) still separates
// instead of gluing itself onto its neighbour ("spor™" -> "spor", not
// "sportm").
function words(s) {
  const lower = String(s == null ? "" : s).toLowerCase();
  // ASCII text is the pre-existing path, byte for byte — and so is text whose
  // only non-ASCII characters are separators anyway (—, →, “ ”: most of an
  // English graph), where the regex split already gives the right answer.
  if (!NON_ASCII_WORD_CHAR.test(lower)) return lower.split(/[^a-z0-9]+/).filter(Boolean);
  const out = [];
  const push = (run) => {
    for (const piece of run.split(NON_WORD)) {
      if (!piece) continue;
      if (ASCII.test(piece)) { out.push(piece); continue; }
      // A fold can itself yield a separator (½ -> 1⁄2) or, via a
      // compatibility form, an upper-case letter — split and lower again.
      for (const w of fold(piece).toLowerCase().split(NON_WORD)) if (w) out.push(w);
    }
  };
  if (SEGMENTER && UNSPACED.test(lower)) {
    for (const seg of SEGMENTER.segment(lower)) if (seg.isWordLike) push(seg.segment);
  } else push(lower);
  return out;
}

// Length in code points, so a non-BMP letter counts once.
function cpLength(w) {
  let n = 0;
  for (const _ of w) n++;
  return n;
}

// The tf-idf terms: words() minus stopwords and 1-2 character fragments (a
// 2-character ideographic word is a content word and survives).
function tokens(s) {
  return words(s).filter((w) => {
    if (STOP.has(w)) return false;
    if (ASCII.test(w)) return w.length > 2;
    const n = cpLength(w);
    return n > 2 || (n === 2 && IDEOGRAPHIC.test(w));
  });
}

// An id-safe ASCII kebab stem (`^[a-z0-9][a-z0-9-]*$` or ""): folded, runs of
// anything else collapsed to one '-', trimmed. With `max`, a stem longer than
// that is cut back to the last whole word that fits — never mid-word — and
// only hard-cut when its first word alone overruns the limit. Letters with no
// Latin spelling fold away entirely (a Han-only title yields "" and the caller
// falls back to its own stem); Cyrillic and Greek are romanized first
// (SCRIPT_TRANSLIT).
function slugify(s, max) {
  // Separators are read before the fold, as in words(): "Spor™ launch" stems
  // spor-launch, not sportm-launch. The script table runs on each side of the
  // fold: BEFORE it for the letters whose decomposition would lose their
  // spelling (й -> и + breve would slug to "i", not "j"; ё, ї likewise), and
  // AFTER it for the accented Greek vowels that only reach a table letter
  // once NFKD strips the tonos. ASCII input is untouched by both passes.
  const t = String(s == null ? "" : s).replace(NON_WORD_G, " ");
  const lower = ASCII.test(t) ? t : romanize(t.normalize("NFC").toLowerCase());
  const stem = romanize(fold(lower).toLowerCase())
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!(max > 0) || stem.length <= max) return stem;
  const cut = stem.slice(0, max + 1);
  const i = cut.lastIndexOf("-");
  return (i > 0 ? cut.slice(0, i) : stem.slice(0, max)).replace(/-+$/, "");
}

module.exports = { STOP, fold, words, tokens, slugify };

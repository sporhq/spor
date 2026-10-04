"use strict";
// The run-record write lint (task-spor-gate-progress-versioned-put-and-write-
// lint). The 2026-09-06 factory review filed 23 concurrency defects that were
// all the same shape: a whole-record read-modify-write of a run record —
// `gate_progress`, the attestation outbox (`gate_attestation_pending`), the
// obligations (`gate_escalation_pending`, `gate_flake_regate`) — outside the
// record lock, or with a premise read before it. The fix is structural, so the
// suite enforces the structure rather than testing for each defect: there is
// ONE versioned put (`putRecord` in lib/shell/agent-dispatch-runner.js), the
// only callers of it are the lock-taking namespace stampers, and every other
// module reaches a record's bytes only through those exported doors. Anything
// else that writes a record — a raw `atomicJson`, an `fs.writeFileSync` on a
// record path, a `gate_progress:` key built outside the writer, a settled-
// record door used from an unlisted function — fails this file.
//
// Source-scanning, deterministic, no I/O beyond reading the tree. Allowlists
// name TOP-LEVEL functions: growing one is a deliberate, reviewable edit here,
// which is the point — a new writer has to say so.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const RUNNER = "lib/shell/agent-dispatch-runner.js";

// The functions that may call `putRecord` — every one takes the record lock.
const RECORD_WRITERS = new Set([
  "closeRun",
  "settleNativeOutcome",
  "settleContractOutcome",
  "stampRun",
  "writeRecordCarryingGate",
  "mergeTerminalOutcome",
  "claimPipeline",
  "renewPipeline",
  "releasePipeline",
  "stampGateState",
  "stampImplState",
  "stampCompletionState",
]);
// The functions that may create a record that does not exist yet.
// The runner itself mints no records post-task-spor-dispatch-native-bg-retire
// (`beginNativeRun` — the only native-launch record creator — was deleted
// when native `--bg` dispatch was retired); `launchSupervisedHarness` in
// bin/spor.js is the surviving, and now only, record creator.
const RECORD_CREATORS = {
  "bin/spor.js": new Set(["launchSupervisedHarness"]),
};
// The settled-record patch door (`allowSettledPatch: true`), by caller.
const SETTLED_PATCH_CALLERS = {
  "bin/spor.js": new Set(["retryOneEscalation", "casFlakeRegateReservation", "cmdWorkRegateFlakes"]),
};
// The `force: true` door past a settled gate/impl verdict, by caller: a
// person re-judging a refused run (`spor work --regate`) and the proposal
// poller closing a parked landing.
const FORCE_CALLERS = {
  "bin/spor.js": new Set(["cmdWorkRegate", "checkProposals"]),
};
// The stampGateState callers that may stamp WITHOUT the pipeline lease's
// `own` door (issue-spor-gate-stamps-bypass-lease-owner), by caller. Every
// gate-pipeline stamp passes `own` — the lease is the ownership contract, so a
// driver displaced by a takeover lands nothing on the new holder's record. The
// rest are NOT pipeline drivers: post-settle bookkeeping on a record whose
// pipeline is over (the escalation retry's CAS on its own pending payload, the
// flake sweep's reservation CAS and retirement stamp, the proposal poller's
// debt flags), and the two no-owner arms whose builder refuses any record a
// lease has ever claimed.
const UNOWNED_GATE_STAMP_CALLERS = {
  "bin/spor.js": new Set(["retryOneEscalation", "casFlakeRegateReservation", "cmdWorkRegateFlakes", "checkProposals"]),
  "lib/shell/gate-deps.js": new Set(["stampPipelineLaunch"]),
  "lib/shell/work.js": new Set(["stampLoopVerdict"]),
};
// Keys only the writer may spell as an object key: the progress stamp and the
// revision the versioned put owns.
const WRITER_ONLY_KEYS = ["gate_progress", "rev", "rev_at"];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

function sourceFiles() {
  const files = [];
  for (const dir of ["bin", "lib", "scripts"]) {
    const abs = path.join(ROOT, dir);
    if (fs.existsSync(abs)) walk(abs, files);
  }
  return files.map((f) => path.relative(ROOT, f).split(path.sep).join("/")).sort();
}

// ONE tokenizer over the source: comments removed, string and regex-literal
// CONTENTS blanked (delimiters and newlines kept, so line numbers survive),
// template `${...}` holes kept as code. A scanner that knows strings but not
// regex literals is blinded by `/'/g` — the literal opens a "string" that runs
// to the next quote, hiding whatever code sits in between — so a regex literal
// is recognised by what precedes the `/`: an operator, an opener, a keyword,
// or the start of a line (a `/` after a value is division).
const REGEX_PRECEDERS = /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\b(?:return|typeof|case|do|else|in|of|instanceof|new|delete|void|throw|yield|await))\s*$/;
function tokenize(src) {
  let out = "";
  let i = 0;
  const templateDepth = []; // brace depth inside each open `${` hole
  const keepNewlines = (text) => text.replace(/[^\n]/g, " ");
  const skipRegex = () => {
    let j = i + 1;
    let inClass = false;
    for (; j < src.length; j += 1) {
      const c = src[j];
      if (c === "\\") { j += 1; continue; }
      if (c === "\n") break; // an unterminated regex is not one — treat as division
      if (inClass) { if (c === "]") inClass = false; continue; }
      if (c === "[") { inClass = true; continue; }
      if (c === "/") { j += 1; while (j < src.length && /[a-z]/i.test(src[j])) j += 1; return j; }
    }
    return -1;
  };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") i += 1; continue; }
    if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += keepNewlines(src.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === "'" || c === "\"") {
      let j = i + 1;
      for (; j < src.length && src[j] !== c && src[j] !== "\n"; j += 1) if (src[j] === "\\") j += 1;
      out += c + keepNewlines(src.slice(i + 1, j)) + (src[j] === c ? c : "");
      i = j + 1;
      continue;
    }
    if (c === "`") {
      // Template: blank until the closing backtick, but re-enter code at `${`.
      out += c;
      i += 1;
      for (;;) {
        if (i >= src.length) break;
        const t = src[i];
        if (t === "\\") { out += "  "; i += 2; continue; }
        if (t === "`") { out += t; i += 1; break; }
        if (t === "$" && src[i + 1] === "{") { out += "${"; i += 2; templateDepth.push(0); break; }
        out += t === "\n" ? "\n" : " ";
        i += 1;
      }
      continue;
    }
    if (templateDepth.length) {
      if (c === "{") templateDepth[templateDepth.length - 1] += 1;
      else if (c === "}") {
        if (templateDepth[templateDepth.length - 1] === 0) {
          // The hole closes: back into the template's blanked text.
          templateDepth.pop();
          out += "}";
          i += 1;
          for (;;) {
            if (i >= src.length) break;
            const t = src[i];
            if (t === "\\") { out += "  "; i += 2; continue; }
            if (t === "`") { out += t; i += 1; break; }
            if (t === "$" && src[i + 1] === "{") { out += "${"; i += 2; templateDepth.push(0); break; }
            out += t === "\n" ? "\n" : " ";
            i += 1;
          }
          continue;
        }
        templateDepth[templateDepth.length - 1] -= 1;
      }
    }
    if (c === "/" && REGEX_PRECEDERS.test(out.slice(-40))) {
      const j = skipRegex();
      if (j > 0) {
        out += "/" + keepNewlines(src.slice(i + 1, j - 1)) + "/";
        i = j;
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return out;
}


// A match that is the function's own definition (`function atomicJson(`),
// not a call of it.
function isDefinition(src, index) {
  return /function\s+$/.test(src.slice(Math.max(0, index - 40), index));
}

function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (src[i] === "\n") line += 1;
  return line;
}

// The top-level function a position sits in: the nearest preceding
// column-0 `function name(` / `async function name(`.
function enclosingFunction(src, index) {
  const before = src.slice(0, index);
  const re = /^(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gm;
  let name = null;
  let m;
  while ((m = re.exec(before))) name = m[1];
  return name;
}

// The text of a call starting at the `(` at `open`, balanced on parens with
// strings skipped.
function callText(src, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (quote) {
      if (c === "\\") { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === "\"" || c === "`") { quote = c; continue; }
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

function firstArg(text) {
  const inner = text.slice(1);
  let depth = 0;
  let quote = null;
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    if (quote) {
      if (c === "\\") { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === "\"" || c === "`") { quote = c; continue; }
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (c === "," && depth === 0) return inner.slice(0, i);
  }
  return inner;
}

function scan() {
  const violations = [];
  const unownedSeen = new Set();
  const sources = new Map();
  for (const rel of sourceFiles()) {
    const raw = fs.readFileSync(path.join(ROOT, rel), "utf8");
    sources.set(rel, { raw, code: tokenize(raw) });
  }
  const flag = (rel, code, index, what) => violations.push(`${rel}:${lineOf(code, index)} ${what}`);

  // The canary against a blinded scanner: every column-0 function definition
  // in the raw source must survive tokenizing. A regex literal or string the
  // tokenizer misread would swallow code — and with it the definitions — so a
  // mismatch here is the tokenizer's bug, not a clean tree.
  const defs = (text) => (text.match(/^(?:async\s+)?function\s+[A-Za-z0-9_$]+\s*\(/gm) || []).length;
  for (const [rel, { raw, code }] of sources) {
    const rawDefs = defs(raw.replace(/^\s*\/\/.*$/gm, ""));
    assert.strictEqual(defs(code), rawDefs, `${rel}: the lint's tokenizer lost ${rawDefs - defs(code)} top-level function definition(s) — a misread string or regex literal is hiding code from the scan`);
  }

  for (const [rel, { code }] of sources) {
    const inRunner = rel === RUNNER;

    // R1 — `atomicJson(` is called from exactly one place: the versioned put.
    for (const m of code.matchAll(/(?<![A-Za-z0-9_$])atomicJson\s*\(/g)) {
      if (isDefinition(code, m.index)) continue;
      const fn = enclosingFunction(code, m.index);
      if (inRunner && fn === "putRecord") continue;
      flag(rel, code, m.index, `direct atomicJson write (in ${fn || "module scope"}) — run records are written through putRecord only`);
    }

    // R2 — `putRecord(` is called only by the lock-taking writers, only in the runner.
    for (const m of code.matchAll(/(?<![A-Za-z0-9_$.])putRecord\s*\(/g)) {
      if (isDefinition(code, m.index)) continue;
      const fn = enclosingFunction(code, m.index);
      if (!inRunner) { flag(rel, code, m.index, `putRecord is the runner's private writer; use an exported stamper`); continue; }
      if (!RECORD_WRITERS.has(fn)) flag(rel, code, m.index, `putRecord called from ${fn || "module scope"}, which is not a listed record writer`);
    }

    // R3 — `createRecord(` only where a record is minted.
    for (const m of code.matchAll(/(?<![A-Za-z0-9_$])createRecord\s*\(/g)) {
      if (isDefinition(code, m.index)) continue;
      const fn = enclosingFunction(code, m.index);
      const allowed = RECORD_CREATORS[rel];
      if (!allowed || !allowed.has(fn)) flag(rel, code, m.index, `createRecord called from ${fn || "module scope"} — only a launcher mints a record`);
    }

    // R4 — no raw write whose target is a record path: the `fs`/`fsp`/
    // `fs.promises` primitives, a destructured one, and the tree's own
    // atomic-write helpers (`writeFileAtomic`, `writePrivate`).
    for (const m of code.matchAll(/(?<![A-Za-z0-9_$])(?:[A-Za-z_$][\w$]*\.)*(writeFileSync|writeFile|renameSync|rename|copyFileSync|copyFile|appendFileSync|appendFile|writeSync|linkSync|link|writeFileAtomic|writePrivate)\s*\(/g)) {
      const fn = enclosingFunction(code, m.index);
      if (inRunner && (fn === "atomicJson" || fn === "createRecord")) continue;
      if (isDefinition(code, m.index)) continue;
      const arg = firstArg(callText(code, m.index + m[0].length - 1));
      // A RUN record path: `runPaths(...).record`, a `record_path`, a
      // `.run.json` — not every variable with "record" in its name (the
      // execution store keeps its own records, under its own writer).
      if (/\.record\b|record_path|recordFile|run\.json|runPaths\s*\(/.test(arg)) flag(rel, code, m.index, `raw ${m[1]} onto a run record path (${arg.trim()}) in ${fn || "module scope"}`);
    }

    // R5 — writer-only keys are never spelled as object keys elsewhere, and
    // `gate_progress` is never assigned onto a record directly.
    if (!inRunner) {
      for (const key of WRITER_ONLY_KEYS) {
        for (const m of code.matchAll(new RegExp(`(?<![A-Za-z0-9_$.])${key}\\s*:(?!:)`, "g"))) {
          flag(rel, code, m.index, `object key '${key}:' built outside the record writer (in ${enclosingFunction(code, m.index) || "module scope"})`);
        }
      }
    }
    // The ledger left the record (task-spor-run-surfaces-read-stage-journal:
    // agent-dispatch-runner.js appendGateProgress writes the gate-progress log
    // beside the stage journals), so NOTHING assigns it any more — a legacy
    // stamp is read, never rewritten.
    for (const m of code.matchAll(/\.gate_progress\s*=[^=]/g)) {
      flag(rel, code, m.index, `direct assignment to .gate_progress (in ${enclosingFunction(code, m.index) || "module scope"})`);
    }

    // R6 — the doors past a settled verdict are used only by listed callers.
    if (!inRunner) {
      for (const m of code.matchAll(/allowSettledPatch/g)) {
        const fn = enclosingFunction(code, m.index);
        const allowed = SETTLED_PATCH_CALLERS[rel];
        if (!allowed || !allowed.has(fn)) flag(rel, code, m.index, `allowSettledPatch used from ${fn || "module scope"}, not a listed settled-patch caller`);
      }
      for (const m of code.matchAll(/\.(stampGateState|stampImplState)\s*\(/g)) {
        const text = callText(code, m.index + m[0].length - 1);
        if (!/\bforce\s*:\s*true\b/.test(text)) continue;
        const fn = enclosingFunction(code, m.index);
        const allowed = FORCE_CALLERS[rel];
        if (!allowed || !allowed.has(fn)) flag(rel, code, m.index, `${m[1]} with force:true from ${fn || "module scope"}, not a listed force caller`);
      }
    }

    // R9 — every stampGateState call outside the runner passes the pipeline
    // lease's `own` door, unless its caller is a listed non-pipeline one.
    if (!inRunner) {
      for (const m of code.matchAll(/\.stampGateState\s*\(/g)) {
        const text = callText(code, m.index + m[0].length - 1);
        if (/\bown\s*:/.test(text)) continue;
        const fn = enclosingFunction(code, m.index);
        const allowed = UNOWNED_GATE_STAMP_CALLERS[rel];
        if (!allowed || !allowed.has(fn)) flag(rel, code, m.index, `stampGateState without \`own\` from ${fn || "module scope"}, not a listed non-pipeline caller — a gate-pipeline stamp must go through the lease's own door`);
        else unownedSeen.add(`${rel}:${fn}`);
      }
    }

    // R7 — the record lock is the runner's; a second lock user is a second writer.
    if (!inRunner) {
      for (const m of code.matchAll(/\b(withRecordLock|recordLockPath|breakerLockPath|breakStaleLock)\b/g)) {
        flag(rel, code, m.index, `${m[1]} referenced outside the runner (in ${enclosingFunction(code, m.index) || "module scope"})`);
      }
    }
  }

  // R9 — an allowlisted unowned caller that no longer stamps unowned is a
  // stale entry: drop it, so the list stays the exact set it claims to be.
  for (const [rel, fns] of Object.entries(UNOWNED_GATE_STAMP_CALLERS)) {
    for (const fn of fns) if (!unownedSeen.has(`${rel}:${fn}`)) violations.push(`${rel}: ${fn} is listed in UNOWNED_GATE_STAMP_CALLERS but makes no unowned stampGateState call`);
  }

  // R8 — every listed writer exists, takes the lock, and defaults it to withRecordLock.
  const runner = sources.get(RUNNER).code;
  for (const name of RECORD_WRITERS) {
    const re = new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`, "m");
    const m = runner.match(re);
    assert.ok(m, `${name} is listed as a record writer but is not a top-level function in ${RUNNER}`);
    const params = callText(runner, m.index + m[0].length - 1);
    assert.match(params, /lock\s*=\s*withRecordLock/, `${name} must take the record lock by default (lock = withRecordLock)`);
    const start = m.index;
    const nextFn = runner.slice(start + m[0].length).search(/^(?:async\s+)?function\s+[A-Za-z0-9_$]+\s*\(/m);
    const body = runner.slice(start, nextFn < 0 ? undefined : start + m[0].length + nextFn);
    assert.match(body, /\block\s*\(/, `${name} must run its write inside lock(...)`);
    assert.doesNotMatch(body, /(?<![A-Za-z0-9_$])atomicJson\s*\(/, `${name} must write through putRecord, not atomicJson`);
  }
  return violations;
}

test("run records are written through ONE versioned put, from the lock-taking writers only, and nothing else writes them", () => {
  const violations = scan();
  assert.deepStrictEqual(violations, [], `record-write lint:\n  ${violations.join("\n  ")}`);
});

test("the lint's own detectors fire on the shapes they exist for", () => {
  // A quick self-test of the helpers against synthetic code, so an edit to the
  // scanner that silently stops matching does not read as a clean tree.
  const code = tokenize([
    "// atomicJson( in a comment is not a call",
    "function other() {",
    "  const merged = { ...record, gate_progress: {} };",
    "  atomicJson(file, merged); /* atomicJson( */",
    "  fs.writeFileSync(p.record, JSON.stringify(x), 'utf8');",
    "  dispatchRuns.stampGateState(home, id, { gate_state: 'x' }, { force: true });",
    "}",
  ].join("\n"));
  assert.strictEqual(enclosingFunction(code, code.indexOf("atomicJson(")), "other");
  assert.strictEqual([...code.matchAll(/(?<![A-Za-z0-9_$])atomicJson\s*\(/g)].length, 1, "comments are stripped, the call is kept");
  const w = code.match(/fs\.writeFileSync\s*\(/);
  assert.match(firstArg(callText(code, w.index + w[0].length - 1)), /record/);
  const s = code.match(/\.stampGateState\s*\(/);
  assert.match(callText(code, s.index + s[0].length - 1), /force\s*:\s*true/);
  // R9: a call is owned by its `own:` option, wherever the options object sits.
  const own = tokenize("function f() { r.stampGateState(home, id, { gate_fix_run_id: x }); r.stampGateState(home, id, (fresh) => patch, { own: token }); }");
  const owns = [...own.matchAll(/\.stampGateState\s*\(/g)].map((m) => /\bown\s*:/.test(callText(own, m.index + m[0].length - 1)));
  assert.deepStrictEqual(owns, [false, true]);
  assert.strictEqual([...code.matchAll(/(?<![A-Za-z0-9_$.])gate_progress\s*:(?!:)/g)].length, 1);
  assert.strictEqual(lineOf(code, code.indexOf("fs.writeFileSync")), 5);
  const blanked = tokenize("const s = \"rev: x\"; const t = `gate_progress: ${1}`; writeFileAtomic(p.record, x);");
  assert.doesNotMatch(blanked, /rev:|gate_progress:/, "string contents are blanked");
  assert.match(blanked, /writeFileAtomic\(p\.record/, "code survives");
  assert.match(firstArg("(recordFile, x)"), /recordFile/);
  assert.doesNotMatch("recordPath(home, t, id)", /\.record\b|record_path|recordFile|run\.json|runPaths\s*\(/, "another store's records are not run records");
  const w2 = blanked.match(/(?<![A-Za-z0-9_$.])(writeFileAtomic)\s*\(/);
  assert.match(firstArg(callText(blanked, w2.index + w2[0].length - 1)), /record/);
  // Regex literals with quotes do not swallow the code after them; division does not open one.
  const rx = tokenize([
    "const a = s.replace(/'/g, \"x\");",
    "const b = /^\\s{0,3}(`{3,}|~{3,})(.*)$/.exec(l);",
    "const c = total / count; const d = other / 2;",
    "function afterRegex() { atomicJson(p.record, x); }",
    "const t = `pre ${ atomicJson(q, `in${1}ner`) } post`;",
  ].join("\n"));
  assert.strictEqual([...rx.matchAll(/(?<![A-Za-z0-9_$])atomicJson\s*\(/g)].length, 2, "code after a quote-bearing regex literal, and inside a template hole, is still scanned");
  assert.strictEqual(enclosingFunction(rx, rx.indexOf("atomicJson(")), "afterRegex");
  assert.doesNotMatch(rx, /x"\)/, "string contents blanked");
  assert.match(rx, /total \/ count/, "division survives");
  // Qualified write primitives are seen whatever the qualifier.
  const q = tokenize("u.writeFileAtomic(p.record, x); atomicWrite.writeFileAtomic(recordFile, y); require(\"fs\").writeFileSync(paths.record, z);");
  assert.strictEqual([...q.matchAll(/(?<![A-Za-z0-9_$])(?:[A-Za-z_$][\w$]*\.)*(writeFileSync|writeFileAtomic)\s*\(/g)].length, 3);
});

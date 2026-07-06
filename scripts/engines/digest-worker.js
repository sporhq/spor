"use strict";
// digest-worker: run the digest intent classifier OFF the prompt path
// (dec-spor-digest-noise-needs-async-semantic-intent). Spawned detached by the
// prompt-context engine when digest.async is on — the same mechanism as
// nudge-worker.js. It reads a spool INPUT file (the filled classifier prompt +
// the already-computed micro-digest), asks the backend whether injecting that
// context would genuinely help the prompt's work, and — unless the verdict is
// an explicit UNWARRANTED — writes a pending-RESULT file that the next
// UserPromptSubmit drains and injects with NO LLM call on the prompt path
// (norm-cc-no-llm-prompt-path).
//
// Fail-open runs in the NOISE direction, deliberately: a backend failure,
// timeout, or unparseable verdict still writes the result (the shipped
// inject-everything behavior). The classifier can only ever REMOVE noise; it
// must never be a new way to lose a warranted digest.
//
//   node digest-worker.js <input-spool.in.json>

const fs = require("fs");
const path = require("path");
const u = require("./util");
const { classifyDigestIntent } = require("./prompt-context");

const inFile = process.argv[2];
if (!inFile) process.exit(0);

let job;
try {
  job = JSON.parse(fs.readFileSync(inFile, "utf8"));
} catch {
  process.exit(0);
}
// Consume the input immediately so a duplicate worker (belt-and-suspenders)
// can't re-run the same classification.
try {
  fs.unlinkSync(inFile);
} catch {}

let verdict = null;
try {
  verdict = classifyDigestIntent(job);
} catch {
  /* fail-open: treated as inject below */
}

if (verdict !== "UNWARRANTED" && job.digest && job.hash) {
  const outFile = path.join(path.dirname(inFile), `${job.hash}.out.json`);
  // Write to a temp name then rename so the prompt-time drainer (which globs
  // `*.out.json`) can never read a half-written file — rename is atomic and the
  // `.tmp` is invisible to the glob.
  const tmp = `${outFile}.tmp`;
  try {
    fs.writeFileSync(
      tmp,
      JSON.stringify({ digest: job.digest, sig: job.sig, slug: job.slug, verdict: verdict ?? "fail-open", ts: u.jqNow() })
    );
    fs.renameSync(tmp, outFile);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

process.exit(0);

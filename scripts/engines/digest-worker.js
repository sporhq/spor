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

const u = require("./util");
const { classifyDigestIntent } = require("./prompt-context");

// The detached worker has no active config; adopt the originating cwd's cascade
// ONLY when a file-configured digest.intentApiKey (never spooled — a secret) is
// there to find, so the no-key path reads exactly what it always did.
const classify = (job) => {
  if (job.cwd && !u.cfgStr("digest.intentApiKey", "DIGEST_INTENT_API_KEY")) {
    const cfg = require(require("path").join(u.ROOT, "lib", "config.js")).loadConfig({ cwd: job.cwd });
    if (cfg.get("digest.intentApiKey")) u.useConfig({ cwd: job.cwd });
  }
  return classifyDigestIntent(job);
};

u.runSpoolWorker(process.argv[2], classify, (job, verdict) =>
  verdict !== "UNWARRANTED" && job.digest
    ? { digest: job.digest, sig: job.sig, slug: job.slug, verdict: verdict ?? "fail-open", ts: u.jqNow() }
    : null
);

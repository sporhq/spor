"use strict";
// The prompt-time drains for the two async hand-off spools — the capture-nudge
// spool (journal/pending-nudges/<session>/) and the digest-intent spool
// (journal/pending-digests/<session>/). Moved out of prompt-context.js
// byte-identical (task-spor-move-prompt-context-drain-loops-next-to-spool); they
// sit beside the spool-handling engines (spool-sweeper.js, distill.js) rather
// than in lib/shell/spool.js because they speak the engines' util (appendLine,
// spawnDetached, jqNow), which lib/ must not depend on. The spool primitives
// themselves stay in lib/shell/spool.js, re-exported on util.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const u = require("./util");

function parseDigest(digest) {
  const header = [];
  const nodes = [];
  const corrections = [];
  let inCorr = false;
  for (const line of String(digest).split("\n")) {
    if (/^Standing corrections:/.test(line)) {
      inCorr = true;
      continue;
    }
    if (inCorr) {
      if (line.trim()) corrections.push(line);
      continue;
    }
    if (line.startsWith("- **")) nodes.push(line);
    else if (!nodes.length && line.trim()) header.push(line);
  }
  return { header, nodes, corrections };
}

function digestSignature(digest) {
  const { nodes, corrections } = parseDigest(digest);
  const basis = nodes.map((l) => l.replace(/: .*/, "")).join("\n") + "\n--\n" + corrections.join("\n");
  return crypto.createHash("sha256").update(basis || digest, "utf8").digest("hex");
}

// task-cc-async-classifier-pending-result-injection: the prompt-time half of
// the async capture nudge. The post-tool worker dropped `<hash>.out.json` files
// under journal/pending-nudges/<session>/ when a background classification
// found facts; this drains them, merges them into ONE capture-nudge block, and
// consumes the files. It is a pure file read — NO LLM call — so it stays clean
// under norm-cc-no-llm-prompt-path, and it runs regardless of the trivial /
// continuation gates below (a pending finding is about a file the agent wrote,
// not about this prompt's relevance). Session-scoped fired cap of 3
// (journal/<session>.nudged-injected), matching the synchronous nudge's cap;
// results beyond the cap are consumed and dropped (parity with sync, which
// stops firing after 3). Fail-open: any error injects nothing.
const PENDING_ORPHAN_MS = u.SPOOL_TTL.orphanInput; // prune an un-consumed `.in.json` after 1h
function drainPendingNudges(graph, input, slug) {
  // Resolve the session EXACTLY as post-tool does (input.session_id ?? "unknown")
  // — the dispatcher already folds cursor/copilot's conversation_id/sessionId
  // onto session_id, so a divergent fallback here would key the drain dir
  // differently from the writer and silently lose every async nudge when
  // session_id is absent.
  const session = input.session_id ?? "unknown";
  const dir = path.join(graph, "journal", "pending-nudges", session);
  let all;
  try {
    all = fs.readdirSync(dir);
  } catch {
    return ""; // no spool dir for this session
  }
  const files = all.filter((f) => f.endsWith(".out.json")).sort();

  const injectedState = path.join(graph, "journal", `${session}.nudged-injected`);
  let injectedLines = [];
  try {
    injectedLines = fs.readFileSync(injectedState, "utf8").split("\n").filter(Boolean);
  } catch {}
  const injected = injectedLines.length;
  const injectedFiles = new Set(injectedLines);

  // Per-result accounting in THREE states, because "this pass did not discharge
  // the debt" and "this pass may destroy the job" are different claims and
  // collapsing them is how a finding disappears (F16/F17):
  //   settled  — a verdict was actually READ here, so the worker's `.in.json`
  //              is answered and prunable (row (d): read state, never a bare
  //              filename);
  //   deferred — a result FILE exists for this hash but this pass reached no
  //              verdict on it (another drain holds the claim, took it, or the
  //              claim write itself failed). Neither prune nor re-drive: the
  //              pair is left exactly as it is for a later sweep;
  //   neither  — no result at all, so the input is an orphan candidate and the
  //              sweep below may re-drive it.
  // The deferred state is what the old code was missing. It treated EVERY null
  // claim — and a vanished result — as proof of settlement and pruned the
  // input, but a claim is taken BEFORE its owner has read the bytes: the owner
  // may still find them unparseable, and its own recovery is to re-drive the
  // input this pass had already deleted. A claim rename that simply FAILED
  // (EACCES, EBUSY, EIO, a Windows sharing violation) is worse still — nobody
  // owns the finding, nobody read it, and both copies were being dropped on the
  // strength of a syscall error.
  const settled = new Set();
  const deferred = new Set();
  const results = [];
  // Results this pass has judged and means to destroy (already injected, or
  // over the fired cap). They are NOT unlinked in the read loop: a result is
  // the durable record of its job's verdict, and destroying it while the
  // worker's `.in.json` is still spooled leaves a concurrent sweep looking at
  // "no result + a stale input" — which is the re-drive signal, so it spends a
  // second classifier call on a job this pass already settled (row (c)/(d),
  // F17). Every consume is therefore deferred until after the prune below has
  // taken the input out from under that reading — owe (the result) before you
  // clear (the input), then clear the result last.
  const discard = [];
  for (const f of files) {
    const hash = u.spoolResultHash(f);
    // Claim before reading (dec-spor-nudge-drain-atomic-claim): the SessionEnd
    // drain reads this same spool, and without the claim an overlapping pair
    // can inject a finding here and capture it there. See u.claimSpoolResult.
    const claimed = u.claimSpoolResult(dir, f);
    if (!claimed) {
      // held / gone / failed — see u.claimSpoolResult. Not one of the three is
      // a read verdict, so the job stays owed and untouched.
      deferred.add(hash);
      continue;
    }
    const fp = path.join(dir, claimed);
    // A failed READ is not a malformed result, and only the second is
    // terminal: EIO, EMFILE, EACCES and a Windows sharing violation all read
    // fine on a later sweep, so they keep the result AND its input. ENOENT is
    // not a verdict either — the file was taken out from under us, which says
    // only that this pass cannot judge it, so the input stays owed too. (The
    // cost of that is bounded and one-sided: once no result remains for the
    // hash, the orphan sweep re-drives the input ONCE. Paying one classifier
    // call beats deleting the last copy of a job whose verdict nobody read.)
    let raw = null;
    try {
      raw = fs.readFileSync(fp, "utf8");
    } catch {
      deferred.add(hash);
      continue;
    }
    let r = null;
    try {
      r = JSON.parse(raw);
    } catch {}
    if (!r || !r.file || !r.facts) {
      // Bytes that do not parse into a usable result reach the same verdict on
      // every future sweep, so the result itself is terminal and must not
      // linger and re-inject. Deliberately NOT settled: if the worker's input
      // is still spooled it is now the only recoverable copy of the job, and
      // the sweep below re-drives it rather than deleting both.
      try {
        fs.unlinkSync(fp);
      } catch {}
      continue;
    }
    // A readable verdict: the job is answered, whatever happens to it here.
    settled.add(hash);
    if (injectedFiles.has(r.file)) {
      // Already surfaced this session — including the crash window below,
      // where the marker landed and the unlink did not. Consume it, never
      // re-inject it. QUEUED, not unlinked here: see `consume` below.
      discard.push({ hash, fp });
      continue;
    }
    if (injected + results.length >= 3) {
      // Over the session's fired cap. Consumed rather than left to re-inject
      // next prompt: the count only ever grows, so it can never come back
      // under the cap (parity with the synchronous nudge, which simply stops
      // firing after 3).
      discard.push({ hash, fp });
      continue;
    }
    results.push({ r, fp, hash });
  }

  // RE-DRIVE, then GC (bounds the spool leak): an input still sitting here an
  // hour after it was spooled means its detached worker never landed a verdict
  // — it died mid-classification, or its result write failed. util's
  // runSpoolWorker deliberately keeps the input as the DEBT in exactly those
  // cases (owe-before-clear), so this sweep is who that debt is owed to: give
  // it one more worker rather than silently dropping a classification the
  // session already paid the tool-loop reservation for.
  //
  // The re-drive itself is ordered OWE BEFORE YOU CLEAR (row (b)): the job is
  // COPIED to the retry-spent `<hash>.redriven.in.json` name, the worker is
  // spawned on that copy, and only THEN is the original unlinked. The copy is
  // created with COPYFILE_EXCL, which is the atomic claim two overlapping
  // sweeps race for — exactly one creates it, every loser gets EEXIST and
  // skips, so the retry is still spent at most once. The old order RENAMED
  // first, which made the claim and the retry-spent stamp the same write: a
  // crash between it and the spawn left a file whose name said its retry was
  // spent when no worker had ever run, and the next sweep deleted the only
  // copy of the job. Now that same crash leaves the original sitting BESIDE
  // the copy, and a copy with its original still present is proof the spawn
  // never landed — so the sweep re-spawns it (refreshing the copy from the
  // original, which also heals a copy torn by that crash) instead of
  // discarding it. A synchronous spawn failure removes the copy and keeps the
  // original: a retry that never started has not been spent.
  //
  // The bound is unchanged — a copy whose worker DID run and die is pruned on
  // the next sweep, so one spooled job still costs at most one extra
  // classifier call. The one case that repeats is a box where spawning a
  // worker cannot work at all: the pair stays, and the sweep tries again once
  // per orphan horizon. That is rate-limited, spends no backend call, and is
  // strictly better than deleting a classifier-verified finding because a
  // spawn failed.
  //
  // Two reconciliations run BEFORE any of that (row (d)): an input whose
  // `<hash>.out.json` this pass could account for has already reached a
  // verdict — only its own cleanup failed — and an input whose file is in
  // `.nudged-injected` has been surfaced. Either way the debt is discharged,
  // so it is pruned instead of spending a second classifier call or re-showing
  // a finding this session has already seen.
  //
  // Deliberately do NOT rmdir an emptied dir: a worker's result lands seconds
  // after its input clears, so the dir is legitimately empty mid-classification
  // and removing it would race that write out from under it. An empty dir
  // persists like the other per-session journal files (.nudged, .jsonl) until a
  // wider journal GC lands.
  try {
    const now = Date.now();
    const rm = (p) => {
      try {
        fs.unlinkSync(p);
      } catch {}
    };
    // Pair each job's original with its re-drive copy: the two names are one
    // job, and every decision below is about the PAIR, not about a filename.
    const jobs = new Map();
    for (const f of all) {
      if (!f.endsWith(".in.json")) continue;
      const hash = f.replace(/(?:\.redriven)?\.in\.json$/, "");
      const e = jobs.get(hash) || {};
      if (f.endsWith(".redriven.in.json")) e.copy = true;
      else e.plain = true;
      jobs.set(hash, e);
    }
    for (const [hash, has] of jobs) {
      const plain = has.plain ? path.join(dir, `${hash}.in.json`) : null;
      const copy = path.join(dir, `${hash}.redriven.in.json`);
      // A result exists for this job that this pass could not judge (row (c)):
      // its claim is held by a live drain, it was taken, or the claim write
      // failed. The job is neither discharged nor orphaned — leave the pair
      // untouched and let a later sweep, once the owner has exited, reach a
      // real verdict on it.
      if (deferred.has(hash)) continue;
      // Everything below MUTATES the pair, so it runs under ONE exclusive
      // per-job lock (row (c), F17). COPYFILE_EXCL is the atomic claim for a
      // FIRST re-drive, but the recovery arm re-copies over a
      // `.redriven.in.json` that already exists and nothing guarded that: two
      // overlapping sweeps could both re-copy — tearing the copy under a
      // worker already reading it — and both spawn. The lock covers the settled
      // prune too, so a prune can never delete files another sweep is
      // mid-recovery on. It is pid-stamped, liveness-checked and TTL-bounded
      // like the result claim, so a crash while holding it self-heals; a lock
      // we cannot take means only "not ours this pass", never "act anyway".
      const release = u.claimSpoolJob(dir, hash);
      if (!release) continue;
      try {
        if (settled.has(hash)) {
          // Its verdict already landed (and this pass injected, consumed or
          // handed it on) — only the worker's own cleanup failed.
          if (plain) rm(plain);
          if (has.copy) rm(copy);
          continue;
        }
        // The file that GOVERNS the pair is the re-drive copy when there is
        // one: it carries the horizon a running worker is protected by, and
        // the original's older stamp says nothing about that worker.
        const governing = has.copy ? copy : plain;
        if (!governing) continue;
        if (now - fs.statSync(governing).mtimeMs <= PENDING_ORPHAN_MS) continue;
        let job = null;
        try {
          job = JSON.parse(fs.readFileSync(governing, "utf8"));
        } catch {}
        if (job && job.file && injectedFiles.has(job.file)) {
          if (plain) rm(plain); // already surfaced — re-driving it re-injects it
          if (has.copy) rm(copy);
          continue;
        }
        if (has.copy && !plain) {
          rm(copy); // its one retry ran and is spent
          continue;
        }
        if (has.copy) {
          // A stale copy with its original still beside it: the spawn never
          // landed (it precedes the unlink below), so this retry was never
          // actually spent. Refresh the copy from the original — healing a
          // copy the crash tore in half — and drive it.
          //
          // The refresh is a temp-write + atomic rename, never a copy in place
          // (F20). This same state also arises the other way round — the spawn
          // DID land and only the `rm(plain)` below failed — and the two are
          // indistinguishable from the pair alone. Owe-before-clear picks the
          // safe reading (an extra classifier call beats a dropped job), but an
          // in-place copy would then rewrite the file a live worker is reading.
          // A rename swaps the inode instead, so that worker keeps reading the
          // intact bytes it opened and the residual is only the bounded extra
          // call, never a torn job.
          const heal = `${copy}.heal-${process.pid}`;
          try {
            fs.copyFileSync(plain, heal);
            fs.renameSync(heal, copy);
          } catch {
            rm(heal);
            continue; // cannot re-arm it; the pair keeps the job owed
          }
        } else {
          // First re-drive. COPYFILE_EXCL is the atomic claim: exactly one
          // sweep creates the copy, and the original is still the debt until
          // the spawn below has landed.
          try {
            fs.copyFileSync(plain, copy, fs.constants.COPYFILE_EXCL);
          } catch {
            continue; // lost the claim, or the job could not be copied
          }
        }
        try {
          u.spawnDetached([path.join(__dirname, "nudge-worker.js"), copy]);
        } catch {
          rm(copy); // the retry never started, so it is not spent — hand it back
          continue;
        }
        rm(plain); // the worker owns the job now; the original is discharged
      } catch {
      } finally {
        release();
      }
    }
  } catch {}

  // The consume, now that the prune above has run: destroying a result while
  // its job's input is still spooled hands a later sweep the exact state it
  // reads as "never classified" (row (c)/(d), F17). So a result is unlinked
  // only once neither half of its input pair remains — the prune succeeded, or
  // the worker had already cleared it. If an input survived (the job lock was
  // another sweep's this pass, or the unlink failed), the result is KEPT: it is
  // re-read next pass, re-reconciled against `.nudged-injected` — so it is
  // never re-injected — and its input pruned then. Retention is the safe side;
  // a leftover result costs one re-read, a premature one costs a backend call
  // or a lost finding.
  const inputRemains = (hash) => {
    for (const n of [`${hash}.in.json`, `${hash}.redriven.in.json`]) {
      try {
        fs.accessSync(path.join(dir, n));
        return true;
      } catch {}
    }
    return false;
  };
  const consume = (hash, fp) => {
    if (inputRemains(hash)) return;
    try {
      fs.unlinkSync(fp);
    } catch {}
  };
  for (const { hash, fp } of discard) consume(hash, fp);

  if (!results.length) return "";

  for (const { r, fp, hash } of results) {
    // OWE BEFORE YOU CLEAR (row (b)): the injected marker — and the journal
    // line the capture-metrics correlation reads — are written while the
    // result file is still on disk, and only then is it consumed. A crash in
    // between leaves the result claimed but INTACT, and the next drain
    // reconciles it against that marker above (consume, do not re-inject);
    // clearing first left a window with neither a debt nor a finding in it.
    //
    // (row (a)) That marker write is the ONLY record of the debt this consume
    // discharges, so it is not allowed to be best-effort here: if it did not
    // land, the result file is KEPT. A finding re-injected next prompt is
    // noise; a finding consumed against a marker that was never written is
    // gone. Everything downstream of the marker — the metrics journal line —
    // is genuinely best-effort and does not gate the consume.
    const marked = u.appendLine(injectedState, r.file);
    // Journal the fired nudge (async) so lib/capture-metrics.js correlates it to
    // a subsequent capture, exactly like the synchronous nudge's journal line.
    u.appendLine(
      path.join(graph, "journal", `${session}.jsonl`),
      JSON.stringify({ ts: u.jqNow(), project: slug, tool: "nudge", file: r.file, facts: r.nfacts, async: true })
    );
    if (!marked) continue; // still injected below — just not yet discharged
    consume(hash, fp);
  }

  // Cap the merged fact blocks so the framing — the actionable "capture it NOW"
  // instruction and the disable hint — always survives (each fact list is
  // already ≤3500 bytes and up to 3 inject, so the raw join can top 10KB and get
  // cut mid-instruction by the host's additionalContext ceiling).
  const blocks = u.byteHead(
    results
      .map(({ r }) => `The file you wrote (${r.file}) contains findings that do not appear to be in the team graph:\n\n${u.stripTrailingNewlines(r.facts)}`)
      .join("\n\n"),
    7000
  );
  return `[spor capture nudge] A background classifier reviewed prose file(s) you wrote earlier this session:

${blocks}

If a finding is durable, capture it NOW — one /spor:defer (or capture tool) call per finding, in your own words with full context. If none are durable, dismiss this consciously and move on. (Classifier: source=nudge, async; disable with SPOR_NUDGE=0 or SPOR_NUDGE_ASYNC=0.)`;
}

// The prompt-time drain for digest.async: pick up the worker's pending digest
// results and inject the newest with NO LLM call. Unlike capture-nudge findings
// (independent per-file facts), pending digests are competing snapshots of the
// same session's context — the latest supersedes the rest — so every file is
// consumed but only the newest injects. `suppress` consumes without injecting
// (the caller is already injecting a fresh synchronous digest this prompt — the
// cap/fail-open fallback — and a stale pending one beside it is exactly the
// noise this gate exists to cut). A drained digest is deduped against the last
// one injected this session (journal/<session>.digest-injected) so a same-topic
// prompt run doesn't re-inject identical context every turn.
function drainPendingDigests(graph, input, slug, { suppress = false } = {}) {
  const session = input.session_id ?? "unknown";
  const dir = path.join(graph, "journal", "pending-digests", session);
  let all;
  try {
    all = fs.readdirSync(dir);
  } catch {
    return ""; // no spool dir for this session
  }

  // Each result is TAKEN by rename before it is read (u.claimAndReadJson), so
  // two overlapping prompts in one session can never both inject one snapshot
  // — the loser's rename finds nothing. The claimed name keeps the hash prefix,
  // so the ascending sort still orders by spool time.
  let result = null;
  for (const f of all.filter((n) => n.endsWith(".out.json")).sort()) {
    const r = u.claimAndReadJson(dir, f);
    if (r && r.digest) result = r; // sorted ascending — the last valid one is newest
  }

  // GC orphaned inputs whose detached worker never ran (same bound and same
  // deliberate no-rmdir as the nudge spool — see drainPendingNudges).
  try {
    const now = Date.now();
    for (const f of all) {
      if (!f.endsWith(".in.json")) continue;
      const fp = path.join(dir, f);
      try {
        if (now - fs.statSync(fp).mtimeMs > PENDING_ORPHAN_MS) fs.unlinkSync(fp);
      } catch {}
    }
  } catch {}

  if (!result || suppress) return "";
  // A pending digest is project-scoped retrieval: if the session moved to a
  // different project (cwd change under one graph home) between the spool and
  // this drain, another project's context is exactly the noise this gate cuts —
  // drop it (already consumed above).
  if (result.slug && slug && result.slug !== slug) return "";

  const injState = path.join(graph, "journal", `${session}.digest-injected`);
  let lastSig = "";
  try {
    const lines = fs.readFileSync(injState, "utf8").split("\n").filter(Boolean);
    lastSig = lines[lines.length - 1] || "";
  } catch {}
  const sig = result.sig || digestSignature(result.digest);
  if (sig === lastSig) return "";
  u.appendLine(injState, sig);
  u.appendLine(
    path.join(graph, "journal", `${session}.jsonl`),
    JSON.stringify({ ts: u.jqNow(), project: slug, tool: "digest", async: true })
  );
  return result.digest;
}

module.exports = { drainPendingNudges, drainPendingDigests, digestSignature, parseDigest };

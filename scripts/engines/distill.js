"use strict";
// SessionEnd engine (async): distill the session transcript into Spor
// nodes. Node port of distill.sh — LOCAL mode writes nodes, normalizes edge
// variants (pure string ops replace the BSD-incompatible sed -i), validates,
// and commits the graph repo; REMOTE mode is the capture client (QUEUE.md
// §2.3). The transcript NEVER leaves the client in either mode.
//
// Recursion guard: the headless backend call would fire its own SessionEnd
// hook on exit; SPOR_DISTILLING (or legacy SUBSTRATE_DISTILLING) short-circuits that. NEVER remove it.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const u = require("./util");
const { drainOutbox } = require("./drain-outbox");
const { inferCommits } = require("./infer-commits");
const graphLib = require(path.join(u.ROOT, "lib", "graph.js"));

// The nested-repo guard (graph home === code repo) now lives in util so the
// `spor init` path can share it (task-spor-onboard-cli-init-git-identity).
const { graphInsideCodeRepo } = u;

// Claude transcript shape: per-JSONL-line `select(.type=="user" or
// .type=="assistant") | .type + ": " + <content text>`.
function claudeConvo(docs) {
  const out = [];
  for (const doc of docs) {
    if (!doc || (doc.type !== "user" && doc.type !== "assistant")) continue;
    const content = doc.message?.content;
    let text;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((c) => c && c.type === "text")
        .map((c) => c.text)
        .join("\n");
    } else {
      continue; // jq would error on other shapes; suppressed by 2>/dev/null
    }
    out.push(`${doc.type}: ${text}`);
  }
  return out.join("\n");
}

// Edge-type variants the distiller model is prone to; sed replaced the first
// occurrence per line.
const EDGE_FIXES = [
  ["{type: related-to,", "{type: relates-to,"],
  ["{type: derives-from,", "{type: derived-from,"],
  ["{type: supercedes,", "{type: supersedes,"],
];
function normalizeEdges(text) {
  return text
    .split("\n")
    .map((line) => {
      for (const [from, to] of EDGE_FIXES) {
        const i = line.indexOf(from);
        if (i !== -1) line = line.slice(0, i) + to + line.slice(i + from.length);
      }
      return line;
    })
    .join("\n");
}

// ===NODE <file>=== ... ===END=== blocks.
function parseNodeBlocks(response) {
  const blocks = [];
  let file = "";
  let emit = false;
  let content = "";
  for (const line of String(response).split("\n")) {
    const m = line.match(/^===NODE (.*)===$/);
    if (m) {
      file = m[1].replace(/===$/, "");
      emit = true;
      content = "";
      continue;
    }
    if (line === "===END===") {
      if (emit && file !== "") blocks.push({ file, content });
      emit = false;
      file = "";
      continue;
    }
    if (emit) content += line + "\n";
  }
  return blocks;
}

// ===FACT=== ... ===END=== blocks (content preserves inner newlines).
function parseFactBlocks(response) {
  const facts = [];
  let emit = false;
  let content = "";
  for (const line of String(response).split("\n")) {
    if (line === "===FACT===") {
      emit = true;
      content = "";
      continue;
    }
    if (line === "===END===") {
      if (emit && content !== "") facts.push(content);
      emit = false;
      continue;
    }
    if (emit) content += line + "\n";
  }
  return facts;
}

// task-cc-client-sessionend-reserve-hook (dec-cc-task-resumption-reservation):
// the fifth-and-sixth lease actions, called from SessionEnd. Converts every
// task THIS SESSION held a live Tier-1 lease on — evidenced by its own
// claim-heartbeat journal lines, the no-LLM per-write renewal the post-tool
// claim-nudge branch already performs (task-cc-claim-nudge-hook) — into
// whichever half of the two-tier lease model fits: still open -> an
// owner-exclusive resumption reservation (`reserve`, advanced but unfinished);
// gone terminal or closed by a resolver edge -> `release` (drop the lease and
// the durable `assigned` edge, cleaning up after finished work). A task this
// session never actually renewed (no edit landed while its lease was live) is
// left alone entirely — "does nothing when no claim was held" — so its Tier-1
// lease just expires on its own TTL rather than being touched by a session
// that did no real work on it.
//
// Scoping to THIS session's own heartbeat record — not a fresh person-scoped
// `assignee=me` queue read — is deliberate: a finished task drops out of the
// queue entirely (rankQueue only ever lists LIVE nodes, even in the steward
// view), so that endpoint can't see a task that just went terminal; and a
// person-scoped read would risk acting on a claim a DIFFERENT concurrent
// session of the same person is still actively working. The session's own
// journal has neither problem.
//
// Same gating posture as the post-tool claim-nudge branch: remote/team mode
// only, in a real git repo, fail-open, config-cascade knobs
// (sessionLease.enabled / SPOR_SESSION_LEASE, default on). No LLM.
async function sessionEndLease({ graph, slug, session, cwd, remote }) {
  if (!remote) return; // a lease is meaningless without a shared server
  if (u.config() ? !u.config().getBool("sessionLease.enabled", true) : (u.envDual("SESSION_LEASE") ?? "1") === "0")
    return;
  const top = u.git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top || !top.trim()) return; // no repo root -> no project pool to act on

  const journalPath = path.join(graph, "journal", `${session}.jsonl`);
  let entries = [];
  try {
    entries = fs
      .readFileSync(journalPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return; // no journal for this session -> no heartbeats -> nothing held
  }
  // Replayed in journal ORDER, because a heartbeat line is a point-in-time
  // reading, not a cumulative one: `renewed` adds a node this beat confirmed,
  // `dropped` REMOVES one it no longer holds. The blanket heartbeat never
  // re-acquires a lapsed lease (dec-spor-heartbeat-adopts-blanket-renew-arm),
  // so without honoring `dropped` the union would still carry a node that went
  // back to the pool mid-session — and `reserve` below AUTO-RECLAIMS an unheld
  // node (dec-spor-lease-auto-reclaim-and-deadline-exposure), quietly taking it
  // back off the pool for a two-day grace window. That is exactly the silent
  // re-claim the heartbeat's arm was chosen to avoid; SessionEnd must not
  // reintroduce it a beat later. A node claimed again after a drop simply
  // re-enters via the next beat's `renewed`. u.readHeartbeatHeldIds is the
  // shared reader for post-tool.js's u.appendHeartbeatRecord writer
  // (task-spor-heartbeat-journal-protocol-shape-guard) — don't re-inline this
  // replay loop, or a field rename on one side can silently break the other.
  const ids = u.readHeartbeatHeldIds(entries);
  if (ids.size === 0) return; // no claim held this session

  const timeoutMs = u.cfgNum("sessionLease.timeoutMs", "SESSION_LEASE_TIMEOUT", 3000);
  // Each id's GET+POST is independent, so run them concurrently rather than
  // paying up to N * 2 * timeoutMs sequentially for a session that held
  // several claims.
  const convert = async (id) => {
    const get = await u
      .curl(`${u.serverBase()}/v1/nodes/${encodeURIComponent(id)}`, { headers: u.bearer(), timeoutMs })
      .catch(() => null);
    if (!get || get.http !== "200") return; // can't verify -> leave the lease alone
    let parsed;
    try {
      parsed = JSON.parse(get.body);
    } catch {
      return;
    }
    if (typeof parsed.raw !== "string") return;
    const rawLines = parsed.raw.split("\n");
    const status = rawLines.find((l) => l.startsWith("status:"))?.slice(7).trim() ?? "";
    // The node's type, preferring the server-parsed frontmatter over the raw
    // line scan (the scan is a fallback for older servers whose GET /v1/nodes
    // response predates the frontmatter field).
    const type = (typeof parsed.frontmatter?.type === "string" && parsed.frontmatter.type) ||
      (rawLines.find((l) => l.startsWith("type:"))?.slice(5).trim() ?? "");
    // Status lags resolution edges (issue-cc-status-lags-resolution-edges):
    // the `resolution` read-time enrichment (a live inbound resolves/answers
    // edge) means the task is done even while its status field still reads
    // open, so either signal counts as finished. The type rides along for the
    // type-aware signature (dec-spor-status-inert-third-partition). Same
    // tiered inert decision as bin/spor.js's dispatchResolutionReason
    // (issue-spor-type-blind-terminal-status-fallbacks, isNodeInertOffline):
    // a server-computed `inert` enrichment key when this server sends one is
    // trusted outright, BOTH values — it already saw the full type-aware
    // partition, including graph-resident overrides, that this caller can't,
    // so an authoritative `false` must not be second-guessed by the offline
    // check below any more than a `true` should be; else the offline
    // seed-registry check, which is still type-aware (an artifact `released`
    // IS visible here) but blind to graph-resident extensions — the
    // server-side lease/queue reads remain the type-aware authority for those.
    const finished = Boolean(parsed.resolution) || graphLib.isNodeInertOffline(parsed.inert, status, type || null);
    const action = finished ? "release" : "reserve";
    const body = action === "reserve" ? JSON.stringify({ session }) : "{}";
    const post = await u
      .curl(`${u.serverBase()}/v1/nodes/${encodeURIComponent(id)}/${action}`, {
        method: "POST",
        headers: { ...u.bearer(), "content-type": "application/json" },
        body,
        timeoutMs,
      })
      .catch(() => null);
    u.appendLine(
      journalPath,
      JSON.stringify({ ts: u.jqNow(), project: slug, tool: "session-lease", id, action, http: post ? post.http : "000" })
    );
  };
  await Promise.all([...ids].map(convert));
}

// task-spor-distill-conditional-status-fetch: the fact-finder's dedup index
// used to re-download the full titles snapshot from /v1/status?titles=1
// (5-15MB) on every sweep. The server now serves conditional-request
// semantics there (a weak ETag + a bodyless 304 on a matching
// If-None-Match, task-cc-tier-2-read-path-scaling) -- this caches the last
// snapshot alongside its ETag (per server, since one machine can point at
// different graph homes over time) so a synced graph collapses to a 304 and
// reuses the cached titles instead. Machine-local runtime state, so it lives
// under cache/ like the coupling-nudge snapshot (GRAPH_IGNORES).
function statusTitlesCacheFile(graph) {
  return path.join(graph, "cache", "status-titles.json");
}
async function fetchRemoteTitleIndex(graph, rlog) {
  const server = u.serverBase();
  const cacheFile = statusTitlesCacheFile(graph);
  let cached = null;
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (c && c.server === server && typeof c.etag === "string" && typeof c.index === "string") cached = c;
  } catch {}
  const headers = { ...u.bearer() };
  if (cached) headers["If-None-Match"] = cached.etag;
  const resp = await u.curl(`${server}/v1/status?titles=1`, { headers, timeoutMs: 6000 });
  const head = resp.headers?.["x-substrate-head"] || "";
  if (resp.http === "304" && cached) {
    rlog(`index cached (http=304, head=${head})`);
    return cached.index;
  }
  if (resp.http === "200") {
    const index = u.remoteTitleIndex(resp.body);
    const etag = resp.headers?.etag;
    if (etag && u.ensureDir(path.join(graph, "cache"))) {
      try {
        fs.writeFileSync(cacheFile, JSON.stringify({ v: 1, server, etag, index, head }));
      } catch {}
    }
    rlog(`index fetched (http=${resp.http})`);
    return index;
  }
  // Stale beats none (the cached-title-index rule, see post-tool.js coupling
  // nudge): a failed refresh distills against last sweep's snapshot instead
  // of an empty one, whether the failure is a transport error or an
  // unexpected status.
  rlog(`index fetch failed (http=${resp.http}); distilling against ${cached ? "cached" : "empty"} index`);
  return cached ? cached.index : "";
}

// Create `nodePath` with `md` if and only if nothing occupies it yet, and make
// it appear COMPLETE or not at all. Returns true when this call created it,
// false when another actor won the race; throws on a real IO failure, so a
// caller can tell "someone else has it" from "we could not write".
//
// hardlink-then-unlink is the primitive that gives both properties at once:
// the temp file is fully written before it is linked, and link() fails with
// EEXIST rather than clobbering. Where the filesystem has no usable link()
// (EPERM/EOPNOTSUPP/ENOSYS on some mounts), the fallback must keep BOTH — an
// in-place `wx` write keeps exclusivity but gives up atomicity, and a
// concurrent drain that reads a half-written node parses a matching
// `capture_key` out of complete frontmatter, calls the finding settled, and
// consumes the only spool copy of a body that was never written. So the
// fallback reserves the pathname with the exclusive create and then RENAMES
// the finished temp file over its own reservation.
function createNodeExclusive(nodePath, md) {
  const tmp = `${nodePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, md);
    try {
      fs.linkSync(tmp, nodePath);
      return true;
    } catch (e) {
      if (e && e.code === "EEXIST") return false;
      if (e && ["EPERM", "EOPNOTSUPP", "ENOSYS", "EXDEV"].includes(e.code)) {
        // `wx` is an ATOMIC exclusive create everywhere — it is only the
        // WRITING that is not atomic — so use it purely as the reservation and
        // let rename() publish the bytes. Nobody else can hold this
        // reservation, so the rename replaces a placeholder that is provably
        // ours and never another actor's node.
        let fd;
        try {
          fd = fs.openSync(nodePath, "wx");
        } catch (e2) {
          if (e2 && e2.code === "EEXIST") return false;
          throw e2;
        }
        try {
          fs.closeSync(fd);
        } catch {
          /* best effort */
        }
        try {
          fs.renameSync(tmp, nodePath);
          return true;
        } catch (e3) {
          // Hand the pathname back rather than leaving an empty node squatting
          // it: the caller keeps the finding spooled and a later sweep retries
          // the same id instead of minting a longer one.
          try {
            fs.rmSync(nodePath, { force: true });
          } catch {
            /* best effort */
          }
          throw e3;
        }
      }
      throw e;
    }
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
  }
}

// issue-spor-async-nudge-session-final-loss: the SessionEnd half of the async
// capture-nudge. A background nudge-worker classifies a written file OFF the
// tool loop and drops a `<hash>.out.json` result under
// journal/pending-nudges/<session>/ for the NEXT UserPromptSubmit to drain
// (prompt-context.js's drainPendingNudges) — but a finding produced by the
// session's FINAL action has no next prompt to drive that drain, so it sits
// stranded in the spool forever. This drains the ENDING session's leftover
// results and writes each straight through the capture path (local: a
// validated node file, no LLM needed — the worker's classifier already
// verified these facts; remote: POST /v1/capture, spooling to the outbox on
// transport failure exactly like the LLM distiller's own per-fact loop
// below).
//
// Independent of the LLM distill() call — same posture as sessionEndLease —
// so a disabled/failing distiller (distill.enabled:false, or a dead backend)
// never stops an already-classified finding from landing; it needs no LLM
// call of its own. Unlike sessionEndLease this DOES run on a
// debounce-approximated firing (input.spor_debounced): capturing a finding is
// idempotent — the source .out.json is consumed either way — and doing it a
// beat early for a turn-scoped host (Codex/Copilot/OpenCode) can only reduce
// loss, never mis-act on a lease someone else is mid-editing the way an
// unwarranted reclaim could.
//
// Consume/supersede semantics mirror drainPendingNudges's, with one
// deliberate difference (issue-spor-session-end-pending-nudges-data-loss):
// this drain is the LAST chance a finding gets, so a `.out.json` is consumed
// only once its finding is somewhere durable — a 200, a spooled outbox
// payload, a dead-lettered payload, a written node — or is provably
// uncapturable. TERMINAL outcomes are consumed (bytes that do not PARSE into a
// usable result, a finding already recorded in <session>.nudged-injected, a
// node the parser or validator refuses): re-reading any of those on a later
// sweep can only reach the same verdict, so they must not linger. A TRANSIENT
// failure — a failed READ of the spool file, no local graph yet, an unloadable
// graph, a node/outbox/dead-letter write that failed — LEAVES the file in the
// spool instead of destroying the only copy of a classifier-verified finding,
// since SessionEnd can fire more than once for one session (a
// debounce-approximated firing precedes the real one on a turn-scoped host).
// Note the read/parse split: an IO failure and corrupt bytes are NOT the same
// verdict, and collapsing them is exactly the loss this drain exists to stop.
// A server 400/413/422 is permanent but still not discardable — API.md §5 has
// a mechanical writer preserve a rejected payload in outbox/dead/, so it is
// dead-lettered and the consume waits on THAT write. The consume therefore
// trails the durable write, which makes a crash in between re-owe an
// already-captured finding: both modes make that replay idempotent rather
// than duplicating — remote on the `idempotency_key` below (and a
// key-deterministic outbox/dead-letter filename), local on a content-addressed
// node id whose full key is stamped as `capture_key` so a re-drain RECONCILES
// against the node it already wrote rather than trusting a pathname. A finding already recorded in <session>.nudged-injected — drained
// and injected in-session, or a rare race with a concurrent prompt-time drain
// — is skipped, never double-captured. Gated on nudge.async (default off) so the
// shipped synchronous path stays byte-identical: no config read touches the
// filesystem when it's unset, and a sync-mode session never has a
// pending-nudges spool to find in the first place. ALSO gated on
// nudge.enabled, mirroring drainPendingNudges's double-gate exactly
// (prompt-context.js) — SPOR_NUDGE=0 must suppress this drain the same way it
// suppresses the prompt-time one, so a user who disabled nudges mid-session
// never gets an old pending finding captured behind their back.
async function sessionEndPendingNudges({ graph, slug, session, remote }) {
  if (!u.cfgBool("nudge.enabled", "NUDGE", true)) return;
  if (!u.cfgBool("nudge.async", "NUDGE_ASYNC", false)) return;

  const dir = path.join(graph, "journal", "pending-nudges", session);
  let all;
  try {
    all = fs.readdirSync(dir);
  } catch {
    return; // no spool dir for this session
  }
  const files = all.filter((f) => f.endsWith(".out.json")).sort();
  if (!files.length) return;

  let alreadyInjected = new Set();
  try {
    alreadyInjected = new Set(
      fs
        .readFileSync(path.join(graph, "journal", `${session}.nudged-injected`), "utf8")
        .split("\n")
        .filter(Boolean)
    );
  } catch {}

  // Destroy a spool file only where re-reading it could not do better: the
  // file IS the debt, so retention needs no flag of its own to be written and
  // no failure of ours can silently drop it.
  const consume = (fp) => {
    try {
      fs.unlinkSync(fp);
    } catch {}
  };

  const rlog = u.makeLogger(path.join(graph, "journal", "remote.log"), `nudge-sessionend ${slug}: `);
  const llog = (m) => u.appendLine(path.join(graph, "journal", "distill.log"), `  ${m}`);
  const note = remote ? rlog : llog;

  const results = [];
  for (const f of files) {
    // Claim before reading (dec-spor-nudge-drain-atomic-claim): the
    // prompt-time drain reads this same spool and INJECTS what it finds, so
    // without the claim an overlapping pair can inject a finding there and
    // capture it here. The claimed name still ends in `.out.json`, so a
    // finding this drain deliberately keeps stays visible to every later
    // sweep — the claim narrows who may act on it, it never destroys it.
    const claimStatus = {};
    const claimed = u.claimSpoolResult(dir, f, claimStatus);
    if (!claimed) {
      // "held"/"gone" is another drain doing its job and needs no note. A
      // "failed" claim is different: the rename itself failed (EACCES, EBUSY,
      // EIO, a Windows sharing violation), so NOBODY has the finding and this
      // last-chance drain silently walked past it. The file is still there —
      // the claim never destroys what it cannot take — so a later sweep can
      // still land it, but the operator needs the line to know why nothing
      // was captured (fail-open hooks look identical to healthy ones,
      // dec-cc-fail-open-hooks).
      if (claimStatus.outcome === "failed") note(`session-final result ${f} kept in the spool: claim failed`);
      continue;
    }
    const fp = path.join(dir, claimed);
    // A read that FAILED is not a result that is MALFORMED, and only the
    // second is terminal. EIO, EMFILE, EACCES and a Windows sharing violation
    // all read fine on a later sweep, so a failed read keeps its file —
    // collapsing the two is the very data loss this drain exists to stop.
    // ENOENT is neither: the file is already gone (a concurrent drain took
    // it), so there is nothing to keep and nothing to consume.
    let raw = null;
    try {
      raw = fs.readFileSync(fp, "utf8");
    } catch (e) {
      if (e && e.code !== "ENOENT") note(`session-final result ${f} kept in the spool: read failed: ${e.message}`);
      continue;
    }
    let r = null;
    try {
      r = JSON.parse(raw);
    } catch {}
    // Terminal here and now: bytes that do not parse into a usable result
    // reach the same verdict on every future sweep, and an already-injected
    // finding is one this session has surfaced already. Everything still
    // capturable keeps its file until the capture below lands it somewhere
    // durable.
    if (r && r.file && r.facts && !alreadyInjected.has(r.file)) results.push({ r, fp });
    else consume(fp);
  }
  if (!results.length) return;

  for (const { r, fp } of results) {
    const facts = u.stripTrailingNewlines(r.facts);
    const text = `Classifier-verified findings from ${r.file}, captured at session end because the session had no further prompt to drain them:\n\n${facts}`;
    // The capture's identity, shared by both modes: because the consume now
    // trails the durable write, a crash in the gap re-drains a finding that
    // already landed, so the retry has to resolve to the SAME capture. The
    // key is the finding itself — this session, this file, these facts.
    const key = crypto.createHash("sha256").update(`${session}\n${r.file}\n${facts}`).digest("hex");

    if (remote) {
      const body = JSON.stringify({
        text: u.byteHead(text, 3900),
        // Always the ambient session slug, never user-declared — same
        // posture as the LLM distiller's per-fact capture loop below.
        context: { project: slug, project_explicit: false },
        source: "nudge-sessionend",
        idempotency_key: key,
      });
      const post = await u
        .curl(`${u.serverBase()}/v1/capture`, {
          method: "POST",
          headers: { ...u.bearer(), "Content-Type": "application/json" },
          body,
          timeoutMs: 30000,
        })
        .catch(() => null);
      // Deterministic on the capture key rather than on a clock+RANDOM name,
      // so the replay the deferred consume allows (a crash between the durable
      // write and the unlink) overwrites its own byte-identical file instead of
      // piling a second copy into the spool.
      const spoolName = `${session}-${key.slice(0, 16)}.capture.json`;
      if (post && post.http === "200") {
        rlog(`captured session-final finding from ${r.file}`);
        consume(fp);
      } else if (post && ["400", "413", "422"].includes(post.http)) {
        // The server's verdict on this exact body — a re-post can only be
        // rejected again, so it is PERMANENT. API.md §5 says what a mechanical
        // writer does with a permanent reject: dead-letter it to `outbox/dead/`
        // with a loud remote.log line, never discard it. That preserves the
        // rejected payload for inspection or replay after a fix, and it is the
        // channel session-start and `spor-hook doctor` already count and
        // surface — so the consume waits on the dead-letter write landing,
        // exactly as the outbox spool below does. (401 is deliberately NOT
        // here: it spools instead, handing the dead-letter decision to
        // drain-outbox, which owns it and can re-post once a token is re-minted.)
        let dead = false;
        if (u.ensureDir(path.join(graph, "outbox", "dead"))) {
          try {
            u.writeFileAtomic(path.join(graph, "outbox", "dead", spoolName), body);
            dead = true;
          } catch {}
        }
        if (dead) {
          rlog(
            `session-final finding from ${r.file} rejected (http=${post.http}, permanent); ` +
              `dead-lettered to outbox/dead/${spoolName} for inspection`
          );
          consume(fp);
        } else {
          rlog(`session-final finding from ${r.file} kept in the spool: dead-letter write failed (http=${post.http})`);
        }
      } else {
        let spooled = false;
        if (u.ensureDir(path.join(graph, "outbox"))) {
          try {
            u.writeFileAtomic(path.join(graph, "outbox", spoolName), body);
            spooled = true;
          } catch {}
        }
        // The outbox is the durable handoff here, so its write is what the
        // consume waits on: an unwritable outbox is the exact case that used
        // to lose the finding outright.
        if (spooled) {
          rlog(`session-final finding from ${r.file} spooled to outbox (http=${post ? post.http : "000"})`);
          consume(fp);
        } else {
          rlog(`session-final finding from ${r.file} kept in the spool: outbox write failed (http=${post ? post.http : "000"})`);
        }
      }
      continue;
    }

    // LOCAL MODE: write a validated node file directly — no LLM needed, the
    // async classifier already verified these facts. Same minimal heuristic
    // shape as `spor add`'s local path (bin/spor.js cmdAdd): a type-prefixed
    // id, title/summary from the finding text, machine authorship stamped so
    // briefings render it as such.
    const logFile = path.join(graph, "journal", "distill.log");
    const nodesDir = path.join(graph, "nodes");
    // The next two are TRANSIENT: a graph home that is not initialized yet, or
    // one that momentarily fails to load, can both be true again later, so the
    // finding stays in the spool rather than being thrown away over them.
    if (!fs.existsSync(nodesDir)) {
      u.appendLine(logFile, `  session-final capture from ${r.file} kept in the spool: no local graph at ${nodesDir}`);
      continue;
    }
    let g;
    try {
      g = graphLib.loadGraph(nodesDir);
    } catch (e) {
      u.appendLine(logFile, `  session-final capture from ${r.file} kept in the spool: loadGraph failed: ${e.message}`);
      continue;
    }
    const type = "task";
    const prefixes = (g.registry && g.registry.prefixesFor(type)) || null;
    const prefix = prefixes && prefixes[0] ? prefixes[0] : `${type}-`;
    const stem = u.slugify(path.basename(r.file, path.extname(r.file))) || "capture";
    // Content-addressed instead of collision-suffixed: the id is a function of
    // the same key the remote idempotency_key uses, so a re-drained finding
    // resolves to the node it already wrote rather than minting a second one,
    // while two DIFFERENT findings out of one file still land on distinct ids —
    // which is all the old `-2` suffix was buying. The id carries a TRUNCATION
    // of the key, so an occupied pathname is never on its own proof that THIS
    // finding is the one already captured: the full key is stamped on the node
    // as `capture_key` and reconciled below, and a mismatch (a truncation
    // collision, or an unrelated node someone authored or renamed onto the id)
    // falls through to the next, longer candidate instead of silently
    // consuming a finding that was never written.
    const idFor = (n) => `${prefix}nudge-sessionend-${stem}-${key.slice(0, n)}`;
    const title = `Session-final capture-nudge findings from ${r.file}`.slice(0, 120);
    const firstFact = facts.split("\n")[0] || title;
    const summary = firstFact.length > 497 ? `${firstFact.slice(0, 497)}...` : firstFact;
    const mdFor = (id) =>
      `---\nid: ${id}\ntype: ${type}\nrepo: ${slug}\ntitle: ${title.replace(/\n/g, " ")}\nsummary: ${summary.replace(
        /\n/g,
        " "
      )}\ndate: ${u.localDate()}\nauthored_via: capture\ncapture_key: ${key}\n---\n\n${text}\n`;

    // Settled | free | torn | taken, decided by READING the occupant rather
    // than by its existence. Unreadable is none of those — it is transient, so
    // it keeps the finding spooled rather than deciding either way.
    //
    // A matching `capture_key` alone is not proof the finding LANDED: on a
    // filesystem without link() the node is published by a rename over an
    // exclusive reservation, and a legacy (or crash-torn) file can carry
    // complete frontmatter over a truncated body. So settled additionally
    // requires the body to still carry the facts verbatim — which an ordinary
    // later edit (an added edge, a reworded title) preserves and a torn write
    // cannot. `torn` is treated like `taken`: the finding moves to the next
    // candidate id rather than being consumed against a node that does not
    // contain it.
    const reconcile = (nodePath) => {
      let existing;
      try {
        existing = fs.readFileSync(nodePath, "utf8");
      } catch (e) {
        if (e && e.code === "ENOENT") return "free";
        return "unreadable";
      }
      let parsed = null;
      try {
        parsed = graphLib.parseFrontmatter(existing, path.basename(nodePath));
      } catch {}
      if (!parsed || parsed.capture_key !== key) return "taken";
      // The BODY specifically, not the raw file: the frontmatter's `summary`
      // is the finding's own first line, so a whole-file match would call an
      // empty body settled on any single-fact capture.
      return String(parsed.body || "").includes(facts) ? "settled" : "torn";
    };

    let settledAs = null;
    let candidate = null;
    let blocked = false;
    for (const n of [16, 24, 64]) {
      const id = idFor(n);
      const state = reconcile(path.join(nodesDir, `${id}.md`));
      if (state === "settled") {
        settledAs = id;
        break;
      }
      if (state === "unreadable") {
        u.appendLine(logFile, `  session-final capture from ${r.file} kept in the spool: ${id}.md unreadable`);
        blocked = true;
        break;
      }
      if (state === "free") {
        candidate = id;
        break;
      }
      if (state === "torn") {
        u.appendLine(
          logFile,
          `  session-final capture from ${r.file}: ${id}.md carries this capture key over a truncated body; trying a longer id`
        );
      }
      // "taken"/"torn" — this pathname does not hold the finding; try a longer
      // key slice.
    }
    if (blocked) continue;
    if (settledAs) {
      u.appendLine(logFile, `  session-final capture from ${r.file} already written as ${settledAs}`);
      consume(fp);
      continue;
    }
    if (!candidate) {
      u.appendLine(logFile, `  session-final capture from ${r.file} kept in the spool: every candidate id is taken`);
      continue;
    }
    const id = candidate;
    const md = mdFor(id);
    // A finding this graph's own parser or validator refuses is terminal —
    // the same bytes reach the same verdict on every future sweep — so it is
    // consumed rather than left to be re-judged forever.
    let node;
    try {
      node = graphLib.parseFrontmatter(md, `${id}.md`);
    } catch (e) {
      u.appendLine(logFile, `  session-final capture from ${r.file} dropped: parseFrontmatter failed: ${e.message}`);
      consume(fp);
      continue;
    }
    const v = graphLib.validateNode(g, node);
    if (!v.ok) {
      u.appendLine(logFile, `  session-final capture invalid, skipped: ${v.errors.join("; ")}`);
      consume(fp);
      continue;
    }
    try {
      // The existence check above is a fast path, not the guarantee: another
      // drain (or a resumed sweep) can create the same id between it and this
      // write. `createNodeExclusive` is therefore both ATOMIC — the node
      // appears complete or not at all, so no concurrent reader parses a
      // half-written file — and EXCLUSIVE, so the loser of the race never
      // clobbers the winner and is told it lost.
      if (!createNodeExclusive(path.join(nodesDir, `${id}.md`), md)) {
        // Someone else got there first. Re-read to see whether it is THIS
        // finding before consuming anything (row (d): reconcile, never act on
        // the bare fact that a file appeared).
        const state = reconcile(path.join(nodesDir, `${id}.md`));
        if (state === "settled") {
          u.appendLine(logFile, `  session-final capture from ${r.file} already written as ${id} (concurrent drain)`);
          consume(fp);
        } else {
          u.appendLine(logFile, `  session-final capture from ${r.file} kept in the spool: ${id}.md taken mid-write`);
        }
        continue;
      }
      u.appendLine(logFile, `  wrote ${path.join(nodesDir, `${id}.md`)} (session-final nudge capture)`);
      consume(fp);
    } catch (e) {
      u.appendLine(logFile, `  session-final capture from ${r.file} kept in the spool: write failed: ${e.message}`);
    }
  }
}

async function distill(input) {
  if (process.env.SPOR_DISTILLING || process.env.SUBSTRATE_DISTILLING) return null;

  const graph = u.graphHome();
  const remote = Boolean(u.serverBase());
  const cwd = input.cwd ?? "";
  const session = input.session_id ?? "unknown";
  const slug = u.projectSlug(cwd);

  // task-cc-client-sessionend-reserve-hook: independent of the LLM
  // distillation below (no-LLM, its own gates) so a disabled/failing
  // distiller never blocks the lease conversion, and vice versa. Skipped for
  // a debounce-approximated firing (spor_debounced, set by bin/spor-hook.js
  // when spooling for Codex/Copilot/OpenCode's turn-scoped quiescence) — that
  // is NOT a genuine session-end signal, and a mid-session pause trips it just
  // as easily as a real goodbye, so acting on it risks silently reserving or
  // releasing a claim that is still actively being worked.
  if (!input.spor_debounced) {
    await sessionEndLease({ graph, slug, session, cwd, remote }).catch(() => {});
  }

  // See sessionEndPendingNudges above for why this runs unconditionally
  // (including on a debounce-approximated firing) and ahead of the
  // distill.enabled kill switch below.
  await sessionEndPendingNudges({ graph, slug, session, remote }).catch(() => {});

  // User kill switch, symmetric with the nudge's SPOR_NUDGE=0 (post-tool.js):
  // SPOR_DISTILL=0 (env) or distill.enabled:false (config) disables the paid
  // SessionEnd distill call. No active config falls back to the exact env
  // dual-read, so unset behavior is byte-identical (default "1").
  if (u.config() ? !u.config().getBool("distill.enabled", true) : (u.envDual("DISTILL") ?? "1") === "0") return null;

  const nodes = path.join(graph, "nodes");
  if (!remote && !fs.existsSync(nodes)) return null;

  const transcriptPath = input.transcript_path ?? "";
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

  u.ensureDir(path.join(graph, "journal"));
  const logFile = path.join(graph, "journal", "distill.log");
  const log = u.makeLogger(logFile, `${session}: `);
  const rlog = u.makeLogger(path.join(graph, "journal", "remote.log"), `distill ${slug}: `);

  // In remote mode, drain any previously-spooled outbox payloads first.
  if (remote) await drainOutbox(graph, "distill").catch(() => {});

  // Conversation text (last ~24k chars), roles prefixed; generic .text
  // fallback for non-Claude transcript shapes.
  let raw = "";
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }
  // jq -r emits a trailing newline; tail -c counts that byte; $() strips it.
  const tailStrip = (s) => u.stripTrailingNewlines(u.byteTail(s ? s + "\n" : "", 24000));
  const docs = u.parseJsonStream(raw);
  let convo = tailStrip(claudeConvo(docs));
  if (u.wordCount(convo) < 80) {
    convo = tailStrip(u.collectTextFields(docs).join("\n"));
  }
  if (u.wordCount(convo) < 80) {
    log("skipped: transcript too small");
    return null;
  }

  // Files this session touched (jq -r '.file' | sort -u | head -30 — lines
  // without a file render as "null", exactly as jq -r did).
  let touched = "";
  try {
    const vals = fs
      .readFileSync(path.join(graph, "journal", `${session}.jsonl`), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          const v = JSON.parse(l).file;
          return v === undefined || v === null ? "null" : String(v);
        } catch {
          return null;
        }
      })
      .filter((v) => v !== null);
    touched = [...new Set(vals)].sort().slice(0, 30).join("\n");
  } catch {}

  // Graph index: locally from node files, remotely from /v1/status?titles=1,
  // revalidated against a cached ETag so a synced graph collapses the 5-15MB
  // titles download to a bodyless 304
  // (task-spor-distill-conditional-status-fetch, task-cc-tier-2-read-path-scaling).
  let index = "";
  if (remote) {
    index = await fetchRemoteTitleIndex(graph, rlog);
  } else {
    index = u.localTitleIndex(nodes);
  }

  const date = u.localDate();
  const tplName = remote ? "distill-remote.md" : "distill-local.md";
  const source = remote ? "distill-remote" : "distill-local";
  const tplFile = path.join(u.ROOT, "prompts", "client", tplName);
  if (!fs.existsSync(tplFile)) {
    log(`missing prompt template ${tplFile}`);
    return null;
  }
  const tplSha = u.sha256Head(tplFile);
  if (!touched) touched = "none";
  // PROMPT=$(cat "$TPL_FILE") — strips the template's trailing newline.
  const prompt = u.fillTemplate(u.stripTrailingNewlines(fs.readFileSync(tplFile, "utf8")), {
    SLUG: slug,
    DATE: date,
    INDEX: index,
    TOUCHED: touched,
    CONVO: convo,
  });

  // Record the full prompt/response to journal/llm-calls (template-versioned,
  // eval-replayable). Best-effort: recording failures never block.
  const llmDir = path.join(graph, "journal", "llm-calls");
  const t0 = Date.now();
  let backend = "";
  // Token usage / cost when the backend reports it (the default claude -p JSON
  // path does; SPOR_DISTILL_CMD backends cannot over the stdin->stdout text
  // contract, so they stay null) — task-cc-spor-client-spend-visibility.
  let usage = null;
  let cost_usd = null;
  let model = null;
  const recordLlm = (response, error) => {
    if (!u.ensureDir(llmDir)) return;
    const rec = {
      id: `llm-${Date.now()}-${u.bashRandom()}`,
      ts: u.isoMs(),
      source,
      backend,
      template: tplName,
      template_sha: tplSha,
      session,
      project: slug,
      latency_ms: Date.now() - t0,
      usage,
      cost_usd,
      model,
      prompt,
      vars: { SLUG: slug, DATE: date, INDEX: index, TOUCHED: touched, CONVO: convo },
      response: error === "" ? response : null,
      error: error === "" ? null : error,
    };
    u.appendLine(path.join(llmDir, `${u.localDate()}.jsonl`), JSON.stringify(rec));
  };

  let response;
  // Bound a hung distill backend (distill.timeoutMs / SPOR_DISTILL_TIMEOUT,
  // default 120s — generous: the distill processes a ~24k-char transcript and
  // runs async on SessionEnd, so it tolerates more than the nudge, but a wedged
  // CLI should still not hang the SessionEnd hook indefinitely).
  const timeoutMs = u.cfgNum("distill.timeoutMs", "DISTILL_TIMEOUT", 120000);
  const distillCmd = u.cfgStr("distill.cmd", "DISTILL_CMD") || u.hostDefaultBackendCmd("distill");
  if (distillCmd) {
    backend = `cmd:${distillCmd}`;
    response = u.runBackendCmd(distillCmd, prompt, { timeoutMs });
    if (response === null) {
      recordLlm("", "distill cmd failed");
      log("distill cmd failed");
      return null;
    }
  } else {
    backend = "cli:claude -p --model haiku";
    const res = u.runClaudeBackend(prompt, { timeoutMs });
    if (res === null) {
      recordLlm("", "claude -p failed");
      log("claude -p failed");
      return null;
    }
    response = res.text;
    usage = res.usage;
    cost_usd = res.cost_usd;
    model = res.model;
  }
  recordLlm(response, "");

  // Report the sweep to the server (remote mode), zero-fact sweeps included.
  // Counts only; the transcript stays client-side. Best-effort.
  const reportSweep = async (f, c, sp, r) => {
    if (!remote) return;
    await u.curl(`${u.serverBase()}/v1/distill/report`, {
      method: "POST",
      headers: { ...u.bearer(), "Content-Type": "application/json" },
      body: JSON.stringify({ project: slug, session, facts: f, captured: c, spooled: sp, rejected: r }),
      timeoutMs: 6000,
    }).catch(() => {});
  };

  if (response.includes("NOTHING")) {
    await reportSweep(0, 0, 0, 0);
    log("distilled: nothing durable");
    return null;
  }

  // ---------------------------------------------------------------------------
  // REMOTE MODE: each found fact -> POST /v1/capture; transport failures spool
  // to outbox/*.capture.json; permanent rejects are dropped with a log line.
  // ---------------------------------------------------------------------------
  if (remote) {
    const facts = parseFactBlocks(response);
    if (facts.length < 1) {
      await reportSweep(0, 0, 0, 0);
      log("distilled: no parseable facts");
      return null;
    }
    let sent = 0;
    let spooled = 0;
    let rejected = 0;
    let factNo = 0;
    for (const fact of facts) {
      factNo++;
      // /v1/capture caps text at 4000 chars; truncate defensively. The per-fact
      // idempotency key is a deterministic hash(session, fact) — the key the
      // server contract prescribes for live distill POSTs (spor-server
      // capture.js / rest.js POST /v1/capture). It closes the
      // timeout-then-server-completes race the `spor add` path guards
      // (issue-spor-add-cli-duplicate-on-timeout-drain): a fact that spools
      // (below) on an aborted-but-landed POST re-ships the SAME key on drain, so
      // the server dedupes instead of ingesting a second node. Hashing on
      // (session, text) rather than a random UUID ALSO coalesces a re-distill of
      // the SAME session across separate runs
      // (task-spor-distiller-idempotency-deterministic-hash) — defense-in-depth
      // behind the SPOR_DISTILLING recursion guard, the only thing preventing
      // that re-run today.
      const text = u.byteHead(fact, 3900);
      const body = JSON.stringify({
        text,
        // Always the ambient cwd slug, never user-declared, so the server's
        // fold-mismatch warning stays silent on ordinary cross-repo distill
        // captures (task-spor-thread-explicit-project-flag).
        context: { project: slug, project_explicit: false },
        source: "distill",
        idempotency_key: crypto.createHash("sha256").update(`${session}\n${text}`).digest("hex"),
      });
      const { http } = await u.curl(`${u.serverBase()}/v1/capture`, {
        method: "POST",
        headers: { ...u.bearer(), "Content-Type": "application/json" },
        body,
        timeoutMs: 90000,
      });
      if (http === "200") {
        sent++;
      } else if (http === "400" || http === "413" || http === "422") {
        rejected++;
        rlog(`capture rejected (http=${http}) for fact-${factNo}.txt`);
      } else {
        u.ensureDir(path.join(graph, "outbox"));
        const spool = path.join(
          graph,
          "outbox",
          `${session}-${Math.floor(Date.now() / 1000)}-${spooled}.capture.json`
        );
        try {
          fs.writeFileSync(spool, body);
        } catch {}
        spooled++;
      }
    }
    await reportSweep(facts.length, sent, spooled, rejected);
    log(`remote distill complete (${facts.length} facts: ${sent} captured, ${spooled} spooled, ${rejected} rejected)`);
    rlog(`captured ${sent}/${facts.length} facts (${spooled} spooled, ${rejected} rejected)`);

    // Infer commit→node links for this session's UNTRAILERED commits
    // (task-cc-commit-inference). Fail-open; never affects the distill above.
    await inferCommits({
      repo: cwd,
      journal: path.join(graph, "journal", `${session}.jsonl`),
      index,
      slug,
      session,
    }).catch(() => {});
    return null;
  }

  // ---------------------------------------------------------------------------
  // LOCAL MODE (original behavior — byte-identical node writes)
  // ---------------------------------------------------------------------------
  const written = [];
  for (const block of parseNodeBlocks(response)) {
    const file = path.join(nodes, block.file);
    if (fs.existsSync(file)) {
      u.appendLine(logFile, `  skip-existing ${file}`);
      continue;
    }
    try {
      fs.writeFileSync(file, normalizeEdges(block.content));
      u.appendLine(logFile, `  wrote ${file}`);
      written.push(file);
    } catch {}
  }
  const candidates = String(response)
    .split("\n")
    .filter((l) => l.startsWith("===NODE")).length;
  log(`distill complete (${candidates} candidate nodes)`);

  // Lint what we just wrote; problems are logged, not fatal.
  const v = spawnSync(process.execPath, [path.join(u.ROOT, "lib", "validate.js"), "--nodes", nodes], {
    encoding: "utf8",
  });
  try {
    fs.appendFileSync(logFile, (v.stdout || "") + (v.stderr || ""));
  } catch {}
  if (v.status !== 0 || v.error) log(`validation found errors — review ${nodes}`);

  // Commit the graph if it's a git repo — UNLESS the graph home lives inside the
  // session's own code repo (the nested-repo hazard, graphInsideCodeRepo). In a
  // per-repo `graph:` sharing setup pointed at the code repo, auto-committing
  // would land distiller commits on the code branch; instead leave the nodes as
  // working-tree changes for the contributor's PR (dec-spor-local-mode-sharing-
  // boundary: distilled nodes ride the normal PR flow).
  if (fs.existsSync(path.join(graph, ".git")) && written.length > 0) {
    if (graphInsideCodeRepo(graph, cwd)) {
      log(
        `graph home is inside the session repo — leaving ${written.length} distilled node(s) uncommitted for the PR flow (dec-spor-local-mode-sharing-boundary)`
      );
    } else {
      const add = u.git(graph, ["add", "nodes/"]);
      const commit =
        add !== null ? u.git(graph, [...u.NO_GPGSIGN, "commit", "-qm", `distill: session ${session} (${slug})`]) : null;
      if (add === null || commit === null) log("graph commit failed");
    }
  }
  return null;
}

module.exports = {
  distill,
  normalizeEdges,
  parseNodeBlocks,
  parseFactBlocks,
  graphInsideCodeRepo,
  sessionEndLease,
  sessionEndPendingNudges,
};

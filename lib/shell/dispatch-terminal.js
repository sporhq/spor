"use strict";

// The dispatch TERMINAL-STATE contract
// (task-spor-dispatch-terminal-states-contract).
//
// A run record's `state` says how the PROCESS ended — the supervisor observed
// an exit, or a reconcile derived one from the harness's own evidence. That is
// not an OUTCOME: an agent can exit 0 having done nothing, and one that crashed
// after writing its resolver did finish the work. So every run also carries a
// `terminal_state`, exactly one of:
//
//   resolved  the graph itself shows the target genuinely done: a live
//             resolving edge (`resolves`/`answers`) for the four types whose
//             completion IS an edge (task/issue/question/incident), or — for
//             every other dispatchable type — the target's OWN status has
//             reached its type's terminal partition (a decision `settled`, a
//             finding `resolved`, a capture-pending `merged`, …). Either way,
//             VERIFIED against the graph, never inferred from exit status and
//             never taken from the agent's own claim.
//   reported  no resolution, but the agent left a final report — filed as an
//             artifact node linked to the target (`relates-to`), after which
//             the lease is released. The item goes back to the queue WITH the
//             work attached instead of vanishing into a dead run.
//   failed    no resolution and no report filed (a launch failure, a crash
//             before any report, an empty one, a graph that refused the write).
//             The lease is released — except where the write was refused, see
//             the ordering rule below — and the record carries a failure note.
//
// `report_node_id` present ⇒ `terminal_state === "reported"`, always, enforced
// or not: it is the invariant a consumer can key on without a type table.
//
// The discriminator between `reported` and `failed` is REPORT PRESENCE, not
// exit status: on an ENFORCED run, `terminal_state === "reported"` iff a report
// artifact was filed, so the state reads as a promise that `report_node_id`
// names a node. A run that crashed with a usable report is still `reported` —
// its report is signal the queue wants — and the crash itself stays fully
// described by `state`/`termination_*`, which this layer never overwrites.
// That promise is the ENFORCED half of the contract only: an unenforced run
// that merely ended cleanly also reads `reported` (nothing better is known
// about it), and its `report_node_id` may or may not be there — a target this
// runner cannot judge still gets its report filed, a native-background or
// local-mode run has none to file. So a consumer reaching for the artifact id
// must gate on the key's presence, and one reading the STATE as a verdict must
// gate on `terminal_enforced` first.
//
// ORDERING IS THE CONTRACT (acceptance criterion): file the report FIRST, then
// release. A crash between the two must leave the lease held and the report
// filed, never a released lease with no report. So the release is only ever
// issued after a confirmed artifact write, and a failed artifact write
// deliberately leaves the lease HELD (it lapses at its TTL) rather than
// returning a signal-free item to the pool.
//
// Enforcement is scoped to supervised-jsonl launches with a reachable graph
// (dec-spor-dispatch-terminal-states-supervised-first). Everything else —
// native-background runs, local mode, a free-text dispatch with no target
// node, a server we could not reach — is classified BEST-EFFORT and stamped
// `terminal_enforced: false`, and can never read `resolved`. Unenforced is
// stated on the record, never silently treated as covered.

const graphLib = require("../graph.js");

const REQUEST_TIMEOUT_MS = 5000;
// The server caps a node's summary at 500 chars and its body at 8192 bytes;
// stay under both so a long agent report is truncated here rather than
// rejected wholesale (a rejected write is a LOST report).
const SUMMARY_CAP = 460;
const BODY_CAP_BYTES = 7000;
const STEM_CAP = 40;

const TERMINAL_OUTCOMES = Object.freeze(["resolved", "reported", "failed"]);

// Node types differ in how completion is ATTESTED. Four seed types — task,
// issue, question, incident — attach a `get()` hook that enriches `GET
// /v1/nodes/{id}` with `resolution`: a live inbound resolving edge (API.md
// §3), verified against the graph rather than trusted from the agent's word.
// Every other dispatchable type — decision, finding, capture-pending, … — is
// retired by STATUS alone; its response carries no `resolution` no matter how
// completely the agent finished the work, so judging it against an edge would
// read every genuine success as unresolved. `graphLib.attachesResolutionHookOffline`
// (a registry read — norm-cc-registry-is-contract, task-spor-dispatch-terminal-
// resolution-all-types) tells the two apart without a hardcoded type list: it
// mirrors whichever seed (or graph-resident-if-a-graph-were-loaded) schema
// declares the `get` hook, so an org that adds one to another type's resident
// override is honored with no code change here. For the status-only types,
// `graphLib.isCompletionStatusOffline` reads the registry's OWN-lifecycle
// `status.terminal` partition (decision `settled`, finding `resolved`,
// capture-pending `merged`, …) UNIONED with the type-blind universal
// completion words — never a hand-hardcoded per-type status table either.

// What a run's outcome reads as when nobody verified it: the process ending is
// all the evidence there is. Never `resolved` — that word means "checked", and
// nothing here checked anything.
function derivedTerminalOutcome(state) {
  return state === "done" ? "reported" : "failed";
}

// The unenforced patch for a run the contract did not (or could not) run on.
function unenforcedOutcome(state, reason) {
  return {
    terminal_state: derivedTerminalOutcome(state),
    terminal_enforced: false,
    terminal_note: reason,
  };
}

function oneLine(text, cap) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > cap ? `${s.slice(0, cap - 1)}…` : s;
}

// Truncate by BYTES, not chars — the server's body cap is a byte cap, and a
// report full of multi-byte content would otherwise sail past it.
function capBytes(text, bytes) {
  const buf = Buffer.from(String(text || ""), "utf8");
  if (buf.length <= bytes) return String(text || "");
  // Slicing mid-codepoint yields U+FFFD; trim back to the last clean boundary.
  let cut = buf.subarray(0, bytes).toString("utf8");
  if (cut.endsWith("�")) cut = cut.slice(0, -1);
  return `${cut}\n\n[report truncated — see the run log for the full text]`;
}

// A readable, deterministic id: the same run filing the same report twice is
// one node (`if_exists: skip`), not two.
function reportArtifactId(nodeId, runId) {
  const stem = String(nodeId || "run")
    .replace(/^[a-z]+-/, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, STEM_CAP)
    .replace(/-+$/, "");
  const short = String(runId || "").replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase() || "unknown";
  return `art-dispatch-report-${stem || "run"}-${short}`;
}

// The report artifact's node markdown. Deliberately NOT a resolver: it carries
// `relates-to`, so filing it never retires the target — the whole point is that
// the item comes BACK to the queue carrying this.
//
// `verified: false` is the out-of-scope target (a type retired by status, not by
// an edge): the report still gets filed — the agent's work must reach the graph
// either way — but it must not ASSERT "ended without resolving it", because on
// such a target no resolving edge could ever have existed and the claim would be
// permanently wrong. It says what is actually true instead: nobody checked.
// (No caller in this file passes `verified: false` any more — every
// dispatchable type is now judged one way or the other — but the parameter is
// exercised directly by test/dispatch-terminal.test.js, so its behavior stays.)
// `notDoneReason`, by contrast, IS live: it lets the `verified` (true) branch
// state the actual reason a status-only type wasn't done (its status, not a
// missing edge it could never have had) instead of a one-size-fits-all line.
function buildReportArtifact({ nodeId, runId, harness, project, reportText, state, date, verified = true, type = null, notDoneReason = null }) {
  const id = reportArtifactId(nodeId, runId);
  const body = capBytes(String(reportText || "").trim(), BODY_CAP_BYTES);
  const first = oneLine(body.split(/\n{2,}/)[0] || body, SUMMARY_CAP - 110);
  const ending = verified
    ? "which ended without resolving it"
    : "whose outcome was not verified against the graph";
  const summary = oneLine(
    `Final report from the dispatched ${harness || "agent"} run on ${nodeId}, ${ending}${first ? `: ${first}` : "."}`,
    SUMMARY_CAP
  );
  const lines = [
    "---",
    `id: ${id}`,
    "type: artifact",
    ...(project ? [`project: ${project}`] : []),
    `title: Dispatch report — ${oneLine(nodeId, 80)}`,
    `summary: ${summary}`,
    `date: ${date}`,
    "edges:",
    `  - {type: relates-to, to: ${nodeId}}`,
    "---",
    "",
    `Final report from dispatched run \`${runId}\` (${harness || "agent"}), which ended`,
    `\`${state}\`. It is filed here so the run's work reaches the graph instead of`,
    "vanishing into a dead run; nothing here resolves the target.",
    "",
    ...(verified
      // `notDoneReason` (task-spor-dispatch-terminal-resolution-all-types) is
      // the same edge-vs-status reason string the caller already computed for
      // the `failed` note, so a status-only type's report never asserts the
      // "no resolving edge" line it could never have had in the first place.
      ? [`The run ended with ${notDoneReason || `no resolving edge on ${nodeId}`}, so the item`,
         "returns to the queue carrying this report."]
      : [`Whether ${nodeId} is complete was NOT verified: a \`${type || "node"}\` of this type is`,
         "retired by its status rather than by a resolving edge, which is the only",
         "signal this runner checks."]),
    "",
    body,
    "",
  ];
  return { id, markdown: `${lines.join("\n")}` };
}

async function httpJson({ method, url, token, body, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined || body === null ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined || body === null ? {} : { body: JSON.stringify(body) }),
      signal: ctrl.signal,
    });
    let json = null;
    try { json = await res.json(); } catch { /* an empty or non-JSON body is not an error here */ }
    return { ok: res.ok, status: res.status, json };
  } catch (e) {
    return { ok: false, status: 0, json: null, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

// `POST /v1/nodes` is a BATCH door: a 207 with a per-entry failure is not an
// error at the HTTP layer, so the entry verdict is what says whether the node
// landed. `skip` (the id already exists) counts as landed — a retried filing
// of the same deterministic id is the same report.
function nodeWriteLanded(res) {
  if (!res) return false;
  const entry = res.json && Array.isArray(res.json.results) ? res.json.results[0] : null;
  if (entry) return entry.ok === true || entry.status === "skipped" || entry.status === "created";
  return !!res.ok;
}

// Run the terminal-state contract for one finished supervised run and return
// the patch to merge into its record. Every network call goes through
// `request` so a test can pin each leg's verdict — including a crash BETWEEN
// the report write and the release, the one ordering this contract exists to
// guarantee.
async function applyTerminalContract({
  base,
  token,
  nodeId,
  releaseNode = null,
  project = null,
  runId,
  harness = null,
  state,
  reportText = "",
  request = null,
  now = () => new Date().toISOString(),
}) {
  const at = now();
  const date = at.slice(0, 10);
  const server = String(base || "").replace(/\/+$/, "");
  if (!server || !token) {
    return unenforcedOutcome(state, "no team graph to verify against — the terminal-state contract is enforced only against a Spor server (local-mode dispatch is unenforced)");
  }
  if (!nodeId) {
    return unenforcedOutcome(state, "the run had no target node (a free-text dispatch), so there is nothing to verify, report against, or release");
  }
  const send = request || (({ method, path, body, timeoutMs }) => httpJson({ method, url: `${server}${path}`, token, body, timeoutMs }));
  // Every leg fails CLOSED into a verdict object rather than throwing: an
  // exception escaping this function would unwind past the state already
  // earned — most damagingly turning a filed-and-released run into a bare
  // unenforced `reported` with no artifact id on it, breaking the invariant
  // that `reported` always names a report node.
  const call = async (req) => {
    try {
      return await send(req);
    } catch (e) {
      return { ok: false, status: 0, json: null, error: e.message };
    }
  };

  // 1. VERIFY. `GET /v1/nodes/{id}` attaches `resolution` for the work types
  // (API.md §3): a live, visible inbound resolves/answers edge with the
  // resolver's id. Its ABSENCE is the answer for an agent that claimed success
  // without writing one — never `resolved`. A graph whose schema attaches no
  // such enrichment reads the same way, which is the fail-safe direction.
  const got = await call({ method: "GET", path: `/v1/nodes/${encodeURIComponent(nodeId)}` });
  if (!got || !got.ok) {
    const why = (got && (got.error || `HTTP ${got.status}`)) || "no response";
    return unenforcedOutcome(state, `could not re-read ${nodeId} to verify its resolution (${why}) — the outcome below is unverified`);
  }
  const node = got.json || {};
  const resolution = node.resolution;
  const type = String(node.type || "").toLowerCase();
  // Which of the two attestation paths applies to this type — a resolving
  // edge, or the node's own status — read off the registry rather than a
  // hardcoded type list (see the header comment above). An UNKNOWN type (a
  // server that does not echo one) is treated as edge-verified: absent
  // evidence of a mismatch, the edge check is the right reading, and a
  // graph-resident schema override that attaches the hook to another type
  // would only ever mis-scope in this same safe direction.
  const edgeVerified = !type || graphLib.attachesResolutionHookOffline(type);
  if (resolution && resolution.by) {
    return {
      terminal_state: "resolved",
      terminal_enforced: true,
      resolved_by: resolution.by,
      resolved_edge: resolution.edge || "resolves",
      // The lease is deliberately NOT released: the durable `assigned` edge is
      // the record of who did the work, and a resolved node is already out of
      // every queue by its resolving edge.
      terminal_note: `verified on the graph: ${resolution.edge || "resolves"} edge from ${resolution.by}`,
    };
  }
  if (!edgeVerified && graphLib.isCompletionStatusOffline(node.status, type)) {
    // This type's completion is a STATUS, not an edge, and that status has
    // already reached the type's own terminal partition — verified done, the
    // same way an edge-verified type is. No release either, and for the same
    // reason: a terminal status already takes the node out of every queue, so
    // the durable `assigned` edge is left as the record of who did the work.
    return {
      terminal_state: "resolved",
      terminal_enforced: true,
      terminal_note: `verified on the graph: status '${String(node.status || "").toLowerCase()}' is terminal for '${type}' nodes (this type's completion is a status, not a resolving edge)`,
    };
  }

  // Neither attestation path found completion — say which one this type uses,
  // so the note reads correctly for a status-only type too (it never had a
  // resolving edge to be missing).
  const notDoneReason = edgeVerified
    ? `no resolving edge on ${nodeId}`
    : `${nodeId}'s status ('${String(node.status || "").toLowerCase()}') has not reached a terminal '${type}' status`;

  const releaseLease = async (note) => {
    // No lease of OURS to hand back (`--no-claim`, or a `--force` re-dispatch
    // that renewed someone else's live lease). The key is OMITTED rather than
    // set false: `lease_released: false` means "we tried and could not", which
    // is what `spor runs` turns into a "release it yourself" hint — saying that
    // about a lease we never held would send the operator to yank an agent's
    // live claim out from under it.
    if (!releaseNode) return { ...note };
    // A release that fails must never cost the caller the outcome it already
    // earned: the report is filed, and that fact is what the record has to
    // keep. The lease simply lapses at its TTL, and the note says how to hand
    // it back sooner.
    const r = await call({ method: "POST", path: `/v1/nodes/${encodeURIComponent(releaseNode)}/release`, body: {} });
    if (r && r.ok) return { ...note, lease_released: true };
    const why = (r && (r.error || `HTTP ${r.status}`)) || "no response";
    return {
      ...note,
      lease_released: false,
      terminal_note: `${note.terminal_note} (the lease could not be released — ${why}; run 'spor release ${releaseNode}')`,
    };
  };

  const report = String(reportText || "").trim();

  // 2. FILE the report. Every remaining case here — an edge-verified type
  // with no live edge, or a status-only type whose status has not yet reached
  // its terminal partition — is a genuinely VERIFIED "not done", so the
  // report always files as a confident claim, never a hedge.
  const fileReport = async () => {
    const artifact = buildReportArtifact({ nodeId, runId, harness, project, reportText: report, state, date, type, notDoneReason });
    const wrote = await call({
      method: "POST",
      path: "/v1/nodes",
      body: { nodes: [{ node: artifact.markdown, if_exists: "skip" }] },
      timeoutMs: 15000,
    });
    return { id: artifact.id, ok: nodeWriteLanded(wrote), why: (wrote && (wrote.error || `HTTP ${wrote.status}`)) || "no response" };
  };

  if (!report) {
    return releaseLease({
      terminal_state: "failed",
      terminal_enforced: true,
      terminal_note: `the run ended '${state}' with ${notDoneReason} and no usable final report`,
    });
  }

  // ...then 3. RELEASE — in that order, always. A crash after the write leaves
  // the report filed and the lease held (it lapses at its TTL); a crash before
  // it leaves both undone. Neither leaves a released lease with no report, which
  // is the state this ordering exists to make impossible.
  const filed = await fileReport();
  if (!filed.ok) {
    const why = filed.why;
    return {
      terminal_state: "failed",
      terminal_enforced: true,
      // Deliberately not released — the same "held" reading `spor runs` turns
      // into a release hint. Omitted when the lease was never ours to hold.
      ...(releaseNode ? { lease_released: false } : {}),
      terminal_note: `the final report could not be filed as ${filed.id} (${why}) — the lease was left HELD rather than returning ${nodeId} to the queue with no signal; the report is still on disk in this run's report file`,
    };
  }
  return releaseLease({
    terminal_state: "reported",
    terminal_enforced: true,
    report_node_id: filed.id,
    terminal_note: `the run ended '${state}' without resolving ${nodeId}; its final report was filed as ${filed.id}`,
  });
}

module.exports = {
  TERMINAL_OUTCOMES,
  derivedTerminalOutcome,
  unenforcedOutcome,
  reportArtifactId,
  buildReportArtifact,
  applyTerminalContract,
  nodeWriteLanded,
  capBytes,
};

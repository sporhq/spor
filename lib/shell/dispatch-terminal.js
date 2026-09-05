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
//   declined  no resolution, and the agent's final report DECLARES the item
//             itself wrong — a stale premise, work that belongs in another
//             repo, something already done — in the fixed form the worker
//             contract prescribes (`DECLINED: <reason>` as the first line,
//             worker-contract.js). Two of the first live factory's eight human
//             escalations were exactly this: an implementer that correctly
//             refused with a clean tree, which the pipeline then ran into the
//             review gate's fail-closed empty-diff rule and paged a person about
//             (task-spor-worker-declined-outcome). A decline is not a claim of
//             completion, so there is nothing for a gate to test; it is routed
//             to TRIAGE instead: the reason is filed as a `finding` linked to
//             the item, the item's `readiness: agent` stamp is cleared (it was
//             wrong — the item is not agent-ready as written), and the lease is
//             released. The item then re-briefs with the decline attached the
//             next time anyone looks at it, instead of a person being paged.
//
// `report_node_id` present ⇒ `terminal_state === "reported"`, always, enforced
// or not: it is the invariant a consumer can key on without a type table. The
// declined twin is `finding_node_id` ⇒ `terminal_state === "declined"`.
//
// `declined` is read off the REPORT's fixed form, never inferred from prose —
// and the graph still wins over the words: a run whose target reads resolved
// on the graph is `resolved` (and gated, and its empty diff fails closed there)
// whatever its final message says. Only a run that did NOT resolve its target
// can read declined.
//
// The discriminator between `reported` and `failed` is REPORT PRESENCE, not
// exit status: on an ENFORCED run, `terminal_state === "reported"` iff a report
// artifact was filed, so the state reads as a promise that `report_node_id`
// names a node. A run that crashed with a usable report is still `reported` —
// its report is signal the queue wants — and the crash itself stays fully
// described by `state`/`termination_*`, which this layer never overwrites.
// That promise is the ENFORCED half of the contract only: an unenforced run
// that merely ended cleanly also reads `reported` (nothing better is known
// about it) and carries NO `report_node_id` — filing sits downstream of the
// verify leg, so a run that never got a graph answer (native-background,
// local-mode, an unreachable server) has nothing filed to name. So a consumer
// reaching for the artifact id must gate on the key's presence, and one
// reading the STATE as a verdict must gate on `terminal_enforced` first.
//
// And `terminal_enforced` reports the VERIFY leg alone — a graph answered the
// re-read — never whether the filing that followed landed. Every arm below a
// successful re-read is enforced, the ones that file nothing included: a
// verified not-done with no report to file, a report the graph refused, a
// decline whose finding it refused. Those say what they lack on their own
// fields (no `report_node_id`/`finding_node_id`, `lease_released: false` for
// the lease left held), because demoting a checked verdict to best-effort
// would make it unreadable as the checked thing it is (WORKERS.md §6, "What
// 'enforced' means").
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
// native-background runs, a free-text dispatch with no target node, a server
// we could not reach — is classified BEST-EFFORT and stamped
// `terminal_enforced: false`, and can never read `resolved`. Unenforced is
// stated on the record, never silently treated as covered.
//
// LOCAL mode has no server to ask, but it does have a graph: the run's own
// `$SPOR_HOME/nodes/` (or a repo's shared `graph:` home), the exact files a
// local agent would have written its resolver into
// (task-spor-work-local-mode-resolver-check). So a local run gets the SAME
// `resolved` reading a remote one does — read straight off the local files
// instead of `GET /v1/nodes/{id}` — before falling back to unenforced. Only
// the resolved arm is checked locally; a local run that did NOT resolve its
// target still reads the prior unenforced `reported`/`failed` (derived from
// exit state alone) — there is no local report-filing or lease-release
// equivalent to run the rest of the contract against, and local dispatch
// never holds a lease to release in the first place.

const graphLib = require("../graph.js");
const kernelResolution = require("../kernel/resolution.js");

const REQUEST_TIMEOUT_MS = 5000;
// The server caps a node's summary at 500 chars and its body at 8192 bytes;
// stay under both so a long agent report is truncated here rather than
// rejected wholesale (a rejected write is a LOST report).
const SUMMARY_CAP = 460;
const BODY_CAP_BYTES = 7000;
const STEM_CAP = 40;

const TERMINAL_OUTCOMES = Object.freeze(["resolved", "reported", "failed", "declined"]);

// The fixed decline form (worker-contract.js): the FIRST non-blank line of the
// final report is `DECLINED: <one-line reason>`. Deliberately narrow — a
// harness may wrap the line in a heading or bold, which is tolerated, but a
// "declined" appearing anywhere later in a report is prose, not a declaration,
// and prose is exactly what this layer never reads outcomes from. Returns
// `{ reason }` or null.
const DECLINE_RE = /^\s*(?:#{1,6}\s*)?(?:\*\*|__|`)?\s*DECLINED\s*(?:\*\*|__|`)?\s*[:\u2014\u2013-]\s*(.+?)\s*$/;
function parseDecline(reportText) {
  const first = String(reportText || "").split(/\r?\n/).find((l) => l.trim());
  if (!first) return null;
  const m = DECLINE_RE.exec(first);
  if (!m) return null;
  const reason = m[1].replace(/(?:\*\*|__|`)+\s*$/, "").trim();
  return reason ? { reason } : null;
}

// Node types differ in how completion is ATTESTED. Four seed types — task,
// issue, question, incident — attach a `get()` hook that enriches `GET
// /v1/nodes/{id}` with `resolution`: a live inbound resolving edge (API.md
// §3), verified against the graph rather than trusted from the agent's word.
// Every other dispatchable type — decision, finding, capture-pending, … — is
// retired by STATUS alone; its response carries no `resolution` no matter how
// completely the agent finished the work, so judging it against an edge would
// read every genuine success as unresolved. Both legs below tell the two apart
// by a registry read rather than a hardcoded type list (norm-cc-registry-is-
// contract, task-spor-dispatch-terminal-resolution-all-types) — but NOT the same
// registry, and that difference is a contract, not an implementation detail
// (WORKERS.md §6, "Which registry answers that question"): the local leg asks
// the graph it just loaded (`registry.attachesResolutionHook`), so a resident
// schema override that adds or drops a `get` hook is honored there with no code
// change; the remote leg has no graph and asks the shipped SEED pack
// (`graphLib.attachesResolutionHookOffline`), which cannot see that override in
// EITHER direction — an added hook leaves a terminal own-status reading
// `resolved` with no edge behind it, and a dropped one leaves a genuinely
// status-retired node reading as not attested (issue-spor-remote-dispatch-
// ignores-resident-resolution-hooks). For the status-only types,
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

// The local-mode counterpart of the VERIFY leg below (step 1 of
// applyTerminalContract): same two attestation paths — a live resolving edge
// for an edge-verified type, the node's own terminal status for a
// status-only type — read off a freshly loaded LOCAL graph instead of a
// server response. Returns the same `resolved` patch shape `GET
// /v1/nodes/{id}` produces, or `null` when the target does not (yet) read
// resolved locally — including when the graph home can't be loaded at all
// (missing/unreadable `nodesDir`, e.g. a free-text dispatch with no repo
// marker) — so the caller falls through to the existing unenforced reading
// exactly as before this existed.
function verifyLocalResolution(nodesDir, nodeId) {
  if (!nodesDir || !nodeId) return null;
  let graph;
  try {
    graph = graphLib.loadGraph(nodesDir);
  } catch {
    return null;
  }
  const node = graph.nodes[nodeId];
  if (!node) return null;
  const type = String(node.type || "").toLowerCase();
  const edgeVerified = !type || graph.registry.attachesResolutionHook(type);
  if (edgeVerified) {
    const resolution = kernelResolution.resolutionOf(graph, nodeId);
    if (!resolution || !resolution.by) return null;
    return {
      terminal_state: "resolved",
      terminal_enforced: true,
      resolved_by: resolution.by,
      resolved_edge: resolution.edge || "resolves",
      terminal_note: `verified on the local graph: ${resolution.edge || "resolves"} edge from ${resolution.by}`,
    };
  }
  const status = String(node.status || "").toLowerCase();
  // Mirror `graphLib.isCompletionStatusOffline`: the registry's per-type
  // `status.terminal` partition UNIONED with the type-blind universal
  // completion words (kernelResolution.terminalStatuses) — a capture-pending
  // `merged` has no per-type declaration of its own (deliberately, see
  // schema-capture-pending) and reads terminal only via that union.
  const completionTerminal = kernelResolution.terminalStatuses.includes(status) || graph.registry.terminalStatuses(type).has(status);
  if (!completionTerminal) return null;
  return {
    terminal_state: "resolved",
    terminal_enforced: true,
    terminal_note: `verified on the local graph: status '${status}' is terminal for '${type}' nodes (this type's completion is a status, not a resolving edge)`,
  };
}

// Does a node the server just handed back read RESOLVED? The VERIFY leg of the
// contract below (step 1), lifted out whole so the two callers that ask that
// exact question cannot drift apart: `applyTerminalContract` asking it once,
// on the way out of a supervised run, and the WORK LOOP asking it again when
// it harvests a record whose supervisor never got to (bin/spor.js
// verifyRunResolution, task-spor-work-idle-run-detection). Pure: it takes the
// node JSON `GET /v1/nodes/{id}` returns and answers with the same `resolved`
// patch shape `verifyLocalResolution` produces off a local graph, or null when
// the target is not (yet) done — the fail-safe direction, since "we could not
// see a resolution" must never read as one.
function resolvedOutcomeFromNode(node) {
  const n = node || {};
  const resolution = n.resolution;
  const type = String(n.type || "").toLowerCase();
  // Which of the two attestation paths applies to this type — a resolving
  // edge, or the node's own status — read off the registry rather than a
  // hardcoded type list — here the SEED pack's, since this leg holds one node's
  // JSON and no graph to ask (see the header comment above for what that misses,
  // in both directions). An UNKNOWN type (a server that does not echo one) is
  // treated as edge-verified: absent evidence of a mismatch, demanding the edge
  // is the fail-safe reading.
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
  if (!edgeVerified && graphLib.isCompletionStatusOffline(n.status, type)) {
    // This type's completion is a STATUS, not an edge, and that status has
    // already reached the type's own terminal partition — verified done, the
    // same way an edge-verified type is. No release either, and for the same
    // reason: a terminal status already takes the node out of every queue, so
    // the durable `assigned` edge is left as the record of who did the work.
    return {
      terminal_state: "resolved",
      terminal_enforced: true,
      terminal_note: `verified on the graph: status '${String(n.status || "").toLowerCase()}' is terminal for '${type}' nodes (this type's completion is a status, not a resolving edge)`,
    };
  }
  return null;
}

// The unenforced patch for a run the contract did not (or could not) run on.
// A report in the fixed decline form still reads `declined` here — unenforced,
// since nothing was filed or cleared on the graph, but a decline is the agent's
// own declaration of NOT done, and misreading it as an unenforced `reported`
// would send it to the gates (work-loop.js shouldGate) — the exact misfiling
// this outcome exists to stop. Callers that have no report (the runner's
// provisional patch, a reconcile backfill) simply omit it.
function unenforcedOutcome(state, reason, reportText = "") {
  const decline = parseDecline(reportText);
  if (decline) {
    return {
      terminal_state: "declined",
      terminal_enforced: false,
      declined_reason: decline.reason,
      terminal_note: `the run declined the item (${decline.reason}); ${reason}`,
    };
  }
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

// The triage finding a DECLINED run files (task-spor-worker-declined-outcome):
// a `finding` — the queueable, human-facing observation type the gardener
// uses — rather than a report artifact, because the item needs a person's (or
// the next briefing's) attention on its PREMISE, not a record of work done.
// `relates-to` the item, never `resolves` or `blocks`: a decline retires
// nothing and gates nothing; it re-briefs. Deterministic id per run, so a
// retried filing is one node.
function declineFindingId(nodeId, runId) {
  return reportArtifactId(nodeId, runId).replace(/^art-dispatch-report-/, "find-declined-");
}

function buildDeclineFinding({ nodeId, runId, harness, project, reason, reportText, state, date }) {
  const id = declineFindingId(nodeId, runId);
  const body = capBytes(String(reportText || "").trim(), BODY_CAP_BYTES);
  const summary = oneLine(`The dispatched ${harness || "agent"} run on ${nodeId} declined the item: ${reason}`, SUMMARY_CAP);
  const lines = [
    "---",
    `id: ${id}`,
    "type: finding",
    ...(project ? [`project: ${project}`] : []),
    `title: Declined — ${oneLine(nodeId, 80)}`,
    `summary: ${summary}`,
    `date: ${date}`,
    "status: open",
    "edges:",
    `  - {type: relates-to, to: ${nodeId}}`,
    "---",
    "",
    `Dispatched run \`${runId}\` (${harness || "agent"}) DECLINED ${nodeId} rather than working it,`,
    `and ended \`${state}\` with no resolver written. Its stated reason:`,
    "",
    `> ${oneLine(reason, 400)}`,
    "",
    "This finding is filed FIRST; the runner then clears the item's `readiness: agent` stamp and hands",
    "its lease back (the run record's `readiness_cleared`/`lease_released` report whether each of those",
    "landed — this node cannot, since it is written before them). The item returns to triage carrying this",
    "finding instead of a gate escalation: re-brief it (or retire it) before it is dispatched again.",
    "Nothing here resolves the target.",
    "",
    "The run's final report, verbatim:",
    "",
    body,
    "",
  ];
  return { id, markdown: lines.join("\n") };
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
  nodesDir = null,
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
    const local = verifyLocalResolution(nodesDir, nodeId);
    if (local) return local;
    // A local decline reads `declined` (unenforced): the local posture files
    // no report and clears no readiness either, and the reading matters on its
    // own — it is what keeps a local factory from gating a decline.
    return unenforcedOutcome(state, "no team graph to verify against — the terminal-state contract is enforced only against a Spor server (local-mode dispatch is unenforced)", reportText);
  }
  if (!nodeId) {
    return unenforcedOutcome(state, "the run had no target node (a free-text dispatch), so there is nothing to verify, report against, or release", reportText);
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
    return unenforcedOutcome(state, `could not re-read ${nodeId} to verify its resolution (${why}) — the outcome below is unverified`, reportText);
  }
  const node = got.json || {};
  const type = String(node.type || "").toLowerCase();
  // Which of the two attestation paths applies to this type — a resolving
  // edge, or the node's own status — read off the registry rather than a
  // hardcoded type list (see the header comment above). Needed here only for
  // `notDoneReason` below; the verdict itself is `resolvedOutcomeFromNode`'s,
  // which applies the same rule.
  const edgeVerified = !type || graphLib.attachesResolutionHookOffline(type);
  const resolved = resolvedOutcomeFromNode(node);
  if (resolved) return resolved;

  // Neither attestation path found completion — say which one this type uses,
  // so the note reads correctly for a status-only type too (it never had a
  // resolving edge to be missing).
  const notDoneReason = edgeVerified
    ? `no resolving edge on ${nodeId}`
    : `${nodeId}'s status ('${String(node.status || "").toLowerCase()}') has not reached a terminal '${type}' status`;

  const releaseLease = async (note) => {
    // No lease of OURS to hand back (`--no-claim`, or a `--force` re-dispatch
    // that renewed someone else's live lease). The key is OMITTED rather than
    // set false: `lease_released: false` means "the handback was not
    // confirmed", which is what `spor runs` turns into a "release it yourself"
    // hint — saying that about a lease we never held would send the operator to
    // yank an agent's live claim out from under it.
    if (!releaseNode) return { ...note };
    // A release that fails must never cost the caller the outcome it already
    // earned: the report is filed, and that fact is what the record has to
    // keep. The lease simply lapses at its TTL, and the note says how to hand
    // it back sooner.
    const r = await call({ method: "POST", path: `/v1/nodes/${encodeURIComponent(releaseNode)}/release`, body: {} });
    if (r && r.ok) return { ...note, lease_released: true };
    // `false` is a claim about our KNOWLEDGE, not about the lease, and the NOTE
    // has to say the same thing — it is what `spor runs` prints, above the
    // field's own hint. Only a client-error answer is evidence the handback did
    // not take; a 5xx, a timeout or a dead socket sits over a release the server
    // may well have committed and only lost the answer to, so that arm reports
    // "not confirmed" rather than asserting a failure it did not observe. The
    // remedy is the same either way and reconciles instead of assuming —
    // `/release` is idempotent, and a claim someone else now holds answers 409
    // naming them (API.md §3) rather than being yanked back.
    const why = (r && (r.error || `HTTP ${r.status}`)) || "no response";
    const refused = !!(r && r.status >= 400 && r.status < 500);
    const how = refused
      ? `the server refused the handback — ${why}`
      : `the handback was not confirmed — ${why}, so the release may in fact have committed`;
    return {
      ...note,
      lease_released: false,
      terminal_note: `${note.terminal_note} (${how}; hand it back with 'spor release ${releaseNode}' — it is idempotent — or wait out the TTL)`,
    };
  };

  const report = String(reportText || "").trim();

  // 2a. A DECLINE (see the header). The graph has just said the target is not
  // resolved, so the agent's declaration that the item itself is wrong stands,
  // and the route is triage, not the gates: file the reason as a finding
  // FIRST (the same file-then-release ordering as a report — a crash between
  // the two leaves the finding filed and the lease held, never a released
  // lease with no signal), clear the item's agent-ready stamp, then release.
  // A refused finding write leaves the lease HELD for the same reason a
  // refused report does; the outcome still reads `declined` — the state is
  // the agent's own declaration, and not gating it is right either way.
  const decline = parseDecline(report);
  if (decline) {
    const finding = buildDeclineFinding({ nodeId, runId, harness, project, reason: decline.reason, reportText: report, state, date });
    const wrote = await call({
      method: "POST",
      path: "/v1/nodes",
      body: { nodes: [{ node: finding.markdown, if_exists: "skip" }] },
      timeoutMs: 15000,
    });
    if (!nodeWriteLanded(wrote)) {
      const why = (wrote && (wrote.error || `HTTP ${wrote.status}`)) || "no response";
      return {
        terminal_state: "declined",
        terminal_enforced: true,
        declined_reason: decline.reason,
        ...(releaseNode ? { lease_released: false } : {}),
        terminal_note: `the run declined ${nodeId} (${decline.reason}), but the finding could not be filed as ${finding.id} (${why}) — the lease was left HELD rather than returning the item to the queue with no signal; the report is still on disk in this run's report file`,
      };
    }
    // The readiness stamp was the claim this decline contradicts. Clearing it
    // (`clear` demotes the override back to derived, API.md §1 set_readiness)
    // is what keeps a `work.accept: ready` worker from re-dispatching the item
    // as-is; a refused clear is noted, never fatal — the finding is filed and
    // the cooldown still stands.
    const cleared = await call({ method: "POST", path: `/v1/nodes/${encodeURIComponent(nodeId)}/readiness`, body: { readiness: "clear" } });
    const readinessOk = !!(cleared && cleared.ok);
    const clearNote = readinessOk
      ? "its agent-ready stamp cleared"
      : `its agent-ready stamp could NOT be cleared (${(cleared && (cleared.error || `HTTP ${cleared.status}`)) || "no response"}; run 'spor ready ${nodeId} --needs-input')`;
    return releaseLease({
      terminal_state: "declined",
      terminal_enforced: true,
      declined_reason: decline.reason,
      finding_node_id: finding.id,
      readiness_cleared: readinessOk,
      terminal_note: `the run declined ${nodeId} (${decline.reason}); the reason was filed as ${finding.id} and ${clearNote} — the item returns to triage, not to a gate`,
    });
  }

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
  verifyLocalResolution,
  resolvedOutcomeFromNode,
  reportArtifactId,
  buildReportArtifact,
  parseDecline,
  declineFindingId,
  buildDeclineFinding,
  applyTerminalContract,
  nodeWriteLanded,
  capBytes,
};

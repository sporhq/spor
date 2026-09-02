// shell/attestation.js — ONE commit-bound, config-checksummed attestation per
// gated run (task-spor-factory-gate-attestation).
//
// The gate pipeline and the integration stage each leave per-outcome facts
// (`art-gate-*`, `art-merge-*`). What they did not leave, before this, was the
// EVIDENCE CHAIN a third party can validate: which commit was judged, by which
// definition (factory + gate digests, node revisions), whether every step
// passed, whether the head that landed is the head that was judged, and when.
// Paul Stack's pre-PR verification loop (stack72.dev/ai-broke-the-assumptions-
// behind-ci) and the swamp `verification/` reference implementation post
// exactly that shape — {subject, gate, configIntegrity, timing, environment} —
// so a repo's CI runs a VALIDATE-attestation job (commit == PR head, all steps
// green, fresh, checksums match) instead of re-running the whole suite.
//
// This module is the builder: a pure function from the pipeline's and stage's
// results to (a) the attestation object, (b) the graph artifact carrying it,
// (c) the PR body a `propose`-mode run carries it in. No I/O — bin/spor.js
// writes the node and opens the PR. Deterministic and idempotent like every
// other gate-minted node: the same run attests to ONE node id.
//
// Zero deps; plain Node.
"use strict";

const gateRunner = require("./gate-runner.js");

const SCHEMA = "spor.attestation/1";
const PR_BEGIN = "<!-- spor-attestation:begin -->";
const PR_END = "<!-- spor-attestation:end -->";
const SUMMARY_CAP = 460;
// Every fact the attestation links to rides as a relates-to edge; a run with an
// absurd number of them (re-gates × gates) is capped so the node stays readable.
const EDGE_CAP = 40;

function oneLine(text, cap) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > cap ? `${t.slice(0, cap - 1)}…` : t;
}

function stemOf(nodeId) {
  return (
    String(nodeId || "item")
      .replace(/^[a-z]+-/, "")
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase()
      .slice(0, 30)
      .replace(/-+$/, "") || "item"
  );
}

// `art-attest-<stem>-<short-run[-aN]>-<hash>` — the same tuple-hash discipline
// gateFactId keeps (gate-runner.js): readable prefix, identity in the suffix.
function attestationId(nodeId, runId, attempt = 0) {
  return `art-attest-${stemOf(nodeId)}-${gateRunner.shortRunAttempt(runId, attempt)}-${gateRunner.gateIdSuffix("attest", "attestation", nodeId, gateRunner.gateRunKey(runId, attempt))}`;
}

function iso(ms) {
  return ms == null ? null : new Date(ms).toISOString();
}

// The attestation object. `gate` is runGatePipeline's result (state, gates[],
// facts[], head/base/trusted_*/branch/definition); `integration` is
// runIntegrationStage's result, or a partial `{mode, ...}` for the PR body a
// propose-mode run writes BEFORE its own stage settles, or null when the
// factory declares no integration block.
function buildAttestationObject({ item, factory, gate, integration = null, environment = {}, now = Date.now }) {
  const nodeId = item.node_id;
  const runId = item.run_id;
  const attempt = Number(item.attempt || 0);
  const def = (gate && gate.definition) || (factory && factory.definition) || { factory: { id: factory && factory.id, revision: null, digest: null }, gates: [] };
  const steps = (gate && gate.gates ? gate.gates : []).map((s) => ({
    id: s.gate,
    kind: s.kind,
    source: s.source || "inline",
    verdict: s.verdict,
    passed: s.verdict === "passed" || s.verdict === "skipped",
    head: s.head || null,
    base: s.base || null,
    digest: s.digest || null,
    revision: s.revision || null,
    cycles: s.cycles == null ? null : s.cycles,
    fact: s.fact || null,
    escalated_to: s.escalated_to || null,
    started_at: s.started_at || null,
    finished_at: s.finished_at || null,
    duration_ms: s.duration_ms == null ? null : s.duration_ms,
    detail: s.detail ? oneLine(s.detail, 300) : null,
  }));
  const gateState = (gate && gate.state) || "failed";
  const gatedHead = (gate && gate.head) || null;
  // Every step must have judged the SAME head, and that head must be known
  // (review findings 1 and 3): a pipeline whose fix cycle advanced HEAD after
  // an earlier gate passed, or one whose change-set read failed, leaves
  // verdicts that do not all bind to `subject.commit` — and an attestation
  // reading "all passed" over them is what a validator must never be handed.
  // The runner re-runs the earlier gates (gate-runner.js) so this is normally
  // true; here it is CHECKED, not assumed.
  const headConsistent = !!gatedHead && steps.every((s) => s.head === gatedHead);
  const allPassed = gateState === "passed" && steps.every((s) => s.passed) && headConsistent;
  const integrationHead = integration && integration.head ? integration.head : null;
  const commit = integrationHead || gatedHead;
  // The stage may have re-gated a moved head (integration-runner.js
  // refreshTree): its `gated_head` is then the head its OWN landing was
  // judged at, and equality is against that.
  const stageGated = (integration && integration.gated_head) || gatedHead;
  const headMatchesGated = integrationHead && stageGated ? integrationHead === stageGated : integration && integration.head_matches_gated != null ? integration.head_matches_gated : null;
  const integrationOk = !integration || !integration.state || ((integration.state === "passed" || integration.state === "parked") && headMatchesGated !== false);
  const starts = steps.map((s) => s.started_at).filter(Boolean).map((t) => Date.parse(t)).filter((n) => !Number.isNaN(n));
  const startedAt = starts.length ? Math.min(...starts) : null;
  const finishedAt = now();
  const issuedAt = iso(finishedAt);
  const id = attestationId(nodeId, runId, attempt);
  return {
    schema: SCHEMA,
    id,
    issued_at: issuedAt,
    passed: allPassed && integrationOk,
    subject: {
      node: nodeId,
      run: runId,
      attempt,
      repo: item.project || null,
      commit,
      branch: (gate && gate.branch) || null,
      base: (gate && gate.base) || null,
      trusted_ref: (gate && gate.trusted_ref) || (factory && factory.trustedRef) || null,
      trusted_sha: (gate && gate.trusted_sha) || null,
    },
    factory: { id: (def.factory && def.factory.id) || (factory && factory.id) || null, revision: (def.factory && def.factory.revision) || null, digest: (def.factory && def.factory.digest) || null },
    gate: {
      allPassed,
      state: gateState,
      head: gatedHead,
      head_consistent: headConsistent,
      reason: gate && gate.reason ? oneLine(gate.reason, 300) : null,
      escalated_to: (gate && gate.escalated_to) || null,
      steps,
    },
    integration: integration
      ? {
          mode: integration.mode || null,
          strategy: integration.strategy || null,
          state: integration.state || null,
          reason: integration.reason ? oneLine(integration.reason, 300) : null,
          target_ref: integration.target_ref || (factory && factory.integration && factory.integration.targetRef) || null,
          target_sha: integration.target_sha || null,
          head: integrationHead,
          gated_head: stageGated,
          head_matches_gated: headMatchesGated,
          landed_sha: integration.landed_sha || null,
          candidate: integration.candidate || null,
          proposal: integration.proposal || null,
          escalated_to: integration.escalated_to || null,
          started_at: integration.started_at || null,
          finished_at: integration.finished_at || null,
          duration_ms: integration.duration_ms == null ? null : integration.duration_ms,
        }
      : null,
    configIntegrity: {
      factory: { id: (def.factory && def.factory.id) || null, revision: (def.factory && def.factory.revision) || null, digest: (def.factory && def.factory.digest) || null },
      gates: (def.gates || []).map((g) => ({ id: g.id, source: g.source || "inline", revision: g.revision || null, digest: g.digest || null })),
      trusted_ref: (gate && gate.trusted_ref) || (factory && factory.trustedRef) || null,
      trusted_sha: (gate && gate.trusted_sha) || null,
      protected_paths: (factory && factory.protectedPaths) || [],
    },
    timing: {
      started_at: iso(startedAt),
      finished_at: issuedAt,
      duration_ms: startedAt == null ? null : Math.max(0, finishedAt - startedAt),
    },
    environment: {
      spor_version: environment.spor_version || null,
      worker: environment.worker || null,
      host: environment.host || null,
      platform: environment.platform || null,
      node: environment.node || null,
      mode: environment.mode || null,
    },
  };
}

// The graph artifact carrying the attestation — `relates-to` the work item and
// every gate/merge fact it summarizes; never `resolves` (an attestation records,
// it does not retire — dec-spor-gates-enforced-in-code-factory-is-data).
//
// The node body is capped (NODE_BODY_CAP_BYTES, the REST door's limit) and the
// attestation JSON is the one part of it a machine reads — so it is never
// byte-truncated (review finding 4: a cut JSON block is an unreadable
// attestation, which for a validator is the same as none). Instead the
// rendering STEPS DOWN until it fits: pretty JSON, compact JSON, then compact
// JSON with the free-text fields dropped, then the per-step list thinned to
// its identity (id/kind/verdict/head/digest/fact — the linked fact carries the
// rest), then fewer linked edges. Every rung is valid JSON carrying the fields
// a validator checks (subject.commit, passed, gate.allPassed, configIntegrity).
const EDGE_FLOOR = 8;
function compactAttestation(att, level) {
  if (level < 2) return att;
  const dropText = (o) => (o ? { ...o, detail: undefined, reason: undefined } : o);
  const a = { ...att, gate: { ...dropText(att.gate), steps: att.gate.steps.map(dropText) }, integration: att.integration ? dropText(att.integration) : null };
  if (level < 3) return a;
  a.gate.steps = att.gate.steps.map((st) => ({ id: st.id, kind: st.kind, verdict: st.verdict, passed: st.passed, head: st.head, digest: st.digest, fact: st.fact }));
  if (a.integration) a.integration = { mode: a.integration.mode, state: a.integration.state, head: a.integration.head, gated_head: a.integration.gated_head, head_matches_gated: a.integration.head_matches_gated, landed_sha: a.integration.landed_sha };
  a.environment = { spor_version: att.environment.spor_version, mode: att.environment.mode };
  a.abridged = "steps and stage thinned to fit the node body cap — the linked gate/merge facts carry the detail";
  return a;
}
function renderAttestationJson(att, level) {
  const a = compactAttestation(att, level);
  return level === 0 ? JSON.stringify(a, null, 2) : JSON.stringify(a);
}

function buildAttestationNode({ item, factory, gate, integration = null, environment = {}, now = Date.now, date = null }) {
  const attestation = buildAttestationObject({ item, factory, gate, integration, environment, now });
  const nodeId = item.node_id;
  const facts = [...((gate && gate.facts) || []), ...((integration && integration.facts) || [])].filter((f) => typeof f === "string" && f);
  const allFacts = [...new Set(facts)];
  const cap = gateRunner.NODE_BODY_CAP_BYTES - 512;
  const render = (json, edgeCap) => renderAttestationMarkdown({ attestation, nodeId, item, uniqueFacts: allFacts.slice(0, edgeCap), day: date || attestation.issued_at.slice(0, 10), json });
  const ladder = [
    [0, EDGE_CAP],
    [1, EDGE_CAP],
    [2, EDGE_CAP],
    [3, EDGE_CAP],
    [3, EDGE_FLOOR],
  ];
  let markdown = null;
  for (const [level, edgeCap] of ladder) {
    const candidate = render(renderAttestationJson(attestation, level), edgeCap);
    if (Buffer.byteLength(candidate, "utf8") <= cap) {
      markdown = candidate;
      break;
    }
  }
  if (markdown == null) {
    // The floor of the ladder is a few hundred bytes of identity; a factory
    // with that many gates has other problems, but even then the JSON is
    // never cut — the step list is replaced by its count.
    const minimal = compactAttestation(attestation, 3);
    minimal.gate = { ...minimal.gate, steps: [], steps_elided: attestation.gate.steps.length };
    minimal.configIntegrity = { ...minimal.configIntegrity, gates: [], gates_elided: attestation.configIntegrity.gates.length };
    markdown = render(JSON.stringify(minimal), EDGE_FLOOR);
  }
  return { id: attestation.id, attestation, markdown };
}

function renderAttestationMarkdown({ attestation, nodeId, item, uniqueFacts, day, json }) {
  const verdict = attestation.passed
    ? "passed"
    : attestation.gate.allPassed
    ? `gates passed, integration ${attestation.integration && attestation.integration.state}${attestation.integration && attestation.integration.head_matches_gated === false ? " (head not the gated head)" : ""}`
    : attestation.gate.state === "passed"
    ? "gates passed but not all at the subject commit"
    : `gates ${attestation.gate.state}`;
  const summary = oneLine(
    `Attestation for ${nodeId} run ${gateRunner.shortRunAttempt(item.run_id, item.attempt)}: ${verdict} at commit ${attestation.subject.commit ? attestation.subject.commit.slice(0, 12) : "unknown"} under factory ${attestation.factory.id || "?"}${attestation.factory.digest ? ` (${attestation.factory.digest.slice(0, 19)}…)` : ""}.`,
    SUMMARY_CAP
  );
  const lines = [
    "---",
    `id: ${attestation.id}`,
    "type: artifact",
    ...(item.project ? [`project: ${item.project}`] : []),
    `title: Attestation — ${verdict} on ${oneLine(nodeId, 60)}`,
    `summary: ${summary}`,
    `date: ${day}`,
    ...(attestation.subject.commit ? [`gate_head: ${attestation.subject.commit}`] : []),
    ...(attestation.factory.digest ? [`factory_digest: ${attestation.factory.digest}`] : []),
    "edges:",
    `  - {type: relates-to, to: ${nodeId}}`,
    ...uniqueFacts.map((f) => `  - {type: relates-to, to: ${f}}`),
    "---",
    "",
    `The gate pipeline for dispatched run \`${item.run_id}\` on ${nodeId}${attestation.factory.id ? `, under factory \`${attestation.factory.id}\`` : ""},`,
    `attests: ${verdict}. Subject commit \`${attestation.subject.commit || "unknown"}\`${attestation.subject.branch ? ` on branch \`${attestation.subject.branch}\`` : ""}${attestation.subject.trusted_ref ? `, trusted ref \`${attestation.subject.trusted_ref}\`${attestation.subject.trusted_sha ? ` at \`${attestation.subject.trusted_sha}\`` : ""}` : ""}.`,
    "",
    "A validator checks four things against this record: the subject commit equals the head it is asked",
    "to trust, `gate.allPassed` (and `integration.head_matches_gated` where a stage ran), `issued_at` is",
    "fresh enough, and `configIntegrity` digests match the factory/gate definitions as they stand",
    "(sha256 of the canonical JSON of the normalized definition — `lib/kernel/gates.js` `definitionDigest`).",
    "",
    "```json",
    json,
    "```",
    "",
    "This is an attestation, not a resolution: it records what the runner enforced, on which commit,",
    "under which definition. The per-gate and merge facts it links carry the evidence.",
    "",
  ];
  return lines.join("\n");
}

// The pull-request body a `propose`-mode run carries its attestation in, so the
// repo's CI validate-attestation job can read it off the PR rather than
// re-running the suite. The JSON sits between two HTML-comment markers a
// validator can locate without parsing markdown.
function renderPrBody({ attestation, branch, base, intro = null }) {
  const s = attestation.subject;
  const steps = attestation.gate.steps.map((st) => `- \`${st.id}\` (${st.kind}) — ${st.verdict}${st.head ? ` at \`${String(st.head).slice(0, 12)}\`` : ""}${st.fact ? ` — ${st.fact}` : ""}`);
  const cand = attestation.integration && attestation.integration.candidate;
  return [
    intro || `Opened by the spor work integration stage (\`propose\` mode) for \`${branch}\` onto \`${base}\`.`,
    "",
    `**Attestation** — commit \`${s.commit || "unknown"}\`${s.branch ? ` on \`${s.branch}\`` : ""}, factory \`${attestation.factory.id || "?"}\`${attestation.factory.digest ? ` (\`${attestation.factory.digest}\`)` : ""}, gates ${attestation.gate.allPassed ? "all passed" : attestation.gate.state}${attestation.integration && attestation.integration.head_matches_gated === false ? " — **the proposed head is not the head the gates judged**" : ""}.`,
    "",
    ...steps,
    ...(cand ? ["", `Candidate suite (\`${cand.command || "declared command"}\`) ${cand.suite || "ran"} on merge(\`${base}\`${cand.base ? ` at \`${String(cand.base).slice(0, 12)}\`` : ""}, \`${String(s.commit || "").slice(0, 12)}\`)${cand.sha ? ` → \`${String(cand.sha).slice(0, 12)}\`` : ""}.`] : []),
    "",
    `A CI job can validate this instead of re-running the suite: \`subject.commit\` must equal the PR head, \`gate.allPassed\` must be true, \`issued_at\` must be fresh, and \`configIntegrity\` digests must match the factory as it stands (\`spor get ${attestation.factory.id || "<factory>"}\`; sha256 over the canonical JSON of the normalized definition).`,
    "",
    PR_BEGIN,
    "```json",
    JSON.stringify(attestation, null, 2),
    "```",
    PR_END,
    "",
  ].join("\n");
}

// A validator's half: read the attestation back out of a PR body. Null when
// the markers are absent or the JSON between them does not parse.
function extractPrAttestation(body) {
  const text = String(body || "");
  const a = text.indexOf(PR_BEGIN);
  const b = text.indexOf(PR_END);
  if (a < 0 || b < 0 || b < a) return null;
  const inner = text.slice(a + PR_BEGIN.length, b).replace(/^\s*```(?:json)?\s*\n/, "").replace(/\n\s*```\s*$/, "");
  try {
    const parsed = JSON.parse(inner);
    return parsed && parsed.schema === SCHEMA ? parsed : null;
  } catch {
    return null;
  }
}

module.exports = {
  SCHEMA,
  PR_BEGIN,
  PR_END,
  attestationId,
  buildAttestationObject,
  buildAttestationNode,
  renderPrBody,
  extractPrAttestation,
};

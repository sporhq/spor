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

const crypto = require("node:crypto");
const gateRunner = require("./gate-runner.js");
const gatesKernel = require("../kernel/gates.js");

const SCHEMA = "spor.attestation/1";
const SIGNATURE_ALG = "hmac-sha256";
const PR_BEGIN = "<!-- spor-attestation:begin -->";
const PR_END = "<!-- spor-attestation:end -->";
const SUMMARY_CAP = 460;
// Integration states an attestation may vouch for (see buildUnboundAttestation).
const OK_INTEGRATION_STATES = new Set(["passed", "parked", "proposing"]);
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
function buildAttestationObject({ item, factory, gate, integration = null, environment = {}, now = Date.now, signing = null }) {
  const att = buildUnboundAttestation({ item, factory, gate, integration, environment, now });
  return bindAttestation(att, signing);
}

function buildUnboundAttestation({ item, factory, gate, integration = null, environment = {}, now = Date.now }) {
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
  // The stage is OK when it landed (`passed`), parked a proposal (`parked`),
  // or is about to open one (`proposing` — the propose-time PR body, built
  // after the candidate suite ran and before the PR exists, so the proposal's
  // identity is the one thing it cannot yet carry; cross-model review, major
  // finding 6: a PR must never OPEN carrying `passed: false` over a green
  // pipeline, or a creation-triggered validator fails for good). In every OK
  // state the head must be the gated head and, where a candidate was built,
  // its suite must have PASSED — a stage that reports parked over a red
  // candidate is not one this attestation vouches for.
  const candidate = integration && integration.candidate ? integration.candidate : null;
  const candidateOk = !candidate || candidate.suite === "passed";
  const integrationOk = !integration || !integration.state || (OK_INTEGRATION_STATES.has(integration.state) && headMatchesGated !== false && candidateOk);
  const starts = steps.map((s) => s.started_at).filter(Boolean).map((t) => Date.parse(t)).filter((n) => !Number.isNaN(n));
  const startedAt = starts.length ? Math.min(...starts) : null;
  // `issued_at` is DERIVED from the judgement, never minted: the moment the
  // last step (or the integration stage) finished. The id is stable per run
  // and every gate-minted node is written `if_exists: skip` with a read-back
  // content comparison, so an attestation rebuilt from the same results must
  // reproduce the same bytes — a fresh `now()` in the bound core made the
  // rebuild collide with its own earlier copy instead of matching it
  // (cross-model review, major finding 7). `now` remains the fallback for a
  // result that carries no timestamps at all.
  const ends = [...steps.map((s) => s.finished_at), integration && integration.finished_at].filter(Boolean).map((t) => Date.parse(t)).filter((n) => !Number.isNaN(n));
  const finishedAt = ends.length ? Math.max(...ends) : now();
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

// --- binding: digest, signature, verification ------------------------------
//
// A PR body is MUTABLE text the PR's own author can edit, so the JSON in it is
// not evidence by itself (cross-model review, blocking finding 2). Two things
// make it checkable, and both key off the same canonical bytes:
//
//   1. `digest` — sha256 over the canonical JSON (sorted keys, no whitespace,
//      `lib/kernel/gates.js` canonicalJson) of the attestation's BOUND CORE:
//      every field a validator checks (subject, verdicts per step, heads,
//      configIntegrity, passed, issued_at, the graph artifact id). The same
//      attestation is written to the GRAPH as `art-attest-*` by the runner —
//      a store the PR author does not write through — so a validator fetches
//      that artifact by `id` (`spor get <id>`) and requires its `digest` to
//      equal the PR body's. The graph copy is the trust anchor; the PR body
//      is a convenience copy of it.
//   2. `signature` — HMAC-SHA256 over those same bytes with a key the runner
//      holds (`attestation.signingKey` / SPOR_ATTESTATION_KEY, never in a
//      committable `.spor.json`) and CI holds as a secret; `key_id` names
//      which. A team without a shared graph reachable from CI verifies this
//      instead. Symmetric on purpose: zero-dep, and the runner and the CI job
//      are the same team's two machines, not two parties.
//
// The core is the subset that SURVIVES every rung of the node-body ladder
// (compactAttestation drops free text and thins steps, never these fields), so
// a graph artifact thinned to fit the cap still carries the digest its full
// PR-body copy was bound to. The ladder's FLOOR elides the step list and the
// per-gate config list outright, so those two enter the core through their
// own sub-digests (`gate.steps_digest`, `configIntegrity.gates_digest`),
// stamped on every copy by bindAttestation: a copy that still carries the
// lists recomputes them from the lists; a floor copy carries the stamped
// values — and a copy that carries lists AND a stamped value is hashed from
// its lists, so a forged list cannot hide behind a genuine stamp. `digest`
// and `signature` are excluded from the bytes they cover.
function sha256Hex(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}
function coreSteps(g) {
  const nz = (v) => (v === undefined ? null : v);
  return (g.steps || []).map((s) => ({ id: nz(s.id), kind: nz(s.kind), verdict: nz(s.verdict), passed: s.passed === true, head: nz(s.head), digest: nz(s.digest), fact: nz(s.fact) }));
}
function coreGates(ci) {
  const nz = (v) => (v === undefined ? null : v);
  return (ci.gates || []).map((x) => ({ id: nz(x.id), source: nz(x.source), revision: nz(x.revision), digest: nz(x.digest) }));
}
function stepsDigest(g) {
  const steps = coreSteps(g || {});
  return steps.length || !(g && g.steps_digest) ? sha256Hex(gatesKernel.canonicalJson(steps)) : String(g.steps_digest);
}
function gatesDigest(ci) {
  const list = coreGates(ci || {});
  return list.length || !(ci && ci.gates_digest) ? sha256Hex(gatesKernel.canonicalJson(list)) : String(ci.gates_digest);
}
// The protected paths are bound by COUNT and DIGEST, never as the list: a
// factory can protect hundreds of globs, and a list in the core would be an
// unbounded field the node-body ladder could not thin without breaking the
// digest (cross-model review, major finding 3). A thinned copy carries the
// stamped count/digest and recomputes to the same core.
function protectedList(ci) {
  return Array.isArray(ci && ci.protected_paths) ? ci.protected_paths.map(String) : [];
}
function protectedCount(ci) {
  const list = protectedList(ci);
  return list.length ? list.length : Number(ci && ci.protected_paths_count) || 0;
}
function protectedDigest(ci) {
  const list = protectedList(ci);
  return list.length || !(ci && ci.protected_paths_digest) ? sha256Hex(gatesKernel.canonicalJson(list)) : String(ci.protected_paths_digest);
}
// The integration stage's bound fields — INCLUDING the candidate-suite
// evidence (the merged candidate's base, sha, suite verdict, and the command
// that produced it) and the proposal's identity. A validator trusting a
// propose-mode PR is trusting exactly that "merge(target, head) was green
// under <command>", so a copy whose candidate block was edited (a different
// base, a `passed` that was `failed`, another command) must fail the digest
// like any other tamper (cross-model review, blocking finding 1).
function coreIntegration(i) {
  const nz = (v) => (v === undefined ? null : v);
  const c = i.candidate || null;
  const p = i.proposal || null;
  return {
    mode: nz(i.mode),
    strategy: nz(i.strategy),
    state: nz(i.state),
    target_ref: nz(i.target_ref),
    target_sha: nz(i.target_sha),
    head: nz(i.head),
    gated_head: nz(i.gated_head),
    head_matches_gated: nz(i.head_matches_gated),
    landed_sha: nz(i.landed_sha),
    candidate: c ? { base: nz(c.base), sha: nz(c.sha), suite: nz(c.suite), command: nz(c.command), trusted_sha: nz(c.trusted_sha) } : null,
    proposal: p ? { number: nz(p.number), repo: nz(p.repo), branch: nz(p.branch), url: nz(p.url) } : null,
  };
}
function attestationCore(att) {
  const a = att || {};
  const g = a.gate || {};
  const i = a.integration || null;
  const ci = a.configIntegrity || {};
  const env = a.environment || {};
  const nz = (v) => (v === undefined ? null : v);
  return {
    schema: nz(a.schema),
    id: nz(a.id),
    issued_at: nz(a.issued_at),
    passed: a.passed === true,
    subject: a.subject ? { ...a.subject } : null,
    factory: a.factory ? { ...a.factory } : null,
    gate: {
      allPassed: g.allPassed === true,
      state: nz(g.state),
      head: nz(g.head),
      head_consistent: g.head_consistent == null ? null : g.head_consistent === true,
      steps_count: g.steps && g.steps.length ? g.steps.length : nz(g.steps_count),
      steps_digest: stepsDigest(g),
    },
    integration: i ? coreIntegration(i) : null,
    configIntegrity: {
      factory: ci.factory ? { ...ci.factory } : null,
      gates_count: ci.gates && ci.gates.length ? ci.gates.length : nz(ci.gates_count),
      gates_digest: gatesDigest(ci),
      trusted_ref: nz(ci.trusted_ref),
      trusted_sha: nz(ci.trusted_sha),
      protected_paths_count: protectedCount(ci),
      protected_paths_digest: protectedDigest(ci),
    },
    environment: { spor_version: nz(env.spor_version), mode: nz(env.mode) },
  };
}

function attestationBytes(att) {
  return Buffer.from(gatesKernel.canonicalJson(attestationCore(att)), "utf8");
}

function attestationDigest(att) {
  return `sha256:${crypto.createHash("sha256").update(attestationBytes(att)).digest("hex")}`;
}

function signatureValue(att, key) {
  return crypto.createHmac("sha256", String(key)).update(attestationBytes(att)).digest("hex");
}

// Stamp `digest`, and `signature` when a key is given. `signing` is
// `{key, keyId}`; a missing/empty key signs nothing (the digest alone is the
// graph binding). Returns the same object, bound.
function bindAttestation(att, signing = null) {
  att.gate = { ...(att.gate || {}), steps_count: ((att.gate && att.gate.steps) || []).length, steps_digest: stepsDigest(att.gate || {}) };
  att.configIntegrity = {
    ...(att.configIntegrity || {}),
    gates_count: ((att.configIntegrity && att.configIntegrity.gates) || []).length,
    gates_digest: gatesDigest(att.configIntegrity || {}),
    protected_paths_count: protectedCount(att.configIntegrity || {}),
    protected_paths_digest: protectedDigest(att.configIntegrity || {}),
  };
  att.digest = attestationDigest(att);
  const key = signing && signing.key ? String(signing.key) : "";
  if (key) att.signature = { alg: SIGNATURE_ALG, key_id: (signing.keyId && String(signing.keyId)) || "default", value: signatureValue(att, key) };
  else delete att.signature;
  return att;
}

// The validator's half — what a CI validate-attestation job runs (`spor
// attestation verify`). Every check is FAIL-CLOSED: a check that cannot be
// performed because something is missing fails rather than skipping, except
// the ones the caller did not ask for (no `commit`, no `maxAgeMs`, no
// `factoryDigest`, no `trusted` copy, no `key` — each is a check only when
// its input is given; `requireSignature`/`requireTrusted` turn the absence of
// the input into a failure too, for a CI that must never run without them).
//
//   digest    the body's `digest` equals a recomputation over its own core
//   signature with `key`: the body's `signature` verifies (a key given and no
//             signature present is a failure — a signed pipeline never emits
//             an unsigned attestation); the wrong key_id is reported
//   trusted   with `trusted` (the graph artifact's attestation, fetched by
//             id): same id, same digest, and the graph copy's own digest (and
//             signature, when a key is held) verify — the PR body is a copy of
//             a real attestation the graph holds. `trustedProvenance`
//             ({mode, author, authored_by_agent, authored_via} — the node's
//             SERVER-stamped authorship) decides whether that copy is an
//             ANCHOR when no key is held: only a remote-mode node with a
//             stamped author and not written by an agent is — a provenance
//             with no author is unknown, not a person's (see the `anchor`
//             check).
//   passed    `passed` is true
//   verdicts  the EVIDENCE under `passed` agrees with it (cross-model review,
//             blocking finding 2): `gate.allPassed`, `gate.head_consistent`,
//             every step (when the list is present) passed AT `subject.commit`,
//             and — where a stage ran — its state is one this attestation may
//             vouch for, `head_matches_gated` is not false, and the candidate
//             suite passed. A body whose top-level flag says passed over
//             explicitly failed evidence is refused, whatever bound it.
//   commit    with `commit`: `subject.commit` equals it (the PR head)
//   target    with `target`: the target tip the stage judged against — the
//             candidate's `base` (else `integration.target_sha`; for a run with
//             no stage, `subject.trusted_sha`) — equals it (cross-model review,
//             blocking finding 3): an attestation over merge(old tip, head) is
//             stale once the target advances, and one for another base must
//             not be reusable against this one. With `targetRef`: the stage's
//             `target_ref` (else `subject.trusted_ref`) names that ref.
//   fresh     with `maxAgeMs`: `issued_at` is within it of `now`
//   config    with `factoryDigest`: `configIntegrity.factory.digest` equals it
//
// Constant-time comparison for the signature and digest strings.
function timingSafeEqualStr(a, b) {
  const x = Buffer.from(String(a || ""), "utf8");
  const y = Buffer.from(String(b || ""), "utf8");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// The judged target tip an attestation binds to: what merge(target, head)'s
// suite ran against. Null when the copy carries none.
function attestedTarget(att) {
  const i = (att && att.integration) || null;
  const c = i && i.candidate;
  if (c && c.base) return { sha: c.base, via: "integration.candidate.base" };
  if (i && i.target_sha) return { sha: i.target_sha, via: "integration.target_sha" };
  if (!i && att && att.subject && att.subject.trusted_sha) return { sha: att.subject.trusted_sha, via: "subject.trusted_sha" };
  return null;
}
function attestedTargetRef(att) {
  const i = (att && att.integration) || null;
  if (i && i.target_ref) return { ref: i.target_ref, via: "integration.target_ref" };
  if (!i && att && att.subject && att.subject.trusted_ref) return { ref: att.subject.trusted_ref, via: "subject.trusted_ref" };
  return null;
}
// A short ref (`main`) matches a full one (`refs/heads/main`, `origin/main`)
// by its last segment; a full one must match exactly.
function refMatches(actual, expected) {
  const a = String(actual || "");
  const e = String(expected || "");
  if (!a || !e) return false;
  if (a === e) return true;
  const tail = (r) => r.split("/").pop();
  return !e.includes("/") ? tail(a) === e : !a.includes("/") ? tail(e) === a : false;
}

// Every disagreement between `passed` and the evidence beneath it. Empty when
// the evidence supports the flag.
function evidenceFailures(att) {
  const out = [];
  const g = att.gate || {};
  const subject = att.subject || {};
  if (g.allPassed !== true) out.push(`gate.allPassed is ${JSON.stringify(g.allPassed)}`);
  if (g.state !== "passed") out.push(`gate.state is ${JSON.stringify(g.state)}`);
  if (g.head_consistent !== true) out.push(`gate.head_consistent is ${JSON.stringify(g.head_consistent)}`);
  if (!subject.commit) out.push("subject.commit is unknown");
  if (g.head && subject.commit && !att.integration && g.head !== subject.commit) out.push(`gate.head ${g.head} is not subject.commit ${subject.commit}`);
  const steps = Array.isArray(g.steps) ? g.steps : null;
  if (steps) {
    if (g.steps_count != null && Number(g.steps_count) !== steps.length) out.push(`gate.steps lists ${steps.length} step(s), steps_count says ${g.steps_count}`);
    for (const st of steps) {
      if (st.passed !== true || (st.verdict !== "passed" && st.verdict !== "skipped")) out.push(`gate '${st.id}' verdict is ${JSON.stringify(st.verdict)}`);
      if (!st.head || st.head !== g.head) out.push(`gate '${st.id}' judged ${st.head || "an unknown head"}, not the gated head ${g.head || "unknown"}`);
    }
  } else if (g.steps_count == null) out.push("the attestation carries neither a step list nor a step count");
  else if (!g.steps_digest) out.push("the attestation elides its step list and carries no steps_digest to stand for it");
  const i = att.integration;
  if (i) {
    if (!OK_INTEGRATION_STATES.has(i.state)) out.push(`integration.state is ${JSON.stringify(i.state)}`);
    if (i.head_matches_gated !== true) out.push(`integration.head_matches_gated is ${JSON.stringify(i.head_matches_gated)}`);
    // The flag is checked against the heads it summarizes, never trusted alone.
    if (i.head && i.gated_head && i.head !== i.gated_head) out.push(`integration.head ${i.head} is not the gated head ${i.gated_head}`);
    if (i.head && subject.commit && i.head !== subject.commit) out.push(`integration.head ${i.head} is not subject.commit ${subject.commit}`);
    if (i.gated_head && g.head && i.gated_head !== g.head) out.push(`integration.gated_head ${i.gated_head} is not gate.head ${g.head}`);
    if (i.candidate && i.candidate.suite !== "passed") out.push(`the candidate suite is ${JSON.stringify(i.candidate.suite)}`);
  }
  return out;
}

function verifyAttestation(att, { key = null, keyId = null, now = Date.now, maxAgeMs = null, commit = null, target = null, targetRef = null, factoryDigest = null, trusted = null, trustedProvenance = null, requireSignature = false, requireTrusted = false } = {}) {
  const checks = [];
  const add = (check, ok, detail) => checks.push({ check, ok, detail });
  if (!att || typeof att !== "object") {
    add("schema", false, "no attestation object");
    return { ok: false, checks, reason: "no attestation object" };
  }
  add("schema", att.schema === SCHEMA, att.schema === SCHEMA ? SCHEMA : `schema '${att.schema}' is not ${SCHEMA}`);
  const recomputed = attestationDigest(att);
  const digestOk = !!att.digest && timingSafeEqualStr(att.digest, recomputed);
  add("digest", digestOk, digestOk ? recomputed : att.digest ? `digest ${att.digest} does not match the content (${recomputed})` : "the attestation carries no digest");
  const sig = att.signature;
  if (key) {
    if (!sig || sig.alg !== SIGNATURE_ALG || !sig.value) add("signature", false, sig ? `unsupported signature (${sig.alg || "no alg"})` : "a verification key was given but the attestation is unsigned");
    else if (keyId && sig.key_id !== keyId) add("signature", false, `signed with key '${sig.key_id}', not '${keyId}'`);
    else {
      const ok = timingSafeEqualStr(sig.value, signatureValue(att, key));
      add("signature", ok, ok ? `${SIGNATURE_ALG} by key '${sig.key_id}'` : `the ${SIGNATURE_ALG} signature does not verify with key '${sig.key_id}'`);
    }
  } else if (requireSignature) add("signature", false, sig ? "a signature is present but no key was given to verify it" : "a signature is required and the attestation is unsigned");
  if (trusted) {
    const sameId = !!att.id && trusted.id === att.id;
    const sameDigest = !!att.digest && !!trusted.digest && timingSafeEqualStr(trusted.digest, att.digest);
    // The graph copy is checked as an ATTESTATION, not as an id/digest pair
    // (cross-model review, blocking finding 2): its digest must recompute
    // from its own content, and when a key is held its signature must verify
    // — a node that merely carries the fields this copy names is not the
    // runner's record of anything.
    const ownDigest = !!trusted.digest && timingSafeEqualStr(trusted.digest, attestationDigest(trusted));
    const tsig = trusted.signature;
    const ownSig = !key || (!!tsig && tsig.alg === SIGNATURE_ALG && !!tsig.value && timingSafeEqualStr(tsig.value, signatureValue(trusted, key)));
    add(
      "trusted",
      sameId && sameDigest && ownDigest && ownSig,
      !sameId ? `the graph artifact is ${trusted.id || "unknown"}, not ${att.id || "unknown"}`
        : !sameDigest ? `the graph artifact ${trusted.id} carries digest ${trusted.digest || "none"}, this copy ${att.digest || "none"}`
        : !ownDigest ? `the graph artifact ${trusted.id}'s digest does not recompute from its own content`
        : !ownSig ? `the graph artifact ${trusted.id}'s signature does not verify with the key held`
        : `bound to graph artifact ${trusted.id}`
    );
    // WHO wrote the graph copy is the anchor, and it is only an anchor when
    // the writer could not have been the code under judgement. A dispatched
    // agent holds graph-write authority (its agent-scoped token), so a node
    // the server stamped `authored_by_agent` may be the implementer's own
    // forgery; and a LOCAL graph is a directory on the box the implementer
    // ran on. With a key, the signature is the anchor and provenance is
    // informational; without one, an anchor the judged code could have
    // written is no anchor (blocking finding 2).
    const prov = trustedProvenance || null;
    if (!key) {
      if (!prov) add("anchor", false, "no trust anchor: the graph artifact's provenance (who wrote it, in which mode) is unknown and no verification key is held");
      else if (prov.mode !== "remote") add("anchor", false, `no trust anchor: the graph artifact was read from a ${prov.mode || "local"} graph — a directory the judged code could write — and no verification key is held`);
      else if (prov.authored_by_agent) add("anchor", false, `no trust anchor: the graph artifact ${trusted.id} was written by agent '${prov.authored_by_agent}' — a dispatched agent has graph-write authority and may be the code under judgement — and no verification key is held`);
      // Person authorship is POSITIVE evidence, never the absence of an agent
      // stamp (cross-model review, blocking finding 4): the CLI always hands
      // over a provenance object, and a node the server never stamped — no
      // author, no channel, no agent — is unknown provenance, not a person's.
      else if (!(typeof prov.author === "string" && prov.author.trim())) add("anchor", false, `no trust anchor: the graph artifact ${trusted.id} carries no server-stamped author — who wrote it is unknown, so it may be the code under judgement — and no verification key is held`);
      else add("anchor", true, `the graph artifact ${trusted.id} is server-stamped as written by ${prov.author || "a person"}${prov.authored_via ? ` via ${prov.authored_via}` : ""}, not by an agent`);
    }
  } else if (requireTrusted) add("trusted", false, "the graph artifact copy is required and none was given");
  // A digest alone is self-authored: whoever edits the body recomputes it.
  // Verification needs at least one anchor the author does not control — a
  // key this validator holds, or the runner-written graph artifact — and
  // without either it FAILS rather than passing on the digest (cross-model
  // review, blocking finding 1).
  if (!key && !trusted) add("anchor", false, "no trust anchor: neither a verification key nor the graph artifact copy was given — the digest alone is self-authored and proves nothing");
  add("passed", att.passed === true, att.passed === true ? "passed" : `passed is ${JSON.stringify(att.passed)}`);
  const disagreements = evidenceFailures(att);
  add("verdicts", disagreements.length === 0, disagreements.length ? `the evidence does not support passed: ${disagreements.join("; ")}` : "every gate passed at the subject commit, and the stage judged that head");
  if (commit) {
    const c = att.subject && att.subject.commit;
    add("commit", c === commit, c === commit ? commit : `subject.commit is ${c || "unknown"}, expected ${commit}`);
  }
  if (target) {
    const t = attestedTarget(att);
    add("target", !!t && t.sha === target, !t ? `the attestation binds no target tip, expected ${target}` : t.sha === target ? `${t.via} ${target}` : `${t.via} is ${t.sha}, expected ${target} — the target has advanced since this was judged, or this attestation is for another base`);
  }
  if (targetRef) {
    const r = attestedTargetRef(att);
    add("target_ref", !!r && refMatches(r.ref, targetRef), !r ? `the attestation names no target ref, expected ${targetRef}` : refMatches(r.ref, targetRef) ? `${r.via} ${r.ref}` : `${r.via} is ${r.ref}, expected ${targetRef}`);
  }
  if (maxAgeMs != null) {
    const issued = Date.parse(att.issued_at || "");
    const age = Number.isNaN(issued) ? null : now() - issued;
    const ok = age != null && age >= 0 && age <= maxAgeMs;
    add("fresh", ok, age == null ? `issued_at '${att.issued_at}' is unreadable` : ok ? `${Math.round(age / 1000)}s old` : age < 0 ? "issued_at is in the future" : `${Math.round(age / 1000)}s old, older than ${Math.round(maxAgeMs / 1000)}s`);
  }
  if (factoryDigest) {
    const d = att.configIntegrity && att.configIntegrity.factory && att.configIntegrity.factory.digest;
    add("config", d === factoryDigest, d === factoryDigest ? factoryDigest : `the factory digest is ${d || "none"}, expected ${factoryDigest}`);
  }
  const failed = checks.filter((c) => !c.ok);
  return { ok: failed.length === 0, checks, reason: failed.length ? failed.map((c) => `${c.check}: ${c.detail}`).join("; ") : null };
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
  // Every field the bound core covers survives the thinning (candidate and
  // proposal included) — a copy that dropped them would carry a digest it can
  // no longer reproduce.
  if (a.integration) a.integration = coreIntegration(a.integration);
  const protectedN = protectedList(att.configIntegrity).length;
  if (protectedN) a.configIntegrity = { ...att.configIntegrity, protected_paths: [], protected_paths_elided: protectedN };
  a.environment = { spor_version: att.environment.spor_version, mode: att.environment.mode };
  a.abridged = "steps and stage thinned to fit the node body cap — the linked gate/merge facts carry the detail";
  return a;
}
function renderAttestationJson(att, level) {
  const a = compactAttestation(att, level);
  return level === 0 ? JSON.stringify(a, null, 2) : JSON.stringify(a);
}

function buildAttestationNode({ item, factory, gate, integration = null, environment = {}, now = Date.now, date = null, signing = null }) {
  const attestation = buildAttestationObject({ item, factory, gate, integration, environment, now, signing });
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
    // never cut — every list is replaced by its count (the digests stamped on
    // the object still bind them). The floor is BOUNDED by construction — ids,
    // shas, digests, counts — and it is CHECKED, not assumed: a rendering that
    // still does not fit is refused loudly here rather than written as a node
    // the graph will reject (cross-model review, major finding 3).
    // The lists are REMOVED, not emptied (cross-model review, major finding
    // 4): a copy carrying `steps: []` beside a nonzero `steps_count` is a
    // disagreement the validator refuses, whereas a copy carrying no list at
    // all is verified by the stamped count and digest — which is what the
    // floor is for. `*_elided` says how many the linked facts carry.
    const minimal = compactAttestation(attestation, 3);
    minimal.gate = { ...minimal.gate, steps: undefined, steps_elided: attestation.gate.steps.length };
    minimal.configIntegrity = { ...minimal.configIntegrity, gates: undefined, gates_elided: attestation.configIntegrity.gates.length, protected_paths: undefined, protected_paths_elided: protectedList(attestation.configIntegrity).length };
    for (const edgeCap of [EDGE_FLOOR, 0]) {
      const candidate = render(JSON.stringify(minimal), edgeCap);
      if (Buffer.byteLength(candidate, "utf8") <= cap) {
        markdown = candidate;
        break;
      }
    }
    if (markdown == null) {
      const floor = render(JSON.stringify(minimal), 0);
      throw new Error(`the attestation node for ${nodeId} does not fit the node body cap even at its floor (${Buffer.byteLength(floor, "utf8")} > ${cap} bytes)`);
    }
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
    ...(attestation.digest ? [`attestation_digest: ${attestation.digest}`] : []),
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
    "This graph artifact is the trust anchor for any copy of the attestation carried elsewhere (a pull",
    "request body): a copy is genuine only if its `digest` equals this node's, and `spor attestation verify`",
    `checks that${attestation.signature ? ` (this one is also signed, ${attestation.signature.alg} key '${attestation.signature.key_id}')` : ""}.`,
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
    `A CI job can validate this instead of re-running the suite — but this text is not evidence by itself (anyone who can edit the PR can edit it). The evidence is the graph artifact \`${attestation.id}\` the runner wrote, which the PR author does not write through: fetch it (\`spor get ${attestation.id}\`), require its \`digest\` to equal this copy's (\`${attestation.digest || "unbound"}\`) and to recompute from its own content, and require the server's authorship stamp to show it was not written by an agent (a dispatched implementer can write graph nodes too; \`spor attestation verify\` checks all of this)${attestation.signature ? `, and/or verify the \`signature\` (${attestation.signature.alg}, key \`${attestation.signature.key_id}\`, over the canonical JSON of the bound core) with the key CI holds` : ""}. Then \`subject.commit\` must equal the PR head, \`integration.candidate.base\` must equal the base branch's current tip (the attestation is for merge(that tip, head) and goes stale when the base advances), \`gate.allPassed\` must be true, \`issued_at\` must be fresh, and \`configIntegrity\` digests must match the factory as it stands (\`spor get ${attestation.factory.id || "<factory>"}\`; sha256 over the canonical JSON of the normalized definition). \`spor attestation verify --pr-body <file> --commit <sha> --target <base tip> --max-age <ms>\` runs every check.${attestation.integration && attestation.integration.state === "proposing" ? " This copy was written as the PR was opened, before the run settled and its graph artifact was written: it is complete and signed as it stands (validate it by signature), and the runner replaces it with the final graph-bound copy once the run settles — a validator comparing against the graph artifact should run on that edit, or re-run." : ""}`,
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
  OK_INTEGRATION_STATES,
  attestedTarget,
  evidenceFailures,
  SIGNATURE_ALG,
  PR_BEGIN,
  PR_END,
  attestationId,
  attestationCore,
  attestationDigest,
  bindAttestation,
  verifyAttestation,
  buildAttestationObject,
  buildAttestationNode,
  renderPrBody,
  extractPrAttestation,
};

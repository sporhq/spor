"use strict";
// kernel/attempt-spec.js — the ONE derivation of an attempt spec
// (task-spor-work-derive-attempt-spec-on-dispatch, PROVIDERS.md §4,
// constrained-by dec-spor-work-execution-provider-contract).
//
// The attempt spec is DERIVED, never hand-written: everything an environment
// must hold is read off the resolved dispatch — the profile (harness, model,
// MCP, skills, plugins), the factory pinned for the run (its implementation
// budget bounds the deadline), the item (its id, its repo pinned at a commit)
// — plus the few things only the REQUEST can say (an isolation kind, an egress
// allow list, extra tools). `spor dispatch` derives it on its launch door and
// matches it against the chosen provider's describe() with `satisfiesAttempt`
// BEFORE any environment is created; `spor attempt build` derives the same
// object for a bundle. One function, so the two can never describe one
// attempt two ways.
//
// Pure: no clock (the caller passes `now`), no git, no config. The shell
// halves read those and hand the facts in (`attemptInputsFromPlan` in
// lib/shell/dispatch.js).
//
// IDENTITY is bound separately (`bindExecution`): a person's `spor dispatch`
// has no execution, so its spec carries no attempt_id/execution_id/fence/
// tenant and no attempt token reference — it is matched, never sent as a
// contract message. The work loop's attempt driver binds the execution it
// claimed and only then validates the whole spec against the contract schema
// (`attemptSpecErrors`), because only then is it a complete attempt.
//
// Secrets: no source declares one yet (a profile and a factory name no secret
// references), so `secrets` is always empty and the matcher's secret_delivery
// axis asks for nothing. When a source gains them they ride here BY REFERENCE
// (§4.2) and are validated by the same schema.

const pc = require("./provider-contract.js");

const DEFAULT_ISOLATION = "worktree";
// The prompt of an attempt whose bundle carries it (PROVIDERS.md §13.1).
const IN_BUNDLE_PROMPT_REF = "spor-bundle://prompt/";
// The fields the work loop's attempt driver binds from the execution it holds
// (§4.1). A spec without them is a dispatch's match-only spec.
const IDENTITY_FIELDS = Object.freeze(["attempt_id", "execution_id", "fence", "tenant"]);

function list(v) {
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  return Array.isArray(v) ? [...new Set(v.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim()))] : [];
}

// Seconds-precision UTC, the shape every other derived timestamp uses.
function isoSeconds(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// The attempt's wall clock (§8): an explicit request wins, then the pinned
// factory's implementation budget (`implementation.budget.run_max_ms`, the
// lane's own watchdog), then the worker's ceiling.
function deadlineFor({ now, requestMs = null, factory = null, defaultMs }) {
  const budget = factory && factory.implementation && factory.implementation.budget;
  const ms = Number.isFinite(requestMs) && requestMs > 0
    ? requestMs
    : budget && Number.isFinite(budget.runMaxMs) && budget.runMaxMs > 0 ? budget.runMaxMs : defaultMs;
  return isoSeconds(now + ms);
}

// deriveAttemptSpec(inputs) -> the attempt spec (PROVIDERS.md §4).
//
//   nodeId       the item, or null (a free-text dispatch)
//   harness      the harness adapter id the dispatcher resolved
//   model        the effective model (flag > profile), or null
//   profile      {id?, mcp?, skills?, plugins?} — the resolved profile's runtime
//   sporMcp      true when the launch wires the Spor MCP (an agent identity in
//                remote mode): `spor` joins the MCP axis even if the profile
//                does not name it, so an environment is asked for exactly the
//                servers the harness will be pointed at
//   factory      the parsed factory pinned for the run, or null
//   repos        [{slug, commit?, branch?, url?}] — the checkouts, pinned
//   server       the graph the attempt writes into (a server base, or a local
//                graph's nodes dir as a file:// reference)
//   request      {isolation?, egress?, tools?, deadlineMs?} — what only the
//                operator can ask for
//   now, defaultRunMaxMs
//   promptBundleRef  where the prompt lives (default: inside the bundle)
//   execution    {attempt_id, execution_id, fence, tenant} — optional; bound
//                via bindExecution
function deriveAttemptSpec({
  nodeId = null, harness, model = null, profile = null, sporMcp = false, factory = null, repos = [],
  server = null, request = {}, now, defaultRunMaxMs, promptBundleRef = IN_BUNDLE_PROMPT_REF, execution = null,
}) {
  const rt = profile || {};
  const req = request || {};
  const mcp = list(rt.mcp);
  if (sporMcp && !mcp.includes("spor")) mcp.push("spor");
  const spec = {
    contract_version: pc.CONTRACT_VERSION,
    ...(nodeId ? { node_id: String(nodeId) } : {}),
    harness: { id: String(harness) },
    ...(model ? { model: String(model) } : {}),
    ...(rt.id ? { profile: String(rt.id) } : {}),
    mcp,
    skills: list(rt.skills),
    plugins: list(rt.plugins),
    // git is the one tool every attempt needs: it commits its candidate.
    tools: [...new Set(["git", ...list(req.tools)])],
    repos: (repos || []).map((r) => ({
      slug: String(r.slug),
      ...(r.commit ? { commit: String(r.commit) } : {}),
      ...(r.branch ? { branch: String(r.branch) } : {}),
      ...(r.url ? { url: String(r.url) } : {}),
    })),
    egress: { allow: list(req.egress) },
    secrets: [],
    spor: server ? { server: String(server) } : {},
    deadline: deadlineFor({ now, requestMs: req.deadlineMs, factory, defaultMs: defaultRunMaxMs }),
    isolation: req.isolation ? String(req.isolation) : DEFAULT_ISOLATION,
    prompt_bundle_ref: promptBundleRef,
  };
  return execution ? bindExecution(spec, execution) : spec;
}

// Bind the execution a worker holds (§4.1): the identity fields in the
// contract's order, and the attempt-scoped token's reference for this fence
// (§4.3). Never re-binds a spec that already carries an identity — an adopted
// attempt keeps the SUBMITTING instance's (§6).
function bindExecution(spec, { attempt_id, execution_id, fence, tenant }) {
  if (spec && spec.execution_id) return spec;
  const { contract_version, ...rest } = spec || {};
  const bound = {
    contract_version,
    attempt_id: String(attempt_id),
    execution_id: String(execution_id),
    fence,
    tenant: String(tenant),
    ...rest,
  };
  if (bound.spor && bound.spor.server) bound.spor = { ...bound.spor, token_ref: `spor-attempt-token://${execution_id}/${fence}` };
  return bound;
}

// The contract schema's verdict on a derived spec: every error, or [] when it
// is a valid attempt (`provider-contract.js` "attempt-spec"). A spec carrying
// no execution identity is checked as the match-only spec a dispatch derives:
// the missing identity fields (and the token reference that hangs off them)
// are the driver's to bind, not errors.
function attemptSpecErrors(spec) {
  const v = pc.validate("attempt-spec", spec);
  if (v.ok) return [];
  if (spec && spec.execution_id) return v.errors;
  const unbound = new Set([...IDENTITY_FIELDS, "node_id", "spor.token_ref"].map((f) => `${f}: is required`));
  return v.errors.filter((e) => !unbound.has(e));
}

module.exports = {
  DEFAULT_ISOLATION,
  IN_BUNDLE_PROMPT_REF,
  IDENTITY_FIELDS,
  deriveAttemptSpec,
  bindExecution,
  attemptSpecErrors,
  deadlineFor,
};

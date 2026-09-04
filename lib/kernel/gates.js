// kernel/gates.js — the FACTORY DEFINITION and its gate vocabulary
// (task-spor-work-gate-pipeline, derived-from dec-spor-software-factory-
// substrate).
//
// A factory definition is graph DATA: a `type: factory` node whose body carries
// a fenced JSON payload declaring an ORDERED list of gates, each one of three
// kinds — `command` (run a declared acceptance suite), `agent-review` (a
// profile-routed cross-model review whose structured verdict is applied in
// code), and `human` (a person approves, keyed on declared risk classes). The
// runner ENFORCES that list; nothing here is an instruction to an orchestrator
// agent, which is the correction the substrate decision exists to make.
//
// This file is the PURE half: parse a definition, resolve inline and referenced
// gates into one normalized list, match declared globs against a diff, and read
// a review's structured findings verdict. No I/O, no clock, no process — every
// side effect lives in shell/gate-runner.js, so the whole vocabulary is
// testable without a git checkout or a dispatch.
//
// Two shapes are supported and are deliberately INDISTINGUISHABLE downstream
// (an acceptance criterion): a gate may be written inline in the factory node,
// or referenced by id as a shareable `type: gate` node (`{"ref":
// "gate-security-review"}`) so an org can vet one gate and reuse it
// product-wide. `resolveGates()` folds both into the same normalized objects,
// and the runner has no "is this a reference?" branch.
//
// Zero deps; plain Node.
"use strict";

const { globToRegExp } = require("./coupling.js");

const GATE_KINDS = Object.freeze(["command", "agent-review", "human"]);

// The `integration:` block's vocabulary (dec-spor-factory-integration-step). It
// is deliberately NOT a fourth gate kind — the decision rejects that shape: a
// gate judges the branch, integration mutates the target ref, serializes
// globally, and cleans up, which is a STAGE, not a gate. So it parses beside
// the gate list, on the same factory payload, with its own vocabulary.
//
// `propose` (task-spor-integration-propose-mode) is for orgs whose policy
// forbids a worker pushing straight onto the target ref: the candidate suite
// still runs pre-PR so the PR is known-green, but landing means opening a PR
// from the gate-passed branch and PARKING the item — never mutating
// target_ref itself. See integration-runner.js's propose branch of
// runIntegrationStage and its checkProposal (the later "did it land" half).
const INTEGRATION_MODES = Object.freeze(["local", "push", "propose"]);
const INTEGRATION_STRATEGIES = Object.freeze(["merge", "squash", "rebase"]);

// The PIPELINE-state vocabulary a run record carries in `gate_state`
// (WORKERS.md §8). It lives here, in the pure gate module, because two layers
// that never require each other both have to agree on it: the run journal
// (shell/agent-dispatch-runner.js), which refuses to overwrite a settled
// verdict, and the worker loop (shell/work-loop.js), which decides from the
// same word whether a pipeline still owes a verdict and may be resumed. Two
// copies of this set drifting apart would either strand an orphan forever or
// let a refusal be overwritten by a later `passed`.
//
// SETTLED is the half that is FINAL for a given run: once a pipeline has said
// passed/failed/blocked about run R, nothing may say anything else about run R
// (a genuine re-gate after a person acts is a NEW dispatch with a new run id).
// Everything else a record can carry — `running` under a worker that may be
// gone, `interrupted` by a stop — is a pipeline that started and never
// reported, which is exactly the state a later worker picks up. That half is
// deliberately NOT enumerated as its own set: the resumable test is "not
// settled", so an unrecognized value resumes rather than being silently
// treated as a verdict, which is the fail-closed direction.
//
// `Object.freeze` is not used here on purpose — it does not make a Set
// immutable (`add`/`delete` still work), so it would only advertise a
// guarantee this does not have.
// "parked" (task-spor-integration-propose-mode) joins the settled set: a
// `propose`-mode integration stage that opened a PR is DONE with this run —
// re-running it would open a duplicate PR — even though the item itself is
// not yet resolved. Whether the PR later lands is tracked separately (the
// blocker item's own status in the graph, checked by checkProposal), never by
// reopening this run's gate_state, which the settled-verdict guard in
// stampGateState would refuse anyway.
// "superseded" (issue-spor-work-adopts-orphaned-pipeline-of-hand-landed-run)
// is the fifth: a pipeline adopted after the fact found its item already
// resolved on the graph AND the run's head already contained in the trusted
// ref — landed by hand while no worker was watching. There is nothing left to
// judge (the trusted ref IS the tree) and re-offering the run would only make
// the next worker re-discover the same fact, so the pipeline settles without
// a gate fact, an escalation or a demotion.
const SETTLED_GATE_STATES = new Set(["passed", "failed", "blocked", "parked", "superseded"]);

const GATE_DEFAULTS = Object.freeze({
  // A command gate's suite gets 15 minutes unless the definition says
  // otherwise — long enough for a real acceptance suite, short enough that a
  // hung one frees the worker's slot the same day.
  commandTimeoutMs: 900000,
  // How long the runner follows a review dispatch before calling the gate
  // unreviewed. A review is an ordinary dispatched run, so this is the same
  // order as the loop's own run watchdog, not a network timeout.
  reviewAwaitMs: 3600000,
  // A human gate waits a day by default, polling every minute: an approval is
  // a person's working-hours act, and a worker that gave up in 30s would file
  // an approval item nobody could ever answer in time.
  approvalTimeoutMs: 86400000,
  approvalPollMs: 60000,
  // Fix cycles per gate. ZERO by default: re-dispatching an implementer at
  // work it already called done is a real cost, so a factory opts INTO it.
  cycles: 0,
  // Suite RERUNS per command gate (and per integration candidate suite)
  // before a failure counts. ZERO by default: a rerun hides a genuine
  // intermittent defect one more time, so a factory whose full suite is
  // known to flake under load opts INTO it (task-spor-factory-spor-flaky-
  // command-gate-needs-fix-cycle-or-rerun). A rerun is the SAME command on
  // the SAME tree — it costs a suite run, never a fix dispatch, and a pass
  // it produces is recorded WITH the first failure's evidence so the flake
  // stays visible in the gate telemetry instead of laundering into a clean
  // pass. Capped small: three reruns of a suite that keeps failing is a
  // defect, not a flake.
  reruns: 0,
  maxReruns: 3,
  trustedRef: "main",
  // The rescue lane (task-spor-factory-rescue-lane): ONE rescue attempt per
  // pipeline by default, followed for the same order of time as a review.
  rescueAttempts: 1,
  rescueAwaitMs: 3600000,
});

// What a rescue agent may say went wrong (task-spor-factory-rescue-lane). The
// four the task named, plus `unknown` for a diagnosis the runner could not
// read — the escalation still opens with whatever prose it did get.
const RESCUE_CATEGORIES = Object.freeze(["reviewer-drift", "real-defect", "stale-premise", "environment", "unknown"]);

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function arr(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim());
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

function intOr(v, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

// The first fenced ```json block in a node body — the same payload convention
// schema nodes use (references/authoring-schemas.md), so a factory reads like
// every other declarative node in the graph.
const FENCE_RE = /^```(\w+)?[^\S\r\n]*\r?\n([\s\S]*?)^```[^\S\r\n]*$/gm;
function fencedJson(body) {
  FENCE_RE.lastIndex = 0;
  let m;
  while ((m = FENCE_RE.exec(String(body || ""))) !== null) {
    const [, lang, src] = m;
    if ((lang || "").toLowerCase() !== "json") continue;
    try {
      return { ok: true, payload: JSON.parse(src) };
    } catch (e) {
      return { ok: false, error: `payload json block does not parse: ${String((e && e.message) || e)}` };
    }
  }
  return { ok: false, error: "no fenced ```json payload block in body" };
}

// Normalize ONE gate object — inline or unwrapped from a referenced gate node.
// Returns {gate, errors}; a gate with errors is never handed to the runner,
// because a factory whose gates don't parse must refuse loudly rather than let
// a worker run ungated (that is the whole point of enforcement in code).
function normalizeGate(raw, { index = 0, source = "inline" } = {}) {
  const errors = [];
  const at = `gate[${index}]`;
  if (!isPlainObject(raw)) return { gate: null, errors: [`${at}: must be a JSON object`] };
  const kind = String(raw.kind || "").trim().toLowerCase();
  if (!GATE_KINDS.includes(kind)) {
    errors.push(`${at}: kind '${raw.kind || ""}' must be one of: ${GATE_KINDS.join(", ")}`);
  }
  const id = String(raw.id || "").trim() || (source !== "inline" ? String(source).replace(/^gate-/, "") : `${kind || "gate"}-${index + 1}`);
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) errors.push(`${at}: id '${id}' must be kebab-case`);
  // A gate id becomes part of every node this gate mints; refuse a pathological
  // one at parse time rather than failing the write that carries the verdict.
  else if (id.length > 48) errors.push(`${at}: id '${id.slice(0, 24)}…' is ${id.length} chars — keep a gate id under 48`);

  const gate = {
    id,
    kind,
    source, // "inline" or the shareable gate node's id — provenance for the recorded fact
    cycles: intOr(raw.cycles, GATE_DEFAULTS.cycles, { max: 10 }),
    title: typeof raw.title === "string" ? raw.title.trim() : "",
  };

  if (kind === "command") {
    gate.command = typeof raw.command === "string" ? raw.command.trim() : "";
    if (!gate.command) errors.push(`${at}: a command gate needs a 'command'`);
    gate.timeoutMs = intOr(raw.timeout_ms, GATE_DEFAULTS.commandTimeoutMs, { min: 1000 });
    // Bounded same-tree reruns before a failure is charged (see GATE_DEFAULTS).
    gate.reruns = intOr(raw.reruns, GATE_DEFAULTS.reruns, { max: GATE_DEFAULTS.maxReruns });
    // A command gate runs the suite from the TRUSTED ref by construction (see
    // the runner); `dir` only says WHERE inside that tree, never which tree.
    gate.dir = typeof raw.dir === "string" ? raw.dir.trim() : "";
    // Risk classes ARM a command gate exactly as they arm a human one
    // (task-spor-command-gate-risk-arming): empty means "every change", a
    // non-empty list means the suite runs only when the change touched one of
    // those classes — a 30-minute database suite need not run for a CSS fix.
    gate.risk = arr(raw.risk !== undefined ? raw.risk : raw.risk_classes);
    // `serialize: repo` — this gate's suite owns a singleton per box (a local
    // database stack on a fixed port) and must never run twice at once for
    // the same repo (task-spor-gate-serialize-lease). The only scope, same
    // as integration.serialize.
    const serialize = raw.serialize == null ? "" : String(raw.serialize).trim().toLowerCase();
    if (serialize && serialize !== "repo") errors.push(`${at}: serialize '${raw.serialize}' must be 'repo' — the only declared lease scope`);
    gate.serialize = serialize === "repo" ? "repo" : null;
  } else if (kind === "agent-review") {
    // Profile-routed, and profile-routed ONLY: the profile names the review
    // lane (a cross-model one, by convention), and the machine's own declared
    // binding decides what that actually executes — a graph write must never
    // define what a box runs (dec-spor-declarative-harness-machine-binds-
    // execution). So there is deliberately no command/argv key here.
    gate.profile = String(raw.profile || "").trim();
    if (!gate.profile) errors.push(`${at}: an agent-review gate needs a 'profile' to route the review to`);
    gate.instructions = typeof raw.instructions === "string" ? raw.instructions.trim() : "";
    gate.awaitMs = intOr(raw.await_ms, GATE_DEFAULTS.reviewAwaitMs, { min: 1000 });
  } else if (kind === "human") {
    // Risk classes ARM the gate: an empty list means "always", a non-empty one
    // means the gate only applies when the change touched one of those classes.
    gate.risk = arr(raw.risk !== undefined ? raw.risk : raw.risk_classes);
    gate.approvalTimeoutMs = intOr(raw.approval_timeout_ms, GATE_DEFAULTS.approvalTimeoutMs, { min: 0 });
    gate.pollMs = intOr(raw.poll_ms, GATE_DEFAULTS.approvalPollMs, { min: 1000 });
    gate.instructions = typeof raw.instructions === "string" ? raw.instructions.trim() : "";
  }
  return { gate: errors.length ? null : gate, errors };
}

// Parse the `integration:` block. Absent is not an error — it means "no
// integration declared", the bare-adoption path (dec-spor-work-v1-bare-
// execution): `{integration: null, errors: []}`. Present-but-malformed IS an
// error, exactly like a gate — a factory that declares integration but gets it
// wrong must refuse to start the worker, not silently run bare.
function parseIntegration(payload) {
  if (!isPlainObject(payload) || payload.integration === undefined || payload.integration === null) {
    return { integration: null, errors: [] };
  }
  const raw = payload.integration;
  if (!isPlainObject(raw)) return { integration: null, errors: ["integration: must be a JSON object"] };
  const errors = [];

  const mode = String(raw.mode || "local").trim().toLowerCase();
  if (!INTEGRATION_MODES.includes(mode)) {
    errors.push(`integration.mode '${raw.mode}' must be one of: ${INTEGRATION_MODES.join(", ")}`);
  }

  // Defaults to the SAME source `factory.trustedRef` is built from (below in
  // parseFactory) — the whole point of "landed" defaulting to "trusted" is
  // that a factory declaring a non-default trusted_ref (e.g. "develop") gets
  // an integration stage that lands onto that ref too, not silently onto the
  // hardcoded fallback.
  const targetRef = String(raw.target_ref || "").trim() || String(payload.trusted_ref || "").trim() || GATE_DEFAULTS.trustedRef;

  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  if (!command) errors.push("integration.command is required — the FULL suite to run on the merged candidate tree");

  const strategy = String(raw.strategy || "merge").trim().toLowerCase();
  if (!INTEGRATION_STRATEGIES.includes(strategy)) {
    errors.push(`integration.strategy '${raw.strategy}' must be one of: ${INTEGRATION_STRATEGIES.join(", ")}`);
  }

  const serialize = String(raw.serialize || "repo").trim().toLowerCase();
  if (serialize !== "repo") errors.push(`integration.serialize '${raw.serialize}' must be 'repo' — the only declared lease scope`);

  const cycles = intOr(raw.cycles, GATE_DEFAULTS.cycles, { max: 10 });
  const timeoutMs = intOr(raw.timeout_ms, GATE_DEFAULTS.commandTimeoutMs, { min: 1000 });
  // The candidate suite gets the same bounded rerun a command gate does: a
  // flake on the merged tree is the same flake, and a fix cycle at it is the
  // same waste.
  const reruns = intOr(raw.reruns, GATE_DEFAULTS.reruns, { max: GATE_DEFAULTS.maxReruns });

  const integration = errors.length ? null : { targetRef, mode, command, strategy, serialize, cycles, timeoutMs, reruns };
  return { integration, errors };
}

// Parse the `rescue:` block (task-spor-factory-rescue-lane). Absent is not
// an error — it means "no rescue lane", and a factory without one behaves
// byte-identically to before the lane existed: `{rescue: null, errors: []}`.
// Present-but-malformed IS an error, exactly like a gate — a factory that
// declares a rescue but gets it wrong must refuse to start the worker.
//
// It is FACTORY-level rather than per-gate, so one rescue covers every
// gate's exhaustion: when any gate has spent its fix cycles (or refused
// unretried for a reason that is not already a person's item), the runner
// dispatches the declared strong-model profile at the refusal BEFORE the
// human escalation is filed, re-runs the whole gate list on what it
// committed under a fresh cycle budget, and only escalates — carrying the
// rescue's diagnosis — if that also refuses. Enforcement stays in code: the
// rescue agent diagnoses, fixes and files; it never marks anything passed.
function parseRescue(payload) {
  if (!isPlainObject(payload) || payload.rescue === undefined || payload.rescue === null) {
    return { rescue: null, errors: [] };
  }
  const raw = payload.rescue;
  if (!isPlainObject(raw)) return { rescue: null, errors: ["rescue: must be a JSON object"] };
  const errors = [];
  // Profile-routed, and profile-routed ONLY — the same rule an agent-review
  // gate keeps: the graph names the lane, the machine's own binding decides
  // what runs (dec-spor-declarative-harness-machine-binds-execution).
  const profile = String(raw.profile || "").trim();
  if (!profile) errors.push("rescue.profile is required — the (strong-model) profile the rescue dispatches under");
  // Bounded by construction: a rescue is a full implementer dispatch plus a
  // whole re-run of the gates, so the cap is small and explicit.
  const attempts = intOr(raw.attempts !== undefined ? raw.attempts : raw.max_attempts, GATE_DEFAULTS.rescueAttempts, { min: 1, max: 3 });
  const awaitMs = intOr(raw.await_ms, GATE_DEFAULTS.rescueAwaitMs, { min: 1000 });
  const instructions = typeof raw.instructions === "string" ? raw.instructions.trim() : "";
  const rescue = errors.length ? null : { profile, attempts, awaitMs, instructions };
  return { rescue, errors };
}

// Fold the factory's gate list — inline objects and `{ref: gate-<id>}`
// references alike — into one ordered normalized list. `gateNodes` maps a gate
// node id to its already-extracted payload (the shell fetches them); a
// reference whose node is missing is an ERROR, never a silently dropped gate.
//
// Keys written BESIDE a `ref` override the referenced gate's own (a shared
// `gate-security-review` reused with a tighter `cycles` for one factory);
// `kind` is deliberately overridable too, but a referenced gate that declares
// none still has to get one from somewhere, so the merge is a plain overlay.
function resolveGates(payload, { gateNodes = new Map() } = {}) {
  const errors = [];
  const list = Array.isArray(payload && payload.gates) ? payload.gates : null;
  if (!list) return { gates: [], errors: ["factory payload needs a 'gates' array"] };
  if (!list.length) return { gates: [], errors: ["factory payload declares no gates"] };
  const gates = [];
  const seen = new Set();
  for (const [i, entry] of list.entries()) {
    if (!isPlainObject(entry)) {
      errors.push(`gate[${i}]: must be a JSON object`);
      continue;
    }
    let raw = entry;
    let source = "inline";
    if (entry.ref) {
      const ref = String(entry.ref).trim();
      const referenced = gateNodes.get(ref);
      if (!referenced) {
        errors.push(`gate[${i}]: referenced gate '${ref}' could not be read from the graph`);
        continue;
      }
      if (!isPlainObject(referenced)) {
        errors.push(`gate[${i}]: referenced gate '${ref}' has no JSON payload object`);
        continue;
      }
      const { ref: _ref, ...overrides } = entry;
      raw = { ...referenced, ...overrides };
      source = ref;
    }
    const { gate, errors: gateErrors } = normalizeGate(raw, { index: i, source });
    errors.push(...gateErrors);
    if (!gate) continue;
    if (seen.has(gate.id)) {
      errors.push(`gate[${i}]: duplicate gate id '${gate.id}' — every gate outcome is a distinct graph fact, so ids must be unique`);
      continue;
    }
    seen.add(gate.id);
    gates.push(gate);
  }
  return { gates, errors };
}

// --- repo scope --------------------------------------------------------------

// Which repos a factory may judge (issue-spor-work-scope-union-factory-mismatch).
//
// A queue scope token is deliberately UNION-y: a bare repo slug resolves UP to
// its home-project grouping and unions the members (dec-spor-queue-slug-
// resolves-to-grouping), which is right for a human reading `spor next` and
// wrong for a GATED worker. A factory's command gate and its integration
// command were authored against ONE repo's checkout; handed an item from a
// sibling repo in the same grouping they run anyway, and only agree by luck
// (both repos happening to build with `npm test`). So the scope a pipeline
// judges is DECLARED on the factory, never inferred from whatever token the
// worker was started with.
//
// `repos` names the repos explicitly; undeclared, the factory node's own
// `project:` stamp is the scope. A factory with neither is UNSCOPED and
// behaves exactly as it did before this field existed — the same no-cliff
// posture the rest of the gate pipeline keeps.
function factoryRepos(payload, project, errors) {
  if (payload.repos == null) {
    const own = String(project == null ? "" : project).trim().toLowerCase();
    return own ? [own] : [];
  }
  const list = [...new Set(arr(payload.repos).map((r) => r.toLowerCase()))];
  if (!list.length) {
    // Fail closed on a typo rather than silently widening: an empty/garbage
    // `repos` reads exactly like "judge everything", which is the bug.
    errors.push("'repos' is declared but names no repo — omit it to let this factory judge any repo, or name the repos it may gate");
  }
  return list;
}

// The set of project spellings a declared repo scope accepts. `repos` holds
// repo SLUGS; a `repo-<slug>` node id is tolerated and also admits the slug it
// names, because the two are the same repo written two ways (GRAPH.md "Project
// identity nodes") and an item's own stamp is always the slug form.
//
// The expansion is deliberately ONE-WAY — node id DOWN to slug, never slug up
// to node id. The inverse would make `repos: ["tools"]` silently admit items
// stamped `repo-tools`, which is a different repo whenever one is genuinely
// named that: a fail-OPEN in a guard whose whole job is to fail closed. An
// empty scope is "unscoped".
function repoScope(repos) {
  const set = new Set();
  for (const r of repos || []) {
    const v = String(r == null ? "" : r).trim().toLowerCase();
    if (!v) continue;
    set.add(v);
    if (v.startsWith("repo-") && v.length > "repo-".length) set.add(v.slice("repo-".length));
  }
  return set;
}

// Is a queue item's own `project` stamp inside `scope`? An empty scope admits
// everything (an unscoped factory). An item with NO stamp is outside every
// non-empty scope: a gated worker that cannot tell which repo an item belongs
// to must not run a repo-specific suite against it. Historical stamps that
// resolve through a repo node's `slugs:` aliases are NOT expanded here — the
// scope is compared against the raw stamp, so an alias-stamped item is skipped
// (loudly, naming the fix) rather than gated by the wrong factory; declare the
// alias in `repos` to admit it.
function inRepoScope(project, scope) {
  if (!scope || !scope.size) return true;
  const v = String(project == null ? "" : project).trim().toLowerCase();
  return v ? scope.has(v) : false;
}

// The whole definition: the node's payload plus its resolved gates. `errors`
// non-empty means the worker must REFUSE rather than run ungated. `project` is
// the factory NODE's own project stamp — the default repo scope when the
// payload declares no `repos` (see factoryRepos above).
function parseFactory(body, { gateNodes = new Map(), id = null, project = null } = {}) {
  const parsed = fencedJson(body);
  if (!parsed.ok) return { factory: null, errors: [parsed.error], refs: [] };
  const payload = parsed.payload;
  if (!isPlainObject(payload)) return { factory: null, errors: ["factory payload must be a JSON object"], refs: [] };
  const { gates, errors } = resolveGates(payload, { gateNodes });
  const riskClasses = {};
  if (isPlainObject(payload.risk_classes)) {
    for (const [cls, globs] of Object.entries(payload.risk_classes)) {
      const g = arr(globs);
      if (!g.length) errors.push(`risk_classes['${cls}']: needs at least one path glob`);
      else riskClasses[cls] = g;
    }
  }
  const { integration, errors: integrationErrors } = parseIntegration(payload);
  errors.push(...integrationErrors);
  const { rescue, errors: rescueErrors } = parseRescue(payload);
  errors.push(...rescueErrors);

  const repos = factoryRepos(payload, project, errors);
  const protectedPaths = arr(payload.protected_paths);
  const testLaneProfile = String(payload.test_lane_profile || "").trim();
  if (protectedPaths.length && !testLaneProfile) {
    // Fail-closed routing needs somewhere to route TO. Without a declared lane
    // a protected-path hit could only be dropped on the floor, which is the one
    // outcome "fails closed" must never mean.
    errors.push("protected_paths are declared but 'test_lane_profile' is not — a protected-path hit has no separate lane to route to");
  }
  // Every human gate's risk class must be declared, or it can never arm and the
  // gate is decoration. Caught here rather than at runtime, where a silently
  // never-arming approval gate reads exactly like an approved one.
  for (const g of gates) {
    if (g.kind !== "human" && g.kind !== "command") continue;
    for (const cls of g.risk || []) {
      if (!riskClasses[cls]) errors.push(`gate '${g.id}': risk class '${cls}' is not declared in 'risk_classes'`);
    }
  }
  const factory = {
    id: id || String(payload.factory || "").trim() || null,
    trustedRef: String(payload.trusted_ref || "").trim() || GATE_DEFAULTS.trustedRef,
    repos,
    protectedPaths,
    testLaneProfile,
    riskClasses,
    gates,
    integration,
    rescue,
  };
  return { factory: errors.length ? null : factory, errors, refs: gateRefs(payload) };
}

// Which shareable gate nodes a payload references — read BEFORE parsing, so
// the shell knows what to fetch. Tolerant by design: it runs against a payload
// that may not validate.
function gateRefs(payload) {
  const list = Array.isArray(payload && payload.gates) ? payload.gates : [];
  const refs = [];
  for (const g of list) {
    if (isPlainObject(g) && g.ref && typeof g.ref === "string") refs.push(g.ref.trim());
  }
  return [...new Set(refs.filter(Boolean))];
}

// The refs of a raw node body, without committing to the rest of it parsing.
function factoryRefs(body) {
  const parsed = fencedJson(body);
  return parsed.ok ? gateRefs(parsed.payload) : [];
}

// --- matching ---------------------------------------------------------------

// Which of `paths` match any of `globs` (the coupling matcher's glob dialect,
// shared rather than re-implemented: `**/`, `*`, `?`, a trailing `/` meaning
// the whole subtree).
function matchPaths(paths, globs) {
  const res = arr(globs).map(globToRegExp);
  if (!res.length) return [];
  return (paths || []).filter((p) => typeof p === "string" && res.some((re) => re.test(p)));
}

// The fail-closed check: which changed paths sit under the factory's declared
// PROTECTED test paths. A non-empty answer means the implementer edited the
// tests that judge it — "tests are more accurate than the code under test" only
// holds while the same entity does not author both, so this can never be a
// warning (dec-spor-software-factory-substrate).
function protectedHits(changedPaths, protectedPaths) {
  return matchPaths(changedPaths, protectedPaths);
}

// Which declared risk classes this change touched — what ARMS a human gate.
// Returns [{class, paths}] in declaration order, so the approval item can name
// exactly why it was raised.
function armedRiskClasses(changedPaths, riskClasses, only = []) {
  const wanted = arr(only);
  const out = [];
  for (const [cls, globs] of Object.entries(riskClasses || {})) {
    if (wanted.length && !wanted.includes(cls)) continue;
    const hits = matchPaths(changedPaths, globs);
    if (hits.length) out.push({ class: cls, paths: hits });
  }
  return out;
}

// Is this human gate armed for this change? A gate declaring NO risk classes is
// unconditional (every change needs the approval); one declaring some arms only
// on a match.
function humanGateArmed(gate, changedPaths, riskClasses) {
  if (!(gate.risk || []).length) return { armed: true, classes: [] };
  const classes = armedRiskClasses(changedPaths, riskClasses, gate.risk);
  return { armed: classes.length > 0, classes };
}

// --- the review verdict -----------------------------------------------------

// The ONE blocking severity (task-spor-review-gate-stateful-bounded). A review
// gate is a second opinion on correctness, and the first live runs showed why
// the floor has to be a single word: with `critical`/`high`/`major` all
// counting, every cycle's "major" note re-opened the gate on taste, and the
// goalposts moved with each reviewer's vocabulary. Now a reviewer that wants
// to block says `blocking` — and demonstrates it (below); everything else is
// advisory and recorded, never enforced. Compared lowercased.
const BLOCKING_SEVERITIES = new Set(["blocking"]);
const PASS_WORDS = new Set(["pass", "passed", "approve", "approved", "clean", "no-findings", "none", "ok", "lgtm"]);
const FAIL_WORDS = new Set(["fail", "failed", "changes_requested", "changes-requested", "request-changes", "block", "blocked", "reject", "rejected"]);
// How a reviewer answers a PRIOR finding: cleared (the fix resolved it) or
// confirmed (it still stands). Anything else is not an answer.
const PRIOR_CLEARED = new Set(["resolved", "fixed", "cleared", "clear", "closed", "addressed", "done", "gone"]);
const PRIOR_OPEN = new Set(["open", "unresolved", "confirmed", "confirm", "still-open", "stands", "remains", "persists", "unfixed", "not-fixed"]);

// Read a review agent's STRUCTURED verdict out of its final report — in code,
// never by asking another agent what it meant. The contract asked of the
// reviewer is one fenced ```json block:
//
//   {"verdict": "pass" | "changes_requested",
//    "prior": [{"id": "F1", "status": "resolved" | "open", "note": "..."}],
//    "findings": [{"id": "F3", "severity", "file", "summary", "evidence", "introduced_by_fix"}]}
//
// Tolerances that do not weaken it: the LAST json fence wins (a reviewer that
// quotes the schema before answering), a bare JSON object is accepted, and a
// report with `findings` but no `verdict` passes iff nothing blocks.
//
// The gate is STATEFUL across fix cycles (task-spor-review-gate-stateful-
// bounded): `prior` is the set of blocking findings still open from earlier
// cycles, each with the id the ledger gave it, and the verdict has to answer
// EVERY one of them — cleared or confirmed — before it may raise anything new.
// Three rules, all decided here so the runner has one predicate to apply:
//
//   1. Only `blocking` blocks. A `major`/`minor`/anything-else finding is
//      advisory: recorded on the fact, handed to the fixer as a note, never a
//      reason to fail the gate.
//   2. A blocking finding must be DEMONSTRATED — carry `evidence` naming the
//      command or test the reviewer ran and what it showed. One without it is
//      downgraded to advisory (the note says why), so a reviewer cannot block
//      on a reading of the code alone. On a fix cycle (cycle > 0) a NEW
//      blocking finding must also be one the fix INTRODUCED
//      (`introduced_by_fix: true`): a defect the reviewer could have raised
//      at cycle 0 and did not is not grounds to move the goalposts now — it
//      is recorded as advisory for a person to weigh.
//   3. A verdict that ignores a prior finding — neither clears nor confirms
//      it — is UNREADABLE (`ok: false`), and counts as changes_requested for
//      the PRIOR SET ONLY: the still-open prior findings are the findings the
//      fix cycle gets, and nothing the memoryless verdict raised is admitted.
//   4. A findings list the parser cannot read is never filtered down to a
//      pass: a malformed entry (not an object, or one with no summary) makes
//      the verdict unreadable, and so does an explicit `changes_requested`
//      that carries no findings list at all, or an empty one with no prior
//      finding confirmed open. "Requested changes, said nothing" fails closed.
//   5. An explicit `changes_requested` whose blocking findings were ALL
//      downgraded (rated blocking, demonstrated nothing) is NOT a pass. The
//      reviewer asked for changes and named what it rated blocking; the
//      protocol cannot ENFORCE an undemonstrated finding, but silently
//      laundering that verdict into an approval is the failure mode the
//      second review of this gate caught. It is unreadable — fail closed for
//      the prior set, the downgraded findings recorded as advisory for the
//      fixer and the ledger — and the reviewer is told, next cycle, that it
//      may demonstrate one of them by id (`raised`, below) and have it count
//      as raised at its original cycle rather than as a goalpost.
//
// `raised` is the set of ledger entries rated blocking but undemonstrated
// on an earlier cycle: a fresh finding that names one of those ids AND now
// carries evidence AND describes the same file is an upgrade of a finding
// the reviewer DID raise before, so rule 2's introduced-by-fix floor does not
// apply to it (the upgrade keeps the LEDGER's file and summary — the id names
// that finding, not whatever a later reviewer puts under it).
//
// FAIL-CLOSED is still the rule: an unparseable, absent or unrecognized
// verdict is NOT a pass. A review whose output we cannot read has reviewed
// nothing, and a gate that waves those through is worse than no gate at all.
function parseReviewVerdict(text, { prior = [], cycle = 0, raised = [] } = {}) {
  const raw = String(text || "");
  const priorList = Array.isArray(prior) ? prior.filter(isPlainObject) : [];
  const raisedById = new Map(
    (Array.isArray(raised) ? raised : [])
      .filter((e) => isPlainObject(e) && String(e.id || "").trim())
      .map((e) => [String(e.id).trim(), { file: String(e.file || "").trim(), summary: String(e.summary || "").trim() }])
  );
  // A verdict we cannot read at all — an unrecognized word, no structured
  // verdict anywhere — has answered nothing, so the prior set stands as it
  // was: every prior finding is carried to the fixer still open (review
  // finding 2 on the third cut: these two returns used to hand back an EMPTY
  // findings list, so an unparseable fix-cycle verdict sent the fixer off with
  // nothing to fix and the blocking set silently dropped out of the cycle).
  const unansweredPrior = (why) => priorList.map((p) => ({ ...p, origin: "prior", blocking: true, status: "open", note: `not answered by this review (${why})` }));
  const unreadableVerdict = (verdict, error) => {
    const carried = unansweredPrior(error);
    return { ok: false, passed: false, findings: carried.map((p) => ({ ...p })), prior: carried, verdict, error: `${error}${carried.length ? " — fails closed for the prior set" : ""}` };
  };
  const candidates = [];
  FENCE_RE.lastIndex = 0;
  let m;
  while ((m = FENCE_RE.exec(raw)) !== null) {
    if ((m[1] || "").toLowerCase() === "json") candidates.push(m[2]);
  }
  if (!candidates.length) {
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1));
  }
  for (const src of candidates.reverse()) {
    let obj = null;
    try {
      obj = JSON.parse(src);
    } catch {
      continue;
    }
    if (!isPlainObject(obj)) continue;
    const word = String(obj.verdict || obj.status || obj.result || "").trim().toLowerCase();
    const findingsRaw = Array.isArray(obj.findings) ? obj.findings : null;
    if (word && !PASS_WORDS.has(word) && !FAIL_WORDS.has(word)) {
      return unreadableVerdict(word, `unrecognized verdict '${word}'`);
    }
    if (!word && !findingsRaw) continue;
    // A findings entry we cannot read is not a finding we may drop: it could
    // be the blocking one. Any non-object entry, or one that says nothing
    // (no summary), makes the whole verdict unreadable — fail closed, never
    // "filter the bad ones out and pass on what is left".
    const malformed = (findingsRaw || []).filter((f) => !isPlainObject(f) || !String(f.summary || f.title || f.description || "").trim()).length;

    // Rule 3 first: the prior set is answered before anything new is read.
    const answers = readPriorAnswers(obj, priorList);
    const unanswered = priorList.filter((p) => !answers.has(p.id));
    const carried = priorList.map((p) => ({
      ...p,
      origin: "prior",
      blocking: true,
      note: answers.has(p.id) ? answers.get(p.id).note : "not answered by this review",
      status: answers.has(p.id) && answers.get(p.id).cleared ? "resolved" : "open",
    }));
    const stillOpen = carried.filter((p) => p.status === "open");
    // Rule 4 (review finding 2 on the first cut of this gate): an explicit
    // request for changes has to SAY what to change. `changes_requested` with
    // no findings list, with a list the parser cannot read, or with an empty
    // list and no prior finding confirmed open, is a verdict we cannot act on
    // — it is unreadable, and unreadable is a failure for the prior set only
    // (nothing new is admitted), never a pass laundered out of a filter.
    const requestsChanges = !!word && FAIL_WORDS.has(word);
    let unreadable = null;
    if (malformed) {
      unreadable = `${malformed} of ${findingsRaw.length} findings ${malformed === 1 ? "is" : "are"} malformed (not an object with a summary)`;
    } else if (requestsChanges && !findingsRaw) {
      unreadable = `the review said '${word}' but carried no findings list`;
    } else if (requestsChanges && !findingsRaw.length && !stillOpen.length) {
      unreadable = `the review said '${word}' with an empty findings list and no prior finding confirmed open`;
    }
    if (unreadable) {
      return {
        ok: false,
        passed: false,
        verdict: requestsChanges ? "changes_requested" : word || null,
        findings: stillOpen.map((p) => ({ ...p })),
        prior: carried,
        error: `${unreadable} — the verdict is unreadable and fails closed${stillOpen.length ? " for the prior set" : ""}`,
      };
    }
    if (unanswered.length) {
      return {
        ok: false,
        passed: false,
        verdict: "changes_requested",
        findings: stillOpen.map((p) => ({ ...p })),
        prior: carried,
        unanswered: unanswered.map((p) => p.id),
        error:
          `the review ignored prior finding${unanswered.length === 1 ? "" : "s"} ${unanswered.map((p) => p.id).join(", ")}` +
          ` (neither cleared nor confirmed) — counted as changes_requested for the prior set only`,
      };
    }

    // Rules 1 and 2: what the review raised, classified.
    const priorIds = new Set(priorList.map((p) => p.id));
    const fresh = (findingsRaw || [])
      .map((f) => normalizeFinding(f, cycle, raisedById))
      // A reviewer that lists a prior finding again under `findings` (by id)
      // is answering it, not raising it: the prior answer already carries it.
      .filter((f) => !(f.id && priorIds.has(f.id)));
    const findings = [...stillOpen.map((p) => ({ ...p })), ...fresh];
    const blocking = findings.filter((f) => f.blocking);
    // Rule 5: "changes requested" backed only by undemonstrated blocking
    // findings does not block. The contract is demonstrated-only (the
    // decision this gate implements: evidence required, everything else
    // advisory), and the second cut's fail-closed reading of this case —
    // which charged a fix cycle, and at the cap a person, to findings nobody
    // demonstrated — was the goalpost-moving the contract exists to stop
    // (review finding 1 on the third cut). The downgraded findings ride along
    // as advisory: the ledger records them, the fact shows them, and a later
    // review may still demonstrate one by id.
    const undemonstrated = fresh.filter((f) => BLOCKING_SEVERITIES.has(f.severity) && !f.blocking && !f.evidence);
    if (requestsChanges && !blocking.length && undemonstrated.length) {
      return {
        ok: true,
        passed: true,
        verdict: "pass",
        findings,
        prior: carried,
        undemonstrated: undemonstrated.length,
        note:
          `the review said '${word}' and rated ${undemonstrated.length} finding${undemonstrated.length === 1 ? "" : "s"} blocking but demonstrated none of them` +
          ` (no evidence: no command or test named) — recorded as advisory; only a demonstrated blocking finding fails the gate`,
      };
    }
    if (word && PASS_WORDS.has(word) && blocking.length) {
      // A "pass" carrying its own blocking findings is the commonest way a
      // reviewer contradicts itself, and taking the word over the evidence is
      // exactly the laundering this parser exists to prevent. The findings win.
      return {
        ok: true,
        passed: false,
        findings,
        prior: carried,
        verdict: "changes_requested",
        error: `the review said '${word}' while ${blocking.length === 1 ? "a blocking finding stands" : `${blocking.length} blocking findings stand`}`,
      };
    }
    // The mirror: a "changes_requested" with nothing that blocks is a pass
    // with notes — blocking is the only blocking class (rule 1), and the
    // reviewer's word does not outrank the floor either way.
    return {
      ok: true,
      passed: blocking.length === 0,
      findings,
      prior: carried,
      verdict: blocking.length ? "changes_requested" : (word && PASS_WORDS.has(word) ? word : "pass"),
      ...(word && FAIL_WORDS.has(word) && !blocking.length
        ? { note: `the review said '${word}' but rated nothing blocking (or demonstrated nothing it rated blocking) — advisory findings do not fail the gate` }
        : {}),
    };
  }
  return unreadableVerdict(null, "no structured verdict found in the review report");
}

// The reviewer's answers to the prior set: `prior` as a list of
// {id, status, note}, or as an object keyed by id. Only a recognized status
// is an answer; an unrecognized one leaves the finding unanswered (rule 3).
function readPriorAnswers(obj, priorList) {
  const answers = new Map();
  const known = new Set(priorList.map((p) => p.id));
  const put = (id, status, note) => {
    const key = String(id || "").trim();
    const s = String(status || "").trim().toLowerCase();
    if (!known.has(key)) return;
    if (PRIOR_CLEARED.has(s)) answers.set(key, { cleared: true, note: String(note || "").trim() || "cleared by the review" });
    else if (PRIOR_OPEN.has(s)) answers.set(key, { cleared: false, note: String(note || "").trim() || "confirmed still open by the review" });
  };
  const raw = obj.prior !== undefined ? obj.prior : obj.prior_findings;
  if (Array.isArray(raw)) {
    for (const p of raw) {
      if (isPlainObject(p)) put(p.id || p.ref, p.status || p.state || p.verdict, p.note || p.reason || p.summary);
    }
  } else if (isPlainObject(raw)) {
    for (const [id, v] of Object.entries(raw)) {
      if (isPlainObject(v)) put(id, v.status || v.state || v.verdict, v.note || v.reason);
      else put(id, v, "");
    }
  }
  return answers;
}

// One raised finding, classified against rules 1 and 2. `blocking` is the
// decided predicate; `note` says why a declared-blocking finding did not
// qualify, so the fact and the fixer both see the downgrade rather than a
// silent disappearance.
// What counts as evidence: a non-empty STRING naming what was run. A boolean
// `true`, a number, an object, or a bare affirmation ("yes", "true", "n/a")
// is not a demonstration — it used to be stringified and pass the `!evidence`
// check (review finding 2 on the third cut), which made `evidence: true` a
// one-token key to the blocking floor.
const EVIDENCE_NOISE = new Set(["true", "yes", "y", "ok", "done", "n/a", "na", "none", "null", "undefined", "-", "tbd", "todo", "see above", "as above"]);
function evidenceText(f) {
  for (const key of ["evidence", "reproduction", "repro", "demonstrated_by"]) {
    const v = f[key];
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (!t || EVIDENCE_NOISE.has(t.toLowerCase())) continue;
    return t;
  }
  return "";
}

function normalizeFinding(f, cycle, raised = new Map()) {
  const severity = String(f.severity || "").trim().toLowerCase() || "unspecified";
  const evidence = evidenceText(f);
  const raisedById = raised instanceof Map ? raised : new Map([...(raised || [])].map((id) => [id, {}]));
  const introducedRaw = f.introduced_by_fix !== undefined ? f.introduced_by_fix : f.caused_by_fix !== undefined ? f.caused_by_fix : f.introduced;
  const introduced = introducedRaw === true || String(introducedRaw || "").trim().toLowerCase() === "true" || String(introducedRaw || "").trim().toLowerCase() === "yes";
  const out = {
    id: String(f.id || f.ref || "").trim() || null,
    severity,
    file: String(f.file || f.path || "").trim(),
    summary: String(f.summary || f.title || f.description || "").trim(),
    evidence,
    introduced,
    origin: "new",
    status: "open",
    blocking: false,
    note: null,
  };
  // Naming an earlier undemonstrated finding by id is an UPGRADE only if it
  // is the same finding: the ledger entry's file (when it has one) must match.
  // Otherwise the id is a name borrowed for a different defect — a way past
  // the introduced-by-fix floor, and a corruption of the ledger's identity
  // (review finding 3 on the third cut) — so it is stripped and the finding is
  // read as the new one it is. A genuine upgrade takes its identity FROM the
  // ledger (file and summary), keeping the reviewer's wording as a restatement.
  let upgrade = null;
  if (out.id && raisedById.has(out.id)) {
    const entry = raisedById.get(out.id) || {};
    const entryFile = String(entry.file || "").trim();
    if (entryFile && out.file && entryFile !== out.file) {
      out.note = `named ${out.id} but describes ${out.file}, not ${entryFile} — not an upgrade of that finding; read as a new one`;
      out.id = null;
    } else {
      upgrade = entry;
      if (entry.summary && out.summary !== entry.summary) out.restated = out.summary;
      if (entry.summary) out.summary = entry.summary;
      if (entryFile) out.file = entryFile;
    }
  }
  if (!BLOCKING_SEVERITIES.has(severity)) return out;
  if (!evidence) {
    out.note = [out.note, "rated blocking without evidence (no command or test demonstrated it) — recorded as advisory"].filter(Boolean).join("; ");
    return out;
  }
  if (cycle > 0 && !introduced && !upgrade) {
    out.note = [out.note, "rated blocking on a fix cycle but not introduced by the fix — a finding available at the first review does not move the goalposts; recorded as advisory"].filter(Boolean).join("; ");
    return out;
  }
  if (cycle > 0 && !introduced) out.note = "raised undemonstrated on an earlier cycle, now demonstrated — counts as raised then, not as a goalpost";
  out.blocking = true;
  return out;
}

// --- the rescue report ------------------------------------------------------

// Read a rescue agent's STRUCTURED diagnosis out of its final report — in
// code, like a review verdict. The contract asked of the rescue is one fenced
// ```json block:
//
//   {"diagnosis": "what went wrong, in a sentence or two",
//    "category": "reviewer-drift" | "real-defect" | "stale-premise" | "environment",
//    "fixed": true | false,
//    "filed": ["task-…"]}
//
// Nothing here decides a verdict: whatever the rescue says, the runner re-runs
// the gates on the tree it left and reads the outcome from the run record.
// This read only feeds the escalation body (the diagnosis it opens with) and
// the rescue fact (what the rescue filed). So it is deliberately TOLERANT —
// the LAST json fence carrying a `diagnosis` wins, a bare object is accepted,
// an unknown category reads `unknown` — and an unreadable report is
// `ok: false` with whatever prose could be salvaged, never a failure of the
// pipeline: a rescue that fixed the tree and forgot the block still gets its
// fix judged.
function parseRescueReport(text) {
  const raw = String(text || "");
  const candidates = [];
  FENCE_RE.lastIndex = 0;
  let m;
  while ((m = FENCE_RE.exec(raw)) !== null) {
    if ((m[1] || "").toLowerCase() === "json") candidates.push(m[2]);
  }
  if (!candidates.length) {
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1));
  }
  for (const src of candidates.reverse()) {
    let obj = null;
    try {
      obj = JSON.parse(src);
    } catch {
      continue;
    }
    if (!isPlainObject(obj)) continue;
    const diagnosis = String(obj.diagnosis || obj.summary || "").replace(/\s+/g, " ").trim();
    if (!diagnosis) continue;
    const cat = String(obj.category || obj.cause || "").trim().toLowerCase().replace(/[\s_]+/g, "-");
    const fixedRaw = obj.fixed !== undefined ? obj.fixed : obj.landed;
    const filed = arr(obj.filed !== undefined ? obj.filed : obj.tasks).filter((id) => /^[a-z0-9][a-z0-9-]*$/.test(id));
    return {
      ok: true,
      diagnosis,
      category: RESCUE_CATEGORIES.includes(cat) ? cat : "unknown",
      fixed: fixedRaw === true || String(fixedRaw || "").trim().toLowerCase() === "true" || String(fixedRaw || "").trim().toLowerCase() === "yes",
      filed,
    };
  }
  // No structured block: keep the tail of the prose as the diagnosis so the
  // escalation still says what the rescue thought, marked as unread.
  const tail = raw.replace(/\s+/g, " ").trim();
  return {
    ok: false,
    diagnosis: tail ? (tail.length > 600 ? `…${tail.slice(-599)}` : tail) : "",
    category: "unknown",
    fixed: false,
    filed: [],
    error: tail ? "no structured diagnosis (fenced json with a `diagnosis`) in the rescue report" : "the rescue left no report",
  };
}

// --- the finding ledger -----------------------------------------------------

// The running record of every finding a gate's cycles raised, in one place:
// what was raised when, what cleared it, what still stands. Pure data, folded
// by `applyReviewToLedger` after every verdict, and:
//   - its OPEN BLOCKING entries are the `prior` set the next review must answer;
//   - it is what the art-gate fact records, so the rescue lane and /spor:factory
//     telemetry can read convergence per gate without re-reading every report.
// Ids are `F<n>`, assigned in the order findings were first raised and never
// reused, so a reviewer's answer names one finding unambiguously.
function openPriorFindings(ledger) {
  return (ledger || []).filter((e) => e.blocking && e.status === "open").map((e) => ({ id: e.id, severity: e.severity, file: e.file, summary: e.summary, evidence: e.evidence || "", opened: e.opened }));
}

// The ledger entries a later reviewer may still DEMONSTRATE: rated blocking
// on an earlier cycle but recorded advisory for want of evidence. Handed to
// parseReviewVerdict as `raised` so an upgrade by id is not a goalpost.
function raisedUndemonstrated(ledger) {
  return (ledger || [])
    .filter((e) => e.status === "advisory" && BLOCKING_SEVERITIES.has(String(e.severity || "").toLowerCase()) && !e.evidence)
    .map((e) => ({ id: e.id, severity: e.severity, file: e.file, summary: e.summary, opened: e.opened }));
}

// An existing entry this cycle is about to change keeps what it looked like
// BEFORE the change (one snapshot per cycle, taken on first touch), so
// `rollbackCycle` can restore it exactly — including the evidence an upgrade
// wrote over an advisory entry's empty one (review finding 3 on the third cut:
// the rollback reset status/blocking/demonstrated but left that evidence
// behind, so the rolled-back entry no longer read as undemonstrated and the
// redo's reviewer could not demonstrate it by id).
function snapshotBefore(e, cycle) {
  if (e.prev && e.prev.cycle === cycle) return;
  e.prev = {
    cycle,
    status: e.status,
    blocking: !!e.blocking,
    evidence: e.evidence || "",
    note: e.note || null,
    closed: e.closed === undefined ? null : e.closed,
    demonstrated: e.demonstrated === undefined ? null : e.demonstrated,
    answered: e.answered === undefined ? null : e.answered,
    // An earlier cycle's snapshot rides inside this one, so restoring this
    // cycle puts that one back where a further rollback can find it.
    prev: e.prev || null,
  };
}

// The one case a fresh finding may keep the id the reviewer gave it: it names
// an ADVISORY ledger entry (an upgrade of a finding raised earlier). Shared by
// the fold and `withLedgerIds`, which must agree on which findings mint.
function keepsReviewerId(f, advisoryIds) {
  return f.origin === "prior" || !!(f.id && advisoryIds.has(f.id));
}

function advisoryIdSet(ledger) {
  return new Set((ledger || []).filter((e) => e.status === "advisory").map((e) => e.id));
}

function applyReviewToLedger(ledger, verdict, cycle) {
  const out = (ledger || []).map((e) => ({ ...e }));
  const byId = new Map(out.map((e) => [e.id, e]));
  const advisoryIds = advisoryIdSet(out);
  for (const p of (verdict && verdict.prior) || []) {
    const e = byId.get(p.id);
    if (!e) continue;
    snapshotBefore(e, cycle);
    if (p.status === "resolved" && e.status === "open") {
      e.status = "resolved";
      e.closed = cycle;
    }
    e.note = p.note || e.note || null;
    e.answered = cycle;
  }
  for (const f of (verdict && verdict.findings) || []) {
    if (f.origin === "prior") continue;
    // A fresh finding naming an existing ADVISORY entry by id is an upgrade
    // of that entry (the reviewer demonstrated, this cycle, what it could
    // only argue before), never a second entry under a second name.
    const existing = keepsReviewerId(f, advisoryIds) ? byId.get(f.id) : null;
    if (existing) {
      snapshotBefore(existing, cycle);
      if (f.evidence) existing.evidence = f.evidence;
      if (f.blocking) {
        existing.blocking = true;
        existing.status = "open";
        existing.demonstrated = cycle;
      }
      // The entry's file and summary are its identity and stay; a reviewer's
      // different wording is kept beside them, never over them.
      if (f.restated) existing.restated = f.restated;
      existing.note = f.note || existing.note || null;
      continue;
    }
    // A fresh finding that REUSES the id of a resolved (or open) entry is not
    // that entry — it is a new finding under a name that is already taken
    // (review finding 4 on the third cut: it used to be dropped on the floor,
    // so a demonstrated blocking finding vanished from the ledger and from
    // the next review's prior set). It mints like any other new finding; the
    // reused name is kept in the note so the fact says what happened.
    const reused = f.id && byId.has(f.id) ? f.id : null;
    const id = `F${out.length + 1}`;
    out.push({
      id,
      severity: f.severity,
      file: f.file,
      summary: f.summary,
      evidence: f.evidence || "",
      introduced: !!f.introduced,
      blocking: !!f.blocking,
      status: f.blocking ? "open" : "advisory",
      note: [f.note, reused ? `raised under the already-used ledger id ${reused}; recorded as ${id}` : null].filter(Boolean).join("; ") || null,
      opened: cycle,
      closed: null,
    });
    byId.set(id, out[out.length - 1]);
  }
  return out;
}

// The verdict's findings with the ids the ledger just minted for them (a new
// finding has no id until it is folded), so the fix cycle and the fact talk
// about a finding by the same name the next review will be asked about.
// `before` is the ledger BEFORE the fold: the minted entries are exactly the
// ones appended past its length. (Review finding 3 on the second cut: keyed
// by `opened === cycle` this handed a re-run review's new finding the id of
// an entry an earlier attempt at the SAME cycle had minted, so the fixer's
// prompt and the durable ledger disagreed about which finding was which.)
// The older `(findings, ledger, cycle)` call shape still works — a number in
// the third position falls back to the opened-at-cycle read.
function withLedgerIds(findings, ledger, before) {
  const list = ledger || [];
  const minted = Array.isArray(before) ? list.slice(before.length) : list.filter((e) => e.opened === before);
  // Only an upgrade of an ADVISORY entry keeps the reviewer's id — the same
  // predicate the fold used, so the minted ids line up finding for finding.
  // A reviewer-invented id, or one that reuses a resolved entry's name, is
  // not a name the fixer or the next review can use: the minted one replaces
  // it. (In the legacy by-cycle shape the pre-fold ledger is unknown, so an
  // entry upgraded AT that cycle counts as advisory-before.)
  const advisoryIds = Array.isArray(before)
    ? advisoryIdSet(before)
    : new Set(list.filter((e) => e.status === "advisory" || e.demonstrated === before).map((e) => e.id));
  let i = 0;
  return (findings || []).map((f) => {
    if (keepsReviewerId(f, advisoryIds)) return f;
    const e = minted[i++];
    return e ? { ...f, id: e.id } : f;
  });
}

// Undo everything one review cycle folded into the ledger — the entries it
// minted are dropped, the prior findings it answered reopen — so a pipeline
// that resumes AT that cycle (the review ran, the worker died before the
// next step was durably decided) re-runs the review against the same ledger
// the first attempt saw, instead of a ledger that already carries the first
// attempt's answers and findings under ids the redo would then re-mint.
function rollbackCycle(ledger, cycle) {
  return (ledger || [])
    .filter((e) => e.opened !== cycle)
    .map((e) => {
      const out = { ...e };
      if (out.prev && out.prev.cycle === cycle) {
        // The fold's own snapshot of the entry before this cycle touched it —
        // exact, evidence and note included.
        const { cycle: _c, prev: older, ...was } = out.prev;
        Object.assign(out, was);
        if (older) out.prev = older;
        else delete out.prev;
        return out;
      }
      // A ledger folded before snapshots existed: undo field by field. An
      // upgrade's evidence goes with it — an entry demonstrated this cycle was
      // undemonstrated before it (that is what made it upgradable by id).
      if (out.closed === cycle) {
        out.status = "open";
        out.closed = null;
      }
      if (out.demonstrated === cycle) {
        out.status = "advisory";
        out.blocking = false;
        out.demonstrated = null;
        out.evidence = "";
      }
      if (out.answered === cycle) out.answered = null;
      return out;
    });
}

// One line per finding, for the fix-cycle prompt and the recorded fact. The
// ledger id leads when there is one so a fixer and a later reviewer talk
// about the same finding by the same name; a downgraded finding says so.
function renderFindings(findings, cap = 20, lineCap = 240) {
  const list = findings || [];
  const lines = list
    .slice(0, cap)
    .map((f, i) => {
      const tag = f.blocking === false && f.note ? `${f.severity || "unspecified"}, advisory` : f.severity || "unspecified";
      const line = `${f.id ? `${f.id} ` : `${i + 1}. `}[${tag}] ${f.file ? `${f.file} — ` : ""}${f.summary || "(no summary)"}${f.note ? ` (${f.note})` : ""}`.replace(/\s+/g, " ");
      return line.length > lineCap ? `${line.slice(0, lineCap - 1)}…` : line;
    });
  if (list.length > cap) lines.push(`…and ${list.length - cap} more`);
  return lines.join("\n");
}

// The ledger, one line per entry: `F2 [blocking] open since cycle 0 — file — summary`.
function renderLedger(ledger, cap = 40, lineCap = 240) {
  const list = ledger || [];
  const lines = list.slice(0, cap).map((e) => {
    const state =
      e.status === "resolved" ? `resolved at cycle ${e.closed}` : e.status === "advisory" ? `advisory (cycle ${e.opened})` : `OPEN since cycle ${e.opened}`;
    const line = `${e.id} [${e.severity}] ${state} — ${e.file ? `${e.file} — ` : ""}${e.summary || "(no summary)"}${e.note && e.status !== "open" ? ` (${e.note})` : ""}`.replace(/\s+/g, " ");
    return line.length > lineCap ? `${line.slice(0, lineCap - 1)}…` : line;
  });
  if (list.length > cap) lines.push(`…and ${list.length - cap} more`);
  return lines.join("\n");
}

// The durable-debt checklist (task-spor-review-gate-durable-debt-flag-
// checklist). A retry/debt FLAG — a `gate_*_pending` field on a run record, a
// journal line, a cooldown file, an outbox entry: anything one pass writes so
// a later pass owes an action — has a fixed set of failure modes, and the
// first live run that shipped one spent every fix cycle discovering them ONE
// PER CYCLE (F2 the retry, F3 the closed tracker, F4 the check-then-write
// race, F5 the non-atomic pair of writes), exhausting the cap on a single
// design walked a step at a time. So the table is stated once, here, and
// rendered into all three prompts that meet such a flag: the reviewer is
// asked to walk every row and file every open one in ONE verdict, and the
// implementer and the fixer are asked to design against the same rows up
// front and say so in the commit message. Prose only — nothing parses it.
const DURABLE_FLAG_FAILURE_MODES = Object.freeze([
  Object.freeze({ key: "write-fails", label: "the flag write itself fails", detail: "the stamp is best-effort or returns without landing — is the debt still owed, and by what, when the write that records it did not happen?" }),
  Object.freeze({ key: "clear-before-owe", label: "clear-before-owe ordering and the crash window", detail: "clearing one flag and owing the next as two writes — a crash between them, or a failed second write, loses the debt; owe first or write both in one stamp" }),
  Object.freeze({ key: "check-then-write", label: "the check-then-write race", detail: "another actor (a second worker, the heal pass, a resumed pipeline) reads or settles the same state between the check and the write" }),
  Object.freeze({ key: "stale-flag", label: "a stale flag against already-settled state", detail: "a later pass finds the flag but what it guards is already resolved, closed or superseded — the flag must reconcile against the settled state, not act on it blindly" }),
]);

// The table as prompt lines, one row each (`(a)`..`(d)`), so every prompt
// names the rows the same way and a reviewer, a fixer and a commit message
// can refer to "row (c)" and mean the same thing.
function renderDurableFlagChecklist({ indent = "" } = {}) {
  return DURABLE_FLAG_FAILURE_MODES.map((m, i) => `${indent}(${String.fromCharCode(97 + i)}) ${m.label} — ${m.detail}`).join("\n");
}

// After a failed cycle: is there another fix cycle left, or is this the
// escalation? `cycle` is 0-based and counts REVIEWS: cycle 0 is the initial
// review, cycle N the review after the Nth fix. So `cycles: 3` is exactly
// three fix dispatches — reviews 0..3, fixes after 0, 1 and 2 — and the
// escalation reads "3 fix cycles", never "4 attempts" (the off-by-one the
// first live run's escalation body reported, counting reviews as cycles).
function cycleDecision(gate, cycle) {
  return cycle < cycleCap(gate) ? "retry" : "escalate";
}

// The declared fix-cycle cap, normalized the way the loop reads it.
function cycleCap(gate) {
  return intOr(gate && gate.cycles, 0, { max: 10 });
}

// The declared same-tree rerun budget of a command gate or an integration
// block, normalized the same way — a hand-built definition (a test fixture,
// an older run record) with no `reruns` reads as zero, byte-identical to
// before the knob existed.
function rerunCap(def) {
  return intOr(def && def.reruns, GATE_DEFAULTS.reruns, { max: GATE_DEFAULTS.maxReruns });
}

// After a failed suite attempt: run it again on the same tree, or charge the
// failure? `attempt` is 1-based — attempt 1 is the declared run, attempt N+1
// the Nth rerun — so `reruns: 1` is exactly two runs of the suite.
function rerunDecision(def, attempt) {
  return attempt <= rerunCap(def) ? "rerun" : "charge";
}

// How a rerun-rescued pass reads on the fact and in the log: the outcome
// names the attempt that passed AND the failure before it, so a person
// reading gate telemetry can count the flakes rather than the passes.
function describeRerun(command, attempt, firstFailure) {
  const reruns = attempt - 1;
  return `\`${command}\` passed on rerun ${reruns} of the same tree after failing (${firstFailure || "no reason recorded"}) — a flake by the gate's own rerun rule, not a fix; the first attempt's failure is recorded as evidence`;
}

// How an EXHAUSTED rerun budget reads: the failure is charged once, but its
// outcome says how many runs of the one tree it failed, so a fact — a gate's
// or the integration stage's — never reads like a single unlucky run when
// the suite was in fact given every declared chance. `runs` is the total
// (the declared run plus every rerun); with no rerun the reason stands alone.
function describeRerunsExhausted(reason, runs) {
  const r = reason || "the suite failed";
  if (!(runs > 1)) return r;
  const reruns = runs - 1;
  return `${r} — on every one of ${runs} runs of the same tree (${reruns} rerun${reruns === 1 ? "" : "s"} declared)`;
}

// How a gate's attempt history reads to a person: `attempts` is one entry per
// REVIEW (or suite run), so the fix cycles it consumed are one fewer.
function describeCycles(gate, attempts) {
  const reviews = (attempts || []).length;
  const fixes = Math.max(0, reviews - 1);
  const cap = cycleCap(gate);
  return { reviews, fixes, cap, text: `${reviews} ${reviews === 1 ? "attempt" : "attempts"}: the initial one plus ${fixes} fix ${fixes === 1 ? "cycle" : "cycles"}, cap ${cap}` };
}

module.exports = {
  GATE_KINDS,
  GATE_DEFAULTS,
  SETTLED_GATE_STATES,
  INTEGRATION_MODES,
  INTEGRATION_STRATEGIES,
  fencedJson,
  normalizeGate,
  resolveGates,
  parseIntegration,
  parseRescue,
  parseFactory,
  repoScope,
  inRepoScope,
  factoryRefs,
  gateRefs,
  BLOCKING_SEVERITIES,
  matchPaths,
  protectedHits,
  armedRiskClasses,
  humanGateArmed,
  // The same predicate, under the name that fits both kinds it now serves.
  gateArmed: humanGateArmed,
  parseReviewVerdict,
  RESCUE_CATEGORIES,
  parseRescueReport,
  renderFindings,
  renderLedger,
  openPriorFindings,
  raisedUndemonstrated,
  applyReviewToLedger,
  withLedgerIds,
  rollbackCycle,
  cycleDecision,
  cycleCap,
  describeCycles,
  rerunCap,
  rerunDecision,
  describeRerun,
  describeRerunsExhausted,
  DURABLE_FLAG_FAILURE_MODES,
  renderDurableFlagChecklist,
};

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
const SETTLED_GATE_STATES = new Set(["passed", "failed", "blocked", "parked"]);

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
  trustedRef: "main",
});

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
    // A command gate runs the suite from the TRUSTED ref by construction (see
    // the runner); `dir` only says WHERE inside that tree, never which tree.
    gate.dir = typeof raw.dir === "string" ? raw.dir.trim() : "";
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

  const integration = errors.length ? null : { targetRef, mode, command, strategy, serialize, cycles, timeoutMs };
  return { integration, errors };
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
    if (g.kind !== "human") continue;
    for (const cls of g.risk) {
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
  if (!gate.risk.length) return { armed: true, classes: [] };
  const classes = armedRiskClasses(changedPaths, riskClasses, gate.risk);
  return { armed: classes.length > 0, classes };
}

// --- the review verdict -----------------------------------------------------

// Severities that contradict a "pass" (below them a reviewer may legitimately
// pass with notes). Compared lowercased; anything unrecognized is not blocking.
const BLOCKING_SEVERITIES = new Set(["blocking", "block", "critical", "high", "major", "must-fix"]);
const PASS_WORDS = new Set(["pass", "passed", "approve", "approved", "clean", "no-findings", "none", "ok", "lgtm"]);
const FAIL_WORDS = new Set(["fail", "failed", "changes_requested", "changes-requested", "request-changes", "block", "blocked", "reject", "rejected"]);

// Read a review agent's STRUCTURED verdict out of its final report — in code,
// never by asking another agent what it meant. The contract asked of the
// reviewer is one fenced ```json block:
//
//   {"verdict": "pass" | "changes_requested", "findings": [{severity, file, summary}]}
//
// Tolerances that do not weaken it: the LAST json fence wins (a reviewer that
// quotes the schema before answering), a bare JSON object is accepted, and a
// report with `findings` but no `verdict` passes iff the list is empty.
//
// FAIL-CLOSED is the rule: an unparseable, absent or unrecognized verdict is
// NOT a pass. A review whose output we cannot read has reviewed nothing, and a
// gate that waves those through is worse than no gate at all — it launders an
// unread report into an approval.
function parseReviewVerdict(text) {
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
    const findings = Array.isArray(obj.findings)
      ? obj.findings.filter(isPlainObject).map((f) => ({
          severity: String(f.severity || "").trim() || "unspecified",
          file: String(f.file || f.path || "").trim(),
          summary: String(f.summary || f.title || f.description || "").trim(),
        }))
      : null;
    const word = String(obj.verdict || obj.status || obj.result || "").trim().toLowerCase();
    if (word && PASS_WORDS.has(word)) {
      // A "pass" carrying its own blocking findings is the commonest way a
      // reviewer contradicts itself, and taking the word over the evidence is
      // exactly the laundering this parser exists to prevent. The findings win.
      const blocking = (findings || []).filter((f) => BLOCKING_SEVERITIES.has(String(f.severity || "").toLowerCase()));
      if (blocking.length) {
        return {
          ok: true,
          passed: false,
          findings,
          verdict: "changes_requested",
          error: `the review said '${word}' while reporting ${blocking.length} ${blocking.length === 1 ? "finding" : "findings"} it rated blocking`,
        };
      }
      return { ok: true, passed: true, findings: findings || [], verdict: word };
    }
    if (word && FAIL_WORDS.has(word)) return { ok: true, passed: false, findings: findings || [], verdict: word };
    if (word) {
      return { ok: false, passed: false, findings: findings || [], verdict: word, error: `unrecognized verdict '${word}'` };
    }
    if (findings) return { ok: true, passed: findings.length === 0, findings, verdict: findings.length ? "changes_requested" : "pass" };
  }
  return { ok: false, passed: false, findings: [], verdict: null, error: "no structured verdict found in the review report" };
}

// One line per finding, for the fix-cycle prompt and the recorded fact.
function renderFindings(findings, cap = 20, lineCap = 240) {
  const list = findings || [];
  const lines = list
    .slice(0, cap)
    .map((f, i) => {
      const line = `${i + 1}. [${f.severity || "unspecified"}] ${f.file ? `${f.file} — ` : ""}${f.summary || "(no summary)"}`.replace(/\s+/g, " ");
      return line.length > lineCap ? `${line.slice(0, lineCap - 1)}…` : line;
    });
  if (list.length > cap) lines.push(`…and ${list.length - cap} more`);
  return lines.join("\n");
}

// After a failed cycle: is there another fix cycle left, or is this the
// escalation? `cycle` is 0-based (the first attempt is cycle 0).
function cycleDecision(gate, cycle) {
  const cycles = intOr(gate && gate.cycles, 0, { max: 10 });
  return cycle < cycles ? "retry" : "escalate";
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
  parseReviewVerdict,
  renderFindings,
  cycleDecision,
};

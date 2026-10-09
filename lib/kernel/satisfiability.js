"use strict";
// Profile satisfiability — the pure matcher that decides whether THIS machine
// can launch a given profile (dec-spor-machine-profile-satisfiability, FORK A).
//
// A `type: profile` node (schema-profile) declares its runtime needs as flat
// fields — `harness`, `mcp`, `skills`, `plugins`. Those fields ARE the
// satisfiability spec; there is no separate requirements block. A machine
// declares the ATOMIC capabilities it has (harnesses on PATH, reachable MCP,
// present skills/plugins, deny-flags) in a machine-local `dispatch.capabilities`
// map. `satisfies(machine, profile)` is the set algebra over the two:
//
//   satisfies(machine, profile) :=
//       profile.harness ∈ machine.harnesses
//     ∧ profile.mcp     ⊆ machine.reachable_mcp
//     ∧ profile.skills  ⊆ machine.skills
//     ∧ profile.plugins ⊆ machine.plugins
//     ∧ profile         ∉ machine.deny           (policy/opt-out, not capability)
//
// Pure and dependency-free — it runs in local mode with no server, and the
// SAME vocabulary is what the deferred remote fleet scheduler will publish
// per-agent. This module is the one source of truth for the harness vocabulary
// (HARNESS_BINARIES) and the capability axes; the probe (scripts/engines/util.js)
// and the CLI (`spor capabilities`, `spor dispatch`) read both from here.

// Canonical harness vocabulary → the binary that launches it. The harness NAMES
// match schema-profile's `harness:` field (claude-code | codex | opencode | …),
// operationalizing dec-cc-portable-core-adapters, so the probe emits exactly the
// tokens a profile declares. This table must list exactly the harnesses
// lib/shell/dispatch-harnesses.js's ADAPTERS registry can actually launch — a
// harness listed here with no adapter reports satisfiable (`spor capabilities`)
// on a box that merely happens to have the bare binary on PATH, and `spor
// dispatch` then refuses it outright (getHarness() returns null). This module
// sits in lib/kernel/ (dependency-free of lib/shell/), so it cannot import the
// adapter registry to derive this list — keep the two in sync by hand when
// either changes. Extend here (and orgs extend the profile schema's allowed
// harness values) to teach the probe a new launcher, in the same change that
// adds its adapter. A machine may ALSO bind a harness id this client has no
// adapter for at all, machine-locally (DECLARED_HARNESS_CONFIG_KEY below) —
// the probe adds those ids to `machine.harnesses` too, so this table is the
// BUILT-IN vocabulary rather than the whole one.
const { isCredentialFreeReference } = require("./provider-contract");

const HARNESS_BINARIES = {
  "claude-code": "claude",
  codex: "codex",
  opencode: "opencode",
  copilot: "copilot",
};

// The env spelling that overrides one harness's launcher, per harness. Paired
// with the `dispatch.bin.<harness>` config key below, this is the EXPLICIT
// route a machine uses to name its launcher outright instead of trusting a
// bare-name PATH lookup — the failure mode a homebrew-style prefix creates,
// where the binary is reachable from an interactive shell and nowhere else, so
// a hand-check succeeds and every dispatched run gets ENOENT
// (task-spor-dispatch-adapters-opencode-copilot). Kept here beside the
// vocabulary it keys so both the pure probe (scripts/engines/util.js) and the
// adapters (lib/shell/dispatch-harnesses.js) read one table; the two existing
// spellings are the ones already shipped, not new names.
const HARNESS_BIN_ENV = {
  "claude-code": "SPOR_CLAUDE_CMD",
  codex: "SPOR_CODEX_CMD",
  opencode: "SPOR_OPENCODE_CMD",
  copilot: "SPOR_COPILOT_CMD",
};

// The config-cascade key holding an explicit launcher path for one harness.
// Machine-specific like `dispatch.repos`, so it belongs in the USER
// $SPOR_HOME/config.json rather than a committable `.spor.json`.
function harnessBinKey(harness) {
  return `dispatch.bin.${harness}`;
}

// The config-cascade key under which a machine BINDS a harness id it has no
// in-code adapter for to a command (task-spor-dispatch-declarative-custom-
// harness). Named here — beside the harness vocabulary it extends — so the
// pure matcher can point an unsatisfiable verdict at the exact fix without
// reaching into lib/shell/. The declaration shape itself lives with the
// adapters (lib/shell/dispatch-harnesses.js); this module knows only its name.
const DECLARED_HARNESS_CONFIG_KEY = "dispatch.harness";

// Fields a PROFILE NODE must never carry. A profile is graph data — anyone who
// can write the graph could otherwise choose the command, argv, or environment
// every machine that picks that profile up would execute. The split the
// declared-harness design rests on is that the graph names a harness and the
// MACHINE binds what that name runs, so these keys are refused outright at
// dispatch rather than quietly ignored: an operator who wrote one must learn
// it does nothing, not discover later that it half-worked.
const GRAPH_LAUNCH_FIELDS = [
  "command", "args", "argv", "bin", "exec", "entrypoint",
  "env", "report", "session", "launch_mode", "launchMode", "identity_mode", "identityMode",
];

// Which of those a parsed profile node actually carries, in declaration order.
// Empty (the only shape a well-formed profile has) means nothing to refuse.
// PRESENCE, not truthiness: the rule this enforces is "a launch field named on
// a graph node is refused", so a falsy-but-present value (`""`, `0`, `false`)
// must count as declared, not as absent — only `null`/`undefined` (a key that
// is genuinely missing from the parsed node) are absent, matching how the
// frontmatter parser represents "not written" and how parseImplementation's
// own `declared` check treats its sibling `implementation`/`completion` keys.
function graphLaunchFields(profile) {
  const p = profile && typeof profile === "object" ? profile : {};
  return GRAPH_LAUNCH_FIELDS.filter((k) => p[k] !== undefined && p[k] !== null);
}

// The additive capability axes — sets the matcher takes ⊆ over. `deny` is a
// separate, policy-only axis (a list of profile ids), not a capability set.
const CAP_AXES = ["harnesses", "reachable_mcp", "skills", "plugins"];

// The canonical name of the Spor MCP/REST surface — the token a profile declares
// as `mcp: [spor]` and the value `spor capabilities allow-mcp spor` writes. The
// session-start probe seeds it into `reachable_mcp` deterministically from
// CONFIGURED-ness (a Spor server/connector is bound), never a network ping
// (task-spor-mcp-reachability-deterministic-seed): in remote mode the agent-spor
// server is reachable by construction, so a profile requiring `mcp: [spor]`
// satisfies on a fresh dispatched box with no manual allow-mcp.
const SPOR_MCP_NAME = "spor";

function strArray(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string" && x);
  if (typeof v === "string" && v) return [v];
  return [];
}

// Order-preserving de-duped union of any number of string lists.
function union(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const v of strArray(list)) {
      if (!seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
  }
  return out;
}

// Collapse a raw `dispatch.capabilities` config value into the five effective
// atomic sets the matcher reads. The config carries up to three sources per
// axis, unioned (declared AUGMENTS probed — a declaration adds what a probe
// can't see, e.g. an MCP reachable only over the VPN):
//   - `probed.<axis>`   — written wholesale by the session-start probe each
//                         refresh, so an uninstalled harness drops out (no
//                         upward drift). For `reachable_mcp` the probe seeds the
//                         spor MCP from CONFIGURED-ness (remote mode), so it too
//                         drops out the moment the server is unconfigured.
//   - `declared.<axis>` — sticky user declarations (`spor capabilities set`),
//                         the authoritative source for axes a probe can't decide.
//   - `<axis>`          — a flat top-level array, so any cascade layer (global
//                         config, repo .spor.json, env) can declare a capability
//                         directly without the structured split.
// `deny` (policy opt-out) is declaration-only — never probed; read from the
// top-level `deny` and `declared.deny`.
function effectiveCapabilities(cap) {
  const c = cap && typeof cap === "object" && !Array.isArray(cap) ? cap : {};
  const probed = c.probed && typeof c.probed === "object" ? c.probed : {};
  const declared = c.declared && typeof c.declared === "object" ? c.declared : {};
  const eff = {};
  for (const axis of CAP_AXES) eff[axis] = union(probed[axis], declared[axis], c[axis]);
  eff.deny = union(c.deny, declared.deny);
  // `gh` is a single boolean machine fact (the gh CLI is on PATH, or it isn't),
  // not a set-membership axis like the four above — there is nothing to
  // enumerate, so it isn't folded into CAP_AXES. Same "declared augments
  // probed" precedence: any layer saying true wins.
  eff.gh = !!(probed.gh || declared.gh || c.gh);
  return eff;
}

// Extract the satisfiability spec from a parsed profile node (frontmatter
// already run through parseFrontmatter, so `mcp`/`skills`/`plugins` are arrays).
function profileSpec(profile) {
  const p = profile && typeof profile === "object" ? profile : {};
  return {
    id: typeof p.id === "string" ? p.id : null,
    harness: typeof p.harness === "string" && p.harness ? p.harness : null,
    mcp: strArray(p.mcp),
    skills: strArray(p.skills),
    plugins: strArray(p.plugins),
  };
}

// satisfies(machine, profile) -> { ok, reasons, profile }.
// `machine` is EFFECTIVE capabilities (run a raw config value through
// effectiveCapabilities first, or pass already-merged sets). `profile` is a
// parsed profile node. `reasons` names every failing atom so dispatch can
// refuse soft-and-loud with an actionable line (FORK B); an empty `reasons`
// means satisfiable. A profile that declares NO runtime needs is trivially
// satisfiable (ok:true) — every box can run it.
function satisfies(machine, profile) {
  const m = {
    harnesses: strArray(machine && machine.harnesses),
    reachable_mcp: strArray(machine && machine.reachable_mcp),
    skills: strArray(machine && machine.skills),
    plugins: strArray(machine && machine.plugins),
    deny: strArray(machine && machine.deny),
  };
  const p = profileSpec(profile);
  const reasons = [];

  // Policy opt-out first — a denied profile is refused regardless of capability.
  if (p.id && m.deny.includes(p.id)) {
    reasons.push(`profile ${p.id} is on this machine's deny list (policy opt-out)`);
  }
  if (p.harness && !m.harnesses.includes(p.harness)) {
    const bin = HARNESS_BINARIES[p.harness];
    // A harness this client has no in-code adapter for is not an error — it is
    // the DECLARED-harness case (task-spor-dispatch-declarative-custom-harness):
    // the graph names an id, and only a machine whose owner locally bound that
    // id can take the work. Naming the binding here is what makes the refusal
    // actionable instead of a dead end ("some other box, maybe").
    reasons.push(
      `harness '${p.harness}' not available here` +
      (bin
        ? ` (${bin} not on PATH)`
        : ` (no built-in adapter, and no '${DECLARED_HARNESS_CONFIG_KEY}.${p.harness}' declaration in this machine's config)`)
    );
  }
  const missing = (req, have, label, fix) => {
    const gap = req.filter((x) => !have.includes(x));
    if (gap.length) reasons.push(`${label} not available here: ${gap.join(", ")}${fix ? ` (${fix})` : ""}`);
  };
  missing(p.mcp, m.reachable_mcp, "MCP server(s)", `declare with: spor capabilities allow-mcp ${p.mcp.join(" ")}`);
  missing(p.skills, m.skills, "skill(s)");
  missing(p.plugins, m.plugins, "plugin(s)");

  return { ok: reasons.length === 0, reasons, profile: p.id };
}

// satisfiesIntegration(machine, factory) -> { ok, reasons }. A factory's
// integration.mode:"propose" NEEDS the gh CLI to open pull requests
// (task-spor-propose-gh-capability-satisfiability) — this is checked
// separately from satisfies() above because a factory is a WORKER-loop
// concept (declared via --factory/work.factory), not a `type: profile` node
// a dispatched item runs under; there is no profile field to fold it into.
// The requirement is derived automatically from the loaded factory rather
// than needing an operator to declare it anywhere — every OTHER integration
// mode (or no factory at all) is trivially satisfiable.
//
// A `ci` suite (dec-spor-command-gate-ci-mode) — on any command gate or on the
// integration block — needs gh too: it is how the verdict is read. Required
// even under `local_fallback`, which covers a CI that cannot be REACHED, not
// a box that was never able to ask.
function factoryUsesCi(factory) {
  if (!factory) return false;
  if (factory.integration && factory.integration.ci) return true;
  return (factory.gates || []).some((g) => g && g.ci);
}
function needsGh(factory) {
  return !!(factory && factory.integration && factory.integration.mode === "propose") || factoryUsesCi(factory);
}
function satisfiesIntegration(machine, factory) {
  if (!needsGh(factory)) return { ok: true, reasons: [] };
  if (machine && machine.gh) return { ok: true, reasons: [] };
  const mode = factory && factory.integration && factory.integration.mode;
  const why = mode === "propose" ? "factory integration mode 'propose' needs it to open pull requests" : "a factory suite declared on CI ('ci') needs it to read the workflow run's verdict";
  return {
    ok: false,
    reasons: [`the 'gh' CLI is not available on this machine — ${why} (install it: https://cli.github.com, or run 'spor capabilities probe' after installing)`],
  };
}

// ---- attempt satisfiability: a provider's describe() vs a derived attempt spec
//
// The execution-provider contract (PROVIDERS.md §3-§4, dec-spor-work-execution-
// provider-contract) widens the question "can THIS machine run this profile?"
// to "can THIS provider run this attempt?". The answer has the same shape as
// satisfies() above — every failing atom named, refuse loudly, never
// substitute (dec-spor-machine-profile-satisfiability) — over the full attempt
// spec instead of the four profile fields. satisfies() is left exactly as it
// was: a machine is still matched against a profile at dispatch, and the fleet
// scheduler still publishes the CAP_AXES vocabulary.
//
// How each axis matches (a provider's capability, absent, is EMPTY — the
// contract's "every other axis defaults to empty"; an attempt field, absent,
// asks for nothing):
//
//   harnesses        attempt.harness.id ∈ caps.harnesses
//   reachable_mcp    attempt.mcp     ⊆ caps.reachable_mcp
//   skills, plugins  attempt.<axis>  ⊆ caps.<axis>
//   tools            attempt.tools   ⊆ caps.tools          (binaries on PATH)
//   repos            every attempt.repos[] slug ∈ caps.repos, or caps.repos
//                    holds "*" (the provider clones any repo) AND the entry
//                    carries a `url` to clone from — a provider cannot check
//                    out a pinned commit of a repo it has no copy of and no
//                    address for. A pin the entry carries is honoured, not
//                    skipped: a `commit` must be a full object name (a short
//                    or symbolic one names no single tree to check out), a
//                    `branch` a non-empty name, and one slug pinned twice to
//                    different commits/branches cannot be one checkout.
//   egress           attempt.egress.allow ⊆ caps.egress, or caps.egress holds
//                    "*" (unrestricted). An empty allow list is `none` and
//                    every provider satisfies it; an allow list naming "*" is
//                    `unrestricted` and only a "*" provider satisfies it.
//   secret_delivery  attempt.secret_delivery (optional) is the set of modes
//                    the attempt can be served by — ANY one offered satisfies.
//                    Unstated, an attempt carrying secrets[] needs SOME mode;
//                    one with no secrets needs none. Stated EMPTY, an attempt
//                    carrying secrets[] has no delivery path at all and is
//                    refused — never read as "unstated".
//   isolation        attempt.isolation ∈ caps.isolation — EXACT. A stronger
//                    kind is not offered in its place: the provider builds the
//                    kind the spec names, and handing back a different one is
//                    the substitution this matcher exists to refuse.
//   resources        each attempt.resources floor ≤ the provider's ceiling; a
//                    floor against a ceiling the provider does not declare is
//                    refused (it never said it could).
//   lifecycle        attempt.lifecycle (optional) ⊆ caps.lifecycle.
//   deadline         deadline - now ≤ caps.max_deadline_ms, when the provider
//                    declares a cap (PROVIDERS.md §8, the environment lifetime).
//   deny             attempt.profile ∉ caps.deny (policy opt-out, first).
//
// `attempt.profile` (the resolved profile id), `attempt.secret_delivery` and
// `attempt.lifecycle` are optional attempt-spec fields this matcher reads; a
// spec without them is matched on everything else. A field that is PRESENT but
// malformed (a string cpu floor, an isolation list, an unparseable deadline)
// refuses on its axis rather than reading as "asks for nothing" — the worker
// calls this directly, not only behind the contract validator.
//
// Every axis a refusal can name, in the order the matcher checks them.
const ATTEMPT_AXES = Object.freeze([
  "deny", "harnesses", "reachable_mcp", "skills", "plugins", "tools", "repos",
  "egress", "secret_delivery", "isolation", "resources", "lifecycle", "deadline",
]);
// The capability axes that are plain sets.
const CAP_SET_AXES = Object.freeze([
  "harnesses", "reachable_mcp", "skills", "plugins", "tools", "repos",
  "egress", "isolation", "secret_delivery", "lifecycle", "deny",
]);
const RESOURCE_KEYS = Object.freeze(["cpu", "memory_mb", "disk_mb"]);
const ANY = "*";
const ZONED_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
// A full git object name (sha-1 or sha-256), the contract's repo pin shape.
const OBJECT_NAME_RE = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

function numOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// Normalize a describe() `capabilities` object (or a describe-result carrying
// one) into the sets the matcher reads. Never throws on a malformed value — a
// malformed capability reads as empty, which refuses rather than admits.
function providerCapabilities(caps) {
  const raw = isObj(caps) ? caps : {};
  const c = isObj(raw.capabilities) ? raw.capabilities : raw;
  const out = {};
  for (const axis of CAP_SET_AXES) out[axis] = strArray(c[axis]);
  const res = isObj(c.resources) ? c.resources : {};
  out.resources = {};
  for (const k of RESOURCE_KEYS) if (numOrNull(res[k]) != null) out.resources[k] = res[k];
  out.max_deadline_ms = numOrNull(c.max_deadline_ms);
  return out;
}

// satisfiesAttempt(providerCaps, attemptSpec, {now}) -> { ok, reasons, axes }.
// `reasons` are prefixed with the axis that failed (`isolation: …`) so a
// refusal names WHAT to change; `axes` lists the failing axes in order, de-
// duplicated. `now` (ms) bounds the deadline check; it defaults to the clock.
function satisfiesAttempt(providerCaps, attemptSpec, opts) {
  const c = providerCapabilities(providerCaps);
  const a = isObj(attemptSpec) ? attemptSpec : {};
  const reasons = [];
  const axes = [];
  const refuse = (axis, why) => {
    reasons.push(`${axis}: ${why}`);
    if (!axes.includes(axis)) axes.push(axis);
  };
  const present = (v) => v !== undefined && v !== null;
  const offered = (list) => (list.length ? list.join(", ") : "nothing");
  // A requested list: absent asks for nothing; present must be strings.
  const wanted = (axis, field, v) => {
    if (!present(v)) return [];
    const ok = Array.isArray(v) ? v.every((x) => typeof x === "string" && x) : typeof v === "string" && v;
    if (!ok) {
      refuse(axis, `attempt ${field} is malformed (${JSON.stringify(v)}); expected a list of names`);
      return null;
    }
    return strArray(v);
  };
  const subset = (axis, field, have, noun) => {
    const want = wanted(axis, field, a[field]);
    if (!want) return;
    const gap = want.filter((x) => !have.includes(x));
    if (gap.length) refuse(axis, `${noun} not offered: ${gap.join(", ")} (this provider offers: ${offered(have)})`);
  };

  if (present(a.profile)) {
    if (typeof a.profile !== "string" || !a.profile) refuse("deny", `attempt profile is malformed (${JSON.stringify(a.profile)})`);
    else if (c.deny.includes(a.profile)) refuse("deny", `profile ${a.profile} is on this provider's deny list (policy opt-out)`);
  }

  if (present(a.harness)) {
    const harness = isObj(a.harness) ? a.harness.id : a.harness;
    if (typeof harness !== "string" || !harness) refuse("harnesses", `attempt harness is malformed (${JSON.stringify(a.harness)})`);
    else if (!c.harnesses.includes(harness)) refuse("harnesses", `harness '${harness}' not offered (this provider offers: ${offered(c.harnesses)})`);
  }
  subset("reachable_mcp", "mcp", c.reachable_mcp, "MCP server(s)");
  subset("skills", "skills", c.skills, "skill(s)");
  subset("plugins", "plugins", c.plugins, "plugin(s)");
  subset("tools", "tools", c.tools, "tool(s) on PATH");

  if (present(a.repos)) {
    if (!Array.isArray(a.repos) || a.repos.some((r) => !isObj(r) || typeof r.slug !== "string" || !r.slug)) {
      refuse("repos", "attempt repos is malformed; expected a list of {slug, commit, branch}");
    } else {
      const pins = new Map();
      for (const r of a.repos) {
        if (present(r.commit) && !(typeof r.commit === "string" && OBJECT_NAME_RE.test(r.commit))) {
          refuse("repos", `${r.slug} pins commit ${JSON.stringify(r.commit)}, which is not a full object name (40 or 64 lowercase hex)`);
        }
        if (present(r.branch) && !(typeof r.branch === "string" && r.branch)) {
          refuse("repos", `${r.slug} pins a malformed branch (${JSON.stringify(r.branch)})`);
        }
        const pin = `${r.commit ?? ""}\u0000${r.branch ?? ""}`;
        if (pins.has(r.slug) && pins.get(r.slug) !== pin) refuse("repos", `${r.slug} is pinned twice to different commits/branches — one checkout cannot hold both`);
        pins.set(r.slug, pin);
      }
      const anyRepo = c.repos.includes(ANY);
      // `*` admits a repo only by a url to clone from, and only one that is a
      // credential-free reference: a url carrying userinfo (or one the
      // reference rule cannot read) is refused by slug, never quoted
      // (issue-spor-provider-url-redaction-fail-open).
      const tainted = anyRepo ? a.repos.filter((r) => !c.repos.includes(r.slug) && typeof r.url === "string" && r.url && !isCredentialFreeReference(r.url)) : [];
      if (tainted.length) {
        refuse("repos", `cannot check out ${tainted.map((r) => r.slug).join(", ")}: its url is not a credential-free reference (value withheld) — a repo url names where to clone from, never what to clone it with`);
      }
      const noRepo = a.repos.filter((r) => !tainted.includes(r) && !(c.repos.includes(r.slug) || (anyRepo && typeof r.url === "string" && r.url)));
      if (noRepo.length) {
        refuse("repos", `cannot check out ${noRepo.map((r) => r.slug).join(", ")}` + (anyRepo ? " (no url to clone from)" : ` (this provider offers: ${offered(c.repos)})`));
      }
    }
  }

  if (present(a.egress)) {
    const allow = isObj(a.egress) ? wanted("egress", "egress.allow", a.egress.allow) : (refuse("egress", "attempt egress is malformed; expected {allow: [...]}"), null);
    if (allow && !c.egress.includes(ANY)) {
      const gap = allow.filter((h) => !c.egress.includes(h));
      if (gap.length) {
        refuse("egress", gap.includes(ANY)
          ? `unrestricted egress not offered (this provider allows: ${offered(c.egress)})`
          : `host(s) not reachable: ${gap.join(", ")} (this provider allows: ${offered(c.egress)})`);
      }
    }
  }

  const modes = wanted("secret_delivery", "secret_delivery", a.secret_delivery);
  if (present(a.secrets) && !Array.isArray(a.secrets)) {
    refuse("secret_delivery", "attempt secrets is malformed; expected a list of {name, ref}");
  } else if (modes && !modes.length && present(a.secret_delivery) && Array.isArray(a.secrets) && a.secrets.length) {
    refuse("secret_delivery", `${a.secrets.length} secret(s) to deliver and the attempt names no delivery mode (secret_delivery is empty)`);
  } else if (modes && modes.length) {
    if (!modes.some((m) => c.secret_delivery.includes(m))) {
      refuse("secret_delivery", `needs ${modes.join(" or ")}; this provider delivers by: ${offered(c.secret_delivery)}`);
    }
  } else if (modes && Array.isArray(a.secrets) && a.secrets.length && !c.secret_delivery.length) {
    refuse("secret_delivery", `${a.secrets.length} secret(s) to deliver and this provider declares no delivery mode`);
  }

  // Required by the contract: an attempt that does not name its isolation
  // cannot be matched to one, so it is refused rather than placed anywhere.
  if (typeof a.isolation !== "string" || !a.isolation) {
    refuse("isolation", `attempt isolation is ${present(a.isolation) ? `malformed (${JSON.stringify(a.isolation)})` : "missing"}`);
  } else if (!c.isolation.includes(a.isolation)) {
    refuse("isolation", `'${a.isolation}' is not offered (this provider offers: ${offered(c.isolation)})`);
  }

  if (present(a.resources)) {
    if (!isObj(a.resources)) refuse("resources", "attempt resources is malformed; expected {cpu?, memory_mb?, disk_mb?}");
    else {
      for (const k of RESOURCE_KEYS) {
        if (!present(a.resources[k])) continue;
        const want = numOrNull(a.resources[k]);
        const have = c.resources[k];
        if (want == null) refuse("resources", `attempt ${k} floor is malformed (${JSON.stringify(a.resources[k])})`);
        else if (have == null) refuse("resources", `${k} >= ${want} requested; this provider declares no ${k}`);
        else if (want > have) refuse("resources", `${k} >= ${want} requested; this provider offers ${have}`);
      }
    }
  }

  subset("lifecycle", "lifecycle", c.lifecycle, "lifecycle operation(s)");

  if (c.max_deadline_ms != null) {
    // Zone-required, like the contract's date-time: a zone-less time would be
    // read in this host's local zone and could land inside the cap it is past.
    const at = typeof a.deadline === "string" && ZONED_DATE_TIME_RE.test(a.deadline) ? Date.parse(a.deadline) : NaN;
    const now = opts && numOrNull(opts.now) != null ? opts.now : Date.now();
    if (!Number.isFinite(at)) {
      refuse("deadline", `attempt deadline ${present(a.deadline) ? `is not a date-time (${JSON.stringify(a.deadline)})` : "is missing"}; this provider caps the environment lifetime at max_deadline_ms ${c.max_deadline_ms}`);
    } else if (at - now > c.max_deadline_ms) {
      refuse("deadline", `${a.deadline} is past this provider's environment lifetime (max_deadline_ms ${c.max_deadline_ms})`);
    }
  }

  return { ok: reasons.length === 0, reasons, axes };
}

module.exports = {
  HARNESS_BINARIES,
  HARNESS_BIN_ENV,
  harnessBinKey,
  DECLARED_HARNESS_CONFIG_KEY,
  GRAPH_LAUNCH_FIELDS,
  graphLaunchFields,
  CAP_AXES,
  SPOR_MCP_NAME,
  effectiveCapabilities,
  profileSpec,
  satisfies,
  satisfiesIntegration,
  ATTEMPT_AXES,
  providerCapabilities,
  satisfiesAttempt,
  factoryUsesCi,
  needsGh,
};

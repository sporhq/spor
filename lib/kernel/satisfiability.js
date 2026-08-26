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
function graphLaunchFields(profile) {
  const p = profile && typeof profile === "object" ? profile : {};
  return GRAPH_LAUNCH_FIELDS.filter((k) => p[k] !== undefined && p[k] !== null && p[k] !== "");
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
};

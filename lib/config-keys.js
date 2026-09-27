"use strict";
// config-keys.js — the ONE declaration of every client config key
// (task-spor-client-config-typed-key-table-and-explain).
//
// Before this table, a key's facts were scattered: its env spelling lived in
// config.js's ENV_MAP, its top-level namespace in a hand-extended KNOWN_KEYS set
// (forgetting one warned "unknown config key 'work' ignored" about a value that
// was being honored — issue-spor-config-loader-work-namespace-warning), its
// repo-layer ban in two REPO_FORBIDDEN_* lists, and its default only as the
// literal each caller passed to get(). config.js now DERIVES all of those from
// this table, `spor config explain` renders it, and test/config-keys.test.js
// lints every literal config read in the tree against it (an undeclared key, a
// fallback literal that disagrees with `default`, or an env name that disagrees
// with `env` fails the suite).
//
// Entry fields:
//   key      dotted path.
//   type     string | number | bool | list | map | enum. `map` is an OPEN
//            object whose children are user-named (slugs, harness ids, paths)
//            and are therefore never checked against this table.
//   choices  (enum only) the accepted values.
//   default  the value a reader gets when nothing sets the key. Callers still
//            pass it as their get() fallback (byte-identical by construction);
//            the lint test holds the two together. Absent = no default (unset
//            means "not configured", e.g. `server`, `enabled`).
//   applied  merged into the cascade's built-in DEFAULTS layer. Only the
//            structural defaults that predate this table are applied, so a
//            config file's absence resolves exactly as it always has.
//   env      the SPOR_<env> (legacy SUBSTRATE_<env>) variable feeding the env
//            layer. Server-side ops vars, worker IPC and the SPOR_DISTILLING
//            recursion guard are deliberately NOT config and never appear here.
//   noRepo   "secret" | "machine-local": a committable repo `.spor.json` may
//            not set this key; it is stripped with a warning. See config.js
//            sanitizeRepoLayer for why each class is banned.
//   secret   redact the value wherever it is displayed (`spor config explain`).
//   doc      one line, shown by `spor config explain`.

const KEYS = [
  // --- mode / tenant / home ------------------------------------------------
  { key: "mode", type: "enum", choices: ["auto", "local", "remote", "off"], default: "auto", applied: true, env: "MODE",
    doc: "auto (remote iff a server resolves) | local | remote | off (plugin is a no-op)" },
  { key: "server", type: "string", env: "SERVER", doc: "team server base URL (flat single-tenant path; `spor auth` stores per-org tenants instead)" },
  { key: "token", type: "string", env: "TOKEN", noRepo: "secret", secret: true, doc: "bearer token for `server`" },
  { key: "org", type: "string", doc: "reserved; the tenant org is selected by --org, SPOR_ORG or a repo `.spor` org: marker" },
  { key: "home", type: "string", env: "HOME", doc: "graph home (a repo `.spor` graph: marker overrides it in local mode)" },
  { key: "nodes", type: "string", env: "NODES", doc: "graph nodes dir (default <home>/nodes)" },
  { key: "enabled", type: "bool", env: "ENABLED", doc: "explicit opt-in/out; unset falls back to repo-marker presence" },

  // --- search / queue ------------------------------------------------------
  { key: "search.minSim", type: "number", default: 0.08, doc: "prompt-digest relevance gate (top cosine)" },
  { key: "search.projects.include", type: "list", default: [], applied: true, doc: "only these projects in neighborhood search" },
  { key: "search.projects.exclude", type: "list", default: [], applied: true, doc: "drop these projects from neighborhood search" },
  { key: "search.projects.boost", type: "map", default: {}, applied: true, doc: "project -> score multiplier" },
  { key: "queue.front.enabled", type: "bool", default: true, applied: true, env: "QUEUE_FRONT", doc: "local git-derived `front` queue signal" },
  { key: "queue.front.days", type: "number", default: 7, applied: true, env: "QUEUE_FRONT_DAYS", doc: "rolling front window (days)" },
  { key: "queue.project", type: "string", env: "QUEUE_PROJECT", doc: "default --project scope for `spor next`" },

  // --- distiller / capture nudge / digest ----------------------------------
  { key: "distill.enabled", type: "bool", default: true, env: "DISTILL", doc: "SessionEnd distiller" },
  { key: "distill.cmd", type: "string", env: "DISTILL_CMD", noRepo: "machine-local", doc: "distiller backend (prompt stdin -> nodes stdout)" },
  { key: "distill.model", type: "string", env: "DISTILL_MODEL", doc: "distiller model" },
  { key: "distill.debounce", type: "number", env: "DEBOUNCE", doc: "debounced-distill quiesce window (s)" },
  { key: "distill.timeoutMs", type: "number", default: 120000, env: "DISTILL_TIMEOUT", doc: "bound a hung distill backend (ms)" },
  { key: "nudge.enabled", type: "bool", default: true, env: "NUDGE", doc: "post-tool capture nudge" },
  { key: "nudge.cmd", type: "string", env: "NUDGE_CMD", noRepo: "machine-local", doc: "capture classifier backend" },
  { key: "nudge.maxCalls", type: "number", default: 20, env: "NUDGE_MAX", doc: "per-session ceiling on classifier calls" },
  { key: "nudge.timeoutMs", type: "number", default: 30000, env: "NUDGE_TIMEOUT", doc: "bound a hung nudge backend (ms)" },
  { key: "nudge.async", type: "bool", default: false, env: "NUDGE_ASYNC", doc: "classify off the tool loop, inject one turn late" },
  { key: "nudge.sweepIntervalMs", type: "number", default: 1800000, env: "NUDGE_SWEEP_INTERVAL", doc: "stranded-spool sweep throttle (ms)" },
  { key: "digest.async", type: "bool", default: null, env: "DIGEST_ASYNC", doc: "tri-state intent gate on the prompt digest (unset = server verdict policy)" },
  { key: "digest.intentCmd", type: "string", env: "DIGEST_INTENT_CMD", noRepo: "machine-local", doc: "digest intent-classifier backend" },
  { key: "digest.intentMaxCalls", type: "number", default: 20, env: "DIGEST_INTENT_MAX", doc: "per-session ceiling on intent-classifier spawns" },
  { key: "digest.intentTimeoutMs", type: "number", default: 30000, env: "DIGEST_INTENT_TIMEOUT", doc: "bound a hung intent backend (ms)" },

  // --- post-tool / session-end remote knobs ---------------------------------
  { key: "claimNudge.enabled", type: "bool", default: true, env: "CLAIM_NUDGE", doc: "claim heartbeat + claim nudge" },
  { key: "claimNudge.timeoutMs", type: "number", default: 3000, env: "CLAIM_NUDGE_TIMEOUT", doc: "bound the lease lookup/heartbeat (ms)" },
  { key: "couplingNudge.enabled", type: "bool", default: true, env: "COUPLING_NUDGE", doc: "edit-time coupling nudge" },
  { key: "couplingNudge.timeoutMs", type: "number", default: 3000, env: "COUPLING_NUDGE_TIMEOUT", doc: "bound the coupling-snapshot download (ms)" },
  { key: "coupling.aliases", type: "map", default: {}, doc: "alias prefix -> canonical prefix for coupling globs" },
  { key: "sessionLease.enabled", type: "bool", default: true, env: "SESSION_LEASE", doc: "SessionEnd reserve/release" },
  { key: "sessionLease.timeoutMs", type: "number", default: 3000, env: "SESSION_LEASE_TIMEOUT", doc: "bound each lease curl (ms)" },
  { key: "inferCommits.enabled", type: "bool", default: false, env: "INFER_COMMITS", doc: "infer commit links for nodes" },
  { key: "inferCommits.threshold", type: "number", env: "INFER_THRESHOLD", doc: "commit-inference score threshold" },

  // --- dispatch --------------------------------------------------------------
  { key: "dispatch.repos", type: "map", default: {}, doc: "machine-local slug -> checkout path (`spor repos add`, `spor enable`)" },
  { key: "dispatch.agent", type: "string", default: null, env: "DISPATCH_AGENT", doc: "this machine's default dispatch agent" },
  { key: "dispatch.claudeLaunchMode", type: "string", default: null, env: "DISPATCH_CLAUDE_LAUNCH_MODE", doc: "RETIRED: only `supervised` exists" },
  { key: "dispatch.allowPersonToken", type: "bool", default: false, env: "ALLOW_PERSON_TOKEN", noRepo: "machine-local", doc: "fall back to person attribution when an agent token cannot be minted" },
  { key: "dispatch.capabilities", type: "map", default: {}, doc: "machine capability map (probed/declared/deny)" },
  { key: "dispatch.capabilitiesPublish", type: "bool", default: true, env: "CAPABILITIES_PUBLISH", doc: "session-start fleet auto-publish" },
  { key: "dispatch.capabilitiesPublishTimeoutMs", type: "number", default: 3000, env: "CAPABILITIES_PUBLISH_TIMEOUT", doc: "bound the auto-publish (ms)" },
  { key: "dispatch.autoRoute", type: "bool", default: false, env: "AUTO_ROUTE", doc: "hand an unsatisfiable node to a satisfying fleet host" },
  { key: "dispatch.autoRouteMaxAge", type: "string", default: "24h", env: "AUTO_ROUTE_MAX_AGE", doc: "re-route target liveness bound (0 disables)" },
  { key: "dispatch.heartbeat", type: "bool", default: true, env: "HEARTBEAT", doc: "post-tool fleet liveness tick" },
  { key: "dispatch.heartbeatIntervalMs", type: "number", default: 300000, env: "HEARTBEAT_INTERVAL", doc: "liveness tick throttle (ms)" },
  { key: "dispatch.heartbeatTimeoutMs", type: "number", default: 3000, env: "HEARTBEAT_TIMEOUT", doc: "bound the liveness tick (ms)" },
  { key: "dispatch.harness", type: "map", noRepo: "machine-local", doc: "declared custom harnesses (id -> {command,args,...})" },
  { key: "dispatch.bin", type: "map", noRepo: "machine-local", doc: "harness id -> launcher binary path" },
  { key: "dispatch.template", type: "string", default: null, doc: "dispatch prompt template path" },
  { key: "dispatch.worktree", type: "bool", default: false, doc: "dispatch into an isolated git worktree by default" },
  { key: "dispatch.worktreeSetup", type: "string", default: null, doc: "script run in a fresh dispatch worktree" },
  { key: "dispatch.worktreeTeardown", type: "string", default: null, doc: "script run before a dispatch worktree is removed" },
  { key: "dispatch.workspaceLockWaitMs", type: "number", default: 20000, doc: "wait for a contended workspace lock (ms)" },
  { key: "dispatch.launchHandshakeTimeoutMs", type: "number", default: 5000, doc: "supervised launch handshake bound (ms)" },
  { key: "dispatch.runRetentionMs", type: "number", default: 1209600000, doc: "how long run records are kept (ms)" },

  // --- attestation -----------------------------------------------------------
  { key: "attestation.signingKey", type: "string", default: null, env: "ATTESTATION_KEY", noRepo: "machine-local", secret: true, doc: "HMAC key signing gate attestations" },
  { key: "attestation.keyId", type: "string", default: null, env: "ATTESTATION_KEY_ID", doc: "key_id stamped beside the signature" },

  // --- the work loop (values mirror lib/shell/work-loop.js WORK_DEFAULTS) ---
  { key: "work.accept", type: "enum", choices: ["ready", "open"], default: "ready", env: "WORK_ACCEPT", doc: "readiness policy: ready | open" },
  { key: "work.factory", type: "string", default: null, doc: "factory node the loop enforces" },
  { key: "work.project", type: "string", default: null, doc: "project scope (falls back to queue.project)" },
  { key: "work.concurrency", type: "number", default: 1, doc: "parallel runs" },
  { key: "work.intervalMs", type: "number", default: 30000, doc: "poll interval (ms)" },
  { key: "work.maxIntervalMs", type: "number", default: 300000, doc: "idle backoff ceiling (ms)" },
  { key: "work.retryAfterMs", type: "number", default: 600000, doc: "refused-item cooldown (ms)" },
  { key: "work.runMaxMs", type: "number", default: 86400000, doc: "per-run watchdog (ms)" },
  { key: "work.runIdleMs", type: "number", default: 2700000, doc: "silence ceiling before a run is stopped (ms, 0 disables)" },
  { key: "work.parkedReofferMax", type: "number", default: 10, doc: "identical interrupted re-offers before escalation (0 = unbounded)" },
  { key: "work.escalationRetryBackoffMs", type: "number", default: 300000, doc: "escalation-write retry backoff (ms)" },
  { key: "work.escalationRetryMaxBackoffMs", type: "number", default: 3600000, doc: "escalation-write retry backoff ceiling (ms)" },
  { key: "work.escalationRetryMaxAttempts", type: "number", default: 5, doc: "escalation-write retries before giving up" },
  { key: "work.reconcileLanded", type: "bool", default: true, env: "WORK_RECONCILE_LANDED", doc: "post-land reconcile-landed pass" },
  { key: "work.restartOnLand", type: "bool", default: false, env: "WORK_RESTART_ON_LAND", doc: "exit for a restart once the loaded code lands" },

  // --- journal gc / execution store / briefs ---------------------------------
  { key: "gc.enabled", type: "bool", default: true, env: "GC", doc: "periodic journal garbage collection" },
  { key: "gc.maxAgeMs", type: "number", default: 1209600000, env: "GC_MAX_AGE", doc: "prune per-session journal artifacts older than (ms)" },
  { key: "gc.intervalMs", type: "number", default: 86400000, env: "GC_INTERVAL", doc: "journal gc throttle (ms)" },
  { key: "execution.leaseTtlMs", type: "number", default: 900000, env: "EXECUTION_TTL", doc: "factory execution lease TTL (ms)" },
  { key: "execution.timeoutMs", type: "number", default: 8000, env: "EXECUTION_TIMEOUT", doc: "bound each /v1/executions call (ms)" },
  { key: "briefs", type: "map", doc: "monorepo subtree path -> brief id (nearest .spor.json wins wholesale)" },
];

const BY_KEY = new Map(KEYS.map((k) => [k.key, k]));

// The declared entry for a dotted path: the exact entry, or the nearest `map`
// ancestor (a child of an open map is declared by the map). null = undeclared.
function lookup(dotted) {
  if (BY_KEY.has(dotted)) return BY_KEY.get(dotted);
  const parts = dotted.split(".");
  for (let i = parts.length - 1; i > 0; i--) {
    const e = BY_KEY.get(parts.slice(0, i).join("."));
    if (e) return e.type === "map" ? e : null;
  }
  return null;
}

// True iff `dotted` is a namespace (an intermediate object) some key sits under.
function isNamespace(dotted) {
  const pre = dotted + ".";
  return KEYS.some((k) => k.key.startsWith(pre));
}

// Does `value` fit `entry.type`? Lenient where the getters already coerce: a
// number may be a numeric string (getNum parseFloats), a bool may be any scalar
// (getBool's shell convention). null always fits — it reads as unset.
function typeMatches(entry, value) {
  if (value === null || value === undefined) return true;
  const obj = typeof value === "object";
  switch (entry.type) {
    case "string": return !obj;
    case "number": return typeof value === "number" ? Number.isFinite(value) : !obj && Number.isFinite(parseFloat(value));
    case "bool": return !obj;
    case "list": return Array.isArray(value);
    case "map": return obj && !Array.isArray(value);
    case "enum": return !obj && entry.choices.includes(String(value));
    default: return true;
  }
}

module.exports = { KEYS, lookup, isNamespace, typeMatches };

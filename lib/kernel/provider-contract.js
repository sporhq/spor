// kernel/provider-contract.js — the execution-provider contract v1, as data
// plus pure validators (task-spor-execution-provider-contract-spec,
// constrained-by dec-spor-work-execution-provider-contract). PROVIDERS.md is
// the prose contract; this module is its machine-readable half.
//
// An execution PROVIDER answers WHERE one attempt runs (a local worktree, a
// container, a VM, a cloud sandbox). It sits between the SOURCE of work (the
// queue, a program, a server work request) and the HARNESS ADAPTER (which agent
// CLI runs inside the environment), and it speaks six operations — describe,
// submit, observe, collect, cancel, release — plus an optional environment
// extension (suspend, resume, checkpoint, restore) a provider ADVERTISES as
// capabilities and a worker never assumes.
//
// The schemas below are a JSON Schema (2020-12) SUBSET written as plain
// objects, so they are both the documentation a third-party provider reads and
// the input to the tiny interpreter at the bottom of this file. Only the
// keywords the interpreter implements are used: type, required, properties,
// items, enum, const, pattern, minLength, minimum, minItems, format
// ("date-time"), anyOf, not, and local `$ref` into `$defs`. No schema sets
// `additionalProperties` — an unknown field is IGNORED everywhere, which is the
// contract's forward-compatibility rule (a v1 reader meeting a field a later
// minor revision added must not refuse it). What JSON Schema cannot say — that
// a secret `ref` is a reference and not a value, that a manifest's candidate
// reference is portable and names the candidate's own commit — is a SEMANTIC
// check run after the structural pass, and is listed beside each schema.
//
// Pure and dependency-free like every kernel module: no I/O, no clock, no node
// builtins. The one kernel import is candidate.js's referenceRefusal, so a
// manifest's candidate reference is judged by exactly the rule a factory
// candidate is (WORKERS.md §10.12) rather than a second copy of it.
"use strict";

const { referenceRefusal } = require("./candidate");

const CONTRACT_VERSION = 1;

// The six required operations and the four optional environment-lifecycle ones.
// A provider advertises the optional ones it implements in
// describe().capabilities.lifecycle; a worker calling one it did not advertise
// is a worker bug, and the provider answers `unsupported_operation`.
const REQUIRED_OPERATIONS = Object.freeze(["describe", "submit", "observe", "collect", "cancel", "release"]);
const OPTIONAL_OPERATIONS = Object.freeze(["suspend", "resume", "checkpoint", "restore"]);
const OPERATIONS = Object.freeze([...REQUIRED_OPERATIONS, ...OPTIONAL_OPERATIONS]);

// The observe state machine (PROVIDERS.md §5). `finished`, `failed` and `lost`
// are TERMINAL for the environment — and, deliberately, for nothing else: an
// observe state is evidence the worker reads, never a task outcome.
// `suspended` is reported only by a provider that advertises `suspend`.
const OBSERVE_STATES = Object.freeze(["pending", "provisioning", "running", "suspended", "stopping", "finished", "failed", "lost"]);
const TERMINAL_OBSERVE_STATES = Object.freeze(["finished", "failed", "lost"]);

// Where an attempt is isolated. Ordered weakest to strongest; the capability
// matcher (task-spor-execution-provider-capability-vocabulary) owns whether a
// stronger kind satisfies a weaker request — this module only names them.
const ISOLATION_KINDS = Object.freeze(["worktree", "container", "vm"]);

// How a provider puts a secret it resolved from ITS OWN vault in front of the
// attempt. There is no `env`-of-a-plaintext-value-Spor-sent class: Spor never
// transports a secret value (dec-spor-work-execution-provider-contract, open
// question 1, answered "references only"). `env` here would mean the provider
// itself materializing its vault value into the sandbox env, which is the
// provider's business — it is still not on the list for v1, so a provider
// cannot claim a delivery mode the decision ruled out.
const SECRET_DELIVERY_MODES = Object.freeze(["file", "egress-inject", "token-mint"]);

const LIFECYCLE_CAPABILITIES = Object.freeze(["cancel", "force-cancel", "stream", ...OPTIONAL_OPERATIONS]);

// The error codes a provider answers with. A provider MAY send a code not on
// this list (forward compatibility), and a worker treats an unknown code as
// `internal` — so the schema checks the SHAPE of a code, not membership.
const ERROR_CODES = Object.freeze([
  "invalid_request", // the request failed this module's validation
  "contract_version_unsupported", // the provider does not speak this version
  "unsupported_operation", // an optional operation the provider did not advertise
  "unsatisfiable", // the attempt asks for something describe() does not offer
  "idempotency_conflict", // the key was already used for a DIFFERENT attempt
  "unknown_handle", // the handle names nothing this provider holds
  "unavailable", // transient: the provider's backend is unreachable
  "internal",
]);

// Field names a secret entry must never carry: each is a way of writing the
// VALUE where only a reference belongs.
const SECRET_VALUE_KEYS = Object.freeze(["value", "secret", "plaintext", "token", "password", "data"]);

const DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
// A reference is an absolute URI: `<scheme>://<something>`. Every shape a
// hand-written value takes — a bare token, a `KEY=value` pair, a JSON blob, a
// base64 string — has no scheme, so this one rule separates "where to get it"
// from "it". The authority carries NO userinfo (`https://user:token@host`,
// `https://token@host` both smuggle a credential into a "reference"), with the
// one conventional exception of a bare ssh login name (`ssh://git@host/…`),
// which names an account, not a secret.
// Extra slashes after `://` are skipped before the authority is judged: a
// WHATWG parser skips them too, so `https:///tok@host` is userinfo `tok`.
const REFERENCE_PATTERN = "^(?:ssh://(?:[A-Za-z0-9._-]+@)?|[a-z][a-z0-9+.-]*://)(?![/\\\\]*[^/?#\\s\\\\]*@)\\S+$";
const OBJECT_NAME_PATTERN = "^([0-9a-f]{40}|[0-9a-f]{64})$";

// ---------------------------------------------------------------- the schemas

const $defs = {
  nonEmptyString: { type: "string", minLength: 1 },
  stringList: { type: "array", items: { $ref: "#/$defs/nonEmptyString" } },
  dateTime: { type: "string", format: "date-time" },
  reference: { type: "string", pattern: REFERENCE_PATTERN },
  contractVersion: { const: CONTRACT_VERSION },
  // The provider's name for one accepted attempt. `provider` + `id` are the
  // whole identity; any other field is provider-private and round-trips
  // verbatim (the worker persists the handle on the execution record exactly as
  // it was returned and hands it back unchanged, so a provider may stash what
  // it needs to re-find the environment).
  handle: {
    type: "object",
    required: ["provider", "id"],
    properties: {
      provider: { $ref: "#/$defs/nonEmptyString" },
      id: { $ref: "#/$defs/nonEmptyString" },
    },
  },
  secretRef: {
    type: "object",
    required: ["name", "ref"],
    properties: {
      name: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
      ref: { $ref: "#/$defs/reference" },
    },
    not: { anyOf: SECRET_VALUE_KEYS.map((k) => ({ required: [k] })) },
  },
  repo: {
    type: "object",
    required: ["slug", "commit", "branch"],
    properties: {
      slug: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$" },
      commit: { type: "string", pattern: OBJECT_NAME_PATTERN },
      branch: { $ref: "#/$defs/nonEmptyString" },
      url: { $ref: "#/$defs/reference" },
    },
  },
  candidateReference: {
    type: "object",
    required: ["kind", "locator", "commit"],
    properties: {
      kind: { enum: ["bundle", "branch"] },
      locator: { $ref: "#/$defs/reference" },
      commit: { type: "string", pattern: OBJECT_NAME_PATTERN },
      key: { $ref: "#/$defs/nonEmptyString" },
      ref: { $ref: "#/$defs/nonEmptyString" },
    },
  },
  error: {
    type: "object",
    required: ["code", "message"],
    properties: {
      code: { type: "string", pattern: "^[a-z][a-z0-9_]*$" },
      message: { $ref: "#/$defs/nonEmptyString" },
      retryable: { type: "boolean" },
    },
  },
};

const SCHEMAS = {
  // The derived attempt spec (PROVIDERS.md §4). Built by the worker from the
  // resolved profile, the pinned factory and the item — never hand-written.
  "attempt-spec": {
    title: "attempt-spec",
    type: "object",
    required: [
      "contract_version", "attempt_id", "execution_id", "fence", "tenant", "node_id",
      "harness", "mcp", "skills", "plugins", "tools", "repos", "egress", "secrets",
      "spor", "deadline", "isolation", "prompt_bundle_ref",
    ],
    properties: {
      contract_version: { $ref: "#/$defs/contractVersion" },
      attempt_id: { $ref: "#/$defs/nonEmptyString" },
      execution_id: { type: "string", pattern: "^exec-[0-9a-f]{16}$" },
      fence: { type: "integer", minimum: 0 },
      tenant: { $ref: "#/$defs/nonEmptyString" },
      node_id: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
      harness: {
        type: "object",
        required: ["id"],
        properties: { id: { $ref: "#/$defs/nonEmptyString" }, version: { $ref: "#/$defs/nonEmptyString" } },
      },
      model: { $ref: "#/$defs/nonEmptyString" },
      mcp: { $ref: "#/$defs/stringList" },
      skills: { $ref: "#/$defs/stringList" },
      plugins: { $ref: "#/$defs/stringList" },
      tools: { $ref: "#/$defs/stringList" },
      repos: { type: "array", minItems: 1, items: { $ref: "#/$defs/repo" } },
      egress: { type: "object", required: ["allow"], properties: { allow: { $ref: "#/$defs/stringList" } } },
      secrets: { type: "array", items: { $ref: "#/$defs/secretRef" } },
      spor: {
        type: "object",
        required: ["server", "token_ref"],
        properties: { server: { $ref: "#/$defs/reference" }, token_ref: { $ref: "#/$defs/reference" } },
        not: { anyOf: SECRET_VALUE_KEYS.map((k) => ({ required: [k] })) },
      },
      resources: {
        type: "object",
        properties: {
          cpu: { type: "number", minimum: 0 },
          memory_mb: { type: "integer", minimum: 0 },
          disk_mb: { type: "integer", minimum: 0 },
        },
      },
      deadline: { $ref: "#/$defs/dateTime" },
      isolation: { enum: [...ISOLATION_KINDS] },
      prompt_bundle_ref: { $ref: "#/$defs/reference" },
    },
  },

  "describe-result": {
    title: "describe-result",
    type: "object",
    required: ["provider_id", "contract_version", "capabilities"],
    properties: {
      provider_id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$" },
      contract_version: { $ref: "#/$defs/contractVersion" },
      capabilities: {
        type: "object",
        required: ["isolation", "lifecycle"],
        properties: {
          harnesses: { $ref: "#/$defs/stringList" },
          reachable_mcp: { $ref: "#/$defs/stringList" },
          skills: { $ref: "#/$defs/stringList" },
          plugins: { $ref: "#/$defs/stringList" },
          tools: { $ref: "#/$defs/stringList" },
          egress: { $ref: "#/$defs/stringList" },
          isolation: { type: "array", minItems: 1, items: { enum: [...ISOLATION_KINDS] } },
          secret_delivery: { type: "array", items: { enum: [...SECRET_DELIVERY_MODES] } },
          lifecycle: { type: "array", items: { enum: [...LIFECYCLE_CAPABILITIES] } },
          resources: {
            type: "object",
            properties: {
              cpu: { type: "number", minimum: 0 },
              memory_mb: { type: "integer", minimum: 0 },
              disk_mb: { type: "integer", minimum: 0 },
            },
          },
          max_deadline_ms: { type: "integer", minimum: 0 },
        },
      },
    },
  },

  "submit-result": {
    title: "submit-result",
    type: "object",
    required: ["handle", "accepted_at"],
    properties: {
      handle: { $ref: "#/$defs/handle" },
      accepted_at: { $ref: "#/$defs/dateTime" },
      // true when the key had already been accepted and this is that handle
      // again — the reconcile reading of a re-submit (PROVIDERS.md §6).
      existing: { type: "boolean" },
      // Descriptive, provider-defined environment facts (a VM name, a region).
      // Never a credential.
      env: { type: "object" },
    },
  },

  "observe-result": {
    title: "observe-result",
    type: "object",
    required: ["state", "since"],
    properties: {
      state: { enum: [...OBSERVE_STATES] },
      since: { $ref: "#/$defs/dateTime" },
      exit: {
        type: "object",
        properties: { code: { type: "integer" }, signal: { $ref: "#/$defs/nonEmptyString" } },
      },
      detail: { type: "string" },
    },
  },

  // What an attempt PRODUCED. A manifest exists only when there is a candidate
  // to judge; an attempt that produced none is a collect-result with a null
  // manifest and a stated reason, never a manifest with the candidate missing.
  "result-manifest": {
    title: "result-manifest",
    type: "object",
    required: ["attempt_id", "execution_id", "fence", "candidate"],
    properties: {
      attempt_id: { $ref: "#/$defs/nonEmptyString" },
      execution_id: { type: "string", pattern: "^exec-[0-9a-f]{16}$" },
      fence: { type: "integer", minimum: 0 },
      candidate: {
        type: "object",
        required: ["repo", "commit", "tree", "reference"],
        properties: {
          repo: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$" },
          commit: { type: "string", pattern: OBJECT_NAME_PATTERN },
          tree: { type: "string", pattern: OBJECT_NAME_PATTERN },
          branch: { $ref: "#/$defs/nonEmptyString" },
          reference: { $ref: "#/$defs/candidateReference" },
        },
      },
      report_ref: { $ref: "#/$defs/reference" },
      log_refs: { type: "array", items: { $ref: "#/$defs/reference" } },
      evidence: {
        type: "array",
        items: {
          type: "object",
          required: ["kind", "ref"],
          properties: { kind: { $ref: "#/$defs/nonEmptyString" }, ref: { $ref: "#/$defs/reference" } },
        },
      },
    },
  },

  "collect-result": {
    title: "collect-result",
    type: "object",
    required: ["manifest"],
    properties: {
      manifest: { anyOf: [{ type: "null" }, { $ref: "#/schemas/result-manifest" }] },
      no_candidate: {
        type: "object",
        required: ["reason"],
        properties: { reason: { $ref: "#/$defs/nonEmptyString" } },
      },
      report_ref: { $ref: "#/$defs/reference" },
      log_refs: { type: "array", items: { $ref: "#/$defs/reference" } },
    },
  },

  "cancel-result": {
    title: "cancel-result",
    type: "object",
    required: ["state"],
    properties: { state: { enum: [...OBSERVE_STATES] } },
  },

  "release-result": {
    title: "release-result",
    type: "object",
    required: ["released"],
    properties: { released: { const: true } },
  },

  "checkpoint-result": {
    title: "checkpoint-result",
    type: "object",
    required: ["checkpoint"],
    properties: {
      checkpoint: {
        type: "object",
        required: ["id", "created_at"],
        properties: { id: { $ref: "#/$defs/nonEmptyString" }, created_at: { $ref: "#/$defs/dateTime" } },
      },
    },
  },
};

// Per-operation request params and response result schemas.
const handleParams = { type: "object", required: ["handle"], properties: { handle: { $ref: "#/$defs/handle" } } };
const PARAMS = {
  describe: { type: "object" },
  submit: {
    type: "object",
    required: ["attempt", "idempotency_key"],
    properties: {
      attempt: { $ref: "#/schemas/attempt-spec" },
      idempotency_key: { type: "string", minLength: 8 },
    },
  },
  observe: handleParams,
  collect: handleParams,
  cancel: {
    type: "object",
    required: ["handle"],
    properties: { handle: { $ref: "#/$defs/handle" }, force: { type: "boolean" } },
  },
  release: handleParams,
  suspend: handleParams,
  resume: handleParams,
  checkpoint: handleParams,
  restore: {
    type: "object",
    required: ["handle", "checkpoint_id", "idempotency_key"],
    properties: {
      handle: { $ref: "#/$defs/handle" },
      checkpoint_id: { $ref: "#/$defs/nonEmptyString" },
      idempotency_key: { type: "string", minLength: 8 },
    },
  },
};
const RESULTS = {
  describe: "describe-result",
  submit: "submit-result",
  observe: "observe-result",
  collect: "collect-result",
  cancel: "cancel-result",
  release: "release-result",
  suspend: "observe-result",
  resume: "observe-result",
  checkpoint: "checkpoint-result",
  restore: "submit-result", // a restore is a new environment: a new handle
};

SCHEMAS.request = {
  title: "request",
  type: "object",
  required: ["contract_version", "id", "op", "params"],
  properties: {
    contract_version: { $ref: "#/$defs/contractVersion" },
    id: { $ref: "#/$defs/nonEmptyString" },
    op: { enum: [...OPERATIONS] },
    params: { type: "object" },
  },
};
SCHEMAS.response = {
  title: "response",
  type: "object",
  required: ["contract_version", "id", "ok"],
  properties: {
    contract_version: { $ref: "#/$defs/contractVersion" },
    id: { $ref: "#/$defs/nonEmptyString" },
    ok: { type: "boolean" },
    result: { type: "object" },
    error: { $ref: "#/$defs/error" },
  },
};

// ---------------------------------------------------------------- interpreter

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (Number.isInteger(v)) return "integer";
  return typeof v;
}

function typeMatches(want, v) {
  const got = typeOf(v);
  if (want === got) return true;
  return want === "number" && got === "integer";
}

function resolveRef(ref) {
  let m = /^#\/\$defs\/(.+)$/.exec(ref);
  if (m && $defs[m[1]]) return $defs[m[1]];
  m = /^#\/schemas\/(.+)$/.exec(ref);
  if (m && SCHEMAS[m[1]]) return SCHEMAS[m[1]];
  throw new Error(`provider-contract: unresolvable $ref ${ref}`);
}

function check(schema, v, path, errors) {
  if (schema.$ref) return check(resolveRef(schema.$ref), v, path, errors);
  const at = path || "(root)";
  if ("const" in schema && v !== schema.const) {
    errors.push(`${at}: must be ${JSON.stringify(schema.const)}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(v)) {
    errors.push(`${at}: ${JSON.stringify(v)} is not one of ${schema.enum.join(", ")}`);
    return;
  }
  if (schema.type && !typeMatches(schema.type, v)) {
    errors.push(`${at}: must be ${schema.type === "integer" ? "an integer" : `of type ${schema.type}`}`);
    return;
  }
  if (schema.anyOf) {
    const branches = schema.anyOf.map((s) => {
      const e = [];
      check(s, v, path, e);
      return e;
    });
    if (!branches.some((e) => e.length === 0)) {
      // Report the branch the value was evidently aiming at: one whose type it
      // has (an object is not "aiming at" null), then the one with the fewest
      // errors.
      const aimed = schema.anyOf
        .map((s, i) => ({ s: s.$ref ? resolveRef(s.$ref) : s, e: branches[i] }))
        .filter(({ s }) => !s.type || typeMatches(s.type, v));
      const pool = (aimed.length ? aimed.map(({ e }) => e) : branches).sort((a, b) => a.length - b.length);
      errors.push(...pool[0]);
      return;
    }
  }
  if (schema.not) {
    const e = [];
    check(schema.not, v, path, e);
    if (e.length === 0) errors.push(`${at}: ${notMessage(schema.not)}`);
  }
  if (typeof v === "string") {
    if (schema.minLength != null && v.length < schema.minLength) {
      errors.push(`${at}: must be at least ${schema.minLength} character${schema.minLength === 1 ? "" : "s"}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(v)) errors.push(`${at}: ${JSON.stringify(v)} does not match ${schema.pattern}`);
    if (schema.format === "date-time" && !isDateTime(v)) {
      errors.push(`${at}: ${JSON.stringify(v)} is not an RFC 3339 date-time`);
    }
  }
  if (typeof v === "number" && schema.minimum != null && v < schema.minimum) errors.push(`${at}: must be >= ${schema.minimum}`);
  if (Array.isArray(v)) {
    if (schema.minItems != null && v.length < schema.minItems) errors.push(`${at}: must have at least ${schema.minItems} item(s)`);
    if (schema.items) v.forEach((item, i) => check(schema.items, item, `${path}[${i}]`, errors));
  }
  if (typeOf(v) === "object") {
    for (const key of schema.required || []) {
      if (!(key in v) || v[key] === undefined) errors.push(`${path ? `${path}.` : ""}${key}: is required`);
    }
    // Only DECLARED properties are checked; every other key is ignored — the
    // forward-compatibility rule (PROVIDERS.md §2).
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (key in v && v[key] !== undefined) check(sub, v[key], path ? `${path}.${key}` : key, errors);
    }
  }
}

// RFC 3339 shape AND a real calendar date: Date.parse rolls `02-30` over to
// March, so the date part must survive a round trip.
function isDateTime(v) {
  const m = DATE_TIME_RE.exec(v);
  if (!m || Number.isNaN(Date.parse(v))) return false;
  const day = new Date(`${m[1]}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === m[1];
}

function notMessage(notSchema) {
  const keys = (notSchema.anyOf || [notSchema]).flatMap((s) => s.required || []);
  if (keys.length) return `must not carry ${keys.join("/")} — secrets travel by reference only`;
  return "matches a forbidden shape";
}

// ---------------------------------------------------------------- semantics

// Checks JSON Schema cannot express. Each takes the (structurally valid) value
// and returns extra error strings.
const SEMANTICS = {
  "attempt-spec": (v, path) => {
    const errors = [];
    const names = new Set();
    (v.secrets || []).forEach((s, i) => {
      if (names.has(s.name)) errors.push(`${path}secrets[${i}].name: duplicate secret name ${JSON.stringify(s.name)}`);
      names.add(s.name);
    });
    const slugs = new Set();
    (v.repos || []).forEach((r, i) => {
      if (slugs.has(r.slug)) errors.push(`${path}repos[${i}].slug: duplicate repo ${JSON.stringify(r.slug)}`);
      slugs.add(r.slug);
    });
    return errors;
  },
  "observe-result": (v, path) => {
    // An exit is a fact about a process that ENDED. A provider that reports one
    // on a live state is describing two attempts at once.
    if (v.exit && !TERMINAL_OBSERVE_STATES.includes(v.state)) {
      return [`${path}exit: only a terminal state (${TERMINAL_OBSERVE_STATES.join(", ")}) carries an exit`];
    }
    return [];
  },
  "result-manifest": (v, path) => {
    const c = v.candidate;
    const errors = [];
    if (c.reference.commit !== c.commit) {
      errors.push(`${path}candidate.reference.commit: must equal candidate.commit — a reference to another commit is not this candidate's`);
    }
    // A manifest is read AFTER release may have destroyed the environment, so a
    // file:// locator — a path on some filesystem, almost always the
    // environment's own — is refused outright here; the reference must be
    // fetchable over the network (https://, or ssh:// for a branch).
    if (/^file:/i.test(c.reference.locator)) {
      errors.push(`${path}candidate.reference.locator: a provider manifest's candidate must be fetchable off the environment — file:// is not`);
    }
    const why = referenceRefusal(c.reference);
    if (why) errors.push(`${path}candidate.reference: ${why}`);
    return errors;
  },
  "collect-result": (v, path) => {
    if (v.manifest === null && !v.no_candidate) {
      return [`${path}no_candidate: is required when manifest is null — an attempt that produced nothing says why`];
    }
    if (v.manifest !== null && v.no_candidate) {
      return [`${path}no_candidate: must be absent when a manifest is present — an attempt either produced a candidate or did not`];
    }
    if (v.manifest) return SEMANTICS["result-manifest"](v.manifest, `${path}manifest.`);
    return [];
  },
  "submit-result": () => [],
};

function runSchema(name, value, path = "") {
  const schema = SCHEMAS[name];
  if (!schema) throw new Error(`provider-contract: unknown schema ${name}`);
  const errors = [];
  check(schema, value, path, errors);
  if (!errors.length && SEMANTICS[name]) errors.push(...SEMANTICS[name](value, path ? `${path}.` : ""));
  return errors;
}

// validate(name, value) → { ok, errors }. `name` is one of SCHEMA_NAMES.
function validate(name, value) {
  const errors = runSchema(name, value);
  return { ok: errors.length === 0, errors };
}

// A request envelope, including its op's params (and, for submit, the attempt
// spec's semantic checks).
function validateRequest(msg) {
  const errors = runSchema("request", msg);
  if (errors.length) return { ok: false, errors };
  check(PARAMS[msg.op], msg.params, "params", errors);
  if (!errors.length && msg.op === "submit") errors.push(...SEMANTICS["attempt-spec"](msg.params.attempt, "params.attempt."));
  return { ok: errors.length === 0, errors };
}

// A response envelope for a request of operation `op`. Exactly one of
// `result` (ok: true) or `error` (ok: false).
function validateResponse(msg, op) {
  if (!OPERATIONS.includes(op)) throw new Error(`provider-contract: unknown operation ${op}`);
  const errors = runSchema("response", msg);
  if (errors.length) return { ok: false, errors };
  if (msg.ok) {
    if ("error" in msg) errors.push("error: must be absent when ok is true");
    if (!("result" in msg)) errors.push("result: is required when ok is true");
    else errors.push(...runSchema(RESULTS[op], msg.result, "result"));
  } else {
    if ("result" in msg) errors.push("result: must be absent when ok is false");
    if (!("error" in msg)) errors.push("error: is required when ok is false");
  }
  return { ok: errors.length === 0, errors };
}

// The observe state machine's allowed moves (PROVIDERS.md §5). A state may
// repeat (an observe is a poll); a terminal state never moves again.
const OBSERVE_TRANSITIONS = Object.freeze({
  pending: Object.freeze(["provisioning", "running", "stopping", "failed", "lost"]),
  provisioning: Object.freeze(["running", "stopping", "failed", "lost"]),
  running: Object.freeze(["suspended", "stopping", "finished", "failed", "lost"]),
  suspended: Object.freeze(["running", "stopping", "failed", "lost"]),
  stopping: Object.freeze(["finished", "failed", "lost"]),
  finished: Object.freeze([]),
  failed: Object.freeze([]),
  lost: Object.freeze([]),
});

function observeTransitionAllowed(from, to) {
  if (!OBSERVE_STATES.includes(from) || !OBSERVE_STATES.includes(to)) return false;
  return from === to || OBSERVE_TRANSITIONS[from].includes(to);
}

const SCHEMA_NAMES = Object.freeze(Object.keys(SCHEMAS));

module.exports = {
  CONTRACT_VERSION,
  REQUIRED_OPERATIONS,
  OPTIONAL_OPERATIONS,
  OPERATIONS,
  OBSERVE_STATES,
  TERMINAL_OBSERVE_STATES,
  OBSERVE_TRANSITIONS,
  ISOLATION_KINDS,
  SECRET_DELIVERY_MODES,
  LIFECYCLE_CAPABILITIES,
  ERROR_CODES,
  SCHEMAS,
  SCHEMA_NAMES,
  PARAMS,
  RESULTS,
  $defs,
  validate,
  validateRequest,
  validateResponse,
  observeTransitionAllowed,
};

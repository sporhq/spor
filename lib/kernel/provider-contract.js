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
// ("date-time", and the `spor-*` reference shapes in REFERENCE_FORMATS),
// anyOf, not, `additionalProperties: false`, and local `$ref` into `$defs`.
// An unknown field is IGNORED everywhere but one place, which is the contract's
// forward-compatibility rule (a v1 reader meeting a field a later minor
// revision added must not refuse it). The two closed shapes are a secret
// entry — exactly {name, ref}, because an unknown key there is a value riding
// where only a reference belongs (dec-spor-provider-credential-review-signoff-
// 2026-10-09 (e)) — and deliver_credential's `credential`, the one object
// that does carry a value, so nothing else may ride beside it. What JSON Schema cannot say — that a manifest's candidate
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
// `deliver_credential` is the one operation that carries a credential VALUE
// (dec-spor-provider-credential-review-signoff-2026-10-09 (g)): the attempt-
// scoped Spor token the worker minted for the attempt's execution and fence,
// handed to the provider so it lands in the environment as the file
// SPOR_TOKEN_FILE names. It is optional like the environment extension — a
// provider that does not advertise it is never sent one — and it is the ONLY
// value exception to "secrets travel by reference" (PROVIDERS.md §4.3).
const OPTIONAL_OPERATIONS = Object.freeze(["suspend", "resume", "checkpoint", "restore", "deliver_credential"]);
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
  "stale_credential", // a deliver_credential under a fence older than one already delivered
  "internal",
]);

// The credential kinds deliver_credential carries. One, by design: the
// attempt-scoped Spor token (PROVIDERS.md §4.3). Its value is the server's
// opaque bearer (`spor_att_…`); the pattern refuses anything else, so a
// worker's own long-lived token (`spor_pat_…`, a legacy one) can never be
// delivered through the exception.
const CREDENTIAL_KINDS = Object.freeze(["spor-attempt-token"]);
const ATTEMPT_TOKEN_PATTERN = "^spor_att_[A-Za-z0-9_-]{16,}$";
// The token's reference, as the attempt spec names it (spor.token_ref):
// `spor-attempt-token://<execution_id>/<fence>`.
const ATTEMPT_TOKEN_REF_RE = /^spor-attempt-token:\/\/(exec-[0-9a-f]{16})\/(0|[1-9][0-9]*)$/;

// Field names a secret entry must never carry: each is a way of writing the
// VALUE where only a reference belongs.
const SECRET_VALUE_KEYS = Object.freeze(["value", "secret", "plaintext", "token", "password", "data"]);

// Credential shapes recognized by PREFIX: GitHub, GitLab, Slack, AWS
// access-key ids, `sk-` API keys (a known sub-prefix — OpenAI `sk-proj-`/
// `sk-svcacct-`/`sk-admin-`, Anthropic `sk-ant-`, Stripe `sk-live-`/`sk-test-`
// — or a legacy unhyphenated `sk-<32+ alnum>`, so a kebab node id or branch
// with an `sk` segment is not one), and Spor's own tokens (`spor_att_` attempt, `spor_pat_` personal,
// `spor_oat_` OAuth, and the legacy `sub_pat_`). None is ever a reference, so
// finding one in a reference, a request line or a log line means a value is
// about to leak. ONE list: the reference rule, the stdio request scan, the
// bundle scan and `redact` all read it.
const CREDENTIAL_TOKEN_SOURCE = [
  "gh[pousr]_[A-Za-z0-9]{20,}",
  "github_pat_[A-Za-z0-9_]{20,}",
  "glpat-[A-Za-z0-9_-]{20,}",
  "xox[abeoprs]-[A-Za-z0-9-]{10,}",
  "sk-(?:proj|ant|live|test|svcacct|admin)-[A-Za-z0-9_-]{16,}",
  "sk-[A-Za-z0-9]{32,}",
  "AKIA[0-9A-Z]{16}",
  "spor_(?:att|pat|oat)_[A-Za-z0-9_-]{16,}",
  "sub_pat_[A-Za-z0-9_-]{16,}",
].join("|");
const CREDENTIAL_RE = new RegExp(`(?:^|[^A-Za-z0-9])(?:${CREDENTIAL_TOKEN_SOURCE})`);

const DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
// A reference is an absolute URI: `<scheme>://<something>`. Every shape a
// hand-written value takes — a bare token, a `KEY=value` pair, a JSON blob, a
// base64 string — has no scheme, so this one rule separates "where to get it"
// from "it". The authority carries NO userinfo (`https://user:token@host`,
// `https://token@host` both smuggle a credential into a "reference"), with the
// one conventional exception of a bare ssh login name (`ssh://git@host/…`),
// which names an account, not a secret. That login is at most 32 characters
// (the user-name limit; an AWS CodeCommit SSH key id fits) and may not open
// with a known token prefix, so `ssh://ghp_…@host` — a credential written
// where the account goes — is refused like any other userinfo.
// Extra slashes after `://` are skipped before the authority is judged: a
// WHATWG parser skips them too, so `https:///tok@host` is userinfo `tok`.
const REFERENCE_PATTERN = "^(?:ssh://(?:(?!(?:gh[pousr]_|github_pat_|glpat-|xox[abeoprs]-))[A-Za-z0-9._-]{1,32}@)?|[a-z][a-z0-9+.-]*://)(?![/\\\\]*[^/?#\\s\\\\]*@)\\S+$";
const OBJECT_NAME_PATTERN = "^([0-9a-f]{40}|[0-9a-f]{64})$";

// The authority's userinfo as the reference rule reads it (extra slashes
// skipped, the LAST `@` before the path ends it, as a WHATWG parser does).
const AUTHORITY_USERINFO_RE = /^([a-z][a-z0-9+.-]*:\/\/[/\\]*)[^/?#\s\\]*@/i;

// Whether `v` is a reference the rule above admits: an absolute URI whose
// authority provably carries no credential, with NO query and NO fragment
// (`?access_token=…`, `#tok=…`, a presigned `?X-Amz-Signature=…` — a query
// is where a URL most often carries a credential, and no reference this
// contract names needs one), and no credential-shaped segment anywhere
// (`https://host/ghp_…/x.git`, `vault://sk-live-…`).
function isCredentialFreeReference(v) {
  return typeof v === "string" && new RegExp(REFERENCE_PATTERN).test(v) && !/[?#]/.test(v) && !CREDENTIAL_RE.test(v);
}

// The URL SHAPES each reference field admits — an allow-list per field
// (dec-spor-provider-credential-review-signoff-2026-10-09 (d)), checked on top
// of the reference rule above. A schema names one as `format`.
const HOST = "(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\\[[0-9A-Fa-f:.]+\\])";
const SSH_LOGIN = "(?!(?:gh[pousr]_|github_pat_|glpat-|xox[abeoprs]-|spor_|sub_pat_|sk-))[A-Za-z0-9._-]{1,32}";
const URL_PATH = "[^\\s?#@\\\\]+";
const REPO_URL_RES = Object.freeze([
  // https://host/path.git — no userinfo at all
  new RegExp(`^https://${HOST}(?::\\d+)?/${URL_PATH}$`),
  // ssh://[git@]host[:port]/path — a bare login name, never a credential
  new RegExp(`^ssh://(?:${SSH_LOGIN}@)?${HOST}(?::\\d+)?/${URL_PATH}$`),
  // git@host:path — scp-style; the login is required (it is what tells it
  // apart from `<scheme>:`), and the path is not `//…`
  new RegExp(`^${SSH_LOGIN}@${HOST}:(?!/)[^\\s?#@\\\\]+$`),
]);
// A server base: scheme, host, optional port, then an optional path prefix
// of plain segments — no `@` (an authority hidden in the path), no query, no
// fragment, no backslash. A trailing slash is tolerated (remote.base() strips
// it; a hand-written one is the same server).
const SERVER_BASE_RE = new RegExp(`^https?://${HOST}(?::\\d+)?(?:/[^\\s?#@\\\\/]+)*/?$`);
const REFERENCE_FORMATS = Object.freeze({
  // Any reference: `<scheme>://…` per the rule above (a secret `ref`, a
  // report/log/evidence ref, the prompt bundle).
  "spor-reference": {
    test: isCredentialFreeReference,
    what: "an absolute <scheme>://… URI with no credential (userinfo), query or fragment",
  },
  // A repo to clone: https://host/path, ssh://[login@]host/path, login@host:path.
  "spor-repo-url": {
    test: (v) => typeof v === "string" && !CREDENTIAL_RE.test(v) && REPO_URL_RES.some((re) => re.test(v)),
    what: "a repo url — https://host/path, ssh://host/path (a bare login allowed) or scp-style login-at-host:path, with no credential, query or fragment",
  },
  // A candidate's locator: fetched over file://, https:// or ssh:// (the
  // schemes candidate.js referenceRefusal reaches).
  "spor-locator": {
    test: (v) => isCredentialFreeReference(v) && /^(?:file|https|ssh):\/\//i.test(v),
    what: "a locator — a file://, https:// or ssh:// URI with no credential, query or fragment",
  },
  // The Spor server: an origin, optionally under a path prefix (a tenant
  // served behind a reverse proxy at `https://host/spor` — what remote.base()
  // yields) — userinfo, a query or a fragment is refused, and so is a
  // credential-shaped string anywhere (`https://sk-live-….example.com`).
  // A local-mode graph is named by its nodes dir as a file:// URI instead
  // (lib/kernel/attempt-spec.js), which carries no authority to hide one in.
  "spor-origin": {
    test: (v) => typeof v === "string" && !CREDENTIAL_RE.test(v) && (SERVER_BASE_RE.test(v) || (/^file:\/\/\//i.test(v) && isCredentialFreeReference(v))),
    what: "a server base — http(s)://host[:port] with an optional path prefix and no credential, query or fragment (or a local graph's file:/// path)",
  },
  // The attempt token's NAME: spor-attempt-token://<execution>/<fence> — a
  // name, never the token itself (`spor-attempt-token://spor_pat_…/1`).
  "spor-token-ref": {
    test: (v) => typeof v === "string" && ATTEMPT_TOKEN_REF_RE.test(v) && !CREDENTIAL_RE.test(v),
    what: "an attempt-token reference — spor-attempt-token://<execution>/<fence>",
  },
});

// Whether `v` is admitted by the named reference shape (REFERENCE_FORMATS).
function isAllowedReference(format, v) {
  const f = REFERENCE_FORMATS[format];
  if (!f) throw new Error(`provider-contract: unknown reference format ${format}`);
  return f.test(v);
}

// Whether a url's authority carries userinfo the reference rule refuses — the
// "this origin had credentials in it" signal, distinct from a url that is
// merely not portable.
function referenceHasUserinfo(v) {
  return typeof v === "string" && AUTHORITY_USERINFO_RE.test(v) && !new RegExp(REFERENCE_PATTERN).test(v.replace(/[?#].*$/s, ""));
}

// Whether a REFUSED reference looks like it carries a value — userinfo (any
// `@`), a query or fragment, or a credential-shaped string — as opposed to one
// that is merely the wrong shape (a path where an origin belongs, an unknown
// scheme). Callers reporting a `spor.server`/`spor.token_ref` refusal read it
// to say "a secret by value" only when that is what they found, rather than
// sending an operator after a secret that is not there.
function referenceCarriesValue(v) {
  return typeof v !== "string" || /[@?#]/.test(v) || CREDENTIAL_RE.test(v);
}

// A URL safe to show or to hand onward as a reference: a value that already
// passes the reference rule is returned unchanged (a bare ssh login name stays),
// and one whose authority carries a credential has the userinfo REMOVED — the
// remainder still names where to fetch from, never what to fetch it with.
// FAILS CLOSED: anything that is still not a credential-free reference after
// that — a value the rule cannot delimit (whitespace inside the userinfo), an
// scp-style `user:tok@host:path` with no scheme, a non-string — is null, never
// passed through, so a caller has no locator rather than a leaking one
// (issue-spor-provider-url-redaction-fail-open). Callers that echo a REFUSED
// value use `describeRefusedReference`. `format` names the field's shape
// (REFERENCE_FORMATS); the result must pass it, so a url with a query, a
// token-shaped segment or a scheme the field does not take is null too.
function stripReferenceUserinfo(v, format = "spor-reference") {
  if (isAllowedReference(format, v)) return v;
  if (typeof v !== "string") return null;
  const stripped = v.replace(AUTHORITY_USERINFO_RE, "$1");
  return isAllowedReference(format, stripped) ? stripped : null;
}

// How an error message names a value the reference rule refused, without
// quoting a credential: userinfo is redacted, and a value with no
// `<scheme>://` (a bare token, a KEY=value pair — the shapes a secret takes)
// or with whitespace left in it (where a userinfo the rule could not delimit
// would hide), or with an `@` left after the authority, is withheld outright.
// A query or fragment is cut (`?<redacted>`), and a value still carrying a
// credential-shaped string is withheld.
function describeRefusedReference(v) {
  if (typeof v !== "string") return JSON.stringify(v);
  const shown = v.replace(AUTHORITY_USERINFO_RE, "$1<redacted>@").replace(/([?#]).*$/s, "$1<redacted>");
  // An `@` left past the authority (`https://host/<tok>@evil`) is a userinfo
  // spelled where the path goes: withheld too.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(shown) || /\s/.test(shown) || CREDENTIAL_RE.test(shown) || shown.replace("<redacted>@", "").includes("@")) return "(value withheld)";
  return JSON.stringify(shown);
}

// Mask every credential a line of text may carry, before it reaches a log, a
// terminal, a status line or a refusal (redaction FAILS CLOSED — signoff (d)):
//   - `secrets`: exact values the caller holds (its own token), replaced first;
//   - any `<scheme>:…@` span: on each line, everything from the FIRST scheme
//     to the LAST `@` after it is masked — whitespace, quotes and escapes
//     included, so a userinfo the URL grammar cannot delimit
//     (`https://u:p w@host`, `https://u:p"w@host`) is still hidden; a
//     scheme-less scp `user:tok@host` reads as scheme `user` and is masked the
//     same way, while `git@host:path` (no `:` before the `@`) stays;
//   - a URL's query and fragment (`?access_token=…`, a presigned signature);
//   - every credential-shaped string (CREDENTIAL_TOKEN_SOURCE).
// Over-masking is the accepted direction: a line that loses a harmless
// `word: … x@y` span is noise, one that keeps a token is a leak.
// Bounded and linear: the masking runs BEFORE the display cap (REDACT_CAP), so
// the cap can never split a credential out from under its pattern; only text
// past REDACT_SCAN_CAP is cut first, and that cut drops the partial last word
// and masks an unclosed scheme span on the last line. Every pass is an
// indexOf walk or a regex whose start is anchored on a word boundary
// (or, for the credential shapes, on a literal prefix).
const REDACT_CAP = 8192;
const REDACT_SCAN_CAP = 65536;
// The same left boundary CREDENTIAL_RE has, so a kebab word ending in "sk"
// (`task-test-…`, `disk-live-…`) is not read as an `sk-` key mid-word.
const CREDENTIAL_GLOBAL_RE = new RegExp(`(?<![A-Za-z0-9])(?:${CREDENTIAL_TOKEN_SOURCE})`, "g");
const SCHEME_START_RE = /(?<![A-Za-z0-9+.-])[a-z][a-z0-9+.-]*:[\\/]*/i;
function maskUserinfoLine(line) {
  const at = line.lastIndexOf("@");
  if (at < 0) return line;
  const m = SCHEME_START_RE.exec(line.slice(0, at));
  return m ? `${line.slice(0, m.index + m[0].length)}***${line.slice(at)}` : line;
}
function maskUrlQuery(run) {
  const i = run.indexOf("://");
  if (i < 0) return run;
  const q = run.slice(i + 3).search(/[?#]/);
  return q < 0 ? run : `${run.slice(0, i + 3 + q)}?***`;
}
function redact(text, secrets = []) {
  let t = String(text);
  for (const s of Array.isArray(secrets) ? secrets : []) {
    if (typeof s === "string" && s.length >= 8 && t.includes(s)) t = t.split(s).join("***");
  }
  if (t.length > REDACT_SCAN_CAP) {
    let k = REDACT_SCAN_CAP;
    while (k > 0 && !/\s/.test(t[k - 1])) k--;
    t = t.slice(0, k);
    const nl = Math.max(t.lastIndexOf("\n"), t.lastIndexOf("\r"));
    const m = SCHEME_START_RE.exec(t.slice(nl + 1));
    if (m) t = `${t.slice(0, nl + 1 + m.index + m[0].length)}***`;
    t += "…";
  }
  t = t.split(/(\r\n|\r|\n)/).map((part, i) => (i % 2 ? part : maskUserinfoLine(part))).join("");
  t = t.replace(/[^\s"'`<>]+/g, maskUrlQuery).replace(CREDENTIAL_GLOBAL_RE, "***");
  return t.length > REDACT_CAP ? `${t.slice(0, REDACT_CAP)}…` : t;
}

// ---------------------------------------------------------------- the schemas

const $defs = {
  nonEmptyString: { type: "string", minLength: 1 },
  stringList: { type: "array", items: { $ref: "#/$defs/nonEmptyString" } },
  dateTime: { type: "string", format: "date-time" },
  reference: { type: "string", format: "spor-reference" },
  repoUrl: { type: "string", format: "spor-repo-url" },
  locator: { type: "string", format: "spor-locator" },
  sporOrigin: { type: "string", format: "spor-origin" },
  tokenRef: { type: "string", format: "spor-token-ref" },
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
  // Exactly {name, ref} (signoff (e)) — closed, like deliver_credential's
  // credential.
  secretRef: {
    type: "object",
    required: ["name", "ref"],
    properties: {
      name: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
      ref: { $ref: "#/$defs/reference" },
    },
    additionalProperties: false,
  },
  repo: {
    type: "object",
    required: ["slug", "commit", "branch"],
    properties: {
      slug: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$" },
      commit: { type: "string", pattern: OBJECT_NAME_PATTERN },
      branch: { $ref: "#/$defs/nonEmptyString" },
      url: { $ref: "#/$defs/repoUrl" },
    },
  },
  candidateReference: {
    type: "object",
    required: ["kind", "locator", "commit"],
    properties: {
      kind: { enum: ["bundle", "branch"] },
      locator: { $ref: "#/$defs/locator" },
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
        properties: { server: { $ref: "#/$defs/sporOrigin" }, token_ref: { $ref: "#/$defs/tokenRef" } },
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
      // Optional, read by the capability matcher (satisfiesAttempt in
      // lib/kernel/satisfiability.js): the resolved profile id (the provider's
      // deny list is keyed on it), the delivery modes ANY one of which can
      // serve the attempt's secrets, and the lifecycle operations it needs.
      profile: { $ref: "#/$defs/nonEmptyString" },
      secret_delivery: { type: "array", items: { enum: [...SECRET_DELIVERY_MODES] } },
      lifecycle: { type: "array", items: { enum: [...LIFECYCLE_CAPABILITIES] } },
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
          // Repo slugs the provider can check out, or "*" for any repo the
          // attempt gives a url for.
          repos: { $ref: "#/$defs/stringList" },
          // Hosts the provider lets an attempt reach, or "*" for unrestricted.
          egress: { $ref: "#/$defs/stringList" },
          // Profile ids this provider refuses by policy.
          deny: { $ref: "#/$defs/stringList" },
          isolation: { type: "array", minItems: 1, items: { enum: [...ISOLATION_KINDS] } },
          secret_delivery: { type: "array", items: { enum: [...SECRET_DELIVERY_MODES] } },
          // The provider's registry of vault schemes: the `<scheme>` of every
          // secrets[].ref it can resolve (`vault`, `op`, `env-ref`, …). An
          // attempt naming a secret under any other scheme is refused by the
          // matcher; a provider declaring none resolves no secret at all.
          secret_schemes: { type: "array", items: { type: "string", pattern: "^[a-z][a-z0-9+.-]*$" } },
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

  "deliver-credential-result": {
    title: "deliver-credential-result",
    type: "object",
    required: ["delivered"],
    properties: { delivered: { const: true } },
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
  // The one request that carries a credential value (see OPTIONAL_OPERATIONS).
  // Idempotent on (handle, fence, value): a re-send of the delivery already
  // made answers delivered again; a delivery under an OLDER fence than one
  // already delivered to the handle is `stale_credential`.
  deliver_credential: {
    type: "object",
    required: ["handle", "credential"],
    properties: {
      handle: { $ref: "#/$defs/handle" },
      credential: {
        type: "object",
        required: ["kind", "ref", "value", "fence"],
        properties: {
          kind: { enum: [...CREDENTIAL_KINDS] },
          ref: { $ref: "#/$defs/reference" },
          value: { type: "string", pattern: ATTEMPT_TOKEN_PATTERN },
          fence: { type: "integer", minimum: 0 },
          expires_at: { $ref: "#/$defs/dateTime" },
        },
        // Closed: the one request carrying a value carries nothing else a
        // second value could ride under.
        additionalProperties: false,
        closedWhy: "a delivery carries the attempt token and its reference, nothing else",
      },
    },
    // Closed too (issue-spor-stdio-binding-submit-trusts-caller): the binding
    // exempts only params.credential.value from its secret scan, so an open
    // params would let a sibling field carry an opaque value beside it.
    additionalProperties: false,
    closedWhy: "a delivery names the handle and the credential, nothing else",
  },
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
  deliver_credential: "deliver-credential-result",
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
    if (schema.pattern === ATTEMPT_TOKEN_PATTERN) {
      // Never quote a refused credential value.
      if (!new RegExp(schema.pattern).test(v)) errors.push(`${at}: (value withheld) is not an attempt-scoped Spor token (spor_att_…) — no other credential is delivered by value`);
    } else if (schema.pattern && !new RegExp(schema.pattern).test(v)) errors.push(`${at}: ${JSON.stringify(v)} does not match ${schema.pattern}`);
    const shape = schema.format && REFERENCE_FORMATS[schema.format];
    if (shape && !shape.test(v)) {
      // Never quote a refused reference: its most likely defect is a
      // credential in it, and these messages land in logs and terminals.
      errors.push(`${at}: ${describeRefusedReference(v)} is not a reference — ${shape.what}`);
    }
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
    // A CLOSED shape (secretRef, the delivered credential): an undeclared key
    // is named, never its value — on a secret entry it is a value riding where
    // a reference belongs.
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(v)) {
        // The key NAME is withheld too: whatever was written there may itself
        // be the value (`{"name": …, "ref": …, "<token>": true}`).
        if (!Object.prototype.hasOwnProperty.call(schema.properties || {}, key)) {
          errors.push(`${path || "(root)"}: carries a key other than ${Object.keys(schema.properties || {}).join(", ")} (name withheld) — ${schema.closedWhy || "secrets travel by reference only"}`);
          break;
        }
      }
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

// deliver_credential params: the reference must be the attempt token's own
// (`spor-attempt-token://<execution>/<fence>`) and name the fence the
// credential claims, so a provider can key the delivery on it.
function credentialErrors(params, path) {
  const c = params.credential;
  const m = ATTEMPT_TOKEN_REF_RE.exec(c.ref);
  if (!m) return [`${path}credential.ref: an attempt token's reference is spor-attempt-token://<execution_id>/<fence>`];
  if (Number(m[2]) !== c.fence) return [`${path}credential.fence: ${c.fence} is not the fence its reference names (${m[2]})`];
  return [];
}

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
  if (!errors.length && msg.op === "deliver_credential") errors.push(...credentialErrors(msg.params, "params."));
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
  CREDENTIAL_KINDS,
  ATTEMPT_TOKEN_PATTERN,
  ATTEMPT_TOKEN_REF_RE,
  SCHEMAS,
  SCHEMA_NAMES,
  PARAMS,
  RESULTS,
  $defs,
  validate,
  validateRequest,
  validateResponse,
  observeTransitionAllowed,
  stripReferenceUserinfo,
  isCredentialFreeReference,
  isAllowedReference,
  referenceHasUserinfo,
  referenceCarriesValue,
  describeRefusedReference,
  REFERENCE_FORMATS,
  CREDENTIAL_TOKEN_SOURCE,
  CREDENTIAL_RE,
  redact,
};

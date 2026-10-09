"use strict";
// attempt-bundle.js — the portable ATTEMPT BUNDLE (task-spor-attempt-bundle-run,
// PROVIDERS.md §13, WORKERS.md §4 "The attempt bundle").
//
// What a provider ships into the environment it provisions so that
// `spor attempt run <bundle>` can execute the attempt there with the unchanged
// harness adapters. Everything the attempt needs that is not a secret, and
// nothing that is:
//
//   attempt.json   the attempt spec (PROVIDERS.md §4), validated by the
//                  contract's own `attempt-spec` schema
//   prompt/        the WORKERS.md §4 prompt: `prompt.md` is the exact bytes the
//                  harness receives on stdin; `session.md`, `briefing.md` and
//                  `task.md` are the parts it was assembled from, when known
//                  (descriptive — the runner reads only prompt.md)
//   repos.json     `{bundle_format, repos: [{slug, commit, branch, url?}]}`, the
//                  pinned checkouts; must agree with attempt.repos exactly
//   env.json       optional, non-secret settings: `{env: {NAME: value}, harness:
//                  {permission_mode?, sandbox?, approval_policy?, read_only?}}`
//
// A bundle is a directory, or the same tree as a POSIX ustar archive (`.tar`;
// lib/tar.js, so this stays zero-dep). Secrets NEVER ride it: the attempt names
// them by reference (secrets[].ref, spor.token_ref) and the provider delivers
// the values through its declared `secret_delivery` channel — the attempt-scoped
// Spor token arrives in the environment as SPOR_TOKEN or
// SPOR_DISPATCH_CHILD_TOKEN. `verifyBundle` refuses a bundle carrying a value:
// a secret entry with a value-bearing key, a credential-shaped string anywhere
// in any file, an env.json naming a credential, or a value the verifying
// process itself holds as a Spor credential.

const fs = require("node:fs");
const path = require("node:path");

const pc = require("../kernel/provider-contract.js");
const tar = require("../tar.js");
const { CREDENTIAL_RE, ambientSecrets, findString } = require("./providers/stdio.js");
const { isSecretEnvName } = require("./gate-runner.js");

const BUNDLE_FORMAT = 1;
const FILES = Object.freeze({ attempt: "attempt.json", repos: "repos.json", env: "env.json", prompt: "prompt/prompt.md" });
const PROMPT_PARTS = Object.freeze(["session", "briefing", "task"]);
// The harness posture a bundle may carry — the same four knobs a dispatch's
// argv is built from (dispatch-harnesses buildArgs), all non-secret.
const HARNESS_SETTINGS = Object.freeze(["permission_mode", "sandbox", "approval_policy", "read_only"]);
// The `prompt_bundle_ref` an attempt carries when its prompt rides INSIDE the
// bundle (rather than at a provider-hosted URL): a reference naming this
// bundle's own prompt/ directory.
const IN_BUNDLE_PROMPT_REF = "spor-bundle://prompt/";

// An env.json name that reads as a credential, beyond the Spor-specific list
// the gate runner already scrubs: a secret is delivered by the provider, never
// written into a settings file.
const GENERIC_SECRET_NAME_RE = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?)$/i;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// A refusal or status line must never carry a credential, even one the
// refused input itself carried: the contract's validator QUOTES offending
// values (a repo url with userinfo — `https://user:token@host` — is refused by
// shape, and its error names the whole url). Every message that leaves the
// bundle verifier or the runner passes through this: URL userinfo and
// credential-shaped strings are masked.
//
// Bounded: the input is capped first (a refused value can be arbitrarily
// long, and a message no one can read whole carries nothing a cap loses), so
// no pattern below can go super-linear on it. The scheme is anchored on its
// left (a scheme never starts mid-word), the separator after it may be any
// run of slashes or backslashes (`https:///tok@host` and `https:\\tok@host`
// are userinfo too — provider-contract.js refuses both), and the userinfo runs
// to the LAST `@` before the path, quotes and escapes included.
const REDACT_CAP = 8192;
const CREDENTIAL_GLOBAL_RE = new RegExp(CREDENTIAL_RE.source.replace("(?:^|[^A-Za-z0-9])", ""), "g");
const USERINFO_RE = /(?<![A-Za-z0-9+.-])([a-z][a-z0-9+.-]*:[\\/]*)[^\s/?#]+@/gi;
function redact(text) {
  let t = String(text);
  if (t.length > REDACT_CAP) t = `${t.slice(0, REDACT_CAP)}…`;
  return t.replace(USERINFO_RE, "$1***@").replace(CREDENTIAL_GLOBAL_RE, "***");
}

// The prompt the parts assemble to — WORKERS.md §4's order: the session note,
// the compiled briefing under its heading, then the task. With no briefing the
// task follows the note directly (a `--no-brief` launch).
function assemblePrompt({ session = "", briefing = "", task = "" } = {}) {
  return briefing
    ? `${session}# Spor briefing (compiled for this task — your standing context)\n\n${briefing}\n\n---\n\n# Task\n\n${task}\n`
    : `${session}${task}`;
}

// The in-memory bundle: {attempt, prompt: {text, parts}, repos, env}. `repos`
// defaults to the attempt's own pins, so a builder states them once.
function createBundle({ attempt, prompt, parts = null, repos = null, env = null }) {
  const pins = (repos || (attempt && attempt.repos) || []).map((r) => ({
    slug: r.slug,
    commit: r.commit,
    branch: r.branch,
    ...(r.url ? { url: r.url } : {}),
  }));
  const cleanParts = {};
  for (const k of PROMPT_PARTS) if (parts && typeof parts[k] === "string" && parts[k]) cleanParts[k] = parts[k];
  return {
    attempt,
    prompt: { text: String(prompt == null ? "" : prompt), parts: cleanParts },
    repos: { bundle_format: BUNDLE_FORMAT, repos: pins },
    env: env && (isPlainObject(env.env) || isPlainObject(env.harness)) ? env : null,
  };
}

// bundle -> [{name, data}] in a stable order (the tar's entry order).
function bundleEntries(bundle) {
  const json = (v) => Buffer.from(`${JSON.stringify(v, null, 2)}\n`);
  const entries = [
    { name: FILES.attempt, data: json(bundle.attempt) },
    { name: FILES.repos, data: json(bundle.repos) },
  ];
  if (bundle.env) entries.push({ name: FILES.env, data: json(bundle.env) });
  entries.push({ name: FILES.prompt, data: Buffer.from(bundle.prompt.text) });
  for (const k of PROMPT_PARTS) {
    const v = bundle.prompt.parts && bundle.prompt.parts[k];
    if (v) entries.push({ name: `prompt/${k}.md`, data: Buffer.from(v) });
  }
  return entries;
}

function isTarPath(p) {
  return /\.tar$/i.test(String(p));
}

// Write a bundle to `dest`: a directory (created; must be absent or empty), or
// a `.tar` archive. Files are 0600 — a bundle names no secret, but a prompt is
// still the operator's working context.
function writeBundle(bundle, dest) {
  const entries = bundleEntries(bundle);
  if (isTarPath(dest)) {
    const mtime = 0;
    const parts = [];
    for (const e of entries) {
      parts.push(tar.tarEntryHeader(e.name, e.data.length, mtime), e.data);
      const pad = (512 - (e.data.length % 512)) % 512;
      if (pad) parts.push(Buffer.alloc(pad));
    }
    parts.push(Buffer.alloc(1024));
    fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
    fs.writeFileSync(dest, Buffer.concat(parts), { mode: 0o600 });
    return { path: path.resolve(dest), kind: "tar", files: entries.map((e) => e.name) };
  }
  if (fs.existsSync(dest) && fs.readdirSync(dest).length) throw new Error(`${dest} is not empty — a bundle is written into a fresh directory`);
  for (const e of entries) {
    const abs = path.join(dest, ...e.name.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, e.data, { mode: 0o600 });
  }
  return { path: path.resolve(dest), kind: "dir", files: entries.map((e) => e.name) };
}

// Read a bundle from a directory or a `.tar`. Returns {ok, bundle} or {ok:
// false, errors}: a missing or unparseable file is a refusal naming it, never
// a throw. The raw text of every file rides along (`raw`) for the secret scan.
function readBundle(src) {
  const files = new Map();
  try {
    const st = fs.statSync(src);
    if (st.isDirectory()) {
      const walk = (dir, rel) => {
        for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
          const r = rel ? `${rel}/${d.name}` : d.name;
          if (d.isDirectory()) walk(path.join(dir, d.name), r);
          else if (d.isFile()) files.set(r, fs.readFileSync(path.join(dir, d.name)));
        }
      };
      walk(src, "");
    } else {
      for (const e of tar.extract(fs.readFileSync(src))) files.set(e.name.replace(/^\.\//, ""), e.data);
    }
  } catch (e) {
    return { ok: false, errors: [`the bundle at ${src} could not be read: ${e.message}`] };
  }
  const errors = [];
  const text = (name) => (files.has(name) ? files.get(name).toString("utf8") : null);
  const parse = (name, required) => {
    const t = text(name);
    if (t == null) {
      if (required) errors.push(`${name}: missing from the bundle`);
      return undefined;
    }
    try {
      return JSON.parse(t);
    } catch (e) {
      errors.push(`${name}: not JSON (${e.message})`);
      return undefined;
    }
  };
  const attempt = parse(FILES.attempt, true);
  const repos = parse(FILES.repos, true);
  const env = parse(FILES.env, false);
  const prompt = text(FILES.prompt);
  if (prompt == null) errors.push(`${FILES.prompt}: missing from the bundle — it is the prompt the harness receives`);
  if (errors.length) return { ok: false, errors };
  const parts = {};
  for (const k of PROMPT_PARTS) {
    const v = text(`prompt/${k}.md`);
    if (v != null) parts[k] = v;
  }
  const raw = {};
  for (const [name, data] of files) raw[name] = data.toString("utf8");
  return { ok: true, bundle: { attempt, prompt: { text: prompt, parts }, repos, env: env === undefined ? null : env }, raw };
}

// Every reason this bundle may not run, or [] — the schema, the pins, the
// settings and the secret rule. `knownSecrets` are values the caller holds as
// credentials (its own Spor token): finding one in the bundle is a leak.
// `raw` (from readBundle) widens the credential scan to every file AS SHIPPED,
// including any the reader does not otherwise interpret.
function verifyBundle(bundle, { raw = null, knownSecrets = [], env = process.env } = {}) {
  const errors = [];
  const secrets = [];
  if (!isPlainObject(bundle)) return { ok: false, errors: ["the bundle is not an object"], secret: false };
  const a = bundle.attempt;
  const v = pc.validate("attempt-spec", a);
  for (const e of v.errors) {
    // The contract's validator quotes offending values; a secret-shaped field
    // is named, never echoed, since a refusal lands in logs.
    if (/^(secrets\[|spor[.:])/.test(e) && !/: is required$/.test(e)) secrets.push(`attempt.json ${e.slice(0, e.indexOf(":"))}: carries a secret by value, not by reference (PROVIDERS.md §4.2)`);
    else errors.push(`attempt.json ${e}`);
  }

  const r = bundle.repos;
  if (!isPlainObject(r) || !Array.isArray(r.repos)) errors.push("repos.json: must be {bundle_format, repos: [...]}");
  else {
    if (r.bundle_format !== BUNDLE_FORMAT) errors.push(`repos.json bundle_format: ${JSON.stringify(r.bundle_format)} is not ${BUNDLE_FORMAT} — this runner reads bundle format ${BUNDLE_FORMAT} only`);
    const pinned = new Map(((a && Array.isArray(a.repos)) ? a.repos : []).map((x) => [x && x.slug, x]));
    if (!r.repos.length) errors.push("repos.json repos: at least one pinned repo is required");
    for (const [i, x] of r.repos.entries()) {
      const p = x && pinned.get(x.slug);
      if (!p) errors.push(`repos.json repos[${i}]: '${x && x.slug}' is not one of the attempt's repos`);
      else if (p.commit !== x.commit || p.branch !== x.branch || (p.url || null) !== (x.url || null)) {
        errors.push(`repos.json repos[${i}]: '${x.slug}' disagrees with attempt.json's pin (commit/branch/url must match exactly)`);
      }
    }
    if (r.repos.length !== pinned.size) errors.push(`repos.json pins ${r.repos.length} repo(s), the attempt ${pinned.size} — every attempt repo is pinned exactly once`);
  }

  if (bundle.env != null) {
    const e = bundle.env;
    if (!isPlainObject(e)) errors.push("env.json: must be an object {env?, harness?}");
    else {
      for (const k of Object.keys(e)) if (k !== "env" && k !== "harness") errors.push(`env.json: unknown key '${k}' (allowed: env, harness)`);
      if (e.env != null) {
        if (!isPlainObject(e.env)) errors.push("env.json env: must be an object of string values");
        else {
          for (const [name, val] of Object.entries(e.env)) {
            if (!ENV_NAME_RE.test(name)) errors.push(`env.json env: '${name}' is not an environment variable name`);
            else if (isSecretEnvName(name) || GENERIC_SECRET_NAME_RE.test(name)) {
              secrets.push(`env.json env.${name}: names a credential — a secret never rides the bundle; the provider delivers it through its secret_delivery channel`);
            } else if (typeof val !== "string") errors.push(`env.json env.${name}: must be a string`);
          }
        }
      }
      if (e.harness != null) {
        if (!isPlainObject(e.harness)) errors.push("env.json harness: must be an object");
        else {
          for (const [k, val] of Object.entries(e.harness)) {
            if (!HARNESS_SETTINGS.includes(k)) errors.push(`env.json harness: unknown key '${k}' (allowed: ${HARNESS_SETTINGS.join(", ")})`);
            else if (k === "read_only" ? typeof val !== "boolean" : typeof val !== "string" || !val) errors.push(`env.json harness.${k}: must be ${k === "read_only" ? "a boolean" : "a non-empty string"}`);
          }
        }
      }
    }
  }

  if (!bundle.prompt || typeof bundle.prompt.text !== "string" || !bundle.prompt.text.trim()) errors.push(`${FILES.prompt}: empty — an attempt with no prompt has nothing to do`);

  // The credential scan, over every file as shipped (or the parsed bundle when
  // there is no raw copy). Names the file/field, never the value.
  const scanned = raw || Object.fromEntries(bundleEntries(bundle).map((x) => [x.name, x.data.toString("utf8")]));
  for (const [name, content] of Object.entries(scanned)) {
    let leaf = null;
    if (/\.json$/.test(name)) {
      try {
        leaf = findString(JSON.parse(content), (s) => CREDENTIAL_RE.test(s), name);
      } catch {
        leaf = CREDENTIAL_RE.test(content) ? name : null;
      }
    } else if (CREDENTIAL_RE.test(content)) leaf = name;
    if (leaf) secrets.push(`a credential-shaped string sits at ${leaf} — secrets travel only as references (PROVIDERS.md §4.2)`);
  }
  const held = [...ambientSecrets(env), ...knownSecrets].filter((s) => typeof s === "string" && s.length >= 8);
  for (const [name, content] of Object.entries(scanned)) {
    if (held.some((s) => content.includes(s))) secrets.push(`${name} carries a credential this process holds — secrets travel only as references (PROVIDERS.md §4.2)`);
  }

  const all = [...secrets, ...errors].map(redact);
  return { ok: all.length === 0, errors: all, secret: secrets.length > 0 };
}

// The bundle `spor attempt build` produces (worker side): the attempt spec
// DERIVED from the execution record (identity, fence, tenant, item), the
// resolved dispatch plan (harness, model, profile and its runtime needs, the
// compiled prompt) and the pinned repo — never hand-written. `server` is the
// graph the attempt's writes land in: a server base, or a local graph's
// nodes dir as a file:// reference (a local-mode attempt). Returns {bundle} or
// {error}.
function bundleFromPlan({ execution, plan, repo, server, deadline, isolation, egress = [], tools = [] }) {
  const x = execution || {};
  const owner = x.owner || null;
  if (!owner || !Number.isInteger(owner.fence)) {
    return { error: `execution ${x.execution_id} has no live owner — an attempt is minted for the instance holding the execution, under its fence (claim it first)` };
  }
  const rt = (plan && plan.profileRuntime) || {};
  const list = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === "string" && s) : []);
  const attempt = {
    contract_version: pc.CONTRACT_VERSION,
    attempt_id: String(owner.instance || owner.worker),
    execution_id: x.execution_id,
    fence: owner.fence,
    tenant: String(x.tenant),
    node_id: x.item.node_id,
    harness: { id: plan.harnessAdapter ? plan.harnessAdapter.id : plan.harness },
    ...(plan.effectiveModel ? { model: String(plan.effectiveModel) } : {}),
    ...(plan.profileCheck && plan.profileCheck.id ? { profile: plan.profileCheck.id } : {}),
    mcp: list(rt.mcp),
    skills: list(rt.skills),
    plugins: list(rt.plugins),
    tools: [...new Set(["git", ...list(rt.tools), ...list(tools)])],
    repos: [{ slug: repo.slug, commit: repo.commit, branch: repo.branch, ...(repo.url ? { url: repo.url } : {}) }],
    egress: { allow: list(egress) },
    secrets: [],
    spor: { server, token_ref: `spor-attempt-token://${x.execution_id}/${owner.fence}` },
    deadline,
    isolation,
    prompt_bundle_ref: IN_BUNDLE_PROMPT_REF,
  };
  const harness = {};
  if (plan.permMode) harness.permission_mode = String(plan.permMode);
  // The EXPLICIT posture only: the runner applies the same defaults (and the
  // same per-adapter validation) the dispatcher does.
  if (plan.sandbox) harness.sandbox = String(plan.sandbox);
  if (plan.approvalPolicy) harness.approval_policy = String(plan.approvalPolicy);
  if (plan.readOnlyPosture) harness.read_only = true;
  const bundle = createBundle({
    attempt,
    prompt: plan.prompt,
    parts: { session: plan.sessionNote || "", briefing: plan.brief || "", task: plan.instruction || "" },
    env: Object.keys(harness).length ? { harness } : null,
  });
  return { bundle };
}

module.exports = {
  redact,
  bundleFromPlan,
  BUNDLE_FORMAT,
  FILES,
  PROMPT_PARTS,
  HARNESS_SETTINGS,
  IN_BUNDLE_PROMPT_REF,
  assemblePrompt,
  createBundle,
  bundleEntries,
  writeBundle,
  readBundle,
  verifyBundle,
};

// shell/providers/stdio.js — the subprocess JSON-over-stdio execution-provider
// binding (task-spor-execution-provider-stdio-binding, constrained-by
// dec-spor-work-execution-provider-contract). PROVIDERS.md §12 is the spec.
//
// A provider is DECLARED machine-locally, exactly like a declared harness:
//
//   dispatch.provider.<id> = {command, args?, env?, inherit_env?, timeout_ms?}
//
// in the user `$SPOR_HOME/config.json` (or the global one) — never a
// committable repo `.spor.json`, which strips the key (config-keys.js
// `noRepo: "machine-local"`): a graph or repo write must never choose what a
// machine executes. The command speaks newline-delimited JSON on stdin/stdout,
// so a provider can be written in any language without touching spor.
//
// LIFETIME: one process per binding instance. `openStdioProvider()` spawns
// nothing; the first request spawns the command and runs the version handshake
// (`hello`), and every later request rides the same process until `close()`.
// A worker opens one binding per pass and closes it at the end of the pass; a
// CLI verb opens one per invocation. A provider must therefore keep what it
// needs to re-find an environment somewhere other than its own memory if its
// environments are meant to outlive a pass — a fresh pass is a fresh process.
//
// LOST ON CRASH: a provider process that exits, or that leaves a request
// unanswered for `timeout_ms` (it is then killed), takes every handle this
// binding instance holds with it. From that moment those handles answer `lost`
// LOCALLY — observe `{state: lost}`, collect a null manifest, cancel `lost`,
// release `{released: true}` — and never consult the provider again, so a
// respawned process that forgot them cannot move a terminal state. A submit
// (or restore) in flight is different: whether the provider acted on it is
// unknown, so it throws LostReply and the worker HOLDS and reconciles under the
// persisted key (PROVIDERS.md §6). Any other request in flight answers
// `provider_exited` / `provider_timeout` (retryable: the next request respawns).
//
// SECRETS BY REFERENCE ONLY (PROVIDERS.md §4.2): a request line is checked
// BEFORE anything is spawned or written. A secret entry carrying a value, a
// `ref` that is not a reference, a credential-shaped string anywhere in the
// line, or a value the caller names as a known secret refuses the request as
// `secret_by_value`; the line never reaches the provider.
//
// ALLOWLISTED ENVIRONMENT (dec-spor-provider-credential-review-signoff-2026-10-09
// (c), PROVIDERS.md §12.6): the child does NOT inherit the worker's
// environment minus a scrub list — a scrub list only removes what it names,
// and a worker's env routinely holds GITHUB_TOKEN, ANTHROPIC_API_KEY, AWS_*
// and whatever else the operator exported. It gets the base allowlist (PATH,
// HOME, LANG, LC_*, TZ, TMPDIR; plus the variables a Windows process cannot
// start without), the names the declaration opts in with `inherit_env`, and
// the declaration's own `env` — neither of which may name a Spor credential.
"use strict";

const os = require("os");
const { spawn } = require("child_process");
const pc = require("../../kernel/provider-contract");
const { LostReply } = require("../provider-conformance");
const { isRelativeCommandPath } = require("../dispatch-harnesses");
const { isSecretEnvName } = require("../secret-env");

const PROVIDER_CONFIG_KEY = "dispatch.provider";
const DECLARATION_KEYS = Object.freeze(["command", "args", "env", "inherit_env", "timeout_ms"]);
// What every provider child inherits from the worker without asking. Nothing
// here carries a credential; anything else is opt-in by name (`inherit_env`).
const BASE_ENV_ALLOWLIST = Object.freeze(["PATH", "HOME", "LANG", "TZ", "TMPDIR"]);
const BASE_ENV_PREFIXES = Object.freeze(["LC_"]);
// A Windows process (node included) cannot reliably start without these; none
// carries a credential. Windows env names are case-insensitive (`Path`), so
// the match there is too.
const WIN32_ENV_ALLOWLIST = Object.freeze(["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "USERPROFILE"]);
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
// `local` is the built-in provider (PROVIDERS.md §11); a declaration cannot
// redefine what it is.
const RESERVED_PROVIDER_IDS = Object.freeze(["local"]);
// `dispatch.provider.default` names the provider a dispatch runs under; it
// shares the map with the declarations but is not one.
const DEFAULT_SELECTOR_KEY = "default";
const DEFAULT_TIMEOUT_MS = 30000;
// One response line may not grow without bound: a provider that never writes a
// newline would otherwise buffer the worker out of memory.
const MAX_LINE_BYTES = 1024 * 1024;
const CLOSE_GRACE_MS = 2000;
// How long an exited provider's stdout may take to drain before its
// generation ends anyway.
const EXIT_DRAIN_MS = 500;

// The codes this binding answers with when the PROVIDER cannot (PROVIDERS.md
// §12.3). The contract's own codes keep their meaning; these extend the list
// the way §2 allows (a worker reads an unknown code as `internal`).
const BINDING_ERROR_CODES = Object.freeze([
  "contract_version_unsupported", // hello answered another version, or refused ours
  "provider_mismatch", // hello named a provider_id other than the declared id
  "provider_protocol_error", // a stdout line that is not a response envelope
  "provider_exited", // the process exited (or never started) with the request in flight
  "provider_timeout", // the request went unanswered for timeout_ms; the process was killed
  "secret_by_value", // the request carried a secret value; refused before spawn
  "invalid_request", // the request failed the contract's validation; refused before spawn
]);

// Credential shapes that are never a reference: GitHub, GitLab, Slack,
// Anthropic and AWS access-key ids. A reference is `<scheme>://…`, so none of
// these can be one; finding one anywhere in a request line means a value is
// about to cross stdio.
const CREDENTIAL_RE = /(?:^|[^A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abeoprs]-[A-Za-z0-9-]{10,}|sk-ant-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})/;
const SECRET_ENV_HINT = /^(SPOR|SUBSTRATE)_/i;

function declarationKey(id, field) {
  return field ? `${PROVIDER_CONFIG_KEY}.${id}.${field}` : `${PROVIDER_CONFIG_KEY}.${id}`;
}

// Validate + canonicalize one raw `dispatch.provider.<id>` value. Returns
// {ok: true, declaration: {id, command, args, env, inheritEnv, timeoutMs}} or {ok: false,
// error}. Loud by design, like normalizeHarnessDeclaration: this is
// hand-authored machine config, so a typo'd key refuses rather than silently
// changing what runs.
function normalizeProviderDeclaration(id, raw) {
  const fail = (error) => ({ ok: false, error });
  if (!PROVIDER_ID_RE.test(String(id || ""))) {
    return fail(`'${id}' is not a usable provider id (lowercase letters, digits and dashes, starting with a letter or digit)`);
  }
  if (RESERVED_PROVIDER_IDS.includes(id)) return fail(`'${id}' is the built-in provider — a declaration cannot redefine it`);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail(`${declarationKey(id)} must be an object declaring at least a 'command'`);
  const unknown = Object.keys(raw).filter((k) => !DECLARATION_KEYS.includes(k));
  if (unknown.length) return fail(`${declarationKey(id)} has unknown key(s) ${unknown.join(", ")} — allowed: ${DECLARATION_KEYS.join(", ")}`);
  if (typeof raw.command !== "string" || !raw.command) {
    return fail(`${declarationKey(id, "command")} must be the provider to run (an absolute path, or a bare name resolved on PATH)`);
  }
  // Same rule as a declared harness's command: a relative path resolves
  // against whatever directory the spawn happens in, not this machine's config.
  if (isRelativeCommandPath(raw.command)) {
    return fail(`${declarationKey(id, "command")} must be an absolute path or a bare name resolved on PATH — '${raw.command}' is a relative path`);
  }
  if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.some((a) => typeof a !== "string"))) {
    return fail(`${declarationKey(id, "args")} must be an array of strings`);
  }
  if (raw.env !== undefined) {
    if (!raw.env || typeof raw.env !== "object" || Array.isArray(raw.env) || Object.values(raw.env).some((v) => typeof v !== "string")) {
      return fail(`${declarationKey(id, "env")} must be an object of string values`);
    }
    // The worker's Spor credentials are scrubbed from the child; the
    // declaration may not hand one back. The attempt names its Spor
    // credential as spor.token_ref, which the provider resolves itself.
    const named = Object.keys(raw.env).filter((k) => isSecretEnvName(k));
    if (named.length) {
      return fail(`${declarationKey(id, "env")} names ${named.join(", ")} — a Spor credential never reaches a provider by value; the attempt carries spor.token_ref for the provider to resolve`);
    }
  }
  if (raw.inherit_env !== undefined) {
    if (!Array.isArray(raw.inherit_env) || raw.inherit_env.some((n) => typeof n !== "string" || !ENV_NAME_RE.test(n))) {
      return fail(`${declarationKey(id, "inherit_env")} must be an array of environment variable names`);
    }
    // Opting a Spor credential back in is the same hand-back `env` refuses.
    const named = raw.inherit_env.filter((k) => isSecretEnvName(k));
    if (named.length) {
      return fail(`${declarationKey(id, "inherit_env")} names ${named.join(", ")} — a Spor credential never reaches a provider by value; the attempt carries spor.token_ref for the provider to resolve`);
    }
  }
  if (raw.timeout_ms !== undefined && !(Number.isInteger(raw.timeout_ms) && raw.timeout_ms > 0)) {
    return fail(`${declarationKey(id, "timeout_ms")} must be a positive integer (milliseconds)`);
  }
  return {
    ok: true,
    declaration: {
      id,
      command: raw.command,
      args: [...(raw.args || [])],
      env: { ...(raw.env || {}) },
      inheritEnv: [...new Set(raw.inherit_env || [])],
      timeoutMs: raw.timeout_ms === undefined ? DEFAULT_TIMEOUT_MS : raw.timeout_ms,
    },
  };
}

// Every declared provider on this machine: Map id -> normalize result
// ({ok, declaration} | {ok: false, error}), in declaration order. The map's
// `default` key is the provider SELECTOR (dispatch.provider.default, read by
// providers/index.js), not a provider, so it is never a row here.
function providerDeclarations(cfg) {
  const raw = cfg && typeof cfg.get === "function" ? cfg.get(PROVIDER_CONFIG_KEY) : null;
  const out = new Map();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const id of Object.keys(raw)) if (id !== DEFAULT_SELECTOR_KEY) out.set(id, normalizeProviderDeclaration(id, raw[id]));
  return out;
}

// The environment a provider child starts with: the base allowlist and the
// declaration's `inherit_env` names, read from the worker's `env`, then the
// declaration's own `env` on top. Never a Spor credential, whatever asked for
// it (normalizeProviderDeclaration refuses those names; this holds for a
// declaration built by hand too).
function providerChildEnv(declaration, env = process.env, platform = process.platform) {
  const win = platform === "win32";
  const norm = (k) => (win ? k.toUpperCase() : k);
  const names = new Set([...BASE_ENV_ALLOWLIST, ...(win ? WIN32_ENV_ALLOWLIST : []), ...((declaration && declaration.inheritEnv) || [])].map(norm));
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (typeof v !== "string" || isSecretEnvName(k)) continue;
    if (names.has(norm(k)) || BASE_ENV_PREFIXES.some((p) => norm(k).startsWith(p))) out[k] = v;
  }
  for (const [k, v] of Object.entries((declaration && declaration.env) || {})) {
    if (isSecretEnvName(k)) continue;
    // On Windows `Path` and `PATH` are one variable, and spawn keeps the
    // first case-insensitive match — drop the inherited spelling so the
    // declared value is the one the child sees.
    if (win) for (const have of Object.keys(out)) if (have !== k && norm(have) === norm(k)) delete out[have];
    out[k] = v;
  }
  return out;
}

// The values this process holds that must never appear in a request line: the
// worker's own Spor credentials, from its environment. A caller adds what it
// resolved elsewhere (the cascade's token) via `knownSecrets`.
function ambientSecrets(env = process.env) {
  const out = [];
  for (const [k, v] of Object.entries(env || {})) {
    if (typeof v === "string" && v.length >= 8 && SECRET_ENV_HINT.test(k) && isSecretEnvName(k)) out.push(v);
  }
  return out;
}

// Why `msg` may not cross stdio, or null. Runs over the request AS IT WOULD BE
// WRITTEN, before any spawn. The message never echoes the value it found.
function secretRefusal(msg, knownSecrets = []) {
  if (msg && msg.op === "submit") {
    const v = pc.validateRequest(msg);
    const leaks = v.ok
      ? []
      : v.errors.filter((e) => /^params\.attempt\.(secrets\[|spor[.:])/.test(e) && !/: is required$/.test(e));
    // Name the fields, never the validator's text: it quotes the offending
    // value, and the refusal lands in logs.
    const at = [...new Set(leaks.map((e) => e.slice(0, e.indexOf(":"))))];
    if (leaks.length) return `the attempt carries a secret by value, not by reference (at ${at.join(", ")})`;
  }
  const line = JSON.stringify(msg);
  const leaf = findString(msg, (s) => CREDENTIAL_RE.test(s));
  if (leaf) return `a credential-shaped string sits at ${leaf} — secrets travel only as references (PROVIDERS.md §4.2)`;
  for (const s of knownSecrets) {
    if (typeof s === "string" && s.length >= 8 && line.includes(s)) return "the request line carries a credential this worker holds — secrets travel only as references (PROVIDERS.md §4.2)";
  }
  return null;
}

function findString(value, test, at = "request") {
  if (typeof value === "string") return test(value) ? at : null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findString(value[i], test, `${at}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const hit = findString(v, test, `${at}.${k}`) || (test(k) ? `${at} (a key)` : null);
      if (hit) return hit;
    }
  }
  return null;
}

function handleKey(handle) {
  return `${handle.provider}\u0000${handle.id}`;
}

function isHandle(h) {
  return !!h && typeof h === "object" && typeof h.provider === "string" && typeof h.id === "string";
}

// openStdioProvider(declaration, opts) -> {id, request, crash, close, held}.
// `request(msg)` takes and answers the contract's envelopes (PROVIDERS.md §2),
// so the conformance runner and a worker drive it like any other provider.
//
// opts: log(line) receives the provider's stderr, one line at a time,
//   prefixed with the provider id (default: the worker's own stderr);
//   knownSecrets: extra values never to send (the cascade's token);
//   env: the worker environment the child's allowlist reads from (process.env);
//   cwd: where the child runs (os.tmpdir(), never a repo checkout).
function openStdioProvider(declaration, opts = {}) {
  const id = declaration.id;
  const timeoutMs = declaration.timeoutMs || DEFAULT_TIMEOUT_MS;
  const log = opts.log || ((line) => process.stderr.write(`${line}\n`));
  const knownSecrets = [...ambientSecrets(opts.env || process.env), ...(opts.knownSecrets || [])];
  const childEnv = providerChildEnv(declaration, opts.env || process.env, opts.platform);

  let proc = null; // the live generation: {child, pending, ready, dead}
  let generation = 0;
  let wireSeq = 0;
  let closed = false;
  const held = new Map(); // handleKey -> handle this instance has seen and not released
  const lost = new Map(); // handleKey -> {since, detail}

  const envelope = (callerId, body) => ({ contract_version: pc.CONTRACT_VERSION, id: callerId, ...body });
  const failure = (callerId, code, message, retryable = false) => envelope(callerId, { ok: false, error: { code, message, retryable } });

  function spawnGeneration() {
    const gen = { n: ++generation, pending: new Map(), dead: null, buf: "", errBuf: "" };
    proc = gen;
    let child;
    try {
      child = spawn(declaration.command, declaration.args, { stdio: ["pipe", "pipe", "pipe"], env: childEnv, cwd: opts.cwd || os.tmpdir(), windowsHide: true });
    } catch (err) {
      die(gen, "provider_exited", `provider ${id} could not be started: ${err.message}`);
      gen.ready = Promise.reject(gen.dead);
      gen.ready.catch(() => {}); // awaited by the request that spawned it
      return gen;
    }
    gen.child = child;
    child.on("error", (err) => die(gen, "provider_exited", `provider ${id} could not be started (${declaration.command}): ${err.message}`));
    // `exit` can fire before stdout is drained, and a provider that writes its
    // last reply and exits must still be heard: wait for stdout's end — bounded,
    // since a grandchild that inherited the pipe can hold it open — then end
    // the generation.
    let stdoutEnded = false;
    child.stdout.on("end", () => {
      stdoutEnded = true;
      if (gen.exited) die(gen, "provider_exited", gen.exited);
    });
    child.on("exit", (code, signal) => {
      gen.exited = `provider ${id} exited (${signal || `code ${code}`})`;
      if (stdoutEnded) return die(gen, "provider_exited", gen.exited);
      setTimeout(() => die(gen, "provider_exited", gen.exited), EXIT_DRAIN_MS).unref();
    });
    child.stdin.on("error", () => {}); // a write to a dead child surfaces as its exit
    child.stdout.on("data", (chunk) => onStdout(gen, chunk));
    child.stderr.on("data", (chunk) => {
      gen.errBuf += chunk.toString("utf8");
      let nl;
      while ((nl = gen.errBuf.indexOf("\n")) >= 0) {
        log(`[provider ${id}] ${gen.errBuf.slice(0, nl).replace(/\r$/, "")}`);
        gen.errBuf = gen.errBuf.slice(nl + 1);
      }
    });
    child.stderr.on("end", () => {
      if (gen.errBuf) log(`[provider ${id}] ${gen.errBuf}`);
      gen.errBuf = "";
    });
    gen.ready = handshake(gen);
    return gen;
  }

  function onStdout(gen, chunk) {
    if (gen.dead) return;
    gen.buf += chunk.toString("utf8");
    let nl;
    while ((nl = gen.buf.indexOf("\n")) >= 0) {
      const line = gen.buf.slice(0, nl).replace(/\r$/, "");
      gen.buf = gen.buf.slice(nl + 1);
      if (line.trim()) onLine(gen, line);
      if (gen.dead) return;
    }
    if (Buffer.byteLength(gen.buf) > MAX_LINE_BYTES) {
      die(gen, "provider_protocol_error", `provider ${id} wrote more than ${MAX_LINE_BYTES} bytes without a newline`, true);
    }
  }

  function onLine(gen, line) {
    let res;
    try {
      res = JSON.parse(line);
    } catch {
      return die(gen, "provider_protocol_error", `provider ${id} wrote a line that is not JSON: ${line.slice(0, 120)}`, true);
    }
    if (!res || typeof res !== "object" || Array.isArray(res) || typeof res.id !== "string" || !gen.pending.has(res.id)) {
      return die(gen, "provider_protocol_error", `provider ${id} answered a request it was never sent (id ${JSON.stringify(res && res.id)})`, true);
    }
    // The binding writes contract_version on every line; a provider may leave
    // it off a response line (§12.2), and a response carrying another one is
    // refused by the envelope schema below.
    if (!("contract_version" in res)) res.contract_version = pc.CONTRACT_VERSION;
    const p = gen.pending.get(res.id);
    const v = p.op === "hello" ? pc.validate("response", res) : pc.validateResponse(res, p.op);
    if (!v.ok) return die(gen, "provider_protocol_error", `provider ${id} answered ${p.op} with a malformed response: ${v.errors.join("; ")}`, true);
    gen.pending.delete(res.id);
    clearTimeout(p.timer);
    p.resolve(res);
  }

  // The generation is over: every request in flight fails with `code`, every
  // held handle is lost, and (for a protocol error or a hang) the child is
  // killed — its stream can no longer be trusted to line up.
  function die(gen, code, message, kill = false) {
    if (gen.dead) return;
    gen.dead = { code, message };
    for (const resolve of gen.onDead || []) setImmediate(resolve);
    if (kill && gen.child) gen.child.kill("SIGKILL");
    const since = new Date().toISOString();
    for (const [key, handle] of held) {
      lost.set(key, { handle, since, detail: `${message}; the environment is lost with it` });
    }
    held.clear();
    for (const p of gen.pending.values()) {
      clearTimeout(p.timer);
      p.reject({ code, message });
    }
    gen.pending.clear();
    if (proc === gen) proc = null;
  }

  function send(gen, op, params, extra = {}) {
    // Nothing reaches the provider: it is dead, or has exited and is only
    // draining — the caller knows it never saw this request.
    if (gen.dead) return Promise.reject({ ...gen.dead, notSent: true });
    if (gen.exited) return Promise.reject({ code: "provider_exited", message: gen.exited, notSent: true });
    const wireId = `${id}-${gen.n}-${++wireSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => die(gen, "provider_timeout", `provider ${id} did not answer ${op} within ${timeoutMs}ms; it was killed`, true), timeoutMs);
      gen.pending.set(wireId, { op, resolve, reject, timer });
      gen.child.stdin.write(`${JSON.stringify({ contract_version: pc.CONTRACT_VERSION, id: wireId, op, ...extra, params })}\n`);
    });
  }

  async function handshake(gen) {
    if (gen.dead) throw gen.dead;
    const res = await send(gen, "hello", { contract_version: pc.CONTRACT_VERSION });
    const refuse = (code, message) => {
      const err = { code, message };
      die(gen, code, message, true);
      throw err;
    };
    if (!res.ok) {
      const why = res.error.code === "contract_version_unsupported" ? "" : ` (${res.error.code})`;
      return refuse("contract_version_unsupported", `provider ${id} refused contract_version ${pc.CONTRACT_VERSION}${why}: ${res.error.message}`);
    }
    const r = res.result || {};
    if (r.contract_version !== pc.CONTRACT_VERSION) {
      return refuse(
        "contract_version_unsupported",
        `provider ${id} speaks contract_version ${JSON.stringify(r.contract_version)}, but this spor speaks ${pc.CONTRACT_VERSION} — upgrade whichever side is behind`,
      );
    }
    if (r.provider_id !== id) {
      return refuse("provider_mismatch", `the command declared as ${declarationKey(id)} says it is provider ${JSON.stringify(r.provider_id)} — fix the declaration's id or the command it runs`);
    }
    return r;
  }

  // Answer an op on a handle the provider took with it when it died.
  function answerLost(msg, rec) {
    const op = msg.op;
    const ok = (result) => envelope(msg.id, { ok: true, result });
    if (op === "observe" || op === "suspend" || op === "resume") return ok({ state: "lost", since: rec.since, detail: rec.detail });
    if (op === "cancel") return ok({ state: "lost" });
    if (op === "collect") return ok({ manifest: null, no_candidate: { reason: rec.detail } });
    if (op === "release") return ok({ released: true });
    return failure(msg.id, "unknown_handle", rec.detail);
  }

  async function request(msg) {
    const callerId = msg && typeof msg.id === "string" && msg.id ? msg.id : "unknown";
    if (closed) return failure(callerId, "provider_exited", `the binding for provider ${id} is closed`);
    const secret = secretRefusal(msg, knownSecrets);
    if (secret) return failure(callerId, "secret_by_value", `refused before reaching provider ${id}: ${secret}`);
    const v = pc.validateRequest(msg);
    if (!v.ok) return failure(callerId, "invalid_request", v.errors.join("; "));
    const handle = msg.params && msg.params.handle;
    if (isHandle(handle) && lost.has(handleKey(handle))) return answerLost(msg, lost.get(handleKey(handle)));

    const gen = proc || spawnGeneration();
    try {
      await gen.ready;
      if (gen.dead) throw gen.dead;
    } catch (err) {
      const code = (err && err.code) || "provider_exited";
      return failure(callerId, code, String((err && err.message) || err), code === "provider_exited" || code === "provider_timeout");
    }
    if (isHandle(handle) && msg.op !== "release") held.set(handleKey(handle), handle);
    let res;
    try {
      res = await send(gen, msg.op, msg.params);
    } catch (err) {
      if ((msg.op === "submit" || msg.op === "restore") && !err.notSent) {
        const lostReply = new LostReply(msg.op);
        lostReply.code = err.code;
        lostReply.detail = err.message;
        throw lostReply;
      }
      if (isHandle(handle) && lost.has(handleKey(handle))) return answerLost(msg, lost.get(handleKey(handle)));
      const code = (err && err.code) || "provider_exited";
      return failure(callerId, code, String((err && err.message) || err), code === "provider_exited" || code === "provider_timeout");
    }
    if (res.ok && (msg.op === "submit" || msg.op === "restore") && isHandle(res.result.handle)) {
      held.set(handleKey(res.result.handle), res.result.handle);
    }
    if (res.ok && msg.op === "release" && isHandle(handle)) held.delete(handleKey(handle));
    return { ...res, id: callerId };
  }

  // Kill the provider process outright (a test's or an operator's crash): the
  // handles it held go lost exactly as on an unplanned exit.
  function crash(signal = "SIGKILL") {
    const gen = proc;
    if (!gen || !gen.child || gen.dead) return Promise.resolve();
    return new Promise((resolve) => {
      (gen.onDead = gen.onDead || []).push(resolve);
      gen.child.kill(signal);
    });
  }

  // End the pass: close the provider's stdin (its cue to wind down), wait a
  // grace period, then kill. Held handles are NOT marked lost — a planned
  // close is not a crash, and the next pass may adopt them.
  function close() {
    closed = true;
    const gen = proc;
    proc = null;
    if (!gen || !gen.child || gen.dead) return Promise.resolve();
    gen.dead = { code: "provider_exited", message: `the binding for provider ${id} is closed` };
    for (const p of gen.pending.values()) {
      clearTimeout(p.timer);
      p.reject(gen.dead);
    }
    gen.pending.clear();
    return new Promise((resolve) => {
      const timer = setTimeout(() => gen.child.kill("SIGKILL"), CLOSE_GRACE_MS);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      gen.child.once("exit", done);
      gen.child.once("error", done); // a command that never started emits no exit
      if (gen.child.pid === undefined || gen.child.exitCode !== null || gen.child.signalCode !== null) {
        clearTimeout(timer);
        resolve();
        return;
      }
      gen.child.stdin.end();
    });
  }

  return {
    id,
    request,
    crash,
    close,
    held: () => [...held.values()],
    lost: () => [...lost.values()].map((r) => r.handle),
  };
}

module.exports = {
  PROVIDER_CONFIG_KEY,
  DECLARATION_KEYS,
  RESERVED_PROVIDER_IDS,
  DEFAULT_TIMEOUT_MS,
  BINDING_ERROR_CODES,
  BASE_ENV_ALLOWLIST,
  WIN32_ENV_ALLOWLIST,
  providerChildEnv,
  declarationKey,
  normalizeProviderDeclaration,
  providerDeclarations,
  secretRefusal,
  // The secret scan's pieces, shared with the attempt bundle's verifier
  // (lib/shell/attempt-bundle.js) so a bundle and a request line refuse the
  // same shapes.
  CREDENTIAL_RE,
  ambientSecrets,
  findString,
  openStdioProvider,
};

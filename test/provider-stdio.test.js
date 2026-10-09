"use strict";
// The subprocess JSON-over-stdio provider binding (task-spor-execution-
// provider-stdio-binding, PROVIDERS.md §12): the stdio-echo example passes the
// whole conformance suite through it (in-process and via `spor provider
// check`), and each binding refusal — version mismatch, malformed line, exit
// mid-call, a hang, a secret value — answers its documented code.

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const stdio = require("../lib/shell/providers/stdio");
const conf = require("../lib/shell/provider-conformance");
const sat = require("../lib/kernel/satisfiability");
const { hermeticEnv } = require("./helpers/env");
const { REPO_FORBIDDEN_PATHS } = require("../lib/config");

const ROOT = path.join(__dirname, "..");
const ECHO = path.join(ROOT, "examples", "providers", "stdio-echo", "provider.js");
const CLI = path.join(ROOT, "bin", "spor.js");

const dirs = [];
function scratch(prefix = "spor-provider-stdio-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
const open = [];
after(async () => {
  for (const p of open) await p.close();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function declare(id, raw) {
  const r = stdio.normalizeProviderDeclaration(id, raw);
  assert.equal(r.ok, true, r.error);
  return r.declaration;
}
function bind(declaration, opts = {}) {
  const lines = [];
  const p = stdio.openStdioProvider(declaration, { log: (l) => lines.push(l), env: hermeticEnv(), ...opts });
  p.logged = lines;
  open.push(p);
  return p;
}
function echoBinding(opts) {
  return bind(declare("stdio-echo", { command: process.execPath, args: [ECHO, "--root", scratch("spor-echo-root-")] }), opts);
}

// A throwaway provider: `handle(msg)` is the body, with `out(obj)` to answer
// and a default hello unless the body takes over. Writes a marker file on
// start so a test can prove it was (or was not) spawned.
function fakeProvider(body, { id = "fake", hello = true } = {}) {
  const dir = scratch("spor-fake-provider-");
  const file = path.join(dir, "p.js");
  const marker = path.join(dir, "started");
  fs.writeFileSync(
    file,
    `require("fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid));
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let buf = "";
process.stdin.on("data", (c) => { buf += c; let n; while ((n = buf.indexOf("\\n")) >= 0) { const l = buf.slice(0, n); buf = buf.slice(n + 1); if (l.trim()) dispatch(JSON.parse(l)); } });
process.stdin.on("end", () => process.exit(0));
function dispatch(msg) {
  ${hello ? `if (msg.op === "hello") return out({ id: msg.id, ok: true, result: { contract_version: 1, provider_id: ${JSON.stringify(id)} } });` : ""}
  handle(msg);
}
function handle(msg) { ${body} }
`,
  );
  return { declaration: declare(id, { command: process.execPath, args: [file], timeout_ms: 1500 }), marker };
}

const req = (op, params = {}, id = `t-${op}`) => ({ contract_version: 1, id, op, params });
const handle = { provider: "fake", id: "env-1" };

function attempt(over = {}) {
  return {
    contract_version: 1,
    attempt_id: "w:1",
    execution_id: "exec-0123456789abcdef",
    fence: 1,
    tenant: "t",
    node_id: "task-x",
    harness: { id: "echo" },
    mcp: [],
    skills: [],
    plugins: [],
    tools: [],
    repos: [{ slug: "r", commit: "a".repeat(40), branch: "b", url: "https://example.invalid/r.git" }],
    egress: { allow: [] },
    secrets: [{ name: "GITHUB_TOKEN", ref: "vault://acme/github" }],
    spor: { server: "https://api.example.invalid", token_ref: "spor-attempt-token://exec-0123456789abcdef/1" },
    deadline: new Date(Date.now() + 600000).toISOString(),
    isolation: "worktree",
    prompt_bundle_ref: "https://example.invalid/p.tar",
    ...over,
  };
}

// ------------------------------------------------------------ conformance

test("stdio-echo passes every conformance scenario through the binding, none skipped", async () => {
  const p = echoBinding();
  const report = await conf.runConformance(p, {
    home: scratch(),
    driver: conf.stdioDriver(p),
    matcher: (caps, a) => sat.satisfiesAttempt(caps, a),
  });
  assert.deepEqual(report.results.filter((r) => !r.ok || r.skipped), []);
  assert.deepEqual(report.results.map((r) => r.name), [...conf.SCENARIO_NAMES]);
});

test("spor provider check stdio-echo passes the suite against a scratch home; capabilities providers lists it", () => {
  const home = scratch("spor-provider-home-");
  const root = scratch("spor-echo-root-");
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ dispatch: { provider: { "stdio-echo": { command: process.execPath, args: [ECHO, "--root", root] }, broken: { command: "./rel/provider" } } } }),
  );
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { env: hermeticEnv({ SPOR_HOME: home }), encoding: "utf8", timeout: 120000 });
  const r = run(["provider", "check", "stdio-echo"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ok +crash-lost/);
  assert.match(r.stdout, /provider stdio-echo passed the conformance suite \(11 scenarios\)/);

  const j = run(["provider", "check", "stdio-echo", "--json"]);
  assert.equal(j.status, 0, j.stderr);
  assert.equal(JSON.parse(j.stdout).ok, true);

  const missing = run(["provider", "check", "nope"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no provider 'nope' is declared on this machine/);
  const broken = run(["provider", "check", "broken"]);
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /dispatch\.provider\.broken\.command must be an absolute path/);

  const list = run(["capabilities", "providers", "--json"]);
  assert.equal(list.status, 0, list.stderr);
  const rows = JSON.parse(list.stdout).providers;
  assert.deepEqual(rows.map((x) => x.provider_id), ["local", "stdio-echo", "broken"]);
  assert.equal(rows[1].binding, "stdio");
  assert.deepEqual(rows[1].capabilities.isolation, ["worktree"]);
  assert.match(rows[2].error, /relative path/);

  const spec = path.join(home, "attempt.json");
  fs.writeFileSync(spec, JSON.stringify(attempt({ secrets: [] })));
  const matched = run(["capabilities", "providers", "--attempt", spec]);
  assert.match(matched.stdout, /provider stdio-echo \(contract v1, stdio binding\)[\s\S]*attempt: +satisfiable/);
  assert.match(matched.stdout, /provider broken \(stdio\): UNAVAILABLE/);
});

// ------------------------------------------------------------ declarations

test("a declaration is refused loudly: relative command, unknown key, reserved id, bad timeout, a Spor credential in env", () => {
  const n = stdio.normalizeProviderDeclaration;
  assert.match(n("p", { command: "./bin/p" }).error, /relative path/);
  assert.match(n("p", { command: "p", argv: [] }).error, /unknown key\(s\) argv/);
  assert.match(n("local", { command: "p" }).error, /built-in provider/);
  assert.match(n("Bad_Id", { command: "p" }).error, /not a usable provider id/);
  assert.match(n("p", { command: "p", timeout_ms: 0 }).error, /positive integer/);
  assert.match(n("p", { command: "p", env: { SPOR_TOKEN: "x" } }).error, /SPOR_TOKEN — a Spor credential never reaches a provider by value/);
  assert.deepEqual(n("p", { command: "/usr/bin/p", env: { VAULT_ADDR: "https://v" } }).declaration, {
    id: "p",
    command: "/usr/bin/p",
    args: [],
    env: { VAULT_ADDR: "https://v" },
    timeoutMs: stdio.DEFAULT_TIMEOUT_MS,
  });
  assert.ok(REPO_FORBIDDEN_PATHS.includes("dispatch.provider"), "a committable .spor.json can never declare what a machine executes");
});

test("dispatch.provider.default is the provider SELECTOR, never a declaration row", () => {
  const cfg = { get: (k) => (k === "dispatch.provider" ? { default: "p", p: { command: "/usr/bin/p" } } : undefined) };
  const decls = stdio.providerDeclarations(cfg);
  assert.deepEqual([...decls.keys()], ["p"]);
  assert.equal(decls.get("p").ok, true);
});

// ------------------------------------------------------------- refusals

test("version mismatch: a hello answering another contract_version is contract_version_unsupported, and no op is sent", async () => {
  const { declaration } = fakeProvider(`if (msg.op === "hello") return out({ id: msg.id, ok: true, result: { contract_version: 2, provider_id: "fake" } }); out({ id: msg.id, ok: true, result: {} });`, { hello: false });
  const p = bind(declaration);
  const res = await p.request(req("describe"));
  assert.equal(res.ok, false);
  assert.equal(res.id, "t-describe");
  assert.equal(res.error.code, "contract_version_unsupported");
  assert.match(res.error.message, /provider fake speaks contract_version 2, but this spor speaks 1/);

  const refusing = bind(fakeProvider(`out({ id: msg.id, ok: false, error: { code: "contract_version_unsupported", message: "I only speak v3" } });`, { hello: false }).declaration);
  const r2 = await refusing.request(req("describe"));
  assert.equal(r2.error.code, "contract_version_unsupported");
  assert.match(r2.error.message, /refused contract_version 1: I only speak v3/);

  // A command that names itself another provider than the id it is declared under.
  const impostor = fakeProvider(`out({ id: msg.id, ok: true, result: {} });`, { id: "someone-else" });
  const r3 = await bind({ ...impostor.declaration, id: "fake" }).request(req("describe"));
  assert.equal(r3.error.code, "provider_mismatch");
  assert.match(r3.error.message, /says it is provider "someone-else"/);
});

test("a malformed line is provider_protocol_error, the process is killed, and held handles go lost", async () => {
  const { declaration } = fakeProvider(`
    if (msg.op === "observe" && !global.seen) { global.seen = true; return out({ id: msg.id, ok: true, result: { state: "running", since: "2026-10-09T00:00:00Z", extra_field: "ignored" } }); }
    process.stdout.write("this is not json\\n");`);
  const p = bind(declaration);
  const first = await p.request(req("observe", { handle }));
  assert.equal(first.ok, true, "unknown response fields are ignored");
  assert.equal(first.result.state, "running");
  const res = await p.request(req("describe"));
  assert.equal(res.error.code, "provider_protocol_error");
  assert.match(res.error.message, /not JSON: this is not json/);
  const after = await p.request(req("observe", { handle }));
  assert.equal(after.result.state, "lost");
  assert.match(after.result.detail, /not JSON/);
  assert.deepEqual(p.lost(), [handle]);
});

test("a response for a request it was never sent, or a malformed envelope, is a protocol error", async () => {
  const p = bind(fakeProvider(`out({ id: "nobody-asked", ok: true, result: {} });`).declaration);
  assert.equal((await p.request(req("describe"))).error.code, "provider_protocol_error");
  const q = bind(fakeProvider(`out({ id: msg.id, ok: "yes" });`).declaration);
  const r = await q.request(req("describe"));
  assert.equal(r.error.code, "provider_protocol_error");
  assert.match(r.error.message, /malformed response/);
});

test("provider exit mid-call: a plain op answers provider_exited, an in-flight submit is a LostReply to hold on, a held handle is lost", async () => {
  const { declaration } = fakeProvider(`
    if (msg.op === "observe") return out({ id: msg.id, ok: true, result: { state: "running", since: "2026-10-09T00:00:00Z" } });
    process.exit(3);`);
  const p = bind(declaration);
  assert.equal((await p.request(req("observe", { handle }))).ok, true);
  const res = await p.request(req("describe"));
  assert.equal(res.error.code, "provider_exited");
  assert.equal(res.error.retryable, true);
  assert.match(res.error.message, /provider fake exited \(code 3\)/);
  // The handle the dead process held answers lost locally, forever.
  const o = await p.request(req("observe", { handle }));
  assert.equal(o.result.state, "lost");
  assert.equal((await p.request(req("cancel", { handle }))).result.state, "lost");
  assert.equal((await p.request(req("collect", { handle }))).result.manifest, null);
  assert.equal((await p.request(req("release", { handle }))).result.released, true);

  // The next request respawns; a submit the process dies on is unknown
  // acceptance — LostReply, never a refusal the worker might act on.
  await assert.rejects(p.request(req("submit", { idempotency_key: "key-12345678", attempt: attempt() })), (err) => {
    assert.ok(err instanceof conf.LostReply);
    assert.equal(err.code, "provider_exited");
    return true;
  });
});

test("a hung provider is killed after timeout_ms: provider_timeout, and its handles go lost", async () => {
  const { declaration } = fakeProvider(`
    if (msg.op === "observe") return out({ id: msg.id, ok: true, result: { state: "running", since: "2026-10-09T00:00:00Z" } });
    /* never answer */`);
  const p = bind({ ...declaration, timeoutMs: 300 });
  assert.equal((await p.request(req("observe", { handle }))).ok, true);
  const t0 = Date.now();
  const res = await p.request(req("describe"));
  assert.ok(Date.now() - t0 >= 280);
  assert.equal(res.error.code, "provider_timeout");
  assert.match(res.error.message, /did not answer describe within 300ms; it was killed/);
  assert.equal((await p.request(req("observe", { handle }))).result.state, "lost");
});

test("a secret value in a request line is secret_by_value, refused before the provider is spawned", async () => {
  const { declaration, marker } = fakeProvider(`out({ id: msg.id, ok: true, result: {} });`);
  const p = bind(declaration, { knownSecrets: ["s3cret-value-held-by-worker"] });
  const cases = [
    attempt({ secrets: [{ name: "GITHUB_TOKEN", ref: "ghp_live0123456789abcdef" }] }),
    attempt({ secrets: [{ name: "GITHUB_TOKEN", ref: "vault://a/b", value: "hunter22" }] }),
    attempt({ spor: { server: "https://s.invalid", token_ref: "spor-attempt-token://x/1", token: "abcdefgh" } }),
    attempt({ model: "ghp_abcdefghijklmnopqrstuvwxyz0123" }),
    attempt({ node_id: "task-x", tenant: "s3cret-value-held-by-worker" }),
  ];
  for (const a of cases) {
    const res = await p.request(req("submit", { idempotency_key: "key-12345678", attempt: a }));
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "secret_by_value", JSON.stringify(res.error));
    assert.doesNotMatch(res.error.message, /hunter22|s3cret-value-held-by-worker|ghp_live0123456789abcdef/);
  }
  assert.equal(fs.existsSync(marker), false, "nothing was spawned");
  // A malformed request is refused before spawn too, under its own code.
  assert.equal((await p.request(req("observe", {}))).error.code, "invalid_request");
  assert.equal(fs.existsSync(marker), false);
  // References alone pass.
  assert.deepEqual(stdio.secretRefusal(req("submit", { idempotency_key: "key-12345678", attempt: attempt() })), null);
});

test("the provider's stderr is mirrored with its id; the child env carries no Spor credential", async () => {
  const { declaration } = fakeProvider(`
    process.stderr.write("warming up\\nhalf a line");
    out({ id: msg.id, ok: true, result: { provider_id: "fake", contract_version: 1, capabilities: { isolation: ["vm"], lifecycle: [] }, token_seen: process.env.SPOR_TOKEN || null, vault: process.env.VAULT_ADDR } });`);
  const p = bind({ ...declaration, env: { VAULT_ADDR: "https://vault.invalid" } }, { env: { ...hermeticEnv(), SPOR_TOKEN: "worker-token-abcdef" } });
  const res = await p.request(req("describe"));
  assert.equal(res.ok, true);
  assert.equal(res.result.token_seen, null);
  assert.equal(res.result.vault, "https://vault.invalid");
  await p.close();
  assert.ok(p.logged.includes("[provider fake] warming up"), p.logged.join("|"));
  assert.ok(p.logged.includes("[provider fake] half a line"), p.logged.join("|"));
  // The worker's own token (read from its env) never crosses stdio.
  const q = bind(declaration, { env: { ...hermeticEnv(), SPOR_TOKEN: "worker-token-abcdef" } });
  const leak = await q.request(req("observe", { handle: { provider: "fake", id: "worker-token-abcdef" } }));
  assert.equal(leak.error.code, "secret_by_value");
});

test("a planned close does not mark held handles lost; a closed binding refuses", async () => {
  const { declaration } = fakeProvider(`out({ id: msg.id, ok: true, result: { state: "running", since: "2026-10-09T00:00:00Z" } });`);
  const p = bind(declaration);
  await p.request(req("observe", { handle }));
  await p.close();
  assert.deepEqual(p.lost(), []);
  assert.equal((await p.request(req("observe", { handle }))).error.code, "provider_exited");
});

test("a provider that writes its last reply and exits is still heard (stdout drains before the generation ends)", async () => {
  // The write completes (its callback) before the exit, so every byte is in
  // the pipe; whether the binding reads it all is the question.
  const { declaration } = fakeProvider(`process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { provider_id: "fake", contract_version: 1, capabilities: { isolation: ["vm"], lifecycle: [] }, pad: "x".repeat(400000) } }) + "\\n", () => process.exit(0));`);
  for (let i = 0; i < 5; i++) {
    const p = bind(declaration);
    const res = await p.request(req("describe"));
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(res.result.pad.length, 400000);
  }
});

test("a command that cannot start: provider_exited, nothing held, a submit is refused (not a LostReply), close resolves", async () => {
  for (const command of [path.join(scratch(), "missing-provider"), "bad\u0000command"]) {
    const p = bind({ id: "fake", command, args: [], env: {}, timeoutMs: 1000 });
    const res = await p.request(req("observe", { handle }));
    assert.equal(res.error.code, "provider_exited", command);
    assert.deepEqual(p.held(), []);
    const sub = await p.request(req("submit", { idempotency_key: "key-12345678", attempt: attempt() }));
    assert.equal(sub.error.code, "provider_exited");
    const q = bind({ id: "fake", command, args: [], env: {}, timeoutMs: 1000 });
    const pending = q.request(req("describe"));
    await q.close();
    assert.equal((await pending).error.code, "provider_exited");
  }
});

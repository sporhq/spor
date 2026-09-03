"use strict";

// Coding-agent CLI adapters for `spor dispatch`. Keep harness-specific argv,
// validation, session-event parsing, and discovery declarations here; the CLI
// owns the common briefing/profile/claim/worktree/supervision lifecycle.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { HARNESS_BINARIES, HARNESS_BIN_ENV, harnessBinKey } = require("../kernel/satisfiability.js");

function tomlString(value) {
  return JSON.stringify(String(value));
}

// Stand-ins an adapter puts in argv for values only the launcher knows. The
// launcher substitutes both right before it writes the supervisor's job file
// (and renders them readably under `--print`), which keeps buildArgs a pure
// function of the profile rather than of the run.
const REPORT_PLACEHOLDER = "__SPOR_REPORT_PATH__";
const CWD_PLACEHOLDER = "__SPOR_CWD__";

// --- launcher resolution ----------------------------------------------------
// (task-spor-dispatch-adapters-opencode-copilot)
//
// A bare-name PATH lookup is not a sufficient way to find a coding-agent CLI.
// On a homebrew-style install the prefix reaches only an INTERACTIVE shell, so
// `opencode` resolves when a human checks it by hand and resolves to nothing
// in the environment a dispatched run actually gets — the adapter passes the
// hand-check and ENOENTs on every real dispatch. Every adapter therefore
// resolves its launcher EXPLICIT-FIRST: the harness's env override, then
// `dispatch.bin.<harness>` from the config cascade (machine-specific, like
// `dispatch.repos` — it belongs in the user `$SPOR_HOME/config.json`), and
// only then the bare default name, which the spawn resolves on PATH exactly
// as it always has. With neither override set the resolved string is the same
// one the previous `env.SPOR_<X>_CMD || "<bin>"` produced, so the shipped
// claude-code and codex launches stay byte-identical.

// The explicitly-configured launcher for one harness, or null. Kept separate
// from harnessCommand() because callers that must REPORT a failure need to
// know whether the string they tried came from configuration or from PATH.
function explicitHarnessBin(id, { env = process.env, cfg = null } = {}) {
  const envKey = HARNESS_BIN_ENV[id];
  const fromEnv = envKey ? env[envKey] : "";
  if (fromEnv) return { path: String(fromEnv), source: `$${envKey}` };
  const fromCfg = cfg && typeof cfg.get === "function" ? cfg.get(harnessBinKey(id)) : null;
  if (typeof fromCfg === "string" && fromCfg) return { path: fromCfg, source: harnessBinKey(id) };
  return null;
}

function harnessCommand(id, env = process.env, cfg = null) {
  const explicit = explicitHarnessBin(id, { env, cfg });
  return explicit ? explicit.path : HARNESS_BINARIES[id];
}

// What a launch of `adapter` would run, and where that came from — the two
// facts a refusal has to NAME so the operator can tell "not installed" apart
// from "installed somewhere this process cannot see".
function describeHarnessBin(adapter, { env = process.env, cfg = null } = {}) {
  // A DECLARED harness (see below) already named its launcher explicitly —
  // that IS the declaration — so there is no PATH default to fall back to and
  // no per-harness env spelling to consult.
  if (adapter && adapter.declaration) {
    const command = adapter.declaration.command;
    return {
      command,
      source: declarationKey(adapter.id, "command"),
      explicit: true,
      onPath: !hasPathSeparator(command),
    };
  }
  const explicit = explicitHarnessBin(adapter.id, { env, cfg });
  const command = explicit ? explicit.path : HARNESS_BINARIES[adapter.id];
  return {
    command,
    source: explicit ? explicit.source : "PATH",
    explicit: !!explicit,
    // A launcher naming no directory is resolved by PATH whether it came from
    // configuration or from the default — `SPOR_CLAUDE_CMD=claude` is still a
    // PATH lookup — so "did this come from config?" is the wrong question for
    // a caller deciding whether a PATH preflight applies.
    onPath: !hasPathSeparator(command),
  };
}

function hasPathSeparator(p) {
  return String(p).includes("/") || String(p).includes("\\");
}

// Does `p` name a file this machine can execute? Asked only of an EXPLICIT
// override, where the answer has to come from the path itself — a PATH scan
// would join `/opt/x/opencode` onto every PATH dir and find nothing.
function isExecutableFile(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() && (process.platform === "win32" || !!(st.mode & 0o111));
  } catch {
    return false;
  }
}

// Is this harness launchable from HERE? An explicit override must exist where
// it says; a bare default has to resolve on PATH. `which` is injected because
// the PATH scan lives in the engine utils, ABOVE lib/ — passing it keeps the
// adapter registry free of an upward require. With no `which` supplied only
// the explicit route can answer, which is what a caller that has no PATH scan
// wants anyway.
function harnessAvailable(id, { env = process.env, cfg = null, which = null } = {}) {
  // The declaration FIRST for a declared id, so this answers the same command
  // the launch will actually run (describeHarnessBin and the adapter's own
  // command() both read `declaration.command` unconditionally). Consulting
  // `dispatch.bin.<id>` first would let a box report a harness available on
  // the strength of a launcher the dispatch then never tries — advertising to
  // the fleet a capability every dispatch would refuse. `declaredLauncher`
  // answers null for every built-in, so their resolution is untouched.
  const explicit = declaredLauncher(id, cfg) || explicitHarnessBin(id, { env, cfg });
  if (explicit) {
    return hasPathSeparator(explicit.path)
      ? isExecutableFile(explicit.path)
      : !!(which && which(explicit.path));
  }
  // No override, no declaration: only a BUILT-IN harness has a default name to
  // scan PATH for. An unknown id has nothing to look up, so it is unavailable
  // — never `which(undefined)`, which some PATH scans answer for.
  const fallback = HARNESS_BINARIES[id];
  return !!(fallback && which && which(fallback));
}

// The launcher a VALID `dispatch.harness.<id>` declaration binds, in the shape
// explicitHarnessBin returns — so the availability check above treats a
// declared harness exactly like an explicitly-overridden built-in one: the
// named path must exist, a bare name must resolve on PATH, and neither is ever
// quietly swapped for something else. Defined here (rather than beside the
// other declaration helpers below) so it sits next to its one caller; a
// harness with no declaration answers null and nothing changes.
function declaredLauncher(id, cfg) {
  if (!cfg || HARNESS_BINARIES[id]) return null;
  const decl = harnessDeclarations(cfg).get(id);
  if (!decl || !decl.ok) return null;
  return { path: decl.declaration.command, source: declarationKey(id, "command") };
}

// The refusal an absent launcher earns, naming the path actually tried and both
// explicit routes to fixing it. Static per adapter for the PATH case (the bare
// name IS what was tried); an explicit override that does not exist surfaces
// through the launcher's own `could not launch <path>: ENOENT`, which already
// names it.
function missingBinaryMessage(id, label) {
  return `${HARNESS_BINARIES[id]} CLI not found (tried '${HARNESS_BINARIES[id]}' on PATH) — install ${label}, or point spor at it with '${harnessBinKey(id)}' in $SPOR_HOME/config.json (or ${HARNESS_BIN_ENV[id]}=/absolute/path)`;
}

// Claude Code's headless print mode (task-spor-claude-adapter-headless-
// supervised). `claude -p` with no positional prompt reads it from STDIN (the
// same discipline every other supervised adapter keeps — the compiled briefing
// never enters argv), and `--output-format stream-json` turns the run into the
// JSONL event stream the shared supervisor already follows: every event carries
// `session_id`, and the terminal `result` event carries the final assistant
// text. `--verbose` is not optional — print mode REFUSES stream-json without
// it ("--output-format=stream-json requires --verbose", measured against Claude
// Code 2.1.259). The identity flags are unchanged from the native launch: the
// agent-scoped token still rides a 0600 `--mcp-config` file plus
// `--strict-mcp-config` (dec-spor-session-identity-active-record), and
// `--model`/`--permission-mode`/`--agent`/`--name` pass through as before.
function claudeArgs({ name, model, permissionMode, agent, mcpConfig }) {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (name) args.push("--name", name);
  if (model) args.push("--model", model);
  if (permissionMode) args.push("--permission-mode", permissionMode);
  if (agent) args.push("--agent", agent);
  if (mcpConfig) args.push("--mcp-config", mcpConfig, "--strict-mcp-config");
  return args;
}

// The native-background launch (`claude --bg`), kept as an explicit OPT-IN
// (`spor dispatch --bg`, or `dispatch.claudeLaunchMode: native-background`) for
// the interactive affordance it alone has — a run a person can `claude attach`
// to — and no longer the default: a `--bg` run detaches into the harness
// daemon, so it has no report channel, its ending is inferred by polling
// `claude agents --json`, and its outcome can never be enforced
// (dec-spor-dispatch-terminal-states-supervised-first). Byte-identical to the
// argv the adapter always built; the prompt is the last positional.
function claudeBackgroundArgs({ name, model, permissionMode, agent, mcpConfig, prompt }) {
  const args = ["--bg"];
  if (name) args.push("--name", name);
  if (model) args.push("--model", model);
  if (permissionMode) args.push("--permission-mode", permissionMode);
  if (agent) args.push("--agent", agent);
  if (mcpConfig) args.push("--mcp-config", mcpConfig, "--strict-mcp-config");
  if (prompt != null) args.push(prompt);
  return args;
}

// Every stream-json event Claude Code emits carries the run's `session_id`
// (the `system`/`init` event is the first, so the bind happens on the first
// line of output rather than at the end).
function claudeSessionFromEvent(event) {
  return event && typeof event.session_id === "string" && event.session_id ? event.session_id : null;
}

// The final report: the terminal `result` event's `result` field is the last
// assistant message in one string, so it is what a "last message wins" reader
// ends on. An `assistant` event's text blocks are taken too, so a stream that
// dies before its `result` (a provider cut-off, a kill) still leaves the last
// thing the agent said rather than nothing; a thinking-only assistant event
// carries no text and is skipped. An error result (`is_error: true`) is still
// text — it is the run's own account of why it stopped, and the exit code is
// what classifies the run, not this.
function claudeReportFromEvent(event) {
  if (!event || typeof event !== "object") return null;
  if (event.type === "result") {
    return typeof event.result === "string" && event.result ? event.result : null;
  }
  if (event.type === "assistant") {
    const content = event.message && Array.isArray(event.message.content) ? event.message.content : [];
    let last = null;
    for (const block of content) {
      if (block && block.type === "text" && typeof block.text === "string" && block.text) last = block.text;
    }
    return last;
  }
  return null;
}

function codexArgs({ model, sandbox, approvalPolicy, reportPath, sporMcp }) {
  const args = [
    "--ask-for-approval", approvalPolicy || "never",
    "exec",
    "--json",
    "--sandbox", sandbox || "workspace-write",
    "--output-last-message", reportPath,
  ];
  if (model) args.push("--model", model);
  if (sporMcp && sporMcp.url) {
    args.push(
      "--config", `mcp_servers.spor.url=${tomlString(sporMcp.url)}`,
      "--config", `mcp_servers.spor.bearer_token_env_var=${tomlString("SPOR_DISPATCH_MCP_TOKEN")}`,
      "--config", "mcp_servers.spor.required=true"
    );
  }
  // stdin carries the compiled prompt so it never appears in argv or process
  // listings. The generic supervisor replaces the report placeholder.
  args.push("-");
  return args;
}

// OpenCode's headless mode. `opencode run` with no positional message reads the
// prompt from STDIN, so the compiled briefing never enters argv (the same
// discipline the Codex adapter keeps), and `--format json` turns the run into
// the JSONL event stream the shared supervisor already knows how to follow.
// `--auto` is the unattended posture dispatch is defined by — the OpenCode
// equivalent of Codex's `--sandbox workspace-write --approval-policy never`
// default; without it a dispatched run stalls on a permission prompt no human
// is there to answer.
function opencodeArgs({ model }) {
  // `--dir` is not belt-and-braces: OpenCode reads its working directory from
  // the shell's `$PWD` rather than getcwd(), and a spawn that sets `cwd`
  // does NOT update that variable — so an OpenCode dispatch left to inherit it
  // silently works in the LAUNCHER's directory and reports success for edits it
  // made to the wrong checkout (measured against opencode 1.18.0). The
  // supervisor substitutes the run's real directory for the placeholder, the
  // same way it does for Codex's report path.
  const args = ["run", "--format", "json", "--auto", "--dir", CWD_PLACEHOLDER];
  if (model) args.push("--model", model);
  return args;
}

// GitHub Copilot CLI's headless mode. `-p/--prompt` takes the prompt as an
// ARGUMENT, which would publish the compiled briefing to every process listing
// on the box; omitting it and piping instead runs the same non-interactive
// path with the prompt on stdin, so this adapter keeps Codex's discipline
// rather than Copilot's documented flag. `--allow-all` is the unattended
// posture (tools/paths/urls, Copilot's `--yolo`), and `--no-ask-user` disables
// the one tool that would otherwise block forever waiting on a human.
// `--no-auto-update` stops the CLI from replacing itself outside CI (observed
// mid-task: 1.0.75 -> 1.0.80 with no operator action) — a dispatched run's
// version should be whatever this box has installed, not whatever npm served
// the moment the run happened to start.
function copilotArgs({ model }) {
  const args = ["--output-format", "json", "--allow-all", "--no-ask-user", "--no-color", "--no-auto-update"];
  if (model) args.push("--model", model);
  return args;
}

// A spawn's `cwd` changes the process's working directory but leaves the
// INHERITED `PWD` pointing at the launcher's, and OpenCode reads that shell
// convention rather than getcwd() — so an OpenCode run left to inherit it
// operates in the launcher's checkout (verified against opencode 1.18.0: a
// spawn with cwd=<repo> from a launcher in <elsewhere> reports `pwd` as
// <elsewhere>). `--dir` above already pins the run's directory; this pins the
// variable too, so anything the run shells out to agrees. Declared HERE rather
// than in the shared supervisor so the harnesses that correctly use getcwd()
// keep the exact launch environment they already had.
function opencodePrepareRun({ cwd } = {}) {
  return cwd ? { env: { PWD: cwd } } : null;
}

// Neither harness has a Codex-style `--output-last-message`, so their final
// report is recovered from the event stream instead: the supervisor keeps the
// LAST text an adapter claims as a final message and writes it to the run's
// report path — the same "last message wins" semantics the Codex flag has.
// Declared per adapter; Codex declares none and keeps writing its own file.
// OpenCode's `text` parts are COMPLETE messages, not streaming deltas (each
// carries its own `time.start`/`time.end`; verified against opencode 1.18.0,
// where a two-step run emitted one `text` part per assistant message), so
// last-wins yields the final message rather than a trailing fragment. Note the
// live suite CANNOT re-derive this for us — it replays this same predicate over
// the run's log, so a switch to incremental parts upstream would satisfy both
// sides and still pass. Re-check a real report by hand when bumping the pinned
// OpenCode version.
function opencodeReportFromEvent(event) {
  if (!event || event.type !== "text") return null;
  const text = event.part && event.part.text;
  return typeof text === "string" && text ? text : null;
}

function copilotReportFromEvent(event) {
  if (!event || event.type !== "assistant.message") return null;
  const text = event.data && event.data.content;
  return typeof text === "string" && text ? text : null;
}

// The flags that belong to OTHER harnesses. Shared by the two adapters below
// because they reject the same set for the same reason: `--permission-mode`
// and `--agent` are Claude Code's, `--sandbox`/`--approval-policy` are Codex's,
// and silently ignoring a flag the operator passed is worse than refusing it.
function rejectForeignOptions(label, { permissionMode, agent, sandbox, approvalPolicy }, hint) {
  const foreign = [
    [permissionMode, "--permission-mode", "Claude Code"],
    [agent, "--agent", "Claude Code"],
    [sandbox, "--sandbox", "Codex"],
    [approvalPolicy, "--approval-policy", "Codex"],
  ].find(([value]) => value);
  if (!foreign) return null;
  const [, flag, owner] = foreign;
  return {
    message: `cannot use ${flag} with a ${label} dispatch — that flag is ${owner}-specific.`,
    hint,
  };
}

// --- nested Codex-from-Codex sandbox isolation ------------------------------
// (dec-spor-nested-codex-supervisor-provisions-codex-home,
// task-spor-nested-codex-dispatch-sandbox-isolation)
//
// A `spor dispatch --profile profile-codex-sol` run FROM an active Codex
// session inherits that outer session's own sandbox, which mounts `~/.codex`
// read-only — the inner `codex exec` then fails before `thread.started`
// because it cannot initialize its state db there. Per
// dec-spor-dispatch-harness-adapter-contract, "environment ... preparation"
// is the ADAPTER's job, not the shared supervisor's — so this stays here,
// behind one optional `prepareRun` hook the supervisor calls generically
// (agent-dispatch-runner.js's runJob), never a harness id check.
//
// The ordinary (non-nested) case — the real CODEX_HOME already writable, the
// one verified by the live host-shell smoke check — must provision nothing:
// `prepareRun` returns null and the run proceeds exactly as before.

function codexRealHome(env) {
  return env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

// The only real proof that a directory is writable is a write that succeeds:
// a permission-bit read means nothing against a read-only bind mount, and a
// missing directory is not evidence of read-only-ness at all — codex has
// simply never run here yet, so there is nothing to isolate FROM (the
// ordinary first-run case must provision nothing, same as an already-writable
// home).
function isWritableDir(dir) {
  if (!fs.existsSync(dir)) return true;
  const probe = path.join(dir, `.spor-write-probe-${process.pid}-${Date.now()}`);
  let wrote = false;
  try {
    fs.writeFileSync(probe, "");
    wrote = true;
    return true;
  } catch {
    return false;
  } finally {
    // Best-effort: if the write itself failed there is nothing to remove; if
    // it succeeded but the unlink fails (rare — e.g. a sticky-bit dir), the
    // probe must not be left behind, and the writable verdict above still
    // stands (the write is what proved it, not the unlink).
    if (wrote) { try { fs.unlinkSync(probe); } catch { /* best-effort */ } }
  }
}

// The files an isolated run legitimately needs FROM the real home to
// authenticate/configure — never the whole tree, and copied read-only
// (0o400) so the isolated run can read them but never write back into (or
// through) them into the real home.
const CODEX_HOME_PROJECTION = ["auth.json", "config.toml"];

function projectCodexHome(realHome, isolatedHome) {
  fs.mkdirSync(path.join(isolatedHome, "state"), { recursive: true });
  for (const name of CODEX_HOME_PROJECTION) {
    const src = path.join(realHome, name);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(isolatedHome, name);
    // Write with mode 0o400 from the file's creation, rather than
    // copyFileSync (which creates dest at the umask-derived default mode,
    // e.g. 0644) followed by a separate chmodSync — that two-step form has a
    // window, however brief, where the projected credential exists wider
    // than 0400.
    fs.writeFileSync(dest, fs.readFileSync(src), { mode: 0o400 });
  }
}

// Called by the shared supervisor right before it spawns the harness child.
// `scratchDir` is a run-scoped directory the supervisor reserves for adapter
// use and owns the lifecycle of (cleaned up on exit/reconcile/prune) — this
// adapter decides what, if anything, to put there. Returns null when nothing
// needs isolating (byte-identical to the pre-isolation behavior); otherwise
// an env overlay plus a cleanup callback the supervisor runs once the child
// is done with it, so the isolated home never outlives the run it served.
function codexPrepareRun({ env = process.env, scratchDir } = {}) {
  if (!scratchDir) return null;
  const realHome = codexRealHome(env);
  if (isWritableDir(realHome)) return null;
  try {
    projectCodexHome(realHome, scratchDir);
  } catch (e) {
    // A failure partway through (e.g. after auth.json copied but before
    // config.toml) must not leave a half-provisioned scratch dir — with a
    // real credential copy in it — sitting around for the supervisor's own
    // catch-and-swallow to only clean up on the 14-day prune sweep. Remove
    // whatever this attempt managed to write, then let the caller fall back
    // to the (broken but no worse than before this fix) real CODEX_HOME.
    try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw e;
  }
  return {
    env: { CODEX_HOME: scratchDir },
    cleanup() {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    },
  };
}

function claudeValidateOptions({ sandbox, approvalPolicy }) {
  if (!sandbox && !approvalPolicy) return null;
  const flag = sandbox ? "--sandbox" : "--approval-policy";
  return {
    message: `cannot use ${flag} with a Claude Code dispatch — that flag is Codex-specific.`,
    hint: "use --permission-mode for Claude Code.",
  };
}

// The opt-in native-background LAUNCH VARIANT of the claude-code adapter
// (task-spor-claude-adapter-headless-supervised). Same id, same launcher, same
// identity mechanism and option validation; only the launch differs — `claude
// --bg` detaches into the harness daemon, so the run is discovered through
// `claude agents --json` (`cli-json`) and its session bound by the launcher
// after the fact (dec-spor-dispatch-bg-session-late-bind). Reached only through
// `launchVariant` (an explicit `--bg` / `dispatch.claudeLaunchMode`), never by
// `getHarness`, so every adapter consumer keeps reading ONE claude-code entry;
// `discoveryAdapters` folds it back in for the run-discovery loops, so a `--bg`
// run — and every native record written before the supervised default — is
// still enumerated and reconciled.
const CLAUDE_NATIVE_BACKGROUND = Object.freeze({
  id: "claude-code",
  label: "Claude Code",
  launchMode: "native-background",
  identityMode: "mcp-file",
  identityNote: "(would mint a session-deferred agent-scoped token + write a 0600 --mcp-config, add --strict-mcp-config, then bind the run session after launch)",
  command: (env = process.env, cfg = null) => harnessCommand("claude-code", env, cfg),
  activeDiscovery: Object.freeze({ kind: "cli-json", args: ["agents", "--json"] }),
  buildArgs: claudeBackgroundArgs,
  validateOptions: claudeValidateOptions,
  sessionPreview: "(allocated by claude --bg at launch, bound after)",
  missingBinary: "claude CLI not on PATH — install Claude Code",
});

const ADAPTERS = Object.freeze({
  // Supervised by default (task-spor-claude-adapter-headless-supervised): a
  // `claude -p --output-format stream-json` child under the shared supervisor,
  // so a Claude run reads its session and final report off its own stream,
  // goes terminal when its process does, and gets the enforced terminal-state
  // contract every other supervised harness gets — instead of the one launch
  // mode whose outcome could never read `resolved`, whose agent-review verdict
  // had no channel to arrive on, and whose ending was inferred by polling.
  "claude-code": Object.freeze({
    id: "claude-code",
    label: "Claude Code",
    launchMode: "supervised-jsonl",
    identityMode: "mcp-file",
    identityNote: "(would mint a session-deferred agent-scoped token + write a 0600 --mcp-config, add --strict-mcp-config, then bind the run session from its stream)",
    command: (env = process.env, cfg = null) => harnessCommand("claude-code", env, cfg),
    activeDiscovery: Object.freeze({ kind: "run-records" }),
    buildArgs: claudeArgs,
    validateOptions: claudeValidateOptions,
    sessionFromEvent: claudeSessionFromEvent,
    reportFromEvent: claudeReportFromEvent,
    sessionPreview: "(read from claude -p --output-format stream-json session_id, bound by supervisor)",
    missingBinary: "claude CLI not on PATH — install Claude Code",
    nativeVariant: CLAUDE_NATIVE_BACKGROUND,
  }),
  codex: Object.freeze({
    id: "codex",
    label: "Codex",
    launchMode: "supervised-jsonl",
    identityMode: "env-mcp",
    identityNote: "(would mint a session-deferred agent token, inject it through env-backed Spor MCP config, then bind the Codex thread after launch)",
    command: (env = process.env, cfg = null) => harnessCommand("codex", env, cfg),
    activeDiscovery: Object.freeze({ kind: "run-records" }),
    buildArgs: codexArgs,
    prepareRun: codexPrepareRun,
    validateOptions({ permissionMode, agent, sandbox, approvalPolicy }) {
      // --agent (claude --agent, a harness AGENT DEFINITION) has no Codex
      // equivalent at all — always a hard error, checked before permissionMode
      // so a combined `--agent ... --permission-mode bypassPermissions` still
      // refuses instead of silently dropping the --agent request.
      if (agent) {
        return {
          message: `cannot use --agent with a Codex dispatch — that flag is Claude Code-specific.`,
          hint: "Codex runs unattended with --sandbox workspace-write --approval-policy never by default; override those Codex flags explicitly if needed.",
        };
      }
      if (!permissionMode) return null;
      // bypassPermissions is the one Claude permission-mode value with a real
      // Codex equivalent — "run unattended, don't gate on approvals or the
      // sandbox" — so it TRANSLATES instead of hard-erroring
      // (issue-spor-codex-dispatch-permission-bypass-error): orchestrators and
      // scripts that pass the same bypass flag to every dispatch regardless of
      // harness keep working against a Codex profile, with a loud warning
      // instead of a silent behavior change. An explicit --sandbox/
      // --approval-policy the caller already passed wins over the translated
      // default (they said what they wanted). Every OTHER permission-mode value
      // (default/plan/acceptEdits/…) has no Codex analog and still hard-errors.
      if (permissionMode === "bypassPermissions") {
        const translatedSandbox = sandbox || "danger-full-access";
        const translatedApprovalPolicy = approvalPolicy || "never";
        return {
          translate: { sandbox: translatedSandbox, approvalPolicy: translatedApprovalPolicy },
          warning:
            `warning: --permission-mode bypassPermissions has no Codex flag; translating to ` +
            `--sandbox ${translatedSandbox} --ask-for-approval ${translatedApprovalPolicy} for this Codex dispatch ` +
            `(pass --sandbox/--approval-policy explicitly to override).`,
        };
      }
      return {
        message: `cannot use --permission-mode with a Codex dispatch — that flag is Claude Code-specific.`,
        hint: "Codex runs unattended with --sandbox workspace-write --approval-policy never by default; override those Codex flags explicitly if needed.",
      };
    },
    sessionFromEvent(event) {
      return event && event.type === "thread.started" ? event.thread_id || null : null;
    },
    sessionPreview: "(read from codex exec thread.started, bound by supervisor)",
    missingBinary: "codex CLI not on PATH — install Codex",
  }),
  // The two secondary CLIs (task-spor-dispatch-adapters-opencode-copilot).
  // Both are ADDITIVE registry entries per
  // dec-spor-dispatch-harness-adapter-contract: they reuse the supervised-JSONL
  // launch mode the Codex adapter established and add no branch to the shared
  // supervisor, only declarations it already consults.
  //
  // Neither can carry the Spor MCP the way Codex does (OpenCode configures MCP
  // servers in its own config file, and Copilot's --additional-mcp-config would
  // put the bearer in argv), so both declare `env-token`: the dispatch still
  // mints a session-deferred agent-scoped token and hands it to the run as
  // SPOR_TOKEN, so the `spor` CLI inside the run is agent-attributed — there is
  // just no injected MCP server.
  opencode: Object.freeze({
    id: "opencode",
    label: "OpenCode",
    launchMode: "supervised-jsonl",
    identityMode: "env-token",
    identityNote: "(would mint a session-deferred agent token, hand it to the run as SPOR_TOKEN, then bind the OpenCode session after launch)",
    command: (env = process.env, cfg = null) => harnessCommand("opencode", env, cfg),
    activeDiscovery: Object.freeze({ kind: "run-records" }),
    buildArgs: opencodeArgs,
    prepareRun: opencodePrepareRun,
    reportFromEvent: opencodeReportFromEvent,
    validateOptions(options) {
      return rejectForeignOptions("OpenCode", options, "OpenCode runs unattended with --auto; pass --model to pick its model.");
    },
    // Every OpenCode event carries the session it belongs to, so the bind
    // happens on the first line of output rather than at the end.
    sessionFromEvent(event) {
      return event && typeof event.sessionID === "string" ? event.sessionID : null;
    },
    sessionPreview: "(read from opencode run --format json sessionID, bound by supervisor)",
    missingBinary: missingBinaryMessage("opencode", "OpenCode"),
  }),
  copilot: Object.freeze({
    id: "copilot",
    label: "GitHub Copilot CLI",
    launchMode: "supervised-jsonl",
    identityMode: "env-token",
    identityNote: "(would mint a session-deferred agent token, hand it to the run as SPOR_TOKEN, then bind the Copilot session after launch)",
    command: (env = process.env, cfg = null) => harnessCommand("copilot", env, cfg),
    activeDiscovery: Object.freeze({ kind: "run-records" }),
    buildArgs: copilotArgs,
    reportFromEvent: copilotReportFromEvent,
    validateOptions(options) {
      return rejectForeignOptions("Copilot", options, "Copilot runs unattended with --allow-all --no-ask-user; pass --model to pick its model.");
    },
    // Copilot stamps the session id only on its terminal `result` event, so
    // this run binds LATE — the supervisor still binds before the record goes
    // terminal (it drains the stream and awaits the bind on close), but a
    // Copilot run is unbound for its whole working life. Read from any event
    // carrying the field so a future version stamping it earlier binds earlier
    // with no change here.
    sessionFromEvent(event) {
      return event && typeof event.sessionId === "string" ? event.sessionId : null;
    },
    sessionPreview: "(read from copilot --output-format json result.sessionId, bound by supervisor at exit)",
    missingBinary: missingBinaryMessage("copilot", "GitHub Copilot CLI"),
  }),
});

// --- declared custom harnesses ---------------------------------------------
// (task-spor-dispatch-declarative-custom-harness)
//
// A profile may name a harness this client has NO in-code adapter for — a
// team's modified Claude Code build, an internal wrapper. The graph carries
// ONLY the id: what that id EXECUTES is bound machine-locally, in the same
// config cascade `dispatch.bin.<harness>` already lives in
// (`dispatch.harness.<id>`, so it belongs in the user $SPOR_HOME/config.json,
// never a committable `.spor.json`). That split IS the security line — a graph
// write must never define what a machine executes — and it is enforced twice:
// the profile's launch-defining fields are refused outright by the dispatch
// path (kernel/satisfiability.js graphLaunchFields), and nothing here ever
// reads a command, argv, or env from graph data.
//
// V1 is deliberately narrow: the declaration binds a command, an argv
// template, report recovery, and an optional session-id path. Everything else
// is FIXED — supervised-jsonl launch, the prompt on stdin, identityMode
// env-token — so a declared harness reuses the supervisor the Codex/OpenCode/
// Copilot adapters already established and adds no branch to it, exactly as
// dec-spor-dispatch-harness-adapter-contract requires of an additive entry.

const DECLARED_HARNESS_KEY = "dispatch.harness";
// The same shape the server's SLUG_RE accepts, so a declared id is a token a
// profile can carry and a fleet can publish without re-quoting it.
const DECLARED_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const DECLARATION_KEYS = ["command", "args", "label", "report", "session"];
// Argv template tokens the operator writes, and the launcher-substituted
// placeholder each becomes. Written as {cwd}/{report} rather than the raw
// __SPOR_*__ spellings because a declaration is hand-authored config; they map
// onto the SAME placeholders the in-code adapters emit, so the launcher
// substitutes them by the one mechanism it already had.
const ARG_TOKENS = Object.freeze({ "{cwd}": CWD_PLACEHOLDER, "{report}": REPORT_PLACEHOLDER });

// The built-in adapter for `id`, or null. An OWN-property lookup, not
// `ADAPTERS[id]`: harness ids reach here from graph data (a profile's
// `harness:`), and a plain bracket read answers `Object.prototype`'s own
// members — `harness: constructor` would resolve to a truthy non-adapter and
// crash the dispatch on the first method call rather than being refused as
// the unknown harness it is.
function builtinAdapter(id) {
  return Object.prototype.hasOwnProperty.call(ADAPTERS, id) ? ADAPTERS[id] : null;
}

function declarationKey(id, field) {
  return field ? `${DECLARED_HARNESS_KEY}.${id}.${field}` : `${DECLARED_HARNESS_KEY}.${id}`;
}

function strList(v) {
  if (typeof v === "string") return v ? [v] : [];
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string" && x);
  return null;
}

// One dotted path into a parsed JSONL event -> the value there, or undefined.
// Plain key walk (numeric segments index arrays); no wildcards — a declaration
// names the exact field its harness stamps.
function pluck(obj, dotted) {
  let cur = obj;
  for (const seg of String(dotted).split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[seg];
  }
  return cur;
}

function firstString(event, paths) {
  for (const p of paths) {
    const v = pluck(event, p);
    if (typeof v === "string" && v) return v;
  }
  return null;
}

// Validate + canonicalize one raw `dispatch.harness.<id>` value. Returns
// {ok:true, declaration} or {ok:false, error}. LOUD by design: this is
// hand-authored machine config, so a typo'd key is refused with the allowed
// set rather than silently changing what launches.
function normalizeHarnessDeclaration(id, raw) {
  const fail = (error) => ({ ok: false, error });
  if (!DECLARED_ID_RE.test(String(id || ""))) {
    return fail(`'${id}' is not a usable harness id (lowercase letters, digits and dashes, starting with a letter or digit)`);
  }
  if (builtinAdapter(id)) {
    return fail(`'${id}' is a built-in harness — a declaration cannot redefine what it runs; point '${harnessBinKey(id)}' at a different launcher instead`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fail(`${declarationKey(id)} must be an object declaring at least a 'command'`);
  }
  const unknown = Object.keys(raw).filter((k) => !DECLARATION_KEYS.includes(k));
  if (unknown.length) {
    return fail(`${declarationKey(id)} has unknown key(s) ${unknown.join(", ")} — allowed: ${DECLARATION_KEYS.join(", ")} (launch mode, prompt transport and identity are fixed for a declared harness)`);
  }
  if (typeof raw.command !== "string" || !raw.command) {
    return fail(`${declarationKey(id, "command")} must be the launcher to run (a path, or a bare name resolved on PATH)`);
  }
  if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.some((a) => typeof a !== "string"))) {
    return fail(`${declarationKey(id, "args")} must be an array of strings`);
  }
  // An entry naming a model that did not resolve is dropped WHOLE at build
  // time, so two spellings have to be refused here rather than fail silently
  // at launch: a bare `{model}` entry leaves the flag before it dangling and
  // swallowing the next argument (`["--model", "{model}", "--json"]` ->
  // `["--model", "--json"]`), and an entry that also carries {cwd}/{report}
  // takes those with it — a report path the harness is then never told,
  // which reads as a run that produced nothing rather than as a bad
  // declaration.
  for (const a of raw.args || []) {
    if (!a.includes("{model}")) continue;
    // The entry has to be FLAG-SHAPED, not merely non-empty. Any entry
    // carrying {model} is dropped whole when no model resolves, so a VALUE
    // entry — `"{model}"`, `"anthropic/{model}"`, `"{model}-latest"` — leaves
    // the flag before it to swallow the next argument (`["--model",
    // "anthropic/{model}", "--json"]` -> `["--model", "--json"]`, and the
    // harness reads `--json` as its model). Requiring the token to live inside
    // the flag that carries it makes the drop remove a complete option.
    if (!a.startsWith("-")) {
      return fail(`${declarationKey(id, "args")} entry ${JSON.stringify(a)} must inline {model} into the flag that carries it (write "--model=${a}" or "--model={model}") — an entry carrying {model} is dropped whole when no model resolves, so a bare value leaves the flag before it to swallow the next argument`);
    }
    if (a.includes("{cwd}") || a.includes("{report}")) {
      return fail(`${declarationKey(id, "args")} entry ${JSON.stringify(a)} mixes {model} with {cwd}/{report} — the whole entry is dropped when no model resolves, taking the path with it; give them separate entries`);
    }
  }
  if (raw.label !== undefined && (typeof raw.label !== "string" || !raw.label)) {
    return fail(`${declarationKey(id, "label")} must be a non-empty string`);
  }
  const args = raw.args ? raw.args.slice() : [];

  // report: "lastText" (default) | "file" | {from, text}
  const rawReport = raw.report === undefined ? "lastText" : raw.report;
  const reportSpec = typeof rawReport === "string" ? { from: rawReport } : rawReport;
  if (!reportSpec || typeof reportSpec !== "object" || Array.isArray(reportSpec)) {
    return fail(`${declarationKey(id, "report")} must be "lastText", "file", or an object`);
  }
  const reportUnknown = Object.keys(reportSpec).filter((k) => !["from", "text"].includes(k));
  if (reportUnknown.length) {
    return fail(`${declarationKey(id, "report")} has unknown key(s) ${reportUnknown.join(", ")} — allowed: from, text`);
  }
  const from = reportSpec.from === undefined ? "lastText" : reportSpec.from;
  if (from !== "lastText" && from !== "file") {
    return fail(`${declarationKey(id, "report.from")} must be "lastText" (recover the run's last message from its event stream) or "file" (the harness writes the report itself)`);
  }
  const reportText = reportSpec.text === undefined ? ["text"] : strList(reportSpec.text);
  if (from === "lastText" && (!reportText || !reportText.length)) {
    return fail(`${declarationKey(id, "report.text")} must name the JSON path(s) carrying a final message`);
  }
  if (from === "file" && !args.some((a) => a.includes("{report}"))) {
    return fail(`${declarationKey(id, "report")} is "file", so ${declarationKey(id, "args")} must pass the run's report path to the harness with the {report} token`);
  }

  const session = raw.session === undefined ? [] : strList(raw.session);
  if (!session) return fail(`${declarationKey(id, "session")} must be a JSON path (or a list of them) into the harness's JSONL events`);

  return {
    ok: true,
    declaration: {
      id,
      command: raw.command,
      args,
      label: raw.label || id,
      report: from === "file" ? { from } : { from, text: reportText },
      session,
    },
  };
}

// The argv a declared harness launches with: the template with {model}
// substituted (an entry naming a model that did not resolve is DROPPED, so
// `--model={model}` disappears wholesale rather than passing an empty flag)
// and {cwd}/{report} rewritten to the launcher's placeholders. Pure in the
// same sense as every other buildArgs — a function of the profile, not the run.
function declaredArgs(declaration, { model } = {}) {
  const out = [];
  for (const raw of declaration.args) {
    let arg = raw;
    if (arg.includes("{model}")) {
      if (!model) continue;
      arg = arg.split("{model}").join(model);
    }
    for (const [token, placeholder] of Object.entries(ARG_TOKENS)) {
      if (arg.includes(token)) arg = arg.split(token).join(placeholder);
    }
    out.push(arg);
  }
  return out;
}

// Synthesize the adapter for a NORMALIZED declaration. Same object shape the
// frozen ADAPTERS carry, so every consumer — the launcher, the supervisor,
// `--print`, run discovery — reads it through the fields it already reads and
// needs no "is this declared?" branch.
function declaredAdapter(declaration) {
  const d = declaration;
  // Every field is checked, not just `command`: this is also called by the
  // supervisor on a declaration read back off DISK (the job file), where a
  // truncated write or an older-format record would otherwise throw on the
  // first field read — outside runJob's try blocks, so the run record would be
  // stranded non-terminal, which is the exact hole the terminal-state contract
  // exists to close. An unrecognizable shape answers null, and runJob's
  // `!adapter` guard turns that into an ordinary exit-2 refusal.
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  if (typeof d.id !== "string" || !d.id || typeof d.command !== "string" || !d.command) return null;
  if (!Array.isArray(d.args) || !Array.isArray(d.session)) return null;
  if (!d.report || typeof d.report !== "object" || Array.isArray(d.report)) return null;
  // An UNRECOGNIZED `from` must read as unrecognizable, not fall through to
  // file recovery: that would leave a run that ends cleanly and reports
  // nothing, with no signal anywhere that its declaration was wrong.
  if (d.report.from !== "lastText" && d.report.from !== "file") return null;
  if (d.report.from === "lastText" && !Array.isArray(d.report.text)) return null;
  const bound = d.session.length
    ? `then bind the ${d.label} session after launch`
    : `this declaration extracts no session id, so the run is never bound to one`;
  return Object.freeze({
    id: d.id,
    label: d.label,
    declared: true,
    declaration: d,
    launchMode: "supervised-jsonl",
    identityMode: "env-token",
    identityNote: `(would mint a session-deferred agent token, hand it to the run as SPOR_TOKEN, ${bound})`,
    command: () => d.command,
    activeDiscovery: Object.freeze({ kind: "run-records" }),
    buildArgs: (opts) => declaredArgs(d, opts || {}),
    validateOptions(options) {
      return rejectForeignOptions(
        d.label,
        options,
        `a declared harness runs exactly the argv in ${declarationKey(d.id, "args")}; pass --model to fill its {model} token.`
      );
    },
    reportFromEvent: d.report.from === "lastText"
      ? (event) => (event ? firstString(event, d.report.text) : null)
      : undefined,
    sessionFromEvent: d.session.length ? (event) => (event ? firstString(event, d.session) : null) : undefined,
    sessionPreview: d.session.length
      ? `(read from the declared ${d.session.join(" / ")} JSON path, bound by supervisor)`
      : "(this declaration names no session path — the run is not bound to an agent session)",
    missingBinary: `${d.command} not found (tried '${d.command}' on PATH) — install it, or give '${declarationKey(d.id, "command")}' an absolute path in $SPOR_HOME/config.json`,
  });
}

// Every `dispatch.harness.*` declaration in the cascade, normalized. Malformed
// entries are RETAINED as errors rather than dropped: a dispatch that names one
// must say why it refused, not report the harness simply unknown.
function harnessDeclarations(cfg) {
  const raw = cfg && typeof cfg.get === "function" ? cfg.get(DECLARED_HARNESS_KEY) : null;
  const out = new Map();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const id of Object.keys(raw)) out.set(id, normalizeHarnessDeclaration(id, raw[id]));
  return out;
}

// The adapter for `id`, wherever it comes from: the in-code registry first (a
// declaration can never redefine a built-in), then this machine's declarations.
// {adapter, error, declared} — `error` is set only when a declaration exists
// and is unusable.
function resolveHarness(id, { cfg = null } = {}) {
  const built = builtinAdapter(id);
  if (built) return { adapter: built, error: null, declared: false };
  const decl = harnessDeclarations(cfg).get(id);
  if (!decl) return { adapter: null, error: null, declared: false };
  if (!decl.ok) return { adapter: null, error: decl.error, declared: true };
  return { adapter: declaredAdapter(decl.declaration), error: null, declared: true };
}

// The ids this machine can launch — built-ins plus every VALID declaration.
// Used by the capability probe (so `spor capabilities` reflects declared ids)
// and by the refusal that lists what this client supports.
function declaredHarnessIds(cfg) {
  const ids = [];
  for (const [id, decl] of harnessDeclarations(cfg)) if (decl.ok) ids.push(id);
  return ids;
}

function getHarness(id, opts) {
  const built = builtinAdapter(id);
  if (built) return built;
  return opts ? resolveHarness(id, opts).adapter : null;
}

// The in-code registry, in its shipped order. With a cascade passed in, the
// machine's valid declarations follow it — declared entries are always LAST so
// the built-in identity and order stay exactly what they were.
function harnesses(opts) {
  const built = Object.values(ADAPTERS);
  if (!opts || !opts.cfg) return built;
  const extra = [];
  for (const [, decl] of harnessDeclarations(opts.cfg)) {
    if (!decl.ok) continue;
    const adapter = declaredAdapter(decl.declaration);
    if (adapter) extra.push(adapter);
  }
  return built.concat(extra);
}

// The adapter to LAUNCH under, given an explicit launch-mode request: null
// (or the adapter's own mode) answers the adapter itself; "native-background"
// answers the adapter's declared native variant, or null when it has none —
// the caller decides whether that is a refusal (an explicit `--bg` on a harness
// with no background mode) or a no-op (a standing config knob that only means
// anything for the harness that has one).
function launchVariant(adapter, mode) {
  if (!adapter) return null;
  if (!mode || mode === adapter.launchMode || mode === "supervised") return adapter;
  if (mode === "native-background") return adapter.nativeVariant || null;
  return null;
}

// Every adapter a run-discovery loop must consult: the launchable registry
// PLUS each built-in's native variant, so a `--bg` run (and a pre-supervised
// native record) is still enumerated through `claude agents --json` while the
// supervised default is discovered from its run records. A variant shares its
// adapter's id; the loops tell them apart by `activeDiscovery.kind`, exactly
// as they already told run-records harnesses from cli-json ones.
function discoveryAdapters(opts) {
  const out = [];
  for (const adapter of harnesses(opts)) {
    out.push(adapter);
    if (adapter.nativeVariant) out.push(adapter.nativeVariant);
  }
  return out;
}

module.exports = {
  getHarness, harnesses, launchVariant, discoveryAdapters, codexPrepareRun, codexRealHome, isWritableDir,
  harnessCommand, explicitHarnessBin, describeHarnessBin, harnessAvailable, isExecutableFile,
  REPORT_PLACEHOLDER, CWD_PLACEHOLDER,
  DECLARED_HARNESS_KEY, declarationKey, normalizeHarnessDeclaration, declaredAdapter,
  harnessDeclarations, resolveHarness, declaredHarnessIds, declaredArgs,
};

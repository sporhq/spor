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
  const explicit = explicitHarnessBin(id, { env, cfg });
  if (explicit) {
    return hasPathSeparator(explicit.path)
      ? isExecutableFile(explicit.path)
      : !!(which && which(explicit.path));
  }
  return !!(which && which(HARNESS_BINARIES[id]));
}

// The refusal an absent launcher earns, naming the path actually tried and both
// explicit routes to fixing it. Static per adapter for the PATH case (the bare
// name IS what was tried); an explicit override that does not exist surfaces
// through the launcher's own `could not launch <path>: ENOENT`, which already
// names it.
function missingBinaryMessage(id, label) {
  return `${HARNESS_BINARIES[id]} CLI not found (tried '${HARNESS_BINARIES[id]}' on PATH) — install ${label}, or point spor at it with '${harnessBinKey(id)}' in $SPOR_HOME/config.json (or ${HARNESS_BIN_ENV[id]}=/absolute/path)`;
}

function claudeArgs({ name, model, permissionMode, agent, mcpConfig, prompt }) {
  const args = ["--bg"];
  if (name) args.push("--name", name);
  if (model) args.push("--model", model);
  if (permissionMode) args.push("--permission-mode", permissionMode);
  if (agent) args.push("--agent", agent);
  if (mcpConfig) args.push("--mcp-config", mcpConfig, "--strict-mcp-config");
  if (prompt != null) args.push(prompt);
  return args;
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
function copilotArgs({ model }) {
  const args = ["--output-format", "json", "--allow-all", "--no-ask-user", "--no-color"];
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

const ADAPTERS = Object.freeze({
  "claude-code": Object.freeze({
    id: "claude-code",
    label: "Claude Code",
    launchMode: "native-background",
    identityMode: "mcp-file",
    identityNote: "(would mint a session-deferred agent-scoped token + write a 0600 --mcp-config, add --strict-mcp-config, then bind the run session after launch)",
    command: (env = process.env, cfg = null) => harnessCommand("claude-code", env, cfg),
    activeDiscovery: Object.freeze({ kind: "cli-json", args: ["agents", "--json"] }),
    buildArgs: claudeArgs,
    validateOptions({ sandbox, approvalPolicy }) {
      if (!sandbox && !approvalPolicy) return null;
      const flag = sandbox ? "--sandbox" : "--approval-policy";
      return {
        message: `cannot use ${flag} with a Claude Code dispatch — that flag is Codex-specific.`,
        hint: "use --permission-mode for Claude Code.",
      };
    },
    sessionPreview: "(allocated by claude --bg at launch, bound after)",
    missingBinary: "claude CLI not on PATH — install Claude Code",
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

function getHarness(id) {
  return ADAPTERS[id] || null;
}

function harnesses() {
  return Object.values(ADAPTERS);
}

module.exports = {
  getHarness, harnesses, codexPrepareRun, codexRealHome, isWritableDir,
  harnessCommand, explicitHarnessBin, describeHarnessBin, harnessAvailable, isExecutableFile,
  REPORT_PLACEHOLDER, CWD_PLACEHOLDER,
};

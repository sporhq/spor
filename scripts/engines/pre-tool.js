"use strict";
// PreToolUse engine (Write|Edit|NotebookEdit|Bash): the dispatch/delegation
// worktree isolation guard (issue-spor-dispatch-worktree-absolute-path-
// bypass). A delegated agent's cwd-based isolation (a linked git worktree)
// only stops it from wandering out by accident — an absolute path, or a
// `cd` out of the worktree, still lands writes and commits in the SHARED
// main checkout, tangling other agents' concurrent work. This engine denies
// exactly that: a Write/Edit/NotebookEdit whose resolved target, or a Bash
// `git commit`/`add`/`apply` whose effective working tree, resolves into the
// main checkout instead of the session's own worktree.
//
// It also refuses pattern-based process termination (pkill/killall) from Bash.
//
// Active ONLY inside a dispatch worktree session (a linked git worktree
// whose main checkout sits elsewhere) — a plain repo or non-repo cwd is a
// pure no-op, so ordinary sessions see byte-identical (no-output) behavior.

const path = require("path");
const u = require("./util");
const shellAst = require("./shell-ast");

// A linked git worktree whose main checkout differs from its own toplevel —
// the same test inferenceRoot() already relies on to collapse worktree
// identities onto their main repo (issue-cc-project-identity-monorepo-
// worktree). Runs on every Write/Edit/NotebookEdit/Bash call in a
// Spor-enabled repo, so both queries ride ONE `git rev-parse` spawn (it
// prints one line per query flag, in argument order) rather than this call
// plus a second, identical --show-toplevel spawn inside inferenceRoot().
// Returns null for a plain repo or non-repo cwd.
function detectWorktreeSession(cwd) {
  if (!cwd) return null;
  const raw = u.git(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]);
  if (!raw) return null;
  const [worktreeTop, commonDir] = raw.trim().split("\n").map((l) => l.trim());
  if (!worktreeTop || !commonDir) return null;
  const mainTop = path.dirname(commonDir); // main worktree's dir sits one level above --git-common-dir
  if (!mainTop || mainTop === worktreeTop) return null;
  let worktreeReal;
  let mainReal;
  try {
    worktreeReal = u.canonPath(worktreeTop);
    mainReal = u.canonPath(mainTop);
  } catch {
    return null;
  }
  if (worktreeReal === mainReal) return null;
  return { worktreeTop: worktreeReal, mainTop: mainReal };
}

function isInside(resolved, root) {
  return resolved === root || resolved.startsWith(root + path.sep);
}

// The dispatch worktree lives INSIDE the main checkout's directory tree
// (`.claude/worktrees/<name>`), so a plain "is this under the main
// checkout" prefix test would also reject legitimate in-worktree writes —
// excluding the worktree's own subtree is what makes this precise.
function violatesIsolation(resolved, session) {
  return isInside(resolved, session.mainTop) && !isInside(resolved, session.worktreeTop);
}

function deny(detail, session) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `[spor worktree guard] Blocked: this session is isolated to ${session.worktreeTop}, but ${detail}. (issue-spor-dispatch-worktree-absolute-path-bypass)`,
    },
  };
}

// Resolve a Write/Edit/NotebookEdit target to its canonical absolute path.
// A relative file_path is relative to the tool call's own cwd, same as a
// shell would resolve it. canonPath normalizes symlinks and `..` even for a
// not-yet-created Write destination (it walks up to the nearest existing
// ancestor).
function resolveTarget(file, cwd) {
  if (!file) return null;
  const abs = path.isAbsolute(file) ? file : path.join(cwd || "", file);
  try {
    return u.canonPath(abs);
  } catch {
    return null;
  }
}

const FILE_TOOL_FIELDS = { Write: "file_path", Edit: "file_path", NotebookEdit: "notebook_path" };

function checkFileTool(input, session) {
  const field = FILE_TOOL_FIELDS[input.tool_name];
  if (!field) return null;
  const target = resolveTarget(input.tool_input?.[field], input.cwd);
  if (!target || !violatesIsolation(target, session)) return null;
  return deny(
    `the target path resolves into the shared checkout ${session.mainTop} (${target}). Edit the corresponding path under your worktree instead`,
    session
  );
}

// A minimal shell lexer, good enough to recover `cd`/`git` arguments from
// agent-generated command strings — not a full shell parser. Walks the WHOLE
// command in one quote-aware pass so a quoted span (single or double) is
// always ONE token regardless of what it contains — critical for `sh -c
// "cd <main> && git commit ..."`, whose payload must survive intact instead
// of being shattered on its own internal `&&` by a naive raw-string split
// before anyone notices it was quoted. `&&`/`||`/`;`/`&`/`|`/`(`/`)`/`{`/`}`/
// newline are all emitted as distinct operator tokens: word characters
// explicitly exclude `&`/`|` too (not just their doubled forms), so both
// `foo&&bar` (no surrounding whitespace) and `cd <dir> & git commit ...`
// (background-job separator) / `... | git commit ...` (pipe) still split
// into separate segments instead of one lone `&`/`|` being silently dropped
// by the regex and gluing two unrelated commands into one token array.
const OPERATOR_RE = /"([^"]*)"|'([^']*)'|&&|\|\||;|&|\||[(){}]|\n|([^\s&|;(){}]+)/g;
function lex(command) {
  const tokens = [];
  let m;
  OPERATOR_RE.lastIndex = 0;
  while ((m = OPERATOR_RE.exec(command))) {
    if (m[1] !== undefined) tokens.push({ op: false, text: m[1] });
    else if (m[2] !== undefined) tokens.push({ op: false, text: m[2] });
    else if (m[3] !== undefined) tokens.push({ op: false, text: m[3] });
    else tokens.push({ op: true, text: m[0] });
  }
  return tokens;
}

// Group a lexed token stream into logical commands, split at each operator
// token (an empty command between two operators, e.g. `a && && b`, yields no
// segment — nothing to check).
function segmentsOf(command) {
  const segments = [];
  let cur = [];
  for (const t of lex(command)) {
    if (t.op) {
      if (cur.length) segments.push(cur);
      cur = [];
    } else {
      cur.push(t.text);
    }
  }
  if (cur.length) segments.push(cur);
  return segments;
}

// Walk a `git` invocation's tokens (tokens[0] === "git"), skipping global
// flags, to recover the subcommand plus any -C/--work-tree override. Best
// effort: unrecognized flags are skipped one token at a time, which is safe
// for a scan (a misparsed subcommand just falls through to "not
// commit/add/apply", never the reverse).
function parseGitInvocation(tokens) {
  let cDir = null;
  let workTree = null;
  let i = 1;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "-C") {
      cDir = tokens[i + 1];
      i++;
      continue;
    }
    if (t === "-c") {
      i++; // skip the key=value argument
      continue;
    }
    if (t === "--work-tree") {
      workTree = tokens[i + 1];
      i++;
      continue;
    }
    if (t.startsWith("--work-tree=")) {
      workTree = t.slice("--work-tree=".length);
      continue;
    }
    if (t === "--git-dir") {
      i++; // value unused: --git-dir alone doesn't relocate the work tree
      continue;
    }
    if (t.startsWith("-")) continue; // any other flag: best-effort skip
    return { subcommand: t, cDir, workTree };
  }
  return { subcommand: null, cDir, workTree };
}

const GIT_WRITE_SUBCOMMANDS = new Set(["commit", "add", "apply"]);
// Wrappers whose quoted/joined argument is itself a command string worth
// scanning — `sh -c "cd <main> && git commit ..."` and `eval "..."` are
// idiomatic (not adversarial) ways to run a compound command without
// changing the caller's own directory, and would otherwise hide a `cd`/`git`
// pair from the top-level segment scan entirely.
const SHELL_DASH_C = new Set(["sh", "bash", "zsh", "dash", "ash"]);

// Locate a `-c`/clustered-short-flag (`-lc`, `-xc`, ...) token in a
// `bash|zsh|...` invocation's argument list, returning its index or -1.
// `bash -lc "cmd"` (login shell + inline command) is a common, non-
// adversarial idiom — a naive `tokens[1] === "-c"` check misses it because
// the `-c` is clustered with other single-char flags. Per bash's own option
// parsing, `c` must be the LAST character of a cluster to mean "take the
// next argv element as the command string" (anything after `c` inside the
// same token is itself consumed as the command, not a further flag), so the
// scan stops at the first cluster ending in `c`; a plain positional argument
// (not starting with `-`) before that means this isn't an inline `-c` call
// at all, and the scan gives up rather than guessing.
function findDashC(tokens) {
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--") break;
    if (t === "-c" || /^-[A-Za-z]*c$/.test(t)) return i;
    if (!t.startsWith("-")) break;
  }
  return -1;
}

// The inline command string of a `sh -c` call, given findDashC's index: the
// next argument, skipping a `--` end-of-options marker (`bash -c -- 'cmd'`).
function dashCBody(tokens, i) {
  return tokens[i + 1] === "--" ? tokens[i + 2] : tokens[i + 1];
}

// A leading run of `NAME=value` tokens in a segment is a POSIX temporary
// environment assignment, scoped to the single command that follows (`FOO=1
// BAR=2 cmd args`) — most relevantly `GIT_WORK_TREE=<dir> git commit ...`,
// which relocates git's effective working tree exactly like `--work-tree`
// but without a recognizable `git` flag to catch. Only LEADING tokens count
// (an assignment-shaped token elsewhere, e.g. inside a quoted commit
// message, is never touched — the scan stops at the first token that isn't
// itself an assignment).
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
function stripEnvAssignments(tokens) {
  const env = {};
  let i = 0;
  for (; i < tokens.length && ENV_ASSIGN_RE.test(tokens[i]); i++) {
    const eq = tokens[i].indexOf("=");
    env[tokens[i].slice(0, eq)] = tokens[i].slice(eq + 1);
  }
  return { env, rest: tokens.slice(i) };
}

// Scan a Bash command for a `git commit`/`add`/`apply` whose EFFECTIVE
// working tree resolves into the shared checkout — tracking `cd` across
// `&&`/`;`/`||`/newline/grouping-separated segments (the actual bypass: `cd
// <main-checkout> && git add -A && git commit ...`, or the equally idiomatic
// `(cd <main> && git commit ...)` subshell form), plus `-C`/`--work-tree`
// overrides on the git invocation itself, and `sh -c "..."`/`eval "..."`
// wrappers (unwrapped recursively). `depth` bounds that recursion (a finite
// command string terminates naturally; this is a backstop against
// pathological input, not an expected path).
//
// Known best-effort gaps, deliberately not chased further (this is a
// regex-based scanner covering the idioms an honestly-wandering agent would
// actually type, not a hardened shell interpreter — see the module doc
// comment): a relative `--work-tree`/`GIT_WORK_TREE` is resolved against the
// tracked `cd` dir rather than the exact `-C`-adjusted cwd git itself would
// use; repeated relative `-C` flags on one invocation aren't chain-resolved;
// and `dir` persists across `||`/`|`/`&`/subshell boundaries the same as
// `&&`/`;` (a rare false-POSITIVE risk — an unrelated command after a failed
// `cd` can read as still "inside" the shared checkout — never a false
// negative). None of these come up in the `cd .. && git ...` /
// `git -C/--work-tree <path> ...` / `sh -c "..."` forms this guard exists to
// catch.
function scanBashForViolation(command, cwd, session, depth = 0) {
  if (!command || depth > 4) return null;
  const segments = segmentsOf(command);
  let dir = cwd || "";
  const topCache = new Map(); // one rev-parse spawn per distinct effective dir per scan
  const resolveTop = (effectiveDir) => {
    if (topCache.has(effectiveDir)) return topCache.get(effectiveDir);
    const rawTop = (u.git(effectiveDir, ["rev-parse", "--show-toplevel"]) || "").trim();
    let top = null;
    if (rawTop) {
      try {
        top = u.canonPath(rawTop);
      } catch {
        top = null;
      }
    }
    topCache.set(effectiveDir, top);
    return top;
  };
  for (const rawTokens of segments) {
    // `env FOO=bar git ...` is the explicit-command spelling of the same
    // temp-env idiom `FOO=bar git ...` covers implicitly — peel the leading
    // `env` token off first so the `NAME=value` run right behind it is
    // recognized the same way (best-effort: env's OWN flags like `env -i`
    // aren't parsed, same as any other unrecognized flag elsewhere here).
    const afterEnvCmd = rawTokens[0] === "env" ? rawTokens.slice(1) : rawTokens;
    // Strip a leading `NAME=value` run first — it never changes which
    // command this segment invokes, only (for `git`) where its effective
    // work tree resolves; every branch below keys off the same `tokens`.
    const { env: segEnv, rest: tokens } = stripEnvAssignments(afterEnvCmd);
    if (!tokens.length) continue; // a bare `FOO=bar` assignment: nothing to check
    if (tokens[0] === "cd") {
      let target = tokens[1];
      if (target === "--") target = tokens[2]; // `cd -- /path`: skip the end-of-options marker
      if (target) dir = path.isAbsolute(target) ? target : path.join(dir, target);
      continue;
    }
    if (SHELL_DASH_C.has(tokens[0])) {
      const dashCIdx = findDashC(tokens);
      if (dashCIdx !== -1 && dashCBody(tokens, dashCIdx)) {
        const nested = scanBashForViolation(dashCBody(tokens, dashCIdx), dir, session, depth + 1);
        if (nested) return nested;
        continue;
      }
    }
    if (tokens[0] === "eval" && tokens[1]) {
      const nested = scanBashForViolation(tokens.slice(1).join(" "), dir, session, depth + 1);
      if (nested) return nested;
      continue;
    }
    if (tokens[0] !== "git") continue;
    const { subcommand, cDir, workTree } = parseGitInvocation(tokens);
    if (!subcommand || !GIT_WRITE_SUBCOMMANDS.has(subcommand)) continue;
    // Precedence matches real git: an explicit --work-tree FLAG beats the
    // GIT_WORK_TREE env var, which in turn beats a bare -C/-C-derived
    // toplevel (verified empirically: `GIT_WORK_TREE=<a> git -C <b>
    // rev-parse --show-toplevel` prints <a>, not <b> — env overrides -C).
    let effectiveDir = dir;
    if (workTree) effectiveDir = path.isAbsolute(workTree) ? workTree : path.join(dir, workTree);
    else if (segEnv.GIT_WORK_TREE)
      effectiveDir = path.isAbsolute(segEnv.GIT_WORK_TREE) ? segEnv.GIT_WORK_TREE : path.join(dir, segEnv.GIT_WORK_TREE);
    else if (cDir) effectiveDir = path.isAbsolute(cDir) ? cDir : path.join(dir, cDir);
    const top = resolveTop(effectiveDir);
    if (top && violatesIsolation(top, session))
      return deny(
        `'git ${subcommand}' resolves its working tree to the shared checkout ${session.mainTop}. Run git commands from your worktree instead`,
        session
      );
  }
  return null;
}

// Pattern-based process termination (issue-spor-orchestrator-agent-global-
// pkill-kills-other-agents): a box runs many agents' suites concurrently, so
// `pkill -f "node --test"` kills the siblings' runs too. The prompts forbid it;
// this denies it mechanically, STRUCTURALLY
// (issue-spor-kill-guard-structural-selector-to-kill-flow): the command is
// parsed (shell-ast.js) into the units the shell would execute — through
// wrappers (sudo/env/timeout/nice/nohup/watch/flock/su/runuser/xargs/find
// -exec/…), `sh -c`/`eval` bodies, command and process substitutions — and it
// is denied when
//   - any executed unit is pkill/killall, or
//   - a process SELECTOR (pgrep, pidof, ps — not `ps -p <pid>`) feeds a unit
//     that runs `kill`: through its stdin (a pipe, `< <(…)`, a here-string or
//     heredoc), its arguments (`kill $(pgrep …)`, `xargs -a <(pgrep …) kill`),
//     an output process substitution (`pgrep … > >(xargs kill)`), or a
//     variable the selector's output was assigned to (`p=$(pgrep …); kill $p`,
//     `for p in $(pgrep …)`, `read p < <(pgrep …)`).
// Quoted text that is never executed (echo/git -m/--grep arguments) is data,
// never matched. Killing by recorded PID or process group (`kill -- -<pgid>`)
// passes.
const PATTERN_KILLERS = new Set(["pkill", "killall", "killall5"]);
const SELECTORS = new Set(["pgrep", "pidof", "ps"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh", "mksh"]);
// Commands that run another command. `args`: options taking a value;
// `pos`: positional words between the options and the command (timeout's
// duration, flock's lock file, chrt's priority, taskset's mask); `script`:
// options whose value is a shell command string.
const WRAPPERS = {
  sudo: { args: ["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T", "--user", "--group", "--chdir", "--host", "--prompt"] },
  doas: { args: ["-u", "-C"] },
  nohup: {},
  setsid: {},
  builtin: {},
  nocorrect: {},
  unbuffer: {},
  busybox: {},
  exec: { args: ["-a"] },
  time: { args: ["-f", "-o", "--format", "--output"] },
  nice: { args: ["-n", "--adjustment"] },
  ionice: { args: ["-c", "-n", "-p", "-P", "-u", "--class", "--classdata"] },
  stdbuf: { args: ["-i", "-o", "-e"] },
  chrt: { pos: 1 },
  taskset: { pos: 1 },
  timeout: { args: ["-s", "-k", "--signal", "--kill-after"], pos: 1 },
  xargs: { args: ["-I", "-L", "-n", "-P", "-s", "-d", "-E", "-a", "--arg-file", "--delimiter", "--max-args", "--max-procs", "--max-chars", "--replace", "--max-lines", "--eof"] },
  parallel: { args: ["-j", "-N", "-L", "-n", "-a", "--jobs", "--arg-file"], stopAt: ":::" },
  env: { args: ["-u", "-C", "--unset", "--chdir"], script: ["-S", "--split-string"] },
  flock: { args: ["-w", "-E", "--timeout", "--wait", "--conflict-exit-code"], pos: 1, script: ["-c", "--command"] },
  su: { args: ["-s", "-g", "-G", "--shell", "--group", "--supp-group"], script: ["-c", "--command", "--session-command"] },
  runuser: { args: ["-u", "-g", "-G", "-s", "--user", "--group", "--shell"], script: ["-c", "--command", "--session-command"] },
  watch: { args: ["-n", "--interval"] }, // runs its remaining words, joined, through `sh -c`
};
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const DECLARATIONS = new Set(["local", "declare", "typeset", "export", "readonly"]);
const READERS = new Set(["read", "mapfile", "readarray"]);
const INPUT_REDIRS = new Set(["<", "<<", "<<-", "<<<", "<>", "<&"]);
const MAX_SCRIPT_DEPTH = 6;

// What a simple command's words execute: the leaf commands it runs and the
// shell command strings it hands to a shell. `stdinShell` marks a shell that
// reads its script from stdin (`bash`, `sh -s`), so a heredoc fed to it is code.
// A script is `dynamic` when its text is not known before it runs — built from
// an expansion (`bash -c "$cmd"`, `eval "$(…)"`) or filled in per input by
// xargs/parallel — and `out.dynamic` marks a command name that is itself an
// expansion (`$cmd args`) or a `source`/`.` of a file.
function execTargets(words, out = { leaves: [], scripts: [], stdinShell: false, dynamic: false }, fedArgs = false) {
  let a = words;
  while (a.length && ENV_ASSIGN_RE.test(a[0].text)) a = a.slice(1);
  if (!a.length) return out;
  const argv = a.map((w) => w.text);
  const script = (ws) => out.scripts.push({ text: ws.map((w) => w.text).join(" "), dynamic: fedArgs || ws.some((w) => w.expands) });
  if (a[0].expands || /[$`]/.test(argv[0])) out.dynamic = true;
  const name = path.basename(argv[0].replace(/^\\/, ""));
  if (name === "source" || name === ".") out.dynamic = true;
  if (SHELLS.has(name)) {
    const i = findDashC(argv);
    if (i !== -1) {
      const at = argv[i + 1] === "--" ? i + 2 : i + 1;
      if (a[at]) script([a[at]]);
      else out.dynamic ||= fedArgs; // `xargs sh -c`: the body is an input line
    } else if (argv.slice(1).every((t) => t.startsWith("-"))) out.stdinShell = true;
    else out.dynamic ||= fedArgs; // `xargs sh file`: a script file per input
    out.leaves.push({ name, args: argv.slice(1) });
    return out;
  }
  if (name === "eval") {
    script(a.slice(1));
    return out;
  }
  if (name === "command" && /^-[a-zA-Z]*[vV]/.test(argv[1] || "")) return out; // `command -v pkill`: a lookup
  if (name === "find") {
    // Each `-exec <cmd> … ;|+` runs <cmd>, with the found paths as arguments.
    for (let i = 1; i < a.length; i++) {
      if (!FIND_EXEC.has(argv[i])) continue;
      let j = i + 1;
      while (j < a.length && !["+", ";", "\;"].includes(argv[j])) j++;
      execTargets(a.slice(i + 1, j), out, true);
      i = j;
    }
    out.leaves.push({ name, args: argv.slice(1) });
    return out;
  }
  const spec = name === "command" ? {} : WRAPPERS[name];
  if (!spec) {
    out.leaves.push({ name, args: argv.slice(1) });
    return out;
  }
  const scriptAt = spec.script ? argv.findIndex((t, k) => k > 0 && (spec.script.includes(t) || spec.script.some((s) => s.startsWith("--") && t.startsWith(s + "=")))) : -1;
  if (scriptAt !== -1) {
    const t = argv[scriptAt];
    if (t.includes("=") && t.startsWith("--")) {
      const w = a[scriptAt];
      out.scripts.push({ text: t.slice(t.indexOf("=") + 1), dynamic: fedArgs || w.expands });
    } else if (a[scriptAt + 1]) script([a[scriptAt + 1]]);
    return out;
  }
  let i = 1;
  const seen = new Set();
  while (i < a.length) {
    const t = argv[i];
    if (t === "--") {
      i++;
      break;
    }
    if (name === "env" && ENV_ASSIGN_RE.test(t)) i++;
    else if (t.startsWith("-") && t.length > 1) {
      seen.add(t);
      i += spec.args?.includes(t) ? 2 : 1;
    } else break;
  }
  if (name === "su") return out; // `su <user>` without -c: an interactive shell
  if (name === "runuser" && !seen.has("-u") && !seen.has("--user")) return out;
  let rest = a.slice(i + (spec.pos || 0));
  const restText = rest.map((w) => w.text);
  if (spec.stopAt && restText.includes(spec.stopAt)) rest = rest.slice(0, restText.indexOf(spec.stopAt));
  if (name === "watch") {
    if (rest.length) script(rest);
    return out;
  }
  return execTargets(rest, out, fedArgs || name === "xargs" || name === "parallel");
}

// `ps -p <pid>` / `ps -q <pid>` reads a KNOWN process (e.g. a recorded pid's
// process group), so it is not a pattern selector. Only the option itself
// counts — never a `p` inside another option's value (`-opid`, `--sort -pcpu`).
function isSelector(leaf) {
  if (!SELECTORS.has(leaf.name)) return false;
  if (leaf.name !== "ps") return true;
  return !leaf.args.some((t) => /^-[pq](\d[\d,]*)?$/.test(t) || /^--(pid|quick-pid)(=|$)/.test(t));
}

// The per-scan analysis over one parsed command. Facts are memoized per node.
class KillFlow {
  constructor() {
    this.execMemo = new WeakMap();
    this.infoMemo = new WeakMap();
    this.tainted = new Set();
    this.errors = [];
  }

  parseScript(text, depth) {
    if (depth >= MAX_SCRIPT_DEPTH) {
      this.errors.push({ msg: "shell body nesting too deep" });
      return { type: "list", items: [] };
    }
    const ast = shellAst.parse(text);
    this.errors.push(...ast.errors);
    return ast;
  }

  // A simple command's own execution: its leaves and parsed shell bodies.
  exec(node, depth) {
    let ex = this.execMemo.get(node);
    if (ex) return ex;
    const t = execTargets(node.words);
    const asts = t.scripts.map((s) => this.parseScript(s.text, depth));
    let dynamic = t.dynamic || t.scripts.some((s) => s.dynamic);
    if (t.stdinShell) {
      // A shell reading its script from stdin: a heredoc/here-string body is
      // parsed; anything else (a pipe, a file) is code we cannot see.
      let seen = false;
      for (const r of node.redirs) {
        if (r.heredoc) {
          seen = true;
          dynamic ||= !r.heredoc.quoted && r.heredoc.subs.length > 0;
          asts.push(this.parseScript(r.heredoc.body, depth));
        } else if (r.op === "<<<" && r.target) {
          seen = true;
          dynamic ||= !!r.target.expands;
          asts.push(this.parseScript(r.target.text, depth));
        }
      }
      if (!seen) dynamic = true;
    }
    ex = { leaves: t.leaves, asts, depth: depth + 1, dynamic };
    this.execMemo.set(node, ex);
    return ex;
  }

  // Does executing `node` (anything it runs, substitutions included) run a
  // selector / a kill, and which pattern killer, if any?
  info(node, depth = 0) {
    let inf = this.infoMemo.get(node);
    if (inf) return inf;
    inf = { selects: false, kills: false, killer: null };
    this.infoMemo.set(node, inf); // cycle-safe placeholder
    const add = (o) => {
      inf.selects ||= o.selects;
      inf.kills ||= o.kills;
      inf.killer ||= o.killer;
    };
    for (const child of this.children(node, depth)) add(this.info(child.ast, child.depth));
    if (node.type === "simple") add(this.execInfo(node, depth));
    return inf;
  }

  // The facts of a simple command's own execution, substitutions excluded.
  execInfo(node, depth) {
    const ex = this.exec(node, depth);
    const inf = { selects: false, kills: false, killer: null };
    for (const leaf of ex.leaves) {
      if (PATTERN_KILLERS.has(leaf.name)) inf.killer ||= leaf.name;
      if (leaf.name === "kill") inf.kills = true;
      if (isSelector(leaf)) inf.selects = true;
    }
    for (const ast of ex.asts) {
      const o = this.info(ast, ex.depth);
      inf.selects ||= o.selects;
      inf.kills ||= o.kills;
      inf.killer ||= o.killer;
    }
    return inf;
  }

  // Every nested node `node` executes, tagged with the substitution kind.
  *children(node, depth) {
    const words = (ws) => ws.flatMap((w) => (w ? w.subs.map((s) => ({ ast: s.ast, kind: s.kind, depth })) : []));
    const redirs = (rs) =>
      rs.flatMap((r) => [...words([r.target]), ...(r.heredoc ? r.heredoc.subs.map((s) => ({ ast: s.ast, kind: s.kind, depth })) : [])]);
    switch (node.type) {
      case "list":
        for (const p of node.items) yield { ast: p, depth };
        break;
      case "pipeline":
        for (const s of node.stages) yield { ast: s, depth };
        break;
      case "simple":
        yield* words(node.assigns);
        yield* words(node.words);
        yield* redirs(node.redirs);
        yield* this.exec(node, depth).asts.map((ast) => ({ ast, kind: "script", depth: depth + 1 }));
        break;
      case "group":
      case "subshell":
        yield { ast: node.body, depth };
        yield* redirs(node.redirs);
        break;
      case "if":
        for (const l of node.lists) yield { ast: l, depth };
        yield* redirs(node.redirs);
        break;
      case "loop":
        yield { ast: node.cond, depth };
        yield { ast: node.body, depth };
        yield* redirs(node.redirs);
        break;
      case "for":
        yield* words(node.words);
        yield { ast: node.body, depth };
        yield* redirs(node.redirs);
        break;
      case "case":
        yield* words([node.word]);
        for (const b of node.bodies) yield { ast: b, depth };
        yield* redirs(node.redirs);
        break;
      case "func":
        yield { ast: node.body, depth };
        break;
    }
  }

  refsTainted(text) {
    for (const v of this.tainted) if (new RegExp(`\\$\\{?[#!]?${v}\\b`).test(text)) return true;
    return false;
  }

  wordTainted(word, depth) {
    if (!word) return false;
    return word.subs.some((s) => this.info(s.ast, depth).selects) || this.refsTainted(word.raw);
  }

  stdinTainted(node, inherited, depth) {
    if (inherited) return true;
    return (node.redirs || []).some(
      (r) =>
        INPUT_REDIRS.has(r.op) &&
        (this.wordTainted(r.target, depth) ||
          (r.heredoc && !r.heredoc.quoted && (r.heredoc.subs.some((s) => this.info(s.ast, depth).selects) || this.refsTainted(r.heredoc.body))))
    );
  }

  // Walk `node` with what its stdin carries, calling `fn(node, stdinSel,
  // depth)` on every command, pipeline stage and nested script; the first
  // truthy return stops the walk.
  walk(node, stdinSel, depth, fn) {
    switch (node.type) {
      case "list":
        for (const p of node.items) {
          const r = this.walk(p, stdinSel, depth, fn);
          if (r) return r;
        }
        return null;
      case "pipeline": {
        let fed = stdinSel;
        for (const s of node.stages) {
          const r = this.walk(s, fed, depth, fn);
          if (r) return r;
          fed = fed || this.info(s, depth).selects; // a selector upstream taints every later stage
        }
        return null;
      }
      default: {
        const st = this.stdinTainted(node, stdinSel, depth);
        const r = fn(node, st, depth);
        if (r) return r;
        const outFed = node.type === "simple" ? this.execInfo(node, depth).selects : this.info(node, depth).selects;
        for (const c of this.children(node, depth)) {
          // `>(…)` reads the command's stdout; everything else inherits its stdin.
          const r2 = this.walk(c.ast, c.kind === "out" ? outFed : st, c.depth, fn);
          if (r2) return r2;
        }
        return null;
      }
    }
  }

  // Variables a selector's output reaches, to a fixed point.
  collectTaint(ast) {
    for (let pass = 0; pass < 8; pass++) {
      const before = this.tainted.size;
      this.walk(ast, false, 0, (node, st, depth) => {
        const taint = (raw) => this.tainted.add(raw.match(/^[A-Za-z_][A-Za-z0-9_]*/)[0]);
        if (node.type === "for" && node.name && node.words.some((w) => this.wordTainted(w, depth))) this.tainted.add(node.name);
        if (node.type !== "simple") return null;
        for (const w of node.assigns) if (this.wordTainted(w, depth)) taint(w.raw);
        const argv = node.words.map((w) => w.text);
        const leaf = this.exec(node, depth).leaves[0];
        if (leaf && DECLARATIONS.has(leaf.name)) {
          for (const w of node.words.slice(1)) if (ENV_ASSIGN_RE.test(w.raw) && this.wordTainted(w, depth)) taint(w.raw);
        }
        if (leaf && READERS.has(leaf.name) && st) {
          this.tainted.add(leaf.name === "read" ? "REPLY" : "MAPFILE");
          for (const t of argv.slice(1)) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) this.tainted.add(t);
        }
        return null;
      });
      if (this.tainted.size === before) break;
    }
  }

  // The deny detail for the first pattern kill in `ast`, or null.
  check(ast) {
    this.collectTaint(ast);
    return this.walk(ast, false, 0, (node, st, depth) => {
      if (node.type === "simple") {
        const ex = this.execInfo(node, depth);
        const killer = this.exec(node, depth).leaves.find((l) => PATTERN_KILLERS.has(l.name));
        if (killer) return `'${killer.name}' terminates processes by pattern`;
        if (ex.kills && [...node.assigns, ...node.words].some((w) => this.wordTainted(w, depth)))
          return "'kill' is handed a pgrep/pidof/ps-selected process set";
      }
      if (st && this.info(node, depth).kills) return "'kill' reads a pgrep/pidof/ps-selected process set";
      return null;
    });
  }
}

// The raw-text backstop (operator decision on issue-spor-kill-guard-
// structural-selector-to-kill-flow, 2026-10-06): the guard stops ACCIDENTAL
// pattern kills, and the parser above must never let through what the old
// raw-text check denied. So, whatever the parser concluded, a command that
// mentions pkill/killall ANYWHERE, or `kill` together with a selector
// (pgrep/pidof, or an executed pattern `ps`), is denied — unless every one of
// those mentions sits inside the literally-quoted argument of a known DATA
// command: echo/printf arguments, `git commit -m/--message`, `git log
// --grep/-S/-G`, a grep pattern, or a quoted-delimiter heredoc fed to `cat`
// (the `git commit -m "$(cat <<'EOF' … EOF)"` idiom). That exception is void
// when the command runs anything whose text is not known before it runs (a
// dynamic `bash -c "$cmd"`/`eval "$(…)"` body, an expanded command name, a
// shell fed from a pipe, a `source`), since data can become code there. And
// it fails CLOSED: a kill-mentioning command the parser could not read cleanly
// (an unterminated quote or substitution, a missing `done`, …) is denied.
const KILLER_WORD_RE = /(?<![\w-])(?:pkill|killall5?)(?![\w-])/g;
const KILL_WORD_RE = /(?<![\w-])kill(?![\w-])/g;
const SELECTOR_WORD_RE = /(?<![\w-])(?:pgrep|pidof)(?![\w-])/g;
const PS_WORD_RE = /(?<![\w-])ps(?![\w-])/g;
const ANY_KILL_RE = /(?<![\w-])(?:kill|pkill|killall5?)(?![\w-])/;
const GREP_VALUE_OPTS = new Set(["-A", "-B", "-C", "-m", "-f", "-d", "-D", "--file", "--max-count", "--context", "--after-context", "--before-context"]);
const GIT_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

// The words of a simple command that a known data command only prints,
// writes or matches against — never executes.
function dataArgs(words) {
  if (!words.length || words[0].expands || words[0].quoted) return [];
  const argv = words.map((w) => w.text);
  const name = path.basename(argv[0]);
  if (name === "echo" || name === "printf") return words.slice(1);
  if (name === "grep" || name === "egrep" || name === "fgrep") {
    const out = [];
    let explicit = false;
    for (let i = 1; i < words.length; i++) {
      const t = argv[i];
      if (t === "-e" || t === "--regexp") {
        if (words[i + 1]) out.push(words[++i]);
        explicit = true;
      } else if (t.startsWith("--regexp=") || /^-e./.test(t)) {
        out.push(words[i]);
        explicit = true;
      } else if (t === "--") {
        if (!explicit && words[i + 1]) out.push(words[i + 1]);
        break;
      } else if (GREP_VALUE_OPTS.has(t)) i++;
      else if (!(t.startsWith("-") && t.length > 1)) {
        if (!explicit) out.push(words[i]); // the first operand is the pattern
        break;
      }
    }
    return out;
  }
  if (name === "git") {
    let i = 1;
    while (i < words.length && argv[i].startsWith("-")) i += GIT_VALUE_OPTS.has(argv[i]) ? 2 : 1;
    const sub = argv[i];
    const out = [];
    for (let j = i + 1; j < words.length; j++) {
      const t = argv[j];
      const takesNext = sub === "commit" ? t === "--message" || /^-[a-zA-Z]*m$/.test(t) : sub === "log" ? ["--grep", "-S", "-G"].includes(t) : false;
      const attached =
        sub === "commit" ? t.startsWith("--message=") || /^-m./.test(t) : sub === "log" ? t.startsWith("--grep=") || /^-[SG]./.test(t) : false;
      if (takesNext) {
        if (words[j + 1]) out.push(words[++j]);
      } else if (attached) out.push(words[j]);
    }
    return out;
  }
  return [];
}

// Every simple command in `node`, substitutions included (same source text).
function forEachSimple(node, fn) {
  if (!node) return;
  const words = (ws) => {
    for (const w of ws) if (w) for (const sub of w.subs) forEachSimple(sub.ast, fn);
  };
  const redirs = (rs) => {
    for (const r of rs || []) {
      words([r.target]);
      if (r.heredoc) for (const sub of r.heredoc.subs) forEachSimple(sub.ast, fn);
    }
  };
  switch (node.type) {
    case "list":
      node.items.forEach((n) => forEachSimple(n, fn));
      break;
    case "pipeline":
      node.stages.forEach((n) => forEachSimple(n, fn));
      break;
    case "simple":
      fn(node);
      words(node.assigns);
      words(node.words);
      redirs(node.redirs);
      break;
    case "group":
    case "subshell":
      forEachSimple(node.body, fn);
      redirs(node.redirs);
      break;
    case "if":
      node.lists.forEach((n) => forEachSimple(n, fn));
      redirs(node.redirs);
      break;
    case "loop":
      forEachSimple(node.cond, fn);
      forEachSimple(node.body, fn);
      redirs(node.redirs);
      break;
    case "for":
      words(node.words);
      forEachSimple(node.body, fn);
      redirs(node.redirs);
      break;
    case "case":
      words([node.word]);
      node.bodies.forEach((n) => forEachSimple(n, fn));
      redirs(node.redirs);
      break;
    case "func":
      forEachSimple(node.body, fn);
      break;
  }
}

// [from, to) ranges of the top-level command text that are quoted data.
function dataRanges(ast) {
  const ranges = [];
  forEachSimple(ast, (node) => {
    for (const w of dataArgs(node.words)) ranges.push(...w.qspans);
    if (node.words.length && !node.words[0].expands && node.words[0].text === "cat") {
      for (const r of node.redirs) if (r.heredoc?.quoted && r.heredoc.start >= 0) ranges.push([r.heredoc.start, r.heredoc.end]);
    }
  });
  return ranges;
}

function matchesOf(re, text) {
  return [...text.matchAll(re)].map((m) => [m.index, m.index + m[0].length]);
}

function backstop(command, ast, flow) {
  const errors = [...(ast.errors || []), ...flow.errors];
  if (errors.length && ANY_KILL_RE.test(command))
    return `a command mentioning kill could not be parsed cleanly (${errors[0].msg}), so it cannot be shown safe`;
  let dynamic = false;
  let psSelects = false;
  flow.walk(ast, false, 0, (node, st, depth) => {
    if (node.type !== "simple") return null;
    const ex = flow.exec(node, depth);
    dynamic ||= ex.dynamic;
    psSelects ||= ex.leaves.some((l) => l.name === "ps" && isSelector(l));
    return null;
  });
  const killers = matchesOf(KILLER_WORD_RE, command);
  const kills = matchesOf(KILL_WORD_RE, command);
  const selectors = matchesOf(SELECTOR_WORD_RE, command);
  if (psSelects || dynamic) selectors.push(...matchesOf(PS_WORD_RE, command));
  if (!killers.length && !(kills.length && (selectors.length || psSelects))) return null;
  const ranges = dynamic ? [] : dataRanges(ast);
  const isData = ([a, b]) => ranges.some(([x, y]) => x <= a && b <= y);
  if (!psSelects && [...killers, ...kills, ...selectors].every(isData)) return null;
  if (dynamic) return "a command that builds code at run time (a dynamic `sh -c`/`eval` body, an expanded command name, a piped or sourced script) mentions a pattern kill";
  const what = killers.length && !killers.every(isData) ? `'${command.slice(...killers.find((m) => !isData(m)))}'` : "'kill' with a pgrep/pidof/ps selector";
  return `${what} appears outside quoted data (only a quoted echo/printf argument, git commit -m, git log --grep/-S/-G or grep pattern is treated as text)`;
}

function denyKill(detail) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `[spor process guard] Blocked: ${detail}. Kill only processes you started, by recorded PID or process group (\`kill -- -<pgid>\`) — never by pattern, since other agents' processes share this box. (issue-spor-orchestrator-agent-global-pkill-kills-other-agents)`,
    },
  };
}

function scanBashForPatternKill(command) {
  if (!command || typeof command !== "string") return null;
  const ast = shellAst.parse(command);
  const flow = new KillFlow();
  const detail = flow.check(ast) ?? backstop(command, ast, flow);
  return detail ? denyKill(detail) : null;
}

function checkBashTool(input, session) {
  if (input.tool_name !== "Bash") return null;
  return (
    scanBashForViolation(input.tool_input?.command, input.cwd, session) ??
    scanBashForPatternKill(input.tool_input?.command)
  );
}

async function preTool(input) {
  const session = detectWorktreeSession(input.cwd);
  if (!session) return null; // not a dispatch/delegation worktree session: byte-identical no-op
  return checkFileTool(input, session) ?? checkBashTool(input, session);
}

module.exports = {
  preTool,
  detectWorktreeSession,
  violatesIsolation,
  resolveTarget,
  scanBashForViolation,
  scanBashForPatternKill,
};

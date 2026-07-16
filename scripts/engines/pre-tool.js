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
// Active ONLY inside a dispatch worktree session (a linked git worktree
// whose main checkout sits elsewhere) — a plain repo or non-repo cwd is a
// pure no-op, so ordinary sessions see byte-identical (no-output) behavior.

const path = require("path");
const u = require("./util");

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
      if (dashCIdx !== -1 && tokens[dashCIdx + 1]) {
        const nested = scanBashForViolation(tokens[dashCIdx + 1], dir, session, depth + 1);
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

function checkBashTool(input, session) {
  if (input.tool_name !== "Bash") return null;
  return scanBashForViolation(input.tool_input?.command, input.cwd, session);
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
};

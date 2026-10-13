"use strict";
// The ONE Windows process-tree kill (task-spor-windows-shared-process-tree-
// helper, dec-spor-process-identity-cross-platform-start-time). Windows has no
// process groups, and a process's descendants outlive it there — the dispatch
// harness is commonly an agent grandchild behind a `cmd.exe` shim, a timed-out
// network git leaves Git for Windows' launcher child, sh and an SSH wrapper —
// so "stop this run" means "stop this process and everything it spawned".
//
// Never `taskkill /T`: Windows does not reparent an orphan, so a parent-pid
// link can name a pid's PREVIOUS holder, and taskkill's own walk follows bare
// parent pids — it would take a stranger's whole subtree along with ours. One
// PowerShell pass instead, so the proof and the kill are milliseconds apart
// rather than a PowerShell boot apart:
//
//   1. snapshot the process table (CIM `Win32_Process`, shipped with every
//      supported Windows — wmic is not);
//   2. prove the root — by its recorded start-time token (`ticks`, epoch ms,
//      process-identity.js), by a live handle the caller holds (`trustRoot`),
//      or, for a root already gone, by a creation window its direct children
//      must fall inside (`since`/`until`);
//   3. walk only TRUE descendants: a child must be created no earlier than its
//      parent (a recycled-pid lookalike predates the parent it claims);
//   4. never this script's own ancestry (a hook running inside the tree);
//   5. pin each target by an open handle, keep only those that existed when
//      the snapshot was taken (so a pid reused since is skipped), then
//      force-stop each through its handle (`Stop-Process -Force`, the same
//      TerminateProcess a Windows "SIGTERM" already is), printing each pid
//      that stopped.
//
// Zero-dep (dec-spor-client-zero-dep-admits-os-binaries): the OS's own
// PowerShell by absolute path, an argv array, no shell. The script uses no
// double quotes, so node's argv quoting cannot mangle it.

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const FILETIME_UNIX_EPOCH = 116444736000000000n; // 100ns ticks, 1601-01-01 -> 1970-01-01
const msToFileTime = (ms) => BigInt(Math.trunc(ms)) * 10000n + FILETIME_UNIX_EPOCH;
// A root token names its creation instant floored to the ms; CIM spells the
// creation time in µs and may round where Get-Process floored, so the proof
// window is [token, token + 1ms + 1µs).
const ROOT_SLACK_FT = 10010n;
// A dead root's children are matched against a window read off this process's
// clock, so it is padded by a second either side.
const WINDOW_SLACK_MS = 1000;
const TIMEOUT_MS = 30000;

// Exit codes the script answers with.
const EXIT_GONE = 3; // the root is not in the snapshot
const EXIT_FOREIGN = 4; // the root's creation time is not the one proven
const EXIT_PROTECTED = 5; // the root is this pass's own ancestry

function systemRoot(env = process.env) {
  return env.SystemRoot || env.SYSTEMROOT || env.windir || "C:\\Windows";
}
function powershellPath(env = process.env) {
  return path.win32.join(systemRoot(env), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

// The script for one tree kill. Exactly one root proof applies: `ticks` (the
// root's recorded token), `trustRoot` (the caller holds a live handle to it, so
// its pid cannot have been reused), or `since`/`until` (the root is gone; its
// children are only accepted inside that creation window). `killRoot: false`
// stops the descendants only.
function treeScript(pid, { ticks = null, trustRoot = false, since = null, until = null, killRoot = true } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) throw new TypeError("treeScript: pid must be a positive integer");
  // Only core types, arrays and hashtables (no New-Object collections, no
  // [Console]), so a Constrained Language Mode host still runs it.
  const lines = [
    // Taken BEFORE the snapshot: anything that starts after it is not a
    // process the snapshot saw, whatever pid it holds (step 5 below).
    "$snapAt = [DateTime]::UtcNow.ToFileTimeUtc()",
    "$all = @(Get-CimInstance Win32_Process -ErrorAction Stop)",
    "$byParent = @{}",
    "$byId = @{}",
    "foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p; if ($p.CreationDate) { $k = [int]$p.ParentProcessId; if (-not $byParent.ContainsKey($k)) { $byParent[$k] = @() }; $byParent[$k] += ,$p } }",
    // Never this script nor anything it runs under: a hook inside a dispatched
    // harness must not end its own ancestry mid-list.
    "$protect = @{}",
    "$up = [int]$PID",
    // A parent is followed only if it predates its child (a dead ancestor's
    // parent pid can name a recycled process).
    "while ($up -gt 0 -and -not $protect.ContainsKey($up)) { $protect[$up] = $true; $me = $byId[$up]; $up = 0; if ($me -and $me.CreationDate) { $pp = [int]$me.ParentProcessId; $par = $byId[$pp]; if ($par -and $par.CreationDate -and $par.CreationDate -le $me.CreationDate) { $up = $pp } } }",
    `$root = $byId[${pid}]`,
  ];
  let childLo = null;
  let childHi = null;
  if (ticks != null) {
    const lo = msToFileTime(ticks);
    // The proof reads the start time the way the token was minted
    // (process-identity.js: Get-Process first, CIM for a process this user
    // cannot open) — CIM spells it as local wall-clock time, which can drift
    // an hour from Get-Process's across a daylight-saving change. The WALK
    // below compares CIM with CIM, one conversion throughout.
    lines.push(
      `if (-not $root -or -not $root.CreationDate) { exit ${EXIT_GONE} }`,
      "$proofFt = $null",
      `try { $proofFt = (Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc() } catch { $proofFt = $root.CreationDate.ToFileTimeUtc() }`,
      `if ($proofFt -lt ${lo} -or $proofFt -ge ${lo + ROOT_SLACK_FT}) { exit ${EXIT_FOREIGN} }`,
      "$rootFt = $root.CreationDate.ToFileTimeUtc()",
    );
  } else if (trustRoot) {
    lines.push(
      `if (-not $root -or -not $root.CreationDate) { exit ${EXIT_GONE} }`,
      "$rootFt = $root.CreationDate.ToFileTimeUtc()",
    );
  } else if (Number.isFinite(since) && Number.isFinite(until)) {
    // No root to prove: its children must have been created while it ran.
    childLo = msToFileTime(since - WINDOW_SLACK_MS);
    childHi = msToFileTime(until + WINDOW_SLACK_MS);
    lines.push("$rootFt = $null");
    killRoot = false; // a root this caller could not prove is never signalled itself
  } else {
    throw new TypeError("treeScript: one of ticks, trustRoot or since/until is required");
  }
  const childOk = childLo == null
    ? "$cft -ge $pft"
    : `(($pft -ne $null -and $cft -ge $pft) -or ($pft -eq $null -and $cft -ge ${childLo} -and $cft -le ${childHi}))`;
  lines.push(
    // Root FIRST: a supervisor root must not watch its children die and close
    // its record as their failure before the stop reaches it.
    `$kill = @(${killRoot ? pid : ""})`,
    "$seen = @{}",
    `$seen[${pid}] = $true`,
    `$queue = @(,@(${pid}, $rootFt))`,
    "$qi = 0",
    "while ($qi -lt $queue.Count) { $cur = $queue[$qi]; $qi++; $pid0 = [int]$cur[0]; $pft = $cur[1]; " +
      "if ($byParent.ContainsKey($pid0)) { foreach ($c in $byParent[$pid0]) { $cid = [int]$c.ProcessId; if ($seen.ContainsKey($cid)) { continue }; " +
      `$cft = $c.CreationDate.ToFileTimeUtc(); if (${childOk}) { $seen[$cid] = $true; $kill += $cid; $queue += ,@($cid, $cft) } } } }`,
    // Pin every target by an open handle BEFORE the first kill, and keep only
    // a process that already existed when the snapshot was taken: a pid freed
    // and reused since (a child that exits once the root goes, say) names a
    // process started after $snapAt, and is skipped. The kill then goes
    // through that held handle, never a fresh open-by-pid.
    // A ROOT that cannot be pinned is answered with why (gone / foreign /
    // protected), after its descendants are stopped: the caller must not
    // fall back to a bare kill of a pid this pass refused.
    "$pins = @()",
    "$rootMiss = 0",
    `foreach ($id in $kill) { $miss = 0; if ($protect.ContainsKey([int]$id)) { $miss = ${EXIT_PROTECTED} } else { try { $gp = Get-Process -Id $id -ErrorAction Stop; $null = $gp.Handle; if ($gp.StartTime.ToFileTimeUtc() -lt $snapAt) { $pins += ,$gp } else { $miss = ${EXIT_FOREIGN} } } catch { $miss = ${EXIT_GONE} } }; if ($miss -and [int]$id -eq ${pid}) { $rootMiss = $miss } }`,
    // Each pid is printed only once its stop succeeded.
    "foreach ($gp in $pins) { try { Stop-Process -InputObject $gp -Force -ErrorAction Stop; Write-Output ([string]$gp.Id) } catch { } }",
    "exit $rootMiss",
  );
  return lines.join("; ");
}

// Kill a tree (see treeScript for the options). Returns `{status, pids}`:
//   - "killed"      the script ran to the end; `pids` are what it stopped
//                   (a process it could not stop — even the root, refused
//                   access — is not listed, and gets no fallback either).
//   - "gone"        the root was not there (exit 3), at the proof or when it
//                   was pinned: the root was not signalled.
//   - "foreign"     the root's start time is not the one proven, or it
//                   started after the snapshot (exit 4): the pid is someone
//                   else's now, and the root was not signalled.
//   - "protected"   the root is this pass's own ancestry (exit 5).
//                   For these three `pids` lists any descendants stopped
//                   (none when the proof itself refused); no caller may fall
//                   back to a bare kill of the root.
//   - "interrupted" the script was timed out or killed mid-run: it may have
//                   stopped the root, whose pid could by now be reused, so no
//                   caller may fall back to a bare-pid kill after it.
//   - "failed"      PowerShell did not get going, or failed before the kill
//                   step: nothing was signalled, and the caller keeps its own
//                   single-pid fallback.
function killWindowsTree(pid, { ticks = null, trustRoot = false, since = null, until = null, killRoot = true, env = process.env, run = spawnSync } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return { status: "failed", pids: [] };
  const t = ticks == null ? null : Number(ticks);
  if (ticks != null && !Number.isFinite(t)) return { status: "failed", pids: [] };
  let script;
  try {
    script = treeScript(pid, { ticks: t, trustRoot, since, until, killRoot });
  } catch {
    return { status: "failed", pids: [] };
  }
  let r;
  try {
    r = run(powershellPath(env), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"], timeout: TIMEOUT_MS,
    });
  } catch {
    return { status: "failed", pids: [] };
  }
  const pids = String((r && r.stdout) || "").split(/\r?\n/).filter((l) => /^\d+$/.test(l.trim())).map((l) => Number(l.trim()));
  // Never "failed" once the kill step ran: a root it refused or could not
  // stop must not be handed to a caller's bare-pid fallback.
  if (r && r.status === 0) return { status: "killed", pids };
  if (r && r.status === EXIT_GONE) return { status: "gone", pids };
  if (r && r.status === EXIT_FOREIGN) return { status: "foreign", pids };
  if (r && r.status === EXIT_PROTECTED) return { status: "protected", pids };
  // A script that RAN and was then timed out or killed may already have
  // stopped the root. One that printed a pid had reached the kill step.
  if (!r || r.signal || (r.error && r.error.code === "ETIMEDOUT") || pids.length) return { status: "interrupted", pids };
  return { status: "failed", pids: [] };
}

module.exports = { killWindowsTree, treeScript, powershellPath, systemRoot, TIMEOUT_MS, EXIT_GONE, EXIT_FOREIGN, EXIT_PROTECTED };

"use strict";
// The `ci` suite mode (dec-spor-command-gate-ci-mode,
// task-spor-command-gate-waits-on-ci-run): a command gate — or the integration
// stage's candidate suite — whose verdict comes from the repo's own CI instead
// of a suite spawned on the worker box. The factory's acceptance suite used to
// run on the same shared box as the implementers it judged, and most of its
// human escalations were that box's load, not the change.
//
// The shape is the local suite handle's (bin/spor.js `openSuite`), so the gate
// runner's rerun loop needs to know nothing about where a suite ran:
//
//   open    push the candidate commit to `spor/candidate/<node>` on the
//           declared remote (the push is what triggers the workflow)
//   run(n)  n = 1: find the declared workflow's run for that exact commit and
//           wait for it; n > 1: `gh run rerun` the same run and wait again —
//           a rerun is the SAME commit judged again, as a local rerun is the
//           same tree
//   close   delete the candidate branch, only if it still names our commit
//
// A run conclusion is read through `gates.ciConclusionVerdict`: success
// passes, failure/timed_out is a verdict on the change, and everything else —
// cancelled, skipped, a run that never appeared, gh/git that could not be
// reached, a wait past the gate's `timeout_ms` — is an OUTAGE, which the
// pipeline's infrastructure retry pool pays for and which otherwise fails
// closed. It is never a pass and never a fix cycle.
//
// Credentials are the box's own: `git push` uses whatever the remote is
// configured with, and `gh` its own login (or GH_TOKEN) — the same two a
// propose-mode factory already needs. The judge's graph and attestation
// secrets are scrubbed from both (gate-runner's `judgeGitEnv`), and git hooks
// are disabled, so the judged repo's own pre-push hook never runs as the judge.
//
// Zero-dep and ASYNC: a wait can last the gate's whole timeout, and the worker
// must keep harvesting runs meanwhile (the reason runGateCommand is async too).

const { spawn } = require("child_process");
const gates = require("../kernel/gates.js");
const gateRunner = require("./gate-runner.js");

const EXEC_TIMEOUT_MS = 60000;
const PUSH_TIMEOUT_MS = 180000;
const LOG_CAP_BYTES = 256 * 1024;

// One child process, bounded, never a shell: every argument here is ours or a
// parsed, validated declaration. {status, stdout, stderr, error}.
function execAsync(cmd, args, { cwd, env, timeoutMs = EXEC_TIMEOUT_MS, capBytes = LOG_CAP_BYTES } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      resolve({ status: null, stdout: "", stderr: "", error: e });
      return;
    }
    const out = [];
    const errOut = [];
    let outSize = 0;
    const take = (buf) => {
      out.push(buf);
      outSize += buf.length;
      // Keep the TAIL: a failed run's log ends where it failed.
      while (outSize > capBytes && out.length > 1) outSize -= out.shift().length;
    };
    child.stdout.on("data", take);
    child.stderr.on("data", (b) => {
      if (errOut.length < 64) errOut.push(b);
    });
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...r, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(errOut).toString("utf8") });
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      done({ status: null, error: new Error(`\`${cmd} ${args[0] || ""}\` did not answer within ${Math.round(timeoutMs / 1000)}s`) });
    }, timeoutMs);
    child.on("error", (e) => done({ status: null, error: e }));
    child.on("close", (code) => done({ status: code, error: null }));
  });
}

const firstLine = (text) => String(text || "").trim().split("\n")[0].slice(0, 300);
const why = (r) => (r.error ? r.error.message : firstLine(r.stderr) || `exit ${r.status}`);
const outage = (reason) => ({ ok: false, code: null, reason, output: "", outage: { outcome: "infrastructure", reason, pool: "retry" } });

// Open a CI suite for `sha`. {ok:true, sha, branch, run, close} | an outage.
async function openCiSuite({ top, sha, branch, ci, timeoutMs, label = "", exec = execAsync, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, log = () => {} }) {
  const env = gateRunner.judgeGitEnv(process.env);
  const what = label || `CI workflow \`${ci.workflow}\``;
  const repoArgs = ci.repo ? ["--repo", ci.repo] : [];
  const gh = (args, opts = {}) => exec("gh", [...args, ...repoArgs], { cwd: top, env, ...opts });
  const listRuns = () => gh(["run", "list", "--workflow", ci.workflow, "--commit", sha, "--limit", "20", "--json", "databaseId,headSha,headBranch,event,status,conclusion,url,attempt"]);
  const parseRuns = (r) => {
    if (r.status !== 0) return null;
    try {
      const runs = JSON.parse(r.stdout || "[]");
      return Array.isArray(runs) ? runs : null;
    } catch {
      return null;
    }
  };
  // The runs that ALREADY exist for this commit, read before the push: the
  // same commit is pushed again by an outage retry, a rescue pass that made no
  // commit, or a re-gate, and a finished run from last time — or a
  // pull_request run over a different tree — must never be read as the
  // verdict on THIS push. A CI we cannot even list is unreachable.
  const before = await listRuns();
  if (before.error && before.error.code === "ENOENT") return outage("the 'gh' CLI is not on PATH, so no CI run can be read");
  const prior = parseRuns(before);
  if (!prior) return outage(`the runs of ${what} could not be listed (${before.status === 0 ? "gh returned an unreadable run list" : why(before)}) — CI could not be reached`);
  const known = new Set(prior.map((x) => x && x.databaseId).filter(Boolean));
  // A candidate branch LEFT at this very commit (a worker killed mid-wait, a
  // delete that failed) would make the push below a no-op, and a no-op push
  // starts no run. Take it down first so the push is a real one.
  const standing = await exec("git", ["ls-remote", ci.remote, `refs/heads/${branch}`], { cwd: top, env, timeoutMs: PUSH_TIMEOUT_MS });
  if (standing.status === 0 && String(standing.stdout || "").split(/\s+/)[0] === sha) {
    const del = await exec("git", ["push", `--force-with-lease=refs/heads/${branch}:${sha}`, ci.remote, `:refs/heads/${branch}`], { cwd: top, env, timeoutMs: PUSH_TIMEOUT_MS });
    if (del.status !== 0) return outage(`a stale ${ci.remote}/${branch} already names ${sha.slice(0, 8)} and could not be deleted (${why(del)}), so a push would start no CI run`);
  }
  const pushed = await exec("git", ["push", "--force", ci.remote, `${sha}:refs/heads/${branch}`], { cwd: top, env, timeoutMs: PUSH_TIMEOUT_MS });
  if (pushed.status !== 0) {
    return outage(`the candidate ${sha.slice(0, 8)} could not be pushed to ${ci.remote}/${branch} (${why(pushed)}), so ${what} never saw it`);
  }
  log(`work: pushed candidate ${sha.slice(0, 8)} to ${ci.remote}/${branch} — waiting on ${what}`);

  let runId = null;
  let runAttempt = 0;

  // The run THIS push started: the declared workflow, this exact commit, a
  // `push` event on the candidate branch, and not one that existed before.
  const discover = async (deadline) => {
    let last = "no run has appeared yet";
    for (;;) {
      const r = await listRuns();
      if (r.error && r.error.code === "ENOENT") return { error: "the 'gh' CLI is not on PATH" };
      const runs = parseRuns(r);
      if (runs) {
        const hit = runs.find(
          (x) =>
            x && x.databaseId && !known.has(x.databaseId) &&
            (!x.headSha || x.headSha === sha) &&
            (!x.event || x.event === "push") &&
            (!x.headBranch || x.headBranch === branch)
        );
        if (hit) return { run: hit };
      } else last = r.status === 0 ? "gh returned an unreadable run list" : why(r);
      if (now() >= deadline) return { error: last };
      await sleep(Math.max(0, Math.min(ci.pollMs, deadline - now())));
    }
  };

  const view = (id) => gh(["run", "view", String(id), "--json", "status,conclusion,url,attempt"]);

  const run = async (attempt = 1) => {
    const start = now();
    const deadline = start + timeoutMs;
    let expect = 1;
    if (runId == null) {
      const found = await discover(Math.min(deadline, start + ci.discoverMs));
      if (!found.run) return outage(`no run of ${what} appeared for ${sha.slice(0, 8)} on ${branch} (${found.error}) — CI could not be reached`);
      runId = found.run.databaseId;
      runAttempt = Number(found.run.attempt) || 1;
      expect = runAttempt;
      log(`work: ${what} run ${found.run.url || runId} is judging ${sha.slice(0, 8)}`);
    } else {
      // A rerun of the SAME run: GitHub keeps the id and bumps its attempt.
      const rr = await gh(["run", "rerun", String(runId)]);
      if (rr.status !== 0) return outage(`${what} run ${runId} could not be re-run (${why(rr)})`);
      expect = runAttempt + 1;
      log(`work: re-running ${what} run ${runId} (attempt ${attempt})`);
    }
    let last = "no answer yet";
    for (;;) {
      const r = await view(runId);
      if (r.error && r.error.code === "ENOENT") return outage("the 'gh' CLI is not on PATH, so the CI run cannot be read");
      if (r.status === 0) {
        let v = null;
        try {
          v = JSON.parse(r.stdout || "{}");
        } catch {
          v = null;
        }
        if (v && typeof v === "object") {
          const at = Number(v.attempt) || 1;
          last = `run ${runId} is ${v.status || "unknown"}`;
          if (v.status === "completed" && at >= expect) {
            runAttempt = at;
            const ciInfo = { workflow: ci.workflow, run_id: runId, attempt: at, url: v.url || null, conclusion: v.conclusion || null, sha, branch };
            const verdict = gates.ciConclusionVerdict(v.conclusion);
            const where = `${what} run ${v.url || runId}${at > 1 ? ` (attempt ${at})` : ""}`;
            if (verdict === "passed") return { ok: true, code: 0, reason: null, output: `${where} concluded success`, ci: ciInfo };
            if (verdict === "outage") {
              return { ...outage(`${where} concluded '${v.conclusion || "nothing"}' — CI did not judge the change`), ci: ciInfo };
            }
            const logs = await gh(["run", "view", String(runId), "--log-failed"], { timeoutMs: EXEC_TIMEOUT_MS });
            return {
              ok: false,
              code: 1,
              reason: `${where} concluded ${v.conclusion}`,
              output: logs.status === 0 ? logs.stdout : `(the failed jobs' log could not be read: ${why(logs)})`,
              ci: ciInfo,
            };
          }
        } else last = "gh returned an unreadable run";
      } else last = why(r);
      if (now() >= deadline) {
        return outage(`${what} run ${runId} did not finish within ${Math.round(timeoutMs / 1000)}s (${last})`);
      }
      await sleep(Math.max(0, Math.min(ci.pollMs, deadline - now())));
    }
  };

  // Best effort, and only while the branch still names OUR commit: a newer
  // push for the same node (a later pipeline) is not ours to delete.
  const close = async () => {
    const del = await exec("git", ["push", `--force-with-lease=refs/heads/${branch}:${sha}`, ci.remote, `:refs/heads/${branch}`], { cwd: top, env, timeoutMs: PUSH_TIMEOUT_MS });
    if (del.status !== 0) log(`work: the candidate branch ${ci.remote}/${branch} could not be deleted (${why(del)}) — it is harmless: the next push replaces it, or deletes it first if it names the same commit`);
  };

  return { ok: true, sha, branch, run, close };
}

module.exports = { openCiSuite, execAsync, CI_BRANCH_PREFIX: gates.CI_BRANCH_PREFIX };

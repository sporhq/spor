#!/usr/bin/env node
'use strict';

// The release CI gate (task-spor-release-gate-refuses-red-main-ci): refuse a
// release unless the `test` workflow's push run on main for the commit being
// released concluded `success` — the WHOLE matrix, Windows shards included.
// Windows shards sat red for 8 days while v0.31.6-v0.31.8 shipped, because the
// publish workflow re-runs `npm test` on ubuntu only and nothing read the
// matrix's verdict.
//
// Two callers: scripts/release.js (local, before it bumps/tags/pushes — main's
// tip must already be green) and .github/workflows/publish.yaml (on the tag,
// `--wait`ing for the run release.js's own push of the release commit started).
// The explicit override is release.js `--allow-red-ci` / the repo variable
// SPOR_RELEASE_ALLOW_RED_CI=true on the publish side; never a silent publish.
//
// Only the `push` run on the release branch counts: a workflow_dispatch or
// pull_request run can share the sha (a branch at main's tip) and be cancelled
// or red for reasons that say nothing about main. A re-run of the push run
// updates that run's own conclusion, so a flake re-run green unblocks it.
//
// Usage:
//   node scripts/release-ci-gate.js --sha <full sha> [--repo owner/name] [--branch main]
//     [--workflow test.yaml] [--wait] [--timeout-min 60] [--interval-sec 30]
//
// Zero-dependency, plain Node + the gh binary.

const { spawnSync } = require('child_process');

const DEFAULTS = {
  workflow: 'test.yaml',
  branch: 'main',
  timeoutMin: 60,
  intervalSec: 30,
};

// Pure verdict over the workflow-runs API's `workflow_runs` for one sha.
// -> {state: 'success'|'red'|'pending'|'none', run?}
function judgeRuns(runs, sha) {
  const mine = (runs || []).filter((r) => r && r.head_sha === sha);
  if (!mine.length) return { state: 'none' };
  // Newest run wins (a later push of the same sha supersedes an older run).
  const run = mine.slice().sort((a, b) =>
    String(b.created_at || '').localeCompare(String(a.created_at || '')) || (b.id || 0) - (a.id || 0))[0];
  if (run.status !== 'completed') return { state: 'pending', run };
  if (run.conclusion === 'success') return { state: 'success', run };
  return { state: 'red', run };
}

// A gh runner: (args) -> {ok, stdout, stderr}. Without an explicit repo, gh
// resolves {owner}/{repo} from the git remote of its cwd, so a caller that
// knows the checkout pins cwd (and a GIT_DIR-scrubbed env) via ghRunnerAt.
function ghRunnerAt(spawnOpts = {}) {
  return (args) => ghRun(args, spawnOpts);
}
function ghRunner(args) { return ghRun(args, {}); }
function ghRun(args, spawnOpts) {
  const res = spawnSync('gh', args, { ...spawnOpts, encoding: 'utf8' });
  if (res.error) return { ok: false, stdout: '', stderr: res.error.message };
  return { ok: res.status === 0, stdout: res.stdout || '', stderr: (res.stderr || '').trim() };
}

function repoPath(repo) { return repo ? `repos/${repo}` : 'repos/{owner}/{repo}'; }

// One read of the gate. -> {state, run?, failedJobs?, error?}
// An unreadable answer is state 'error' — never success.
function readGate({ sha, repo, branch = DEFAULTS.branch, workflow = DEFAULTS.workflow, gh = ghRunner }) {
  const q = `head_sha=${encodeURIComponent(sha)}&branch=${encodeURIComponent(branch)}&event=push&per_page=20`;
  const res = gh(['api', `${repoPath(repo)}/actions/workflows/${encodeURIComponent(workflow)}/runs?${q}`]);
  if (!res.ok) return { state: 'error', error: res.stderr || 'gh api failed' };
  let body;
  try { body = JSON.parse(res.stdout); } catch { return { state: 'error', error: 'unparseable gh api response' }; }
  const verdict = judgeRuns(body && body.workflow_runs, sha);
  if (verdict.state === 'red') verdict.failedJobs = failedJobs({ run: verdict.run, repo, gh });
  return verdict;
}

// Best-effort: the names of the jobs that did not pass, for the refusal message.
function failedJobs({ run, repo, gh }) {
  const res = gh(['api', `${repoPath(repo)}/actions/runs/${run.id}/jobs?per_page=100`]);
  if (!res.ok) return null;
  try {
    return (JSON.parse(res.stdout).jobs || [])
      .filter((j) => j.conclusion && j.conclusion !== 'success' && j.conclusion !== 'skipped')
      .map((j) => `${j.name} (${j.conclusion})`);
  } catch { return null; }
}

// The human sentence for a verdict.
function describe(v, { sha, branch = DEFAULTS.branch, workflow = DEFAULTS.workflow }) {
  const short = String(sha).slice(0, 12);
  const where = v.run && v.run.html_url ? ` — ${v.run.html_url}` : '';
  switch (v.state) {
    case 'success': return `\`${workflow}\` push run on ${branch} for ${short} passed${where}`;
    case 'pending': return `\`${workflow}\` push run on ${branch} for ${short} has not finished (${v.run.status})${where}`;
    case 'none': return `no \`${workflow}\` push run on ${branch} for ${short} — is the commit pushed to ${branch}?`;
    case 'error': return `could not read the \`${workflow}\` runs for ${short}: ${v.error}`;
    default: {
      const jobs = v.failedJobs && v.failedJobs.length ? `\n  failing jobs:\n    ${v.failedJobs.join('\n    ')}` : '';
      return `\`${workflow}\` push run on ${branch} for ${short} concluded ${v.run.conclusion || 'without a verdict'}${where}${jobs}`;
    }
  }
}

// Poll until the run settles or the deadline passes. 'none' keeps waiting too:
// the run a fresh push starts can take a moment to appear.
async function waitGate(opts, { timeoutMs, intervalMs, now = Date.now, sleep, log = () => {} }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const v = readGate(opts);
    if (v.state === 'success' || v.state === 'red') return v;
    if (now() + intervalMs > deadline) return v.state === 'error' ? v : { ...v, timedOut: true };
    log(describe(v, opts) + ' — waiting…');
    await sleep(intervalMs);
  }
}

function parseArgs(argv) {
  const o = { ...DEFAULTS, wait: false };
  const val = (i) => {
    if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--sha': o.sha = val(i); i++; break;
      case '--repo': o.repo = val(i); i++; break;
      case '--branch': o.branch = val(i); i++; break;
      case '--workflow': o.workflow = val(i); i++; break;
      case '--wait': o.wait = true; break;
      case '--timeout-min': o.timeoutMin = Number(val(i)); i++; break;
      case '--interval-sec': o.intervalSec = Number(val(i)); i++; break;
      default: throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!o.sha || !/^[0-9a-f]{40}$/.test(o.sha)) throw new Error('--sha must be a full 40-hex commit sha');
  for (const k of ['timeoutMin', 'intervalSec']) {
    if (!Number.isFinite(o[k]) || o[k] <= 0) throw new Error(`--${k === 'timeoutMin' ? 'timeout-min' : 'interval-sec'} must be a positive number`);
  }
  return o;
}

// CLI: exit 0 only on success. -> exit code
async function main(argv, { gh = ghRunner, out = console.log, err = console.error, sleep } = {}) {
  let o;
  try { o = parseArgs(argv); } catch (e) { err(`release-ci-gate: ${e.message}`); return 2; }
  const opts = { sha: o.sha, repo: o.repo, branch: o.branch, workflow: o.workflow, gh };
  const v = o.wait
    ? await waitGate(opts, {
      timeoutMs: o.timeoutMin * 60000,
      intervalMs: o.intervalSec * 1000,
      sleep: sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
      log: out,
    })
    : readGate(opts);
  const line = describe(v, opts);
  if (v.state === 'success') { out(`release-ci-gate: ${line}`); return 0; }
  const gha = process.env.GITHUB_ACTIONS === 'true' ? '::error::' : '';
  err(`${gha}release-ci-gate: refusing to release — ${line}${v.timedOut ? ` (gave up after ${o.timeoutMin}min)` : ''}`);
  return 1;
}

module.exports = { ghRunnerAt, judgeRuns, readGate, waitGate, describe, parseArgs, main, DEFAULTS };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

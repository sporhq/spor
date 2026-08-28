// shell/integration-runner.js — the declarative INTEGRATION STEP: a
// code-enforced merge queue that runs after every declared gate has passed and
// before a work item's resolution stands (dec-spor-factory-integration-step,
// derived-from dec-spor-software-factory-substrate).
//
// This is deliberately NOT a fourth gate kind (the decision's own rejected
// alternative): a gate judges the implementer's branch; integration MUTATES
// the target ref, must serialize across workers/machines, and cleans up after
// itself. It is a STAGE that runs once every gate has already passed, reusing
// the SAME fix-cycle / cycle-cap / human-escalation shape gates use
// (gate-runner.js) rather than inventing a second one — a merge conflict or a
// candidate-suite failure is fed back to the same implementer as a fix cycle,
// bounded the same way an agent-review gate is.
//
// Shape, mirroring gate-runner.js's runGatePipeline:
//   1. Build a CANDIDATE worktree at merge(target_ref, branch) per the
//      declared strategy. A merge conflict is a fix-cycle event, not a
//      terminal error.
//   2. Force every declared protected path in that candidate tree back to the
//      trusted ref's copy — the SAME guarantee a command gate gives
//      (WORKERS.md §10.3), reused via gate-runner.js's forceProtectedPaths.
//   3. Run the declared FULL suite on the candidate tree. A failure is also a
//      fix-cycle event.
//   4. Land via compare-and-swap: local mode is `git update-ref` CAS on the
//      target ref; push mode is a `git push` whose own non-fast-forward
//      rejection IS the CAS. A lost race rebuilds the candidate against the
//      ref's new tip and reruns — automatically, not as a fix cycle, because
//      losing a race is not the implementer's mistake.
//   5. Every landing or failure is a graph fact (art-merge-…), and a failure
//      demotes the item exactly as a failed gate does (gate-runner.js's
//      demote contract, reused via the same deps.demote).
//
// Every side effect enters through `deps`, so the whole stage is drivable with
// a fake git, a fake dispatcher, and a fake clock — same discipline as
// gate-runner.js, which this module deliberately mirrors rather than
// duplicates: id minting, fact bodies, and fence-safety all come from there.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const gates = require("../kernel/gates.js");
const { gitSpawn } = require("./git-exec.js");
const gateRunner = require("./gate-runner.js");

const git = (cwd, args, opts = {}) => gitSpawn(cwd, args, opts);
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

const { gateIdSuffix, fenceSafe, capBytes, NODE_BODY_CAP_BYTES, tailBytes } = gateRunner;
const SUMMARY_CAP = 460;
const EVIDENCE_CAP_BYTES = 2500;
const STEM_CAP = 30;

// A lost landing race is not a fix cycle — it costs the implementer nothing —
// so it is bounded separately, defensively, against the pathological case of a
// target ref moving on every single attempt.
const RACE_RETRY_CAP = 5;

function oneLine(text, cap) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > cap ? `${s.slice(0, cap - 1)}…` : s;
}

function stemOf(nodeId) {
  return (
    String(nodeId || "item")
      .replace(/^[a-z]+-/, "")
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase()
      .slice(0, STEM_CAP)
      .replace(/-+$/, "") || "item"
  );
}

function shortRun(runId) {
  return String(runId || "").replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase() || "unknown";
}

// Deterministic and idempotent, mirroring gateFactId in gate-runner.js — the
// same outcome re-filed for the same run is one node, never two.
function integrationFactId(nodeId, runId) {
  return `art-merge-${stemOf(nodeId)}-${shortRun(runId)}-${gateIdSuffix("integration", "integration", nodeId, runId)}`;
}

// The graph fact for the integration stage's outcome — the twin of gate-
// runner.js's buildGateFact, for a stage rather than a gate.
function buildIntegrationFact({ integration, nodeId, runId, project, verdict, detail, evidence, attempts, escalatedTo, demotion, date, factory }) {
  const id = integrationFactId(nodeId, runId);
  const landed = verdict === "landed";
  const summary = oneLine(
    `Integration ${landed ? "landed" : verdict} ${nodeId} onto ${integration.targetRef} for dispatched run ${shortRun(runId)}${detail ? `: ${detail}` : "."}`,
    SUMMARY_CAP
  );
  const lines = [
    "---",
    `id: ${id}`,
    "type: artifact",
    ...(project ? [`project: ${project}`] : []),
    `title: Integration ${landed ? "landed" : verdict} — ${oneLine(nodeId, 60)}`,
    `summary: ${summary}`,
    `date: ${date}`,
    "edges:",
    `  - {type: relates-to, to: ${nodeId}}`,
    ...(escalatedTo ? [`  - {type: relates-to, to: ${escalatedTo}}`] : []),
    "---",
    "",
    `The integration stage (\`${integration.mode}\` mode, \`${integration.strategy}\` strategy)`,
    `${landed ? "landed" : verdict === "blocked" ? "is blocking" : "failed"} for dispatched run \`${runId}\` on ${nodeId} onto \`${integration.targetRef}\`${factory ? `, under factory \`${factory}\`` : ""}.`,
    "",
    detail ? `Outcome: ${detail}` : "",
    escalatedTo ? `Escalated to ${escalatedTo}.` : "",
    demotion ? `Demotion: ${oneLine(demotion, 300)}` : "",
    "",
    ...(attempts && attempts.length > 1
      ? ["Attempts:", ...attempts.map((a, i) => `${i + 1}. ${a.verdict} — ${oneLine(a.detail || "", 200)}`), ""]
      : []),
    ...(evidence ? ["Evidence:", "", "```", fenceSafe(capBytes(String(evidence).trim(), EVIDENCE_CAP_BYTES)), "```", ""] : []),
    "This is an integration outcome, not a resolution: it records what the runner",
    "enforced landing the change onto the target ref.",
    "",
  ];
  return { id, markdown: capBytes(lines.filter((l) => l !== undefined).join("\n"), NODE_BODY_CAP_BYTES - 512) };
}

// Which of `remoteBranch` a push target names — "origin/main" -> {remote:
// "origin", branch: "main"}; a bare "main" defaults to "origin".
function splitRemoteRef(targetRef) {
  const cleaned = String(targetRef || "").replace(/^refs\/(heads|remotes)\//, "");
  const slash = cleaned.indexOf("/");
  if (slash > 0) return { remote: cleaned.slice(0, slash), branch: cleaned.slice(slash + 1) };
  return { remote: "origin", branch: cleaned };
}

// Materialize the CANDIDATE tree: a throwaway worktree holding merge(target_ref,
// branch) per `strategy`. Resolves target_ref FRESH every call, which is what
// makes a post-race retry rebuild against the ref's new tip rather than the
// stale one. {ok, dir, sha, expectedSha, cleanup} | {ok:false, reason,
// evidence, conflict}.
function buildCandidateTree({ top, head, targetRef, strategy }) {
  const resolved = git(top, ["rev-parse", targetRef]);
  if (resolved.status !== 0) {
    return { ok: false, reason: `the integration target ref '${targetRef}' does not resolve in ${top}` };
  }
  const expectedSha = (resolved.stdout || "").trim();

  let parent = null;
  try {
    parent = fs.mkdtempSync(path.join(os.tmpdir(), "spor-integration-"));
  } catch (e) {
    return { ok: false, reason: `could not create an integration worktree: ${e.message}` };
  }
  const dir = path.join(parent, "tree");
  const cleanup = () => {
    try {
      git(top, ["worktree", "remove", "--force", "--force", dir]);
    } catch {
      /* best effort — the rm + prune below are the backstop */
    }
    try {
      fs.rmSync(parent, { recursive: true, force: true });
    } catch {
      /* a leaked scratch dir is not worth failing integration over */
    }
    try {
      git(top, ["worktree", "prune"]);
    } catch {
      /* nothing left to do about it */
    }
  };

  // merge/squash land the branch ONTO the target — start there. rebase replays
  // the branch's own commits onto the target — start at the branch tip, so the
  // rebase's result descends linearly from `expectedSha` and a plain CAS
  // pointer-move safely lands it.
  const startAt = strategy === "rebase" ? head : expectedSha;
  const add = git(top, ["worktree", "add", "--detach", dir, startAt]);
  if (add.status !== 0) {
    cleanup();
    return { ok: false, reason: `could not create the integration candidate worktree from ${startAt.slice(0, 8)}: ${(add.stderr || "").trim().split("\n")[0] || "git worktree add failed"}` };
  }

  const ident = ["-c", "user.name=spor-integration", "-c", "user.email=integration@spor.local"];
  const bigOutput = { maxBuffer: GIT_MAX_BUFFER }; // a real conflict's stdout/stderr can be large on a sizeable change
  let action;
  if (strategy === "squash") {
    action = git(dir, ["merge", "--squash", head], bigOutput);
    if (action.status === 0) action = git(dir, [...ident, "commit", "-m", `Squash-integrate ${head.slice(0, 8)} onto ${targetRef}`], bigOutput);
  } else if (strategy === "rebase") {
    action = git(dir, ["rebase", expectedSha], bigOutput);
  } else {
    action = git(dir, [...ident, "merge", "--no-ff", "--no-edit", head], bigOutput);
  }

  if (action.status !== 0) {
    const evidence = `${action.stdout || ""}\n${action.stderr || ""}`.trim();
    // Abort whichever of the two states might be mid-flight; the one that
    // does not apply is a harmless no-op.
    try {
      git(dir, ["merge", "--abort"]);
    } catch {
      /* not mid-merge */
    }
    try {
      git(dir, ["rebase", "--abort"]);
    } catch {
      /* not mid-rebase */
    }
    cleanup();
    return {
      ok: false,
      conflict: true,
      reason: `${strategy === "rebase" ? "rebasing" : strategy === "squash" ? "squash-merging" : "merging"} ${head.slice(0, 8)} onto ${targetRef} (${expectedSha.slice(0, 8)}) conflicts`,
      evidence: tailBytes(evidence),
    };
  }

  const sha = git(dir, ["rev-parse", "HEAD"]);
  if (sha.status !== 0) {
    cleanup();
    return { ok: false, reason: `could not read the candidate tree's own HEAD after integrating ${head.slice(0, 8)}` };
  }
  return { ok: true, dir, sha: (sha.stdout || "").trim(), expectedSha, cleanup };
}

// After forceProtectedPaths restores protected paths in the candidate
// worktree's WORKING DIRECTORY (a checkout + an untracked-file removal — never
// a commit), `sha` still names the commit buildCandidateTree produced BEFORE
// that restore ran. Landing `sha` as-is would ship exactly the tampered
// protected-path edits the restore exists to strip
// (issue-spor-integration-landed-sha-pre-restoration) — the suite runs on the
// restored tree and passes, but the sha handed to landCandidate never was that
// tree. If the restore changed anything, re-commit the restored tree and land
// THAT sha instead: `git commit --amend` keeps the candidate's existing
// parents (merge's two, squash's and rebase's one), so only the tree changes,
// under every strategy. A no-op restore — the ordinary case, since the
// command gate's fail-closed check already refuses a branch that touched a
// protected path — costs nothing: the working tree already equals `sha`'s
// tree, so there is nothing to stage or amend. {ok, sha, amended} |
// {ok:false, reason}.
//
// Known residual: under `strategy: rebase` with a MULTI-commit branch, this
// amends only the replayed chain's tip. The invariant this function exists
// for — the sha handed to landCandidate has the tree the suite ran on — still
// holds, because the tip's tree is what's tested and what lands. But an
// earlier replayed commit that itself touched a protected path, with a later
// commit that doesn't touch it again, still carries the tampered content in
// ITS OWN tree, reachable from the landed history (`git show <that
// commit>:<path>`). Rewriting every commit in the chain would need a
// tree-filter over the whole rebased range, not a single amend — out of scope
// for the invariant this function guarantees.
function reconcileCandidateSha({ dir, sha }) {
  const status = git(dir, ["status", "--porcelain"]);
  if (status.status !== 0) {
    return { ok: false, reason: `could not check the candidate tree for protected-path restorations: ${(status.stderr || "").trim().split("\n")[0] || "git status failed"}` };
  }
  if (!(status.stdout || "").trim()) return { ok: true, sha, amended: false };

  const add = git(dir, ["add", "-A"]);
  if (add.status !== 0) {
    return { ok: false, reason: `could not stage the restored protected paths: ${(add.stderr || "").trim().split("\n")[0] || "git add failed"}` };
  }
  const ident = ["-c", "user.name=spor-integration", "-c", "user.email=integration@spor.local"];
  const amend = git(dir, [...ident, "commit", "--amend", "--no-edit"]);
  if (amend.status !== 0) {
    return { ok: false, reason: `could not re-commit the candidate tree after restoring protected paths: ${(amend.stderr || "").trim().split("\n")[0] || "git commit --amend failed"}` };
  }
  const rev = git(dir, ["rev-parse", "HEAD"]);
  if (rev.status !== 0) {
    return { ok: false, reason: "could not read the candidate tree's HEAD after restoring protected paths" };
  }
  return { ok: true, sha: (rev.stdout || "").trim(), amended: true };
}

// Land the candidate SHA onto the target ref. `mode` is the factory's declared
// integration.mode — `local` CAS's a local ref with `git update-ref`; `push`
// pushes, whose own non-fast-forward rejection IS the compare-and-swap. {ok,
// sha, detail} | {ok:false, race, reason}. `race:true` means "rebuild and
// retry", not "fail" — the caller decides what to do with that.
function landCandidate({ top, dir, sha, expectedSha, targetRef, mode }) {
  if (mode === "local") {
    const ref = targetRef.startsWith("refs/") ? targetRef : `refs/heads/${targetRef}`;
    const r = git(top, ["update-ref", ref, sha, expectedSha]);
    if (r.status === 0) return { ok: true, sha, detail: `landed ${sha.slice(0, 8)} on ${targetRef} (local update-ref CAS from ${expectedSha.slice(0, 8)})` };
    const now = git(top, ["rev-parse", ref]);
    const nowSha = (now.stdout || "").trim();
    if (now.status === 0 && nowSha && nowSha !== expectedSha) {
      return { ok: false, race: true, reason: `${targetRef} moved to ${nowSha.slice(0, 8)} since the candidate was built (expected ${expectedSha.slice(0, 8)})` };
    }
    return { ok: false, race: false, reason: (r.stderr || "git update-ref failed").trim().split("\n")[0] || "git update-ref failed" };
  }
  if (mode === "push") {
    const { remote, branch } = splitRemoteRef(targetRef);
    const r = git(dir, ["push", remote, `${sha}:refs/heads/${branch}`], { maxBuffer: GIT_MAX_BUFFER });
    if (r.status === 0) return { ok: true, sha, detail: `pushed ${sha.slice(0, 8)} to ${remote}/${branch}` };
    const text = `${r.stdout || ""}\n${r.stderr || ""}`;
    const rejected = /non-fast-forward|fetch first|stale info|fetch-first|rejected/i.test(text);
    return { ok: false, race: rejected, reason: text.trim().split("\n").filter(Boolean).pop() || "git push failed" };
  }
  return { ok: false, race: false, reason: `integration mode '${mode}' has no landing path` };
}

// The declarative pipeline. `item` is {node_id, run_id, project}; `factory` is
// the resolved factory (factory.integration is the block this stage enforces —
// the caller (bin/spor.js) is expected to have already confirmed it is
// present, exactly like it already checks `factory.gates.length` before
// calling the gate pipeline at all). `deps` mirrors gate-runner.js's contract:
//   changedTree()                    -> {ok, top, head, cwd} | {ok:false, reason}
//   buildCandidate({top, head, targetRef, strategy}) -> see buildCandidateTree
//   forceProtected({dir, sha})       -> {ok, reason, sha} — sha is the sha to
//                                        land: unchanged if nothing needed
//                                        restoring, or a fresh re-commit of
//                                        the restored tree otherwise (see
//                                        reconcileCandidateSha)
//   runSuite({dir})                  -> {ok, reason, output}
//   land({top, dir, sha, expectedSha, targetRef, mode}) -> see landCandidate
//   fix({cycle, kind, detail, evidence}) -> {ok, reason}
//   escalate({attempts, detail, evidence}) -> {ok, id, reason}
//   demote({blockerId})              -> {ok, demoted, note, reason}
//   recordFact({id, markdown})       -> {ok, reason}
//   acquireLease()/releaseLease(token) -> the serialize:repo lease (best effort)
//   cleanupImplementer()             -> void, called only after a landing
//   now()                            -> epoch ms
// Returns {state: "passed"|"failed"|"blocked", facts, reason, escalated_to,
// demoted, demote_reason} — the SAME shape runGatePipeline returns, so the
// caller folds the two together with no branch of its own.
async function runIntegrationStage({ item, factory, deps, log = () => {} }) {
  const integration = factory.integration;
  const nodeId = item.node_id;
  const runId = item.run_id;
  const now = deps.now || (() => Date.now());
  const attempts = [];
  const facts = [];

  const record = async ({ verdict, detail, evidence, escalatedTo, demotion }) => {
    let factId = null;
    try {
      const fact = buildIntegrationFact({
        integration, nodeId, runId, project: item.project || null, verdict, detail, evidence, attempts, escalatedTo, demotion,
        date: new Date(now()).toISOString().slice(0, 10),
        factory: factory.id,
      });
      const wrote = await deps.recordFact({ id: fact.id, markdown: fact.markdown });
      if (wrote && wrote.ok) factId = fact.id;
      else log(`work: the integration outcome for ${nodeId} could not be recorded on the graph (${(wrote && wrote.reason) || "no response"}) — the verdict still stands`);
    } catch (e) {
      log(`work: the integration outcome for ${nodeId} could not be recorded on the graph (${(e && e.message) || e}) — the verdict still stands`);
    }
    if (factId) facts.push(factId);
    return factId;
  };

  const settle = async (state, { detail, evidence }) => {
    let escalatedTo = null;
    try {
      const esc = await deps.escalate({ attempts, detail, evidence: evidence || "" });
      if (esc && esc.ok) escalatedTo = esc.id;
      else log(`work: the integration escalation for ${nodeId} could not be filed (${(esc && esc.reason) || "no response"})`);
    } catch (e) {
      log(`work: the integration escalation for ${nodeId} could not be filed (${(e && e.message) || e})`);
    }
    let demoted = { demoted: false, note: null, reason: null };
    if (deps.demote) {
      let r = null;
      try {
        r = await deps.demote({ blockerId: escalatedTo });
      } catch (e) {
        r = { ok: false, reason: `${(e && e.message) || e}` };
      }
      if (r && r.ok) {
        demoted = { demoted: !!r.demoted, note: r.note || null, reason: null };
      } else {
        const reason = (r && r.reason) || "no response";
        demoted = { demoted: false, note: null, reason };
        log(`work: integration for ${nodeId} refused, but the item could not be demoted on the graph (${reason}) — the verdict still stands`);
      }
    }
    await record({
      verdict: state, detail, evidence, escalatedTo,
      demotion: demoted.note || (demoted.reason ? `the item could not be demoted on the graph (${demoted.reason})` : null),
    });
    log(`work: integration ${state} on ${nodeId} — ${detail || "no detail"}${escalatedTo ? ` (escalated to ${escalatedTo})` : ""}${demoted.note ? `; ${demoted.note}` : ""}`);
    return {
      state, facts, reason: `integration ${state}: ${detail || ""}`.trim(),
      escalated_to: escalatedTo, demoted: demoted.demoted, demote_reason: demoted.reason,
    };
  };

  const tree = await deps.changedTree();
  if (!tree.ok) {
    const detail = tree.reason || "the change to integrate could not be read";
    attempts.push({ verdict: "failed", detail });
    return settle("failed", { detail });
  }

  let lease = null;
  try {
    lease = await deps.acquireLease();
  } catch (e) {
    log(`work: the integration lease for ${nodeId} could not be acquired (${(e && e.message) || e}) — proceeding without it`);
  }

  try {
    let cycle = 0;
    let races = 0;
    for (;;) {
      const built = await deps.buildCandidate({ top: tree.top, head: tree.head, targetRef: integration.targetRef, strategy: integration.strategy });
      if (!built.ok) {
        attempts.push({ verdict: built.conflict ? "conflict" : "failed", detail: built.reason });
        if (gates.cycleDecision(integration, cycle) === "retry") {
          log(`work: integration ${built.conflict ? "conflict" : "failure"} on ${nodeId} — fix cycle ${cycle + 1}/${integration.cycles}`);
          const fixed = await runFix(deps, { cycle, kind: built.conflict ? "conflict" : "build", detail: built.reason, evidence: built.evidence });
          cycle += 1;
          if (!fixed.ok) {
            attempts.push({ verdict: "failed", detail: `the fix cycle could not run (${(fixed && fixed.reason) || "no response"})` });
            return settle("failed", { detail: `${built.reason}; the fix cycle could not run (${(fixed && fixed.reason) || "no response"})`, evidence: built.evidence });
          }
          continue;
        }
        return settle("failed", { detail: built.reason, evidence: built.evidence });
      }

      // The candidate worktree from HERE on is cleaned up on EVERY exit from
      // this block — a normal return, a `continue` back to rebuild, or a
      // throw from any dep — never left to a scattered call the way a thrown
      // dep would skip. Landed is handled as data (`landed`) rather than an
      // early return FROM INSIDE the try: cleaning up the CANDIDATE worktree
      // must happen before deps.cleanupImplementer() touches the implementer's
      // own worktree, because buildCandidate/land ran with `top` = the
      // implementer's own working directory (gateChangeSet resolves it via
      // `git rev-parse --show-toplevel`, which for a worktree is the worktree
      // itself) — cleaning up that directory FIRST would make every git call
      // in the candidate's own cleanup() spawn against a cwd that no longer
      // exists, silently no-op via its try/catch, and leak the candidate.
      let landed = null;
      try {
        const forced = deps.forceProtected ? await deps.forceProtected({ dir: built.dir, sha: built.sha }) : { ok: true, sha: built.sha };
        if (!forced.ok) {
          attempts.push({ verdict: "failed", detail: forced.reason });
          return await settle("failed", { detail: forced.reason });
        }
        // The sha landed below must be the sha whose TREE the suite just ran
        // on. If forceProtected restored anything, it comes back with the
        // re-committed sha; a no-op restore leaves built.sha unchanged.
        const landSha = forced.sha || built.sha;

        const suite = await deps.runSuite({ dir: built.dir });
        if (!suite.ok) {
          const evidence = tailBytes(suite.output || "");
          attempts.push({ verdict: "failed", detail: suite.reason, evidence });
          if (gates.cycleDecision(integration, cycle) === "retry") {
            log(`work: the integration candidate suite failed on ${nodeId} — fix cycle ${cycle + 1}/${integration.cycles}`);
            const fixed = await runFix(deps, { cycle, kind: "suite", detail: suite.reason, evidence });
            cycle += 1;
            if (!fixed.ok) {
              attempts.push({ verdict: "failed", detail: `the fix cycle could not run (${(fixed && fixed.reason) || "no response"})` });
              return await settle("failed", { detail: `${suite.reason}; the fix cycle could not run (${(fixed && fixed.reason) || "no response"})`, evidence });
            }
            continue;
          }
          return await settle("failed", { detail: suite.reason, evidence });
        }

        const landing = await deps.land({ top: tree.top, dir: built.dir, sha: landSha, expectedSha: built.expectedSha, targetRef: integration.targetRef, mode: integration.mode });

        if (landing.ok) {
          // Set the data and fall out of the try normally (no return/continue
          // here) — the finally below cleans up the CANDIDATE worktree first;
          // deps.cleanupImplementer() runs only after that, once we act on
          // `landed` outside this try.
          attempts.push({ verdict: "landed", detail: landing.detail });
          await record({ verdict: "landed", detail: landing.detail, evidence: null });
          landed = { state: "passed", facts, reason: landing.detail || `landed on ${integration.targetRef}` };
        } else if (landing.race) {
          races += 1;
          attempts.push({ verdict: "race", detail: landing.reason });
          if (races >= RACE_RETRY_CAP) {
            log(`work: integration for ${nodeId} lost the landing race on ${integration.targetRef} ${races} times in a row — giving up`);
            return await settle("failed", { detail: `lost the landing race ${races} times in a row: ${landing.reason}` });
          }
          log(`work: integration for ${nodeId} lost the landing race on ${integration.targetRef} — rebuilding (${races}/${RACE_RETRY_CAP})`);
          continue; // rebuild fresh against the ref's new tip — a lost race is nobody's fix cycle
        } else {
          attempts.push({ verdict: "failed", detail: landing.reason });
          if (gates.cycleDecision(integration, cycle) === "retry") {
            log(`work: integration could not land ${nodeId} — fix cycle ${cycle + 1}/${integration.cycles}`);
            const fixed = await runFix(deps, { cycle, kind: "land", detail: landing.reason });
            cycle += 1;
            if (!fixed.ok) {
              attempts.push({ verdict: "failed", detail: `the fix cycle could not run (${(fixed && fixed.reason) || "no response"})` });
              return await settle("failed", { detail: `${landing.reason}; the fix cycle could not run (${(fixed && fixed.reason) || "no response"})` });
            }
            continue;
          }
          return await settle("failed", { detail: landing.reason });
        }
      } finally {
        built.cleanup();
      }

      // Only the landed path falls out of the inner try/finally without
      // returning or continuing from inside it — every other outcome already
      // exited above. The candidate worktree is gone by now (the finally just
      // ran); the implementer's own worktree is cleaned up only NOW, so its
      // removal never yanks away the cwd the candidate's own cleanup needed.
      if (deps.cleanupImplementer) {
        try {
          await deps.cleanupImplementer();
        } catch {
          /* best effort — a leaked implementer worktree is not worth failing a landed integration over */
        }
      }
      log(`work: ${nodeId} — integration landed on ${integration.targetRef}`);
      return landed;
    }
  } finally {
    if (deps.releaseLease) {
      try {
        await deps.releaseLease(lease);
      } catch {
        /* best effort — a lease this box could not release lapses on its own TTL */
      }
    }
  }
}

async function runFix(deps, { cycle, kind, detail, evidence }) {
  try {
    return await deps.fix({ cycle, kind, detail, evidence });
  } catch (e) {
    return { ok: false, reason: `${(e && e.message) || e}` };
  }
}

module.exports = {
  RACE_RETRY_CAP,
  integrationFactId,
  buildIntegrationFact,
  splitRemoteRef,
  buildCandidateTree,
  reconcileCandidateSha,
  landCandidate,
  runIntegrationStage,
};

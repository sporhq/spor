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

// The judge's git (gate-runner.js judgeGitEnv): secrets scrubbed, hooks off —
// the candidate merge/rebase and its checkout run over the judged change's
// own tree, which may point `core.hooksPath` at a tracked directory.
const git = (cwd, args, opts = {}) => gitSpawn(cwd, args, { ...opts, env: gateRunner.judgeGitEnv(opts.env) });
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

// The integration stage's id wherever a stage stands in for a gate — the
// `id` its candidate suite runs under (bin/spor.js makeIntegrationDeps
// `runSuite`) and the `gateId`/`stage` its escalation-retry payload carries
// (settle(), below). Not a reserved gate id: a factory may declare a gate
// named `integration` too, so a retry keys on `stage`, never on this alone.
const INTEGRATION_STAGE_ID = "integration";

// Deterministic and idempotent, mirroring gateFactId in gate-runner.js — the
// same outcome re-filed for the same run is one node, never two. `phase` is
// null for every mode but `propose`: local/push settle a run with exactly one
// fact, so the bare id (no phase segment) is preserved byte-for-byte. Propose
// settles a run in up to TWO facts for the SAME (nodeId, runId) — "proposed"
// when the PR opens, "landed"/"closed" later once checkProposal reads the
// PR's outcome — so each phase needs its own id, or the second write would
// collide with the first under writeGateNode's same-id-same-content rule.
function integrationFactId(nodeId, runId, phase = null, attempt = 0) {
  const suffix = gateIdSuffix("integration", phase ? `integration-${phase}` : "integration", nodeId, gateRunner.gateRunKey(runId, attempt));
  return `art-merge-${stemOf(nodeId)}-${gateRunner.shortRunAttempt(runId, attempt)}${phase ? `-${phase}` : ""}-${suffix}`;
}

// The sentence fragment naming what happened, for the fact body's one-liner.
// "landed" reads as a bare past-tense verb ("landed for dispatched run...");
// every other verdict reads as "is/was ..." — kept as one table so a new
// verdict (a future integration outcome) cannot forget to extend it and fall
// through to the "failed" default silently.
function integrationOutcomePhrase(verdict) {
  if (verdict === "landed") return "landed";
  if (verdict === "blocked") return "is blocking";
  if (verdict === "proposed") return "opened a pull request and is pending review";
  if (verdict === "closed") return "had its pull request closed without landing";
  if (verdict === "base-mismatch") return "merged onto a different base than expected and was left parked";
  if (verdict === "mismatch") return "refused to land: the branch no longer carries the candidate the gates judged";
  return "failed";
}

// The graph fact for the integration stage's outcome — the twin of gate-
// runner.js's buildGateFact, for a stage rather than a gate.
//
// Commit-bound like a gate fact (task-spor-factory-gate-attestation): `chain`
// carries the head the stage read (`gate_head` frontmatter), the head the
// gates judged, the sha it landed (or proposed), and the definition digests.
function buildIntegrationFact({ integration, nodeId, runId, project, verdict, detail, evidence, attempts, escalatedTo, demotion, date, factory, attempt = 0, chain = null, trackingPending = null }) {
  const phase = integration.mode === "propose" ? verdict : null;
  const id = integrationFactId(nodeId, runId, phase, attempt);
  const landed = verdict === "landed";
  const head = chain && chain.head ? String(chain.head) : null;
  const gatedHead = chain && chain.gatedHead ? String(chain.gatedHead) : null;
  const landedSha = chain && chain.landedSha ? String(chain.landedSha) : null;
  const def = chain && chain.definition && chain.definition.factory ? chain.definition.factory : null;
  const provenance = [
    head
      ? `Integrated commit: \`${head}\`${gatedHead ? gatedHead === head ? " (the head the gates judged)" : ` — the gates judged \`${gatedHead}\`` : ""}${landedSha ? `; ${verdict === "proposed" ? "candidate" : "landed"} sha \`${landedSha}\`` : ""}${chain.targetSha ? `; target \`${integration.targetRef}\` was at \`${chain.targetSha}\`` : ""}.`
      : "",
    def ? `Definition: factory \`${def.id || factory || "?"}\`${def.revision ? ` rev \`${def.revision}\`` : ""}${def.digest ? ` digest \`${def.digest}\`` : ""}.` : "",
  ].filter(Boolean);
  const summary = oneLine(
    `Integration ${landed ? "landed" : verdict} ${nodeId} onto ${integration.targetRef} for dispatched run ${shortRun(runId)}${detail ? `: ${detail}` : "."}`,
    SUMMARY_CAP
  );
  // A "landed" fact in propose mode is what actually RESOLVES the tracking
  // item checkProposal parked the item behind — the PR merging is the fact
  // that closes it. Every other verdict only RELATES to its tracking/blocker
  // item, exactly like a gate's own escalation (it names why, it does not
  // retire anything).
  const escalatedEdgeType = landed && integration.mode === "propose" ? "resolves" : "relates-to";
  const lines = [
    "---",
    `id: ${id}`,
    "type: artifact",
    ...(project ? [`project: ${project}`] : []),
    `title: Integration ${landed ? "landed" : verdict} — ${oneLine(nodeId, 60)}`,
    `summary: ${summary}`,
    `date: ${date}`,
    ...(head ? [`gate_head: ${head}`] : []),
    ...(landedSha ? [`landed_sha: ${landedSha}`] : []),
    "edges:",
    `  - {type: relates-to, to: ${nodeId}}`,
    ...(escalatedTo ? [`  - {type: ${escalatedEdgeType}, to: ${escalatedTo}}`] : []),
    "---",
    "",
    `The integration stage (\`${integration.mode}\` mode, \`${integration.strategy}\` strategy)`,
    `${integrationOutcomePhrase(verdict)} for dispatched run \`${runId}\` on ${nodeId} onto \`${integration.targetRef}\`${factory ? `, under factory \`${factory}\`` : ""}.`,
    "",
    ...provenance,
    "",
    detail ? `Outcome: ${detail}` : "",
    escalatedTo ? `Escalated to ${escalatedTo}.` : "",
    // A park whose tracking-node write failed still KNOWS the tracker's id
    // (proposalTrackingId is deterministic over node/run), so the fact names
    // it — as prose, never an edge: the node does not exist yet, and an edge
    // to a missing target is not something every write door accepts. The heal
    // pass files it under exactly this id and wires `blocks` then.
    !escalatedTo && trackingPending ? `Tracking item: ${trackingPending} — not on the graph yet (its write failed on this pass); the per-pass proposal check files it under this id.` : "",
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

// Where the branch this stage is standing on stands relative to the PINNED
// candidate (task-spor-integration-builds-candidate-from-pinned-commit,
// FACTORY-IMPLEMENTATION-STAGE.md §3.2 "first published wins" and §4.2 M1).
// Pure git facts — three of them; the JUDGEMENT of what they mean is
// runIntegrationStage's, so a new rule there needs no new probe here:
//
//   contained         the pinned commit is reachable from `head` (a commit is
//                     its own ancestor, so an unmoved branch is contained)
//   commitTreeMatches `rev-parse <commit>^{tree}` equals the candidate's own
//                     `tree` — M1's own definition of a candidate whose
//                     evidence does not describe it
//   headTreeMatches   the branch head resolves to the candidate's tree, i.e.
//                     the head is a same-tree RELABEL of the pinned commit
//                     (an amend, a re-commit): §3.2's "a head that is a
//                     same-tree relabel of the pinned commit is not what
//                     lands — its tree is, under the commit that was
//                     published"
//
// Three-valued like gate-runner.js's gateHeadLanded, and for the same reason:
// `known: false` (a commit git cannot resolve, a probe that errored) is not
// evidence of anything and must never be read as "contained". The caller
// fails CLOSED on it — this stage is about to land a tree, and a tree it
// cannot verify is exactly what it must not land.
function candidateStanding({ top, head, commit, tree = null }) {
  const unknown = (reason) => ({ known: false, contained: null, commitTreeMatches: null, headTreeMatches: null, reason });
  if (!top || !head || !commit) return unknown("the pinned candidate could not be located in this checkout");
  // A record's `commit` is data read off disk, and it reaches git as an
  // ARGUMENT: `gitSpawn` uses argv (so there is no shell in play), but a value
  // beginning with `-` would still be parsed as a git OPTION. kernel/candidate
  // .js mints only full object names (OBJECT_NAME_RE), so anything else is a
  // tampered or hand-edited record — refused here rather than probed, which is
  // the same fail-closed direction every other reading in this function takes.
  if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(String(commit))) return unknown("the pinned commit is not a full git object name");
  const obj = git(top, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]);
  if (obj.status !== 0) return unknown(`the pinned commit is not in ${top}`);
  const anc = git(top, ["merge-base", "--is-ancestor", commit, head]);
  const contained = anc.status === 0 ? true : anc.status === 1 ? false : null;
  if (contained === null) return unknown(`git could not tell whether the pinned commit is contained in ${head.slice(0, 8)}`);
  const pinTree = git(top, ["rev-parse", `${commit}^{tree}`]);
  const headTree = git(top, ["rev-parse", `${head}^{tree}`]);
  if (pinTree.status !== 0 || headTree.status !== 0) return unknown("the candidate's tree could not be read in this checkout");
  // The relabel test compares the head against the candidate's RECORDED tree
  // when it has one, and against the pinned commit's OWN tree when it does not
  // — a candidate carrying no `tree` (a legacy or hand-edited record; the
  // minter always writes one) then still gets a real answer instead of a
  // `null` that reads as "different" in one mode and is ignored in another.
  // `commitTreeMatches` stays null there, because there is nothing recorded to
  // disagree with, and the caller tests it for an explicit `false`.
  const basis = tree || (pinTree.stdout || "").trim();
  return {
    known: true,
    contained,
    commitTreeMatches: tree ? (pinTree.stdout || "").trim() === tree : null,
    headTreeMatches: (headTree.stdout || "").trim() === basis,
    reason: null,
  };
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
// branch) per `strategy`. Resolves target_ref FRESH every call (and in push
// mode FETCHES it first), which is what makes a post-race retry rebuild
// against the ref's new tip rather than the stale one. {ok, dir, sha, expectedSha, cleanup} | {ok:false, reason,
// evidence, conflict}.
//
// `label` names what is being landed (the work item's id, from the caller) so
// the merge/squash commit the landing leaves on the target ref reads as
// "Integrate task-x onto main" in `git log`, not git's default
// "Merge commit '<sha>' into HEAD".
// `teardown(dir)` mirrors gate-runner's prepareGateTree: run first thing in
// `cleanup`, before the candidate worktree goes, so a service the setup hook
// started for it can be stopped.
function buildCandidateTree({ top, head, targetRef, strategy, label = null, teardown = null, mode = "local" }) {
  // Push mode lands on a REMOTE ref, and the local remote-tracking ref only
  // moves when this box pushes or fetches — so without a fetch here, a lost
  // landing race (another pusher moved the branch) would "rebuild against the
  // ref's new tip" on the same stale tip, be rejected again, and burn through
  // RACE_RETRY_CAP (issue-spor-integration-push-mode-never-fetches). Fetch
  // exactly the target branch, every build, so `expectedSha` is the live tip.
  // A fetch that cannot run is not evidence of anything — fail closed.
  if (mode === "push") {
    const { remote, branch } = splitRemoteRef(targetRef);
    const fetched = git(top, ["fetch", "--quiet", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`], { maxBuffer: GIT_MAX_BUFFER });
    if (fetched.status !== 0) {
      return { ok: false, reason: `could not fetch ${remote}/${branch} before building the integration candidate: ${(fetched.stderr || "").trim().split("\n").filter(Boolean).pop() || "git fetch failed"}` };
    }
  }
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
    if (teardown) {
      try {
        teardown(dir);
      } catch {
        /* the tree still goes */
      }
    }
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
    if (action.status === 0) action = git(dir, [...ident, "commit", "-m", `Integrate ${label || head.slice(0, 8)} onto ${targetRef} (squash of ${head.slice(0, 8)})`], bigOutput);
  } else if (strategy === "rebase") {
    action = git(dir, ["rebase", expectedSha], bigOutput);
  } else {
    action = git(dir, [...ident, "merge", "--no-ff", "-m", `Integrate ${label || head.slice(0, 8)} onto ${targetRef}`, head], bigOutput);
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
// The tip is not the only commit the landing makes reachable, though
// (issue-spor-integration-rebase-intermediate-protected-paths). Under `rebase`
// every replayed commit lands; under `merge` the branch's own commits ride in
// behind the merge's second parent. An earlier one that touched a protected
// path — a later one then leaving it alone, or reverting it — still carries the
// tampered content in ITS OWN tree (`git show <that commit>:<path>`), reachable
// from the target ref with the tip perfectly clean. So when the caller names
// the candidate's `base` (the target tip it was built on) and its
// `protectedPaths`, every commit in `base..sha` is read, and if ANY of them
// touched a protected path and there is more than one, the range is COLLAPSED
// to a single commit on `base` carrying the restored tree. Squash-on-land,
// deliberately not a per-commit tree-filter: it changes history shape only in
// the already-anomalous case (the command gate fails such a branch closed
// before integration ever runs), and a squash cannot leave a commit behind that
// the rewrite missed. "Touched" is read from each commit's own diff, not its
// tree — a commit that never touched a protected path carries its parent's
// copy, so an untouched range carries the target's own — and it is
// over-inclusive on purpose (a touch that happens to restore the trusted copy
// still collapses). Any read that fails here fails the stage closed. With no
// `base`, the tip-only behavior above is unchanged. {ok, sha, amended,
// collapsed} — `collapsed` is the number of commits folded, or 0.
function reconcileCandidateSha({ dir, sha, base = null, protectedPaths = [], message = null }) {
  const status = git(dir, ["status", "--porcelain"]);
  if (status.status !== 0) {
    return { ok: false, reason: `could not check the candidate tree for protected-path restorations: ${(status.stderr || "").trim().split("\n")[0] || "git status failed"}` };
  }
  const dirty = Boolean((status.stdout || "").trim());

  let collapse = 0;
  if (base && (protectedPaths || []).length) {
    const count = git(dir, ["rev-list", "--count", `${base}..${sha}`]);
    // `--cc`: a merge INSIDE the range lists the paths it resolved to content
    // neither parent had (an evil merge), which a plain log would print
    // nothing for; a merge that only takes one side's copy stays silent, so
    // the candidate's own top merge never collapses just because the target
    // moved a protected path since the fork.
    const touched = git(dir, ["log", "--cc", "--no-renames", "--name-only", "-z", "--format=", `${base}..${sha}`], { maxBuffer: GIT_MAX_BUFFER });
    if (count.status !== 0 || touched.status !== 0) {
      return { ok: false, reason: `could not read the candidate's landed history for protected-path edits: ${((count.status !== 0 ? count : touched).stderr || "").trim().split("\n")[0] || "git failed"}` };
    }
    const n = Number((count.stdout || "").trim()) || 0;
    const paths = (touched.stdout || "").split("\0").map((l) => l.trim()).filter(Boolean);
    if (n > 1 && gates.matchPaths(paths, protectedPaths).length) collapse = n;
  }
  if (!dirty && !collapse) return { ok: true, sha, amended: false, collapsed: 0 };

  if (dirty) {
    const add = git(dir, ["add", "-A"]);
    if (add.status !== 0) {
      return { ok: false, reason: `could not stage the restored protected paths: ${(add.stderr || "").trim().split("\n")[0] || "git add failed"}` };
    }
  }
  const ident = ["-c", "user.name=spor-integration", "-c", "user.email=integration@spor.local"];
  if (collapse) {
    // `reset --soft` keeps the index — the restored tree — and moves HEAD to
    // `base`, so the one commit below has `base` as its only parent.
    const reset = git(dir, ["reset", "--soft", base]);
    if (reset.status !== 0) {
      return { ok: false, reason: `could not collapse the candidate's history onto ${base.slice(0, 8)}: ${(reset.stderr || "").trim().split("\n")[0] || "git reset failed"}` };
    }
    const msg = `${message || `Integrate ${sha.slice(0, 8)}`} (${collapse} commits collapsed: they touched protected paths)`;
    const commit = git(dir, [...ident, "commit", "--allow-empty", "-m", msg]);
    if (commit.status !== 0) {
      return { ok: false, reason: `could not commit the collapsed candidate tree: ${(commit.stderr || "").trim().split("\n")[0] || "git commit failed"}` };
    }
  } else {
    const amend = git(dir, [...ident, "commit", "--amend", "--no-edit"]);
    if (amend.status !== 0) {
      return { ok: false, reason: `could not re-commit the candidate tree after restoring protected paths: ${(amend.stderr || "").trim().split("\n")[0] || "git commit --amend failed"}` };
    }
  }
  const rev = git(dir, ["rev-parse", "HEAD"]);
  if (rev.status !== 0) {
    return { ok: false, reason: "could not read the candidate tree's HEAD after restoring protected paths" };
  }
  return { ok: true, sha: (rev.stdout || "").trim(), amended: true, collapsed: collapse };
}

// After a LOCAL landing moved the target ref with `update-ref`, bring the one
// checkout that has that branch checked out — the shared main checkout, on a
// dev box — up to the landed commit, for the landed files only.
//
// `update-ref` moves the ref and nothing else: that checkout's HEAD now names
// the new commit while its index and working tree still hold the old tree, so
// `git status` there reads as a staged mega-revert of everything just landed,
// and a plain `git commit` from it backs the feature out of the branch again
// (the beb04c9 incident; issue-spor-live-server-stale-working-tree). The
// orchestrator skill this stage replaces had a person reconcile that by hand
// after every merge; a worker that lands unattended has to do it itself.
//
// SURGICAL, never a reset: only the paths the landing changed
// (`fromSha..toSha`), and each one only when that checkout's index AND working
// copy still equal the PRE-landing version — i.e. nothing there was touched
// since. A path someone edited in that checkout meanwhile is left alone and
// named in the note; another job's WIP in the shared checkout is exactly what
// a blanket `checkout HEAD -- .` would have destroyed. A checkout mid-merge or
// mid-rebase is skipped whole. Best-effort by contract: the landing already
// happened, and a reconcile that cannot run only leaves the checkout as
// `update-ref` alone would have.
function reconcileCheckedOutTarget({ top, ref, fromSha, toSha }) {
  const none = { checkout: null, updated: [], skipped: [], note: "" };
  if (!fromSha || !toSha || fromSha === toSha) return none;
  // Which worktree (if any) has the branch checked out. Git refuses the same
  // branch in two worktrees, so there is at most one.
  const list = git(top, ["worktree", "list", "--porcelain"], { maxBuffer: GIT_MAX_BUFFER });
  if (list.status !== 0) return none;
  let checkout = null;
  let current = null;
  for (const line of (list.stdout || "").split("\n")) {
    if (line.startsWith("worktree ")) current = line.slice("worktree ".length).trim();
    else if (line === `branch ${ref}` && current) checkout = current;
  }
  if (!checkout || !fs.existsSync(checkout)) return none;
  const inProgress = ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"].some((f) => {
    const p = (git(checkout, ["rev-parse", "--path-format=absolute", "--git-path", f]).stdout || "").trim();
    return !!p && fs.existsSync(p);
  });
  if (inProgress) return { ...none, checkout, note: `${checkout} has a merge/rebase in progress — its working tree was left as-is` };

  const diff = git(top, ["diff", "--name-status", "-z", fromSha, toSha], { maxBuffer: GIT_MAX_BUFFER });
  if (diff.status !== 0) return { ...none, checkout };
  const entries = [];
  const parts = (diff.stdout || "").split("\0");
  for (let i = 0; i + 1 < parts.length; ) {
    const status = parts[i];
    if (!status) break;
    if (status.startsWith("R") || status.startsWith("C")) {
      // renames/copies carry two paths: the old one is gone, the new one is added
      entries.push({ status: "D", path: parts[i + 1] });
      entries.push({ status: "A", path: parts[i + 2] });
      i += 3;
    } else {
      entries.push({ status: status[0], path: parts[i + 1] });
      i += 2;
    }
  }
  const updated = [];
  const skipped = [];
  const untouched = (p) => {
    // The working copy and the index both still hold the pre-landing version:
    // `git diff <fromSha> -- p` is worktree-vs-tree, `--cached` is index-vs-tree.
    const wt = git(checkout, ["diff", "--quiet", fromSha, "--", p]);
    const ix = git(checkout, ["diff", "--cached", "--quiet", fromSha, "--", p]);
    return wt.status === 0 && ix.status === 0;
  };
  const toCheckout = [];
  const toRemove = [];
  const toIndexOnly = [];
  for (const e of entries) {
    if (!e.path) continue;
    const localFile = e.status === "A" && fs.existsSync(path.join(checkout, e.path));
    if (localFile || !untouched(e.path)) {
      // Someone's local work — a file the landing ADDS that already exists
      // there untracked, or a landed path edited in that checkout since. The
      // working copy is never overwritten. The INDEX still moves to the landed
      // blob when it was itself untouched: that leaves the local edit visible
      // as an ordinary unstaged modification against the landed version,
      // instead of a staged phantom revert of the landing plus an unstaged
      // edit on top.
      skipped.push(e.path);
      const ix = git(checkout, ["diff", "--cached", "--quiet", fromSha, "--", e.path]);
      if (ix.status === 0) toIndexOnly.push(e.path);
      continue;
    }
    if (e.status === "D") toRemove.push(e.path);
    else toCheckout.push(e.path);
  }
  for (let i = 0; i < toIndexOnly.length; i += 100) {
    git(checkout, ["reset", "-q", toSha, "--", ...toIndexOnly.slice(i, i + 100)]);
  }
  for (let i = 0; i < toCheckout.length; i += 100) {
    const chunk = toCheckout.slice(i, i + 100);
    const co = git(checkout, ["checkout", toSha, "--", ...chunk]);
    if (co.status === 0) updated.push(...chunk);
    else skipped.push(...chunk);
  }
  for (let i = 0; i < toRemove.length; i += 100) {
    const chunk = toRemove.slice(i, i + 100);
    // The index still lists the file (at the pre-landing blob); HEAD no longer
    // does. `rm --cached` drops the index entry, then the working copy goes.
    const rm = git(checkout, ["rm", "-q", "--cached", "--", ...chunk]);
    if (rm.status !== 0) {
      skipped.push(...chunk);
      continue;
    }
    for (const p of chunk) {
      try {
        fs.rmSync(path.join(checkout, p), { force: true });
      } catch {
        /* the index entry is gone either way; a leftover file reads as untracked */
      }
    }
    updated.push(...chunk);
  }
  const note =
    updated.length || skipped.length
      ? `brought ${checkout} up to the landed commit (${updated.length} path${updated.length === 1 ? "" : "s"}` +
        `${skipped.length ? `; left ${skipped.length} locally-modified path${skipped.length === 1 ? "" : "s"} alone: ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? ", …" : ""}` : ""})`
      : "";
  return { checkout, updated, skipped, note };
}

// Land the candidate SHA onto the target ref. `mode` is the factory's declared
// integration.mode — `local` CAS's a local ref with `git update-ref`; `push`
// pushes, whose own non-fast-forward rejection IS the compare-and-swap. {ok,
// sha, detail} | {ok:false, race, reason}. `race:true` means "rebuild and
// retry", not "fail" — the caller decides what to do with that.
function landCandidate({ top, dir, sha, expectedSha, targetRef, mode }) {
  if (mode === "local") {
    const ref = targetRef.startsWith("refs/") ? targetRef : `refs/heads/${targetRef}`;
    // `update-ref <ref> <new> <old>` only asserts the ref is STILL at <old> —
    // it says nothing about whether <new> actually descends from <old>, so a
    // candidate built from a stale base (buildCandidateTree normally
    // guarantees descent, but this is the last line of defense against a
    // caller-supplied sha that skipped that step) would silently REWIND the
    // ref instead of losing a race (issue-spor-orchestrator-merge-cas-lacks-
    // ancestry-check: a merge subagent's own hand-run CAS did exactly this
    // and cost six already-landed commits). Refuse before the swap runs — a
    // non-descendant is a build defect, not a lost race, so it is never
    // silently retried the way `race: true` would be.
    const ancestry = git(top, ["merge-base", "--is-ancestor", expectedSha, sha]);
    if (ancestry.status !== 0) {
      return {
        ok: false,
        race: false,
        reason: `refusing to land ${sha.slice(0, 8)} on ${targetRef}: it does not descend from the observed tip ${expectedSha.slice(0, 8)} (ancestry check failed) — the candidate was built from a stale base`,
      };
    }
    const r = git(top, ["update-ref", ref, sha, expectedSha]);
    if (r.status === 0) {
      const synced = reconcileCheckedOutTarget({ top, ref, fromSha: expectedSha, toSha: sha });
      return {
        ok: true,
        sha,
        detail: `landed ${sha.slice(0, 8)} on ${targetRef} (local update-ref CAS from ${expectedSha.slice(0, 8)})${synced.note ? `; ${synced.note}` : ""}`,
        reconciled: synced,
      };
    }
    const now = git(top, ["rev-parse", ref]);
    const nowSha = (now.stdout || "").trim();
    // The ref is ALREADY at the candidate: this landing landed and its result
    // was not recorded (the workflow's at-least-once window — a crash between
    // executing the land and journaling it re-runs it). Not a race: nothing
    // moved the ref away from what this stage meant to put there.
    // The reconcile is surgical and idempotent (a path already at the landed
    // version is left alone), so a retry that crashed between the swap and
    // the reconcile still brings the checked-out target up to date.
    if (now.status === 0 && nowSha && nowSha === sha) {
      const synced = reconcileCheckedOutTarget({ top, ref, fromSha: expectedSha, toSha: sha });
      return {
        ok: true,
        sha,
        detail: `landed ${sha.slice(0, 8)} on ${targetRef} (the ref already stood at it — a landing recorded on retry)${synced.note ? `; ${synced.note}` : ""}`,
        reconciled: synced,
      };
    }
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
//   forceProtected({dir, sha, base}) -> {ok, reason, sha} — sha is the sha to
//                                        land: unchanged if nothing needed
//                                        restoring, or a fresh re-commit of
//                                        the restored tree otherwise — collapsed
//                                        onto `base` (the target tip it was
//                                        built on) when earlier landed commits
//                                        touched a protected path (see
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
// and, optional, what the workflow form adds (integration-workflow.js):
//   dispatchFix(args) + awaitRun({runId}) -> the fix cycle as a launch that
//                                        returns {ok, runId} plus a driver-side
//                                        wait for the run's terminal state
//                                        ({ok, reason}); with both wired the
//                                        workflow awaits the run as a SIGNAL
//                                        and a resumed worker awaits the same
//                                        run instead of dispatching again; a
//                                        `fix` that is not their composition
//                                        (gate-deps tags its own
//                                        `composedOfSignals`) wins over them
//   discardCandidate({top, dir})     -> tear down a candidate worktree by path
//                                        (a resumed worker's predecessor built
//                                        it; its cleanup closure died with it)
//   workflowJournal()                -> {journal, persist}: the durable journal
//                                        (execution-store.js openWorkflowJournal)
//                                        the stage replays from; absent = an
//                                        in-memory journal, byte-identical to
//                                        the pre-kernel stage
// Returns {state: "passed"|"failed"|"blocked"|"parked", facts, reason,
// escalated_to, demoted, demote_reason} — plus `escalation_failed: true` on a
// failed/blocked verdict whose escalation could not be filed (and so demoted
// nothing) — the SAME shape runGatePipeline returns, so the caller folds the
// two together with no branch of its own. An unsettled hand-up (a ci outage,
// an interrupted re-gate) is {state: "interrupted", ...}: the workflow has
// YIELDED (a durable timer, its lease released, its candidate torn down) and
// the next drive over the same journal continues from there.
//
// `gatedHead` (task-spor-factory-gate-attestation) is the head the gate
// pipeline's last passing gate judged. The stage re-reads the implementer's
// tree independently (deps.changedTree), and a FIRST read whose head differs
// refuses — settled failed, escalated to a person — because whatever moved the
// checkout between the verdict and the landing produced a head no gate has
// judged. It is deliberately NOT a fix cycle: a fix cycle commits, so it
// produces a new head by construction and can never restore the equality;
// only re-gating can. The stage's OWN fix cycles (conflict, candidate suite)
// legitimately move the head afterwards, and the merge fact records both
// heads so that is visible.
//
// The stage's control flow is `integrationWorkflow` in integration-workflow.js
// — one deterministic function of (input, journal) over lib/kernel/workflow.js
// (task-spor-integration-stage-as-workflow-function); this is its driver's
// door, kept under the name and contract every caller and test already uses.
// The require is lazy because that module imports this one for the fact
// builders and the id minting.
function runIntegrationStage(args) {
  return require("./integration-workflow.js").driveIntegrationStage(args);
}

// Tear down a candidate worktree BY PATH — the resumed-worker twin of the
// `cleanup` closure buildCandidateTree hands back, for a worktree a dead
// worker built (its closure died with it, the directory did not). Same three
// steps, same best-effort posture; the scratch parent is removed only when it
// is one of ours (buildCandidateTree's `spor-integration-` prefix), never an
// arbitrary directory a record happened to name.
function discardCandidateTree({ top, dir }) {
  if (!dir) return { ok: true, removed: false };
  try {
    git(top, ["worktree", "remove", "--force", "--force", dir]);
  } catch {
    /* best effort — the rm + prune below are the backstop */
  }
  const parent = path.dirname(dir);
  if (path.basename(dir) === "tree" && path.basename(parent).startsWith("spor-integration-")) {
    try {
      fs.rmSync(parent, { recursive: true, force: true });
    } catch {
      /* a leaked scratch dir is not worth failing integration over */
    }
  }
  try {
    git(top, ["worktree", "prune"]);
  } catch {
    /* nothing left to do about it */
  }
  return { ok: true, removed: true };
}

// The OTHER half of propose mode's lifecycle — "did the PR land yet?" — run
// on a SEPARATE, later pass (never inside the run that opened the PR: that
// run already parked and freed its slot). `proposal` is what the run record
// carried away from `park()`: { nodeId, runId, project, number, repo, url,
// branch, targetRef, blockerId, strategy, factory }. `deps.prStatus(proposal)`
// -> {ok, state: "open"|"closed", merged, mergedBy, mergeCommitSha, baseRefName,
// reason}.
//
// `baseRefName` is cross-checked against `proposal.targetRef` before a merged
// PR is ever treated as landed (task-spor-integration-propose-mode base-check
// gap): GitHub's merged/closed report is keyed on PR NUMBER alone and says
// nothing about which base it actually merged onto, so a PR view/status call
// keyed only on number can silently confirm a retargeted (or coincidentally
// reused) PR that never reached THIS proposal's targetRef. A mismatch never
// resolves/restores — it records a `base-mismatch` fact (PR number, actual
// base, expected targetRef) and leaves the tracking item parked for a person,
// same fail-safe direction as the recordFact-gates-restore rule below.
//
// Deliberately reads the GRAPH as the source of truth for "is there still
// something to check" (the caller skips a proposal whose blocker item is
// already terminal) rather than mutating this run's own record: the settled-
// verdict guard in stampGateState refuses to touch a record once its
// `gate_state` reads "parked" (SETTLED_GATE_STATES), which is the CORRECT
// behavior for THIS run's pipeline (it must never be resumed/re-run) but
// means the proposal's own open/landed/closed lifecycle cannot live there
// either — it lives on the blocker item checkProposal resolves once merged.
//
// recordFact (the landed fact, carrying the `resolves` edge) runs BEFORE
// `restore`, and GATES it: task-cc-terminal-status-requires-resolver means the
// resolver has to exist on the graph before the tracking item's own status can
// validly flip terminal, so a recordFact failure must stop this pass short of
// calling `restore` at all — never just log and carry on. Leaving the tracking
// item open (nothing promoted, nothing closed) is exactly what makes the NEXT
// `spor work` pass retry: blockerAlreadyClosed reads the tracking item's own
// STATUS, not a resolving edge, so an open tracking item is retried
// unconditionally. recordFact's fact id is deterministic
// (integrationFactId), so that retry's write is idempotent whether or not the
// previous attempt actually landed before failing to report success.
async function checkProposal(proposal, { deps, log = () => {} }) {
  const nodeId = proposal.nodeId;
  let status = null;
  try {
    status = await deps.prStatus(proposal);
  } catch (e) {
    return { checked: false, reason: `${(e && e.message) || e}` };
  }
  if (!status || !status.ok) {
    return { checked: false, reason: (status && status.reason) || "could not read the pull request's status" };
  }
  if (status.state !== "closed") return { checked: true, settled: false };

  const date = new Date((deps.now ? deps.now() : Date.now())).toISOString().slice(0, 10);
  const integration = { mode: "propose", targetRef: proposal.targetRef, strategy: proposal.strategy || "merge" };

  // task-spor-integration-propose-mode base-check gap: GitHub's own
  // merged/closed report is keyed by PR NUMBER alone — it says nothing about
  // WHICH base the PR actually merged onto. A PR can be retargeted after
  // park() recorded the expected base (or a stale/coincidentally-reused PR
  // number could belong to a different base entirely), so "merged" is not by
  // itself evidence this landed on THIS proposal's targetRef. Cross-check
  // before ever treating it as landed — same fail-safe direction as the
  // recordFact-gates-restore rule below: stay parked, never falsely resolve.
  const expectedBase = splitRemoteRef(proposal.targetRef).branch;
  if (status.merged && status.baseRefName !== expectedBase) {
    const detail = `PR #${proposal.number} merged onto \`${status.baseRefName || "(unknown)"}\`, not the expected \`${expectedBase}\` (targetRef \`${proposal.targetRef}\`) — left parked for a person to reconcile`;
    const mismatchFact = buildIntegrationFact({
      integration,
      nodeId,
      runId: proposal.runId,
      project: proposal.project || null,
      verdict: "base-mismatch",
      detail,
      evidence: proposal.url || null,
      attempts: [],
      escalatedTo: proposal.blockerId || null,
      demotion: null,
      date,
      factory: proposal.factory || null,
    });
    let mismatchFactId = null;
    try {
      const wrote = await deps.recordFact({ id: mismatchFact.id, markdown: mismatchFact.markdown });
      if (wrote && wrote.ok) mismatchFactId = mismatchFact.id;
    } catch {
      /* best-effort note — a failed write here just leaves the tracking item open for the next pass to retry and re-record */
    }
    log(
      `work: ${nodeId} — PR #${proposal.number} merged onto \`${status.baseRefName || "unknown"}\`, not the expected \`${expectedBase}\` — NOT resolving; ${proposal.blockerId || "its"} tracking item stays open for a person`
    );
    return { checked: true, settled: false, state: "base-mismatch", fact: mismatchFactId, baseRefName: status.baseRefName || null, expectedBase };
  }

  const verdict = status.merged ? "landed" : "closed";
  const detail = status.merged
    ? `PR #${proposal.number} merged${status.mergedBy ? ` by ${status.mergedBy}` : ""}${status.mergeCommitSha ? ` as ${String(status.mergeCommitSha).slice(0, 8)}` : ""} onto ${proposal.targetRef}`
    : `PR #${proposal.number} was closed without merging — a person decides what happens next`;

  const fact = buildIntegrationFact({
    integration, nodeId, runId: proposal.runId, project: proposal.project || null,
    verdict, detail, evidence: proposal.url || null, attempts: [], escalatedTo: proposal.blockerId || null, demotion: null,
    date, factory: proposal.factory || null,
  });
  let factId = null;
  try {
    const wrote = await deps.recordFact({ id: fact.id, markdown: fact.markdown });
    if (wrote && wrote.ok) factId = fact.id;
    else log(`work: the ${verdict} outcome for ${nodeId}'s proposal could not be recorded on the graph (${(wrote && wrote.reason) || "no response"})${status.merged ? " — leaving the proposal parked for a retry" : " — the verdict still stands"}`);
  } catch (e) {
    log(`work: the ${verdict} outcome for ${nodeId}'s proposal could not be recorded on the graph (${(e && e.message) || e})${status.merged ? " — leaving the proposal parked for a retry" : " — the verdict still stands"}`);
  }

  if (!status.merged) {
    log(`work: ${nodeId} — PR #${proposal.number} closed without merging; ${proposal.blockerId || "its"} tracking item still stands for a person to decide`);
    return { checked: true, settled: true, state: "closed", fact: factId };
  }

  // The gate: no resolver landed, so do not restore — see the block comment
  // above checkProposal. `settled: false` reports honestly that this pass did
  // not finish the job, even though the PR itself is already merged.
  if (!factId) {
    return { checked: true, settled: false, state: "landed", fact: null, restored: false, restore_reason: "the landed fact could not be recorded" };
  }

  let restored = { restored: false, note: null, reason: null };
  if (deps.restore) {
    try {
      const r = await deps.restore({ blockerId: proposal.blockerId, nodeId, factId });
      if (r && r.ok) restored = { restored: !!r.restored, note: r.note || null, reason: null };
      else restored = { restored: false, note: null, reason: (r && r.reason) || "no response" };
    } catch (e) {
      restored = { restored: false, note: null, reason: `${(e && e.message) || e}` };
    }
  }
  log(`work: ${nodeId} — PR #${proposal.number} landed; ${restored.note || (restored.reason ? `could not restore the item's resolution (${restored.reason})` : "nothing to restore")}`);
  return { checked: true, settled: true, state: "landed", fact: factId, restored: restored.restored, restore_reason: restored.reason };
}

module.exports = {
  RACE_RETRY_CAP,
  INTEGRATION_STAGE_ID,
  integrationFactId,
  integrationOutcomePhrase,
  buildIntegrationFact,
  splitRemoteRef,
  candidateStanding,
  buildCandidateTree,
  reconcileCandidateSha,
  landCandidate,
  reconcileCheckedOutTarget,
  discardCandidateTree,
  runIntegrationStage,
  checkProposal,
};

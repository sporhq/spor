// kernel/candidate.js — the FACTORY CANDIDATE object and the implementation
// stage's run-record vocabulary (task-spor-factory-candidate-record,
// derived-from dec-spor-factory-implementation-stage-contract; the contract is
// FACTORY-IMPLEMENTATION-STAGE.md §3-§4, which at the time of writing lives on
// the `task-spor-factory-implementation-stage` branch, not on main).
//
// A CANDIDATE is a pinned commit plus the tree it resolves to, plus provenance,
// plus a reference something other than this process can follow. It is never an
// agent's claim of resolution — that is the whole point: under
// `completion.by: controller` the implementer submits one of these and the
// RUNNER writes the resolving edge at the declared boundary, so a pending or
// refused pipeline releases nothing.
//
// This file is the PURE half — no I/O, no clock, no process, and (like every
// other kernel module) no node builtins: the sha256 the id is derived from is
// INJECTED, so the whole vocabulary is testable with a fake hasher and the one
// place that owns crypto stays in the shell. Every side effect — the git reads
// that fill `commit`/`tree`/`base`, the run-record stamps, the publish — lives
// in shell/gate-runner.js and bin/spor.js.
//
// Zero deps; plain Node.
"use strict";

// The object's own version, carried on every candidate so a reader that meets
// one written by a newer client knows what it is looking at (§3.1).
const SPEC_VERSION = 1;

const CANDIDATE_ID_PREFIX = "cand-";
// 16 hex of the digest — the same truncation the capture-nudge convention uses
// for a content-addressed node id. Short enough to read in a log line, wide
// enough that a collision is not a thing that happens to a queue.
const CANDIDATE_ID_HEX = 16;

// A full git object name, in either of git's two object formats. Deliberately
// NOT an abbreviation: a candidate PINS, and a short sha is a prefix query
// whose answer can change as the repository grows.
const OBJECT_NAME_RE = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

// The stage state a run record carries in `impl_state` (§4.1), mirroring
// `gate_state` (WORKERS.md §8): the same durable-resume shape, the same
// "settled is final" rule, and deliberately the same failure posture — an
// unrecognized value RESUMES rather than being read as a verdict.
//
// It lives here, in the pure module, for the reason SETTLED_GATE_STATES lives
// in kernel/gates.js: two layers that never require each other both have to
// agree on the word — the run journal (shell/agent-dispatch-runner.js), which
// refuses to overwrite a settled verdict, and whatever resumes a stage. Two
// copies drifting apart would either strand a stage forever or let a refusal be
// overwritten by a later `candidate`.
const SETTLED_IMPL_STATES = Object.freeze(
  new Set(["candidate", "declined", "exhausted", "escalated", "unroutable", "mismatch"])
);
const UNSETTLED_IMPL_STATES = Object.freeze(new Set(["dispatched", "running", "interrupted"]));

// The per-ATTEMPT outcome (recorded beside the attempt, never a stage state).
// `no-candidate` and `cancelled` are HERE and not in the settled set on
// purpose: each consumes an attempt from the code pool and either re-dispatches
// or exhausts the stage (§4.2 rows I3-I11). An earlier draft of the contract —
// the one the task node still quotes — listed them as settled STATES and also
// said they consumed attempts, which left "what happens after the pool is
// spent" unwritten.
const IMPL_ATTEMPT_OUTCOMES = Object.freeze([
  "pending",
  "candidate",
  "no-candidate",
  "failed",
  "infrastructure",
  "cancelled",
  "declined",
  "candidate-mismatch",
]);

// The two budget pools an attempt can charge (§5.3): the code pool
// (`budget.attempts`) and the shared infrastructure/publish retry pool
// (`retry.attempts`).
const IMPL_POOLS = Object.freeze(["implementation", "retry"]);

// Which step of the pipeline produced this pin (§3.3). The first submission is
// `implementation`; every later re-pin names the fixer whose commit moved HEAD.
const SUBMIT_STAGES = Object.freeze(["implementation", "fix", "rescue", "integration-fix"]);

// The two portable reference kinds (§3.4). A machine-local path is never one of
// them — that is `provenance.cwd`, which is provenance, not a door.
const REFERENCE_KINDS = Object.freeze(["bundle", "branch"]);

// The run-record fields this stage adds. ADDITIVE, per WORKERS.md §8's
// additive-only rule: a record carrying none of them is a legacy run and reads
// as `completion.by: agent`. Named here so the journal's stamp guard and the
// two in-process record writers that must carry them across a whole-record
// write can agree on one list rather than three prefix tests.
const IMPL_FIELD_PREFIX = "impl_";

// The stage's run-record fields that do NOT carry the prefix (§6.5 names them
// beside the `impl_*` family). They are here, in the same list the journal's
// stamp guard reads, so a field the design spells without the prefix is not
// silently dropped by a guard that only knows about the prefix — and so the
// guard stays an ALLOWLIST rather than becoming "anything a caller passes".
//
// `publish_pending` is the publish OWED (§3.4, §6.5): a candidate with a
// `commit` and no `reference.verified_at`. It carries the reason so an operator
// reading `spor runs` sees why a stage is unsettled, and it is cleared by the
// publish that verifies.
const IMPL_STAGE_FIELDS = Object.freeze(new Set(["publish_pending"]));

// Whether a run-record key belongs to the implementation stage's additive
// namespace — the one test the journal's stamp guard makes.
function isImplField(key) {
  return String(key || "").startsWith(IMPL_FIELD_PREFIX) || IMPL_STAGE_FIELDS.has(String(key));
}

// Whether a word is a SETTLED stage verdict. Anything else — an unsettled
// word, an unrecognized one, an empty one — is not, which is the direction that
// resumes rather than inventing a verdict nobody gave.
function implSettled(state) {
  return !!state && SETTLED_IMPL_STATES.has(String(state));
}

// Whether a record's stage should be RESUMED. A record with no `impl_state` at
// all is a LEGACY run, not an unfinished stage: it never had one, so there is
// nothing to resume and it reads as `completion.by: agent`. Everything else
// that is not settled — including a word this client does not recognize,
// written by a newer one — resumes.
function implResumable(state) {
  const s = String(state || "");
  return !!s && !SETTLED_IMPL_STATES.has(s);
}

// The exact bytes the candidate id is the digest of. ONE canonical spelling,
// pulled out of `candidateIdFor` so a test can pin the key without pinning a
// hash implementation, and so the shell and any future reader derive the same
// id from the same three facts.
//
// `sha256(repo, node_id, tree)` and NOTHING else (§3.2) — not the commit, not
// the attempt, not the run. The TREE is the content a gate judges; the commit
// is one of possibly several labels on it. So an amend that changes only the
// message, a retry that re-commits the same files, and a rebase that happens to
// reproduce the same tree all yield the SAME candidate and hit the same
// idempotent facts; a rebase onto a moved trusted ref changes the tree and IS a
// new candidate, correctly, because the merged-in base is content the gates
// have not judged. The item is in the key, so two items with one tree are two
// candidates; the repo is, so one tree in two repos is too.
//
// Each field is followed by a newline (the `task-split-` id convention), so no
// concatenation of one field's value with the next can be read as another
// triple's key.
function candidateKey({ repo, nodeId, tree }) {
  return `${String(repo || "")}\n${String(nodeId || "")}\n${String(tree || "")}\n`;
}

// `cand-` + the first 16 hex of the digest of the key above. `sha256` is
// injected as `(string) => hex` — kernel modules require nothing but their
// siblings, and a hash is the one primitive this vocabulary cannot compute for
// itself.
function candidateIdFor(parts, sha256) {
  if (typeof sha256 !== "function") throw new TypeError("candidateIdFor needs a sha256(string) => hex function");
  const hex = String(sha256(candidateKey(parts)) || "");
  if (!/^[0-9a-f]{32,}$/.test(hex)) throw new TypeError("candidateIdFor's sha256 must return a lowercase hex digest");
  return `${CANDIDATE_ID_PREFIX}${hex.slice(0, CANDIDATE_ID_HEX)}`;
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function str(v) {
  return typeof v === "string" ? v.trim() : "";
}

function intOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

// The canonical spelling of a candidate's changed-path set, hashed into
// `changed_paths_sha256` (§3.1). Git's own `diff --name-only` ORDER is kept —
// re-sorting would make the field disagree with the list a gate matched its
// globs against — and every path is newline-TERMINATED so a trailing-empty
// list and a one-empty-path list cannot hash alike.
function changedPathsKey(paths) {
  return (Array.isArray(paths) ? paths : []).map((p) => `${String(p)}\n`).join("");
}

// Mint the §3.1 object. Everything required is required: a candidate that
// cannot name what it pins is not one, and returning a half-filled object would
// put the burden of that check on every reader.
//
// `clean` is the `require_clean` verdict at submission, computed by the
// producer with the same `git status` read a command gate uses — an UNREADABLE
// status is `false`, never `true` (§3.5, §10.3). It is an input rather than
// something derived here because the read is I/O; the one thing this function
// enforces is that it is a real boolean, so a producer that forgot to compute
// it cannot have `undefined` read as truthy anywhere downstream.
//
// `reference` is `null` at mint: §3.4's "submission is not complete until the
// reference verified" is the publisher's rule, and the publisher
// (task-spor-factory-candidate-portable-reference) stamps the reference and the
// state together. A candidate with a `commit` and no `reference.verified_at` is
// a publish OWED — there is no `publish: none`, so "unpublished" has exactly one
// meaning.
function mintCandidate(input, { sha256 } = {}) {
  const errors = [];
  const i = isPlainObject(input) ? input : {};
  const repo = str(i.repo);
  const nodeId = str(i.node_id || i.nodeId);
  const commit = str(i.commit).toLowerCase();
  const tree = str(i.tree).toLowerCase();
  if (!repo) errors.push("candidate: 'repo' is required — the repo is part of the identity, so one tree in two repos is two candidates");
  if (!nodeId) errors.push("candidate: 'node_id' is required — the item is part of the identity");
  if (!OBJECT_NAME_RE.test(commit)) errors.push(`candidate: 'commit' must be a full git object name — '${commit || "(none)"}' is not one`);
  if (!OBJECT_NAME_RE.test(tree)) errors.push(`candidate: 'tree' must be a full git object name — '${tree || "(none)"}' is not one`);
  if (typeof i.clean !== "boolean") errors.push("candidate: 'clean' must be a boolean — an unreadable git status is false, never absent");

  const rawBase = isPlainObject(i.base) ? i.base : {};
  const base = {
    ref: str(rawBase.ref) || null,
    commit: OBJECT_NAME_RE.test(str(rawBase.commit).toLowerCase()) ? str(rawBase.commit).toLowerCase() : null,
    merge_base: OBJECT_NAME_RE.test(str(rawBase.merge_base || rawBase.mergeBase).toLowerCase())
      ? str(rawBase.merge_base || rawBase.mergeBase).toLowerCase()
      : null,
  };
  // The bundle a publisher writes is `base.merge_base..commit`, so a candidate
  // with no merge base names a range nobody can cut. Refused at the mint rather
  // than at the publish, where the workspace may already be gone.
  if (!base.merge_base) errors.push("candidate: 'base.merge_base' is required — it is the lower bound of the range a bundle is cut from");

  const rawSubmitted = isPlainObject(i.submitted_by || i.submittedBy) ? i.submitted_by || i.submittedBy : {};
  const stage = str(rawSubmitted.stage) || "implementation";
  if (!SUBMIT_STAGES.includes(stage)) errors.push(`candidate: submitted_by.stage '${stage}' must be one of: ${SUBMIT_STAGES.join(", ")}`);
  const submittedBy = {
    stage: SUBMIT_STAGES.includes(stage) ? stage : "implementation",
    cycle: intOr(rawSubmitted.cycle, 0),
    rescue: intOr(rawSubmitted.rescue, 0),
  };

  const rawProv = isPlainObject(i.provenance) ? i.provenance : {};
  const pool = str(rawProv.pool) || null;
  if (pool && !IMPL_POOLS.includes(pool)) errors.push(`candidate: provenance.pool '${pool}' must be one of: ${IMPL_POOLS.join(", ")}`);
  const provenance = {
    run_id: str(rawProv.run_id || rawProv.runId) || null,
    attempt: intOr(rawProv.attempt, 1),
    pool: pool && IMPL_POOLS.includes(pool) ? pool : null,
    harness: str(rawProv.harness) || null,
    profile: str(rawProv.profile) || null,
    agent: str(rawProv.agent) || null,
    worker: str(rawProv.worker) || null,
    machine: str(rawProv.machine) || null,
    // Where the commit was MADE. It is provenance, not a reference: nothing in
    // the pipeline follows it, and a controller on another machine never sees
    // it as a way to obtain the commit (§3.1). `reference` is the only door.
    cwd: str(rawProv.cwd) || null,
    started_at: str(rawProv.started_at || rawProv.startedAt) || null,
    finished_at: str(rawProv.finished_at || rawProv.finishedAt) || null,
  };

  const rawResolver = isPlainObject(i.resolver) ? i.resolver : {};
  const resolver = {
    node: str(rawResolver.node) || null,
    written: !!rawResolver.written,
    // `false` is the whole point under `completion.by: controller`: the
    // implementer wrote its resolver node, and the edge that retires the item
    // is not on it yet. `true` at submission is a PREMATURE resolution (§4.5).
    resolves_edge: !!(rawResolver.resolves_edge ?? rawResolver.resolvesEdge),
  };

  if (errors.length) return { ok: false, candidate: null, errors };

  const candidate = {
    candidate_id: candidateIdFor({ repo, nodeId, tree }, sha256),
    spec_version: SPEC_VERSION,
    repo,
    node_id: nodeId,
    commit,
    tree,
    base,
    branch: str(i.branch) || null,
    // Every OTHER commit seen carrying this same tree — an amend, a same-tree
    // re-commit. The pinned `commit` above never moves (§3.2: first published
    // wins), so this is where a relabel goes.
    commits_seen: [],
    clean: i.clean,
    changed_paths_sha256: Array.isArray(i.changed_paths)
      ? String(sha256(changedPathsKey(i.changed_paths)) || "")
      : str(i.changed_paths_sha256) || null,
    supersedes: str(i.supersedes) || null,
    submitted_by: submittedBy,
    provenance,
    reference: isPlainObject(i.reference) ? i.reference : null,
    resolver,
  };
  return { ok: true, candidate, errors: [] };
}

// The re-pin fold (§3.2, §3.3). HEAD moves after submission — a fix cycle
// commits, a rescue amends, an integration fix commits again — and a candidate
// that stayed pinned to the first commit would be a record of something the
// gates are no longer judging. So every run that commits under the pipeline
// re-pins, and this is what a re-pin MEANS:
//
//   - no prior           → the first submission (`created`);
//   - same candidate id  → the same TREE, so the same judged content: the new
//                          commit is appended to `commits_seen` and NOTHING
//                          else changes — not `commit`, not `reference`, not
//                          the published object (`seen`). This is what lets the
//                          published object be keyed by `candidate_id` AND
//                          immutable without contradiction;
//   - different id       → new content, so a NEW candidate carrying
//                          `supersedes: <prior id>` (`superseded`).
//
// Never mutates `prior`: a candidate is superseded, never mutated, and the
// caller may still be holding the ancestor for a fact that names it.
function repinCandidate(prior, next) {
  if (!isPlainObject(next)) return { candidate: prior || null, change: "unchanged" };
  if (!isPlainObject(prior)) return { candidate: next, change: "created" };
  if (prior.candidate_id !== next.candidate_id) {
    return { candidate: { ...next, supersedes: prior.candidate_id }, change: "superseded" };
  }
  const seen = Array.isArray(prior.commits_seen) ? prior.commits_seen : [];
  if (!next.commit || next.commit === prior.commit || seen.includes(next.commit)) {
    return { candidate: prior, change: "unchanged" };
  }
  return { candidate: { ...prior, commits_seen: [...seen, next.commit] }, change: "seen" };
}

// The chain the run record carries beside the tip (§3.3, `impl_candidates`):
// the pin EVENTS in order, oldest first, and **the tip is always the last
// entry**. A re-pin that only grew `commits_seen` updates its own entry in
// place (same id as the current tip, richer object) rather than appending a
// near-duplicate; anything else is appended.
//
// The match is against the LAST entry only, never a search of the whole list.
// A tree can legitimately come BACK — a fix cycle that reverts a one-hunk
// change reproduces the earlier tree exactly, and by §3.2 that is the same
// candidate id — and replacing the earlier ENTRY with the new one would
// destroy the ancestor's own `supersedes`, `submitted_by` and provenance (the
// record of who first produced that tree, which an `art-gate-*` fact may
// already name), put the tip somewhere other than the end, and leave two
// entries pointing `supersedes` at each other so a reader walking the chain
// back to the first submission never terminates. Appending instead keeps every
// one of those true: the same id may appear twice, which is the honest reading
// — the tree was pinned, superseded, and pinned again.
function appendCandidateChain(chain, candidate) {
  const list = Array.isArray(chain) ? chain.slice() : [];
  if (!isPlainObject(candidate) || !candidate.candidate_id) return list;
  const tip = list.length ? list[list.length - 1] : null;
  if (tip && tip.candidate_id === candidate.candidate_id) list[list.length - 1] = candidate;
  else list.push(candidate);
  return list;
}

// What is REFUSED as a reference (§3.4), checked by the producer at submission
// and again by every reader before a fetch. Returns the reason a reference is
// not portable, or `null` when it is well-formed.
//
// PORTABLE means exactly: self-describing, content-verified, and obtainable by
// any reader that can reach the store the locator names — never dependent on
// the producing process, its working tree, or its machine being alive. So a
// working tree and a repository's object store are not stores: they are alive
// only while the process that made them is.
//
// This is the SHAPE half only. The fetch-and-verify half — `rev-parse
// <commit>^{tree}` equals `tree`, and `commit` equals `reference.commit` — is
// mandatory and mechanical, and belongs to whoever can run git
// (task-spor-factory-candidate-portable-reference).
function referenceRefusal(reference, { bundleStore = null, cwd = null } = {}) {
  if (!isPlainObject(reference)) return "a candidate reference must be an object";
  const kind = str(reference.kind);
  if (!REFERENCE_KINDS.includes(kind)) return `reference.kind '${kind || "(none)"}' must be one of: ${REFERENCE_KINDS.join(", ")}`;
  const locator = str(reference.locator);
  if (!locator) return "reference.locator is required — it is the ONE absolute URI a reader fetches";
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(locator);
  if (!scheme) {
    // A remote NAME where a URL is required, a bare sha, a relative path: each
    // is a thing only this machine can resolve, and each is named rather than
    // lumped in, since the producer can publish correctly on the retry.
    if (OBJECT_NAME_RE.test(locator.toLowerCase())) return "reference.locator is a bare commit sha, not a locator — a reader cannot fetch a sha";
    if (/^[.~/]/.test(locator)) return `reference.locator '${locator}' is a filesystem path, not an absolute URI — a path is not reachable from another machine`;
    return `reference.locator '${locator}' is not an absolute URI — a remote name resolves only on the machine that declared it`;
  }
  const proto = scheme[1].toLowerCase();
  // `ssh://` is reachable ONLY for a `branch` reference — it is the resolved
  // URL of a git remote (§3.4), and a remote is the one door a `bundle`
  // reference never uses (a bundle's locator is always the declared/default
  // bundle_store, which is `file://`/`https://` only — see
  // resolveBundleStore in shell/candidate-publish.js). Admitting it
  // unconditionally would let a bundle reference claim a scheme its own store
  // can never produce.
  const reachable = proto === "file" || proto === "https" || (proto === "ssh" && kind === "branch");
  if (!reachable) return `reference.locator '${proto}://' is not a reachable scheme — a candidate is fetched over file://, https://, or (for a branch reference) ssh://`;
  if (!OBJECT_NAME_RE.test(str(reference.commit).toLowerCase())) return "reference.commit must be the full pinned commit — it is what a reader verifies the fetch against";
  if (proto === "file") {
    // A `file://` locator must resolve UNDER the declared or default bundle
    // store. In particular one under the producer's own working tree or inside
    // a `.git` directory is refused: those are alive only while the process
    // that made them is. And a locator that has to be RESOLVED before you know
    // where it points is not self-describing, so a relative segment is refused
    // outright rather than normalized — this check also runs in READERS
    // validating a candidate object they did not mint, which is exactly where a
    // traversal locator would matter.
    //
    // BOTH tests run over the same SEPARATOR- AND DOT-FOLDED copy, and that is
    // load-bearing (issue-spor-candidate-reference-percent-encoding-bypass):
    // `\` is a path separator for special schemes in the WHATWG URL spec on
    // every platform, not just Windows, so `file:///store/..\..\etc/x` resolves
    // to `file:///etc/x` while string-starting with `file:///store/`; and a
    // fetcher that percent-decodes before resolving sees segments a raw test
    // never gets to look at, so `file:///store/%2egit/objects` reaches exactly
    // the object store the `.git` rule exists to refuse. Running one of the two
    // tests on the RAW string and the other on the decoded one left the first
    // of those open — decode ONCE, then judge every segment on the decoded form.
    const decoded = locator
      .replace(/%2f/gi, "/")
      .replace(/%5c/gi, "\\")
      .replace(/%2e/gi, ".")
      .replace(/\\/g, "/");
    if (/(^|\/)\.git(\/|$)/.test(decoded)) return `reference.locator '${locator}' points inside a .git directory — a repository's object store is not a store a reader can reach`;
    if (/(^|\/)\.\.?(\/|$)/.test(decoded)) {
      return `reference.locator '${locator}' carries a relative path segment — a locator must name where it points, not need resolving to find out`;
    }
    // Both prefix tests compare against a SLASH-terminated prefix: a sibling
    // directory whose name merely starts with the same characters
    // (`/w/run-10` beside `/w/run-1`) is a different place, and reading it as
    // the same one would refuse a perfectly good reference — or, for the store,
    // accept one nobody was told to look in.
    // Duplicate slashes are collapsed on both sides first (`file:///store//x`
    // and `file:///store/x` are the same place), after the scheme's own `//`.
    // Both sides are normalized the same way before the prefix comparisons:
    // duplicate slashes collapsed (`file:///store//x` and `file:///store/x` are
    // the same place) and the SCHEME lowercased, since a scheme is
    // case-insensitive and `FILE:///store/x` under a `file://` store points
    // exactly where the store says. The path is left alone — it is
    // case-sensitive on the filesystems that matter.
    const flat = (u) => {
      const m = /^([a-z][a-z0-9+.-]*:\/\/)(.*)$/i.exec(String(u));
      // A scheme-less string never reaches here (the scheme was parsed above),
      // but be total anyway: collapse the whole thing rather than throw.
      return m ? `${m[1].toLowerCase()}${m[2].replace(/\/{2,}/g, "/")}` : String(u).replace(/\/{2,}/g, "/");
    };
    const here = flat(locator);
    // The cwd is a filesystem PATH, not a URI, and it is compared against a
    // locator that is one. On Windows that path is `C:\repo`, whose file URL is
    // `file:///C:/repo` — so pasting it in raw produced `file://C:\repo/`, which
    // matches nothing and silently disarmed this guard on the one platform
    // where it was silently disarmed. Separators are folded and a drive letter
    // is given the leading slash a file URL has, in pure string terms (the
    // kernel requires no builtins).
    const cwdUrl = `file://${String(cwd).replace(/\\/g, "/").replace(/^([a-zA-Z]:)/, "/$1")}`;
    if (cwd && here.startsWith(flat(cwdUrl.endsWith("/") ? cwdUrl : `${cwdUrl}/`))) {
      return `reference.locator '${locator}' points inside the producing run's own working tree, which is gone as soon as the run is`;
    }
    const store = str(bundleStore);
    if (store && !here.startsWith(flat(store.endsWith("/") ? store : `${store}/`))) {
      return `reference.locator '${locator}' does not resolve under the declared bundle store '${store}'`;
    }
  }
  if (kind === "bundle" && !str(reference.key)) return "a bundle reference needs the object 'key' inside its store";
  if (kind === "branch" && !str(reference.ref)) return "a branch reference needs the 'ref' it was pushed to";
  return null;
}

// Whether a candidate is SUBMITTED (§3.4). Submission is not complete until
// the reference verified: a candidate no reader could obtain is not a
// candidate, in either mode, so a pinned commit with no `reference.verified_at`
// is a publish OWED rather than a settled stage. There is no `publish: none`,
// which is what gives "unpublished" exactly one meaning.
//
// This is the one predicate that decides whether the stage settles
// `impl_state: candidate` or stays unsettled with the publish owed, so the
// publisher (task-spor-factory-candidate-portable-reference) has exactly one
// call site to satisfy rather than a rule restated at each of them.
function candidateSubmitted(candidate) {
  return !!(isPlainObject(candidate) && isPlainObject(candidate.reference) && str(candidate.reference.verified_at));
}

// A candidate's one-line reading, for `spor runs` and `spor work --status`. The
// TREE leads because it is the identity; the commit is what a person cites and
// what git fetches. `unpublished` is stated rather than omitted — a candidate
// no reader could obtain is not yet a submission (§3.4).
function candidateSummary(candidate) {
  if (!isPlainObject(candidate)) return "";
  const c = candidate;
  const short = (s) => String(s || "").slice(0, 12) || "?";
  const where = isPlainObject(c.reference) && c.reference.verified_at ? String(c.reference.kind || "published") : "unpublished";
  return (
    `${c.candidate_id || "cand-?"}  tree ${short(c.tree)}  commit ${short(c.commit)}` +
    `${c.branch ? ` on ${c.branch}` : ""}  ${where}` +
    `${c.clean === false ? "  (tree not clean)" : ""}` +
    `${c.supersedes ? `  supersedes ${c.supersedes}` : ""}`
  );
}

module.exports = {
  SPEC_VERSION,
  CANDIDATE_ID_PREFIX,
  CANDIDATE_ID_HEX,
  SETTLED_IMPL_STATES,
  UNSETTLED_IMPL_STATES,
  IMPL_ATTEMPT_OUTCOMES,
  IMPL_POOLS,
  SUBMIT_STAGES,
  REFERENCE_KINDS,
  IMPL_FIELD_PREFIX,
  IMPL_STAGE_FIELDS,
  isImplField,
  implSettled,
  implResumable,
  candidateKey,
  candidateIdFor,
  changedPathsKey,
  mintCandidate,
  repinCandidate,
  appendCandidateChain,
  referenceRefusal,
  candidateSubmitted,
  candidateSummary,
};

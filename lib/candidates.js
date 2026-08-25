// candidates.js — the packaged candidate schema pack
// (task-spor-resident-schema-adoption-upgrade-path). Rollout-stage schemas
// that ship WITH the npm package but deliberately NOT in the seed registry:
// a candidate is inert until a graph adopts it as a graph-resident schema
// node (`spor schema adopt`), preserving the propose→activate flow that a
// seed schema — active everywhere, instantly, with no opt-in — would bypass.
// The distribution gap this closes: before this pack, a product schema rolled
// out graph-resident (e.g. schema-edge-member-of-program) had no delivery
// channel to local-mode graphs or fresh tenants at all, and an adopted copy
// had no upgrade channel when the package revved it (the stale-shadow class,
// issue-cc-schema-override-seed-shadow).
//
// Placement: lib/seed/candidates/*.md. shell.readGraphFiles() is
// non-recursive, so the seed loader never sees the subdir — candidates stay
// out of seedRegistry()/buildRegistry() with zero loader changes, and a graph
// that never adopts is byte-identical.
//
// Provenance stamps: `spor schema adopt` writes `adopted_from: spor@<pkg
// version>` and `adopted_sha: <canonical hash of the candidate>` onto the
// resident copy. The canonical hash covers schema_version + body ONLY — the
// registry-meaningful content (the fenced JSON payload and attached code live
// in the body) — never the rest of the frontmatter, which the server rewrites
// with attribution stamps (author/session/authored_via) on every write. On
// upgrade, a resident whose recomputed canonical hash still equals its
// adopted_sha is a pristine copy of the old candidate and updates in place;
// a mismatch (or a hand-copied resident with no stamp) is local divergence
// and refuses without --force.
//
// Lifecycle terminus: when a candidate stabilizes it moves candidates/ ->
// seed/ at a release (CalVer bump); the stamped resident copy then shadows
// the seed (validateGraph's stale-override warning) and candidateState
// reports superseded-by-seed with the retire instruction (flip the resident
// to status: retired — the schema-issue retirement precedent).
//
// Zero deps (node builtins only); the client parses candidate schema code for
// display but never executes it — adopt writes text through the validated
// node surface.

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SEED_DIR = path.join(__dirname, "seed");
const CANDIDATES_DIR = path.join(SEED_DIR, "candidates");

// The canonical hash of a schema node for adoption provenance: schema_version
// + trimmed body (parseFrontmatter already normalizes \r\n and trims), first
// 16 hex chars. Frontmatter beyond schema_version is deliberately excluded —
// see the header comment.
function canonicalSha(node) {
  return crypto
    .createHash("sha256")
    .update(`${node.schema_version || ""}\n${(node.body || "").trim()}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}

// Parse the packaged candidates dir. Candidates ship with the repo, so a file
// that fails to parse is a bug — throw loudly (mirrors parseSeedSchemas).
// An absent dir is a build with no candidates: [].
function loadCandidates() {
  const graphLib = require(path.join(__dirname, "graph.js"));
  const registry = require(path.join(__dirname, "kernel", "registry.js"));
  let files;
  try {
    files = fs.readdirSync(CANDIDATES_DIR).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(CANDIDATES_DIR, f), "utf8");
    const node = graphLib.parseFrontmatter(raw, f);
    const r = registry.parseSchemaNode(node);
    if (!r.ok) throw new Error(`candidate schema ${f}: ${r.errors.join("; ")}`);
    if (node.status) throw new Error(`candidate schema ${f}: candidates ship without a status line (adopt sets it)`);
    out.push({
      id: node.id,
      file: f,
      raw,
      node,
      version: node.schema_version,
      kind: node.kind,
      // What the registry would index this schema under (payload.node_type /
      // payload.edge_type / register name / …) — the footer's presence probe.
      declaredType: r.schema.key,
      sha: canonicalSha(node),
      inSeed: fs.existsSync(path.join(SEED_DIR, `${node.id}.md`)),
    });
  }
  return out;
}

// Classify a candidate against the resident copy in a graph (a parsed node,
// or null when the graph has none). States:
//   superseded-by-seed  the candidate was promoted to the seed pack — the
//                       registry already has it; retire the resident copy
//   not-adopted         no resident copy
//   current             resident schema_version >= candidate (idempotent no-op;
//                       local customization on a current copy is the graph's
//                       own business, not drift)
//   outdated            candidate is newer and the resident is a pristine copy
//                       of the old candidate (recomputed hash == adopted_sha)
//   diverged            candidate is newer but the resident was locally
//                       modified since adoption — upgrade needs --force
//   unstamped           candidate is newer and the resident carries no
//                       adoption stamp (hand-copied) — adopt needs --force
function candidateState(cand, resident) {
  const registry = require(path.join(__dirname, "kernel", "registry.js"));
  const base = resident
    ? { resident_version: resident.schema_version || null, resident_status: resident.status || null }
    : {};
  if (cand.inSeed) return { ...base, state: "superseded-by-seed" };
  if (!resident) return { state: "not-adopted" };
  const rv = registry.parseCalVer(resident.schema_version);
  // Candidate CalVer is gated at load; an unparseable RESIDENT version can
  // never rank as current, so it falls through to the stamp check below.
  if (rv && registry.compareCalVer(rv, cand.version) >= 0) return { ...base, state: "current" };
  if (!resident.adopted_sha) return { ...base, state: "unstamped" };
  return { ...base, state: canonicalSha(resident) === resident.adopted_sha ? "outdated" : "diverged" };
}

// The resident markdown an adopt/upgrade writes: the candidate's frontmatter
// with status + provenance stamps appended, and the candidate's body verbatim.
// Only top-level status/stamp lines are stripped first (candidates ship
// without them; defensive for --force re-adoption round-trips).
function adoptMarkdown(cand, { status, pkgVersion }) {
  const m = cand.raw.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error(`candidate ${cand.file}: no frontmatter`);
  const fm = m[1].split("\n").filter((l) => !/^(status|adopted_from|adopted_sha):/.test(l));
  fm.push(`status: ${status}`);
  fm.push(`adopted_from: spor@${pkgVersion}`);
  fm.push(`adopted_sha: ${cand.sha}`);
  return `---\n${fm.join("\n")}\n---\n\n${m[2].replace(/^\n+/, "")}`;
}

// One human line for a candidate's state (shared by `spor schema candidates`
// and the doctor section).
function stateLine(cand, st) {
  switch (st.state) {
    case "superseded-by-seed":
      return st.resident_version
        ? `now ships in the seed pack — retire the resident copy (status: retired)`
        : `now ships in the seed pack — nothing to adopt`;
    case "not-adopted":
      return `not adopted — adopt with: spor schema adopt ${cand.id}`;
    case "current":
      return `adopted @ ${st.resident_version}${st.resident_status ? ` (status: ${st.resident_status})` : ""} — current`;
    case "outdated":
      return `adopted @ ${st.resident_version}, package has ${cand.version} — upgrade with: spor schema adopt ${cand.id}`;
    case "diverged":
      return `adopted @ ${st.resident_version} but locally modified since adoption — upgrade needs --force`;
    case "unstamped":
      return `resident copy has no adoption stamp (hand-copied?) — adopting over it needs --force`;
    default:
      return st.state;
  }
}

// The one-line `spor schema` overview footer: candidates whose declared type
// is absent from the registry snapshot. A cheap presence probe (no per-node
// reads), so a proposed-but-inert resident still counts as "not in this
// registry" — which is accurate: the registry doesn't have it. Only kinds the
// snapshot lists by type are probed.
function footerLine(candidates, snap) {
  const types = new Set(
    [...(snap.node_types || []), ...(snap.edge_types || [])].map((x) => x.type)
  );
  const missing = candidates.filter(
    (c) => !c.inSeed && (c.kind === "node-schema" || c.kind === "edge-schema") && !types.has(c.declaredType)
  );
  if (!missing.length) return null;
  const n = missing.length;
  return `${n} candidate schema${n === 1 ? "" : "s"} ship${n === 1 ? "s" : ""} with this package but ${n === 1 ? "is" : "are"} not in this registry — see: spor schema candidates`;
}

module.exports = { CANDIDATES_DIR, canonicalSha, loadCandidates, candidateState, adoptMarkdown, stateLine, footerLine };

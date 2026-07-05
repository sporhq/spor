"use strict";
// check.js — the coupling-drift checker behind `spor check`
// (task-spor-cli-check-coupling-verb, dec-spor-coupling-norms-declared-first):
// the boundary-time half of the coupling norms the post-tool nudge serves at
// edit time. Given a change set (repo-relative paths) and the graph's coupling
// norms, report each norm whose trigger set (`couples_when`) is touched while
// its target set (`couples_also`) is not — plus, for norms carrying a VALUE
// invariant (`couples_value_a`/`couples_value_b`), whether the two extracted
// values actually agree ("these two now disagree" beats "you probably
// forgot"). Pure over injected inputs — the CLI resolves git, mode, and norm
// loading; this module never touches the network.

const coupling = require("./kernel/coupling.js");

const arr = (v) => (Array.isArray(v) ? v : []);

// Does any changed path satisfy one couples_also target entry (same-repo view)?
function targetTouched(glob, changed) {
  const re = coupling.globToRegExp(glob);
  return changed.some((p) => re.test(p));
}

// Check one norm's value invariant against the change. Returns null when the
// norm declares none, else:
//   { checked: true,  agree, a: {file, value}, b: {file, value} }
//   { checked: false, reason: "cross-repo" | "malformed" | "unreadable", ... }
// `readFile(relPath)` returns file content or null (the CLI wires it to the
// working tree, or `git show <rev>:<path>` for --range).
function checkValueInvariant(norm, { slug, readFile }) {
  if (norm.couples_value_a == null && norm.couples_value_b == null) return null;
  const specA = coupling.parseValueSpec(norm.couples_value_a);
  const specB = coupling.parseValueSpec(norm.couples_value_b);
  if (!specA || !specB) return { checked: false, reason: "malformed" };
  for (const s of [specA, specB]) {
    if (s.repo !== null && !coupling.repoMatches(s.repo, slug)) {
      return { checked: false, reason: "cross-repo", file: `${s.repo}:${s.file}` };
    }
  }
  const contentA = readFile(specA.file);
  const contentB = readFile(specB.file);
  if (contentA == null || contentB == null) {
    return { checked: false, reason: "unreadable", file: contentA == null ? specA.file : specB.file };
  }
  const a = coupling.extractValue(contentA, specA.pattern);
  const b = coupling.extractValue(contentB, specB.pattern);
  if (a == null || b == null) {
    return { checked: false, reason: "unreadable", file: a == null ? specA.file : specB.file, pattern_miss: true };
  }
  return { checked: true, agree: a === b, a: { file: specA.file, value: a }, b: { file: specB.file, value: b } };
}

// The check. Inputs:
//   slug      — this repo's project slug (scopes the norms, resolves qualifiers)
//   changed   — repo-relative forward-slash paths of the change set
//   norms     — coupling norms (scanCouplingEntries output)
//   repoTags  — this repo's `tags:` (feeds applies_to_tags scope)
//   readFile  — (relPath) -> content|null, for value invariants
// Returns { checked, findings, reminders }: `checked` counts the norms whose
// trigger set was evaluated against this change; findings are, per norm, one of
//   kind "untouched"          — triggers hit, same-repo targets untouched
//   kind "value-disagreement" — the declared invariant's two values differ
//   kind "value-unverifiable" — triggers hit but the invariant could not be
//                               read/parsed here (carries the untouched list)
// A norm whose invariant CHECKS and AGREES emits nothing even when target
// globs look untouched — the machine-checkable truth beats the heuristic
// (e.g. the Dockerfile already carried the right version).
// `reminders` are triggered norms whose OTHER-REPO targets can't be verified
// by this diff — surfaced as information, never findings (else every
// cross-repo coupling would fail --strict unconditionally); a norm appears
// there only when it produced no finding (a finding already carries its
// cross_repo list).
function runCheck({ slug, changed, norms, repoTags = [], readFile = () => null }) {
  const findings = [];
  const reminders = [];
  let checkedCount = 0;
  for (const norm of arr(norms)) {
    if (!coupling.isCouplingNorm(norm)) continue;
    checkedCount++;
    const ctx = { slug, repoTags };
    const triggered = arr(changed).filter((p) => coupling.couplingHit(norm, { ...ctx, relPath: p }));
    const invariant = checkValueInvariant(norm, { slug, readFile });
    // The invariant also arms on a change to either of its own files, so a
    // target edited to the WRONG value is caught even when the norm's glob
    // targets were all touched.
    const invariantFiles = [norm.couples_value_a, norm.couples_value_b]
      .map((s) => coupling.parseValueSpec(s))
      .filter((s) => s && (s.repo === null || coupling.repoMatches(s.repo, slug)))
      .map((s) => s.file);
    const invariantArmed = triggered.length > 0 || arr(changed).some((p) => invariantFiles.includes(p));
    if (!triggered.length && !(invariant && invariantArmed)) continue;

    // Partition targets: same-repo ones are checkable against this diff;
    // other-repo ones can only be surfaced as reminders.
    const untouched = [];
    const crossRepo = [];
    for (const entry of arr(norm.couples_also)) {
      const { repo, glob } = coupling.parseEntry(entry);
      if (repo !== null && !coupling.repoMatches(repo, slug)) {
        crossRepo.push(entry);
        continue;
      }
      if (!targetTouched(glob, arr(changed))) untouched.push(entry);
    }

    const base = { norm: norm.id, title: norm.title ?? null, triggered, cross_repo: crossRepo };
    const before = findings.length;
    if (invariant && invariantArmed) {
      if (invariant.checked) {
        if (!invariant.agree) {
          findings.push({ kind: "value-disagreement", ...base, untouched, a: invariant.a, b: invariant.b });
        }
        // agree -> the invariant is authoritative; no untouched finding.
      } else if (triggered.length && untouched.length) {
        findings.push({ kind: "value-unverifiable", ...base, untouched, reason: invariant.reason, file: invariant.file ?? null });
      }
    } else if (triggered.length && untouched.length) {
      findings.push({ kind: "untouched", ...base, untouched });
    }
    if (findings.length === before && triggered.length && crossRepo.length) {
      reminders.push({ norm: norm.id, title: norm.title ?? null, triggered, cross_repo: crossRepo });
    }
  }
  return { checked: checkedCount, findings, reminders };
}

// The human report. One block per finding; the summary line always prints so
// a clean run is visibly a run, not a silent no-op. Cross-repo reminders
// render after the findings, informational only.
function renderReport({ slug, changed, checked, findings, reminders = [] }, { strict = false } = {}) {
  const lines = [];
  const n = findings.length;
  lines.push(
    `spor check: ${n === 0 ? "ok" : `${n} finding${n === 1 ? "" : "s"}`} (${changed.length} changed file${changed.length === 1 ? "" : "s"}, ${checked} coupling norm${checked === 1 ? "" : "s"}, project ${slug})`
  );
  for (const f of findings) {
    lines.push("");
    lines.push(`${f.norm}${f.title ? ` — ${f.title}` : ""}`);
    if (f.triggered.length) lines.push(`  triggered by: ${f.triggered.join(", ")}`);
    if (f.kind === "value-disagreement") {
      lines.push(`  value disagreement: ${f.a.file} (${f.a.value}) != ${f.b.file} (${f.b.value})`);
    }
    if (f.untouched && f.untouched.length && f.kind !== "value-disagreement") {
      lines.push(`  untouched: ${f.untouched.join(", ")}`);
    }
    if (f.kind === "value-unverifiable") {
      lines.push(`  value invariant not verifiable here (${f.reason}${f.file ? `: ${f.file}` : ""})`);
    }
    if (f.cross_repo && f.cross_repo.length) {
      lines.push(`  other-repo targets (verify there): ${f.cross_repo.join(", ")}`);
    }
  }
  for (const r of reminders) {
    lines.push("");
    lines.push(`${r.norm}${r.title ? ` — ${r.title}` : ""} (reminder)`);
    if (r.triggered.length) lines.push(`  triggered by: ${r.triggered.join(", ")}`);
    lines.push(`  other-repo targets (verify there): ${r.cross_repo.join(", ")}`);
  }
  if (n > 0 && !strict) lines.push("", "(advisory — exit 0; run with --strict to fail on findings)");
  return lines.join("\n");
}

module.exports = { runCheck, renderReport, checkValueInvariant };

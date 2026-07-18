"use strict";
// Infer commit→node links for UNTRAILERED commits (task-cc-commit-inference)
// and route confident proposals through the capture path — never a direct
// stamp. Node port of infer-commits.sh: OFF unless SPOR_INFER_COMMITS=1
// (legacy SUBSTRATE_INFER_COMMITS still read),
// remote mode only, evidence scored by lib/commit-inference.js (spawned with
// the same JSON stdin contract), fail-open.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const u = require("./util");

async function inferCommits({ repo, journal, indexFile = "", index = "", slug = "project", session = "unknown" }) {
  // Off by default; SPOR_INFER_COMMITS=1 (env) or inferCommits.enabled:true
  // (config) turns it on. No active config falls back to the exact env read.
  if (u.config() ? !u.config().getBool("inferCommits.enabled", false) : (u.envDual("INFER_COMMITS") ?? "0") !== "1") return;
  if (!u.serverBase()) return;
  if (!repo || !journal || !fs.existsSync(journal)) return;
  const top = u.git(repo, ["rev-parse", "--show-toplevel"])?.trim();
  if (!top) return;

  const graph = u.graphHome();
  u.ensureDir(path.join(graph, "journal"));
  const rlog = u.makeLogger(path.join(graph, "journal", "remote.log"), `infer-commits ${slug}: `);
  const lib = path.join(u.ROOT, "lib", "commit-inference.js");
  if (!fs.existsSync(lib)) {
    rlog(`missing ${lib}`);
    return;
  }

  // Candidate nodes from the graph index ("id — title" lines), capped at 200.
  let indexText = index;
  if (!indexText && indexFile) {
    try {
      indexText = fs.readFileSync(indexFile, "utf8");
    } catch {}
  }
  const candidates = (indexText || "")
    .split("\n")
    .slice(0, 200)
    .map((line) => line.match(/^([a-z0-9][a-z0-9-]*) — (.*)$/))
    .filter(Boolean)
    .map((m) => ({ id: m[1], title: m[2] }));
  if (candidates.length === 0) {
    rlog("no candidates from index");
    return;
  }

  const branch = u.git(top, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim() || "";

  // Untrailered commits this session journaled: tool=git-commit, empty nodes.
  let shas = [];
  try {
    shas = fs
      .readFileSync(journal, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          const o = JSON.parse(l);
          return o.tool === "git-commit" && (o.nodes ?? []).length === 0 ? o.sha : null;
        } catch {
          return null;
        }
      })
      .filter((s) => s && /^[0-9a-f]{7,40}$/.test(s));
    shas = [...new Set(shas)].sort();
  } catch {}
  if (shas.length === 0) {
    rlog("no untrailered commits journaled");
    return;
  }

  let posted = 0;
  for (const sha of shas) {
    const subject = u.git(top, ["show", "-s", "--format=%s", sha])?.trim() ?? "";
    const files = (u.git(top, ["show", "--name-only", "--format=", sha]) || "")
      .split("\n")
      .filter(Boolean)
      .slice(0, 50);
    const commit = { sha, repo: slug, branch, message: subject, files };

    const r = spawnSync(process.execPath, [lib], {
      input: JSON.stringify({ commit, candidates }),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.status !== 0 || r.error) {
      rlog(`scorer failed for ${sha.slice(0, 12)}`);
      continue;
    }
    let proposals = [];
    try {
      proposals = JSON.parse(r.stdout).proposals ?? [];
    } catch {}
    if (proposals.length < 1) continue;

    for (const p of proposals) {
      const ev = p?.evidence;
      if (!ev) continue;
      const body = JSON.stringify({ text: ev, context: { project: slug, project_explicit: false }, source: "infer" });
      const { http } = await u.curl(`${u.serverBase()}/v1/capture`, {
        method: "POST",
        headers: { ...u.bearer(), "Content-Type": "application/json" },
        body,
        timeoutMs: 90000,
      });
      rlog(`proposed ${sha.slice(0, 12)} -> capture http=${http}`);
    }
    posted++;
  }
  rlog(`inference complete (${posted} untrailered commit(s) scored)`);
}

module.exports = { inferCommits };

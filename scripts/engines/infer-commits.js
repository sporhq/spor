"use strict";
// Infer commit→node links for UNTRAILERED commits (task-cc-commit-inference)
// and route confident proposals through the capture path — never a direct
// stamp. Node port of infer-commits.sh: OFF unless SPOR_INFER_COMMITS=1
// (legacy SUBSTRATE_INFER_COMMITS still read),
// remote mode only, evidence scored by lib/commit-inference.js (spawned with
// the same JSON stdin contract), fail-open.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const u = require("./util");
const capturePartial = require(path.join(u.ROOT, "lib", "shell", "capture-partial.js"));

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
      // Keyed on what the proposal IS (repo, commit, evidence), so a re-run
      // over the same journal — or a capture that timed out client-side but
      // landed — replays the server's pinned answer instead of filing the
      // link proposal twice (the same content-addressed rule distill uses).
      const key = crypto.createHash("sha256").update(`infer\n${slug}\n${sha}\n${ev}`).digest("hex");
      const body = JSON.stringify({ text: ev, context: { project: slug, project_explicit: false }, source: "infer", idempotency_key: key });
      const res = await u.curlWithRefresh(`${u.serverBase()}/v1/capture`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        timeoutMs: 90000,
      });
      rlog(`proposed ${sha.slice(0, 12)} -> capture http=${res.http}`);
      // A FINAL partial_unsaved hands its deferred drafts back: re-submit them
      // as node writes (task-spor-client-capture-partial-unsaved-handling).
      // A 200 marked partial names what landed, what did not, and the
      // capture-pending node holding the rest.
      const outcome = u.captureOutcome(res);
      if (outcome.partial) rlog(`proposed ${sha.slice(0, 12)}: ${capturePartial.describePartialCapture(outcome.partial)}`);
      // Anything that did not land is handed to the outbox under a name
      // derived from the key: a TRANSIENT failure (transport, 429, 5xx) is
      // spooled for the drain to re-send — the key makes that replay safe, so
      // even a 5xx the server marked non-replayable answers its pinned reply
      // rather than filing twice — and a PERMANENT one (API.md §5) is
      // dead-lettered for inspection, never dropped.
      const stem = `infer-${sha.slice(0, 12)}-${key.slice(0, 12)}`;
      const spoolName = `${stem}.capture.json`;
      const kind = u.classifyHttpFailure(res.http);
      let handoff = null;
      if (outcome.unsaved) {
        const { durable } = await u.settlePartialUnsaved(graph, outcome.unsaved, { stem, log: (m) => rlog(`proposed ${sha.slice(0, 12)}: ${m}`) });
        // Only if its drafts reached neither the server nor disk: a keyed
        // replay of the capture answers the same drafts again.
        if (!durable) handoff = "spool";
      } else if (u.isPermanentHttpFailure(kind)) handoff = "dead";
      else if (kind !== "ok") handoff = "spool";
      if (handoff === "spool") {
        let spooled = false;
        if (u.ensureDir(path.join(graph, "outbox"))) {
          try {
            u.writeSpoolFile(path.join(graph, "outbox", spoolName), body);
            spooled = true;
          } catch {}
        }
        rlog(`proposed ${sha.slice(0, 12)}: ${spooled ? `spooled to outbox/${spoolName} (http=${res.http})` : `outbox write failed (http=${res.http}); proposal dropped`}`);
      } else if (handoff === "dead") {
        let dead = null;
        if (u.ensureDir(path.join(graph, "outbox", "dead"))) {
          try {
            dead = path.basename(u.deadLetterFile(path.join(graph, "outbox", "dead"), spoolName, { data: body }));
          } catch {}
        }
        rlog(`proposed ${sha.slice(0, 12)}: capture rejected (http=${res.http})${dead ? `; dead-lettered to outbox/dead/${dead}` : "; dead-letter write failed"}`);
      }
    }
    posted++;
  }
  rlog(`inference complete (${posted} untrailered commit(s) scored)`);
}

module.exports = { inferCommits };

"use strict";
// `spor-hook doctor` — the client health surface
// (task-cc-client-hook-operability-diagnostics piece 3). The fail-open hook
// machinery (outbox spooling, dead-letter queue, cached briefings) makes
// degradation invisible: a crashing engine and a quiet success look identical
// (piece 1), and dead-lettered captures pile up unseen in outbox/dead/ (piece
// 2's nudge points here). doctor is the one command that makes the whole client
// health surface legible in one shot — server reachability, token validity,
// outbox / dead-letter depth with the oldest file's age, cached-briefing
// freshness, and the trailing error lines from journal/remote.log and
// journal/distill.log. Read-only and fail-soft: it never writes, never throws,
// and reports what it cannot determine rather than crashing. Returns the report
// as a string; the dispatcher prints it. Reads settings through the active
// config cascade the dispatcher sets, falling back to env when none is active.

const fs = require("fs");
const path = require("path");
const u = require("./util");

// "Nd Nh ago" / "Nh Nm ago" / "Nm ago" / "Ns ago" from an epoch-ms instant.
// null/NaN -> "unknown"; a future instant (clock skew) -> "just now".
function fmtAge(ms) {
  if (ms == null || !Number.isFinite(ms)) return "unknown";
  const delta = Date.now() - ms;
  if (delta < 0) return "just now";
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ago`;
}

// Last `n` error-ish lines of a log file. Returns:
//   null  -> the log doesn't exist yet (nothing has run)
//   []    -> log present, no error lines (healthy)
//   [...] -> the trailing error lines
// The journals interleave success ("briefing ok", "drained X", "0 rejected")
// with failure; the pattern matches only failure shapes so the report shows
// signal, not history. It is anchored to the actual log phrasings (e.g.
// "rejected (http" — never the success line's bare "0 rejected)").
const ERR_RE =
  /(failed|unreachable|dead-letter|crashed|revoked|\binvalid\b|auth failure|found errors|missing prompt template|not found|cache write failed|commit failed|too small|rejected \(http)/i;
function tailErrors(file, n = 3) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n").filter((l) => l.trim() && ERR_RE.test(l));
  return lines.slice(-n);
}

// Cached briefings and when each was fetched (the offline-fallback freshness
// signal). Reads the `<!-- spor cache: ... fetched=... -->` marker session-start
// writes; dual-reads the legacy `substrate cache:` spelling. Age comes from the
// marker timestamp, falling back to the file mtime if it's missing/unparseable.
function cacheReport(cacheDir) {
  let files;
  try {
    files = fs
      .readdirSync(cacheDir)
      .filter((f) => f.startsWith("brief-") && f.endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
  const isMarker = (l) => l.startsWith("<!-- spor cache:") || l.startsWith("<!-- substrate cache:");
  const out = [];
  for (const f of files) {
    let fetched = "";
    let ageMs = null;
    try {
      const raw = fs.readFileSync(path.join(cacheDir, f), "utf8");
      const header = raw.split("\n").find(isMarker);
      fetched = header?.match(/fetched=([^ ]+)/)?.[1] || "";
      const parsed = fetched ? Date.parse(fetched) : NaN;
      ageMs = Number.isNaN(parsed) ? fs.statSync(path.join(cacheDir, f)).mtimeMs : parsed;
    } catch {
      ageMs = null;
    }
    out.push({ file: f, fetched, ageMs });
  }
  return out;
}

async function doctor() {
  const graph = u.graphHome();
  const cfg = u.config();
  const mode = cfg ? cfg.mode() : u.serverBase() ? "remote" : "local";
  const enabled = cfg ? cfg.enabled() : true;
  const L = [];
  const kv = (label, value) => L.push(`  ${(label + ":").padEnd(13)}${value}`);

  L.push("spor doctor — client health");
  kv("mode", `${mode}${enabled ? "" : "  (not enabled here — run 'spor enable' to opt in; hooks are a no-op for this repo)"}`);
  kv("graph home", graph);

  if (u.serverBase()) {
    const host = u.serverHost();
    const token = u.cfgStr("token", "TOKEN");
    kv("server", u.serverBase());

    // One probe answers both reachability and token validity: /v1/status needs
    // auth, so 200 => reachable AND token good, 401/403 => reachable but token
    // rejected, 000 => transport down (token validity indeterminate).
    const probe = await u.curl(`${u.serverBase()}/v1/status`, { headers: u.bearer(), timeoutMs: 6000 });
    if (probe.http === "000") {
      kv("reachable", `NO — no response from ${host} (server down, wrong URL, or network)`);
      kv("token", token ? "present (cannot validate while the server is unreachable)" : "MISSING — set SPOR_TOKEN");
    } else if (probe.http === "401" || probe.http === "403") {
      kv("reachable", `yes (${host})`);
      kv("token", `REJECTED (http ${probe.http}) — invalid, revoked, or expired; re-mint it and update SPOR_TOKEN`);
    } else if (probe.http === "200") {
      let n = null;
      try {
        n = JSON.parse(probe.body).node_count;
      } catch {
        /* status body not JSON — token still validated by the 200 */
      }
      kv("reachable", `yes (${host})`);
      kv("token", `valid${n != null ? ` — graph has ${n} nodes` : ""}`);
    } else {
      kv("reachable", `yes, but ${host} returned http ${probe.http}`);
      kv("token", token ? "present" : "MISSING — set SPOR_TOKEN");
    }

    // Outbox / dead-letter depth — the captures the fail-open path stranded.
    const outbox = path.join(graph, "outbox");
    const spool = u.spoolStats(outbox);
    const dead = u.spoolStats(path.join(outbox, "dead"));
    kv(
      "outbox",
      spool.count
        ? `${spool.count} spooled (oldest ${fmtAge(spool.oldestMs)}) — undelivered, awaiting the next drain`
        : "0 spooled — clear"
    );
    kv(
      "dead-letter",
      dead.count
        ? `${dead.count} in outbox/dead/ (oldest ${fmtAge(dead.oldestMs)}) — PERMANENT rejects; fix the token, then replay outbox/dead/`
        : "0 — clear"
    );

    // Cached briefings (offline fallback freshness).
    const caches = cacheReport(path.join(graph, "cache"));
    if (!caches.length) {
      kv("cache", "none — no briefing cached for offline starts yet");
    } else {
      for (const c of caches) kv("cache", `${c.file} fetched ${c.fetched || "unknown"} (${fmtAge(c.ageMs)})`);
    }
  } else {
    // Local mode: no server / outbox / cache — report the graph itself.
    const nodesDir = path.join(graph, "nodes");
    let n = null;
    try {
      n = fs.readdirSync(nodesDir).filter((f) => f.endsWith(".md")).length;
    } catch {
      /* no nodes/ dir */
    }
    kv("graph", n == null ? "not created — run 'spor init'" : `${nodesDir} (${n} nodes)`);
  }

  // Capture-pipeline health (task-spor-distill-nudge-health-diagnostics):
  // per-pipeline success rates over the trailing window, from the llm-calls
  // records every distill/nudge backend call writes. A 100%-failure streak —
  // the silent-outage shape — is flagged loudly; partial failure just shows
  // its numbers; no calls at all is "idle", not an alarm.
  const { captureHealth, failingPipelines } = require("./capture-health");
  const health = captureHealth(graph);
  const failing = new Set(failingPipelines(health));
  for (const p of ["distill", "nudge"]) {
    const s = health[p];
    const label = `${p} ${health.days}d`;
    if (s.attempts === 0) {
      kv(label, "no calls in the window — idle (or the pipeline never fires; check backend config)");
    } else if (failing.has(p)) {
      kv(
        label,
        `FAILING — ${s.failures}/${s.attempts} calls failed, 0 successes` +
          ` (last error: ${s.lastErr}); capture is effectively OFF — check the backend cmd/CLI`
      );
    } else {
      const okPct = Math.round(((s.attempts - s.failures) / s.attempts) * 100);
      kv(
        label,
        `${s.attempts} calls, ${s.failures} failed (${okPct}% ok)` +
          (s.lastOkTs ? `, last success ${fmtAge(Date.parse(s.lastOkTs))}` : "")
      );
    }
  }

  // Recent error history from both journals — the after-the-fact crumb the
  // fail-open contract would otherwise hide (piece 1 feeds remote.log crashes).
  const journal = path.join(graph, "journal");
  for (const [label, file] of [
    ["remote.log", path.join(journal, "remote.log")],
    ["distill.log", path.join(journal, "distill.log")],
  ]) {
    const errs = tailErrors(file);
    if (errs == null) {
      kv(label, "(no log yet)");
    } else if (errs.length === 0) {
      kv(label, "no recent errors");
    } else {
      kv(label, `last ${errs.length} error line(s):`);
      for (const e of errs) L.push(`    ${e}`);
    }
  }

  return L.join("\n") + "\n";
}

module.exports = { doctor, fmtAge, tailErrors, cacheReport };

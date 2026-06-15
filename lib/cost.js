"use strict";
// cost.js — client-side LLM spend summary over journal/llm-calls
// (task-cc-spor-client-spend-visibility). The distiller and the post-tool
// capture nudge are the only paid calls the client makes; each records a row
// in $SPOR_HOME/journal/llm-calls/<date>.jsonl carrying token usage and a
// CLI-computed cost (the default `claude -p --output-format json` backend
// reports `total_cost_usd`; SPOR_*_CMD backends cannot, so those rows count as
// cost-unknown). This module aggregates those rows so the README "~$0.02 a
// session" figure is verifiable rather than asserted.
//
// Pure summarize() takes the parsed records; the CLI under require.main reads
// the journal, honoring the client config cascade for the graph home.

// Aggregate llm-call records into per-source and total spend. Optional filters
// narrow the set before counting. A record with no numeric cost_usd is counted
// as cost-unknown (cost_known/cost_unknown) rather than treated as $0, so a
// custom-backend user isn't shown a misleadingly low total.
function summarize(records, opts = {}) {
  const since = opts.since || null; // YYYY-MM-DD (inclusive, compares on ts/date prefix)
  const until = opts.until || null; // YYYY-MM-DD (inclusive)
  const project = opts.project || null;

  const bySource = Object.create(null);
  const total = blankBucket();
  let matched = 0;

  for (const r of records) {
    if (!r || typeof r !== "object") continue;
    if (project && r.project !== project) continue;
    const day = String(r.ts || "").slice(0, 10);
    if (since && day && day < since) continue;
    if (until && day && day > until) continue;
    matched++;

    const src = r.source || "unknown";
    const b = (bySource[src] = bySource[src] || blankBucket());
    addRow(b, r);
    addRow(total, r);
  }

  return {
    total,
    bySource,
    matched,
    sources: Object.keys(bySource).sort(),
    filters: { since, until, project },
  };
}

function blankBucket() {
  return {
    calls: 0,
    errors: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cost_usd: 0, // sum of KNOWN costs only
    cost_known: 0, // # rows with a numeric cost
    cost_unknown: 0, // # rows without one (cmd backend / pre-feature rows)
  };
}

function addRow(b, r) {
  b.calls++;
  if (r.error != null) b.errors++;
  const u = r.usage || {};
  b.input_tokens += num(u.input_tokens);
  b.output_tokens += num(u.output_tokens);
  b.cache_read_input_tokens += num(u.cache_read_input_tokens);
  b.cache_creation_input_tokens += num(u.cache_creation_input_tokens);
  if (typeof r.cost_usd === "number" && Number.isFinite(r.cost_usd)) {
    b.cost_usd += r.cost_usd;
    b.cost_known++;
  } else {
    b.cost_unknown++;
  }
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// ---- rendering (CLI only; kept here so the format has one home) ----
function fmtInt(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
function fmtCost(n) {
  return "$" + n.toFixed(4);
}

function render(sum, where) {
  const lines = [];
  const f = sum.filters;
  const scope = [
    f.project ? `project ${f.project}` : null,
    f.since ? `since ${f.since}` : null,
    f.until ? `until ${f.until}` : null,
  ].filter(Boolean);
  lines.push(`Spor LLM spend — ${where}`);
  lines.push(`${sum.matched} call${sum.matched === 1 ? "" : "s"}${scope.length ? " · " + scope.join(" · ") : ""}`);
  lines.push("");

  if (sum.matched === 0) {
    lines.push("(no recorded calls)");
    return lines.join("\n");
  }

  const head = pad("source", 10) + r("calls", 7) + r("in tok", 11) + r("out tok", 11) + r("cost", 16);
  lines.push(head);
  lines.push("-".repeat(head.length));
  for (const src of sum.sources) {
    lines.push(row(src, sum.bySource[src]));
  }
  lines.push("-".repeat(head.length));
  lines.push(row("total", sum.total));

  const unk = sum.total.cost_unknown;
  if (unk > 0) {
    lines.push("");
    lines.push(`note: ${unk} call${unk === 1 ? " has" : "s have"} no recorded cost (custom backend or pre-telemetry rows); cost shown sums the rest.`);
  }
  return lines.join("\n");
}

function row(label, b) {
  let costCell = fmtCost(b.cost_usd);
  if (b.cost_unknown > 0) costCell += `(${b.cost_known}/${b.calls})`;
  return (
    pad(label, 10) +
    r(fmtInt(b.calls) + (b.errors ? `!${b.errors}` : ""), 7) +
    r(fmtInt(b.input_tokens), 11) +
    r(fmtInt(b.output_tokens), 11) +
    r(costCell, 16)
  );
}
function pad(s, w) {
  s = String(s);
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}
function r(s, w) {
  s = String(s);
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

module.exports = { summarize };

// ---------------- CLI (local mode / debugging) ----------------
//   node lib/cost.js [--home <dir>] [--since YYYY-MM-DD] [--until YYYY-MM-DD]
//                    [--project <slug>] [--json]
if (require.main === module) {
  const path = require("path");
  const files = require(path.join(__dirname, "shell", "files.js"));
  const argv = process.argv.slice(2);
  const has = (n) => argv.includes(`--${n}`);
  const opt = (n, d) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d;
  };

  // Graph home via the client config cascade (dec-spor-client-config-cascade),
  // then the home.graphHome() default — byte-identical to other CLIs when
  // nothing is configured.
  const cfg = require(path.join(__dirname, "config.js")).loadConfig({ cwd: process.cwd() });
  const home = opt("home", cfg.graphHome());
  const dir = path.join(home, "journal", "llm-calls");

  const records = files.readJsonlDir(dir);
  const sum = summarize(records, {
    since: opt("since", null),
    until: opt("until", null),
    project: opt("project", null),
  });

  if (has("json")) {
    process.stdout.write(JSON.stringify(sum, null, 2) + "\n");
  } else {
    process.stdout.write(render(sum, dir) + "\n");
  }
}

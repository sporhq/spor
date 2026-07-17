// schema.js — first-class introspection of the LIVE schema registry
// (task-spor-schema-introspection-surface). The registry is the contract
// (norm-cc-registry-is-contract): node/edge types, id prefixes, edge weights,
// the ride-along flags (always_on/traversable/capturable/queueable), the
// status-resolution partition, and the attached validate()/transitions()/get()
// gates all live in schema nodes — the seed pack in lib/seed/ plus any graph-
// resident `type: schema` overrides. Agents have been observed reverse-
// engineering that contract by reading lib/seed/ files directly, which is
// fragile (it misses resident overrides) and couples them to internal file
// layout. This module renders `graph.registry.snapshot()` (lib/kernel/registry.js)
// into a human view and a machine view, so the contract is a proper read surface.
//
// The renderers are pure (snapshot in, string out) so all three surfaces share
// them: the local `spor schema` CLI (this file's main), the remote `spor schema`
// path (bin/spor.js fetches GET /v1/schema and renders the same snapshot), and
// — once shipped — the server's REST endpoint / MCP tool. Zero deps.
//
// CLI (local mode / debugging):
//   node lib/schema.js [--nodes <dir>]
//     [<type>]                 detail for one node/edge type (flags, provenance,
//                              hook NAMES, and each hook's source)
//     [--edges]                list edge types only
//     [--nodes-only]           list node types only
//     [--source seed|graph|native]   filter the lists by provenance
//     [--code]                 include hook source in --json (implied for <type>)
//     [--json]                 machine snapshot (full, or one type with <type>)

// ---------- formatting helpers ----------

// Right-pad to width (display is plain ASCII, so .length is the cell width).
function pad(s, w) {
  s = String(s);
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

// Render a list of row objects as an aligned table given [key, header] columns.
// Returns "" for an empty rows array (callers decide the empty-state line).
function table(rows, cols) {
  if (!rows.length) return "";
  const widths = cols.map(([k, h]) => Math.max(h.length, ...rows.map((r) => String(r[k] ?? "").length)));
  const line = (cells) => cells.map((c, i) => pad(c, widths[i])).join("  ").trimEnd();
  const out = [line(cols.map(([, h]) => h))];
  for (const r of rows) out.push(line(cols.map(([k]) => r[k] ?? "")));
  return out.join("\n");
}

// The flag glyphs for a node type, in a stable order. Empty -> "—".
function nodeFlags(n) {
  const f = [];
  if (n.queueable) f.push("queueable");
  if (n.always_on) f.push("always_on");
  if (!n.traversable) f.push("not-traversable");
  if (!n.capturable) f.push("not-capturable");
  if (n.non_resolving && n.non_resolving.length) f.push("non-resolving:" + n.non_resolving.join(","));
  if (n.terminal && n.terminal.length) f.push("terminal:" + n.terminal.join(","));
  // Only a DECLARED inert set is rendered — the inherited default would just
  // repeat the terminal list on every row (dec-spor-status-inert-third-partition).
  if (!n.inert_inherited && n.inert && n.inert.length) f.push("inert:" + n.inert.join(","));
  return f.length ? f.join(" ") : "—";
}

// Inverse + aliases column for an edge type. Aliases are marked with "~".
function edgeRels(e) {
  const parts = [];
  if (e.inverse_label) parts.push(e.inverse_label);
  for (const a of e.aliases || []) parts.push("~" + a);
  return parts.length ? parts.join("; ") : "—";
}

function fmtWeight(e) {
  return e.weight.toFixed(2) + (e.weight_default ? "*" : "");
}

function schemaCell(x) {
  return x.schema_id ? `${x.schema_id} @ ${x.schema_version}` : "(native)";
}

// ---------- snapshot filtering ----------

const { SLOTS } = require("./kernel/registry.js");

// Return a snapshot whose slot entries (node/edge types, policies, registers,
// queue policy — one per lib/kernel/registry.js SLOTS entry) are restricted to
// provenance `source` ("seed" | "graph" | "native"). Warnings and scalars pass
// through. A no-op when source is falsy. Walks SLOTS generically (by
// snapshotKey + singleton flag) rather than hand-picking keys, so a sixth slot
// is filtered with no edit here (norm-cc-registry-is-contract).
function filterBySource(snap, source) {
  if (!source) return snap;
  const keep = (x) => x.source === source;
  const out = { ...snap };
  for (const slot of SLOTS) {
    const val = snap[slot.snapshotKey];
    out[slot.snapshotKey] = slot.singleton ? (val && keep(val) ? val : null) : val.filter(keep);
  }
  return out;
}

// ---------- human renderers (pure: snapshot -> string) ----------

// The full overview: node types, edge types, registers, the policy layer, the
// queue policy, and any registry-health warnings. `opts.only` ("nodes"|"edges")
// narrows it to one table for the focused list flags.
function renderOverview(snap, opts = {}) {
  const only = opts.only || null;
  const overrides = [...snap.node_types, ...snap.edge_types].filter((x) => x.source === "graph").length;
  const blocks = [];

  const header =
    `Spor schema registry — ${snap.node_types.length} node type${snap.node_types.length === 1 ? "" : "s"}, ` +
    `${snap.edge_types.length} edge type${snap.edge_types.length === 1 ? "" : "s"}` +
    (overrides ? ` (${overrides} graph-resident override${overrides === 1 ? "" : "s"})` : " (seed pack)");
  blocks.push(header);

  if (!only || only === "nodes") {
    const rows = snap.node_types.map((n) => ({
      type: n.type,
      prefix: (n.prefix || []).join(",") || "—",
      flags: nodeFlags(n),
      src: n.source,
      schema: schemaCell(n),
    }));
    blocks.push(
      "\nNODE TYPES" +
        (rows.length ? "\n" + table(rows, [["type", "type"], ["prefix", "prefix"], ["flags", "flags"], ["src", "src"], ["schema", "schema"]]) : "\n  (none)")
    );
  }

  if (!only || only === "edges") {
    const rows = snap.edge_types.map((e) => ({
      type: e.type,
      weight: fmtWeight(e),
      rels: edgeRels(e),
      src: e.source,
      schema: schemaCell(e),
    }));
    blocks.push(
      "\nEDGE TYPES" +
        (rows.length
          ? "\n" + table(rows, [["type", "type"], ["weight", "weight"], ["rels", "inverse / ~aliases"], ["src", "src"], ["schema", "schema"]]) + "\n  (* = default weight " + snap.default_edge_weight.toFixed(2) + ", no explicit weight in schema)"
          : "\n  (none)")
    );
  }

  if (!only) {
    if (snap.registers.length) {
      const rows = snap.registers.map((r) => ({
        name: r.name,
        classes: (r.classes || []).map((c) => c.id).join(",") || "—",
        src: r.source,
        schema: schemaCell(r),
      }));
      blocks.push("\nREGISTERS\n" + table(rows, [["name", "register"], ["classes", "classes"], ["src", "src"], ["schema", "schema"]]));
    }
    if (snap.policies.length) {
      const rows = snap.policies.map((p) => ({
        schema: schemaCell(p),
        governs: [
          p.governs.types.length ? "types:" + p.governs.types.join(",") : "",
          p.governs.projects.length ? "projects:" + p.governs.projects.join(",") : "",
        ].filter(Boolean).join(" ") || "org-wide",
        src: p.source,
      }));
      blocks.push("\nPOLICIES\n" + table(rows, [["schema", "policy"], ["governs", "governs"], ["src", "src"]]));
    }
    blocks.push("\nQUEUE POLICY\n  " + (snap.queue_policy ? schemaCell(snap.queue_policy) + ` (${snap.queue_policy.source})` : "(none — kernel default ranking)"));

    const warns = [...(snap.stale_overrides || []), ...(snap.alias_collisions || [])];
    if (warns.length) {
      blocks.push("\n⚠ registry warnings\n" + warns.map((w) => "  - " + w).join("\n"));
    }
  }

  return blocks.join("\n");
}

// Detail for one type (node or edge). Includes the attached-hook source so the
// validate()/transitions()/get() gates — the part agents most need and most
// often reverse-engineer — are readable directly. Returns null if no such type.
function renderType(snap, type) {
  const n = snap.node_types.find((x) => x.type === type);
  const e = !n && snap.edge_types.find((x) => x.type === type);
  if (!n && !e) return null;
  const lines = [];
  if (n) {
    lines.push(`${n.type}   (node type)`);
    lines.push(`  schema:      ${schemaCell(n)}  (${n.source})`);
    lines.push(`  description: ${n.description || "—"}`);
    lines.push(`  prefix:      ${(n.prefix || []).join(", ") || "—"}`);
    lines.push(`  flags:       ${nodeFlags(n)}`);
    lines.push(`  hooks:       ${n.hooks.length ? n.hooks.join(", ") : "—"}`);
    appendCode(lines, n.code);
  } else {
    lines.push(`${e.type}   (edge type)`);
    lines.push(`  schema:      ${schemaCell(e)}  (${e.source})`);
    lines.push(`  description: ${e.description || "—"}`);
    lines.push(`  weight:      ${fmtWeight(e)}${e.weight_default ? "  (default — no explicit weight)" : ""}`);
    lines.push(`  inverse:     ${e.inverse_label || "—"}`);
    lines.push(`  aliases:     ${(e.aliases || []).join(", ") || "—"}`);
    lines.push(`  capturable:  ${e.capturable}`);
    lines.push(`  hooks:       ${e.hooks.length ? e.hooks.join(", ") : "—"}`);
    appendCode(lines, e.code);
  }
  return lines.join("\n");
}

function appendCode(lines, code) {
  if (!code) return;
  // De-dup: many exports share one source block (validate + transitions in one
  // fenced ```js block). Print each distinct source once, labelled by its names.
  const bySource = new Map();
  for (const [name, src] of Object.entries(code)) {
    if (!bySource.has(src)) bySource.set(src, []);
    bySource.get(src).push(name);
  }
  for (const [src, names] of bySource) {
    lines.push(`\n  --- ${names.join(", ")} ---`);
    lines.push(src.replace(/\n$/, "").split("\n").map((l) => "  " + l).join("\n"));
  }
}

// ---------- shared dispatch (one renderer for the local CLI and the remote path) ----------

// Given a snapshot and the resolved view options, produce { text, code, stderr }.
// The single place that maps (type | overview) × (human | json) × source-filter
// to output, so the local `spor schema` (this file's main) and the remote
// `spor schema` (bin/spor.js, rendering a GET /v1/schema body) stay identical.
// Code embedding is a property of the passed snapshot (built with { code } /
// fetched with ?code=1), not of this function.
function present(snap, { type = null, only = null, source = null, json = false } = {}) {
  snap = filterBySource(snap, source);
  if (type != null) {
    if (json) {
      const x = snap.node_types.find((n) => n.type === type) || snap.edge_types.find((e) => e.type === type);
      if (!x) return { text: `no node or edge type '${type}' in the registry`, code: 1, stderr: true };
      return { text: JSON.stringify(x, null, 2), code: 0 };
    }
    const out = renderType(snap, type);
    if (out == null) return { text: `no node or edge type '${type}' in the registry`, code: 1, stderr: true };
    return { text: out, code: 0 };
  }
  if (json) return { text: JSON.stringify(snap, null, 2), code: 0 };
  return { text: renderOverview(snap, { only }), code: 0 };
}

module.exports = { renderOverview, renderType, filterBySource, present, nodeFlags, edgeRels };

// ---------- CLI (local mode / debugging) ----------

if (require.main === module) {
  const fs = require("fs");
  const path = require("path");
  const graphLib = require(path.join(__dirname, "graph.js"));

  const argv = process.argv.slice(2);
  const opt = (n, d) => {
    let v = d;
    for (let i = 0; i < argv.length - 1; i++) if (argv[i] === `--${n}`) v = argv[i + 1];
    return v;
  };
  const has = (n) => argv.includes(`--${n}`);
  // First non-flag, non-flag-value token is the optional <type> positional.
  const flagVals = new Set();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--nodes" || argv[i] === "--source") flagVals.add(i + 1);
  }
  const positional = argv.find((a, i) => !a.startsWith("--") && !flagVals.has(i)) || null;

  const cfg = require(path.join(__dirname, "config.js")).loadConfig({ cwd: process.cwd() });
  const NODES_DIR = path.resolve(opt("nodes", cfg.nodesDir()));
  if (!fs.existsSync(NODES_DIR)) {
    console.error(`no Spor graph at ${NODES_DIR}`);
    process.exit(0);
  }

  // Single-type views always carry the hook source (the detail is the point);
  // the full overview/--json opt in with --code so the common output stays lean.
  const wantCode = has("code") || positional != null;
  const g = graphLib.loadGraph(NODES_DIR);
  const snap = g.registry.snapshot({ code: wantCode });
  const only = has("edges") ? "edges" : has("nodes-only") ? "nodes" : null;

  const r = present(snap, { type: positional, only, source: opt("source", null), json: has("json") });
  (r.stderr ? console.error : console.log)(r.text);
  process.exit(r.code);
}

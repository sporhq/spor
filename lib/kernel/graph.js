// kernel/graph.js — the pure graph core: parse / build / compile / validate.
// Data in, data out (REFACTOR.md §1): no filesystem, no environment, no
// side effects. File contents arrive as plain { filename: rawText } maps and
// the seed ontology arrives as already-parsed schema objects; reading them
// off disk is lib/shell/files.js's job, and lib/graph.js wires the two while
// keeping the exact pre-split API.
//
// Exports:
//   parseFrontmatter(raw, file)                  -> node object
//   parseSeedSchemas(files)                      -> [schema] (throws on a bad seed)
//   seedRegistry(seedSchemas)                    -> Registry
//   buildRegistry(seedSchemas, schemaNodes)      -> { registry, errors }
//   buildGraph(files, {nodesDir, seedSchemas})   -> { nodes, adj, supersededBy, docs, df, N, nodesDir, registry }
//   compile(graph, opts)                         -> { text, picks, meta }  (opts.relevant=false => "nothing")
//   renderSkeleton(graph, rootId, {version, date, compiledAt}) -> { briefId, version, text, sources, corrections }
//   validateNode(graph, candidate)               -> { ok, errors }
//   validateGraphFiles(files, seedSchemas)       -> { errors, warnings, byType, count, nodes }
//   rankAgainst(graph, text, excludeIds)         -> [{ id, sim }]
//
// QUEUE.md §2 / rollout step 1: the hardcoded ontology tables (edge weights,
// known node/edge types, id prefixes, the norm ride-along, briefing/correction
// traversal exclusion) are registry lookups. The registry is built from the
// seed schema pack in lib/seed/ (the GRAPH.md ontology expressed as schema
// nodes), overridden/extended by `type: schema` nodes resident in the graph
// being loaded.

const registry = require("./registry.js");

// ---------- the schema registry ----------

// Parse a seed pack given as { filename: rawText }. The seed ships with the
// repo, so a seed file that fails to parse is a bug — throw loudly.
function parseSeedSchemas(files) {
  const out = [];
  for (const f of Object.keys(files).filter((f) => f.endsWith(".md")).sort()) {
    const n = parseFrontmatter(files[f], f);
    const r = registry.parseSchemaNode(n);
    if (!r.ok) throw new Error(`seed schema ${f}: ${r.errors.join("; ")}`);
    out.push(r.schema);
  }
  return out;
}

// Registry from the seed pack alone (what a graph with no schema nodes gets).
function seedRegistry(seedSchemas) {
  const reg = new registry.Registry();
  for (const s of seedSchemas) reg.add(s, "seed");
  return reg;
}

// A graph-resident schema node contributes to the registry only once ACTIVE
// (QUEUE.md §2.4 proposal flow, rollout step 4): server-written schema nodes
// land with status: proposed and are inert data until a human flips them to
// active. Absent status (pre-proposal-flow schemas, hand-written by admins)
// counts as active.
const schemaActive = (n) => !n.status || n.status === "active";

// Seed pack + graph-resident schema nodes layered on top. Returns
// { registry, errors } — errors are per-node parse failures (the node is
// skipped, the registry keeps its seed entry for that type).
function buildRegistry(seedSchemas, schemaNodes = []) {
  const reg = seedRegistry(seedSchemas);
  const errors = [];
  for (const n of schemaNodes) {
    const r = registry.parseSchemaNode(n);
    if (!r.ok) { errors.push(...r.errors.map((e) => `${n.file ?? n.id}: ${e}`)); continue; }
    reg.add(r.schema, "graph");
  }
  return { registry: reg, errors };
}

// ---------- constants ----------

const STRUCTURAL_THRESHOLD = 0.25;
const FULL_BODY_THRESHOLD = 0.6;
const MAX_HOPS = 3;
const CONTENT_TOP_K = 4;
const CONTENT_MIN_SIM = 0.04;
const QUERY_SEEDS = 3;
const DIGEST_CAP = 4500; // chars; stays well under the 10KB additionalContext cap
const DEFAULT_MIN_SIM = 0.08;

// ---------- frontmatter parsing ----------

// Regex-based frontmatter parser (hard rule: no YAML library — zero deps).
// Supports simple
// key: value, YAML folded multi-line values (indented continuations),
// pin:/exclude:/queue_mute:/commits:/slugs:/fingerprints: inline lists, and
// "- {type: X, to: Y}" edges. commits entries are repo-qualified shas
// ("repo@sha", task-cc-commit-linking); slugs/fingerprints are the project
// node's alias and repo-evidence registers (task-cc-project-identity-nodes)
// — flat strings, not objects, by parser design.
function parseFrontmatter(raw, file) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error(`no frontmatter in ${file}`);
  const [, fm, body] = m;
  const node = { edges: [], pin: [], exclude: [], body: body.trim(), file };
  let lastKey = null; // for YAML folded scalars (indented continuation lines)
  for (const line of fm.split("\n")) {
    const list = line.match(/^(pin|exclude|queue_mute|commits|slugs|fingerprints):\s*\[([^\]]*)\]/);
    if (list) { node[list[1]] = list[2].split(",").map((s) => s.trim()).filter(Boolean); lastKey = null; continue; }
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) {
      if (kv[1] !== "edges") { node[kv[1]] = kv[2].replace(/^["']|["']$/g, ""); lastKey = kv[1]; }
      else lastKey = null;
      continue;
    }
    const edge = line.match(/-\s*\{type:\s*([\w-]+),\s*to:\s*([\w-]+)\}/);
    if (edge) { node.edges.push({ type: edge[1], to: edge[2] }); continue; }
    const cont = line.match(/^\s+(\S.*)$/);
    if (cont && lastKey) node[lastKey] += ` ${cont[1].trim()}`;
  }
  return node;
}

// ---------- graph build ----------

// files: { filename: rawText } in directory order (the shell preserves
// readdir order). nodesDir is carried as plain data — compile() prints it in
// the digest header; nothing here touches it as a path.
function buildGraph(files, { nodesDir = "", seedSchemas = [] } = {}) {
  const nodes = {};
  for (const f of Object.keys(files).filter((f) => f.endsWith(".md"))) {
    const n = parseFrontmatter(files[f], f);
    nodes[n.id] = n;
  }

  // schemas load first (QUEUE.md §2.2): ACTIVE graph-resident schema nodes
  // layered over the seed pack drive every ontology lookup below. Proposed /
  // rejected schema nodes are inert data (§2.4 proposal flow). An active
  // schema node that doesn't parse is as fatal as malformed frontmatter.
  const built = buildRegistry(seedSchemas, Object.values(nodes).filter((n) => n.type === "schema" && schemaActive(n)));
  if (built.errors.length) throw new Error(`invalid schema node(s): ${built.errors.join("; ")}`);
  const reg = built.registry;
  const traversable = (n) => reg.isTraversable(n.type);

  const adj = {};
  const supersededBy = {};
  for (const n of Object.values(nodes)) {
    if (!traversable(n)) continue;
    for (const e of n.edges) {
      if (!nodes[e.to] || !traversable(nodes[e.to])) continue;
      const w = reg.edgeWeight(e.type);
      (adj[n.id] ??= []).push({ to: e.to, type: e.type, weight: w });
      (adj[e.to] ??= []).push({ to: n.id, type: `${e.type} (inbound)`, weight: w });
      if (e.type === "supersedes") supersededBy[e.to] = n.id;
    }
  }

  const docs = Object.values(nodes).filter(traversable)
    .map((n) => ({ id: n.id, tf: tf(tokens(`${n.title ?? ""} ${n.summary ?? ""} ${n.body}`)) }));
  const df = {};
  for (const d of docs) for (const t of Object.keys(d.tf)) df[t] = (df[t] ?? 0) + 1;
  const N = docs.length;

  // Precompute the corpus as an inverted index once per load: rankAgainst
  // runs on every prompt, and recomputing 5k doc vectors per query costs
  // ~100ms+ at scale, vs ~10ms with a sparse dot product over query terms.
  //
  // The vectors live as per-term posting lists of typed arrays rather than a
  // string-keyed plain object per doc (issue-cc-graph-vec-posting-lists): at
  // 50k nodes the old per-doc objects cost ~328MB of heap in per-property
  // overhead. postings[term] = { docs: Int32Array of indices into `docs`, w:
  // Float64Array of aligned tf-idf weights }; df already supplies each term's
  // posting-list length. Weights stay Float64 so cosines are bit-for-bit what
  // the old object path produced (norm-cc-byte-identical-refactor).
  const vec = makeVec(df, N);
  const postings = {};
  const cursor = {};
  for (const t of Object.keys(df)) {
    postings[t] = { docs: new Int32Array(df[t]), w: new Float64Array(df[t]) };
    cursor[t] = 0;
  }
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    const dv = vec(d.tf); // transient; folded into the posting lists below
    let nn = 0;
    for (const t of Object.keys(dv)) {
      const x = dv[t];
      nn += x * x; // same products, same order as the old Object.values(d.vec)
      const p = postings[t], k = cursor[t]++;
      p.docs[k] = i;
      p.w[k] = x;
    }
    d.norm = Math.sqrt(nn);
    delete d.tf; // dead after this; rankAgainst reads only postings + d.norm
  }

  return { nodes, adj, supersededBy, docs, df, N, postings, nodesDir, registry: reg,
    projectAliases: projectAliasMap(nodes), archivedProjects: archivedProjectSet(nodes) };
}

// ---------- project identity (task-cc-project-identity-nodes) ----------

// Slug -> project-node-id map from resident `type: project` nodes. Every
// slug in a project node's `slugs:` register resolves to that node, as does
// the node's own id, so any historical alias names the same project. The
// `project:` stamp on data nodes never rewrites; consumers resolve at read
// time via resolveProject(). First claim wins on a slug two project nodes
// both list (directory order — deterministic; the validator warns). A graph
// with no project nodes gets an empty map and resolution is the identity.
function projectAliasMap(nodes) {
  const out = {};
  for (const n of Object.values(nodes)) {
    if (n.type !== "project") continue;
    out[n.id] ??= n.id;
    for (const s of n.slugs ?? []) out[s] ??= n.id;
  }
  return out;
}

// Resolve a project slug (or project-node id) to its canonical key: the
// owning project node's id when one claims it, else the input unchanged.
function resolveProject(graph, slug) {
  if (!slug) return slug;
  return graph.projectAliases?.[slug] ?? slug;
}

// End-of-life for a project (issue-cc-project-lifecycle-queue-pollution): a
// `type: project` node carrying `status: archived` retires the whole project.
// The set holds canonical keys (the project node's id) so a stamp under any
// alias resolves into it. Archival is identity-level GRAPH STATE — one edit
// retires the project for EVERY viewer, unlike the per-person queue_mute that
// needs N people to each silence it. Slug aliases still resolve (so closed
// history stays reachable in a project-scoped read), but the queue stops
// surfacing the archived project's open work and session-start announces the
// archival instead of injecting a stale brief. A project with no status, or
// any non-archived status, behaves exactly as before.
function archivedProjectSet(nodes) {
  const out = new Set();
  for (const n of Object.values(nodes)) {
    if (n.type === "project" && (n.status || "").toLowerCase() === "archived") out.add(n.id);
  }
  return out;
}

// Is the (already-resolved) canonical project key archived? Resolves the input
// through the alias map first, so callers may pass a raw slug or stamp.
function isArchivedProject(graph, slug) {
  if (!slug || !graph.archivedProjects?.size) return false;
  return graph.archivedProjects.has(resolveProject(graph, slug));
}

// ---------- tf-idf ----------

const STOP = new Set(("the a an and or of to in for on with is are was were be been this that " +
  "it as at by from we our their they you your has have had not no do does but if than then so " +
  "its into out over under all any per each").split(" "));
const tokens = (t) => t.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 2 && !STOP.has(x));
const tf = (ts) => ts.reduce((m, t) => ((m[t] = (m[t] ?? 0) + 1), m), {});

function makeVec(df, N) {
  return (tfm) => Object.fromEntries(Object.entries(tfm).map(([t, c]) => [t, c * Math.log(N / (df[t] ?? N))]));
}
const cos = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (const [t, x] of Object.entries(a)) { na += x * x; if (b[t]) dot += x * b[t]; }
  for (const x of Object.values(b)) nb += x * x;
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};

function rankAgainst(graph, text, excludeIds) {
  const vec = makeVec(graph.df, graph.N);
  const rootVec = vec(tf(tokens(text)));
  // Same math as cos(rootVec, docVec), against the posting lists and norms
  // precomputed in buildGraph: sqrt(na)*sqrt(nb) === queryNorm*d.norm. Driving
  // the dot from the query's posting lists touches only docs that share a query
  // term, and each doc's score accumulates its query terms in
  // Object.entries(rootVec) order — bit-identical to the old per-doc loop.
  let qn = 0;
  for (const x of Object.values(rootVec)) qn += x * x;
  const queryNorm = Math.sqrt(qn);
  const docs = graph.docs;
  const scores = new Float64Array(docs.length);
  for (const [t, x] of Object.entries(rootVec)) {
    const p = graph.postings[t];
    if (!p) continue;
    const pd = p.docs, pw = p.w;
    for (let k = 0; k < pd.length; k++) scores[pd[k]] += x * pw[k];
  }
  const out = [];
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    if (excludeIds.has(d.id)) continue;
    out.push({ id: d.id, sim: scores[i] / (queryNorm * d.norm || 1) });
  }
  return out.sort((a, b) => b.sim - a.sim);
}

// ---------- structural walk ----------

function structuralWalk(graph, seeds) { // seeds: {id: initialScore}
  const adj = graph.adj;
  const best = {};
  const queue = [];
  for (const [id, score] of Object.entries(seeds)) {
    best[id] = { score, hops: 0, via: seeds[id] === 1.0 ? "root" : "content seed" };
    queue.push(id);
  }
  while (queue.length) {
    const cur = queue.shift();
    const { score, hops } = best[cur];
    if (hops >= MAX_HOPS) continue;
    for (const e of adj[cur] ?? []) {
      const s = score * e.weight;
      if (s < STRUCTURAL_THRESHOLD) continue;
      if (!best[e.to] || best[e.to].score < s) {
        best[e.to] = { score: s, hops: hops + 1, via: `${e.type} from ${cur}` };
        queue.push(e.to);
      }
    }
  }
  return best;
}

// ---------- compile ----------
//
// opts: { rootId?, query?, digest?, minSim?, seedSchemas? }
// returns { text, picks, meta, relevant }. relevant=false means "nothing
// relevant" — the CLI maps that to exit 0 with empty stdout. unknownRoot=true
// means the requested root id is absent (CLI maps to exit 1). seedSchemas
// only backs the norm ride-along fallback for graphs built without a
// registry; every buildGraph() result carries one.
function compile(graph, opts = {}) {
  const { nodes, supersededBy } = graph;
  const ROOT_ID = opts.rootId ?? null;
  const QUERY = opts.query ?? null;
  const DIGEST = !!opts.digest;
  const MIN_TOP_SIM = opts.minSim != null ? opts.minSim : DEFAULT_MIN_SIM;
  const NODES_DIR = graph.nodesDir;

  // ---------- root / seeds ----------
  let seeds, rootText, rootHeader;
  if (ROOT_ID) {
    const root = nodes[ROOT_ID];
    if (!root) return { unknownRoot: true, relevant: false };
    seeds = { [ROOT_ID]: 1.0 };
    rootText = `${root.title} ${root.summary} ${root.body}`;
    rootHeader = `## THE TASK\n\n### ${ROOT_ID} — ${root.title}\n\n${root.body}\n`;
  } else {
    const ranked0 = rankAgainst(graph, QUERY, new Set());
    if (!ranked0.length || ranked0[0].sim < MIN_TOP_SIM) return { relevant: false }; // nothing relevant
    seeds = {};
    for (const [i, r] of ranked0.slice(0, QUERY_SEEDS).entries()) {
      if (r.sim >= CONTENT_MIN_SIM) seeds[r.id] = 0.9 - i * 0.05;
    }
    rootText = QUERY;
    rootHeader = `## THE QUERY\n\n${QUERY}\n`;
  }

  // ---------- corrections ----------
  const corrections = Object.values(nodes).filter((n) =>
    n.type === "correction" && (n.target === ROOT_ID || n.target === "global"));
  const pinned = new Map();
  const excluded = new Set();
  for (const c of corrections) {
    for (const id of c.pin) if (nodes[id]) pinned.set(id, c.id);
    for (const id of c.exclude) excluded.add(id);
  }

  // ---------- assembly ----------
  const structural = structuralWalk(graph, seeds);
  if (ROOT_ID) delete structural[ROOT_ID];
  for (const id of Object.keys(structural)) {
    const w = supersededBy[id];
    if (w && !structural[w]) structural[w] = { score: structural[id].score, hops: structural[id].hops, via: `supersedes ${id} (graph fixup)` };
  }
  for (const id of excluded) delete structural[id];

  const structuralSet = new Set(Object.keys(structural));
  const ranked = rankAgainst(graph, rootText, new Set([...structuralSet, ...(ROOT_ID ? [ROOT_ID] : [])]));
  const contentPicks = ranked.filter((r) => r.sim >= CONTENT_MIN_SIM && !excluded.has(r.id) && !pinned.has(r.id)).slice(0, CONTENT_TOP_K);
  for (const p of [...contentPicks]) {
    const w = supersededBy[p.id];
    if (w && !structuralSet.has(w) && !contentPicks.some((x) => x.id === w)) {
      contentPicks.push({ id: w, sim: p.sim, note: `supersedes ${p.id}` });
    }
  }
  const contentSet = new Set(contentPicks.map((p) => p.id));
  const pinnedPicks = [...pinned.entries()].filter(([id]) => !structuralSet.has(id) && !contentSet.has(id));
  const topical = new Set(ranked.slice(0, 8).map((r) => r.id));
  // ride-along is a schema flag now (always_on: true; the seed sets it on norm)
  const reg = graph.registry ?? seedRegistry(opts.seedSchemas ?? []);
  const norms = Object.values(nodes).filter((n) =>
    reg.isAlwaysOn(n.type) && !structuralSet.has(n.id) && !contentSet.has(n.id) && !pinned.has(n.id) && !excluded.has(n.id));

  // ---------- rendering ----------
  function render(n, full, provenance) {
    const head = `### ${n.id} — ${n.title} (${n.type}, ${n.date})\n*selected via: ${provenance}*\n`;
    const stale = supersededBy[n.id]
      ? `\n> ⚠ SUPERSEDED by ${supersededBy[n.id]}. Do not follow; included only so you recognize stale references.\n` : "";
    return (full && !supersededBy[n.id]) ? `${head}${stale}\n${n.body}\n` : `${head}${stale}\n${n.summary}\n`;
  }

  let out;
  if (DIGEST) {
    const lines = [];
    const seen = new Set();
    const add = (n, tag) => {
      if (seen.has(n.id)) return;
      seen.add(n.id);
      const warn = supersededBy[n.id] ? ` ⚠ SUPERSEDED by ${supersededBy[n.id]} — do not follow` : "";
      const proj = n.project ? `, ${n.project}` : "";
      lines.push(`- **${n.id} — ${n.title}** (${n.type}${proj}, ${n.date}${tag ? `, ${tag}` : ""}): ${n.summary}${warn}`);
    };
    for (const [id, corrId] of pinnedPicks) add(nodes[id], `pinned by ${corrId}`);
    for (const [id] of Object.entries(structural).sort((a, b) => b[1].score - a[1].score)) add(nodes[id], null);
    for (const p of contentPicks) add(nodes[p.id], "content match — no lineage, check for prior art");
    if (!lines.length) return { relevant: false };
    const corrText = corrections.filter((c) => c.target === "global").map((c) => `> ${c.body.split("\n")[0]}`).join("\n");
    out = `Spor graph nodes relevant to this prompt (auto-compiled; node files live in ${NODES_DIR}; run /spor:brief for a full briefing):\n\n`;
    for (const l of lines) {
      if (out.length + l.length > DIGEST_CAP) break;
      out += l + "\n";
    }
    if (corrText) out += `\nStanding corrections:\n${corrText}\n`;
  } else {
    out = `# Compiled neighborhood\n\n${rootHeader}\n`;
    if (corrections.length) {
      out += `## CORRECTIONS (standing guidance from prior briefing reviews — MUST be honored)\n\n`;
      for (const c of corrections) out += `### ${c.id} — ${c.title} (${c.date})\n\n${c.body}\n\n`;
    }
    if (pinnedPicks.length) {
      out += `## PINNED (forced into the neighborhood by corrections)\n\n`;
      for (const [id, corrId] of pinnedPicks) out += render(nodes[id], true, `pinned by ${corrId}`) + "\n";
    }
    out += `## LINEAGE (structural arm: typed-edge walk)\n\n`;
    for (const [id, info] of Object.entries(structural).sort((a, b) => b[1].score - a[1].score)) {
      out += render(nodes[id], info.score >= FULL_BODY_THRESHOLD || pinned.has(id), `${info.via}, score ${info.score.toFixed(2)}`) + "\n";
    }
    out += `## OUTSIDE VIEW (content arm — no lineage connection; check for prior art and unowned constraints)\n\n`;
    for (const [i, p] of contentPicks.entries()) {
      out += render(nodes[p.id], i < 2 || !!p.note, p.note ? `graph fixup: ${p.note}` : `content similarity ${p.sim.toFixed(3)}`) + "\n";
    }
    out += `## ORG NORMS (always-on)\n\n`;
    for (const n of norms) out += render(n, topical.has(n.id), "norm") + "\n";
  }

  return {
    text: out,
    relevant: true,
    picks: { structural, structuralSet, contentPicks, pinnedPicks, norms, corrections, ranked },
    meta: {
      nodes: Object.keys(nodes).length,
      structural: structuralSet.size,
      content: contentPicks.length,
      pinned: pinnedPicks.length,
      corrections: corrections.length,
      tokens: Math.round(out.length / 4),
    },
  };
}

// ---------- skeleton ----------
//
// Pure half of the briefing-skeleton flow: compiles the root's neighborhood
// and renders the versioned skeleton text. The side effects of the original
// (archiving the prior version to history/, bumping the version, stamping the
// clock) live in the lib/graph.js façade — version, date, and compiledAt
// arrive here as data.
function renderSkeleton(graph, rootId, { version = 1, date, compiledAt, seedSchemas } = {}) {
  const { nodes } = graph;
  const r = compile(graph, { rootId, digest: false, seedSchemas });
  if (r.unknownRoot) return { unknownRoot: true };
  const { structuralSet, contentPicks, pinnedPicks, norms, corrections } = r.picks;

  const briefId = `brief-${rootId}`;
  const sources = [...structuralSet, ...contentPicks.map((p) => p.id), ...pinnedPicks.map(([id]) => id), ...norms.map((n) => n.id)];
  const text = `---
id: ${briefId}
type: briefing
title: Compiled briefing for ${rootId}
summary: Machine-compiled, human-correctable context briefing for ${rootId} (version ${version}).
version: ${version}
date: ${date}
compiled_at: ${compiledAt}
edges:
  - {type: compiled-for, to: ${rootId}}
${sources.map((id) => `  - {type: derived-from, to: ${id}}`).join("\n")}
${corrections.map((c) => `  - {type: shaped-by, to: ${c.id}}`).join("\n")}
---

<!-- BODY: distiller fills this in -->
`;
  return { briefId, version, text, sources, corrections };
}

// ---------- validation ----------
//
// validateNode lints a single already-parsed node object against the structural
// rules the CLI validator enforces per file (ERROR set only — id/type/title/
// summary present, id==filename, correction has target). Cross-node checks
// (duplicate id, dangling edges) live in validateGraphFiles.
function validateNode(graph, node) {
  const errors = [];
  const f = node.file ?? `${node.id ?? "?"}.md`;
  for (const field of ["id", "type", "title", "summary"]) {
    if (!node[field]) errors.push(`${f}: missing ${field}`);
  }
  if (node.id && node.id !== f.replace(/\.md$/, "")) errors.push(`${f}: id '${node.id}' != filename`);
  if (node.type === "correction" && !node.target) errors.push(`${f}: correction without target`);
  // schema nodes (QUEUE.md §2.2) must parse into a registry entry: valid kind,
  // CalVer schema_version, fenced json payload, well-formed upgrade chain.
  if (node.type === "schema") {
    errors.push(...registry.parseSchemaNode(node).errors.map((e) => `${f}: ${e}`));
  }
  return { ok: errors.length === 0, errors };
}

// validateGraphFiles reproduces the original lib/validate.js exactly: iterates
// files in the order given (the shell preserves readdir order), accumulates
// errors (exit-1 conditions) and warnings (exit-0 notes), and returns the
// node-count/byType summary the CLI prints. It re-parses leniently per file
// (so it tolerates malformed files that buildGraph would throw on, exactly
// like the original inline validator).
function validateGraphFiles(files, seedSchemas = []) {
  const errors = [], warnings = [];
  const nodes = {};
  const fileNodes = []; // parsed files in directory order, for the warning pass

  for (const f of Object.keys(files).filter((f) => f.endsWith(".md"))) {
    const raw = files[f];
    const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!m) { errors.push(`${f}: no frontmatter`); continue; }
    const node = { edges: [], body: m[2].trim(), file: f };
    for (const line of m[1].split("\n")) {
      const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
      if (kv && kv[1] !== "edges") node[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
      const edge = line.match(/-\s*\{type:\s*([\w-]+),\s*to:\s*([\w-]+)\}/);
      if (edge) node.edges.push({ type: edge[1], to: edge[2] });
    }
    for (const field of ["id", "type", "title", "summary"]) {
      if (!node[field]) errors.push(`${f}: missing ${field}`);
    }
    if (node.id && node.id !== f.replace(/\.md$/, "")) errors.push(`${f}: id '${node.id}' != filename`);
    if (node.id && nodes[node.id]) errors.push(`${f}: duplicate id '${node.id}' (also in ${nodes[node.id].file})`);
    if (node.type === "correction" && !node.target) errors.push(`${f}: correction without target`);
    fileNodes.push(node);
    if (node.id) nodes[node.id] = node;
  }

  // Schemas load first: the registry the type/edge warnings check against is
  // the seed pack plus this graph's own ACTIVE schema nodes (proposed ones
  // are inert until approved — §2.4). Every schema node must still PARSE,
  // active or not — an unparseable proposal can never be approved, so it is
  // an error (exit 1) either way.
  const reg = seedRegistry(seedSchemas);
  for (const n of fileNodes) {
    if (n.type !== "schema") continue;
    const r = registry.parseSchemaNode(n);
    if (!r.ok) { errors.push(...r.errors.map((e) => `${n.file}: ${e}`)); continue; }
    if (schemaActive(n)) reg.add(r.schema, "graph");
  }

  // alias/inverse collisions (API.md §1): a schema claiming a name that
  // is (or that another schema already claims as) part of the edge
  // vocabulary makes normalization ambiguous.
  warnings.push(...reg.aliasCollisions().map((c) => `registry: ${c}`));

  // stale resident overrides (issue-cc-schema-override-seed-shadow): a
  // graph-resident schema at a lower version than the seed for the same type
  // silently masks seed behavior changes — graph beats seed wholesale.
  warnings.push(...reg.staleOverrides().map((c) => `registry: ${c}`));

  for (const n of fileNodes) {
    if (n.type && !reg.isKnownType(n.type)) warnings.push(`${n.file}: unknown type '${n.type}'`);
    if (!n.date) warnings.push(`${n.file}: missing date`);
    // wake: scheduled dormancy (QUEUE.md §4). An unparseable date fails open
    // to AWAKE in the queue — surfaced work beats silently hidden work — so
    // the mistake is flagged here instead.
    if (n.wake != null) {
      if (Number.isNaN(Date.parse(n.wake))) {
        warnings.push(`${n.file}: wake '${n.wake}' is not a parseable date (expected YYYY-MM-DD) — the item stays awake`);
      } else if (n.type && !reg.isQueueable(n.type) && n.type !== "schema") {
        warnings.push(`${n.file}: wake on non-queueable type '${n.type}' has no effect`);
      }
    }
  }

  // project identity (task-cc-project-identity-nodes): a slug two project
  // nodes both claim makes alias resolution ambiguous (first claim wins in
  // buildGraph, deterministically); a non-canonical slug never matches a
  // session's derived slug, so it is dead data.
  const slugClaims = new Map();
  for (const n of fileNodes) {
    if (n.type !== "project") continue;
    const m = (files[n.file] ?? "").match(/^slugs:\s*\[([^\]]*)\]/m);
    for (const s of (m?.[1] ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(s)) {
        warnings.push(`${n.file}: slug '${s}' is not kebab-case (^[a-z0-9][a-z0-9-]*$) and will never match a derived slug`);
      } else if (slugClaims.has(s) && slugClaims.get(s) !== n.id) {
        warnings.push(`registry: slug '${s}' is claimed by both '${slugClaims.get(s)}' and '${n.id}'`);
      } else {
        slugClaims.set(s, n.id);
      }
    }
  }

  for (const n of Object.values(nodes)) {
    for (const e of n.edges) {
      if (!reg.isKnownEdge(e.type)) warnings.push(`${n.file}: unknown edge type '${e.type}'`);
      if (!nodes[e.to]) warnings.push(`${n.file}: dangling edge ${e.type} -> ${e.to}`);
    }
  }

  const byType = {};
  for (const n of Object.values(nodes)) byType[n.type] = (byType[n.type] ?? 0) + 1;

  return { errors, warnings, byType, count: Object.keys(nodes).length, nodes };
}

module.exports = {
  parseFrontmatter,
  parseSeedSchemas,
  seedRegistry,
  buildRegistry,
  schemaActive,
  buildGraph,
  resolveProject,
  isArchivedProject,
  compile,
  renderSkeleton,
  validateNode,
  validateGraphFiles,
  rankAgainst,
  registry,
  DIGEST_CAP,
  DEFAULT_MIN_SIM,
};

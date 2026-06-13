// Spor schema registry — CalVer, schema-node parsing, upgrade chains,
// and the Registry lookup object. Plain Node, zero deps (QUEUE.md §2).
//
// A schema is an ordinary graph node (`type: schema`) whose declarative
// payload lives in a fenced ```json block in the body and whose attached code
// (validate / transitions / queueSignals / upgrade fns) lives in fenced ```js
// blocks. In rollout step 1 the code blocks are PARSED AND PRESERVED but never
// executed — no vm, no sandbox. Upgrade functions only run when supplied
// programmatically (synthetic schemas in tests); a markdown-sourced upgrade
// entry that would need to run throws instead.
//
// This module is pure: no fs, no knowledge of the frontmatter parser. It takes
// already-parsed node objects ({ id, kind, schema_version, body, ... }).
// Seed-pack loading and graph wiring live in lib/graph.js.
//
// Exports:
//   parseCalVer(s)                 -> { year, month, day, micro } | null
//   compareCalVer(a, b)            -> -1 | 0 | 1
//   validateUpgradeChain(chain, v) -> string[] errors (empty == ok)
//   parseSchemaNode(node)          -> { ok, errors, schema }
//   applyUpgrades(node, schema)    -> { node, applied, version }  (lazy, forward-only)
//   Registry                       -> the lookup object loadGraph builds
//   DEFAULT_EDGE_WEIGHT            -> 0.3 (weight for edges no schema weights)

// ---------- CalVer (swamp-style YYYY.MM.DD.MICRO) ----------

const CALVER_RE = /^(\d{4})\.(\d{2})\.(\d{2})\.(\d+)$/;

function parseCalVer(s) {
  const m = typeof s === "string" ? s.match(CALVER_RE) : null;
  if (!m) return null;
  const [, y, mo, d, micro] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || micro < 1) return null;
  return { year: y, month: mo, day: d, micro };
}

// Numeric tuple comparison; accepts strings or parsed objects. Throws on an
// invalid version — callers validate at parse time, so an invalid version
// here is a programming error, not data.
function compareCalVer(a, b) {
  const pa = typeof a === "string" ? parseCalVer(a) : a;
  const pb = typeof b === "string" ? parseCalVer(b) : b;
  if (!pa || !pb) throw new Error(`compareCalVer: invalid CalVer (${a} vs ${b})`);
  for (const k of ["year", "month", "day", "micro"]) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  return 0;
}

// ---------- upgrade chains ----------

// A chain is an ordered list of pure old-fields -> new-fields transforms:
//   [{ from: CalVer, to: CalVer, fn?: Function, fnName?: string }, ...]
// Rules (QUEUE.md §2.2, swamp's verbatim): chronological (each from < to,
// entries non-overlapping and increasing), and the last `to` must equal the
// schema's current schema_version. Forward-only — there are no downgrades.
function validateUpgradeChain(chain, schemaVersion) {
  const errors = [];
  if (chain == null) return errors;
  if (!Array.isArray(chain)) return [`upgrades must be an array`];
  for (const [i, up] of chain.entries()) {
    if (!up || typeof up !== "object") { errors.push(`upgrades[${i}] is not an object`); continue; }
    if (!parseCalVer(up.from)) errors.push(`upgrades[${i}].from '${up.from}' is not CalVer YYYY.MM.DD.MICRO`);
    if (!parseCalVer(up.to)) errors.push(`upgrades[${i}].to '${up.to}' is not CalVer YYYY.MM.DD.MICRO`);
    if (parseCalVer(up.from) && parseCalVer(up.to) && compareCalVer(up.from, up.to) >= 0) {
      errors.push(`upgrades[${i}] is not forward (from ${up.from} >= to ${up.to})`);
    }
    if (i > 0 && parseCalVer(chain[i - 1].to) && parseCalVer(up.from) &&
        compareCalVer(up.from, chain[i - 1].to) < 0) {
      errors.push(`upgrades[${i}] out of chronological order (from ${up.from} < previous to ${chain[i - 1].to})`);
    }
  }
  if (chain.length && parseCalVer(chain[chain.length - 1].to) && parseCalVer(schemaVersion) &&
      compareCalVer(chain[chain.length - 1].to, schemaVersion) !== 0) {
    errors.push(`last upgrade to ${chain[chain.length - 1].to} != schema_version ${schemaVersion}`);
  }
  return errors;
}

// Lazy migration machinery: bring a data node up to its schema's current
// version by applying the chain entries from the node's version forward.
// Pure — returns a new node object, never mutates the input. The caller (the
// write path, in a later rollout step) persists the result so each upgrade
// runs once per node.
function applyUpgrades(node, schema) {
  const chainErrors = validateUpgradeChain(schema.upgrades ?? [], schema.version);
  if (chainErrors.length) throw new Error(`invalid upgrade chain on ${schema.id}: ${chainErrors.join("; ")}`);

  const nodeV = node.schema_version ?? null; // null == pre-versioning: the whole chain applies
  if (nodeV != null) {
    if (!parseCalVer(nodeV)) throw new Error(`node ${node.id}: schema_version '${nodeV}' is not CalVer`);
    const c = compareCalVer(nodeV, schema.version);
    if (c === 0) return { node, applied: [], version: schema.version };
    if (c > 0) throw new Error(`node ${node.id} is at ${nodeV}, newer than schema ${schema.id} ${schema.version} — upgrades are forward-only`);
  }

  let cur = { ...node };
  const applied = [];
  for (const up of schema.upgrades ?? []) {
    if (nodeV != null && compareCalVer(up.from, nodeV) < 0) continue; // already past this hop
    if (typeof up.fn !== "function") {
      throw new Error(`upgrade ${up.from} -> ${up.to} on ${schema.id} has no executable fn (attached schema code is parsed but not executed in this build)`);
    }
    cur = { ...cur, ...up.fn(cur) };
    cur.schema_version = up.to;
    applied.push(up.to);
  }
  cur.schema_version = schema.version;
  return { node: cur, applied, version: schema.version };
}

// ---------- schema-node parsing ----------

const FENCE_RE = /^```(\w+)?[ \t]*\n([\s\S]*?)^```[ \t]*$/gm;
const EXPORT_RE = /export\s+(?:async\s+)?(?:function|const|let)\s+([A-Za-z_$][\w$]*)/g;
const KINDS = new Set(["node-schema", "edge-schema", "queue-policy"]);

// Takes an already-parsed graph node (frontmatter fields + body) and extracts
// the registry entry. Never throws on bad data; returns { ok, errors, schema }.
// schema: { id, kind, version, key, payload, code, codeBlocks, upgrades }
//   key     -> payload.node_type | payload.edge_type (what the registry indexes by)
//   code    -> { exportName: sourceString } across all fenced js blocks
//   upgrades-> payload.upgrades entries, code-by-name resolved to fnName only
//              (fn stays unset: markdown-attached code is not executed yet)
function parseSchemaNode(node) {
  const errors = [];
  const id = node.id ?? "?";

  if (!KINDS.has(node.kind)) {
    errors.push(`kind '${node.kind}' must be node-schema, edge-schema, or queue-policy`);
  }
  if (!parseCalVer(node.schema_version)) {
    errors.push(`schema_version '${node.schema_version}' is not CalVer YYYY.MM.DD.MICRO`);
  }

  // fenced blocks: first ```json block is the declarative payload; every
  // ```js block is preserved verbatim, with its named exports indexed.
  let payload = null;
  const codeBlocks = [];
  const code = {};
  FENCE_RE.lastIndex = 0;
  let m;
  while ((m = FENCE_RE.exec(node.body ?? "")) !== null) {
    const [, lang, src] = m;
    if (lang === "json" && payload === null) {
      try { payload = JSON.parse(src); } catch (e) {
        errors.push(`payload json block does not parse: ${String(e.message || e)}`);
        payload = undefined; // seen-but-broken: don't also report "missing"
      }
    } else if (lang === "js") {
      codeBlocks.push(src);
      EXPORT_RE.lastIndex = 0;
      let x;
      while ((x = EXPORT_RE.exec(src)) !== null) code[x[1]] = src;
    }
  }
  if (payload === null) errors.push(`no fenced \`\`\`json payload block in body`);
  if (payload && typeof payload !== "object") { errors.push(`payload must be a JSON object`); payload = undefined; }

  let key = null;
  if (payload && typeof payload === "object") {
    if (node.kind === "node-schema") {
      key = payload.node_type;
      if (typeof key !== "string" || !key) errors.push(`node-schema payload missing node_type`);
      else if (key === "schema") errors.push(`node_type 'schema' is native to the core and cannot be redefined`);
      if (payload.prefix != null) {
        const p = Array.isArray(payload.prefix) ? payload.prefix : [payload.prefix];
        if (!p.length || p.some((x) => typeof x !== "string" || !x)) errors.push(`prefix must be a non-empty string or array of strings`);
      }
    } else if (node.kind === "queue-policy") {
      // Singleton: the registry holds at most one (graph beats seed, higher
      // version wins). The blend lives in attached code — a `rank` export is
      // what rankQueue() calls — so a policy without one is inert by
      // construction and rejected here rather than silently ignored.
      key = "queue-policy";
      if (!code.rank) errors.push(`queue-policy schema has no attached \`\`\`js block exporting rank()`);
    } else if (node.kind === "edge-schema") {
      key = payload.edge_type;
      if (typeof key !== "string" || !key) errors.push(`edge-schema payload missing edge_type`);
      if (payload.weight != null && typeof payload.weight !== "number") errors.push(`weight must be a number`);
      // write-path normalization data (API.md §1): aliases rename in
      // place, inverse_label flips onto the target. Names must be edge-ish
      // strings and may not shadow this schema's own canonical type;
      // cross-schema collisions are caught at the Registry level.
      if (payload.aliases != null) {
        if (!Array.isArray(payload.aliases) || payload.aliases.some((a) => typeof a !== "string" || !a)) {
          errors.push(`aliases must be an array of non-empty strings`);
        } else if (payload.aliases.includes(key)) {
          errors.push(`alias '${key}' shadows the schema's own edge_type`);
        }
      }
      if (payload.inverse_label != null) {
        if (typeof payload.inverse_label !== "string" || !payload.inverse_label) {
          errors.push(`inverse_label must be a non-empty string`);
        } else if (payload.inverse_label === key) {
          errors.push(`inverse_label '${key}' shadows the schema's own edge_type`);
        }
      }
    }
    errors.push(...validateUpgradeChain(payload.upgrades, node.schema_version));
  }

  const upgrades = (payload && Array.isArray(payload.upgrades) ? payload.upgrades : []).map((up) => ({
    from: up.from, to: up.to,
    fnName: typeof up.fn === "string" ? up.fn : undefined,
    // fn stays undefined for markdown-sourced schemas; synthetic schemas built
    // in JS may carry real functions and applyUpgrades will run them.
  }));

  return {
    ok: errors.length === 0,
    errors,
    schema: errors.length === 0 ? {
      id: node.id, kind: node.kind, version: node.schema_version,
      key, payload, code, codeBlocks, upgrades,
    } : null,
  };
}

// ---------- the registry ----------

// Weight the compiler uses for edge types no schema assigns one (the historic
// `EDGE_WEIGHTS[type] ?? 0.3` default — also what provenance-only edge
// schemas like compiled-for fall back to).
const DEFAULT_EDGE_WEIGHT = 0.3;

// Lookup object replacing the hardcoded tables (QUEUE.md §2.2): EDGE_WEIGHTS,
// known node/edge types, id-prefix rules, the norm ride-along special case
// (always_on), and briefing/correction traversal exclusion (traversable:
// false). Resolution order: graph-resident schemas override/extend the seed
// pack; within a source, the higher schema_version wins.
//
// The `schema` node type itself is recognized natively (prefix `schema-`,
// traversable, never always-on) and cannot be redefined — no
// schema-for-schemas regress.
class Registry {
  constructor() {
    this.nodeSchemas = new Map(); // node_type -> schema (+ .source)
    this.edgeSchemas = new Map(); // edge_type -> schema (+ .source)
    this.queuePolicy = null;      // singleton queue-policy schema (+ .source), or null
    // key -> { graphId, graphVersion, seedVersion } when a graph-resident
    // schema wins over a STRICTLY NEWER seed entry for the same type — the
    // silent-shadow case (issue-cc-schema-override-seed-shadow). Surfaced as
    // validateGraph warnings via staleOverrides(); never affects resolution.
    this._staleShadows = new Map();
  }

  // Resolution: graph always beats seed; within a source the higher
  // schema_version wins. Returns the winning entry.
  static _prefer(existing, entry) {
    if (!existing) return entry;
    if (existing.source === "graph" && entry.source === "seed") return existing;
    if (existing.source === "seed" && entry.source === "graph") return entry;
    return compareCalVer(entry.version, existing.version) > 0 ? entry : existing;
  }

  // Record when a graph override shadows a newer seed: either a graph entry
  // already installed and a newer seed arrives, or a graph entry arrives over
  // an already-installed newer seed. Graph still wins (graph beats seed) — the
  // shadow is the point of the warning.
  _noteShadow(key, winner, loser) {
    if (!winner || !loser) return;
    if (winner.source === "graph" && loser.source === "seed" &&
        compareCalVer(loser.version, winner.version) > 0) {
      this._staleShadows.set(key, {
        graphId: winner.id, graphVersion: winner.version, seedVersion: loser.version,
      });
    }
  }

  // source: "seed" | "graph". Returns true if the entry was installed.
  add(schema, source) {
    const entry = { ...schema, source };
    if (schema.kind === "queue-policy") {
      const existing = this.queuePolicy;
      const winner = Registry._prefer(existing, entry);
      this._noteShadow("queue-policy", winner, winner === entry ? existing : entry);
      if (winner !== entry) return false;
      this.queuePolicy = entry;
      return true;
    }
    const map = schema.kind === "edge-schema" ? this.edgeSchemas : this.nodeSchemas;
    const existing = map.get(schema.key);
    const winner = Registry._prefer(existing, entry);
    this._noteShadow(schema.key, winner, winner === entry ? existing : entry);
    if (winner !== entry) return false;
    map.set(schema.key, entry);
    return true;
  }

  isKnownType(t) { return t === "schema" || this.nodeSchemas.has(t); }
  isKnownEdge(t) { return this.edgeSchemas.has(t); }

  edgeWeight(t) {
    const s = this.edgeSchemas.get(t);
    return s && typeof s.payload.weight === "number" ? s.payload.weight : DEFAULT_EDGE_WEIGHT;
  }

  prefixesFor(t) {
    if (t === "schema") return ["schema-"];
    const s = this.nodeSchemas.get(t);
    if (!s || s.payload.prefix == null) return null;
    return Array.isArray(s.payload.prefix) ? s.payload.prefix : [s.payload.prefix];
  }

  isTraversable(t) {
    if (t === "schema") return true;
    const s = this.nodeSchemas.get(t);
    return !(s && s.payload.traversable === false); // unknown types traverse, as before
  }

  isAlwaysOn(t) {
    const s = this.nodeSchemas.get(t);
    return !!(s && s.payload.always_on === true);
  }

  // Capture ingestion (QUEUE.md §2.3): which node/edge types the ingestion
  // model may draft against. Machinery types (briefing, correction,
  // capture-pending, the provenance edges, and `schema` itself) opt out via
  // capturable: false in their seed payload; org-added types default in.
  isCapturableType(t) {
    if (t === "schema") return false;
    const s = this.nodeSchemas.get(t);
    return !!(s && s.payload.capturable !== false);
  }

  isCapturableEdge(t) {
    const s = this.edgeSchemas.get(t);
    return !!(s && s.payload.capturable !== false);
  }

  // Decision-queue participation (QUEUE.md §4/§5): queueable: true on a
  // node-schema. Opt-in — the seed marks task and capture-pending.
  isQueueable(t) {
    const s = this.nodeSchemas.get(t);
    return !!(s && s.payload.queueable === true);
  }

  // ---- snapshots (back-compat exports in graph.js are derived from these) ----

  edgeWeights() {
    const out = {};
    for (const [t, s] of this.edgeSchemas) {
      if (typeof s.payload.weight === "number") out[t] = s.payload.weight;
    }
    return out;
  }
  knownNodeTypes() { return new Set(["schema", ...this.nodeSchemas.keys()]); }
  knownEdgeTypes() { return new Set(this.edgeSchemas.keys()); }

  // ---- write-path normalization data (API.md §1) ----

  // Same-direction synonyms -> canonical name. An alias that collides with a
  // canonical edge type is dropped (canonical wins, deterministically) and
  // reported by aliasCollisions().
  edgeRenames() {
    const out = {};
    for (const [t, s] of this.edgeSchemas) {
      for (const a of s.payload.aliases || []) {
        if (this.edgeSchemas.has(a)) continue; // canonical wins
        out[a] = t;
      }
    }
    return out;
  }

  // Inverse labels -> canonical name (the edge as read from the target's
  // side; the write path flips these onto the target node). Collisions with
  // canonical types are dropped, same policy as renames.
  edgeInverses() {
    const out = {};
    for (const [t, s] of this.edgeSchemas) {
      const inv = s.payload.inverse_label;
      if (typeof inv === "string" && inv && !this.edgeSchemas.has(inv)) out[inv] = t;
    }
    return out;
  }

  // Alias/inverse names that shadow a canonical edge type, or that two
  // schemas both claim — surfaced as validateGraph warnings.
  aliasCollisions() {
    const out = [];
    const claimed = new Map(); // name -> canonical type that claimed it
    for (const [t, s] of this.edgeSchemas) {
      const names = [...(s.payload.aliases || [])];
      if (typeof s.payload.inverse_label === "string" && s.payload.inverse_label) {
        names.push(s.payload.inverse_label);
      }
      for (const name of names) {
        if (this.edgeSchemas.has(name)) {
          out.push(`edge schema '${t}' claims '${name}' which is a canonical edge type`);
        } else if (claimed.has(name) && claimed.get(name) !== t) {
          out.push(`'${name}' is claimed by both '${claimed.get(name)}' and '${t}'`);
        } else {
          claimed.set(name, t);
        }
      }
    }
    return out;
  }

  // Graph-resident schema overrides that shadow a STRICTLY NEWER seed schema
  // for the same type (issue-cc-schema-override-seed-shadow). Graph beats seed
  // wholesale (QUEUE.md §2), so a stale resident override silently masks seed
  // behavior changes (gates, transitions, defaults) until it is bumped in
  // lockstep. Surfaced as validateGraph warnings, like aliasCollisions().
  staleOverrides() {
    const out = [];
    for (const [key, s] of this._staleShadows) {
      out.push(
        `graph schema '${s.graphId}' (${key} @ ${s.graphVersion}) shadows a newer seed schema ` +
        `(@ ${s.seedVersion}) — bump the resident override in lockstep with seed changes, or retire it`
      );
    }
    return out;
  }

  // One-line gloss per canonical edge type, for surfaces that advertise the
  // vocabulary (API.md §2: tool descriptions are generated from this).
  edgeVocabulary() {
    const out = [];
    for (const [t, s] of [...this.edgeSchemas].sort(([a], [b]) => a.localeCompare(b))) {
      out.push({
        type: t,
        description: typeof s.payload.description === "string" ? s.payload.description : "",
        inverse: typeof s.payload.inverse_label === "string" ? s.payload.inverse_label : null,
      });
    }
    return out;
  }
}

module.exports = {
  parseCalVer,
  compareCalVer,
  validateUpgradeChain,
  applyUpgrades,
  parseSchemaNode,
  Registry,
  DEFAULT_EDGE_WEIGHT,
};

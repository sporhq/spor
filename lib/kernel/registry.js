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
const KINDS = new Set(["node-schema", "edge-schema", "queue-policy", "policy", "register"]);

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
    errors.push(`kind '${node.kind}' must be one of: node-schema, edge-schema, queue-policy, policy, register`);
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
      // status disposition (dec-spor-definition-of-done-org-policy): the
      // resolving-status partition the kernel reads off the registry instead of
      // a hardcoded table. `non_resolving` lists the statuses in which a node of
      // this type, acting as a RESOLVER, does NOT retire its targets (a withdrawn
      // decision, an in-review change). Optional; unlisted statuses resolve.
      if (payload.status != null) {
        if (typeof payload.status !== "object" || Array.isArray(payload.status)) {
          errors.push(`status must be an object`);
        } else {
          // All three status partitions are optional string-arrays:
          // `non_resolving` (resolver semantics — does this node retire
          // others), `terminal` (own-lifecycle completion — read by
          // work-analytics, issue-spor-analytics-completion-ignores-schema-
          // terminal-status), and `inert` (queue-liveness-dead — the per-type
          // overlay isTerminalStatus reads; a schema that declares none
          // inherits its `terminal` set, dec-spor-status-inert-third-partition).
          for (const field of ["non_resolving", "terminal", "inert"]) {
            const v = payload.status[field];
            if (v != null && (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x))) {
              errors.push(`status.${field} must be an array of non-empty strings`);
            }
          }
        }
      }
    } else if (node.kind === "queue-policy") {
      // Singleton: the registry holds at most one (graph beats seed, higher
      // version wins). The blend lives in attached code — a `rank` export is
      // what rankQueue() calls — so a policy without one is inert by
      // construction and rejected here rather than silently ignored.
      key = "queue-policy";
      if (!code.rank) errors.push(`queue-policy schema has no attached \`\`\`js block exporting rank()`);
    } else if (node.kind === "policy") {
      // The org-defined policy layer (task-cc-policy-layer;
      // dec-spor-policy-layer-activate). NOT a singleton — many policies coexist
      // in one graph, each scoped by governs-traversal so teams within one org
      // carry different rules (dec-spor-definition-of-done-org-policy). The gate
      // lives in attached code: a `gate(current, proposed, view)` export the
      // write path runs AND-ed with the per-type transitions(), returning
      // { allow, reason? }. A policy without one is inert by construction and
      // rejected here rather than silently ignored. The native self-approval
      // floor stays BENEATH this layer (a policy cannot loosen it,
      // dec-cc-policy-floor-now-layer-deferred); policy nodes go through the
      // same proposal/activation flow they govern.
      //
      // `governs` is the scope selector (the traversal key): which nodes this
      // policy gates. `types` restricts to those node types, `projects` to those
      // project slugs; an absent or empty field means "any" (org-wide). The
      // registry keys policies by id (every policy is distinct), and
      // policiesFor(node) returns the applicable ones most-specific-first.
      key = node.id;
      if (!code.gate) errors.push(`policy schema has no attached \`\`\`js block exporting gate()`);
      if (payload.governs != null) {
        if (typeof payload.governs !== "object" || Array.isArray(payload.governs)) {
          errors.push(`governs must be an object`);
        } else {
          for (const field of ["types", "projects"]) {
            const v = payload.governs[field];
            if (v != null && (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x))) {
              errors.push(`governs.${field} must be an array of non-empty strings`);
            }
          }
        }
      }
    } else if (node.kind === "register") {
      // A registry-declared extensible enum — a named vocabulary the kernel
      // exposes as a partition (graph.registry.register(name)) instead of
      // owning a hardcoded table (dec-spor-orchestration-routine-requires-
      // threads thread 4: `requires:` is the first such register, the
      // risk/permission axis). Keyed by the register NAME (payload.register),
      // so a graph-resident register schema overrides/extends the seed one
      // wholesale — an org grows the enum by editing a schema node, no code
      // change. `classes` is the enum: an array of { id, description } objects;
      // readers (the dispatch matcher, the policy layer) read the ids off the
      // partition. The kernel only DECLARES the vocabulary here — validating a
      // node's `requires:` against it, and policy gating, are downstream.
      key = payload.register;
      if (typeof key !== "string" || !key) errors.push(`register payload missing register name`);
      if (payload.classes != null) {
        if (!Array.isArray(payload.classes) ||
            payload.classes.some((c) => !c || typeof c !== "object" || typeof c.id !== "string" || !c.id)) {
          errors.push(`register classes must be an array of { id, description } objects`);
        }
      }
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

// ---------- schema-kind slot table ----------
//
// Small pure helpers snapshot() renders every kind's entries with: the
// attached-hook names, the code blocks (only when { code: true }), and the
// common provenance triple. Module-level so the slot render() fns below can
// share them.
function hookNames(s) { return Object.keys((s && s.code) || {}).sort(); }
function codeOf(s, code) { return code ? { code: { ...((s && s.code) || {}) } } : {}; }
function prov(s) { return { schema_id: s.id, schema_version: s.version, source: s.source }; }

// The ONE place the inert-inherits-terminal default is decided
// (dec-spor-status-inert-third-partition): a node-schema payload's effective
// per-type inert overlay is its declared `status.inert`, or — when none is
// declared — its `status.terminal`. Both the SLOTS snapshot render and
// Registry.inertStatuses() read this, so the introspection surface and the
// runtime liveness check can never disagree about which source applies.
function inertSource(payload) {
  const st = payload && payload.status;
  const declared = st && Array.isArray(st.inert) ? st.inert : null;
  return {
    list: declared ?? (st && Array.isArray(st.terminal) ? st.terminal : []),
    inherited: !declared,
  };
}

// The canonical list of schema-kind storage slots (QUEUE.md §2.2): for each
// kind, which Registry field holds its winning entries (a Map keyed by the
// schema's `key`, or a singleton field for the one kind that has at most one
// live entry), and how to render one entry for the snapshot() introspection
// view. add(), staleOverrides(), and snapshot() all walk this table instead
// of hand-enumerating the five kinds separately — adding a sixth kind means
// adding one entry here, not touching three methods.
const SLOTS = [
  {
    kind: "node-schema", field: "nodeSchemas", singleton: false, snapshotKey: "node_types",
    render: (s, { code }) => ({
      type: s.key,
      description: typeof s.payload.description === "string" ? s.payload.description : "",
      prefix:
        s.payload.prefix == null
          ? null
          : Array.isArray(s.payload.prefix)
            ? s.payload.prefix
            : [s.payload.prefix],
      always_on: s.payload.always_on === true,
      traversable: s.payload.traversable !== false,
      capturable: s.payload.capturable !== false,
      queueable: s.payload.queueable === true,
      non_resolving:
        s.payload.status && Array.isArray(s.payload.status.non_resolving)
          ? s.payload.status.non_resolving
          : [],
      terminal:
        s.payload.status && Array.isArray(s.payload.status.terminal)
          ? s.payload.status.terminal
          : [],
      // The effective per-type inert overlay (queue-liveness-dead,
      // dec-spor-status-inert-third-partition): declared `status.inert`, or —
      // the inheritance default — the declared `status.terminal`, decided by
      // the shared inertSource() rule inertStatuses() also reads.
      // `inert_inherited` says which; the type-blind terminal-status register
      // is unioned in downstream (lib/kernel/resolution.js), never here.
      inert: inertSource(s.payload).list,
      inert_inherited: inertSource(s.payload).inherited,
      hooks: hookNames(s),
      ...prov(s),
      ...codeOf(s, code),
    }),
  },
  {
    kind: "edge-schema", field: "edgeSchemas", singleton: false, snapshotKey: "edge_types",
    render: (s, { code }) => ({
      type: s.key,
      description: typeof s.payload.description === "string" ? s.payload.description : "",
      weight: typeof s.payload.weight === "number" ? s.payload.weight : DEFAULT_EDGE_WEIGHT,
      weight_default: typeof s.payload.weight !== "number",
      inverse_label: typeof s.payload.inverse_label === "string" ? s.payload.inverse_label : null,
      aliases: Array.isArray(s.payload.aliases) ? s.payload.aliases : [],
      capturable: s.payload.capturable !== false,
      hooks: hookNames(s),
      ...prov(s),
      ...codeOf(s, code),
    }),
  },
  {
    // Singleton: the registry holds at most one (graph beats seed, higher
    // version wins). The blend lives in attached code — a `rank` export is
    // what rankQueue() calls.
    kind: "queue-policy", field: "queuePolicy", singleton: true, snapshotKey: "queue_policy",
    render: (s, { code }) => ({ ...prov(s), hooks: hookNames(s), ...codeOf(s, code) }),
  },
  {
    // NOT a singleton — many policies coexist in one graph, each scoped by
    // `governs`; keyed by id (every policy is distinct).
    kind: "policy", field: "policySchemas", singleton: false, snapshotKey: "policies",
    render: (s, { code }) => {
      const g = (s.payload && s.payload.governs) || {};
      return {
        ...prov(s),
        governs: {
          types: Array.isArray(g.types) ? g.types : [],
          projects: Array.isArray(g.projects) ? g.projects : [],
        },
        hooks: hookNames(s),
        ...codeOf(s, code),
      };
    },
  },
  {
    // Keyed by register name — a graph-resident register schema overrides/
    // extends the seed one wholesale.
    kind: "register", field: "registers", singleton: false, snapshotKey: "registers",
    render: (s) => ({
      name: s.key,
      classes: Array.isArray(s.payload.classes)
        ? s.payload.classes.map((c) => ({
            id: c.id,
            description: typeof c.description === "string" ? c.description : "",
          }))
        : [],
      ...prov(s),
    }),
  },
];
const SLOT_BY_KIND = new Map(SLOTS.map((s) => [s.kind, s]));

// [key, entry] pairs currently installed in a slot, regardless of whether it
// is backed by a Map (most kinds) or a singleton field (queue-policy).
function slotEntries(reg, slot) {
  if (slot.singleton) {
    const e = reg[slot.field];
    return e ? [[slot.kind, e]] : [];
  }
  return [...reg[slot.field]];
}

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
    this.policySchemas = new Map(); // id -> policy schema (+ .source); the
                                    // org-defined policy layer (kind: policy),
                                    // NOT a singleton — selected by scope.
    this.registers = new Map();     // name -> register schema (+ .source); the
                                    // registry-declared extensible enums (kind:
                                    // register), e.g. `requires` (the risk axis,
                                    // dec-spor-orchestration-routine-requires-
                                    // threads). Keyed by register name; graph
                                    // beats seed, higher CalVer wins.
    // `${kind}:${key}` -> highest seed schema_version ever add()-ed for that
    // slot, regardless of whether that seed entry won. This is END-STATE
    // bookkeeping (not a mid-traversal snapshot): staleOverrides() compares
    // the FINAL winning entry against this record, so the warning can't
    // depend on the order graph schema nodes were read off disk
    // (issue-spor-registry-stale-shadow-traversal-bug — the old approach
    // computed the shadow at add()-time by comparing whatever just arrived,
    // so a legacy graph override arriving before its own newer graph
    // replacement could latch a stale-shadow warning the replacement never
    // cleared).
    this._seedVersions = new Map();
  }

  // Resolution: graph always beats seed; within a source the higher
  // schema_version wins. Returns the winning entry.
  static _prefer(existing, entry) {
    if (!existing) return entry;
    if (existing.source === "graph" && entry.source === "seed") return existing;
    if (existing.source === "seed" && entry.source === "graph") return entry;
    return compareCalVer(entry.version, existing.version) > 0 ? entry : existing;
  }

  // Record the best (highest) seed version seen for a slot, so staleOverrides()
  // has an end-state bar to compare the eventual winner against.
  _recordSeedVersion(kind, key, version) {
    const k = `${kind}:${key}`;
    const cur = this._seedVersions.get(k);
    if (!cur || compareCalVer(version, cur) > 0) this._seedVersions.set(k, version);
  }

  // source: "seed" | "graph". Returns true if the entry was installed. Same
  // precedence for every kind (Registry._prefer: graph beats seed, higher
  // version wins within a source) — only the storage differs, and that
  // difference lives in the SLOTS table, not here.
  add(schema, source) {
    const entry = { ...schema, source };
    if (source === "seed") this._recordSeedVersion(schema.kind, schema.key, schema.version);

    const slot = SLOT_BY_KIND.get(schema.kind);
    const existing = slot.singleton ? this[slot.field] : this[slot.field].get(schema.key);
    const winner = Registry._prefer(existing, entry);
    if (winner !== entry) return false;
    if (slot.singleton) this[slot.field] = entry;
    else this[slot.field].set(schema.key, entry);
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

  // Resolution partition (dec-spor-definition-of-done-org-policy): the set of
  // statuses in which a node, acting as a RESOLVER, does NOT retire its targets.
  // Unioned across every node-schema's `status.non_resolving` (type-blind, like
  // the hardcoded NON_RESOLVING set it replaces in resolution.js). Lowercased.
  // The kernel reads this off graph.registry instead of owning a table; an org
  // reconfigures the bar by editing a schema node, no code change. Seed
  // assignments reproduce the old {rejected, abandoned} set byte-identically.
  nonResolvingStatuses() {
    const out = new Set();
    for (const s of this.nodeSchemas.values()) {
      const nr = s.payload.status && s.payload.status.non_resolving;
      if (Array.isArray(nr)) for (const v of nr) if (typeof v === "string" && v) out.add(v.toLowerCase());
    }
    return out;
  }

  // A resolver in this status retires its targets (the read-time completion
  // truth). Empty/unlisted statuses resolve; only declared non-resolving
  // statuses (withdrawn decisions, in-review changes) keep the target live.
  isResolvingStatus(status) {
    return !this.nonResolvingStatuses().has((status || "").toLowerCase());
  }

  // Lifecycle-terminal partition (issue-spor-analytics-completion-ignores-schema-
  // terminal-status): the statuses in which a node's OWN lifecycle is complete.
  // Distinct from BOTH nonResolvingStatuses() (resolver semantics — does this node
  // retire OTHERS) and resolution.js's type-blind TERMINAL set (queue liveness,
  // which a settled decision must stay OUT of so it keeps surfacing in briefings,
  // dec-spor-decision-lifecycle-surfacing). Work-analytics unions THIS with the
  // legacy set so a schema-only terminal status (decision `settled`) counts as
  // completion instead of lingering in WIP. Lowercased; empty when no schema
  // declares one (analytics then behaves exactly as before — byte-identical). The
  // registry is the contract — no hardcoded per-type table (dec-cc-registry-as-data).
  //
  // `type` (optional, task-spor-analytics-type-aware-inert-partition): when given,
  // returns ONLY that node type's own declared status.terminal, not the flat
  // union across every schema — the per-type slice work-analytics needs so one
  // type's declaration (artifact `released`) can't leak into how every OTHER
  // type is judged. Omitting `type` keeps the existing cross-type union
  // (unaffected, existing callers/tests). Mirrors inertStatuses(type)'s
  // per-type shape below, for the sibling status.terminal partition.
  terminalStatuses(type) {
    const out = new Set();
    if (type != null) {
      const s = this.nodeSchemas.get(type);
      const t = s && s.payload.status && s.payload.status.terminal;
      if (Array.isArray(t)) for (const v of t) if (typeof v === "string" && v) out.add(v.toLowerCase());
      return out;
    }
    for (const s of this.nodeSchemas.values()) {
      const t = s.payload.status && s.payload.status.terminal;
      if (Array.isArray(t)) for (const v of t) if (typeof v === "string" && v) out.add(v.toLowerCase());
    }
    return out;
  }

  // Per-type inert partition (dec-spor-status-inert-third-partition): the
  // statuses in which a node of THIS type is queue-liveness-dead — the set the
  // type-aware isTerminalStatus(status, type, graph) overlays onto the
  // type-blind terminal-status register. A schema that declares no
  // `status.inert` INHERITS its `status.terminal` set (the additive default —
  // most types' two partitions coincide), so only a schema whose sets genuinely
  // differ declares `inert` explicitly: the seed decision schema pins `settled`
  // terminal but NOT inert, keeping settled decisions live in queues and
  // briefings (dec-spor-decision-lifecycle-surfacing). The overlay is ADDITIVE
  // per type — union with the type-blind vocabulary happens in
  // lib/kernel/resolution.js, never here — so a declaration can scope an
  // org's status (artifact `released`) to its own type without removing any
  // universal completion word. Empty Set for an unknown type or a schema that
  // declares neither partition (those types read the type-blind vocabulary
  // alone, byte-identical to the pre-inert behavior). Lowercased.
  inertStatuses(type) {
    const out = new Set();
    const s = this.nodeSchemas.get(type);
    if (!s) return out;
    for (const v of inertSource(s.payload).list) if (typeof v === "string" && v) out.add(v.toLowerCase());
    return out;
  }

  // ---- registry-declared enums (kind: register) ----

  // The full payload of a named register (its `classes` array and any other
  // declared fields), or null when no schema declares it. The orchestration
  // layer's `requires:` risk-class register is the first
  // (dec-spor-orchestration-routine-requires-threads thread 4): a node's
  // `requires:` lists risk/permission classes the work touches; the dispatch
  // matcher and the org policy layer read the legal vocabulary off this
  // partition rather than a hardcoded table (the registry is the contract).
  register(name) {
    const s = this.registers.get(name);
    return s ? s.payload : null;
  }

  // The class ids of a named register, in declaration order ([] if undeclared).
  registerClasses(name) {
    const s = this.registers.get(name);
    const classes = s && Array.isArray(s.payload.classes) ? s.payload.classes : [];
    return classes.map((c) => c.id);
  }

  // The `requires:` risk-class vocabulary as a Set, the convenience the matcher
  // and policy gate read. Empty when no `requires` register is declared (a
  // graph with neither the register nor any `requires:` fields is unaffected).
  requiresClasses() {
    return new Set(this.registerClasses("requires"));
  }

  // ---- the org-defined policy layer (task-cc-policy-layer) ----

  // governs-traversal selection (dec-spor-policy-layer-activate): which policy
  // schemas govern a given node. A policy's `governs` block scopes it — `types`
  // restricts to those node types, `projects` to those project slugs; an absent
  // or empty list means "any" on that axis. A node is governed by every policy
  // whose every present axis matches it.
  //
  // Returned MOST-SPECIFIC-FIRST so a caller that wants "nearest governs wins"
  // (a project+type policy over an org-wide one) can take the head; the gate AND
  // runs them all regardless (a policy cannot loosen another — only deny adds).
  // Specificity is the count of matched scope axes, ties broken by id for
  // determinism. Pure: takes a {type, project} shape, no graph walk here — the
  // node's project is whatever the caller resolved (the `project:` stamp).
  policiesFor(node) {
    const type = node && node.type;
    const project = node && node.project;
    const matches = [];
    for (const p of this.policySchemas.values()) {
      const g = (p.payload && p.payload.governs) || {};
      const types = Array.isArray(g.types) ? g.types : null;
      const projects = Array.isArray(g.projects) ? g.projects : null;
      if (types && types.length && (!type || types.indexOf(type) === -1)) continue;
      if (projects && projects.length && (!project || projects.indexOf(project) === -1)) continue;
      const specificity =
        (types && types.length ? 1 : 0) + (projects && projects.length ? 1 : 0);
      matches.push({ schema: p, specificity });
    }
    matches.sort((a, b) =>
      b.specificity - a.specificity || (a.schema.id < b.schema.id ? -1 : 1));
    return matches.map((m) => m.schema);
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
    const check = (kind, key, entry) => {
      if (!entry || entry.source !== "graph") return;
      const seedVersion = this._seedVersions.get(`${kind}:${key}`);
      if (seedVersion && compareCalVer(seedVersion, entry.version) > 0) {
        out.push(
          `graph schema '${entry.id}' (${key} @ ${entry.version}) shadows a newer seed schema ` +
          `(@ ${seedVersion}) — bump the resident override in lockstep with seed changes, or retire it`
        );
      }
    };
    for (const slot of SLOTS) {
      for (const [key, entry] of slotEntries(this, slot)) check(slot.kind, key, entry);
    }
    return out;
  }

  // Graph-resident node-schema overrides that predate the status.inert
  // partition (dec-spor-status-inert-third-partition,
  // task-spor-validate-resident-override-inert-mismatch): an override
  // declaring `status.terminal` without its own `status.inert` silently
  // INHERITS its whole terminal set into queue-liveness (inertSource()'s
  // additive default) — even for a type whose SEED schema deliberately
  // narrows inert below terminal (the decision schema's settled-stays-live
  // pin). Since graph beats seed WHOLESALE (no field-level merge), such an
  // override resurrects statuses the seed excludes from inert — e.g.
  // silently retiring settled decisions from every queue and briefing. Takes
  // the pristine seed-only registry (pre-override) as the comparison
  // baseline, since `this` may already hold the winning (graph) entry in
  // place of the seed one. Flagged only for a type whose seed schema
  // actually partitions terminal/inert differently, and only when the
  // override does not declare its own `status.inert` — one that does is
  // assumed deliberate, whether or not it reproduces the seed's exact set.
  inertPartitionMismatches(seedReg) {
    const out = [];
    for (const [type, entry] of this.nodeSchemas) {
      if (entry.source !== "graph") continue;
      const status = entry.payload.status;
      if (status && Array.isArray(status.inert)) continue; // declared its own — deliberate
      // inert not declared -> this.inertStatuses(type) is exactly the
      // inertSource() inheritance default (the override's own terminal set).
      const overrideTerminal = this.inertStatuses(type);
      if (!overrideTerminal.size) continue;

      const seedEntry = seedReg.nodeSchemas.get(type);
      if (!seedEntry) continue;
      const seedInert = seedReg.inertStatuses(type);
      const seedTerminal = new Set(
        seedEntry.payload.status && Array.isArray(seedEntry.payload.status.terminal)
          ? seedEntry.payload.status.terminal.filter((v) => typeof v === "string" && v).map((v) => v.toLowerCase())
          : []
      );
      // The statuses the seed itself carves OUT of inert despite them being
      // terminal (settled, for decision) — the only ones a silently-inherited
      // override can wrongly resurrect. Intersecting with the override's own
      // terminal (rather than just subtracting seedInert from it) keeps a
      // status the override introduces that the seed never had an opinion on
      // at all from being misreported as something "the seed keeps out of
      // inert" — it isn't; the seed simply never declared it.
      const seedDiff = [...seedTerminal].filter((v) => !seedInert.has(v));
      if (!seedDiff.length) continue; // seed doesn't partition this type differently

      const diff = seedDiff.filter((v) => overrideTerminal.has(v));
      if (!diff.length) continue; // override's inherited overlay doesn't leak beyond seed's inert
      out.push(
        `graph schema '${entry.id}' (${type}) declares status.terminal without status.inert — it inherits ` +
        `${diff.join(", ")} into queue-liveness, but the seed schema for '${type}' keeps ${diff.length > 1 ? "them" : "it"} ` +
        `out of inert (dec-spor-status-inert-third-partition) — declare status.inert explicitly, or retire the override`
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

  // ---- full introspection snapshot (task-spor-schema-introspection-surface) ----

  // A complete, JSON-serializable view of the LIVE registry: every node and edge
  // type with its prefixes, weights, flags, status partition, and attached-hook
  // NAMES — each entry tagged with provenance (seed | graph | native), plus the
  // queue policy, the org policy layer, the registry-declared enums, and the
  // registry-health warnings. This is the one structure the `spor schema` CLI
  // verb, the REST `GET /v1/schema` endpoint, and the MCP schema tool all render,
  // so agents (and humans) introspect the contract HERE — reflecting graph-
  // resident overrides — instead of reverse-engineering it from lib/seed/ files,
  // which miss those overrides (norm-cc-registry-is-contract). Pure: no fs, no
  // graph walk. Pass { code: true } to also embed each hook's source (the
  // per-type detail / `?code=1` path); the default omits it so the list view and
  // the common API response stay lean.
  snapshot({ code = false } = {}) {
    // The `schema` node type is recognized NATIVELY by the core (prefix
    // `schema-`, traversable, never always-on/capturable/queueable) and is not
    // in nodeSchemas — surface it so the type list is complete and an introspecting
    // caller sees that schema-for-schemas is core, not redefinable.
    const nativeSchema = {
      type: "schema",
      description: "a node/edge type definition (the registry is data, QUEUE.md §2)",
      prefix: ["schema-"],
      always_on: false,
      traversable: true,
      capturable: false,
      queueable: false,
      non_resolving: [],
      terminal: [],
      inert: [],
      inert_inherited: true,
      hooks: [],
      schema_id: null,
      schema_version: null,
      source: "native",
      ...(code ? { code: {} } : {}),
    };

    // Every slot's rendered entries, keyed by its snapshotKey — the same
    // SLOTS table add()/staleOverrides() walk, so a sixth kind shows up here
    // automatically once it carries a render() fn.
    const rendered = {};
    for (const slot of SLOTS) {
      rendered[slot.snapshotKey] = slotEntries(this, slot).map(([, s]) => slot.render(s, { code }));
    }

    const node_types = [nativeSchema, ...rendered.node_types].sort((a, b) => a.type.localeCompare(b.type));
    const edge_types = rendered.edge_types.sort((a, b) => a.type.localeCompare(b.type));
    const queue_policy = rendered.queue_policy[0] ?? null;
    const policies = rendered.policies.sort((a, b) => a.schema_id.localeCompare(b.schema_id));
    const registers = rendered.registers.sort((a, b) => a.name.localeCompare(b.name));

    return {
      default_edge_weight: DEFAULT_EDGE_WEIGHT,
      node_types,
      edge_types,
      queue_policy,
      policies,
      registers,
      stale_overrides: this.staleOverrides(),
      alias_collisions: this.aliasCollisions(),
    };
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

// Spor attached-code sandbox — QUEUE.md §2.4 v1. Plain Node, zero deps
// (node:vm is a builtin).
//
// Executes the fenced ```js code attached to schema nodes: validate /
// transitions / queueSignals (and future verbs). The functions are PURE by
// contract: data in, data out — and this sandbox enforces the mechanical half
// of that contract:
//
//   - fresh vm context per schema, nothing from the host realm in scope
//     (no require, no process, no host globals)
//   - codeGeneration disabled (no eval / new Function escape)
//   - no clock, no randomness (Date removed, Math.random throws)
//   - intrinsics frozen after load (no prototype patching between calls)
//   - a per-call timeout (v1 fuel limit)
//   - arguments and results cross the boundary as JSON — host objects never
//     leak in, guest objects never leak out
//
// Sandboxing secures EXECUTION, not semantics — the review gate (the schema
// proposal flow) is what secures semantics. The hardening path is the same
// JS-in-wasm sandbox chosen for lenses; this is the controlled-box v1.

const vm = require("node:vm");

const DEFAULT_TIMEOUT_MS = 100;
const EXPORT_RE = /export\s+(?:async\s+)?(?:function|const|let)\s+([A-Za-z_$][\w$]*)/g;
const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

// Named exports of a module-style attached-code block. Shared with the
// server's wasm engine (server/sandbox.js) so both engines agree on what is
// callable.
function parseExports(code) {
  const names = [];
  EXPORT_RE.lastIndex = 0;
  let m;
  while ((m = EXPORT_RE.exec(code)) !== null) {
    if (IDENT_RE.test(m[1])) names.push(m[1]);
  }
  return names;
}

// Compile one schema's attached code into a callable sandbox.
//   createSandbox(code) -> { call(name, args[], opts?) -> value, names: [...] }
// Throws if the code itself fails to parse/evaluate.
function createSandbox(code, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const names = parseExports(code);

  const context = vm.createContext({}, {
    codeGeneration: { strings: false, wasm: false },
  });

  // Strip the export keywords (the code is authored module-style) and collect
  // the named exports into __fns__ inside the guest realm.
  const stripped = code.replace(/^\s*export\s+/gm, "");
  const setup = `
    "use strict";
    var __fns__ = (function () {
      ${stripped}
      return { ${names.map((n) => `${n}: (typeof ${n} !== "undefined" ? ${n} : undefined)`).join(", ")} };
    })();
    // determinism: no clock, no randomness, frozen intrinsics.
    Date = undefined;
    Math.random = function () { throw new Error("attached code may not use randomness"); };
    [Object, Array, Function, String, Number, Boolean, JSON, Math, RegExp, Error].forEach(function (C) {
      try { Object.freeze(C); if (C.prototype) Object.freeze(C.prototype); } catch (e) {}
    });
    undefined;
  `;
  vm.runInContext(setup, context, { timeout: timeoutMs });

  return {
    names,
    has: (name) => names.includes(name),
    // call: JSON in, JSON out, timeout enforced on the guest invocation.
    call(name, args = [], opts = {}) {
      if (!IDENT_RE.test(name) || !names.includes(name)) {
        throw new Error(`no attached export '${name}'`);
      }
      context.__argsJson__ = JSON.stringify(args);
      const out = vm.runInContext(
        `JSON.stringify(__fns__.${name}.apply(null, JSON.parse(__argsJson__)) ?? null)`,
        context,
        { timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS }
      );
      return JSON.parse(out);
    },
  };
}

// Memoized per-schema sandboxes keyed by schema id + version + code, so hot
// paths (queue ranking, write validation) compile each schema's code once.
// The key carries the full source: keying on src.length collided distinct
// same-length code bodies under the same id+version, serving a stale sandbox.
const _cache = new Map();
function sandboxFor(schema) {
  const src = schema.codeBlocks && schema.codeBlocks.length ? schema.codeBlocks.join("\n") : null;
  if (!src) return null;
  const key = `${schema.id}@${schema.version}:${src}`;
  let sb = _cache.get(key);
  if (!sb) {
    sb = createSandbox(src);
    _cache.set(key, sb);
  }
  return sb;
}

module.exports = { createSandbox, sandboxFor, parseExports, DEFAULT_TIMEOUT_MS };

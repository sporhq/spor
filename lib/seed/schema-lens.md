---
id: schema-lens
type: schema
kind: node-schema
schema_version: 2026.06.10.2
title: Seed schema for lens nodes
summary: Node schema for the lens type — a view over the graph defined by declarative query/render json blocks in the body, an optional sandboxed js custom-render escape hatch, and an optional actions block binding write affordances to registry transitions. Not traversable and not capturable — lenses are interface, not knowledge. Seed-pack mirror of the GRAPH.md ontology; a graph-resident schema node for this type overrides it.
date: 2026-06-10
---

Seed schema for the `lens` node type (ontology in GRAPH.md), shipped with the
plugin as a registry default (QUEUE.md §2). A `type: schema` node in the graph
with `kind: node-schema` and the same `node_type` overrides this entry.

A view over the graph is itself a graph node (dec-lenses-as-nodes), so it is
versioned, attributed, shareable, and forkable by copying the node. The body
carries fenced blocks — `## query` (declarative select/traverse/group/sort,
JSON) and `## render` (builtin renderer config, JSON), plus an optional
`## custom` js block executed in the same no-clock/no-randomness sandbox as
schema attached code. Running a lens is deterministic: a pure function of
(graph snapshot, lens node, params, now). A lens is parameterized at the node
it `focuses-on` (schema-edge-focuses-on): the runner resolves `"$focus"` in the
query from that edge when no runtime parameter is given.

A lens body may also carry an optional `## actions` fenced json block — an
array of declarative write affordances `{id, label, on?, set, confirm?}`
(dec-ui-actions-as-transitions). `on` is a select-style clause choosing which
rendered items carry the affordance (omitted means all); `set` is a flat object
of frontmatter field changes (scalars, or `"$param"` bindings resolved from
lens params at render time) and may never change `id` or `type`. Invoking an
action is exactly one revision-checked node update through the ordinary write
path, arbitrated fail-closed by the TARGET schema's `transitions()` gate — the
lens declares intent, the renderer surfaces it, the registry decides legality.
Only trusted renderer hosts turn actions into controls; the `## custom` sandbox
never sees or invokes them.

`traversable: false` keeps lenses out of compiler lineage walks — a lens says
what someone wants to look at, not what the graph knows. `capturable: false`
for the same reason the machinery types opt out (briefing, correction): a lens
is authored deliberately against a query language, never drafted from a capture
or a distilled transcript.

The attached `validate` gate rejects lens nodes whose blocks would not run.

```json
{
  "node_type": "lens",
  "description": "a view over the graph — declarative query/render blocks, optional sandboxed custom render, optional declarative actions bound to registry transitions",
  "prefix": [
    "lens-"
  ],
  "traversable": false,
  "capturable": false
}
```

```js
export function validate(node) {
  const errors = [];
  const body = node.body || "";
  const fence = /^##\s*(query|render|custom|actions)\s*\n+```(?:json|js)\n([\s\S]*?)```/gm;
  const blocks = {};
  let m;
  while ((m = fence.exec(body)) !== null) blocks[m[1]] = m[2];
  if (!blocks.query) errors.push("lens body must carry a '## query' fenced json block");
  for (const k of ["query", "render", "actions"]) {
    if (blocks[k]) {
      try { JSON.parse(blocks[k]); }
      catch (e) { errors.push("'" + k + "' block is not valid JSON: " + e.message); }
    }
  }
  if (blocks.render) {
    try {
      if (JSON.parse(blocks.render).as === "custom" && !blocks.custom) {
        errors.push("render.as=custom requires a '## custom' js block");
      }
    } catch (e) { /* already reported above */ }
  }
  if (blocks.actions) {
    let acts = null;
    try { acts = JSON.parse(blocks.actions); } catch (e) { /* already reported above */ }
    if (acts !== null) {
      if (!Array.isArray(acts)) {
        errors.push("'actions' block must be a JSON array");
      } else {
        const seen = {};
        acts.forEach(function (a, i) {
          const where = "actions[" + i + "]";
          if (!a || typeof a !== "object" || Array.isArray(a)) { errors.push(where + " must be an object"); return; }
          if (typeof a.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(a.id)) {
            errors.push(where + ".id must be a kebab-case string");
          } else if (seen[a.id]) {
            errors.push("duplicate action id '" + a.id + "'");
          } else { seen[a.id] = true; }
          if (typeof a.label !== "string" || !a.label) errors.push(where + ".label must be a non-empty string");
          if (!a.set || typeof a.set !== "object" || Array.isArray(a.set) || !Object.keys(a.set).length) {
            errors.push(where + ".set must be a non-empty object of frontmatter field changes");
          } else {
            for (const k of Object.keys(a.set)) {
              const v = a.set[k];
              if (k === "id" || k === "type") errors.push(where + ".set may not change '" + k + "'");
              if (v !== null && typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
                errors.push(where + ".set." + k + " must be a scalar ('$param' string bindings allowed)");
              }
            }
          }
          if (a.on !== undefined && (!a.on || typeof a.on !== "object" || Array.isArray(a.on))) {
            errors.push(where + ".on must be a select-style clause object");
          }
          if (a.confirm !== undefined && typeof a.confirm !== "boolean") {
            errors.push(where + ".confirm must be a boolean");
          }
          for (const k of Object.keys(a)) {
            if (["id", "label", "on", "set", "confirm"].indexOf(k) === -1) {
              errors.push(where + " has unknown key '" + k + "'");
            }
          }
        });
      }
    }
  }
  return errors;
}
```

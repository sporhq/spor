---
id: schema-lens-actions
type: schema
kind: node-schema
schema_version: 2026.06.10.2
project: wf
title: Lens v2 — adds the declarative actions block (write affordances as transition bindings)
summary: Proposed revision of schema-lens adding an optional '## actions'
  fenced json block - declarative write affordances ({id, label, on, set,
  confirm}) that bind UI buttons to ordinary revision-checked node updates,
  arbitrated by the target schema's transitions() gate. The lens declares
  intent; the renderer surfaces it; the registry decides legality. On
  activation this supersedes schema-lens (same node_type, higher
  schema_version wins).
date: 2026-06-10
status: active
---

Revision of the lens node type (dec-ui-actions-as-transitions made real):
alongside `## query` / `## render` / `## custom`, a lens body may carry an
optional `## actions` fenced json block — an array of declarative write
affordances:

```
[
  { "id": "start",  "label": "Start",
    "on": { "type": "task", "status": "open" },
    "set": { "status": "in-progress" } },
  { "id": "close",  "label": "Mark done", "confirm": true,
    "on": { "type": "task", "status": ["open", "in-progress"] },
    "set": { "status": "done" } }
]
```

Semantics — deliberately nothing new in the write path:

- `on` is a select-style clause (same predicate language as `## query`
  select) choosing which rendered items carry the affordance; omitted means
  all items.
- `set` is a flat object of frontmatter field changes — scalars or
  `"$param"` bindings resolved from lens params at render time (an
  unresolved binding disables the affordance). `id` and `type` can never
  be set. Body and edge edits are out of scope for this revision.
- Invoking an action is exactly one revision-checked node update through
  the existing server write path: current frontmatter + `set`, attributed
  to the invoking identity. The TARGET schema's `transitions()` gate
  arbitrates, fail-closed — a button is a typed, reviewed graph transition
  with a label, and the guardrails for agent-authored UI are the registry
  itself, not the lens.
- The view tree carries actions as data ({id, label, confirm} per matching
  item); only trusted renderer hosts turn them into controls and issue the
  update. The `## custom` sandbox never sees or invokes actions.

Existing lens nodes are untouched (`actions` is optional — no upgrade
chain needed). The attached `validate` gate extends the v1 checks:
actions must be a JSON array of {id, label, on?, set, confirm?} with
kebab-case unique ids, non-empty scalar-valued `set`, and no unknown keys.

```json
{
  "node_type": "lens",
  "description": "a view over the graph — declarative query/render blocks, optional sandboxed custom render, optional declarative actions bound to registry transitions",
  "prefix": ["lens-"],
  "traversable": false
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

---
id: schema-workspace
type: schema
kind: node-schema
schema_version: 2026.06.10.1
project: wf
title: Workspace — a per-persona composition of lenses, layout as data
summary: Node schema for the workspace type (dec-workspaces-as-nodes) - a
  composition of lens nodes with layout as data in a '## layout' fenced json
  block ({columns?, slots: [{lens, title?, span?, params?}]}) and composes
  edges mirroring the slots. Versioned, attributed, forkable by copying the
  node; agent-draftable mid-meeting. traversable false - interface, not
  knowledge.
date: 2026-06-10
status: active
---

The `workspace` node type: persona home surfaces (leadership OKRs, VP
capacity, sales release radar, engineer blocking view, PM discovery board)
are workspace nodes — each a grid of lenses. The body carries one fenced
block:

```
## layout   ```json   { columns?: 1|2|3, slots: [{ lens, title?, span?, params? }] }
```

Slot `params` pin lens parameters (scalars, or "$name" forwarded from the
workspace's own query params); `span` lets a slot take two columns. Every
slot's lens must also be a `composes` edge and vice versa, so composition
is queryable from the edge index without parsing bodies. Rendering a
workspace is a pure function of (graph snapshot, workspace node, params,
now): each slot runs through the lens engine and the result is one view
tree (as: workspace) interpreted by the same trusted hosts.

```json
{
  "node_type": "workspace",
  "description": "a per-persona composition of lenses — layout as data, composes edges to the lenses it arranges",
  "prefix": ["workspace-"],
  "traversable": false
}
```

```js
export function validate(node) {
  const errors = [];
  const m = /^##\s*layout\s*\n+```json\n([\s\S]*?)```/m.exec(node.body || "");
  if (!m) { errors.push("workspace body must carry a '## layout' fenced json block"); return errors; }
  let layout = null;
  try { layout = JSON.parse(m[1]); }
  catch (e) { errors.push("'layout' block is not valid JSON: " + e.message); return errors; }
  if (!layout || typeof layout !== "object" || Array.isArray(layout)) { errors.push("layout must be an object"); return errors; }
  for (const k of Object.keys(layout)) {
    if (["columns", "slots"].indexOf(k) === -1) errors.push("layout has unknown key '" + k + "'");
  }
  if (layout.columns !== undefined && [1, 2, 3].indexOf(layout.columns) === -1) {
    errors.push("layout.columns must be 1, 2, or 3");
  }
  if (!Array.isArray(layout.slots) || !layout.slots.length) {
    errors.push("layout.slots must be a non-empty array");
    return errors;
  }
  const slotLenses = {};
  layout.slots.forEach(function (s, i) {
    const where = "slots[" + i + "]";
    if (!s || typeof s !== "object" || Array.isArray(s)) { errors.push(where + " must be an object"); return; }
    if (typeof s.lens !== "string" || s.lens.indexOf("lens-") !== 0) {
      errors.push(where + ".lens must be a lens node id (lens-…)");
    } else { slotLenses[s.lens] = true; }
    if (s.title !== undefined && (typeof s.title !== "string" || !s.title)) errors.push(where + ".title must be a non-empty string");
    if (s.span !== undefined && [1, 2].indexOf(s.span) === -1) errors.push(where + ".span must be 1 or 2");
    if (s.params !== undefined) {
      if (!s.params || typeof s.params !== "object" || Array.isArray(s.params)) {
        errors.push(where + ".params must be an object");
      } else {
        for (const k of Object.keys(s.params)) {
          const v = s.params[k];
          if (v !== null && typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
            errors.push(where + ".params." + k + " must be a scalar ('$name' forwarding allowed)");
          }
        }
      }
    }
    for (const k of Object.keys(s)) {
      if (["lens", "title", "span", "params"].indexOf(k) === -1) errors.push(where + " has unknown key '" + k + "'");
    }
  });
  const edgeLenses = {};
  for (const e of node.edges || []) if (e.type === "composes") edgeLenses[e.to] = true;
  for (const id of Object.keys(slotLenses)) {
    if (!edgeLenses[id]) errors.push("slot lens '" + id + "' has no composes edge");
  }
  for (const id of Object.keys(edgeLenses)) {
    if (!slotLenses[id]) errors.push("composes edge to '" + id + "' matches no slot");
  }
  return errors;
}
```

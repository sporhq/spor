# Authoring and changing Spor schemas

Node and edge types are **data, not code**. Each type is a `type: schema`
node. The set Spor runs on is assembled at load time from two layers: the seed
pack shipped in `lib/seed/` (the defaults) and any schema nodes resident in
your graph, which override the seed entry of the same `node_type`/`edge_type`
**wholesale**.

So you extend or change the ontology by writing a node — usually a
graph-resident schema node carrying an org-specific rule. That is deliberately
easy mechanically and deliberately disciplined contractually. Read both halves
below before you do it.

## A schema node's shape

Frontmatter: `id: schema-<type>` (or `schema-edge-<type>`), `type: schema`,
`kind: node-schema` or `edge-schema`, a CalVer `schema_version`
(`YYYY.MM.DD.MICRO`), a `title`, a stand-alone `summary`, and a `date`. The
body holds prose, then a fenced **JSON payload**, then optional fenced **JS
functions**.

### Node schema — JSON payload keys

```json
{
  "node_type": "task",
  "description": "active or planned work",
  "prefix": ["task-"],
  "queueable": true,
  "always_on": false,
  "traversable": true,
  "capturable": true,
  "status": { "non_resolving": ["abandoned"] }
}
```

- `node_type` / `prefix` — the type and its id prefix(es).
- `queueable` — may appear in the decision queue.
- `always_on` — rides along in every project-relevant compile (norms). A
  norm INSTANCE can narrow that ride-along to specific repos with flat
  `applies_to_tags:`/`applies_to_repos:`/`applies_to_projects:` frontmatter
  keys (not schema flags) — see concepts.md "Ride-along flags".
- `traversable: false` — excluded from lineage walks (briefings, corrections).
- `capturable: false` — never produced by the capture/ingest path.
- `status.non_resolving` — statuses that count as *not* resolving for the
  completion gate (an `abandoned` task resolves nothing).

Note what the payload does **not** hold: there is no field list and no status
*enum*. Extra frontmatter fields are allowed as-is — a custom `severity:` line
on your nodes just works, no declaration needed. To *require* a field or pin a
status to a fixed set, enforce it in the attached functions below, not in JSON.

### Edge schema — JSON payload keys

```json
{
  "edge_type": "blocks",
  "description": "target cannot proceed until this node does",
  "weight": 0.7,
  "inverse_label": "blocked-by",
  "aliases": ["block"]
}
```

- `weight` — decay across compile hops (1.0 structural → 0.3 weak).
- `inverse_label` — how the edge reads from the target; inverse forms are
  accepted on write and flipped onto the target.
- `aliases` — same-direction synonyms normalized to the canonical spelling.

### Attached behavior (optional JS)

A schema may carry fenced `js` blocks exporting **pure** functions, run
server-side in a sandbox (no I/O, no clock) at the JSON boundary. The one most
types use:

- `transitions(current, proposed, view)` — gate a status change; runs on
  **update only** (the create path is ungated). Return `{allow: true}` or
  `{allow: false, reason: "..."}`. Make the reason actionable: a writing agent
  reads it and retries. This is also where you pin a type's legal status set —
  reject any proposed status outside it. `current` is the stored node (`null` if
  unparseable), `proposed` the incoming one, and `view` a read-only join the
  server computes: `view.resolvers` (live inbound `resolves`/`answers` edges,
  pre-filtered to resolving states), `view.targets`, `view.actor`,
  `view.approvals`, `view.non_resolving_statuses`. (The task type's gate uses
  `view.resolvers` to require a resolving `decision`/`artifact` before `done`.)

Two more hooks are supported but unused by the seed types:

- `validate(node)` — runs at the door on **every write (create and update)**.
  Extra field checks beyond the base validator (e.g. "a `severity` is required
  and must be one of …"). Return a list of error message strings, `[]` meaning
  valid; the server prefixes each with `<schema-id> validate():`. The sandbox
  passes only the node — there is no second argument.
- `queueSignals(node, ctx)` — contribute a `{name: number}` map of ranking
  signals to the decision queue.

To read a real, current attached function, fetch a live schema:
`spor get schema-task` shows a two-gate `transitions`. (The seed schemas also
ship in the plugin's `lib/seed/` if you have a checkout.)

### A complete example

A custom `escalation` type — queueable, with an `open → mitigated → closed`
status machine and a required `severity` — is one whole node. The outer fence
is shown with four backticks only so the inner blocks display; in the file you
write, use normal three-backtick fences.

````markdown
---
id: schema-escalation
type: schema
kind: node-schema
schema_version: 2026.06.16.0
title: Customer escalation
summary: A customer escalation tracked open -> mitigated -> closed, with a severity.
date: 2026-06-16
---

Escalations as first-class, queueable nodes, so live ones surface in the queue
and the mitigation history is kept.

```json
{
  "node_type": "escalation",
  "description": "a customer escalation and its mitigation lineage",
  "prefix": ["esc-"],
  "queueable": true,
  "status": { "non_resolving": ["closed"] }
}
```

```js
const SEVERITIES = ["sev1", "sev2", "sev3"];
const FLOW = { open: ["mitigated", "closed"], mitigated: ["closed", "open"], closed: ["open"] };

export function validate(node) {
  if (!node.severity) return ["escalation requires a severity"];
  if (!SEVERITIES.includes(node.severity)) return [`severity must be one of: ${SEVERITIES.join(", ")}`];
  return [];
}

export function transitions(current, proposed) {
  const from = (current && current.status) || "";
  const to = (proposed && proposed.status) || "";
  if (!to || to === from) return { allow: true };
  if ((FLOW[from] || []).includes(to)) return { allow: true };
  return { allow: false, reason: `escalation can't go ${from || "(new)"} -> ${to}; allowed: ${(FLOW[from] || []).join(", ") || "(none)"}` };
}
```
````

An escalation node then just carries `severity: sev2` in its frontmatter and
moves through the gated statuses. The `transitions` contract here is exactly
what the seed `schema-task` uses (`spor get schema-task` to see a live one);
`validate` follows the validator's usual error-list convention.

## Activating a schema (remote)

When you write a schema node through the server, it is forced to
`status: proposed` (any payload status is discarded) and stays **inert** until
a *different* identity flips it to `active` — there is no self-approval. It
surfaces in the decision queue as a `suggest: approve` item; a human (or a
second agent) reviews and runs `set_status schema-<type> active`. Locally
there's no ingester, so you write the file yourself (e.g.
`$SPOR_HOME/nodes/schema-escalation.md`) and it's live once it validates.

## The discipline

Changing a schema is a contract change — every node of that type, and every
reader of them, depends on it. Treat it with care:

1. **Prefer a graph-resident override to a seed edit.** If only your graph
   needs a rule, write a schema node *in your graph* that overrides the seed
   entry — don't fork the seed pack. The seed is the shared default for
   everyone; your override is yours alone and travels with your graph.
2. **Version honestly.** Bump `schema_version` (CalVer) with a migration only
   when the change is **not** backward-readable. If existing nodes still parse
   and mean the same thing — a new write-time gate, a new optional field —
   it's backward-readable: no node-shape change, no migration needed. The seed
   `schema-task` gates are written this way; each header notes whether it
   needed an upgrade chain.
3. **Keep the payload and any attached functions consistent.** A schema whose
   `transitions()` rejects a status its own `description` advertises will
   frustrate every writer. Test the change (below) before relying on it.

(If you're *contributing to the plugin itself* by editing the seed pack rather
than overriding it in your graph, more has to stay in step — the GRAPH.md docs,
the distiller prompts, the bundled skills, and the test suite — and such
refactors must stay byte-identical against a real graph. Most users never need
this: an org rule belongs in a graph-resident schema, not a seed fork.)

## Sanity checks

```bash
spor validate                    # lint the graph; fix anything it flags
spor get schema-<type>           # read back the effective schema your graph will use
spor compile --root <id>         # confirm a node of the new type compiles cleanly
```

If the automatic distiller starts emitting an edge variant you didn't define,
that's a schema gap — add or adjust the edge schema rather than accepting the
stray form.

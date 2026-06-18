---
id: schema-profile
type: schema
kind: node-schema
schema_version: 2026.06.18.1
title: Seed schema for profile nodes
summary: Node schema for the profile type — a reusable runtime+capability bundle (harness, model, skills, plugins, mcp) an agent runs under. The runtime fields ARE the dispatch satisfiability spec the machine-capabilities matcher reads; there is no separate requirements block. Personal AND org-published with personal override. Seed-pack default; a graph-resident schema node for this type overrides it.
date: 2026-06-18
---

Seed schema for the `profile` node type (ontology in GRAPH.md), shipped with the
plugin as a registry default (QUEUE.md §2). A `type: schema` node in the graph
with `kind: node-schema` and the same `node_type` overrides this entry.

A profile is the orchestration layer's runtime+capability bundle — "the HOW" —
that an `agent` (schema-agent, "the WHO") dispatches under
(dec-spor-agent-orchestration-layer). Factoring it out of the agent node makes
the toolset reusable across agents and people, and gives dispatch one structured
declaration to parameterize a launch from.

Instances carry, beyond the standard fields (`id`, `type`, `title`, `summary`,
`date`), the runtime register — all flat values the regex frontmatter parser
already supports:

- `harness:` — the launcher/adapter the work runs under (`claude-code` |
  `codex` | `opencode` | …), operationalizing dec-cc-portable-core-adapters
  (claude-code → `claude --bg`, codex/opencode → their CLIs). A flat scalar.
- `model:` — the model id passed to the harness (`--model`). A flat scalar.
- `skills:` / `plugins:` / `mcp:` — inline lists of the skills, plugins, and MCP
  servers the harness preloads; `mcp` is merged into the strict `--mcp-config`
  dispatch writes so the agent's toolset is exactly the profile plus the
  agent-spor server, nothing ambient (dec-spor-session-identity-active-record).

**These runtime fields ARE the satisfiability spec** — there is no separate
requirements block (dec-spor-machine-profile-satisfiability, FORK A). A machine
declares ATOMIC capabilities in a machine-local `dispatch.capabilities` map, and
`satisfies(machine, profile)` is `profile.harness ∈ machine.harnesses ∧
profile.mcp ⊆ machine.reachable_mcp ∧ profile.skills ⊆ machine.skills ∧
profile.plugins ⊆ machine.plugins ∧ profile ∉ machine.deny`. The matcher and the
machine-local map are the deferred build this schema unblocks
(task-spor-dispatch-capabilities-satisfiability); the same atomic vocabulary is
forward-compatible with the deferred remote fleet scheduler (each agent publishes
its capabilities to the server). This schema only fixes the profile's field
contract that match reads.

**Reusable + both-scoped, with override.** Profiles are PERSONAL (you author
your own) AND ORG-PUBLISHED (the org curates a vetted toolset, e.g.
`profile-docs-writer`), with personal override. Org-published profiles are where
this meets policy — the org policy layer (dec-spor-policy-layer-activate) can
require that work of a given risk class be assigned to an agent whose profile is
org-approved (curated-toolset-as-governance). That gating lives in policy nodes,
not in this schema. An agent references its DEFAULT profile with a `uses-profile`
edge (schema-edge-uses-profile), overridable per assignment (the `assigned →
agent` edge's `profile:` attribute, schema-edge-assigned) or per dispatch
(`--profile`); cascade precedence is `--profile` flag > assignment-edge attribute
> agent's default.

`status:` is declarative (`active` by default; any other status, or none, reads
as before) — not gated by a `transitions()` enum, so the type stays
backward-readable. `capturable: false`: a profile is created deliberately (by a
person curating a toolset, or an org publishing one), never drafted from a
capture or distilled from a transcript — mirroring `agent`, `person`, `repo`,
and `workflow-run`. Graphs without profile nodes behave exactly as before.

```json
{
  "node_type": "profile",
  "description": "a reusable runtime+capability bundle an agent runs under — harness, model, skills, plugins, mcp; its runtime fields are the dispatch satisfiability spec",
  "prefix": [
    "profile-"
  ],
  "capturable": false
}
```

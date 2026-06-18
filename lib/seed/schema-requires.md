---
id: schema-requires
type: schema
kind: register
schema_version: 2026.06.18.1
title: Seed schema for the requires risk-class register
summary: Registry-declared extensible enum (kind register) for the `requires:` risk/permission axis — the classes of capability a piece of work may touch (shell, prod-creds, browser, network, human, filesystem-write, paid-api). DISTINCT from machine-satisfiability: this is what the WORK needs, validated against the assigned profile and gated by org policy. The kernel exposes the vocabulary as a partition (graph.registry.requiresClasses()); reading/gating is downstream. Seed default; a graph-resident register schema for this name overrides/extends it.
date: 2026-06-18
---

Seed schema for the `requires` register (ontology in GRAPH.md), shipped with the
plugin as a registry default (QUEUE.md §2). It declares a named, extensible
vocabulary — not a node or edge type. A `type: schema` node in the graph with
`kind: register` and `register: requires` overrides/extends this entry, so an org
grows the enum by editing a schema node, never by a code change (the registry is
the contract).

`requires:` is the risk/permission axis (dec-spor-orchestration-routine-requires-
threads thread 4): a flat list on a work node (`requires: [shell, prod-creds]`)
naming the classes of capability the work may touch. It is **DISTINCT from
machine-satisfiability** — that asks "can this box LAUNCH the assigned profile"
(harness/mcp/skills present, derived from the profile's runtime fields, decides
dispatch; dec-spor-machine-profile-satisfiability). `requires:` asks "what is this
work allowed to touch", validated against the assigned agent's profile (a task's
`requires:` must be ⊆ the profile's granted classes, else warn/refuse —
under-equipped or over-privileged) and gated by org policy.

The kernel stays policy-free: it only DECLARES the vocabulary and exposes it as a
partition (`graph.registry.requiresClasses()` / `register("requires")`), the same
way the resolving-status partition is read off the registry rather than a
hardcoded table. The org policy layer reads it via the same governs-traversal the
definition-of-done quorum gate uses (dec-spor-definition-of-done-org-policy):
the nearest governing policy node decides which classes need which approvals and
which agents may hold them. Validating a node's `requires:` against the register,
the profile match, and the policy gate are the deferred build this unblocks
(task-spor-dispatch-capabilities-satisfiability); this schema only fixes the
vocabulary.

`human` is special: it is unsatisfiable by ANY agent — work that needs a human
(an irreversible real-world action, e.g. delegating Namecheap NS to Cloudflare)
is assigned to a person, not an agent. The seed set is deliberately small;
org-extend it with a resident register schema.

```json
{
  "register": "requires",
  "description": "the risk/permission classes a piece of work may touch — validated against the assigned profile and gated by org policy; DISTINCT from machine-satisfiability",
  "classes": [
    { "id": "shell", "description": "runs arbitrary shell commands on the host" },
    { "id": "prod-creds", "description": "uses production credentials or secrets" },
    { "id": "browser", "description": "drives a real web browser / does web automation" },
    { "id": "network", "description": "makes outbound network calls beyond the Spor server" },
    { "id": "human", "description": "needs a human — unsatisfiable by any agent; assign to a person" },
    { "id": "filesystem-write", "description": "writes to the filesystem outside a scratch/worktree sandbox" },
    { "id": "paid-api", "description": "calls a metered/paid external API" }
  ]
}
```

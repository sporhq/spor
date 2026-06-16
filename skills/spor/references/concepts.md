# Spor concepts reference

The full ontology behind the orientation in SKILL.md. The seed pack
(`lib/seed/`) is the source of truth; an org's graph-resident `type: schema`
nodes override or extend it. Anything here may be overridden in a given graph
— check the effective schema in your own graph (`spor get schema-<type>`) when
exactness matters.

## Node types

One file per type at `lib/seed/schema-<type>.md`. "Queueable" = can appear in
the decision queue (QUEUE.md §4).

| type | id prefix | purpose | notes |
|---|---|---|---|
| decision | `dec-` | a choice that was made, with the why | status `active`/`superseded`/`rejected`; a **rejected** decision is a dismissed approach — keep the reason |
| task | `task-` | active or planned work | status `open`/`active`/`done`/`abandoned`; queueable; `done` needs a resolving `decision`/`artifact` (see SKILL routing → /spor:next) |
| issue | `issue-` | a defect and its resolution lineage | status `open`/`active`/`resolved`; queueable |
| incident | `inc-` | something that went wrong in operation | queueable |
| artifact | `art-`, `spec-` | a document, spec, module, or build product | optional delivery status `in-review`/`approved`/`merged`/`released` |
| norm | `norm-` | a standing convention or constraint | `always_on: true` — rides along in every project-relevant compile (capped to the topically relevant subset) |
| briefing | `brief-` | a compiled briefing (output of the system) | `traversable: false` (never walked) and `capturable: false` |
| correction | `corr-` | a standing fix to a briefing (pin/exclude/guidance) | `traversable: false`; applied at every future compile of its target |
| question | `question-` | a routed ask the graph couldn't answer | queueable; status `open`/`answered`; joins the queue until answered |
| person | `person-` | an org member | anchor for `$viewer` binding and question routing |
| capture-pending | `cap-` | raw captured text that fit no schema | born status-less; closes only as `merged` or `rejected` |
| finding | `find-` | a gardener observation (stale anchor, cold work) | filed as a queue item |
| repo | `repo-` | a durable git-repo identity | carries `slugs:` aliases + `fingerprints:`; heals renames at read time |
| project | `proj-` | a stable grouping above repos | owns members via inbound `grouped-under` edges; owns no slugs/fingerprints itself |
| workflow | `wf-` | a repeatable automation DAG | created `proposed`, inert until activated; queueable |
| workflow-run | `run-` | one execution of a workflow | queueable when stuck; `capturable: false` |

## Edge types

One file per type at `lib/seed/schema-edge-<type>.md`. Written **source →
target**. `weight` sets how much the edge decays across compile hops (high =
structural). `inverse_label` is how the edge reads from the target's side;
inverse forms are accepted on write and **flipped onto the target**. `aliases`
are same-direction synonyms renamed at write time.

| edge | weight | meaning (source → target) | inverse / aliases |
|---|---|---|---|
| supersedes | 1.0 | this replaces the target; target is stale | inverse `superseded-by`; alias `supercedes` |
| constrained-by | 1.0 | the target limits what this may do | — |
| governed-by | 0.95 | the target is the norm/policy this falls under | — |
| derived-from | 0.9 | this was produced from the target | alias `derives-from` |
| decided-in | 0.9 | the choice here was made in the target | — |
| resolves | 0.9 | this fixes/closes the target | — |
| triggered-by | 0.7 | this run was triggered by the target | — |
| performs | 0.8 | this run is an execution of the target workflow | — |
| blocks | 0.7 | the target can't proceed until this does | inverse `blocked-by` |
| answers | 0.7 | this answers the target question | inverse `answered-by` |
| assigned | 0.5 | work assigned to this person | — |
| relates-to | 0.5 | weak association | alias `related-to` |
| mentions | 0.5 | weakest association | — |
| stewards | 0.4 | this person stewards the target area/spec/norm | question-routing key |
| grouped-under | 0.3 | this repo's home project grouping (structural) | inverse `groups` |
| routed-to | 0.3 | this question is routed to that person | — |
| compiled-for | — | briefing → the task/query it was compiled for | provenance only |
| shaped-by | — | briefing → the corrections that shaped it | provenance only |

**Ride-along flags** (set in a schema's JSON payload):
- `always_on: true` (norm) — injected into every project-relevant compile.
- `traversable: false` (briefing, correction) — excluded from lineage walks.
- `capturable: false` (briefing, workflow-run) — never produced by capture.

Don't invent edge variants. The automatic distiller sometimes emits forms like
`related-to`/`supercedes`/`derives-from`; those normalize to the canonical
spelling on write — they're the *only* accepted non-canonical forms. A genuinely
new relationship needs a new edge schema (see `authoring-schemas.md`).

## Node file format

A node is one markdown file; `id` = filename minus `.md`. The frontmatter
parser is **regex-based, not a YAML library** — it supports simple
`key: value`, YAML folded multi-line values (indented continuations),
`pin:`/`exclude:` inline lists, and `- {type: X, to: Y}` edges. Don't use any
other YAML construct.

```markdown
---
id: dec-export-csv-format        # required; kebab-case, starts with the type prefix
type: decision                   # required; a type in the registry
project: meridian                # the repo/project slug (legacy spelling: repo:)
title: Export defaults to CSV    # required; a one-line human title
summary: One or two sentences that stand entirely on their own.  # required
status: active                   # optional; the legal set is enforced by the type's schema, not listed here
date: 2026-06-09                 # required; the EVENT date (not creation date), YYYY-MM-DD
edges:
  - {type: derived-from, to: spec-export-schema}
  - {type: supersedes, to: dec-export-json-only}
---

The body — a few paragraphs at most. Shown at full resolution when the node
scores high in a compile, so write for a reader with zero session context. If
a load-bearing reason exists ("because the release is Friday"), record it here.
One fact per node; if you're writing "and also…", split it.
```

Server-stamped fields you don't set by hand: `author`, `authored_via`. Other
type-specific fields exist (`wake:` dormancy date; `commits:` linked git shas;
`pin:`/`exclude:` on corrections; `slugs:`/`fingerprints:` on repo nodes;
`roles:`/`queue_mute:` on person nodes) — see GRAPH.md for the complete list.

Validate any local node you write: `spor validate` (or
`node lib/validate.js`), and fix what it flags.

## Project slug convention

A node's `project:` stamp and most reads are scoped by a **project slug**,
derived from the session's cwd:

1. A committed `.spor` marker file wins — `repo: <slug>` (legacy `project:`),
   read from the nearest ancestor (cwd → repo root), so a monorepo subtree
   marker can split one repo into distinct identities. The value must already
   be canonical (`^[a-z0-9][a-z0-9-]*$`); a non-matching value is ignored.
2. Otherwise: the kebab-cased basename of `git rev-parse --show-toplevel`
   (lowercased, runs of non-alphanumerics → `-`, trimmed). `My_Repo` →
   `my-repo`.
3. A git **worktree** infers from its main repo's basename, so every worktree
   of one repo shares one identity.

The client and server compute the slug identically, so a slug derived locally
always matches what the server expects (the canonical form is
`^[a-z0-9][a-z0-9-]*$`). A repo's home is a `type: project` grouping it sits
under via a `grouped-under` edge;
project-scoped reads union every repo grouped under that project, and a bare
repo slug resolves *up* to its grouping. Renaming a repo changes its slug;
`type: project`/`type: repo` identity nodes with `slugs:` alias lists heal that
at read time so old `project:` stamps still match.

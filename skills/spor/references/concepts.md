# Spor concepts reference

The full ontology behind the orientation in SKILL.md. The seed pack
(`lib/seed/`) is the default; an org's graph-resident `type: schema` nodes
override or extend it. Anything here may be overridden in a given graph, so
**don't reverse-engineer the contract from `lib/seed/` files** — that misses
resident overrides. Introspect the LIVE registry instead:

- `spor schema` — the whole ontology (every node/edge type, prefixes, weights,
  flags, status partition), seed + resident overrides merged, each entry tagged
  by provenance (seed / graph / native).
- `spor schema <type>` — one type in detail, including its
  `validate()`/`transitions()`/`get()` gate source.
- `spor schema --json` — the machine snapshot (the same shape the server's
  `GET /v1/schema` returns). Remote mode reflects the server's live registry.

## Node types

One file per type at `lib/seed/schema-<type>.md`. "Queueable" = can appear in
the decision queue (QUEUE.md §4).

| type | id prefix | purpose | notes |
|---|---|---|---|
| decision | `dec-` | a choice that was made, with the why | status `active`/`superseded`/`rejected`/`settled`; a **rejected** decision is a dismissed approach — keep the reason; **settled** = in force but acknowledged as just-context, exempt from the gardener decay-sweep (optional `reviewed_at` ISO scalar snoozes it) |
| task | `task-` | active or planned work | status `open`/`active`/`done`/`abandoned`; queueable; `done` needs a resolving `decision`/`artifact` (see SKILL routing → /spor:next) |
| issue | `issue-` | a defect and its resolution lineage | status `open`/`active`/`resolved`; queueable; `resolved` needs a resolving `decision`/`artifact` (see SKILL routing → /spor:next) |
| incident | `inc-` | something that went wrong in operation | queueable |
| artifact | `art-`, `spec-` | a document, spec, module, or build product | optional delivery status `in-review`/`approved`/`merged`/`released` |
| norm | `norm-` | a standing convention or constraint | `always_on: true` — rides along in every project-relevant compile (capped to the topically relevant subset); narrow it to specific repos with `applies_to_tags:`/`applies_to_repos:`/`applies_to_projects:`; `couples_when:`/`couples_also:` file globs make it a coupling norm (edit-time "changed X, don't forget Y" nudge — see below) |
| briefing | `brief-` | a compiled briefing (output of the system) | `traversable: false` (never walked) and `capturable: false` |
| correction | `corr-` | a standing fix to a briefing (pin/exclude/guidance) | `traversable: false`; status `active`/`applied` (default active — fires at every in-scope compile until a recompile absorbs it and retires it to `applied`) |
| question | `question-` | a routed ask the graph couldn't answer | queueable; status `open`/`answered`; joins the queue until answered |
| person | `person-` | an org member | mutable `name` display label plus anchor for `$viewer` binding and question routing |
| organization | `org-` | a durable organization identity anchor | `member-of-org` records membership; `stewards` records org-admin authority; `org-root` remains the virtual graph-wide operator anchor; `capturable: false` |
| agent | `agent-` | a person-owned automation principal | a dispatched session's durable identity; owned by a person via `owned-by`; `capturable: false`; carries forward-compat `spiffe:`/`pubkey:` |
| profile | `profile-` | a reusable runtime+capability bundle an agent runs under | `harness`/`model`/`skills`/`plugins`/`mcp`; these runtime fields ARE the dispatch satisfiability spec; `capturable: false` |
| routine | `routine-` | owner-scoped trigger→action automation | `owned-by` a person; declarative `when → do` rules over graph events; dispatches only the owner's agents, AND-ed with org policy; `capturable: false` |
| capture-pending | `cap-` | raw captured text that fit no schema | born status-less; closes only as `merged` or `rejected` |
| finding | `find-` | a gardener observation (stale anchor, cold work) | filed as a queue item |
| repo | `repo-` | a durable git-repo identity | carries `slugs:` aliases + `fingerprints:`; heals renames at read time; optional `tags:` are the match key for a norm's `applies_to_tags` |
| project | `proj-` | a stable grouping above repos | owns members via inbound `grouped-under` edges; owns no slugs/fingerprints itself |
| workflow | `wf-` | a repeatable automation DAG | created `proposed`, inert until activated; queueable |
| workflow-run | `run-` | one execution of a workflow | queueable when stuck; `capturable: false` |
| lens | `lens-` | a saved view over the graph (`render_lens`) | body carries a required `## query` json block plus optional `## render`/`## custom`/`## actions` blocks; parameterized by a `focuses-on` edge (`"$focus"`); `traversable: false` and `capturable: false` |

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
| blocks | 0.7 | the target can't proceed until this does | inverse `blocked-by`; also program membership — member `blocks` umbrella, rendered by `render_program` |
| answers | 0.7 | this answers the target question | inverse `answered-by` |
| assigned | 0.5 | work assigned to this person OR agent (explicit routing; an agent target may carry a `profile:` per-assignment override) | — |
| relates-to | 0.5 | weak association | alias `related-to` |
| mentions | 0.5 | weakest association | — |
| stewards | 0.4 | this person stewards the target area/spec/norm | question-routing key |
| member-of-org | 0.3 | this person is a member of the target organization | inverse `has-org-member`; structural identity, not admin authority; `capturable: false` |
| grouped-under | 0.3 | this repo's home project grouping (structural) | inverse `groups` |
| owned-by | 0.3 | this agent is owned by that person (structural identity) | inverse `owns` |
| uses-profile | 0.3 | this agent's default profile (runtime+capability bundle); structural config, overridable per assignment/dispatch | — |
| routed-to | 0.3 | this question is routed to that person | — |
| focuses-on | 0.2 | this lens is parameterized on that node (resolves `"$focus"` in its query) | `capturable: false` |
| compiled-for | — | briefing → the task/query it was compiled for | provenance only |
| shaped-by | — | briefing → the corrections that shaped it | provenance only |

**Ride-along flags** (set in a schema's JSON payload):
- `always_on: true` (norm) — injected into every project-relevant compile.
- `traversable: false` (briefing, correction, lens) — excluded from lineage walks.
- `capturable: false` (briefing, workflow-run, agent, lens) — never produced by capture.

An `always_on` norm rides along project-wide by default, but that scope is the
whole home-project **grouping** — so under a project that spans heterogeneous
repos (a terraform repo, a Go service, a Python service) a `uv` norm would bleed
into all three. Narrow it with flat per-instance selectors on the norm node
(not the schema): `applies_to_tags: [python]` (matched against the session
repo's `tags:`), `applies_to_repos: [repo-x]`, `applies_to_projects: [proj-y]`.
A norm that declares any `applies_to_*` and matches none is **excluded** —
including in a repo with no `tags:` — so repo tagging is the opt-in (set a
repo's tags with `spor repos tag <slug> <tag...>`; `spor repos tags` lists
them). A norm with none keeps the default project-wide ride-along.

A norm may also declare **coupling anchors** — two flat inline lists that turn
it into a *coupling norm* ("when X changes, Y must change too"):

```
couples_when: [lib/seed/**, skills/spor/**]     # trigger file globs
couples_also: [GRAPH.md, API.md]                 # what changes with them
```

When a session edits a file matching a trigger, the post-tool hook injects the
targets as a nudge (once per session per norm, deterministic, no LLM). Globs
are repo-root-relative: `**` crosses path segments, `*` stays within one, a
trailing `/` means the whole subtree, and a bare `API.md` anchors at the root.
An entry may be **repo-qualified** as `<slug>:<glob>` to couple artifacts
across repos (e.g. `couples_when: [spor-docs:src/content/**]` on a norm
stamped to another project) — a qualified trigger fires only in that repo and
bypasses the norm's scope, while unqualified entries follow the norm's
`applies_to_*`/`project:` scope (unstamped = every repo, the org-wide case:
`couples_when: [.nvmrc]`, `couples_also: [Dockerfile]`). Both keys are
required; either alone is inert. Author one whenever you fix (or cause) a
"changed X, forgot the coupled Y" miss — that is the moment the coupling is
proven.

`spor check` is the boundary-time twin of that nudge: it checks a diff
(uncommitted by default; `--staged` / `--range a..b` / `--files`) against the
same coupling norms and reports triggers-touched-but-targets-not — advisory,
or `--strict` for CI. For mechanical couplings add a **value invariant** the
checker compares byte-level instead of guessing from touched-ness:

```
couples_value_a: .nvmrc#v?(\d+)              # <path>#<regex>, first capture = value
couples_value_b: Dockerfile#FROM node:(\d+)
```

Agreeing values suppress the "untouched" heuristic; disagreeing values are
reported even when both files were edited. Both `_a`/`_b` are required and
ride only on a coupling norm.

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

Server-stamped fields you don't set by hand: `author`, `authored_via` (plus `authored_by_agent` +
`session`, with `authored_via: dispatch`, on a write made under an agent-scoped
token — the node reads "agent on behalf of person"). Other
type-specific fields exist (`wake:` dormancy date; `commits:` linked git shas;
`pin:`/`exclude:` on corrections; `slugs:`/`fingerprints:`/`tags:` on repo nodes;
`applies_to_tags:`/`applies_to_repos:`/`applies_to_projects:` ride-along
selectors on norms; `roles:`/`queue_mute:`/`register:` on person nodes, `register` being the
free-text "how to talk to this reader" language-style field viewer-facing
surfaces render verbatim) — see GRAPH.md for the complete list.

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

---
name: correct
description: Record a standing correction to a Spor briefing (pin/exclude nodes, add guidance). Use when the user says a briefing was wrong, missed something, or included something stale — debug the context, not the model.
---

# Record a correction

Corrections are nodes. They persist in the graph and are applied at every
future compile of their target — a context fix made once applies forever.

One command records it — `spor correct` resolves the graph (local vs team) on
its own; you never test `SPOR_SERVER` or branch on mode. The correction goes to
whichever graph the briefing came from (remote mode POSTs it to the server so it
affects the team's compiles; local mode writes a `corr-…` node file). Don't echo
`SPOR_SERVER`/`SPOR_TOKEN`/`SPOR_HOME` or announce the mode unless the user asks.

```bash
spor correct <target> "<guidance>" [--pin <id>] [--exclude <id>] [--title "<one line>"]
```

The command builds, validates, and commits the correction (remote: the server
mints the `corr-<target>-<n>` id; local: it writes the node file and validates).
`--pin`/`--exclude` are repeatable. **In Cowork (no shell)**, call the
`propose_correction` MCP tool with the same fields instead.

## 1. Pick the target — corrections fire only when their target is in scope

- a **node id** (the node the bad briefing was compiled for — check
  `compiled-for` edges on the briefing node): fires when that node is the
  compile root or one of the nodes a query matched. The right scope for a fix
  about one specific topic; it applies in query/digest mode too, not just
  root-mode briefings (issue-cc-corrections-silent-noop-query-mode).
- `project:<slug>`: fires on every compile for that project (the slug resolves
  through project aliases, so a historical name still matches). Use this for
  project-wide guidance.
- `global`: fires on EVERY compile, for every project and teammate — the
  broadest scope. Reserve it for graph-wide norms; prefer `project:<slug>` when
  the guidance is project-specific.

## 2. Establish what went wrong, from the user or the conversation

- a relevant node was missed → `--pin <id>`. Pinned/excluded values must be
  existing node ids (the command rejects non-ids / warns on missing ones); if
  the knowledge isn't a node yet, create it first (`spor add` or `put_node`),
  then pin it.
- an irrelevant/stale node was included → `--exclude <id>`.
  - exception: if the irrelevant node is a **norm bleeding in across repos**
    (e.g. a `uv` norm showing up in a terraform or Go brief under the same
    project), the durable fix is to scope the norm at its source — add
    `applies_to_tags:`/`applies_to_repos:`/`applies_to_projects:` to the norm
    node and `tags:` to the repos (see GRAPH.md / concepts.md) — not a
    per-briefing `--exclude` you'd have to repeat everywhere it bleeds.
- emphasis/framing was wrong → free-text guidance (the positional argument).

## 3. Verify it applies

Recompile the target and confirm the pinned/excluded nodes and guidance show up:
`spor compile --root <target>` (or `spor brief <target>` for a node id, or
`spor compile --query "<text>"` for a query-scoped correction). The guidance
appears under a `## CORRECTIONS` heading in the compiled neighborhood.

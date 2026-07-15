---
name: defer
description: Capture deferred or discovered work into the Spor graph the moment it appears — an out-of-scope fix, a follow-up, a dismissed approach, a "we should really…". One call; the server types it, links it, and resurfaces it when a session next works nearby. Use whenever work is being postponed instead of done, or when the user says to remember/file/defer something.
---

# Capture deferred work

Discovered work dies in TODO comments. Capture it instead: the Spor graph
resurfaces it automatically the moment a future session touches its
neighborhood — no backlog grooming required (QUEUE.md §1/§3).

Write 2-3 standalone sentences: WHAT the work is and WHY it was deferred
(the deferral reason is often itself a decision worth keeping). Include
concrete names (files, endpoints, node ids). Do not pick node types or ids —
the server's ingestion model does that against the live schema registry.

## Capture it

One command — `spor add` resolves the graph (local vs team), the project slug,
and your identity on its own, and types the node (remotely the server's
ingestion model; locally a well-formed, validated file):

```bash
spor add "<the 2-3 sentences>"
```

If this discovery happened while working a known graph node (check the session's
briefing/digest for its id), link it with `--during <node-id>` — a provenance
edge so the capture traces back to the work it came from. Don't echo
`SPOR_SERVER`/`SPOR_TOKEN`/`SPOR_HOME` or announce the mode unless the user asks.

Read what it prints and tell the user, briefly:

- `captured: <ids>` — report the node id(s) and what landed. Done.
- `captured (pending)` — the text fit no schema; it was preserved as a `cap-…`
  node for later triage. Say so; nothing is lost.
- an `offline` / `error 503` line — the team graph's ingestion is unreachable or
  down. The capture is spooled to the outbox, not lost; it ships on the next Spor
  session, or run `spor drain` once the server is back to flush it now.

**In Cowork (no shell)**, call the `capture` MCP tool with the same fields
(`text`, `project`, `during`, and the `blocks`/`needed_by` below).

## Declaring a cross-project dependency

When the deferred work is something *another* team/repo must do for the
current initiative — the kind of cross-cutting dependency that otherwise gets
discovered late (task-cc-xproject-dependency-loop) — declare it so it surfaces
in the SERVING team's queue from day one, on both sides:

```bash
spor add "<the 2-3 sentences>" --project <serving-slug> --blocks <requester-id> --needed-by 2026-07-15
```

- `--project` is the **serving** project slug (who must do the work), NOT the
  current session's slug.
- `--blocks` is the node id of the requesting work this dependency blocks — it
  must already exist (create the requester first if needed).
- `--needed-by` is a `YYYY-MM-DD` deadline. Unlike `wake` (which hides a node
  until its date), `needed_by` keeps it visible and ramps its queue urgency as
  the date nears.

The server attaches the `blocks` edge and `needed_by` deterministically (not via
the model): a missing `--blocks` target returns `404`, a non-date `--needed-by`
returns `422` — both before any model call. Locally, the same flags write the
edge and the `needed_by:` field onto the node directly. In Cowork, pass the same
`blocks`/`needed_by` fields to the `capture` MCP tool.

## Capturing several pieces of work at once

When one deferral splits into several nodes — "these three things, in this
order" — the ordering is part of the capture, not a follow-up. `spor add` types
and links each node, but it never infers build order across a batch, and the
queue takes its dependency signal only from `blocks` edges. Ordering left in the
prose is invisible to `spor next`, which then surfaces the cohort backwards
(issue-spor-agent-missing-dependency-edges).

The `--blocks` flag above is not just for cross-project work: it wires the edge
in the same call whenever the node this one gates already exists. So capture the
dependent first, then the thing that gates it:

```bash
spor add "<the dependent work>"                       # -> task-tenant-api
spor add "<the prerequisite>" --blocks task-tenant-api
```

Where that doesn't fit — a batch already captured, or an order you only worked
out afterwards — add the edges directly, from prerequisite to dependent:

```bash
spor edge <prerequisite-id> blocks <dependent-id>   # or MCP add_edge
```

Only wire a real gate. `blocks` is work-to-work (task→task, task→issue) and
never from a decision (norm-cc-blocks-work-only); siblings that could proceed in
either order need no edge between them.

---
name: ask
description: File a question the Spor graph could not answer so it routes to whoever knows, instead of evaporating. One call; remotely the server routes it to the right steward, locally it lands as an open queue item. Use when the briefing/digest came back empty on something a teammate would know, or when the user says to ask/file/route a question.
---

# Ask the graph a question

When the graph can't answer something — the session briefing and per-prompt
digest came back empty on a question a teammate would know — don't let it
evaporate. File it as a `question` node: the routing system delivers it to the
steward of the closest work, and the answer becomes durable graph context for
everyone after you (the new-hire path the README headlines). This is the
deliberate counterpart to a search that returned nothing
(dec-cc-inter-session-graph-coordination).

Write the question as one or two standalone sentences — concrete enough that
whoever it routes to can answer without more context. Include the names that
locate it (files, endpoints, node ids).

## File it

One command — `spor ask` resolves the graph (local vs team), the project, and
your identity on its own:

```bash
spor ask "Does spor next accept a repo-<slug> node id, or only a bare slug?"
```

If the question is *about* known graph nodes, name them with `--mention <id>`
(repeatable). Routing weighs mentions first, so a mentioned node's steward is
who it reaches:

```bash
spor ask "Did the OAuth phase B token-rotation hook land?" --mention dec-cc-authz-rebac-fga
```

For a question with no mentions whose neighborhood is empty, the server can't
infer a project — pass `--project <slug>` to route it to the right team's queue.
Don't echo `SPOR_SERVER`/`SPOR_TOKEN`/`SPOR_HOME` or announce the mode unless the
user asks.

Read what it prints and tell the user, briefly:

- `question filed: <id>` + `routed to <person>` — report the id and who it
  reached. Done; the answer will arrive as a node with an `answers` edge.
- `question filed: <id>` + `unrouted — visible to everyone` — no steward matched
  its neighborhood, so it surfaces to the whole team's queue. Still filed.
- `question filed: <id> (open)` (local mode) — written as an open, queueable
  node in your personal graph; `spor next` will surface it.
- an `offline` line — the team graph is unreachable. The question was not filed;
  re-run when the server is back.

**In Cowork (no shell)**, call the `ask_question` MCP tool with the same fields
(`text`, and optionally `title`, `mentions`, `project`).

## Answering a question

A question is answered by a node carrying an `answers` edge to it — not by
editing the question. Write the answer (a `decision`/`artifact`, or whatever fits
the fact), add the edge, then flip the question terminal:

```bash
spor edge <answer-id> answers <question-id>
spor set-status <question-id> answered
```

`answered` is terminal — it leaves the queue. The asker or the answerer can flip
it once the `answers` edge is in place.

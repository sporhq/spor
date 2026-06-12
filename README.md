# Spor

Spor gives your coding agent a memory that outlives the session and crosses
between sessions and teammates. It is a typed, versioned knowledge graph of
your work — decisions (including the ones you dismissed), issues, norms,
specs, tasks — that your agent reads from and writes back to. Conversation
goes in; briefings come out. When work starts, the session is briefed from
the graph; when it ends, the transcript is distilled into a node or two and
paid back in.

The name is Norwegian — *spor*, the track something leaves.

## Quickstart

Create the graph home (this is yours, kept outside any code repo):

```bash
mkdir -p ~/.spor/nodes && git -C ~/.spor init \
  && printf 'journal/\n' > ~/.spor/.gitignore
```

Then install for your agent. In Claude Code:

```
/plugin marketplace add sporhq/spor
/plugin install spor@spor
```

For every other host — Codex CLI, Gemini CLI, Cursor, Copilot CLI, OpenCode,
and an `AGENTS.md` fallback for hosts with no hook support — see
[adapters/](adapters/).

To start with a populated graph, point the bundled `spor-backfill` agent at
your existing sources: it mines git history, design docs, and issue trackers
into a first graph. Or skip that and just work — distillation grows the graph one session
at a time.

## What your agent gets, and gives back

The loop runs without you having to drive it:

- A project briefing arrives when you begin work, so the session opens
  knowing what's already been decided.
- As you type, only what's relevant to the current prompt is pulled in —
  often nothing, because nothing on the prompt path calls a model, so the
  briefing lands in milliseconds rather than after a round trip.
- While you work, Spor nudges you to capture findings worth keeping and links
  your commits to the nodes they touch.
- When the session ends, the transcript is distilled into zero to two new
  nodes — including approaches you tried and rejected, kept on purpose so the
  team doesn't relitigate them. Distillation runs a small, cheap model and
  costs about $0.02 a session.

You can also ask for any of this directly: an on-demand briefing for a task,
a correction when a briefing was wrong, a capture of work you're deferring,
and a ranked queue of what to do next. In Claude Code these surface as
`/spor:brief`, `/spor:correct`, `/spor:defer`, and `/spor:next`.

Corrections are durable. When a briefing includes something stale or misses
something it should have known, you record the correction once, and every
future briefing honors it — you don't re-explain it next week. Briefings are
themselves versioned nodes, each carrying edges back to the sources it was
built from and the corrections that shaped it. Debug the context, not the
model.

## Why a graph, and not just retrieval

The behavior above rests on a context compiler that was measured against the
alternatives on the same planning task.

A planner agent fed a compiled briefing of about 0.8k tokens matched a
144k-token kitchen-sink context at 10/10 task quality — versus 4/10 with no
context at all — and did it at roughly 2.6× lower cost. Similarity-only
retrieval (RAG over the top twelve matches) scored 7/10 on that same task: it
missed a constraint that was only reachable by following lineage edges, the
kind of link a graph keeps and a flat index does not. And the cost of
distilling sessions back into the graph turned out to be insensitive to model
tier — the cheap model writes nodes as well as an expensive one, at about
$0.02 each.

A graph holds two things a pile of documents cannot: the edges between facts,
and the facts you decided against.

## Storage and ownership

There is one graph per person, or one per organization. It lives at
`$SPOR_HOME` (default `~/.spor/`), outside your code repositories, and is
itself an ordinary git repo — its history is the history of what the team
knows, separate from any code branch.

Because it sits outside your repos, knowledge distilled on a branch that
never merges still survives, and dismissed ideas are kept deliberately rather
than lost. Each node is one fact in its own plain-markdown file, with typed
edges to the nodes it relates to; the format is documented in
[GRAPH.md](GRAPH.md).

## Team mode

Single-player Spor is the whole client. Team mode is what you reach for when
the graph should be shared: one graph served to your entire team — the people
and their agents alike — with per-identity attribution on every node,
transactional writes so concurrent work doesn't clobber, and a shared
decision queue ranked across the team.

Team mode adds something a personal graph can't do: when a question can't be
answered from what's already there, it routes to the person most likely to
know, and their answer flows back into the graph as a node — so the next
person who asks gets it from the graph instead.

A client joins a team graph by pointing at it with two environment variables:

```bash
export SPOR_SERVER=https://spor.example.com
export SPOR_TOKEN=...
```

Set those and the client talks to the team graph over REST and MCP; leave
them unset and it runs entirely against your local `$SPOR_HOME`. If the team
server is ever unreachable, the client fails open — it falls back to a local
cache or to nothing, never blocking your session. The full contract a client
programs against is in [API.md](API.md).

## Pointers

- [GRAPH.md](GRAPH.md) — the node and edge format: what a node file looks
  like, the node types, the typed edges between them.
- [API.md](API.md) — the team-server contract: the REST and MCP surfaces, the
  write semantics, identity and auth, and client configuration.
- [adapters/](adapters/) — supported coding agents and how install works on
  each, including the `AGENTS.md` floor for hosts without hooks.

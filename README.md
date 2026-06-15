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

Install the CLI. It ships as the npm package `@sporhq/spor` and puts two
commands on your PATH — `spor` (the human CLI) and `spor-hook` (the hook
dispatcher hosts call):

```bash
npm install -g @sporhq/spor
```

Requires Node 20+ and nothing else — the client is zero-dependency. To run
from a checkout instead (e.g. to hack on it), clone the repo and `npm link`
from its root; that symlinks the same two commands onto your PATH.

Then create the graph home (this is yours, kept outside any code repo):

```bash
spor init        # creates ~/.spor/nodes, git-inits it, writes .gitignore
```

`spor init` is idempotent. `spor status` then tells you the resolved mode,
graph, project, and (in remote mode) server health and identity — run it any
time you're unsure whether Spor is active or which graph you're on. (Without
the `spor` CLI on your PATH the equivalent is
`mkdir -p ~/.spor/nodes && git -C ~/.spor init && printf 'journal/\n' > ~/.spor/.gitignore`.)

Then install for your agent. One verb wires up any supported host — it
resolves the adapter manifest to this checkout and drops it into the host's
config:

```bash
spor install claude     # Claude Code (via its plugin CLI — no marketplace browsing)
spor install codex      # also: gemini, cursor, copilot, opencode
spor install            # no host => list the hosts detected on this machine
```

`--scope user` (default) installs for you; `--scope repo` writes a committable
per-repo config. `--all` installs every detected host, `--print` is a dry run,
and `--server <url> --token <tok>` also points the client at a team graph in
the same step. Re-running is idempotent — it refreshes the path and never
duplicates your other hooks.

In Claude Code you can still install from the marketplace by hand if you
prefer:

```
/plugin marketplace add sporhq/spor
/plugin install spor@spor
```

For the per-host event mapping, fidelity notes, distiller backend, and the
`AGENTS.md` fallback for hosts with no hook support, see
[adapters/](adapters/).

To start with a populated graph, ask your agent to run the bundled
`spor-backfill` agent against your existing sources — in Claude Code:
*"use the spor-backfill subagent to bootstrap a Spor graph for this repo."*
It is a **subagent** (invoked through the Task tool, not a `/spor:` slash
command), so it runs in its own context, mining git history, design docs, and
issue trackers into a first graph. Or skip that and just work — distillation
grows the graph one session at a time.

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
`/spor:brief`, `/spor:correct`, `/spor:defer`, and `/spor:next`. (Graph
bootstrapping is separate: `spor-backfill` is a *subagent* you invoke by
asking your agent to use it — it does not appear in the `/spor:` slash menu.)

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

## Configuration

Settings can live in config files instead of environment variables, cascading
from broad to specific so a repo can override your personal defaults. Highest
precedence wins:

1. CLI flags
2. environment — `SPOR_*` (legacy `SUBSTRATE_*` still read)
3. **repo** — `.spor.json` at (or above) the working directory; the nearest one
   wins, so a monorepo subtree can override its root
4. **user** — `$SPOR_HOME/config.json`
5. **global** — `$XDG_CONFIG_HOME/spor/config.json` (`~/.config/spor/config.json`)
6. built-in defaults

Environment sits above the config files, so existing setups are unchanged;
add files only when you want them. A `.spor.json` (committable) is for
settings the whole repo should share — never put a `token` there; it is
honored only from the environment or your user/global config.

```jsonc
// .spor.json — committed at a repo root
{
  "enabled": false,                 // make the plugin a no-op in this repo:
                                    // unrelated side projects don't pollute
                                    // the shared graph (default true)
  "search": {
    "minSim": 0.10,                 // raise/lower the relevance gate
    "projects": {
      "include": ["spor"],          // restrict candidate ranking to these
      "exclude": ["personal-blog"], // drop these from ranking entirely
      "boost":   { "spor": 1.5 }    // favor a project's nodes in ranking
    }
  }
}
```

Other recognized keys mirror their env var: `server`, `token`, `home`,
`nodes`, `mode` (`auto`/`local`/`remote`/`off`), and the `distill`, `nudge`,
and `inferCommits` groups. `spor validate` prints config warnings (an unknown
key, a secret in a committable config) on stderr.

### LLM spend — visibility and control

The two paid calls the client makes are the SessionEnd distiller and the
post-tool capture nudge, both on a small, cheap model. Either can be turned
off, and what you spend is recorded so the "~$0.02 a session" figure above is
verifiable rather than asserted:

- `SPOR_DISTILL=0` (or `distill.enabled: false`) disables distillation — you
  keep briefings with no SessionEnd model spend.
- `SPOR_NUDGE=0` (or `nudge.enabled: false`) disables the capture nudge.
- Every call appends a row to `$SPOR_HOME/journal/llm-calls/<date>.jsonl` with
  token usage and the model-reported cost. `spor cost` (`--since YYYY-MM-DD`,
  `--project <slug>`, `--json`) totals it by source. Custom `SPOR_DISTILL_CMD`
  /`SPOR_NUDGE_CMD` backends return text only, so their rows count as
  cost-unknown.

## Pointers

- [GRAPH.md](GRAPH.md) — the node and edge format: what a node file looks
  like, the node types, the typed edges between them.
- [API.md](API.md) — the team-server contract: the REST and MCP surfaces, the
  write semantics, identity and auth, and client configuration.
- [adapters/](adapters/) — supported coding agents and how install works on
  each, including the `AGENTS.md` floor for hosts without hooks.

## License

Spor (this client) is licensed under the [Apache License 2.0](LICENSE) — a
permissive license with an explicit patent grant. See [NOTICE](NOTICE) for
attribution.

"Spor" and "sporhq" are trademarks of the project; the Apache License grants no
rights to the marks. Their use is governed by the [Trademark Policy](TRADEMARKS.md)
— in short, build "an adapter **for** Spor," not a product **named** Spor.

Contributions are welcome under inbound = outbound (Apache-2.0); see
[CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and the
[Code of Conduct](CODE_OF_CONDUCT.md).

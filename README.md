# Spor

Spor gives coding agents a memory they can carry from one session to the next.

It keeps track of the useful things that normally disappear into chat history: decisions, rejected approaches, open questions, project norms, tasks, incidents, and the reasons behind them. When a new session starts, Spor briefs your agent with the relevant parts of that history. When the session ends, useful new context can be written back.

The name comes from Norwegian: *spor* means the track something leaves behind.

📖 **Full documentation: [docs.sporhq.io](https://docs.sporhq.io)** — concepts, getting started, the CLI, the REST API, the MCP surface, and the hosted product.

## Why use Spor?

Coding agents are good at working inside a single session. The problem is everything before and after that session.

Without shared memory, you keep repeating things like:

* “We already tried that.”
* “That service has a weird deployment rule.”
* “This was decided in the last refactor.”
* “Don’t use that API; it only works in staging.”
* “The answer is in an old design doc, but I can’t remember which one.”

Spor gives those facts somewhere to live.

It is not just a pile of notes. Spor stores knowledge as a small typed graph, so it can preserve relationships such as:

* this decision supersedes that one
* this task is blocked by this issue
* this implementation came from this spec
* this correction should affect future briefings
* this rejected idea should not be proposed again next week

That graph can live locally on your machine, or be shared by a team.

## How it works

At a high level, Spor runs a simple loop:

1. **Brief**
   At the start of a coding session, Spor finds relevant project context and gives it to your agent.

2. **Nudge**
   While you work, Spor can suggest capturing useful discoveries before they vanish.

3. **Distil**
   At the end of a session, Spor can turn the important parts of the transcript into one or two durable graph nodes.

4. **Reuse**
   Future sessions get briefed from the graph instead of starting cold.

You can also ask for things directly, such as a briefing for a task, a correction to stale context, or the next item in the project queue.

## What is a briefing?

A briefing is the packet of context Spor gives your coding agent before it starts work.

It is not a transcript dump. Spor reads the project graph, finds the nodes that look relevant to the current repo and task, and turns them into a short working summary.

A good briefing might include:

* the decisions that still apply
* old approaches that were rejected
* open tasks and blockers
* project-specific conventions
* related incidents, specs, or design notes
* corrections that should stop the agent repeating stale advice
* links back to the graph nodes the briefing came from

For example, before working on auth, a briefing might tell the agent:

```text
Use the token exchange flow from dec-auth-token-exchange.
Do not revive the old session-cookie approach; it was rejected in dec-auth-cookie-rejection.
The current blocker is issue-auth-refresh-race.
Security review notes are in art-auth-review-2026-06.
```

The point is to give the agent enough memory to start in the right place, without making you paste old notes into every session.

Briefings can be created automatically at session start, but you can also ask Spor directly.

In agent hosts that support tool mentions, use `@Spor`:

```text
@Spor brief me before I change the auth middleware
@Spor what do we already know about the export pipeline?
@Spor why did we reject the previous queue design?
@Spor what should I avoid touching in this repo?
```

You can also use the explicit command:

```text
/spor:brief
```

A briefing is itself stored as a graph node, with links back to the nodes it was compiled from. That means it can be reviewed, corrected, versioned, and rebuilt when the graph changes.

## Install

Spor is distributed as an npm package.

```bash
npm install -g @sporhq/spor
```

Requirements:

* Node.js 20 or newer

For local use, Spor runs without:

* a database
* a server, unless you want live team sharing

The package installs two commands:

* `spor` — the human-facing CLI
* `spor-hook` — the hook dispatcher used by agent hosts

Check the install with:

```bash
spor --help
```

## Connect Spor to your agent

Install the adapter for the agent host you use:

```bash
spor install claude
```

Other supported hosts include:

```bash
spor install codex
spor install gemini
spor install cursor
spor install copilot
spor install opencode
```

To see what Spor detects on your machine:

```bash
spor install
```

Useful install flags:

```bash
spor install --all       # install every detected host
spor install --print     # show what would change, without changing it
spor install --scope repo
spor install --scope user
```

`--scope user` is the default. It installs Spor for you.

`--scope repo` writes configuration that can be committed with a repository.

Re-running `spor install` is safe. It refreshes the Spor paths and does not duplicate existing hooks.

## First-time setup

After installing the adapter, open your coding agent inside a repo and run:

```text
/spor:onboard
```

This is the easiest way to start.

Onboarding will:

* check your Spor status
* choose local or team mode
* set up your identity
* enable Spor for the current repo
* ask what sources it may read
* optionally backfill context from git history, docs, and issue trackers

You can run it again later if setup was interrupted or something feels wrong.

## Using Spor day to day

Once Spor is enabled for a repo, you usually do not need to think about it.

At the start of a session, your agent gets a briefing: a short, task-aware summary of the project memory that matters right now. During the session, Spor can surface related context, answer direct questions through `@Spor`, or suggest captures. At the end, it can distil useful discoveries back into the graph.

In Claude Code, the main commands are:

```text
/spor:brief      # get a briefing for a task or area
/spor:correct    # fix stale or wrong context
/spor:defer      # capture something to return to later
/spor:ask        # record a question the graph cannot answer
/spor:next       # show the next useful thing to work on
/spor:onboard    # first-time setup
/spor:backfill   # extend the graph from existing sources
```

From the shell, `spor status` is the first thing to run when something is unclear:

```bash
spor status
```

It shows the current mode, graph, project, server health, and whether Spor is active in the current repo.

## Background agents

Spor can dispatch background work with the right context already attached.

```bash
spor dispatch "wire up token rotation in the pipeline"
```

You can also dispatch from existing graph nodes or from the queue:

```bash
spor dispatch issue-86
spor dispatch --from-queue
spor dispatch --backfill
```

When dispatching a node, Spor briefs the agent with the relevant neighbourhood of the graph. It also avoids obvious duplicate work: if the same node is already being worked on locally, or already claimed in team mode, Spor refuses the duplicate dispatch unless you force it.

To see what would be launched without starting anything:

```bash
spor dispatch issue-86 --print
```

To provide your own prompt wrapper:

```bash
spor dispatch issue-86 --template prompt.tpl
```

Templates can use placeholders such as:

```text
{{brief}}
{{task}}
{{node}}
{{id}}
{{title}}
{{summary}}
{{type}}
{{status}}
{{date}}
{{slug}}
{{dir}}
{{default}}
```

`{{id}}`, `{{summary}}`, `{{type}}`, `{{status}}`, and `{{date}}` come from the
dispatched node's own frontmatter fields (blank in free-text or `--backfill`
dispatch, where there is no target node).

## Local mode

By default, Spor can run entirely on your machine.

The graph lives outside your code repositories, under:

```bash
~/.spor/
```

or another directory if `$SPOR_HOME` is set.

The graph is a normal git repo. Nodes are plain markdown files. This means your project memory has history, diffs, branches, and all the boring-but-useful properties of git.

A local graph is good when:

* you are trying Spor for the first time
* you want personal memory across projects
* you do not need live team sharing
* you prefer to keep everything on your own machine

Because the graph is outside your code repo, context from a branch can survive even if the branch never merges.

## Team mode

Team mode is for sharing one live graph across people and agents.

Join a team graph with an invite token:

```bash
spor join spor_pat_...
```

By default, this points at the hosted Spor service. To use another server:

```bash
spor join https://spor.example.com spor_pat_...
```

You can also configure team mode with environment variables:

```bash
export SPOR_SERVER=https://api.sporhq.io
export SPOR_TOKEN=spor_pat_...
```

In team mode, writes are attributed to the person or agent that made them. The server also handles concurrent writes so teammates do not clobber each other.

Team mode is useful when:

* several people work on the same codebase
* background agents are working alongside humans
* decisions should be shared immediately
* open questions should route to the person most likely to know
* the team wants a shared queue of useful work

If the team server is unavailable, Spor fails open. It should not block your coding session.

## Sharing a graph over git

You can also share a graph without running a server.

Create or clone a graph as a normal git repo, then point your code repo at it with a committed `.spor` marker:

```text
# .spor
repo: my-service
graph: ../my-team-graph
```

The path is resolved relative to the repo marker. A common layout is:

```text
my-service/
my-team-graph/
```

Everyone clones both repos side by side. Distilled nodes are written as markdown and can go through your normal pull-request flow.

This is simpler than team mode, but it does not provide live concurrent writes, hosted isolation, or question routing.

## What gets stored?

Spor stores small, typed nodes.

Examples include:

* decisions
* tasks
* issues
* incidents
* specs
* norms
* questions
* corrections
* people
* agents
* projects
* repositories

Each node is a markdown file with frontmatter and a short body. Nodes can link to other nodes using typed edges.

A simplified decision node looks like this:

```markdown
---
id: dec-export-csv-format
type: decision
project: meridian
title: Bulk export uses CSV with a stable column order
summary: CSV is the first supported bulk export format because customers already use spreadsheet-based workflows.
status: active
date: 2026-06-09
edges:
  - {type: derived-from, to: spec-export-schema}
  - {type: supersedes, to: dec-export-json-only}
---

We chose CSV first because it works with the tools customers already use.

JSON export is still possible later, but it is no longer the first format.
```

See `GRAPH.md` for the full graph format.

## Configuration

Spor reads configuration from several places. More specific settings win over broader ones.

Precedence order:

1. CLI flags
2. environment variables such as `SPOR_SERVER`
3. repo config: `.spor.json`
4. user config: `$SPOR_HOME/config.json`
5. global config: `~/.config/spor/config.json`
6. built-in defaults

A repo can opt in with `.spor.json`:

```jsonc
{
  "enabled": true
}
```

Installing Spor does not automatically enable every repo you open. A repo is inactive until it has a `.spor` or `.spor.json` marker, or until you enable Spor globally.

This avoids leaking side-project context into a team graph by accident.

To enable Spor in the current repo:

```bash
spor enable
```

To check what mode and config are active:

```bash
spor status
```

To validate config:

```bash
spor validate
```

Never commit a team token into `.spor.json`. Use the environment, user config, or global config for secrets.

## LLM usage and cost controls

Spor can make small model calls for two things:

* distilling useful session context at the end of a session
* nudging you to capture useful findings while you work

You can turn either off:

```bash
export SPOR_DISTILL=0
export SPOR_NUDGE=0
```

You can also point them at a custom backend:

```bash
export SPOR_DISTILL_CMD=/path/to/distiller
export SPOR_NUDGE_CMD=/path/to/classifier
```

The backend contract is simple: prompt on stdin, response on stdout.

Spor records model usage under:

```bash
$SPOR_HOME/journal/llm-calls/
```

To inspect spend:

```bash
spor cost
spor cost --since 2026-06-01
spor cost --json
```

## Health and diagnostics

Spor hooks are designed to fail open. If something goes wrong, your agent session should continue; you may just get less context.

For a health check, run:

```bash
spor-hook doctor
```

It reports things like:

* resolved mode
* server reachability
* token validity
* outbox depth
* dead-letter depth
* cached briefing freshness
* recent hook and distiller errors

If captures are stuck because the team server was unavailable, drain the outbox with:

```bash
spor drain
```

## Upgrading

Update the npm package:

```bash
npm install -g @sporhq/spor
```

Then refresh installed adapters:

```bash
spor upgrade
```

For a specific host:

```bash
spor upgrade claude
```

To preview changes:

```bash
spor upgrade --print
```

This matters because some hosts cache plugins or hook definitions. Updating the npm package alone may not refresh what the agent has already loaded.

`spor status` will show when a loaded plugin is stale.

## More docs

* [docs.sporhq.io](https://docs.sporhq.io) — the full documentation site: concepts, getting started, CLI, REST API, MCP, and the hosted guide
* `GRAPH.md` — graph format, node types, edges, and schema behaviour
* `API.md` — REST and MCP server contract
* `QUEUE.md` — queue, capture, routing, and workflow details
* `adapters/` — host-specific adapter notes
* `CONTRIBUTING.md` — contributing guide
* `SECURITY.md` — security policy

## License

Spor is licensed under Apache-2.0. See `LICENSE` and `NOTICE`.

“Spor” and “sporhq” are project trademarks. The Apache license grants rights to the code, not to the marks. See `TRADEMARKS.md` for details.

Contributions are welcome under inbound = outbound Apache-2.0.


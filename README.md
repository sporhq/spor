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
/spor:spor       # the operating manual — load before any graph operation
/spor:brief      # get a briefing for a task or area
/spor:correct    # fix stale or wrong context
/spor:defer      # capture something to return to later
/spor:ask        # record a question the graph cannot answer
/spor:next       # show the next useful thing to work on
/spor:triage     # actively work the queue: dedupe, groom, close readiness gaps
/spor:onboard    # first-time setup
/spor:backfill   # extend the graph from existing sources
/spor:factory    # compile a factory: what has to be true before work counts as done
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

A dispatched agent runs beyond the launcher's own lifetime — a Claude Code
agent detaches into its own background-agent daemon, a Codex agent into a
supervisor Spor owns (more on that below) — so `spor dispatch` records every
run it launches and `spor runs` reports how each one ended:

```bash
spor runs
spor runs --node issue-86
```

Each run resolves to a terminal state — `done`, `failed`, `vanished` (it stopped
mid-turn, or it ended in a way nothing can be attributed to), or `failed_launch`
— with the reason, and a class that keeps environment failures such as provider
credit exhaustion separate from failures of the work itself. A Claude Code run
that bound a session also carries a pointer to its transcript; a Codex run's
equivalent evidence is its own log instead. One that never bound a session says
so rather than borrowing a transcript from whatever else ran in that checkout.
Terminal records age out after `dispatch.runRetentionMs` (default 14 days).

That state describes how the **process** ended. Alongside it every run also
carries its **outcome** — what the run did to the graph — as exactly one of
`resolved`, `reported`, or `failed`:

| outcome | meaning |
|---|---|
| `resolved` | the graph itself shows a live resolving edge (`resolves`/`answers`) onto the target node. Verified by re-reading the node after the run, never inferred from an exit code and never taken from the agent's own word |
| `reported` | no resolution, but the agent left a final report. It is filed as an artifact node linked to the target (`relates-to`) and **then** the lease is released, so the item returns to the queue carrying the work instead of vanishing into a dead run. `report_node_id` names the artifact — a filed report always reads `reported`, enforced or not |
| `failed` | no resolution and no report filed — a launch failure, a crash before any report, an empty one, or a graph that refused the write. `terminal_note` carries the failure note. The lease is released, except where the report could not be filed (see the ordering rule below) or the target was one this runner cannot judge |

The ordering is the contract: the report is filed before the lease goes back to
the pool, so an interrupted run can leave a held lease with the report filed but
never a released lease with nothing attached.

Enforcement covers **supervised** launches (Claude Code, Codex, OpenCode, Copilot
CLI — every built-in) against a team graph, targeting a node type whose
completion is a resolving edge (`task`, `issue`, `question`, `incident`). A
native-background run (`spor dispatch --bg`, the opt-in `claude --bg` launch), a
local-mode dispatch, a free-text dispatch, a target retired by status instead of
by an edge, and a run whose graph could not be reached are all classified
best-effort and marked `terminal_enforced: false` — an unenforced run can never
read `resolved`, and only an **enforced** `reported` promises a `report_node_id`
(an unenforced run that merely ended cleanly reads `reported` with no artifact).
A report is still filed wherever one exists and the graph is reachable, including
for a target this runner cannot judge — the verdict is scoped, the agent's work
reaching the graph is not.
`spor runs` prints the outcome (tagging `(unenforced)`), the note, and the report
artifact id; `spor runs --json` carries the same fields on each record.

### Working the queue continuously

`spor dispatch` does one item. `spor work` does them all: it polls the queue,
takes the items this machine may actually run, dispatches each one under its
routed profile, waits for its **terminal state**, and goes round again.

```bash
spor work                                   # work the whole queue, one run at a time
spor work --project spor --concurrency 2    # two runs in flight, scoped to one project
spor work --once --print                    # show scope, pacing and candidates; launch nothing
```

It is pull, not push: nothing schedules a worker, it takes work. That is safe
because the claim is a server-held lease with a per-launch nonce — two workers
racing for one node end with one claim and one refusal, and a worker that dies
drops its lease by lapsing. Capabilities stay machine-local facts and the fleet
scheduler stays advisory, so a worker that cannot reach the scheduler degrades
to "work the queue with what I have" rather than stopping.

It adds no guards of its own. Every launch goes through the same code path as
`spor dispatch --node <id>`, so already-resolved, `requires: human`, a profile
this box cannot satisfy (never substituted), a profile that tries to declare
what to execute, the same-machine duplicate guard, the auto-claim, worktree
isolation and the terminal-state contract all apply exactly as they do one-shot.
Selection is the same filtered page `--from-queue` picks its one item from,
minus anything whose derived readiness is `human` — a worker never claims work
meant for a person — and minus anything already in flight on this machine. An
item that is refused, or whose run ended without resolving it, is remembered
with the reason and retried after `--retry-after` instead of being re-attempted
on the next poll.

A slot frees when the **run record** goes terminal and its outcome is settled,
not when a launcher returns — by then the terminal-state contract has filed the
report and released or held the lease. There is no `--no-claim` here: the lease
is what keeps two workers off one node, so a loop always takes it. Stopping
(`SIGINT`/`SIGTERM`, or `--once`/`--max`) stops picking up new work; runs
already in flight are detached, keep going, and self-report through `spor runs`.

A native-background run (`claude --bg`, reached only through `spor dispatch
--bg` or a standing `dispatch.claudeLaunchMode: native-background`) is the weak
spot, for the same reason its outcome is unenforced: its termination is not
deterministically observable, so a slot is freed from the harness's own
live-agent listing. If that listing cannot be read, the slot stays held and the
worker says so; `--run-max` (default 24 hours) is the backstop that stops
following such a run. A supervised harness — Claude Code by default, Codex,
OpenCode, Copilot CLI, or a declared one — has none of this, which is why the
worker never passes `--bg`.

Run it as a service and read it back:

```bash
spor work --status          # every worker on this box: slots, outcomes, what it is skipping and why
spor work --regate <run-id> --factory <id>   # re-judge one refused run after fixing what refused it (no redo)
spor work --status --json
```

Records live under the machine-local journal; a worker whose process is gone
reads as stale, never as running. The `work.*` config keys (`concurrency`,
`intervalMs`, `maxIntervalMs`, `retryAfterMs`, `project`) let a unit file be a
bare `spor work`.

### Gates — what has to be true before work counts as done

A worker with no factory declared runs bare: dispatch, await, repeat. Point it
at a **factory definition** — a `type: factory` node in the graph — and its
ordered gate list is enforced, in code, between the claim and the resolve.

```bash
spor schema adopt schema-factory            # the factory/gate schemas ship as candidates
spor work --factory factory-spor-default    # (or set work.factory)
spor work --print --factory factory-spor-default   # see the gates without launching anything
```

Three kinds of gate, written inline in the factory or referenced as shareable
`type: gate` nodes an org vets once and reuses (the runner cannot tell them
apart):

- **command** — runs the declared acceptance suite from the **trusted ref**,
  never the implementer branch's copy of the tests. A change that touched a
  declared protected test path fails **closed**, unrun, and the test change is
  filed for a separate lane under a different profile.
- **agent-review** — dispatches a profile-routed, cross-model review and parses
  its structured findings verdict in code. An unreadable verdict is a failure,
  never a pass. Failures loop implementer fix cycles up to a declared cap, then
  escalate by filing an item a person has to answer.
- **human** — armed by declared risk classes (`touches:auth`, …); files an
  approval item and blocks the resolve until someone answers it.

Every gate outcome is written to the graph as a fact linked to the work item,
and a factory that does not validate refuses to start the worker rather than
letting it run ungated. [WORKERS.md](WORKERS.md) §10 is the full contract.

You do not have to hand-write the definition. `/spor:factory` is the compiler:
it interviews you — product questions if you are the owner, pipeline questions
if you are the engineer — reads your CI config, suites and graph, proposes a
pipeline, and emits the factory, its gates and the profiles they route to as
nodes. It also maintains one from its own telemetry ("why did the last three
fail review"), and seeds a test-writer lane when there is no acceptance suite
to gate on yet. It authors data only; enforcement stays in `spor work`.

### Choosing a harness

By default, `spor dispatch` launches a Claude Code agent in headless print mode
(`claude -p --output-format stream-json`) under the shared supervisor: the
prompt goes in on stdin, the run's session id and final report are read off its
event stream, the run record goes terminal when the process does, and the
terminal-state contract judges the outcome like any other supervised harness.
Pass `--bg` (or set `dispatch.claudeLaunchMode: native-background` in your user
config) to launch the native background session instead (`claude --bg`) — the
attachable, interactive form (`claude attach`), at the cost of an unenforced
outcome and no report channel. To dispatch under a different coding-agent CLI —
Codex, OpenCode, and GitHub Copilot CLI are also supported — resolve a
**profile**: a node that bundles a harness, model, and toolset.

```bash
spor dispatch issue-86 --profile profile-codex-sol
```

A profile looks like this:

```markdown
---
id: profile-codex-sol
type: profile
title: Codex / gpt-5.6-sol
summary: Codex harness running gpt-5.6-sol — general-purpose dispatch profile.
status: active
harness: codex
model: gpt-5.6-sol
mcp: [spor]
---
```

Profiles are authored deliberately rather than captured from a transcript —
write one yourself with `spor put-node`, or reuse one your team has published.
An `agent` node can also carry a default profile (a `uses-profile` edge), so
its dispatches pick a harness without a flag every time; `--profile` on the
command line always wins over that default.

Before launching anything, dispatch checks whether **this machine** can
actually run the resolved profile — is the harness's CLI reachable, are the
right MCP servers reachable, and so on (see `spor capabilities`). If it can't,
dispatch refuses outright rather than silently falling back to Claude Code; in
team mode it also names any other machine in the fleet that can run it.

Codex-specific flags (`--sandbox`, `--approval-policy`) and Claude-specific
ones (`--permission-mode`, `--agent`) are mutually exclusive — passing the
wrong one for the resolved harness is a hard error, so a dispatch can't launch
half-configured for the wrong CLI. The one exception: `--permission-mode
bypassPermissions` against a Codex profile has a real Codex equivalent
("run fully unattended"), so instead of erroring it translates to `--sandbox
danger-full-access --approval-policy never` (an explicit `--sandbox`/
`--approval-policy` you also pass wins over that default) and prints a loud
warning naming the translation — so an orchestrator or script that passes the
same bypass flag to every dispatch regardless of harness keeps working.
Every other permission-mode value still hard-errors against Codex.

The harnesses do not all confine a run the same way. Codex dispatch defaults to
`--sandbox workspace-write`, so its filesystem reach is bounded. OpenCode
(`--auto`) and GitHub Copilot CLI (`--allow-all --no-ask-user`) have no
equivalent — a dispatch under either runs with unrestricted tool access,
because an unattended run has no human to answer a permission prompt. Dispatch
those into a worktree or a checkout you are willing to have an agent change.

**Naming a launcher explicitly.** A dispatched run does not inherit your
interactive shell, so a CLI installed under a prefix that only an interactive
shell sees (a common Homebrew setup) resolves when you check it by hand and
resolves to nothing when Spor launches it. Point Spor at the binary directly
rather than relying on `PATH`, in `~/.spor/config.json` — machine-specific, like
`dispatch.repos`, so it never belongs in a committable `.spor.json` (and is
dropped with a warning if it turns up in one):

```json
{ "dispatch": { "bin": { "opencode": "/home/linuxbrew/.linuxbrew/bin/opencode" } } }
```

`SPOR_CLAUDE_CMD` / `SPOR_CODEX_CMD` / `SPOR_OPENCODE_CMD` / `SPOR_COPILOT_CMD`
override the same thing per harness and win over the config file. An explicit
launcher is used verbatim and is never quietly swapped for something on `PATH`;
with none set, the bare name resolves on `PATH` as before.

**Declaring a harness Spor has no adapter for.** A profile can name a harness
this client ships no adapter for at all — a team's modified Claude Code build,
an internal wrapper. The graph carries only the *name*; the machine binds what
that name runs, in the same machine-local config:

```json
{
  "dispatch": {
    "harness": {
      "oxalpha": {
        "command": "/opt/ox/bin/ox",
        "args": ["run", "--jsonl", "--dir={cwd}", "--model={model}"],
        "label": "Ox Alpha",
        "report": { "from": "lastText", "text": "message.text" },
        "session": "session.id"
      }
    }
  }
}
```

A profile then selects it with nothing but `harness: oxalpha`. That split is
the point: **a graph write must never define what a machine executes.** A
profile carrying a `command`, `args`, `env` or any other launch-defining field
is refused outright rather than honoured, and a machine that never declared the
id refuses the dispatch and leaves the item assigned — so an org can publish a
profile naming `oxalpha` and only the boxes whose owner bound that id will take
the work. `spor capabilities` lists a declared harness alongside the built-in
ones, and, in team mode, publishes it to the fleet so re-routing can find it.

The same rule holds for a write anyone else could land in your repo:
`dispatch.harness` (and `dispatch.bin`) are dropped with a warning if they
appear in a committable `.spor.json`, so cloning a repo — or pulling a PR
branch into one — can never choose a command this box will run. They are read
only from your own `~/.spor/config.json` (or the global one).

What the declaration may set, and nothing else:

* `command` — the launcher: an absolute path, or a bare name resolved on `PATH`.
* `args` — the argv template. `{cwd}` becomes the run's directory, `{report}`
  the run's report path, `{model}` the resolved model. An entry carrying
  `{model}` is dropped **whole** when no model resolves, so it has to be the
  flag itself — `--model={model}`, or `--model=anthropic/{model}` — never a
  bare value after a separate `--model`, which would leave that flag to swallow
  the next argument. A declaration that gets this wrong is refused, not
  launched.
* `label` — what `spor dispatch` and `spor runs` call it.
* `report` — how the run's final message is recovered: `"lastText"` (the
  default) keeps the last string found at the `report.text` JSON path in the
  harness's own event stream, and `"file"` means the harness writes the report
  itself at the `{report}` path you passed it.
* `session` — the JSON path (or paths) carrying the harness's session id, so
  the run can be bound to its agent session. Optional; without it the run
  simply is not bound.

Everything else is fixed, and naming it is an error: a declared harness always
runs under the supervisor below, always takes its prompt on **stdin** (so a
compiled briefing never lands in a process listing), and always gets its
agent-scoped token as `SPOR_TOKEN` in the run's environment. A malformed
declaration is refused by name — Spor never falls back to guessing.

Claude Code dispatch detaches into Claude Code's own background-agent daemon —
the launcher exits immediately, and `spor dispatch` can only reconcile what
happened to it afterwards from the harness's own session transcript. Every
other harness instead runs under a small supervisor Spor itself owns: it
launches the CLI's headless mode in the background, streams its progress into a
private log, and captures the run's final message to a report file. At launch
it prints where everything lives:

```text
run:     3f9a2c1e-... (Codex supervisor running)
log:     ~/.spor/journal/dispatch/3f9a2c1e-....log
report:  ~/.spor/journal/dispatch/3f9a2c1e-....report.md
session: 019f7a51-...
```

`log` is the full JSONL progress stream; `report` is the run's final message —
the thing to read for "what did it conclude". Both paths, plus the run's
outcome, are also recorded durably and can be looked up later, same as any
other dispatch:

```bash
spor runs --node issue-86            # human-readable: state, why, log path
spor runs --node issue-86 --json     # add .runs[0].report_path for the final message
```

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
* `WORKERS.md` — the worker protocol: claim/brief/work/report/resolve, lease
  semantics, agent identity, and the terminal-state contract — for
  implementing a Spor factory worker without this client
* `adapters/` — host-specific adapter notes
* `CONTRIBUTING.md` — contributing guide
* `SECURITY.md` — security policy

## License

Spor is licensed under Apache-2.0. See `LICENSE` and `NOTICE`.

“Spor” and “sporhq” are project trademarks. The Apache license grants rights to the code, not to the marks. See `TRADEMARKS.md` for details.

Contributions are welcome under inbound = outbound Apache-2.0.


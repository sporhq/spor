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

Wire Spor into your agent. One verb resolves the adapter manifest to this
install and drops it into the host's config:

```bash
spor install claude     # Claude Code (via its plugin CLI — no marketplace browsing)
spor install codex      # also: gemini, cursor, copilot, opencode
spor install            # no host => list the hosts detected on this machine
```

`--scope user` (default) installs for you; `--scope repo` writes a committable
per-repo config. `--all` installs every detected host, `--print` is a dry run,
and `--server <url> --token <tok>` also points the client at a team graph in
the same step. Re-running is idempotent — it refreshes the path and never
duplicates your other hooks. (In Claude Code you can also install by hand:
`/plugin marketplace add sporhq/spor` then `/plugin install spor@spor`.)

Upgrading. Bumping the package does **not** refresh what an agent already
loaded — Claude Code runs its own cached copy of the plugin, so new
skills/hooks won't appear until that copy is updated. After an npm bump, run:

```bash
npm install -g @sporhq/spor   # update the package on disk
spor upgrade                  # refresh every wired host to it, then restart
```

`spor upgrade` updates Claude Code's plugin (`marketplace update` +
`plugin update`) and re-points the hook hosts at the new install; pass a host
(`spor upgrade claude`) to scope it, or `--print` for a dry run. `spor status`
flags the gap on its own — it shows the loaded plugin version and marks it
`STALE` when the package on disk is newer.

Then onboard — from inside the repo, run `/spor:onboard` in your agent:

```
/spor:onboard
```

It's the first-time-setup front door. It reads `spor status`, forks
personal-local vs team-server, establishes your identity (a person node, and
this machine's dispatch agent), enables Spor for the repo, asks which sources
the backfill may read, and hands off to `/spor:backfill` to populate the graph
from git history, design docs, and issue trackers. It's idempotent — re-run it
any time to repair a half-set-up box. If you're new to Spor or anything's
unclear, start here.

Once you're set up, bootstrapping another freshly-cloned repo is one unattended
command from inside it:

```bash
cd ~/my-repo && spor dispatch --backfill
```

That's the CLI primitive `/spor:onboard` delegates to: it creates your graph
home if it doesn't exist yet (`~/.spor/nodes`, git-initialised), registers the
repo so Spor knows where it lives on this machine, makes sure Spor is enabled,
and launches the `/spor:backfill` agent in a Claude Code background session.
Watch or attach to it with `claude agents`. It skips the identity, tenant, and
consent steps `/spor:onboard` covers, so reach for it once those are done — or
skip onboarding entirely and just work, since distillation grows the graph one
session at a time.

`spor status` tells you the resolved mode, graph, project, and (on a team
graph) server health and identity — run it any time you're unsure whether Spor
is active or which graph you're on. `spor init` does the graph-home setup on
its own if you'd rather not dispatch anything yet.

For the per-host event mapping, fidelity notes, distiller backend, and the
`AGENTS.md` fallback for hosts with no hook support, see
[adapters/](adapters/).

## Dispatching background agents

`spor dispatch` hands a task to Claude Code's background-agent machinery
(`claude --bg`) with a briefing already compiled in:

```bash
spor dispatch "wire up token rotation in the pipeline"   # free-text task, briefed
spor dispatch issue-86                                    # a node id — briefs its neighborhood
spor dispatch --from-queue                                # the top item from 'spor next'
spor dispatch --backfill                                  # init + enable + run /spor:backfill (door: /spor:onboard)
spor dispatch <task> --template prompt.tpl                # launch your own prompt, context injected
spor dispatch <task> --print                              # dry run: show dir, prompt, argv
```

It compiles the briefing (the same two-arm compiler the `/spor:brief` skill
drives), prepends it to the prompt, and launches `claude --bg` **in the right
repo**. Which directory that is comes from a per-machine slug→path map: the
shared graph is path-free by design (every teammate clones to a different
path), so the map is local, kept in the config cascade under `dispatch.repos`
(`spor repos` to inspect; written to `$SPOR_HOME/config.json`). It self-learns
as you open sessions, so by the time you dispatch a node from another repo,
Spor already knows where that repo lives. Flags pass through to `claude`
(`--model`, `--permission-mode`, `--agent`, `--name`); `--full` embeds the whole
neighborhood and `--no-brief` skips the briefing.

**No accidental duplicates.** A node dispatch won't double up on work already
underway. In remote mode it auto-claims the task's heartbeat lease at launch, so
dispatching a node a teammate already holds is refused with the holder named
(`--no-claim` opts out). And in either mode, dispatching a node that already has
a background agent in flight *on this machine* — each agent is named after its
node id — is refused too, catching the same-person duplicate the lease's
idempotent renew can't. `--force` overrides the local guard.

**Your own prompt.** By default the briefing is prepended to a built-in prompt
shell. Pass `--template <file>` (or set a default path in `dispatch.template`)
to supply your own prompt instead, with Handlebars-style `{{placeholder}}`
tokens substituted from the dispatch context: `{{brief}}` (the compiled
briefing, aka `{{briefing}}`/`{{neighbourhood}}`), `{{task}}`, `{{node}}`,
`{{title}}`, `{{slug}}`, `{{dir}}`, and `{{default}}` (the whole built-in
prompt, so you can wrap rather than replace it). Unknown placeholders blank out
with a warning. The template takes over the prompt entirely — you decide where
the brief and task land.

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
a question filed when the graph can't answer, and a ranked queue of what to do
next. In Claude Code these surface as `/spor:brief`, `/spor:correct`,
`/spor:defer`, `/spor:ask`, and `/spor:next`, plus `/spor:onboard` to set Spor
up the first time and `/spor:backfill` to bootstrap/extend the graph and
organize repos into projects. (`/spor:onboard` is the first-time-setup front
door — identity, mode, consent — and hands off to `/spor:backfill`, whose heavy
git-history mining runs in the `spor-backfill` subagent it dispatches.)

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
the graph should be shared *live*: one graph served to your entire team — the
people and their agents alike — with per-identity attribution on every node,
transactional writes so concurrent work doesn't clobber, and a shared
decision queue ranked across the team. (A team can also share a graph for free
over plain git, with no server — see "Sharing a graph over git" below.)

Team mode adds something a personal graph can't do: when a question can't be
answered from what's already there, it routes to the person most likely to
know, and their answer flows back into the graph as a node — so the next
person who asks gets it from the graph instead.

A client joins a team graph with a token from your team's invite:

```bash
spor join spor_pat_...                 # hosted Spor (https://api.sporhq.io)
```

`spor join` writes the server URL and token to your user config and confirms
the connection. The URL defaults to the hosted Spor service
(`https://api.sporhq.io`); pass your own to point elsewhere
(`spor join https://spor.example.com spor_pat_...`). The equivalent two
environment variables work too:

```bash
export SPOR_SERVER=https://api.sporhq.io
export SPOR_TOKEN=spor_pat_...
```

Set those and the client talks to the team graph over REST and MCP; leave
them unset and it runs entirely against your local `$SPOR_HOME`. If the team
server is ever unreachable, the client fails open — it falls back to a local
cache or to nothing, never blocking your session. The full contract a client
programs against is in [API.md](API.md).

> **Split-brain warning (local mode + a claude.ai Spor connector).** If your
> Claude Code is logged into a claude.ai account that has a **Spor MCP
> connector**, that connector is live in your sessions too — even in local
> mode — so you have *two* write surfaces at once: the local `$SPOR_HOME` file
> graph (skills, CLI, and ambient hook captures) and the remote team graph
> behind the connector (MCP-tool captures). Captures can split across them
> with no signal which got which. Pick one surface: either set `SPOR_SERVER`/
> `SPOR_TOKEN` to go fully remote, or disable the claude.ai Spor connector to
> stay fully local. `spor status` detects this and warns.

A team graph can also carry **lenses** — saved views (a board, a table, a
lineage tree) defined as nodes and rendered by the server. View them from the
shell:

```bash
spor lens                          # list the available lenses
spor lens lens-roadmap             # render one to the terminal (text)
spor lens lens-roadmap --format json   # the raw view tree, for piping
spor lens lens-roadmap --project wf    # pass a lens parameter
```

Rendering happens server-side (the same engine as the `render_lens` MCP tool),
so `spor lens` is a team-mode verb — in local mode it tells you to point at a
team graph rather than failing.

## Sharing a graph over git — no server

A team can share one graph for free, with no live server, by treating the
graph as the ordinary git repo it already is — everyone clones, pulls, and
pushes it. Point a code repo at a shared graph with a `graph:` line in its
committed `.spor` marker:

```
# .spor — committed at the repo root
repo: my-service
graph: ../my-team-graph
```

The path resolves relative to the marker, so the conventional layout is the
graph as a **sibling** repo (`../my-team-graph`) each teammate clones alongside
the code. This binding **overrides `SPOR_HOME`**: even a contributor with their
own personal `~/.spor` inherits the shared graph while working in this repo, so
prior decisions and dismissed approaches come for free. Distilled nodes land in
the shared graph as plain markdown and ride your normal PR flow.

Spor keeps the shared graph clean for you: it writes a `.gitignore` covering
the machine-local, per-person state (`journal/`, `cache/`, `outbox/`, `auth/`,
`config.json`) so only the durable `nodes/` (and brief `history/`) are
committed, and the end-of-session distiller leaves nodes uncommitted for your
PR — rather than auto-committing — when the graph lives inside the code repo
itself. This is the free tier's sharing model; the live **Team mode** server
above adds real-time concurrent writes, question routing, and hosted isolation.

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

**Spor is opt-in per repo.** Installing the plugin does not make every repo you
open participate: a repo is a no-op (no context injected, nothing distilled into
the shared graph) until it opts in — either it carries a `.spor`/`.spor.json`
marker, or `enabled` is set anywhere in the cascade (`SPOR_ENABLED=1`, or
`enabled:true` in user/global config to turn it on everywhere). `spor enable`
writes the marker below for you; `/spor:onboard` and `spor dispatch --backfill`
do it as part of onboarding. This keeps unrelated side projects out of your
team graph even when a server is configured globally. Run `spor status` (or
`spor-hook doctor`) in a repo to see whether it's active.

```jsonc
// .spor.json — committed at a repo root
{
  "enabled": true,                  // opt this repo in (what `spor enable`
                                    // writes). Spor is OFF in a repo with no
                                    // marker; set false to force a no-op even
                                    // where a marker would otherwise enable it
  "search": {
    "minSim": 0.10,                 // raise/lower the relevance gate
    "projects": {
      "include": ["spor"],          // restrict candidate ranking to these
      "exclude": ["personal-blog"], // drop these from ranking entirely
      "boost":   { "spor": 1.5 }    // favor a project's nodes in ranking
    }
  },
  "briefs": {                       // path-scoped sub-briefs for a monorepo:
    "auth/": "brief-myrepo-auth",   // each subtree -> its own brief node id
    "frontend-router/": "brief-myrepo-frontend-router"
  }
}
```

**Path-scoped briefs (monorepos).** A repo split into separately-owned subtrees
can declare one brief per subtree in `briefs` — a relative-path → brief-id map.
At session start the nearest-ancestor subtree containing your cwd is the *active
area*: its brief is injected alongside the repo brief, while the sibling areas
are surfaced as a one-line discovery list (`/spor:brief <id>` to open one)
without injecting their bodies. A session in no declared subtree (e.g. the repo
root) just gets the discovery list. This is a routing layer over the existing
`brief` concept — a covered subtree is an "area", a label on a brief, not a new
identity type; distilled nodes still stamp the repo. Name siblings
`brief-<repo>-<area>` so they group.

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
- The capture nudge runs synchronously after a `.md` write, so its backend's
  latency is felt in the tool loop. `SPOR_NUDGE_CMD` (or `nudge.cmd`) points it
  at a faster classifier — Gemini Flash via the bundled
  `scripts/distill-gemini.sh` returns in ~2–7s versus ~17s for a `claude -p`
  cold boot, with no quality regression. Two bounds keep a bad session cheap:
  `SPOR_NUDGE_MAX` (or `nudge.maxCalls`, default 20) caps classifier calls per
  session, and `SPOR_NUDGE_TIMEOUT` (or `nudge.timeoutMs`, default 30000ms)
  kills a hung backend. The distiller has the same `distill.cmd` and
  `distill.timeoutMs` (`SPOR_DISTILL_TIMEOUT`, default 120000ms) levers. See
  [adapters/README.md](adapters/README.md) for the backend contract.
- Every call appends a row to `$SPOR_HOME/journal/llm-calls/<date>.jsonl` with
  token usage and the model-reported cost. `spor cost` (`--since YYYY-MM-DD`,
  `--project <slug>`, `--json`) totals it by source. Custom `SPOR_DISTILL_CMD`
  /`SPOR_NUDGE_CMD` backends return text only, so their rows count as
  cost-unknown.

### Health and diagnostics

The hooks fail open — they never break a session — which also means a dead
server or a revoked token degrades quietly. To make that legible, run:

```bash
spor-hook doctor
```

It prints a one-shot health report: resolved mode, server reachability and
token validity, the outbox and dead-letter depth (with the oldest stranded
capture's age), how fresh the cached briefing is, and the most recent error
lines from `journal/remote.log` and `journal/distill.log`. When captures
have been stranded (a dead-letter pile-up or a deep outbox), session-start
also surfaces a one-line nudge alongside its status banner pointing you here.

When the outbox has stranded captures, flush it on demand with:

```bash
spor drain
```

It replays each spooled capture to the team server (the same drain a session
runs at start), so a pure-CLI user who never opens a session can still ship
them. A successful remote `spor add` drains opportunistically too.

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

# Spor

Spor is a Claude Code plugin that gives your sessions a shared memory: a
typed, versioned knowledge graph of your work, holding decisions (including
dismissed ones), issues, norms, specs, and tasks. It compiles compact,
lineage-aware briefings from that graph at session start, on every prompt,
and on demand, and sessions pay knowledge back in: an end-of-session
distiller turns transcripts into new nodes.

The name is Norwegian — *spor*, the track something leaves. The long-term
aim is a team graph shared by humans and agents, where a question the graph
can't answer routes to the engineer who can, and the answer flows back as a
node. See [Roadmap](#roadmap).

## Quickstart

```bash
# 1. Create the graph home
mkdir -p ~/.spor/nodes && git -C ~/.spor init \
  && printf 'journal/\n' > ~/.spor/.gitignore

# 2. Run Claude Code with the plugin (from your clone of this repo)
claude --plugin-dir <path-to-your-clone>

# 3. Bootstrap a graph for your project (inside the session)
#    "Use the spor-backfill agent to build a graph for this repo"
#    …or just work: the distiller grows the graph session by session.

# Persistent install
/plugin marketplace add sporhq/spor
/plugin install spor@spor
```

Sanity checks:

```bash
node lib/validate.js                        # lint the graph
node lib/compile.js --query "..." --digest  # what a prompt would inject
node lib/compile.js --root <node-id>        # full neighborhood for a node
node --test                                 # test suite, incl. conformance goldens
```

For team mode (a shared graph served over REST and MCP), see
[Team mode](#team-mode-the-spor-server).

## Why a graph, not RAG

This plugin packages a context compiler validated by experiment (in a
private research repo) on synthetic and scaled corpora:

- A planner agent fed a compiled briefing (~0.8k tokens) matched a
  kitchen-sink context (~144k tokens) at 10/10 task quality, vs 4/10 with no
  context — at ~2.6× lower cost, breaking even on compile cost at the first
  agent.
- Similarity-only retrieval (RAG, top-12) scored 7/10 on the same task: it
  missed a constraint reachable only through lineage edges and was misled by
  a near-miss node. Structure-aware compilation found both.
- Distillation quality is model-tier-insensitive: Haiku distills sessions at
  ~$0.02 with zero downstream quality loss.

The compiler has two arms. The **structural arm** walks typed edges
(`supersedes`, `constrained-by`, `derived-from`, …) out from the task with
weighted decay: relevance by lineage. The **content arm** runs tf-idf
similarity across the whole graph, blind to edges. It is the counterweight
that surfaces prior art from teams with no lineage connection to you — the
anti-Conway's-law arm. Graph-aware fixups then resolve supersession (stale
nodes are demoted to warnings and their supersessors pulled in), and org
norms ride along in every compile.

Two mechanisms make the system correctable rather than just queryable:

- **Corrections are nodes.** When a briefing is wrong, you don't edit the
  briefing. You record a correction (`pin`/`exclude`/free-text guidance)
  that applies at every future compile. Debug the context, not the model.
- **Briefings are nodes.** Versioned, with `derived-from` edges to every
  source and `shaped-by` edges to corrections — context with provenance.

## What runs when

| Moment | Mechanism | What happens |
|---|---|---|
| Session start | `SessionStart` hook | Injects the standing `brief-<project>` briefing + graph status (no LLM, file read) |
| Every prompt | `UserPromptSubmit` hook | Two-arm compile with the prompt as query over the whole org graph; injects a ≤4.5KB summary-resolution digest, or nothing when the graph isn't relevant (no LLM, milliseconds) |
| Write/Edit/Bash | `PostToolUse` hook | Journals touched files (project-tagged) to the graph home's `journal/`, nudges live capture when a substantial prose write contains findings missing from the graph, and links git commits to nodes |
| Session end | `SessionEnd` hook (async) | Distills transcript + journal into 0–2 project-stamped nodes — including dismissed approaches as `status: rejected` — via headless `claude -p --model haiku` (~$0.02); auto-commits the graph repo |
| On demand | `/spor:brief <query\|node-id>` | Full compile + in-session distillation into a briefing; `--skeleton` persists it as a versioned briefing node |
| On demand | `/spor:correct` | Records a standing correction node |
| On demand | `/spor:defer` | Captures deferred or discovered work into the graph the moment it appears |
| On demand | `/spor:next` | Presents the decision queue: deferred work and open questions, ranked by graph signals |
| Bootstrap | `spor-backfill` agent | Mines git history / docs / issue trackers into a first graph (~40–80 nodes), prioritizing lineage edges over content volume |
| Every 2 hours | cron (server repo) | Opus reviews every recorded Haiku prompt/response, files eval cases for improvable ones, and ships eval-gated prompt-template improvements (see [the Haiku quality loop](#the-haiku-quality-loop-record--review--improve)) |

Every hook has two modes: **local** (the default, reading `$SPOR_HOME`
directly) and **remote** (when `SPOR_SERVER`/`SPOR_TOKEN` are set, calling
the Spor server's REST twin and failing open to a local cache or to nothing
if the server is unreachable). The legacy `SUBSTRATE_*` spellings of these
variables are still read during the dual-read back-compat window. See
[API.md](API.md) §6.

## Other hosts (Codex, Gemini CLI, …)

The client is a portable core behind per-host adapters. The hook engines in
`scripts/engines/` speak Claude Code's hook contract, and `bin/spor-hook`
dispatches any host's payload onto them: manifests for Codex CLI, Gemini
CLI, Cursor, and Copilot CLI, plus an in-process JS plugin for OpenCode.
See [adapters/](adapters/) for install instructions, the fidelity table,
the configurable distiller backend (`SPOR_DISTILL_CMD`), and the
`AGENTS.md` floor for hook-less hosts (`bin/spor-hook agents-md`).

## The Haiku quality loop (record → review → improve)

Every prompt Spor sends to its small-model tier — the session-end distiller
and the capture-nudge classifier — is recorded in full: prompt, response,
template name + sha, latency, and the variables that built the prompt, as
JSONL under `journal/llm-calls/` in the graph home that made the call. For
the client that home is `~/.spor` (a legacy `~/.substrate` is used if
`~/.spor` is absent); the server records its own calls under its
`SPOR_HOME`.

The prompts themselves are `{{VAR}}` templates in
[prompts/client/](prompts/client/), re-read on every call, so a template
edit needs no restart. A cron job in the server repo
(`review/run-review.sh`) runs every two hours, handing unreviewed records
to a headless Opus session, which grades every response and files a replayable eval case for
each one that could have been better. Once a template accumulates 3+ cases
sharing a weakness, the job drafts a candidate template and adopts it only
when the eval harness (Haiku replay, Opus judge — also in the server repo)
scores it above the current template with no per-case regression,
committing the winner. Review state (cursor, batches, reports, eval cases)
lives under `~/.spor/llm-review/`, outside this repo, because eval cases
embed session-transcript excerpts.

## Storage: one graph, outside your repos

The graph lives at `$SPOR_HOME` (default `~/.spor/`) — **not** inside code
repositories — and is its own git repo, auto-committed by the distiller.
This is deliberate:

- Knowledge distilled on branches that never merge survives. Dismissed
  ideas are preserved: "we tried X and rejected it because Y" is exactly
  what stops a team relitigating.
- Edges cross repo boundaries; per-repo graphs would re-encode Conway's law.
- The graph repo's history is the knowledge history, decoupled from code
  history. Team sync arrives with the remote MCP server (see Roadmap),
  which serves the same graph to every member.

Nodes are one-fact-per-file markdown with frontmatter (`id`, `type`,
`project`, `summary`, typed `edges`). Full format spec: [GRAPH.md](GRAPH.md).

## Team mode: the Spor server

Host the graph on the Spor server and point clients at it. The client
contract is [API.md](API.md); the server itself — token minting, the daemon,
operator runbooks — lives in a separate, private repo (`sporhq/spor-server`),
with its own setup docs.

```bash
# The server consumes this repo's lib/ as a file: dependency on a sibling
# checkout (resolution order: $SPOR_LIB, then the installed @sporhq/spor
# package, then ../spor). Only a name-reservation stub is on npm
# (@sporhq/spor@0.1.0) — clone this repo as a sibling rather than
# npm-installing it, or the installed stub wins the resolution order
# over ../spor.

# In each client environment: hooks switch to remote mode, fail open when
# the server is down. ~/.spor becomes the client-side cache/outbox home.
export SPOR_SERVER=https://spor.example.com
export SPOR_TOKEN=spor_pat_...
```

Tokens minted before the rename keep the `sub_pat_` prefix and stay valid;
verification is hash-based and prefix-agnostic.

Cowork and other MCP clients connect to `${SPOR_SERVER}/mcp`
(`query_graph`, `get_node`, `put_node`, `propose_correction`, `my_queue`).

## Layout

- `.claude-plugin/` — plugin + marketplace manifests (plugin name: `spor`)
- `GRAPH.md` — node/edge format spec; the contract shared by the compiler,
  skills, agents, and distiller prompt
- `API.md` — the Spor server's public client contract: REST `/v1/*`, MCP
  `/mcp`, auth, error envelope
- `QUEUE.md` — design spec for deferred-work capture, the decision queue,
  and the evolving schema registry (raw-text ingestion, schema-attached
  code; partially supersedes GRAPH.md when it lands)
- `REFACTOR.md` — design record for the kernel/shell split and the
  conformance suite
- `lib/` — the zero-dependency client core, exactly what local mode runs:
  `compile.js` and `validate.js` (CLIs), with `graph.js`, `queue.js`,
  `registry.js`, `resolution.js`, `sandbox.js`, and `commit-inference.js`
  as façades over pure kernels in `lib/kernel/`; IO lives in `lib/shell/`,
  seed schemas in `lib/seed/`. The engine half (lenses, routing, workflow
  runs, rendering) lives in the server repo.
- `conformance/` — language-neutral golden cases (inputs → outputs) for the
  kernel, run by the test suite
- `hooks/hooks.json` — Claude Code hook wiring (see the table above)
- `scripts/engines/` — the zero-dep Node hook engines (`session-start`,
  `prompt-context`, `post-tool`, `distill`, `drain-outbox` for nodes
  spooled while offline, commit linking)
- `bin/spor-hook`, `adapters/` — host-agnostic hook dispatcher and the
  per-host adapter manifests (legacy `bin/substrate-hook` still works)
- `prompts/client/` — `{{VAR}}` templates for the client's LLM calls
- `skills/` — `/spor:brief`, `/spor:correct`, `/spor:defer`, `/spor:next`,
  and `team-graph` (the Cowork-side skill; Cowork has no hooks, so the
  skill triggers pulls)
- `agents/backfill.md` — the `spor-backfill` agent
- `workers/shim` — standalone bootstrap worker for workflow runs; it polls
  the server's claim API and executes steps, because the server itself
  never executes effects
- `test/` — zero-dep `node:test` suite

## Roadmap

Tiered so each step is independently useful. The expensive parts (compiler,
corrections, distillation, node format) exist; what follows is transport
and workflow.

### Tier 1 — remote MCP server
The spine of team mode, and the only path to Cowork: **Cowork has no hook
support** (plugin hooks silently never fire there; skills + MCP connectors
are the shared extension surface). Client contract: [API.md](API.md).
- [x] MCP server wrapping the compiler: `query_graph`, `get_node`,
  `put_node`, `propose_correction`, `my_queue`
- [x] Bearer-token (Phase A) identity → node attribution (including on
  distilled nodes); server-side transactional writes. (OAuth identity for
  Cowork/claude.ai connectors — Phase B — is still pending.)
- [x] Claude Code hooks call the server instead of local files; Cowork gets
  a bundled skill that pulls via `query_graph` (no ambient injection there —
  the skill description does the triggering, and will need iteration)
- [x] Multi-root compile (e.g. local personal graph + remote team graph)
- [ ] Verify the reported Cowork bug where remote-connector tool calls can
  arrive without bound auth tokens before trusting attribution

### Tier 2 — question routing / the decision queue
The original Spor thesis materializing: home is a decision queue.
- [x] `question` nodes — filed deliberately (`ask_question` tool /
  `POST /v1/questions`) with the empty `query_graph` result nudging the
  session to ask; routing is deterministic (the server's routing module):
  the steward of the closest relevance-neighborhood node, ties by sorted
  id, no steward → unrouted and visible to everyone
- [x] `person` nodes + `stewards`/`assigned` edges — seed schemas, plus the
  `$viewer` lens binding: both doors map the token's email to its person
  node and overwrite `params.viewer` (never caller-supplied). Routing
  semantics still open below.
- [ ] Stewardship map population (start dumb: CODEOWNERS + an explicit map)
- [x] Pull-based delivery: `my_queue` and `GET /v1/queue` carry the
  routed-to-me `questions` (token → person, the `$viewer` shape), open
  questions rank in the same queue, and session-start injects
  "N questions routed to you" fail-open
- [ ] Slack webhook for urgent questions
- [x] Answer loop is lineage by construction: any node with an `answers`
  edge (seed, weight 0.7) answers the question; flipping it to
  `status: answered` (terminal) retires it from the queue

### Deliberately deferred
- Team sync via a shared git remote on `~/.spor` (pull on SessionStart,
  push after distill): was the interim transport, skipped in favor of going
  straight to the MCP server. Still works as a manual fallback — the graph
  home is an ordinary git repo.
- CRDT backend (Automerge + derived index): the scale-up path, not the
  entry price. One-fact-per-file + transactional server writes avoids
  concurrent body edits at team scale.
- Multi-party consensus/sign-off on decisions: v1 consensus = one steward's
  decision node + the correction loop.
- Embedding-based content arm: tf-idf is good enough until graphs get
  large; the swap-in point is `rankAgainst()` in the compiler.

## Known limitations

- The per-prompt digest compiles over the whole org graph by design.
  Cross-project nodes in unrelated sessions are usually signal (prior art);
  if they turn out noisy, the fix is a project-affinity boost in ranking,
  not a partition.
- The frontmatter parser is regex-based, not a YAML library: simple
  scalars, YAML folded multi-line values, and the `- {type: X, to: Y}` edge
  form only.
- The prompt-context hook runs under a 15s timeout, so nothing on that path
  may call an LLM. Briefings are precompiled (they're nodes); prompt-time
  work is select+inject.
- `additionalContext` is capped at 10KB; the digest self-caps at 4.5KB.
- The distiller spawns `claude -p`; the `SPOR_DISTILLING` env var is the
  recursion guard. Don't remove it.
- Server auth is Phase A (admin-minted bearer tokens, full read/write — the
  trust model of a shared repo). OAuth for Cowork/claude.ai connectors is
  pending (OAuth Phase B, API.md §4), so Cowork can't connect yet.

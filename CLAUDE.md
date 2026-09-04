# CLAUDE.md

Claude Code plugin ("spor") that maintains a global knowledge graph at
`$SPOR_HOME` (default `~/.spor/`; if that is absent and a legacy
`~/.substrate/` exists, the legacy dir is used — and the legacy
`SUBSTRATE_*` spellings of the user-facing env vars are still read) and
compiles context briefings from it via hooks. README.md has the
architecture and roadmap; GRAPH.md documents the node file format and the
seed ontology. This is the client half of Spor: the server, lib-engine
(lenses, rendering, routing, runs), gardener, review loop, and evals live
in the private sibling repo `../spor-server` (sporhq/spor-server), whose
client-facing contract is this repo's API.md.

## Hard rules

- **The schema registry is the contract** (QUEUE.md §2). Node/edge types,
  id prefixes, edge weights, the norm ride-along (`always_on`), and
  briefing/correction traversal exclusion (`traversable: false`) live in
  schema nodes: the seed pack in `lib/seed/` is the default, and `type:
  schema` nodes resident in a graph override/extend it (`loadGraph()` builds
  the registry; `graph.registry` is the only place to look these up — never
  re-hardcode a table). If you change the SEED ontology, update `lib/seed/`,
  GRAPH.md's documentation of it, the distiller prompts in `prompts/`, and
  the skills that encode it in the same change — and only with a CalVer
  `schema_version` bump plus upgrade chain if the change isn't
  backward-readable. Rollout-stage schemas that should ship with the package
  but NOT be active-everywhere-instantly go in `lib/seed/candidates/` (the
  candidate pack, `lib/candidates.js`): inert until `spor schema adopt`
  writes them into a graph as resident schema nodes with
  `adopted_from`/`adopted_sha` provenance stamps; promote to `lib/seed/`
  once stabilized (GRAPH.md "Resolution and rollout").
- **Zero dependencies.** The PUBLISHED surface — `lib/`, the hook engines
  (`scripts/engines/` + `bin/spor-hook.js`), shipped `skills/`, and `adapters/`
  — is plain Node (no npm install, node builtins + the git binary only). Keep
  it that way — the plugin must run anywhere Claude Code runs, natively on
  Windows, macOS, and Linux. Dependencies live only in the private server
  repo. This rule is scoped to the published tree (see `package.json`
  `files`); `.claude/` is local-operator tooling (this repo's own dogfooded
  skills/config, never part of the npm package) and is exempt — bash+jq there
  is fine as long as each script says so (see
  `.claude/skills/spor-orchestrator/scripts/`,
  dec-spor-orchestrator-scripts-scoped-zero-dep-exemption).
- **No LLM calls on the prompt path.** `UserPromptSubmit` has a 30s budget;
  `scripts/engines/prompt-context.js` must stay select+inject (tf-idf +
  graph walk only). LLM work belongs in the async `SessionEnd` distiller or
  in-session skills.
- **Never remove the `SPOR_DISTILLING` guard** in
  `scripts/engines/distill.js` — the headless `claude -p` it spawns fires
  its own SessionEnd hook on exit; without the guard, distillation recurses.
- **Refactors prove themselves byte-identical** against the live graph
  (norm-cc-byte-identical-refactor), standing-armed by the `conformance/`
  golden suite.
- The frontmatter parser is regex-based, not a YAML library. It supports
  simple `key: value`, YAML folded multi-line values (indented
  continuations), a fixed allowlist of keys
  (`pin`/`exclude`/`slugs`/`tags`/`skills`/`requires`/… — see the
  `parseFrontmatter` `LIST_FIELDS` allowlist) as either an inline list
  (`commits: [wf@1a2b3c4d]`) or a YAML block list (`commits:` alone on its
  line followed by indented `- wf@1a2b3c4d` lines — both parse to the same
  array; only these allowlisted keys get block-list support, everything else
  stays a folded scalar), and `- {type: X, to: Y}` edges, which may carry
  extra flat attributes (`- {type: assigned, to: agent-X, profile:
  profile-Y}`, preserved on the edge object). Don't write nodes with any
  other YAML constructs.

## Verifying changes

The compiler/validator core lives in `lib/graph.js` (loadGraph / compile /
validateNode / validateGraph / renderSkeleton); `compile.js` and `validate.js`
are thin CLI wrappers over it. There's a zero-dep `node:test` suite under
`test/` (including the conformance goldens). Run it from the repo root:

```bash
npm test                                              # node --test test/*.test.js
```

Also verify by exercising the real CLI paths (unchanged contracts):

```bash
node lib/validate.js                                  # graph lint, exit 1 on errors
node lib/compile.js --root <id>                       # full neighborhood
node lib/compile.js --query "some task text" --digest # prompt-time digest
node lib/compile.js --query "gibberish zzz" --digest  # must emit NOTHING (gate)
```

Hooks are tested by piping simulated payloads through the dispatcher (all
read JSON on stdin; engines live in `scripts/engines/`, dispatched in-process
by `bin/spor-hook.js` — `bin/spor-hook` is its POSIX shim,
`bin/spor-hook.cmd` the Windows one). `test/hookcli.test.js` is the
black-box contract suite over this whole surface:

```bash
echo '{"cwd": "/path/to/some/repo", "session_id": "t1"}' | bin/spor-hook session-start
echo '{"cwd": "...", "prompt": "six words minimum to pass the gate"}' | bin/spor-hook prompt-context
echo '{"cwd": "...", "session_id": "t1", "tool_name": "Edit", "tool_input": {"file_path": "/x.js"}}' | bin/spor-hook post-tool
echo '{"cwd": "...", "session_id": "t1", "transcript_path": "/tmp/fake.jsonl"}' | bin/spor-hook distill
```

Beyond the hand-built-payload contract suite, `test/e2e-claude.test.js`
(task-spor-e2e-integration-tests) drives the REAL `claude` binary with the
plugin loaded (`claude --plugin-dir . -p`) against a zero-dep `node:http` fake
Anthropic Messages API (`test/helpers/fake-anthropic.js`), replaying genuine
client paths (norm-qa-replay-genuine-paths) to catch regressions when a new
Claude Code version ships. `npm run test:e2e` runs just this file; it is part of
`npm test` but SELF-SKIPS when the `claude` binary is absent (CI runs on a
runner without it — the suite stays green) or `SPOR_E2E=0`. Set
`SPOR_E2E_CLAUDE=<path|version>` to run against a SPECIFIC Claude Code version (a
full binary path, or a bare version like `2.1.177` resolved under the native
`~/.local/share/claude/versions/`) — the fake serves a dummy key so any version
runs offline (the version-matrix override,
task-spor-e2e-claude-version-matrix-sandbox). The driver
(`test/helpers/claude-e2e.js`) replays Tier 0 (spec-correct SSE text) and Tier 1
(one `tool_use` round-trip); the remote-mode tier (claim nudge, dispatch, agent
identity) needs a live Spor server and lives in spor-server, which imports the
fake from here. Three things were paid for and must not be undone:
- **The oracle is the REQUEST BODIES claude sends + SPOR_HOME side effects, never
  claude's own response framing** (we script the responses). Hook
  `additionalContext` (briefing/digest/nudge) lands in the next `POST
  /v1/messages` as a `<system-reminder>` inside a USER message (not the `system`
  field) — `allInjectedText()` scans message text. A new CC version breaking the
  hook contract surfaces there, or in the scratch graph's nodes/cooldowns.
- **Hermeticity needs a fresh `CLAUDE_CONFIG_DIR` + clean `HOME`**: a configured
  dev box has the installed `spor@spor` plugin and `SPOR_SERVER`/`SPOR_TOKEN` in
  `~/.claude/settings.json`, which claude merges into the HOOK env — without
  isolation the hooks run in REMOTE mode against the LIVE team graph (a
  write-to-live-graph hazard, norm-cc-scratch-home-for-tests). The curated
  `env:` we pass replaces (not merges) the environment.
- **Invoke claude with async `spawn` resolving on `exit`, NOT `spawnSync`**:
  claude 2.x leaves a persistent background daemon, and `spawnSync` blocks on
  process-group/stdio teardown the daemon keeps alive — it hangs to its timeout
  even though `claude -p` itself exited in ~1s. Route stdout/stderr to temp
  files (not pipes) for the same reason.
The SSE wire encoder in the fake is pinned to the documented streaming event
contract; when a new CC version tightens parsing and it breaks, that IS the
signal. Cap fidelity by stubbing the `SPOR_DISTILL_CMD`/`SPOR_NUDGE_CMD` seams
so the fake never has to emulate distiller node markdown or the classifier
verdict. See test/e2e-claude.test.js.

For a clean version MATRIX and full isolation, `test/e2e/Dockerfile` +
`test/e2e/docker-matrix.sh` run the same suite inside a container with
a pinned Claude Code version (`npm i -g @anthropic-ai/claude-code@<ver>`): the
fake API, claude, the plugin, and the scratch graph all live IN the container, so
`docker run --rm` teardown reaps the claude daemon and any background agents —
the leak-safe home for a real `claude --bg` dispatch smoke
(issue-spor-server-dispatch-e2e-bg-agent-leak). Run `test/e2e/docker-matrix.sh
[VER ...]` (default `latest`); CI runs it on demand + weekly via
`.github/workflows/e2e-matrix.yaml`. No secrets — the fake's dummy key keeps it
offline.

The post-tool engine also carries the capture nudge
(task-cc-posttool-capture-nudge):
a Write/Edit of ≥50 words of prose to a `.md` outside the graph runs a Haiku
classifier and, if it finds capturable facts, injects a capture-or-dismiss
`additionalContext`. `~/.claude` is excluded as agent-private EXCEPT its
auto-memory files (`…/memory/*.md`, minus the MEMORY.md index), which route
through the classifier — memory writes are where durable findings land
instead of the graph (issue-spor-capture-nudge-memory-exclusion-loses-facts). Test with `SPOR_NUDGE_CMD` (prompt stdin → response
stdout, same contract as `SPOR_DISTILL_CMD`; stubs must `cat >/dev/null`
first or the prompt pipe SIGPIPEs); `SPOR_NUDGE=0` disables; cooldown
state is `journal/<session>.nudged`. `scripts/distill-gemini.sh` satisfies the
contract too (~2-7s vs ~17s for `claude -p` CLI boot). The classifier runs
SYNCHRONOUSLY in the tool loop, so two bounds keep a docs-heavy session cheap:
`SPOR_NUDGE_MAX` (`nudge.maxCalls`, default 20) caps total classifier calls per
session — each `.md` is classified at most once and a NOTHING result is free
against the separate 3-fired-nudge cap, so without this a session that writes
many `.md` files runs unbounded calls — and `SPOR_NUDGE_TIMEOUT`
(`nudge.timeoutMs`, default 30000) SIGKILLs a hung backend (the distiller has
the parallel `SPOR_DISTILL_TIMEOUT`/`distill.timeoutMs`, default 120000). All
knobs resolve through the config cascade (`u.cfgNum`). See test/nudge.test.js.
`SPOR_NUDGE_ASYNC=1` (`nudge.async`, default off,
task-cc-async-classifier-pending-result-injection) moves the classifier OFF the
tool loop entirely: post-tool reserves the file (phase-1 cooldown, a `pending\t`
line in `.nudged`) and hands the job to a DETACHED worker
(`scripts/engines/nudge-worker.js`, spawned like `debounce-watcher.js`), so the
PostToolUse call returns immediately with no injection. The worker runs the same
`classifyForNudge` and, on facts, drops a phase-2 result file under
`journal/pending-nudges/<session>/<hash>.out.json`; the NEXT UserPromptSubmit
DRAINS those files, merges them into ONE capture nudge, and injects it with NO
LLM call (`drainPendingNudges` in prompt-context.js — a pure file read, so it
stays clean under norm-cc-no-llm-prompt-path). Injection runs even for a
trivial/continuation prompt (a pending finding is about a written file, not the
prompt) but is gated on `nudge.enabled` too (`SPOR_NUDGE=0` suppresses the drain,
not just the spawn). The 3-fired cap can't be read at spawn (async doesn't know
outcomes), so it's approximated by injected nudges
(`journal/<session>.nudged-injected`) PLUS results already waiting in the spool;
once that hits 3, further spawns are suppressed — a best-effort analog of the
synchronous 3-fired early-stop, backstopped by the hard `nudge.maxCalls` ceiling.
Known tradeoff (inherent to one-turn-delay): a finding in a doc written as the
FINAL action of a session — no subsequent prompt — is never injected; the
SessionEnd distiller is the backstop that still captures it. The default
synchronous path is byte-identical (the drain and its syscalls are gated on the
flag). See test/nudge-async.test.js.

The prompt-context engine's digest has the same async pattern as an INTENT GATE
(issue-spor-user-prompt-submit-digest-noise,
dec-spor-digest-noise-needs-async-semantic-intent): the digest over-fires on
high-similarity LEXICAL false-matches that no fire-gate threshold separates
(the eval, art-spor-digest-noise-eval-2026-06-25 — F1 peaks at the current
min-sim 0.08), so the residual gate must be semantic, i.e. an LLM call, which
cannot live on the prompt path. `SPOR_DIGEST_ASYNC=1` (`digest.async`, default
off) moves it off: UserPromptSubmit runs the deterministic gates + compile
exactly as before, but instead of injecting it spools the micro-digest
(`journal/pending-digests/<session>/<hash>.in.json`) to a DETACHED worker
(`scripts/engines/digest-worker.js`, spawned like nudge-worker.js) that asks a
backend whether injecting that context would help the prompt's work
(`prompts/client/digest-intent.md`; backend `SPOR_DIGEST_INTENT_CMD` /
`digest.intentCmd`, same stdin→stdout contract as `SPOR_NUDGE_CMD`; default
`claude -p --model haiku`; bounded by `SPOR_DIGEST_INTENT_TIMEOUT` /
`digest.intentTimeoutMs`, default 30000). Only an explicit UNWARRANTED verdict
suppresses — a backend failure or unparseable reply still writes the result
file, so the classifier can only REMOVE noise, never lose a warranted digest.
The NEXT UserPromptSubmit drains the newest result and injects it with NO LLM
call (norm-cc-no-llm-prompt-path), consuming superseded snapshots and deduping
against the last injected signature (`journal/<session>.digest-injected`).
Spend is capped by `SPOR_DIGEST_INTENT_MAX` (`digest.intentMaxCalls`, default
20 classifier spawns/session, one line each in
`journal/<session>.digest-intent`); at the cap — or on any spool/spawn failure
— the engine falls open to the shipped SYNCHRONOUS injection (and a pending
result arriving beside a synchronous digest is consumed, not double-injected).
The default path is byte-identical (spool, drain, and their syscalls are all
gated on the flag), and the same one-turn-delay tradeoff as the async capture
nudge applies: a digest for a session's final prompt is dropped. Enabling it by
default is deliberately deferred until the classifier is scored against the
eval's `warranted` labels. See test/digest-async.test.js.

The post-tool engine ALSO carries the coupling nudge
(task-spor-coupling-nudge-posttool, dec-spor-coupling-norms-declared-first) —
BOTH modes, deterministic, NO LLM: on every Write/Edit it glob-matches the
edited repo-relative path against the `couples_when:` triggers of coupling
norms (norm nodes carrying `couples_when:` + `couples_also:` inline lists, see
GRAPH.md) and injects the `couples_also:` targets — "you changed X, don't
forget Y" at the moment of the edit. Entries may be repo-qualified
`<slug>:<glob>` for cross-repo couplings (a qualified trigger fires only in
that repo and bypasses the norm's scope; an unqualified one follows the
`applies_to_*`/`project:` scoping). The matcher is `lib/kernel/coupling.js`
(shared with `spor check`, the boundary-time twin: a diff-level report of
triggers-touched-but-targets-not plus `couples_value_a/b` value-invariant
comparison — advisory, `--strict` for CI; lib/check.js, see
test/check.test.js);
norms come from the local nodes dir keyed by a readdir+mtime fingerprint
(local mode, so a freshly authored norm is live on the next tool call) or a
1h-TTL `cache/coupling.json` snapshot of `GET /v1/export` (remote mode; the
`fetched` stamp is written BEFORE the download so a dead server costs at most
one bounded attempt per TTL — `SPOR_COUPLING_NUDGE_TIMEOUT` /
`couplingNudge.timeoutMs`, default 3000). Once per (session, norm) via
`journal/<session>.coupling-nudged`; precedence claim-nudge > coupling >
capture, and a coupling hit taking the envelope does NOT burn the file's one
capture classification (no `.nudged` line is written, so its next edit still
classifies). Disable with `SPOR_COUPLING_NUDGE=0`
(`couplingNudge.enabled:false`); a graph with no coupling norms is
byte-identical. See test/coupling-nudge.test.js + test/coupling.test.js.
Deriving a symlinked subtree's candidate spellings is one-way (alias ->
canonical, never canonical -> alias — a runtime reverse lookup would need a
filesystem-wide symlink scan, dismissed as too expensive for the edit-time
hot path, dec-spor-dismiss-reverse-symlink-path-lookup), so a glob authored
against an alias still misses an edit reported only in its resolved form
(issue-spor-coupling-matcher-reverse-symlink-gap). The settled fix is
`coupling.aliases` in `.spor.json` — a declared `{ "<alias prefix>":
"<canonical prefix>" }` map, expanded in both directions at zero runtime
cost by `coupling.js`'s `expandAliasCandidates`, shared by both this nudge
and `spor check`. Declaring nothing is the default posture and keeps the
one-way limitation (GRAPH.md documents it).

The post-tool engine ALSO carries the claim heartbeat ∪ claim-nudge
(task-cc-claim-nudge-hook, dec-cc-task-claim-lease) — REMOTE-MODE ONLY and a
NO-LLM boolean lease lookup (a queue read, not a classifier; it stays off the
LLM path). On every Write/Edit in a team-mode repo it does one
`GET /v1/queue?project=<slug>&assignee=me` (the assignee read is the
lease-exempt steward view, so the person's own carried work returns tagged with
`lease_state`/`lease_by`) and branches: this PERSON holds a live (`in_progress`)
claim here → ONE `POST /v1/queue/renew` with an EMPTY body (the heartbeat,
piggybacking on write-activity — no new timer, so it's portable across adapters
that don't fire hooks uniformly), no nudge; this person holds none → nudge ONCE
per session to claim a top eligible pool item (`GET /v1/queue?project=<slug>`)
or `/spor:defer`. That renew is deliberately `renewAll`'s BLANKET arm —
`ids` omitted, and `session` omitted too
(dec-spor-heartbeat-adopts-blanket-renew-arm): the named-`ids` arm and the
singular `/v1/nodes/{id}/renew` both AUTO-RECLAIM a lapsed lease, which is right
for a caller who names a node and wrong for a background beat that would then
silently re-take work another actor released; and in the blanket arm `session`
is a FILTER, so sending it would skip the leases claimed outside a session
(`spor claim`, `spor dispatch`'s pre-launch claim) and let them lapse. The
trade the blanket arm accepts is the mirror one — a lapsed node silently drops
out of the working set — so the heartbeat journal line carries `renewed` (what
the server confirmed) and `dropped` (held work this beat SAW but did not
renew — the GET→POST race, or a node held live by someone else), and the
SessionEnd reserve/release hook replays both in order (`distill.js`
sessionEndLease) so it never `reserve`s — and thereby auto-reclaims — a node the
beat reported letting go. Note `renewed` is what the server confirmed only when
it answered: on any non-200 the beat keeps the optimistic list rather than
dropping a live lease out of SessionEnd's reach on a blip. The residual: a lease
that vanishes from the project lookup ENTIRELY between beats (the ordinary
45m lapse, or a `spor release` from another terminal) is never reported as
dropped, so SessionEnd still `reserve`s it and the server auto-reclaims — which
IS the decided behavior for a named call by the session that worked the node
(dec-spor-lease-auto-reclaim-and-deadline-exposure exists for exactly the
lapsed-long-session case), but it means the no-reclaim guarantee is the
heartbeat's, not the whole client's. Person-scoped suppression (a held claim from ANY
session, including a Tier-2 `reserved` reservation, suppresses); the beat renews
the person's live Tier-1 leases. Two costs ride with the arm, both accepted with
it: the beat is NOT project-scoped (the enumerate arm takes no project, while
the lookup above is project-scoped — so the journal is narrowed back to this
project's held work, but a write in ANY opted-in repo renews the person's leases
everywhere, and a lease nobody releases — a `claude --bg` agent killed before
SessionEnd — stops self-healing back into the pool at its TTL while its owner
keeps working elsewhere); and the arm never re-stamps `live.session` (it selects
on it), so lease session bindings go stale rather than following the last
editing session, which is what the server's `skipped_other_session` drift signal
keys on. Cooldown
`journal/<session>.claim-nudged`; disable `SPOR_CLAIM_NUDGE=0`
(`claimNudge.enabled:false`); the lookup/heartbeat curls are bounded by
`SPOR_CLAIM_NUDGE_TIMEOUT` (`claimNudge.timeoutMs`, default 3000). Fail-open:
any non-200/unparseable/dead-server lease state → no nudge, exit 0 (never nudge
during an outage). LOCAL mode is a no-op (returns before any side effect, so
local output is byte-identical). The branch runs first and its nudge takes the
single output envelope; the heartbeat branch returns null so a held-claim write
still falls through to the capture nudge. See test/claim-nudge.test.js.

The post-tool engine ALSO carries the FLEET liveness tick
(task-spor-fleet-scheduler-client-heartbeat-tick) — REMOTE-MODE ONLY and the
client caller for the server's `POST /v1/agents/{id}/heartbeat`
(art-spor-fleet-scheduler-hardening-shipped). The fleet scheduler keys its
host-match staleness (`?max_age` on `GET /v1/profiles/{id}/hosts`) off the agent's
`last_seen`, which today only the session-start auto-publish refreshes — the
EXPENSIVE way (a full caps re-publish per session), so a box that publishes once
and then runs for hours ages out of host-matches mid-session even though it's
alive. This tick refreshes `last_seen` the CHEAP way: a bodyless POST that
re-stamps it WITHOUT re-probing or re-uploading capabilities. Like the claim
heartbeat it piggybacks on write-activity (no new timer, portable across
adapters), but it's THROTTLED to one ping per `dispatch.heartbeatIntervalMs`
(`SPOR_HEARTBEAT_INTERVAL`, default 5min) via a per-session cooldown file
(`journal/<session>.heartbeat`, holding the last-tick epoch ms) — a held lease must
renew on every write, but liveness only needs to beat the staleness window. Gated
on a configured `dispatch.agent` (the SAME opt-in as the session-start
auto-publish — a box that never ran `spor agent use` has no fleet identity to keep
alive); bounded by `dispatch.heartbeatTimeoutMs` (`SPOR_HEARTBEAT_TIMEOUT`,
default 3000). The cooldown is stamped BEFORE the curl so a dead/slow server can't
make every write pay the timeout (at most one attempt per interval). Always
returns null (a pure side effect, never the output envelope), so it doesn't
compete with the claim/capture nudges; LOCAL mode is a no-op (byte-identical
output). Fail-open: any error/non-200 (a 404 means caps were never published —
publish-before-heartbeat) is journaled (`tool: agent-heartbeat`) and swallowed,
exit 0. Disable with `SPOR_HEARTBEAT=0` (`dispatch.heartbeat:false`). See
test/heartbeat.test.js.

Hooks have two modes (API.md §6): the payloads above test LOCAL mode;
prefix `SPOR_SERVER=http://127.0.0.1:<port> SPOR_TOKEN=<token>` to
test REMOTE mode against a running server (or a dead port for the fail-open
path — hooks must exit 0 fast and inject cache/nothing). Local mode with
`SPOR_SERVER` unset must stay byte-for-byte identical to the original
behavior.

For the distill engine use a fake transcript (JSONL of
`{"type":"user|assistant","message":{"content":[{"type":"text","text":"..."}]}}`,
≥80 words) — note it makes a real `claude -p --model haiku` call and writes
real nodes; point `SPOR_HOME` at a scratch dir first.

End-to-end: `SPOR_DISTILLING=1 claude --plugin-dir . -p "<question only
the graph can answer>"` from a project directory whose nodes exist in the
graph. (`SPOR_DISTILLING=1` stops the test session distilling junk into
the real graph.) Note the same marker now also suppresses the
UserPromptSubmit digest (issue-spor-digest-fires-on-headless-backend-
personas: backend personas are not user prompts), so this recipe exercises
the session-start briefing only — test the digest via the `bin/spor-hook
prompt-context` payload above.

When testing against a scratch graph, set `SPOR_HOME=/tmp/whatever` — never
test write-paths against your live graph home. The live graph (the one the
Spor server and distiller auto-commit into) and the client-side cache/outbox
home in remote mode (`~/.spor`, or a legacy `~/.substrate`) are off-limits to
tests; point `SPOR_HOME` at a throwaway scratch dir instead.

## Gotchas already paid for

- The hook engines are fail-open by contract (dec-cc-fail-open-hooks): the
  dispatcher catches everything and exits 0 with no output. A symptom-free
  hook is therefore also what a crashing engine looks like — check
  `journal/distill.log` / `journal/remote.log` before trusting silence.
  (The retired bash engines had the same trap via `set -euo pipefail`.)
- Engine semantics intentionally preserve bash quirks the graph relies on:
  `$()` command substitution stripped trailing newlines (templates, backend
  responses, digest bodies), `head -c`/`tail -c` truncate BYTES not chars,
  and jq's `now|todate` is second-precision UTC. `scripts/engines/util.js`
  encodes these; don't "clean them up" — outputs are verified byte-identical
  against the pre-port engines (see the port commit).
- `additionalContext` caps at 10KB; the digest self-caps via `DIGEST_CAP` in
  compile.js (4.5KB). Session-start truncates the briefing body at 7KB.
- The digest relevance gate is `--min-sim` (default 0.08 top cosine); the
  trivial-prompt gate in the prompt-context engine is ≥6 words and not a
  `/command`.
- Haiku-as-distiller invents edge-type variants (`related-to`,
  `supercedes`, `derives-from`); the distill engine normalizes them on write
  (EDGE_FIXES in scripts/engines/distill.js; the server does it via its own
  normalization table in remote mode). If you see new variants in the
  distill log, extend the table, don't loosen the validator.
- Haiku-as-distiller will CONTINUE the transcript's dialogue instead of
  distilling it if the prompt ends with the raw conversation tail (real
  session tails end mid-dialogue — "Ready for next?"). The distiller prompt
  must fence the transcript in BEGIN/END markers and restate the
  output-format instruction AFTER it. Synthetic test transcripts don't
  trigger this; only real ones do. Also: `claude -p` inside a hook needs
  `</dev/null` or it stalls 3s waiting on the already-consumed stdin.
- Hook JSON output shape: `{"hookSpecificOutput": {"hookEventName":
  "<EventName>", "additionalContext": "..."}}` — hookEventName must match
  the firing event.
- `${CLAUDE_PLUGIN_ROOT}` is only substituted in hooks.json command strings;
  engines locate `lib/` and `prompts/` relative to themselves
  (`scripts/engines/util.js` ROOT).

## Project slug convention

A session's project is `basename $(git rev-parse --show-toplevel)` of its
cwd (falling back to `basename cwd`), normalized to kebab-case: lowercased,
runs of non-alphanumerics collapsed to `-`, trimmed (`My_Repo` → `my-repo`,
`MyProject.AppHost` → `myproject-apphost`; identity for names
already kebab-case). A committed `.spor` marker file (`project: <id>`) beats
inference, read by NEAREST ancestor (walk cwd → repo root), so a monorepo
subtree marker (`services/api/.spor`) beats the root's and splits one repo
into distinct identities; the value must already be canonical — a
non-matching value is ignored, not normalized. A git **worktree** infers
from its main repo's basename (`dirname(git rev-parse --git-common-dir)`),
not the worktree dir, so every worktree of one repo shares one identity and
the shared fingerprints don't trip false rename detection
(issue-cc-project-identity-monorepo-worktree). The normalization lives
in ONE place — `projectSlug()` in `scripts/engines/util.js` — and must
stay in sync with the server's `SLUG_RE` (`^[a-z0-9][a-z0-9-]*$`, in the
server repo's `server/rest.js`), which rejects anything non-canonical.
The slug determines which `brief-<slug>` node session-start injects, the
`project:` stamp on distilled nodes, and journal tagging. (The same flat
marker also carries a `graph: <path>` key — the per-repo shared graph **home
binding**, not a slug; see "Client config cascade".) Renaming a repo
changes its slug, which used to orphan the old project tag (the 2026-06-12
substrate→spor rename did exactly this; see brief-spor / brief-spor-server)
— `type: project` nodes with `slugs:` alias lists heal this at read time
(GRAPH.md "Project identity nodes"); historical `project:` stamps never
rewrite.

## Client config cascade

Client settings resolve through `lib/config.js`
(`loadConfig({cwd, env})`), the realization of dec-cc-spor-cli-universal-surface's
"mode via a lib/config cascade" — see dec-spor-client-config-cascade. Precedence
high-first: CLI flags > env (`SPOR_*`/`SUBSTRATE_*` via `home.envDual`) > repo
`.spor.json` (nearest-ancestor walk, deepest wins, secrets stripped) > user
`$SPOR_HOME/config.json` > global `$XDG_CONFIG_HOME/spor/config.json` >
built-in defaults. **Env sits above the files on purpose**: with no config
files present every resolved value equals the prior env-or-hardcoded default,
so the change is byte-identical (norm-cc-byte-identical-refactor, verified
against the live graph for compile/validate/digest/skeleton). The ONE
deliberate exception is `Config.enabled()`: the plugin is now opt-IN per repo
(task-spor-plugin-opt-in-default, see "Opt-in activation" below), so a
markerless, never-enabled repo resolves to a no-op instead of the old
default-on — every OTHER resolved value stays byte-identical. Engines read it
through the active config the dispatcher sets per run
(`u.useConfig`/`u.config()`/`u.cfgStr`); when none is active, every read falls
back to the exact `envDual` it replaced, so standalone calls and unit tests
stay byte-identical. `.spor.json` is config, held SEPARATE from the `.spor`
identity marker (which stays flat `key: value`). **Per-repo graph home
(local-mode git sharing, dec-spor-local-mode-sharing-boundary):** a `graph:
<path>` key in the flat `.spor` marker binds the repo to a shared graph home
and is the ONE input that beats env — it **overrides `SPOR_HOME`** (resolved in
`repoMarkerGraph()`, lib/config.js, merged above env but below an explicit CLI
`--home`), because the point is that a contributor with a personal global
`SPOR_HOME` still inherits the *shared* graph inside a shared-graph repo. It is
a path (not a slug), resolved relative to the marker's own dir so a committed
`graph: ../team-graph` is cwd-stable; nearest-ancestor with a `graph:` key wins
(an identity-only deeper marker doesn't shadow it); LOCAL mode only — in remote
mode the server is the graph, so the marker is ignored. `.spor.json`'s `home`
stays an ordinary BELOW-env setting; only the marker `graph:` beats env. When a
marker home is in force, session-start ensures a `.gitignore` there for
machine-local state (`/journal/ /cache/ /outbox/ /auth/ /config.json`; durable
`nodes/`+`history/` stay tracked), and the SessionEnd distiller SKIPS its
auto-commit when the graph home is the same git repo as the code repo (the
nested-repo case — `Config.sharedGraphHome()` gates the first,
`graphInsideCodeRepo()` the second; distilled nodes then ride the human PR
flow). **Opt-in activation (task-spor-plugin-opt-in-default):** the plugin is a
no-op in any repo that hasn't opted in — `Config.enabled()` is true only when
mode≠`off` AND either (a) an explicit `enabled` flag resolved anywhere in the
cascade (`enabled:true`/`false` in any config layer, `SPOR_ENABLED` env, or a
`--enabled` CLI flag — explicit wins, true on / false off) OR (b) a repo-level
`.spor` or `.spor.json` marker sits in the cwd ancestry (what `spor
enable`/`link`/`dispatch --backfill` write; `enable` writes `.spor.json
{enabled:true}`). Default — no flag, no marker — bails fail-open in the
dispatcher (`bin/spor-hook.js`) so running an agent in an unrelated side
project never injects context or distills nodes into the shared graph, even in
remote mode (a globally-set `SPOR_SERVER` resolves the *mode* to remote but
does NOT imply *enabled*). The presence walk is `repoMarkerPresent()` in
lib/config.js; this repo ships its own `.spor.json {enabled:true}` to dogfood
it. Other levers beyond env migration: neighborhood-search project controls
(`search.minSim`, `search.projects.{include,exclude,boost}`, applied in
`lib/kernel/graph.js` compile, no-op when empty), the path-scoped sub-briefs
map (`briefs`, a committable relative-subtree-path→brief-id manifest for a
monorepo; `Config.briefs()`/`briefsBase()` anchor it at the nearest-ancestor
`.spor.json` carrying the key, and session-start routes cwd to the
nearest-ancestor area via `u.matchBriefs()` and surfaces the siblings as a
discovery line — dec-spor-monorepo-path-scoped-briefs; a covered subtree is an
"area" label on a brief, never a node type, and distilled nodes still stamp
`project: <repo>`), and the `spor dispatch`
slug→local-path map (`dispatch.repos`, a per-machine `{slug: path}` table the
shared graph can't hold; written to the USER `$SPOR_HOME/config.json` by
`spor repos`/`session-start`, read via the cascade — never a committable
`.spor.json`, since paths are machine-specific), and its sibling
`dispatch.capabilities` — the machine-local profile-satisfiability map
(harnesses/reachable-MCP/skills/plugins + a `deny` policy list) probe-populated
by `session-start` and declared by `spor capabilities`, in the SAME user
config.json (`dispatch.capabilities.probed` is refreshed wholesale, `.declared`
is sticky, `.deny` overrides both; the pure matcher is `lib/kernel/satisfiability.js`,
task-spor-dispatch-capabilities-satisfiability). The probe seeds
`reachable_mcp: [spor]` into `.probed` from CONFIGURED-ness — when a Spor
server/connector is bound (remote mode), the spor MCP is reachable by
construction, so an `mcp: [spor]` profile satisfies on a fresh dispatched box
with no manual `allow-mcp` and no flaky network ping; the seed rides `.probed`,
so it drops out when the server is unconfigured (other MCP reachability stays
declared, task-spor-mcp-reachability-deterministic-seed).
**Declared custom harnesses (task-spor-dispatch-declarative-custom-harness):**
a profile may name a harness with NO in-code adapter; the graph then carries
only `harness: <id>` and a MACHINE-LOCAL `dispatch.harness.<id>` declaration
binds that id to what it runs — `{command, args, label, report, session}`,
normalized by `normalizeHarnessDeclaration` in `lib/shell/dispatch-harnesses.js`
and synthesized into an ordinary registry-shaped adapter (`declaredAdapter`), so
the launcher, the supervisor, `--print` and run discovery gain no
"is this declared?" branch. Everything outside those five keys is FIXED by v1
scope and naming it is a refusal: supervised-jsonl, prompt on stdin,
`identityMode: env-token`. The argv template takes `{cwd}`/`{report}`/`{model}`
tokens (a `{model}` entry is dropped whole when no model resolves, so the
normalizer refuses a standalone `{model}` and one sharing an entry with a path
token); the launcher's placeholder substitution is SUBSTRING only for a declared
harness and stays whole-entry equality for the built-ins
(norm-cc-byte-identical-refactor — substring would also rewrite a placeholder
appearing in a graph-supplied `profile.model`). The supervisor rebuilds the
adapter from `job.harness_declaration`, never from config, so a config edit
mid-run can't change how a live stream is read. **A graph write must never
define what a machine executes**, enforced both ways: a profile node carrying
any of `sat.GRAPH_LAUNCH_FIELDS` (command/args/argv/bin/exec/entrypoint/env/
report/session/launch_mode/identity_mode) is REFUSED by `spor dispatch`, and a
machine with no binding for the id fails satisfiability (refuses loudly, leaves
the assignment and lease intact, names the missing declaration). The same rule
covers a write a TEAMMATE could land: `dispatch.harness` and `dispatch.bin` are
stripped from a committable repo `.spor.json` with a warning
(`REPO_FORBIDDEN_PATHS`, lib/config.js) — they resolve only from env, the user
`$SPOR_HOME/config.json`, or the global one. The probe adds valid declared ids
to `machine.harnesses`, so `spor capabilities` and the fleet publish reflect
them. See test/declared-harness-dispatch.test.js. In REMOTE mode, when a
`dispatch.agent` is configured (`spor agent use`), `session-start` ALSO
auto-publishes the freshly-probed effective capabilities to the fleet scheduler
(`POST /v1/agents/{id}/capabilities`) — folding the manual `spor capabilities
publish` into the probe so the fleet view auto-populates and the box's
last-contact stays fresh (task-spor-fleet-capabilities-autopublish-session-start).
It rides the same concurrent batch as the briefing/queue reads (so it adds no
latency), is bounded (`dispatch.capabilitiesPublishTimeoutMs` /
`SPOR_CAPABILITIES_PUBLISH_TIMEOUT`, default 3s) and fail-open like the claim
heartbeat; the `dispatch.agent` requirement is the opt-in (a box that never ran
`spor agent use` never publishes), and `SPOR_CAPABILITIES_PUBLISH=0`
(`dispatch.capabilitiesPublish:false`) disables it. Between session-starts the
`post-tool` engine keeps that same `last_seen` fresh the CHEAP way — a throttled
`POST /v1/agents/{id}/heartbeat` that re-stamps liveness without re-probing or
re-uploading caps (task-spor-fleet-scheduler-client-heartbeat-tick), gated on the
SAME `dispatch.agent` opt-in, throttled by `dispatch.heartbeatIntervalMs`
(`SPOR_HEARTBEAT_INTERVAL`, default 5min), bounded by `dispatch.heartbeatTimeoutMs`
(`SPOR_HEARTBEAT_TIMEOUT`, default 3s), and disabled by `SPOR_HEARTBEAT=0`
(`dispatch.heartbeat:false`).
**The work loop (task-spor-work-loop):** `spor work` is the pull-based
continuous worker over the queue — poll, dispatch, await the TERMINAL state,
repeat — and is a GENERALIZATION of `spor dispatch --from-queue`, never a second
dispatcher: selection is the shared `dispatchableQueuePage()` and every launch
goes through `cmdDispatch` (so all its guards, the auto-claim, worktree
isolation, the supervisor, the run record and the terminal-state contract apply
unchanged and can never drift). The loop machine is `lib/shell/work-loop.js`,
dependency-injected so it drives with a fake clock/queue/dispatcher; `cmdWork`
in `bin/spor.js` is the wiring. Two things it owns beyond dispatch: a slot frees
only when the RUN RECORD goes terminal AND its outcome is settled — never when a
launcher returns — and any item that was refused — or whose run ended WITHOUT resolving, which hands the
lease back and returns it to the pool — cools off for `work.retryAfterMs` so the
worker walks down the queue instead of re-dispatching one node every poll. The
refusal REASON is the refusal's own first stderr line, captured through the
`ERR_TEE` sink in `bin/spor.js` rather than by teaching a dozen guard sites to
report themselves twice (the first UNINDENTED, non-`warning:`/`note:` line, since
a refusal is routinely preceded by an aside and followed by indented
remediation); `cmdDispatch`'s optional third arg (`ctx.onLaunch`) reports the run
id the exit code can't carry. "Settled" is `contract_pending` — a supervised
record goes terminal SYNCHRONOUSLY carrying a provisional unenforced outcome and
the verified verdict merges in up to three bounded round-trips later
(`closeWithOutcome`), so harvesting on `state` alone would file a run that
RESOLVED its target as an unenforced `reported` and cool the node off; the flag
is cleared by the contract write, and the hold is doubly bounded — it lasts only
while the supervisor is demonstrably alive (pid identity-checked) AND inside
`contractGraceMs` (60s, the contract's own worst case), because a supervisor
killed mid-contract leaves the flag set forever and a recycled pid satisfies the
bare probe a non-Linux host degrades to. The mirror hazard
is a slot held FOREVER: a native-background run whose harness can no longer be
enumerated never goes terminal at all, so `work.runMaxMs` (`--run-max`, default
24h) is the watchdog and the un-enumerable case is warned about rather than
hidden. That watchdog bounds a run's LENGTH and only ever stops FOLLOWING it,
which is the wrong instrument for a WEDGED one, so `work.runIdleMs`
(`--run-idle`, default 45min, 0 disables) bounds its SILENCE and actually ends
it (task-spor-work-idle-run-detection): a run whose OBSERVED output has not
moved for the ceiling is STOPPED and classified `failed`/`idle-timeout`, with a
recognized environment signal in the log still winning over the generic
reading. Observed is `observedActivityAt` — the log's or the transcript's mtime
with `lastActivityAt`'s launch fallback REMOVED, because a native launch whose
session was never bound has no readable channel and judging it on its launch
stamp would stop a healthy agent at the ceiling; a 0 there falls through to the
watchdog. Stopping means the run is OVER, not that a signal was sent: the
supervisor's whole (detached) process GROUP is SIGTERMed — grandchildren
included, and group membership is stronger ownership evidence than a bare pid —
then anything we signalled that still answers after a bounded grace is
SIGKILLed, all gated on the supervisor's recorded start-time ticks so a recycled
pid is never touched. What it measures is SILENCE, not idleness, so one tool
call longer than the ceiling is stopped mid-work — the accepted trade, with
`--run-idle` as the lever (WORKERS.md §8). Both that classification and the `contract_pending` harvest above
RE-READ the graph first (`verifyRunResolution`, the verify leg of
lib/shell/dispatch-terminal.js lifted out as `resolvedOutcomeFromNode`): an
agent that wrote its resolver and then hung — or one whose supervisor was
killed inside the 60s grace — genuinely finished the work, and filing it as an
unenforced `reported` gates and cools an item that is done. Only a POSITIVE
reading ever overwrites what a record says, so an unreachable graph leaves the
provisional verdict exactly as it was. Two things the idle stop deliberately
does NOT do: it never releases the LEASE (that is the terminal contract's job,
part of filing a report a wedged run never produced — leaving it held keeps
other workers off the node and self-heals at its TTL), and where there was
nothing of ours to signal — or the stop did not take — it takes the WATCHDOG's
cooldown rather than the ordinary refusal window, since it then only stopped
FOLLOWING the run and a second agent must not land in a checkout the first may
still hold. There is deliberately no `--no-claim` passthrough (the lease is the only
thing keeping two pull workers off one node), and numeric options are REFUSED
rather than silently replaced (`--max $UNSET` must not become an unbounded
worker). The LOOP never passes `--force` (a loop
that forces past the duplicate/resolved guards is the runaway a pull worker must
not be — the gate pipeline's bounded fix cycle below is the single deliberate
exception), and a worker never claims a `readiness: human` item even though
one-shot dispatch only warns on the non-`requires:human` half (WORKERS.md §3).
Knobs: `work.concurrency` (1), `work.intervalMs` (30s), `work.maxIntervalMs`
(the idle backoff ceiling, 5min), `work.retryAfterMs` (10min),
`work.runMaxMs` (24h), `work.runIdleMs` (45min),
`work.project` (falls back to `queue.project`). Status is machine-local under
`journal/work/<worker>.work.json`, read back by `spor work --status [--json]` (a
worker whose pid is gone reads STALE, never running). See test/work-loop.test.js.
**The gate pipeline (task-spor-work-gate-pipeline):** the loop still runs BARE
by default — with no factory declared nothing changes — but `work.factory`
(`--factory <id>`) points it at a graph-resident `type: factory` node
(candidate schemas `schema-factory`/`schema-gate`, adopted, never seed) whose
ORDERED gate list is enforced IN CODE between the claim and the resolve, never
handed to an orchestrator agent as prose (dec-spor-software-factory-substrate).
The vocabulary is pure (`lib/kernel/gates.js`: parse the definition, fold inline
and `{ref: gate-<id>}` gates into ONE list the runner cannot tell apart, match
declared globs, read a review verdict); the execution is
`lib/shell/gate-runner.js`, dependency-injected like the loop. Three kinds.
**command** runs the declared suite from the TRUSTED ref — a throwaway worktree
at the implementer's commit with every declared protected path forced back to
`trusted_ref`'s copy — and a change that TOUCHED a protected path fails CLOSED,
unrun and unretried, filing the test change as its own item under the declared
`test_lane_profile` (a different lane: same entity, same misunderstanding). It
judges COMMITTED work only — uncommitted TRACKED changes (or an unreadable `git
status`) refuse the gate, while untracked suite residue is ignored. A declared
`reruns` (default 0, max 3; also on the `integration:` block) re-runs the SAME
command on the SAME tree before a failure is charged — a flaky full suite then
costs one more suite run, not a fix dispatch or a rescue — and a rerun-rescued
pass keeps the first failure as evidence on its fact so flakes stay countable
(`gates.rerunDecision`, task-spor-factory-spor-flaky-command-gate-needs-fix-cycle-or-rerun). **agent-review**
dispatches a profile-routed (cross-model) review through the same `cmdDispatch`
path, waits for its terminal state, and parses a fenced-JSON findings verdict in
code — unreadable, undispatchable or report-less is a FAILURE, never a pass (so
the profile must be a SUPERVISED harness: the report is the verdict channel) —
then loops implementer fix cycles up to the declared `cycles` cap (the ONE place
the worker passes `--force`: the node reads resolved because the run resolved
it) before escalating with a `requires: [human]` queue item. The review is
STATEFUL and BOUNDED (task-spor-review-gate-stateful-bounded, WORKERS.md §10.4):
it runs read-only (`spor dispatch --read-only`, the adapter's posture), its prompt
carries the work item, the bounded diff, the prior findings by ledger id and the
last fix's commits; only a DEMONSTRATED `blocking` finding blocks (`evidence`
required, `introduced_by_fix` on a fix cycle — everything else is advisory), a
verdict that ignores a prior finding is unreadable and counts as changes_requested
for the prior set only (so is a `changes_requested` with no readable findings — a
malformed entry or a missing/empty list is never filtered down to a pass), and the
per-gate finding ledger rides on the `art-gate-*` fact AND on the run record
(`gate_progress`: ledger + fix count + attempts + last fix, saved BEFORE each fix
dispatch, so a resumed pipeline keeps its prior findings and its cap holds across
the interruption). `--read-only` REFUSES on a harness with no posture (the built-ins
all have one: codex sandbox, claude plan mode, opencode `--agent plan` plus a
`bash: deny` for that agent via `OPENCODE_CONFIG_CONTENT` from the adapter's
`prepareRun` — plan mode alone leaves the shell write-capable — and copilot
`--deny-tool write --deny-tool shell`; the OpenCode and Copilot reviewers
therefore cannot run commands, so they cannot demonstrate a blocking finding
and their verdicts are advisory). An unreadable verdict (unrecognized word, no
structured verdict) carries the whole prior set to the fixer still open; a
fresh finding reusing a resolved ledger id mints a new entry; the fold
snapshots every entry it touches (`prev`) so `rollbackCycle` restores it
exactly, evidence included. Evidence is a non-empty STRING (a boolean `true`
or a bare "yes" is not a demonstration), a `changes_requested` backed only by
undemonstrated blocking findings PASSES with them recorded as advisory (the
contract is demonstrated-only; failing it charged fix cycles to nothing), an
upgrade by id must match the ledger entry's file and takes the ledger's
identity, the review dispatch drops the worker's harness flags
(`permission-mode`/`sandbox`/`approval-policy`/`agent`/`model` — a foreign flag
is refused by the reviewer's adapter), and a fix cycle already launched under
its unique run name is ADOPTED on resume, never dispatched twice
(`gate_fix_gate`/`gate_fix_cycle` ride the stamp so `loadGateProgress` reads
the launch back). `cycles` counts FIX dispatches (`cycles: 3` = initial review + 3 fixes). **human** arms on
declared risk classes, files an approval item and BLOCKS the resolve until a
live RESOLVING EDGE (approved — a bare status flip is not an approval) or any
other terminal status (refused) answers it, reporting `blocked` at `approval_timeout_ms` rather than deciding for the
person. Every gate outcome is a deterministic, idempotent `art-gate-*` artifact
carrying `relates-to` the work item (never `resolves` — a gate records, it does
not retire). Only a CLAIM is gated (`shouldGate`: a verified `resolved`, or an
UNENFORCED `reported` where nothing could check it), the gated item HOLDS its
slot until the pipeline settles (and its node is out of candidate selection for
EVERY worker on the box while it does, so a free slot never re-dispatches what a
gate is judging), and a
factory that does not validate REFUSES to start the worker rather than running it
ungated. WHAT a factory may gate is the factory's own declaration, never the
worker's `--project` (issue-spor-work-scope-union-factory-mismatch): a bare
repo slug on the queue resolves UP to its home-project grouping and unions the
members, so a `--project spor-server` worker is handed repo:spor items and its
command/integration commands run against a checkout they were not authored for.
The payload's `repos:` (defaulting to the factory NODE's own repo stamp; a
factory with NEITHER is unscoped and byte-identical to before — an existing
factory carrying a repo stamp does change, which is the fix) bounds candidate
selection — `gates.repoScope`/`inRepoScope` compared against the item's own
stamp, so an out-of-scope item is skipped VISIBLY (stdout + `--status`, like a
policy skip), an item with no stamp or an unlisted historical alias fails
closed, and a lone declared repo also becomes the default `--project` when none
is given (warned about at startup in local mode if it names nothing in the
graph, and a page whose candidates were ALL scope-filtered says so once, since
a starved scoped worker otherwise looks exactly like an empty queue). The
node-id spelling resolves one way only (`repo-x` admits `x`, never the
reverse — the reverse would fail OPEN on a repo genuinely named `repo-x`).
RESUMPTION is the other door into a gate, and it never goes through selection,
so an orphaned pipeline is adopted only by a worker armed with the SAME factory
that started it (`orphanedGateRuns`'s `factory`/`onForeign`) — the wrong-factory
case has the same consequences the bare-worker exclusion already exists to
prevent. A gate/merge fact — and every item a refusal files (the escalation,
the test-change lane, the approval, the proposal tracker) — is filed under the
ITEM's own repo (carried on the worker's slot, across the active->gating move
so a resumed pipeline files there too), not the worker's scope token, which
differ under a multi-repo factory. A failed/blocked pipeline does more than cool the node — a cooldown is
machine-local and the gate runs AFTER the resolver exists, so the refusal is
also written as GRAPH state (§10.7) in two parts: the `requires: [human]` item
it files carries `blocks` onto the work item (the fail-closed half — a live
queue item naming its dependent), and the item's own COMPLETION status is rolled
back to `open`, which is what stops the STATUS-derived surfaces (`spor get`'s ⚠,
analytics, `--status`) calling it done. It never re-enters the queue: liveness
comes from the resolving EDGE, which this client cannot retract and which is the
evidence the escalation asks a person to judge — and a refused item must not
come back round to a worker anyway. Only a completion is rolled back (never an
`abandoned` item), and a passing gate never re-flips it.
And because a gate pipeline is the one piece of work the worker PROCESS owns, a
killed worker's unfinished pipelines are RESUMED (§10.8): each stamps
`gate_state` on its run record (settled verdicts are final, and the two in-process
record writers carry the namespace across), and a later gate-armed worker joins
that to the stale worker status files and re-gates the orphans before taking new
work — DEFERRING any whose node still has a live run, since a resumed pipeline
re-runs from gate 0 and its fix cycle would put a second agent in one checkout.
WORKERS.md §10 is the contract; see test/gates.test.js +
test/gate-pipeline.test.js.
**The rescue lane (task-spor-factory-rescue-lane, WORKERS.md §10.10):** an
optional FACTORY-level `rescue:` block (`profile` required, `attempts` 1..3
default 1, `await_ms` default 1h, `instructions`; parsed by `parseRescue` in
`lib/kernel/gates.js`, absent = byte-identical) that runs when a gate would
otherwise ESCALATE — fix cycles spent, or an unretried refusal that is not
already a person's item (a lane item, a rejected/blocked approval are never
rescued; a `declined` run is never gated). The runner (`runGatePipeline`,
now a `judge(rescue, seed)` pass over the gate list) writes the refused gate's
fact FIRST, dispatches `rescue.profile` into the run's own checkout
(`makeGateDeps.rescue` in bin/spor.js: `--no-worktree --force`, NOT read-only,
and — unlike a review — carrying the worker's unattended POSTURE
(`--permission-mode`/`--sandbox`/`--approval-policy`, else a claude-code rescue
stalls on its first write prompt) filtered per flag through the LANE harness's
own `validateOptions` — and where a flag does not survive, TRANSLATED BY
MEANING (issue-spor-rescue-posture-foreign-restrictive-flag-becomes-bypass):
the owning adapters read the whole posture as read-only / attended /
unattended (`postureMeaning`, most restrictive first) and it is re-expressed
in the lane's own declarations — read-only as the lane's `--read-only`,
unattended as its declared `unattended` posture (the per-adapter twin of
`readOnly`: empty wherever the argv builder is already unattended, the bypass
on claude-code), attended as its declared `attended` posture (empty on
claude-code, `--approval-policy on-request` on Codex) after displacing every
surviving posture flag — and where the lane declares none (OpenCode/Copilot,
whose unattended argv cannot be unsaid) it NARROWS to the lane's
`--read-only`, never up to that harness's unattended default; only an EMPTY
worker posture takes the lane's unattended posture unread. The harness-flag membership lists
(review subset, rescue posture/routing halves, work-loop passthrough) all
derive from `HARNESS_OPTION_FLAGS` in dispatch-harnesses.js —
while its ROUTING (`--model`/`--agent`) is dropped so the lane's profile keeps
naming the strong model,
issue-spor-rescue-dispatch-drops-harness-flags) with the item, the diff,
EVERY commit on the branch, the cycle history, the finding ledger and the gate
facts, reads its `{"diagnosis","category","fixed","filed"}` block FAIL-SOFT
(`parseRescueReport` — it only feeds the escalation and the `art-rescue-*`
fact; the tree is judged regardless), then re-runs the WHOLE gate list as a
rescue pass: fresh fix-cycle budget per gate (`cycleDecision(gate, cycle -
base)`), but the ledger is CARRIED and the cycle index CONTINUES so the
post-rescue review is a fix-cycle review under the stateful protocol. Every
id a rescue pass mints is keyed one segment deeper (`shortRunAttempt`/
`gateRunKey`'s third arg → `-x<n>`/`#x<n>`; progress under `<gate>#x<n>`).
Only a refusal of the LAST rescue pass escalates, and the escalation body
OPENS with the diagnosis. The rescue state (refusal handed, per-gate seed,
run id, diagnosis) rides `gate_progress.rescue` on the run record
(`loadRescueState`/`saveRescueState`, `gate_rescue_run_id` stamped at launch),
so a killed worker resumes INSIDE the rescue and adopts its run by name
(`rescue-<short>-<n>`), never re-running the original pass. See
test/gate-pipeline.test.js "the rescue lane".
**The integration step (task-spor-factory-integration-step, WORKERS.md §10.9,
dec-spor-factory-integration-step):** a factory's optional `integration:` block
is the merge-queue landing stage `spor work` runs after every declared gate has
passed — deliberately NOT a fourth gate kind (a gate judges the branch;
integration mutates the target ref and serializes across workers), so it is
parsed beside `gates` in `lib/kernel/gates.js` (`parseIntegration`) and enforced
by `lib/shell/integration-runner.js` (`runIntegrationStage`), folded into the
SAME `deps.gate` promise the gate pipeline already returns (`bin/spor.js`
`runGateAndIntegration`) so the loop's slot-holding/cooldown/resume machinery
needs no changes and a factory declaring no integration block is
byte-identical to before this stage existed. It builds a throwaway candidate
worktree at `merge(target_ref, branch)` per the declared `strategy`
(merge/squash/rebase), forces every declared protected path back to the
trusted ref's copy in that candidate tree (the SAME guarantee and matcher a
command gate's tree gets, `gate-runner.js`'s shared `forceProtectedPaths`),
runs the full declared suite there, and lands via compare-and-swap — local
mode is `git update-ref target new old`, push mode is a `git push` whose own
non-fast-forward rejection IS the CAS. A merge conflict or a candidate-suite
failure is a FIX-CYCLE event, routed through the exact cycle-cap ->
human-escalation machinery a failing gate already uses; a LOST CAS race
rebuilds the candidate against the ref's new tip and retries automatically,
bounded separately (`RACE_RETRY_CAP`) and never charged against the fix-cycle
cap, since losing a race is nobody's mistake. The `serialize: repo` lease that
makes the race rare rather than load-bearing is best-effort and fail-open:
remote mode reuses the SAME server-held claim/lease door dispatch uses
(`claimDispatch`) against a synthetic per-repo lock node; local mode falls
back to a machine-local lockfile (dec-cc-task-claim-lease "Local mode" has no
server pool to lean on there). `mode: propose`
(task-spor-integration-propose-mode) is the fourth: it never mutates
`target_ref` — it opens a PR from the implementer's own branch through the
`gh` CLI (a declared capability; `spor work` refuses loudly at startup if it
is absent) and PARKS the item (demoted on the graph, a tracking item filed,
the work-loop slot freed immediately — never held polling for a review that
can take days, unlike a `human` gate's in-process approval wait). A LATER,
separate per-pass hook (`deps.checkProposals`, wired only under propose mode)
polls the PR via `gh` and, once it merges, writes a second `art-merge-…` fact
that RESOLVES the tracking item and restores the work item's own resolution
(`gatePromoteItem`, demote's mirror); a PR closed unmerged is recorded and
left for a person, same as a rejected `human`-gate approval. See WORKERS.md
§10.9 "Propose mode". Every landing OR proposal is an idempotent
`art-merge-…` graph fact, the integration stage's twin of a gate's
`art-gate-…` fact; a failure (or a closed-unmerged PR) demotes the item
exactly as a failed gate does (§10.7). See test/integration-step.test.js.
Server-side ops vars
(`SPOR_GARDENER_MS`, `SPOR_INGEST_CMD`, `SPOR_SANDBOX`, `SPOR_SOLO`,
`SPOR_ROOT_ID`), worker IPC (`SPOR_STEP`), and the recursion guard
(`SPOR_DISTILLING`) are deliberately NOT config — they stay pure env.
**Multi-tenant credentials (dec-spor-client-cli-mode-tenant-resolution, API.md
§6.2):** server tokens are org-scoped, so the client holds one credential per
`(issuer, org)` in `$SPOR_HOME/auth/credentials.json` (0600, machine-local —
`lib/auth.js`, already in the shared-graph `.gitignore` `/auth/`). The active
tenant resolves through a SELECTOR layered into `lib/config.js`
(`Config.tenant()/server()/token()`), high-first: `--org`/`--server` flag >
`SPOR_SERVER`(+`SPOR_TOKEN`)/`SPOR_ORG` env > repo `.spor` `org:` marker
(`repoMarkerOrg`, the remote-mode sibling of the `graph:` binding) > store
`default` > legacy flat `config.json` `server`+`token` (migrate-on-read) > local.
`lib/remote.js` + the hook engines read `server()`/`token()` instead of the raw
`get("server")`/`get("token")` and transparently refresh a tenant's
`refresh_token` on a 401; **byte-identical** when no store / org-selector is in
play (only a flat `server`+`token` or env). The `spor auth` verbs (login [device
grant, RFC 8628] / list / switch / whoami / logout; flat `login`/`whoami`/`join`
aliases, `join` APPENDS) populate and select within the store and never clobber
a sibling tenant. `--org` is a GLOBAL flag lifted out of argv in `bin/spor`
`main()` so any verb can pick a tenant. The org for a freshly-minted token is the
JWT `org` claim (opaque-token deployments need `--org`, or the future `/v1/me`
org echo).

## Design context

The Spor design system — PRODUCT.md (register, users, principles), DESIGN.md
(visual rules), and `design/tokens.css` (OKLCH tokens) — now lives in the
private spor-server repo, alongside the one live UI surface (the MCP
view-tree widget), and governs all Spor UI. Identity in one line:
evidentiary/calm/precise, cool neutrals, one rationed **glacial teal** accent
(hue 205) — indigo/violet accents are banned product-wide.

@AGENTS.md

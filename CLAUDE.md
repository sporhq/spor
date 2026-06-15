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
  backward-readable.
- **Zero dependencies.** Everything in this repo — `lib/`, the hook engines
  (`scripts/engines/` + `bin/spor-hook.js`), skills, adapters — is plain
  Node (no npm install, node builtins + the git binary only). Keep it that
  way — the plugin must run anywhere Claude Code runs, natively on Windows,
  macOS, and Linux. Dependencies live only in the private server repo.
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
  continuations), `pin:`/`exclude:` inline lists, and `- {type: X, to: Y}`
  edges. Don't write nodes with any other YAML constructs.

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

The post-tool engine also carries the capture nudge
(task-cc-posttool-capture-nudge):
a Write/Edit of ≥50 words of prose to a `.md` outside the graph runs a Haiku
classifier and, if it finds capturable facts, injects a capture-or-dismiss
`additionalContext`. Test with `SPOR_NUDGE_CMD` (prompt stdin → response
stdout, same contract as `SPOR_DISTILL_CMD`; stubs must `cat >/dev/null`
first or the prompt pipe SIGPIPEs); `SPOR_NUDGE=0` disables; cooldown
state is `journal/<session>.nudged`. `scripts/distill-gemini.sh` satisfies the
contract too (~2-7s vs ~17s for `claude -p` CLI boot). See test/nudge.test.js.

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
the real graph.)

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
against the live graph for compile/validate/digest/skeleton). Engines read it
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
flow). New levers beyond env migration: per-repo no-op disable (`enabled:false`/`mode:off` → dispatcher
bails, fail-open), neighborhood-search project controls
(`search.minSim`, `search.projects.{include,exclude,boost}`, applied in
`lib/kernel/graph.js` compile, no-op when empty), and the `spor dispatch`
slug→local-path map (`dispatch.repos`, a per-machine `{slug: path}` table the
shared graph can't hold; written to the USER `$SPOR_HOME/config.json` by
`spor repos`/`session-start`, read via the cascade — never a committable
`.spor.json`, since paths are machine-specific). Server-side ops vars
(`SPOR_GARDENER_MS`, `SPOR_INGEST_CMD`, `SPOR_SANDBOX`, `SPOR_SOLO`,
`SPOR_ROOT_ID`), worker IPC (`SPOR_STEP`), and the recursion guard
(`SPOR_DISTILLING`) are deliberately NOT config — they stay pure env.

## Design context

The Spor design system — PRODUCT.md (register, users, principles), DESIGN.md
(visual rules), and `design/tokens.css` (OKLCH tokens) — now lives in the
private spor-server repo, alongside the one live UI surface (the MCP
view-tree widget), and governs all Spor UI. Identity in one line:
evidentiary/calm/precise, cool neutrals, one rationed **glacial teal** accent
(hue 205) — indigo/violet accents are banned product-wide.

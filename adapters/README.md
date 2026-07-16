# Host adapters

> **Installing:** `spor install <host>` (e.g. `spor install codex`) automates
> the per-host recipe below — it resolves the `__SPOR_ROOT__` placeholder to
> your checkout and merges the manifest into the host's config (idempotently;
> `--scope user|repo`, `--all`, `--print`). Add `--mcp` (needs a configured
> server — `--server`/`--token` or `spor join`) to also auto-write the host's
> MCP server config (codex/gemini/opencode/copilot — see each README's "MCP:"
> section for the shape) and run `agents-md` to populate `AGENTS.md`, so one
> command finishes setup with no manual file edits. The manual steps in each
> adapter's README remain valid for hand-installs or when you want to see
> exactly what lands where. Claude Code installs via its own plugin CLI (`spor
> install claude`), not a file drop.

The Spor client is a portable core behind per-host adapters
(dec-cc-portable-core-adapters):

- **Core**: the four hook engines in `scripts/` (session-start briefing,
  prompt-context digest, post-tool journal, distill capture) and the
  `bin/spor-hook.js` dispatcher that normalizes host payload quirks and
  envelope event names. All engines are fail-open: any failure injects
  nothing and exits 0.
- **Universal surfaces**: the server's MCP endpoint (`/mcp`) and REST
  (`/v1/*`) work from any host; `spor-hook agents-md` maintains a managed
  Spor section in `AGENTS.md` (capture-discipline directive + standing
  briefing) as the floor for hook-less hosts. The committable directive-only
  form of the same block is `spor agents-md` (written by `spor enable` by
  default, refreshed by `spor upgrade`) — see `spor help agents-md`.
- **Adapters**: a manifest per host mapping its event names onto the
  dispatcher.

| Host | Adapter | Fidelity |
|---|---|---|
| Claude Code | the plugin itself (`hooks/hooks.json`) | full |
| Codex CLI | `adapters/codex/` | full (debounced distill on turn-scoped `Stop`; generic transcript fallback) |
| Gemini CLI | `adapters/gemini/` | full (generic transcript fallback for distill) |
| OpenCode | `adapters/opencode/` — JS plugin over the same dispatcher | full (parts injection via `chat.message`; debounced distill on `session.idle` with SDK transcript export) |
| Cursor | `adapters/cursor/` | partial — briefing at `sessionStart`, journal + distill; no per-prompt digest (`beforeSubmitPrompt` is block-only) |
| Copilot CLI | `adapters/copilot/` | partial — capture full (journal + debounced distill on `agentStop`); no ambient injection (`sessionStart` has no output, prompt-submit observe-only), briefing via the AGENTS.md floor |
| Cowork / claude.ai | MCP only | on-demand (no ambient injection) |
| Goose, Amp, Crush, others | MCP + `AGENTS.md` section (`spor-hook agents-md`) | floor |

An ACP (Agent Client Protocol) stdio proxy is the eventual single adapter for
editor-hosted agents; it is deliberately sequenced after these (see the
decision node for the rationale and revisit triggers).

## Distiller backend

The end-of-session distiller defaults to `claude -p --model haiku`. Hosts
without the claude CLI set `SPOR_DISTILL_CMD` (contract: prompt on
stdin, response on stdout), e.g. `codex exec -` or `gemini`. (Legacy
`SUBSTRATE_*` names are still read for all user-facing variables.) The
`SPOR_DISTILLING=1` recursion guard is exported around the call either
way, so a distiller whose own exit fires a session-end hook cannot recurse.

`scripts/distill-gemini.sh` is a ready-made backend implementing the
contract against the Gemini API directly (no CLI; `GEMINI_API_KEY`
required, model via `SPOR_DISTILL_MODEL`, default `gemini-3.5-flash`):

```sh
export SPOR_DISTILL_CMD="$HOME/repos/spor/scripts/distill-gemini.sh"
```

The journal records the backend per call (`journal/llm-calls/`), so distill
quality stays observable across backends through the same eval loop.

## Capture-nudge backend

The post-tool capture nudge (a Write/Edit of substantial prose to a `.md`
outside the graph runs a classifier and, if it finds capturable facts, injects
a capture-or-dismiss nudge) uses the **same backend contract** as the
distiller — prompt on stdin, response on stdout — but a separate variable so
you can point the two at different models:

- `SPOR_NUDGE_CMD` — custom classifier command (defaults to `claude -p --model
  haiku`, same as the distiller). Because the contract is identical,
  `scripts/distill-gemini.sh` doubles as a nudge backend (it keys off
  `SPOR_DISTILL_MODEL`, default `gemini-3.5-flash`):

  ```sh
  export SPOR_NUDGE_CMD="$HOME/repos/spor/scripts/distill-gemini.sh"
  ```

  This is the recommended latency fix: the nudge runs **synchronously** in the
  tool loop, and Gemini Flash returns in ~2–7s versus ~17s for a `claude -p`
  cold boot, with no quality regression (dec-cc-nudge-flash-latency).
- `SPOR_NUDGE=0` — disable the nudge entirely.
- `SPOR_NUDGE_MAX` — per-session ceiling on classifier calls (default 20),
  bounding spend/latency in a docs-heavy session where many `.md` files each
  classify to nothing. (A separate cap stops after 3 *fired* nudges.)
- `SPOR_NUDGE_TIMEOUT` — milliseconds before a hung classifier is killed
  (default 30000), so a wedged backend can't block the tool loop.

(Legacy `SUBSTRATE_*` spellings are still read for all four.) The same
`SPOR_DISTILLING=1` recursion guard is exported around the call, and the
journal records each nudge call under `journal/llm-calls/` (source `nudge`)
through the same eval loop as the distiller.

---
name: brief
description: Compile a Spor briefing for a task. Use when starting a non-trivial piece of work in a project with a Spor graph, or when the user runs /spor:brief with a query or node id.
---

# Compile a briefing

You are the distiller stage of the Spor context compiler. The traversal
stage is mechanical; your job is to turn its neighborhood document into a
briefing an agent (or human) can act on without reading anything else.

**Resolve mode silently.** The Spor status line injected at session start tells
you which mode you're in (`team graph: …` = remote, `A Spor knowledge graph is
active: …` = local); use it, or test `[ -n "$SPOR_SERVER" ]` once if it isn't in
context. Don't echo `SPOR_SERVER`/`SPOR_TOKEN`/`SPOR_HOME` or announce the mode
to the user unless they ask, and run the local-mode resolution below without
echoing `$SPOR_ROOT`.

Steps:

1. Run the traversal. `$ARGUMENTS` is either a node id (e.g. `issue-86`) or a
   free-text query; quote it.

   **Remote mode (team graph) — when `SPOR_SERVER` is set:** the compile
   runs on the server. Use its REST twins (API.md §3) instead of the local
   compile.js. (Env vars here are the `SPOR_*` family; the legacy
   `SUBSTRATE_*` names are still read.) First resolve THIS repo's project slug
   the same way a session does and send it as `"project"` so the server scopes
   the compile to your repo — the same-project relevance boost, the grouping
   union, and the `always_on` norm `applies_to_*` ride-along — instead of
   running *project-blind* (issue-spor-remote-digest-project-blind). Resolve the
   plugin root from the session-start cache, then the slug:
   ```bash
   SPOR_ROOT="$(cat "${SPOR_HOME:-$HOME/.spor}/cache/plugin-root" 2>/dev/null \
     || cat "$HOME/.substrate/cache/plugin-root" 2>/dev/null)"
   SPOR_ROOT="${SPOR_ROOT:-$CLAUDE_PLUGIN_ROOT}"
   SLUG="$(node -e 'process.stdout.write(require("'"$SPOR_ROOT"'/scripts/engines/util.js").projectSlug(process.cwd()))' 2>/dev/null)"
   ```
   - free-text query: `POST ${SPOR_SERVER%/}/v1/digest` with
     `{"query":"<text>","project":"<slug>"}` (`Authorization: Bearer
     $SPOR_TOKEN`); the `text` field is the compiled neighborhood. A
     `{"found":false}` means the team graph has nothing relevant — say so and
     stop. (Omit `project` only if the slug couldn't be resolved.)
   - node id: `GET ${SPOR_SERVER%/}/v1/nodes/<id>` for the raw node, and
     `POST /v1/digest` with the node's title/summary as the query (plus the same
     `"project":"<slug>"`) for its neighborhood. In Cowork, call the
     `query_graph` MCP tool (with `root_id` for a node id, or `query` for free
     text) — there is no compile.js there.

   **Local mode (personal graph) — `SPOR_SERVER` unset:** first resolve the
   plugin root — `${CLAUDE_PLUGIN_ROOT}` is empty in the Bash tool, so read
   the path the session-start hook cached
   (issue-cc-skill-plugin-root-unsubstituted) — then resolve THIS repo's
   project slug the same way a session does, so the compile is scoped to the
   repo you're in instead of project-blind:
   ```bash
   SPOR_ROOT="$(cat "${SPOR_HOME:-$HOME/.spor}/cache/plugin-root" 2>/dev/null \
     || cat "$HOME/.substrate/cache/plugin-root" 2>/dev/null)"
   SPOR_ROOT="${SPOR_ROOT:-$CLAUDE_PLUGIN_ROOT}"
   SLUG="$(node -e 'process.stdout.write(require("'"$SPOR_ROOT"'/scripts/engines/util.js").projectSlug(process.cwd()))' 2>/dev/null)"
   ```
   - node id: `node "$SPOR_ROOT/lib/compile.js" --root <id> --skeleton ${SLUG:+--project "$SLUG"}`
   - query: `node "$SPOR_ROOT/lib/compile.js" --query "<text>" ${SLUG:+--project "$SLUG"}`

   **Always pass `--project "$SLUG"`.** Without it, `compile --root`/`--query`
   run *project-blind* (`sessionProject == null`): the org-norm ride-along then
   keeps every `always_on` norm and ignores `applies_to_repos`/`applies_to_tags`/
   `applies_to_projects` scoping entirely — so an unscoped briefing shows norms a
   real session in this repo would filter out (the `applies_to_*` selectors match
   the SESSION repo, not the `--root` node's repo). `--project` makes the compile
   match what session-start actually injects here.

   (The compiler defaults to the global graph at `$SPOR_HOME/nodes`, falling
   back to `~/.spor/nodes` — or a pre-existing `~/.substrate/nodes` when
   `~/.spor` is absent.)
   Empty output means the graph has nothing relevant — say so and stop.

2. Distill the neighborhood document into a briefing:
   - Honor every CORRECTIONS instruction verbatim — they are standing human
     guidance and outrank your judgment.
   - Lead with what the task is and the constraints that bind it
     (constrained-by/governed-by lineage, norms).
   - Flag anything marked SUPERSEDED so the reader recognizes stale references.
   - Include the OUTSIDE VIEW nodes as "prior art / check before building".
   - Target 400-800 tokens. Cite node ids inline so claims are traceable.

3. If you ran with `--skeleton`, a `skeleton-brief-<id>.md` file was written
   next to the nodes dir with provenance edges and a bumped version. Move your
   briefing body into it (replacing `<!-- BODY -->`), add a `project:` field,
   and save it as `~/.spor/nodes/brief-<id>.md` (or under `~/.substrate` if
   that is where the graph lives). For free-text queries,
   just present the briefing — only persist it as a node if the user asks.

4. Present the briefing. If the user later says it was wrong or incomplete,
   point them at /spor:correct — corrections fix the compile permanently;
   editing the briefing by hand fixes it once.

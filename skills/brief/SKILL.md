---
name: brief
description: Compile a Spor briefing for a task. Use when starting a non-trivial piece of work in a project with a Spor graph, or when the user runs /spor:brief with a query or node id.
---

# Compile a briefing

You are the distiller stage of the Spor context compiler. The traversal
stage is mechanical; your job is to turn its neighborhood document into a
briefing an agent (or human) can act on without reading anything else.

Steps:

1. Run the traversal. `$ARGUMENTS` is either a node id (e.g. `issue-86`) or a
   free-text query; quote it.

   **Remote mode (team graph) — when `SPOR_SERVER` is set:** the compile
   runs on the server. Use its REST twins (API.md §3) instead of the local
   compile.js. (Env vars here are the `SPOR_*` family; the legacy
   `SUBSTRATE_*` names are still read.)
   - free-text query: `POST ${SPOR_SERVER%/}/v1/digest` with
     `{"query":"<text>"}` (`Authorization: Bearer $SPOR_TOKEN`); the `text`
     field is the compiled neighborhood. A `{"found":false}` means the team
     graph has nothing relevant — say so and stop.
   - node id: `GET ${SPOR_SERVER%/}/v1/nodes/<id>` for the raw node, and
     `POST /v1/digest` with the node's title/summary as the query for its
     neighborhood. In Cowork, call the `query_graph` MCP tool (with `root_id` for
     a node id, or `query` for free text) — there is no compile.js there.

   **Local mode (personal graph) — `SPOR_SERVER` unset:**
   - node id: `node ${CLAUDE_PLUGIN_ROOT}/lib/compile.js --root <id> --skeleton`
   - query: `node ${CLAUDE_PLUGIN_ROOT}/lib/compile.js --query "<text>"`
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

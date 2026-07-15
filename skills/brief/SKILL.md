---
name: brief
description: Compile a Spor briefing for a task. Use when starting a non-trivial piece of work in a project with a Spor graph, or when the user runs /spor:brief with a query or node id.
---

# Compile a briefing

You are the distiller stage of the Spor context compiler. The traversal
stage is mechanical; your job is to turn its neighborhood document into a
briefing an agent (or human) can act on without reading anything else.

One command runs the traversal — `spor` resolves local vs team graph on its own;
you never test `SPOR_SERVER` or branch on mode. Don't echo
`SPOR_SERVER`/`SPOR_TOKEN`/`SPOR_HOME` or announce the mode unless the user asks
(`spor status` reports the resolved mode if you need it).

Steps:

1. **Run the traversal.** `$ARGUMENTS` is either a node id (e.g. `issue-86`) or a
   free-text query; quote it. First resolve THIS repo's project slug and pass it
   as `--project` so the compile is scoped to the repo you're in — the
   same-project relevance boost, the grouping union, and the `always_on` norm
   `applies_to_*` ride-along — instead of running *project-blind*
   (issue-spor-remote-digest-project-blind). `spor status` already resolves the
   slug the same way session-start does (local vs remote, `.spor` marker
   overrides, worktree main-repo inference); read it back instead of
   recomputing it:
   ```bash
   SLUG="$(spor status 2>/dev/null | sed -n 's/^project:[[:space:]]*//p')"
   ```
   Then run the one command (the CLI compiles locally or dispatches to the server
   per the resolved mode, just like the `spor brief`/`spor compile` verbs):
   - node id: `spor brief <id> ${SLUG:+--project "$SLUG"}`
   - free-text query: `spor compile --query "<text>" ${SLUG:+--project "$SLUG"}`

   Empty output means the graph has nothing relevant — say so and stop.

   **Why `--project`.** Without it, the compile runs *project-blind*
   (`sessionProject == null`): the org-norm ride-along then keeps every
   `always_on` norm and ignores `applies_to_repos`/`applies_to_tags`/
   `applies_to_projects` scoping entirely — so an unscoped briefing shows norms a
   real session in this repo would filter out (the `applies_to_*` selectors match
   the SESSION repo, not the `--root` node's repo). `--project` makes the compile
   match what session-start actually injects here. (The local compiler defaults to
   the global graph at `$SPOR_HOME/nodes`, falling back to `~/.spor/nodes`, or a
   pre-existing `~/.substrate/nodes`.)

   **In Cowork (no shell)**, call the `query_graph` MCP tool instead — `root_id`
   for a node id, or `query` for free text. A `{"found":false}` means the graph
   has nothing relevant; say so and stop.

2. Distill the neighborhood document into a briefing:
   - Honor every CORRECTIONS instruction verbatim — they are standing human
     guidance and outrank your judgment.
   - Lead with what the task is and the constraints that bind it
     (constrained-by/governed-by lineage, norms).
   - Flag anything marked SUPERSEDED so the reader recognizes stale references.
   - Include the OUTSIDE VIEW nodes as "prior art / check before building".
   - Target 400-800 tokens. Cite node ids inline so claims are traceable.

3. Persist the briefing only if it is worth keeping (a node-id brief you will
   return to). In the **local** graph, `spor compile --root <id> --skeleton
   ${SLUG:+--project "$SLUG"}` writes a versioned `skeleton-brief-<id>.md` next
   to the nodes dir with provenance edges; move your briefing body into it
   (replacing `<!-- BODY -->`), add a `project:` field, and save it as
   `~/.spor/nodes/brief-<id>.md` (or under `~/.substrate` if that is where the
   graph lives). In **remote/Cowork** mode the server already holds compiled
   briefings, so just present it; persist a node only if the user asks. For
   free-text queries, just present the briefing.

   Once the new version is persisted, retire the corrections it just absorbed
   (issue-spor-corrections-no-applied-lifecycle): a correction whose `target`
   is exactly `<id>` (a node-targeted fix, not `global`/`project:<slug>`) fired
   because *this specific recompile* was its job — its guidance is now baked
   into the briefing body you just wrote, so it has nothing left to do. For
   each `shaped-by` edge in the skeleton whose correction's `target` equals
   `<id>`, run `spor set-status <corr-id> applied` so it stops injecting on
   every future compile of this same target (a stale-forever `corr-` node is
   exactly the dead weight this step exists to prevent). Leave
   `global`/`project:<slug>`-scoped corrections alone — those are standing,
   broad-scope guidance meant to keep firing on every future compile, not a
   one-shot fix this recompile discharges.

4. Present the briefing. If the user later says it was wrong or incomplete,
   point them at /spor:correct — corrections fix the compile permanently;
   editing the briefing by hand fixes it once.

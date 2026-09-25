# Preserve unfinished cross-repo acceptance

The supervisor performs all graph writes, both before dispatch and when a
Codex report contains `## HANDED BACK`. Never create a second untracked branch
in another repo. Independently testable halves become sibling tasks; lockstep
changes instead run solo with all affected checkouts explicitly scoped.

Use the original skill's stable identity contract so retries and both variants
converge on the same graph state:

1. For each additional repo, use its canonical `repo:` slug, not a path or a
   `repo-...` node ID. Compute SHA-256 over the original task's full ID plus a
   newline, then the full canonical slug plus a newline. Take the first 12 hex
   characters. The sibling ID is `task-split-<slug-prefix>-<hash>`, where only
   the readable slug prefix is truncated to 60 characters; hash the full slug.
   Example: `issue-foo-bar` and `spor-server` produce
   `task-split-spor-server-a543f6c75e9a`.
2. Write the sibling with `spor put-node --if-exists skip` or MCP `put_node`.
   Give it `type: task`, `repo:` and `project:` equal to that slug, standalone
   acceptance, and a `relates-to` edge to the original task. Read it back.
   Identity passes only when its repo matches AND it has a `relates-to` or
   `derived-from` edge to the original. A skipped write with matching identity
   succeeds. A mismatching node is an anomaly: stop and escalate, never overwrite
   it or mint a second ID.
3. Read the original and its revision. Append this marker, preserving all
   existing content/edges and adding the reverse `relates-to` edge:

   ```text
   ## Scope (narrowed)
   covers: <original agent's repo slug>
   sibling: <verified sibling ID> — <other repo slug>: <acceptance summary>
   ```

   Include a sibling line for every handed-back repo. A prose mention or an
   edge alone is not narrowing. Skip only when the exact repo/sibling marker
   exists and every sibling passes the identity test. Use an optimistic full
   node update: with MCP supply `revision`; with CLI include the fetched
   `revision` in the node frontmatter passed to `spor put-node --if-exists update`.
   On conflict, re-read and reconcile instead of resending stale content.
4. Wire `blocks` only for real prerequisites, not mere cohort membership. Make
   each eligible sibling agent-ready, with sufficient acceptance for a cold
   implementer. At selection time stop here and dispatch the narrowed task;
   no implementation has finished yet.
5. On a finished worker report, the supervisor may proceed to gate/merge only
   after sibling and narrowing are durable. Resolve only after that work passes
   the completion workflow, and mention the sibling in its resolution evidence.

Order is sibling → narrowing marker → completion. Re-run the contract even if
another actor resolved the original meanwhile: unfinished acceptance still
needs its sibling and marker; never create a duplicate resolver. A terminal
sibling can still be referenced. After a failed graph write, preserve the report
and pending attempt; retry up to three loop turns, then escalate with the exact
state. Do not re-dispatch finished implementation to fix graph availability.

<!-- spor:begin -->
## Spor team graph

A team knowledge graph (Spor) holds prior decisions, constraints, dismissed approaches, and deferred work. Before designing or deciding anything non-trivial, check it (query_graph). Ask show_queue what to work on next. When a git commit implements a tracked node (a task, decision, or issue), add a 'Spor: <node-id>' trailer to the commit message, in the final trailer block alongside any Co-Authored-By (no blank line between trailers) — git then records which node the commit serves, and the graph records the commit's sha.

Keep the graph current as you work — do these unprompted:

- The moment work is discovered that you won't do right now (an out-of-scope
  bug, a follow-up, a dismissed approach), capture it before moving on:
  /spor:defer (or `spor add "..."`) — 2-3 sentences in your own words; the
  server types and links it.
- Found a defect you ARE about to fix? File it first, fix second — the issue
  node is the lineage the fix resolves.
- Made a decision worth keeping (approach chosen, alternative ruled out,
  gotcha paid for)? Capture it at the moment it is made, not at session end.
- Durable, team-relevant facts belong in the graph, never only in private
  auto-memory or scratch notes. If you are about to "remember" something a
  teammate or future session could need, capture it to Spor as well.
- When tracked work finishes, close the loop: record the resolution (a
  decision or artifact node with a `resolves` edge), not a bare status flip.
- After a substantial multi-node session (several nodes produced, or a real
  investigation/build/scoping run), file ONE outcome artifact that links what
  you produced — a provenance hub, `resolves` what it closed and
  `relates-to`/`mentions` the rest — so the "what did this accomplish, why do
  these nodes belong together" record exists without a human asking. Ad-hoc work
  that never flips a task to done has no other capture trigger; don't leave the
  connective record unwritten.
<!-- spor:end -->

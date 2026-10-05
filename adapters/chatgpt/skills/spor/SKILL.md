---
name: spor
description: Use Spor to recall team decisions and constraints, brief a task, inspect the backlog, capture discoveries, route unanswered questions, or correct stale graph context.
---

# Work with the Spor team graph

Use the connected Spor MCP tools. This plugin operates on the hosted team graph;
it does not require a shell, local repository, CLI, or lifecycle hooks. If the
connection needs authentication, ask the user to connect Spor through the host's
sign-in flow. Never ask for tokens in chat. Do not claim graph access or a write
succeeded unless the tool confirms it.

## Orient and traverse

Before non-trivial project decisions, call `query_graph` with the task or question.
Pass the known project when the tool supports it; do not invent a project.
Deepen relevant results with `query_graph` using `root_id`, and read exact nodes
with `get_node`. Honor supersession and applicable corrections. Explain an empty
result as missing graph evidence, not proof that no prior decision exists.

For a briefing, summarize the relevant constraints, decisions, dismissed
alternatives, and outstanding dependencies. Cite node IDs so the lineage can be
retrieved. Distinguish recorded facts from your recommendations.

## Queue and views

Use `show_queue` for the backlog or what to work on next. Omit `assignee` for an
ordinary queue request; use it only for an explicitly person-scoped request.
Follow pagination when completeness matters. Prioritize prerequisites and inspect
a candidate's neighborhood before recommending or changing it.

Use `render_queue` for an interactive queue, `render_lens` for saved views, and
`render_program` for a workstream's dependency/progress tree, when these tools are
available. A view is not evidence that work was completed.

## Capture and close loops

Capture durable discoveries, decisions, and deferred work with `capture`, using
2–3 standalone sentences and the known project. Check for existing related work
before creating duplicates. File a defect before fixing it. Use `ask_question`
for unanswered questions requiring team knowledge, and `propose_correction` for
standing corrections to briefings.

For precise graph edits use `put_node`, `add_edge`, and `set_status` according to
their live schemas. Read a node's revision before replacing it. If multiple work
items have a known order, add `blocks` edges from prerequisite to dependent;
prose alone does not affect queue dependency ranking. Only work nodes block work.

Completion needs evidence and a decision or artifact with a `resolves` edge to
the task/issue before a terminal status. Answers use `answers` edges. After a
substantial session, write one outcome artifact linking the produced nodes and
stating what was verified and what remains open. Never mark implementation or
release delivery complete solely because a plan or package was created.

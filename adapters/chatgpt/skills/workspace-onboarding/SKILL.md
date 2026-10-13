---
name: workspace-onboarding
description: Guide users through their first useful Spor ChatGPT workspace workflow when they run plugin setup or ask for a tour. Teach queue, graph, evidence chat, and program views; optionally help them set up a factory, launch a worker with guided CLI commands, verify it through MCP, and send it a task or program. General local plugin installation uses the separate onboard skill.
---

# Get started with Spor Workspace

Teach through one useful task in the connected workspace. If setup was invoked
during an existing conversation, continue the user's task and explain the
relevant controls as you use them. Otherwise offer a short choice: understand
current work, plan a feature, or review implementation. Give one next action at
a time; the routes below are options, not a checklist to complete in one sitting.
Let the user skip, restart, or move straight into their work.

## Open and orient

Use the connected Spor MCP tools and their live schemas. The workspace tour
needs no shell, repository, CLI, or hooks. The optional worker setup below guides
commands in the user's terminal; it does not give ChatGPT a local shell.
If Spor is disconnected or needs
authentication, direct the user to the host's connect/sign-in flow and resume
after it succeeds. Never ask for credentials in chat.

Open the workspace with `render_cockpit` when available. Reuse the `workspace_id`
from app context and read its current state/revision before changing selection
or view state. Preserve the current project and focus unless the chosen task
needs a change. If scope is unknown, use returned projects to help the user
choose; never invent a project or node ID. Explain how to reopen Spor from the
sidebar only when that entrypoint is available in this host. If interactive
views are unavailable, teach the same workflow with the available data tools
and make that limitation clear.

Read the returned state and evidence before describing where the user is.
Do not infer clicks, completed steps, or visible controls from your previous
instructions. Adapt to the deployed app's capabilities and labels, including
whether graph, document, image-selection, and factory features are enabled.

## Find and understand work

For a first tour, open the queue with `render_queue`, or use `show_queue` for
its data. Omit `assignee` for an ordinary queue request; an explicitly assigned
work filter is narrower. Help the user pick one relevant item and explain its
priority, dependencies, and why it surfaced using returned evidence.

Use `query_graph` with that item's `root_id` and read exact nodes as needed.
Follow a useful relationship to the request, decision, or artifact that explains
the work. Teach the relationship through its meaning: what prompted this task,
what it blocks, or what evidence supports it. Use the graph view when available;
respect loaded-neighborhood limits rather than presenting it as the entire graph.
For questions about new or completed work, use available activity data and trace
its origin. Completion claims need recorded status and supporting evidence.

An empty queue does not prove an empty graph. Check the current scope and filters.
If there is no suitable example, offer to draft the user's first real feature
in chat. Do not populate the shared graph with tutorial tasks automatically.

## Discuss selected evidence

Open a relevant artifact and invite the user to select a passage or screenshot
and use the app's chat action, when supported. Explain that navigation context
identifies the current location; explicitly shared evidence supplies the text
or image for discussion. Use the actual attachment and its source/revision or
image anchor. If pixels are unavailable, say so and work from the supplied text
or ask the user to attach the image; do not claim to see it.

Point out the available context removal control. Respect removed selections and
do not silently reattach them. Removing shared app context does not erase prior
conversation messages. When selection context is absent or stale, re-read the
source or ask which passage/image the user means before proposing a change.

## Plan, execute, and review when relevant

For a feature, clarify the desired behavior and research the graph before
drafting a design. Use available rich-document tools for a requested saved
artifact, retaining a readable text source. Teach design review, then the
available reviewed program-creation workflow when the user wants tasks created.

For ongoing work, use `render_program` to explain program progress. Inspect the
available factory/run views for task stages, new issues, and completion evidence.
Distinguish program completion from one run's progress. A factory is the execution
process and its gates; starting it is a separate action from viewing the plan.

For screenshot feedback, use the actual selected artifact/image and originating
task, program, and run. If the user requests a follow-up task, use the supported
creation flow with those links; resolve ambiguous origins with them. Report
whether the task was created, held, or admitted to a run from the tool result.
Creation alone does not mean a worker has started.

Follow the user's existing authorization for real work. Setup alone authorizes
a walkthrough, not task edits, program creation, or starting a factory. Explain
the intended change before a new action when its scope is not already clear.
Use available review/apply flows; an inert proposal is not an applied change.

## Optional: connect a factory and worker

When the user wants to execute work, offer to help set up a factory, start a
worker on their computer or server, and send it a selected task or program.
Proceed if they agree or have already requested this workflow; otherwise
continue the workspace tour. Explain that the worker uses their checkout and
agent harness and can make code changes and incur model usage.

Read [Factory and worker setup](references/factory-worker.md) for this route.
Before proposing the factory, retrieve the team's release context from Spor
and inspect accessible repositories and CI pipelines; ask only about missing
or conflicting evidence. Fit the factory to that established release process.
Guide terminal setup and launch one step at a time. In ChatGPT on the web,
check worker availability and execution status yourself with the connected MCP
tools (`preflight_program_run`, `get_program_run`, `get_program_run_events`,
and `get_execution` when available). Do not make the user repeatedly run CLI
status commands or paste logs when MCP can answer. Published availability is
advisory; a live run owner and child execution establish actual pickup.

## Finish or resume

Briefly name what the user accomplished and their next useful action. They can
ask for the workspace tour again or ask about a specific view. Resume from the
conversation and current workspace state; do not claim durable tour progress
unless the app actually stores it. If they skip setup, continue their original
request immediately.

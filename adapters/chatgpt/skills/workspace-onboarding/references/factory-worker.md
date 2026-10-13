# Connect a factory and worker

Use this route only after the user opts into execution setup. Honor permission
already given and skip completed setup. Keep the current project and task.
ChatGPT operates the connected graph through MCP; the user runs local commands.
Never describe commands you supplied as commands you executed.

## 1. Choose the work and execution machine

Establish which task or program they want to run, where its repo is checked out,
and which installed, authenticated agent harness the worker should use. Reuse
known answers. Read the task, its constraints, acceptance criteria, dependencies,
and existing program membership through MCP. A program is a task umbrella whose
members carry `member-of-program` edges; do not invent a `program` node type.

Check the installed client's supported worker modes before choosing a command.
The client used to author this guide (0.31.3) supports `--serve program` and
refuses `--serve node` and `--serve queue`. Server support alone does not mean the
installed worker can consume those requests.

- For a program, use its reviewed eligible members as the initial cohort.
- For one task already in a suitable program, select only that task for admission.
- For a standalone task on a program-only worker, offer a small single-task
  program, explain the grouping, and create it and its membership edge only if
  agreed. Preserve existing membership; do not include unrelated work. A
  `blocks` edge means an actual completion dependency and is separate from
  membership. If they decline the grouping, explain the installed client's
  limitation rather than pretending a direct task request will be consumed.

`spor dispatch <task-id>` launches a separate attempt; it does not submit a task
to the already-running factory worker. `spor work --program <id>` starts a local
program-scoped loop, whereas `--serve program` listens for workspace Start
requests. Do not combine those flags or substitute either workflow silently.

## 2. Reuse or define the factory

Discover how this user and organization actually release before proposing or
changing a factory. Use available evidence before interviewing the user:

1. **Existing Spor context.** Use `query_graph` scoped to the known project for
   release/deployment practices, CI, approvals, integration policy, and the
   user's role. Traverse relevant decisions, norms, recent release artifacts,
   and their linked sources; read exact nodes and honor corrections and
   supersession. Use `list_factories` and `get_factory` to inspect existing
   definitions, gates, profiles, and validation. An empty search is missing
   evidence, not proof that the team has no release process.
2. **Accessible repositories and CI.** When connected repo tools or supplied
   files are available, inspect the actual relevant repos even if graph context
   exists. Read contributor/release instructions, CI workflow definitions,
   referenced scripts or reusable workflows, and package/build configuration.
   Check the default/release branches, PR and tag triggers, versioning and
   artifact publication, deployment environments, required checks and approvals,
   and rollback procedure where visible. Recent pipeline runs and releases help
   establish which paths are in use; a workflow file alone does not prove a
   successful release. Do not assume every repo in a project releases alike.
3. **Fill only the gaps.** For a new Spor user or sparse graph, use accessible
   repo/CI evidence as the starting point. If access is missing, ask for the
   relevant files or specific non-secret output. State what remains unknown,
   including settings or external pipelines the available tools cannot inspect.
   If graph policy and current repo behavior disagree, show the conflict and
   ask which should govern; do not silently replace either with a generic flow.

Summarize the observed path from change to release with source node IDs and
repo paths/links (and revisions when available). Separate required policy,
observed behavior, and your proposed changes. Then ask only the remaining
product questions: what must never break, what needs human judgment, and where
the factory's responsibility should end. Prefer a suitable existing factory.
Do not guess test commands, harness/model availability, or repo paths.

Map this evidence into the proposal: reuse existing checks and trusted refs,
preserve the team's PR/merge and release approvals, and state whether completion
means tested, merged, packaged, deployed, or verified in an environment. A tag-
triggered deployment is not automatically a gate to run per task. Explain what
the worker enforces and what remains in the existing release system; use only
completion boundaries the installed runner supports. Inspecting a release
pipeline does not authorize triggering it. Include provenance links from new
factory definitions to relevant graph decisions/norms and repository evidence.

Propose a short ordered pipeline with its cost and completion boundary. When
the user agrees to that concrete definition, author it through `put_node` and
`add_edge` using the live `schema` contract:

- Reuse or create the required profiles and gate nodes before the factory.
  Profiles name harnesses and models; they never contain executable commands,
  environment secrets, or launch arguments. Machine bindings stay local.
- Put factory configuration in its fenced JSON body. Declare `factory`,
  `trusted_ref`, exact `repos`, and ordered `gates`. Command gates use verified
  suite commands; review gates name available profiles. Human gates remain
  actual human decisions. Do not point a gate at a suite that does not exist.
- Program-run workers require `completion.by: controller`. Explain `after:
  gates` versus `after: integration`; the latter needs a valid `integration`
  block. Finishing gates alone does not promise merged code. Declare the intended
  implementation profile so Start preflight can check capability matches.
- If using protected test paths, declare their separate test-writing profile.
  Scope risk-based gates to declared risk classes. Reuse the graph's established
  integration policy; do not introduce automatic pushing as a tutorial default.

Read back the definitions with `get_factory`. Resolve missing/inactive schemas,
missing dependencies, invalid payloads, and completion incompatibility before
starting. If schema activation requires another identity, identify that actual
prerequisite. Do not weaken gates to make onboarding pass.

## 3. Guide local setup

Ask which operating system and shell the user will use if unknown. Give small
copyable command blocks with actual, safely quoted IDs/paths substituted for
the placeholders below. Explain the expected result and handle errors before
the next step. Do not request a terminal transcript containing credentials.

From the intended checkout, first establish the installed version and connection:

```sh
node --version
spor --version
spor status
spor whoami
spor help work
```

If Spor is missing, guide installation of a compatible `@sporhq/spor` release
with npm and its required Node version. If disconnected, use
`spor auth login --server <verified-team-server>` and, if needed,
`spor auth switch <org>`. Verify the CLI and ChatGPT are using the same tenant;
do not copy this tutorial's development tenant or machine paths.

Check existing agents with `spor agent list`. Reuse the intended owned agent or,
with the user's agreement, create and activate one:

```sh
spor agent create <machine-label>
spor agent use <returned-agent-id>
spor repos add <repo-slug> <absolute-checkout-path>
spor capabilities probe
spor capabilities
```

Creation and activation are separate. Map every repo the chosen work requires.
Verify the chosen harness is installed and signed in locally. Fix actual missing
tools or repo setup; never advertise invented capabilities to pass preflight.

The program-run claim authenticates as the worker credential. `--as` or
`spor agent use` chooses dispatch identity but does not change the credential
the parent polling loop uses. On clients requiring a standing agent token,
guide its owner to mint one locally, for example:

```sh
spor agent token <agent-id> --label workspace-worker --expires 7d
```

This command displays a secret once: tell them to keep its output out of chat.
Use their local secret manager or a hidden-input prompt in the worker terminal
to set `SPOR_TOKEN`, keeping the verified server/tenant binding. For Bash, after
locally copying the token, a hidden-input prompt is:

```bash
read -r -s -p 'Worker token (local only): ' SPOR_TOKEN
printf '\n'
export SPOR_TOKEN
spor whoami
```

Adapt that prompt for other shells. Keep the person's authenticated CLI session
separate; do not overwrite it with worker credentials. Check the returned
identity belongs to the intended agent and tenant. Never mint or return an agent
secret through ChatGPT MCP output. For persistent service setup use the machine's
supported secret storage, and explain expiry/rotation without exposing the token.

## 4. Preview and start the worker

Construct the launch command from the chosen factory, machine, and harness.
Start with one concurrent task and isolated worktrees:

```sh
spor work --serve program --factory <factory-id> --as <agent-id> --concurrency 1 --worktree --print
```

Resolve the preview's tenant, repo, factory, isolation, and permission findings.
Unattended write posture is harness-specific. For Codex, verify the effective
`--sandbox workspace-write --approval-policy never` posture. Claude Code requires
an explicit unattended posture such as `--permission-mode bypassPermissions`;
explain its effect and only include it if the user accepts that permission scope.
Do not add permission bypasses, `--force`, or `--accept open` to cure a refusal.
Use the selected harness's flags, then repeat the preview with those same flags.

Explain that a serve worker can pick up any compatible pending run for that
factory, not only the next request in this conversation. Inspect known pending
work before launching; use an agreed dedicated factory where that scope is too
broad. When ready, have the user run the same verified command without `--print`
in a terminal they keep open. Offer persistent service setup only if wanted.

Publish availability from the worker's configured machine/session:

```sh
spor capabilities publish
```

This uses `dispatch.agent`, so it must match the intended worker, even when the
launch also supplies `--as`. Some clients, including 0.31.3, do not automatically
publish capabilities or refresh scheduler heartbeat from `spor work` (tracked
as `issue-spor-work-does-not-publish-capabilities-or-heartbeat`). A manual publish
can unblock initial discovery; it is not a durable heartbeat service. Refresh
publication if preflight later reports stale visibility. For unattended ongoing
use, verify a supported worker release or existing supervisor maintains freshness;
do not invent a `spor heartbeat` command or promise automatic availability.

## 5. Check through MCP, then submit the reviewed work

In ChatGPT on the web, perform these checks with connected MCP tools yourself.
CLI status/log requests are diagnostic fallbacks for facts the server cannot
observe, not the normal status workflow.

1. Call `preflight_program_run` with the actual `program_id` and `factory_id`.
   Inspect `workers` for the intended agent's freshness and each selected member's
   `compatible_workers`, readiness, blockers, and capability gaps. A fresh
   published record means visible/compatible, not proof of a running process.
   `can_start` alone does not mean the desired members are eligible.
2. Review the exact cohort and factory with the user. Resolve readiness through
   the workspace's reviewed readiness action, or guide `spor ready <task-id>`
   when appropriate; never stamp an incomplete or human-only task just to launch.
   Refresh preflight after any changes. Keep blocked and human members visible.
3. With authorization for that reviewed run, use the workspace Start confirmation
   or `start_program_run` with the current `preflight_revision`, admitted IDs,
   and one idempotency key according to its live schema. Reuse the same key and
   payload on an uncertain retry; re-read first rather than creating duplicates.
   This creates a durable request; the server does not launch the local process.
4. Read `get_program_run` by the returned run ID and use bounded
   `get_program_run_events` reads, following cursors when necessary. Verify a
   live controller/lease and its actual worker, machine, and instance. If another
   compatible worker claims it, report that accurately; publishing a request
   does not pin it to the machine just configured.
5. Inspect the returned child with `get_execution` to verify admission, active
   implementation/stage, and ownership. Distinguish waiting for a worker, claimed,
   implementing, blocked, awaiting approval, and completed. Do not report actual
   pickup until the telemetry confirms it; do not claim success from Start alone.

Use a few reads over the worker's poll interval, not an indefinite tight loop.
If no claim appears, report waiting and check tenant, agent credential, selected
factory, stale publication, repo access, and profile compatibility. Only then ask
for local `spor work --status --json` or a small redacted error excerpt if needed.
With no target run, the current MCP preflight cannot prove that an idle process
is alive: say availability is advertised and pickup remains unverified. If the
host lacks these MCP tools, explain the missing surface and use an explicitly
agreed local diagnostic fallback; never pretend an agent node is live telemetry.

## 6. Leave them with working controls

Open the run monitor and point out progress, discoveries, artifacts, and gates.
Explain that pausing stops new admissions while current children continue;
draining lets current pipelines settle. Cancelling a parent or stopping the local
worker does not kill every child. Use the available reviewed run controls for
the user's chosen action; let the worker controller record completion.

Finish with the factory, worker identity, request/run ID, what MCP verified, and
any remaining blocker. Keep the terminal/service running for ongoing work. The
user can return to the workspace to submit another reviewed task or program.

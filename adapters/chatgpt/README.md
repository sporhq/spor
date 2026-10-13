# ChatGPT plugin release package

Every `v*` tag builds `plugin.zip` and attaches it to the matching GitHub Release.
The ChatGPT Plugin workflow also validates pull requests and main, retaining the
ZIP as the `chatgpt-plugin` Actions artifact. To repair a missing release asset,
rerun that workflow for the tag; it does not republish npm.

Build locally with Python 3 (standard library only):

```sh
npm run package:chatgpt
python3 test/package-chatgpt.test.py
```

The result is `dist/chatgpt/plugin.zip`, with one `spor/` directory containing a
portable `plugin.json`, `mcp.json`, hosted-MCP and workspace-onboarding skills,
and license notices.
It also includes Spor's existing 512px square brand icon (from the website brand
assets), referenced as both the logo and composer icon. The builder validates
these required references and PNG dimensions before writing the archive.
The builder supplies the version from `package.json` and checks the existing
Claude/Codex/lockfile versions. `--tag vX.Y.Z` additionally checks the release tag.
The adapter manifest is a template; install the generated archive, not this folder.
Only explicitly listed files enter the archive. No local configuration, tokens,
CLI hooks, worktrees, or app-account bindings are bundled.

Upload the ZIP through ChatGPT's plugin installation/import flow and connect
Spor using OAuth. A Spor account with team graph access is required. The service
is the existing `https://mcp.sporhq.io/mcp` endpoint; its OAuth discovery metadata
is served at `https://mcp.sporhq.io/.well-known/oauth-protected-resource`.
Packaging does not upload to an account or submit to the public directory.
An actual import and authenticated ChatGPT session are separate acceptance checks.

The format follows [OpenAI's plugin package guide](https://developers.openai.com/plugins/build/plugins).
ChatGPT uses a dedicated MCP-focused skill because local CLI and session hooks
are not available in a hosted chat. Keep it aligned with the tool contract when
changing the shared skills or MCP API.

## Workspace onboarding

`extensions.com.openai.onboardingSkill` points to
`./skills/workspace-onboarding/SKILL.md` inside the generated package. Running
plugin setup starts a guided workspace workflow in a new conversation, or
continues the conversation in which the plugin was installed. Users can also
ask for a workspace tour. The skill uses connected MCP tools, adapts to the
available app features, and teaches through the user's work. The separate CLI
`onboard` skill remains responsible for local identity and repository setup.

An optional [factory and worker guide](skills/workspace-onboarding/references/factory-worker.md)
is bundled with the skill. After the user opts in, it covers factory definition,
local CLI setup and launch, and reviewed task/program submission. ChatGPT on the
web checks availability and actual pickup with MCP preflight and run/execution
telemetry. Local status commands are a diagnostic fallback. The guide distinguishes
published capabilities from a live worker and handles program-only clients and
clients without automatic availability publication.
Factory setup first retrieves graph release policies and inspects accessible
repo/CI evidence, preserving established release and approval boundaries and
surfacing conflicts before proposing changes.

After importing a test ZIP, verify setup in both a fresh conversation and an
existing feature-planning conversation. Check that the latter retains its task
and project; skipping exits the tour. Also exercise a disconnected account, an
empty project, and a host without interactive views. With a connected workspace,
verify queue-to-node navigation, passage/image context and its removal, and
program/run evidence. Setup by itself must not create tasks or start a factory.
The package tests verify the bundled entrypoint and reproducibility; these live
host checks verify the conversational experience.

For the optional execution route, use a scratch graph and checkout with a stub
or bounded test harness. Verify declining leaves setup unchanged; accepting
reuses an existing factory or reviews a new definition before writing it. Check
that commands use the chosen tenant/agent and installed client capabilities,
secrets stay local, and web status checks use MCP. Exercise fresh publication
without a running process, stale publication, a mismatched factory/profile,
single-task admission, and program admission. Start must remain "waiting" until
a live controller claims it, with implementation verified by child telemetry.
Do not launch a real worker against the shared graph for package tests.
Also check factory proposals against an established graph release policy, a new
user's repo-only CI process, inaccessible release settings, and conflicting graph
and repo evidence. Proposals should cite their sources, reuse existing checks,
and ask only about gaps or conflicts rather than assume a generic release flow.

The tag workflow creates a GitHub Release if absent. Consequently release.js
`--no-release` only skips its immediate local GitHub API call; pushing a tag
still publishes the ZIP and creates its release in CI. `--no-push` stays local.

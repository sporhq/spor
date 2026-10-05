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
portable `plugin.json`, `mcp.json`, a hosted-MCP skill, and license notices.
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

The tag workflow creates a GitHub Release if absent. Consequently release.js
`--no-release` only skips its immediate local GitHub API call; pushing a tag
still publishes the ZIP and creates its release in CI. `--no-push` stays local.

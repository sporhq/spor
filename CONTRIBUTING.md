# Contributing to Spor

Thanks for your interest in Spor. This repository is the **client** half of
Spor — the Claude Code plugin, the zero-dependency Node hook engines, the
`lib/` client core, the per-agent adapters, the skills, and the public specs
(GRAPH.md, API.md, QUEUE.md).

## License of contributions

Spor is licensed under the [Apache License 2.0](LICENSE). By submitting a
contribution (a pull request, patch, or any change), you agree that your
contribution is licensed under the same Apache License 2.0, under the inbound =
outbound principle (Section 5 of the license). Don't submit code you can't
license this way.

We don't require a separate CLA. Please make sure your commits are made under
your own name and email; a `Signed-off-by` line (`git commit -s`), asserting
the [Developer Certificate of Origin](https://developercertificate.org/), is
appreciated but not required.

## Ground rules that bite

These are hard constraints in this repo — a change that breaks them won't be
merged:

- **Zero dependencies.** The published package (see `package.json` `files`) is
  plain Node — node builtins and the `git` binary only, no `npm install`. The
  plugin must run anywhere Claude Code runs, natively on Windows, macOS, and
  Linux. New runtime dependencies are not accepted there. (`.claude/` operator
  tooling — outside the package — is exempt; see CLAUDE.md.)
- **No model calls on the prompt path.** The per-prompt hook has a tight time
  budget and must stay select-and-inject (tf-idf + graph walk). LLM work
  belongs in the async end-of-session distiller or in in-session skills.
- **Refactors prove themselves.** Behavior-preserving changes must keep the
  compiler/validator/queue output byte-identical (the `conformance/` golden
  suite stands guard).
- **Hooks fail open.** A hook must exit 0 quickly no matter what — never block
  or slow a user's session.

See [CLAUDE.md](CLAUDE.md) for the full set of project rules and gotchas.

## Before you open a PR

```bash
npm test            # the zero-dep node:test suite (test/*.test.js)
npm run conformance # the byte-identical golden suite
```

Both must pass. Add tests for new behavior, and keep new code in the style of
the code around it.

## Reporting bugs and ideas

Open an issue at <https://github.com/sporhq/spor/issues>. For anything that
looks security-sensitive, follow [SECURITY.md](SECURITY.md) instead of filing a
public issue.

## Code of conduct

Participation is governed by our [Code of Conduct](CODE_OF_CONDUCT.md).

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

## Skill eval suites

Some shipped skills carry an `evals/evals.json` (currently `skills/factory/` and
`skills/onboard/`) — trigger-accuracy test cases authored via `/skill-creator`
(its own format: `{skill_name, evals: [{id, prompt, expected_output, files}]}`,
documented in that plugin's `references/schemas.md`). This is **not** the
`claude plugin eval` CLI's `case.yaml`/`prompt.md` format — that feature is
early-access, needs an undocumented enablement setting, and would need every
case rewritten to adopt.

Two things check these suites, at different costs:

- **Manifest validity** (`test/skill-evals-manifest.test.js`, part of `npm
  test`, runs on every PR/push): a fast, zero-cost structural check — valid
  JSON, `skill_name` matching the directory and `SKILL.md` frontmatter, unique
  ids, non-empty `prompt`/`expected_output`, and any `files` reference actually
  existing. Catches a manifest silently rotting (a rename, a typo, a dangling
  file) immediately.
- **Trigger-accuracy run** (`scripts/run-skill-evals.js`, wired to
  `.github/workflows/skill-evals.yaml` on a weekly schedule + manual
  `workflow_dispatch`, **not** per-PR): drives the real `claude` binary with
  this plugin loaded against each eval's `prompt` and checks whether the
  `Skill` tool fires exactly when the case expects it to (a case's
  `expected_output` starting with "Should NOT trigger" is a negative case).
  Each case is one real, billed model call, so it runs on a schedule rather
  than every push. It needs an `ANTHROPIC_API_KEY` repository secret; without
  one configured it logs a message and exits 0 rather than failing the job.
  `test/skill-evals-runner.test.js` covers the harness itself (spawn,
  stream-json parsing, tool-use detection) against the fake Anthropic API used
  elsewhere in this suite, so that logic is verified without spending real API
  budget — only the scheduled workflow spends money, and only once the secret
  exists.

Adding a new skill's `evals/evals.json`? Follow the existing two as the
template; both checks above pick it up automatically (no registration step).

## Reporting bugs and ideas

Open an issue at <https://github.com/sporhq/spor/issues>. For anything that
looks security-sensitive, follow [SECURITY.md](SECURITY.md) instead of filing a
public issue.

## Code of conduct

Participation is governed by our [Code of Conduct](CODE_OF_CONDUCT.md).

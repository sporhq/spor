# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities **privately** — do not open a public
issue, pull request, or discussion for a suspected vulnerability.

Use GitHub's private vulnerability reporting for this repository:

> **Security → Report a vulnerability** at
> <https://github.com/sporhq/spor/security/advisories/new>

If you cannot use that channel, reach us via <https://sporhq.io> and we will
provide a private way to share the details.

When reporting, please include as much as you can:

- a description of the issue and its impact,
- the version, commit, or release affected,
- steps to reproduce or a proof of concept,
- any suggested remediation.

We will acknowledge your report, keep you updated on our assessment and a fix,
and credit you when a fix ships (unless you prefer to remain anonymous).

## Scope

This repository is the Spor **client**: the Claude Code plugin, the hook
engines, the `lib/` client core, the per-agent adapters, and the skills. Issues
worth reporting include, for example: a hook that can be made to execute
untrusted input, leakage of tokens or local file contents, a path-traversal or
injection in node handling, or a way to bypass the fail-open/again-safe
guarantees.

## Supported versions

Spor is pre-1.0 and ships from the `main` branch and the latest published
release. Security fixes are made against the latest release; please test
against current `main` before reporting.

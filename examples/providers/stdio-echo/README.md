# stdio-echo

The reference execution provider for Spor's subprocess binding
([PROVIDERS.md §12](../../../PROVIDERS.md)). It is one Node file with no
dependencies, and it passes the whole conformance suite.

Each attempt "runs" in its own scratch directory: a runner process commits the
attempt spec to a fresh git repository there, and that commit is the
candidate. stdio-echo runs no harness and resolves no secret. A real provider
replaces the runner with `spor attempt run <bundle>` inside the environment it
builds, such as a container or a VM ([PROVIDERS.md §13](../../../PROVIDERS.md)).
That runner checks the pinned repos out, runs the harness, and pushes the branch
to the repo's `url` before a manifest names it.

stdio-echo keeps its own echo runner on purpose. `spor provider check` drives
it with attempts that pin synthetic commits in repos that do not exist. No
environment can check those out, so `spor attempt run` would refuse every one
of them before launch, and the conformance suite would only ever see the
refusal.

## Try it

Declare it on this machine, in `$SPOR_HOME/config.json` (paths must be
absolute):

```
{
  "dispatch": {
    "provider": {
      "stdio-echo": {
        "command": "node",
        "args": ["/abs/path/to/examples/providers/stdio-echo/provider.js", "--root", "/abs/scratch/dir"]
      }
    }
  }
}
```

Then:

```
spor capabilities providers      # its describe(), beside the built-in `local`
spor provider check stdio-echo   # every conformance scenario, against a scratch home
```

`--root` is where environments live. Without it the provider makes a temporary
directory and removes it when the binding closes; a provider killed mid-attempt
(the conformance suite's crash scenario does exactly this) leaves its
directory behind.

## What to copy

- `hello` answers `{contract_version, provider_id}`; the id must match the
  declared one.
- `submit` is idempotent on the key: the same attempt under the same key
  returns the same handle with `existing: true`, and a different attempt under
  it is `idempotency_conflict`.
- An attempt whose `prompt_bundle_ref` has a `/hold/` segment keeps running
  until cancelled. `spor provider check` relies on that to test cancel.
- `collect` answers a manifest only for a finished attempt that produced a
  commit, and only with a reference something other than the environment can
  fetch.
- `release` is idempotent.
- Anything written to stderr shows up in the worker's log as
  `[provider stdio-echo] …`; stdout carries protocol lines only.

# Spor execution-provider contract

`contract_version: 1`

An **execution provider** answers one question for `spor work`: *where does
this attempt run?* It might be a git worktree on the worker's own box, a
container, a VM or a cloud sandbox. This document specifies the contract
between the worker loop and a provider precisely enough that a third party can
implement a provider without our client. The machine-readable half is
`lib/kernel/provider-contract.js`: the schemas for every object below, as
zero-dependency validators. `test/provider-contract.test.js` validates every
JSON example in this file against those schemas, so an example here cannot
drift from the code.

Governing decision: dec-spor-work-execution-provider-contract. Companion
specs: [WORKERS.md](WORKERS.md) (the worker protocol, the prompt contract
§4, the execution store §10.15), [API.md](API.md) (REST/MCP).

**Status.** This is the contract only. The `local` provider extraction
(task-spor-work-local-provider-refactor), the capability matcher
(task-spor-execution-provider-capability-vocabulary), the subprocess stdio
binding (task-spor-execution-provider-stdio-binding), the in-environment runner
(task-spor-attempt-bundle-run), the conformance suite
(task-spor-execution-provider-conformance-suite) and the server's attempt
handle and attempt-scoped token are separate items. None of them is shipped
yet, so `spor work` behaves today exactly as WORKERS.md describes.

## 1. Two seams, three layers

`spor work` has two independent seams. Each one is a flag of the same loop;
neither one is a second dispatcher.

- **SOURCE** is where attempts come from: the queue, `--program <id>`, or (later)
  `--serve`, which polls durable work requests held by the server.
- **EXECUTOR** is where an attempt runs. That is the execution provider, and it
  is the subject of this document.

Three layers sit underneath an attempt:

| layer | answers | example |
|---|---|---|
| source | which item, under which factory | the dispatchable queue page |
| **provider** | which environment | a worktree, a container, an exe.dev VM, an Azure sandbox |
| harness adapter | which agent CLI, which argv, how its stream is read | claude-code, codex, a declared `dispatch.harness.<id>` |

The harness adapter (dec-spor-dispatch-harness-adapter-contract) is unchanged.
It runs inside whatever environment the provider supplies. A provider is never
a harness adapter: a VM provider must be able to run any adapter.

## 2. Versioning, envelopes, forward compatibility

Every message carries `contract_version: 1`. A provider that does not speak
the requested version answers `contract_version_unsupported` with a
human-readable message. It never guesses.

**Unknown fields are ignored**, at every level and in both directions. A v1
reader that meets a field a later revision added must not refuse the message.
That is why no schema in the module declares `additionalProperties`. The one
exception is closed by name rather than by shape: a secret entry (and the
`spor` block) must not carry a value-bearing key (`value`, `secret`,
`plaintext`, `token`, `password`, `data`). See §4.2.

The contract is transport-neutral. A binding (subprocess JSON-over-stdio
first, then HTTP) carries one **request** and one **response** per operation:

```json provider-contract=request
{
  "contract_version": 1,
  "id": "req-1",
  "op": "observe",
  "params": { "handle": { "provider": "container", "id": "ctr-7f3a" } }
}
```

```json provider-contract=response:observe
{
  "contract_version": 1,
  "id": "req-1",
  "ok": true,
  "result": { "state": "running", "since": "2026-10-09T10:04:11Z" }
}
```

A response carries exactly one of `result` (when `ok: true`) or `error` (when
`ok: false`), never both. A failed operation answers `ok: false` with an `error`. `code` is a snake_case
string and `retryable` says whether the same request may simply be sent again:

```json provider-contract=response:submit
{
  "contract_version": 1,
  "id": "req-2",
  "ok": false,
  "error": {
    "code": "unsatisfiable",
    "message": "isolation 'vm' is not offered; this provider offers: container",
    "retryable": false
  }
}
```

Known codes are `invalid_request`, `contract_version_unsupported`,
`unsupported_operation`, `unsatisfiable`, `idempotency_conflict`,
`unknown_handle`, `unavailable` (transient) and `internal`. A worker reads any
other code as `internal`.

## 3. Operations

| op | params | result | notes |
|---|---|---|---|
| `describe` | `{}` | describe-result | Capabilities over the capability vocabulary. The worker caches it per pass. |
| `submit` | `{attempt, idempotency_key}` | submit-result | Idempotent on the key (§6). |
| `observe` | `{handle}` | observe-result | Pollable. A provider MAY also stream. |
| `collect` | `{handle}` | collect-result | Persisted BEFORE `release` (§7). |
| `cancel` | `{handle, force?}` | `{state}` | Graceful by default; `force: true` is the kill (§8). |
| `release` | `{handle}` | `{released: true}` | Tears the environment down. Idempotent: releasing a released handle succeeds. |
| `suspend`, `resume` | `{handle}` | observe-result | Optional (§10). |
| `checkpoint` | `{handle}` | `{checkpoint: {id, created_at}}` | Optional. |
| `restore` | `{handle, checkpoint_id, idempotency_key}` | submit-result | Optional. Returns a NEW handle. |

A **handle** is `{provider, id}` plus any provider-private fields. The worker
persists it on the execution record exactly as returned and hands it back
unchanged, so a provider can stash whatever it needs to find the environment
again.

### describe

```json provider-contract=describe-result
{
  "provider_id": "container",
  "contract_version": 1,
  "capabilities": {
    "harnesses": ["claude-code", "codex"],
    "reachable_mcp": ["spor"],
    "skills": [],
    "plugins": ["spor@spor"],
    "tools": ["git", "node", "npm", "gh"],
    "egress": ["api.anthropic.com", "api.sporhq.io", "github.com", "registry.npmjs.org"],
    "isolation": ["container"],
    "secret_delivery": ["file"],
    "lifecycle": ["cancel", "force-cancel"],
    "resources": { "cpu": 4, "memory_mb": 8192, "disk_mb": 20480 },
    "max_deadline_ms": 14400000
  }
}
```

`isolation` and `lifecycle` are required. Every other axis defaults to empty.
The worker matches the attempt spec against these capabilities using the same
pure shape as the profile matcher `satisfies()`
(dec-spor-machine-profile-satisfiability). If an attempt does not match, the
worker **refuses loudly, leaves the assignment intact, and never substitutes**.
How each axis matches is task-spor-execution-provider-capability-vocabulary.

## 4. The attempt spec

The attempt spec is **derived, never hand-written**. The worker builds it from
the resolved profile, the pinned factory and the item. It names everything the
environment must hold and nothing the provider could leak:

```json provider-contract=attempt-spec
{
  "contract_version": 1,
  "attempt_id": "wrk-a1b2:4211:1696850000",
  "execution_id": "exec-3f9c0a1b2c3d4e5f",
  "fence": 3,
  "tenant": "acme",
  "node_id": "task-acme-rate-limit",
  "harness": { "id": "claude-code", "version": "2.1.177" },
  "model": "claude-opus-5-5",
  "mcp": ["spor"],
  "skills": [],
  "plugins": ["spor@spor"],
  "tools": ["git", "node", "npm"],
  "repos": [
    {
      "slug": "acme-api",
      "commit": "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      "branch": "spor/task-acme-rate-limit",
      "url": "https://github.com/acme/acme-api.git"
    }
  ],
  "egress": { "allow": ["api.anthropic.com", "api.sporhq.io", "github.com"] },
  "secrets": [
    { "name": "GITHUB_TOKEN", "ref": "vault://acme/ci/github-token" },
    { "name": "ANTHROPIC_API_KEY", "ref": "vault://acme/llm/anthropic" }
  ],
  "spor": {
    "server": "https://api.sporhq.io",
    "token_ref": "spor-attempt-token://exec-3f9c0a1b2c3d4e5f/3"
  },
  "resources": { "cpu": 2, "memory_mb": 4096, "disk_mb": 10240 },
  "deadline": "2026-10-09T14:00:00Z",
  "isolation": "container",
  "prompt_bundle_ref": "https://bundles.acme.internal/attempts/exec-3f9c0a1b2c3d4e5f/3/prompt.tar"
}
```

### 4.1 Field reference

| field | meaning |
|---|---|
| `attempt_id` | The execution **instance**: the claiming process (WORKERS.md §10.15). One execution may see several attempts. |
| `execution_id`, `fence` | The execution record this attempt serves and the fence it was claimed under. Everything the attempt writes back is checked against both. |
| `tenant`, `node_id` | The org the attempt's graph writes land in, and the item it works. |
| `harness` | `{id, version?}`, the harness adapter to run in the environment. |
| `model` | Optional. The profile's model, when the profile names one. |
| `mcp`, `skills`, `plugins`, `tools` | What must be reachable or present. `tools` are binaries on `PATH`. |
| `repos[]` | `{slug, commit, branch, url?}`. Each repo is pinned to a full object name, and the attempt commits to `branch`. |
| `egress.allow[]` | Hosts the attempt may reach. Everything else is denied wherever the provider can enforce it. |
| `secrets[]` | `{name, ref}`, **by reference only** (§4.2). |
| `spor` | `{server, token_ref}`. Names the server and the attempt-scoped token (§4.3). |
| `resources` | Optional. `{cpu?, memory_mb?, disk_mb?}`. |
| `deadline` | The attempt's wall clock (§8). |
| `isolation` | `worktree`, `container` or `vm`. |
| `prompt_bundle_ref` | Where the prompt bundle lives: the session note, `# Spor briefing`, `# Task` and the worker contract (WORKERS.md §4). |

### 4.2 Secrets travel by reference only

Spor never transports a secret value. A `secrets[]` entry is a `name` (the env
or file name the harness expects) and a `ref`: an absolute URI into **the
provider's own vault** (`vault://…`, `azure-keyvault://…`, a token-mint
integration URL). The provider resolves the reference at the edge, through one
of the delivery modes it advertises (`file`, `egress-inject`, `token-mint`).
There is no class for plaintext env values passed through Spor. The validator
refuses an entry whose `ref` is not a URI, and an entry that carries a value
under any key. Every reference in the contract is a URI with no userinfo
(`https://user:token@host` and `https://token@host` are refused; a bare ssh
login such as `ssh://git@host/…` names an account and is allowed). So this
entry is refused:

```json provider-contract-refused=secret-entry
{ "name": "GITHUB_TOKEN", "ref": "ghp_live0123456789abcdef" }
```

### 4.3 The attempt-scoped token

`spor.token_ref` names the **only** credential Spor itself mints for an
attempt: a token issued by the server when the attempt is admitted. It is bound
to (agent, execution, fence, instance), it expires with the worker's lease, it
is one-shot per fence, and it is refused after release, a terminal state or a
fence advance (task-spor-server-attempt-scoped-token). The provider delivers it
like any other secret. A long-lived personal access token never enters a
sandbox.

## 5. The observe state machine

```
pending ──► provisioning ──► running ──► stopping ──► finished
                               │ ▲          ▲
                               ▼ │          │
                            suspended ──────┘

any non-terminal state ──► failed | lost
```

The allowed moves are exactly `OBSERVE_TRANSITIONS` in the module. Beyond the
arrows above, a provider may skip a step it does not have: `pending` may go
straight to `running` or `stopping`, `provisioning` may go to `stopping`, and
`running` may go straight to `finished` when there is nothing to wind down.

| state | meaning |
|---|---|
| `pending` | Accepted, not yet provisioning. |
| `provisioning` | The environment is being built: image, clone, secrets. |
| `running` | The harness is running in the environment. |
| `suspended` | Paused by `suspend`; only a provider advertising `suspend` reports it. `resume` returns it to `running`. |
| `stopping` | Winding down after the harness exits or a cancel. This is the collect window. |
| `finished` | The environment ran to the end. The harness exit is in `exit`. |
| `failed` | The provider could not run the attempt (provisioning failed, the image could not be pulled). |
| `lost` | The provider can no longer account for the environment (host gone, heartbeat lapsed). |

`finished`, `failed` and `lost` are terminal **for the environment** and carry
the only `exit` an observe may report. A state may repeat, because an observe is
a poll. A terminal state never moves again.

```json provider-contract=observe-result
{
  "state": "finished",
  "since": "2026-10-09T11:52:40Z",
  "exit": { "code": 0 },
  "detail": "harness exited; manifest ready for collect"
}
```

An observe state is **evidence, never a task outcome**. `finished` with
`exit.code: 0` does not mean the item is done. Whether it is done is still
decided where it is decided today: the run's report, the candidate, the gate
pipeline and the completion boundary (WORKERS.md §6, §10).

## 6. Idempotency, and holding on unknown acceptance

`submit` is idempotent on `idempotency_key` (at least 8 characters, required).
The worker mints the key once, for the attempt it is about to submit (from
`execution_id`, `fence` and `attempt_id`, for example), and **persists the key
and the request on the execution record BEFORE the first send**. A re-send
always uses that persisted key and request, never a re-derived one. This
matters after a restart: the restarted worker is a new instance under an
advanced fence, so a key re-derived from its own identity would be a new key,
and a new key is a new environment.

- **Same key, same attempt:** the provider returns the SAME handle with
  `existing: true`. It never creates a second environment.
- **Same key, different attempt:** `idempotency_conflict`.

```json provider-contract=request
{
  "contract_version": 1,
  "id": "req-3",
  "op": "submit",
  "params": {
    "idempotency_key": "exec-3f9c0a1b2c3d4e5f/3/wrk-a1b2:4211:1696850000",
    "attempt": {
      "contract_version": 1,
      "attempt_id": "wrk-a1b2:4211:1696850000",
      "execution_id": "exec-3f9c0a1b2c3d4e5f",
      "fence": 3,
      "tenant": "acme",
      "node_id": "task-acme-rate-limit",
      "harness": { "id": "codex" },
      "mcp": [], "skills": [], "plugins": [], "tools": ["git"],
      "repos": [{ "slug": "acme-api", "commit": "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "branch": "spor/task-acme-rate-limit" }],
      "egress": { "allow": [] },
      "secrets": [],
      "spor": { "server": "https://api.sporhq.io", "token_ref": "spor-attempt-token://exec-3f9c0a1b2c3d4e5f/3" },
      "deadline": "2026-10-09T14:00:00Z",
      "isolation": "container",
      "prompt_bundle_ref": "https://bundles.acme.internal/attempts/exec-3f9c0a1b2c3d4e5f/3/prompt.tar"
    }
  }
}
```

```json provider-contract=submit-result
{
  "handle": { "provider": "container", "id": "ctr-7f3a", "host": "builder-2" },
  "accepted_at": "2026-10-09T10:03:58Z",
  "existing": false,
  "env": { "image": "ghcr.io/acme/spor-attempt:2026.10" }
}
```

**Unknown acceptance: hold, then reconcile.** If a submit's reply is lost (a
timeout, a dropped connection), the worker does not know whether an environment
exists. It **holds**: it does not retry under a new key and it does not mark
the attempt failed. It reconciles by re-sending the persisted request with the
persisted key. That is safe by the rule above, and the reply settles the
question. A blind retry under a fresh key is exactly the duplicate environment
this rule exists to prevent. Once a handle comes back, it is written to the
execution record as `attempt.submitted {provider, handle, idempotency_key,
env}` before submit returns to the loop.

**Adoption.** A restarted worker re-claims the execution as a new instance
under an advanced fence. If the record carries `attempt.submitted`, it
**adopts** the live attempt by that handle (observe, collect, release) instead
of submitting again. If it carries only the persisted key and request (the
previous instance died while holding), it reconciles exactly as above and then
adopts. Either way the old fence's attempt token is dead; how the adopted
environment gets a token for the new fence is the server's attempt-token
contract (task-spor-server-attempt-scoped-token), not a resubmit.

## 7. Collect before release; the result manifest

`collect` returns what the attempt produced. The worker **persists the result
manifest before it calls `release`**, because release may destroy the only copy
of the environment's work. A provider must keep `collect` answerable until
release.

A manifest exists only when there is a **candidate**: a pinned commit, the tree
it resolves to, and a portable reference something other than the environment
can fetch. This is the same object and the same reference rule as a factory
candidate (WORKERS.md §10.12, `referenceRefusal` in `lib/kernel/candidate.js`).
The candidate reference is required, and it must be fetchable off the
environment: a `file://` locator is refused in a provider manifest, because the
manifest is read after `release` may have destroyed the filesystem it names.

```json provider-contract=collect-result
{
  "manifest": {
    "attempt_id": "wrk-a1b2:4211:1696850000",
    "execution_id": "exec-3f9c0a1b2c3d4e5f",
    "fence": 3,
    "candidate": {
      "repo": "acme-api",
      "commit": "9fceb02d0ae598e95dc970b74767f19372d61af8",
      "tree": "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      "branch": "spor/task-acme-rate-limit",
      "reference": {
        "kind": "branch",
        "locator": "https://github.com/acme/acme-api.git",
        "ref": "refs/heads/spor/task-acme-rate-limit",
        "commit": "9fceb02d0ae598e95dc970b74767f19372d61af8"
      }
    },
    "report_ref": "https://bundles.acme.internal/attempts/exec-3f9c0a1b2c3d4e5f/3/report.md",
    "log_refs": ["https://bundles.acme.internal/attempts/exec-3f9c0a1b2c3d4e5f/3/harness.jsonl"],
    "evidence": [
      { "kind": "author-check", "ref": "https://bundles.acme.internal/attempts/exec-3f9c0a1b2c3d4e5f/3/npm-test.log" }
    ]
  }
}
```

An attempt that produced nothing (it failed before committing, or it was
cancelled before any work) answers with a null manifest and a stated reason. It
never answers with a manifest that is missing its candidate:

```json provider-contract=collect-result
{
  "manifest": null,
  "no_candidate": { "reason": "provisioning failed: image pull denied" },
  "log_refs": ["https://bundles.acme.internal/attempts/exec-3f9c0a1b2c3d4e5f/3/provision.log"]
}
```

## 8. Cancel, and the three clocks

`cancel` is graceful: the provider signals the harness, moves to `stopping`,
and keeps the environment collectable. `cancel {force: true}` kills the
environment outright. The worker's ladder is: graceful cancel, a collect window,
`collect`, then a forced cancel if the environment is still not terminal, then
`release`.

```json provider-contract=request
{
  "contract_version": 1,
  "id": "req-4",
  "op": "cancel",
  "params": { "handle": { "provider": "container", "id": "ctr-7f3a" }, "force": false }
}
```

Three clocks run during an attempt, and the contract never conflates them:

| clock | owner | effect |
|---|---|---|
| attempt **deadline** | the spec (`deadline`) | The provider stops the harness at the deadline. |
| worker **lease** | the execution store (`lease_expires_at`, fence) | A lapsed lease lets another worker take over. The attempt token stops working when the fence advances. |
| environment **lifetime** | the provider | Idle suspend, platform caps, auto-delete. The cap is advertised as `max_deadline_ms`, and an attempt whose deadline is further out than that does not match the provider. |

## 9. Failure semantics

A provider-level `failed` or `lost` is **evidence, not a terminal task result**.
The loop routes it through the paths that already exist: an attempt that
produced no candidate spends the implementation stage's retry pool, and a spent
pool escalates (WORKERS.md §10.16). The rescue lane and the person's queue item
apply as they do today. A provider never resolves, completes or abandons an
item, and it never writes to the graph. Graph writes come only from the
harness inside the environment (with the attempt-scoped token) and from the
worker.

## 10. The optional environment extension

`suspend`, `resume`, `checkpoint` and `restore` exist only on providers that
advertise them in `capabilities.lifecycle`. A worker never calls one that was
not advertised. If it does, the provider answers `unsupported_operation`. These
operations differ enough between platforms (Azure memory/disk suspend, E2B
pause, exe.dev none) that assuming them would be wrong somewhere. `restore`
creates a NEW environment from a checkpoint. It therefore takes its own
`idempotency_key` and returns a new handle. Expect replayed setup and expired
tokens in a restored environment: re-mint, never reuse.

## 11. Worked examples (prose; no vendor code ships in Spor)

**`local`** is the default, and it is today's behaviour. `describe` reports
`isolation: [worktree]` and the machine's probed capability map. `submit`
creates the dispatch worktree and starts the detached supervisor
(`launchSupervisedHarness`). The handle's `id` is the run id. `observe` reads
the run record; `collect` reads the report and the pinned candidate; `release`
removes the worktree. Secrets are not materialized, since the harness runs
with the operator's own environment. The extraction must be byte-identical:
same run records, same journal paths, same prompt bytes
(task-spor-work-local-provider-refactor).

**A container provider** (the first remote reference, decided before exe.dev).
`submit` runs a labelled container (`spor.execution=<id>`, `spor.fence=<n>`)
from an image carrying `spor` and the harness, mounts each resolved secret as
a file, applies the egress allowlist with a network policy or a proxy, and
starts `spor attempt run <bundle>`. The label gives `submit` idempotency: an
existing container with the key's label is returned with `existing: true`.
`observe` maps the container state onto §5 and relays the runner's status
stream. `collect` reads the manifest the runner wrote to a mounted volume.
`release` removes the container and the volume.

**exe.dev.** `submit` creates (or takes from a pool) a VM with
`--setup-script`, and starts the runner **detached** (`setsid nohup spor
attempt run …`), because an `exec` call is capped at 30 seconds. exe.dev has no
create-time secret injection, so secrets are delivered by `token-mint`: the VM
POSTs to an integration URL and receives short-lived credentials. The VM name
is derived from the idempotency key, because exe.dev has no native create
idempotency. `observe` polls a status file through `exec`. `lifecycle` is
`[cancel, force-cancel]`.

**Azure Container Apps sandboxes.** `submit` creates a sandbox in a sandbox
group with labels `{run_id, execution, fence}`, an egress policy of
default-Deny plus the allowlist, and a `Transform` rule that injects
credentials as headers at egress (`egress-inject`), so the sandbox never holds
the value. `list_sandboxes(labels=…)` both reconciles an unknown submit and
sweeps orphans. The platform's memory/disk suspend and snapshots let the
provider advertise `suspend`, `resume`, `checkpoint` and `restore`. Azure's own
docs warn that a clone replays non-idempotent setup and that tokens expire
while a sandbox is inactive, which is why §10 says re-mint.

All four answer the same six operations and pass the same conformance suite.
None of them adds vendor code to `lib/`.

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

**Status.** The contract, the `local` provider and the resolution rule are
shipped; the subprocess stdio binding
(§12, `lib/shell/providers/stdio.js`, with `examples/providers/stdio-echo/` and `spor provider check <id>`; no worker drives a binding yet) is shipped too, and so are
the attempt bundle and the in-environment runner `spor attempt build|run` (§13,
`lib/shell/attempt-bundle.js` + `lib/shell/attempt.js`); the worker's persisted attempt handle
(task-spor-work-attempt-handle-adoption) and the server's attempt-scoped token
are separate items. `spor work` therefore behaves today exactly as WORKERS.md
describes: every launch goes through the one door (`executeDispatch` in
`lib/shell/dispatch.js`), which now resolves a provider — `--provider <id>` >
`dispatch.provider.default` > `local` (`lib/shell/providers/index.js`; an id
this machine cannot run under is refused naming it, by `spor dispatch` before
any side effect and by `spor work` at startup, never silently run under
`local`) — and calls its `submit`. `local` (`lib/shell/providers/local.js`) is
the pre-provider launch byte-identical: `test/dispatch-local-provider.test.js`
pins the run record, job file, prompt bytes, journal layout and stdout against
a golden recorded from the inline launch, and drives the provider through the
conformance suite over real supervisor launches. Every dispatch submits the
DERIVED attempt spec (§4.4): `executeDispatch` derives it and matches it
against the provider's describe() with `satisfiesAttempt` before anything is
claimed, created or launched. The loop still reads run
records itself; `observe`/`collect`/`cancel`/`release` are exercised by the
suite and become the loop's own reads with the attempt-handle work. The
conformance suite every binding must pass is
`lib/shell/provider-conformance.js` (`runConformance(provider, {home,
driver})`), proven against the synthetic providers in
`test/fixtures/providers/` by `test/provider-conformance.test.js`. The
capability matcher (§3.1, `satisfiesAttempt` in `lib/kernel/satisfiability.js`)
is shipped, and `spor capabilities providers [--attempt <spec.json>]` prints
each provider's describe() — the built-in `local` one and every provider
declared on the machine (§12.1) — and, given a spec, why it would be refused.
The attempt token's hand-off (§4.3) is shipped too: the worker mints the
token and hands it to the provider through `deliver_credential` after every
submit and adoption (`deliverAttemptToken` in
`lib/shell/provider-attempts.js`), the stdio binding exempts exactly that
field from its secret refusal (§12.6), `spor attempt run` reads
`SPOR_TOKEN_FILE` (§13.1), and the conformance suite's `credential-rotation`
scenario pins delivery, rotation on a re-fence and the old token's refusal.

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
That is why only a few schemas in the module declare `additionalProperties`:
a secret entry is CLOSED to exactly `{name, ref}`, since an unknown key there
is a value riding where a reference belongs, and `deliver_credential`'s
`credential` is CLOSED to `{kind, ref, value, fence, expires_at}`, since it is
the one object that carries a value and nothing else may ride beside it. Its
`params` is CLOSED too, to `{handle, credential}`: the binding exempts
`credential.value` from its secret scan (§12.6), so an open `params` would let
an opaque sibling field ride beside the one value the scan does not read. The `spor` block stays open but
must not carry a value-bearing key (`value`, `secret`, `plaintext`, `token`,
`password`, `data`). See §4.2.
The one operation that does carry a value, `deliver_credential`, carries exactly
one kind of it — the attempt-scoped Spor token — at exactly one field (§4.3).

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
`unknown_handle`, `unavailable` (transient), `stale_credential` (§4.3) and
`internal`. A worker reads any
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
| `deliver_credential` | `{handle, credential}` | `{delivered: true}` | Optional, advertised under `lifecycle`. Puts the attempt token in the environment (§4.3). The only operation that carries a value. |

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
    "repos": ["*"],
    "egress": ["api.anthropic.com", "api.sporhq.io", "github.com", "registry.npmjs.org"],
    "isolation": ["container"],
    "secret_delivery": ["file"],
    "secret_schemes": ["vault", "op"],
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

### 3.1 How each axis matches

`satisfiesAttempt(capabilities, attempt)` in `lib/kernel/satisfiability.js`
returns every failing atom, each reason prefixed with the axis that failed
(`isolation: 'vm' is not offered (this provider offers: worktree)`). A
capability the provider leaves out is empty; an attempt field left out asks
for nothing. An attempt field that is present but malformed refuses on its
axis, and so does a missing `isolation`.

| axis | the attempt is satisfied when |
|---|---|
| `deny` | `attempt.profile` is not on the provider's `deny` list. Checked first: a policy opt-out refuses regardless of capability. |
| `harnesses` | `attempt.harness.id` is in `harnesses`. |
| `reachable_mcp`, `skills`, `plugins`, `tools` | `attempt.mcp`, `.skills`, `.plugins`, `.tools` are each a subset of the matching capability. |
| `repos` | Every `attempt.repos[]` slug is in `repos`, or `repos` holds `"*"` (the provider clones any repo) and the entry carries a `url`. A pin the entry carries is honoured: a `commit` that is not a full object name, an empty `branch`, or one slug pinned twice to different commits/branches refuses. |
| `egress` | `attempt.egress.allow` is a subset of `egress`, or `egress` holds `"*"` (unrestricted). An empty allow list (none) always matches; an allow list naming `"*"` (unrestricted) matches only a `"*"` provider. |
| `secret_delivery` | One of `attempt.secret_delivery` (the modes that can serve this attempt) is offered. With no `secret_delivery` stated, an attempt carrying `secrets[]` needs some mode, and one with none needs nothing. Stated empty, an attempt carrying `secrets[]` has no delivery path and is refused. |
| `secret_schemes` | Every `secrets[].ref`'s scheme (`vault` in `vault://acme/gh`) is in `secret_schemes`, the provider's registry of the vault schemes it resolves (§4.2). A provider that declares none resolves no reference, so any secret refuses; an attempt with no secrets asks nothing. The refusal names the secret, never its reference. |
| `isolation` | `attempt.isolation` is in `isolation`, **exactly**. A stronger kind is not offered in its place, because handing back a different environment than the spec names is a substitution. |
| `resources` | Each requested floor is at most the provider's ceiling. A floor against a ceiling the provider does not declare is refused. |
| `lifecycle` | `attempt.lifecycle` (the operations the attempt needs) is a subset of `lifecycle`. |
| `deadline` | `deadline - now` is within `max_deadline_ms`, when the provider declares one (§8). |

## 4. The attempt spec

The attempt spec is **derived, never hand-written**. The worker builds it from
the resolved profile, the pinned factory and the item (§4.4 says how, field by
field). It names everything the environment must hold and nothing the provider
could leak:

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
| `attempt_id` | The execution **instance**: the claiming process (WORKERS.md §10.15). One execution may see several attempts. It names the instance that SUBMITTED the attempt and stays that across a worker restart: an adopting instance never re-derives it (§6). |
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
| `profile` | Optional. The resolved profile id; a provider's `deny` list is keyed on it. |
| `secret_delivery` | Optional. The delivery modes, any one of which can serve this attempt's secrets (§3.1). |
| `lifecycle` | Optional. The lifecycle operations this attempt needs, such as `suspend` (§10). |
| `prompt_bundle_ref` | Where the prompt bundle lives: the session note, `# Spor briefing`, `# Task` and the worker contract (WORKERS.md §4). |

### 4.2 Secrets travel by reference only

Spor never transports a secret value. A `secrets[]` entry is a `name` (the env
or file name the harness expects) and a `ref`: an absolute URI into **the
provider's own vault** (`vault://…`, `azure-keyvault://…`, a token-mint
integration URL). The provider resolves the reference at the edge, through one
of the delivery modes it advertises (`file`, `egress-inject`, `token-mint`).
There is no class for plaintext env values passed through Spor. The validator
refuses an entry whose `ref` is not a URI, and an entry with any key besides
`name` and `ref`. Every reference in the contract is a URI with no userinfo
(`https://user:token@host` and `https://token@host` are refused; a bare ssh
login such as `ssh://git@host/…` names an account and is allowed, provided it
is at most 32 characters and does not open with a known token prefix, so
`ssh://ghp_…@host` is refused), no query and no fragment
(`?access_token=…`, a presigned `?X-Amz-Signature=…`, `#tok=…`), and no
credential-shaped string anywhere (`https://host/ghp_…/x.git`,
`vault://sk-live-…`). On top of that rule each field admits an allow-listed
SHAPE (`REFERENCE_FORMATS` in lib/kernel/provider-contract.js):

| Field | Shapes admitted |
|---|---|
| `repos[].url` | `https://host/path`, `ssh://[login@]host/path`, scp-style `login@host:path` |
| candidate `reference.locator` | `file://`, `https://`, `ssh://` |
| `spor.server` | a server base — `http(s)://host[:port]` with an optional path prefix (`https://host/spor`, a tenant behind a reverse proxy — what the worker's configured server resolves to); a local graph: its `file:///` nodes dir |
| `spor.token_ref` | `spor-attempt-token://<execution>/<fence>` |
| `secrets[].ref`, `prompt_bundle_ref`, `report_ref`, `log_refs[]`, evidence `ref` | any `<scheme>://…` reference |

`spor.server` and `spor.token_ref` are held to the credential-shape rule too
(`https://sk-live-….example.com`, `spor-attempt-token://spor_pat_…/1` are
refused). A refusal of either that carries no value — a path where an origin
belonged, a scheme the field does not take — is reported as the wrong shape,
never as "a secret by value".

**Which vaults a reference may name is the provider's registry.** A provider's
`describe()` lists the schemes it resolves as `capabilities.secret_schemes`
(`["vault", "op", "env-ref"]`); an attempt whose `secrets[].ref` names any
other scheme is refused by the matcher (§3.1) before it is submitted, so a
typo (`valut://…`) is a refusal at the worker, not a lookup failure inside the
environment.

**What the shape rule cannot see.** Credentials are recognized by a KNOWN
prefix only (`ghp_`, `glpat-`, `xox?-`, `sk-…`, `AKIA`, `spor_att_`,
`spor_pat_`, …). An opaque token written as a plain path segment
(`https://host/3f9a7c…/repo.git`, `vault://acme/9d2b…`) has no shape that
tells it from an id, so no reference check — and no `redact` — can detect it.
The defence there is the rule's other half: a reference names WHERE a value
lives, and a field that would need an opaque token in its path to work is a
field this contract does not admit.

A refusal never quotes the value: userinfo, query and fragment are cut and a
value still carrying a credential shape is withheld. So this
entry is refused:

```json provider-contract-refused=secret-entry
{ "name": "GITHUB_TOKEN", "ref": "ghp_live0123456789abcdef" }
```

### 4.3 The attempt-scoped token

`spor.token_ref` names the **only** credential Spor itself mints for an
attempt: a token issued by the server when the attempt is admitted. It is bound
to (agent, execution, fence, instance), it expires with the worker's lease, it
is one-shot per fence, and it is refused after release, a terminal state or a
fence advance (task-spor-server-attempt-scoped-token). A long-lived personal
access token never enters a sandbox.

**The worker mints it; the provider delivers it** (dec-spor-provider-
credential-review-signoff-2026-10-09 (g)). Once a submit has returned a
handle, the worker mints the token for the execution and fence it holds
(`POST /v1/executions/:id/attempt-token`, spor-server EXECUTION-STATE.md
§4.1) and hands it to the provider through `deliver_credential`. That
operation is the **one value exception** to §4.2: it carries the token itself,
at exactly `params.credential.value`, and nothing else ever does. The
provider writes it into the environment as a file, readable only by the
attempt, and points the runner's `SPOR_TOKEN_FILE` at it (§13.1). It
creates that file `0600` ATOMICALLY: write the token to a temp file in the same
directory, created with mode `0600` from the start (never chmod-ed down after
the bytes land), then `rename` it onto the path. The runner may be polling the
path already, so it must never see a partial token or a moment where the file
is readable by group or others.

```json provider-contract=request
{
  "contract_version": 1,
  "id": "req-7",
  "op": "deliver_credential",
  "params": {
    "handle": { "provider": "container", "id": "ctr-7f3a", "host": "builder-2" },
    "credential": {
      "kind": "spor-attempt-token",
      "ref": "spor-attempt-token://exec-3f9c0a1b2c3d4e5f/4",
      "value": "spor_att_v1_acme_q3Zr9TfX2bLm0WcY8nHkPd",
      "fence": 4,
      "expires_at": "2026-10-09T14:00:00Z"
    }
  }
}
```

```json provider-contract=response:deliver_credential
{ "contract_version": 1, "id": "req-7", "ok": true, "result": { "delivered": true } }
```

- `kind` is `spor-attempt-token`, the only kind. `value` must be an attempt
  token (`spor_att_…`), so a worker's own long-lived token can never ride the
  exception; `ref` is the token's reference as the attempt names it, and
  `fence` must be the fence that reference names.
- A provider advertises the operation as `deliver_credential` in
  `capabilities.lifecycle`. A worker never sends it to a provider that did not
  (the `local` provider does not: its harness runs under the worker's own
  launch).
- **Idempotent.** Re-sending the delivery already made (a lost reply) answers
  `delivered` again. The worker keeps the plaintext in memory only, so a re-send
  carries the SAME token; a worker that lost it revokes the fence's token and
  mints afresh (the server allows one live token per fence).
- **Never backwards.** A delivery under an OLDER fence than one the
  environment already holds answers `stale_credential`, and the environment
  keeps the newer token.
- **Rotation.** A restarted or takeover worker adopts the environment under an
  advanced fence (§6). The fence advance tombstoned the old token on the
  server, so the adopter mints a token for its own fence and delivers it
  through the same operation. Nothing is resubmitted.
- A delivery that did not land is owed: the worker's per-pass sweep re-sends
  it until the provider answers.
- **What rotation reaches.** A re-delivery replaces the token in the
  environment's file, and a runner that has not launched its harness yet
  reads the new one. A harness ALREADY running keeps the token it was launched
  with: the runner reads the file once, before launch, and hands the value to
  the harness (its environment, its MCP config). Rotating the credential of a
  running harness needs the harness side to re-read `SPOR_TOKEN_FILE`, which
  is not built yet. Today the work loop follows only `local` attempts, which
  take no delivery, so the adoption path is exercised by the conformance suite
  rather than by a running worker.
- A provider's refusal or stderr that echoes a delivered value is masked
  before it reaches the worker's log, and the worker never puts the token in a
  result, a record or a log line.

### 4.4 How the spec is derived

One pure function, `deriveAttemptSpec` in `lib/kernel/attempt-spec.js`,
derives every attempt, and both doors call it: `spor dispatch`
(`executeDispatch` in `lib/shell/dispatch.js`, through `attemptInputs(cfg,
plan)` and `deriveDispatchAttempt`) and `spor attempt build` (§13.2). So a
dispatched attempt and a bundled one cannot describe one item two ways.

| field | derived from |
|---|---|
| `node_id` | The item. A free-text dispatch has none. |
| `harness`, `model` | The harness adapter the dispatcher resolved, and the effective model (`--model`, else the profile's). |
| `profile`, `mcp`, `skills`, `plugins` | The resolved profile's id and runtime lists. When the launch wires the Spor MCP for an agent identity (remote mode), `spor` joins `mcp` even if the profile does not name it. |
| `tools` | `git`, which every attempt needs to commit its candidate, plus any the request names (`spor attempt build --tool`). |
| `repos` | The item's checkout: the commit at `HEAD` (or `--ref`), the branch the attempt commits to (a dispatch worktree's branch, else the checked-out branch; `spor attempt build` defaults to one branch per attempt), and the portable `origin` URL with any credential stripped. A checkout git cannot read pins nothing, and is still matched on every other axis. |
| `egress` | The request's allow list (`spor attempt build --egress`). Empty otherwise. |
| `secrets` | Always empty: no profile or factory names a secret reference yet. When a source gains them they ride here by reference (§4.2). |
| `spor` | The graph the attempt writes into: the server, or a local graph's `nodes/` as a `file://` reference. |
| `deadline` | The request's (`--deadline`), else the pinned factory's `implementation.budget.run_max_ms`, else the worker's `work.runMaxMs`. |
| `isolation` | The request's (`spor dispatch --isolation`, `spor attempt build --isolation`). `worktree` for a dispatch that names none. |
| `attempt_id`, `execution_id`, `fence`, `tenant`, `spor.token_ref` | Bound by `bindExecution` from the execution the worker holds. A person's own `spor dispatch` has no execution, so its spec is match-only and never sent as a contract message. The work loop's attempt driver binds the execution and then validates the whole spec against the contract schema before it persists the submit key. |

The dispatch matches the spec against the chosen provider's describe() with
`satisfiesAttempt` (§3.1). A mismatch is refused before anything is claimed,
created or launched, and every failing axis is named:

```
cannot dispatch iso-run: the local execution provider cannot run this attempt —
  isolation: 'container' is not offered (this provider offers: worktree)
  nothing was claimed, created or launched; the assignment is unchanged (…).
```

The `local` provider's describe() at the dispatch door is the box as the
dispatcher just resolved it: the fresh capability probe the profile matcher
used, the harness the dispatcher built a launch for, the checkout it
resolved, and in remote mode the Spor MCP. So the attempt matcher and the
profile matcher never disagree about one machine. On `local` the attempt
gate refuses only what a request asks for and the box cannot give (today,
an isolation kind other than `worktree`, or a tool not on `PATH`). Every
accepted dispatch launches byte-identically
(`test/dispatch-local-provider.test.js`).

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
execution record as `attempt.submitted {provider, handle, env}` before submit
returns to the loop.

**On the execution record** (EXECUTION-STATE.md §3/§5 in spor-server; the
client mirror is `lib/kernel/execution.js`, the worker side
`lib/shell/provider-attempts.js`) the persistence is three fenced events,
materialized as the attempt row's `provider` object:

| event | written | carries |
|---|---|---|
| `attempt.submitting` | before the first send | `provider`, `submit_idempotency_key`, `request` (the params minus the key; nothing provider-private) |
| `attempt.submitted` | once a handle comes back, before the loop proceeds | `provider`, `handle`, `submit_idempotency_key`, `env?` |
| `attempt.observed` | each pass the loop observes the environment | `state`, `detail?` |

The provider's key travels as **`submit_idempotency_key`** on these events.
The field `idempotency_key` on an execution event is the event log's own replay
key, which for these three is always derived (`<execution_id>:attempt.
submitted:<attempt>`, …). A writer that sends the provider's key as
`idempotency_key` is accepted and canonicalized, and sending both with
different values is `invalid_event`. A second submit for the same attempt
under a different handle or key is `attempt_handle_conflict`: adopt what the
record names.

The attempt index on these three events is **canonical**: a positive integer,
or a string of decimal digits naming one (`"01"` is attempt 1). It is
normalized before the replay key is derived, so `1` and `"01"` are one attempt
on the log as on the record, and the journal stores the integer. Anything else
(a fraction, an exponent, a boolean, an empty string) is `invalid_event`. A live
`attempt.submitted` with no prior `attempt.submitting` for that attempt is also
`invalid_event`: the submit key and request must be durable before any handle,
or a successor has nothing to reconcile under. Replaying a journal written
before these rules keeps its raw spelling, raw keys and request-less rows, so
it still rebuilds, and a live exact retry of one of its raw-keyed rows reads as
a replay (dec-spor-server-execution-attempt-index-canonical). The other event
families (`gate.*`, `stage.*`, `integration.*`, `rescue.*`, and the server's
`deploy.*`) still derive their keys from the raw attempt value; normalizing
those is a separate change, since it moves golden keys.

The work loop holds a submit whose acceptance is unknown in place. The
execution and the item's hold stand, nothing is marked failed, and the next
dispatch of the item re-sends the persisted request under the persisted key.
A provider that can name what it accepted under a key without being handed
the request again may offer an in-process `lookup(key)`. The `local` provider
does this from its run records. The worker consults `lookup` before
re-sending. An attempt the record places under a provider this box does not
run is reported as `blocked.orphaned` in `spor work --status`. It is never
dispatched here.

**Adoption.** A restarted worker re-claims the execution as a new instance
under an advanced fence. Before it acts on anything the record holds (adopting
a handle or re-sending a persisted submit), it makes a fenced write: a renew
of the execution lease under its own fence. Reading the record proves nothing
about ownership, because a fenced-out worker reads the same record. A renew
the store refuses (`fence_stale`, `lease_expired`) or cannot confirm (offline)
means nothing is adopted or re-sent and the attempt is held, so a stale fence
holder is refused at adoption, not at its next `attempt.observed`. If the record carries `attempt.submitted`, it
**adopts** the live attempt by that handle (observe, collect, release) instead
of submitting again. If it carries only the persisted key and request (the
previous instance died while holding), it reconciles exactly as above and then
adopts. Either way the environment keeps the identity it was submitted with:
the adopter re-sends the persisted request byte for byte (its own
`attempt_id` and fence under the persisted key is a different attempt, so
`idempotency_conflict`), and the manifest it collects names the submitting
instance's `attempt_id` and `fence`, not its own. The old fence's attempt
token is dead; the adopter mints one for its own fence and delivers it with
`deliver_credential` (§4.3), never a resubmit.

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
advertise them in `capabilities.lifecycle` (so does `deliver_credential`,
§4.3, which is advertised the same way). A worker never calls one that was
not advertised. If it does, the provider answers `unsupported_operation`. These
operations differ enough between platforms (Azure memory/disk suspend, E2B
pause, exe.dev none) that assuming them would be wrong somewhere. `restore`
creates a NEW environment from a checkpoint. It therefore takes its own
`idempotency_key` and returns a new handle. Expect replayed setup and expired
tokens in a restored environment: re-mint, never reuse.

## 11. Worked examples (prose; no vendor code ships in Spor)

**`local`** (`lib/shell/providers/local.js`) is the default, and it is
today's behaviour. `describe` reports `isolation: [worktree]` and the
machine's probed capability map (`tools` is a fixed `git node npm gh docker`
plus whatever the attempt asks for, filtered to what is on PATH, since PATH
cannot be enumerated; `secret_delivery` is empty, so an attempt carrying
`secrets[]` does not match it). `submit` takes the finished launch on a
provider-private `attempt.local` block (the harness adapter's argv is the
dispatcher's, not the provider's), creates the dispatch worktree and starts the
detached supervisor (`launchSupervisedHarness`); the handle's `id` is the run
id, and the key→handle table lives in memory until the worker persists handles
(task-spor-work-attempt-handle-adoption). `observe` reads the run record
(launching → `provisioning`, running → `running`, a closed record → `finished`
with the harness exit, a vanished one → `lost`, and a non-terminal record whose
supervisor is demonstrably gone → `lost`); `collect` answers the branch's HEAD
once it moved past the launch's base commit, PUSHED to the repo's `origin` (its
push URL when one is set) and read back before the manifest names it by the
fetch URL — the same honest publication `spor attempt run` makes (§13), so a
repo with no `origin`, or a push that does not land, has no manifest and says
why. The fetch URL is the CONFIGURED `remote.origin.url` (never this box's
`insteadOf` rewrite of it), its userinfo stripped; a URL that cannot be proven
credential-free is withheld, and with it the manifest. A push URL that differs
from the fetch URL is assumed to feed it (a push mirror): the read-back proves
the push landed, not that the fetch URL already serves it — plus the report and log as `file://` references; `cancel` is SIGTERM to the supervisor's process group (identity-
gated), `force` the TERM-then-KILL stop with the record closed as cancelled;
`release` stops anything still running and removes the worktree this submit
created. Secrets are not materialized, since the harness runs with the
operator's own environment. The extraction is byte-identical — same run
records, same journal paths, same prompt bytes — and
`test/dispatch-local-provider.test.js` holds the golden that says so.

**A container provider** (the first remote reference, decided before exe.dev).
`submit` runs a labelled container (`spor.execution=<id>`, `spor.fence=<n>`)
from an image carrying `spor` and the harness, mounts each resolved secret as
a file, applies the egress allowlist with a network policy or a proxy, and
starts `spor attempt run <bundle>` (§13). The label gives `submit` idempotency: an
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

## 12. The subprocess binding: JSON over stdio

The first binding lets anyone write a provider in any language without
touching spor: a program that reads one JSON request per line on stdin and
writes one JSON response per line on stdout. The worker half is
`lib/shell/providers/stdio.js` (`openStdioProvider`); the reference provider is
`examples/providers/stdio-echo/` (Node, zero dependencies), which passes the
whole conformance suite through the binding.

### 12.1 Declaring a provider

A provider is declared on the machine that runs it, exactly like a declared
harness (`dispatch.harness.<id>`), in the user `$SPOR_HOME/config.json` or the
global `$XDG_CONFIG_HOME/spor/config.json`:

```
{
  "dispatch": {
    "provider": {
      "stdio-echo": {
        "command": "node",
        "args": ["/opt/spor/examples/providers/stdio-echo/provider.js", "--root", "/var/tmp/stdio-echo"],
        "env": { "VAULT_ADDR": "https://vault.internal" },
        "inherit_env": ["HTTPS_PROXY", "NO_PROXY"],
        "timeout_ms": 30000
      }
    }
  }
}
```

| key | meaning |
|---|---|
| `command` | The program to run: an absolute path, or a bare name resolved on `PATH`. A relative path is refused. |
| `args` | Optional. Its arguments, verbatim. |
| `env` | Optional. String values added to the child's environment. It may not name a Spor credential (`SPOR_TOKEN`, `SPOR_*_KEY`, …). |
| `inherit_env` | Optional. Names of worker environment variables the child inherits beyond the base allowlist (§12.6). A name the worker does not have set is skipped. It may not name a Spor credential. |
| `timeout_ms` | Optional, default 30000. How long one request may go unanswered (§12.4). |

Any other key is refused, and so is the id `local` (the built-in provider).
The key is machine-local: a committed repo `.spor.json` that sets
`dispatch.provider` has it stripped with a warning, because a repo or graph
write must never choose what a machine executes. The id the declaration uses
must be the id the provider names itself in `hello` (§12.2).

`spor capabilities providers` lists each declared provider's describe() beside
`local`'s; a declaration that is malformed, or a provider that cannot answer,
is listed with its error. `spor provider check <id>` runs the conformance suite
against it (§12.5).

### 12.2 Lifetime, handshake and framing

**One process per binding instance.** Opening a binding spawns nothing. The
first request spawns the command and runs the handshake, and every later
request rides the same process until the binding is closed. A worker opens one
binding per pass and closes it at the end of the pass; a CLI verb opens one per
invocation. Closing ends the child's stdin, which is its cue to exit; after a
grace period it is killed. So a provider whose environments must outlive a
pass keeps what it needs to find them again somewhere other than its own
memory — the next pass is a new process.

**Handshake.** The binding's first line is `hello`; the provider answers with
the contract version it speaks and its own id:

```
→ {"contract_version":1,"id":"stdio-echo-1-1","op":"hello","params":{"contract_version":1}}
← {"id":"stdio-echo-1-1","ok":true,"result":{"contract_version":1,"provider_id":"stdio-echo"}}
```

Another `contract_version`, or a `hello` the provider refuses, ends the process
and answers the caller `contract_version_unsupported` with a message naming
both versions. A `provider_id` other than the declared id answers
`provider_mismatch`. No operation is sent until the handshake passes.

**Framing.** Each operation is one request line (`{contract_version, id, op,
params}`, the §2 envelope) and one response line (`{id, ok, result}` or `{id,
ok, error: {code, message, retryable}}`). A response may leave
`contract_version` off; the binding fills it in. Unknown fields are ignored at
every level. The binding mints its own request ids, so several requests may be
in flight and answered in any order. The provider's stderr is not part of the
protocol: each line is mirrored into the worker's log as `[provider <id>]
<line>`, REDACTED first — provider code is third-party and its diagnostics may
echo a credential — by the contract's fail-closed `redact` plus an exact mask
of every value the worker holds. An error response's `message` is redacted the
same way.

### 12.3 What the binding answers when the provider cannot

| code | when | retryable |
|---|---|---|
| `contract_version_unsupported` | `hello` answered another version, or refused ours. | no |
| `provider_mismatch` | `hello` named a provider id other than the declared one. | no |
| `provider_protocol_error` | A stdout line that is not JSON, not a response envelope, answers an id that was never sent, or runs past 1 MiB without a newline. The stream can no longer be trusted to line up, so the process is killed. | no |
| `provider_exited` | The process exited, or could not be started, with the request in flight. The next request spawns a new process. | yes |
| `provider_timeout` | The request went unanswered for `timeout_ms`. The process is killed. | yes |
| `secret_by_value` | The request carries a secret value (§12.6). Refused before anything is spawned or written. | no |
| `invalid_request` | The request fails the contract's validation. Refused before anything is spawned or written. | no |
| `unsatisfiable` | A submit whose secrets the provider's own `describe()` does not declare it resolves (`secret_schemes`) or delivers (`secret_delivery`) (§12.6). Refused before the submit is written. | no |

A submit (or restore) is the exception. If the process dies or hangs with one
in flight, whether the provider acted on it is unknown, so the binding does not
answer a refusal. It reports a lost reply (`LostReply`, carrying the code
above), and the worker holds and reconciles under the persisted key exactly as
§6 says.

### 12.4 Lost on crash

When the process exits unexpectedly, or is killed for a protocol error or a
hang, every handle this binding instance holds is **lost** with it: every
handle it submitted or was handed in a request, and has not released. From
then on the binding answers those handles itself and never asks the provider
again: `observe` reports `lost` (with a `detail` naming why), `cancel` answers
`lost`, `collect` answers a null manifest, and `release` succeeds. A respawned
process that forgot the environment therefore cannot move a terminal state
(§5). An exit is noticed at once; a hang after `timeout_ms`. A planned
`close()` is not a crash and loses nothing, so the next pass may adopt the
handles.

### 12.5 `spor provider check`

`spor provider check <id> [--json]` opens the binding, runs every conformance
scenario (`lib/shell/provider-conformance.js`) against a scratch home that it
then removes, and exits 0 only when every scenario passes. The capability
matcher is the real one (§3.1) — the suite's default, so the attempt it
derives carries a `profile`, `secret_delivery`, `lifecycle` and a repo pinned
to a full commit and branch. Graceful `cancel` is exercised whatever
`lifecycle` advertises, since `cancel` is a required operation (§3); only the
forced cancel is gated on `force-cancel`. A collected manifest must name the
attempt's identity and a `candidate.repo` the attempt asked for. The worker-side halves the
scenarios check (persist the key before the send, reconcile a held submit,
adopt across a restart) are the worker's own `submitAttempt`
(`lib/shell/provider-attempts.js`) over a real execution in a scratch local
execution store. A restart is a new store instance re-claiming the execution
under an advanced fence. Only the collected manifest is kept in a file beside
the store, because the execution record has no event for it yet. The driver it uses, `stdioDriver`, makes three
conventions a provider under check should honour:

- An attempt whose `prompt_bundle_ref` has a `/hold/` path segment keeps
  running until it is cancelled. The cancel scenarios and
  `credential-rotation` need one.
- Every repo in the attempt carries a `url`, so a provider offering `repos:
  ["*"]` matches.
- The crash scenario kills the provider **process**, so it checks the
  binding's lost-on-crash semantics (§12.4) for every provider.

`credential-rotation` runs when the provider advertises `deliver_credential`
(it is skipped, and reported, otherwise). Through the worker's own delivery
door and a stand-in for the server's token authority, it delivers the token,
restarts the worker under an advanced fence, adopts the handle with no
submit, delivers the new fence's token, and checks that the authority now
refuses the old one, that re-delivering the old one is `stale_credential`,
that a re-send of the new one is idempotent, and that an unknown handle is
`unknown_handle`. A driver that can read the environment's token
(`credential(handle)`, the in-process fixtures do) also checks the
environment holds the right one after each step.

### 12.6 Secrets never cross stdio by value

The attempt names its secrets by reference (`secrets[].ref`) and its Spor
credential as `spor.token_ref` (§4.2, §4.3). The provider resolves each
reference in its own vault, and its `secret_delivery` capability says how the
value reaches the sandbox. The binding checks every request before it is
written, and before a process is spawned for it. It answers
`secret_by_value` when it finds any of these:

- a secret entry or `spor` block carrying a value, or a `ref` that is not a
  reference (the §4.2 validator);
- a credential-shaped string anywhere in the line (a GitHub, GitLab, Slack,
  `sk-` API key or AWS key shape, or a Spor `spor_att_`/`spor_pat_`/`spor_oat_`/
  `sub_pat_` token);
- a value the worker itself holds: its Spor credentials from the environment
  and the token the config cascade resolved.

The refusal names the field, never the value.

**The one exemption** is `deliver_credential`'s `params.credential.value`
(§4.3): that field, and only it, is left out of the scan, because it is the
attempt token being delivered. It is held to the attempt-token shape instead,
and it is still refused when it is a credential the worker itself holds — the
exception admits the token minted for the attempt, never the worker's own. A
delivered value that the provider later writes to stderr is masked in the
worker's log. The request around it is closed (§2): `params` carries exactly
`{handle, credential}`, so no unscanned sibling can ride beside the exempt
field.

**A submit is re-matched inside the binding.** The worker matches an attempt
against `describe()` before it submits (§3.1), but a direct caller or a
replayed submit never passes through that door. So, before the first submit
a provider process receives, the binding asks that process to describe itself
(once per process), and on every submit it re-runs the matcher and refuses as
`unsatisfiable` an attempt whose secret references use a scheme outside
`secret_schemes`, or whose secrets the provider has no `secret_delivery` mode
for. Only the secret axes refuse here, because they decide which references
cross stdio. Every other axis is the provider's own `unsatisfiable` to answer,
and a reconcile re-send under a persisted key (§6) must still reach it. A
describe that fails is answered as that failure, and the submit is never sent,
so it is never a lost reply.

The child's environment is an **allowlist**, not the worker's environment with
credentials scrubbed out. A worker's environment routinely holds
`GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AWS_*` and whatever
else its operator exported, and a scrub list only removes what it names. The
child gets, in order:

1. the base allowlist from the worker's environment: `PATH`, `HOME`, `LANG`,
   every `LC_*`, `TZ`, `TMPDIR` (on Windows also `SYSTEMROOT`, `WINDIR`,
   `COMSPEC`, `PATHEXT`, `TEMP`, `TMP`, `USERPROFILE`, matched
   case-insensitively, because a Windows process cannot reliably start
   without them);
2. every name the declaration lists in `inherit_env`, when the worker has it
   set;
3. the declaration's `env`, which wins over both.

Nothing else is inherited. A Spor credential is never in the result, whatever
asked for it. A provider that needs a cloud credential names it in
`inherit_env`. Better, it resolves the credential itself from its own vault, so
the worker's copy never reaches it. The built-in `local` provider (§11) spawns
no provider process and is unchanged.

## 13. The attempt bundle and `spor attempt run`

A provider that runs an attempt somewhere other than the worker's own box ships
the attempt in as a **bundle** and runs it there with `spor attempt run`. The
runner reuses the harness adapters unchanged: the same registry, the same
machine-declared `dispatch.harness.<id>` bindings, the same supervisor, run
record, log and report a local dispatch makes. Only the environment differs.

### 13.1 The bundle

A bundle is a directory, or the same tree as a POSIX ustar archive (`.tar`):

| file | holds |
|---|---|
| `attempt.json` | The attempt spec (§4). It must validate against the `attempt-spec` schema. |
| `prompt/prompt.md` | The exact prompt the harness receives on stdin (WORKERS.md §4). |
| `prompt/session.md`, `briefing.md`, `task.md` | The parts it was assembled from, when known. These are descriptive; the runner reads only `prompt.md`. |
| `repos.json` | `{"bundle_format": 1, "repos": [{slug, commit, branch, url?}]}`, the pinned checkouts. These must agree with `attempt.repos` exactly. |
| `env.json` | Optional, non-secret settings: `{"env": {NAME: value}, "harness": {permission_mode?, sandbox?, approval_policy?, read_only?}}`. |

An attempt whose prompt rides inside the bundle names it with
`prompt_bundle_ref: "spor-bundle://prompt/"`.

**Secrets never ride a bundle.** The attempt names its secrets by reference
(§4.2) and its Spor credential as `spor.token_ref` (§4.3). The provider
delivers secret values through its declared `secret_delivery` channel. The
attempt-scoped Spor token arrives through `deliver_credential` (§4.3) as a
file: the runner reads the file `SPOR_TOKEN_FILE` names FIRST, and only with
no `SPOR_TOKEN_FILE` set falls back to `SPOR_DISPATCH_CHILD_TOKEN` or
`SPOR_TOKEN` in its environment. It hands the token to the harness. The
worker mints the token only after the submit returned a handle, so the runner
may start first: an attempt bound to a server waits (up to 120 seconds) for
the file to appear, and refuses before launch if it never does, if it holds
anything but an attempt token (`spor_att_…`), or if it is not a regular file
private to its owner (any group or other permission bit set — create it `0600`
atomically, temp file plus `rename`, as §4.3 says; Windows, which has no POSIX
mode bits, is not checked). A bundle
is refused, by `build` before it is written and by `run` before anything is
checked out, when it carries any of these:

- a secret entry or `spor` block with a value;
- a credential-shaped string in any file, the prompt included;
- an `env.json` name that reads as a credential (`*_TOKEN`, `*_SECRET`, `*_API_KEY`, …);
- a value the process itself holds as a Spor credential.

The refusal names the file and field. It never echoes the value.

### 13.2 `spor attempt build <execution-id> --out <dir|file.tar>`

This runs on the worker side. It derives the bundle and never asks anyone to
write it by hand:

- **Identity.** From the execution record: `execution_id`, the owner's fence,
  the owning instance as `attempt_id`, the tenant and the item. An execution
  with no live owner is refused.
- **What runs.** From the dispatch plan for the item, which is the same
  read-only plan `spor dispatch --print` resolves, read through the
  dispatcher's `attemptInputs(cfg, plan)` and derived by the same
  `deriveAttemptSpec` a dispatch uses (§4.4): the harness, the model, the
  profile and its runtime needs, the compiled briefing, and the factory's
  worker contract as the task. The deadline is `--deadline`, else the
  factory's implementation budget, else `work.runMaxMs`. The attempt is unattended, so a harness posture
  that would stop at its first write is refused, as it is for a worker's
  dispatch. Pass the posture, for example `--permission-mode
  bypassPermissions` for Claude Code. `run` checks the same rule again.
- **The pin.** The mapped checkout's commit (`--ref`, default `HEAD`) and its
  portable `origin` URL, stripped of any credentials it carries. The attempt
  commits to `--branch`. The default is `spor/<node-id>-<exec>-f<fence>`, one
  branch per attempt, so a re-attempt never collides with an earlier attempt's
  published candidate.
- **The graph.** `spor.server` is the server, or, for a local-mode attempt, the
  graph's `nodes/` directory as a `file://` reference.

**One repo per attempt (a v1 limitation).** The derivation pins exactly one
repo, the item's own checkout, so `attempt.repos` has one entry, the runner
launches the harness in that checkout, and the manifest holds one candidate
(§7: `candidate` is a single object). The schema already admits several
`repos`, and `spor attempt run` checks every one of them out, but the harness
runs in the first and only the first repo's candidate is collected. A
cross-repo attempt is therefore not expressible yet. Supporting it means a
manifest with one candidate per repo, which is a contract revision rather than
a field added to v1.

### 13.3 `spor attempt run <bundle>`

This runs on the sandbox side. In order:

1. It verifies the bundle (§13.1).
2. It clones every repo from its `url` into `--workdir/<slug>` and checks it
   out at the pinned commit on the attempt's branch. `--repo <slug>=<path|url>`
   clones from a mirror instead. A repo that cannot be checked out at its pin
   fails **before launch**, naming the repo and the reason.
3. It resolves the harness adapter by `harness.id` and builds its argv with the
   bundle's harness settings. The settings are validated, translated and
   defaulted exactly as `spor dispatch` does it. The attempt's `mcp` axis
   decides the MCP config: when it names `spor` and the attempt token is
   present, the runner writes the same Spor MCP config `spor dispatch` writes
   (`lib/shell/mcp-config.js`). Any other name on the axis is provided by the
   environment, which the provider's `reachable_mcp` already promised.
4. It launches the harness under the supervisor and relays the run as status
   lines on stdout.

Each status line is an observe-result (§5) with `kind`, `at` and `run_id`
added. Unknown fields are ignored, so every line validates:

```json provider-contract=observe-result
{
  "kind": "status",
  "state": "running",
  "since": "2026-10-09T10:04:11Z",
  "at": "2026-10-09T10:04:12Z",
  "run_id": "3f0c2a9e-6d1b-4c55-9a3e-2b7d8e1f4a60"
}
```

The states run `pending` (bundle verified) → `provisioning` (checkouts, then
the supervisor starting) → `running` → `stopping` (the harness exited or was
told to stop, and the candidate is being collected) → `finished`, with the
harness exit. A refusal before launch is a single `failed`. A SIGTERM to the
runner, or the attempt's `deadline` passing, stops the harness through the
supervisor and then collects what is there.

At exit the runner **publishes the candidate honestly**. It pushes the
checkout's HEAD, if it moved past the pin, to `refs/heads/<branch>` at the
repo's `url`, never forced, and reads the ref back. Only then does a manifest
name it (§7). It writes the collect-result to `--out/manifest.json` beside
`status.jsonl`, `report.md` and `harness.jsonl`, and prints it as the last
stdout line, `{"kind": "result", …collect-result}`. The exit code mirrors the
manifest: `0` means a manifest; `1` means no candidate (the attempt produced
nothing, or it could not be published); `2` means the attempt was refused
before launch. `--out` must be absent or empty, because a result directory
belongs to one run. The token-bearing MCP config a Claude Code harness reads
is written to a private temporary directory, never into `--out`, and is
removed when the run settles. Refusals and status details pass the contract's
`redact`, which FAILS CLOSED: any `<scheme>:…@` span is masked up to its last
`@`, whitespace and quotes included (`https://u:p w@host`), as are a URL's query
and fragment and every credential-shaped string (Spor's token prefixes
included).

The `local` provider (§11) uses the same path in-process. It wraps the launch
a dispatch built as an in-memory bundle, launches it through the same door, and
reads and collects through the same functions. So an attempt behaves the same
whether it runs on the worker's box or in a provider's sandbox.


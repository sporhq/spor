# shim worker

The **bootstrap worker** for workflow runs (the claim/complete API, API.md
§3.1). A small,
standalone, zero-dependency Node program — *not* a server feature. The
Spor server never executes effects (no shell, no outbound HTTP from the
run engine); execution lives out here in a separate process.

The shim polls the claim API for steps whose `capability` it serves, claims
them, runs them by spawning a **mapped argv** (`child_process.execFile` — an
argv array, never a shell string), and reports the verdict back through
`complete`. It exists so the run loop is validated against real effects on day
one and is **deleted, not migrated** once purpose-built workers (CI jobs,
deploy daemons, a VM worker) replace it.

## Run

```sh
node shim.js config.json          # or: SHIM_CONFIG=config.json node shim.js
```

`SIGINT`/`SIGTERM` drains cleanly: polling stops, an in-flight step is allowed
to finish its complete attempt, then the process exits.

## Config

```json
{
  "server":  "http://127.0.0.1:8787",
  "token":   "spor_pat_…",
  "poll_ms": 500,
  "capabilities": {
    "ci":      { "argv": ["/bin/echo", "{\"ok\":true}"] },
    "deploy":  { "argv": ["swamp", "model", "release", "method", "run"], "timeout_ms": 600000 },
    "metrics": { "argv": ["node", "-e", "process.stdout.write(JSON.stringify({error_rate:0}))"] }
  }
}
```

- **`server`**, **`token`** — base URL and bearer token (a worker is anything
  with a token; credentials live in the worker, never in the graph).
- **`poll_ms`** — `GET /v1/work` interval (default 1000).
- **`capabilities`** — the `capability → argv` map. **This map is the only place
  the worker vocabulary lives.** Workflow nodes name a `capability` label
  (`ci`, `deploy`, …); the graph never learns what command serves it. Optional
  per-capability `timeout_ms` bounds execution (default 15 min, matching the
  lease default).

### The execution contract a mapped command sees

- **stdin**: the step's interpolated `inputs` as a single JSON object.
- **env `SPOR_STEP`**: the full work item (`run_id`, `step`, `capability`,
  `kind`, `inputs`) as JSON, for wrappers that need run context.
- **exit 0**: stdout is parsed as a JSON object and becomes the step `result`
  (lands on the run node). Non-JSON stdout falls back to `{ "output": "<raw>" }`.
- **exit ≠ 0** (or spawn failure or timeout): the step is completed **failed**
  with a typed `result` (`{ error: "nonzero_exit" | "timeout", code }`).
- **log tail** (both outcomes): a tail of stderr (plus a little stdout context)
  rides the complete's `log` field into the run-keyed **journal**, never onto
  the run node — step logs do not land on the run node (API.md §3.1); only
  the small `result` does.

### Lease / at-least-once

A claim is a lease with a TTL. If a step overruns its lease the server may have
already returned it to `ready`; the shim still attempts `complete`, and a
`409 lease_expired` is a **logged no-op**. Spor promises at-least-once
*dispatch*, not exactly-once *execution* — mapped commands must guard their own
side effects (idempotent deploys, etc.).

## swamp production mapping (illustrative example)

This section is an **illustrative example** of the capability→argv contract,
not a required setup: one concrete way to wire the shim is to point it at the
**unmodified `swamp` CLI**:

```json
{
  "server": "https://spor.internal",
  "token":  "spor_pat_…",
  "capabilities": {
    "deploy": { "argv": ["swamp", "model", "release-pipeline", "method", "run", "execute"], "timeout_ms": 1800000 },
    "ci":     { "argv": ["swamp", "model", "ci", "method", "run"] }
  }
}
```

**License posture (deliberate, must stay so).** The shim invokes the stock
`swamp` CLI as an **arm's-length subprocess** — it does **not** import
`libswamp` (linking it would pull the shim under AGPL). swamp definitions
authored for these commands are covered by swamp's definition exception, and
the shim claims *our* steps rather than re-exposing swamp's API through ours,
keeping clear of the exception's anti-substitution clause. The
`capability → swamp-definition` mapping lives **here, in this config file —
never in a workflow node**, so the graph stays swamp-ignorant and the swap to
purpose-built workers touches zero graph data and zero schemas.

> **Note:** `swamp` is **not installed in this environment**. The integration
> test and the example configs above use stub commands (`/bin/echo`,
> `node -e …` emitting JSON) to validate the claim → execute → complete loop;
> the swamp argv is the production substitution, dropped in unchanged.

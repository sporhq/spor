"use strict";
// A synthetic in-process execution provider (task-spor-execution-provider-
// conformance-suite): the reference the conformance suite is proven against.
// No environment is real — an "environment" is a record in a Map that steps
// one state per observe — so the suite runs deterministically with no clock,
// no process and no disk of its own.
//
// Behaviour is read off the attempt's prompt_bundle_ref path (the driver
// writes it): `/hold/` keeps the environment running until it is cancelled,
// anything else runs to `finished` with a candidate. The handle carries a
// provider-private `slot` the provider checks on every call, so a worker that
// does not hand the handle back verbatim is caught.
//
// `brokenIdempotency: true` is the deliberately broken fixture: every submit
// creates a new environment, key or no key. `manifestRepo` overrides the
// repo a collected manifest names (a provider naming a repo the attempt never
// asked for, which the suite must refuse). `brokenCredential: "accept-stale"`
// takes a delivery under an older fence than one already delivered (an
// environment moved back to a dead token), which the suite must refuse.
// `credentials: false` advertises no deliver_credential.

const crypto = require("node:crypto");
const { bindInProcess, ProviderError } = require("../../../lib/shell/provider-conformance");
const pc = require("../../../lib/kernel/provider-contract");

const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");

// The candidate a "complete" attempt produces — a pure function of the
// attempt, so the driver can predict it.
function candidateFor(attempt) {
  const id = `${attempt.execution_id}\u0000${attempt.fence}\u0000${attempt.attempt_id}`;
  return { commit: sha1(`commit\u0000${id}`), tree: sha1(`tree\u0000${id}`) };
}

function createSyntheticImpl({ providerId = "synthetic", brokenIdempotency = false, brokenCredential = null, credentials = true, manifestRepo = null, capabilities = {}, now = () => new Date().toISOString() } = {}) {
  const envs = new Map(); // id -> env
  const byKey = new Map(); // idempotency key -> id
  let next = 0;

  const caps = {
    harnesses: ["claude-code", "codex"],
    reachable_mcp: ["spor"],
    skills: [],
    plugins: [],
    tools: ["git", "node"],
    // Any repo the attempt gives a url for (the conformance base attempt then
    // carries one, so the real matcher admits it).
    repos: ["*"],
    egress: [],
    isolation: ["container"],
    secret_delivery: ["file"],
    secret_schemes: ["vault"],
    lifecycle: ["cancel", "force-cancel", ...(credentials ? ["deliver_credential"] : [])],
    max_deadline_ms: 4 * 60 * 60 * 1000,
    ...capabilities,
  };

  function find(handle) {
    const env = envs.get(handle.id);
    if (!env || handle.provider !== providerId || handle.slot !== env.slot) {
      throw new ProviderError("unknown_handle", `no environment ${JSON.stringify(handle)}`);
    }
    if (env.released) throw new ProviderError("unknown_handle", `environment ${handle.id} was released`);
    return env;
  }
  function move(env, state, exit) {
    env.state = state;
    env.since = now();
    if (exit) env.exit = exit;
  }
  function view(env) {
    return { state: env.state, since: env.since, ...(env.exit ? { exit: env.exit } : {}), ...(env.detail ? { detail: env.detail } : {}) };
  }

  return {
    describe() {
      return { provider_id: providerId, contract_version: pc.CONTRACT_VERSION, capabilities: caps };
    },
    submit({ attempt, idempotency_key: key }) {
      if (!caps.isolation.includes(attempt.isolation)) {
        throw new ProviderError("unsatisfiable", `isolation '${attempt.isolation}' is not offered; this provider offers: ${caps.isolation.join(", ")}`);
      }
      const canon = JSON.stringify(attempt);
      if (!brokenIdempotency && byKey.has(key)) {
        const env = envs.get(byKey.get(key));
        if (env.canon !== canon) throw new ProviderError("idempotency_conflict", `key ${key} was accepted for a different attempt`);
        return { handle: env.handle, accepted_at: env.accepted_at, existing: true };
      }
      const slot = ++next;
      const id = `syn-${slot}`;
      const env = {
        handle: { provider: providerId, id, slot },
        slot,
        canon,
        attempt,
        hold: /\/hold\//.test(attempt.prompt_bundle_ref),
        accepted_at: now(),
        released: false,
      };
      move(env, "pending");
      envs.set(id, env);
      byKey.set(key, id);
      return { handle: env.handle, accepted_at: env.accepted_at, existing: false, env: { slot } };
    },
    observe({ handle }) {
      const env = find(handle);
      if (env.crashed) {
        if (env.state !== "lost") {
          move(env, "lost");
          env.detail = "host gone";
        }
      } else if (env.state === "pending") move(env, "provisioning");
      else if (env.state === "provisioning") move(env, "running");
      else if (env.state === "running" && !env.hold) {
        env.produced = true;
        move(env, "finished", { code: 0 });
      } else if (env.state === "stopping") move(env, "finished", { code: 143, signal: "SIGTERM" });
      return view(env);
    },
    collect({ handle }) {
      const env = find(handle);
      if (env.produced) {
        const c = candidateFor(env.attempt);
        const repo = env.attempt.repos[0];
        return {
          manifest: {
            attempt_id: env.attempt.attempt_id,
            execution_id: env.attempt.execution_id,
            fence: env.attempt.fence,
            candidate: {
              repo: manifestRepo || repo.slug,
              commit: c.commit,
              tree: c.tree,
              branch: repo.branch,
              reference: { kind: "branch", locator: `https://synthetic.spor.invalid/${repo.slug}.git`, ref: `refs/heads/${repo.branch}`, commit: c.commit },
            },
          },
        };
      }
      return { manifest: null, no_candidate: { reason: `no candidate yet (environment ${env.state})` } };
    },
    cancel({ handle, force }) {
      const env = find(handle);
      if (pc.TERMINAL_OBSERVE_STATES.includes(env.state)) return { state: env.state };
      if (force) move(env, "finished", { signal: "SIGKILL" });
      else move(env, "stopping");
      return { state: env.state };
    },
    release({ handle }) {
      const env = envs.get(handle.id);
      if (!env || handle.provider !== providerId || handle.slot !== env.slot) throw new ProviderError("unknown_handle", `no environment ${handle.id}`);
      env.released = true;
      return { released: true };
    },
    // The attempt token lands in the environment (here: on its record — a
    // real provider writes the file SPOR_TOKEN_FILE names). Keyed on the
    // fence: an older fence than the one held is stale.
    ...(credentials
      ? {
          deliver_credential({ handle, credential }) {
            const env = find(handle);
            if (env.credential && credential.fence < env.credential.fence && brokenCredential !== "accept-stale") {
              throw new ProviderError("stale_credential", `environment ${handle.id} already holds the token for fence ${env.credential.fence}`);
            }
            env.credential = { fence: credential.fence, value: credential.value };
            return { delivered: true };
          },
        }
      : {}),
    // Test-only controls, outside the contract.
    fixture: {
      credential(handle) {
        const env = envs.get(handle.id);
        return env && env.credential ? env.credential.value : null;
      },
      crash(handle) {
        const env = envs.get(handle.id);
        if (env) env.crashed = true;
      },
      environments() {
        return [...envs.values()].filter((e) => !e.released).length;
      },
    },
  };
}

// The driver the conformance runner reads beside the provider.
function syntheticDriver(fixture) {
  return {
    attempt(base, behavior) {
      return { ...base, prompt_bundle_ref: `https://synthetic.spor.invalid/${behavior}/${base.execution_id}/prompt.tar` };
    },
    candidate: candidateFor,
    crash: (handle) => fixture.crash(handle),
    environments: () => fixture.environments(),
    ...(fixture.credential ? { credential: (handle) => fixture.credential(handle) } : {}),
  };
}

// { provider, driver } for the in-process synthetic provider.
function createSyntheticProvider(opts = {}) {
  const impl = createSyntheticImpl(opts);
  return { provider: bindInProcess(impl), driver: syntheticDriver(impl.fixture), impl };
}

module.exports = { createSyntheticImpl, createSyntheticProvider, syntheticDriver, candidateFor };

"use strict";
// providers/index.js — the execution-provider registry and the ONE resolution
// rule for which provider a dispatch runs under
// (task-spor-work-local-provider-refactor, PROVIDERS.md).
//
//   --provider <id>  >  dispatch.provider.default  >  local
//
// `dispatch.provider` is one machine-local map (lib/config-keys.js): its
// `default` names the provider every dispatch runs under when no flag does,
// and every other key is a declared provider BINDING by id
// (`dispatch.provider.<id>`, the subprocess stdio binding of
// task-spor-execution-provider-stdio-binding — not shipped yet, so today the
// only provider that resolves is `local`). An id that resolves to nothing is a
// REFUSAL naming it — never a silent fall-through to local, which would run
// an attempt somewhere other than where the operator asked (the substitution
// rule, dec-spor-machine-profile-satisfiability, applied to WHERE instead of
// WHAT).

const local = require("./local.js");

const DEFAULT_PROVIDER = local.PROVIDER_ID;

// The provider ids a dispatch may name on this machine: the built-in `local`
// plus whatever `dispatch.provider.<id>` declares (reserved for the stdio
// binding; a declared id resolves to a refusal until a binding ships).
function providerMap(cfg) {
  const raw = cfg.get("dispatch.provider", {});
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function knownProviderIds(cfg) {
  return [DEFAULT_PROVIDER];
}

// {id, source} — which provider id applies and where it came from (`--provider`,
// `dispatch.provider.default`, or `default`). Pure: a bad id is reported by
// `providerRefusal`, not thrown here.
function resolveProviderId(cfg, explicit = null) {
  // Any flag value is the flag's choice — `--provider ""` (an unset shell
  // variable, quoted) names nothing and is refused as such, never read as
  // "unset" and quietly routed to the configured default.
  if (explicit != null) return { id: String(explicit).trim(), source: "--provider" };
  const configured = providerMap(cfg).default;
  if (configured != null && String(configured).trim() !== "") return { id: String(configured).trim(), source: "dispatch.provider.default" };
  return { id: DEFAULT_PROVIDER, source: "default" };
}

// The refusal text for an id this machine cannot run under, or null when it
// resolves. One sentence, naming the id, its source, and what IS available.
function providerRefusal(cfg, resolved) {
  const { id, source } = resolved;
  if (knownProviderIds(cfg).includes(id)) return null;
  const declared = Object.keys(providerMap(cfg)).filter((k) => k !== "default");
  const binding = declared.includes(id)
    ? ` (dispatch.provider.${id} is declared, but provider bindings are not shipped yet — task-spor-execution-provider-stdio-binding)`
    : "";
  const what = id === "" ? "an empty execution provider id" : `unknown execution provider '${id}'`;
  return `${what} (from ${source})${binding} — the providers this machine can run under: ${knownProviderIds(cfg).join(", ")}`;
}

// Instantiate a resolved provider over the CLI host. Throws for an id
// `providerRefusal` would have refused — callers resolve-and-refuse first.
function createProvider(id, { cfg, host }) {
  if (id === local.PROVIDER_ID) return local.createLocalProvider({ cfg, host });
  throw new Error(`createProvider: no binding for execution provider '${id}'`);
}

module.exports = { DEFAULT_PROVIDER, knownProviderIds, resolveProviderId, providerRefusal, createProvider };

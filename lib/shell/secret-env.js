"use strict";
// shell/secret-env.js — the ONE list of environment variables that carry a
// Spor credential (the attestation signing key, every graph bearer / refresh /
// admin token, in both the SPOR_ and legacy SUBSTRATE_ spellings), and the
// scrub that drops them from an environment a less-trusted process inherits.
// The gate runner's suites and judge-side git calls (lib/shell/gate-runner.js,
// which re-exports these) and the stdio provider binding's child environment
// (lib/shell/providers/stdio.js) read the same list, so a credential scrubbed
// from one door cannot arrive by the other.

const SECRET_ENV_RE = /^(SPOR|SUBSTRATE)_(.*_)?(TOKEN|KEY|SECRET|PASSWORD|CREDENTIALS?)$/i;
const SECRET_ENV_NAMES = new Set(["SPOR_ATTESTATION_KEY", "SPOR_TOKEN", "SUBSTRATE_TOKEN", "SPOR_REFRESH_TOKEN", "SPOR_ADMIN_TOKEN"]);
function isSecretEnvName(name) {
  return SECRET_ENV_NAMES.has(name) || SECRET_ENV_RE.test(name);
}
function scrubSecretEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) if (!isSecretEnvName(k)) out[k] = v;
  return out;
}

module.exports = { SECRET_ENV_RE, SECRET_ENV_NAMES, isSecretEnvName, scrubSecretEnv };

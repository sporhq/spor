"use strict";
// The ONE hermetic environment for a spawned spor CLI / hook engine
// (task-spor-client-config-typed-key-table-and-explain,
// issue-spor-scratch-home-does-not-force-local-mode).
//
// Scrubbing SPOR_*/SUBSTRATE_* and pointing SPOR_HOME at a scratch dir is not
// enough on its own: the cascade also reads $XDG_CONFIG_HOME/spor/config.json,
// and a scratch home was once observed resolving REMOTE and writing a junk node
// to the live hosted tenant. So this helper also isolates XDG_CONFIG_HOME and
// pins SPOR_MODE=local — unless the caller states remote intent by passing
// SPOR_SERVER, SPOR_ORG or its own SPOR_MODE (`SPOR_MODE: "auto"` restores
// server-from-config resolution for a test that configures a server in a
// scratch config file). A key passed as `undefined` is deleted.
function hermeticEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("SPOR_") || k.startsWith("SUBSTRATE_") || k === "XDG_CONFIG_HOME") continue;
    env[k] = v;
  }
  const remoteIntent = ["SPOR_SERVER", "SPOR_ORG", "SPOR_MODE"].some((k) => extra[k] !== undefined);
  if (!remoteIntent) env.SPOR_MODE = "local";
  Object.assign(env, extra);
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
}

module.exports = { hermeticEnv };

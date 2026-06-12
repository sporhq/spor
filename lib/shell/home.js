"use strict";
// home.js — Spor graph-home and env resolution (SPLIT.md rename surface).
//
// User-facing env vars renamed SUBSTRATE_* -> SPOR_* with an indefinite
// dual-read window (dec-cc-spor-rename-compat-dual-read): SPOR_X wins, the
// old SUBSTRATE_X keeps working. The default graph home is ~/.spor; when it
// is absent and the legacy ~/.substrate exists, the legacy directory is used
// (D3: dual-accept, no forced migration).

const fs = require("fs");
const os = require("os");
const path = require("path");

// $SPOR_<name>, else $SUBSTRATE_<name>. Empty string counts as unset, like
// the bash ${SPOR_X:-${SUBSTRATE_X:-}} form the engines replaced.
function envDual(name, env = process.env) {
  const v = env[`SPOR_${name}`];
  if (v != null && v !== "") return v;
  const legacy = env[`SUBSTRATE_${name}`];
  if (legacy != null && legacy !== "") return legacy;
  return undefined;
}

function graphHome(env = process.env) {
  const explicit = envDual("HOME", env);
  if (explicit) return explicit;
  const spor = path.join(os.homedir(), ".spor");
  if (fs.existsSync(spor)) return spor;
  const legacy = path.join(os.homedir(), ".substrate");
  if (fs.existsSync(legacy)) return legacy;
  return spor;
}

module.exports = { envDual, graphHome };

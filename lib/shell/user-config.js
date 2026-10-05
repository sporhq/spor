// shell/user-config.js — the ONE writer of the USER config ($SPOR_HOME/config.json).
// Every client-side edit of that machine-local file (server/token, dispatch.repos,
// dispatch.capabilities, dispatch.agent) goes through editUserConfig, so each is
// read-modify-write, ATOMIC (temp file + rename — a concurrent reader or a crash
// never sees a torn file) and MODE-PRESERVING (an existing file keeps its
// permission bits; a new one is created 0600, since the legacy flat shape can
// hold a bearer token; an existing file that ends up holding a SECRET key — a
// legacy flat `token` — is tightened to owner-only, never left world-readable).
// Plain Node, zero deps.
"use strict";

const fs = require("fs");
const path = require("path");
const { writeFileAtomic, symlinkTarget } = require("./atomic-write.js");
const { KEYS } = require("../config-keys.js");

const NEW_FILE_MODE = 0o600;
const SECRET_PATHS = KEYS.filter((k) => k.secret).map((k) => k.key.split("."));

// Does the config about to be written carry a non-empty secret value?
function holdsSecret(data) {
  return SECRET_PATHS.some((parts) => {
    let v = data;
    for (const p of parts) v = v && typeof v === "object" ? v[p] : undefined;
    return v != null && v !== "";
  });
}

function userConfigPath(home) {
  return path.join(home, "config.json");
}

// Read-modify-write the user config. `mutate(data)` edits the parsed object in
// place and returns false to say "unchanged — skip the write". Preserves every
// key the mutator doesn't touch. A symlinked config (dangling included) is
// written THROUGH the link. A config holding a secret is written owner-only
// (group/other bits dropped from the kept mode). Returns { file, wrote, malformed }: a
// present-but-malformed config is NEVER overwritten (malformed: true, nothing
// written), so a syntax error never costs the user their settings. A non-object
// JSON root is treated as empty (as the prior writers did). IO failures throw —
// fail-open callers wrap the call.
function editUserConfig(home, mutate) {
  let file = userConfigPath(home);
  let raw = null;
  let mode = NEW_FILE_MODE;
  file = symlinkTarget(file); // a symlinked config (dotfiles repo) keeps its link: the rename lands on the target
  try {
    raw = fs.readFileSync(file, "utf8");
    mode = fs.statSync(file).mode & 0o777;
  } catch (e) {
    if (e.code !== "ENOENT") throw e; // present but unreadable — never treat as empty and overwrite
  }
  let data = {};
  if (raw != null) {
    try {
      data = JSON.parse(raw);
    } catch {
      return { file, wrote: false, malformed: true };
    }
    if (data == null || typeof data !== "object" || Array.isArray(data)) data = {};
  }
  const kept = mode;
  const unchanged = mutate(data) === false;
  if (holdsSecret(data)) mode &= 0o700;
  if (unchanged) {
    // No edit to make, but a secret-bearing file left group/other-readable is
    // still tightened in place (best-effort: a no-op edit never throws).
    if (raw != null && mode !== kept) {
      try {
        fs.chmodSync(file, mode);
      } catch {
        /* platform without POSIX perms */
      }
    }
    return { file, wrote: false, malformed: false };
  }
  writeFileAtomic(file, JSON.stringify(data, null, 2) + "\n", { mkdir: true, mode });
  return { file, wrote: true, malformed: false };
}

module.exports = { editUserConfig, userConfigPath };

"use strict";
// shell/asset-export.js — the asset half of `spor export --assets`
// (task-split-spor-e0dad1d2959b, the client half of
// task-spor-chatgpt-asset-backup-restore). The server's asset-inclusive export
// (`GET /v1/export?assets=1`, spor-server server/asset-backup.ts, spec
// docs/ASSET-STORAGE.md §13) appends to the node tarball:
//
//   assets/sha256/<2-hex>/<hex>   one entry per inventoried object, re-hashed
//                                 before it is written
//   assets/manifest.json          LAST: {format: "spor-assets/1", generated_at,
//                                 head, tenant, inventory, objects[], missing[],
//                                 corrupt[], unreadable[]}
//
// This module is both sides of that layout for the CLI:
//   - local mode BUILDS it from $SPOR_HOME/assets/ (the same LocalAssetStore
//     layout `spor asset import` writes), over the same inventory the server
//     keys on: every digest an `asset_digest:` frontmatter line names in the
//     working tree OR any committed revision of nodes/ — so an extracted local
//     export restores through the same `spor-assets restore` tool;
//   - remote mode READS it back out of the downloaded archive: the manifest is
//     the last entry, so an archive without one is a transfer that did not
//     finish, never a smaller backup.
// Zero-dep: fs + crypto + the git binary.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { splitDocument } = require("../kernel/frontmatter.js");
const { gitSpawn } = require("./git-exec.js");
const { objectPath } = require("./asset.js");

const ASSET_EXPORT_FORMAT = "spor-assets/1";
const MANIFEST_NAME = "assets/manifest.json";
// One frontmatter line naming a descriptor's bytes — the server's DIGEST_LINE,
// anchored at line start so a body that merely MENTIONS a digest is not a
// reference. Applied to a diff line's payload too (the history inventory).
const DIGEST_LINE = /^asset_digest:[ \t]*["']?(sha256:[0-9a-f]{64})["']?[ \t]*$/;
const HISTORY_MAX_BYTES = 256 * 1024 * 1024;
const HISTORY_TIMEOUT_MS = 120000;

function idOf(file) {
  const base = path.basename(file);
  return base.endsWith(".md") ? base.slice(0, -3) : null;
}

function add(inv, digest, id, current) {
  let e = inv.get(digest);
  if (!e) {
    e = { digest, descriptors: [], current: false };
    inv.set(digest, e);
  }
  if (id && !e.descriptors.includes(id)) e.descriptors.push(id);
  if (current) e.current = true;
}

// Digests the WORKING TREE's descriptors name (frontmatter only).
function currentInventory(nodesDir, inv = new Map()) {
  let names = [];
  try {
    names = fs.readdirSync(nodesDir).filter((n) => n.endsWith(".md"));
  } catch {
    return inv;
  }
  for (const name of names) {
    let text;
    try {
      text = fs.readFileSync(path.join(nodesDir, name), "utf8");
    } catch {
      continue;
    }
    const doc = splitDocument(text);
    if (!doc) continue;
    for (const line of doc.frontmatter.split("\n")) {
      const m = DIGEST_LINE.exec(line);
      if (m) add(inv, m[1], idOf(name), true);
    }
  }
  return inv;
}

// Digests any COMMITTED revision of a node file named: one `git log -p` over
// the commits whose diff touches an `asset_digest:` line (both sides read, `-m`
// so a merge's resolved tree is included — over-including is the safe
// direction). THROWS when git cannot answer: a backup must never silently drop
// history. The repo is found from the nodes dir itself (`--show-toplevel`),
// not assumed to be the graph home: a shared graph home nested in a code repo
// has no .git of its own, and a configured `nodes` dir can live elsewhere. A
// nodes dir in no repo, or a repo with no commits yet, has no history to read.
function historyInventory(nodesDir, inv = new Map()) {
  const top = gitSpawn(nodesDir, ["rev-parse", "--show-toplevel"]);
  if (top.error) throw new Error(`could not run git to read the graph's history for asset descriptors: ${top.error.message}`);
  if (top.status !== 0) {
    if (/not a git repository/i.test(String(top.stderr))) return inv;
    throw new Error(`could not locate the graph's git repo for asset descriptors: ${String(top.stderr).trim() || `git exited ${top.status}`}`);
  }
  const root = String(top.stdout).trim();
  // The NATIVE realpath on both sides: git reports the long form of a Windows
  // 8.3 short path (RUNNER~1 -> runneradmin), which only it recovers.
  const rel = path.relative(fs.realpathSync.native(root), fs.realpathSync.native(nodesDir)).split(path.sep).join("/") || ".";
  const r = gitSpawn(root, ["log", "--all", "-m", "--format=", "-p", "--no-color", "--no-ext-diff", "--no-renames", "--unified=0",
    "-G", "^asset_digest:", "--", rel], { maxBuffer: HISTORY_MAX_BYTES, timeout: HISTORY_TIMEOUT_MS });
  if (r.error || r.status !== 0) {
    const msg = String((r.error && r.error.message) || r.stderr || "").trim();
    if (/does not have any commits|bad default revision|unknown revision/i.test(msg)) return inv;
    throw new Error(`could not read the graph's git history for asset descriptors: ${msg || `git exited ${r.status}`}`);
  }
  let file = null;
  for (const line of String(r.stdout).split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      file = null;
      continue;
    }
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      const p = line.slice(4).trim();
      if (p !== "/dev/null") file = p.replace(/^[ab]\//, "");
      continue;
    }
    if (line[0] !== "+" && line[0] !== "-") continue;
    const m = DIGEST_LINE.exec(line.slice(1));
    if (m) add(inv, m[1], file ? idOf(file) : null, false);
  }
  return inv;
}

// The full inventory, sorted by digest (descriptors sorted) so the export is
// deterministic — the server's assetInventory.
function assetInventory(nodesDir) {
  const inv = currentInventory(nodesDir);
  historyInventory(nodesDir, inv);
  const sorted = new Map();
  for (const d of [...inv.keys()].sort()) {
    const e = inv.get(d);
    e.descriptors.sort();
    sorted.set(d, e);
  }
  return sorted;
}

function objectEntryName(digest) {
  const hex = digest.slice("sha256:".length);
  return `assets/sha256/${hex.slice(0, 2)}/${hex}`;
}

// The `assets/` entries ({name, data, mtime}) for a local export: every
// inventoried object read from the local store and re-hashed BEFORE it is
// written (a torn or forged object is reported `corrupt`, never exported under
// a digest it does not match), then the manifest last. Returns {entries,
// manifest}.
function assetExportEntries(home, inventory, { head = null, now = Date.now() } = {}) {
  const entries = [];
  const objects = [];
  const missing = [];
  const corrupt = [];
  const unreadable = [];
  const mtime = Math.floor(now / 1000);
  for (const e of inventory.values()) {
    const ref = { digest: e.digest, descriptors: e.descriptors, current: e.current };
    let data;
    try {
      data = fs.readFileSync(objectPath(home, e.digest));
    } catch (err) {
      if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) missing.push(ref);
      else unreadable.push({ ...ref, error: String((err && err.message) || err).slice(0, 200) });
      continue;
    }
    if (`sha256:${crypto.createHash("sha256").update(data).digest("hex")}` !== e.digest) {
      corrupt.push(ref);
      continue;
    }
    objects.push({ ...ref, bytes: data.length });
    entries.push({ name: objectEntryName(e.digest), data, mtime });
  }
  const manifest = {
    format: ASSET_EXPORT_FORMAT,
    generated_at: new Date(now).toISOString(),
    head: head || null,
    tenant: null,
    inventory: inventory.size,
    objects,
    missing,
    corrupt,
    unreadable,
  };
  entries.push({ name: MANIFEST_NAME, data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), mtime });
  return { entries, manifest };
}

// Read and check the manifest out of an extracted archive ([{name, data}]).
// Returns {manifest} or {error}. The manifest is the archive's LAST entry, so
// its absence means the transfer stopped early (the server aborts a failed
// asset export rather than ending it cleanly); an unknown format major is
// refused rather than guessed at; and every object the manifest lists must be
// in the archive — a manifest that names bytes the archive lacks is not a
// backup of them.
function readArchiveManifest(entries) {
  const last = entries.length ? entries[entries.length - 1] : null;
  if (!last || last.name !== MANIFEST_NAME) {
    return { error: `the archive does not end with ${MANIFEST_NAME} — the transfer was cut short (an aborted export), so it is not a complete backup` };
  }
  let manifest;
  try {
    manifest = JSON.parse(last.data.toString("utf8"));
  } catch (e) {
    return { error: `${MANIFEST_NAME} is not valid JSON (${e.message})` };
  }
  const major = /^spor-assets\/(\d+)$/.exec(String(manifest && manifest.format));
  if (!major || major[1] !== "1") {
    return { error: `unsupported asset export format ${JSON.stringify(manifest && manifest.format)} (this client reads ${ASSET_EXPORT_FORMAT})` };
  }
  for (const k of ["objects", "missing", "corrupt", "unreadable"]) {
    if (!Array.isArray(manifest[k])) return { error: `${MANIFEST_NAME} has no ${k} list` };
  }
  const have = new Map(entries.map((e) => [e.name, e.data]));
  for (const o of manifest.objects) {
    const data = o && typeof o.digest === "string" && /^sha256:[0-9a-f]{64}$/.test(o.digest) ? have.get(objectEntryName(o.digest)) : undefined;
    if (!data) return { error: `${MANIFEST_NAME} lists ${o && o.digest} but the archive does not carry it` };
    if (`sha256:${crypto.createHash("sha256").update(data).digest("hex")}` !== o.digest) {
      return { error: `the archive's copy of ${o.digest} does not hash to its name — the transfer is corrupt` };
    }
  }
  return { manifest };
}

// The lists a manifest says it could NOT carry, as stderr lines (empty when
// the export is whole). One summary line, then one line per digest naming the
// descriptors that reference it.
function describeGaps(manifest) {
  const lines = [];
  const kinds = ["missing", "corrupt", "unreadable"];
  const lists = kinds.map((k) => (Array.isArray(manifest[k]) ? manifest[k] : []));
  const total = lists.reduce((n, l) => n + l.length, 0);
  if (!total) return lines;
  const counts = kinds.map((k, i) => (lists[i].length ? `${lists[i].length} ${k}` : null)).filter(Boolean).join(", ");
  lines.push(`warning: asset export is incomplete — ${counts} (named in ${MANIFEST_NAME}; these bytes are NOT in the archive):`);
  kinds.forEach((k, i) => {
    for (const ref of lists[i]) {
      const ds = Array.isArray(ref && ref.descriptors) && ref.descriptors.length ? ` (${ref.descriptors.join(", ")})` : "";
      const why = ref && ref.error ? ` — ${ref.error}` : "";
      lines.push(`  ${k}: ${ref && ref.digest}${ds}${why}`);
    }
  });
  return lines;
}

module.exports = {
  ASSET_EXPORT_FORMAT,
  MANIFEST_NAME,
  currentInventory,
  historyInventory,
  assetInventory,
  objectEntryName,
  assetExportEntries,
  readArchiveManifest,
  describeGaps,
};

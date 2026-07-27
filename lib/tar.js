"use strict";
// tar.js — a zero-dependency POSIX ustar writer for the local-mode arm of
// `spor export` (task-spor-export-cli-verb). It builds the SAME tarball the
// server streams from GET /v1/export (the hand-rolled ustar in
// spor-server/server/rest.js), so a local export and a remote export of the
// same graph are byte-for-byte interchangeable: `tar x` reproduces nodes/
// either way (norm-spor-cli-mode-parity). zlib (the optional --gzip) is a Node
// builtin, so this stays zero-dep like the rest of lib/.
//
// The server STREAMS its archive (it serves 50k-node team graphs under
// concurrent load); this twin BUFFERS, because the local arm dumps one
// personal graph once from the CLI — buffering is simpler and the scale is
// small. The on-the-wire bytes are identical regardless.

const fs = require("fs");
const path = require("path");

// Most node ids are short kebab slugs that fit the 100-byte ustar name field
// outright; a longer path (a gardener finding id is the realistic case) is
// rescued by splitting it at a `/` boundary into the ustar `prefix` field
// (<=155 bytes) + `name` (<=100 bytes) — POSIX ustar proper, not the GNU
// `././@LongLink` extension. Byte-faithful port of the server's fix
// (spor-server ca04032, issue-spor-server-export-ustar-limit).
//
// The split can only land on a `/` that is actually present in the path: on
// extraction, a ustar reader reconstructs the full name as `prefix + "/" +
// name` unconditionally, so splitting anywhere else would insert a slash that
// was never there and corrupt the path. Node ids are plain kebab slugs (no
// internal "/"), so in practice the only usable boundary is the "nodes/"
// directory separator; returns null when no split leaves both halves within
// their field widths.
function splitUstarName(name) {
  if (Buffer.byteLength(name, "utf8") <= 100) return { prefix: "", name };
  // i > 0, not >= 0: a "/" at index 0 would split into an EMPTY prefix, which
  // ustar readers treat as "no prefix used" (reconstructing from `name` alone)
  // rather than as a genuine empty-string prefix component — not a usable
  // split — and `lastIndexOf("/", -1)` clamps to re-finding index 0 forever,
  // so including it would also infinite-loop.
  for (let i = name.lastIndexOf("/"); i > 0; i = name.lastIndexOf("/", i - 1)) {
    const prefix = name.slice(0, i);
    const rest = name.slice(i + 1);
    if (Buffer.byteLength(prefix, "utf8") <= 155 && Buffer.byteLength(rest, "utf8") <= 100) {
      return { prefix, name: rest };
    }
  }
  return null;
}

// One 512-byte POSIX ustar header. Byte-faithful copy of the server's
// tarHeader: mode 0644, zero uid/gid, octal size/mtime, checksum computed with
// the chksum field blanked to spaces, typeflag '0' (regular file). `name` over
// the 100-byte field is rescued via splitUstarName's prefix; the caller must
// pre-filter (splitUstarName returning null) any entry with no viable split.
function tarHeader(name, size, mtime) {
  const split = splitUstarName(name);
  if (!split) throw new Error(`ustar: '${name}' has no /-boundary split that fits prefix(155)+name(100)`);
  const buf = Buffer.alloc(512);
  buf.write(split.name, 0, 100, "utf8");
  buf.write("0000644\0", 100); // mode
  buf.write("0000000\0", 108); // uid
  buf.write("0000000\0", 116); // gid
  buf.write(size.toString(8).padStart(11, "0") + "\0", 124);
  buf.write(mtime.toString(8).padStart(11, "0") + "\0", 136);
  buf.write("        ", 148); // chksum: spaces while summing
  buf.write("0", 156); // typeflag: regular file
  buf.write("ustar\0", 257);
  buf.write("00", 263);
  if (split.prefix) buf.write(split.prefix, 345, 155, "utf8");
  let sum = 0;
  for (const b of buf) sum += b;
  buf.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return buf;
}

// Concatenate the descriptors ({name, abs}) into a ustar archive Buffer: a
// header per file, its bytes, padding up to the next 512 boundary, then two
// closing zero blocks. mtime mirrors the server (file mtime, second precision).
function buildTarball(descriptors) {
  const parts = [];
  for (const d of descriptors) {
    const data = fs.readFileSync(d.abs);
    const mtime = Math.max(0, Math.floor(fs.statSync(d.abs).mtimeMs / 1000));
    parts.push(tarHeader(d.name, data.length, mtime));
    parts.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024)); // two closing zero blocks
  return Buffer.concat(parts);
}

// The export entry list for a graph home's nodes/ dir, mirroring the server's
// selection: every *.md file, sorted by name, as a `nodes/<name>` entry. Most
// long ids are rescued by the prefix split (splitUstarName); an entry with no
// viable split at all is dropped and counted (a path with no viable split is
// still unrepresentable in this archive format).
function collectNodeEntries(nodesDir) {
  const names = fs
    .readdirSync(nodesDir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".md"))
    .map((d) => d.name)
    .sort();
  const descriptors = [];
  let skipped = 0;
  for (const name of names) {
    const entry = `nodes/${name}`;
    if (!splitUstarName(entry)) {
      skipped++;
      continue;
    }
    descriptors.push({ name: entry, abs: path.join(nodesDir, name) });
  }
  return { descriptors, skipped };
}

// The whole local export in one call: { buffer, count, skipped } where buffer
// is the uncompressed ustar (the caller gzips if asked) and count is the node
// entry count (the local twin of the x-substrate-node-count header).
function exportNodesDir(nodesDir) {
  const { descriptors, skipped } = collectNodeEntries(nodesDir);
  return { buffer: buildTarball(descriptors), count: descriptors.length, skipped };
}

// One NUL-terminated (or full-width) string field from a 512-byte header block.
function tarField(header, start, len) {
  const slice = header.subarray(start, start + len);
  let end = slice.indexOf(0);
  if (end < 0) end = len;
  return slice.toString("utf8", 0, end);
}

// Parse a POSIX ustar archive Buffer into [{name, data}] for its regular-file
// entries — the READ twin of buildTarball, for the remote arm of `spor query`
// (task-spor-cli-query-remote-mode): it downloads the GET /v1/export tarball and
// runs the SAME local query.js over the extracted nodes/. The on-the-wire bytes
// are identical to a local export (norm-spor-cli-mode-parity), so a round-trip
// reproduces nodes/ exactly. Only regular files (typeflag '0' or NUL) with a
// non-empty name are returned; directory / long-name / other entries are
// skipped. Reading stops at the first all-zero (end-of-archive) block, so it
// tolerates the two closing zero blocks and any trailing junk. A non-empty
// `prefix` field (the tarHeader/splitUstarName rescue for a long path) is
// rejoined as `prefix + "/" + name`, matching how a real ustar reader
// reconstructs the full path — same reconstruction rule splitUstarName's
// comment describes for why the split can only land on an existing "/".
function extract(buf) {
  const entries = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive zero block
    const prefix = tarField(header, 345, 155);
    const name = prefix ? `${prefix}/${tarField(header, 0, 100)}` : tarField(header, 0, 100);
    const size = parseInt(tarField(header, 124, 12).trim() || "0", 8) || 0;
    const typeflag = header[156]; // 0x30 '0' or 0x00 → regular file
    off += 512; // advance past the header to the data
    if (name && (typeflag === 0x30 || typeflag === 0)) {
      entries.push({ name, data: Buffer.from(buf.subarray(off, off + size)) });
    }
    off += Math.ceil(size / 512) * 512; // skip the data + its padding to the next block
  }
  return entries;
}

module.exports = { tarHeader, splitUstarName, buildTarball, collectNodeEntries, exportNodesDir, extract };

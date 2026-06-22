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

// One 512-byte POSIX ustar header. Byte-faithful copy of the server's
// tarHeader: mode 0644, zero uid/gid, octal size/mtime, checksum computed with
// the chksum field blanked to spaces, typeflag '0' (regular file). Node ids are
// short kebab slugs so every entry name fits the 100-byte field; the caller
// drops (and counts) any that don't.
function tarHeader(name, size, mtime) {
  const buf = Buffer.alloc(512);
  buf.write(name, 0, 100, "utf8");
  buf.write("0000644\0", 100); // mode
  buf.write("0000000\0", 108); // uid
  buf.write("0000000\0", 116); // gid
  buf.write(size.toString(8).padStart(11, "0") + "\0", 124);
  buf.write(mtime.toString(8).padStart(11, "0") + "\0", 136);
  buf.write("        ", 148); // chksum: spaces while summing
  buf.write("0", 156); // typeflag: regular file
  buf.write("ustar\0", 257);
  buf.write("00", 263);
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
// selection: every *.md file, sorted by name, as a `nodes/<name>` entry.
// Entries whose name overflows the 100-byte ustar field are dropped and counted
// (effectively never hit — node ids are short — but the count stays honest).
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
    if (Buffer.byteLength(entry, "utf8") > 100) {
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
// tolerates the two closing zero blocks and any trailing junk.
function extract(buf) {
  const entries = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive zero block
    const name = tarField(header, 0, 100);
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

module.exports = { tarHeader, buildTarball, collectNodeEntries, exportNodesDir, extract };

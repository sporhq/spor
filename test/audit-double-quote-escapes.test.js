const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const SCRIPT = path.join(__dirname, "..", "scripts", "analysis", "audit-double-quote-escapes.js");

test("audit flags wholly double-quoted control escapes, not plain scalars or JSON-style ones", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-dq-"));
  const node = (id, summary) => fs.writeFileSync(path.join(dir, `${id}.md`), `---\nid: ${id}\ntype: artifact\nsummary: ${summary}\n---\n\nbody\n`);
  node("art-path", String.raw`"C:\new\temp"`);
  node("art-json", String.raw`"say \"hi\" \\ ok"`);
  node("art-plain", String.raw`join("\n") is literal here`);
  const r = spawnSync(process.execPath, [SCRIPT, dir, "--json"], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr);
  const { scanned, hits } = JSON.parse(r.stdout);
  assert.strictEqual(scanned, 3);
  const by = Object.fromEntries(hits.map((h) => [h.id, h.kinds]));
  assert.deepStrictEqual(by, { "art-path": ["control"], "art-json": ["json-style"] });
  fs.rmSync(dir, { recursive: true, force: true });
});

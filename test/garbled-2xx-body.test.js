// garbled-2xx-body.test.js — a 2xx whose body will not parse is a FAILED read,
// never an empty envelope (task-spor-cli-code-smell-cleanup; the CLI-verb half
// of issue-spor-verify-run-resolution-silent-json-parse-failure). Each verb
// that used to read `r.json || {}` must exit 1 naming the unparseable body.
require("./helpers/tmp-cleanup");
const { hermeticEnv } = require("./helpers/env.js");
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const CLI = path.join(__dirname, "..", "bin", "spor.js");
const ISO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "spor-garbled-iso-"));

function garbledServer() {
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("<html>not json");
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(srv)));
}
function run(args, port) {
  return new Promise((resolve) => {
    const env = hermeticEnv({ SPOR_HOME: ISO_HOME, XDG_CONFIG_HOME: ISO_HOME, SPOR_SERVER: `http://127.0.0.1:${port}`, SPOR_TOKEN: "t" });
    const c = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

for (const [label, args] of [
  ["admin gardener", ["admin", "gardener"]],
  ["share", ["share", "task-x"]],
  ["ask", ["ask", "does the garbled body fail closed here?"]],
  ["next", ["next"]],
]) {
  test(`${label}: an unparseable 2xx body exits 1 instead of reading as empty`, async () => {
    const srv = await garbledServer();
    try {
      const r = await run(args, srv.address().port);
      assert.strictEqual(r.status, 1, r.stderr);
      assert.match(r.stderr, /unparseable (response )?body/);
    } finally {
      srv.close();
    }
  });
}

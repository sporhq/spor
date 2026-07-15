// task-spor-distill-conditional-status-fetch: the remote distiller's dedup
// index used to re-download the full /v1/status?titles=1 snapshot (5-15MB)
// on every SessionEnd sweep. The server now serves conditional-request
// semantics there (a weak ETag + a bodyless 304 on a matching
// If-None-Match, task-cc-tier-2-read-path-scaling); this suite drives the
// real dispatcher (bin/spor-hook distill) against an in-process stub server
// to prove the client caches the titles snapshot by ETag, revalidates with
// If-None-Match, and reuses the cached titles on a 304 or a failed refetch.
require("./helpers/tmp-cleanup"); // scratch-home leak guard (issue-spor-test-mkdtemp-inode-exhaustion)
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnHook, writeNodeScript, nodeCommand } = require("./helpers/portable");

function freshEnv(home, extra = {}) {
  const env = { ...process.env, SPOR_HOME: home };
  for (const k of Object.keys(env)) {
    if (k.startsWith("SUBSTRATE_")) delete env[k];
    if (k.startsWith("SPOR_") && k !== "SPOR_HOME") delete env[k];
  }
  // Spor is opt-in per repo (task-spor-plugin-opt-in-default).
  env.SPOR_ENABLED = "1";
  return { ...env, ...extra };
}

// Pure remote: no local nodes/ dir, and no git repo (so sessionEndLease's
// `git rev-parse --show-toplevel` gate short-circuits and the only network
// hits are the ones this suite is asserting on).
function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spor-statuscache-"));
  const home = path.join(root, "graph");
  fs.mkdirSync(home, { recursive: true });
  const cwd = path.join(root, "projx");
  fs.mkdirSync(cwd);
  return { root, home, cwd };
}

function words(n, w) {
  return Array.from({ length: n }, (_, i) => `${w}${i}`).join(" ");
}

function writeTranscript(root, name, a, b) {
  const p = path.join(root, name);
  fs.writeFileSync(
    p,
    [
      JSON.stringify({ type: "user", message: { content: [{ type: "text", text: words(60, a) }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: words(60, b) }] } }),
    ].join("\n") + "\n"
  );
  return p;
}

// The distill backend stub: dumps the prompt it received on stdin to
// promptFile, then answers NOTHING so the test isolates the titles-index
// fetch/cache behavior from the fact-parsing / capture path.
function makeCaptureStub(root, name, promptFile) {
  const stub = path.join(root, name);
  writeNodeScript(
    stub,
    `
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(promptFile)}, input);
  process.stdout.write("NOTHING\\n");
});
`
  );
  return nodeCommand(stub);
}

// Stub server: GET /v1/status?titles=1 answers with state.etag/state.head,
// 304-ing a matching If-None-Match; everything else (the sweep report,
// outbox drain probes) answers a generic 200.
function makeServer(state) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.method === "GET" && req.url.startsWith("/v1/status")) {
        const inm = req.headers["if-none-match"];
        if (inm && inm === state.etag) {
          res.writeHead(304, { etag: state.etag, "x-substrate-head": state.head });
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json", etag: state.etag, "x-substrate-head": state.head });
        res.end(JSON.stringify({ titles: state.titles }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "updated", found: false, graph_status: { node_count: 0 } }));
    });
  });
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}` }))
  );
}

function runAsync(args, input, env) {
  return new Promise((resolve, reject) => {
    const c = spawnHook(args, input, env, { stdio: ["pipe", "ignore", "ignore"] });
    c.on("error", reject);
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });
}

test("distill (remote): fetches titles uncached on the first sweep, then revalidates with If-None-Match and reuses the cached titles on a 304", async () => {
  const { root, home, cwd } = scratch();
  const state = { etag: 'W/"v1"', head: "head1", titles: [{ id: "task-x", title: "Task X" }] };
  const { srv, hits, base } = await makeServer(state);
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: "spor_pat_test" });

    const prompt1 = path.join(root, "prompt1.txt");
    env.SPOR_DISTILL_CMD = makeCaptureStub(root, "stub1.js", prompt1);
    await runAsync(
      ["distill", "--host", "claude-code"],
      JSON.stringify({
        cwd,
        session_id: "s1",
        transcript_path: writeTranscript(root, "t1.jsonl", "alpha", "beta"),
        hook_event_name: "SessionEnd",
      }),
      env
    );

    const firstStatusHit = hits.find((h) => h.method === "GET" && h.url.startsWith("/v1/status"));
    assert.ok(firstStatusHit, "the sweep fetched /v1/status?titles=1");
    assert.strictEqual(
      firstStatusHit.headers["if-none-match"],
      undefined,
      "no cache yet on the first sweep -> no conditional header sent"
    );
    const p1 = fs.readFileSync(prompt1, "utf8");
    assert.match(p1, /task-x — Task X/, "the fresh titles snapshot reaches the fact-finder prompt");

    const cacheFile = path.join(home, "cache", "status-titles.json");
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    assert.strictEqual(cached.etag, state.etag);
    assert.strictEqual(cached.server, base);
    assert.match(cached.index, /task-x — Task X/);

    // second sweep: the server 304s a matching If-None-Match -> the
    // distiller must reuse the cached titles instead of re-downloading.
    const before = hits.length;
    const prompt2 = path.join(root, "prompt2.txt");
    env.SPOR_DISTILL_CMD = makeCaptureStub(root, "stub2.js", prompt2);
    await runAsync(
      ["distill", "--host", "claude-code"],
      JSON.stringify({
        cwd,
        session_id: "s2",
        transcript_path: writeTranscript(root, "t2.jsonl", "gamma", "delta"),
        hook_event_name: "SessionEnd",
      }),
      env
    );

    const secondStatusHit = hits.slice(before).find((h) => h.method === "GET" && h.url.startsWith("/v1/status"));
    assert.ok(secondStatusHit, "the second sweep also fetched /v1/status?titles=1");
    assert.strictEqual(
      secondStatusHit.headers["if-none-match"],
      state.etag,
      "revalidates against the cached ETag"
    );
    const p2 = fs.readFileSync(prompt2, "utf8");
    assert.match(
      p2,
      /task-x — Task X/,
      "a 304 reuses the cached titles rather than distilling against an empty index"
    );
  } finally {
    srv.close();
  }
});

test("distill (remote): a fresh 200 (changed titles) replaces the cached snapshot and its ETag", async () => {
  const { root, home, cwd } = scratch();
  const state = { etag: 'W/"v1"', head: "head1", titles: [{ id: "task-x", title: "Task X" }] };
  const { srv, base } = await makeServer(state);
  try {
    const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: "spor_pat_test" });
    env.SPOR_DISTILL_CMD = makeCaptureStub(root, "stub1.js", path.join(root, "prompt1.txt"));
    await runAsync(
      ["distill", "--host", "claude-code"],
      JSON.stringify({
        cwd,
        session_id: "s1",
        transcript_path: writeTranscript(root, "t1.jsonl", "alpha", "beta"),
        hook_event_name: "SessionEnd",
      }),
      env
    );

    // the graph moved on: a new ETag and a new title set
    state.etag = 'W/"v2"';
    state.head = "head2";
    state.titles = [{ id: "task-y", title: "Task Y" }];

    const prompt2 = path.join(root, "prompt2.txt");
    env.SPOR_DISTILL_CMD = makeCaptureStub(root, "stub2.js", prompt2);
    await runAsync(
      ["distill", "--host", "claude-code"],
      JSON.stringify({
        cwd,
        session_id: "s2",
        transcript_path: writeTranscript(root, "t2.jsonl", "gamma", "delta"),
        hook_event_name: "SessionEnd",
      }),
      env
    );

    const p2 = fs.readFileSync(prompt2, "utf8");
    assert.match(p2, /task-y — Task Y/, "the refreshed snapshot reaches the prompt");
    assert.doesNotMatch(p2, /task-x/, "the stale entry from the old snapshot is gone");

    const cached = JSON.parse(fs.readFileSync(path.join(home, "cache", "status-titles.json"), "utf8"));
    assert.strictEqual(cached.etag, 'W/"v2"');
    assert.match(cached.index, /task-y — Task Y/);
  } finally {
    srv.close();
  }
});

test("distill (remote): a failed refetch falls back to the last cached titles snapshot (stale beats none)", async () => {
  const { root, home, cwd } = scratch();
  const state = { etag: 'W/"v1"', head: "head1", titles: [{ id: "task-x", title: "Task X" }] };
  const { srv, base } = await makeServer(state);
  const env = freshEnv(home, { SPOR_SERVER: base, SPOR_TOKEN: "spor_pat_test" });
  env.SPOR_DISTILL_CMD = makeCaptureStub(root, "stub1.js", path.join(root, "prompt1.txt"));
  await runAsync(
    ["distill", "--host", "claude-code"],
    JSON.stringify({
      cwd,
      session_id: "s1",
      transcript_path: writeTranscript(root, "t1.jsonl", "alpha", "beta"),
      hook_event_name: "SessionEnd",
    }),
    env
  );
  srv.close(); // the next sweep's status fetch now transport-fails (http "000")

  const prompt2 = path.join(root, "prompt2.txt");
  env.SPOR_DISTILL_CMD = makeCaptureStub(root, "stub2.js", prompt2);
  await runAsync(
    ["distill", "--host", "claude-code"],
    JSON.stringify({
      cwd,
      session_id: "s2",
      transcript_path: writeTranscript(root, "t2.jsonl", "gamma", "delta"),
      hook_event_name: "SessionEnd",
    }),
    env
  );

  const p2 = fs.readFileSync(prompt2, "utf8");
  assert.match(
    p2,
    /task-x — Task X/,
    "a dead server still distills against the last cached snapshot instead of an empty index"
  );
});

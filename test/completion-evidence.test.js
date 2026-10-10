require("./helpers/tmp-cleanup");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { hermeticEnv } = require("./helpers/env.js");
const { gitEnv } = require("./helpers/git.js");
const { loadConfig } = require("../lib/config.js");
const graph = require("../lib/graph.js");
const content = require("../lib/kernel/content.js");
const evidence = require("../lib/kernel/completion-evidence.js");
const gates = require("../lib/kernel/gates.js");
const completion = require("../lib/shell/completion.js");
const assets = require("../lib/shell/asset.js");
const documents = require("../lib/shell/document.js");
const spor = require("../bin/spor.js");
const { workerContract } = require("../lib/shell/worker-contract.js");
const root = path.join(__dirname, "..");
const commit = "b".repeat(40);
const executionId = "exec-0123456789abcdef";
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");

function raw(id, type, body = "A readable account.", extra = "") {
  return `---\nid: ${id}\ntype: ${type}\nproject: spor\ntitle: ${id}\nsummary: A readable fixture for completion screenshot evidence.\n${extra}---\n\n${body}\n`;
}
function cli(home, args) {
  const r = spawnSync(process.execPath, [path.join(root, "bin/spor.js"), ...args], {
    cwd: home, env: hermeticEnv({ SPOR_HOME: home, SPOR_MODE: "local", XDG_CONFIG_HOME: home }), encoding: "utf8", timeout: 30000,
  });
  assert.equal(r.status, 0, r.stderr || r.error?.message);
  return r.stdout;
}
function fixture({ required = true, after = "gates", inclusion = true, screenshots } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-evidence-"));
  const nodes = path.join(home, "nodes");
  fs.mkdirSync(nodes);
  const init = spawnSync("git", ["init", "-q", home], { env: gitEnv(), encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  fs.writeFileSync(path.join(nodes, "task-visible.md"), raw("task-visible", "task", "Implement the visible feature.", `status: open\nexecution: ${executionId}\nedges:\n  - {type: blocks, to: task-dependent}\n`));
  fs.writeFileSync(path.join(nodes, "task-dependent.md"), raw("task-dependent", "task", "Wait for the feature.", "status: open\n"));
  fs.writeFileSync(path.join(nodes, "art-design.md"), raw("art-design", "artifact"));
  if (inclusion) {
    const schema = fs.readFileSync(path.join(root, "lib/seed/candidates/schema-edge-uses-asset.md"), "utf8");
    fs.writeFileSync(path.join(nodes, "schema-edge-uses-asset.md"), schema);
  }
  const file = path.join(home, "private-screenshot.png");
  fs.writeFileSync(file, image);
  const imported = JSON.parse(cli(home, ["asset", "import", file, "--alt", "The delivered queue", "--json"]));
  const shot = { uri: imported.asset.uri, caption: "The queue [empty] state", provenance: "Queue view, 1280x800, empty fixture, Playwright." };
  const manifest = { schema: evidence.SCHEMA, execution_id: executionId, revision: commit,
    design: "art-design", result: "The queue explains how to admit the next task.", screenshots: screenshots || [shot] };
  const account = (m) => raw("art-account", "artifact", `Changed the empty queue.\n\n\`\`\`${evidence.FENCE}\n${JSON.stringify(m)}\n\`\`\``, "edges:\n  - {type: relates-to, to: task-visible}\n");
  const published = documents.putDocument(nodes, { node: account(manifest), journalDir: path.join(home, "journal/documents") });
  assert.equal(published.ok, true, JSON.stringify(published));
  const cfg = loadConfig({ cwd: home, env: { SPOR_HOME: home, SPOR_MODE: "local", XDG_CONFIG_HOME: home } });
  const record = { run_id: "run-evidence", node_id: "task-visible", item_repo: "spor", gates_state: "passed", impl_state: "candidate",
    impl_claim: { execution_id: executionId, completion: { by: "controller", after, screenshots: required ? "required" : "optional" }, status_snapshot: "open", resolving_snapshot: [] },
    impl_candidate: { candidate_id: "cand-1111222233334444", commit, tree: "a".repeat(40), resolver: { node: "art-account", revision: published.revision, written: true, resolves_edge: false } } };
  const deps = spor.makeCompletionDeps(cfg, { home });
  deps.stamp = (patch) => Object.assign(record, patch);
  deps.stampImpl = (patch) => Object.assign(record, patch);
  return { home, nodes, cfg, record, deps, imported, shot, manifest, account };
}

test("factory screenshot policy is optional, validated, and carried only on declared controller completion", () => {
  const parse = (completion) => gates.parseImplementation({ completion });
  assert.deepEqual(parse({ by: "controller" }).completion, { by: "controller", after: "gates" });
  assert.equal(parse({ by: "controller", screenshots: "required" }).completion.screenshots, "required");
  for (const v of [true, "yes", "", null, {}]) assert.match(parse({ by: "controller", screenshots: v }).errors.join(" "), /completion.screenshots/);
  assert.match(parse({ by: "agent", screenshots: "required" }).errors.join(" "), /requires completion.by/);
  const text = workerContract({ nodeId: "task-visible", factory: { trustedRef: "main", gates: [], completion: { by: "controller", screenshots: "required" } } });
  assert.match(text, /spor asset import/);
  assert.match(text, /spor-completion-evidence/);
  assert.match(text, /Screenshot policy: required/);
  assert.match(text, /Screenshots never pass factory gates/);
});

test("digest-pinned screenshots become durable readable completion inclusions at gates, releasing dependents only at the CAS", async () => {
  const f = fixture();
  const before = graph.loadGraph(f.nodes);
  const accountRevision = f.record.impl_candidate.resolver.revision;
  assert.equal(require("../lib/kernel/resolution.js").resolutionMap(before)["task-visible"], undefined);
  const order = [];
  const verify = f.deps.verifyEvidenceAsset;
  f.deps.verifyEvidenceAsset = async (uri) => { order.push("verify"); return verify(uri); };
  f.deps.execution = { confirm: async () => { order.push("fence"); return { confirmed: true }; } };
  const write = f.deps.writeNode;
  f.deps.writeNode = async (...args) => { order.push("resolver"); return write(...args); };
  const cas = f.deps.casWrite;
  f.deps.casWrite = async (...args) => {
    order.push("cas");
    const held = graph.loadGraph(f.nodes);
    assert.equal(require("../lib/kernel/resolution.js").resolutionMap(held)["task-visible"], undefined);
    return cas(...args);
  };
  const r = await completion.writeCompletion({ record: f.record, deps: f.deps, facts: ["art-gate-visible"], boundary: "gates" });
  assert.equal(r.settled, "written", r.reason);
  assert.deepEqual(order, ["verify", "fence", "resolver", "cas"]);
  const g = graph.loadGraph(f.nodes);
  const node = g.nodes[r.resolver];
  assert.equal(node.content_format, "markdown");
  assert.ok(node.edges.some((e) => e.type === "uses-asset" && e.to === f.imported.asset.id));
  assert.ok(node.edges.some((e) => e.type === "derived-from" && e.to === "art-design"));
  assert.ok(node.edges.some((e) => e.type === "relates-to" && e.to === "art-account"));
  const doc = documents.getDocument(f.nodes, { id: r.resolver }).document;
  assert.equal(doc.complete, true);
  assert.match(doc.source, /The queue explains how to admit the next task/);
  assert.match(doc.source, /Screenshots illustrate the result; factory gate/);
  assert.ok(doc.source.includes(f.shot.uri));
  assert.ok(doc.source.includes(executionId) && doc.source.includes(commit) && doc.source.includes(accountRevision));
  assert.equal(f.record.impl_candidate.resolver.revision, null, "the account revision is not mislabeled as the controller resolver's revision");
  assert.equal(content.extractAssetEmbeds(doc.body).length, 1);
  assert.equal(g.nodes["task-visible"].execution, undefined);
  assert.equal(g.nodes["task-visible"].status, "done");
  assert.equal(f.record.completion_debt, null);
});

test("images cannot bypass failed gates, running integration, or the pinned boundary", async () => {
  const f = fixture({ after: "integration" });
  f.record.integration_state = "running";
  for (const boundary of ["gates", "integration"]) {
    const r = await completion.writeCompletion({ record: f.record, deps: f.deps, boundary });
    assert.equal(r.ok, false);
    assert.match(r.reason, /pinned controller completion boundary/);
    assert.equal(fs.readdirSync(f.nodes).some((p) => p.startsWith("art-completion-")), false);
  }
  f.record.integration_state = "landed";
  assert.equal((await completion.writeCompletion({ record: f.record, deps: f.deps, boundary: "integration" })).settled, "written");
  const failed = fixture();
  failed.record.gates_state = "failed";
  assert.equal((await completion.writeCompletion({ record: failed.record, deps: failed.deps })).ok, false);
  assert.ok(graph.loadGraph(failed.nodes).nodes["task-visible"].execution);
});

test("a parked proposal needs the landed fact and screenshots before completing", async () => {
  const f = fixture({ after: "integration" });
  f.record.integration_state = "parked";
  assert.equal((await completion.writeCompletion({ record: f.record, deps: f.deps })).ok, false);
  assert.equal((await completion.writeCompletion({ record: f.record, deps: f.deps, landedFactPresent: true })).settled, "written");
});

test("required missing evidence does not prevent reconciling a person's release before gates", async () => {
  const f = fixture({ screenshots: [{ caption: "Queue", provenance: "Playwright.", missing: "Upload failed." }] });
  f.record.gates_state = "failed";
  fs.writeFileSync(path.join(f.nodes, "task-visible.md"), raw("task-visible", "task", "Released by a person.", "status: open\n"));
  f.deps.verifyEvidenceAsset = async () => assert.fail("a released execution does not verify evidence");
  const r = await completion.writeCompletion({ record: f.record, deps: f.deps });
  assert.equal(r.settled, "released", r.reason);
  assert.equal(f.record.completion_debt, null);
  assert.equal(fs.readdirSync(f.nodes).some((p) => p.startsWith("art-completion-")), false);
});

for (const required of [true, false]) {
  test(`upload failure is explicit and ${required ? "blocks required completion" : "allows optional completion"}`, async () => {
    const f = fixture({ required, screenshots: [{ caption: "Empty queue", provenance: "Playwright, empty fixture.", missing: "Upload failed; no descriptor was published." }] });
    const r = await completion.writeCompletion({ record: f.record, deps: f.deps });
    assert.equal(r.ok, !required, r.reason);
    if (required) {
      assert.equal(f.record.completion_debt, "write");
      assert.match(f.record.completion_note, /Missing required screenshot evidence/);
      assert.ok(graph.loadGraph(f.nodes).nodes["task-visible"].execution);
      assert.equal(fs.readdirSync(f.nodes).some((p) => p.startsWith("art-completion-")), false);
    } else {
      const doc = documents.getDocument(f.nodes, { id: r.resolver }).document;
      assert.match(doc.source, /Missing screenshot evidence: Empty queue/);
      assert.match(doc.source, /Upload failed; no descriptor was published/);
      assert.equal(content.extractAssetEmbeds(doc.body).length, 0);
    }
  });
}

test("lost required bytes after the resolver write keep the CAS owed; restoration reconciles without duplicate resolution", async () => {
  const f = fixture();
  const cas = f.deps.casWrite;
  f.deps.casWrite = async () => ({ ok: false, reason: "simulated unavailable CAS" });
  assert.equal((await completion.writeCompletion({ record: f.record, deps: f.deps })).ok, false);
  assert.ok(f.record.completion_resolver);
  const file = assets.objectPath(f.home, f.imported.asset.digest);
  fs.unlinkSync(file);
  f.deps.casWrite = cas;
  const missing = await completion.reconcileCompletion({ record: f.record, deps: f.deps });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /missing required screenshot/);
  assert.ok(graph.loadGraph(f.nodes).nodes["task-visible"].execution);
  fs.writeFileSync(file, image);
  const settled = await completion.reconcileCompletion({ record: f.record, deps: f.deps });
  assert.equal(settled.settled, "written", settled.reason);
  assert.equal(f.record.completion_note, null);
  assert.equal(fs.readdirSync(f.nodes).filter((p) => p.startsWith("art-completion-")).length, 1);
  assert.equal((await completion.writeCompletion({ record: f.record, deps: f.deps })).already, true);
});

test("wrong commit or execution, absent policy schema, forged bytes, and incomplete accounts never satisfy required evidence", async () => {
  for (const kind of ["commit", "execution", "schema", "forged", "incomplete", "manifest"]) {
    const f = fixture({ inclusion: kind !== "schema" });
    if (kind === "commit") f.record.impl_candidate.commit = "c".repeat(40);
    if (kind === "execution") f.deps.readEvidenceDocument = async () => ({ complete: true, source: f.account({ ...f.manifest, execution_id: "exec-other" }), revision: f.record.impl_candidate.resolver.revision });
    if (kind === "forged") { const file = assets.objectPath(f.home, f.imported.asset.digest); fs.chmodSync(file, 0o600); fs.writeFileSync(file, Buffer.alloc(image.length)); }
    if (kind === "incomplete") f.deps.readEvidenceDocument = async () => ({ complete: false, source: f.account(f.manifest), revision: f.record.impl_candidate.resolver.revision });
    if (kind === "manifest") f.deps.readEvidenceDocument = async () => ({ complete: true, source: "No screenshot manifest.", revision: f.record.impl_candidate.resolver.revision });
    const r = await completion.writeCompletion({ record: f.record, deps: f.deps });
    assert.equal(r.ok, false, kind);
    assert.equal(fs.readdirSync(f.nodes).some((p) => p.startsWith("art-completion-")), false, kind);
    assert.ok(graph.loadGraph(f.nodes).nodes["task-visible"].execution, kind);
  }
});

test("account revisions stay pinned when a later edit removes or replaces evidence", async () => {
  const f = fixture();
  const pinned = f.record.impl_candidate.resolver.revision;
  const snapshot = documents.getDocument(f.nodes, { id: "art-account" }).document.snapshot;
  const changed = documents.putDocument(f.nodes, { node: raw("art-account", "artifact", "Later edits remove the screenshot."), snapshot, journalDir: path.join(f.home, "journal/documents") });
  assert.equal(changed.ok, true);
  assert.notEqual(changed.revision, pinned);
  const r = await completion.writeCompletion({ record: f.record, deps: f.deps });
  assert.equal(r.settled, "written", r.reason);
  assert.ok(documents.getDocument(f.nodes, { id: r.resolver }).document.source.includes(pinned));
});

test("claim pins screenshot policy independently of later factory edits", async () => {
  const f = fixture();
  const file = path.join(f.nodes, "task-visible.md");
  fs.writeFileSync(file, raw("task-visible", "task", "Feature.", "status: open\n"));
  const factory = gates.parseFactory('```json\n{"factory":"test","gates":[{"id":"check","kind":"command","command":"true"}],"completion":{"by":"controller","screenshots":"required"}}\n```', { id: "factory-test" }).factory;
  const claim = await spor.claimExecutionHold(f.cfg, { id: "task-visible" }, factory, { home: f.home });
  assert.equal(claim.ok, true, claim.reason);
  assert.equal(claim.recordFields.impl_claim.completion.screenshots, "required");
  factory.completion.screenshots = "optional";
  assert.equal(claim.recordFields.impl_claim.completion.screenshots, "required");
});

test("remote completion uses authenticated descriptor and document core doors with exact pins and the validated write boundary", async (t) => {
  const f = fixture();
  const requests = [];
  const localDeps = spor.makeCompletionDeps(f.cfg, { home: f.home });
  const server = require("node:http").createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    requests.push([req.method, url.pathname, url.search]);
    if (req.headers.authorization !== "Bearer fixture-token") { res.writeHead(401); res.end(); return; }
    const send = (body, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    try {
      if (url.pathname === "/v1/schema") return send(graph.loadGraph(f.nodes).registry.snapshot());
      if (url.pathname === "/v1/documents/art-account") {
        const d = documents.getDocument(f.nodes, { id: "art-account", revision: url.searchParams.get("revision") });
        return send(d.document);
      }
      if (url.pathname.startsWith("/v1/assets/")) {
        assert.equal(url.searchParams.get("digest"), f.imported.asset.digest);
        if (url.pathname.endsWith("/content")) {
          res.writeHead(200, { "content-type": "image/png" }); res.end(image); return;
        }
        return send(assets.describeLocal({ home: f.home, nodesDir: f.nodes, ref: assets.parseRef(f.shot.uri) }));
      }
      if (req.method === "POST" && url.pathname === "/v1/nodes") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const entry = JSON.parse(body).nodes[0];
        const id = graph.parseFrontmatter(entry.node, "incoming.md").id;
        const r = entry.if_exists === "update"
          ? await localDeps.casWrite({ nodeId: id, revision: entry.revision, raw: entry.node })
          : await localDeps.writeNode(id, entry.node);
        return send({ results: [{ ...r, id }] });
      }
      if (url.pathname.startsWith("/v1/nodes/")) {
        const id = url.pathname.slice("/v1/nodes/".length);
        const file = path.join(f.nodes, `${id}.md`);
        if (!fs.existsSync(file)) return send({ error: { code: "not_found" } }, 404);
        const bytes = fs.readFileSync(file);
        const extra = id === f.record.node_id ? { execution_hold: { inert_resolvers: [] } } : {};
        return send({ raw: bytes.toString("utf8"), revision: documents.gitBlobSha(bytes), ...extra });
      }
      send({ error: { code: "not_found" } }, 404);
    } catch (e) { send({ error: { message: e.message } }, 500); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cfg = loadConfig({ cwd: f.home, env: { SPOR_HOME: f.home, SPOR_MODE: "remote", SPOR_SERVER: base, SPOR_TOKEN: "fixture-token", XDG_CONFIG_HOME: f.home } });
  const deps = spor.makeCompletionDeps(cfg, { home: f.home });
  deps.stamp = f.deps.stamp;
  deps.stampImpl = f.deps.stampImpl;
  const pin = f.record.impl_candidate.resolver.revision;
  const r = await completion.writeCompletion({ record: f.record, deps });
  assert.equal(r.settled, "written", r.reason);
  assert.ok(requests.some(([, p, q]) => p === "/v1/documents/art-account" && q.includes(pin)));
  assert.ok(requests.some(([, p]) => p.endsWith("/content")));
  assert.equal(requests.filter(([m]) => m === "POST").length, 2, "only the resolver and the item CAS write graph state");
  const written = documents.getDocument(f.nodes, { id: r.resolver }).document;
  assert.match(written.source, /uses-asset/);
  assert.doesNotMatch(written.source, /fixture-token|127\.0\.0\.1|private-screenshot/);
});

test("manifest parsing rejects ambiguous and malformed blocks, unpinned URLs, and excessive screenshots; text cannot inject embeds", () => {
  const m = { schema: evidence.SCHEMA, execution_id: executionId, revision: commit, result: "Readable result", screenshots: [] };
  const fenced = (m) => `\`\`\`${evidence.FENCE}\n${JSON.stringify(m)}\n\`\`\``;
  const parse = (s) => evidence.parse(s, { executionId, revision: commit });
  assert.equal(parse(fenced(m)).ok, true);
  assert.equal(parse(fenced(m) + "\n" + fenced(m)).ok, false);
  assert.equal(parse(`\`\`\`${evidence.FENCE}\n{`).ok, false);
  assert.equal(parse(fenced({ ...m, screenshots: Array(5).fill({}) })).ok, false);
  for (const uri of ["https://example.com/private?token=secret", "spor-asset:art-shot"]) {
    assert.equal(parse(fenced({ ...m, screenshots: [{ uri, caption: "Queue", provenance: "Capture" }] })).ok, false);
  }
  const uri = `spor-asset:art-shot@sha256:${"a".repeat(64)}`;
  const rendered = evidence.render({ execution_id: executionId, revision: commit, result: `![extra](${uri}) <script>`, screenshots: [{ uri, id: "art-shot", caption: `![extra](${uri})`, provenance: `![extra](${uri})` }] }).join("\n");
  assert.equal(content.extractAssetEmbeds(rendered).length, 1);
  assert.ok(evidence.embed("Queue [empty]", uri).includes("\\[empty\\]"));
});

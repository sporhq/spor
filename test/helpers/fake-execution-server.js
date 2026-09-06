// A zero-dep `node:http` stand-in for the server's `/v1/executions` surface
// (EXECUTION-STATE.md §7) plus the two `/v1/nodes` doors the controller
// completion uses (GET one node, POST a CAS put_node batch). It is driven by
// the CLIENT's own execution engine (lib/shell/execution-store.js
// localExecutionEngine) over a scratch home with a fixed tenant, one engine
// per bearer token so the worker principal is derived from the identity the
// way the real server does it — never from the body.
//
// The oracle a test reads is `requests` (method, path, body, bearer) — what
// the client actually sent — and the state files under `home`. Knobs:
//   down       refuse connections (a partition): the socket is destroyed
//   unserved   answer 404 with no error envelope on every /v1/executions route
//              (a front door with no such route)
//   unservedEnveloped  answer the server router's own route-miss — 404 with
//              the standard envelope `not_found: no such route` (an older
//              server that does not serve the surface)
//   unavailable answer 503 unavailable (a server with no store configured)
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const executionStore = require("../../lib/shell/execution-store.js");

const STATUS_BY_CODE = {
  not_found: 404,
  invalid_node: 422,
  invalid_event: 422,
  unknown_gate: 422,
  unavailable: 503,
  conflict: 409,
  already_owned: 409,
  lease_live: 409,
  fence_stale: 409,
  not_owned: 409,
  lease_expired: 409,
  execution_terminal: 409,
  execution_open: 409,
  boundary_not_reached: 409,
  candidate_conflict: 409,
  no_candidate: 409,
  gates_unsettled: 409,
};

function gitBlobSha(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), "utf8");
  return crypto.createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");
}

async function startFakeExecutionServer({ tenant = "acme", nodes = {}, workers = { "tok-a": "agent-a", "tok-b": "agent-b" }, now = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spor-fake-exec-"));
  const state = {
    home,
    tenant,
    nodes: new Map(Object.entries(nodes)),
    requests: [],
    down: false,
    unserved: false,
    unservedEnveloped: false,
    unavailable: false,
    engines: new Map(),
  };
  const engineFor = (bearer, machine = null) => {
    const worker = workers[bearer] || `unknown-${bearer}`;
    const key = JSON.stringify([worker, machine]);
    if (!state.engines.has(key)) {
      state.engines.set(
        key,
        executionStore.localExecutionEngine({
          home,
          tenant,
          worker,
          machine,
          now: now || (() => new Date().toISOString()),
          pinRead: (id) => (state.nodes.has(id) ? { revision: gitBlobSha(state.nodes.get(id)), repo: "spor" } : null),
        })
      );
    }
    return state.engines.get(key);
  };
  const reply = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const answer = (res, r) => {
    if (r && r.ok) return reply(res, 200, r);
    const code = (r && r.code) || "internal";
    return reply(res, STATUS_BY_CODE[code] || 500, { error: { code, message: (r && r.message) || code, ...(r && r.holder ? { holder: r.holder } : {}), ...(r && r.execution ? { execution: r.execution } : {}) } });
  };

  const server = http.createServer((req, res) => {
    if (state.down) {
      req.socket.destroy();
      return;
    }
    let chunks = "";
    req.on("data", (c) => (chunks += c));
    req.on("end", async () => {
      const url = new URL(req.url, "http://x");
      const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      let body = null;
      if (chunks) {
        try {
          body = JSON.parse(chunks);
        } catch {
          body = { _unparseable: chunks };
        }
      }
      state.requests.push({ method: req.method, path: url.pathname + url.search, body, bearer });
      const p = url.pathname;
      try {
        if (req.method === "GET" && p === "/v1/schema") return reply(res, 200, require("../../lib/graph.js").seedRegistry().snapshot());
        if (p.startsWith("/v1/executions")) {
          if (state.unserved) return reply(res, 404, { message: "Route not found" });
          if (state.unservedEnveloped) return reply(res, 404, { error: { code: "not_found", message: "no such route", details: [] } });
          if (state.unavailable) return answer(res, { ok: false, code: "unavailable", message: "the execution store is not configured on this server" });
          const eng = engineFor(bearer, body?.machine ?? null);
          const m = /^\/v1\/executions\/([^/]+)(?:\/(claim|renew|release|events))?$/.exec(p);
          if (req.method === "POST" && p === "/v1/executions") {
            // The server pins at open and refuses an item or factory it cannot
            // read (server/executions.js pinDefinition) — a served `not_found`
            // names the node, which is how it differs from a route miss.
            if (body && body.node_id && !state.nodes.has(String(body.node_id))) return answer(res, { ok: false, code: "not_found", message: `no such work item '${body.node_id}'` });
            if (body && body.factory && !state.nodes.has(String(body.factory))) return answer(res, { ok: false, code: "not_found", message: `no such factory '${body.factory}'` });
            return answer(res, await eng.open({ node_id: body && body.node_id, factory: body && body.factory, gates: body && body.gates, boundary: body && body.boundary, repo: body && body.repo, machine: body && body.machine, ttl_ms: body && body.ttl_ms }));
          }
          if (req.method === "GET" && p === "/v1/executions") {
            return answer(res, await eng.list({ node_id: url.searchParams.get("node_id"), stage: url.searchParams.get("stage"), limit: url.searchParams.get("limit") || 50 }));
          }
          if (m && req.method === "GET" && !m[2]) return answer(res, await eng.get(decodeURIComponent(m[1])));
          if (m && req.method === "GET" && m[2] === "events") return answer(res, await eng.events(decodeURIComponent(m[1]), { limit: url.searchParams.get("limit") || 500 }));
          if (m && req.method === "POST" && m[2] === "claim") return answer(res, await eng.claim(decodeURIComponent(m[1]), { takeover: !!(body && body.takeover), ttl_ms: body && body.ttl_ms, machine: body && body.machine }));
          if (m && req.method === "POST" && m[2] === "renew") return answer(res, await eng.renew(decodeURIComponent(m[1]), { fence: body && body.fence, ttl_ms: body && body.ttl_ms }));
          if (m && req.method === "POST" && m[2] === "release") return answer(res, await eng.release(decodeURIComponent(m[1]), { fence: body && body.fence }));
          if (m && req.method === "POST" && m[2] === "events") return answer(res, await eng.event(decodeURIComponent(m[1]), { fence: body && body.fence, event: body && body.event }));
          return reply(res, 404, { error: { code: "not_found", message: "no such route" } });
        }
        const n = /^\/v1\/nodes\/([^/]+)$/.exec(p);
        if (req.method === "GET" && n) {
          const id = decodeURIComponent(n[1]);
          if (!state.nodes.has(id)) return reply(res, 404, { error: { code: "not_found", message: `no such node: ${id}` } });
          const raw = state.nodes.get(id);
          return reply(res, 200, { id, raw, revision: gitBlobSha(raw), resolution: null });
        }
        if (req.method === "POST" && p === "/v1/nodes") {
          const results = [];
          for (const entry of (body && body.nodes) || []) {
            const idm = /^id:\s*(\S+)/m.exec(String(entry.node || ""));
            const id = idm ? idm[1] : null;
            if (!id) {
              results.push({ ok: false, code: "invalid_node", message: "no id" });
              continue;
            }
            const exists = state.nodes.has(id);
            if (exists && entry.if_exists === "skip") {
              results.push({ ok: true, status: "skipped", id, revision: gitBlobSha(state.nodes.get(id)) });
              continue;
            }
            if (exists && entry.if_exists === "update" && entry.revision && entry.revision !== gitBlobSha(state.nodes.get(id))) {
              results.push({ ok: false, code: "conflict", message: `stale revision for '${id}'; re-read and retry`, revision: gitBlobSha(state.nodes.get(id)) });
              continue;
            }
            state.nodes.set(id, String(entry.node));
            results.push({ ok: true, status: exists ? "updated" : "created", id, revision: gitBlobSha(String(entry.node)) });
          }
          return reply(res, results.every((r) => r.ok) ? 200 : 207, { results });
        }
        return reply(res, 404, { error: { code: "not_found", message: "no such route" } });
      } catch (e) {
        return reply(res, 500, { error: { code: "internal", message: String((e && e.message) || e) } });
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    state,
    port,
    base: `http://127.0.0.1:${port}`,
    // Force a lease into the past so a takeover by another worker succeeds.
    expireLease(executionId) {
      const rec = executionStore.readRecord(home, tenant, executionId);
      if (rec && rec.owner) {
        rec.owner.lease_expires_at = new Date(Date.now() - 1000).toISOString();
        executionStore.writeRecord(home, tenant, rec, { type: "ownership.changed", execution_id: executionId, owner: rec.owner, at: rec.updated_at, seq: rec.seq });
      }
    },
    record: (id) => executionStore.readRecord(home, tenant, id),
    events: (id) => executionStore.readEvents(home, tenant, id),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

module.exports = { startFakeExecutionServer, gitBlobSha };

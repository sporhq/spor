// stub-spor-server.js — a zero-dep node:http stand-in for the Spor server's
// dual-mode READ routes, answering over a LOCAL fixture graph with the client's
// own kernels (task-spor-local-remote-single-renderer-conformance).
//
// The point is the mode-parity diff (test/mode-parity.test.js): run a verb in
// local mode over a fixture graph, run it again in remote mode against this stub
// serving the SAME graph, and require identical output. The stub computes each
// envelope the way the server's handler does — same query-param parsing and
// clamps, same canonical shaping helpers (lib/kernel/queue.js
// shapeQueueEnvelope, lib/kernel/graph.js unknownProjectWarning), same additive
// server-only fields — so what the diff exercises is everything BETWEEN the
// envelope and the terminal: flag forwarding, paging assembly, warning
// lifting, and the renderer. Those are exactly where the documented mirrors
// drifted (a readiness flag never forwarded, a counts line one arm never
// printed, a warning one arm swallowed). Each route cites the server handler it
// models; when that handler's shape moves, this moves with it.
//
// Never the live graph: it reads only the nodes dir it is handed.

const http = require("node:http");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const graphLib = require(path.join(ROOT, "lib", "graph.js"));
const queueLib = require(path.join(ROOT, "lib", "queue.js"));
const analyticsLib = require(path.join(ROOT, "lib", "analytics.js"));

// server/rest.js
const QUEUE_MAX_LIMIT = 100;
const QUEUE_DEFAULT_LIMIT = 20;
// server/rest-fastify.ts's queue handler: the readiness enum it validates
const READINESS_VALUES = new Set(["agent", "human", "untriaged"]);
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
const bad = (res, message) => send(res, 422, { error: { code: "invalid_node", message } });

// startStubServer({ nodesDir }) -> Promise<{ base, requests, close }>.
// `requests` records every path+query the client sent, for assertions on what
// was forwarded.
function startStubServer({ nodesDir }) {
  const requests = [];
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, "http://stub");
    requests.push(url.pathname + url.search);
    // Reloaded per request, like a server whose graph is the source of truth.
    const g = graphLib.loadGraph(nodesDir);
    const sp = url.searchParams;
    const project = sp.get("project");
    if (project && !SLUG_RE.test(project)) return bad(res, `bad project slug '${project}'`);
    const types = (key) => {
      const out = [];
      for (const raw of sp.getAll(key).flatMap((v) => v.split(","))) {
        const s = raw.trim();
        if (s) out.push(s);
      }
      return out.length ? out : null;
    };

    if (req.method === "GET" && url.pathname === "/v1/queue") {
      // server/rest-fastify.ts `queue` + server/shapes.js shapeQueuePage.
      const limit = Math.min(QUEUE_MAX_LIMIT, Math.max(1, Number(sp.get("limit")) || QUEUE_DEFAULT_LIMIT));
      const offset = Math.max(0, Math.floor(Number(sp.get("offset")) || 0));
      const readiness = types("readiness");
      for (const v of readiness || []) {
        if (!READINESS_VALUES.has(v)) return bad(res, `bad readiness value '${v}' (must be one of ${[...READINESS_VALUES].join(", ")})`);
      }
      // No viewer (the stub's token binds no person) and the same git-derived
      // front/timestamps local mode reads off the same directory, standing in
      // for the server's request-log write activity.
      const r = queueLib.rankQueue(g, {
        project: project || null,
        includeTypes: types("type"),
        excludeTypes: types("exclude_type"),
        readiness,
        limit: Infinity,
        front: queueLib.gitFront(path.dirname(nodesDir), path.basename(nodesDir), 7),
        frontDays: 7,
        timestamps: g.timestamps,
      });
      const envelope = queueLib.shapeQueueEnvelope(r, {
        offset,
        limit,
        projectWarning: graphLib.unknownProjectWarning(g, project, "queue"),
      });
      // The server-only routing lists (SERVER_ONLY_QUEUE_FIELDS), present so the
      // parity diff proves it sets exactly these aside and nothing else.
      return send(res, 200, {
        ...envelope,
        awaiting_you: [],
        questions: [],
        asked: [],
        findings: [],
        pending: [],
        reviews: [],
        generated_at: new Date().toISOString(),
      });
    }

    if (req.method === "GET" && url.pathname === "/v1/analytics") {
      // server/rest-fastify.ts `analytics`: clamped window ints, the report plus
      // the additive project_warning.
      const intParam = (key, min, max) => {
        const v = sp.get(key);
        if (v == null) return undefined;
        const n = Math.floor(Number(v));
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
      };
      let inScope = null;
      if (project) {
        const scope = graphLib.scopeFor(g, project);
        inScope = (node) => scope.has(graphLib.resolveProject(g, node.project));
      }
      const report = analyticsLib.analyze(g, {
        weeks: intParam("weeks", 1, 52) ?? 12,
        topN: intParam("top", 1, 100) ?? 10,
        agingDays: intParam("aging", 1, 365) ?? 30,
        types: types("type"),
        inScope,
      });
      const projectWarning = graphLib.unknownProjectWarning(g, project, "analytics");
      return send(res, 200, projectWarning ? { ...report, project_warning: projectWarning } : report);
    }

    send(res, 404, { error: { code: "not_found", message: `stub has no route ${url.pathname}` } });
  });
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () =>
      resolve({
        base: `http://127.0.0.1:${srv.address().port}`,
        requests,
        close: () => new Promise((r) => srv.close(r)),
      })
    )
  );
}

module.exports = { startStubServer };

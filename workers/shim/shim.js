#!/usr/bin/env node
// workers/shim/shim.js — the bootstrap worker for the workflow-run
// claim/complete API (API.md §3.1).
//
// A small, standalone, ZERO-DEP Node program. It is NOT a server feature: the
// Spor server never executes effects (no shell, no outbound HTTP from the
// engine). Execution lives here, at arm's length, in a separate process that
// claims OUR steps over the REST claim API and runs them by spawning a mapped
// argv. The reference production mapping points that argv at the unmodified
// `swamp` CLI (see README) — but the shim knows nothing about swamp: the
// capability -> argv mapping lives in THIS program's config file, never in a
// workflow node, so the graph never learns swamp vocabulary and swapping the
// shim for purpose-built workers touches zero graph data (§4).
//
// The loop (API.md §3.1):
//   GET  /v1/work?capability=<our caps>      -> claimable steps across live runs
//   POST /v1/runs/{id}/steps/{sid}/claim     -> a lease (identity-stamped, TTL)
//   spawn the mapped argv (execFile — argv array, NEVER a shell string) with the
//     step inputs as JSON on stdin and SPOR_STEP env carrying the step json
//   exit 0  -> parse stdout as JSON result (fall back to {output:<raw>}),
//              complete succeeded
//   exit !0 -> complete failed, result carries a stderr tail
//   POST /v1/runs/{id}/steps/{sid}/complete  -> report the verdict
//
// Lease honesty / at-least-once: if execution overruns the lease TTL the server
// may already have returned the step to `ready`. We still ATTEMPT the complete;
// a 409 lease_expired is a logged no-op (Spor promises at-least-once
// dispatch, not exactly-once execution — workers must guard their own effects).
//
// Clean shutdown on SIGINT/SIGTERM: stop polling, let an in-flight step finish
// its complete attempt, then exit.

"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const { URL } = require("url");
const { execFile } = require("child_process");

// ---------------- config ----------------
// {
//   "server":  "http://127.0.0.1:8787",
//   "token":   "sub_pat_…",
//   "poll_ms": 500,
//   "capabilities": {
//     "deploy": { "argv": ["swamp", "model", "x", "method", "run"], "timeout_ms": 600000 },
//     "ci":     { "argv": ["/bin/echo", "{\"ok\":true}"] }
//   }
// }
function loadConfig(p) {
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (e) {
    die(`cannot read config '${p}': ${e.message}`);
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    die(`config '${p}' is not valid JSON: ${e.message}`);
  }
  if (!cfg.server) die("config.server is required");
  if (!cfg.token) die("config.token is required");
  if (!cfg.capabilities || typeof cfg.capabilities !== "object") {
    die("config.capabilities map is required");
  }
  for (const [cap, spec] of Object.entries(cfg.capabilities)) {
    if (!spec || !Array.isArray(spec.argv) || spec.argv.length === 0) {
      die(`capability '${cap}' must map to { argv: [cmd, ...args] }`);
    }
  }
  cfg.poll_ms = Number(cfg.poll_ms) > 0 ? Number(cfg.poll_ms) : 1000;
  return cfg;
}

function die(msg) {
  process.stderr.write(`shim: ${msg}\n`);
  process.exit(2);
}

function log(...args) {
  process.stdout.write(`[shim ${new Date().toISOString()}] ${args.join(" ")}\n`);
}

// ---------------- HTTP (zero-dep, token-bearing JSON) ----------------

function request(cfg, method, pathAndQuery, body) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(pathAndQuery, cfg.server);
    } catch (e) {
      return reject(e);
    }
    const mod = u.protocol === "https:" ? https : http;
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { Authorization: `Bearer ${cfg.token}` };
    if (payload) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(payload.length);
    }
    const req = mod.request(
      u,
      { method, headers, timeout: 35000 },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          if (text) {
            try {
              json = JSON.parse(text);
            } catch {
              /* leave json null — non-JSON body */
            }
          }
          resolve({ status: res.statusCode, json, text });
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------------- step execution ----------------

// Spawn the mapped argv for a work item. Step inputs go in as JSON on stdin;
// the full work item rides along as SPOR_STEP in the env (so a wrapper can
// read run_id / step / capability without parsing argv). Resolves to
// { status, result } — never rejects: an exec error is a failed step, not a
// shim crash.
function executeStep(spec, item) {
  return new Promise((resolve) => {
    const [cmd, ...args] = spec.argv;
    const timeout = Number(spec.timeout_ms) > 0 ? Number(spec.timeout_ms) : 15 * 60 * 1000;
    const child = execFile(
      cmd,
      args,
      {
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, SPOR_STEP: JSON.stringify(item) },
      },
      (err, stdout, stderr) => {
        // The log tail (stderr, with a little stdout context) is debug evidence:
        // it belongs in the run-keyed journal via the complete `log` field
        // (API.md §3.1), NOT on the run node — only the small
        // `result` lands there. We send it on success AND failure.
        const logTail = tailLines(
          [String(stderr || "").trim(), String(stdout || "").trim()].filter(Boolean).join("\n--- stdout ---\n"),
          40
        );
        if (err) {
          // nonzero exit, spawn failure, or timeout (err.killed).
          resolve({
            status: "failed",
            result: {
              error: err.killed ? "timeout" : "nonzero_exit",
              code: typeof err.code === "number" ? err.code : null,
            },
            log: logTail || (err.message ? tailLines(String(err.message), 40) : ""),
          });
          return;
        }
        const raw = String(stdout || "").trim();
        let result;
        if (raw === "") {
          result = { output: "" };
        } else {
          try {
            result = JSON.parse(raw);
          } catch {
            result = { output: raw };
          }
        }
        resolve({ status: "succeeded", result, log: logTail });
      }
    );
    // Feed step inputs to the child on stdin as JSON.
    try {
      child.stdin.write(JSON.stringify(item.inputs || {}));
      child.stdin.end();
    } catch {
      /* child may have died immediately; the exec callback handles it */
    }
  });
}

function tailLines(s, n) {
  const lines = s.split("\n");
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

// ---------------- claim / complete ----------------

async function claim(cfg, item) {
  const body = item.iteration != null ? { iteration: item.iteration } : {};
  const res = await request(
    cfg,
    "POST",
    `/v1/runs/${item.run_id}/steps/${item.step}/claim`,
    body
  );
  if (res.status === 200 && res.json && res.json.lease) {
    return res.json.lease; // { generation, expires_at, claimant, at }
  }
  // 409 (already claimed / not ready / lease race) — someone else got it, or
  // the step advanced. Not our error; skip this item.
  return null;
}

async function complete(cfg, item, lease, outcome) {
  const body = {
    lease: lease.generation,
    status: outcome.status,
    result: outcome.result,
  };
  // The worker log tail rides the complete into the run-keyed journal (the §9
  // run store's stand-in in step 1) — kept off the run node deliberately.
  if (outcome.log) body.log = outcome.log;
  if (item.iteration != null) body.iteration = item.iteration;
  const res = await request(
    cfg,
    "POST",
    `/v1/runs/${item.run_id}/steps/${item.step}/complete`,
    body
  );
  if (res.status === 200) return { ok: true };
  // Lease overran the TTL and the step was reclaimed/expired: at-least-once
  // semantics — log and move on, do NOT crash or retry the effect.
  const code = res.json && res.json.error && res.json.error.code;
  if (res.status === 409 && code === "lease_expired") {
    log(`complete ${item.run_id}/${item.step}: lease_expired (already expired) — no-op`);
    return { ok: false, expired: true };
  }
  log(
    `complete ${item.run_id}/${item.step}: unexpected ${res.status} ` +
      `${code || (res.text || "").slice(0, 120)}`
  );
  return { ok: false };
}

// ---------------- main loop ----------------

let running = true;
let inFlight = false;

async function tick(cfg) {
  const caps = Object.keys(cfg.capabilities).join(",");
  const res = await request(cfg, "GET", `/v1/work?capability=${encodeURIComponent(caps)}`);
  if (res.status !== 200 || !res.json || !Array.isArray(res.json.work)) {
    if (res.status !== 200) log(`/v1/work -> ${res.status}`);
    return;
  }
  for (const item of res.json.work) {
    if (!running) break;
    const spec = cfg.capabilities[item.capability];
    if (!spec) continue; // not ours (defensive — we asked for our caps only)

    inFlight = true;
    try {
      const lease = await claim(cfg, item);
      if (!lease) continue; // lost the race / not ready
      log(`claimed ${item.run_id}/${item.step} (cap=${item.capability}, gen=${lease.generation})`);
      const outcome = await executeStep(spec, item);
      await complete(cfg, item, lease, outcome);
      log(`completed ${item.run_id}/${item.step} -> ${outcome.status}`);
    } catch (e) {
      log(`error handling ${item.run_id}/${item.step}: ${e.message}`);
    } finally {
      inFlight = false;
    }
  }
}

async function main() {
  const configPath = process.argv[2] || process.env.SHIM_CONFIG;
  if (!configPath) die("usage: node shim.js <config.json>  (or set SHIM_CONFIG)");
  const cfg = loadConfig(configPath);

  log(
    `starting: server=${cfg.server} caps=[${Object.keys(cfg.capabilities).join(", ")}] ` +
      `poll=${cfg.poll_ms}ms`
  );

  const shutdown = (sig) => {
    if (!running) return;
    log(`${sig} received — draining`);
    running = false;
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  while (running) {
    try {
      await tick(cfg);
    } catch (e) {
      log(`poll error: ${e.message}`);
    }
    if (!running) break;
    await sleep(cfg.poll_ms);
  }

  // Let an in-flight complete finish before exiting (best effort).
  let waited = 0;
  while (inFlight && waited < 30000) {
    await sleep(50);
    waited += 50;
  }
  log("stopped");
  process.exit(0);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  process.stderr.write(`shim: fatal ${e && e.stack ? e.stack : e}\n`);
  process.exit(1);
});

"use strict";
// anthropic-call: one raw Anthropic Messages API call over node `https`, the
// cheap default backend for the digest-intent classifier
// (task-spor-digest-intent-cheap-default-backend). `claude -p` spends ~98% of
// its ~$0.08 on CLI session boot around a 4.6KB prompt and a one-word answer;
// this is the same classification as one small request.
//
// Run as a CHILD of util.js's runClassifierBackend so the (synchronous)
// classifier contract stays unchanged: prompt on stdin, one JSON line on
// stdout `{text, usage, model}`, non-zero exit on any failure. Zero deps.
//
//   SPOR_ANTHROPIC_KEY=<key> [SPOR_ANTHROPIC_MODEL=…] [ANTHROPIC_BASE_URL=…] \
//     node anthropic-call.js < prompt

const http = require("http");
const https = require("https");
const tls = require("tls");

// Its own bound, independent of the caller's (digest.intentTimeoutMs may be 0):
// a hung connection can never outlive this.
const REQUEST_TIMEOUT_MS = Number(process.env.SPOR_ANTHROPIC_TIMEOUT_MS) > 0 ? Number(process.env.SPOR_ANTHROPIC_TIMEOUT_MS) : 30000;

function fail(msg) {
  process.stderr.write(`anthropic-call: ${msg}\n`);
  process.exit(1);
}

// HTTPS_PROXY support: CONNECT tunnel, then TLS to the API over the tunnel.
// Plain-http targets (a local fake) go direct. A proxy we cannot use FAILS
// loudly — never a silent direct connection around a mandated proxy.
function proxyFor(base) {
  if (base.protocol !== "https:") return null;
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!raw) return null;
  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (noProxy.some((h) => h === "*" || base.hostname === h.replace(/^\./, "") || base.hostname.endsWith("." + h.replace(/^\./, "")))) return null;
  let u;
  try {
    u = new URL(raw.includes("://") ? raw : `http://${raw}`);
  } catch {
    fail(`unusable HTTPS_PROXY`);
  }
  if (u.protocol !== "http:") fail(`unsupported HTTPS_PROXY scheme ${u.protocol}`);
  return u;
}

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

function main() {
  const key = process.env.SPOR_ANTHROPIC_KEY;
  if (!key) {
    process.stderr.write("anthropic-call: no key\n");
    process.exit(2);
  }
  let prompt = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (prompt += c));
  process.stdin.on("end", () => {
    const base = new URL(process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com");
    const body = JSON.stringify({
      model: process.env.SPOR_ANTHROPIC_MODEL || DEFAULT_MODEL,
      max_tokens: 16,
      messages: [{ role: "user", content: prompt }],
    });
    const mod = base.protocol === "http:" ? http : https;
    const opts = {
      protocol: base.protocol,
      hostname: base.hostname,
      port: base.port || undefined,
      path: `${base.pathname.replace(/\/+$/, "")}/v1/messages`,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
    };
    setTimeout(() => fail(`timed out after ${REQUEST_TIMEOUT_MS}ms`), REQUEST_TIMEOUT_MS);
    const proxy = proxyFor(base);
    if (!proxy) return send(mod, opts, body);
    const target = `${base.hostname}:${base.port || 443}`;
    const pheaders = { host: target };
    if (proxy.username) {
      pheaders["proxy-authorization"] =
        "Basic " + Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64");
    }
    const creq = http.request({ hostname: proxy.hostname, port: proxy.port || 80, method: "CONNECT", path: target, headers: pheaders });
    creq.on("error", (e) => fail(`proxy: ${e.message}`));
    creq.on("connect", (cres, socket) => {
      if (cres.statusCode !== 200) fail(`proxy CONNECT refused: HTTP ${cres.statusCode}`);
      const tlsSock = tls.connect({ socket, servername: base.hostname });
      tlsSock.on("error", (e) => fail(`tls: ${e.message}`));
      send(mod, { ...opts, createConnection: () => tlsSock, agent: false }, body);
    });
    creq.end();
  });
}

function send(mod, opts, body) {
  {
    const req = mod.request(
      opts,
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            process.stderr.write(`anthropic-call: HTTP ${res.statusCode}: ${raw.slice(0, 300)}\n`);
            process.exit(1);
          }
          try {
            const j = JSON.parse(raw);
            const text = (j.content || []).filter((b) => b && b.type === "text").map((b) => b.text).join("");
            process.stdout.write(JSON.stringify({ text, usage: j.usage || null, model: j.model || null }) + "\n");
            process.exit(0);
          } catch (e) {
            process.stderr.write(`anthropic-call: bad response: ${e.message}\n`);
            process.exit(1);
          }
        });
      }
    );
    req.on("error", (e) => fail(e.message));
    req.end(body);
  }
}

main();

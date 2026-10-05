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
// The key rides stdin, never the environment (a child's env is readable via
// /proc and inherited by anything it spawns): the FIRST line is the key, the
// rest is the prompt.
//
//   [SPOR_ANTHROPIC_MODEL=…] [ANTHROPIC_BASE_URL=…] node anthropic-call.js \
//     < "<key>\n<prompt>"

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

// A plaintext http base would put the key on the wire and skip HTTPS_PROXY, so
// only a loopback http base (a local fake / gateway) is allowed.
function isLoopback(host) {
  return host === "localhost" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

function main() {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (input += c));
  process.stdin.on("end", () => {
    const nl = input.indexOf("\n");
    const key = nl < 0 ? input.trim() : input.slice(0, nl).trim();
    const prompt = nl < 0 ? "" : input.slice(nl + 1);
    if (!key) {
      process.stderr.write("anthropic-call: no key\n");
      process.exit(2);
    }
    let base;
    try {
      base = new URL(process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com");
    } catch {
      return fail("unusable ANTHROPIC_BASE_URL");
    }
    if (base.protocol !== "https:" && !(base.protocol === "http:" && isLoopback(base.hostname))) {
      return fail("refusing ANTHROPIC_BASE_URL: only https, or http to a loopback host, may carry the key");
    }
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
            // Status + the API's own error class only: the body is
            // endpoint-controlled and a misbehaving one can echo request
            // headers (the key) back, and this line lands in journal/llm-calls.
            let cls = "";
            try {
              const t = JSON.parse(raw).error.type;
              if (typeof t === "string" && /^[a-z_]{1,64}$/.test(t)) cls = ` ${t}`;
            } catch {}
            process.stderr.write(`anthropic-call: HTTP ${res.statusCode}${cls}\n`);
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
    req.on("error", (e) => fail(e.code || "request error"));
    req.end(body);
  }
}

main();

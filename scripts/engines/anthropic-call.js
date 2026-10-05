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
    const req = mod.request(
      {
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
      },
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
    req.on("error", (e) => {
      process.stderr.write(`anthropic-call: ${e.message}\n`);
      process.exit(1);
    });
    req.end(body);
  });
}

main();

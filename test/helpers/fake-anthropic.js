"use strict";
// Zero-dep fake Anthropic Messages API for E2E tests (task-spor-e2e-integration-tests).
//
// Drives the REAL `claude` binary offline: claude honors ANTHROPIC_BASE_URL (+ a dummy
// ANTHROPIC_API_KEY), ALWAYS streams (so SSE is mandatory, not optional), and the only
// endpoint it calls is POST /v1/messages (no count_tokens). This server captures every
// request body — the regression oracle: hook-injected `additionalContext` (briefing,
// digest, nudge) lands in the next request's `messages`, and a new claude version that
// breaks the hook contract surfaces as a change there. It serves matcher-scripted SSE
// responses and returns ONLY clean 200s (a 429/5xx would trip claude's exponential
// backoff and make tests slow/flaky).
//
// node builtins only — this module is imported by spor-server's remote-mode E2E tier
// (task-spor-server-e2e-remote-mode-tier) via the sibling spor checkout, so it must not
// depend on node:test or anything outside the public client surface.

const http = require("http");

// --- SSE encoder: the documented Messages streaming event contract. Wrong order or
// shape stalls claude's stream parser, so this encoder is itself a regression surface —
// keep it pinned to the spec; when a new claude version tightens parsing and a test
// breaks here, that IS the signal. ---
function writeEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// Stream one assistant message. `blocks` is an ordered list of content blocks:
//   { type: "text", text }
//   { type: "tool_use", id, name, input }   (framed via input_json_delta)
// `stopReason` is "end_turn" | "tool_use" | ...
function streamMessage(res, { model, blocks, stopReason, usage }) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  writeEvent(res, "message_start", {
    type: "message_start",
    message: {
      id: "msg_fake",
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
  blocks.forEach((b, i) => {
    if (b.type === "text") {
      writeEvent(res, "content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } });
      writeEvent(res, "content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: b.text } });
      writeEvent(res, "content_block_stop", { type: "content_block_stop", index: i });
    } else if (b.type === "tool_use") {
      writeEvent(res, "content_block_start", {
        type: "content_block_start",
        index: i,
        content_block: { type: "tool_use", id: b.id, name: b.name, input: {} },
      });
      // The tool input streams as a JSON string in input_json_delta deltas; one chunk is
      // a legal stream (claude reassembles partial_json across deltas).
      writeEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index: i,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input ?? {}) },
      });
      writeEvent(res, "content_block_stop", { type: "content_block_stop", index: i });
    }
  });
  writeEvent(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: usage ?? { output_tokens: 10 },
  });
  writeEvent(res, "message_stop", { type: "message_stop" });
  res.end();
}

// Normalize a handler's return into stream-message input. Shorthands:
//   "hi"                              -> one text block, end_turn
//   { text: "hi" }                    -> one text block, end_turn
//   { tool: { name, input, id? } }    -> one tool_use block, stop_reason tool_use
//   { blocks: [...], stopReason }     -> explicit
function specToMessage(spec, model) {
  if (typeof spec === "string") return { model, blocks: [{ type: "text", text: spec }], stopReason: "end_turn" };
  if (spec && spec.blocks) return { model, blocks: spec.blocks, stopReason: spec.stopReason || "end_turn", usage: spec.usage };
  if (spec && spec.tool) {
    const t = spec.tool;
    return {
      model,
      blocks: [{ type: "tool_use", id: t.id || "toolu_fake", name: t.name, input: t.input || {} }],
      stopReason: "tool_use",
      usage: spec.usage,
    };
  }
  return { model, blocks: [{ type: "text", text: (spec && spec.text) ?? "ok" }], stopReason: (spec && spec.stopReason) || "end_turn", usage: spec && spec.usage };
}

// Start the fake. Resolves to { url, port, requests, close }.
//   handler(requestBody, requests) -> spec   (matcher-based — see specToMessage)
// `requests` is the LIVE array of captured { url, method, headers, body }, where `body`
// is the parsed JSON request (model, system, messages, tools, ...). Matcher scripting
// (inspect the request, not a fixed sequence) is robust to claude's retries and to extra
// probe calls a new version might add.
function startFakeAnthropic(opts = {}) {
  const handler = opts.handler || (() => ({ text: "ok" }));
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        /* non-JSON probe */
      }
      requests.push({ url: req.url, method: req.method, headers: req.headers, body });
      // claude only ever POSTs /v1/messages; answer any other probe (a base-URL
      // connectivity check, etc.) with a benign 200 so nothing triggers retries/backoff.
      if (!(req.method === "POST" && req.url.startsWith("/v1/messages"))) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }
      let spec;
      try {
        spec = handler(body, requests);
      } catch {
        spec = { text: "handler-error" };
      }
      streamMessage(res, specToMessage(spec, (body && body.model) || "claude-fake"));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// --- Oracle helpers: extract what the hooks injected from a captured request. claude
// carries hook additionalContext as <system-reminder> blocks INSIDE user messages (not
// the top-level `system` field), so the oracle scans message text. ---
function messageText(body) {
  if (!body || !Array.isArray(body.messages)) return "";
  const parts = [];
  for (const m of body.messages) {
    if (typeof m.content === "string") {
      parts.push(m.content);
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (!b) continue;
        if (b.type === "text") parts.push(b.text);
        else if (b.type === "tool_result") {
          if (typeof b.content === "string") parts.push(b.content);
          else if (Array.isArray(b.content)) for (const c of b.content) if (c && c.type === "text") parts.push(c.text);
        }
      }
    }
  }
  return parts.join("\n");
}

// All injected user-message text across every captured /v1/messages request, joined.
function allInjectedText(requests) {
  return requests
    .filter((r) => r.body && Array.isArray(r.body.messages))
    .map((r) => messageText(r.body))
    .join("\n----\n");
}

// Tool names claude advertised in a request (it re-sends its tool set each turn).
function toolNames(body) {
  return Array.isArray(body && body.tools) ? body.tools.map((t) => t.name) : [];
}

// Has any message in this request carried a tool_result yet? (matcher input that
// distinguishes a first turn from a post-tool follow-up turn).
function hasToolResult(body) {
  return JSON.stringify((body && body.messages) || []).includes('"tool_result"');
}

module.exports = {
  startFakeAnthropic,
  streamMessage,
  specToMessage,
  messageText,
  allInjectedText,
  toolNames,
  hasToolResult,
};

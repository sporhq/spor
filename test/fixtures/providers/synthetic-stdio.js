"use strict";
// The synthetic provider in a CHILD PROCESS, speaking the contract's envelopes
// as newline-delimited JSON on stdin/stdout (task-spor-execution-provider-
// conformance-suite). It proves the conformance runner drives a provider
// across a process boundary exactly as it drives an in-process one.
//
// This is deliberately the bare envelope stream, not the stdio BINDING
// (lib/shell/providers/stdio.js: the version handshake, the
// dispatch.provider.<id> declaration, lost-on-crash). Its `fixture.*` control
// ops ride outside the contract, which the binding refuses to send, and its
// crash marks ONE environment lost while the process lives on — a different
// crash than the binding's process kill. The binding is proven against the
// stdio-echo example in test/provider-stdio.test.js.
//
// Run as a script it is the provider: `node synthetic-stdio.js
// [--broken-idempotency]`. Three test-only ops ride the same stream outside the
// contract: `fixture.crash {handle}`, `fixture.environments {}` and
// `fixture.credential {handle}`.
// Required as a module it exports startSyntheticStdio() -> {provider, driver,
// close}.

const { spawn } = require("node:child_process");
const readline = require("node:readline");
const { syntheticDriver } = require("./synthetic");

if (require.main === module) {
  const { createSyntheticImpl } = require("./synthetic");
  const { bindInProcess } = require("../../../lib/shell/provider-conformance");
  const impl = createSyntheticImpl({ brokenIdempotency: process.argv.includes("--broken-idempotency") });
  const provider = bindInProcess(impl);
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify({ contract_version: 1, id: "unknown", ok: false, error: { code: "invalid_request", message: "not JSON", retryable: false } })}\n`);
      return;
    }
    let res;
    if (msg.op === "fixture.crash") {
      impl.fixture.crash(msg.params.handle);
      res = { id: msg.id, ok: true, result: {} };
    } else if (msg.op === "fixture.credential") {
      res = { id: msg.id, ok: true, result: { value: impl.fixture.credential(msg.params.handle) } };
    } else if (msg.op === "fixture.environments") {
      res = { id: msg.id, ok: true, result: { count: impl.fixture.environments() } };
    } else {
      res = await provider.request(msg);
    }
    process.stdout.write(`${JSON.stringify(res)}\n`);
  });
  rl.on("close", () => process.exit(0));
}

function startSyntheticStdio({ args = [] } = {}) {
  const child = spawn(process.execPath, [__filename, ...args], { stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map();
  let exited = null;
  const rl = readline.createInterface({ input: child.stdout });
  const rejectAll = (err) => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  rl.on("line", (line) => {
    let res;
    try {
      res = JSON.parse(line);
    } catch {
      rejectAll(new Error(`synthetic-stdio wrote a non-JSON line: ${line.slice(0, 200)}`));
      return;
    }
    const p = pending.get(res && res.id);
    if (p) {
      pending.delete(res.id);
      p.resolve(res);
    } else {
      rejectAll(new Error(`synthetic-stdio answered an unknown request id ${JSON.stringify(res && res.id)}`));
    }
  });
  child.on("error", rejectAll);
  child.stdin.on("error", rejectAll);
  child.on("exit", (code, signal) => {
    exited = { code, signal };
    rejectAll(new Error(`synthetic-stdio exited (${code ?? signal}) with a request in flight`));
  });
  let ctl = 0;
  function send(msg) {
    if (exited) return Promise.reject(new Error("synthetic-stdio has exited"));
    return new Promise((resolve, reject) => {
      pending.set(msg.id, { resolve, reject });
      child.stdin.write(`${JSON.stringify(msg)}\n`);
    });
  }
  const control = async (op, params = {}) => (await send({ id: `ctl-${++ctl}`, op, params })).result;
  return {
    provider: { request: send },
    driver: syntheticDriver({
      crash: (handle) => control("fixture.crash", { handle }),
      environments: async () => (await control("fixture.environments")).count,
      credential: async (handle) => (await control("fixture.credential", { handle })).value,
    }),
    close() {
      child.stdin.end();
      return new Promise((resolve) => (exited ? resolve() : child.on("exit", () => resolve())));
    },
  };
}

module.exports = { startSyntheticStdio };

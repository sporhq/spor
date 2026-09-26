// Outer-timeout notice for the suite runner
// (issue-spor-worker-contract-reload-e2e-cancelled-under-load).
//
// When the `node --test` PARENT gets SIGTERM/SIGINT (a caller's timeout: a
// merge gate's `timeout`, the Bash tool's 600s cap on a suite that runs long
// under fleet load), node's runner cancels every file that has not finished
// yet, in flight or never started, and reports each with the same error:
// "Promise resolution is still pending but the event loop has already
// resolved". Files run in alphabetical order, so the victims are always the
// tail of test/ (work-reload-factory-e2e.test.js, worker-contract.test.js).
// That reads as a lifetime bug in those files, and they pass alone because
// nothing kills them there. They were never the cause: both passed 20/20 at
// --test-concurrency=8 under added CPU load.
//
// So the runner parent says so on the way out: which signal, after how long,
// and that the cancelled files were stopped from outside. Loaded with
// `--require` in the npm test script. It only installs in the runner PARENT
// (`--test` in execArgv and no NODE_TEST_CONTEXT). The per-file children get
// NODE_TEST_CONTEXT, and a plain `node file.test.js` has no runner SIGTERM
// handler, so a listener there would swallow the default termination. In the
// parent, node's own termination handler still runs after this one and exits.
// Outside the window where node's handler is installed, the notice re-raises
// the signal itself.

"use strict";

if (process.execArgv.includes("--test") && !process.env.NODE_TEST_CONTEXT) {
  const started = Date.now();
  const notice = (signal) => {
    const secs = Math.round((Date.now() - started) / 1000);
    process.stderr.write(
      `\nspor test runner: received ${signal} after ${secs}s. The suite was stopped from OUTSIDE ` +
        "(a caller's timeout, e.g. a 600s tool cap). Files reported as cancelled with " +
        "'Promise resolution is still pending but the event loop has already resolved' were cut off " +
        "unfinished; that is not a failure of their own. Re-run detached to a log and poll it, or raise the timeout.\n"
    );
    // Node adds its handler only once the runner is set up, after this
    // preload, and removes it at teardown. A signal outside that window finds
    // no other listener. `once` has already removed ours, so re-raising
    // restores the default termination instead of swallowing it.
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  };
  process.once("SIGTERM", () => notice("SIGTERM"));
  process.once("SIGINT", () => notice("SIGINT"));
}

module.exports = {};

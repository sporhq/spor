"use strict";
// abort.js — the one AbortSignal race helper shared by lib/remote.js and the
// hook engines (scripts/engines/util.js).

// `promise`, or null as soon as `signal` aborts (whichever is first). The
// underlying work is left running so e.g. a token refresh still lands in the
// store if it finishes. A rejection resolves null.
function untilAborted(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve) => {
    const onAbort = () => resolve(null);
    if (signal.aborted) {
      promise.catch(() => {}); // abandoned: a later rejection must not go unhandled
      return resolve(null);
    }
    signal.addEventListener("abort", onAbort, { once: true });
    const done = (v) => {
      signal.removeEventListener("abort", onAbort);
      resolve(v);
    };
    promise.then(done, () => done(null));
  });
}

module.exports = { untilAborted };

// kernel/workflow.js — the durable-workflow REPLAY KERNEL: the programming
// model Temporal, Restate and js-wf share, as a zero-dep client module
// (task-spor-gate-pipeline-as-workflow-kernel, step 1 of
// dec-spor-gate-pipeline-durable-workflow-model-zero-dep-kernel-first; promoted
// from spikes/durable-workflow/harness.js, whose proofs now run against this
// file).
//
// The model, stripped to what all three engines agree on:
//
//   - a workflow is a DETERMINISTIC function of (input, journal). It is
//     re-executed from the top after every crash, and every non-deterministic
//     thing it did — an activity result, a timer, a signal, the clock — is read
//     back from the journal instead of being redone;
//   - an ACTIVITY (`ctx.run`) is journaled under a STABLE KEY. Its result is
//     recorded once; the activity itself is at-least-once — a crash between
//     executing and journaling re-runs it, which is why every engine documents
//     "make your side effects idempotent". For the gate pipeline that is the
//     deterministic node id + `if_exists: skip` for a graph write, a git CAS,
//     and ADOPT-BY-NAME for a dispatch (dec-spor-adopt-by-name-returns-existing);
//   - a DURABLE TIMER (`sleepUntil`) is journaled as a wake time; the workflow
//     SUSPENDS (holds no slot, no process) and is re-driven when the clock
//     passes it;
//   - a SIGNAL is an external event journaled on arrival and awaited by key;
//     an await with nothing journaled SUSPENDS.
//
// Replay is strictly sequential, as in every real engine: the n-th key the
// workflow asks for must be the n-th entry the journal holds, and a key seen
// out of order — or twice — is a NonDeterminism error. That discipline is
// what makes "the journal is the progress" true: there is no cursor to save,
// no progress field to stamp, no resume protocol — a resumed worker runs the
// same function over the same journal and lands in the same place.
//
// VERSIONING (decision point 2): a journal is bound to the WORKFLOW VERSION
// that recorded it. An Execution opened with a `version` stamps a header on an
// empty journal and refuses to replay one recorded under a different version
// (`WorkflowVersionMismatch`): the caller opens a NEW attempt instead of
// patching replay branches — pipeline attempts are hours to days long, so a
// version bump that starts a fresh journal is cheaper than Temporal-style
// `patched()` forks.
//
// PERSISTENCE is injected: `persist(entry)` is called synchronously after every
// append and BEFORE the appended result is handed back to the workflow, so a
// caller that writes the entry durably (lib/shell/execution-store.js's
// workflow journal) has the entry on disk before the workflow acts on it. A
// persist that throws takes its entry back out of the in-memory journal, so
// memory never runs ahead of disk.
//
// Like every kernel module this file is clock-free, I/O-free and needs no node
// builtins: the clock is injected (`{ now() }`), the activities are injected,
// the journal is a plain array the caller owns. Activities may be synchronous
// or return a promise; `ctx.run` hands back the value directly for a
// synchronous activity and a promise for an asynchronous one, so a workflow
// function may be written either way (`run()` itself always returns a
// promise).
//
// What the kernel deliberately does NOT model: workers, partitions, leases,
// task queues. Ownership of a journal is the execution store's fence
// (kernel/execution.js `ownershipLive`); the kernel assumes one driver at a
// time.
"use strict";

const JOURNAL_SPEC_VERSION = 1;

// The entry kinds a journal may hold, in the vocabulary a reader of the
// persisted file sees. `version` is the optional header; everything else is a
// keyed step the workflow asked for, or a signal delivered from outside.
const ENTRY_KINDS = Object.freeze(["version", "effect", "now", "timer", "await", "signal"]);

class Suspend extends Error {
  constructor(kind, detail) {
    super(`workflow suspended: ${kind}`);
    this.name = "Suspend";
    this.kind = kind; // "timer" | "signal"
    this.detail = detail;
  }
}

// A simulated crash — the test seam for the at-least-once window. The window
// is the one thing a caller MUST be able to probe (the activity's idempotency
// is the only thing that closes it), so the seam is first-class rather than
// a test-local monkeypatch.
class Crash extends Error {
  constructor(where) {
    super(`simulated crash ${where}`);
    this.name = "Crash";
    this.where = where;
  }
}

class NonDeterminism extends Error {
  constructor(msg) {
    super(msg);
    this.name = "NonDeterminism";
  }
}

class WorkflowVersionMismatch extends Error {
  constructor(recorded, expected) {
    super(`journal was recorded by ${describeVersion(recorded)}, this execution is ${describeVersion(expected)} — open a new attempt rather than replaying it`);
    this.name = "WorkflowVersionMismatch";
    this.recorded = recorded;
    this.expected = expected;
  }
}

function describeVersion(v) {
  if (!v) return "an unversioned workflow";
  return `${v.workflow || "workflow"}@${v.version}`;
}

function isThenable(v) {
  return !!v && (typeof v === "object" || typeof v === "function") && typeof v.then === "function";
}

function sameVersion(a, b) {
  return String(a.version) === String(b.version) && String(a.workflow || "") === String(b.workflow || "");
}

// The header entry a versioned journal opens with. Read by `journalVersion`
// so a driver can decide, before constructing an Execution, whether the
// journal on disk belongs to the workflow it is about to run.
function journalVersion(journal) {
  const head = journal && journal[0];
  if (head && head.kind === "version") return { workflow: head.workflow || null, version: head.version, spec: head.spec };
  return null;
}

// One workflow execution over one journal. `run()` replays the journal from
// the top every time; the SAME Execution can be `run()` repeatedly after a
// suspend or a crash (that is the whole point).
class Execution {
  constructor(workflowFn, input, { journal = [], clock, activities = {}, persist = null, crashPlan = null, onActivity = null, version = null, workflow = null } = {}) {
    if (typeof workflowFn !== "function") throw new TypeError("a workflow is a function of (ctx, input)");
    if (!clock || typeof clock.now !== "function") throw new TypeError("an Execution needs an injected clock { now() }");
    if (!Array.isArray(journal)) throw new TypeError("the journal is an array the caller owns");
    this.fn = workflowFn;
    this.input = input;
    this.journal = journal; // [{kind, key, ...}] — append-only, shared by reference so a caller can persist it
    this.clock = clock; // { now(): number }
    this.activities = activities;
    this.persist = persist; // (entry) => void, called after every append
    this.crashPlan = crashPlan; // { at: "before-execute"|"before-journal"|"after-journal", nth: n } — crash around the n-th EXECUTED activity
    this.onActivity = onActivity;
    this.version = version != null ? { workflow: workflow || null, version: String(version) } : null;
    this.executedEffects = 0; // activities actually EXECUTED (not replayed) over this execution's lifetime
    this.status = "created";
    this.result = undefined;
    this.error = undefined;
  }

  // Deliver an external signal (a human approval, a run's terminal state, a
  // CI verdict). Journaled on arrival, keyed on the name the workflow awaits.
  signal(name, payload) {
    this._append({ kind: "signal", key: `signal:${name}`, payload });
  }

  // Append + persist, as one step: a persist that throws takes the entry back
  // out, so the in-memory journal never holds an entry the durable one lacks.
  _append(entry) {
    this.journal.push(entry);
    if (this.persist) {
      try {
        this.persist(entry);
      } catch (e) {
        this.journal.pop();
        throw e;
      }
    }
  }

  // Bind (or check) the journal's version header. Returns the error to fail
  // with, or null.
  _bindVersion() {
    const recorded = journalVersion(this.journal);
    if (!this.version) return null; // an unversioned execution ignores a header
    if (!recorded) {
      if (this.journal.length) return new WorkflowVersionMismatch(null, this.version);
      this._append({ kind: "version", spec: JOURNAL_SPEC_VERSION, workflow: this.version.workflow, version: this.version.version });
      return null;
    }
    if (!sameVersion(recorded, this.version)) return new WorkflowVersionMismatch(recorded, this.version);
    return null;
  }

  async run() {
    this.status = "running";
    const mismatch = this._bindVersion();
    if (mismatch) {
      this.status = "failed";
      this.error = mismatch;
      return { status: "failed", error: mismatch };
    }
    const ctx = this._ctx();
    try {
      let out = this.fn(ctx, this.input);
      if (isThenable(out)) out = await out;
      this.status = "completed";
      this.result = out;
      return { status: "completed", result: out };
    } catch (e) {
      if (e instanceof Suspend) {
        this.status = "suspended";
        return { status: "suspended", kind: e.kind, detail: e.detail };
      }
      if (e instanceof Crash) {
        this.status = "crashed";
        return { status: "crashed", where: e.where };
      }
      this.status = "failed";
      this.error = e;
      return { status: "failed", error: e };
    }
  }

  _ctx() {
    const self = this;
    let cursor = journalVersion(self.journal) ? 1 : 0; // replay position, past the header
    // Signals seen during THIS replay and not yet consumed by an await. Scoped
    // to the run, not the Execution, so replay stays a pure function of the
    // journal (a consumed signal must not resurface on the next run).
    const pending = [];
    const seen = new Set();

    // Find the journal entry for `key` at or after the cursor. Replay is
    // sequential in every real engine; the pipeline is sequential too, so a
    // strictly ordered read is the honest model and a key seen out of order is
    // a nondeterminism error, as it would be in Temporal.
    function replay(kind, key) {
      if (seen.has(key)) throw new NonDeterminism(`key ${key} used twice in one execution — activity keys must be unique`);
      seen.add(key);
      drainSignals();
      const e = self.journal[cursor];
      if (e && e.key === key && e.kind === kind) {
        cursor++;
        return e;
      }
      if (e) throw new NonDeterminism(`journal expected ${e.kind} ${e.key} at position ${cursor}, workflow asked for ${kind} ${key}`);
      return null;
    }

    // Append a NEW entry and move the cursor past it, so the next key reads
    // from the end rather than re-comparing against what was just written.
    function append(entry) {
      self._append(entry);
      cursor = self.journal.length;
    }

    // Skip signal arrivals: they are journaled when delivered, not when
    // awaited, so they sit interleaved with the effects.
    function drainSignals() {
      while (cursor < self.journal.length && self.journal[cursor].kind === "signal") {
        pending.push(self.journal[cursor]);
        cursor++;
      }
    }

    function crashIf(at, nth, where) {
      if (self.crashPlan && self.crashPlan.at === at && self.crashPlan.nth === nth) throw new Crash(where);
    }

    // The second half of an activity: the at-least-once window, the journal
    // append, the after-journal crash point. Shared by the synchronous and
    // the promise-returning paths so the two cannot drift.
    function settle(key, name, args, nth, threw, result) {
      // The activity EXECUTED (whatever happens to its journal entry next):
      // the observer sees it before the at-least-once window, so a crash in
      // that window still counts the execution it is about to repeat.
      if (!threw && self.onActivity) self.onActivity({ key, name, args, result });
      crashIf("before-journal", nth, `after executing ${key}, before journaling`);
      if (threw) {
        // An activity that throws is journaled as a FAILURE and the failure is
        // replayed — a real engine retries by policy first; the pipeline
        // decides retries itself (reruns, outage backoff), so the kernel
        // records the outcome and hands it to the workflow.
        append({ kind: "effect", key, threw: true, error: threw.message || String(threw) });
        throw threw;
      }
      append({ kind: "effect", key, result });
      crashIf("after-journal", nth, `after journaling ${key}`);
      return result;
    }

    return {
      // Journaled activity. `key` must be stable across replays and unique
      // within the workflow: this is where the pipeline's deterministic ids
      // (gate fact id, attestation id, escalation id, execution event key)
      // become the SAME thing as the engine's dedup key.
      run(key, name, args) {
        const prior = replay("effect", key);
        if (prior) {
          if (prior.threw) throw Object.assign(new Error(prior.error), { replayed: true });
          return prior.result;
        }
        const act = self.activities[name];
        if (typeof act !== "function") throw new TypeError(`no activity ${name}`);
        const nth = ++self.executedEffects; // cumulative across resumes: "crash on the n-th activity this execution ever ran"
        crashIf("before-execute", nth, `before executing ${key}`);
        let out;
        try {
          out = act(args, { key });
        } catch (e) {
          return settle(key, name, args, nth, e, undefined);
        }
        if (isThenable(out)) {
          return out.then(
            (result) => settle(key, name, args, nth, null, result),
            (e) => settle(key, name, args, nth, e || new Error("activity rejected"), undefined)
          );
        }
        return settle(key, name, args, nth, null, out);
      },

      // Journaled clock read.
      now(key) {
        const prior = replay("now", key);
        if (prior) return prior.at;
        const at = self.clock.now();
        append({ kind: "now", key, at });
        return at;
      },

      // Durable timer: journal the wake time once; suspend until the clock
      // passes it. A workflow parked on a reviewer's `try again at <date>` is
      // exactly this — no slot held, no poll, no per-pass re-derivation.
      sleepUntil(key, wakeAt) {
        const prior = replay("timer", key);
        const fireAt = prior ? prior.fireAt : wakeAt;
        if (!prior) append({ kind: "timer", key, fireAt });
        if (self.clock.now() < fireAt) throw new Suspend("timer", { key, fireAt });
      },

      // Await a signal by name, optionally with a deadline. The deadline is a
      // durable timer too, so an approval nobody answers becomes `timeout`
      // from a suspended workflow instead of a slot held polling.
      awaitSignal(key, name, { deadlineAt = null } = {}) {
        const prior = replay("await", key);
        if (prior) {
          // A replayed await consumed its signal when it was live; take it out
          // of `pending` too, or a later await for the same name would find it
          // on replay and not live — replay must stay a function of the journal.
          if (prior.outcome.received) {
            drainSignals();
            const i = pending.findIndex((s) => s.key === `signal:${name}`);
            if (i >= 0) pending.splice(i, 1);
          }
          return prior.outcome;
        }
        drainSignals();
        const idx = pending.findIndex((s) => s.key === `signal:${name}`);
        if (idx >= 0) {
          const [s] = pending.splice(idx, 1);
          const outcome = { received: true, payload: s.payload };
          append({ kind: "await", key, outcome });
          return outcome;
        }
        if (deadlineAt != null && self.clock.now() >= deadlineAt) {
          const outcome = { received: false, timeout: true };
          append({ kind: "await", key, outcome });
          return outcome;
        }
        throw new Suspend("signal", { key, name, deadlineAt });
      },
    };
  }
}

// Drive an execution to a settled state the way an engine's worker would:
// re-run after a crash, advance the clock to the next timer when suspended
// on one, deliver queued signals. `signals` is [{atOrAfter, name, payload}],
// taken by reference (an activity may enqueue the terminal signal of the run
// it just dispatched). The clock must be ADVANCEABLE (`advanceTo`) — a fake,
// or a real driver's own wait — so this is the test-and-local-driver loop; a
// real worker's loop is "drive every open journal; deliver signals; advance
// timers" with the wall clock doing the advancing.
async function drive(exec, { clock, signals = [], maxRuns = 200, onCrash = null } = {}) {
  const queue = signals;
  let runs = 0;
  for (;;) {
    if (++runs > maxRuns) throw new Error("drive: did not settle");
    // deliver any signal whose time has come
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].atOrAfter == null || clock.now() >= queue[i].atOrAfter) {
        exec.signal(queue[i].name, queue[i].payload);
        queue.splice(i, 1);
      }
    }
    const r = await exec.run();
    if (r.status === "completed" || r.status === "failed") return { ...r, runs };
    if (r.status === "crashed") {
      if (onCrash) onCrash(r);
      exec.crashPlan = null; // a crash plan fires once; the resumed worker has none
      continue;
    }
    // suspended
    if (r.kind === "timer") {
      clock.advanceTo(r.detail.fireAt);
      continue;
    }
    if (r.kind === "signal") {
      const next = queue.find((s) => s.name === r.detail.name);
      if (next) {
        clock.advanceTo(Math.max(clock.now(), next.atOrAfter || clock.now()));
        continue;
      }
      if (r.detail.deadlineAt != null) {
        clock.advanceTo(r.detail.deadlineAt);
        continue;
      }
      return { ...r, runs, stuck: true };
    }
  }
}

function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advanceTo: (x) => {
      if (x > t) t = x;
    },
    advanceBy: (ms) => {
      t += ms;
    },
  };
}

module.exports = { JOURNAL_SPEC_VERSION, ENTRY_KINDS, Execution, drive, fakeClock, journalVersion, Suspend, Crash, NonDeterminism, WorkflowVersionMismatch };

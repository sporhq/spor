// spikes/durable-workflow/harness.js — the SMALLEST durable-workflow runtime
// that exhibits the programming model Temporal, Restate and js-wf share, so
// the gate pipeline can be written against that model and crash-tested
// WITHOUT installing any of the three (the client is zero-dep, and a spike
// must not pay a dependency to ask a question).
//
// The model, stripped to what all three agree on:
//
//   - a workflow is a DETERMINISTIC function of (input, journal). It is
//     re-executed from the top after every crash, and every non-deterministic
//     thing it did — an activity result, a timer, a signal, the clock — is
//     read back from the journal instead of being redone
//     (Temporal "replay", Restate "journal", js-wf "per-subject CAS journal");
//   - an ACTIVITY (Temporal activity / Restate `ctx.run` / js-wf `wf.Run`) is
//     journaled under a STABLE KEY. Its result is recorded once; the activity
//     itself is at-least-once — a crash between executing and journaling
//     re-runs it, which is exactly why every one of them documents "make your
//     side effects idempotent" (js-wf README: "an effect that is not
//     idempotent can execute again after a crash");
//   - a DURABLE TIMER (`sleep`) is journaled as a wake time; the workflow
//     SUSPENDS (holds no slot, no process) and is re-driven when the clock
//     passes it;
//   - a SIGNAL is an external event journaled on arrival and awaited by key;
//     an await with nothing journaled SUSPENDS.
//
// What this harness deliberately does NOT model: workers, partitions, leases,
// task queues, versioning, continue-as-new. Those are the engine's business
// and the spike's question is upstream of them: does the pipeline's control
// flow FIT the model, and what is left over once it does?
//
// Node builtins only, no fs: the journal is an array the caller persists
// however it likes (a run-record field, an executions-store event log, a NATS
// subject).
"use strict";

class Suspend extends Error {
  constructor(kind, detail) {
    super(`workflow suspended: ${kind}`);
    this.name = "Suspend";
    this.kind = kind; // "timer" | "signal"
    this.detail = detail;
  }
}

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

// One workflow execution over one journal. `run()` replays the journal from
// the top every time; the SAME Execution can be `run()` repeatedly after a
// suspend or a crash (that is the whole point).
class Execution {
  constructor(workflowFn, input, { journal = [], clock, activities = {}, crashPlan = null, onActivity = null } = {}) {
    this.fn = workflowFn;
    this.input = input;
    this.journal = journal; // [{key, kind, ...}] — append-only, shared by reference so a caller can persist it
    this.clock = clock; // { now(): number }
    this.activities = activities;
    this.crashPlan = crashPlan; // { at: "before-execute"|"before-journal"|"after-journal", nth: n } — crash around the n-th EXECUTED activity
    this.onActivity = onActivity;
    this.executedEffects = 0; // activities actually EXECUTED (not replayed) over this execution's lifetime
    this.status = "created";
    this.result = undefined;
    this.error = undefined;
  }

  // Deliver an external signal (a human approval, a run's terminal state, a
  // CI verdict). Journaled on arrival, keyed on the name the workflow awaits.
  signal(name, payload) {
    this.journal.push({ kind: "signal", key: `signal:${name}`, payload });
  }

  run() {
    const ctx = this._ctx();
    this.status = "running";
    try {
      const out = this.fn(ctx, this.input);
      // The harness is synchronous on purpose: the model is "a function of
      // (input, journal)", and async only obscures the replay. A real engine
      // awaits; nothing in the pipeline's control flow depends on the
      // difference.
      if (out && typeof out.then === "function") throw new TypeError("spike workflows are synchronous functions");
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
    let cursor = 0; // replay position
    // Signals seen during THIS replay and not yet consumed by an await. Scoped
    // to the run, not the Execution, so replay stays a pure function of the
    // journal (a consumed signal must not resurface on the next run).
    const pending = [];
    const seen = new Set();

    // Find the journal entry for `key` at or after the cursor. Replay is
    // sequential in every real engine (js-wf: "handlers should not issue steps
    // concurrently"; Temporal orders commands); the pipeline is sequential
    // too, so a strictly ordered read is the honest model and a key seen out
    // of order is a nondeterminism error, as it would be in Temporal.
    function replay(kind, key) {
      if (seen.has(key)) throw new NonDeterminism(`key ${key} used twice in one execution — activity keys must be unique`);
      seen.add(key);
      // Skip signal arrivals: they are journaled when delivered, not when
      // awaited, so they sit interleaved with the effects.
      while (cursor < self.journal.length && self.journal[cursor].kind === "signal") {
        pending.push(self.journal[cursor]);
        cursor++;
      }
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
      self.journal.push(entry);
      cursor = self.journal.length;
    }

    function drainSignals() {
      while (cursor < self.journal.length && self.journal[cursor].kind === "signal") {
        pending.push(self.journal[cursor]);
        cursor++;
      }
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
        const newEffects = ++self.executedEffects; // cumulative across resumes: "crash on the n-th activity this execution ever ran"
        if (self.crashPlan && self.crashPlan.at === "before-execute" && self.crashPlan.nth === newEffects) throw new Crash(`before executing ${key}`);
        let result;
        let threw = null;
        try {
          result = act(args, { key });
          if (self.onActivity) self.onActivity({ key, name, args, result });
        } catch (e) {
          threw = e;
        }
        // The at-least-once window: executed, not yet journaled.
        if (self.crashPlan && self.crashPlan.at === "before-journal" && self.crashPlan.nth === newEffects) throw new Crash(`after executing ${key}, before journaling`);
        if (threw) {
          // An activity that throws is journaled as a FAILURE and the failure
          // is replayed — a real engine retries by policy first; the pipeline
          // decides retries itself (reruns, outage backoff), so the harness
          // records the outcome and hands it to the workflow.
          append({ kind: "effect", key, threw: true, error: threw.message || String(threw) });
          throw threw;
        }
        append({ kind: "effect", key, result });
        if (self.crashPlan && self.crashPlan.at === "after-journal" && self.crashPlan.nth === newEffects) throw new Crash(`after journaling ${key}`);
        return result;
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
// on one, deliver queued signals. `signals` is [{atOrAfter, name, payload}].
function drive(exec, { clock, signals = [], maxRuns = 200, onCrash = null } = {}) {
  const queue = signals; // by reference: an activity may enqueue the terminal signal of the run it just dispatched
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
    const r = exec.run();
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
    advanceTo: (x) => { if (x > t) t = x; },
    advanceBy: (ms) => { t += ms; },
  };
}

module.exports = { Execution, drive, fakeClock, Suspend, Crash, NonDeterminism };

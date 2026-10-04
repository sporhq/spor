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
// persisted file sees. `version` is the optional header; `tombstone` is the
// optional TERMINAL entry (below); everything else is a keyed step the
// workflow asked for, or a signal delivered from outside.
const ENTRY_KINDS = Object.freeze(["version", "effect", "now", "timer", "await", "signal", "tombstone"]);

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

// A TOMBSTONED journal: one a driver closed for good. A driver that REFUSES
// to continue a journal — the workflow's own fail-closed check found the
// definition it opened under edited, or the journal was recorded by another
// version — settles the attempt outside the journal (an escalation, a fact).
// Those writes are durable and nothing reverses them, so the journal must be
// terminal too: were it left resumable, reverting the edit and re-driving it
// would CONTINUE the attempt — and land it — under a refusal already on the
// graph. `Execution.tombstone(detail)` appends the terminal entry (persisted
// like every append, so it is on disk before the driver settles anything), and
// every later `run()` fails with WorkflowTombstoned carrying the recorded
// detail — before the version is even read, so a journal of ANY version stays
// refused — which is what lets a driver re-settle the SAME refusal under the
// same ids after a crash between the tombstone and the settle.
class WorkflowTombstoned extends Error {
  constructor(entry) {
    super(`journal was tombstoned${entry && entry.reason ? ` (${entry.reason})` : ""} — the attempt it recorded is closed and is never resumed`);
    this.name = "WorkflowTombstoned";
    this.tombstone = entry;
  }
}

function describeVersion(v) {
  if (!v) return "an unversioned workflow";
  return `${v.workflow || "workflow"}@${v.version}`;
}

// A journaled failure, rebuilt on replay: the message, and the `name` and
// `code` a workflow may branch on, so live and replayed runs take the same
// branch. The original class cannot be restored (the kernel knows no
// classes); `replayed: true` marks it as a replay.
function replayedFailure(prior) {
  const e = new Error(prior.error);
  if (prior.name) e.name = prior.name;
  if (prior.code != null) e.code = prior.code;
  e.replayed = true;
  return e;
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

// The terminal entry, wherever it sits (a tombstone closes the journal at the
// point it was written; nothing follows it).
function journalTombstone(journal) {
  if (!Array.isArray(journal)) return null;
  for (const e of journal) if (e && e.kind === "tombstone") return e;
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
    this.poisoned = null; // the persist error that made this Execution unusable, if any
    this.version = version != null ? { workflow: workflow || null, version: String(version) } : null;
    this.executedEffects = 0; // activities actually EXECUTED (not replayed) over this execution's lifetime
    this.status = "created";
    this.result = undefined;
    this.error = undefined;
  }

  // Deliver an external signal (a human approval, a run's terminal state, a
  // CI verdict). Journaled on arrival, keyed on the name the workflow awaits.
  signal(name, payload) {
    this._refuseIfPoisoned();
    const closed = journalTombstone(this.journal);
    if (closed) throw new WorkflowTombstoned(closed);
    // A versioned journal opens with its header, whichever write comes first.
    if (this.version && !this.journal.length) this._append({ kind: "version", spec: JOURNAL_SPEC_VERSION, workflow: this.version.workflow, version: this.version.version });
    this._append({ kind: "signal", key: `signal:${name}`, payload });
  }

  // Close the journal for good (see WorkflowTombstoned). `detail` is the
  // JSON-plain record a driver re-settles from; `reason` names the refusal.
  // Appended and persisted as one step like every entry, so a persist failure
  // poisons this Execution and throws rather than leaving a tombstone in
  // memory that is not on disk. Idempotent: a journal already tombstoned
  // keeps its FIRST tombstone (the one a settle may already have read).
  tombstone(reason, detail = null) {
    this._refuseIfPoisoned();
    const prior = journalTombstone(this.journal);
    if (prior) return prior;
    if (this.version && !this.journal.length) this._append({ kind: "version", spec: JOURNAL_SPEC_VERSION, workflow: this.version.workflow, version: this.version.version });
    const entry = { kind: "tombstone", reason: String(reason || "refused"), ...(detail != null ? { detail } : {}) };
    this._append(entry);
    return entry;
  }

  _refuseIfPoisoned() {
    if (this.poisoned) throw this.poisoned;
  }

  // Append + persist, as one step. A persist that throws leaves the durable
  // state UNKNOWN — an fsync or close can fail after the bytes landed, so the
  // entry may or may not be on disk — and neither keeping nor removing the
  // in-memory entry is safe to run on. So the Execution is POISONED: this and
  // every later run() or signal() refuses with the persist error, and the
  // driver's only move is a fresh Execution over the journal re-read from
  // disk, which holds whatever truly landed.
  _append(entry) {
    this.journal.push(entry);
    if (this.persist) {
      try {
        this.persist(entry);
      } catch (e) {
        this.poisoned = e instanceof Error ? e : new Error(String(e));
        this.poisoned.poisoned = true;
        throw this.poisoned;
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

  _poisonedResult() {
    this.status = "failed";
    this.error = this.poisoned;
    return { status: "failed", error: this.poisoned };
  }

  async run() {
    if (this.poisoned) return this._poisonedResult();
    this.status = "running";
    const closed = journalTombstone(this.journal);
    if (closed) {
      this.status = "failed";
      this.error = new WorkflowTombstoned(closed);
      return { status: "failed", error: this.error };
    }
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
      // The persist failure surfaces to the workflow as the activity's own
      // throw (it is thrown from inside ctx.run), and a workflow with a
      // try/catch around that call may swallow it and go on to a verdict. The
      // run that hit it is poisoned regardless: whatever the function
      // returned was computed over a journal that may not match the disk.
      if (this.poisoned) return this._poisonedResult();
      this.status = "completed";
      this.result = out;
      return { status: "completed", result: out };
    } catch (e) {
      if (this.poisoned) return this._poisonedResult();
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
      self._refuseIfPoisoned(); // a run that already lost its disk journals nothing more
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

    // Is the workflow still inside the recorded past? True while a non-signal
    // journal entry remains ahead of the cursor — the engines' `isReplaying`
    // — so a workflow can hold its NON-journaled side effects (a log line, a
    // progress note) to the live portion of a run instead of re-emitting its
    // whole history on every resume. Trailing signals are deliveries, not
    // steps, so a journal that ends in undelivered signals is not a replay.
    function isReplaying() {
      let i = cursor;
      while (i < self.journal.length && self.journal[i].kind === "signal") i++;
      return i < self.journal.length;
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
        append({ kind: "effect", key, threw: true, error: threw.message || String(threw), ...(threw.name && threw.name !== "Error" ? { name: String(threw.name) } : {}), ...(threw.code != null ? { code: threw.code } : {}) });
        throw threw;
      }
      append({ kind: "effect", key, result });
      crashIf("after-journal", nth, `after journaling ${key}`);
      return result;
    }

    return {
      isReplaying,

      // Journaled activity. `key` must be stable across replays and unique
      // within the workflow: this is where the pipeline's deterministic ids
      // (gate fact id, attestation id, escalation id, execution event key)
      // become the SAME thing as the engine's dedup key.
      run(key, name, args) {
        const prior = replay("effect", key);
        if (prior) {
          if (prior.threw) throw replayedFailure(prior);
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
          return settle(key, name, args, nth, e || new Error("activity threw"), undefined);
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
      // `meta` is LIVE data for the driver, carried on the Suspend's detail
      // (never journaled): what the workflow wants the driver to know about
      // this wait — the parked result a yield hands up, the item an approval
      // wait polls — so a driver reads it off `detail.meta` instead of a side
      // channel on the input (task-spor-fold-gate-and-integration-into-one-
      // workflow). It is re-supplied by the workflow on every replay, so it
      // is as current as the code that passes it.
      sleepUntil(key, wakeAt, meta = undefined) {
        const prior = replay("timer", key);
        const fireAt = prior ? prior.fireAt : wakeAt;
        if (!prior) append({ kind: "timer", key, fireAt });
        if (self.clock.now() < fireAt) throw new Suspend("timer", { key, fireAt, ...(meta !== undefined ? { meta } : {}) });
      },

      // A durable timer that SUSPENDS ONCE (task-spor-fold-gate-and-
      // integration-into-one-workflow): the LIVE call — the one that journals
      // the wake — always suspends, whatever the clock reads, and a REPLAY
      // suspends only while the clock is before the wake. `sleepUntil` is a
      // pure function of (clock, wake), so a yield whose wake is "now" never
      // suspends at all under a real clock (the appends between the clock
      // read and the check already moved it past) and the workflow spins into
      // its next pass in the same drive. A YIELD exists to hand the slot back,
      // so it must suspend at least once; the journaled entry is the proof it
      // did, and the re-drive continues once the wake is past. Deterministic:
      // the entry's presence is what the replay branches on.
      yieldUntil(key, wakeAt, meta = undefined) {
        const prior = replay("timer", key);
        const fireAt = prior ? prior.fireAt : wakeAt;
        if (!prior) {
          append({ kind: "timer", key, fireAt });
          throw new Suspend("timer", { key, fireAt, ...(meta !== undefined ? { meta } : {}) });
        }
        if (self.clock.now() < fireAt) throw new Suspend("timer", { key, fireAt, ...(meta !== undefined ? { meta } : {}) });
      },

      // Await a signal by name, optionally with a deadline. The deadline is a
      // durable timer too, so an approval nobody answers becomes `timeout`
      // from a suspended workflow instead of a slot held polling.
      // THE DEADLINE NEVER SUSPENDS ONCE PASSED: an await whose `deadlineAt`
      // the clock is already at or past journals `{timeout: true}` at once,
      // without suspending even once — so a drive RESUMED after the deadline
      // settles the timeout without the driver ever getting a chance to
      // deliver a signal that arrived while no worker was running. A workflow
      // that wants "one read past the deadline before timing out" (the gate
      // list's human approval, gate-workflow.js awaitApproval) must await
      // WITHOUT a kernel deadline and have the driver deliver the timeout as a
      // signal after its own read. `meta` rides the Suspend's detail as for
      // `sleepUntil`.
      awaitSignal(key, name, { deadlineAt = null, meta = undefined } = {}) {
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
        throw new Suspend("signal", { key, name, deadlineAt, ...(meta !== undefined ? { meta } : {}) });
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

// Is `e` one of the kernel's own control-flow throws — a suspend, a simulated
// crash, a replay fault, a version refusal, or a poisoned journal — rather than
// an activity's failure? A workflow that wraps a stretch of activities in a
// try/finally to release a resource must let these pass through UNTOUCHED: a
// journaled step taken on the way out of a suspend lands out of order in the
// journal and turns the next resume into a NonDeterminism fault.
function isControlFlow(e) {
  return !!e && (e instanceof Suspend || e instanceof Crash || e instanceof NonDeterminism || e instanceof WorkflowVersionMismatch || e instanceof WorkflowTombstoned || e.poisoned === true);
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

module.exports = { JOURNAL_SPEC_VERSION, ENTRY_KINDS, Execution, drive, fakeClock, journalVersion, journalTombstone, isControlFlow, Suspend, Crash, NonDeterminism, WorkflowVersionMismatch, WorkflowTombstoned };

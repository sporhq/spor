"use strict";
// The worker's FLEET PRESENCE (issue-spor-work-does-not-publish-capabilities-
// or-heartbeat): `spor work` keeps its agent a fresh, published host for the
// fleet scheduler and the program-run Start preflight on its own, instead of
// leaning on a wrapper script that runs `spor capabilities publish` once and
// POSTs the heartbeat on a timer.
//
// The server reads a worker as fresh off its agent's `last_seen` (the
// preflight's window is 15min; the host-match's is the caller's `max_age`),
// and only two doors move it: the capabilities publish (POST
// /v1/agents/{id}/capabilities — also the ONE door that makes the agent a host
// at all; a heartbeat before it is a 404) and the cheap liveness ping (POST
// /v1/agents/{id}/heartbeat). The session-start hook and the post-tool tick
// call those for an interactive session; a headless worker fires neither
// between its own dispatches, so its presence is this module's job:
//
//   start  publish once (the effective capabilities this box has NOW), then
//          tick every `intervalMs`.
//   tick   heartbeat; a 404 means the server holds no published caps for the
//          agent (never published, or the store lost it), so the next tick
//          re-publishes instead. A tick while a publish never landed also
//          re-publishes — a server outage at startup heals on its own.
//   stop   clear the timer. The agent then goes stale on the server's own
//          clock: there is no "going away" door, and a stopped worker only
//          has to stop claiming to be alive.
//
// Everything is fail-open and bounded: a failure is one log line (latched per
// distinct message, so an outage is not a line every interval) and never
// stops the loop. The timer is unref'd, so it never holds a finished worker's
// process open, and a tick in flight is never overlapped by the next.
// In-memory only — no flag, no journal, nothing a later pass owes.

function failureText(r) {
  if (!r) return "no response";
  if (r.transport) return r.error || "transport error";
  const code = r.json && r.json.error && r.json.error.code;
  return `HTTP ${r.status}${code ? ` (${code})` : ""}`;
}

function startFleetPresence({
  cfg,
  remote,
  agent,
  capabilities,
  publish = true,
  heartbeat = true,
  intervalMs,
  publishTimeoutMs = 3000,
  heartbeatTimeoutMs = 3000,
  log = () => {},
  setTimer = setInterval,
  clearTimer = clearInterval,
}) {
  const base = encodeURIComponent(agent);
  const state = { published: false, stopped: false, inFlight: null, lastFailure: null };
  const failed = (what, r) => {
    const line = `work: fleet ${what} for ${agent} failed (${failureText(r)}) — retried every ${Math.round(intervalMs / 1000)}s; the scheduler sees this worker as stale until one lands`;
    if (line === state.lastFailure) return;
    state.lastFailure = line;
    log(line);
  };
  const recovered = (what) => {
    if (state.lastFailure === null) return;
    state.lastFailure = null;
    log(`work: fleet ${what} for ${agent} landed again`);
  };

  const doPublish = async () => {
    let caps;
    try {
      caps = capabilities();
    } catch (e) {
      failed("capabilities probe", { transport: true, error: (e && e.message) || String(e) });
      return false;
    }
    const r = await remote.post(cfg, `/v1/agents/${base}/capabilities`, caps, { timeoutMs: publishTimeoutMs });
    if (r && r.ok) {
      state.published = true;
      recovered("publish");
      return true;
    }
    failed("capabilities publish", r);
    return false;
  };

  const doHeartbeat = async () => {
    const r = await remote.post(cfg, `/v1/agents/${base}/heartbeat`, {}, { timeoutMs: heartbeatTimeoutMs });
    if (r && r.ok) {
      recovered("heartbeat");
      return true;
    }
    // Publish before heartbeat: the server keeps no liveness without caps.
    if (r && r.status === 404) state.published = false;
    failed("heartbeat", r);
    return false;
  };

  // One tick at a time; a slow server never stacks requests behind the timer.
  const tick = () => {
    if (state.stopped || state.inFlight) return state.inFlight;
    const step = async () => {
      try {
        // A box that opts out of publishing still has to have published SOME
        // time for its heartbeat to mean anything; that is the operator's
        // `spor capabilities publish`, so its heartbeat runs regardless.
        if (publish && !state.published) await doPublish();
        else if (heartbeat) await doHeartbeat();
      } catch (e) {
        failed(publish && !state.published ? "capabilities publish" : "heartbeat", { transport: true, error: (e && e.message) || String(e) });
      }
    };
    state.inFlight = step().finally(() => {
      state.inFlight = null;
    });
    return state.inFlight;
  };

  const ready = tick();
  let timer = null;
  if (heartbeat || publish) {
    timer = setTimer(tick, intervalMs);
    if (timer && typeof timer.unref === "function") timer.unref();
  }
  return {
    ready,
    tick,
    state,
    stop() {
      state.stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}

// Resolve whether and how a worker keeps a fleet presence, from the SAME
// config keys the session-start publish and the post-tool tick read: remote
// mode and an agent identity are the opt-in (a box that never ran `spor agent
// use` and passed no `--as` has no fleet identity), and
// `dispatch.capabilitiesPublish` / `dispatch.heartbeat` switch each half off.
function fleetPresenceOptions(cfg, { remote, agent }) {
  if (!agent || !remote.isRemote(cfg)) return null;
  const publish = cfg.getBool("dispatch.capabilitiesPublish", true);
  const heartbeat = cfg.getBool("dispatch.heartbeat", true);
  if (!publish && !heartbeat) return null;
  const num = (key, dflt) => {
    const v = Number(cfg.get(key, dflt));
    return Number.isFinite(v) && v > 0 ? v : dflt;
  };
  return {
    agent,
    publish,
    heartbeat,
    intervalMs: num("dispatch.heartbeatIntervalMs", 300000),
    publishTimeoutMs: num("dispatch.capabilitiesPublishTimeoutMs", 3000),
    heartbeatTimeoutMs: num("dispatch.heartbeatTimeoutMs", 3000),
  };
}

module.exports = { startFleetPresence, fleetPresenceOptions };

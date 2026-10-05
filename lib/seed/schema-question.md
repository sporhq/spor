---
id: schema-question
type: schema
kind: node-schema
schema_version: 2026.10.05.1
title: Seed schema for question nodes
summary: Node schema for the question type — a routed ask that the graph could not answer; queueable so open questions join the decision queue, routed-to a steward, answered by nodes carrying answers edges. Seed-pack default; a graph-resident schema node for this type overrides it.
date: 2026-06-10
---

Seed schema for the `question` node type (Tier-2 question routing),
shipped with the plugin as a registry default (QUEUE.md §2). A question is
filed deliberately (the `ask_question` tool / `POST /v1/questions`) when
the graph comes back empty — coordination is durable graph nodes, not
side-channels (dec-cc-inter-session-graph-coordination).

Lifecycle: `status: open` while waiting; an answer is any node carrying an
`answers` edge to the question, after which the asker or answerer flips
`status: answered` (terminal — leaves the queue). The flip is gated: see
`transitions()` (2026.10.05.1) below. The `asker` frontmatter
field records the asking person node; attribution still comes only from
the token. `routed-to` edges carry the routing result; an unrouted
question (no steward matched) surfaces to everyone.

`transitions()` (2026.06.13.1): status is constrained to the question
vocabulary (`open`/`answered`, or none = live) so the queue-terminal value
(`answered`) is not shadowed by synonyms
(dec-cc-status-enforcement-via-transitions). Write-time gate,
backward-readable, no upgrade chain.

`validate()` (2026.06.20.1, issue-spor-node-create-bypasses-status-vocabulary):
the status-vocabulary membership check moved to the `validate()` door so it runs
on **create as well as update** — `transitions()` runs on update only, so a
question could be BORN with an off-vocabulary status that a later re-validating
write then rejected. `validate()` and `transitions()` SHARE one `VALID` list (no
drift). Backward-readable: write-time only, no node-shape change, no upgrade chain.

`validate()` placeholder gate (2026.07.05.1,
issue-spor-ask-question-template-placeholder-validation): a docs example run
verbatim minted `question-question` — title, summary, and body all the literal
string `<question>`, an information-free slug, auto-routed and queued as a real
ask. The door now rejects any PRESENT text field (`title`/`summary`/`body`)
whose entire content is one unfilled template token (`<...>`, `{...}`/`{{...}}`,
or `[...]`), so an unfilled ask fails at write time on every path that runs
schema hooks (REST, MCP, remote CLI). Absent/empty fields remain the core
validator's concern; text with real content around a token passes. Slug
derivation was already content-derived — rejecting the degenerate input is what
prevents the information-free id. Backward-readable: write-time only, no
node-shape change, no upgrade chain.

`get()` (2026.06.19.1): the read-time enrichment hook
(task-spor-schema-get-hook-readtime-enrichment) — the single mechanism that
generalizes the old hardcoded `get_node` ride-alongs. On every read, the server
hands the hook a bounded one-hop neighborhood (`ctx.neighbors`, not a live graph
handle — the §2.4 sandbox is a JSON-only boundary) and the hook attaches derived
context. For a question that means its **answer**: the first live inbound
`answers`/`resolves` edge from a non-superseded, resolving-status node rides along
as `resolution`, carrying the answering node's summary — so an already-`answered`
question still points at WHAT answered it, the read that
task-spor-getnode-surface-resolution-on-terminal first shipped against. Pure,
read-only, fail-soft (a crashing hook is dropped, never breaks the read);
registry behavior only, backward-readable, no upgrade chain.

`status` (2026.08.22.1, task-spor-registry-declarative-terminal-status-policy):
the status vocabulary `validate()` enforces is now also DECLARED as registry
data (`status.vocabulary`), alongside `status.completion: answered` — the
single success terminal value a mechanical "make the record honest" remedy
should name. (It originally declared no `resolver_required`; 2026.10.05.1
below gates `answered` on a live answering node.) Enforcement is unchanged — the hook is still the
write door; `test/seed-declarative-status-policy.test.js` drives it through the
sandbox and fails if the hook and this payload disagree. Backward-readable:
declaration only, no stored-shape change, no upgrade chain.

`resolution` (2026.09.06.1, issue-spor-offline-check-get-hook-resolution-proxy):
the attestation path for this type's completion, DECLARED as registry data.
`verified_by: edge` — a question is retired by a live inbound resolving edge
(the `get()` ride-along above), never by its status alone. It restates as data
what the hook already implies, because readers used to INFER it from the mere
presence of a `get()` hook: `get()` is the general-purpose read-time enrichment
verb (a held-note, an execution hold, a question's answers), so that proxy
would have reclassified any type adopting one for an unrelated purpose.
Declaration only — enforcement stays in the hooks — no stored-shape change, no
upgrade chain.

`transitions()` + `status` (2026.10.05.1,
issue-spor-set-status-answered-without-answers-edge): `answered` now requires a
live inbound answer on the graph, read off `view.resolvers` exactly as
schema-task/schema-issue gate `done`/`resolved` — a question is retired by an
answering node, never by its status alone, which is what the `get()` hook and
`resolution.verified_by: edge` already say. Before this a bare open→answered flip
with no `answers` edge in place was accepted. The gate counts a resolver only when
its status is not in the host's `view.non_resolving_statuses` partition, and
accepts the answerer types declared as `status.resolver_types` (any node type that
can carry an `answers` edge; the host passes the declared list as
`view.resolver_types`, absent → the seed list). `status.resolver_required: true`
now declares it. Write-time only, so existing `answered` nodes are unaffected;
backward-readable, no stored-shape change, no upgrade chain. The server's
`server/test/questions.test.js` asserts the old bare flip and is updated with the
next `@sporhq/spor` pin bump (task-spor-server-questions-test-answered-needs-answers-edge).

```json
{
  "node_type": "question",
  "description": "a routed ask the graph could not answer — open questions join the decision queue",
  "prefix": [
    "question-"
  ],
  "queueable": true,
  "status": {
    "vocabulary": [
      "open",
      "answered"
    ],
    "completion": "answered",
    "resolver_required": true,
    "resolver_types": [
      "decision",
      "artifact",
      "finding",
      "spec",
      "norm",
      "task",
      "issue",
      "question"
    ]
  },
  "resolution": {
    "verified_by": "edge"
  }
}
```

```js
// The question status vocabulary, shared by validate() (the door, runs on
// create AND update) and transitions() (update only). Defining it ONCE is what
// makes the create path and the update path AGREE on the enum
// (issue-spor-node-create-bypasses-status-vocabulary): the membership check used
// to live only in the update-path gate, so a question could be BORN with an
// off-vocabulary status that a later re-validating write then rejected.
const VALID = ["open", "answered"];
function statusReason(next) {
  return "invalid question status '" + next + "': valid statuses are open " +
    "(awaiting an answer) and answered (an answers edge resolved it; " +
    "terminal) — or none, meaning live. (dec-cc-status-enforcement-via-transitions)";
}

// One unfilled template token and nothing else: <question>, {slug}, {{text}},
// [id]. Whole-field match only — real content around a token passes, and
// ABSENT fields stay the core validator's concern (bare probe nodes must pass).
const PLACEHOLDER = /^\s*(?:<[^<>]*>|\{\{[^{}]*\}\}|\{[^{}]*\}|\[[^\[\]]*\])\s*$/;

// validate(node) — the door, runs on EVERY write (create AND update) in the
// §2.4 sandbox. Enforce the status-vocabulary MEMBERSHIP here so a question
// cannot be BORN with an off-vocabulary status that the update-path
// transitions() gate would later reject
// (issue-spor-node-create-bypasses-status-vocabulary). Empty status
// (status-less = live, an open question) is allowed. Also reject any present
// text field that is ONLY an unfilled template placeholder — a docs example
// run verbatim once minted question-question with title/summary/body all
// '<question>' (issue-spor-ask-question-template-placeholder-validation).
export function validate(node) {
  const errors = [];
  const s = ((node && node.status) || "").toLowerCase();
  if (s !== "" && VALID.indexOf(s) === -1) errors.push(statusReason(s));
  const fields = ["title", "summary", "body"];
  for (let i = 0; i < fields.length; i++) {
    const v = node && node[fields[i]];
    if (typeof v === "string" && v.trim() !== "" && PLACEHOLDER.test(v)) {
      errors.push("question " + fields[i] + " is an unfilled template placeholder ('" +
        v.trim() + "'): replace it with the actual question text " +
        "(issue-spor-ask-question-template-placeholder-validation)");
    }
  }
  return errors;
}

// transitions(current, proposed, view) — question status vocabulary gate plus
// the answered-needs-an-answer gate (dec-cc-status-enforcement-via-transitions,
// issue-spor-set-status-answered-without-answers-edge). Runs on every UPDATE in
// the §2.4 sandbox, JSON boundary, pure. Empty status (status-less = live) is
// always allowed; the SHARED check above also enforces the vocabulary on create.
// view.resolvers = live inbound answering nodes; view.non_resolving_statuses =
// the registry's non-resolving partition; view.resolver_types = this type's
// status.resolver_types (absent → the seed list).
export function transitions(current, proposed, view) {
  const next = ((proposed && proposed.status) || "").toLowerCase();
  if (next === "") return { allow: true };
  if (VALID.indexOf(next) === -1) return { allow: false, reason: statusReason(next) };
  if (next === "answered") {
    const rs = (view && view.resolvers) || [];
    const nonResolving = (view && view.non_resolving_statuses) || [];
    const types = ((view && view.resolver_types) || []).map(function (t) { return String(t); });
    const accepted = types.length ? types : ["decision", "artifact", "finding", "spec", "norm", "task", "issue", "question"];
    let ok = false;
    for (let i = 0; i < rs.length; i++) {
      const st = ((rs[i] && rs[i].status) || "").toLowerCase();
      if (accepted.indexOf(String(rs[i].type)) !== -1 && nonResolving.indexOf(st) === -1) { ok = true; break; }
    }
    if (!ok) {
      return {
        allow: false,
        reason: "answered requires a node in a RESOLVING state carrying an answers " +
          "edge to this question — write the answer on the graph (put_node with " +
          "an answers edge, or add_edge answers) first, then flip the status. " +
          "(issue-spor-set-status-answered-without-answers-edge)",
      };
    }
  }
  return { allow: true };
}
```

```js
// get(node, ctx) — read-time enrichment, run on get_node in the §2.4 sandbox
// (task-spor-schema-get-hook-readtime-enrichment). JSON boundary, pure, read-only.
// The host hands in a BOUNDED one-hop neighborhood rather than a live graph handle:
//   ctx.neighbors[] = this node's edges, each { id, edge, dir:"in"|"out", type,
//                     status, title, summary, date, superseded } (capped fan-out)
//   ctx.non_resolving_statuses = the registry's resolving partition (a resolver in
//                     one of these statuses retires nothing)
//   ctx.terminal    = whether THIS node's status is terminal (drives the note)
// The returned object's keys ride along on the get_node result. Fail-soft: a throw
// or non-object return drops enrichment, never breaks the read.
//
// Re-expresses the resolution ride-along store.getNode used to hardcode: the FIRST
// live inbound resolves/answers edge from a non-superseded, resolving-status node
// becomes `resolution`, carrying the resolver's summary, with a `lagging` flag —
// ⚠ when an open status contradicts the edge (status lags), an informational ✓ when
// the node is healthily terminal (task-spor-getnode-surface-resolution-on-terminal).
// `answers` retires only questions; `resolves` retires any target — the same
// partition the kernel's resolutionMap applies, so reads stay byte-consistent.
export function get(node, ctx) {
  const neighbors = (ctx && ctx.neighbors) || [];
  const nonResolving = (ctx && ctx.non_resolving_statuses) || [];
  for (let i = 0; i < neighbors.length; i++) {
    const nb = neighbors[i];
    if (nb.dir !== "in") continue;
    if (nb.edge !== "resolves" && nb.edge !== "answers") continue;
    if (nb.superseded) continue;
    if (nonResolving.indexOf((nb.status || "").toLowerCase()) !== -1) continue;
    if (nb.edge === "answers" && node.type !== "question") continue;
    const lagging = !(ctx && ctx.terminal);
    const note = lagging
      ? "resolved by " + nb.id + (nb.date ? " (" + nb.date + ")" : "") + " via " +
        nb.edge + " edge — the status field has not been updated; trust the edge."
      : (nb.edge === "answers" ? "answered" : "resolved") + " by " + nb.id +
        (nb.date ? " (" + nb.date + ")" : "") + (nb.summary ? " — " + nb.summary : "");
    return {
      resolution: {
        by: nb.id,
        edge: nb.edge,
        date: nb.date != null ? nb.date : null,
        summary: nb.summary != null ? nb.summary : null,
        title: nb.title != null ? nb.title : null,
        lagging: lagging,
        note: note,
      },
    };
  }
  return {};
}
```

// shell/worker-contract.js — the standing instructions `spor work` appends to
// every implementer it dispatches (task-spor-work-loop, replacing the
// /spor-orchestrator skill's hand-written agent prompt with a contract the
// worker itself carries).
//
// `spor dispatch` builds a prompt of three parts — session note, compiled
// briefing, task (WORKERS.md §4) — and the task line for a node is one
// sentence: "Work on <id> — <title>." That is right for a person aiming one
// agent at one node, and wrong for an unattended factory: nothing in it says
// COMMIT before you resolve, do not merge to main, do not touch the protected
// suite, resolve LAST. The first live factory run showed exactly those gaps —
// one implementer self-landed its commit on main (so the review gate diffed a
// commit against itself), another left the gate a dirty tree it refused to
// judge. The orchestrator skill carried all of this in prose; a worker that
// replaces the orchestrator has to carry it too.
//
// Pure: a string from a shape. Harness-neutral on purpose (no tool names) —
// the same text goes to a claude-code, codex, opencode or copilot implementer.
// Factory-specific lines (the integration target, the acceptance command, the
// protected paths) appear only when the factory declares them, so a BARE
// worker's contract is the plain commit-then-resolve discipline and nothing
// more — plus the durable-debt checklist (kernel/gates.js
// DURABLE_FLAG_FAILURE_MODES), which is design discipline rather than a
// factory fact and rides in both: a retry flag designed one failure mode at a
// time costs the same cycles under any factory. The one FIXED FORM in it —
// `DECLINED: <reason>` as the first line of the final message — is the
// worker's declared decline, read back by dispatch-terminal.js
// (parseDecline); change the two together.
"use strict";

const { renderDurableFlagChecklist } = require("../kernel/gates.js");

function list(items, cap = 8) {
  const arr = (items || []).filter(Boolean);
  const shown = arr.slice(0, cap).map((p) => `\`${p}\``).join(", ");
  return arr.length > cap ? `${shown} (+${arr.length - cap} more)` : shown;
}

// `factory` is the resolved definition (kernel/gates.js parseFactory) or null
// for a bare worker. `terminal` names the status the item's type reaches when
// resolved ("done" for a task) when the caller knows it; the contract states
// the general rule either way.
function workerContract({ nodeId, factory = null, terminal = null } = {}) {
  const id = String(nodeId || "this item");
  const integration = factory && factory.integration ? factory.integration : null;
  const target = integration ? integration.targetRef : factory ? factory.trustedRef : "main";
  const commandGates = factory ? factory.gates.filter((g) => g.kind === "command") : [];
  const reviewGates = factory ? factory.gates.filter((g) => g.kind === "agent-review") : [];
  const protectedPaths = factory ? factory.protectedPaths || [] : [];

  const lines = [
    "## Worker contract",
    "",
    `You own ONE queue item, \`${id}\`. Carry it to "committed, clean, resolved on the graph" on your own;`,
    "nobody is watching this session, so do not stop to ask, and do not end your turn waiting on anything.",
    "",
    "Workspace:",
    "- Work only in your current working directory, on the branch you were launched on. Never edit",
    "  another checkout by its absolute path, even a file you know lives there.",
    `- Do NOT merge to \`${target}\`, push to it, or touch any other branch.` +
      (integration
        ? ` The factory's integration stage lands your branch onto \`${target}\` after the gates pass; your job ends at committed, clean, resolved.`
        : " Landing the branch is not your job; it ends at committed, clean, resolved."),
    ...(protectedPaths.length
      ? [
          `- Do NOT edit the protected test paths (${list(protectedPaths)}). The acceptance gate runs the trusted ref's copy and`,
          "  FAILS CLOSED on a branch that touches them" +
            (factory.testLaneProfile ? `; a test change belongs in the separate \`${factory.testLaneProfile}\` lane — say so in your report instead.` : "."),
        ]
      : []),
    "",
    "The loop:",
    "1. Orient. Before you touch the Spor graph, load the `/spor:spor` skill (the node/edge format and the",
    `   resolution rules your training does not cover). Read the item (\`spor get ${id}\`), pin down what`,
    '   "done" means for it, and honor the repo\'s own rules (CLAUDE.md / AGENTS.md) and the norms in the briefing.',
    "2. Implement, in scope. Code that reads like the code around it. Unrelated problems you trip over are",
    "   not folded in — name them in your final report.",
    "3. Verify deterministically before anything else: the typecheck and the tests that exercise your change" +
      (commandGates.length
        ? `, and the factory's acceptance command (${commandGates.map((g) => `\`${g.command}\``).join(", ")}), which the gate re-runs from the trusted ref's copy.`
        : "."),
    '   Never hand back red tests or "should work"; if you cannot verify it, say so plainly.',
    "4. Commit everything on this branch with a clear message, and leave the working tree CLEAN — the gates",
    "   judge committed work only and REFUSE a tree with uncommitted changes to tracked files." +
      (reviewGates.length ? ` A second model reviews \`git diff ${target}...HEAD\` next; write for that reader.` : ""),
    "   If your change introduces or extends a durable retry/debt flag (a `*_pending` run-record field, a journal",
    "   line, a cooldown file — anything one pass writes so a later pass owes an action), design it against ALL of",
    "   these up front and say how each is handled in the commit message; a review walks the whole table in one",
    "   verdict, and a flag designed one failure mode at a time spends every fix cycle on one mechanism:",
    renderDurableFlagChecklist({ indent: "   " }),
    `5. Resolve the item on the graph LAST, only after step 4's commit is on the branch: write a resolver node`,
    `   (a \`decision\` for a substantive change, a short \`artifact\` for a trivial one) carrying a \`resolves\``,
    `   edge to \`${id}\`, then set its terminal status${terminal ? ` (\`${terminal}\`)` : " (a task -> done, an issue/incident -> resolved)"}.`,
    "   Resolving before committing makes the graph lie; never do it out of order.",
    "",
    "If it will not converge — a blocker outside your control, a change that genuinely needs another repo,",
    "an acceptance bar you cannot meet — do not thrash and do not force it. Commit whatever is safe, leave the",
    "item UNRESOLVED, and say exactly what blocks it in your final report; the item returns to the pool",
    "carrying that report, which is the designed path, not a failure.",
    "",
    "If the ITEM itself is wrong — its premise no longer holds, it is already done, the change belongs in a",
    "different repo — DECLINE it instead of working around it: commit nothing, write no resolver, and make the",
    "FIRST line of your final message exactly `DECLINED: <one-line reason>` (explain below it). That fixed form",
    "is read by the runner: a declined item skips the gates and goes back to triage carrying your reason as a",
    "finding, with its agent-ready stamp cleared, instead of paging a person. A decline with commits behind it,",
    "or with a resolver written, is not a decline — it is judged as the claim it makes.",
    "",
    `Final report: the item id, what you changed, how you verified it, and the id of the resolver node you`,
    "wrote (or what blocks the item, or the `DECLINED:` line). Then a findings block for whoever triages the graph — one line each,",
    "`- [issue|task|smell|better-approach] <area> — <what + why>` — or `FINDINGS: none`.",
  ];
  return lines.join("\n");
}

module.exports = { workerContract };

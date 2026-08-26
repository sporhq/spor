# The interview

Six questions decide a factory. They do not change with the operator; only the
language does. Ask a few at a time, reflect the answers back in your own words,
and stop asking anything the repo or the graph already answered.

| # | What it decides | Emits |
|---|---|---|
| 1 | What must never break for the people who use this | the acceptance criteria, and the command gate that checks them |
| 2 | What already checks that today | `gates[].command` — prefer what CI runs |
| 3 | Which branch is the truth | `trusted_ref` |
| 4 | Whether an agent may edit the checks | `protected_paths` + `test_lane_profile` |
| 5 | What a second reader should hunt for | an `agent-review` gate, its `profile` and `cycles` |
| 6 | What a person must see before it ships | a `human` gate and the `risk_classes` that arm it |

## Reading the register

Pick the register from how the ask arrives, not from a job title, and switch if
you were wrong — an owner who starts answering in paths and CI job names has
told you which bank to use.

**Product register** — the ask is about outcomes and users ("agents keep
breaking checkout", "I want to trust this", "what should never break"). Answers
come as user journeys, money, trust, embarrassment. Never make them choose a
timeout, a glob, or a harness; propose those and say what you chose.

**Engineer register** — the ask is about mechanism ("a codex review gate with
two fix cycles", "run the conformance goldens from main"). Answers come as
commands, paths, refs, profiles. Propose densely; skip the translation work and
show them the payload.

## Product bank — turning judgment into an acceptance spec

Ask these as they are. They are the whole factory job for a non-technical
owner, and every answer is evidence you carry verbatim into the nodes you emit.

1. **"If one thing about this product broke overnight and you only found out
   from a customer, what would you least want it to be?"** — the first
   acceptance criterion. Push for two or three more, then stop.
2. **"Walk me through what a customer does, from arriving to being finished."**
   — the black-box journey the suite has to cover. Write the steps down in
   their words; they become the body of the test-writer lane item.
3. **"How would *you* check that it still works, if you had five minutes and no
   code?"** — this is the acceptance test, stated by the person whose judgment
   defines correct. Their manual steps are the spec.
4. **"Is there anything you would want to look at yourself before it goes
   live?"** — a human gate. Follow up with "which parts of the product?" and
   turn that into risk classes with the paths *you* find in the repo.
5. **"When something does go wrong, who finds out and how?"** — tells you
   whether the honest first pipeline is one command gate (they have no
   detection at all) or something denser.
6. **"Who else should look at an agent's work — and what would they be looking
   for?"** — an agent-review gate's `instructions`, in their words.

**What not to ask them**: which harness, what timeout, how many fix cycles,
what glob covers auth, whether to inline or reference a gate. Decide those,
state them in the proposal in one plain line each, and let them push back.

## Engineer bank

1. Which suite is the acceptance suite, and what invokes it? (`command`,
   `dir`, `timeout_ms` — and does it match CI, or is this a second definition
   of done?)
2. Trusted ref — default branch, or a release branch?
3. Which paths are the judge? (`protected_paths`, and the `test_lane_profile`
   a protected-path hit routes to.)
4. Review lane: which profile, cross-model or not, what should it hunt for,
   how many fix cycles before it escalates to a person?
5. Which changes need an approval, and from whom? (`risk_classes` as globs, and
   the gate that names them.)
6. Inline or shareable? A gate more than one factory will use — a
   `gate-security-review` — is a `type: gate` node; a one-off is inline. The
   runner cannot tell the difference.

## Translating a product answer into a gate

| They said | You emit | What you must state back |
|---|---|---|
| "Checkout must never fail" | a `command` gate over the suite that covers checkout — or, if there is none, the test-writer lane carrying that sentence as a criterion | that today nothing checks it, and the lane is how it starts to |
| "I want to see anything touching payments" | a `human` gate with a `touches:payments` risk class you write from the repo's real paths | the exact globs, so they can say "no, also this" |
| "I don't want an agent marking its own homework" | `protected_paths` over the suite + a `test_lane_profile` | that a change touching a test fails closed and files a separate item — it is not merely a warning |
| "Have someone smart double-check it" | an `agent-review` gate routed to a cross-model profile | that a review is a second opinion, not a proof, and an unreadable verdict counts as a failure |
| "It should be fast" | nothing — a preference, not a gate | that gates cost time by construction, and the lever is `cycles` and how many gates, not a faster gate |

## What a first factory should look like

Resist compiling everything they said. The first factory that runs beats the
complete one that scares them off:

- one **command** gate over the suite (or the seeded lane if there is none);
- **protected paths** over that suite, with the lane profile to route to;
- one **agent-review** gate, `cycles: 1`, only if a review lane already exists
  or the operator wants cross-model review enough to declare one;
- a **human** gate only where they named something they want to see — armed on
  risk classes, never unconditional, unless they truly want to approve
  everything (say what that costs: every change waits for them).

Everything else is a maintenance-flow edit once there is telemetry to argue
from.

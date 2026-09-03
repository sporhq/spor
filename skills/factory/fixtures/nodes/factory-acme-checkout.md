---
id: factory-acme-checkout
type: factory
repo: acme-checkout
title: What "done" means for Acme Checkout
summary: The ordered gates Acme Checkout work must clear between an agent claiming it and it counting as done — the CI suite from main, a cross-model review, and the owner's approval on anything that touches money.
date: 2026-08-26
status: active
edges:
  - {type: relates-to, to: gate-adversarial-review}
  - {type: relates-to, to: profile-acme-test-writer}
  - {type: relates-to, to: profile-acme-rescue}
---

Compiled from the owner's own acceptance criteria (see the interview fixture).
In their words: "someone can't pay — that's the whole business", and "anything
to do with taking money" waits for them; copy and the blog do not.

What this factory refuses:

- work that breaks the suite CI already runs, judged from `main`'s copy of it
  rather than the agent's;
- work whose diff touches the tests that judge it — that fails closed, unrun,
  and is filed to the test-writer lane;
- work a second model finds correctness defects in, until they are fixed or a
  person is asked;
- work touching the billing paths, until the owner approves it.

What it does not yet refuse: a checkout that fails end to end. Nothing covers
that today, which is why `task-acme-checkout-acceptance-suite` exists — the
command gate stays on `npm test` until that suite lands, because a gate
pointing at a command that does not exist fails every item for the wrong reason.

Once every gate above passes — including the owner's own approval on anything
that touches money — the owner does not want to be the release button (Q7):
work lands itself onto `main`, re-running `npm test` on the merged result
first, with one fix cycle before a conflict or that re-run failing comes back
to them the same way a failed review would.

And before any of that reaches them (Q8): a refusal that has spent its fix
cycles is handed to a strong model first — dispatched into the implementer's
own checkout to diagnose why the lane could not converge, fix and commit, and
file the factory change that would have prevented it — and the whole gate list
re-runs on what it leaves. Only if that pass also refuses is the owner paged,
and the item they get opens with the diagnosis. It never passes anything
itself.

```json
{
  "factory": "acme-checkout",
  "trusted_ref": "main",
  "repos": ["acme-checkout"],
  "protected_paths": ["test/**", "e2e/**"],
  "test_lane_profile": "profile-acme-test-writer",
  "risk_classes": {
    "touches:payments": ["lib/billing/**", "**/payments/**", "src/checkout/charge.*"]
  },
  "gates": [
    {"id": "acceptance", "kind": "command", "command": "npm test", "timeout_ms": 900000},
    {"ref": "gate-adversarial-review", "cycles": 1},
    {"id": "payments-approval", "kind": "human", "risk": ["touches:payments"], "instructions": "Anything that takes money. Copy and blog changes do not arm this."}
  ],
  "integration": {
    "target_ref": "main",
    "mode": "local",
    "command": "npm test",
    "strategy": "merge",
    "serialize": "repo",
    "cycles": 1
  },
  "rescue": {
    "profile": "profile-acme-rescue",
    "attempts": 1,
    "await_ms": 3600000,
    "instructions": "Prefer the smallest fix that makes the prior findings resolve; if the review was arguing about naming, say so."
  }
}
```

---
id: gate-adversarial-review
type: gate
repo: acme-checkout
title: Adversarial cross-model review
summary: A second model reads the diff hunting for correctness defects and silently lost orders, with one implementer fix cycle before the failure escalates to a person. Shareable across Acme's factories so the review bar is vetted once.
date: 2026-08-26
status: active
edges:
  - {type: relates-to, to: profile-codex-review}
---

The owner's ask (Q6) was "someone who'd catch it quietly losing an order, not
someone arguing about naming" — so this gate is calibrated for correctness and
data loss, and says outright that style is not blocking. It is a `type: gate`
node rather than an inline gate because every Acme repo wants the same bar; a
factory that needs a tighter cycle cap overrides `cycles` beside the `ref`.

What it does not do: prove anything. A review is a second opinion. Its value is
that the verdict is read in code and an unreadable one counts as a failure —
an unread review is not an approval.

```json
{
  "id": "adversarial-review",
  "kind": "agent-review",
  "profile": "profile-codex-review",
  "cycles": 2,
  "instructions": "Hunt for correctness defects, silently dropped orders, and unhandled payment failures. Rate style, naming and formatting non-blocking."
}
```

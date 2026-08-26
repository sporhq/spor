---
id: task-acme-checkout-acceptance-suite
type: task
project: acme-checkout
title: Write the black-box acceptance suite for buying something
summary: Cover the customer journey the owner named — product page to basket to card to confirmation email — as a black-box suite under e2e/, so the factory's command gate can judge "someone can't pay" instead of only the unit tests.
date: 2026-08-26
profile: profile-acme-test-writer
edges:
  - {type: relates-to, to: factory-acme-checkout}
---

## Acceptance criteria (the owner's words)

1. "Someone can't pay. They put things in the basket, get to the card screen
   and it just fails. That's the whole business."
2. "If the email doesn't arrive they email us, so that counts too."

## The journey to cover

"They land on a product page, add it to the basket, hit checkout, type their
card in, and get an email with the order number."

Their own five-minute manual check is the spec: buy the cheapest item, confirm
the confirmation email arrives, confirm the order shows up in the admin.

## Constraints

Black-box only — drive the product the way a customer does, never by calling
internals. The suite lives under `e2e/`, which is one of the factory's
protected paths: it is the judge, so it is written by this lane and never by
the lane that writes the code under test.

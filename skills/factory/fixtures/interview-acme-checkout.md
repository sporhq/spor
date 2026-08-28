# Dry-run input: the Acme Checkout interview

A worked example of the creation flow — the transcript on this side, the exact
node set a correct compilation of it emits in `nodes/`. `test/factory-skill.test.js`
replays the output half without an LLM: it loads `nodes/` into a scratch graph
with the candidate schemas adopted, lints it with `spor validate`, and parses
the emitted factory with the runner's own vocabulary (`lib/kernel/gates.js`).

## Register

Product. The operator opened with "our agents keep breaking checkout and I find
out from customers" — an outcome, not a mechanism — so the product bank applies
and the pipeline mechanics are proposed rather than asked.

## What the repo read found (step 2, before any proposal)

- `.github/workflows/ci.yaml` runs `npm test` on every push. That is the
  command gate; a gate that disagreed with CI would be a second definition of
  done.
- `test/` holds unit tests. There is **no** black-box suite that drives
  checkout the way a customer does — nothing covers criterion 1 below.
- Default branch is `main`.
- `CLAUDE.md` carries one hard rule that is really a gate in prose: "billing
  changes are reviewed by a second person".

## Transcript (abridged to the answers that became data)

> **Q1. If one thing broke overnight and you only heard about it from a
> customer, what would you least want it to be?**
>
> "Someone can't pay. They put things in the basket, get to the card screen and
> it just fails. That's the whole business."

> **Q2. Walk me through what a customer does, arriving to finished.**
>
> "They land on a product page, add it to the basket, hit checkout, type their
> card in, and get an email with the order number. If the email doesn't arrive
> they email us, so that counts too."

> **Q3. How would you check it still works, in five minutes and no code?**
>
> "I'd buy something. Real card, cheapest item, check the confirmation email
> arrives and the order shows up in the admin."

> **Q4. Anything you'd want to look at yourself before it goes live?**
>
> "Anything to do with taking money. I don't need to see copy changes or the
> blog."

> **Q5. When something goes wrong, who finds out and how?**
>
> "Customers, by email. That's the problem."

> **Q6. Who else should look at an agent's work, and what for?**
>
> "Someone who'd catch it quietly losing an order. Not someone arguing about
> naming."

> **Q7. Once something passes all of that, should it go live by itself, or do
> you want to be the one who pushes it out?**
>
> "If it passed the review and, when it's money stuff, I've okayed it — just
> ship it. I don't want to be the release button for every little thing."

## The proposal that was confirmed (step 4)

1. **Acceptance** — run what CI runs (`npm test`) from `main`'s copy, never the
   agent's. Refuses work that breaks the existing suite. Costs one suite run.
2. **Adversarial review** — a second model reads the diff hunting for silent
   data loss, one fix cycle before it escalates to you. Costs one review
   dispatch. Explicitly not a proof, and not a style argument (Q6).
3. **Payments approval** — anything under the billing paths waits for you.
   Nothing else does (Q4). Costs your attention, only on money changes.
4. Plus: agents may not edit the tests that judge them; a change that touches
   them fails closed and is filed to a test-writer lane instead.
5. Plus: nothing today covers "someone can't pay" end to end, so that criterion
   is seeded as its own item for the test-writer lane — in the owner's words —
   and the command gate is left on `npm test` until that suite lands.
6. **Land it automatically** (Q7) — once the gates above pass, CAS the result
   onto `main` (`mode: local`) rather than wait for a person; the merged tree
   gets `npm test` run on it again first, and a conflict or that re-run failing
   gets one implementer fix cycle before it comes to you the same way a failed
   review would. `mode: propose` (open a PR instead, for orgs whose policy
   forbids a direct land) was not offered — the owner asked to "just ship it",
   not to route it through a PR.

## What was emitted (step 5)

| Node | Why |
|---|---|
| `gate-adversarial-review` | shareable: Q6 applies to every Acme repo, so it is a `type: gate` node other factories reference |
| `profile-codex-review` | the cross-model lane that gate routes to |
| `profile-acme-test-writer` | the lane a protected-path hit routes to, and the one that writes the seeded suite |
| `factory-acme-checkout` | the ordered pipeline, trusted ref, protected paths, the `touches:payments` risk class, and the `integration:` block from Q7 |
| `task-acme-checkout-acceptance-suite` | the missing black-box suite, carrying Q1-Q3 verbatim as its spec |

Nothing was turned on: `spor work --factory factory-acme-checkout` is the
operator's to run.

---
id: profile-acme-test-writer
type: profile
repo: acme-checkout
title: Acceptance test-writer lane
summary: The lane that writes and repairs the black-box acceptance suite — the lane a protected-path hit routes to, kept separate from the lane that writes the code under test.
date: 2026-08-26
harness: claude-code
status: active
---

Separate from the implementer lane on purpose: "tests are more accurate than
the code under test" only holds while the same entity does not author both.
A change that touches the factory's protected paths fails its command gate
closed and is filed here as its own item — same entity, same misunderstanding.

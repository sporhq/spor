---
id: profile-acme-rescue
type: profile
repo: acme-checkout
title: Strong-model rescue lane
summary: The lane Acme's factory-level rescue block routes to — a strong model on a supervised, write-capable harness, dispatched into the implementer's own checkout when a gate has spent its fix cycles, before the owner is paged.
date: 2026-08-26
harness: claude-code
model: claude-fable-5-1
status: active
---

Deliberately the strongest model the team can route to, and deliberately NOT
the implementer's own lane: a rescue diagnoses why the cheaper lane could not
converge — reviewer drift, a real defect it kept patching around, a stale
premise, the environment — and that reading is worth a strong model exactly
once per refusal, not on every item.

Supervised and write-capable by requirement: the runner reads the diagnosis
off the run's final report (a native-background launch would have no report
to read, and the worker refuses to start on one), and the rescue commits in
the same checkout, runs the suite, and files its factory-improvement tasks
with `spor put-node`. It never marks a gate passed — the gates re-run on
whatever it leaves.

This node names a harness and a model, nothing else. What `claude-code`
actually executes is bound on each machine (`dispatch.harness.claude-code`),
never here: a graph write must never define what a machine runs.

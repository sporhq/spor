# Dry run: one interview, one emitted node set

`interview-acme-checkout.md` is the input — a product-register interview, what
reading the repo turned up, and the pipeline that was proposed and confirmed.
`nodes/` is the output: exactly the nodes a correct compilation of that
transcript emits, in the shapes `references/emitting.md` documents.

It is a **worked example, not a template to copy**. Read it for the shape of a
finished emission — how the operator's words survive into the factory body, how
a shareable gate is separated from an inline one, why the command gate is left
on the suite that exists while the missing one is seeded as its own lane item.

## What the test pins (no LLM involved)

`test/factory-skill.test.js` replays the output half deterministically:

1. adopts `schema-factory` and `schema-gate` into a scratch `SPOR_HOME` through
   the real `spor schema adopt --activate`, then copies `nodes/` in;
2. runs the real `spor validate` over that graph — exit 0, no error, and no
   warning naming a fixture file (so a dangling edge or an unknown type in the
   emitted set fails the suite);
3. parses the emitted factory with the runner's own vocabulary
   (`lib/kernel/gates.js parseFactory`), resolving the referenced gate node the
   way the worker does — zero errors, the declared gates in order, the trusted
   ref, the protected paths, the test lane, the risk classes, the
   `integration:` block (`parseIntegration`), and the `rescue:` block
   (`parseRescue`) — routed to a strong-model profile in the emitted set;
4. checks the invariants the skill promises and the runner would otherwise
   discover at worker-start: every referenced gate and every routed profile
   exists as a node in the emitted set, and no profile carries a
   machine-execution key.

The last one is the point of the fixture. A factory that does not validate
refuses to start the worker; this is where that is discovered at test time
instead.

## Applying it by hand

```bash
export SPOR_HOME=$(mktemp -d) && mkdir -p "$SPOR_HOME/nodes"
spor schema adopt schema-factory --activate
spor schema adopt schema-gate --activate
cp skills/factory/fixtures/nodes/*.md "$SPOR_HOME/nodes/"
spor validate
spor get factory-acme-checkout
```

Never against your real graph home — the fixture is a fictional product.

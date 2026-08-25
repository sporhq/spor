---
id: schema-edge-member-of-program
type: schema
kind: edge-schema
schema_version: 2026.08.21.1
title: Schema for member-of-program edges
summary: Edge schema for dedicated program membership — this node is a member of the target program umbrella, independent of whether it also gates it.
date: 2026-08-21
edges:
  - {type: derived-from, to: dec-spor-program-membership-dedicated-edge-type}
---

Program membership as its own edge type, so membership and gating are
independent (dec-spor-program-membership-dedicated-edge-type). The canonical
direction is `member -> umbrella`, the same perspective `blocks` is written
from; the inverse `has-program-member` form is accepted at the write door and
folded onto the member.

`blocks` keeps meaning only gating. A member usually carries both (it is a
member AND it gates the umbrella's completion); a member that does not gate
carries only this edge, and a prerequisite of the umbrella that is not part of
the program carries only `blocks` — a distinction the blocks-topology inference
this replaces could not draw.

Readers (`render_program`, the navigator overview, the gardener's
program-completion pass) prefer these edges PER NODE and fall back to inbound
`blocks` wherever a node declares none, so an unmigrated program keeps working
unchanged. The preference is all-or-nothing at a node: declare ALL of an
umbrella's members in one write, or the un-declared rest stop counting as
members (the program view counts and names them rather than dropping them
silently).

```json
{
  "edge_type": "member-of-program",
  "description": "this node is a member of the target program umbrella",
  "weight": 0.7,
  "inverse_label": "has-program-member",
  "capturable": false
}
```

---
id: bad-edge-line
type: task
title: Garbage line inside a block-form edges list
summary: Exercises the unparseable-edge-entry error for a line that opens no key and continues nothing.
date: 2026-06-01
edges:
  - type: relates-to
    to: dup-a
  not a key line at all
---
The well-formed entry above the garbage line still parses; the file is still SKIPPED by the loader.

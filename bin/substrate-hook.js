#!/usr/bin/env node
// substrate-hook.js — back-compat stub for the Spor rename (SPLIT.md):
// forwards to spor-hook.js. Remove after the dual-read window closes.
const { main, logCrash } = require("./spor-hook.js");

main()
  .catch((err) => logCrash(err))
  .finally(() => process.exit(0));

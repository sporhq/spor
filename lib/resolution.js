// resolution.js — façade over the pure kernel (REFACTOR.md §1 kernel/shell split).
// This path is the stable import for hooks, server, and wf/lenses; the
// implementation lives in lib/kernel/resolution.js (data in, data out, no IO).
module.exports = require("./kernel/resolution.js");

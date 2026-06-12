#!/usr/bin/env node
// Spor validate — lint a Spor graph. Thin CLI wrapper over
// lib/graph.js (validateGraph). All rules live in graph.js.
// Usage: validate.js [--nodes <dir>]
// Errors (exit 1): unparseable file, missing id/type/title/summary, id != filename,
// duplicate id, correction without target.
// Warnings (exit 0): dangling edge, unknown edge type, unknown node type, missing date.

const path = require("path");
const graph = require(path.join(__dirname, "graph.js"));

const argv = process.argv.slice(2);
const i = argv.indexOf("--nodes");
const home = require(path.join(__dirname, "shell", "home.js"));
const NODES_DIR = path.resolve(i >= 0 ? argv[i + 1] : process.env.SPOR_NODES ?? path.join(home.graphHome(), "nodes"));

// validateGraph re-reads the directory itself (tolerating malformed files that
// loadGraph would throw on), so pass the dir rather than a parsed graph.
const { errors, warnings, byType, count } = graph.validateGraph(NODES_DIR);

console.log(`${count} nodes (${Object.entries(byType).map(([t, c]) => `${c} ${t}`).join(", ")})`);
for (const w of warnings) console.log(`WARN  ${w}`);
for (const e of errors) console.log(`ERROR ${e}`);
console.log(`${errors.length} errors, ${warnings.length} warnings`);
process.exit(errors.length ? 1 : 0);

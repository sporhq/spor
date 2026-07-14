#!/usr/bin/env node
// conformance/runner.js — execute the language-neutral conformance suite
// against the JS kernel (REFACTOR.md §2). The suite is the permanent oracle:
// fixture corpora (graph snapshots as plain file maps) + pinned inputs in
// cases/*.json + golden outputs in expected/. A kernel implementation in any
// language passes when it reproduces every expected file byte-for-byte.
//
//   node conformance/runner.js              run all cases, report, exit 1 on drift
//   node conformance/runner.js --case <id>  run one case
//   node conformance/runner.js --update     (re)generate expected outputs
//   node conformance/runner.js --list       list case ids
//
// Semantics a port must reproduce (see README.md for the full contract):
//   - corpus files are presented to the kernel in LEXICOGRAPHIC filename
//     order (byte order of UTF-8 names);
//   - the seed schema pack (lib/seed/) is part of the kernel contract and is
//     an input alongside the corpus;
//   - `now` is always pinned by the case (ISO 8601, parsed to epoch ms);
//   - JSON outputs are serialized with 2-space indent, object keys in
//     construction order, plus a trailing newline;
//   - attached schema code (queueSignals / queue-policy rank) runs under the
//     sandbox contract (no clock, no randomness, JSON boundary) — this
//     runner uses the zero-dep node:vm engine.
//
// The runner is shell-side by design (it reads fixtures off disk and hosts
// the sandbox engine); everything it calls is lib/kernel/*.

const fs = require("fs");
const path = require("path");

const kgraph = require("../lib/kernel/graph.js");
const kqueue = require("../lib/kernel/queue.js");
const { sandboxFor } = require("../lib/sandbox.js");

const ROOT = __dirname;
const CASES_DIR = path.join(ROOT, "cases");
const EXPECTED_DIR = path.join(ROOT, "expected");
const CORPORA_DIR = path.join(ROOT, "corpora");
const SEED_DIR = path.join(ROOT, "..", "lib", "seed");

// Lexicographic order is the defined presentation order (readdir order is
// filesystem-dependent and therefore not part of the contract).
function readFilesSorted(dir) {
  const files = {};
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    files[f] = fs.readFileSync(path.join(dir, f), "utf8");
  }
  return files;
}

let _seed = null;
const seedSchemas = () => (_seed ??= kgraph.parseSeedSchemas(readFilesSorted(SEED_DIR)));

const _graphs = new Map();
function graphFor(corpus) {
  if (!_graphs.has(corpus)) {
    const files = readFilesSorted(path.join(CORPORA_DIR, corpus, "nodes"));
    _graphs.set(corpus, kgraph.buildGraph(files, {
      nodesDir: `/graph/${corpus}/nodes`, // pinned: appears verbatim in digest text
      seedSchemas: seedSchemas(),
    }));
  }
  return _graphs.get(corpus);
}

const json = (x) => JSON.stringify(x, null, 2) + "\n";
const ms = (iso) => Date.parse(iso);

const KINDS = {
  // briefing compile — text out. relevant=false => empty output (the CLI's
  // "inject nothing"); unknown root => the literal marker line.
  compile(c) {
    const g = graphFor(c.corpus);
    const r = kgraph.compile(g, {
      rootId: c.input.rootId ?? null,
      query: c.input.query ?? null,
      digest: !!c.input.digest,
      minSim: c.input.minSim,
      project: c.input.project ?? null, // session repo slug; absent -> project-blind, byte-identical
      seedSchemas: seedSchemas(),
    });
    if (r.unknownRoot) return "UNKNOWN ROOT\n";
    return r.relevant ? r.text : "";
  },

  // briefing skeleton — version/date/compiledAt are case-pinned data.
  skeleton(c) {
    const g = graphFor(c.corpus);
    const r = kgraph.renderSkeleton(g, c.input.rootId, {
      version: c.input.version,
      date: c.input.date,
      compiledAt: c.input.compiledAt,
      seedSchemas: seedSchemas(),
    });
    return r.unknownRoot ? "UNKNOWN ROOT\n" : r.text;
  },

  // queue ranking — JSON out. viewer is a node id resolved in the corpus.
  // `leases` is the injected ephemeral claim-lease table (task-cc-claim-lease-
  // rankqueue): the case pins {nodeId -> {by, expires_iso|expires, reserved?}};
  // `expires_iso` (an ISO string) is parsed to epoch ms here so the fixture
  // stays clock-pinned and human-readable, exactly as `now` is. Absent -> the
  // queue is byte-identical to before this input existed.
  // `timestamps` is the git-derived per-node index ({id: {created_at,
  // updated_at}}, ISO strings) the caller injects (graph.timestamps from
  // loadGraph, task-spor-git-derived-timestamp-index). The fixture corpora are
  // plain file maps with NO git history, so buildGraph derives no index — the
  // case PINS it directly (it is an injected rankQueue input, like leases/front,
  // so the kernel stays clock- and git-agnostic). It feeds the `cold_neighbors`
  // signal, which is surfaced-not-scored by decision
  // (task-spor-cold-neighbors-weight-conformance): the goldens lock that it rides
  // the signal + why-line but adds 0 to the score. Absent -> byte-identical.
  queue(c) {
    const g = graphFor(c.corpus);
    let leases = null;
    if (c.input.leases) {
      leases = {};
      for (const [id, l] of Object.entries(c.input.leases)) {
        leases[id] = { ...l, expires: l.expires_iso != null ? ms(l.expires_iso) : l.expires };
        delete leases[id].expires_iso;
      }
    }
    return json(kqueue.rankQueue(g, {
      project: c.input.project ?? null,
      assignee: c.input.assignee ?? null,
      // agent-readiness filter (dec-spor-agent-readiness-derived-classification):
      // a hard scope narrow to agent|human|untriaged. Absent -> byte-identical.
      readiness: c.input.readiness ?? null,
      activity: c.input.activity ?? null,
      front: c.input.front ?? null,
      leases,
      timestamps: c.input.timestamps ?? null,
      limit: c.input.limit ?? undefined,
      viewer: c.input.viewer ? g.nodes[c.input.viewer] : null,
      now: ms(c.input.now),
      sandboxFor,
    }));
  },

  // validator diagnostics — JSON of the reportable surface (the parsed nodes
  // map is an implementation detail, not part of the oracle).
  validate(c) {
    const files = readFilesSorted(path.join(CORPORA_DIR, c.corpus, "nodes"));
    const r = kgraph.validateGraphFiles(files, seedSchemas());
    return json({ errors: r.errors, warnings: r.warnings, byType: r.byType, count: r.count });
  },

};
// The lens/viewtree and workflow-run kinds moved with their kernels to the
// server-side engine half, which keeps its own conformance goldens; this
// runner covers the client-core kinds only.

function cases() {
  return fs.readdirSync(CASES_DIR).filter((f) => f.endsWith(".json")).sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(CASES_DIR, f), "utf8")));
}

function runCase(c) {
  const kind = KINDS[c.kind];
  if (!kind) throw new Error(`${c.id}: unknown kind '${c.kind}'`);
  return kind(c);
}

const expectedPath = (c) => path.join(EXPECTED_DIR, c.expected);

module.exports = { cases, runCase, expectedPath };

// ---------- CLI ----------

if (require.main === module) {
  const argv = process.argv.slice(2);
  const update = argv.includes("--update");
  const onlyIdx = argv.indexOf("--case");
  const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;

  let all = cases();
  if (argv.includes("--list")) {
    for (const c of all) console.log(`${c.id}  (${c.kind}, ${c.corpus ?? "-"})`);
    process.exit(0);
  }
  if (only) all = all.filter((c) => c.id === only);
  if (!all.length) { console.error("no matching cases"); process.exit(1); }

  let failed = 0;
  for (const c of all) {
    let got;
    try {
      got = runCase(c);
    } catch (e) {
      console.log(`ERROR ${c.id}: ${e.message}`);
      failed++;
      continue;
    }
    const file = expectedPath(c);
    if (update) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, got);
      console.log(`wrote ${c.id} -> expected/${c.expected} (${got.length} bytes)`);
      continue;
    }
    const want = fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n") : null;
    if (want === got) {
      console.log(`ok   ${c.id}`);
    } else {
      failed++;
      if (want === null) {
        console.log(`MISS ${c.id}: expected/${c.expected} absent (run --update)`);
      } else {
        const gl = got.split("\n"), wl = want.split("\n");
        let i = 0;
        while (i < Math.min(gl.length, wl.length) && gl[i] === wl[i]) i++;
        console.log(`FAIL ${c.id}: first divergence at line ${i + 1}`);
        console.log(`  expected: ${JSON.stringify(wl[i] ?? "<eof>")}`);
        console.log(`  got:      ${JSON.stringify(gl[i] ?? "<eof>")}`);
      }
    }
  }
  console.log(`${all.length - failed}/${all.length} conformance cases pass`);
  process.exit(failed ? 1 : 0);
}

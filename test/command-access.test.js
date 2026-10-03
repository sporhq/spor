// Command access classes (task-spor-cli-command-access-classes-for-agent-runs):
// every CLI command that touches the PERSON's credentials declares what it does
// to them — acquire / store-read / store-write — beside its COMMANDS entry, and
// the agent-run guard refuses by CLASS. These tests pin the classification and
// LINT the table: a command (or a new alias) that reaches a credential-store
// primitive without declaring a class fails the suite, so the guard can no
// longer be skipped the way the flat `whoami --all` alias once skipped a
// hand-kept list of spellings.
require('./helpers/tmp-cleanup');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const cli = require('../bin/spor.js');
const { COMMANDS, AUTH_SUBCOMMANDS, ACCESS_CLASSES, commandAccess, isCredentialAcquisition, isCredentialStoreAccess } = cli;

const SRC = fs.readFileSync(path.join(__dirname, '..', 'bin', 'spor.js'), 'utf8');

test('classification: each credential-touching invocation carries its class', () => {
  const cases = [
    [['join', ['tok']], 'acquire'],
    [['login', []], 'acquire'],
    [['auth', ['login', '--web']], 'acquire'],
    [['auth', []], 'store-read'],
    [['auth', ['list']], 'store-read'],
    [['auth', ['whoami', '--all']], 'store-read'],
    [['whoami', ['--all']], 'store-read'],
    [['auth', ['switch', 'acme']], 'store-write'],
    [['auth', ['logout']], 'store-write'],
    [['auth', ['logout', '--all']], 'store-write'],
    [['install', ['claude', '--token', 'x']], 'store-write'],
    [['install', ['--server=https://s']], 'store-write'],
    // The resolved tenant's own reads stay open.
    [['auth', ['whoami']], null],
    [['whoami', []], null],
    [['install', ['claude']], null],
    [['get', ['task-x']], null],
    [['auth', ['bogus']], null],
  ];
  for (const [[canon, args], want] of cases) {
    assert.strictEqual(commandAccess(canon, args), want, `${canon} ${args.join(' ')}`);
  }
  assert.strictEqual(isCredentialAcquisition('auth', ['login']), true);
  assert.strictEqual(isCredentialAcquisition('auth', ['logout']), false);
  assert.strictEqual(isCredentialStoreAccess('whoami', ['--all']), true);
  assert.strictEqual(isCredentialStoreAccess('whoami', []), false);
});

test('table: every auth subcommand declares an access key, and every declared class is a known one', () => {
  for (const [sub, spec] of Object.entries(AUTH_SUBCOMMANDS)) {
    assert.ok('access' in spec, `auth ${sub} declares no access key`);
    assert.strictEqual(typeof spec.run, 'function', `auth ${sub} has no run`);
  }
  const probes = [[], ['--all'], ['--server', 'x'], ['--token=x'], ['x']];
  for (const [canon, entry] of Object.entries(COMMANDS)) {
    if (!('access' in entry)) continue;
    for (const args of probes) {
      const a = commandAccess(canon, canon === 'auth' ? ['whoami', ...args] : args);
      assert.ok(a === null || ACCESS_CLASSES.includes(a), `${canon}: unknown access class ${a}`);
    }
  }
  for (const [sub, spec] of Object.entries(AUTH_SUBCOMMANDS)) {
    for (const args of probes) {
      const a = typeof spec.access === 'function' ? spec.access(args) : spec.access;
      assert.ok(a == null || ACCESS_CLASSES.includes(a), `auth ${sub}: unknown access class ${a}`);
    }
  }
});

test('aliases: a flat alias inherits the class of the auth subcommand it runs', () => {
  for (const args of [[], ['--all'], ['--web']]) {
    assert.strictEqual(commandAccess('whoami', args), commandAccess('auth', ['whoami', ...args]), `whoami ${args}`);
    assert.strictEqual(commandAccess('login', args), commandAccess('auth', ['login', ...args]), `login ${args}`);
  }
});

// The lint. Split bin/spor.js into its top-level functions, build the
// name-reference call graph, and find every function that reaches a
// credential-store primitive (lib/auth.js store reads/writes, or the flat
// config credential writer). Any COMMANDS entry whose `run` reaches one must
// declare `access` — a new verb or alias wired straight to cmdAuthLogout & co.
// cannot ship unclassified.
test('lint: every COMMANDS entry that reaches a credential-store primitive declares an access class', () => {
  const PRIMITIVE = /\bauth\.(readStore|writeStore|upsertTenant|setDefault|removeTenant|clearAll)\(|\bwriteServerToken\(/;
  const bodies = new Map();
  const re = /^(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gm;
  const starts = [];
  let m;
  while ((m = re.exec(SRC))) starts.push({ name: m[1], at: m.index });
  // A top-level `const` (COMMANDS itself, AUTH_SUBCOMMANDS, …) also ends the body before it.
  const stops = [...SRC.matchAll(/^const\s+[A-Za-z0-9_$]+\s*=/gm)].map((x) => x.index);
  for (let i = 0; i < starts.length; i++) {
    const end = Math.min(starts[i + 1] ? starts[i + 1].at : SRC.length, ...stops.filter((s) => s > starts[i].at));
    bodies.set(starts[i].name, SRC.slice(starts[i].at, end));
  }
  // AUTH_SUBCOMMANDS' run closures are part of cmdAuth's reach.
  const table = SRC.slice(SRC.indexOf('const AUTH_SUBCOMMANDS'), SRC.indexOf('function authSubcommand'));
  bodies.set('cmdAuth', bodies.get('cmdAuth') + table);
  // Fixpoint over the name-reference graph: a function reaches the store if it
  // holds a primitive or names a function that does.
  const callees = (src) => [...src.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)].map((x) => x[1]);
  const reach = new Set([...bodies].filter(([, body]) => PRIMITIVE.test(body)).map(([name]) => name));
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, body] of bodies) {
      if (!reach.has(name) && callees(body).some((c) => reach.has(c))) { reach.add(name); grew = true; }
    }
  }
  const visit = (name) => reach.has(name);
  for (const fn of ['cmdAuthLogin', 'cmdAuthList', 'cmdAuthSwitch', 'cmdAuthWhoami', 'cmdAuthLogout', 'cmdJoin', 'cmdInstall', 'cmdAuth']) {
    assert.ok(visit(fn), `the lint's call graph lost ${fn} — it no longer sees a known store path`);
  }
  const offenders = [];
  for (const [canon, entry] of Object.entries(COMMANDS)) {
    if (typeof entry.run !== 'function' || 'access' in entry) continue;
    if (callees(entry.run.toString()).some(visit)) offenders.push(canon);
  }
  assert.deepStrictEqual(offenders, [], `these commands reach the credential store without an access class: ${offenders.join(', ')}`);
});

// shell/candidate-publish.js — publishing a factory CANDIDATE as a PORTABLE
// REFERENCE (task-spor-factory-candidate-portable-reference, §8 item 6 of
// FACTORY-IMPLEMENTATION-STAGE.md; the contract is its §3.4).
//
// kernel/candidate.js mints the object and says what a reference must LOOK
// like (`referenceRefusal`, the shape half). This module is the half that can
// run git and touch a store: it produces the object a reader fetches, puts it
// somewhere a reader can reach with a real compare-and-swap, and then PROVES
// the round trip by fetching its own publish back into a scratch repository.
//
// The property being bought is stated in §3.4 and is the whole reason the key
// exists: a controller that does not share a filesystem with the implementer
// must be able to obtain `commit` and prove it resolves to `tree`. So:
//
//   - `bundle` (the default) is `git bundle create` of `base.merge_base..commit`
//     into the declared store. It needs no credential and no network, and the
//     OBJECT is portable even when the locator is not — copy the file anywhere
//     and it still verifies.
//   - `branch` pushes the pinned commit to `refs/spor/candidates/<id>` on the
//     declared remote, recording the remote's RESOLVED URL: a remote NAME is a
//     thing only the producing machine can resolve, so it is never the locator.
//     `file://`, `https://` and `ssh://` are all reachable here (§3.4); an
//     scp-style spelling (`git@host:org/repo.git`, what `git remote get-url`
//     most often answers) is normalized to its canonical `ssh://` form before
//     it is ever stamped as a locator, since a bare `user@host:path` is not an
//     absolute URI and would be refused as one.
//   - `both` publishes both and carries `references[]`, so a reader picks the
//     door it can reach. `reference` stays the bundle.
//
// There is no `publish: none` (§2.1 E11), which is what gives "unpublished"
// exactly one meaning: a candidate with a `commit` and no
// `reference.verified_at` is a publish OWED, never a deliberate omission.
//
// Every side effect enters through an injected dep (`git`, `http`, `now`), the
// same discipline gate-runner.js and integration-runner.js keep, so the whole
// module is drivable against a throwaway repo and a fake store.
//
// Zero deps; plain Node.
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { fileURLToPath, pathToFileURL } = require("url");

const candidateKernel = require("../kernel/candidate.js");
const gatesKernel = require("../kernel/gates.js");
const { gitSpawn } = require("./git-exec.js");

const defaultGit = (cwd, args, opts = {}) => gitSpawn(cwd, args, opts);

// A worker is UNATTENDED: nobody is there to answer a credential prompt, and a
// `git push`/`fetch`/`ls-remote` that opens one blocks the worker PROCESS
// itself — not a dispatched run, so `work.runIdleMs` never sees it. Every
// remote-touching call therefore runs with prompting disabled and a wall-clock
// bound, while the purely local calls (bundle create, update-ref, rev-parse)
// keep the plain spawn.
const GIT_NET_TIMEOUT_MS = 300000;
// Built PER CALL, never snapshotted at module load: anything exported after
// this file was required (a credential a test or a launcher sets up late) must
// still reach the child.
//
// An askpass HELPER is deliberately REMOVED rather than pointed at something
// harmless: git prefers a helper over the terminal-prompt refusal, and a
// helper that answers at all — `echo` hands the prompt straight back as a
// username — makes a real authentication attempt with garbage instead of
// failing immediately, once per retry, which is the shape that trips a host's
// rate limiting. With no helper, `GIT_TERMINAL_PROMPT=0` is what answers.
function netOpts() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -oBatchMode=yes" };
  delete env.GIT_ASKPASS;
  delete env.SSH_ASKPASS;
  return { timeout: GIT_NET_TIMEOUT_MS, env };
}
const netGit = (git, cwd, args) => git(cwd, args, netOpts());

// The ONE ref name a candidate is published under, in BOTH kinds: `branch`
// pushes it, and a `bundle` carries it as the bundle's own ref so a reader can
// `git fetch <bundle> <ref>` by name. git refuses to bundle a bare revision
// range whose tip names no ref ("Refusing to create empty bundle"), so the
// bundle needs a ref regardless — making it the same one the push uses means a
// reader follows one spelling whichever door it came through.
const CANDIDATE_REF_PREFIX = "refs/spor/candidates/";

// The store's default reach: machine-local state under the graph home, beside
// journal/ and cache/ (and gitignored with them — bundles are binary artifacts
// that must never ride a shared graph repo's git flow).
const DEFAULT_STORE_DIR = "candidates";

// How long a store round trip may take before it is read as an outage. The
// bundle write is local git; only the `https://` door is a network call, and it
// is bounded like every other client HTTP call rather than left to hang a
// worker's slot.
const STORE_TIMEOUT_MS = 30000;

// The scheme a URI names, read with the WHATWG parser rather than a regex —
// it is the one part of a locator that is genuinely a parse, and `new URL` is a
// node builtin (zero-dep). It is used for the SCHEME only, never to rewrite a
// locator: `new URL` NORMALIZES (`file:///a/../b` becomes `file:///b`), and the
// kernel's refusal table deliberately refuses a locator that needs resolving
// rather than silently resolving it. Returns "" for anything that is not an
// absolute URI — a remote name, an scp-style `git@host:path`, a bare path.
function uriScheme(value) {
  try {
    return new URL(String(value)).protocol.replace(/:$/, "").toLowerCase();
  } catch {
    return "";
  }
}

function candidateRef(id) {
  return `${CANDIDATE_REF_PREFIX}${id}`;
}

function bundleKey(id) {
  return `${id}.bundle`;
}

function sha256Bytes(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// The LAST non-empty line of git's stderr — git puts its `fatal:` there, under
// whatever progress or advice preceded it.
function gitReason(text) {
  return (
    String(text || "")
      .trim()
      .split("\n")
      .filter(Boolean)
      .pop() || ""
  );
}

// Which kinds a `publish` word means, in the order they are published. `both`
// puts the bundle FIRST because §3.4 makes the bundle the primary `reference`:
// it is the door that needs no credential, so it is the one a reader that can
// reach only one of the two is likeliest to have.
function publishKinds(publish) {
  const p = String(publish || "bundle").trim().toLowerCase();
  if (p === "both") return ["bundle", "branch"];
  if (p === "branch") return ["branch"];
  return ["bundle"];
}

// `<store>/<key>`, with the store's own trailing slash already dropped by the
// parser. Kept as one function so the locator a publish RECORDS and the locator
// a startup check VALIDATES can never be spelled two ways.
function storeLocator(store, key) {
  return `${String(store).replace(/\/+$/, "")}/${key}`;
}

// The per-mode default store (§2.1). Local mode is `file://<SPOR_HOME>/candidates`.
//
// REMOTE mode's documented default is the server's candidate door
// (`https://<server>/v1/executions/{execution_id}/candidates`, §7.5) — and that
// door is keyed by an EXECUTION id this client does not mint yet
// (task-spor-client-execution-store-adapter owns the execution store; §7.5's
// door is the hosted server's own item). A default that named a URL nobody can
// form would fail every publish in remote mode and, because there is no
// `publish: none`, would take the whole implementation stage with it. So until
// an execution id exists here, remote mode takes the SAME machine-local store:
// the object is portable either way (§3.4's property is a property of the
// bundle, not of the locator's reach), and an operator who wants further reach
// declares `candidate.bundle_store` — which is exactly the key that exists for
// it, and which the hosted door will be declared through as well.
function defaultBundleStore(graphHome) {
  return pathToFileURL(path.join(String(graphHome || ""), DEFAULT_STORE_DIR)).href.replace(/\/+$/, "");
}

// Keep a `file://` store's own directory out of its enclosing git repo's
// tracked tree — bundles are binary artifacts that must never ride a commit.
// This is deliberately scoped to wherever the store ITSELF resolves rather
// than the marker-resolved SHARED graph home
// (task-spor-candidate-store-home-vs-shared-graph-home-trap,
// dec-spor-local-mode-sharing-boundary): the store defaults to
// `userConfigHome()`, which is a DIFFERENT directory from a `graph:`-bound
// shared home, so a `/candidates/` line written into the shared home's
// `.gitignore` regardless of where the store lives is dead weight the vast
// majority of the time and only happens to matter when an operator declares
// `bundle_store` inside the shared home. Following the store's actual
// directory instead makes the two cases the same code path: the default (a
// personal, usually git-init'd `userConfigHome()`) and the override (an
// operator-declared path that may or may not be the shared graph home) both
// get exactly the hygiene they need and nothing they don't.
//
// Guarded on the store actually sitting inside a git working tree — found by
// walking up from its own directory looking for a `.git` (bounded, so a
// pathological/cyclic path can't loop forever; no `git` spawn, matching this
// module's other filesystem-only startup checks). The store need not sit
// directly under the tree's root: a declared `bundle_store` nested several
// directories below it (e.g. `<shared-home>/data/candidates`) is still found,
// and the ignore line is written RELATIVE TO the root it found, not just the
// store's own basename. A store with no enclosing git tree at all has no
// shared-tree hygiene problem to solve, so nothing is written there.
// Best-effort and fail-open like every other side effect in this module's
// satisfiability checks: a failure here must never turn into a store refusal.
function ensureStoreGitignore(dir) {
  try {
    const trimmed = String(dir || "").replace(/[\\/]+$/, "");
    if (!trimmed) return false;
    let root = path.dirname(trimmed);
    let found = null;
    for (let i = 0; i < 64; i++) {
      if (fs.existsSync(path.join(root, ".git"))) {
        found = root;
        break;
      }
      const parent = path.dirname(root);
      if (parent === root) break; // reached the filesystem root
      root = parent;
    }
    if (!found) return false;
    const rel = path.relative(found, trimmed);
    if (!rel || rel.startsWith("..")) return false; // shouldn't happen; refuse rather than guess
    const file = path.join(found, ".gitignore");
    const line = `/${rel.split(path.sep).join("/")}/`;
    let existing = null;
    try {
      existing = fs.readFileSync(file, "utf8");
    } catch {
      existing = null; // absent
    }
    if (existing !== null && existing.split("\n").some((l) => l.trim() === line)) return false;
    const sep = existing === null || existing === "" || existing.endsWith("\n") ? "" : "\n";
    fs.appendFileSync(file, sep + line + "\n");
    return true;
  } catch {
    return false;
  }
}

// The store a factory's publish will actually use, plus the refusals a PARSE
// could not make because it can read neither a filesystem nor a mode (§2.4 E14
// and its sibling writability check).
//
// `configurationErrors` are invalid declarations and remain fatal at startup.
// `unavailable` names runtime failures, retried by the worker before claim.
// `errors` retains their union for execution-side callers and older readers.
function resolveBundleStore(factory, { graphHome, mode = "local" } = {}) {
  const errors = [];
  const unavailable = [];
  const declared = String((factory && factory.implementation && factory.implementation.candidate && factory.implementation.candidate.bundleStore) || "").trim();
  const store = declared || defaultBundleStore(graphHome);
  const proto = uriScheme(store);
  if (proto !== "file" && proto !== "https") {
    // The parser already refuses every other scheme (E12); this only ever
    // fires for a store built from a graph home that is not a path.
    errors.push(`implementation.candidate.bundle_store '${store}' must be a file:// or https:// URI`);
    return { store, errors, configurationErrors: errors, unavailable };
  }
  if (proto === "https" && mode !== "remote") {
    // E14: the hosted candidate door is the server's, so an `https://` store in
    // local mode names a door that does not exist.
    errors.push(`implementation.candidate.bundle_store '${store}' needs a Spor server — local mode has no candidate door; use file://`);
    return { store, errors, configurationErrors: errors, unavailable };
  }
  if (proto === "file") {
    // The two store shapes the kernel's refusal table will reject for EVERY
    // candidate, checked here because they are knowable without a checkout: a
    // store inside a `.git` directory, and one carrying a relative segment. A
    // publish into either can never verify, and a permanent failure classified
    // as an outage would spend the retry pool once per candidate forever.
    // (The third permanent shape — a store under the producing run's own
    // working tree — depends on a cwd a startup check does not have.)
    const segments = String(store)
      .replace(/%2f/gi, "/")
      .replace(/%5c/gi, "\\")
      .replace(/%2e/gi, ".")
      .replace(/\\/g, "/");
    if (/(^|\/)\.git(\/|$)/.test(segments)) {
      errors.push(`implementation.candidate.bundle_store '${store}' points inside a .git directory — a repository's object store is not a store a reader can reach`);
      return { store, errors, configurationErrors: errors, unavailable };
    }
    if (/(^|\/)\.\.?(\/|$)/.test(segments)) {
      errors.push(`implementation.candidate.bundle_store '${store}' carries a relative path segment — a store must name where it points, not need resolving to find out`);
      return { store, errors, configurationErrors: errors, unavailable };
    }
    let dir = null;
    try {
      dir = fileURLToPath(store.endsWith("/") ? store : `${store}/`);
    } catch (e) {
      errors.push(`implementation.candidate.bundle_store '${store}' is not a usable file:// URI (${(e && e.message) || e})`);
      return { store, errors, configurationErrors: errors, unavailable };
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      ensureStoreGitignore(dir);
    } catch (e) {
      unavailable.push(`implementation.candidate.bundle_store '${store}' is not writable from this machine (${(e && e.message) || e})`);
    }
  }
  return { store, errors: [...errors, ...unavailable], configurationErrors: errors, unavailable };
}

// The classic scp-like git remote spelling — `[user@]host:path` — recognized
// only when there are no slashes before the first colon (the same test git
// itself uses, per its own docs, to tell it apart from a local path that
// happens to contain one). `new URL` rejects this shape outright (it is not
// an absolute URI), and git nonetheless accepts it as a remote, so it is
// normalized here to its canonical `ssh://` spelling before it is ever
// compared against a scheme or stamped as a locator.
//
// Deliberately NOT reproducing git's own home-relative-path distinction (a
// path with no leading `/` after the colon technically means "relative to
// the remote user's home directory", spelled in an `ssh://` URL with a
// literal `~` path segment): every host this normalization matters for in
// practice — GitHub, GitLab, Bitbucket, self-hosted forges — routes on the
// path text itself and does not resolve it against a real Unix home
// directory, so scp-style `git@host:org/repo.git` and `git@host:/org/repo.git`
// name the SAME place on every one of them. Inserting `~/` would be the
// textbook-correct reading for a bare git+ssh server with real home
// directories, but it would break the common case this normalization exists
// for (issue-spor-candidate-reference-locator-vocabulary-lacks-ssh) — so both
// spellings collapse to the same `ssh://user@host/path` instead.
const SCP_LIKE_RE = /^([^/]+)@([^/:]+):(.+)$/;
function normalizeScpLikeUrl(value) {
  const s = String(value || "").trim();
  if (!s || uriScheme(s)) return s;
  const m = SCP_LIKE_RE.exec(s);
  if (!m) return s;
  const [, user, host, rest] = m;
  return `ssh://${user}@${host}/${rest.replace(/^\/+/, "")}`;
}

// Whether a remote NAME resolves to a fetch URL in a given checkout. An
// absolute URL (or an scp-style `user@host:path`) is already a locator and
// needs no checkout at all — which is what lets a factory declare one and be
// checkable on a box holding no clone.
// Whether a resolved fetch URL can be a REFERENCE at all. §3.4 admits `file`,
// `https`, and (for a `branch` reference only — see referenceRefusal in
// kernel/candidate.js) `ssh`; anything else — a remote NAME that never
// resolved, `git://`, a bespoke scheme — produces a locator that will be
// refused at the publish. Saying so at startup is the whole point of
// deferring E9 out of the parser: the answer costs an implementer's whole run
// if it waits for the first publish.
function portableRemoteRefusal(url) {
  const proto = uriScheme(url);
  if (proto === "file" || proto === "https" || proto === "ssh") return null;
  if (!proto) return `'${url}' is not an absolute URI — a candidate reference is fetched over file://, https://, or ssh://`;
  return `'${url}' is a ${proto}:// remote — a candidate reference is fetched over file://, https://, or ssh://`;
}

function resolveRemoteUrl(remote, cwd, { git = defaultGit } = {}) {
  const name = String(remote || "").trim() || "origin";
  // An absolute URI is already a locator; so is an scp-style `git@host:path`,
  // normalized to its canonical `ssh://` spelling so `portableRemoteRefusal`
  // and the kernel's own refusal table see one shape instead of two.
  if (uriScheme(name) || /^[^/]+@[^/]+:/.test(name)) return { ok: true, url: normalizeScpLikeUrl(name), declared: true };
  if (!cwd) return { ok: false, reason: `the remote name '${name}' can only be resolved inside a checkout, and none was given` };
  const r = git(cwd, ["remote", "get-url", name]);
  const url = r && r.status === 0 ? String(r.stdout || "").trim() : "";
  if (!url) return { ok: false, reason: `no git remote named '${name}' in ${cwd}` };
  // The checkout's own `git remote get-url` answer is exactly as likely to be
  // scp-style as a declared one — it is what most real `origin` remotes are.
  return { ok: true, url: normalizeScpLikeUrl(url), declared: false };
}

// Synchronous declaration/filesystem checks shared by startup diagnostics and
// per-item preflight. The worker passes one repo at selection time so a healthy
// sibling repo never masks the selected item's missing remote. Network probes
// are separate and bounded in factory-availability.js; actual publish still
// verifies its immutable reference after claim.
function publishSatisfiability(factory, { graphHome, mode = "local", repoPaths = {}, git = defaultGit } = {}) {
  const errors = [];
  const warnings = [];
  const configurationErrors = [];
  const unavailable = [];
  if (!factory || !factory.implementation) return { ok: true, errors, warnings, configurationErrors, unavailable, store: null };
  const kinds = publishKinds(factory.implementation.candidate && factory.implementation.candidate.publish);
  let store = null;
  if (kinds.includes("bundle")) {
    const resolved = resolveBundleStore(factory, { graphHome, mode });
    store = resolved.store;
    errors.push(...resolved.errors);
    configurationErrors.push(...(resolved.configurationErrors || resolved.errors));
    unavailable.push(...resolved.unavailable);
  }
  if (kinds.includes("branch")) {
    const remote = String((factory.implementation.candidate && factory.implementation.candidate.remote) || "").trim() || "origin";
    const dirs = Object.entries(repoPaths || {}).filter(([, p]) => p);
    const direct = resolveRemoteUrl(remote, null, { git });
    if (direct.ok) {
      // A declared URL is the locator itself; nothing about a checkout can
      // change that verdict — except whether it is a scheme a reader can fetch.
      const refusal = portableRemoteRefusal(direct.url);
      if (refusal) { const reason = `implementation.candidate.remote ${refusal}`; errors.push(reason); configurationErrors.push(reason); }
    } else if (!dirs.length) {
      warnings.push(
        `implementation.candidate.publish is '${factory.implementation.candidate.publish}' and names remote '${remote}', but no checkout of ${(factory.repos || []).join(", ") || "this factory's repos"} is known on this machine (dispatch.repos) — the remote will be checked on each selected item before claim.`
      );
    } else {
      const resolved = dirs.map(([slug, dir]) => [slug, resolveRemoteUrl(remote, dir, { git })]);
      const missing = resolved.filter(([, r]) => !r.ok).map(([slug]) => slug);
      // A remote that resolves to a scheme no reader can fetch is worse than a
      // missing one: it looks configured. Refused wherever it appears, never
      // downgraded to a warning by a sibling repo that happens to be fine.
      for (const [slug, r] of resolved) {
        if (!r.ok) continue;
        const refusal = portableRemoteRefusal(r.url);
        if (refusal) { const reason = `the git remote '${remote}' in ${slug} resolves to ${refusal}`; errors.push(reason); configurationErrors.push(reason); }
      }
      if (missing.length === dirs.length) {
        unavailable.push(
          `implementation.candidate.publish is '${factory.implementation.candidate.publish}' but no git remote named '${remote}' exists in ${missing.join(", ")} — declare implementation.candidate.remote, or add the remote to the checkout.`
        );
      } else if (missing.length) {
        warnings.push(`no git remote named '${remote}' in ${missing.join(", ")} — candidates from ${missing.length === 1 ? "that repo" : "those repos"} cannot publish a branch reference.`);
      }
    }
  }
  return { ok: errors.length === 0 && unavailable.length === 0, errors: [...errors, ...unavailable.filter(e => !errors.includes(e))], configurationErrors, unavailable, warnings, store };
}

// ------------------------------------------------------------ the publish --

function attemptEntry({ index, kind, outcome, at, locator = null, reason = null, pool = null }) {
  return { index, kind, outcome, at, locator, reason, pool };
}

// Write the bundle for `merge_base..commit` under a ref named for the
// candidate. The temp ref is created and removed around the bundle so the
// producing checkout is left exactly as it was found — a worker's checkout is
// also a fix cycle's and a rescue's, and a stray ref is a fact nobody wrote.
function createBundle(cand, cwd, dest, { git = defaultGit } = {}) {
  const ref = candidateRef(cand.candidate_id);
  const set = git(cwd, ["update-ref", ref, cand.commit]);
  if (set.status !== 0) return { ok: false, reason: `could not name the candidate commit for bundling: ${gitReason(set.stderr) || "git update-ref failed"}` };
  try {
    const made = git(cwd, ["bundle", "create", dest, `${cand.base.merge_base}..${ref}`], { maxBuffer: 16 * 1024 * 1024 });
    if (made.status !== 0) return { ok: false, reason: `git bundle create failed: ${gitReason(made.stderr) || "no reason given"}` };
  } finally {
    git(cwd, ["update-ref", "-d", ref]);
  }
  return { ok: true };
}

// Put the bytes into a `file://` store with a real compare-and-swap: an
// EXCLUSIVE create, never an overwrite. A store that already holds the id is
// not a race to win — it is either the same publish replayed (a crash after a
// landed put) or two different objects under one content-addressed id, which is
// corruption. So the existing object is READ and compared rather than assumed.
function putFileStore(store, key, bytes) {
  let dir;
  try {
    dir = fileURLToPath(store.endsWith("/") ? store : `${store}/`);
  } catch (e) {
    return { ok: false, classification: "infrastructure", reason: `the bundle store '${store}' is not a usable file:// URI (${(e && e.message) || e})` };
  }
  const target = path.join(dir, key);
  let tmp = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    tmp = path.join(dir, `.${key}.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, bytes);
    // HARDLINK a FINISHED file into place, not a copy: `copyFileSync` with
    // COPYFILE_EXCL creates the target empty and then fills it, so a reader
    // fetching mid-put sees a truncated bundle and a racing producer sees a
    // partial file where it expects an object. `link()` publishes complete
    // bytes in one atomic step and fails EEXIST atomically — the same
    // primitive, and the same fallback, `createNodeExclusive` uses where
    // link() is unavailable.
    try {
      fs.linkSync(tmp, target);
    } catch (linkErr) {
      if (!linkErr || !["EPERM", "EOPNOTSUPP", "ENOSYS", "EXDEV"].includes(linkErr.code)) throw linkErr;
      // No hardlinks here: reserve the name exclusively, then rename the
      // finished file over the reservation. A rename that FAILS must take the
      // reservation with it — a 0-byte file left at a content-addressed id is
      // an object that can never verify, so every later attempt would read it
      // as a different object and refuse the id permanently.
      fs.closeSync(fs.openSync(target, "wx"));
      try {
        fs.renameSync(tmp, target);
      } catch (renameErr) {
        try {
          fs.unlinkSync(target);
        } catch {
          /* nothing more to do — the reservation is reported below either way */
        }
        throw renameErr;
      }
      tmp = null;
    }
    return { ok: true, outcome: "published" };
  } catch (e) {
    if (!e || e.code !== "EEXIST") {
      return { ok: false, classification: "infrastructure", reason: `the bundle could not be written to '${store}': ${(e && e.message) || e}` };
    }
    // OCCUPIED, not yet a conflict. WHAT is under the id is settled by the
    // CALLER, which fetches it and asks whether it resolves to the pinned
    // commit and tree — never by comparing bytes here, because `git bundle
    // create` is not byte-reproducible (threaded delta search alone changes the
    // packfile run to run), so a legitimate retry after a landed put produces
    // different bytes for the same content and a byte comparison would call it
    // corruption forever.
    return { ok: true, outcome: "occupied" };
  } finally {
    if (tmp) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* a leaked temp beside the store is not worth failing a publish over */
      }
    }
  }
}

// The same CAS against the hosted door (§7.5): `PUT` answers 201 on create, 200
// when the id already holds the same bytes and 409 when it holds different
// ones. Both of the latter are OCCUPIED here rather than a verdict — what is
// under the id is decided by the caller, which fetches it and checks the commit
// and tree it resolves to, for the same non-reproducibility reason the file arm
// gives.
async function putHttpStore(store, key, bytes, http) {
  const locator = storeLocator(store, key);
  if (!http || typeof http.put !== "function" || typeof http.get !== "function") {
    return { ok: false, classification: "infrastructure", reason: `no HTTPS store client is configured, so '${locator}' cannot be written` };
  }
  let res;
  try {
    res = await http.put(locator, bytes);
  } catch (e) {
    return { ok: false, classification: "infrastructure", reason: `PUT ${locator} failed: ${(e && e.message) || e}` };
  }
  const status = res && res.status;
  if (status === 201) return { ok: true, outcome: "published" };
  if (status === 200 || status === 409) return { ok: true, outcome: "occupied" };
  return { ok: false, classification: "infrastructure", reason: `PUT ${locator} answered ${status || "no status"}${res && res.error ? ` (${res.error})` : ""}` };
}

// Fetch our own publish back and check it against the candidate — the step that
// makes `verified_at` mean something (§3.4). It is a ROUND TRIP, never a read of
// the working tree: a bundle written truncated or a ref that landed on the wrong
// commit is caught here, on the machine that can still fix it.
//
// The scratch repository needs the prerequisite the bundle was cut against
// (`git bundle verify` and the fetch both refuse without it), so it first pulls
// the base from the PRODUCING repository — which is exactly what a real reader
// has from the trusted ref's history, and is the only part of the round trip
// that may touch the producer at all: the commit itself comes from the locator.
function verifyPublished(cand, { kind, locator, source, base, git = defaultGit }) {
  let scratch = null;
  try {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "spor-cand-verify-"));
  } catch (e) {
    return { ok: false, classification: "infrastructure", reason: `could not create a scratch repository to verify the publish: ${(e && e.message) || e}` };
  }
  try {
    const init = git(scratch, ["init", "-q", "--bare"]);
    if (init.status !== 0) return { ok: false, classification: "infrastructure", reason: `could not initialize the verification repository: ${gitReason(init.stderr) || "git init failed"}` };
    if (kind === "bundle") {
      // The prerequisite. A bare sha is not fetchable by default (the server
      // side refuses an arbitrary want), so the base is pulled by REF NAME with
      // a wildcard fallback for a candidate whose base ref is unnamed here.
      // The prerequisite. A bare sha is not fetchable by default (the server
      // side refuses an arbitrary want), so the base is pulled by REF NAME,
      // with a WILDCARD as the fallback: a named ref that still resolves may no
      // longer REACH the merge base (the trusted ref moved under a long run),
      // and the only way to find that out is to verify and look. So the specs
      // are tried in order, and a `bundle verify` that reports the prerequisite
      // missing walks on to the next one rather than settling a verdict on a
      // base this repository simply has not got yet.
      const specs = [];
      if (base && base.ref) specs.push(`+${base.ref}:refs/spor/verify-base`);
      specs.push("+refs/heads/*:refs/spor/verify-base/*");
      let verified = null;
      let fetchedAny = false;
      for (const spec of specs) {
        if (git(scratch, ["fetch", "--no-tags", "-q", source, spec]).status !== 0) continue;
        fetchedAny = true;
        verified = git(scratch, ["bundle", "verify", locator]);
        if (verified.status === 0) break;
        // Only a MISSING PREREQUISITE is worth another spec; an unreadable
        // bundle reads the same however the base got here.
        if (!/prerequisite/i.test(String(verified.stderr || ""))) break;
      }
      if (!fetchedAny) {
        return { ok: false, classification: "infrastructure", reason: `the bundle's prerequisite ${String(base && base.merge_base).slice(0, 12)} could not be obtained from ${source}, so the publish could not be verified` };
      }
      if (verified.status !== 0) {
        // A MISSING PREREQUISITE is not a bad bundle: it means this scratch
        // repository could not obtain the base, which happens when the
        // producing checkout's own trusted ref moved off the merge base under
        // a long run (a force-push, a rebase). Reading a perfectly good bundle
        // as corrupt evidence would escalate it permanently, so it stays on
        // the retryable side; only an unreadable bundle is a mismatch.
        if (/prerequisite/i.test(String(verified.stderr || ""))) {
          return { ok: false, classification: "infrastructure", reason: `the bundle at '${locator}' could not be verified here: its prerequisite ${String(base && base.merge_base).slice(0, 12)} is no longer obtainable from ${source}` };
        }
        return { ok: false, classification: "candidate-mismatch", reason: `the published bundle at '${locator}' does not verify: ${gitReason(verified.stderr) || "git bundle verify failed"}` };
      }
    }
    const spec = `+${candidateRef(cand.candidate_id)}:refs/spor/verify-tip`;
    // A `branch` locator is a whole repository, and everything this check needs
    // is the tip commit and its tree — so ask for depth 1 first and fall back
    // only if the transport refuses it. A bundle is already exactly the range
    // it was cut from, and shallow-fetching one buys nothing.
    let fetched = { status: 1 };
    if (kind === "branch") fetched = netGit(git, scratch, ["fetch", "--no-tags", "-q", "--depth=1", locator, spec]);
    if (fetched.status !== 0) fetched = kind === "branch" ? netGit(git, scratch, ["fetch", "--no-tags", "-q", locator, spec]) : git(scratch, ["fetch", "--no-tags", "-q", locator, spec]);
    if (fetched.status !== 0) {
      return { ok: false, classification: "infrastructure", reason: `the published candidate could not be fetched back from '${locator}': ${gitReason(fetched.stderr) || "git fetch failed"}` };
    }
    const tip = git(scratch, ["rev-parse", "refs/spor/verify-tip"]);
    const tree = git(scratch, ["rev-parse", "refs/spor/verify-tip^{tree}"]);
    if (tip.status !== 0 || tree.status !== 0) {
      return { ok: false, classification: "infrastructure", reason: `the fetched candidate could not be read back from '${locator}'` };
    }
    const gotCommit = String(tip.stdout || "").trim();
    const gotTree = String(tree.stdout || "").trim();
    if (gotCommit !== cand.commit) {
      return { ok: false, classification: "candidate-mismatch", reason: `'${locator}' holds commit ${gotCommit.slice(0, 12)}, but the candidate pins ${String(cand.commit).slice(0, 12)}` };
    }
    if (gotTree !== cand.tree) {
      return { ok: false, classification: "candidate-mismatch", reason: `the commit at '${locator}' resolves to tree ${gotTree.slice(0, 12)}, but the candidate pins ${String(cand.tree).slice(0, 12)}` };
    }
    return { ok: true };
  } finally {
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch {
      /* a leaked scratch dir is not worth failing a publish over */
    }
  }
}

async function publishBundle(cand, { cwd, store, git, http }) {
  const key = bundleKey(cand.candidate_id);
  const locator = storeLocator(store, key);
  const isFile = store.toLowerCase().startsWith("file://");
  let workdir = null;
  try {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "spor-cand-bundle-"));
  } catch (e) {
    return { ok: false, classification: "infrastructure", reason: `could not stage the bundle: ${(e && e.message) || e}` };
  }
  try {
    const local = path.join(workdir, key);
    const made = createBundle(cand, cwd, local, { git });
    if (!made.ok) return { ok: false, classification: "infrastructure", reason: made.reason };
    let bytes;
    try {
      bytes = fs.readFileSync(local);
    } catch (e) {
      return { ok: false, classification: "infrastructure", reason: `the bundle could not be read back after it was written: ${(e && e.message) || e}` };
    }
    const put = isFile ? putFileStore(store, key, bytes) : await putHttpStore(store, key, bytes, http);
    if (!put.ok) return put;

    // Read back WHAT IS IN THE STORE — never the staged copy — because that is
    // what a reader fetches, and because after an `occupied` put it may not be
    // our bytes at all. Its own sha256 is what goes on the reference, so the
    // digest a reader checks is the digest of the object it will actually get.
    let stored;
    let fetchFrom;
    if (isFile) {
      try {
        fetchFrom = fileURLToPath(locator);
        stored = fs.readFileSync(fetchFrom);
      } catch (e) {
        return { ok: false, classification: "infrastructure", reason: `the published bundle could not be read back from '${locator}': ${(e && e.message) || e}` };
      }
    } else {
      let got;
      try {
        got = await http.get(locator);
      } catch (e) {
        return { ok: false, classification: "infrastructure", reason: `the published bundle could not be fetched back from '${locator}': ${(e && e.message) || e}` };
      }
      if (!got || !got.ok || !got.buffer) {
        return { ok: false, classification: "infrastructure", reason: `the published bundle could not be fetched back from '${locator}' (GET ${got && got.status ? got.status : "failed"})` };
      }
      stored = got.buffer;
      fetchFrom = path.join(workdir, `fetched-${key}`);
      try {
        fs.writeFileSync(fetchFrom, stored);
      } catch (e) {
        return { ok: false, classification: "infrastructure", reason: `the fetched bundle could not be staged for verification: ${(e && e.message) || e}` };
      }
    }
    // TRUNCATION, on the one arm where a byte comparison is valid: an object we
    // ourselves just put, compared against the very bytes we put — never
    // against a second `bundle create` run, so the reproducibility problem does
    // not arise. It is worth its own check because `git bundle verify` exits 0
    // on a truncated bundle (it reads the header and the prerequisite list, not
    // the pack), and the fetch that then fails reads as an outage — draining
    // the retry pool against a store that is up and holding a corrupt object.
    if (put.outcome === "published" && sha256Bytes(stored) !== sha256Bytes(bytes)) {
      return {
        ok: false,
        classification: "candidate-mismatch",
        reason: `'${locator}' holds ${stored.length} bytes, not the ${bytes.length} we published — the store did not keep what it was given`,
      };
    }
    const verified = verifyPublished(cand, { kind: "bundle", locator: fetchFrom, source: cwd, base: cand.base, git });
    if (!verified.ok) {
      // WHOSE object failed decides what the failure means. An object WE just
      // wrote that does not verify is a store that mangled our bytes — a
      // candidate whose evidence does not describe it. An object that was
      // ALREADY there and does not verify is a different candidate's object
      // under our content-addressed id, which is corruption, not a race. Only
      // a transport-level failure (`infrastructure`) is passed through as-is.
      if (verified.classification === "candidate-mismatch" && put.outcome === "occupied") {
        return { ok: false, classification: "publish-conflict", reason: `'${locator}' already holds a DIFFERENT object — ${verified.reason}` };
      }
      return verified;
    }
    return {
      ok: true,
      // An `occupied` id whose object VERIFIES is this publish replayed: the
      // pinned commit never moves (§3.2, first published wins), so an object
      // resolving to our commit and tree IS our candidate however its bytes
      // were packed.
      outcome: put.outcome === "occupied" ? "replayed" : "published",
      reference: { kind: "bundle", store, key, locator, commit: cand.commit, sha256: sha256Bytes(stored), bytes: stored.length },
    };
  } finally {
    try {
      fs.rmSync(workdir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

function publishBranch(cand, { cwd, remote, git }) {
  const resolved = resolveRemoteUrl(remote, cwd, { git });
  if (!resolved.ok) return { ok: false, classification: "infrastructure", reason: resolved.reason };
  const url = resolved.url;
  const ref = candidateRef(cand.candidate_id);
  // `--force-with-lease=<ref>:` with an EMPTY expectation is "create only if
  // absent" — never `--force`. A rejection is therefore proof the ref exists,
  // which is read (not assumed) below.
  const pushed = netGit(git, cwd, ["push", url, `${cand.commit}:${ref}`, `--force-with-lease=${ref}:`]);
  let outcome = "published";
  if (pushed.status !== 0) {
    const ls = netGit(git, cwd, ["ls-remote", url, ref]);
    if (ls.status !== 0) {
      return { ok: false, classification: "infrastructure", reason: `the candidate could not be pushed to '${url}' and the ref could not be read back: ${gitReason(pushed.stderr) || "git push failed"}` };
    }
    const there = String(ls.stdout || "").trim().split(/\s+/)[0] || "";
    if (!there) {
      return { ok: false, classification: "infrastructure", reason: `the candidate could not be pushed to '${url}': ${gitReason(pushed.stderr) || "git push failed"}` };
    }
    if (there !== cand.commit) {
      return {
        ok: false,
        classification: "publish-conflict",
        reason: `'${url}' already holds ${there.slice(0, 12)} at ${ref}, not the pinned ${String(cand.commit).slice(0, 12)} — two commits under one content-addressed id is corruption, not a race`,
      };
    }
    // The ref is already ours: a crash after a landed push, replayed.
    outcome = "replayed";
  }
  const verified = verifyPublished(cand, { kind: "branch", locator: url, source: cwd, base: cand.base, git });
  if (!verified.ok) return verified;
  return { ok: true, outcome, reference: { kind: "branch", locator: url, ref, commit: cand.commit } };
}

// Publish a candidate and return it with its reference stamped, or the reason
// the publish is still owed.
//
// Success returns `{ok: true, candidate}` where the candidate carries
// `reference` (verified), `references[]` under `both`, and the
// `publish_attempts[]` trail. Failure returns `{ok: false, classification,
// reason, candidate}` — the candidate still carries the attempt trail, because
// the failed attempt is what a pool may be charged against (§5.3,
// `gates.publishOutcomePool` is the one place that decides which) and what an
// escalation names. `classification` is one of:
//
//   - `infrastructure` — a genuine outage: an unreachable store, a write or a
//     fetch that failed: re-attemptable FROM THE WORKSPACE under the retry
//     pool, never by re-dispatching the implementer (§3.4);
//   - `unpublishable` — the reference's SHAPE can never verify, however many
//     times it is tried (e.g. a bundle store resolving under the producing
//     run's own working tree — gone as soon as the run is,
//     `referenceRefusal` in kernel/candidate.js): the guard already knows
//     this is not an outage, so it spends no pool and escalates naming the
//     shape (issue-spor-unpublishable-reference-shape-classified-
//     infrastructure-until-pool-drains) instead of being retried until the
//     retry pool drains;
//   - `candidate-mismatch` — the published evidence does not describe the
//     candidate: escalated, consuming no pool;
//   - `publish-conflict` — the id already holds a different object: refused and
//     escalated exactly like a mismatch.
//
// A candidate that is ALREADY verified publishes nothing and is returned
// unchanged: `publish` runs at submission and at every re-pin, and a re-pin
// that only grew `commits_seen` is the same published object (§3.4).
async function publishCandidate(cand, { cwd, publish = "bundle", bundleStore = null, bundleStoreReason = "", remote = "", git = defaultGit, http = null, now = () => new Date().toISOString() } = {}) {
  if (!cand || typeof cand !== "object") return { ok: false, classification: "infrastructure", reason: "there is no candidate to publish", candidate: cand || null };
  if (candidateKernel.candidateSubmitted(cand)) return { ok: true, candidate: cand, published: false };
  if (!cwd) return { ok: false, classification: "infrastructure", reason: "the producing workspace is gone, so the candidate cannot be published from it", candidate: cand };

  const kinds = publishKinds(publish);
  const attempts = Array.isArray(cand.publish_attempts) ? cand.publish_attempts.slice() : [];
  const refs = [];
  for (const kind of kinds) {
    const at = now();
    const index = attempts.length + 1;
    let r;
    try {
      // An unusable store leaves the SAME attempt trail every other failure
      // does: it is the record the retry pool is charged against and the one
      // an escalation names, so short-circuiting before it would show an
      // outcome classifier a stage that never tried to publish at all.
      if (kind === "bundle" && !bundleStore) {
        r = { ok: false, classification: "infrastructure", reason: bundleStoreReason || "no bundle store is configured, so the candidate has nowhere to publish to" };
      } else r = kind === "bundle" ? await publishBundle(cand, { cwd, store: bundleStore, git, http }) : publishBranch(cand, { cwd, remote, git });
    } catch (e) {
      r = { ok: false, classification: "infrastructure", reason: `the ${kind} publish threw: ${(e && e.message) || e}` };
    }
    if (r.ok) {
      // The producer checks its OWN reference against the same refusal table
      // every reader applies (§3.4): a locator inside the working tree, a bare
      // sha, a relative path is never stamped. Every reason this table can
      // give is a SHAPE the guard already knows can never verify — never an
      // outage a retry could fix — so it is `unpublishable`, not
      // `infrastructure`: classifying it an outage would burn the whole
      // retry pool on a store/remote combination that was never going to
      // succeed (issue-spor-unpublishable-reference-shape-classified-
      // infrastructure-until-pool-drains). The one shape a startup check
      // cannot rule out — a store under the producing run's own working
      // tree — needs this run's cwd, which resolveBundleStore never has; it
      // reaches exactly here, on the first publish attempt, and only once.
      const refusal = candidateKernel.referenceRefusal(r.reference, { bundleStore: kind === "bundle" ? bundleStore : null, cwd });
      if (refusal) r = { ok: false, classification: "unpublishable", reason: refusal };
    }
    if (!r.ok) {
      attempts.push(attemptEntry({ index, kind, outcome: r.classification === "infrastructure" ? "failed" : r.classification, at, reason: r.reason, pool: gatesKernel.publishOutcomePool(r.classification) }));
      return { ok: false, classification: r.classification, reason: r.reason, candidate: { ...cand, publish_attempts: attempts } };
    }
    attempts.push(attemptEntry({ index, kind, outcome: r.outcome, at, locator: r.reference.locator }));
    refs.push({ ...r.reference, verified_at: now() });
  }
  const published = { ...cand, reference: refs[0], publish_attempts: attempts };
  // §3.4: only `both` carries `references[]`. A single-kind publish has one
  // door and a second field saying so would be one more thing to keep in sync.
  if (refs.length > 1) published.references = refs;
  return { ok: true, candidate: published, published: true };
}

// The default HTTPS store client: a bearer-authenticated PUT/GET of raw bytes
// against the hosted candidate door (§7.5). Separated from the publish so tests
// drive a fake store and the one place that speaks HTTP stays this small.
function httpStoreClient({ bearer = null, timeoutMs = STORE_TIMEOUT_MS } = {}) {
  const headers = bearer ? { Authorization: `Bearer ${bearer}` } : {};
  const call = async (method, url, body) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: { ...headers, ...(body ? { "Content-Type": "application/octet-stream" } : {}) },
        body,
        signal: ctrl.signal,
      });
      const buffer = method === "GET" ? Buffer.from(await res.arrayBuffer()) : null;
      return { ok: res.ok, status: res.status, buffer };
    } catch (e) {
      return { ok: false, status: 0, error: (e && e.message) || String(e) };
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    put: (url, bytes) => call("PUT", url, bytes),
    get: (url) => call("GET", url),
  };
}

module.exports = {
  CANDIDATE_REF_PREFIX,
  DEFAULT_STORE_DIR,
  STORE_TIMEOUT_MS,
  uriScheme,
  normalizeScpLikeUrl,
  candidateRef,
  bundleKey,
  publishKinds,
  storeLocator,
  defaultBundleStore,
  ensureStoreGitignore,
  resolveBundleStore,
  resolveRemoteUrl,
  portableRemoteRefusal,
  publishSatisfiability,
  publishCandidate,
  httpStoreClient,
};

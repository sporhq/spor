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
const { gitSpawn } = require("./git-exec.js");

const defaultGit = (cwd, args, opts = {}) => gitSpawn(cwd, args, opts);

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

// The store a factory's publish will actually use, plus the refusals a PARSE
// could not make because it can read neither a filesystem nor a mode (§2.4 E14
// and its sibling writability check).
//
// Returns {store, errors[]}. A non-empty `errors` is a startup refusal: unlike
// the `gh`/propose check — where a box that cannot land a proposal can still
// idle usefully while a capable box takes the work — there is no per-item
// degrade path here. Every candidate must publish, so a worker whose store is
// unusable can complete nothing at all, and saying so once at startup is more
// honest than failing every item identically.
function resolveBundleStore(factory, { graphHome, mode = "local" } = {}) {
  const errors = [];
  const declared = String((factory && factory.implementation && factory.implementation.candidate && factory.implementation.candidate.bundleStore) || "").trim();
  const store = declared || defaultBundleStore(graphHome);
  const proto = uriScheme(store);
  if (proto !== "file" && proto !== "https") {
    // The parser already refuses every other scheme (E12); this only ever
    // fires for a store built from a graph home that is not a path.
    errors.push(`implementation.candidate.bundle_store '${store}' must be a file:// or https:// URI`);
    return { store, errors };
  }
  if (proto === "https" && mode !== "remote") {
    // E14: the hosted candidate door is the server's, so an `https://` store in
    // local mode names a door that does not exist.
    errors.push(`implementation.candidate.bundle_store '${store}' needs a Spor server — local mode has no candidate door; use file://`);
    return { store, errors };
  }
  if (proto === "file") {
    let dir = null;
    try {
      dir = fileURLToPath(store.endsWith("/") ? store : `${store}/`);
    } catch (e) {
      errors.push(`implementation.candidate.bundle_store '${store}' is not a usable file:// URI (${(e && e.message) || e})`);
      return { store, errors };
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
    } catch (e) {
      errors.push(`implementation.candidate.bundle_store '${store}' is not writable from this machine (${(e && e.message) || e})`);
    }
  }
  return { store, errors };
}

// Whether a remote NAME resolves to a fetch URL in a given checkout. An
// absolute URL (or an scp-style `user@host:path`) is already a locator and
// needs no checkout at all — which is what lets a factory declare one and be
// checkable on a box holding no clone.
// Whether a resolved fetch URL can be a REFERENCE at all. §3.4 admits `file`
// and `https` only, and the kernel's own refusal table enforces it on every
// reader — so an `ssh://`/scp-style remote (`git@host:path`), which is what
// `git remote get-url origin` most often answers, produces a locator that will
// be refused at the publish. Saying so at startup is the whole point of
// deferring E9 out of the parser: the answer costs an implementer's whole run
// if it waits for the first publish.
function portableRemoteRefusal(url) {
  const proto = uriScheme(url);
  if (proto === "file" || proto === "https") return null;
  if (!proto) return `'${url}' is not an absolute URI — a candidate reference is fetched over file:// or https://`;
  return `'${url}' is a ${proto}:// remote — a candidate reference is fetched over file:// or https://`;
}

function resolveRemoteUrl(remote, cwd, { git = defaultGit } = {}) {
  const name = String(remote || "").trim() || "origin";
  // An absolute URI is already a locator; so is an scp-style `git@host:path`,
  // which `new URL` rejects and which git nonetheless accepts as a remote —
  // it is carried through so `portableRemoteRefusal` can name it for what it
  // is rather than this reporting it as an unresolvable name.
  if (uriScheme(name) || /^[^/]+@[^/]+:/.test(name)) return { ok: true, url: name, declared: true };
  if (!cwd) return { ok: false, reason: `the remote name '${name}' can only be resolved inside a checkout, and none was given` };
  const r = git(cwd, ["remote", "get-url", name]);
  const url = r && r.status === 0 ? String(r.stdout || "").trim() : "";
  if (!url) return { ok: false, reason: `no git remote named '${name}' in ${cwd}` };
  return { ok: true, url, declared: false };
}

// The startup half of §2.4 E9 and E14: a `branch` publish needs a resolvable
// remote, and a store needs to be reachable and writable. Both are deferred
// from parse time because a parse can read neither a checkout nor a filesystem,
// and both are checked HERE — beside the `gh`-capability check
// `integrationSatisfiability` performs for `mode: propose` — rather than at the
// first publish, where the answer costs an implementer's whole run.
//
// `repoPaths` is the {slug: checkout} the worker can see (the `dispatch.repos`
// map, narrowed to the factory's declared repos). A remote NAME is checked in
// every checkout we can find, because a mixed fleet may hold only some of them;
// finding NONE is not a refusal — we could not prove a failure — but it is
// reported, since an operator reading the log is the only one who can tell a
// missing clone from a missing remote.
function publishSatisfiability(factory, { graphHome, mode = "local", repoPaths = {}, git = defaultGit } = {}) {
  const errors = [];
  const warnings = [];
  if (!factory || !factory.implementation) return { ok: true, errors, warnings, store: null };
  const kinds = publishKinds(factory.implementation.candidate && factory.implementation.candidate.publish);
  let store = null;
  if (kinds.includes("bundle")) {
    const resolved = resolveBundleStore(factory, { graphHome, mode });
    store = resolved.store;
    errors.push(...resolved.errors);
  }
  if (kinds.includes("branch")) {
    const remote = String((factory.implementation.candidate && factory.implementation.candidate.remote) || "").trim() || "origin";
    const dirs = Object.entries(repoPaths || {}).filter(([, p]) => p);
    const direct = resolveRemoteUrl(remote, null, { git });
    if (direct.ok) {
      // A declared URL is the locator itself; nothing about a checkout can
      // change that verdict — except whether it is a scheme a reader can fetch.
      const refusal = portableRemoteRefusal(direct.url);
      if (refusal) errors.push(`implementation.candidate.remote ${refusal}`);
    } else if (!dirs.length) {
      warnings.push(
        `implementation.candidate.publish is '${factory.implementation.candidate.publish}' and names remote '${remote}', but no checkout of ${(factory.repos || []).join(", ") || "this factory's repos"} is known on this machine (dispatch.repos) — the remote cannot be checked until the first publish.`
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
        if (refusal) errors.push(`the git remote '${remote}' in ${slug} resolves to ${refusal}`);
      }
      if (missing.length === dirs.length) {
        errors.push(
          `implementation.candidate.publish is '${factory.implementation.candidate.publish}' but no git remote named '${remote}' exists in ${missing.join(", ")} — declare implementation.candidate.remote, or add the remote to the checkout.`
        );
      } else if (missing.length) {
        warnings.push(`no git remote named '${remote}' in ${missing.join(", ")} — candidates from ${missing.length === 1 ? "that repo" : "those repos"} cannot publish a branch reference.`);
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings, store };
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
function putFileStore(store, key, bytes, digest) {
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
    fs.copyFileSync(tmp, target, fs.constants.COPYFILE_EXCL);
    return { ok: true, outcome: "published" };
  } catch (e) {
    if (!e || e.code !== "EEXIST") {
      return { ok: false, classification: "infrastructure", reason: `the bundle could not be written to '${store}': ${(e && e.message) || e}` };
    }
    let existing = null;
    try {
      existing = fs.readFileSync(target);
    } catch (readErr) {
      return { ok: false, classification: "infrastructure", reason: `'${storeLocator(store, key)}' already exists but could not be read to compare (${(readErr && readErr.message) || readErr})` };
    }
    if (sha256Bytes(existing) === digest) return { ok: true, outcome: "replayed" };
    return {
      ok: false,
      classification: "publish-conflict",
      reason: `'${storeLocator(store, key)}' already holds a DIFFERENT object (${sha256Bytes(existing).slice(0, 12)} vs ours ${digest.slice(0, 12)}) — two objects under one content-addressed id is corruption, not a race`,
    };
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
// when the id already holds the same bytes (the replayed no-op) and 409 when it
// holds different ones. 409 is confirmed by a `GET` rather than trusted — the
// same read the file store makes, for the same reason.
async function putHttpStore(store, key, bytes, digest, http) {
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
  if (status === 200) return { ok: true, outcome: "replayed" };
  if (status !== 409) {
    return { ok: false, classification: "infrastructure", reason: `PUT ${locator} answered ${status || "no status"}${res && res.error ? ` (${res.error})` : ""}` };
  }
  let got;
  try {
    got = await http.get(locator);
  } catch (e) {
    return { ok: false, classification: "infrastructure", reason: `'${locator}' answered 409 but could not be read to compare (${(e && e.message) || e})` };
  }
  if (!got || !got.ok || !got.buffer) {
    return { ok: false, classification: "infrastructure", reason: `'${locator}' answered 409 but could not be read to compare (GET ${got && got.status ? got.status : "failed"})` };
  }
  if (sha256Bytes(got.buffer) === digest) return { ok: true, outcome: "replayed" };
  return {
    ok: false,
    classification: "publish-conflict",
    reason: `'${locator}' already holds a DIFFERENT object (${sha256Bytes(got.buffer).slice(0, 12)} vs ours ${digest.slice(0, 12)}) — two objects under one content-addressed id is corruption, not a race`,
  };
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
      const specs = [];
      if (base && base.ref) specs.push(`+${base.ref}:refs/spor/verify-base`);
      specs.push("+refs/heads/*:refs/spor/verify-base/*");
      let got = false;
      for (const spec of specs) {
        if (git(scratch, ["fetch", "--no-tags", "-q", source, spec]).status === 0) {
          got = true;
          break;
        }
      }
      if (!got) {
        return { ok: false, classification: "infrastructure", reason: `the bundle's prerequisite ${String(base && base.merge_base).slice(0, 12)} could not be obtained from ${source}, so the publish could not be verified` };
      }
      const verified = git(scratch, ["bundle", "verify", locator]);
      if (verified.status !== 0) {
        // The bundle exists and is unreadable AS a bundle: truncated bytes, a
        // wrong object under our id. That is evidence that does not describe
        // the candidate, not an outage.
        return { ok: false, classification: "candidate-mismatch", reason: `the published bundle at '${locator}' does not verify: ${gitReason(verified.stderr) || "git bundle verify failed"}` };
      }
    }
    const spec = `+${candidateRef(cand.candidate_id)}:refs/spor/verify-tip`;
    // A `branch` locator is a whole repository, and everything this check needs
    // is the tip commit and its tree — so ask for depth 1 first and fall back
    // only if the transport refuses it. A bundle is already exactly the range
    // it was cut from, and shallow-fetching one buys nothing.
    let fetched = { status: 1 };
    if (kind === "branch") fetched = git(scratch, ["fetch", "--no-tags", "-q", "--depth=1", locator, spec]);
    if (fetched.status !== 0) fetched = git(scratch, ["fetch", "--no-tags", "-q", locator, spec]);
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
    const digest = sha256Bytes(bytes);
    const put = store.toLowerCase().startsWith("file://")
      ? putFileStore(store, key, bytes, digest)
      : await putHttpStore(store, key, bytes, digest, http);
    if (!put.ok) return put;

    // Verify from the LOCATOR, never from the staged copy: the claim is that
    // what a reader fetches is the candidate, and only the store's copy can
    // settle it. An `https://` store is fetched down first — git speaks no
    // Spor-authenticated HTTPS.
    let fetchFrom = locator;
    if (!store.toLowerCase().startsWith("file://")) {
      let got;
      try {
        got = await http.get(locator);
      } catch (e) {
        return { ok: false, classification: "infrastructure", reason: `the published bundle could not be fetched back from '${locator}': ${(e && e.message) || e}` };
      }
      if (!got || !got.ok || !got.buffer) {
        return { ok: false, classification: "infrastructure", reason: `the published bundle could not be fetched back from '${locator}' (GET ${got && got.status ? got.status : "failed"})` };
      }
      if (sha256Bytes(got.buffer) !== digest) {
        return { ok: false, classification: "candidate-mismatch", reason: `'${locator}' returned bytes whose sha256 is not the one we published` };
      }
      fetchFrom = path.join(workdir, `fetched-${key}`);
      try {
        fs.writeFileSync(fetchFrom, got.buffer);
      } catch (e) {
        return { ok: false, classification: "infrastructure", reason: `the fetched bundle could not be staged for verification: ${(e && e.message) || e}` };
      }
    } else {
      try {
        fetchFrom = fileURLToPath(locator);
      } catch (e) {
        return { ok: false, classification: "infrastructure", reason: `'${locator}' is not a usable file:// locator (${(e && e.message) || e})` };
      }
    }
    const verified = verifyPublished(cand, { kind: "bundle", locator: fetchFrom, source: cwd, base: cand.base, git });
    if (!verified.ok) return verified;
    return {
      ok: true,
      outcome: put.outcome,
      reference: { kind: "bundle", store, key, locator, commit: cand.commit, sha256: digest, bytes: bytes.length },
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
  const pushed = git(cwd, ["push", url, `${cand.commit}:${ref}`, `--force-with-lease=${ref}:`]);
  if (pushed.status !== 0) {
    const ls = git(cwd, ["ls-remote", url, ref]);
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
    const verifiedReplay = verifyPublished(cand, { kind: "branch", locator: url, source: cwd, base: cand.base, git });
    if (!verifiedReplay.ok) return verifiedReplay;
    return { ok: true, outcome: "replayed", reference: { kind: "branch", locator: url, ref, commit: cand.commit } };
  }
  const verified = verifyPublished(cand, { kind: "branch", locator: url, source: cwd, base: cand.base, git });
  if (!verified.ok) return verified;
  return { ok: true, outcome: "published", reference: { kind: "branch", locator: url, ref, commit: cand.commit } };
}

// Publish a candidate and return it with its reference stamped, or the reason
// the publish is still owed.
//
// Success returns `{ok: true, candidate}` where the candidate carries
// `reference` (verified), `references[]` under `both`, and the
// `publish_attempts[]` trail. Failure returns `{ok: false, classification,
// reason, candidate}` — the candidate still carries the attempt trail, because
// the failed attempt is what the retry pool is charged against (§5.3) and what
// an escalation names. `classification` is one of:
//
//   - `infrastructure` — an outage, an unreachable store, a refused shape:
//     re-attemptable FROM THE WORKSPACE under the retry pool, never by
//     re-dispatching the implementer (§3.4);
//   - `candidate-mismatch` — the published evidence does not describe the
//     candidate: escalated, consuming no pool;
//   - `publish-conflict` — the id already holds a different object: refused and
//     escalated exactly like a mismatch.
//
// A candidate that is ALREADY verified publishes nothing and is returned
// unchanged: `publish` runs at submission and at every re-pin, and a re-pin
// that only grew `commits_seen` is the same published object (§3.4).
async function publishCandidate(cand, { cwd, publish = "bundle", bundleStore = null, remote = "", git = defaultGit, http = null, now = () => new Date().toISOString() } = {}) {
  if (!cand || typeof cand !== "object") return { ok: false, classification: "infrastructure", reason: "there is no candidate to publish", candidate: cand || null };
  if (candidateKernel.candidateSubmitted(cand)) return { ok: true, candidate: cand, published: false };
  if (!cwd) return { ok: false, classification: "infrastructure", reason: "the producing workspace is gone, so the candidate cannot be published from it", candidate: cand };

  const kinds = publishKinds(publish);
  if (kinds.includes("bundle") && !bundleStore) {
    return { ok: false, classification: "infrastructure", reason: "no bundle store is configured, so the candidate has nowhere to publish to", candidate: cand };
  }
  const attempts = Array.isArray(cand.publish_attempts) ? cand.publish_attempts.slice() : [];
  const refs = [];
  for (const kind of kinds) {
    const at = now();
    const index = attempts.length + 1;
    let r;
    try {
      r = kind === "bundle" ? await publishBundle(cand, { cwd, store: bundleStore, git, http }) : publishBranch(cand, { cwd, remote, git });
    } catch (e) {
      r = { ok: false, classification: "infrastructure", reason: `the ${kind} publish threw: ${(e && e.message) || e}` };
    }
    if (r.ok) {
      // The producer checks its OWN reference against the same refusal table
      // every reader applies (§3.4): a locator inside the working tree, a bare
      // sha, a relative path is never stamped — the submission is a failed
      // publish with the reason named, and the producer can publish correctly
      // from the workspace on the retry.
      const refusal = candidateKernel.referenceRefusal(r.reference, { bundleStore: kind === "bundle" ? bundleStore : null, cwd });
      if (refusal) r = { ok: false, classification: "infrastructure", reason: refusal };
    }
    if (!r.ok) {
      attempts.push(attemptEntry({ index, kind, outcome: r.classification === "infrastructure" ? "failed" : r.classification, at, reason: r.reason, pool: r.classification === "infrastructure" ? "retry" : null }));
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
  candidateRef,
  bundleKey,
  publishKinds,
  storeLocator,
  defaultBundleStore,
  resolveBundleStore,
  resolveRemoteUrl,
  portableRemoteRefusal,
  publishSatisfiability,
  publishCandidate,
  httpStoreClient,
};

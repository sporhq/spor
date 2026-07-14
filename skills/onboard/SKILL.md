---
name: onboard
description: First-time Spor setup — the front door for a new user or a fresh install. Use whenever someone is getting started with Spor, says "set up / onboard spor", "I just installed spor", "connect me to a team graph", "join my team's graph", "spor isn't doing anything / nothing happens", "create my spor identity", or is otherwise standing in a repo with Spor wired but not yet set up. Detects the state with `spor status`, forks personal-local vs team-server setup, establishes identity (person + agent), enables the repo, gets consent for the sources backfill will read, then hands off to /spor:backfill. Distinct from /spor:backfill (which populates a repo's graph and groups repos) — onboard is the one-time identity+config door you run BEFORE backfill. Re-runnable to repair a half-set-up box.
---

# Onboard to Spor

Spor does nothing until a person is onboarded. The plugin is **opt-in per repo**,
so its hooks no-op in any repo with no marker; the local queue has no `$viewer`
identity to bind your work to; and dispatched agents have no identity to act
under. A fresh `npm install` plus `spor install claude` wires the plugin but
sets none of that up. **This skill is the one-time setup door.** It figures out
where you are, establishes identity and config for your mode, gets consent for
the sources the next step will read, and hands off to `/spor:backfill` to
populate the graph.

It is the **front door**. `/spor:backfill` (populate a repo's graph, group repos
into projects) and `spor dispatch --backfill` (the CLI primitive that
inits + enables + launches a backfill agent) are the steps *after* an identity
exists — onboard is what gets you there. Everything here is **idempotent**: each
step detects what's already done and reports it, so re-running to repair a
half-set-up box is safe. Don't echo `SPOR_SERVER`/`SPOR_TOKEN`/`SPOR_HOME` or
announce the raw mode — `spor status` is the user-facing report.

## 0. Detect where you are — always start here

Run `spor status` and read it. It is the single source of truth for the fork
below and tells you what's already done:

- **`mode: local` vs `mode: remote`** — picks the branch below. Local = your own
  graph in files; remote = a team server. You don't test env vars or branch in
  prose elsewhere; the CLI self-resolves every verb (see /spor:spor).
- **`(not enabled here …)`** on the mode line — this repo has no `.spor`/`.spor.json`
  marker, so the plugin is a no-op here until you run `spor enable` (a step below).
- **`node: … TOO OLD`** — **stop.** Every hook silently no-ops on a Node below
  the floor. Tell the user to upgrade Node (nvm or their package manager) to the
  version shown, then re-run onboard. This is the #1 cause of "I installed it and
  nothing happens" (issue-spor-onboarding-no-node-silent-fail-open).
- **`plugin: spor@spor X loaded (STALE …)`** — the copy Claude Code loaded lags
  the installed package, so new skills/hooks (including this one) may be missing.
  Tell the user to run `spor upgrade` and restart Claude Code. Non-fatal; flag it.
- **`identity:` / `graph:`** — whether an identity already exists (lets you skip
  the steps that are done).

Then fork on `mode:`.

## Remote mode — joining a team server

Goal: a valid org-scoped credential **bound to your person node**, so your writes
attribute to you and your queue and question-routing work.

1. **Sign in** (skip if `spor status` already shows a bound `identity:`).
   `spor auth login --server <url>` runs the device-code grant — it prints a code
   and URL you approve in any browser, so it works over SSH with no local browser.
   If the user already has a minted token to paste, `spor join <url> <token>`
   instead (omit the URL to onboard to the hosted service). The URL is the team's
   front door.
2. **Pick the org.** Server tokens are org-scoped, so a person in N orgs holds N
   credentials. If sign-in surfaced several, `spor auth switch <org>` selects the
   active one and `spor auth list` shows them with health.
3. **Verify the token binds to a person — do not skip this.** Run `spor whoami`.
   If it reports **`⚠ token maps to no person node`**, surface it loudly and stop:
   routed questions and the personal queue will be empty and writes won't be
   attributed. This is a server-side binding, so the fix is for a team admin to
   mint a person-bound token (`spor invite --person <id>` / `--name --email`) and
   hand it over; the user then re-runs step 1 with it. Don't paper over it — silent
   identity degradation is exactly the failure this check exists to catch
   (issue-cc-onboarding-email-mismatch-silent-degradation).
4. **Ask how assistants should talk to them — the `register` field.** First
   check `spor get <person-id>` — if the node already carries a `register:`,
   this step is done (mention it exists and move on; don't re-interview a
   returning user). Otherwise interview briefly, then **draft the field
   yourself — never transcribe the user's first answer**. People
   under-specify this in the moment ("just keep it simple" encodes nothing a
   model can act on), so extract the substance: what's their role, how
   technical are they, and what does a useful explanation look like to them —
   asking for an example of an explanation they liked or hated works well.
   From that, compose 2–4 directive sentences a model can follow mechanically
   (vocabulary level, node titles vs raw ids, analogies vs precision, detail
   depth — e.g. `register: Non-technical founder. Plain everyday language, no
   graph jargon; use node titles, never raw ids. Analogies over precision.`),
   read the draft back for approval, and write the approved version to their
   person node (GRAPH.md "person"): `spor get <person-id> --json` for the
   revision, add the field, then
   `spor put-node - --if-exists update --revision <sha>`. The server renders it
   to every graph-reading assistant (MCP instructions + an Audience note on
   reads), so a non-technical user gets answers they can actually use — for
   them this is the highest-value step here
   (task-spor-viewer-register-adaptation). Presentation only, editable any time
   by updating their person node; a technical user happy with the default
   needs no field — skip without ceremony.
5. **Enable this repo.** `spor enable` writes `.spor.json {enabled: true}` so the
   plugin actually runs here — without a marker every hook no-ops (the opt-in
   default), even in remote mode. Commit the file to share the setting. If the
   inferred project slug is wrong, `spor link <slug>` writes a `.spor` marker.
6. **(Optional) a dispatch identity**, if the user will run background agents.
   Two explicit steps: `spor agent create <label>` writes the agent node owned by
   your person, then `spor agent use <agent-id>` makes it **this machine's**
   default — that's what turns on session-start capability auto-publish and the
   liveness heartbeat. Creating does not activate; both are needed. Use the full
   `agent-<slug>` id from `spor agent list`, not the bare label.
7. **State the data reality correctly.** In remote mode your captures and
   distilled nodes land in the **shared team graph on the server** — visible to
   teammates and attributed to you. It is *not* local-only.
8. **Hand off to populate the repo:** `/spor:backfill` (mine history, group
   repos). Tracker/MCP consent happens there — see step 6 of the local branch,
   which applies equally.

## Local mode — your personal graph

Goal: a committable local graph at `$SPOR_HOME` (default `~/.spor`) with a person
node **your git identity binds to**, this machine's agent, and the repo enabled.

1. **Create the graph home** (idempotent): `spor init`. It makes `~/.spor/nodes`,
   `git init`s it, writes a `.gitignore`, and ensures a **committable git
   identity + initial commit** so the distiller/gardener auto-commits never
   silently fail (dec-spor-init-committable-graph-identity). Read its `commits:`
   line: if it shows **`spor@localhost`**, git has no real identity on this box —
   have the user set `git config --global user.email you@example.com` (and
   `user.name`) **before** the next step, because that email is the `$viewer` key
   the local queue binds you to. The `spor@localhost` fallback exists only so the
   graph can commit; it deliberately **cannot** bind a person node
   (dec-spor-fallback-identity-not-person).
2. **Create your person node** (idempotent): `spor person create`. It writes the
   `type: person` `$viewer` anchor, seeding name/email from the git identity. A
   re-run that finds your identity already bound reports it and exits 0. If it
   refuses with *"no real git identity (found the spor@localhost commit
   fallback)"*, fix `git config user.email` and re-run, or pass
   `--email you@example.com`. Then run `spor person list` and confirm your git
   identity is the marked (`$viewer`) one — if it isn't, the node's email differs
   from your `git config user.email` and the queue won't bind to you.
3. **Create and activate this machine's agent** (two explicit steps):
   - `spor agent create <label>` — writes the `type: agent` node owned by your
     person (an `owned-by` edge); reused across dispatches as this machine's
     durable identity. (With exactly one person node it picks the owner
     automatically; with several, pass `--owner person-x`.)
   - `spor agent use <agent-id>` — sets `dispatch.agent` so this machine
     dispatches as that agent. **Creation alone does not activate it.** Attribution
     is remote-only, so in pure local mode this is forward-looking — do it now if
     the user plans to dispatch or later join a team; skip it for a read-only solo
     graph.
4. **Enable this repo:** `spor enable` → `.spor.json {enabled: true}`. Without a
   `.spor`/`.spor.json` marker the plugin no-ops here (opt-in default), so this is
   what turns the hooks on. `spor link <slug>` if the inferred slug is wrong.
5. **State the data reality correctly.** In local mode everything persists to
   files under `~/.spor/nodes`, version-controlled by the git repo `spor init`
   created. It is your **personal** graph — not shared with anyone and not
   transmitted off the box. (Only switching to remote mode — `SPOR_SERVER` set —
   shares to a team.)
6. **Get consent for the sources backfill will read.** `/spor:backfill` always
   mines local git history, and — only with consent — issue trackers: GitHub via
   an authenticated `gh`, Jira/Linear via their MCP tools if present in this
   session. Before handing off, note which of those are actually reachable and
   confirm with the user which ones backfill may read. A local tracker read is
   the one place data leaves the box, so make it an opt-in, not a default.
7. **Hand off:** `/spor:backfill` to populate this repo's graph and group repos
   into projects. It writes nothing without confirmation.

## When to use which door (`spor dispatch --backfill` vs this skill)

`spor dispatch --backfill` stays as the **unattended CLI primitive**: it inits
the graph home, re-enables a disabled repo, registers the repo in the dispatch
slug→path map, and launches a `claude --bg` backfill agent. It does **not** set up
identity (person/agent), pick a tenant, verify a person binding, or get tracker
consent. So:

- **First-time setup, or anything's unclear → `/spor:onboard`** (this skill). It
  covers exactly the identity, mode, consent, and health steps `--backfill` skips,
  then hands to `/spor:backfill`.
- **Identity already exists and you just want to bootstrap a freshly-cloned repo
  unattended → `spor dispatch --backfill`** from inside it.

The two are complementary, not redundant.

## Idempotency and repair

Re-run this skill any time to repair a half-set-up box: `spor status` shows the
current state, every `spor init` / `person create` / `agent create` / `enable`
reports "already done" and moves on, and an unbound remote token or a
non-binding local person node is surfaced (steps remote-3 / local-2) rather than
silently tolerated. If a single step looks wrong, fix that one and re-run — you
won't clobber the rest.

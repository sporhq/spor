#!/bin/bash
# link-live-skill.sh [--apply] [--force] — point the live skill directory at
# this repo copy, so the two cannot fork again.
#
# Local-operator tooling: lives under .claude/, outside the published npm
# package, so it is exempt from the repo's zero-dep plain-Node rule
# (CLAUDE.md "Hard rules" — Zero dependencies) and may use bash+jq.
#
# Claude Code loads this skill from ~/.claude/skills/spor-orchestrator; the
# directory in the repo is the versioned source of truth. When the live path is
# a real directory, hand-edits to it never reach the repo and repo commits never
# reach a running fleet — by 2026-07-27 every one of the ten files had diverged
# in both directions (task-spor-orchestrator-skill-copies-reconcile). Making the
# live path a SYMLINK to the repo copy removes the second copy entirely.
#
# Safe by default — this replaces the directory the orchestrator itself runs
# from, so it refuses rather than guesses:
#   - dry run unless --apply;
#   - refuses if the live directory's CONTENT differs from the repo copy — that
#     difference may be un-upstreamed work, and linking would delete it.
#     Reconcile it into the repo copy first, then re-run;
#   - refuses while a fleet is up — scripts/watch-fleet.sh and
#     scripts/fleet-status.sh are load-bearing mid-run;
#   - keeps a timestamped backup of any real directory it replaces.
# The refusals override SEPARATELY (--force-diverged / --force-fleet), because
# they protect different things: forcing past a spurious fleet block must not
# also switch off the guard standing between hand-edits and deletion. --force
# is the both-at-once shorthand. The backup is taken regardless.
#
# The backup lands in ~/.claude/, NOT under ~/.claude/skills/: a copy left
# inside skills/ is still a skill directory, and a second SKILL.md declaring the
# same name collides with the one we just linked.
# HEADER_END (--help prints down to here)
set -u

SRC=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
DEST="${SPOR_ORCHESTRATOR_LIVE:-$HOME/.claude/skills/spor-orchestrator}"
APPLY=0; FORCE_DIVERGED=0; FORCE_FLEET=0
usage='usage: link-live-skill.sh [--apply] [--force|--force-diverged|--force-fleet]'
for a in "$@"; do
  case "$a" in
    --apply) APPLY=1 ;;
    --force) FORCE_DIVERGED=1; FORCE_FLEET=1 ;;
    --force-diverged) FORCE_DIVERGED=1 ;;
    --force-fleet) FORCE_FLEET=1 ;;
    -h|--help) sed -n '2,/^# HEADER_END/p' "${BASH_SOURCE[0]}" | sed '$d'; exit 0 ;;
    *) echo "$usage" >&2; exit 1 ;;
  esac
done

echo "source (repo): $SRC"
echo "live   (dest): $DEST"

# Running the LIVE copy in the pre-link state makes SRC and DEST the same
# directory — and the divergence guard below cannot fire, because a directory is
# always identical to itself. The swap would then move that directory into the
# backup and leave the live path a self-referential dangling symlink, taking any
# un-upstreamed edits with it. Refuse before anything is touched.
#
# `! -L` matters: once the link exists, DEST resolves to SRC by design, and that
# is the IN-SYNC case handled below — only a REAL directory that is also SRC is
# the hazard.
if [ -d "$DEST" ] && [ ! -L "$DEST" ] && [ "$(cd -- "$DEST" 2>/dev/null && pwd -P)" = "$SRC" ]; then
  echo "REFUSING — you are running the live copy itself (source and dest are the" >&2
  echo "same directory). Run this script from the repo checkout instead." >&2
  exit 2
fi

# The link outlives any single piece of work, so it must point at the shared
# checkout. A worktree is deleted at merge time (references/merge.md step 7),
# which would leave the orchestrator's own skill a dangling symlink.
case "$SRC" in
  */.claude/worktrees/*)
    echo "REFUSING — this copy lives in a worktree, which is removed after its merge." >&2
    echo "Run this script from the shared checkout instead." >&2
    exit 2 ;;
esac

# Already correct? Nothing to do, whatever the flags say.
if [ -L "$DEST" ] && [ "$(readlink -f -- "$DEST")" = "$SRC" ]; then
  echo "IN-SYNC — live path is already a symlink to the repo copy."
  exit 0
fi

blocked_diverged=0; blocked_fleet=0

# Guard 1: content divergence. Only meaningful for a real directory; a symlink
# pointing somewhere ELSE is reported but not diffed (it is not a second copy,
# just a wrong target).
if [ -L "$DEST" ]; then
  echo "NOTE: live path is a symlink to $(readlink -f -- "$DEST") — will be repointed."
elif [ -d "$DEST" ]; then
  drift=$(diff -rq -- "$SRC" "$DEST" 2>&1)
  if [ -n "$drift" ]; then
    echo "DIVERGED — live directory differs from the repo copy:"
    printf '%s\n' "$drift" | sed 's/^/  /'
    echo "Reconcile these into the repo copy first (linking would delete the live side)."
    blocked_diverged=1
  else
    echo "clean — live directory is byte-identical to the repo copy."
  fi
elif [ -e "$DEST" ]; then
  echo "REFUSING — live path exists and is neither a directory nor a symlink." >&2
  exit 2
else
  echo "absent — live path does not exist yet; nothing to back up."
fi

# Guard 2: an active fleet. Background agents only — an idle interactive session
# is not a fleet. Watch `status`, never `state`: `state` sticks at "working"
# after an agent finishes (inc-spor-orchestration-watcher-stuck-state), so a
# finished agent's corpse would otherwise read as live.
#
# Exclude THIS session by sessionId: a dispatched agent running this script is
# itself a busy background agent, and self-blocking would push the operator
# toward a force flag for no reason.
agents_json=$(claude agents --json 2>/dev/null)
# `$me == ""` disables the exclusion entirely: with no session id to match, the
# `// ""` fallback would otherwise equate every entry MISSING a sessionId with
# "self" and drop a real fleet on the floor.
active=$(printf '%s' "$agents_json" | jq -r --arg me "${CLAUDE_CODE_SESSION_ID:-}" '
  (.agents? // .) | .[]? | select(.kind == "background")
  | select($me == "" or (.sessionId // "") != $me)
  | select((.status // "") | test("^(working|busy|starting)$")) | .name // .id' 2>/dev/null)
jq_rc=$?
if [ -n "$active" ]; then
  echo "FLEET UP — background agents still running:"
  printf '%s\n' "$active" | sed 's/^/  /'
  echo "The watcher scripts are load-bearing mid-run; do this after the run drains."
  blocked_fleet=1
elif [ -z "$agents_json" ] || [ "$jq_rc" != 0 ]; then
  # Fail open, but say so: this guard is about avoiding disruption, not data
  # loss (guard 1 covers that and fails closed). Still, "no fleet" and "could
  # not tell" must not look the same in the output — so key on jq actually
  # having parsed something, not merely on `claude` having printed something
  # (an auth error on stdout, or a missing jq, is not an empty fleet).
  echo "NOTE: could not determine fleet state — \`claude agents --json\` gave nothing parseable."
fi

if [ "$blocked_diverged" = 1 ] && [ "$FORCE_DIVERGED" != 1 ]; then
  echo "BLOCKED on divergence — re-run with --force-diverged only if you are sure."
  exit 1
fi
if [ "$blocked_fleet" = 1 ] && [ "$FORCE_FLEET" != 1 ]; then
  echo "BLOCKED on active fleet — re-run with --force-fleet only if you are sure."
  exit 1
fi
[ "$blocked_diverged" = 1 ] && echo "forced past divergence; any live-only content survives only in the backup."
[ "$blocked_fleet" = 1 ] && echo "forced past the active fleet."

if [ "$APPLY" != 1 ]; then
  echo "DRY RUN — would link $DEST -> $SRC. Re-run with --apply."
  exit 0
fi

# Swap. Stage the new symlink beside the destination and rename it into place so
# the live path is never missing for more than one rename.
mkdir -p -- "$(dirname -- "$DEST")"
staged="$DEST.linking.$$"
rm -f -- "$staged"
ln -s -- "$SRC" "$staged" || { echo "FAILED to stage symlink" >&2; exit 2; }

if [ -d "$DEST" ] && [ ! -L "$DEST" ]; then
  # Never reuse an existing backup path: `mv dir existing-dir` NESTS instead of
  # failing, so a second run inside the same second would bury the diverged copy
  # one level down instead of preserving it beside the first.
  stamp="$HOME/.claude/spor-orchestrator.bak-$(date +%Y%m%dT%H%M%S)"
  backup="$stamp"; n=1
  while [ -e "$backup" ]; do backup="$stamp.$n"; n=$((n + 1)); done
  mv -- "$DEST" "$backup" || { rm -f -- "$staged"; echo "FAILED to back up $DEST" >&2; exit 2; }
  echo "backed up previous live directory -> $backup"
fi
mv -Tf -- "$staged" "$DEST" || { rm -f -- "$staged"; echo "FAILED to move symlink into place" >&2; exit 2; }

if [ "$(readlink -f -- "$DEST")" = "$SRC" ]; then
  echo "LINKED — $DEST -> $SRC"
  exit 0
fi
echo "FAILED — $DEST does not resolve to $SRC after the swap" >&2
exit 2

#!/usr/bin/env bash
# land.sh — the orchestrator's one landing primitive
# (task-spor-orchestrator-land-from-detached-worktree-retire-healer).
#
# Local-operator tooling: lives under .claude/, outside the published npm
# package, so it is exempt from the repo's zero-dep plain-Node rule
# (dec-spor-orchestrator-scripts-scoped-zero-dep-exemption). bash + git only.
#
# WHY THIS EXISTS. The orchestrator used to CAS `refs/heads/main` forward while
# the shared root checkout had `main` checked out. `update-ref` moves the ref
# and nothing else, so the root's index and working tree kept the OLD commit's
# content and `git status` showed every merged file as modified — a shape no
# status letter tells apart from a parallel job's live WIP. A hand-commit from
# that root reverted merged work three times, and the 1,134-line
# scripts/heal-stale-root.js existed only to re-derive, over strings, which of
# those paths were safe to check out — thirteen safety-review defects
# (TOCTOU, non-UTF-8 path mangling, index-env inheritance, …) were the price of
# re-implementing git's index/worktree semantics by hand.
#
# THE STRUCTURAL FIX. Nobody lands INTO a checkout any more:
#   1. No worktree keeps the target branch checked out. Any that does is
#      parked DETACHED at its own current commit (`git checkout --detach`, no
#      commit argument: HEAD stops following the branch, the index and the
#      working tree are not touched, nothing is discarded). From then on
#      moving the ref cannot make anyone's checkout lie — a detached HEAD's
#      `git status` is still exactly its own WIP, and a commit made there is
#      off the old base, which a later land's ancestry guard refuses instead
#      of silently reverting.
#   2. The ancestry guard: NEW must descend from OLD (`merge-base
#      --is-ancestor`). `update-ref <ref> <new> <old>` only asserts the ref is
#      still at OLD, never that NEW builds on it — a skipped rebase once
#      rewound spor main by six commits
#      (issue-spor-orchestrator-merge-cas-lacks-ancestry-check).
#   3. The CAS: `git update-ref <ref> NEW OLD` — fails if the ref moved.
#   4. Each parked checkout — and the main worktree, when an earlier land left
#      it detached on the target's line — is ADVANCED to NEW with `git
#      checkout --detach NEW` — git's own two-way checkout, which carries local changes to paths
#      OLD..NEW does not touch and refuses the WHOLE checkout (writing nothing)
#      when a change would be overwritten. It must advance: `spor dispatch
#      --worktree` cuts each new agent branch from the shared root's HEAD, and
#      a root frozen at the first land's OLD would base every later dispatch on
#      stale code. A checkout git refuses to advance stays detached where it
#      was (consistent, only behind) and is reported `behind=`; the next land
#      tries it again.
#   5. Verification happens in a FRESH detached worktree at NEW, never in the
#      shared root: `--verify "<cmd>"` runs there after the swap. The worktree
#      is bare — no node_modules — so a repo with dependencies must stage them
#      in the command itself (the same thing its dispatch.worktreeSetup does).
#
# THE TIP RESOLVES IN THE CALLER'S CWD. `--repo` is the shared root, which is
# parked at (or near) the target, so a per-worktree name like HEAD resolved THERE
# names the root's commit, not the branch the caller meant, and the land came out
# NOOP while reporting success (issue-spor-land-sh-symbolic-tip-resolves-in-repo-
# and-noops). When the caller's cwd is a worktree of the same repository the tip
# is resolved to a sha there first; from anywhere else a per-worktree name
# (HEAD, ORIG_HEAD, …) is refused as `symbolic-tip` — pass a sha or a branch.
# Git's replace refs are ignored throughout (GIT_NO_REPLACE_OBJECTS=1 on the
# ref and ancestry probes), so a `refs/replace` graft cannot make ancestry read differently than
# the objects a checkout will write.
#
# Usage:
#   land.sh --repo <dir> --tip <commit-ish> [--target main] [--verify "<cmd>"] [--keep]
#
# Output: one verdict line on stdout, `VERDICT key=value …`:
#   LANDED   old=<sha> new=<sha> [parked=<path>,…] [behind=<path>,…] [verify=passed] [worktree=<dir>]
#   NOOP     the target is already at the tip
#   REFUSED  reason=not-descendant|moved|unresolvable|park-failed|… [parked=…] —
#            the ref did not move (a checkout parked before a `moved` refusal
#            stays parked, detached at its own commit, and is listed)
#   VERIFY-FAILED  old=<sha> new=<sha> worktree=<dir> — the swap LANDED but the
#            verification command failed; the worktree is kept for inspection.
#            Revert per merge.md step 6 (only CAS back if the ref is still NEW).
# Exit: 0 LANDED/NOOP, 1 REFUSED, 3 VERIFY-FAILED, 2 usage.

set -uo pipefail

usage() { printf 'usage: land.sh --repo <dir> --tip <commit-ish> [--target <branch>] [--verify "<cmd>"] [--keep]\n' >&2; exit 2; }

repo="" tip="" target="main" verify="" keep=0
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo="${2:-}"; shift 2 || usage ;;
    --tip) tip="${2:-}"; shift 2 || usage ;;
    --target) target="${2:-}"; shift 2 || usage ;;
    --verify) verify="${2:-}"; shift 2 || usage ;;
    --keep) keep=1; shift ;;
    -h|--help) usage ;;
    *) printf 'land.sh: unknown argument: %s\n' "$1" >&2; usage ;;
  esac
done
[ -n "$repo" ] && [ -n "$tip" ] && [ -n "$target" ] || usage

# git's repo-local variables would retarget every call below at whatever repo
# the caller's environment names (the class lib/shell/git-exec.js
# GIT_LOCAL_ENV_VARS pins); this script only ever means --repo.
unset GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS \
  GIT_COMMON_DIR GIT_DIR GIT_GRAFT_FILE GIT_IMPLICIT_WORK_TREE GIT_INDEX_FILE \
  GIT_NO_REPLACE_OBJECTS GIT_OBJECT_DIRECTORY GIT_PREFIX GIT_REPLACE_REF_BASE \
  GIT_SHALLOW_FILE GIT_WORK_TREE

refuse() { printf 'REFUSED reason=%s\n' "$1"; [ -n "${2:-}" ] && printf 'land.sh: %s\n' "$2" >&2; exit 1; }
g() { GIT_NO_REPLACE_OBJECTS=1 git -C "$repo" "$@"; }

# The tip, resolved where the caller stands (see THE TIP RESOLVES ABOVE).
callerdir=$PWD
commondir() { (cd "$1" 2>/dev/null && cd "$(GIT_NO_REPLACE_OBJECTS=1 git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P) || true; }
tipdir="$repo"
if [ -n "$(commondir "$callerdir")" ] && [ "$(commondir "$callerdir")" = "$(commondir "$repo")" ]; then
  tipdir="$callerdir"
else
  case "$tip" in
    HEAD*|@*|ORIG_HEAD*|FETCH_HEAD*|MERGE_HEAD*|CHERRY_PICK_HEAD*|REVERT_HEAD*|REBASE_HEAD*)
      refuse symbolic-tip "tip '$tip' names a per-worktree ref and the caller's cwd is not a worktree of $repo — pass a sha or branch" ;;
  esac
fi

ref="refs/heads/$target"
old=$(g rev-parse --verify --quiet "$ref^{commit}") || refuse unresolvable "cannot resolve $ref in $repo"
new=$(GIT_NO_REPLACE_OBJECTS=1 git -C "$tipdir" rev-parse --verify --quiet "$tip^{commit}") || refuse unresolvable "cannot resolve tip $tip in $tipdir"

if [ "$old" = "$new" ]; then
  printf 'land.sh: NOOP — tip %s (%s, resolved in %s) is already %s; nothing landed\n' "$tip" "$new" "$tipdir" "$target" >&2
  printf 'NOOP old=%s\n' "$old"
  exit 0
fi

# merge-base --is-ancestor: 0 = yes, 1 = no, anything else = git could not
# answer. Only a yes lands; the other two refuse with different reasons, so a
# failed probe never reads as a verdict.
g merge-base --is-ancestor "$old" "$new"
case $? in
  0) ;;
  1) refuse not-descendant "$new does not descend from $target ($old) — rebase onto $target first" ;;
  *) refuse ancestry-unknown "merge-base --is-ancestor could not answer for $old..$new" ;;
esac

# Park every worktree that has the target checked out. --porcelain prints
# `worktree <path>` then `branch refs/heads/<b>` for a checkout on a branch or
# `detached` for a detached one; the FIRST entry is the main worktree — the
# shared root `spor dispatch --worktree` cuts new branches from. A hook's exit
# status passes through `git checkout`, so success is judged by the resulting
# HEAD, never the exit code.
parked=()
list=$(g worktree list --porcelain) || refuse worktree-list-failed "git worktree list failed"
wt="" mainwt="" maindetached=0
while IFS= read -r line; do
  case "$line" in
    "worktree "*) wt="${line#worktree }"; [ -z "$mainwt" ] && mainwt="$wt" ;;
    detached) [ "$wt" = "$mainwt" ] && maindetached=1 ;;
    "branch $ref")
      git -C "$wt" checkout --quiet --detach >&2
      git -C "$wt" symbolic-ref -q HEAD >/dev/null && refuse park-failed "could not detach $wt from $target"
      parked+=("$wt")
      printf 'land.sh: parked %s detached at %s (it had %s checked out)\n' "$wt" "$(git -C "$wt" rev-parse --short HEAD)" "$target" >&2
      ;;
  esac
done <<<"$list"

joined() { local IFS=,; printf '%s' "$*"; }
extra=""
[ ${#parked[@]} -gt 0 ] && extra=" parked=$(joined "${parked[@]}")"

if ! g update-ref -m "land.sh: $target $old -> $new" "$ref" "$new" "$old"; then
  printf 'REFUSED reason=moved%s\n' "$extra"
  printf 'land.sh: %s moved off %s before the swap — re-rebase onto the new %s and retry\n' "$target" "$old" "$target" >&2
  exit 1
fi

# Advance: every checkout parked this run, plus the main worktree when an
# EARLIER land (or a refused one) left it detached on the target's line — its
# HEAD a strict ancestor of NEW. A detached main worktree NOT on that line
# (someone's own detached commit off an old base) is not ours to move. Other
# linked worktrees that merely sit detached on an ancestor (a merge helper's
# verify checkout) are never touched.
advance=(${parked[@]+"${parked[@]}"})
if [ "$maindetached" -eq 1 ]; then
  mainhead=$(git -C "$mainwt" rev-parse --verify --quiet HEAD) || mainhead=""
  if [ -n "$mainhead" ] && [ "$mainhead" != "$new" ] && g merge-base --is-ancestor "$mainhead" "$new"; then
    advance+=("$mainwt")
  fi
fi
behind=()
for wt in ${advance[@]+"${advance[@]}"}; do
  # HEAD decides whether the checkout advanced (a refused checkout leaves it
  # put); the exit status only qualifies it — git passes a post-checkout hook's
  # status through AFTER the checkout completed, so a non-zero exit with HEAD at
  # NEW is a landed advance with a noisy hook, reported on stderr, not behind.
  git -C "$wt" checkout --quiet --detach "$new" >&2; rc=$?
  if [ "$(git -C "$wt" rev-parse --verify --quiet HEAD)" != "$new" ]; then
    behind+=("$wt")
    printf 'land.sh: git refused to advance %s to %s (exit %s; local changes in the way); left detached at %s\n' "$wt" "$new" "$rc" "$(git -C "$wt" rev-parse --short HEAD)" >&2
  elif [ "$rc" -ne 0 ]; then
    printf 'land.sh: %s advanced to %s but git checkout exited %s (a post-checkout hook?)\n' "$wt" "$new" "$rc" >&2
  fi
done
[ ${#behind[@]} -gt 0 ] && extra="$extra behind=$(joined "${behind[@]}")"

if [ -z "$verify" ]; then
  printf 'LANDED old=%s new=%s%s\n' "$old" "$new" "$extra"
  exit 0
fi

wtdir=$(mktemp -d "${TMPDIR:-/tmp}/spor-land-XXXXXX") || { printf 'VERIFY-FAILED old=%s new=%s reason=mktemp%s\n' "$old" "$new" "$extra"; exit 3; }
rmdir "$wtdir"
if ! g worktree add --quiet --detach "$wtdir" "$new" >&2; then
  printf 'VERIFY-FAILED old=%s new=%s reason=worktree-add%s\n' "$old" "$new" "$extra"
  exit 3
fi
if (cd "$wtdir" && bash -c "$verify") >&2; then
  if [ "$keep" -eq 1 ]; then
    printf 'LANDED old=%s new=%s%s verify=passed worktree=%s\n' "$old" "$new" "$extra" "$wtdir"
  else
    # --force: this is OUR throwaway checkout, and the suite may leave residue.
    g worktree remove --force "$wtdir" >/dev/null 2>&1 || printf 'land.sh: could not remove %s\n' "$wtdir" >&2
    printf 'LANDED old=%s new=%s%s verify=passed\n' "$old" "$new" "$extra"
  fi
  exit 0
fi
printf 'VERIFY-FAILED old=%s new=%s worktree=%s%s\n' "$old" "$new" "$wtdir" "$extra"
exit 3

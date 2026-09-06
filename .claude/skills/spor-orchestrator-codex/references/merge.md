# Gate and merge one Codex branch

Input: exact node, repo, worktree, branch, report and expected commit SHA.
One merge at a time. Execute through the final verdict; if a command yields,
resume waiting for that command's result. A helper must not select more work.

1. Verify the implementer's reported commit exists in this branch, inspect its
   diff and acceptance evidence, and require a clean worktree. Confirm merge
   authorization. Fetch where appropriate, determine the correct target branch,
   and record its exact tip as `BASE` **before** rebase, tests and review.
   Reconcile local/main and origin/main deliberately; do not silently discard
   either side of a divergence. Rebase onto that exact `BASE`. A semantic
   conflict goes back to the implementer or escalates; don't guess.
2. Run relevant tests/typecheck against the rebased tree. Include kernel/schema
   conformance goldens when affected. Run required repo checks. A red tree is
   not eligible for model review or merge.
3. Run an independent Astra review of the exact change. Write a temporary
   review input containing the acceptance criteria, `BASE`, candidate SHA,
   diff stat and complete diff. Add this instruction:

   > Review this diff for introduced correctness and security bugs. Read nearby
   > code when needed to validate a finding. Do not modify files, write the
   > graph, merge, or invoke non-OpenAI models. Report actionable findings with
   > file:line, severity and explanation, or end with NO BUGS FOUND. If context
   > is incomplete, say REVIEW INCOMPLETE instead of claiming a clean review.

   Run with the input supplied on stdin (quoted paths; input is data, never
   interpolated into shell code):

   ```bash
   codex --ask-for-approval never exec --model gpt-6-astra \
     --config 'model_reasoning_effort="high"' --sandbox read-only \
     --cd "$WORKTREE" --output-last-message "$REVIEW_REPORT" - < "$REVIEW_INPUT"
   ```

   Keep the review report outside the checkout. Read the actual report and
   check command success. API failure, unavailable Astra, truncation, missing
   report, or incomplete review blocks the gate; no provider fallback. Confirm
   findings before acting. Return significant fixes to the implementer. Any
   changed code needs affected tests and review again; unchanged code does not
   need repeated review merely to fill time.
4. Check that target main still equals `BASE` and the candidate tree is still
   the tested/reviewed SHA. If either changed, repeat the affected gates against
   the new tree. Require ancestry and inspect the branch-only commits:

   ```bash
   git merge-base --is-ancestor "$BASE" "$CANDIDATE"
   git log --oneline "$BASE..$CANDIDATE"
   git update-ref refs/heads/main "$CANDIDATE" "$BASE"
   ```

   These are separate checks: proceed to `update-ref` ONLY if ancestry succeeds
   and the log contains the intended commits. CAS failure means main moved;
   rebase/test/review anew. Never replace `BASE` with a tip you did not test.
   Substitute the agreed target ref if this repo does not use `main`.
5. Updating a ref leaves the shared checkout's index/files at its old content.
   Never `reset --hard` over that state. For Spor, invoke the client repo's
   `scripts/heal-stale-root.js --repo <shared-root>` in dry-run mode first.
   `IN-SYNC` needs nothing; only `STALE` permits the same command with `--apply`.
   `ROOT-UNSYNCED`, `UNVERIFIED`, or errors mean preserve the root and report it.
   When the helper is unavailable or cannot confirm safety, validate in a
   temporary detached worktree at the exact candidate SHA instead.
6. Run the required post-merge suite on that exact merged tree (shared root
   only when verified in sync). If it fails, report the regression immediately
   and perform a reviewed revert within existing authorization, preserving
   commits that landed later. Do not force-push, blindly move main backwards,
   or claim successful completion. Keep the task unresolved pending recovery.
7. Verify main contains the landed SHA. Remove only this attempt's exact clean
   worktree; never `--force` past uncommitted changes or clean other agents'
   worktrees. Delete its branch only after confirming it is fully merged.
   Push only if publishing was authorized; local merging is not a push.

Return `MERGED` with landed SHA, review/test evidence and root-sync status, or
`FAILED`/`ESCALATE` with the precise blocker and preserved paths. A merge helper
never resolves the graph; the supervisor does that after successful verification.

## Worktree and cross-repo validation

Spor client worktrees are zero-dependency. For server work, inspect the target
repo's `dispatch.worktreeSetup` and actual dependency setup. Install missing
dependencies within the isolated worktree without altering the shared checkout.
If node_modules is a symlink, remove only that symlink before an isolated install.

Inspect how the server selects the client library (including `SPOR_LIB` or a
`file:` dependency). Never assume a machine-specific path or that a server
worktree sees a client worktree's edits. If both changes must be present to
validate, stop isolated dispatch and schedule explicitly scoped solo work on
the linked checkouts. Independently testable cross-repo acceptance instead uses
[split.md](split.md).

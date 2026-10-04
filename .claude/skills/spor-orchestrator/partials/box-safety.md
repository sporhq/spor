<!-- SOURCE OF TRUTH for the box-safety rules every orchestrator prompt carries
     (task-spor-consolidate-box-safety-rules). Do not edit the rendered copies:
     edit a block here, then run `node scripts/render-box-safety.js` from the
     repo's .claude/skills/spor-orchestrator dir (or `--check` to see drift).
     test/box-safety-partial.test.js fails when a rendered copy differs.
     Blocks are spliced into a file between
       <!-- box-safety:begin NAME [indent=N] [cmd=...] -->
       <!-- box-safety:end -->
     markers; `indent` indents every non-empty line, `cmd` fills <<cmd>>.
     `{{...}}` is left for `spor dispatch --template` to substitute. -->

<!-- block: ops-script -->
**Never run a host-mutating ops script against real paths — by hand or from a
test.** A script that deletes, prunes, gc's, acks, erases or restarts
(`scripts/*.sh` like `enospc-recover.sh`, `prune-*`, `ack-*`, anything taking
`--apply`) acts on the whole shared box: its `/tmp`, its Docker daemon, its
live `SPOR_HOME`, its running server. A test of one must point EVERY root it
touches at a `mkdtemp` through an override the script honours, put stubs for
every external binary it calls (`docker`, `fly`, `systemctl`, `sudo`, …)
first on `PATH`, pass `--no-restart` where offered, and opt in to `--apply`
explicitly, only inside that sandbox — including the first red draft of the
test. A root the script hardcodes (`enospc-recover.sh` sweeps the real `/tmp`
today) has no sandbox: add an override, or leave that path untested and say
so in your report. This box also holds other agents' worktrees and scratch
(`/tmp/claude-*`): one implementer's early test ran `enospc-recover.sh
--apply` for real and pruned every Docker image plus other sessions' scratch
(issue-spor-implementer-ran-destructive-host-script-during-test).
<!-- /block -->

<!-- block: ops-script-infra -->
**Never run a host-mutating ops script from a test, and never against real
paths unless the item explicitly authorizes that run.** Your authorized swamp
change (deploy, or rollback within scope) is the only infrastructure mutation
you make. A box-local ops script (`scripts/*.sh` like `enospc-recover.sh`,
`prune-*`, `ack-*`, anything taking `--apply`) acts on the whole shared box:
its `/tmp`, its Docker daemon, its live `SPOR_HOME`, its running server. A test
of one must point EVERY root it touches at a `mkdtemp` through an override the
script honours, put stubs for every external binary it calls (`docker`, `fly`,
`systemctl`, `sudo`, …) first on `PATH`, pass `--no-restart` where offered, and
opt in to `--apply` explicitly, only inside that sandbox. A root the script
hardcodes gets an override or stays untested, said so in your report. The box
hosts other agents' worktrees, scratch and Docker images
(issue-spor-implementer-ran-destructive-host-script-during-test).
<!-- /block -->

<!-- block: kill-own -->
**Only ever kill processes you started — by the PID or process group you
recorded, never by pattern.** A suite you detach gets its own process group,
recorded: `setsid … & echo $! > "$LOG.pgid"`, and `kill -- -"$(cat "$LOG.pgid")"`
stops it. Never `pkill -f`, `killall`, `pkill node`, or `kill $(pgrep …)`: this
box runs other agents' suites concurrently in their own worktrees, and a
pattern like `pkill -f "node --test"` kills theirs too — they then fail as
signal-killed runs with no trace back to you
(issue-spor-orchestrator-agent-global-pkill-kills-other-agents). A process you
did not start that looks hung is not yours to kill: name it in your final
report or verdict; don't kill it.
<!-- /block -->

<!-- block: foreground-suite -->
**Run any suite or check in the FOREGROUND — never as a background job, and
never end your turn waiting on it or on a completion notification.** You are a one-shot
supervised run: your turn ending is the run ending, so anything not
committed and resolved by then is gone, not merely paused (this is exactly
how two implementers in this fleet lost their commit). If it may run longer
than the Bash tool's 600000ms (10min) cap, don't fight the cap with a bigger
timeout — launch it detached to a log and poll for completion in the
foreground with an until-loop, each poll comfortably under 10 minutes. Give
the run its own process group and RECORD it, so "stop my suite" can only ever
mean yours, e.g.:
```bash
LOG=/tmp/{{node}}-test.log
setsid sh -c '<<cmd>> > "$1" 2>&1; echo "EXIT=$?" >> "$1"' sh "$LOG" & echo $! > "$LOG.pgid"
```
then, in later Bash calls:
```bash
LOG=/tmp/{{node}}-test.log; until grep -q '^EXIT=' "$LOG"; do sleep 30; done; tail -50 "$LOG"
```
This is the same foreground-only discipline `references/merge.md` holds merge
subagents to for a long `npm test`. To stop that run:
`LOG=/tmp/{{node}}-test.log; kill -- -"$(cat "$LOG.pgid")"`.
<!-- /block -->

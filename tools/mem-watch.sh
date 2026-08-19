#!/usr/bin/env bash
# Run a command and sample the memory of its WHOLE process tree until it exits.
#
# WHY THIS EXISTS: our test entry points spawn children (test-*.js runs
# test/run.js, which may itself spawn workers or a browser), so measuring one
# pid understates the real cost -- and `/usr/bin/time -l` reports a single
# max-RSS number that silently folds in descendants, so the two disagree by
# 10x and neither tells you *when* or *where* the memory went. This samples the
# tree on an interval and prints a timeline plus the peak, so a spike can be
# attributed to a phase of the run.
#
# Usage:
#   tools/mem-watch.sh [--interval=SEC] [--quiet] -- <command> [args...]
#
# Example:
#   tools/mem-watch.sh -- node test/test-aoe-menu.js
#   tools/mem-watch.sh --interval=0.1 -- node test/run.js --exe=... --png=out.png

set -uo pipefail

INTERVAL=0.25
QUIET=0
while [ $# -gt 0 ]; do
  case "$1" in
    --interval=*) INTERVAL="${1#*=}"; shift ;;
    --quiet) QUIET=1; shift ;;
    --) shift; break ;;
    *) echo "mem-watch: unexpected argument '$1' (did you forget --?)" >&2; exit 2 ;;
  esac
done

if [ $# -eq 0 ]; then
  echo "usage: tools/mem-watch.sh [--interval=SEC] [--quiet] -- <command> [args...]" >&2
  exit 2
fi

"$@" &
ROOT_PID=$!

# Sum RSS over the process tree rooted at ROOT_PID. One ps call per sample:
# walking /proc-style per-pid files is not available on macOS, and repeated ps
# invocations per descendant would cost more than the thing being measured.
sample_tree() {
  ps -Ao pid=,ppid=,rss= | awk -v root="$ROOT_PID" '
    { pid[NR] = $1; ppid[NR] = $2; rss[NR] = $3; n = NR }
    END {
      inTree[root] = 1
      # Repeat until no new descendants are found; process lists are small and
      # a child may appear before its parent in ps output.
      changed = 1
      while (changed) {
        changed = 0
        for (i = 1; i <= n; i++) {
          if (!inTree[pid[i]] && inTree[ppid[i]]) { inTree[pid[i]] = 1; changed = 1 }
        }
      }
      total = 0; procs = 0
      for (i = 1; i <= n; i++) if (inTree[pid[i]]) { total += rss[i]; procs++ }
      printf "%d %d", total, procs
    }'
}

PEAK_KB=0
PEAK_AT=0
START=$SECONDS
while kill -0 "$ROOT_PID" 2>/dev/null; do
  read -r TOTAL_KB NPROC <<<"$(sample_tree)"
  [ -z "${TOTAL_KB:-}" ] && TOTAL_KB=0
  if [ "$TOTAL_KB" -gt "$PEAK_KB" ]; then
    PEAK_KB=$TOTAL_KB
    PEAK_AT=$((SECONDS - START))
  fi
  if [ "$QUIET" -eq 0 ]; then
    printf '[mem-watch] t=%3ds  tree=%5.2f GB  procs=%s\n' \
      "$((SECONDS - START))" "$(echo "scale=4; $TOTAL_KB/1048576" | bc)" "${NPROC:-0}"
  fi
  sleep "$INTERVAL"
done

wait "$ROOT_PID"
STATUS=$?

printf '[mem-watch] PEAK %.2f GB at t=%ds  (exit %d, %ds wall)\n' \
  "$(echo "scale=4; $PEAK_KB/1048576" | bc)" "$PEAK_AT" "$STATUS" "$((SECONDS - START))"
exit $STATUS

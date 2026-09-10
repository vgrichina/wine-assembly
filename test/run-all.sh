#!/usr/bin/env bash
# Aggregating test runner. Classifies test/test-*.js and test/*.test.js into three tiers and runs
# them sequentially, printing a summary at the end.
#
# Usage:
#   test/run-all.sh            # everything, CPU-count tests at a time
#   test/run-all.sh quick -j4  # cap the parallelism (JOBS=4 works too)
#   test/run-all.sh unit       # only unit (in-process WASM, fast)
#   test/run-all.sh e2e        # only e2e (spawns test/run.js per case)
#   test/run-all.sh smoke      # only smoke matrix (all-exes, dialogs)
#   test/run-all.sh quick      # unit only — the pre-commit tier
#
# Tiers come from filename conventions plus the small, validated exception
# lists in tools/test-tiers.js. New ordinary tests enter UNIT automatically;
# browser/application conventions enter E2E. Logs land in
# test/output/run-all/<tier>/<name>.log so a failure can be inspected without
# re-running.

set -u
cd "$(dirname "$0")/.."

# Args in any order: the tier name, plus -jN / --jobs=N / --heap=MB.
TIER=all
for a in "$@"; do
  case "$a" in
    -j*)        JOBS="${a#-j}" ;;
    --jobs=*)   JOBS="${a#--jobs=}" ;;
    --heap=*)   TEST_HEAP_MB="${a#--heap=}" ;;
    --timeout=*) TEST_TIMEOUT="${a#--timeout=}" ;;
    -h|--help)
      echo "usage: test/run-all.sh [all|unit|quick|e2e|smoke] [-jN|--jobs=N] [--heap=MB] [--timeout=SEC]"
      echo "  -jN / --jobs=N   tests to run at once (default: CPU count; env JOBS also works)"
      echo "  --heap=MB        per-child JS heap cap (default 2048; env TEST_HEAP_MB)"
      echo "  --timeout=SEC    kill a test that runs longer (default 300; env TEST_TIMEOUT, 0 disables)"
      exit 0 ;;
    -*)         echo "unknown option: $a" >&2; exit 2 ;;
    *)          TIER="$a" ;;
  esac
done

# Tier membership is derived from filenames. The classifier validates its small
# compatibility exception list and prints paths in deterministic order; adding a
# conventionally named test therefore needs no edit to this central runner.
UNIT=()
E2E=()
SMOKE=()
while IFS= read -r file; do UNIT+=("$file"); done < <(node tools/test-tiers.js unit)
while IFS= read -r file; do E2E+=("$file"); done < <(node tools/test-tiers.js e2e)
while IFS= read -r file; do SMOKE+=("$file"); done < <(node tools/test-tiers.js smoke)

# Refuse to run if an exception is stale/redundant, a quarantine has no reason,
# or any discovered test is not assigned exactly once.
if ! bash tools/check-test-manifest.sh; then
  echo "run-all: refusing to run an incomplete suite" >&2
  exit 2
fi

LOG_ROOT=test/output/run-all
mkdir -p "$LOG_ROOT"

# Each test is its own node process with its own 128MB WASM memory, so the tier
# is embarrassingly parallel and was running one at a time on an 8-core box.
#   -jN / --jobs=N or JOBS=N     how many at once (default: CPU count)
#   --heap=MB or TEST_HEAP_MB    per-child JS heap cap (default 2048). The
#                 guest's 128MB WASM memory lives outside this cap, so it is
#                 about keeping N children from collectively swapping, not
#                 about how much memory the emulated app can have.
if [ -z "${JOBS:-}" ]; then
  if command -v sysctl >/dev/null 2>&1; then JOBS=$(sysctl -n hw.ncpu 2>/dev/null)
  elif command -v nproc >/dev/null 2>&1; then JOBS=$(nproc)
  fi
  JOBS=${JOBS:-4}
fi
TEST_HEAP_MB="${TEST_HEAP_MB:-2048}"

# A test that never exits used to stall the whole suite indefinitely -- the
# runner polls for finished slots and has no notion of one taking too long, so
# a single hung child holds its slot forever and the summary never prints.
# Every child now gets a wall-clock cap and is reported as TIMEOUT, which
# counts as a failure -- a suite that stalls is a suite nobody waits for.
# The cap is deliberately far above what any test needs (the slowest gameplay
# test measures 8.5s) so it catches hangs, not slow machines.
DEFAULT_TEST_TIMEOUT=300
TEST_TIMEOUT="${TEST_TIMEOUT:-$DEFAULT_TEST_TIMEOUT}"
SKIP_EXIT_STATUS=77

# bash 3.2 (what macOS ships) has no `wait -n`, so slots are polled.
run_tier() {
  local tier_name="$1"; shift
  local files=("$@")
  local log_dir="$LOG_ROOT/$tier_name"
  mkdir -p "$log_dir"
  local passed=0 skipped=0 failed=0
  local fail_list=()
  echo "=== $tier_name (${#files[@]} files, ${JOBS} at a time) ==="
  local start_tier=$SECONDS

  local slot_pid=() slot_name=() slot_log=() slot_start=()
  local i=0
  while [ $i -lt "$JOBS" ]; do slot_pid[$i]=""; i=$((i + 1)); done

  # Never leave children behind if the runner is interrupted.
  trap 'for p in "${slot_pid[@]}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done; exit 130' INT TERM

  local next=0 running=0
  local total=${#files[@]}
  while [ $next -lt "$total" ] || [ $running -gt 0 ]; do
    # Fill free slots.
    i=0
    while [ $i -lt "$JOBS" ] && [ $next -lt "$total" ]; do
      if [ -z "${slot_pid[$i]}" ]; then
        local f="${files[$next]}"
        local name; name=$(basename "$f" .js)
        slot_name[$i]="$name"
        slot_log[$i]="$log_dir/$name.log"
        slot_start[$i]=$SECONDS
        NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=$TEST_HEAP_MB" \
          WA_TEST_SKIP_EXIT="$SKIP_EXIT_STATUS" \
          node --require "$PWD/test/skip-exit.js" "$f" >"${slot_log[$i]}" 2>&1 &
        slot_pid[$i]=$!
        running=$((running + 1))
        next=$((next + 1))
      fi
      i=$((i + 1))
    done
    # Reap whatever finished.
    local reaped=0
    i=0
    while [ $i -lt "$JOBS" ]; do
      local pid="${slot_pid[$i]}"
      # Kill a child that has outlived the cap before checking for exits, so a
      # hung test frees its slot instead of holding it for the whole run. The
      # test process usually has a test/run.js child of its own; kill that
      # first, or it keeps running with nobody left to read its output.
      if [ -n "$pid" ] && [ "$TEST_TIMEOUT" -gt 0 ] \
         && [ $((SECONDS - ${slot_start[$i]})) -ge "$TEST_TIMEOUT" ] \
         && kill -0 "$pid" 2>/dev/null; then
        pkill -9 -P "$pid" 2>/dev/null
        kill -9 "$pid" 2>/dev/null
        wait "$pid" 2>/dev/null || true
        echo "run-all: killed after ${TEST_TIMEOUT}s wall clock" >>"${slot_log[$i]}"
        printf "TIME  %-40s  %3ds  %s\n" "${slot_name[$i]}" "$((SECONDS - ${slot_start[$i]}))" "${slot_log[$i]}"
        failed=$((failed + 1))
        fail_list+=("${slot_name[$i]} (timeout)")
        slot_pid[$i]=""
        running=$((running - 1))
        reaped=1
        pid=""
      fi
      if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
        local status=0
        wait "$pid" || status=$?
        if [ $status -eq 0 ]; then
          printf "PASS  %-40s  %3ds\n" "${slot_name[$i]}" "$((SECONDS - slot_start[$i]))"
          passed=$((passed + 1))
        elif [ $status -eq "$SKIP_EXIT_STATUS" ]; then
          printf "SKIP  %-40s  %3ds  %s\n" "${slot_name[$i]}" "$((SECONDS - slot_start[$i]))" "${slot_log[$i]}"
          skipped=$((skipped + 1))
        else
          printf "FAIL  %-40s  %3ds  %s\n" "${slot_name[$i]}" "$((SECONDS - slot_start[$i]))" "${slot_log[$i]}"
          failed=$((failed + 1))
          fail_list+=("${slot_name[$i]}")
        fi
        slot_pid[$i]=""
        running=$((running - 1))
        reaped=1
      fi
      i=$((i + 1))
    done
    [ $reaped -eq 0 ] && [ $running -gt 0 ] && sleep 0.2
  done
  trap - INT TERM
  echo "--- $tier_name: $passed passed, $skipped skipped, $failed failed in $((SECONDS - start_tier))s"
  if [ ${#fail_list[@]} -gt 0 ]; then
    TOTAL_FAILS+=("${fail_list[@]}")
  fi
  TOTAL_PASS=$((TOTAL_PASS + passed))
  TOTAL_SKIP=$((TOTAL_SKIP + skipped))
  TOTAL_FAIL=$((TOTAL_FAIL + failed))
  echo
}

TOTAL_PASS=0
TOTAL_SKIP=0
TOTAL_FAIL=0
TOTAL_FAILS=()

case "$TIER" in
  unit|quick)  run_tier unit  "${UNIT[@]}" ;;
  e2e)         run_tier e2e   "${E2E[@]}" ;;
  smoke)       run_tier smoke "${SMOKE[@]}" ;;
  all)
    run_tier unit  "${UNIT[@]}"
    run_tier e2e   "${E2E[@]}"
    run_tier smoke "${SMOKE[@]}"
    ;;
  *)
    echo "unknown tier: $TIER (want: all|unit|quick|e2e|smoke)" >&2
    exit 2
    ;;
esac

echo "======================================"
echo "TOTAL: $TOTAL_PASS passed, $TOTAL_SKIP skipped, $TOTAL_FAIL failed"
if [ $TOTAL_FAIL -gt 0 ]; then
  printf '  fail: %s\n' "${TOTAL_FAILS[@]}"
  exit 1
fi

#!/usr/bin/env bash
# Aggregating test runner. Classifies test/test-*.js into three tiers and runs
# them sequentially, printing a summary at the end.
#
# Usage:
#   test/run-all.sh            # everything
#   test/run-all.sh unit       # only unit (in-process WASM, fast)
#   test/run-all.sh e2e        # only e2e (spawns test/run.js per case)
#   test/run-all.sh smoke      # only smoke matrix (all-exes, dialogs)
#   test/run-all.sh quick      # unit only — the pre-commit tier
#
# Tiers are computed from filename patterns below — no test-file edits needed
# to add or reclassify. Logs land in test/output/run-all/<tier>/<name>.log so
# a failure can be inspected without re-running.

set -u
cd "$(dirname "$0")/.."

TIER="${1:-all}"

UNIT=(
  test/test-x86-ops.js
  test/test-bignum-mul.js
  test/test-mat4.js
  test/test-vfs.js
  test/test-radio-mutex.js
  test/test-listbox.js
  test/test-open-nav.js
  test/test-render-color-dlg.js
  test/test-render-find-dlg.js
  test/test-render-font-dlg.js
  test/test-render-open-dlg.js
)

E2E=(
  test/test-notepad.js
  test/test-notepad-find.js
  test/test-notepad-menu.js
  test/test-notepad-menu-items.js
  test/test-find-typing.js
  test/test-find-cancel.js
  test/test-about-cancel.js
  test/test-open-cancel.js
  test/test-help.js
  test/test-freecell-move.js
  test/test-freecell-dblclick.js
  test/test-freecell-stats.js
  test/test-solitaire-deal.js
  test/test-solitaire-drag.js
  test/test-solitaire-maximize.js
  test/test-solitaire-resize.js
  test/test-minesweeper-no-resize.js
  test/test-pinball-flipper.js
  test/test-tworld-launch.js
)

SMOKE=(
  test/test-all-exes.js
  test/test-notepad-dialogs.js
)

LOG_ROOT=test/output/run-all
mkdir -p "$LOG_ROOT"

run_tier() {
  local tier_name="$1"; shift
  local files=("$@")
  local log_dir="$LOG_ROOT/$tier_name"
  mkdir -p "$log_dir"
  local passed=0 failed=0
  local fail_list=()
  echo "=== $tier_name (${#files[@]} files) ==="
  local start_tier=$SECONDS
  for f in "${files[@]}"; do
    local name
    name=$(basename "$f" .js)
    local log="$log_dir/$name.log"
    local start=$SECONDS
    if node "$f" >"$log" 2>&1; then
      printf "PASS  %-40s  %3ds\n" "$name" "$((SECONDS - start))"
      passed=$((passed + 1))
    else
      printf "FAIL  %-40s  %3ds  %s\n" "$name" "$((SECONDS - start))" "$log"
      failed=$((failed + 1))
      fail_list+=("$name")
    fi
  done
  echo "--- $tier_name: $passed passed, $failed failed in $((SECONDS - start_tier))s"
  if [ ${#fail_list[@]} -gt 0 ]; then
    TOTAL_FAILS+=("${fail_list[@]}")
  fi
  TOTAL_PASS=$((TOTAL_PASS + passed))
  TOTAL_FAIL=$((TOTAL_FAIL + failed))
  echo
}

TOTAL_PASS=0
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
echo "TOTAL: $TOTAL_PASS passed, $TOTAL_FAIL failed"
if [ $TOTAL_FAIL -gt 0 ]; then
  printf '  fail: %s\n' "${TOTAL_FAILS[@]}"
  exit 1
fi

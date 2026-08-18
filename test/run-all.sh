#!/usr/bin/env bash
# Aggregating test runner. Classifies test/test-*.js into three tiers and runs
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
# Tiers are computed from filename patterns below — no test-file edits needed
# to add or reclassify. Logs land in test/output/run-all/<tier>/<name>.log so
# a failure can be inspected without re-running.

set -u
cd "$(dirname "$0")/.."

# Args in any order: the tier name, plus -jN / --jobs=N / --heap=MB.
TIER=all
for a in "$@"; do
  case "$a" in
    -j*)        JOBS="${a#-j}" ;;
    --jobs=*)   JOBS="${a#--jobs=}" ;;
    --heap=*)   TEST_HEAP_MB="${a#--heap=}" ;;
    -h|--help)
      echo "usage: test/run-all.sh [all|unit|quick|e2e|smoke] [-jN|--jobs=N] [--heap=MB]"
      echo "  -jN / --jobs=N   tests to run at once (default: CPU count; env JOBS also works)"
      echo "  --heap=MB        per-child JS heap cap (default 2048; env TEST_HEAP_MB)"
      exit 0 ;;
    -*)         echo "unknown option: $a" >&2; exit 2 ;;
    *)          TIER="$a" ;;
  esac
done

UNIT=(
  test/test-x86-ops.js
  test/test-ne-loader.js
  test/test-win16-exec.js
  test/test-fs-prefix.js
  test/test-bignum-mul.js
  test/test-mat4.js
  test/test-vfs.js
  test/test-storage-registry.js
  test/test-codepage-dbcs.js
  test/test-atom-table.js
  test/test-menu-insert.js
  test/test-sscanf.js
  test/test-format-message-inserts.js
  test/test-wat-dib-rle.js
  test/test-winhelp-wat-parser.js
  test/test-wide-api.js
  test/test-midi-mci.js
  test/test-thread-manager.js
  test/test-dev-server.js
  test/test-vlan-rtc.js
  test/test-waveout-audio.js
  test/test-wavein-audio.js
  test/test-audio-mixer.js
  test/test-core-no-app-fast-paths.js
  test/test-wat-gdi-region.js
  test/test-wat-gdi-select-clip-path.js
  test/test-wat-gdi-path.js
  test/test-wat-gdi-line.js
  test/test-wat-gdi-raster.js
  test/test-wat-gdi-raster-handlers.js
  test/test-wat-gdi-benchmark.js
  test/test-wat-gdi-bitmap.js
  test/test-wat-gdi-bitmap-handlers.js
  test/test-wat-gdi-palette.js
  test/test-gdi-migration-status.js
  test/test-gdi-public-api-status.js
  test/test-wat-gdi-public-bitmap-region.js
  test/test-wat-gdi-public-state-format.js
  test/test-wat-gdi-public-font.js
  test/test-wat-gdi-font-objects.js
  test/test-gdi-text-map-font.js
  test/test-wat-gdi-bitmap-text-layout.js
  test/test-wat-gdi-bitmap-text-compat.js
  test/test-wat-gdi-multiline-ellipsis.js
  test/test-wat-gdi-draw-text-ex.js
  test/test-wat-gdi-default-bitmap-font.js
  test/test-wat-gdi-font-enum.js
  test/test-wat-gdi-fixed-stock-font.js
  test/test-wat-truetype-metrics.js
  test/test-font-substitutions.js
  test/test-font-subsets.js
  test/test-wat-truetype-substitution.js
  test/test-wat-gdi-scalable-text.js
  test/test-wat-text-draw-extent.js
  test/test-wat-font-resource.js
  test/test-wat-gdi-public-metafile.js
  test/test-wat-gdi-printer-surface.js
  test/test-compatible-bitmap-wat.js
  test/test-gdi-patblt-brush.js
  test/test-gdi-surface.js
  test/test-gdi-deferred-presentation.js
  test/test-wat-memory-map.js
  test/test-wat-window-frame.js
  test/test-wat-statusbar-grip.js
  test/test-wat-font-metrics-reference.js
  test/test-wat-decoder-runaway.js
  test/test-wat-winsock.js
  test/test-vlan-wire.js
  test/test-large-dll-staging.js
  test/test-wat-gdi-state.js
  test/test-wat-gdi-text.js
  test/test-wat-gdi-callback-state.js
  test/test-wat-gdi-window-surface.js
  test/test-wat-gdi-directdraw-surface.js
  test/test-wat-gdi-screen-surface.js
  test/test-wat-gdi-shapes.js
  test/test-wat-gdi-geometry-handlers.js
  test/test-dib-dirty-sync.js
  test/test-web-pinball-assets.js
  test/test-pinball-web-lifecycle.js
  test/test-web-touch-input.js
  test/test-web-fullscreen-consent.js
  test/test-web-pwa-metadata.js
  test/test-radio-mutex.js
  test/test-listbox.js
  test/test-tooltip.js
  test/test-open-nav.js
  test/test-host-window-related.js
  test/test-process-id.js
  test/test-render-color-dlg.js
  test/test-render-find-dlg.js
  test/test-render-font-dlg.js
  test/test-render-open-dlg.js
  test/test-canvas-keydown-preventdefault.js
  test/test-renderer-mouse-drag-mask.js
  test/test-renderer-dialog-caption-drag.js
  test/test-renderer-shell-dialog.js
  test/test-renderer-multi-app-modal.js
)

E2E=(
  test/test-taskman-tasks.js
  test/test-taskman-arrange.js
  test/test-taskman-web.js
  test/test-wordpad-web.js
  test/test-wordpad-thread-startup.js
  test/test-wordpad-copy-clipboard.js
  test/test-fontview.js
  test/test-mspaint-web.js
  test/test-sound-recorder-audio.js
  test/test-volume-control-audio.js
  test/test-notepad.js
  test/test-notepad-find.js
  test/test-notepad-menu.js
  test/test-notepad-menu-items.js
  test/test-notepad-typing-latency.js
  test/test-notepad-typing-scroll.js
  test/test-find-typing.js
  test/test-notepad-find-next-positive.js
  test/test-notepad-find-not-found-msgbox.js
  test/test-find-cancel.js
  test/test-about-cancel.js
  test/test-calc-about.js
  test/test-calc-drag-close.js
  test/test-calc-helper-window.js
  test/test-open-cancel.js
  test/test-help.js
  test/test-winhelp-dll-macro.js
  test/test-freecell-select-game.js
  test/test-freecell-move.js
  test/test-freecell-dblclick.js
  test/test-freecell-stats.js
  test/test-funtris-hall-of-fame-ok.js
  test/test-funtris-gameover-hall-name.js
  test/test-funtris-options.js
  test/test-funtris-new-game.js
  test/test-funtris-web-launch.js
  test/test-win98-audio-web.js
  test/test-local-candidate-desktop-web.js
  test/test-win16-web.js
  test/test-win16-dialog.js
  test/test-win16-menus.js
  test/test-win16-hearts-startup.js
  test/test-win16-solitaire-play.js
  test/test-win16-minesweeper-smiley.js
  test/test-win16-hearts-menus.js
  test/test-win16-dde-room.js
  test/test-win16-dde-connect-callback.js
  test/test-sysmon-perfstats.js
  test/test-local-candidates-playability.js
  test/test-dxball-candidate.js
  test/test-blobby-volley.js
  test/test-blobby-network.js
  test/test-pyramid-menu.js
  test/test-bricks-drag.js
  test/test-empipe-start.js
  test/test-empipe-stage-transition.js
  test/test-cwordzap-render.js
  test/test-gdi-stock-select.js
  test/test-mspaint-draw.js
  test/test-mspaint-tools.js
  test/test-mspaint-tool-repaint.js
  test/test-mspaint-options.js
  test/test-mspaint-file-roundtrip.js
  test/test-mspaint-dirty-new.js
  test/test-mspaint-clipboard.js
  test/test-mspaint-large-scroll.js
  test/test-mspaint-scrollbar-thumb.js
  test/test-mspaint-thumbnail.js
  test/test-mplay32-dual-mode.js
  test/test-statusbar-surface.js
  test/test-regedit-deep.js
  test/test-solitaire-deal.js
  test/test-solitaire-drag.js
  test/test-cruel-maximized-launch-layout.js
  test/test-skifree-showwindow-startup.js
  test/test-skifree-gameplay.js
  test/test-spider-deal-menu.js
  test/test-spider-drag.js
  test/test-spider-maximized-canvas-resize.js
  test/test-spider-messagebox.js
  test/test-spider-show-available-move-menu.js
  test/test-solitaire-maximize.js
  test/test-solitaire-resize.js
  test/test-minesweeper-click.js
  test/test-minesweeper-no-resize.js
  test/test-minesweeper-smiley-reset.js
  test/test-pinball-controls-layout.js
  test/test-pinball-fullscreen-menu.js
  test/test-pinball-flipper.js
  test/test-pinball-web-render.js
  test/test-aoe-menu.js
  test/test-tworld-launch.js
  test/test-winamp-about-web.js
  test/test-vlan-loopback.js
  test/test-wat-windowposchanged.js
  test/test-tetrinet-connect.js
  test/test-vlan-browser.js
)

SMOKE=(
  test/test-all-exes.js
  test/test-notepad-dialogs.js
)

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

# bash 3.2 (what macOS ships) has no `wait -n`, so slots are polled.
run_tier() {
  local tier_name="$1"; shift
  local files=("$@")
  local log_dir="$LOG_ROOT/$tier_name"
  mkdir -p "$log_dir"
  local passed=0 failed=0
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
          node "$f" >"${slot_log[$i]}" 2>&1 &
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
      if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
        local status=0
        wait "$pid" || status=$?
        if [ $status -eq 0 ]; then
          printf "PASS  %-40s  %3ds\n" "${slot_name[$i]}" "$((SECONDS - slot_start[$i]))"
          passed=$((passed + 1))
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

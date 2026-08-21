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
# Tiers are the explicit arrays below — a new test/test-*.js has to be added to
# one of them by hand, and tools/check-test-manifest.sh (run before any tier)
# fails if one is in none. Logs land in test/output/run-all/<tier>/<name>.log so
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
  test/test-shift-equivalence.js
  test/test-ne-loader.js
  test/test-win16-exec.js
  test/test-fs-prefix.js
  test/test-create-directory-last-error.js
  test/test-bignum-mul.js
  test/test-mat4.js
  test/test-vfs.js
  test/test-vfs-host-files.js
  test/test-storage-registry.js
  test/test-codepage-dbcs.js
  test/test-atom-table.js
  test/test-menu-insert.js
  test/test-menu-popup-text.js
  test/test-dynamic-menu-bar.js
  test/test-sscanf.js
  test/test-format-message-inserts.js
  test/test-ole-clipboard-wrap.js
  test/test-ole-insert-object-dlg.js
  test/test-wat-dib-rle.js
  test/test-icon-extract.js
  test/test-winhelp-wat-parser.js
  test/test-wide-api.js
  test/test-midi-mci.js
  test/test-thread-manager.js
  test/test-mm-timer-callback.js
  test/test-browser-mm-timer.js
  test/test-diablo-runtime-apis.js
  test/test-debug-thread-state.js
  test/test-dev-server.js
  test/test-vlan-rtc.js
  test/test-waveout-audio.js
  test/test-wavein-audio.js
  test/test-audio-mixer.js
  test/test-core-no-app-fast-paths.js
  test/test-wat-gdi-region.js
  test/test-wat-gdi-select-clip-path.js
  test/test-wat-gdi-path.js
  test/test-gdi-p0-p1.js
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
  test/test-font-enum-sizes.js
  test/test-wat-gdi-fixed-stock-font.js
  test/test-wat-truetype-metrics.js
  test/test-wat-truetype-hinting.js
  test/test-font-substitutions.js
  test/test-font-subsets.js
  test/test-wat-truetype-substitution.js
  test/test-wat-gdi-scalable-text.js
  test/test-win98-gdi-font-outline-reference.js
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
  test/test-paint-wallpaper-host.js
  test/test-region-window-client-rect.js
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
  test/test-mem-utils-dib-g2w.js
  test/test-web-pinball-assets.js
  test/test-process-boot-yields.js
  test/test-worker-imports.js
  test/test-debug-midi.js
  test/test-vfs-seed.js
  test/test-vfs-miss-async.js
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
  test/test-renderer-input-cursor.js
  test/test-renderer-mouse-drag-mask.js
  test/test-renderer-dialog-caption-drag.js
  test/test-renderer-shell-dialog.js
  test/test-renderer-multi-app-modal.js
  # Recovered 2026-08-18: written, never listed here, so never run. All green
  # on the sweep that found them; see QUARANTINE for the ones that were not.
  test/test-aoe-span-trace-handler.js
  test/test-aoe-stack-packet-handler.js
  test/test-clipboard-rtf-api.js
  test/test-coinitialize-ex.js
  test/test-critical-section-threading.js
  test/test-ddraw-surface-dirty-rect.js
  test/test-defer-window-pos-visibility.js
  test/test-delphi-seh-mutated-chain.js
  test/test-desktop-surface-color.js
  test/test-dialog-idok-handled.js
  test/test-directdraw-cooperative-window.js
  test/test-directdraw-create-ex.js
  test/test-directinput-device.js
  test/test-directinput8-create.js
  test/test-directx-ordinals.js
  test/test-dx-vtable-worker-sync.js
  test/test-disabled-dialog-controls.js
  test/test-duplicate-handle.js
  test/test-ext-text-out-wide.js
  test/test-findreplace-matchcase-flags.js
  test/test-gdi-exttextout-clipping.js
  test/test-gdi-transparent-blt.js
  test/test-gdi-scroll-window-rect.js
  test/test-listview.js
  test/test-edit-wrap-resize.js
  test/test-isequalguid.js
  test/test-kernel32-last-error.js
  test/test-movewindow-child-size.js
  test/test-named-event-api.js
  test/test-nested-child-paint.js
  test/test-ole-bind-context.js
  test/test-ole-cfb.js
  test/test-ole-data-object.js
  test/test-ole-guest-callback.js
  test/test-ole-moniker.js
  test/test-ole-running-object-table.js
  test/test-ole-static-handler.js
  test/test-ole-storage.js
  test/test-parent-child-paint-order.js
  test/test-pe-zero-original-first-thunk.js
  test/test-peek-message-filter.js
  test/test-raster-canvas.js
  test/test-renderer-dialog-modal-input.js
  test/test-renderer-input-resize.js
  test/test-renderer-palette-route.js
  test/test-renderer-transparent-desktop.js
  test/test-richedit-version-compat.js
  test/test-rtf-stylesheet.js
  test/test-shell-desktop-fallback.js
  test/test-solitaire-web.js
  test/test-sparse-width-boundary.js
  test/test-string-ops-sparse-boundary.js
  test/test-surface.js
  test/test-system-metrics.js
  test/test-toolbar-insert.js
  test/test-treeview-scroll.js
  test/test-v86-reference-paint-workflows.js
  test/test-vfs-legacy-hfile.js
  test/test-virtual-map-cross-instance.js
  test/test-wat-drive-types.js
  test/test-wat-gdi-region-lazy-mirror.js
  test/test-wat-gdi-screen-readback.js
  test/test-wat-winsock-hostname.js
  test/test-window-control-id.js
  test/test-compile-wat-unknown-name.js
  test/test-gdi-public-seven.js
  test/test-combobox.js
  test/test-render-combobox.js
)

E2E=(
  test/test-win16-wep-gameplay.js
  test/test-win16-vb-gameplay.js
  test/test-win16-wep-class-menu.js
  test/test-win16-pipe-help.js
  test/test-win16-pipe-about.js
  test/test-win16-jigsawed.js
  test/test-win16-entertainment-manifests.js
  test/test-cli-vfs-include.js
  test/test-winhelp-reference.js
  test/test-taskman-tasks.js
  test/test-taskman-arrange.js
  test/test-taskman-web.js
  test/test-wordpad-web.js
  test/test-wordpad-thread-startup.js
  test/test-wordpad-copy-clipboard.js
  test/test-wordpad-paste-refcount.js
  test/test-wordpad-font-combo.js
  test/test-wordpad-font-size-list.js
  test/test-fontview.js
  test/test-mspaint-web.js
  test/test-mspaint-berrry-video.js
  test/test-qblackjack-web.js
  test/test-sound-recorder-audio.js
  test/test-volume-control-audio.js
  test/test-notepad.js
  test/test-notepad-find.js
  test/test-notepad-menu.js
  test/test-notepad-menu-items.js
  test/test-notepad-typing-latency.js
  test/test-notepad-typing-scroll.js
  test/test-notepad-scrollbar-cursor.js
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
  test/test-win16-hearts-vlan.js
  test/test-web-hearts-lan.js
  test/test-web-hearts-rtc.js
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
  test/test-cursor-class.js
  test/test-mspaint-thumbnail.js
  test/test-mplay32-dual-mode.js
  test/test-statusbar-surface.js
  test/test-regedit-deep.js
  test/test-solitaire-deal.js
  test/test-solitaire-drag.js
  test/test-cruel-maximized-launch-layout.js
  test/test-skifree-showwindow-startup.js
  test/test-skifree-gameplay.js
  test/test-cs-owndc-stats-font.js
  test/test-spider-deal-menu.js
  test/test-spider-drag.js
  test/test-spider-maximized-canvas-resize.js
  test/test-spider-messagebox.js
  test/test-spider-show-available-move-menu.js
  test/test-solitaire-maximize.js
  test/test-window-show-state.js
  test/test-solitaire-resize.js
  test/test-minesweeper-click.js
  test/test-minesweeper-no-resize.js
  test/test-minesweeper-smiley-reset.js
  test/test-pinball-controls-layout.js
  test/test-pinball-fullscreen-menu.js
  test/test-pinball-select-players.js
  test/test-pinball-flipper.js
  test/test-pinball-web-render.js
  test/test-aoe-menu.js
  test/test-tworld-launch.js
  test/test-winamp-about-web.js
  test/test-winamp-visualization-web.js
  test/test-vlan-loopback.js
  test/test-wat-windowposchanged.js
  test/test-tetrinet-connect.js
  test/test-vlan-browser.js
  # Recovered 2026-08-18 (see the UNIT note). Several of these only pass now
  # because their spawn budgets were raised off the 5-15s they were written
  # with -- that is under the emulator's own CPU cost on a loaded box.
  test/test-calc-arith.js
  test/test-calc-view-switch.js
  test/test-calc-button-pressed.js
  test/test-cli-candidate-corpus.js
  test/test-cwordzap-gameplay.js
  test/test-entertainment-menu-client-layout.js
  test/test-generated-fixedsys-fon.js
  test/test-generated-wine-fonts.js
  test/test-minesweeper-custom-tab.js
  test/test-mspaint-attributes.js
  test/test-mspaint-dock-toggle.js
  test/test-mspaint-edit-colors-hook.js
  test/test-mspaint-flip-radio-groups.js
  test/test-mspaint-line-width.js
  test/test-mspaint-magnifier-menu.js
  test/test-mspaint-opaque-selection.js
  test/test-mspaint-selection-move.js
  test/test-mspaint-image-edit.js
  test/test-mspaint-statusbar.js
  test/test-mspaint-stretch-icons.js
  test/test-notepad-editing.js
  test/test-notepad-file-menu.js
  test/test-notepad-find-radio-click.js
  test/test-notepad-find-tab.js
  test/test-notepad-open-file-title.js
  test/test-notepad-type-and-find.js
  test/test-pinball-playable.js
  test/test-pinball-select-table.js
  test/test-qbob-candidate.js
  test/test-solitaire-maximize-restore.js
  test/test-winamp.js
  test/test-winamp-audio.js
  test/test-winamp-eq-presets.js
  test/test-winamp-installers.js
  test/test-wordpad-advanced-rtf.js
  test/test-wordpad-dialog-lifecycle.js
  test/test-wordpad-format-accelerators.js
  test/test-wordpad-format-roundtrip.js
  test/test-wordpad-international.js
  test/test-wordpad-keyboard-rich-clipboard-format.js
  test/test-wordpad-layout-stress.js
  test/test-wordpad-menu-edit-clipboard.js
  test/test-wordpad-mixed-charformat.js
  test/test-wordpad-mixed-format-roundtrip.js
  test/test-wordpad-ole-clipboard.js
  test/test-wordpad-ole-keyboard-undo.js
  test/test-wordpad-ole-space-copy.js
  test/test-wordpad-paraformat-fields.js
  test/test-wordpad-paraformat-roundtrip.js
  test/test-wordpad-plain-text-filter.js
  test/test-wordpad-printing.js
  test/test-wordpad-reopen-saved.js
  test/test-wordpad-rich-clipboard-format.js
  test/test-wordpad-richedit-clipping.js
  test/test-wordpad-richedit-color.js
  test/test-wordpad-richedit-scroll.js
  test/test-wordpad-richedit.js
  test/test-wordpad-save-as.js
  test/test-wordpad-selection-highlight.js
  test/test-wordpad-toolbar.js
  test/test-wordpad-toolbar-color-menu.js
  test/test-wordpad-toolbar-format-buttons.js
  test/test-wordpad-font-dialog.js
  test/test-wordpad-paragraph-align.js
  test/test-wordpad-caret.js
  test/test-wordpad-replace.js
  test/test-wordpad-undo-find.js
  test/test-wordpad-ui-advanced.js
  # Green only once their budgets stopped being shorter than the work: the two
  # vlan ones spawn a second emulator and wait for it over the wire.
  test/test-find-mouse-click.js
  test/test-liquid-war-candidate.js
  test/test-vlan-tetrinet.js
  test/test-combobox-pinball.js
)

SMOKE=(
  test/test-all-exes.js
  test/test-notepad-dialogs.js
)

# Known-red. These are NOT run by any tier; they are listed so that
# tools/check-test-manifest.sh can tell "deliberately parked" from "nobody ever
# added it", which is how 145 files ended up invisible in the first place.
# Every entry carries what it actually reports -- fix the cause, then move the
# line up into UNIT or E2E. Reasons measured 2026-08-18.
#
# Harness drift: the test calls a host/renderer entry point that no longer
# exists. Cheap to fix; the product is probably fine.
QUARANTINE=(
  # b2a93f7 added winhelp-freecell-default/-topics to apps.json without
  # capturing their reviewed references; capture.js needs the Win98 v86 state
  # off the network, and a reference nobody looked at is worse than none.
  test/test-v86-reference-harness.js    # 2 manifest apps have no reviewed capture
  test/test-vlan-match.js               # server now listens, then no progress in 400s on 3.0s of CPU
  # OLE presentation data -- the known static-handler/IDataObject gap.
  test/test-wordpad-ole-roundtrip.js    # saved RTF carries no DIB presentation
  test/test-wordpad-ole-delete-roundtrip.js
)

# A test file missing from every array above does not fail, it just never runs.
# Refuse to report a green suite while that is true of anything.
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

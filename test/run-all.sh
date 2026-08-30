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

UNIT=(
  test/test-boot-cursor.js
  test/test-x86-ops.js
  test/test-lut-run-generalized.js
  test/test-mmx-mask-copy-run.js
  test/test-copy32-bounded-run.js
  test/test-packed-avg-run.js
  test/test-mw3-rgb565-alpha-run.js
  test/test-lut-span.js
  test/test-load32-esp-run.js
  test/test-shift-equivalence.js
  test/test-ne-loader.js
  test/test-win16-exec.js
  test/test-fs-prefix.js
  test/test-create-directory-last-error.js
  test/test-unhandled-exception-filter.js
  test/test-cxx-throw-report.js
  test/test-dynamic-module-filename.js
  test/test-bignum-mul.js
  test/test-mat4.js
  test/test-vfs.js
  test/test-flush-view-of-file.js
  test/test-heap-free-block-validation.js
  test/test-vfs-host-files.js
  test/test-storage-registry.js
  test/test-registry-snapshot-diff.js
  test/test-vfs-export.js
  test/test-codepage-dbcs.js
  test/test-atom-table.js
  test/test-menu-insert.js
  test/test-image-list-icons.js
  test/test-insert-menu-item-host-bar.js
  test/test-menu-popup-text.js
  test/test-dynamic-menu-bar.js
  test/test-sscanf.js
  test/test-format-message-inserts.js
  test/test-ole-clipboard-wrap.js
  test/test-ole-insert-object-dlg.js
  test/test-wat-dib-rle.js
  test/test-icon-extract.js
  test/test-heroes2-desktop-save.js
  test/test-wide-api.js
  test/test-oem-to-char-buff.js
  test/test-ver-find-file.js
  test/test-static-dx-version.js
  test/test-midi-mci.js
  test/test-mci-get-device-id.js
  test/test-thread-manager.js
  test/test-worker-metadata-refresh.js
  test/test-mm-timer-callback.js
  test/test-run-budget-completes-resume.js
  test/test-cmp-memory-jb.js
  test/test-browser-waveout-pump.js
  test/test-browser-worker-dx-present.js
  test/test-browser-worker-input-focus.js
  test/test-dll-init-order.js
  test/test-getmessage-teardown-quit.js
  test/test-gpu-backend.js
  test/test-keyboard-message-lparam.js
  test/test-to-ascii.js
  test/test-keyboard-hook.js
  test/test-opengl-fixed-function.js
  test/test-opengl-frame-state.js
  test/test-opengl-command-stream.js
  test/test-gpu-atomic-present.js
  test/test-opengl-swapbuffers.js
  test/test-renderer-dialog-button-queue.js
  test/test-dialog-button-command-queue.js
  test/test-dialog-custom-class.js
  test/test-nc-flags-message-wake.js
  test/test-browser-step-scheduler.js
  test/test-browser-worker-run-slice.js
  test/test-guest-rpc-nested-wait.js
  test/test-worker-api-batching.js
  test/test-console-input.js
  test/test-browser-mm-timer.js
  test/test-asset-parts.js
  test/test-runtime-log-toggle.js
  test/test-diablo-runtime-apis.js
  test/test-starcraft-dll-policy.js
  test/test-debug-game-apps.js
  test/test-dllmain-load-context.js
  test/test-debug-thread-state.js
  test/test-dev-server.js
  test/test-vlan-rtc.js
  test/test-wsa-startup-data.js
  test/test-waveout-audio.js
  test/test-wavein-audio.js
  test/test-audio-mixer.js
  test/test-directsound-loop-refresh.js
  test/test-directsound3d-web-audio.js
  test/test-directsound3d-listener.js
  test/test-directsound-ordinals.js
  test/test-directsound-buffer-format.js
  test/test-wave-out-get-id.js
  test/test-core-no-app-fast-paths.js
  test/test-wat-gdi-select-clip-path.js
  test/test-wat-gdi-path.js
  test/test-gdi-p0-p1.js
  test/test-wat-gdi-line.js
  test/test-wat-gdi-raster.js
  test/test-gdi-fast-blit-paths.js
  test/test-wat-gdi-raster-handlers.js
  test/test-wat-gdi-bitmap.js
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
  test/test-wat-gdi-calcrect-memory-dc.js
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
  test/test-gdi-object-record-cache.js
  test/test-gdi-deferred-presentation.js
  test/test-heap-partition.js
  test/test-wat-atomics.js
  test/test-wat-locks.js
  test/test-wat-critical-section.js
  test/test-wat-window-tables.js
  test/test-wat-user-threading.js
  test/test-cross-thread-send.js
  test/test-wat-rpc-region.js
  test/test-worker-thread-scheduler.js
  test/test-wat-memory-map.js
  test/test-wat-window-frame.js
  test/test-paint-wallpaper-host.js
  test/test-region-window-client-rect.js
  test/test-wat-statusbar-grip.js
  test/test-wat-decoder-runaway.js
  test/test-page-chunk-sizing.js
  test/test-wat-winsock.js
  test/test-vlan-wire.js
  test/test-large-dll-staging.js
  test/test-wat-gdi-state.js
  test/test-wat-gdi-text.js
  test/test-wat-gdi-callback-state.js
  test/test-wat-gdi-window-surface.js
  test/test-wat-gdi-directdraw-surface.js
  test/test-wat-gdi-screen-surface.js
  test/test-vsnprintf.js
  test/test-strncmp.js
  test/test-wat-gdi-shapes.js
  test/test-wat-gdi-geometry-handlers.js
  test/test-dib-dirty-sync.js
  test/test-mem-utils-dib-g2w.js
  test/test-process-boot-yields.js
  test/test-worker-imports.js
  test/test-debug-midi.js
  test/test-vfs-seed.js
  test/test-vfs-miss-async.js
  test/test-pinball-web-lifecycle.js
  test/test-web-touch-input.js
  test/test-perf-hud-input.js
  test/test-web-fullscreen-consent.js
  test/test-web-page-fullscreen.js
  test/test-single-app-mode.js
  test/test-mobile-keyboard.js
  test/test-page-script-globals.js
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
  test/test-renderer-letterbox-input.js
  test/test-relative-mouse-input.js
  test/test-relative-mouse-clip-edge.js
  test/test-renderer-dialog-caption-drag.js
  test/test-renderer-shell-dialog.js
  test/test-renderer-multi-app-modal.js
  # Recovered 2026-08-24: these standalone tests were present but absent from
  # every tier. All pass as standalone Node entries; the Retina browser test
  # additionally needs an environment that permits binding a localhost server.
  test/test-debug-2d-scaling.js
  test/test-debug-dropdown-manifests.js
  test/test-delete-menu.js
  test/test-diablo-font-sheet.js
  test/test-directdraw-backbuffer-desc.js
  test/test-directdraw-palette-format.js
  test/test-directsound-play-cursor.js
  test/test-expand-environment-strings.js
  test/test-find-first-last-error.js
  test/test-font-render-history.js
  test/test-get-number-format.js
  test/test-getclassname-controls.js
  test/test-getclassname-superclass.js
  test/test-global-alloc-reuse.js
  test/test-is-char-alpha.js
  test/test-iswindow-validity.js
  test/test-lcmapstring-wat.js
  test/test-locale-info-wat.js
  test/test-listview-icon-mode.js
  test/test-lookup-icon-id.js
  test/test-map-view-of-file-ex.js
  test/test-openfile-create.js
  test/test-paint-desktop.js
  test/test-presentation-filter.js
  test/test-register-hotkey.js
  test/test-reg-set-value-wat.js
  test/test-retina-scale2x-web.js
  test/test-security-descriptor.js
  test/test-sh-change-notify.js
  test/test-shell-desktop-zorder.js
  test/test-shell-execute-launch.js
  test/test-shell-window.js
  test/test-sib-load8-handler.js
  test/test-thread-resource-sync.js
  test/test-vfs-persistence.js
  test/test-win16-winexec.js
  test/test-win32-dde-progman.js
  test/test-win98-scm-probe.js
  test/test-x86-16bit-upper-half.js
  # Recovered 2026-08-18: written, never listed here, so never run. All green
  # on the sweep that found them; see QUARANTINE for the ones that were not.
  test/test-aoe-span-trace-handler.js
  test/test-aoe-stack-packet-handler.js
  test/test-aoe-grid-fill-run.js
  test/test-aoe2-span-prefix.js
  test/test-clipboard-rtf-api.js
  test/test-coinitialize-ex.js
  test/test-commondialog-props.js
  test/test-critical-section-threading.js
  test/test-ddraw-surface-dirty-rect.js
  test/test-defer-window-pos-visibility.js
  test/test-delphi-seh-mutated-chain.js
  test/test-button-focus-notify.js
  test/test-def-dlg-proc.js
  test/test-dialog-setfocus-tabstop.js
  test/test-dialog-idok-handled.js
  test/test-isdialogmessage-enter.js
  test/test-dialog-custom-dispatch.js
  test/test-end-dialog-lifecycle.js
  test/test-modal-common-dialog-worker.js
  test/test-sendmessagetimeout.js
  test/test-directdraw-cooperative-window.js
  test/test-directdraw-enum-lowres.js
  test/test-directdraw-native-child-overlay.js
  test/test-directdraw-stale-background-restore.js
  test/test-directdraw-cursor-background-restore.js
  test/test-directdraw-create-ex.js
  test/test-directdraw-mode-change-primary.js
  test/test-directdraw-present-force.js
  test/test-directdraw-retained-primary.js
  test/test-directanimation-image-render.js
  test/test-directinput-device.js
  test/test-directinput8-create.js
  test/test-directx-ordinals.js
  test/test-launch-prefs-resolution.js
  test/test-d3dim-indexed-texture.js
  test/test-d3ddevice2-texture-format-desc.js
  test/test-d3dim-line-primitives.js
  test/test-d3dim-viewport-background-texture.js
  test/test-dx-blank-primary-holdover.js
  test/test-dx-present-window-placement.js
  test/test-dx-vtable-worker-sync.js
  test/test-disabled-dialog-controls.js
  test/test-duplicate-handle.js
  test/test-ext-text-out-wide.js
  test/test-gdi-exttextout-clipping.js
  test/test-gdi-transparent-blt.js
  test/test-gdi-scroll-window-rect.js
  test/test-rect-in-region.js
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
  test/test-renderer-worker-repaint-boundary.js
  test/test-worker-input-slice-wake.js
  test/test-richedit-stream-callback.js
  test/test-richedit-version-compat.js
  test/test-rtf-stylesheet.js
  test/test-shell-desktop-fallback.js
  test/test-solitaire-web.js
  test/test-sparse-width-boundary.js
  test/test-string-ops-sparse-boundary.js
  test/test-sparse-generated-code-cache.js
  test/test-surface.js
  test/test-system-metrics.js
  test/test-system-parameters-info-nonclient.js
  test/test-toolbar-insert.js
  test/test-treeview-scroll.js
  test/test-treeview-two-controls.js
  test/test-v86-reference-paint-workflows.js
  test/test-vfs-legacy-hfile.js
  test/test-virtual-map-cross-instance.js
  test/test-wat-drive-types.js
  test/test-wat-gdi-region-lazy-mirror.js
  test/test-wat-gdi-screen-readback.js
  test/test-wat-winsock-hostname.js
  test/test-window-control-id.js
  test/test-window-exstyle.js
  test/test-compile-wat-unknown-name.js
  test/test-gdi-public-seven.js
  test/test-combobox.js
  test/test-render-combobox.js
  test/test-win16-v86-audit.js
  # Repaired and recovered from quarantine 2026-08-24.
  test/test-winhelp-wat-parser.js
  test/test-wat-gdi-region.js
  test/test-wat-gdi-benchmark.js
  test/test-wat-gdi-bitmap-handlers.js
  test/test-wat-font-metrics-reference.js
  test/test-web-pinball-assets.js
  test/test-desktop-surface-color.js
  test/test-findreplace-matchcase-flags.js
  test/test-v86-reference-harness.js
  # Recovered 2026-08-29 by the build-level manifest gate. These are fast,
  # self-contained Node/WASM checks; local-payload and browser-driver tests are
  # listed in E2E below.
  test/test-baldurs-gate-compat-patches.js
  test/test-batch-clock.js
  test/test-browser-critical-section-yield.js
  test/test-browser-cooperative-crash-registers.js
  test/test-button-auto-check.js
  test/test-char-lower-w.js
  test/test-compare-file-time.js
  test/test-command-line-a-stability.js
  test/test-created-dialog-main-promotion.js
  test/test-cw-usedefault-adjusted.js
  test/test-d3d9-fixed-function-shaders.js
  test/test-d3d9-shader-unsupported.js
  test/test-d3d9-swap-chain.js
  test/test-destroy-main-window-recreation.js
  test/test-directdraw-surface3-desc.js
  test/test-directplay-lobby-address.js
  test/test-edit-unicode-text.js
  test/test-enum-display-devices-w.js
  test/test-enum-resource-names-a.js
  test/test-extract-icon-ex-w.js
  test/test-free-console.js
  test/test-gdiplus-flat-api.js
  test/test-get-ancestor.js
  test/test-get-clipboard-sequence-number.js
  test/test-get-computer-name-w.js
  test/test-get-cursor.js
  test/test-get-environment-variable-w.js
  test/test-get-system-directory-w.js
  test/test-getprocaddress-sparse-name.js
  test/test-heap-api-handles.js
  test/test-hidden-relative-mouse.js
  test/test-imm-is-ime.js
  test/test-is-debugger-present.js
  test/test-load-library-ex-w.js
  test/test-local-proprietary-demo-dropdown.js
  test/test-mcm-manifest-paths.js
  test/test-mem-utils-hidden-shared-buffer.js
  test/test-midi-out-long-msg.js
  test/test-msvcrt-ftol-native.js
  test/test-msi-query-product-state.js
  test/test-open-mutex-w.js
  test/test-process-environment-launch.js
  test/test-set-std-handle.js
  test/test-sh-get-folder-path-w.js
  test/test-shell-execute-ex-w.js
  test/test-showwindow-dialog-promotion.js
  test/test-system-enum-dispatch.js
  test/test-thread-manager-sparse-stack.js
  test/test-timer-message-pump.js
  test/test-to-unicode.js
  test/test-token-security.js
  test/test-toyvm-browser-bundle.js
  test/test-toyvm-live.js
  test/test-user-default-ui-language.js
  test/test-virtual-query-user-boundary.js
  test/test-wave-in-dev-caps.js
  test/test-wide-text-extent.js
  test/test-window-from-point.js
  test/test-fnstsw-test-jcc.js
  test/test-winsparkle-stubs.js
  test/test-worker-sparse-thread-stack.js
)

E2E=(
  test/test-win16-wep-gameplay.js
  test/test-win16-vb-gameplay.js
  test/test-win16-wep1-gameplay.js
  test/test-win16-wep2-gameplay.js
  test/test-win16-wep3-gameplay.js
  test/test-win16-wep4-gameplay.js
  test/test-win16-wep-class-menu.js
  test/test-win16-pipe-help.js
  test/test-win16-pipe-about.js
  test/test-win16-idlewild-handle-map.js
  test/test-worker-thread-stuck-detect.js
  test/test-tapi-line-init.js
  test/test-caesar3-fullscreen-metrics.js
  test/test-caesar3-gameplay.js
  test/test-abedemo-gameplay.js
  test/test-baldurs-gate-demos.js
  test/test-diablo-shareware-art.js
  test/test-diablo-shareware-gameplay.js
  test/test-heroes2-gameplay.js
  test/test-heroes3-demo-launch.js
  test/test-heroes3-demo-gameplay.js
  test/test-heroes3-demo-installer.js
  test/test-quake2-demo-installer.js
  test/test-quake2-demo-web.js
  test/test-quake2-gl-switch-web.js
  test/test-quake2-gl-web.js
  test/test-quake2-menu-keys-web.js
  test/test-quake2-input-web.js
  test/test-jazz2-demo-web.js
  test/test-diablo2-demo-installer.js
  test/test-diablo2-demo-installed.js
  test/test-diablo2-demo-gameplay.js
  test/test-half-life-uplink-installed.js
  test/test-half-life-uplink-web.js
  test/test-web-notepad-close-desktop.js
  test/test-web-keyboard-shift-cleared.js
  test/test-web-app-close-frees-memory.js
  test/test-web-failed-launch-recovers.js
  test/test-web-double-tap-single-launch.js
  test/test-web-touch-cursor.js
  test/test-web-record-audio.js
  test/test-web-audio-session.js
  test/test-web-ios-lab.js
  test/test-web-single-app-quit.js
  test/test-win16-jigsawed.js
  test/test-win16-jigsawed-menus.js
  test/test-win16-entertainment-manifests.js
  test/test-cli-vfs-include.js
  test/test-winhelp-reference.js
  test/test-taskman-tasks.js
  test/test-taskman-arrange.js
  test/test-taskman-web.js
  test/test-wordpad-web.js
  test/test-wordpad-thread-startup.js
  test/test-cli-worker-threads.js
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
  test/test-class-menu-from-dll.js
  test/test-listbox-ownerdraw.js
  test/test-les-flat.js
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
  test/test-explorer98-web.js
  test/test-local-candidate-desktop-web.js
  test/test-win16-web.js
  test/test-worker-guest.js
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
  test/test-cursor-icon-indirect.js
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
  test/test-aoe2-gameplay.js
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
  test/test-winamp-visualizers.js
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
  test/test-vlan-match.js
  test/test-combobox-pinball.js
  test/test-wm-setcursor-on-show.js
  test/test-wordpad-ole-roundtrip.js
  test/test-wordpad-ole-delete-roundtrip.js
  # Recovered 2026-08-29: browser drivers and local candidate/corpus runs.
  # Proprietary fixtures keep their own explicit SKIP path when absent.
  test/test-arena-dosbox.js
  test/test-beneath-scummvm.js
  test/test-daggerfall-dosbox.js
  test/test-deus-ex-demo.js
  test/test-dos-corpus-live-page.js
  test/test-fotaq-scummvm.js
  test/test-icewind-dale-demo.js
  test/test-icewind-dale-menu-web.js
  test/test-icewind-dale-persistence-web.js
  test/test-lure-scummvm.js
  test/test-mw3-gameplay.js
  test/test-shadow-warrior-dosbox.js
  test/test-ultima4-dosbox.js
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
QUARANTINE=(
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

# A test that never exits used to stall the whole suite indefinitely -- the
# runner polls for finished slots and has no notion of one taking too long, so
# a single hung child holds its slot forever and the summary never prints.
# Every child now gets a wall-clock cap and is reported as TIMEOUT, which
# counts as a failure -- a suite that stalls is a suite nobody waits for.
# The cap is deliberately far above what any test needs (the slowest gameplay
# test measures 8.5s) so it catches hangs, not slow machines.
TEST_TIMEOUT="${TEST_TIMEOUT:-300}"

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

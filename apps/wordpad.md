# WordPad (Win98) — PARTIAL

**Binary:** `test/binaries/win98-apps/wordpad.exe`  
**Status (2026-07-14):** PARTIAL.

WordPad opens and renders in the focused smoke:

```text
WordPad ... PASS  134 APIs, window created, 392 colors
```

Focused typing probe:

```text
click editor, type "hello world"
focus: RichEdit child hwnd=0x10002
result: PASS for basic text entry — "hello world" is inserted and visible in
        the RichEdit editor.
```

Current evidence from the 2026-07-14 follow-up probe:

- Mouse click now focuses the RichEdit child, so keyboard routing is no longer
  the blocker.
- `WM_CHAR` inserts through the native RichEdit path.
- The `32767 twips` RichEdit sentinel is clamped during the exact screen-DPI
  `MulDiv(32767, 96, 1440)` conversion, so text no longer paints at a large
  negative y coordinate.
- `ExtTextOutA/W` now honors `ETO_OPAQUE` rect fills, so RichEdit's erase bands
  clear to the DC background instead of leaving black memory-DC strips.
- Screenshot: `/private/tmp/wordpad-eto-opaque-hello.png` shows visible
  `hello world` text in the editor.

## Write Launcher

**Binary:** `test/binaries/win98-apps/write.exe`
**Status (2026-07-14):** PASS in the all-EXE smoke matrix.

The Win98 `write.exe` binary is only a compatibility launcher. It calls
`ShellExecuteA(..., "wordpad.exe", ...)` and exits cleanly without drawing its
own window, so the smoke harness validates the `ShellExecuteA` call and skips
the blank-canvas gate for this case.

## Threading Note

The older blocker was `ResumeThread` during OLE/COM initialization. The current
handler returns a previous suspend count and advances the stack, which is enough
for the WordPad startup smoke. Thread creation still does not fully model
`CREATE_SUSPENDED`; that is a fidelity issue, not a current WordPad startup
blocker.

## Follow-Up

1. Add true `CREATE_SUSPENDED` handling in `lib/thread-manager.js` if another
   app depends on threads staying suspended until `ResumeThread`.
2. Extend `$handle_ResumeThread` to call a host unsuspend import once the thread
   manager tracks suspend counts.
3. Expand WordPad coverage beyond basic insertion: selection, deletion, line
   wrapping, formatting changes, and save/load still need focused probes.

**Key files:** `lib/thread-manager.js`, `lib/renderer-input.js`,
`lib/host-imports.js`, `src/09a-handlers.wat`, `src/09a5-handlers-window.wat`

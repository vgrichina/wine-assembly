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
result: keyboard input reaches the native RichEdit wndproc, but the typed text
        paints offscreen after RichEdit scrolls to the bottom of a bogus
        ~4368px virtual document.
```

Current evidence from the 2026-07-14 probe:

- Mouse click now focuses the RichEdit child, so keyboard routing is no longer
  the blocker.
- `WM_CHAR` inserts through the native RichEdit path.
- RichEdit calls `ScrollWindowEx(hwnd=0x10002, dx=-195, dy=-4121, ...)` after
  the first character and later paints the glyph at approximately
  `ExtTextOutA(x=-182, y=-4121, "h")`, outside the visible edit surface.
- Screenshot: `/private/tmp/wordpad-hello-final-status.png` shows the editor
  still blank after typing.

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
3. Fix native RichEdit layout/scroll state so a single typed line stays at the
   top of the visible client area instead of scrolling to the bottom of the
   default virtual document.

**Key files:** `lib/thread-manager.js`, `lib/renderer-input.js`,
`src/09a-handlers.wat`, `src/09a5-handlers-window.wat`

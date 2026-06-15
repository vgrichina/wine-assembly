# WordPad (Win98) — PASS

**Binary:** `test/binaries/win98-apps/wordpad.exe`  
**Status (2026-06-14):** PASS in the all-EXE smoke matrix.

WordPad now opens and renders in the focused smoke:

```text
WordPad ... PASS  134 APIs, window created, 392 colors
```

## Write Launcher

**Binary:** `test/binaries/win98-apps/write.exe`
**Status (2026-06-14):** PASS in the all-EXE smoke matrix.

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

**Key files:** `lib/thread-manager.js`, `src/09a-handlers.wat`

# WordPad (Win98) — FAIL

**Binary:** `test/binaries/win98-apps/wordpad.exe`  
**Crash:** `ResumeThread` unimplemented (calls `$crash_unimplemented`)

## Write Launcher

**Binary:** `test/binaries/win98-apps/write.exe`
**Status (2026-06-14):** PASS in the all-EXE smoke matrix.

The Win98 `write.exe` binary is only a compatibility launcher. It calls
`ShellExecuteA(..., "wordpad.exe", ...)` and exits cleanly without drawing its
own window, so the smoke harness validates the `ShellExecuteA` call and skips
the blank-canvas gate for this case.

## Root Cause

WordPad creates a suspended thread during OLE/COM initialization, then calls `ResumeThread` to start it. The emulator has `CreateThread` support but no `CREATE_SUSPENDED` flag handling or `ResumeThread`.

## Fix Needed

1. In `lib/thread-manager.js`: support `CREATE_SUSPENDED` flag (dwCreationFlags bit 2) — create thread but don't run it until `ResumeThread`
2. Implement `$handle_ResumeThread` in WAT: call host import to unsuspend the thread
3. Add `resume_thread` host import

**Key files:** `lib/thread-manager.js`, `src/09a-handlers.wat`

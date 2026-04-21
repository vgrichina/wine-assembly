# MSPaint Win98 (test/binaries/mspaint.exe)

## Status: WARN-BLANK — runs cleanly, client area still empty (no chrome/menu/toolbar)

**Binary:** `test/binaries/mspaint.exe` (344064 bytes — ANSI Win98 build)

## Previous Bug: Stack Leak in Message Loop (FIXED)

App was doing ~34,000 "ghost" DefWindowProcA calls in the idle loop. ESP climbed out
of the guest stack region at ~20 bytes/call.

**Root cause:** the EIP-in-thunk-zone dispatch path in `$run` (src/13-exports.wat) never
set EIP after running a normal API handler. Handlers do `esp += 4 + nargs*4` (pop ret +
stdcall args) but never touch EIP — the caller (`$th_call_ind`) normally sets EIP from
the saved `$op`. When `$handle_DispatchMessageA` redirected EIP to a thunk (because the
resolved wndproc itself lives in the thunk zone, e.g. MFC's AfxWndProc thunked via the
import table at 0x04e03530), the main loop re-entered the thunk every pass, running the
handler again and again, each pass popping 20 bytes off ESP.

**Fix:** save `prev_eip` before calling `$win32_dispatch`; if the handler didn't change
EIP, pop `[prev_esp]` as the new EIP — mirroring what `$th_call_ind` does for CALL-to-thunk.
See 13-exports.wat at the thunk-zone dispatch check.

After the fix: idle loop settles at ESP=0x04bfff1c with a clean PeekMessageA/GetMessageA/
TlsGetValue cycle. 10k API calls in 200 batches vs. 38k in 200 batches before, and none
of them are phantom DefWindowProcA.

## Remaining Issue: Blank Client Area

App boots, creates window with "Paint" title (275x400) and one full-client child hwnd
(269x373). PNG shows the gray back-canvas but no menu bar, toolbar, status bar, tool
palette, or color palette.

At 200 batches the idle loop is established and nothing new paints. Next diagnostic
steps (low priority — app isn't crashing):

1. `--trace-gdi` to see whether any drawing primitives are being called into the child's
   back-canvas during startup.
2. `--trace-dc` to confirm DC resolution lands on the right canvas (child vs main).
3. Compare with what NCPAINT / WM_PAINT traffic the notepad Win98 binary generates —
   MFC may be waiting on a state flag that never gets set during our startup chain.
4. Check whether MSPaint creates a toolbar via `CreateToolbarEx` / manual CreateWindowEx
   and whether those children actually get registered + painted.

## NT Variant — Unrelated, Different Failure

The NT build fails much earlier at MFC42U's DllMain (Win9x platform check). See
`apps/mspaint-nt.md`.

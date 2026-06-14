# MSPaint (NT) - PARTIAL

**Binary:** `test/binaries/nt/mspaint.exe` (also at
`test/binaries/entertainment-pack/mspaint.exe`; identical 447248 bytes)
**DLLs:** `msvcrt.dll`, `mfc42u.dll`

## Status (2026-06-13)

The old startup blockers are fixed. Runners now auto-report NT 4.0 when an EXE
imports `MFC42U.DLL`, so MFC42U's `DllMain` no longer rejects the process as a
Win9x host. MSPaint NT also gets through the first Unicode/MFC setup path by
using real handlers for:

- `RegisterWindowMessageW`
- `CreateFontIndirectW`
- `SetWindowsHookExW` for `WH_CBT`
- `CallWindowProcW`
- `SetWindowTextW` title/control state parity with the ANSI path
- `LoadBitmapW`
- `GetTextExtentPointW`
- `GetTextExtentPoint32W`
- `GetObjectW`

The old Node/V8 heap OOM is also fixed. MSPaint NT passes a 24bpp
`BITMAPINFOHEADER` with a bogus non-zero `biClrUsed`; high-bpp BI_RGB DIBs do
not have color tables, so the host now caps/ignores DIB palettes unless the
format is indexed.

Current focused run:

```sh
node test/run.js --exe=test/binaries/nt/mspaint.exe --max-batches=420 --batch-size=1000 --no-close --quiet-api --quiet-blocks --no-build --png=/private/tmp/mspaint-nt-getobjectw.png
```

Result: MFC42U and MSVCRT `DllMain` both return success, the app reaches the
main frame (`hwnd=0x10001`, title `"Untitled - Paint"`), creates the image child
and common-control child windows, and writes a visible 640x480 PNG. The standard
`test/test-all-exes.js` smoke matrix now reports `MSPaint (NT)` and `MSPaint
(EP)` as `PASS`.

## Current Blocker

The longer focused run still trips the harness stuck detector after visible UI
startup, with the last reported `EIP=0x010713a6`. It is no longer an
unimplemented API or heap OOM. The visible output shows the NT MSPaint frame,
menu bar, and gray client area; the remaining work is to inspect that MFC42U
path and determine whether it is a normal idle/message wait pattern, an
over-aggressive stuck detector, or a real missing message/control behavior.

Important detail: MFC chains to a saved previous wndproc through
`CallWindowProcW`; in this run the saved proc is the import thunk for
`DefWindowProcW` (`0x08103618`, API id 99). `CallWindowProcA/W` now handle
default-proc thunks directly and leave ESP as a normal `CallWindowProc` return.

## Previous Blockers

MFC42U's `DllMain` checks `GetVersion()` and refuses to initialize on anything
other than Windows NT. The emulator used to report `$winver = 0xC0000A04`
(Win98 SE, high bit set), so the DLL showed:

> "This application or DLL can not be loaded on Windows 95 or on Windows 3.1."

and returned 0 from `DllMain`. The process then limped into CRT/MFC setup and
threw `CMemoryException` through `_CxxThrowException`.

The next blocker after that was a bad virtual call to `0x0110d4fe` inside
relocated MFC42U `.rdata`. That was caused by skipping MFC's Unicode `WH_CBT`
attach hook; recording `SetWindowsHookExW(WH_CBT, ...)` lets the hook attach
the `CWnd` before `WM_CREATE`, moving execution past that point.

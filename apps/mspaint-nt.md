# MSPaint (NT) - PARTIAL

**Binary:** `test/binaries/nt/mspaint.exe` (also at
`test/binaries/entertainment-pack/mspaint.exe`; identical 447248 bytes)
**DLLs:** `msvcrt.dll`, `mfc42u.dll`

## Status (2026-06-13)

The old startup blocker is fixed. Runners now auto-report NT 4.0 when an EXE
imports `MFC42U.DLL`, so MFC42U's `DllMain` no longer rejects the process as a
Win9x host. MSPaint NT also gets past the first missing Unicode APIs by using
real handlers for:

- `RegisterWindowMessageW`
- `CreateFontIndirectW`
- `SetWindowsHookExW` for `WH_CBT`
- `CallWindowProcW`

Current focused run:

```sh
node test/run.js --exe=test/binaries/nt/mspaint.exe --max-batches=40 --batch-size=1000 --no-close --quiet-api --quiet-blocks --no-build --png=/private/tmp/mspaint-nt-defproc-special.png
```

Result: MFC42U and MSVCRT `DllMain` both return success, the app reaches main
window creation (`hwnd=0x10001`, title `"Paint"`, size `275x400`) and creates
the first child window (`hwnd=0x10002`) after MFC's Unicode CBT hook attaches.
The old `EIP=0x0110d4fe` jump into MFC42U `.rdata` is no longer the first
failure.

## Current Blocker

After child creation and two `SetWindowText("P")` calls, the run enters a long
synchronous path that grows the Node/V8 heap until the host process OOMs. This
happens even with `--quiet-api`, so it is not console-output pressure.

The next useful work is to bound that path with hit counters or a targeted
breakpoint around the post-child-create MFC window/message flow and find the
repeated EIP or translated-code growth source.

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

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

Current focused run:

```sh
node test/run.js --exe=test/binaries/nt/mspaint.exe --max-batches=150 --batch-size=50000 --no-close --quiet-blocks --no-build --png=/private/tmp/mspaint-nt-auto-2.png
```

Result: MFC42U and MSVCRT `DllMain` both return success, the app reaches main
window creation (`hwnd=0x10001`, title `"P"`, size `275x400`), then stalls
before the window becomes visible.

## Current Blocker

Execution stops at `EIP=0x0110d4fe`, which is inside relocated MFC42U `.rdata`,
not executable code. The immediate bad call is an MFC virtual dispatch through a
heap-looking object:

- `ECX=0x011b157c`
- `[ECX]=0x011b1438`
- `[0x011b1438 + 0xa0] = 0x0110d4fe`

That means MFC is treating a structure as an object/vtable and jumping into data.
The next useful work is to trace the Unicode window/message path that feeds this
object into the MFC wrapper. The likely suspects are stale `CreateWindowExW`
behavior versus the richer ANSI path, or a `SendMessageW`/window-map mismatch
around MFC `CWnd` lookup.

## Previous Blocker

MFC42U's `DllMain` checks `GetVersion()` and refuses to initialize on anything
other than Windows NT. The emulator used to report `$winver = 0xC0000A04`
(Win98 SE, high bit set), so the DLL showed:

> "This application or DLL can not be loaded on Windows 95 or on Windows 3.1."

and returned 0 from `DllMain`. The process then limped into CRT/MFC setup and
threw `CMemoryException` through `_CxxThrowException`. This is no longer the
first failure for MFC42U apps.

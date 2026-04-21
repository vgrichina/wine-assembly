# MSPaint (NT) — FAIL

**Binary:** `test/binaries/nt/mspaint.exe` (also at `test/binaries/entertainment-pack/mspaint.exe` — identical 447248 bytes)
**DLLs:** msvcrt.dll, mfc42u.dll
**Crash:** unhandled C++ exception (`CMemoryException`) → EIP=0

## Root Cause

MFC42U's `DllMain` checks `GetVersion()` and refuses to initialize on anything other than Windows NT. Our emulator reports `$winver = 0xC0000A04` (Win98 SE — high bit set → Win9x platform), so the DLL throws up a MessageBox:

> "MFC Runtime Module": "This application or DLL can not be loaded on Windows 95 or on Windows 3.1. It takes advantage of Unicode features only available on Windows NT."

and returns 0 from `DllMain` (verified in verbose run: `DllMain returned, EAX=0x0`). The process continues anyway, limps through CRT init, then during MFC per-thread-state setup a follow-on alloc fails and MFC throws `CMemoryException` via `_CxxThrowException`. No SEH catches it; EIP lands at 0.

Trace sequence reaching the throw:
1. `GetDC(NULL)` + TLS probes
2. `HeapAlloc(0x140000, 0, 0x50)` → TLS
3. `EnterCriticalSection(0x011412c0)` → `HeapAlloc(0x140000, 0, 0x10)` → `LeaveCriticalSection`
4. `AfxThrowMemoryException` → `RaiseException(0xe06d7363, ..., throwInfo)` with TypeDescriptors `CMemoryException` / `CSimpleException` / `CException` / `CObject`.

The caller of `AfxThrowMemoryException` (ret = `0x0116c6ff`) lives inside the MFC42U image, not in mspaint.exe's sections (confirm: `tools/find_fn.js` rejects it as "VA not in any section").

## Fix Sketch

**Primary fix — report NT:** Add per-app winver override so MSPaint (and any other MFC42U-using NT binary) sees `GetVersion() == 0x00000A04` (bit 31 clear → NT 4.0) instead of the Win9x default. The `set_winver` WAT export is already plumbed; needs a host-side call gated by binary detection (e.g. IMPORT DLL list contains `MFC42U.DLL`).

Globally flipping to NT would regress Win9x-targeted apps that branch on `GetVersion()`, so this must be per-exe.

**Out of scope for now:** actually finishing SEH catch-dispatch so C++ throw→catch would unwind cleanly. Explorer (98) has the same underlying gap — see `explorer98.md`.

## Verification

Run with `--trace-api` — stops at API #287 with `RaiseException` carrying the `CMemoryException` vtable. No window is ever created.

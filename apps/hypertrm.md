# HyperTerminal — FAIL

**Binary:** `test/binaries/win98-apps/hypertrm.exe`  
**Crash:** Unresolved DLL export `InitInstance`

## Root Cause

HyperTerminal requires companion DLLs (hticons.dll and possibly others) that export `InitInstance`. These DLLs are not available in `test/binaries/dlls/`.

## Fix Needed

Low priority — requires proprietary companion DLLs. Either source the DLLs or create stubs.

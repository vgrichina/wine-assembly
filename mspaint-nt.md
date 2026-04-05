# MSPaint (NT) — FAIL

**Binary:** `test/binaries/nt/mspaint.exe`  
**DLLs:** msvcrt.dll, mfc42u.dll  
**Crash:** `RaiseException` → `unreachable`

## Root Cause

MFC application. During MFC/COM initialization, C++ exception handling uses `RaiseException`. Same issue as Explorer (98) — SEH dispatch not implemented.

## Fix Needed

Same as Explorer (98): implement `RaiseException` → SEH chain walk → handler dispatch.

**Key files:** `src/11-seh.wat`, `src/09a-handlers.wat`  
**See also:** `explorer98.md`

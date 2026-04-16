# Kodak Imaging — FAIL

**Binary:** `test/binaries/win98-apps/kodakimg.exe`  
**Crash:** Unresolved C++ mangled export `?UpdateVersion@@YGJH@Z`

## Root Cause

Requires proprietary Kodak/Wang imaging DLLs (oiui400.dll, oifil400.dll, etc.). These export C++ mangled names that can't be resolved.

## Fix Needed

Low priority — proprietary DLL dependencies not available.

# Win98 Tour (tour98.exe) — Win98

**Status:** FAIL (infinite TlsGetValue loop)

## Behavior
Loads comctl32.dll successfully (DllMain returns 1), then enters an infinite TlsGetValue loop. The app never progresses past this point.

## DLL Dependencies
- COMCTL32.dll ✓ (loaded, DllMain succeeds)
- KERNEL32.dll, USER32.dll, GDI32.dll, ADVAPI32.dll ✓
- comdlg32.dll, WINSPOOL.DRV, SHELL32.dll, COMCTL32.dll ✓

## Blocking Issue
After comctl32.dll DllMain returns, the app enters a loop calling TlsGetValue repeatedly. TlsGetValue is implemented but may be returning wrong values. The app might be:
1. Waiting for TLS data set by DllMain that wasn't properly stored
2. Spinning on a TLS-based lock or initialization flag
3. comctl32.dll DllMain may have set TLS values that our TlsSetValue didn't persist correctly

## What's Needed
- Debug TlsGetValue/TlsSetValue to verify values are correctly stored and retrieved
- Check if comctl32.dll's DllMain correctly initializes TLS slots
- May need to trace TlsAlloc → TlsSetValue → TlsGetValue sequence during DllMain

## Difficulty: Medium (TLS debugging)

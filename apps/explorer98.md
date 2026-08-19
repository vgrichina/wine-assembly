# Explorer (Win98) — FAIL

**Binary:** `test/binaries/win98-apps/explorer.exe`  
**Crash:** `RaiseException(0x6d007f, 0, 1, ...)` → `unreachable`

## API Trace (last 4)

```
#191 InterlockedExchange(0x415528, 0x400000)
#192 GetProcAddress(0x400000, ordinal 0xf4)
#193 GetLastError()
#194 RaiseException(0x6d007f, 0, 1, ...)
```

## Root Cause

Explorer calls `GetProcAddress` for ordinal 0xf4 from itself (hModule=0x400000). This fails, then it raises a structured exception. The exception code 0x6d007f doesn't match standard C++ exception codes — it may be a custom exception or a delayed-load import failure (FACILITY_VISUALCPP exception).

The `$handle_RaiseException` in `src/09a-handlers.wat` calls `$crash_unimplemented`.

## Fix Needed

Implement SEH dispatch: walk FS:[0] exception handler chain, set up EXCEPTION_RECORD and CONTEXT, call the handler. If handler returns EXCEPTION_CONTINUE_EXECUTION, resume. If EXCEPTION_CONTINUE_SEARCH, try next handler.

Same fix needed for MSPaint (NT).

**Key files:** `src/11-seh.wat`, `src/09a-handlers.wat` (`$handle_RaiseException`)

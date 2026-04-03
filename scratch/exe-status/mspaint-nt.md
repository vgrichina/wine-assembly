# MSPaint NT (test/binaries/nt/mspaint.exe)

## Status: FAIL (crash)

## Crash Point
Crashes on API #337: RaiseException(0xe06d7363, 0x00000001, 0x00000003, 0x02bffc40)
- Exception code 0xe06d7363 = MSVC C++ exception ("msc" in ASCII)
- EIP at crash: 0x0116b6cb

## API Call Sequence Leading to Crash
1. GetDC(0x00000000) -- get screen DC
2. Several TlsGetValue calls (MFC thread-local storage)
3. EnterCriticalSection / LeaveCriticalSection pairs
4. More TlsGetValue calls
5. EnterCriticalSection(0x011402c0) -- enters a critical section
6. EnterCriticalSection / LeaveCriticalSection (nested)
7. LeaveCriticalSection(0x011402c0)
8. **RaiseException(0xe06d7363, ...)** -- C++ throw, crashes

Only 337 API calls before crash (batch 5). The app throws a C++ exception very early during initialization.

## What Needs to Be Implemented
1. **RaiseException** -- needs real SEH (Structured Exception Handling) support to unwind the C++ exception
2. The exception is likely thrown because some initialization failed (possibly GetDC returning wrong value, or a resource not found)
3. The NT MSPaint uses MFC42u.dll (Unicode MFC) which requires msvcrt.dll -- the C++ exception infrastructure in SEH must properly handle `_CxxThrowException`

## Stack Context
- 0xe06d7363 exception with 3 parameters, typical MSVC `throw` pattern
- Parameter at 0x02bffc40 contains 0x19930520 (MSVC exception signature)

## Difficulty: Hard
Requires full C++ exception handling via SEH, including `_CxxThrowException` unwinding through MFC frames. This is one of the most complex Win32 subsystems to emulate. Alternatively, the root cause (why the exception is thrown) could be fixed, but that requires understanding MFC initialization deeply.

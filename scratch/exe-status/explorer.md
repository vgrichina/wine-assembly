# Explorer (explorer.exe) — Win98

**Status:** FAIL (crashes on RaiseException early)

## Behavior
Crashes very early (batch 0, ~194 API calls) with RaiseException(0x006d007f). The exception code 0x006d007f doesn't match known patterns (not C++ exception 0xe06d7363). May be a Delphi or custom exception.

## DLL Dependencies
- ADVAPI32.dll, KERNEL32.dll, GDI32.dll, USER32.dll ✓
- SHLWAPI.dll ✓ (available)
- COMCTL32.dll ✓ (available)

## Blocking Issue
RaiseException is a crash stub. Explorer needs SEH (Structured Exception Handling) to catch exceptions and continue. Without SEH support, any RaiseException is fatal.

## What's Needed
- Full SEH implementation (walk exception handler chain, call handlers)
- This is a fundamental infrastructure need that affects MSPaint NT and other apps too

## Difficulty: Hard (SEH infrastructure)

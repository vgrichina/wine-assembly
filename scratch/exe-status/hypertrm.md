# HyperTerminal (hypertrm.exe) — Win98

**Status:** FAIL (crashes on InitInstance)

## Behavior
Loads msvcrt.dll, then tries to call `InitInstance` which is imported from **HYPERTRM.dll** — a companion DLL that contains all the actual HyperTerminal logic. The EXE is just a thin launcher.

## DLL Dependencies
- msvcrt.dll ✓ (loaded)
- **HYPERTRM.dll** ✗ (missing — contains InitInstance, main app logic)
- KERNEL32.dll ✓ (emulated)

## Blocking Issue
Missing HYPERTRM.dll. The EXE is useless without it.

## What's Needed
1. Obtain HYPERTRM.dll from Win98 system files
2. Place in test/binaries/dlls/

## Difficulty: Easy (just need the DLL file)

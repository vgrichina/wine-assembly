# Write (write.exe) — Win98

**Status:** WARN (31 APIs, no window, no crash)

## Behavior
Stuck in MFC CriticalSection initialization loop. Gets through 100+ API calls but never creates a window — endless Enter/LeaveCriticalSection cycling during MFC class factory registration.

## DLL Dependencies
Uses MFC (same as WordPad). write.exe IS WordPad (same binary, different name on Win98).

## Blocking Issue
MFC init creates multiple CriticalSection objects in a loop that never terminates. Likely the same underlying issue as WordPad — MFC's thread initialization path spins when certain thread-local storage or COM init isn't available.

## What's Needed
- Fix MFC CriticalSection init loop (same fix applies to WordPad, XP End of Life, and other MFC apps)
- May need OLE/COM initialization (CoInitialize) to succeed before MFC can proceed

## Difficulty: Hard (MFC/COM infrastructure)

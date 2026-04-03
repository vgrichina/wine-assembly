# IP Config (winipcfg.exe) — Win98

**Status:** WARN (147 APIs, no window)

## Behavior
Stuck in MFC CriticalSection initialization loop, same pattern as write.exe. Endlessly cycling Enter/LeaveCriticalSection + InitializeCriticalSection.

## Last APIs
InitializeCriticalSection → LeaveCriticalSection → EnterCriticalSection (repeating)

## Blocking Issue
Same MFC init loop as write.exe, xp_eos, sndrec32.

## What's Needed
- Fix MFC CriticalSection init loop

## Difficulty: Hard (MFC infrastructure)

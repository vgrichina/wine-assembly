# Sound Recorder (sndrec32.exe) — Win98

**Status:** WARN (151 APIs, no window)

## Behavior
Gets through CRT init (VirtualAlloc, heap setup), then stalls during environment/locale processing. Last call is GetEnvironmentStrings — likely stuck in MFC/CRT locale init loop.

## Last APIs
VirtualAlloc x2, then GetEnvironmentStrings — doesn't proceed further.

## Blocking Issue
CRT init doesn't complete — likely same MFC CriticalSection loop issue as write.exe and other MFC apps.

## What's Needed
- Fix the MFC/CRT init loop issue (shared with write.exe, xp_eos, etc.)

## Difficulty: Hard (MFC/CRT infrastructure)

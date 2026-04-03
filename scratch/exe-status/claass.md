# claass.exe (Calculator XP) - XP

**Status:** FAIL
**Crashes on:** UnhookWindowsHook (not Ex variant)
**Batch reached:** 3

## Crash Details

The app's CRT init succeeds (via msvcrt.dll), then it starts its WinMain. It calls `SetWindowsHookW`, checks for audio devices (waveOutGetNumDevs, mixerGetLineInfoW, mixerGetID, mixerGetNumDevs), fails to find any, loads an error string, shows a MessageBoxW, then tries to clean up with `UnhookWindowsHook(-1, 0x01002e54)` and crashes.

Note: there is an earlier `FATAL: implement this API` crash (batch 0) during CRT init that is somehow recovered from. The terminal crash is at batch 3.

EIP at crash: `0x0100456a` -- cleanup path after MessageBoxW.

The API `UnhookWindowsHook` (USER32.dll, the older non-Ex version) is NOT in api_table.json. Only `UnhookWindowsHookEx` exists (id 707). The dispatch table has no handler for UnhookWindowsHook.

## API Call Sequence (190 calls before crash)

Key APIs:
- msvcrt CRT init (HeapAlloc, GetVersionExA, etc.)
- GetStartupInfoA, GetModuleHandleA
- LoadStringW, SetWindowsHookW(-1, 0x01002e54)
- RegOpenKeyExW (HKCU)
- waveOutGetNumDevs, waveOutMessage, mixerGetID
- mixerGetLineInfoW x3, mixerGetNumDevs
- LoadStringW x2 (error message strings)
- MessageBoxW (shows "no audio device" error)
- **UnhookWindowsHook(-1, 0x01002e54)** -- CRASH

## What Needs to Be Implemented

1. `UnhookWindowsHook` -- the legacy (non-Ex) hook removal API. Takes hook type and hook proc, returns BOOL. Simple stub returning TRUE would suffice since hooks are not actually installed.
2. The earlier CRT init crash should also be investigated (some unnamed API during msvcrt init).

## Difficulty: Easy

UnhookWindowsHook is a trivial wrapper -- just return 1 (TRUE). The real problem is that the app thinks there's no audio and shows an error. Fixing mixer APIs to report fake audio devices would be medium difficulty but isn't needed to get past the crash.

# CD Player (cdplayer.exe) — Win98

**Status:** WARN (153 APIs, no window, exits with code -1)

## Behavior
Initializes, loads resources, checks for CD-ROM drives via MCI APIs, fails to find any, calls ExitProcess(-1). Clean exit — not a crash, just no hardware.

## Last APIs
LocalFree x2 cleanup, then ExitProcess(0xffffffff)

## Blocking Issue
No CD-ROM drive emulation. App exits immediately when it can't find a CD drive.

## What's Needed
- MCI device emulation (mciSendCommand for CD audio) — or at minimum, fake a CD drive presence so the app gets past init and shows its window
- The app may also need mcicda.dll (MCI CD audio driver)

## Difficulty: Hard (MCI subsystem)

# Volume Control (sndvol32.exe) — Win98

**Status:** WARN (163 APIs, no window, exits cleanly)

## Behavior
Initializes, calls waveOutMessage/mixerGetID to probe audio hardware, finds no mixer devices (MMSYSERR_NODRIVER), calls ExitProcess(0). Clean exit.

## Last APIs
waveOutMessage(0, 0x805, 0, 0) → mixerGetID(0, ..., 0x10000000) → ExitProcess(0)

## Blocking Issue
No audio mixer hardware. The app requires at least one mixer device to display its volume controls.

## What's Needed
- Fake mixer device that reports at least one audio line (master volume)
- mixerGetDevCaps, mixerGetLineInfo, mixerGetLineControls, mixerGetControlDetails need to return plausible data

## Difficulty: Medium (audio mixer emulation)
## Notes
vol98.exe has the exact same behavior and blocking issue.

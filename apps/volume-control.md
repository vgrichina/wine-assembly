# Volume Control — PASS

**Binaries:**

- `test/binaries/win98-apps/sndvol32.exe`
- `test/binaries/win98-apps/vol98.exe`
- `test/binaries/xp/claass.exe`

**Status (2026-06-14):** PASS in focused all-EXE smokes.

The Win98 volume-control binaries now render visible mixer UI with the fake
WINMM mixer surface:

```text
Volume Control ... PASS  104 APIs, window created, 143 colors
Volume (98)    ... PASS  104 APIs, window created, 143 colors
```

The XP `claass.exe` binary is also `sndvol32` rather than Calculator. It now
reaches its dialog and renders after the same mixer surface plus small
SetupAPI/device-notification failure stubs:

```text
Volume Control (XP) ... PASS  122 APIs, window created, 202 colors
```

## Implemented Surface

- `mixerGetNumDevs`, `mixerGetID`, `mixerOpen`, `mixerClose`, `mixerMessage`
- `mixerGetDevCapsA/W`, `mixerGetLineInfoA/W`
- `mixerGetLineControlsA/W`, `mixerGetControlDetailsA/W`
- `mixerSetControlDetails`
- `waveOutGetDevCapsW`
- optional XP device-notification probes fail cleanly:
  `SetupDiCreateDeviceInfoList`, `SetupDiDestroyDeviceInfoList`,
  `SetupDiGetDeviceInterfaceDetailW`, `SetupDiOpenDevRegKey`,
  `SetupDiOpenDeviceInterfaceW`, `RegisterDeviceNotificationW`,
  `UnregisterDeviceNotification`
- `MapDialogRect` and `IsDialogMessageW` are now handled for the XP dialog path.

## Limitations

The mixer is enumeration/control plumbing only. It exposes one wave-out volume
control with fixed full-volume details; it does not yet connect slider changes
to host audio gain.

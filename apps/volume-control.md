# Volume Control — PASS

**Binaries:**

- `test/binaries/win98-apps/sndvol32.exe`
- `test/binaries/win98-apps/vol98.exe`
- `test/binaries/xp/claass.exe`

**Status (2026-08-11):** PASS with functional master, Wave, and MIDI buses.

The Win98 volume-control binaries render a three-strip mixer backed by Web
Audio gain nodes. Master volume composes with independent Wave and MIDI gains,
and each strip has a preserving mute toggle.

```text
Volume Control ... PASS  111 APIs, window created, 466 colors
Volume (98)    ... PASS  111 APIs, window created, 466 colors
```

The XP `claass.exe` binary is also `sndvol32` rather than Calculator. It now
reaches its dialog and renders after the same mixer surface plus small
SetupAPI/device-notification failure stubs:

```text
Volume Control (XP) ... PASS  126 APIs, window created, 476 colors
```

## Implemented Surface

- `mixerGetNumDevs`, `mixerGetID`, `mixerOpen`, `mixerClose`, `mixerMessage`
- `mixerGetDevCapsA/W`, `mixerGetLineInfoA/W`
- `mixerGetLineControlsA/W`, `mixerGetControlDetailsA/W`
- `mixerSetControlDetails`
- speaker destination plus Wave and MIDI source-line enumeration
- stereo unsigned volume and uniform Boolean mute controls per line
- functional horizontal/vertical trackbar mouse capture and scroll messages
- shared Web Audio master, Wave, and MIDI gain buses
- `waveOutGetDevCapsW`
- optional XP device-notification probes fail cleanly:
  `SetupDiCreateDeviceInfoList`, `SetupDiDestroyDeviceInfoList`,
  `SetupDiGetDeviceInterfaceDetailW`, `SetupDiOpenDevRegKey`,
  `SetupDiOpenDeviceInterfaceW`, `RegisterDeviceNotificationW`,
  `UnregisterDeviceNotification`
- `MapDialogRect` and `IsDialogMessageW` are now handled for the XP dialog path.

## Verification

- `test/test-audio-mixer.js` validates bus routing, independent gain, mute
  restoration, and shared state.
- `test/test-volume-control-audio.js` drives the native Win98 UI, changes all
  three volume sliders, toggles Wave mute twice, and checks three screenshots.

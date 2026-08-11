# Sound Recorder — PASS

**Binaries:**

- `test/binaries/win98-apps/sndrec32.exe`
- `test/binaries/xp/sndrec32.exe`

**Status (2026-08-11):** Functional capture and playback in focused CLI tests.

Both Sound Recorder binaries now create and render the main recorder dialog:

```text
Sound Recorder      ... PASS  107 APIs, window created, 498 colors
Sound Recorder (XP) ... PASS  119 APIs, window created, 498 colors
```

## Implemented Surface

- `waveInOpen` now creates a real capture device for PCM formats, while
  `WAVE_FORMAT_QUERY` remains permission-free.
- `waveInPrepareHeader`, `waveInAddBuffer`, stop/reset, and unprepare maintain
  native `WAVEHDR` flags and byte counts.
- Browser capture uses `getUserMedia`, converts Web Audio float samples to the
  requested 8/16-bit mono/stereo PCM format, and resamples into guest buffers.
- `CALLBACK_WINDOW` delivers `MM_WIM_OPEN`, `MM_WIM_DATA`, and `MM_WIM_CLOSE`;
  Sound Recorder consumes and requeues those buffers normally.
- Recorded PCM plays through the existing asynchronous waveOut bridge.

- `CreateDialogParamW` now reuses the A dialog path, so W dialogs get the same
  WAT-side registration, top-level auto-show, and seeded paint behavior.
- `GetPropW`, `SetPropW`, and `RemovePropW` share the lightweight USER32
  property table with the A variants.
- `SetClassLongW` and `GetClassLongW` route to the existing scalar class-long
  behavior.
- `CharPrevW` handles simple UTF-16 backward string walking.

## Verification

```sh
node test/test-wavein-audio.js
node test/test-sound-recorder-audio.js
```

The end-to-end test records deterministic 440 Hz PCM through the real Win98
Sound Recorder controls, stops, plays it, verifies non-silent output, and saves
before/after screenshots under `scratch/sound-recorder-audio/`.

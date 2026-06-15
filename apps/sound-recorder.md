# Sound Recorder — PASS

**Binaries:**

- `test/binaries/win98-apps/sndrec32.exe`
- `test/binaries/xp/sndrec32.exe`

**Status (2026-06-14):** PASS in focused all-EXE smokes.

Both Sound Recorder binaries now create and render the main recorder dialog:

```text
Sound Recorder      ... PASS  107 APIs, window created, 498 colors
Sound Recorder (XP) ... PASS  119 APIs, window created, 498 colors
```

## Implemented Surface

- `CreateDialogParamW` now reuses the A dialog path, so W dialogs get the same
  WAT-side registration, top-level auto-show, and seeded paint behavior.
- `GetPropW`, `SetPropW`, and `RemovePropW` share the lightweight USER32
  property table with the A variants.
- `SetClassLongW` and `GetClassLongW` route to the existing scalar class-long
  behavior.
- `CharPrevW` handles simple UTF-16 backward string walking.

## Limitations

Audio capture/playback is still stub-level. The recorder reaches visible UI and
survives its `waveInOpen`/`waveOutOpen` probes, but it does not record or play
real waveform data yet.

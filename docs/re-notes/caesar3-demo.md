# Caesar III demo

## Payload

The playable payload is produced by the original Sierra/Impressions demo
installer chain documented in `sources.md`:

```text
caesar3.exe (ZipMagic wrapper)
  -> setup.exe (Win16 bootstrap)
  -> _ins5176._mp (InstallShield engine)
  -> installed/c3.exe + SMACKW32.DLL + 112 data/audio files
```

The launcher mounts that installed tree through the `caesar3_demo` manifest.
It does not substitute files extracted outside the installer workflow.

## Name entry

The demo copies `The new governor` into its 32-byte player-name buffer at
`0x57eb3c`. Its capture initializer at `0x49f7b7` computes length 16 but leaves
the capture cursor at zero with overwrite mode enabled. The first five typed
characters therefore produced `Codexew governor`.

`lib/app-profiles.js` verifies the original instruction bytes at `0x41607d`
before replacing only that default-name copy with a bounded 32-byte clear. The
patch applies to the loaded image, not the installer-produced file on disk. A
different `c3.exe` is rejected by the expected-byte check.

## Gameplay gate

`test/test-caesar3-gameplay.js` launches one headless CLI process with frozen
stdio control and the CLI's own `--max-seconds=90` bound. It drives:

```text
title -> Start new game -> type Codex -> Continue
      -> Assignment 1 briefing -> To the city -> live city
```

Mouse presses retain separate down/up execution slices because Caesar samples
button state from its frame loop. The test asserts that the live name buffer is
exactly `Codex`, captures the name screen, then verifies the final 800x600 city
by its terrain/control-panel regions. Set `CAESAR3_NAME_SCREENSHOT` and
`CAESAR3_SCREENSHOT` to retain both PNGs.

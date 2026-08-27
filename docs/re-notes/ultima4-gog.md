# Ultima IV: Quest of the Avatar (GOG)

## Source and fixture boundary

The local fixture comes from the Internet Archive `gog_collection` item pinned
in `test/candidate-corpus/manifest.json`. Its RAR is 12,548,654 bytes with
SHA-1 `a75b5a57226650c47fe8f8cdb0872c8289da1cf7`; the contained GOG offline
installer is `setup_ultima_iv_-_quest_of_the_avatar_1.0_cs_(28045).exe`,
12,548,400 bytes. GOG listed Ultima IV for USD 0.00 when this corpus was
verified, but the package remains proprietary and gitignored. Nothing here
grants redistribution rights for the installer or extracted game.

## Direct installer path

The original PE32 Inno wrapper was executed directly in Wine-Assembly, without
host Wine. It extracted a 1,343,072-byte child and called `CreateProcessW` with
this exact handoff:

```text
/SL5="$10001,11966063,192512,C:\setup_ultima_iv_-_quest_of_the_avatar_1.0_cs_(28045).exe"
```

Wine-Assembly intentionally does not implement a general child-process model,
so the wrapper reports that it cannot execute the temporary file and waits in
its error dialog. A debugger dump of the live UTF-16 `CreateProcessW` command
line supplied the handoff above. Running the extracted child directly with the
original installer mounted at the named `C:` path reaches the native Inno
language-selection UI and remains responsive; a bounded run completed 5,000
batches and 47,180 Win32 API calls there.

After proving the original and child paths, the existing local `innoextract`
build extracted the payload for runtime acceptance. This is a local throughput
and process-boundary workaround, not host Wine. The ignored extracted tree is
about 17 MiB.

## Bundled DOSBox runtime

The package contains the 32-bit Windows `DOSBOX/DOSBox.exe`, version 0.74-2.1.
`test/configs/ultima4-wine-assembly.conf` selects `core=dynamic`, mounts the
extracted root as `C:`, and launches the package's `ULTIMA.COM`. The launcher
then transfers control to `TITLE.EXE`, matching GOG's own single-game config.
The 3,000-cycle setting is deliberate: 50,000 nested cycles greatly increases
outer interpreter work. The acceptance runs guest work continuously for a
bounded 30 wall-clock seconds and captures the final frame, avoiding a
machine-load-dependent assumption that a particular batch number represents a
particular amount of DOS time.

The bounded acceptance runs that unchanged Windows DOSBox inside Wine-Assembly,
observes both `Program: ULTIMA` and `Program: TITLE`, and captures the 320x200
title/map intro. The accepted content has at least ten colors, over 40,000
black pixels, and over 1,000 cyan pixels; the earlier orange DOSBox splash
cannot satisfy that signature.

```sh
node test/test-ultima4-dosbox.js
```

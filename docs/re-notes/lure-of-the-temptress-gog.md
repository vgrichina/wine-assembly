# Lure of the Temptress — GOG Windows ScummVM

The local fixture is the GOG offline installer recorded under
`gog-free-lure-of-the-temptress` in `test/candidate-corpus/manifest.json` and
`sources.md`. GOG listed the game at USD 0.00 when the corpus was inventoried;
that price does not make the proprietary installer redistributable, so both the
installer and installed payload remain gitignored local fixtures.

## Direct install and launch

The PE32/i386 GOG installer was executed directly by Wine-Assembly. Its VFS
output is retained locally at:

```text
test/binaries/candidates/gog-free-lure-of-the-temptress/installed
```

The installed package ships ScummVM 2.0.0 for Windows. The acceptance launches
that `scummvm.exe` directly—there is no host Wine process and no DOSBox layer:

```sh
node test/run.js \
  --exe=test/binaries/candidates/gog-free-lure-of-the-temptress/installed/scummvm/scummvm.exe \
  '--args=-c c:\lure.ini --path=c:\ lure' \
  --env=SDL_RENDER_DRIVER=software \
  --vfs-include=../disk1.vga --vfs-include=../disk2.vga \
  --vfs-include=../disk3.vga --vfs-include=../disk4.vga \
  '--vfs-mount=test/binaries/candidates/gog-free-lure-of-the-temptress/installed/__support/app/lure.ini=c:\lure.ini' \
  --dll-seed=test/binaries/candidates/gog-free-lure-of-the-temptress/installed/scummvm/sdl2.dll \
  --winver=win2k --screen=800x600 --max-seconds=12
```

Run `node test/test-lure-scummvm.js` for the bounded local acceptance. It checks
that ScummVM selects Lure, remains live, and visibly renders the branded
ScummVM/Revolution startup sequence rather than an empty SDL window.

## Compatibility findings

SDL 2.0 defaults this build to its Direct3D renderer. Wine-Assembly can create
the D3D9 objects it probes, but does not yet execute the programmable shaders
SDL generates, so that backend produced an empty frame. SDL's software backend
uses the implemented GDI `BitBlt` path and renders the game correctly. The
renderer choice is injected with the per-process `--env` launcher option; it is
not a global default and does not disable D3D9 for other programs.

SDL also passes `CW_USEDEFAULT` through `AdjustWindowRectEx` and later performs
centering arithmetic on the adjusted sentinel. Treating the small adjusted
sentinel families as `CW_USEDEFAULT`, and centering the resulting `SetWindowPos`
request against the emulated screen, keeps the 640x480 game window onscreen.

The installer and runtime additionally exercised resource enumeration, older
Win32 shell/security/display APIs, MIDI SysEx completion, and a bounded set of
SSE instructions used by the bundled SDL/ScummVM binaries. CPUID still leaves
the SSE feature bit clear because the emulator does not claim the complete
instruction family.

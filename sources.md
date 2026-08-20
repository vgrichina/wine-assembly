# Candidate games and sources

Verified 2026-08-20. These are possible future compatibility targets for
Wine-Assembly, with an emphasis on official demos and shareware that can be
tested without distributing a full retail game.

## Diablo

The Internet Archive has several copies of the original PC release, including
[Diablo (1996) (PC)](https://archive.org/details/rootifera-diablo-1996), as well
as Blizzard's
[official Diablo pre-release demo](https://archive.org/details/Diablo_1020).
The demo is the preferred first target.

The Archive item describes the demo as a 1996 Blizzard release in which the
Warrior can play through the first two dungeon levels and fight the Butcher.
Its download is a roughly 56 MB ZIP containing only `DIABLO.EXE` and
`DIABLO.TXT`. `DIABLO.EXE` is Blizzard's self-extracting package rather than
the game executable itself; running it produces `DIABDEMO.EXE`, `STORM.DLL`,
and the other temporary payload used by the demo.

Local inspection of the archived executable found:

- A 32-bit Intel 80386 Windows GUI PE with a preferred image base of
  `0x400000`.
- The included notes require DirectX 2.0 or later.
- Static imports from `CRTDLL.dll`, `KERNEL32.dll`, `USER32.dll`, and
  `ADVAPI32.dll`.
- Strings for `ddraw.dll`, `Storm.dll`, and `SmackW32.dll`, consistent with a
  palette-era DirectDraw game using Blizzard's Storm and Smacker stack.
- File, registry, event, thread, synchronization, timing, and dynamic-library
  calls that overlap substantially with functionality already implemented in
  Wine-Assembly.

This makes the Diablo demo an unusually promising target: its Win95/DirectX 2
technology overlaps with the DirectDraw SDK samples, DX-Ball, Age of Empires,
threading, palette, audio, and virtual-filesystem work already present in this
repository.

### Current local integration

The repository's `?debug` app selector now has a debug-only
`diablo_demo` entry. Its ignored local payload lives in
`test/binaries/candidates/diablo/` and uses this verified layout:

- `DIABDEMO.EXE` is the launched game.
- `STORM.DLL` is loaded as a real PE DLL.
- The original 58,586,610-byte `DIABLO.EXE` package is mounted in the guest as
  both `C:\DIABLO.EXE` and `Z:\DIABLO.EXE`. An authoritative filesystem trace
  shows this Storm build opening the `C:` path; the `Z:` alias preserves the
  demo's CD-style search layout.
- `DIABLO.TXT` is mounted as `C:\DIABLO.TXT`.

The source ZIP is
[`diablopr.zip`](https://archive.org/download/Diablo_1020/diablopr.zip), SHA-1
`3116e614824b7bca73e24f41e09b61c7c012ac04`. The local candidate metadata
records the extraction step and file provenance. The payload remains excluded
from public deployment while compatibility work is in progress.

The debug registry has been exercised through both launch paths. It loads
`DIABDEMO.EXE`, maps `STORM.DLL`, patches 1,446 Storm thunks, and creates the
640-by-480 `Diablo Game` window. The browser reaches the animated title menu,
character selection, name entry, and the cathedral loading screen through the
normal `?debug` selector with no CLI-only filesystem scan or thread mode.

### Compatibility findings

Reaching gameplay required several real runtime contracts rather than success
stubs:

- CRT `atexit` now registers callbacks and drains them in LIFO order on normal
  `exit`; cdecl `strstr` implements exact first-substring semantics.
- `acmMetrics` reports the built-in PCM converter and the correct 18-byte
  `WAVEFORMATEX` maximum format size used by Diablo's sound initialization.
- Closing an event or semaphore frees its shared synchronization slot so
  Storm's repeated create/close cycle cannot exhaust the 64-slot table.
- DirectX COM vtable globals are synchronized into a worker instance before
  Storm calls `IDirectSoundBuffer::Lock` through a vtable. The shared registry
  was also moved away from the virtual-socket table it previously overlapped.
- `CRITICAL_SECTION` acquisition is recursive and owner-aware across the
  emulator's cooperative WASM instances. A contended entrant parks with a
  scheduler yield instead of being allowed into the protected region.
- `WaitForMultipleObjects(..., bWaitAll=TRUE, ...)` remains wait-all after a
  cooperative yield and consumes auto-reset events/semaphore counts only when
  every requested object is ready. Treating the resumed wait as wait-any had
  let Storm recycle handles while its worker still used them, corrupting a
  DirectSound object.
- The multimedia timer callback guard is cleared by its dedicated return
  thunk, not inferred from later stack depth, and callbacks never interrupt a
  parked wait frame. Diablo opts into the existing cooperative browser timer
  hook between main slices because its loading loop waits on `timeSetEvent`
  without pumping window messages. This is an isolated per-app scheduling
  policy and does not add Web Workers or native/real threads.

The deterministic CLI harness reached the cathedral progress screen and then
the rendered town game view. A subsequent click visibly moved the Warrior,
providing an interaction check rather than a menu-only or static-frame result.
The evidence captures are `/private/tmp/diablo-delayed-b43000.png`,
`/private/tmp/diablo-delayed-b60000.png`,
`/private/tmp/diablo-delayed-b85000.png`, and
`/private/tmp/diablo-delayed-b119999.png` (temporary local artifacts, not
redistributable fixtures).

### Startup-scan note

An earlier report that the "loader" took roughly two minutes was incorrect.
The CLI harness recursively indexes the executable's parent directory before
execution. Placing the executable directly in `/private/tmp` therefore made it
walk all of `/private/tmp`; putting it in a dedicated app directory made that
phase nearly immediate. This is not PE-loader or Diablo execution time.

This was fixed in commit `571ea0f`. Registered `--app` runs use only their
explicit manifests; an arbitrary `--exe` mounts only that executable unless
the caller supplies bounded, repeatable `--vfs-include` globs. This removes the
unrelated-directory scan and accidental file exposure. The tradeoff is that an
ad-hoc executable which previously found undeclared sibling DLLs or data must
now list those files explicitly (or be added to the app registry). Nested
assets remain supported through explicit glob patterns.

Full Diablo is still commercially available as a DRM-free offline release in
[Diablo + Hellfire on GOG](https://www.gog.com/en/game/diablo). Archive.org
availability is not by itself permission to redistribute a copyrighted retail
image. For a public deployment or checked-in test fixture, prefer the official
demo. For full-game testing, use files from a legitimately owned retail or GOG
copy and verify the applicable redistribution rights separately.

## Other promising games

Recommended order after the Diablo demo:

1. [StarCraft Shareware (USA)](https://archive.org/details/StarCraftUSAShareware)
   — a 1998 Blizzard shareware CD with a unique prequel campaign. Its related
   Blizzard technology makes it the natural follow-up after Diablo, although
   it is larger and likely exercises more Storm, Smacker, VFS, and installer
   behavior.
2. [Fallout Demo](https://archive.org/details/FalloutDemo) — a small 1997
   Interplay demo containing a settlement and story content not present in the
   retail game. Its archive is about 20 MB and expands directly to
   `Falldemo.exe`, `Falldemo.dat`, documentation, and registration files.
3. [Jazz Jackrabbit 2 Demo v1.23s](https://archive.org/details/JazzJackrabbit2Demo)
   — a fast 2D platformer and good input, audio, scrolling, and frame-throughput
   test. The archived package is a roughly 20 MB Windows executable installer,
   and its later DirectX requirements make it a more ambitious target.
4. [Captain Claw Demo](https://archive.org/details/CaptainClaw) — another
   attractive 2D platformer target. The archive provides an approximately
   11 MB Windows self-extracting installer, so unpacking or installer support
   is likely the first task.
5. [Heroes of Might and Magic II: The Succession Wars Demo](https://archive.org/details/HeroesofMightandMagicIITheSuccessionWars_1020)
   — a slower-paced strategy target with a directly runnable `H2DEMOW.EXE` and
   data files. It is visually suitable but technically less direct because it
   imports WinG32, Miles Sound System (`MSS32.DLL`), and Smacker.

### Fallout compatibility notes

Local inspection found that `Falldemo.exe` is a 32-bit Windows PE and directly
imports `DirectDrawCreate`, `DirectSoundCreate`, and `DirectInputCreateA`.
It also uses WinMM timers, threads, events, mutexes, TLS, file enumeration,
console routines, and window hooks. This makes Fallout a useful broad
subsystem test, but it is likely to expose more missing APIs than Diablo before
reaching gameplay.

### Heroes II compatibility notes

Local inspection found that `H2DEMOW.EXE` is a 32-bit Windows PE accompanied by
its game data, maps, help file, `MSS32.DLL`, and `SMACKW32.DLL`. In addition to
normal Win32 windowing and GDI calls, it imports WinG bitmap functions, Miles
audio functions, Smacker ordinals, palette operations, serial-port functions,
and Winsock ordinals. It is a worthwhile later target, but it introduces more
third-party DLL surface area than the games ranked above it.

## Suggested first experiment

Start with the official Diablo demo, then move to StarCraft Shareware. The
Diablo package is self-contained, period-appropriate, recognizable, and close
to subsystems already exercised by existing applications. Once its Storm,
Smacker, DirectDraw, input, and audio paths work, StarCraft should reuse much of
the resulting compatibility work.

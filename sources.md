# Candidate games and sources

Verified 2026-08-20. These are possible future compatibility targets for
Wine-Assembly, with an emphasis on official demos and shareware that can be
tested without distributing a full retail game.

## Win16 Entertainment Pack recovery

The byte-level recovery ledger for Rodent's Revenge, Fuji Golf, and Tic Tac
Drop is [docs/win16-app-sources.md](docs/win16-app-sources.md). Internet Archive
disk images and unpacked collections are the primary sources; the ledger lists
every item URL, downloaded archive and disk-image SHA-256, recovered-file hash,
the independent WinWorld comparison, and the libmspack extraction tool source.

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

## StarCraft demo and shareware

Two Internet Archive items were used as independent Blizzard-era sources:

- [StarCraft Shareware CD](https://archive.org/details/cdrom-starcraft-shareware),
  whose raw image has SHA-1
  `d5afc3283344091e6d3caf9f96a92dadcb0f681b`. The local ISO derived from it
  is 230,686,720 bytes with SHA-256
  `63ffa521f8ea07c01fbf4035eda24bc667c5fe2e71bc162fdae5c8c1a48609b8`.
  The native disc installer files are `INSTALL.EXE` (SHA-256
  `8c8855f29d1fb3265727021381d82bf35555a736a27896d9f159c3f34bebe0a8`),
  `SETUP.EXE` (SHA-256
  `ab0c5f9ffabf9e879ba89405eaed97064d4edf8ab17764f4b2b36cd3dd893cb7`),
  and `SMACKW32.DLL` (SHA-256
  `5786b7b72667b9ea1cc4bf7762a9e313c2ad1474392907a0f3b52e4e888029bf`).
- [StarCraft Demo](https://archive.org/details/SCDEMO), whose original
  29,569,615-byte `SCDEMO.EXE` has Archive-recorded SHA-1
  `2bef4f65032f34d70957bb123560fddb63e5686c` and local SHA-256
  `3c10439a63f1dc06f07fb3451d7d2788ba5cd000c798fd846294f467431663d0`.

Both were exercised through their native Windows installers inside
Wine-Assembly; no host Wine installation or pre-extracted gameplay shortcut
was used. The shareware CD installer produced the exact 35,912,186-byte
`stardatsw.mpq` and exited its worker after the cooperative critical-section
ownership and retry contracts were corrected.

The standalone demo installer also provided a real-Windows oracle using the
repository's v86 Windows 98 reference environment. Windows 98 produced a
970,752-byte `Starcraft.exe` with SHA-256
`b2461f58aca73df0af402009f2a33fae85ce57626eb938479effd12e972c1c26`.
Before the memory fix, Wine-Assembly produced the same length but corrupted
175,467 bytes across 224 of its 237 4 KiB blocks. Tracing showed the first bad
byte was already present in the PKWARE explode output buffer before VFS
`WriteFile`, excluding the extracted file, VFS persistence, and mapped-file
data as the source.

The root cause was the sparse guest-memory layout. Adjacent guest pages may be
backed by non-adjacent regions of WASM memory when `VirtualAlloc` commits are
interleaved. Ordinary 16- and 32-bit helpers translated only the first address
and then performed one native WASM-width access, so a word or dword crossing a
4 KiB boundary read or wrote unrelated backing memory. Page-local accesses
retain the single-translation fast path; only true non-contiguous boundary
accesses gather or scatter bytes. After that correction, all 237 output blocks
from the native demo installer matched the Windows 98 oracle byte-for-byte.

The installer is intentionally retained as a compatibility test because it
exposed shared-dialog data-segment overlap, named-event behavior, cooperative
critical-section ownership, and sparse-memory corruption that mounting a
prebuilt installed image would have hidden. A mounted image can still be an
optional faster gameplay path once the installer result has been verified.

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

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

The installed demo's ten files were also checked independently under the v86
Windows 98 reference environment. Their sizes and CRC-32 values exactly match
the native Wine-Assembly installation: `Starcraft.exe` 970,752 / `f7d9cc58`,
`Storm.dll` 202,752 / `048f72d9`, `Local.dll` 52,224 / `7659e716`,
`SmackW32.dll` 95,232 / `614a9406`, `Battle.snp` 239,358 / `531bcffe`,
`Standard.snp` 97,258 / `db5e9b18`, `StardateD.mpq` 29,005,415 /
`94d270e3`, `Readme.cnt` 1,134 / `d0b8a3e2`, `Readme.hlp` 28,926 /
`9647957d`, and `License.txt` 10,617 / `7a99b80d`. This excludes installer,
VFS, and extracted-file corruption from the later `font\\font.gid` failure.

That failure instead exposed a Win32 loader contract. Microsoft documents that
[`DllMain` receives a NULL `lpvReserved` for a dynamic process attach and a
non-NULL value for a static process attach](https://learn.microsoft.com/en-us/windows/win32/dlls/dllmain).
Wine-Assembly previously passed NULL to every DLL. StarCraft imports
`Storm.dll` at process startup, and disassembly of this 1998 build shows that
its attach routine branches on that third argument. NULL runs a legacy table
initializer seeded with `0x10000100`; non-NULL defers initialization until the
MPQ path builds the compatible table from `0x00100001`.

The archive itself was checked against the algorithm and structures in
[StormLib's `SBaseCommon.cpp`](https://github.com/ladislav-zezula/StormLib/blob/master/src/SBaseCommon.cpp).
The on-disk hash table decrypts correctly, and `font\\font.gid` is present at
hash slot 1675 with block index `0x57e`, file position `0x1b2a3d5`, compressed
size `0x50`, logical size `0x48`, and flags `0x80030200`. Passing dynamic-load
NULL to the statically imported DLL instead produced the wrong crypt table and
deterministically transformed the correct 64 KiB VFS read into invalid hash
entries. Static import-graph DLLs now receive non-NULL; actual `LoadLibrary`
and COM in-process loads retain NULL.

### StarCraft runtime memory-layout audit

The installed executable now reaches its original full-screen loading artwork,
loads app-local `Storm.dll`, `Local.dll`, and `SmackW32.dll`, and starts its
cooperative loader workers. A two-phase loader breakpoint confirmed that
`LoadLibraryA("local.dll")` returns the real mapped module base `0x006da000`
after the host-side yield, its `DllMain` returns success, and `LoadStringA` id 3
returns the expected locale string `0x00000409`. The small pre-yield value
visible in an earlier trace was the loader's yield marker, not a truncated
`HMODULE`.

The startup wait that initially looked like a corrupted handle is also valid.
At guest `0x074fb5e0`, StarCraft builds a contiguous 61-entry array containing
events `0x000e0003` through `0x000e003f` and calls
`WaitForMultipleObjects(61, array, TRUE, 50)`. The three earlier event slots
belong to singleton/thread coordination, so the 61-entry preload batch exactly
fills the remaining slots in the runtime's 64-object table. Microsoft documents
that `nCount` is the number of entries in `lpHandles`, is bounded by
[`MAXIMUM_WAIT_OBJECTS`](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitformultipleobjects),
and a `bWaitAll=TRUE` call completes only when every listed object is signaled.
The misleading trace label printed `nCount=0x3d` as a "handle"; the guest array
itself, its alignment, and every handle value were intact.

The `Data File Error` dialog seen during debugging was caused by injecting
Escape twice while those asynchronous preload batches were still active; it is
not the natural startup path. An isolated load of RT_DIALOG 106 preserved the
source bytes and produced four independent, correctly sized controls, including
a 16-byte text block containing `local.dll\0`. In the live cancellation dialog,
the final static likewise had a valid 24-byte state block and a separate
24-byte text allocation with the internally consistent length 3. Tracing the
call site showed `SetDlgItemTextA` received guest pointer `0x3d3e2f8c`, and
sparse-safe guest reads at that pointer were already `64 a3 6c 00` (`d£l`).
USER copied the supplied bytes faithfully; no overlap, free-list alias, resource
mutation, mapped-file corruption, or sparse translation error occurred in this
dialog path. Forced cancellation should therefore not be used as evidence for
the no-input loader's next blocker.

The natural preload was then followed through batches 4,000, 8,000, and 11,000.
All three frames retained the original `Loading` artwork, but the scheduler was
not deadlocked: the main thread completed its 61-object wait roughly every four
to six outer batches, worker T1 remained normally parked on event `0x000e0001`,
and worker T2 advanced through `Storm.dll` addresses `0x006c558c` through
`0x006c5956`. Those addresses relocate to the DLL's `0x15028570` decompressor,
whose state layout contains a 4 KiB sliding output window, an 0x800-byte input
buffer, input/output callbacks at offsets `+0x28` and `+0x2c`, bit accumulator
state at `+0x14/+0x18`, and tables beginning at `+0x2234`. The observed guest
contexts were aligned and independently allocated; output indices stayed in
the documented 0x1000..0x2000 window and callback returns were bounded below
0x800.

A breakpoint immediately after the input callback showed different short
refill lengths and changing context allocations across jobs. This rules out an
EOF loop replaying one compressed buffer: Storm is processing a large queue of
distinct MPQ assets and the main thread is consuming their completion events.
One decoded-arena overflow marker (`0xCA00F10F`) appeared during the workload,
but the current memory map is internally consistent: eight 4 MiB per-instance
decoded arenas occupy `0x05000000..0x07000000`, the main stack begins at
`0x07012000`, and all cache indices occupy `0x07152000..0x07192000`. Expanding
an arena in place would overlap the stack or another thread, so no speculative
layout change is justified without repartitioning the fixed 512 MiB map.

The trace also exposed avoidable host overhead rather than guest corruption.
Every satisfied main-thread wait printed an unconditional ThreadManager line;
StarCraft generates thousands of those completions while loading. The worker
path already restricted the equivalent message to explicit thread tracing.
The main path now follows the same policy, so normal browser startup does not
turn the preload queue into console I/O while `--trace-thread` retains the
diagnostic when requested. Five older synchronization handlers also crossed
the Wasm/JavaScript boundary solely to print their return value, including both
wait APIs on this hot path. Those result prints were removed; functional event,
thread, and wait calls are unchanged, and explicit API/thread tracing remains
available. The later transition phase also creates and recycles many short-lived
Storm events, so default `CreateEvent`/`CreateSemaphore` diagnostics were put
behind the same explicit thread-trace switch. Actual thread lifecycle messages
remain available by default.

### StarCraft hot-code and sparse-memory profile

The next performance audit used the installed, byte-verified demo with
`--batch-size=1000 --thread-slices=64` and bounded handler histograms in
`test/run.js`. At batch 2,600 the process had 885 sparse VirtualAlloc map
records. Storm's active decompressor buffer was in record 860, so the former
`g2w` implementation restarted a linear scan and tested about 861 records for
each uncached guest byte access. On the same 2,600-batch workload, adding a
single last-range translation cache reduced wall time from 26.0 seconds to
3.1 seconds (about 8.4x). The mappings are append-only in the current runtime:
`VirtualFree` does not decommit or remove their backing, and a later extension
can safely miss the old cached size once and refill it.

A worker-T2 histogram over batches 2,214 through 2,600 counted 148,574,886
threaded handlers. Storm's bit reader and back-reference loop at relocated
addresses around `0x006c58a0` dominated. The most frequent individual handlers
were 32-bit loads from `[esi]` (5.17%), loads from `[esp]` (4.95%), `push esi`
(4.84%), add-immediate (4.46%), conditional-zero branches (3.76%), and stores
through `[esi]` (3.41%). These are already specialized handlers; the important
remaining cost was the translation performed under their memory accesses, not
a missing arithmetic opcode fast path.

After preload, the main thread enters dynamically generated Smacker conversion
code at `0x3ff68c18`. A representative prefix is
`c7 c0 00 00 00 00 8b 0f 8b 16 8a c1 8a e2 81 c6 04 00 00 00 8a 1c 28`.
It repeatedly rearranges packed byte registers, rotates 32-bit words, reads an
input stream through ESI, reads palette bytes through `[eax+ebp]`, and writes
pixels through EDI. This is coherent generated x86, not corrupted extracted
data or a wild instruction stream.

Before instruction fusion, the exact main-thread window from batches 3,750 to
3,830 executed 140,307,945 handlers. `MOV r8,r8` accounted for 24.62%, shifts
and rotates 19.44%, SIB effective-address calculation 12.39%, and its separate
byte-load consumer 12.37%. The SIB census found 17,146,790
compute-SIB-to-load8 pairs (12.68% of all adjacent handler pairs); 98.63% were
palette loads into BL or BH from `[eax+ebp]`. Folding that generic SIB/load8
pair into existing handler 149 made the same fixed handler budget execute
20.14 million indexed loads instead of 17.39 million, 15.9% more guest work.
It does not add a handler-table entry, which also avoids overflowing the fixed
pair-histogram geometry.

The generated converter alternates three sparse regions—palette, input, and
output—so one shared last-range cache is insufficient. Retaining four recent
ranges removes the fallback scans through hundreds of map records; the
3,830-batch no-renderer point then completed in 25.53 seconds. A separate 4KB
byte-read translation TLB prevents the palette's `gl8` stream from probing the
input/output cache slots. With identical 140.3-million-handler progress and
22.06 million indexed loads, this reduced the profiled whole-run time from
31.07 to 27.67 seconds (10.9%). Invalid translations to the four-byte null
sentinel are deliberately never cached.

Two further handler experiments distinguish useful fusion from cosmetic code
changes. Folding adjacent flag-neutral register-byte MOVs into existing
handler 155 raised indexed-load progress under the same handler budget from
20.14 to 22.06 million (+9.5%) while reducing profiled wall time from 32.83 to
31.07 seconds, so it was retained. Folding adjacent immediate shifts advanced
22.06 to 23.02 million loads (+4.35%) but increased wall time from 31.07 to
32.51 seconds (+4.63%); normalized throughput did not improve, so that change
was removed. Earlier direct formulas for the common byte moves and `ROR 16`
likewise measured 32.83 versus 32.73 seconds, within noise, and were removed.

Only two decoded-arena overflow/flush markers appeared in the representative
3,830-batch run. They are far too infrequent to explain the sustained late
cost. A renderer run also continued to return from successive batches while
executing the generated converter; the silence between scheduler heartbeats
was long synchronous guest work, not a decompressor deadlock. Escape was
delivered during this first experiment, but the headless renderer's forced
snapshot remained its gray backing canvas, so that capture alone does not
establish whether the browser-visible Smacker presentation was skipped. A
second renderer run held both the window-key and DirectInput Escape states
starting at batch 3,829. Batch 3,830 still spent more than a minute in the same
synchronous conversion phase before returning, so Escape cannot preempt a
frame already executing; input must be observed by the surrounding video loop
between completed conversions.

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

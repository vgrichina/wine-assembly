# Candidate games and sources

Verified 2026-08-20. These are possible future compatibility targets for
Wine-Assembly, with an emphasis on official demos and shareware that can be
tested without distributing a full retail game.

## Windows 98 games A-D archive

Verified 2026-09-04. The local compatibility fixtures for **Curse of Monkey
Island**, **Atomic Bomberman**, **Broken Sword**, **Dungeon Keeper**, and
**Darkstone** came from the Internet Archive item
[*Win98 Games A-D.7z*](https://archive.org/details/win-98-games-a-d.-7z).
Its Archive.org-generated
[`torrent`](https://archive.org/download/win-98-games-a-d.-7z/win-98-games-a-d.-7z_archive.torrent)
has BitTorrent v1 info hash `3ade118219510c517927fb43a50618776ca4fef7`.
The selected payload is `Win98_Games-A-D.7z`, 7,169,873,753 bytes, with SHA-1
`c53417bcc617790d9671ec385c49ee6f018846c9` and MD5
`7610b389f075be9f4ea8b521157e87d2` as recorded in that torrent.

Only those five demo trees were unpacked into the local, ignored
`test/binaries/win98-games-a-d/` corpus. Their launch executable SHA-256 values
are:

- Curse of Monkey Island `COMI.EXE`:
  `b55524231edacc7d184c22c762d25193d616adc55d0141785fb21b8890d352b9`
- Atomic Bomberman `_BOMB.EXE`:
  `0ff14a352d6626660ceb66ea0e6743cd33c457e754cfd5705120bacae0530638`
- Broken Sword `WINSWORD.EXE`:
  `8ca6e3f0c56e1f289f79e2d52ca8cd98466c5b5c2817b3d05b7f7d80425c4177`
- Dungeon Keeper `KEEPER95.EXE`:
  `470bc45a428ac0e180b2bd34bfbc35c09a5606390fe2e92525de0c98ad4cd8fc`
- Darkstone `DarkstoneDemo.exe`:
  `b43db5e1b835eb1e93688a1f3f1d9c814517be6fc8110c7fb6e024d467ee721b`

The archive and extracted binaries remain local-only. Browser runs using the
generated companion manifests reached interactive gameplay in both cooperative
and Threads modes: Guybrush movement, an Atomic Bomberman arena with movement
and bomb placement, Broken Sword's playable café scene, Dungeon Keeper's live
dungeon level, and Darkstone's controllable town view.

## Baldur's Gate demos and commercial preview

Verified 2026-08-29. Three different Windows promotional builds are preserved
on Archive.org and are useful local compatibility fixtures. None is shareware,
and the payloads must remain out of the repository and deployed site.

- The [non-interactive demo](https://archive.org/details/BALDUR) is the
  34,296,832-byte `BALDUR.EXE` WinZip self-extractor (SHA-1
  `e7caae4255e8ed570cef3a29642432c8d28ecdb9`). It expands to a DirectX 5
  presentation headed by a 913,408-byte `Baldur.exe`. Its README permits
  personal, noncommercial copies shared at no cost, but excludes commercial
  or bundled distribution.
- The [interactive demo](https://archive.org/details/bg-demo) is a
  513,132,544-byte `BG Demo.iso` (SHA-1
  `3796defce51a3e867aa216bc27f0be0689fdadf0`). Its README identifies demo
  version 1.0.0 and explains that it omits the main quests and story, disables
  multiplayer and character import/export, and exists to demonstrate the
  engine. The disc installs its data cabinet but runs the 4,848,640-byte
  `BGDemo.exe` from the CD root.
- [*Baldur's Gate: Chapters I & II*](https://archive.org/details/20230723_20230723_0858)
  is a separate version 1.1.0003 commercial preview. The exact preserved ZIP
  is 612,538,616 bytes (SHA-1
  `2e5256bc8c418aec51ea39ef1a5bf8640dd3317a`) and contains a matching CUE plus
  a 753,844,224-byte raw MODE1/2352 BIN. Its README calls the game an abridged,
  self-contained version of the prologue and first two chapters, with some
  areas removed and a modified ending. The bundled license prohibits copying
  or electronic distribution, so the corpus records only a checksum-pinned,
  local-only fetch recipe.

## ToyVM DOS game corpus

This is a separate source collection from ToyVM's scene-demo corpus. The
existing corpus is fetched from the Hornet scene archive by
`tools/toyvm/fetch-demos.js` and the generated gallery offers Pouët lookup
links. This collection is for official playable DOS game demos and shareware,
including the companion files a game needs rather than selecting isolated
executables from demo-scene archives.

An official demo download is not automatically permission to republish it.
Record the upstream page, exact archive URL and digest here first; keep the
payload out of the repository and public corpus until its redistribution terms
have been checked separately.

### The Settlers II DOS demos

Verified 2026-08-28. The [Settlers II downloads
page](https://settlers2.net/download/) preserves six public DOS demo builds.
The maintainer says the files came from Blue Byte's FTP server; the convenient
ZIP files are modern repackagings, while the page also links original
self-extracting distributions where they survive.

| Release | Language | Preserved ZIP | Size | Notes |
|---|---|---|---:|---|
| *Die Siedler II: Erste Demo* v0.15 | German | [`S2DEMO15.ZIP`](https://settlers2.net/downloads/demo/s2demo15.zip) | 20.8 MB | First public pre-release build; includes extra images and video. |
| *Die Siedler II: Erste Demo* v0.16 | German | [`S2DEMO16.ZIP`](https://settlers2.net/downloads/demo/s2demo16.zip) | 3.79 MB | Commonly preserved compact version of the first demo. |
| *The Settlers II: Veni Vidi Vici* v1.01 | English | [`SETTLER2.ZIP`](https://settlers2.net/downloads/demo/settler2_v101.zip) | 50.0 MB | Playable demo with the intro video and files not needed to run it. |
| *The Settlers II: Veni Vidi Vici* v1.02 | English | [`SETTLER2.ZIP`](https://settlers2.net/wp-content/uploads/2012/09/settler2_v102.zip) | 3.41 MB | Compact playable demo; the preferred first ToyVM game fixture. |
| *The Settlers II: Mission CD* v1.51 | English | [`S2MISS.ZIP`](https://settlers2.net/wp-content/uploads/2012/09/s2miss.zip) | 9.91 MB | Includes a map editor limited to 15 minutes and unable to save. |
| *The Settlers II: Gold Edition* v1.51 | English | [`S2GOLD.ZIP`](https://settlers2.net/wp-content/uploads/2012/09/s2gold.zip) | 9.75 MB | Closely related to the Mission CD demo, with a few differing files. |

The v1.02 ZIP was downloaded and inspected locally. It is 3,579,784 bytes with
SHA-256
`b3b96739fc25e475c7f4ff610c1bef35df790bbf2aaf1d51dbe2261d65dd95b5`.
It contains 181 entries and expands to 8,844,950 bytes. The launch path is
`START.BAT` to `S2.EXE` (1,897,074 bytes), with `DOS4GW.EXE`, Miles sound
drivers, maps, saved state, graphics, music and other files in sibling
directories. A corpus importer must therefore retain the full extracted tree;
`S2.EXE` alone is not a valid fixture.

This is a DOS/4GW game, not a native Windows release. Its included readme asks
for roughly 7 MB of XMS memory and VESA VBE support; its Windows 95 “Autorun”
note describes launching the DOS program from Windows. The demo is a useful
ToyVM target precisely because it broadens the corpus beyond tiny real-mode,
single-file intros into a protected-mode, VESA, mouse, sound and filesystem
workload. DOS Games Archive describes v1.02 as a playable demo containing the
[tutorial and an exclusive single-player
scenario](https://www.dosgamesarchive.com/download/the-settlers-ii-veni-vidi-vici).
It is a demo, not shareware, and no explicit redistribution grant was found in
the included `README.TXT`; keep the archive source-only unless a separate grant
is established.

### Grand Theft Auto demos and Rockstar Classics

Verified 2026-08-30. The preserved official **Grand Theft Auto** DOS demo is
the Liberty City, 24-bit high-resolution release. The exact 9,531,378-byte
[`gta24.zip`](https://archive.org/download/gta-1997/Files/Demo%20-%20Liberty%20City%20-%2024%20Bit%20-%20High%20Res%20Version/gta24.zip)
has SHA-256
`76f1e1da5c898f755597b86357c4d77b7447cb483673a23d10d34f40cfe03ec9`.
It expands to a `GTA24` tree whose launch executable is the 2,001,991-byte
`GTADOS/DEMO24.EXE` (SHA-256
`2f1cedfb95254b2f1a8913f1aeac7a915966cb42c70c9c96b14b8861fbf78c9f`).
The executable embeds DOS/4GW and requires VESA; its 117 companion files must
remain beside it. The manifest and fetch recipe therefore keep the complete
tree as an ignored local fixture.

The preserved **Grand Theft Auto 2** Wild Demo is the original 12,972,175-byte
[`gta2demo.exe`](https://archive.org/download/gta2-1999/Files/Demo/gta2demo.exe)
(SHA-256
`f8fc0a9653932f008a03e56ea892fb31dbeb98d228cc4df61b910bcb35d08d21`).
This is a PackageForTheWeb self-extractor around an InstallShield 5 setup, not
an already-installed game. Wine Assembly's acceptance starts from that file,
lets its own LZ32 path emit Disk1, runs the emitted `Setup.exe`, then runs the
emitted `_INS5576._MP` wizard. The stages are separate processes only because
the emulator does not yet execute Win32 child processes. The final test checks
the wizard's completion message and its 73-file payload before the matching
installed executable is launched into the Wild Demo map.

Rockstar later offered three complete games at no charge through its Rockstar
Classics series: **Grand Theft Auto**, **Grand Theft Auto 2**, and **Wild Metal
Country**. That historical offer did not include the GTA London expansions,
and it is no longer available. More importantly for this repository, the
Rockstar download notice explicitly said the games were *not freeware* and
could not be mirrored or duplicated without written consent. “Free download”
therefore does not authorize bundling those full versions here; both demo
fixtures remain local-only as well because their included terms contain no
clear public-redistribution grant.

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
The pre-release demo remains useful as a historical comparison, while the
retail-era 1997 shareware CD documented below is now the preferred playable
candidate.

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

### Pre-release local integration

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

### 1997 shareware CD

The later [Diablo Shareware Windows CD](https://archive.org/details/DiabloSharewareWindowsBlizzardEntertainment1997)
is now retained as a separate `diablo_shareware` corpus entry rather than
replacing the historically distinct August 1996 pre-release demo. This is the
retail-era shareware branch: it is a substantially later and more representative
Diablo build, while still being limited shareware rather than the commercial
full game.

Archive.org's original `DIABLOSW.iso` is 137,576,448 bytes, SHA-1
`bf1a62b24ce01ce39993955bff4b3c4d4ab9d647`, and MD5
`3f37d919254c9747039e1042ed70a5fb`. The disc was created on 1997-01-18 and
contains two distinct native paths:

- `AUTORUN.EXE`: the authentic shareware installer and its packaged data.
- `BLIZDEMO.EXE`: a separate Blizzard promotional reel; it is not Diablo
  gameplay and is retained only as another disc fixture.

`AUTORUN.EXE` was run to completion entirely inside Wine Assembly. Its worker
threads exposed a real process-handle bug: `CloseHandle` did not inherit the
process-owned synchronization-table release callback, eventually exhausting
all 64 event slots. Sharing that callback with workers let the unchanged
installer finish and produce `diablo_s.exe`, `storm.dll`, `diabloui.dll`,
`smackw32.dll`, and the 50,274,091-byte `spawn.mpq`.

The ignored local corpus retains the ISO, extracted disc, and untouched
installer-produced files beneath `test/binaries/candidates/diablo-shareware/`.
The `diablo_shareware` web entry launches that installed game payload, while
the corpus keeps `disc/AUTORUN.EXE` as the installer regression target. This
does not use host Wine or a preinstalled third-party package.

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

This was reverified against the current worktree on 2026-08-21 through the
registered `--app=diablo_demo` path and its native-installer output. The
deterministic input sequence clicked through the quote at batch 25,000, chose
New Game at 28,000, confirmed Warrior at 32,000, entered `ABC` at
35,000--35,200, and confirmed the name at 39,000. With the app's cooperative
multimedia timer enabled from that transition, the cathedral loader completed
and the live town view was rendered by batch 70,000. A canvas click at batch
72,000 moved the Warrior; the batch-70,000 and batch-80,000 PNGs differ in
214,119 pixels and the process remained live through batch 100,000. The fresh
temporary evidence is under `/private/tmp/diablo-gameplay.2UwT5L/`.

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

## StarCraft command-line video bypass research

The documented command-line surface for original StarCraft is very small. The
[BWAPI command reference](https://github.com/bwapi/bwapi/wiki/Commands) lists
only `ddemulate` and `nosound` as ordinary options, plus single-player cheat
codes. A period technical community reference gives the same list and notes
that arguments have no leading dash: `StarCraft.exe nosound`, not
`StarCraft.exe -nosound`. Local string inspection of the exact shareware
`starcraft.exe` likewise found `ddemulate` and `nosound`, but none of
`skipintro`, `novideo`, or `nomovie`. There is therefore no evidence of a
dedicated video-disabling CLI switch in this build.

The useful indirect option is the `ophelia` level-selection cheat. The
[StarEdit Network command-line notes](https://staredit.net/topic/8620/#1)
show `StarCraft.exe ophelia xzerg01` and report that it skips the menu and opens
that campaign mission directly. The same behavior is documented by BWAPI.

Disassembly of the exact shareware executable resolves the remaining grammar.
Function `0x45dab0` compares each token at full token length and recognizes five
literal options: `nosound`, `ddemulate`, `pirate`, `nospawn`, and `rdtsc`.
Before that literal fallback, caller `0x45d490` passes every token to the
encoded cheat recognizer at `0x406fe0`. `ophelia` matches its eight-byte table
entry at `0x4d5588` and toggles cheat-state bit `0x200`. While that bit is set,
fallback `0x407490` accepts the three campaign prefixes stored at `0x4da6e8`,
but this shareware branch only acts on `terran` followed by a number from zero
through three. It stores mission selectors `0x26` through `0x29` and sets the
direct-launch flag at `0x508144`. Runtime probes confirmed all four forms;
`terran4` leaves the direct-launch flag clear.

An end-to-end rendered run of `Starcraft.exe ophelia terran1` confirmed mask
`0x200`, mission selector `0x27`, and direct-launch flag `1`. It does not bypass
the startup presentation/preload: the Shareware title remained visible, and
the main thread repeatedly waited for all 61 Smacker work events while the
decoder worker ran. That barrier eventually completed around batch 23,500,
after which the game loaded both network providers and created another worker.
The frame at batch 25,000 was still the title, and the next long synchronous
guest batch did not return before the bounded 180-second run expired. Holding
both window-key and DirectInput Escape did not avoid the preload. Thus
`ophelia terran1` does select the first demo mission and should bypass the main
menu after startup, but it is not a workaround for the current slow/non-
preemptible startup decode path.

## StarCraft native-install, preload, and gameplay follow-up

All subsequent runs used the files produced by the original StarCraft
Shareware installer, not Wine and not a pre-extracted third-party package. The
installed tree is currently preserved at
`/private/tmp/starcraft-native-install.J7GB4C/vfs/program files/starcraft shareware/`;
it contains `starcraft.exe`, the 38 MB `stardatsw.mpq`, `storm.dll`,
`smackw32.dll`, both network providers, and the remaining installed data. The
test registry supplies the install path and CD-drive value expected by this
build. [StormLib](https://github.com/ladislav-zezula/StormLib) is a useful
modern primary reference for the MPQ container family, while the conclusions
below come from disassembly and execution of this exact 1998 shareware build.

The apparent post-preload hang had two independent causes. First, the decoder
allowed a straight-line block to contain as many as 4,096 guest instructions,
but `$next` retained only 1,000 threaded-handler calls and did not retain a
resume IP. A generated block at `0x3ff60f8a` therefore restarted on every
quantum. Splitting straight-line blocks after 256 decoded guest instructions
preserves an exact EIP continuation and eliminates that replay. The focused
regression executes a 1,200-instruction increment stream and verifies every
increment occurs exactly once.

Second, the original `VirtualFree` handler returned TRUE without removing a
sparse map. Storm performs thousands of short-lived 64 KB reservations, often
committing only the first 4 KB. After roughly 2,400 cycles, the 2,048-record
sparse-map table was exhausted and Storm's `SBmpAllocLoadImage` reached its
allocation failure at the source provenance `SBMP.CPP`, line 889. Exact sparse
`MEM_RELEASE` now removes and compacts the matching map record, and reclaims
the physical backing cursor when the released mapping is topmost. A 2,500
cycle focused regression verifies that table slots and LIFO backing are
recovered.

Map-slot reclamation exposed a separate guest-address-space limit: reservations
were still handed out monotonically from `0x40000000` down to `0x10000000`, and
StarCraft reached that floor just before building the selected unit's command
panel. The result was its `_CTRLNODE` critical-error dialog on the first unit
or building selection. The dedicated DIB guest arena does not begin until
`0x50000000`, so the sparse allocation ceiling now uses that exact boundary.
This adds 256 MB without overlap or a change to the established reserve/commit
mapping behavior. A more complete future allocator could recycle fragmented
guest reservation holes; the bounded ceiling change intentionally does not
introduce that larger semantic change.

The late decompression hot path is scalar by construction. The profiled Storm
routine at original `storm.dll` address `0x150288a0` updates a serial bit
reservoir and follows a data-dependent Huffman node on every step. In batches
29,500 through 30,000 it was entered 58,512 times, and its prologue accounted
for 11.7% of sampled block entries. Each next address and bit count depends on
the immediately previous result, so there is no independent lane set for a
SIMD implementation; the repository also contained no SIMD variant of this
path. The retained optimization is therefore a scalar superinstruction for
the exact common no-refill path, with the rare refill callback reconstructed
and resumed through the original guest code. Similar exact fusions cover the
dominant indexed load/test, add/load/test, byte-decrement branch, shift branch,
and Smacker Huffman-walk sequences. The focused handler suite covers their
fast paths, fallbacks, flags, callback return, and long-block continuation.

The corrected native run now completes the preload, loads `battle.snp` and
`standard.snp`, presents the Terran mission briefing, accepts Start, renders
the first mission, and dismisses the normal StarCraft Tips modal. StarCraft
polls mouse-button state, so a synthetic press and release in the same harness
batch can be missed; holding mouse-down across several guest batches matches a
real browser click. At batch 1,220,000 an SCV selection produced its green
selection ring, portrait, 60/60 health display, and command buttons. The game
remained active through batch 1,350,000 with no `_CTRLNODE` error and with
`virtual_alloc_top=0x1cbf0000`, still above the floor. Evidence images are:

- `/private/tmp/sc12-clean.png` — unobstructed first Terran mission;
- `/private/tmp/sc12-selected.png` — selected SCV and populated command panel;
- `/private/tmp/sc12-final.png` — stable selected-unit gameplay later;
- `/private/tmp/sc13-selected.png` and `/private/tmp/sc13-final.png` — repeated
  native run confirming the interaction and continued simulation.

The full build, handler-count/ESP gates, indexed-handler regression, and
cross-instance sparse-map regression pass with these changes. The result
establishes native emulator gameplay and normal mouse selection. The scripted
`M` key plus target click did not visibly relocate the chosen SCV in the
captured interval, so movement-command automation is not claimed here; the
browser's real mouse state remains the correct next input oracle.

## Fallout demo native archive and gameplay follow-up

The Fallout demo was run from the repository's extracted copy of the original
`falldemo.zip` distribution, whose readme explicitly describes unzipping the
archive with directory names as the installation procedure. No Wine install or
Wine runtime was used. The pinned package source is
[Internet Archive: Fallout Demo](https://archive.org/download/FalloutDemo/falldemo.zip),
with package SHA-1 `214c6b8931f75aa2a9a11f521a26b0cb8e565ad9`;
the tested `Falldemo.exe` and `Falldemo.dat` SHA-1 values are respectively
`e8340e0cf5604f7f2e916b8126446894f993307a` and
`4d072c81d852287804e77ac951ba981d6ea84017`.

The first strict launch failed at `Falldemo.exe` address `0x004a1c5a`, opcode
`D4 0A`. The emulator had no AAM decoder or handler. The new general x86
implementation divides AL by the encoded byte base, places the quotient in AH
and remainder in AL, preserves EAX's upper half, publishes byte-width SF/ZF/PF,
and raises the normal divide exception for a zero base. The real demo then
finished opening `Falldemo.dat` and created its 640x480 DirectDraw window.

Fallout next entered a timer-seed helper that writes control byte zero to PIT
port `0x43` and reads the low/high bytes from channel-zero port `0x40`. The
emulator now decodes the complete accumulator IN/OUT opcode family
(`E4`-`E7`, `EC`-`EF`), models the latched PIT access used here, alternates VGA
vertical-retrace status for legacy polling, and uses a conservative floating-
bus value for other ports. Its following compiler helper exposed ordinary
32-bit `ENTER 0x144,0`; level-zero 32-bit ENTER is now implemented while
non-zero nesting remains fail-fast.

The first input initially jumped to patterned address `0x39ac39a6`. This was
not an input or DirectDraw defect. Fallout is a Watcom PE whose `.bss` section
has `VirtualSize=0`, `SizeOfRawData=0x160200`,
`PointerToRawData=0`, and `IMAGE_SCN_CNT_UNINITIALIZED_DATA`. The loader treated
the raw-size field as copy length and copied 1.38 MB beginning at the DOS header
into guest address `0x510000`. The optional input callback at `0x5fa560`, which
must start as zero, consequently contained bytes `a6 39 ac 39`. PE section
mapping now uses `max(VirtualSize, SizeOfRawData)` as the committed extent but
zero-fills uninitialized/no-file-backing sections. A synthetic Watcom-style BSS
regression locks this behavior down.

With correct BSS state, Fallout requested `VirtualProtect` on its own code
range `0x004aa97c..0x004b0e8c`. Wasm linear memory already has the effective
read/write/execute capability required by this interpreter, so the handler now
validates the call, reports the prior effective protection, and succeeds; no
guest instructions are skipped. The resulting run performs hundreds of
primary-surface lock/unlock operations, palette updates, DirectInput polls, and
file reads, then renders the outdoor demo map with the player character and
live HUD. Evidence images are:

- `/private/tmp/fallout-vp-final.png` — the rendered outdoor starting map;
- `/private/tmp/fallout-play-before.png` — repeat run at the same interactive
  gameplay state;
- `/private/tmp/fallout-play-after.png` and
  `/private/tmp/fallout-play-late.png` — the held mouse action was delivered and
  advanced the game into a normal fade/loading-cursor transition.

The full WAT build, handler count/ESP checks, AAM/PIT/ENTER focused execution,
PE FirstThunk+BSS regression, and cross-instance sparse-map regression all
pass. The measured Fallout startup is file/decompression and asset setup into
guest memory plus DirectDraw surfaces; it completes. It was not a permanent
decompression hang.

## Browser debug-launch follow-up

Diablo, StarCraft Shareware, and the Fallout demo are now all present in the
`?debug` app selector. Fallout launches from the original extracted demo
distribution, fetches `Falldemo.dat`, creates its 640x480 DirectDraw surface,
and renders the native main menu in Chromium. A trusted held Enter advances
through New Game and the Max Stone equipment screen; after the bounded load,
`/private/tmp/fallout-browser-character-confirm.png` captures live outdoor
combat with the player and NPC sprites, floating dialogue, hit messages, and
the weapon/AP/HUD controls. This establishes browser gameplay, not only menu
rendering. Earlier browser stages remain at `/private/tmp/fallout-browser.png`
and `/private/tmp/fallout-browser-enter-held.png`; native-emulator gameplay and
accepted-input evidence remains `/private/tmp/fallout-play-before.png`,
`/private/tmp/fallout-play-after.png`, and `/private/tmp/fallout-play-late.png`.

StarCraft uses the tree produced by its original native installer, copied into
the ignored local candidate directory
`test/binaries/candidates/starcraft-shareware/installed/`. The browser mounts
the installed files both at `C:\\` (the layout of the successful compatibility
run) and at `C:\\Program Files\\Starcraft Shareware\\` (the path written by the
installer), and seeds the install registry values before launch. The app
command line remains `ophelia terran1 nosound`.

The first browser manifest omitted the CD's 163,820,728-byte `Install.exe` and
reliably reached StarCraft's own **Data File Error** dialog. Static strings in
the exact shareware executable include root-relative `\\Install.exe` beside
`StarCD`; the successful native run had that file mounted at the drive root.
The corrected manifest therefore mounts the original CD file as
`C:\\install.exe` rather than bypassing the check. Its SHA-256 is
`8c8855f29d1fb3265727021381d82bf35555a736a27896d9f159c3f34bebe0a8`.

With that correction Chromium renders the genuine StarCraft Shareware title,
advances through its loading screen to the animated main menu, accepts a held
browser click on **Single Player**, and creates the native `codex` player
profile. Evidence images are:

- `/private/tmp/starcraft-browser-with-cd.png` — corrected CD mount reaches the
  shareware title instead of the data-file dialog;
- `/private/tmp/starcraft-browser-multiskip.png` — fully rendered interactive
  main menu;
- `/private/tmp/starcraft-browser-campaign.png` — held browser click reaches
  the Single Player registry/name dialog;
- `/private/tmp/starcraft-browser-briefing.png` — typed profile created and
  returned in the native registry list;
- `/private/tmp/starcraft-browser-terran.png` — Terran mission briefing with
  objectives and the live Start button;
- `/private/tmp/starcraft-cursor-coalesce-before.png` and
  `/private/tmp/starcraft-cursor-coalesce-after.png` — genuine first-mission
  map and StarCraft Tips dialog before and after a ten-position browser cursor
  burst.

The latter run establishes browser gameplay: the emulated game has loaded the
first Terran map, units and HUD and is waiting at its in-game Tips dialog. It
also exposed a browser-input fidelity problem. Native Windows coalesces pending
`WM_MOUSEMOVE` messages, but the renderer retained every browser pointer
sample. StarCraft draws a software cursor into its sole canonical 640x480
DirectDraw primary surface, so replaying a large backlog made it paint obsolete
cursor positions and appear to leave trails. The renderer now replaces only an
adjacent pending move for the same HWND, button state, and target. Mouse button
edges, target crossings, and drag transitions remain ordering barriers. In the
live verification, ten input positions produced one queued move, the queue
drained to zero, and the final frame contained one cursor. The apparent dark
lower bands are already present in StarCraft's canonical primary DIB rather
than being Safari canvas retention; they are the dark 1998 game HUD regions,
not additional browser cursor copies.

A later live Chromium gameplay probe reproduced the reported intermittent
white/grey blink as a precise one-refresh swap to solid RGB `192,192,192`.
Nine such frames appeared in a 30-second gameplay sample, each followed by a
normal DirectDraw frame. Attachment tracing identified the solid color as the
canonical 32-bit GDI window surface (`0x610001`), whose untouched pixels are
initialized to Win98 `COLOR_BTNFACE`, temporarily replacing StarCraft's 8-bit
DirectDraw primary (`0x200002`). The trigger was not an asynchronous canvas
blit: repeated `GetDC(hwnd)` probes reattached the GDI backing even when no GDI
pixels were written. Window-DC acquisition no longer changes the presented
surface; the GDI backing is reattached only when a raster operation uploads
real changed pixels.

The rebuilt browser run repeated the same scripted mission start and sampled
1,846 displayed frames over 30 seconds of active gameplay. It observed zero
solid-grey frames (versus nine before the change), and every attachment in the
sample was the DirectDraw primary. The final unobstructed gameplay capture is
`/private/tmp/starcraft-no-flash-gameplay.png`.

## GOG zero-price classic-game installers

Verified 2026-08-25 against GOG's official product pages. The following seven
games in the Internet Archive
[`gog_collection`](https://archive.org/details/gog_collection) item were listed
by GOG at **USD 0.00** and tagged as free games when they were added to the
local candidate corpus:

- [Beneath a Steel Sky](https://www.gog.com/en/game/beneath_a_steel_sky):
  `beneath.a.steel.sky.rar`, 91,327,768 bytes, SHA-1
  `dee0ca140e5d8cea0738c7f0f9bba2b970ad8f44`; extracts
  `setup_beneath_a_steel_sky_1.0_(20270).exe`.
- [Flight of the Amazon Queen](https://www.gog.com/en/game/flight_of_the_amazon_queen):
  `flight.of.the.amazon.queen.rar`, 140,413,462 bytes, SHA-1
  `5381b63e357f91ef78050a5880c6020d2bc2d630`; extracts
  `setup_flight_of_the_amazon_queen_1.0_(20270).exe`.
- [Lure of the Temptress](https://www.gog.com/en/game/lure_of_the_temptress):
  `lure.of.the.temptress.rar`, 26,465,516 bytes, SHA-1
  `8a0ff33dbd94ebfbf8d4edd979c5fee7c3985b2f`; extracts
  `setup_lure_of_the_temptress_1.0_(20270).exe`.
- [Shadow Warrior Classic Complete](https://www.gog.com/en/game/shadow_warrior_complete):
  `shadow.warrior.rar`, 241,578,512 bytes, SHA-1
  `92f1c925d235c3176ab4c21b6f1f0461b1b602c8`; extracts
  `setup_shadow_warrior_complete_2.0.0.7.exe`.
- [The Elder Scrolls: Arena](https://www.gog.com/en/game/the_elder_scrolls_arena):
  `the.elder.scrolls.1.arena.rar`, 81,068,818 bytes, SHA-1
  `aa8f357433ea5c07a9ebda4c6dd062b53348f57b`; extracts
  `setup_the_elder_scrolls_arena_1.07_(28043).exe`.
- [The Elder Scrolls II: Daggerfall](https://www.gog.com/en/game/the_elder_scrolls_chapter_ii_daggerfall):
  `the.elder.scrolls.2.daggerfall.rar`, 184,129,634 bytes, SHA-1
  `05276866d94746987a56617b708fa6eb4653359b`; extracts
  `setup_the_elder_scrolls_ii_daggerfall_1.07_(28043).exe`.
- [Ultima IV: Quest of the Avatar](https://www.gog.com/en/game/ultima_iv_quest_of_the_avatar):
  `ultima.4.quest.of.the.avatar.rar`, 12,548,654 bytes, SHA-1
  `a75b5a57226650c47fe8f8cdb0872c8289da1cf7`; extracts
  `setup_ultima_iv_-_quest_of_the_avatar_1.0_cs_(28045).exe`.

All seven RAR hashes match the values recorded by the Archive item, and each
RAR contains one PE32/i386 GOG offline installer. The exact URLs, hashes,
installer versions, and filenames are pinned in
`test/candidate-corpus/manifest.json`; `tools/fetch-candidate-corpus.js`
downloads, verifies, and extracts them beneath the gitignored
`test/binaries/candidates/gog-free-*` fixture directories.

"Free on GOG" describes the store price and acquisition path, not a public
domain or open-source license. These remain proprietary packages unless their
individual rights holders say otherwise, and a zero price does not by itself
grant permission to redistribute the GOG installers. They therefore remain
local research fixtures and must not enter a public deployment merely because
GOG offered them without charge or Archive.org hosts copies.

### Local runtime acceptance status (2026-08-29)

All seven downloads contain PE32/i386 Windows installers. The installed game
payloads are not all native Windows games: Beneath a Steel Sky, Flight of the
Amazon Queen, and Lure of the Temptress use GOG's bundled Windows ScummVM;
Shadow Warrior, Arena, Daggerfall, and Ultima IV use GOG's bundled Windows
DOSBox to host the original DOS game. The launch checks below execute those
Windows runtimes directly inside Wine-Assembly. They do not use host Wine or
DOSBox-X.

The local screenshot set is
`/private/tmp/free-gog-screenshots.EC8yad`. Six numbered frames have been
visually checked as actual gameplay rather than logos, menus, installers, or
load selectors:

| Game | Verified local frame | Content |
|---|---|---|
| Beneath a Steel Sky | `1-beneath-a-steel-sky.png` | playable industrial opening scene |
| Flight of the Amazon Queen | `2-flight-of-the-amazon-queen.png` | Joe's bedroom with the verb/inventory UI |
| Lure of the Temptress | `3-lure-of-the-temptress.png` | player-controlled dungeon cell |
| Shadow Warrior Classic Complete | `4-shadow-warrior.png` | first-person combat in Wang's bar |
| The Elder Scrolls: Arena | `5-elder-scrolls-arena.png` | first-person city view with live HUD |
| Ultima IV | `7-ultima-iv.png` | overhead world-map gameplay with party/status UI |

Daggerfall is the remaining handoff item. The bundled GOG DOSBox dynamic core
now reaches character creation, and a deterministic physical-input script has
been visually verified through exhausted attribute and skill bonus pools,
reflex selection, and final review. The first full capture attempt clicked
`(60,204)` on that last page; the drawn OK button is actually at `(284,204)`,
so its five nominal gameplay frames remained identical to final review. The
corrected sequence is preserved by `tools/run-daggerfall-gameplay.js`; a
partial handoff retry reached attribute allocation batch 12,770 before it was
stopped to wrap and commit this state. Until a complete retry produces a
first-person dungeon frame,
`6-elder-scrolls-daggerfall.png` must not be presented as gameplay.

## Further shareware/demo/freeware game candidates

Research on 2026-08-22 narrowed the next browser targets to distributions that
were released as demos or shareware. Entries in this file identify and link to
the original distributions; Wine-Assembly can download and run those packages
without republishing them. A playable demo is therefore a valid target even
when its terms do not grant redistribution, unless those terms explicitly
prohibit the project's method of obtaining or running it.

### Little Fighter 2 v1.9 freeware

The exact 12,669,116-byte `lf2_v19.exe` archived at
[Archive.org](https://archive.org/details/lf2_v19) is pinned as
`little-fighter-2-installer` with SHA-1
`708c6be6dc4a195c1011fde480157862c60fbdee`. The unchanged Win32 installer now
completes under Wine-Assembly and its installed game reaches interactive
three-fighter VS combat. See
[`docs/re-notes/little-fighter-2.md`](docs/re-notes/little-fighter-2.md) for the
installer route, hashes, DirectDraw fix, and frozen gameplay gate.

The [official LF2 introduction](https://www.lf2.net/en/intro.html) describes
the game as freeware, and the [official FAQ](https://www.lf2.net/faq_en.html)
confirms that the authors intended it to be free to play. The package readme
still says **All rights reserved**, and no inspected official page expressly
permits redistribution. Keep both the installer and prepared game payload
local/gitignored; freeware status permits this compatibility target under the
candidate policy but does not clear it for public deployment.

### Pocket Tanks v1.6 shareware

The official [Pocket Tanks page](https://classic.blitwise.com/pockettanks.html)
offers the shareware edition, and its direct
[`ptanks.exe` download](https://classic.blitwise.com/ptanks.exe) is pinned as
`pocket-tanks-installer`. The package has SHA-1
`1f10dd5830eecf117bc10daf7e85d29f364dbdc2` and SHA-256
`a3d7da899ab2d3cdd33c6b10747478628175c5a5e0c215eb43a629e6cf98c982`.

Wine-Assembly runs the unchanged bootstrap and the Inno Setup child it creates,
then launches the installed game into Target Practice. See
[`docs/re-notes/pocket-tanks.md`](docs/re-notes/pocket-tanks.md) for the exact
guest-only installer route and frozen gameplay gate. Keep the installer and
installed payload local/gitignored unless its package terms are separately
confirmed to authorize public bundling; the official shareware label does not
make the game open source.

### Icy Tower v1.3.1 freeware

The exact 2,647,172-byte installer from the
[Icy Tower Archive item](https://archive.org/details/Icy_Tower) is pinned as
`icy-tower`, with archive SHA-1
`21aa4fb949c5f0718a59f922df6ad644a80e6715` and installer SHA-256
`e8a6ddc8a11d49b1e68484f725afc9204d9d15e0bf6cf90f0b14f0d1c9d24302`.
The unchanged bootstrap and its generated Inno child now complete inside
Wine-Assembly, and the installed game reaches moving tower gameplay. See
[`docs/re-notes/icy-tower.md`](docs/re-notes/icy-tower.md).

The installed readme calls Icy Tower freeware and expressly encourages copying
the game in its original form, provided Free Lunch Design receives credit and a
site link. It separately forbids inclusion in commercial compilations or
packages without the author's permission. Preserve the original package and
those conditions for any public distribution; the extracted local browser
payload remains gitignored.

Recommended order:

1. [Jazz Jackrabbit 2 Demo v1.23s](https://archive.org/details/JazzJackrabbit2Demo)
   is now a completed target. The Archive item identifies it as a 1998
   Windows action-game demo, provides a 19.2 MB Windows executable, and says it
   contains three single-player levels including a boss plus multiplayer maps.
   The exact `J2swc123.exe` package and SHA-1 are already pinned in
   `test/candidate-corpus/manifest.json`, so acquisition is reproducible. Its
   unchanged installer now completes and the installer-produced game reaches
   animated Darn Ratz gameplay; see
   [`docs/re-notes/jazz2-demo.md`](docs/re-notes/jazz2-demo.md).
2. [RollerCoaster Tycoon Demo](https://archive.org/details/RollercoasterTycoonDemo)
   is a 1999 Windows demo delivered as the single 18.7 MB `RCTYCOON.EXE`.
   Archive.org describes a roughly 25-minute playable session with saving,
   most scenarios, some rides, and ride music disabled. It is a useful change
   from action games: dense GDI/DirectDraw UI, timers, simulation, and mouse
   interaction matter more than twitch input.
3. [Worms 2 Demo](https://archive.org/details/Worms2_1020) is a 1998 Windows
   action/strategy demo in a 13.6 MB Archive item. Turn-based local play makes
   it forgiving of emulator speed while still exercising destructible 2D
   graphics, sound, keyboard, and precise mouse input.
4. [Total Annihilation Demo](https://archive.org/details/TotalAnnihilation_201405)
   is a 1997 Windows strategy-game demo offered as a 20.6 MB item with a direct
   Windows executable download. It is a strong later stress target for large
   scrolling battlefields, many animated units, audio, and sustained RTS
   simulation, but is likely heavier than Jazz, RollerCoaster Tycoon, or Worms.
5. [Captain Claw Demo](https://archive.org/details/CaptainClaw) and
   [Heroes of Might and Magic II Demo](https://archive.org/details/HeroesofMightandMagicIITheSuccessionWars_1020)
   remain good alternates already researched above. Claw is the more immediate
   action target; Heroes II is slower-paced but brings WinG, Miles, and Smacker
   DLL coverage.

[Warcraft II: Tides of Darkness Demo](https://archive.org/details/WarcraftIiTidesOfDarknessDemo)
is intentionally not ranked as a Wine-Assembly game target. Although the item
is tagged as a Windows game and includes Win32 autorun/map-editor programs, its
35.6 MB `war2sw108.zip` contains a DOS4GW `setup.exe` and the playable
`war2.exe` compressed inside `war2.exa`; only `war2ed95.exe` and the autorun
shell are PE32. It is therefore primarily a DOS-game package rather than the
Win32 executable this emulator needs.

### 2026-08-22 native-installer bring-up results

RollerCoaster Tycoon was already present as the `rct` debug app, so it remains
the baseline rather than a new registration. The other candidate packages were
downloaded into ignored `test/binaries/candidates/` directories and exercised
through their original installers before using any extracted game files.

- Jazz Jackrabbit 2 uses the pinned `J2swc123.exe`. Its InstallShield wizard
  now renders all five original property-sheet pages, accepts **No, continue
  without DirectX 5**, and completes the unchanged package's extraction dialog.
  It exits normally through its own completion message and writes all 53 files
  and shortcuts under `C:\\Games\\Jazz2Sw`. Launching the installer-produced
  `jazz2.exe` reaches distinct animated Darn Ratz gameplay frames.
- Worms 2 was ultimately installed from Team17's smaller October demo archive,
  `Worms2Demo10Oct.zip` (7,299,379 bytes; SHA-256
  `c65d36cef69437f066a3d50d8ff26d43d228a0595d7bcc106d541375e1d3cfd8`).
  The original Win16 InstallShield bootstrap expanded and ran its native
  32-bit engine; fixing `IsWindow(HWND_BROADCAST)` to reject the `0xFFFF`
  sentinel let that unchanged bootstrap finish, and three ordinary **Next**
  clicks completed the install to `C:\\Team 17\\Worms 2 Demo`.
- Total Annihilation is the direct `Total Annihilation.exe`. The native
  self-extractor calls `FindResourceA` with string-form integer names `#130`,
  `#135`, and `#136`; these correspond to numeric `ADD` resources containing
  `TADemo.hpi` (20,474,804 bytes), the readme (24,279 bytes), and `TADemo.exe`
  (809,984 bytes). Supporting the documented `#decimal` resource spelling
  exposed a second general bug: the 21,540,864-byte PE exceeded the fixed 8 MB
  staging buffer, and the loader copied the unstaged `.rsrc` tail as zeroes.
  Prehydrating mapped section tails now makes the unchanged native installer
  produce a valid PE (`216e4f39617cb979cd2bc1fba92e9e5136b33a98790d9fc6d3d1cb901ecfbb57`)
  and HPI (`fd53a2637ecf8fb5ca6d2c02a34b4ef783a4441f8be070137276afc4d5627e1e`).
  Game startup then exposed a VFS enumeration error: `palettes\\*` against a
  missing directory fell back to the drive root and recursively invented paths
  such as `palettes\\program files\\program files`. Broad wildcards in missing
  directories now fail normally. TA now completes that initialization, renders
  its title and campaign menus, loads the first Arm mission, and reaches the
  live battlefield through the registered installer-produced payload. See
  [`docs/re-notes/total-annihilation-demo.md`](docs/re-notes/total-annihilation-demo.md).
- Captain Claw is the direct 11,275,313-byte `claw_demo.exe`. Its original
  InstallShield self-extractor runs from 1% through 99% and yields a complete
  10,689,596-byte `data.z`, 185,356-byte `_setup.lib`, and the native Win16
  `setup.exe`. The Win16 bootstrap expands the original 674,304-byte 32-bit
  InstallShield engine; running that engine with its native companions reaches
  the Claw wizard and copies the demo to `C:\\GAMES\\CLAWDEMO`.

### 2026-08-22 Worms 2 October demo gameplay

The completed native install contains `worms2demo.exe` plus `worms2.dat`, the
terrain/graphics/level archives, and 136 installed effect and speech WAV files.
Despite its extension, `worms2.dat` is the actual PE32 game. Static and runtime
tracing show that `worms2demo.exe` is only a promotional carousel: a click
posts `WM_CHAR`, enters its `_spawn` implementation, and calls
`CreateProcessA("worms2.dat", ...)`. Since Wine-Assembly intentionally has a
single-process browser model, the debug manifest launches that exact installed
PE directly instead of emulating a second process solely for the wrapper.

An unchanged direct run finished the native loading sequence and entered the
playable two-player medieval demo match. Captures at batches 50,000, 100,000,
150,000, and 199,000 show different live worms (`Fudge`, `Nadger`, `Knuckle`,
and `Woodbine`), turn arrows, moving camera/cursor, health, and changing turn
timers. The first gameplay evidence is
`/private/tmp/w2-direct-50k.png`; the later sustained-gameplay capture is
`/private/tmp/w2-direct-199k.png`.

The shared `worms2_demo` app manifest was then exercised through the actual
Chromium page, not only the CLI host. After loading the same installed files,
the browser reached the live match and changed the game canvas in 16 of 17
one-second probes over a 15-second sample, with no runtime error or long task.
The inspected browser capture is `/private/tmp/w2-browser-gameplay.png`.
- Heroes II is the direct `h2demo.zip` (SHA-1
  `f324b626e69a6e087364be5f69e5dd13dde814d2`), which is already a ready-to-run
  demo rather than an installer. `H2DEMOW.EXE` creates its real game window, then
  stops at the unimplemented Miles export `_AIL_startup@0`. The executable's
  own command-line help advertises `/D0`, `/M0`, and `/R0`; these disable the
  respective sound systems after startup, but do not bypass that initial call.
  A two-call diagnostic substitution established that the only Miles calls
  made in this mode are zero-argument `_AIL_startup@0` and periodic
  `_AIL_serve@0` housekeeping. With both returning normally, the original demo
  renders its main menu, accepts **New Game**, opens the **Standard Game**
  configuration, and reads `MAPS\\BROKENA.MP2` for the playable Broken Alliance
  scenario. This proves the 42 MB `DATA\\HEROES2.AGG` VFS mount is intact and
  makes Heroes II the first newly playable candidate from this round. A final
  Chromium run through the real `heroes2_demo` web manifest clicked **New
  Game**, **Standard Game**, and **Okay** and reached the interactive adventure
  map with the castle, hero, minimap, and command panel rendered. Evidence is
  `/private/tmp/heroes2-browser-gameplay.png`; the untouched executable also
  rendered through the CLI manifest at `/private/tmp/heroes2-unmodified-app.png`.
  A subsequent untouched run loaded the archive's real `MSS32.DLL` and
  `SMACKW32.DLL` with only `/R0` (Red Book CD audio) disabled. Both DLL entry
  points completed successfully and the Miles runtime emitted 240
  `midiOutShortMsg` calls during 300 execution batches, proving that Heroes II
  music reaches the emulator's existing WinMM MIDI path without a replacement
  Miles implementation. The web manifest therefore seeds both bundled DLLs and
  no longer passes the `/D0` digital-audio or `/M0` MIDI-disable switches.
  A later adventure-map trace identified the repeating-effect defect precisely:
  Miles creates a 32,768-byte mono 8-bit DirectSound software-mixer ring at
  22,050 Hz and starts it looping, then continuously rewrites it through
  `IDirectSoundBuffer::Lock`/`Unlock`. The browser host had decoded the ring only
  once at `Play`, so its first 1.486 seconds repeated even after Miles mixed
  silence or a replacement effect. Looping-buffer `Unlock` now copies the guest
  PCM into the existing Web Audio buffer without replacing its source or moving
  its play cursor. In a rebuilt Chromium run, three observed refreshes preserved
  source identity and each changed the ring RMS to zero; the adventure map stayed
  live at 60.1 fps. Evidence is `/private/tmp/heroes2-audio-refresh.png`.
  That refresh fixed buffers Miles explicitly clears, but a live gold-pickup
  reproduction exposed a second case: Miles starts both ambient rings and
  fixed-size one-shot allocations with `DSBPLAY_LOOPING`. The gold allocation
  held audible PCM through frame 20,372 of 32,768, followed by 12,395 frames of
  exact unsigned-8-bit silence; looping the allocation repeated the pickup every
  1.486 seconds even though no later `Unlock` or `Stop` was issued. The host now
  treats a looping allocation whose final eighth or more is exact PCM silence as
  a one-shot. In the rebuilt Chromium run, the full-ring ambience remained
  looped while the gold voice ended naturally and cleared its active source.
  Evidence is `/private/tmp/heroes2-gold-no-repeat.png`.
  A follow-up route collected both nearby gold piles and then entered the
  castle, exposing a distinct lifecycle error rather than another PCM-tail
  classification problem. Miles did issue `IDirectSoundBuffer::Stop` for every
  explicit map loop at the scene transition, and the host stopped all of those
  Web Audio sources. However, `IDirectSoundBuffer::GetStatus` was backed only by
  the flags recorded at `Play`, so a source that ended naturally still reported
  `DSBSTATUS_PLAYING` forever. The stored loop bit was also `0x2`, which is
  `DSBSTATUS_BUFFERLOST`; the real `DSBSTATUS_LOOPING` value is `0x4`. Status now
  queries the live Web Audio voice, clears playing/looping after `onended`, and
  uses `PLAYING|LOOPING == 0x5` consistently for Play and Unlock. In the rebuilt
  Chromium route, the pickup effects ended, the map ambience remained active
  only while appropriate, and the castle transition left every DirectSound
  voice inactive. Evidence is `/private/tmp/heroes-audio-stop-fixed.png`.

### 2026-08-22 Total Annihilation DirectSound3D bridge

The installed demo imports only `DirectSoundCreate` from `DSOUND.dll`; its
local payload contains no redistributable `dsound.dll`. A stock DirectSound
runtime would therefore replace the emulator's existing browser-audio COM
objects rather than wrap them, while also bringing its Windows driver-facing
dependencies. The bounded compatibility path is an auxiliary
`IDirectSound3DBuffer` view over the existing DirectSound buffer and voice.

The [W3C Web Audio specification](https://www.w3.org/TR/webaudio-1.1/)
defines `PannerNode` source positions, orientations, inverse/linear/exponential
distance models, reference and maximum distances, directional cones, and HRTF
stereo rendering. MDN records the
[`PannerNode.panningModel`](https://developer.mozilla.org/en-US/docs/Web/API/PannerNode/panningModel)
API as widely available and distinguishes the efficient `equalpower` model
from HRTF convolution. These primitives map the demo's observed
`SetPosition`, `SetMinDistance`, `SetMaxDistance`, and `SetMode` calls to real
browser spatialization rather than successful no-ops.

The emulator now publishes the complete 21-slot `IDirectSound3DBuffer` COM
vtable. Querying IID `{279AFA86-4981-11CE-A521-0020AF0BE560}` returns a stable
auxiliary wrapper for the same buffer and opens its host voice before the game
sets 3D properties. The host routes that voice through an HRTF `PannerNode`,
mirrors DirectSound's +Z-forward convention to Web Audio's -Z-forward
convention, maps minimum/maximum distance to `refDistance`/`maxDistance`, maps
cone direction and attenuation, and restores the ordinary stereo route for
`DS3DMODE_DISABLE`. Float values cross the WAT import boundary losslessly as
their raw IEEE-754 bits, and all getters return the retained DirectSound-space
values.

Focused host, vtable-contiguity, stack-pop, and worker-vtable synchronization
tests pass, as does the full WAT build. An unchanged run of the extracted
`tademo.exe` plus `tademo.hpi` advances beyond the former 3D-vtable stack
corruption and reaches its next independent missing Win32 call,
`IsCharAlphaA`, at guest EIP `0x0047731d` (batch 665). This proves the four
observed 3D calls return through the correct COM layout without corrupting the
stack. A browser trace then confirmed that same next stop at `0x0047731d` was
the one-argument USER32 `IsCharAlphaA` import, not a hang. The implementation
now reuses the existing ANSI `C1_ALPHA` classifier and consumes the promoted
byte argument with the correct stdcall frame. With that API present, the
unchanged web manifest creates and shows the 640x480 "Total Annihilation"
window and remains live through 1,200 execution batches (874 API calls), past
the former batch-665 failure.

On 2026-09-03 the same installer-produced payload was driven beyond startup
with the frozen stdin CLI. It rendered the title menu, accepted **Single
Player** -> **New Campaign** -> **Arm**, displayed mission `10001ARME`, and
entered the live battlefield with units, terrain, minimap, and metal/energy
HUD. `test/test-total-annihilation-candidate.js` now preserves that route and
requires a Right-arrow battlefield scroll to change more than 5,000 pixels.
The same test reruns the native self-extractor first and verifies that its
fresh EXE and HPI match the pinned hashes. This supersedes the earlier
window-only status. The embedded EULA permits no-fee copying/distribution only
with its notice and other stated conditions. That clause is not an inclusion
blocker: the Sources entry links to the original distribution, and the emulator
runs its installer rather than distributing either the installer or extracted
runtime files.

### 2026-08-22 Caesar III demo

The sixth compatibility target is the [Caesar III Demo Archive.org item](https://archive.org/details/CaesarIiiDemo),
published by Sierra On-Line / Impressions Games in 1998. Archive.org's metadata
identifies the original Windows executable as `caesar3.exe`, 25,035,493 bytes,
with SHA-1 `0f342a7722a0819bcfb225d51148ceb3c8f309d5` and MD5
`2b13991ed623eab12e1161deafde8983`. The locally downloaded file matches all
three values exactly and is a 32-bit i386 Windows GUI PE.

The file is a ZipMagic self-extracting archive rather than the game executable.
An unchanged emulator run reaches its native **Caesar 3 Demo** extraction
window, whose own text says that it will extract the payload and launch Setup.
That wrapper produces the original Win16 `setup.exe`; running it in the emulator
then produces and invokes the 547,840-byte native InstallShield engine
`_ins5176._mp` with the bundled `setup.ins` and cabinets.

The installer originally chose `A:\\SIERRA\\CAESAR3DEMO` because the emulator's
`GetDriveTypeA/W` helper incorrectly reported every non-CD letter as a fixed
disk. Windows 98 exposes only fixed `C:` and CD-ROM `D:` here; returning
`DRIVE_NO_ROOT_DIR` for the other letters makes the untouched wizard select
`C:\\SIERRA\\CAESAR3DEMO` and proceed through its DirectX notice, WAV system
test, destination page, Sierra utility copy, and game-data expansion.

The resulting `c3.exe` is 1,343,488 bytes with SHA-256
`d7c73f21d3837b1fc465a6035f4fea6ab5a7eddf62907c72c4dd076a5193d236`.
The native run produced 113 cabinet payload files byte-for-byte identical to a
direct InstallShield-cabinet verification; the bounded diagnostic run stopped
while writing its final 5.5 MB narration file, so the checked launch payload
uses the same cabinet's complete `Wavs/rome1.wav` (5,544,566 bytes, SHA-256
`0be017cae367622e1e5e15548b383f58f4abd8a7af6fd2fd1130f7d207aece1a`)
rather than preserving that interrupted partial write. The debug launcher now
starts this untouched installed `c3.exe`, loads its bundled `SMACKW32.DLL`, and
mounts the full 112-file data/sound manifest at the paths used by the game.

A direct current-emulator launch creates the 800x600 Caesar III DirectDraw
surface and renders the Sierra/Caesar title sequence. Its long first transition
is real progress rather than a deadlock: the executable performs a software
RGB555-to-RGB565 conversion over the whole surface one pixel at a time, then
leaves that loop and enters its normal message pump.

The installer-produced payload now has a frozen-stdio acceptance route through
the Caesar III title, **Start new game**, governor-name entry, the **Assignment
1 - Aventine / The Birth of a City** briefing from `mission1.pak`, **To the
city**, and the live 800x600 city simulation. The final frame contains the
green terrain map, stone control panel, minimap, resources, and construction
controls rather than a menu or loading frame.

The demo initializes its 32-byte name capture buffer with `The new governor`
but leaves its overwrite cursor at byte zero, so a short typed name retains the
old suffix (`Codexew governor`). A verified load-time compatibility patch for
this exact `c3.exe` skips that one default copy and clears the buffer before the
game starts capture. The installer-produced executable remains unchanged on
disk; subsequent typing, drawing, and mission state are the game's own. See
`docs/re-notes/caesar3-demo.md` and `test/test-caesar3-gameplay.js`.

### 2026-08-23 Captain Claw demo gameplay

The original Captain Claw self-extractor and both native InstallShield stages
now complete without substituting a third-party repack. The final wizard copies
the following gameplay payload to `C:\\GAMES\\CLAWDEMO`:

- `clawdemo.exe`: 1,227,776 bytes, SHA-256
  `16021c5b6c5566650af364edd6468f1384e19de5d0941346858d564c7a361376`
- `clawdemo.rez`: 16,414,408 bytes, SHA-256
  `7e9da15bfbeca783f638e2162d2f1184046d6ef0d9c2546f811f3c65089af97c`
- bundled `mss32.dll`: 159,232 bytes, SHA-256
  `cc7e8d381b21049175ff25f2f628347718df7c8070661dfb31ec4c71fc47ab85`

The game must load that bundled Miles DLL as native code; merely mounting it as
a VFS file leaves `_AIL_startup@0` unresolved, while loading the original DLL
runs its `DllMain`, starts its worker thread, and advances normally. Registry
tracing proves that the installed game reads `Skip Joystick Calibration Test`
and `Skip Title Screen` from
`HKLM\\Software\\Monolith Productions\\Claw Demo\\1.0`; the debug manifest
sets those documented advanced options so a one-process browser launch reaches
the main menu without replaying startup calibration and movies.

The shared `captain_claw_demo` manifest reaches **Demo Level #1 — La Roca** in
the CLI host. Holding the real DirectInput right-arrow state moves Claw and
scrolls the level camera from the initial cell into the next room; the inspected
post-movement capture is `/private/tmp/claw-after-right.png`. The same manifest
was then launched through the actual Chromium page, clicked through **Single
Player**, and remained in animated gameplay for a 15-second sample. The canvas
changed in 16 of 17 one-second probes with no runtime error or browser long
task; the inspected browser capture is
`/private/tmp/claw-browser-gameplay.png`.

### 2026-09-04 Captain Claw frozen gameplay regression

The installer-produced runtime files above still match their recorded SHA-256
values. A dedicated low-load headless regression now runs the registered app in
one frozen stdio-controlled CLI process with its internal wall-clock guard. It
selects **Single Player**, reaches **Demo Level #1 - La Roca**, holds the real
DirectInput right-arrow state, and verifies that Claw and the level camera move.
Fresh manually inspected captures are `/private/tmp/claw-before.png` and
`/private/tmp/claw-after.png`; see `docs/re-notes/captain-claw-demo.md` for the
repeatable command and visual acceptance criteria.

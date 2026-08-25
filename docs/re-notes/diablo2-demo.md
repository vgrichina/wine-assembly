# Diablo II Shareware demo

## Package and installer

The local package is Blizzard's `DiabloIIDemo.exe`:

- size: 138,309,685 bytes
- SHA-256: `89352716523e474514553e2092a1ae9349c5c7ff9e79c7861dd65fe19be88b61`

`test/test-diablo2-demo-installer.js` drives setup without fixed-batch dialog
timing. It waits for `Diablo II Shareware Setup`, clicks the launcher's Install
button, waits for each real InstallShield control, accepts the default path,
and reaches the shortcut/copy phase. A full acceptance run continued through
the 127 MiB copy. The worker finished after about 205 seconds; the outer setup
window remained on `Adding shortcuts to the start menu..`, but the complete
installed payload was present in the VFS. The retained acceptance screenshot
is `/private/tmp/diablo2-installer-complete.png`.

Saving that VFS exposed a host-export collision: setup creates both the file
`C:\support\images\msproxy` and descendants below a directory with that name.
`lib/vfs-export.js` now preserves the file as `msproxy.__vfs_file__` rather
than failing the whole export. `test/test-vfs-export.js` pins that behavior.

The installer-produced payload is staged locally under
`test/binaries/candidates/diablo-2-demo-installer/installed-extracted/`. Its
core pins are:

| File | Size | SHA-256 |
| --- | ---: | --- |
| `diablo ii.exe` | 2,154,496 | `d0aa0d30b55f8313e04026cca560ef0d178ee76b2ece6c3ccdc1fca4af46b3f1` |
| `d2data.mpq` | 44,301,122 | `82ed65b7f574234a22a36abb4a6d6a1e7f8bebc4746192f39cdb6603ee382d49` |
| `d2music.mpq` | 32,743,265 | `631172d59cc4a8d9b42faade73b194140b6a327811ea556562df9c89f857a694` |
| `storm.dll` | 266,280 | `2b6a27f223aac30d2d383f185705be55f43f37a687aa76ebe307a1035b6eea2d` |

## Registry evidence

The raw captures remain under `/private/tmp` and are not corpus fixtures.
Relative to a clean profile, setup wrote:

- `HKCU\Software\Battle.net\Configuration`, `Server List` = `exodus.battle.net`
- `HKLM\SOFTWARE\Battle.net\Configuration`, `Server List` = `exodus.battle.net`

A clean installed-game launch reaches the menu without pre-seeding either
key. The game itself creates
`HKCU\Software\Blizzard Entertainment\Diablo II Shareware` with:

- `CmdLine` = `ii.exe -skiptobnet`
- `InstallPath` = `C:\`
- `UseCmdLine` = DWORD `0`

It also probes `CompressedData` and preference values, but none is required to
launch this package.

## Compatibility fixes

The installed executable and its DLL graph exposed three concrete gaps:

1. CRTDLL `_vsnprintf` was missing. The bounded formatter now returns `-1`
   without a terminator on truncation, matching the Win9x CRT contract.
2. D2Sound imports authentic Win98 DSOUND ordinals 1 and 2. They now resolve
   to `DirectSoundCreate` and `DirectSoundEnumerateA`.
3. The original 64-entry synchronization table filled during startup. Storm's
   later transient `CreateEventA` returned NULL, so a one-byte MPQ member
   (`data\local\use`) reported `ERROR_HANDLE_EOF` and the game stopped in
   `Archive.cpp` line 143. A 256-entry diagnostic build showed startup fill
   every slot through `e00ff`; the final 512-entry/8 KiB table leaves space
   for the fixed pool and streaming events. The same run then read all MPQs,
   initialized DirectDraw and sound, and rendered the main menu.

The final installer-produced game screenshot is
`/private/tmp/diablo2-installed-sync512.png`: an 800x600 DirectDraw frame with
the animated Diablo II logo, Single Player button, Shareware v1.04 label and
Exit Diablo II button. `test/test-diablo2-demo-installed.js` reproduces this
from a clean profile, skips the intro with normal keyboard input, pins the
EXE/data archives, and validates those menu regions.

One non-fatal diagnostic remains: the loader's first bounded D2CMP `DllMain`
pass reports an incomplete return and the game's recovery path logs an
`SMemReAlloc()` message before normal initialization repeats successfully.
It is not present in the rendered game UI and does not prevent the menu or MPQ
streaming, but it is the next cleanup target if DLL initialization is made
fully resumable.

## Character creation and gameplay

The installed demo originally crashed immediately after confirming a new
Barbarian. A normal-input trace (Single Player, double-click Barbarian, focus
the name field, type `TEST`, press Enter) stopped at batch 588 in two adjacent
CRTDLL imports:

1. `strncmp(0x01e4face, 0x009facf4, 10)` jumped through `0x009c4d7e` to the
   fail-fast unimplemented handler.
2. After implementing that function, `_strnicmp(0x01e4f898, 0x005cb3a4,
   0x7fffffff)` did the same through `0x009c4d78`.

Both are now real cdecl handlers: `strncmp` compares unsigned bytes and both
functions stop at the first difference, a shared NUL, or the requested count;
`_strnicmp` additionally folds ASCII A-Z. Zero count returns equality without
dereferencing either pointer. `test/test-strncmp.js` pins those edge cases and
the cdecl ABI.

With both imports present, the same input sequence clears the animated Act I
loading portal and reaches the playable Rogue Encampment at batch 1600 with a
one-million-block batch budget. The retained frame is
`/private/tmp/d2world-1600.png`; it contains the Barbarian and NPC, rain,
torches, terrain, belt and skill bar, plus the red life and blue mana orbs. A
ground click later scrolls the world to the wagon without a trap; that frame is
`/private/tmp/d2world-2200.png`. `test/test-diablo2-demo-gameplay.js` reproduces
hero creation from `--app=diablo2_demo` and asserts the rendered terrain and
HUD color regions, not merely process survival.

## Performance and SIMD

The playable trace is CPU-emulation bound rather than blocked on an obvious
host-side subsystem. Over 400 seconds it made 1,754,049 Win32 API calls (about
4.4K/s), while the interpreter recorded three active cooperative guest
threads, 17,089,938 block decodes, 46,860 live-cache evictions and 1,672 full
cache clears. The page's DirectDraw path already coalesces dirty presentation
to at most one upload per animation frame. No API, audio, timer, networking or
surface-upload storm was identified.

MMX is advertised and implemented, with packed operations lowered to
WebAssembly SIMD, but this run retired exactly zero MMX instructions. Static
SIMD clusters exist in `ijl11.dll`, `binkw32.dll` and `smackw32.dll`; the active
game and DirectDraw renderer DLLs contain no credible SIMD routine. The main
EXE's three isolated SSE-looking byte sequences are low-confidence scan
coincidences, SSE is not advertised, and no SSE path executes. Implementing
more SIMD is therefore unlikely to be the first-order gameplay speedup for
this shareware build; interpreter/cache/thread efficiency is the measured
target.

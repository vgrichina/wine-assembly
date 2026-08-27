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

The cache-clear pressure came from fixed reservation rather than typical
compiled size. The old allocator reserved 16KB for every compiled 4KB guest
page; a fixed-allocator sample of 795 Diablo II pages found a 2,411-byte mean,
with 78.1% fitting in 4KB, 97.1% in 8KB and 99.5% in 12KB. Compiled pages now
use 4/8/12/16KB classes, grow only when emitted code requires it, and recycle
safely retired chunks. A directory clock also makes the separate 128-index
limit explicit instead of refusing all later pages. On the final replay through
batch 1660 this reduced full resets to 13; the fixed-size trace recorded 128
resets during batches 1500–1600 alone and 1,672 by batch 2300. Because the host
load varied substantially, this establishes the cache-pressure improvement but
is not presented as a wall-clock FPS measurement.

MMX is advertised and implemented, with packed operations lowered to
WebAssembly SIMD, but this run retired exactly zero MMX instructions. Static
SIMD clusters exist in `ijl11.dll`, `binkw32.dll` and `smackw32.dll`; the active
game and DirectDraw renderer DLLs contain no credible SIMD routine. The main
EXE's three isolated SSE-looking byte sequences are low-confidence scan
coincidences, SSE is not advertised, and no SSE path executes. Implementing
more SIMD is therefore unlikely to be the first-order gameplay speedup for
this shareware build; interpreter/cache/thread efficiency is the measured
target.

## Gameplay hot-loop census

A post-cache gameplay histogram over batches 1500..1660 mapped runtime block
entries back through each PE's load delta and then checked every hot backward
edge in disassembly. The table groups blocks belonging to the same loop nest;
`top entries` is the hottest constituent block, not a sum or an instruction
count. This avoids double-counting nested loops.

| Guest instance | Runtime range | Original PE range | Top entries | What it does |
| --- | --- | --- | ---: | --- |
| main | `0x86e1ed..0x86e275` | d2gfx `0x100031ed..0x10003275` | 924,243 | clipped rows; inner one-source palette translation at `0x86e24e` |
| main | `0x4d8e70..0x4d8e9f` | EXE, same VA | 739,112 | scans an array of rectangle/region pointers and performs four bounds tests |
| main | `0x86c141..0x86c2e2` | d2gfx `0x10001141..0x100012e2` | 434,355 | 15-row Duff/jump-table renderer with 32 unrolled one-source LUT pixels |
| main | `0x86c34d..0x86c6c3` | d2gfx `0x1000134d..0x100016c3` | 324,300 | 15-row Duff renderer with 32 unrolled two-source 64K blend-table pixels |
| main | `0x86e34d..0x86e418` | d2gfx `0x1000334d..0x10003418` | 251,520 | clipped rows; inner two-source palette/blend translation at `0x86e3ca` |
| main | `0x655465..0x6554af` | d2cmp `0x6fe28465..0x6fe284af` | 235,366 | signed RLE command stream: skip, change row, or `REP MOVS` literal run |
| main | `0x6556a1..0x6557b5` | d2cmp `0x6fe286a1..0x6fe287b5` | 226,217 | clipped RLE row decoder; optional in-place two-input palette translation |
| main | `0x4946e4..0x494748` | EXE, same VA | 217,280 | nested 8x8 lighting/color-grid sampling through `0x430df0` |
| main | `0x65813f..0x658186` | d2cmp `0x6fe2b13f..0x6fe2b186` | 217,088 | nearest-color search using three squared channel distances |
| main | `0x42f8d9..0x42f90c`, `0x42fbe0..0x42fc1c` | EXE, same VAs | 119,808 | initialize and populate the 48x48 map/light grid, including region queries |
| main | `0x430b73..0x430c60` | EXE, same VA | 112,632 | nested lighting interpolation and per-cell contribution calls |
| main | `0x5025ff..0x5026ed`, `0x502a53..0x502b66` | EXE, same VAs | 107,520 | scan fixed bucket arrays and linked game-object/client records |
| main | `0x86c736..0x86c8e0`, `0x86c9a1..0x86ccff`, `0x86cdc3..0x86cff8` | d2gfx `0x10001736..0x10001ff8` | 112,010 | compressed CEL RLE renderers with unrolled LUT/blend suffixes and clipping |
| main | `0x88f753..0x88f790` | d2ddraw `0x10003753..0x10003790` | 96,354 | short DirectDraw buffer/scanline loop |
| main | `0x86e471..0x86e73e` | d2gfx `0x10003471..0x1000373e` | 84,900 | visible-tile/object traversal that selects and calls the renderer variants above |
| main | `0x42145d..0x421475` | EXE, same VA | 120,960 | 128-bucket array plus linked-list callback walk |
| main | `0x493f84..0x49433b` | EXE, same VA | 60,148 | object/cell render preparation with nested fixed 6x6 grids |
| main | `0x4b54fb..0x4b5561` | EXE, same VA | 60,175 | Bresenham-like collision/region walk with bounds queries |
| main | `0x651188..0x651252` | d2cmp `0x6fe24188..0x6fe24252` | 65,174 | scan zero/nonzero spans and emit bounded RLE literal/skip commands |

Smaller measured backedges (hottest block 20K–53K) are the same classes, not a
new dominant idiom: more clipped d2gfx CEL variants (`0x86d0da..0x86d4d5`),
D2CMP state/color transforms (`0x652851..0x65294c`,
`0x653f8f..0x65408b`), EXE object/list traversals (`0x421274..0x4212c1`,
`0x4300d6..0x43049c`, `0x494b22..0x49514e`), short memory scans/fills
(`0x41fd7e..0x41fda6`, `0x4c9e2e..0x4c9e45`), and two short coordinate loops
at `0x4dea38` and `0x4deae2`. Most contain calls, pointer chasing, multiple
branches, or fixed two-dimensional control and are not safe LUT_RUN shapes.

Generalized H418 LUT_RUN removes both genuinely hot byte-translation
self-loops: d2gfx runtime `0x86e24e` and d2cmp runtime `0x655762`. In the same
160-batch main window it reduced handlers from 262,313,891 to 257,258,415
(1.93%) while processing 1,381,859 pixels. The remaining first-order local
target was the straight-line/unrolled d2gfx family, especially
`0x86c141..0x86c2e2`; it needed an unrolled-LUT recognizer, not broader
self-loop recognition.

H431 now handles that fixed-span form at decode time. It recognizes the exact
descending one-source suffix and symbolically validates MSVC's scheduled
two-source blend suffix, then continues into the ordinary outer row tail. On a
full replay of the same batches 1500..1660, main handlers fell again from
257,258,415 to 179,778,066: 77,480,349 fewer, or **30.12% beyond H418 alone**
(31.46% from the original pre-LUT 262,313,891). The d2gfx suffix landings no
longer appear in the hot-block top twenty; the jump-table and row-head blocks
at `0x86c167`, `0x86c141`, `0x86c38e` and `0x86c34d` remain, as expected,
because H431 is nonterminal and does not absorb their control flow. The batch
1652 Rogue Encampment capture remained healthy: terrain 87,447, life orb 3,612,
mana orb 2,910 and 187 quantized colors. Host load forced the replay to its
320-second cap exactly at batch 1680, so this is an instruction-count result,
not a wall-time/FPS claim.

The clipped two-source inner loop at runtime `0x86e3ca` (d2gfx original
`0x100033ca`) now uses H418 as well. Descriptor version one adds a second
advancing byte stream, an auxiliary low-byte register, an absolute table
displacement and a selector for which source cursor terminates the run. A
separate exact recognizer proves the observed `xor/xor`, two loads, `shl 8`,
three increments, 64KB blend lookup, store and `cmp source2,bound / jb` order;
the executor remains the shared universal LUT kernel.

In a fresh batches-1500..1660 profile, `0x86e3ca` fell from the prior capture's
251,520 per-pixel block entries to 26,522 budget resumptions. H418 processed
1,205,355 pixels in 96,689 aggregate runs, while the new canonical ESP load-run
recognition drove H408 2,869,328 times and removed `H343 -> H343` from the top
pairs. That fresh scene retired 145,589,954 main handlers and scored terrain
102,464, life 3,612, mana 2,910 and 189 colors. Its terrain workload differs
from the earlier H431 capture and host load exceeded 80, so neither the total
handler difference nor wall time is presented as an isolated speed percentage.

### High-level meaning of the post-LUT hot blocks

The remaining block heads are easier to understand as engine operations than
as instruction pairs. Counts in this table are correlated entries within loop
nests and therefore must not be added together.

| Operation | Current evidence | Interpretation |
| --- | --- | --- |
| Fixed-shade isometric tile blit | d2gfx `0x10001130`, runtime row heads `0x86c141` (322,448) and `0x86c167` (345,480) | Draws the 15 diamond rows through a Duff jump table. Each source palette index passes through one selected 256-byte row of the 64K table before reaching the 8bpp framebuffer. |
| Per-pixel-lit isometric tile blit | d2gfx `0x10001340`, runtime row heads `0x86c34d` (289,814) and `0x86c38e` (310,515) | Combines a tile byte with a byte from the coordinate-selected light field at `0x10014004`, using `(light << 8) + pixel` into the 64K table. This is palette lighting/shading, not a 16/32bpp arithmetic alpha blend. |
| Clipped palette blit/blend | H418 aggregate 1,205,355 pixels in 96,689 runs; d2gfx `0x100031ed`/`0x1000334d` | The same fixed-shade and per-pixel-lit operations with horizontal clipping. H418 now absorbs their actual pixel loops; the surrounding row setup remains. |
| Tile/collision mask query | EXE `0x4d8e10`, hot scan blocks `0x4d8e70..0x4d8e9f` at roughly 307K--384K entries | Finds which room rectangle contains a world coordinate, resolves that room's row-offset table, loads a 16-bit tile/collision word and applies the caller's mask. This is simulation/spatial-query work, not renderer clipping. |
| Light-grid sampling/build | EXE `0x4946cd` inner 8x8 blocks at 186,048 entries and clamped sampler `0x430df0` at about 194K | Repeatedly clamps coordinates to a 48x48 grid and copies one or four light/color bytes while constructing the small lighting grid consumed by the per-pixel tile renderer. |
| CEL/RLE expansion | d2cmp `0x6fe28465`, runtime `0x655465` at 198,960 entries | Interprets signed commands: negative values skip output or advance a row; positive values copy a literal run. Other d2gfx paths apply the LUT/light operation while decoding compressed CEL rows. |

H431 processed 11,825,842 fixed-span pixels in 718,737 invocations in this
capture. Dividing the two fixed-tile row-head counts by their 15-row shape gives
about 40.8K full-tile equivalents, only as a scale estimate because clipping
and variant dispatch make it non-exact. The important consequence is that H431
has already removed most pixel-by-pixel dispatch, so the remaining d2gfx cost
is increasingly row setup, diamond-shape jump dispatch and function control.

That changes the next optimization level. An exact full-tile handler covering
the fixed-shade and per-pixel-light variants could consume all 15 rows per call
and subsume H431 internally. Separate candidates are the room collision-mask
query, the fixed 8x8 light-grid builder and the signed D2CMP command decoder.
Those are whole engine primitives; generic `XOR -> LOAD8` or `CMP -> Jcc`
fusions would only shave pieces of all four.

## Cooperative workers and real browser threads

The browser HUD's blue `threads` phase is literal wall time spent in
`ThreadManager.runBudgeted`, but the name does not mean Web Workers. The three
guest worker WASM instances currently run synchronously and round-robin on the
browser's main JavaScript thread. A sequential per-instance histogram over
batches 1500..1650 found:

| Instance | 50-batch handlers | Dominant work |
| --- | ---: | --- |
| T1, Fog service thread | 0 | parked in `WaitForSingleObject` |
| T2, Storm async worker | 56,384,573 | MPQ Huffman/bitstream decode and ADPCM expansion |
| T3, D2Sound worker | 53,312 | mostly waits and DirectSound service calls |

T2's hottest nests are Storm runtime `0x9a1f40..0x9a21b3` (original
`0x6ffbbf40..0x6ffbc1b3`, Huffman bit refill/tree traversal; 433,747 entries in
its hottest block) and `0x9a2d30..0x9a2e9f` (original
`0x6ffbcd30..0x6ffbce9f`, ADPCM code expansion and predictor/step-index clamps;
432,499). Its secondary loops build/walk the decode trees at
`0x9a1c40..0x9a1e6e` and perform smaller output transforms at
`0x9a31a6..0x9a31f4`. Neither is LUT_RUN, and no worker instance executed H418
during the full replay.

Consequently, real Web Workers should materially improve browser responsiveness
for this workload: nearly the entire blue phase could overlap the main guest
instead of blocking input and paint. At the sampled rates main averaged about
1.61M handlers/batch and T2 1.13M; perfect independent overlap would put a
rough upper bound near 1.7x for their combined CPU phase. That is a ceiling,
not an FPS forecast: main sometimes waits for worker events, host imports such
as audio/window/storage need a main-thread broker, shared emulator allocators
still need locking, and the green d2gfx renderer remains single-threaded. The
existing shared WASM memory, per-thread instances, atomic wait table and
partitioned decode caches provide useful groundwork; the missing broker and
race audit are the implementation cost documented in
`docs/design-real-threads.md`.

## Isolated-Worker bounded MPQ waits

The isolated browser backend originally omitted the bounded-wait poll floor
already used by the cooperative main scheduler. Its guest clock can advance
past Storm's 255ms MPQ completion wait after only one or two concurrent Worker
slices. `resolveMainWorkerWait()` then returned `WAIT_TIMEOUT` while the Storm
decompression worker was still runnable; Storm accepted the resulting short
read, and D2CMP later reported `Codec.cpp` line 1563, `top >= 0`, while decoding
the incomplete data.

`ThreadManager.resolveWait()` now requires both elapsed guest time and up to
the same bounded number of scheduler polls while an isolated main thread still
has runnable guest workers. A signal remains immediate, and a permanently
unsignalled finite wait still times out after the poll ceiling. The focused
regression advances the guest clock by 1000ms during a 255ms wait, proves it
does not complete after the second Worker slice, then signals the event and
proves normal completion.

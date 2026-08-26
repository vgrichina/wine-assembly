# Diablo Shareware

`test/binaries/candidates/diablo-shareware/installed/`, registry id
`diablo_shareware` (`lib/apps.js`). Reaches gameplay — see the
`project_diablo_gameplay` note for how a character gets into Tristram.

## Modules and address arithmetic

`node tools/pe-sections.js <file>` prints `imageBase`/`sizeOfImage`; the runtime
bases below are those laid out in load order, each module starting where the
previous one ends.

| Module | Original base | `sizeOfImage` | Runtime base | Runtime → original |
|---|---|---|---|---|
| `diablo_s.exe` | `0x400000` | `0x2a1000` | `0x400000` | identity |
| `storm.dll` | `0x15000000` | `0x3d000` | `0x6a3000` | `+0x1495d000` |
| `diabloui.dll` | `0x20000000` | `0x46000` | `0x6e0000` | `+0x1f920000` |
| `smackw32.dll` | `0x400000` | `0x15000` | `0x726000` | `-0x326000` |

**Do not do this arithmetic by hand.** `--trace-at`, `--count` and `--break`
accept `module+0xORIG_VA` (`storm+0x1500bec4`, `diabloui+0x2000…`, `exe+0x…`)
and resolve it after the DLLs load. The table is here to read a trace that
already printed a runtime VA, and it is only valid while the DLL set is
unchanged — adding a DLL shifts everything after it.

## Getting to a screen headlessly

The Smacker intro is real time, so a normal-speed run never reaches the menu
inside a sane batch budget. `--time-scale=30` fast-forwards the guest clock; the
main menu is live from roughly batch 39000.

```sh
timeout 300 node test/run.js --app=diablo_shareware --time-scale=30 \
  --max-batches=40300 --no-close \
  --input=40000:png:/tmp/f1.png,40100:png:/tmp/f2.png
```

**Always pass `--quiet-api`** unless you are actually reading the API log. A
Diablo run prints one `[API]` line per call — 96,787 of them by the menu alone,
724,015 by Tristram — and writing them is *blocking* I/O on the same thread the
guest runs on. Measured back to back, same 1000-batch command line:

| | wall | user CPU |
|---|---|---|
| default | 3:53 | 25.1s |
| `--quiet-api` | **1:17** | 25.1s |

Identical CPU, three times the wall clock: every second of that difference is
the process waiting on stdout. On a box under load this is the difference
between a run finishing and a run being SIGKILLed at the timeout, and it is why
several probe runs in this file were originally reported as "too slow to
finish".

Runs are **deterministic, threads included** — the same command line twice gives
byte-identical output. Measured, with T1 alive, on a loaded box:

```sh
for i in 1 2; do
  timeout 120 node test/run.js --app=diablo_shareware --time-scale=30 \
    --max-batches=40100 --no-close --trace-thread \
    --count=storm+0x1500c7d9,storm+0x1500bec4,diabloui+0x20001669 \
    --input=40050:png:/tmp/det$i.png > /tmp/det$i.log 2>&1
done
# 150391 log lines each, identical apart from the PNG filename; PNGs cmp equal.
```

This is by construction, not luck. The CLI has no OS threads: `ThreadManager`
steps every guest thread from one JS loop, and `test/run.js` hands it a
**virtual clock** (`now: () => tickState.batch * 200`), so slice deadlines,
`sleepUntil` and audio-thread priority are all functions of the batch counter.
`get_ticks` is batch-driven too. Nothing in the scheduler reads the wall clock,
which is also why adding `--trace-thread` does not perturb the interleave.

What *does* change the interleave is **changing the flags**: `--break`,
multi-address `--trace-at` (forces `BATCH_SIZE=1`) and anything else that
alters how many steps run per batch produce a genuinely different execution.
Two runs are only comparable if the command lines match exactly. The earlier
claim in this file that "runs are non-deterministic once T1 exists" came from
comparing three *different* flag configurations, and is withdrawn.

> One real-clock leak did survive until 2026-08-24: a bounded main
> `WaitForSingleObject` with other threads still active measured its timeout
> against `Date.now()` in `lib/thread-manager.js`. It now uses the injected
> `this._now()` like everything else. That also fixed an incoherence — the wait
> was timed on the wall while the guest's own `GetTickCount` ran on the batch
> counter, so a 5-second wait advanced the guest's clock by millions of
> milliseconds. Diablo's frames are byte-identical either side of the change.

`--time-scale=30` is the working setting. **`--time-scale=200` hangs** — five
sweep captures across a run came back byte-identical, frozen on the Blizzard
North intro frame with T1 already exited. Do not raise the scale looking for a
faster repro.

Menu geometry in the 640×480 capture: "SINGLE PLAYER" spans about x=175..465,
y=200..228, so a click at (320, 213) selects it. Enter also works once the menu
is actually on screen. `run.js`'s `click` action is invisible to games that
sample the button once per frame — use `mousedown`, a gap, then `mouseup`.

**Choose Class.** Take Single Player from that menu and hold the input long
enough to be sampled. Both of these reach it; the resulting frame is stable from
about batch 39800 through 43900:

```sh
# keyboard
timeout 540 node test/run.js --app=diablo_shareware --time-scale=30 \
  --max-batches=41500 --no-close --repaint-every=200 \
  --input=39500:keydown:13,39560:keyup:13,41000:png:/tmp/cc.png

# mouse
timeout 540 node test/run.js --app=diablo_shareware --time-scale=30 \
  --max-batches=41500 --no-close --repaint-every=200 \
  --input=39400:mousemove:320:213,39500:mousedown:320:213,39620:mouseup:320:213,41000:png:/tmp/cc.png
```

`--repaint-every=200` is required for the PNG to be anything but a stale frame,
and `--no-close` is required for `--png`/`png:` to write at all.

## Graphics: DirectDraw, and the guest does the drawing

Measured API histogram over a menu run:

- exactly **one** `CreateSurface`
- **zero** `Flip`, `Blt`, `GetAttachedSurface`
- **1472** `Lock`/`Unlock` pairs
- **30** `IDirectDrawPalette_SetEntries`
- **2** `WaitForVerticalBlank`

So there is no blitter path to blame for a wrong picture: Diablo locks the one
primary surface and writes the pixels itself. When something renders wrong, the
suspects are the surface descriptor we hand back at `Lock` (pitch/stride, the
lock rect) and the palette — not our GDI or our compositor.

## `spawn.mpq`

50,274,091 bytes. `node tools/mpq-dir.js spawn.mpq` dumps the header and block
table; `--pos=0xOFF` maps a file offset seen in a `--trace-fs` line to its block;
`--table=IDX` decrypts one block's sector offset table.

```
header at 0x0, v0, sector size 4096 (shift 3)
hash  table @ 0x2fe5eeb   2048 entries
block table @ 0x2fedeeb   1028 entries (all live)
```

Storm issues one `ReadFile` per *sector run*, so a trace only ever shows the
compressed length. A read that looks truncated usually is not — check it against
the sector table before believing it. The archive is stripped of its listfile, so
a sector table's decryption key is recovered from known plaintext instead: entry
0 is the table's own byte length **and** the last entry is the file's compressed
size. Matching only entry 0 yields false positives (that mistake cost an hour
here, and is why `detectSeed` trial-decrypts the whole table).

### Host-side ground truth: `tools/mpq-extract.js`

`tools/mpq-dir.js` only reads the tables. `tools/mpq-extract.js` decodes an
entry all the way to bytes, so the guest's decompressed output can be diffed
against what the archive actually holds:

```
node tools/mpq-extract.js <file.mpq> (--name='dir\file.ext' | --block=N | --verify)
                          [--out=PATH] [--png=PATH] [--frame-height=N] [--palette]
```

`--verify` decodes every live block by index and checks each against its
`fsize`. On spawn.mpq: **695 exact, 330 whose key could not be guessed, 3 wrong**
— and all three "wrong" ones are *also* key failures that slipped through, see
the `detectSeed` correction below. Extraction by `--name=` needs no guessing and
is the mode to trust.

The crypt table, `hashString`, `decryptBlock`, `detectSeed`, `flagNames` and the
header scan now live in `tools/mpq.js`, shared by both scripts; `mpq-dir.js`'s
CLI output is byte-identical to before the split (verified across the default,
`--all`, `--pos=`, `--table=` and `--name=` modes).

Facts confirmed while building it:

- **Every `ui_art\*.pcx` in spawn.mpq is `IMPLODE|ENCRYPTED`** (flags
  `0x80010100`) — never `COMPRESS` (0x200), so there is **no per-sector
  compression-type byte**; the whole sector is a raw PKWARE DCL stream. No
  `FIX_KEY`, no `SINGLE_UNIT`, no `SECTOR_CRC` on any of them.
- The file-data key is `hashString(bare_name, 3)` — the name **after** the last
  backslash, so `"logo.pcx"`, not `"ui_art\logo.pcx"`. The sector table uses
  `key - 1`, sector *i* uses `key + i`. With the name known you never need
  `detectSeed`.
- **Correction to the paragraph above this subsection:** matching *both* dword 0
  and the last dword does **not** pin the sector-table key either. Measured on
  spawn.mpq block 0 (`ui_art\title.pcx`): the real file key is `0xe19c3ed3`, so
  the table key is `0xe19c3ed2`, but `detectSeed` returns `0xfce59174` — a
  collision that decrypts dword 0 and the last dword correctly and everything
  in between to garbage. 3 of 1028 blocks hit this. `detectSeed` is a fallback
  for a nameless block, not a substitute for the name.
- A sector whose stored length is **not smaller** than its decompressed length
  is verbatim; everything else is exploded. Sector size is 4096.
- The PKWARE DCL explode implementation is in `tools/mpq.js` (no npm
  dependency). Its three fixed Huffman tables are the run-length form used by
  Mark Adler's `blast.c` — byte = `(repeat-1) << 4 | bit-length` — and codes are
  stored **bit-reversed**, which is why `decode()` inverts each bit. Length code
  0 is 3 and code 1 is 2 (DCL's 2-byte match is not the first code), and a
  2-byte match always uses 2 distance bits regardless of dictionary size.

#### `ui_art\logo.pcx` real geometry

Block 19, `pos 0x4a32e`, csize 315035, **fsize 535264** (the correctness gate:
the decode must produce exactly this many bytes).

- PCX v5, **550 x 3240**, 8bpp, 1 plane, bytesPerLine 550, 256-colour palette in
  the trailing 769 bytes (`0x0C` marker + 768 RGB bytes).
- **15 frames of 550 x 216** stacked vertically. 3240 / 15 = 216 exactly.
- The colour key is **index 250 = rgb(0, 255, 0)**, 68.7% of all pixels. Black is
  a *different* index — 239 = rgb(0,0,0), only 5.9%. So a frame that renders
  solid black in the emulator is not "the green key went black": the pixel
  indices themselves are wrong (or all zero), because index 0 is not black-heavy
  in this image at all. That distinguishes a palette bug from a decompression
  bug without any further instrumentation.

Regenerate the ground truth (full image plus one PNG per frame,
`logo.000.png` … `logo.014.png`):

```
node tools/mpq-extract.js \
  test/binaries/candidates/diablo-shareware/installed/spawn.mpq \
  --name='ui_art\logo.pcx' --png=/tmp/logo.png --frame-height=216 --palette
```

All 15 frames render as a legible flaming "DIABLO" wordmark on the green key.

#### The rest of `ui_art\` (all decode cleanly)

| name | block | fsize | PCX | frames |
|---|---|---|---|---|
| `title.pcx` | 0 | 80648 | 640x480 | 1 |
| `mainmenu.pcx` | 20 | 21788 | 640x480 | 1 |
| `focus42.pcx` | 21 | 6707 | 42x336 | 8 of 42x42 |
| `smlogo.pcx` | 22 | 333227 | 390x2310 | 15 of 390x154 |
| `selhero.pcx` | 23 | 15895 | 640x480 | 1 |
| `heros.pcx` | 24 | 28929 | 180x304 | 4 of 180x76 |
| `focus16.pcx` | 25 | 3032 | 20x160 | 8 of 20x20 |
| `sb_arrow.pcx` | 28 | 2372 | 28x88 | — |
| `focus.pcx` | 29 | 4873 | 30x240 | 8 of 30x30 |
| `credits.pcx` | 1002 | 157403 | 640x480 | 1 |
| `black.pcx` | 994 | 11457 | 640x480 | 1 |

The "pentagram animation" is `focus*.pcx` — three sizes of the same 8-frame
spinning pentagram used as the menu selection marker, not a separate asset.
`ui_art\pentspin.pcx`, `ui_art\hf_logo3.pcx` and `ui_art\diablo.pal` are **not**
in this archive.

## Named addresses

Original VAs. Verify with `node tools/disasm_fn.js storm.dll 0x1500bb20 60`.

| VA | What |
|---|---|
| `storm+0x1500bb20` | audio pump thread body |
| `storm+0x1500be49` | its `LeaveCriticalSection`, *before* the object at `ebx` is used |
| `storm+0x1500beb9` | `mov ecx,[ebx+0x18]` + null test — branches away when the sound buffer is null |
| `storm+0x1500bedd` | `call [edi+0x2c]` — `IDirectSoundBuffer::Lock` through the vtable we synthesize (see below) |
| `storm+0x1500beeb` | the `rep movsd`/`rep movsb` that fills the buffer Lock handed back |
| `storm+0x150365e4` / `+0x150365e8` | imported `EnterCriticalSection` / `LeaveCriticalSection` |
| `storm+0x150316c0` | head of the list the pump walks (next pointer at `+0x30`) |
| `storm+0x15034b28` | the pump's `CRITICAL_SECTION` |

### The audio pump's `Lock` call, decoded

`0x2c / 4` = vtable slot 11, which for `IDirectSoundBuffer` is `Lock`
(IUnknown 0-2, GetCaps 3, GetCurrentPosition 4, GetFormat 5, GetVolume 6,
GetPan 7, GetFrequency 8, GetStatus 9, Initialize 10, Lock 11). The eight
pushes at `0x1500bec4..0x1500bedc` are, in argument order:

| Argument | Source |
|---|---|
| `this` | `[ebx+0x18]` (`ecx`; the vtable is `edi = [ecx]`) |
| `dwOffset` | `[ebx+0x1c]` |
| `dwBytes` | `[ebx+0x24]` |
| `ppvAudioPtr1` | `&[ebx+0x14]` — **Lock must write the locked pointer here** |
| `pdwAudioBytes1` | `&[ebx+0x24]` — and the byte count here |
| `ppvAudioPtr2`, `pdwAudioBytes2`, `dwFlags` | `0`, `0`, `0` |

and the pump immediately reads its own out-parameter back:

```
1500bee0  mov eax,[ebp+0x0]
1500bee3  mov edi,[ebx+0x14]     ; exactly what Lock stored
1500beeb  rep movsd / rep movsb
```

The argument decode above is **correct** — verified against
`node tools/disasm_fn.js storm.dll 0x1500bec4 20`.

> **Withdrawn (the stale-`edi` theory only):** the paragraph that used to follow
> read "`[ebx+0x14]` already holds something before the call (`esi` is loaded
> from it at `0x1500be7e`), so a `Lock` that returns without writing
> `*ppvAudioPtr1` leaves `edi` stale and the `rep movsd` writes wild." That is
> not what happens. At the death `edi = 0` and the thread ends at EIP=0, which is
> a control transfer to null — a wild `rep movsd` cannot produce that. The fault
> is the `call [edi+0x2c]` itself, and it never reaches `Lock`. See "Storm audio
> pump thread dies" below.

Storm is **EBP-less**, so `--trace-stack` returns `frames=[]` on anything inside
it. Do not spend time on the frame walker here; use `--count` on candidate call
sites, or `tools/caller_census.js`, to find who called what.

## Open bugs

### FIXED (re-measured 2026-08-25): logo blinks on the main menu

**This no longer reproduces.** Everything below it — the whole "black tail from
a large MPQ read" chain — is kept as history, because the addresses in it are
correct and useful, but do not go hunting for the defect again without first
re-measuring. Two independent checks:

```
node test/test-diablo-shareware-art.js
#   logo frame IoU vs archive: 0.81 0.81 0.80 0.83 0.81 0.81 0.81 0.80 0.83 …
#   logo frames matching the archive: 15/15  (distinct sprites seen: 2,5,8,11,14)
#   PASS
```

That test scores each capture against the frames `tools/mpq-extract.js` decodes
from `spawn.mpq` host-side, so 15/15 is a statement about the *pixel indices*,
not about brightness: the black-tail bug would score ~0.25.

Second check, on the fast recipe rather than the art test's `--time-scale=30`
one, so it is not the same run wearing a different hat — ten consecutive menu
frames, top colour of the logo rect:

```
node test/run.js --app=diablo_shareware --batch-size=200000 --tick-ms-per-batch=50 \
  --max-batches=1040 --no-close --quiet-api --input=1000:png:/tmp/f00.png,1004:png:…
for f in /tmp/f*.png; do node tools/png-stats.js $f --region=126,0,388,154 --top=1; done
#   distinct colours: 128-132   #000000 65.1-67.5%   on all ten
```

A blanked frame is ~100% `#000000` and one distinct colour, so a single blink in
that window would be unmissable. The old repro's duty cycle was ~20% art / 80%
black over a 45-batch period; ten samples across 40 batches cannot miss that.

Which change fixed it was not bisected. The likeliest candidate is the
per-offset code-write invalidation described in `docs/page-compile-design.md`:
the same run now reports `page invalidations 22117 that dropped a block 3081 …
whole-page drops (write too wide to walk) 1 (100.0% exact)`, and the sparse
arena at `0x4fc68000` is the last page named — i.e. Storm's runtime-generated
blitters are now being retired on write, which is exactly the suspect the
"Still open: why the blitter overruns" note below could not exclude.

#### History: the symptom as it was

The 385×156 logo block appears and disappears across frames while "SHAREWARE",
the menu items, the pentagrams and the version string all stay put.

Repro (deterministic; menu is live from ~batch 39000):

```
timeout 500 node test/run.js --app=diablo_shareware --time-scale=30 \
  --max-batches=40300 --no-close \
  --input=40000:png:/tmp/x1.png,40050:png:/tmp/x2.png,40100:png:/tmp/x3.png
```

#### It is not a present/erase problem: 12 of the 15 frames really are black

The logo is a 15-frame animation. `diabloui+0x20001610` loads `ui_art\logo.pcx`
(390 × 2310) into one `SMemAlloc`'d 900,900-byte buffer, makes one
`STransCreate` sprite per 390 × 154 sub-rect into the 30-dword array at
`0x20022478` (runtime `0x702478`), then frees the buffer. The frame index at
`0x200224f8` (runtime `0x7024f8`) advances 0..14 and wraps at the first null
slot (`0x2000148b`).

All 15 sprites get created — `--count=diabloui+0x20001669` = 30 across the two
animated arts, and the array holds 15 non-null handles with slot 15 zero. Their
payload sizes are the tell:

| frame | payload | meaning |
|---|---|---|
| 0 | 23220 | real art, has transparent pixels |
| 1 | 24010 | real art |
| 2 | 32456 | real art for the top ~125 of 154 rows, then black |
| 3 – 14 | 60984 each | 154 × (390 + 6) — the *fully opaque* worst case, identical bbox 389×153 |

Frame 3's compiled payload dumped as all zero bytes. `STransCreate`'s
transparency index for this art is **0xFA** (`push 0x10000fa` at
`0x20001677`), so a source byte of 0 compiles to **opaque black**, not
transparent. That is why the "missing" logo is a black rectangle rather than
nothing, and why nothing erases or restores it.

Measured period at `--time-scale=30`: 45 batches, ON for ~9 of them (≈20% duty
cycle); presents land 2-3 batches apart, so the cycle is 15 animation frames of
which 3 show art. Captures at stride 1 over 40040-40100 are ON at 40043-40051
and 40088-40096. Frame 2's truncation is visible in the PNG as a hard
horizontal slice through the DIABLO letters: `tools/png-diff.js --region` gives
a changed box of `126,0 388x154` on a full frame and `126,0 388x125` on that
one.

> The guest-clock caveat: the 30× scale is only what makes the menu reachable in
> a sane batch budget. The blink itself is not timing-dependent (see below).

#### Why the buffer is black: an ignored short read from Storm

Storm's PCX reader inside `SBmpLoadImage` reads the whole body in **one**
`SFileReadFile(hFile, buf, fileSize - 128, ...)` at `storm+0x15001f0e` — and
**never tests the return value**; `0x15001f13` walks straight into the decode.
The RLE loop at `0x15001f1b`-`0x15001f4c` has no early exit and no input bounds
check: it always writes exactly `height × bytesPerLine` bytes, and an input byte
below 0xC0 is a literal, so a 0x00 byte paints one black pixel. An untouched
(zero) tail of the read buffer therefore becomes a black tail of the image, and
`SBmpLoadImage` still returns success — which is why `diabloui`'s
`test eax,eax` at `0x200097a2` sees a "successful" load and builds 15 sprites.

So the read came up short. Measured directly: exactly **one** `SFileReadFile` in
the whole run takes the short-read exit at `storm+0x1500ead4`
(`SetLastError(ERROR_HANDLE_EOF=0x26)`, `return 0`):

```
node test/run.js --app=diablo_shareware --time-scale=30 --max-batches=40100 --no-close \
  --count=storm+0x1500e7c3,storm+0x1500ea69,storm+0x1500ead4,storm+0x1500eac5,storm+0x1500e85a,storm+0x1500e78a,storm+0x1500e984
#   0x006b17c3 = 0    plain-file ReadFile path
#   0x006b1a69 = 58   single-threaded sector-cache fill
#   0x006b1ad4 = 1    <-- ERROR_HANDLE_EOF short read
#   0x006b1ac5 = 70   full-success returns
#   0x006b185a = 1    cached rep-movs fast path
#   0x006b1984 = 15   async 0x20000-chunk dispatches
```

The chain below it: `SFileReadFile`'s MPQ path (`0x1500e869`) reaches the
single-threaded branch `0x1500ea5e`, which calls the sector-cache fill
`0x1500c0a0`. That returns "bytes available", and short-returns at
`0x1500c1eb` (`cmp eax,esi / jnz 0x1500c1f3`) when the bulk sector decompressor
`0x1500c2e0` produced fewer bytes than the whole-sector span asked for. Inside
`0x1500c2e0`, the per-sector loop `0x1500c6f3`-`0x1500c821` either `rep movs`-
copies a stored sector (`0x1500c7db`) or calls PKWARE explode at `0x1502c3c0`
(call at `0x1500c7d4`, 0x3134-byte work buffer at `[0x150316d4]`, read callback
`0x1500c860`, write callback `0x1500c8a0`). **Explode's return value is not
checked** — `0x1500c7d9` jumps straight to `0x1500c7fb` and the output pointer
advances by the full sector size regardless — so a sector whose explode fails
silently leaves 4096 zero bytes behind and the loop carries on.

Sector-loop census over the same repro:

```
--count=storm+0x1500c6f3,storm+0x1500c7d9,storm+0x1500c7db,storm+0x1500c827,storm+0x1500c83b,storm+0x1500c7fb
#   0x006af6f3 = 396  sector-loop iterations
#   0x006af7d9 = 339  explode calls
#   0x006af7db = 4    stored-sector rep-movs copies
```

> **Withdrawn (the failure chain above, not the addresses):** re-measured with a
> single full-speed `--count` run over the same repro, and the chain does not
> hold.
>
> ```
> node test/run.js --app=diablo_shareware --time-scale=30 --max-batches=40100 --no-close \
>   --count=storm+0x1500c1eb,storm+0x1500c7d9,storm+0x1500c7db,storm+0x1500c827,storm+0x1500ead4,storm+0x15001f13,diabloui+0x20001610,diabloui+0x20001669
> #   0x006af1eb = 0     <-- the claimed sector-fill short return NEVER FIRES
> #   0x006af7d9 = 339   explode call returns
> #   0x006af7db = 4     stored-sector verbatim copies
> #   0x006af827 = 84    sector-loop normal exits
> #   0x006b1ad4 = 1     ERROR_HANDLE_EOF short read
> #   0x006a4f13 = 18    SFileReadFile body-read landing
> #   0x006e1610 = 2     animated-art builder (logo + pentagram)
> #   0x006e1669 = 30    STransCreate (15 + 15)
> ```
>
> Two things fall out of that. `0x1500c1eb` fires **zero** times, so the
> sector-cache fill never takes the short return the chain was built on. And of
> the 339 explode calls, every one of 304 sampled returns came back `EAX=0`
> (`CMP_NO_ERROR`) — explode is not silently failing. 339 + 4 = 343 sectors is
> approximately every sector of every file the run reads, so the decompression
> *volume* is not truncated either.
>
> What survives from the section above: the addresses, the fact that explode's
> return value is discarded at `0x1500c7d9`, and the fact that a zero tail in the
> read buffer paints black because 0x00 is a literal in the PCX RLE loop. What
> does not survive: "the sector fill short-returns" and "explode is
> mis-executed". Something else is zeroing the buffer.

#### What I could not determine

Which src/ defect makes Storm stop producing output partway through
`ui_art\logo.pcx`. The counters above are aggregates over 18 PCX body reads and
cannot isolate that file's 131 sectors, so I cannot yet say whether explode ran
for all 131 and produced zeros from some index on, or the sector loop exited
early. Both endings are the same statement: **the emulator mis-executes Storm's
PKWARE explode partway through a large MPQ file.** Note that explode is exactly
the code that builds the runtime unrolled byte copier described in
"Emulator-side context" at the bottom of this file, and exactly the code
`--loop-superops`' COPY_RUN is already known to miscompile.

The experiment that would settle it needs a src/ change and so was not run here:
log, from inside the emulator, the `(sector index, requested size, returned
size)` triple at the return of `0x1502c3c0` — i.e. a `--trace-host`-style hook
on the explode call — or dump the read buffer straight after `0x15001f0e`
returns and find the first zero byte. Either one turns "somewhere in explode"
into a sector number.

Two size facts worth having next to that: `ui_art\logo.pcx` is block 19,
csize 315,035 / fsize 535,264 / 131 sectors, and `ui_art\smlogo.pcx` (which the
Choose Class screen uses) is block 22, csize 215,185 / fsize 333,227 / 82
sectors, while `ui_art\title.pcx` — which renders correctly — is only 80,648
bytes. The two large arts are the two corrupted screens. Get them with
`node tools/mpq-dir.js <spawn.mpq> --name='ui_art\logo.pcx'` (the `--name`
hash-table lookup was added for this investigation; the archive has no
listfile).

#### Newly named storm/diabloui addresses (original VAs)

`node tools/disasm_fn.js test/binaries/candidates/diablo-shareware/installed/storm.dll 0xVA <count>`
(`diabloui.dll` for the `0x2000….` ones).

- `storm+0x1500e730` `SFileReadFile(hFile, buf, nBytes, &read, lpOverlapped)`, `ret 0x14`
  - `0x1500e796` plain-file path, `0x1500e7c3` its ReadFile return landing
  - `0x1500e7ea` MPQ cache fast path, `0x1500e85a` its success return
  - `0x1500e869` MPQ decompress path; `0x1500e8bc` `nChunks = (len+0x1ffff)>>17`
  - `0x1500e93b`-`0x1500e9c1` async 0x20000-chunk dispatch loop (`call 0x1500c8e0`)
  - `0x1500e9d5` `WaitForMultipleObjects(n, handles, TRUE, 255)` — return ignored
  - `0x1500ea5e` single-threaded path, `0x1500ead4` `SetLastError(ERROR_HANDLE_EOF)` + return 0
- `storm+0x1500c0a0` sector-cache fill, returns bytes available; `0x1500c1f3` short return
- `storm+0x1500c2e0` bulk sector decompressor; per-sector loop `0x1500c6f3`-`0x1500c821`
- `storm+0x1502c3c0` PKWARE explode; callbacks `0x1500c860` (read) / `0x1500c8a0` (write)
- `storm+0x15001d10` `SBmpLoadImage`; `0x15001e48` 0x80-byte header read,
  `0x15001f0e` whole-body read (return unchecked), `0x15001f1b` PCX RLE row loop
- `diabloui+0x20001610` animated-art builder (frame count = height/frameHeight, clamp 0x1e)
- `diabloui+0x20009740` LoadArt: query dims, `SMemAlloc(w*h)`, decode, `test eax` at `0x200097a2`
- `diabloui+0x2000148b` animation tick on `0x200224f8`

#### Ruled out, each with a measurement

- **Block cache / self-modifying code.** Forcing `$cache_lookup` to never reuse a
  block from the sparse generated-code arena produced byte-identical PNGs.
- **The sparse `VirtualAlloc` arena.** `--dump-vmap` shows 11 mappings and zero
  overlaps; region [10] `0x4fc10000..0x4fc70000` backs `0x080f1000`.
- **The Storm audio thread death below.** Real, but a separate fault.
- **The presentation path.** One primary surface, no `Flip`/`Blt`; `Unlock`
  presents the whole primary DIB with no dirty rect
  (`$handle_IDirectDrawSurface_Unlock` in `src/09a8-handlers-directx.wat`).
  There is no per-frame partial-present that could selectively drop the logo,
  and the bad pixels are in the source art anyway.
- **Sprite creation.** All 15 `STransCreate` sprites exist and are non-null
  (`--count=diabloui+0x20001669` = 30 over two animated arts).
- **Host file I/O.** `--trace-api=ReadFile,SetFilePointer` over the repro: 474
  reads, **zero** short reads — every one returned exactly what it asked for.
- **MPQ-level delivery of `logo.pcx`.** The guest read the sector table (0x210)
  plus sectors 0..129, ending exactly at sector-table offset[130] = 0x4c828.
  Only the last of 131 sectors is unread: 99.5% of the compressed bytes were
  delivered, nowhere near enough to explain an 81% shortfall in the image.
- **Storm's async 128KB chunk path and its 255 ms `WaitForMultipleObjects`.**
  Tempting (`0x1500e9d5` passes `dwMilliseconds=0xff` and ignores the result),
  but only 15 chunks are ever dispatched in the whole run and the big body reads
  take the single-threaded `0x1500ea5e` path instead — see the count block above.
- **Decoder fusion options.** `--no-sib-fusion` and `--no-rect-run` each give
  byte-identical sprite sizes (frames 3-14 all 60984).
- **A stored (uncompressed) sector confusing the loop.** All 131 of
  `logo.pcx`'s sectors are compressed — every entry of
  `node tools/mpq-dir.js <spawn.mpq> --table=19` is under the 4096 sector size,
  so the `cmp ebp,eax / jbe 0x1500c7db` stored-sector branch is not taken for
  this file at all. The 4 stored copies in the census belong to other files.
- **Anything specific to the logo.** **Both** animated arts degrade — the logo
  *and* the pentagrams lose their tail the same way — while every static art on
  the same screen is intact, and about 2.5 of 15 frames (~20%) come out correct.
  Whatever this is, it keys on the multi-frame path or on large files, not on
  one asset.

> **Withdrawn:** the earlier bullet "A truncated MPQ read … the file involved was
> the title WAV, not the logo." The 82-sector file that stops on a 0x20000
> boundary is `ui_art\smlogo.pcx` (block 22, csize 215,185 / fsize 333,227), not
> a WAV — `node tools/mpq-dir.js <spawn.mpq> --name='ui_art\smlogo.pcx'`. And a
> truncated read is *not* ruled out: it is the mechanism, just one level further
> down than the sector table can show.

### FIXED (re-measured 2026-08-25): Choose Class screen is corrupted

**This no longer reproduces either.** `test/test-diablo-shareware-art.js` scores
the nine panel-outline segments of `ui_art\selhero.pcx` against the archive and
reports `choose class panel segments drawn: 9/9`, every segment at `1.00`. The
sprite array being NULL was the symptom of the flat-grey palette bug fixed in
`cfff3789`; kept below as history.

Symptom as the user states it: "the layout is a mess and clicks and UI don't
seem to match". What the capture shows is a mostly black screen with only gold
class names and stat labels legible, sitting on undisturbed leftover pixels from
the main menu.

> **Withdrawn:** "heavy horizontal striping … start at the lock rect / pitch and
> the palette." There is no striping to explain. The fully-lit bottom row 479 is
> a CLI harness composite artifact — it is present on the *working* main-menu
> PNG too, and absent from the raw DirectDraw surface dump
> (`--dx-surfaces` + `dd/dx_01_primary_640x480_8bpp.png`). The faint upper lines
> are leftover main-menu pixels that nothing erased, not a pitch error. Lock
> rect, pitch and palette are not implicated by any measurement taken here.

**The screen has no art at all, and that is the whole bug.** diabloui's sprite
array (`diabloui+0x20022478`, runtime `0x702478`) holds 15 live frame pointers
while the main menu is up and is **entirely NULL** on Choose Class:

```sh
timeout 280 node test/run.js --app=diablo_shareware --time-scale=30 \
  --max-batches=39400 --no-close --repaint-every=200 --dump=0x702478:128
#   0x00702478  30 9c c6 4f 60 9c c6 4f 90 9c c6 4f …   (15 pointers)
# same run to 41500 with the Single Player input:
#   0x00702478  00 00 00 00 00 00 00 00 …               (all zero)
```

The multi-frame loader `diabloui+0x20001610` fires a **third** time for this
screen (`--count` says 3 by batch 41500, vs the 2 on the menu), so the screen's
art path does run — it just gets nothing back. Since frame count and per-frame
rects are derived from the loaded bitmap's dimensions, an element list built on
top of a zero-sprite load is the most economical explanation for "layout is a
mess and clicks don't match what's drawn": there is nothing to lay out against.
**Not measured, and the next thing to do:** read the width/height/frame-count
the loader stores on the failing call, and compare a drawn element rect against
the rect the app hit-tests. I could not separate the geometry symptom from the
art failure, because every art load on this screen fails.

#### The chain, measured end to end

1. `SDlgBeginPaint` (`storm+0x15004f00`) takes its do-nothing STUB tail
   (`storm+0x15004fed`) for the Choose Class dialog `hwnd 0x1000e` — 1 API call,
   no `Lock` — while the menu's `0x10006` took the full path (376 API calls).
2. Not the `WS_EX_TRANSPARENT` branch: `0x1000e`'s `GWL_EXSTYLE` is `0x00010000`.
   (`0x1001c` is `0x00010020` and its stub *is* correct behaviour.)
3. It is the record branch: `call storm+0x15005010` returns 0 for `0x1000e`. The
   `SDlgSetBitmap` record list (head `0x4fc6b380`) holds 18 records — every
   *child* of `0x1000e` and `0x1001c`, and none for `0x1000e` itself. So
   `SDlgSetBitmap` (`storm+0x150081e0`) was never called for it.
4. diabloui's art helper `diabloui+0x200097e0` bailed. `--count`: 3 entries,
   2 reach the success target of load #1 (`+0x20009818`), 2 reach load #2
   (`+0x20009860`) — one call fails at the **first** `SBmpLoadImage`, the
   dimension query. Of its 19 static xrefs only three ever fire; the one that
   fires here is `diabloui+0x2000df28`, whose string argument is
   `ui_art\selhero.pcx` (`diabloui+0x2001e960`), return landing `0x6edf2d` = 1.
5. `SBmpLoadImage` (`storm+0x15001d10`) fails at its 0x80-byte PCX header read:
   40 entries, 40 successful opens, **4** taking the failure block
   `storm+0x15001e51` (`xor esi,esi` after `SFileReadFile` returns FALSE). The
   open-failure exit `storm+0x15002019` is **0** — `SFileOpenFile` never fails.
6. `SFileReadFile` (`storm+0x1500e730`, see the address list) has two paths,
   selected at `storm+0x1500e8ae` on `[archive+0x108]`: zero → synchronous
   `storm+0x1500c0a0`, non-zero → an async path that chunks at `0x20000`, builds
   one work node per chunk and waits on `WaitForMultipleObjects` with a 255 ms
   timeout.
7. **The phase split is the decisive measurement.** To batch 39400 (before the
   transition): helper 2/2 OK, `SBmpLoadImage` 36/36 OK, sync reader
   `0x6af0a0` = 88 entries. To batch 41500 (after): helper 3 with 1 failure,
   `SBmpLoadImage` 40 with **4** failures, sync reader still **88** — not one
   further synchronous read — and 17 completions on the async path. *Every* MPQ
   read issued after the Single Player transition takes the async path, and every
   one of them comes back empty. It is not selhero-specific.
8. The async path sums per-chunk delivered bytes out of the work nodes; nothing
   fills them, so the sum is 0, `cmp eax,edx / jnz` at `storm+0x1500eabd` fires
   and it returns FALSE with `SetLastError(0x26)` = `ERROR_HANDLE_EOF`.

#### This is the same bug as "Storm audio pump thread dies"

The two open bugs are one. `0x1500c8e0` is **not** an audio-only node
constructor: of its three call sites, `0x1500e97f` — the one the section below
lists as "the no-DSound path, arg2 = 0" — is **inside `SFileReadFile`'s async
path**. So `0x150316c0` is Storm's shared async **work** queue and the thread at
`storm+0x15020cd0` (created ~batch 39184, `CreateThread handle=0xe1000
start=0x6c3cd0`) is its shared worker, servicing both DirectSound buffer fills
and MPQ sector reads. `[node+0x18]` is the job discriminator: non-null = sound
job (`Lock` through the buffer's vtable), null = file job (fall through to
`storm+0x1500c0a0`).

That is why the thread's death blacks out Choose Class: when the worker is gone,
every async file read times out with zero bytes. It also cross-confirms the
blitter-overrun finding below — my run saw `[ebx+0x18] = 0x1fe` with
`[+0x1c]=0x2a` and `[+0x24]=0xeb`, which are copier opcode bytes, exactly the
`0x4` / `0xc7ff0788` values that section reports.

Worker loop counts to batch 41500 (`--count`): body `0x6aeeb9` = 30, good tail
`0x6aef97` = 29, crash block `0x6aeec4` = 17. It is not dying on its first job.

#### Ruled out here, with the measurement

- **Host file I/O.** `--trace-api=ReadFile,CreateFileA`: 474 reads, every one
  returns exactly the byte count requested. **No host read at `0xcebf2` ever
  happens** — the failure is entirely upstream of the VFS. The single `n=0x0`
  read belongs to block 22 on thread 1, not to selhero.
- **A corrupt MPQ block table in guest memory.** `--dump=0x8155ac:64` gives
  block 23 = pos `0xcebf2`, csize `0x9e6`, fsize `0x3e17`, flags `0x80010100`,
  byte-identical to `node tools/mpq-dir.js spawn.mpq --name='ui_art\selhero.pcx'`.
- **`SFileReadFile` rejecting the handle or the arguments.** Its handle-list-miss
  exit `0x6b1782` = 0 and its argument-validation exit `0x6b1ae8` = 0.
- **`SFileOpenFile` failing.** `storm+0x15002019` = 0 over 40 `SBmpLoadImage`
  calls.
- **The `WS_EX_TRANSPARENT` branch of `SDlgBeginPaint`.** `0x1000e`'s exstyle is
  `0x00010000`; the bit is clear.
- **Striping being a pitch/palette bug.** See the withdrawal above.
- **Superimposed title strings being part of this.** They are a separate,
  smaller bug: `hwnd 0x1001b` ("Single Player Characters", 25,161,590×35) is
  invalidated a second time by `InvalidateRect(0x1001b, NULL, FALSE)` from
  `0x6e6e69` with no `(…, TRUE)` follow-up, so `fErase` is FALSE, Storm skips
  the per-control art fill, and the new text lands on the old.

#### Addresses named by this investigation (original VAs)

| VA | What |
|---|---|
| `storm+0x15001d10` | `SBmpLoadImage` (export #8); `+0x15001e48` = the 0x80-byte header `SFileReadFile`; `+0x15001e51` = its failure block; `+0x15002019` = open-failed exit |
| `storm+0x15004f00` | `SDlgBeginPaint` (export #15); `+0x15004fed` = the do-nothing STUB tail |
| `storm+0x15005010` | `SDlgBeginPaint`'s background-record lookup (0 ⇒ stub tail) |
| `storm+0x15007e60` | `SDlgDrawBitmap` |
| `storm+0x150081e0` | `SDlgSetBitmap` (export #33) — builds the record list at `[0x1503110c]` |
| `storm+0x1500e730` | `SFileReadFile`; `+0x1500e782` handle-miss exit, `+0x1500e8ae` sync/async selector on `[archive+0x108]`, `+0x1500ea5e` sync call, `+0x1500eabd` short-read compare, `+0x1500ead4` `ERROR_HANDLE_EOF` return, `+0x1500eae8` arg-validation exit, `+0x1500e97f` async node enqueue |
| `storm+0x1500c0a0` | synchronous sector reader, fastcall `ecx`=handle `edx`=filePos, `[esp+4]`=buf `[esp+8]`=size; returns 0 without I/O when `edx >= fsize` |
| `storm+0x1500c2e0` | the sector reader it calls (cache at `[archive+0x110..0x120]`) |
| `storm+0x1500be5c` | shared async worker body; `+0x1500bec4` = the sound-job branch it must not take for a file job |
| `storm+0x15020cd0` | the worker thread's start address (runtime `0x6c3cd0`) |
| `diabloui+0x200097e0` | art helper; `+0x20009808` dimension-query `SBmpLoadImage`, `+0x2000980d`/`+0x20009857` the two failure tests, `+0x20009949` the shared failure exit |
| `diabloui+0x2000df28` | the call site that loads `ui_art\selhero.pcx` (string at `diabloui+0x2001e960`) |
| `diabloui+0x20022478` | the sprite-frame pointer array (runtime `0x702478`) |

Runtime twins used above, for reading traces: `0x6a4d10`/`0x6a4e51`/`0x6a5019`
(`SBmpLoadImage`), `0x6af0a0` (sync reader), `0x6aeec4` (crash block),
`0x6b1730`/`0x6b1782`/`0x6b1ae8`/`0x6b1ad4` (`SFileReadFile`), `0x6e97e0`
/`0x6e9818`/`0x6e9860` (art helper), `0x6edf2d` (selhero call return).

#### Not determined

- Whether the geometry/hit-test mismatch is a *separate* bug or purely a
  consequence of the zero-sprite load. It cannot be separated until art loads.
- Whether the uncommitted `src/09a-handlers.wat` / `src/10-helpers.wat` work in
  the tree at the time of these runs makes this better or worse than `HEAD`;
  every number above includes it.

### FIXED-BUT-INCOMPLETE (re-measured 2026-08-25): Storm audio pump thread dies

**The death no longer reproduces, and the list head is no longer clobbered.**
Three runs on the fast recipe — 1000 batches (menu), 3200 batches (menu, idle)
and 3300 batches driven all the way into Tristram — all end with

```
T1 h=0xe1000 state=active eip=0x6af04f  …  waitH=0xe0001
Hexdump 0x006d46c0:  00 00 00 00 | 00 00 00 00 | 00 10 0e 00 | 18 60 3e 08
```

`0x6af04f` is `storm+0x1500c04f`, the pump's own idle head — it reads the list
head and picks a `Sleep` length from it (`0xfa` when empty, `5` when not), so T1
is parked in its normal loop, not dead. The head at `0x6d46c0` reads **zero**,
not `0x4fc69xxx` copier bytes, and `0x6d46c8`/`0x6d46cc` still hold the pump
thread handle `0xe1000` and the `IDirectSound` object `0x083e6018`. The art test
asserts the same thing from the `[thread-event]` side and passes.

**What that does not say.** A head of zero means *no stream node was ever
linked*, so the pump was idle the whole time and the `Lock` path below was never
re-entered. In other words the wild store is gone, but this measurement does not
prove the audio path works — it proves it is not crashing. Diablo is silent in
these runs and finding out why is a separate, unstarted question; start it by
counting `storm+0x1500ba65` (the return landing of the
`IDirectSound::CreateSoundBuffer` vtable call).

> **Trap, paid for once here:** `--count=storm+0x1500ba62` reads **0** and means
> nothing, because `0x1500ba62` is the `call [eax+0xc]` itself and `--count`
> only fires on basic-block entries. The same goes for `0x1500c9dc` and
> `0x1500bfe2` in the table below: both are mid-block stores. Probe
> `0x1500ba65`, `0x1500c9d4` and `0x1500bfdf` instead — a call-return landing
> and two `jz` fall-throughs. A zero from a bad probe address looks exactly like
> a zero from code that never runs.

History follows.

Thread 1 ends with EIP=0, last logged block entry `storm+0x1500bec4`, just
before the `IDirectSoundBuffer::Lock` vtable call.

> **Withdrawn:** this was first read as "null `IDirectSoundBuffer` at
> `[ebx+0x18]`". That cannot be it — `0x1500beb9` tests exactly that pointer and
> jumps away when it is null. More likely a null or stub slot at `+0x2c` of the
> vtable we synthesize, an object pointer that is not a real COM wrapper, or a
> death somewhere earlier with `0x1500bec4` merely being the last block we logged.

> **Withdrawn (that replacement list too):** all three of those guesses are now
> disproved by measurement — see "Ruled out" below. `[ebx+0x18]` is neither null
> nor a wrapper: it is small **non-null garbage**, which is exactly why it slips
> past the `test ecx,ecx / jz` guard.

#### The actual mechanism

Registers at the death (`--break=storm+0x1500bec4 --break-once`, plus the
`ThreadManager` register dump on the fatal batch):

```
prev_eip=0x6aeec4  ebx=0x4fc69ce0  ecx=0x4  edx=0x4fc69cf4  edi=0x0
```

- `ecx = [ebx+0x18] = 4` — non-null, so the guard at `0x1500bebe` lets it through.
- `edi = [ecx] = [0x4] = 0` — that guest address is far below `image_base`, so
  `g2w` falls back to `NULL_SENTINEL`, a zeroed page.
- `call [edi+0x2c]` = `call [0x2c]` = `call 0`. EIP=0. `Lock` is never entered.

So `ebx` is **not a live work node**. The list the pump walks
(`storm+0x150316c0`, next at `+0x30`) is corrupt: it points into Storm's
generated-code arena.

```sh
timeout 300 node test/run.js --app=diablo_shareware --time-scale=30 \
  --max-batches=39168 --no-close --dump=0x6d46c0:8,0x4fc69c00:0x600
```

`[0x6d46c0]` (the list head) held `0x4fc69d60`, and the bytes there are Storm's
runtime-built unrolled OR-blit copier, not a node:

```
0x4fc69d10  8a 06 8a 1f ff c6 0a c3 88 07 ff c7 8a 06 8a 1f
0x4fc69d20  ff c6 0a c3 88 07 ff c7 8a 06 8a 1f ff c6 0a c3
0x4fc69d30  88 07 ff c7 e9 00 00 00 00 00 00 00 00 00 00 00
...
0x4fc69d60  88 07 ff c7 e9 00 00 00 00 00 04 00 e1 a3 0b 00
```

`8a 06 8a 1f ff c6 0a c3 88 07 ff c7` is one unrolled copied byte; `e9 rel32`
terminates it. In another run `[ebx+0x18]` read literally `88 07 ff c7`
(`0xc7ff0788`) — i.e. the pump read four bytes of that copier as its
`IDirectSoundBuffer`. Healthy nodes live at `0x4fc684xx..0x4fc68axx` on a `0x40`
stride; the corrupt ones are all at `0x4fc69xxx`.

#### Who clobbers the list head

Watch the head itself — the watch is propagated to T1, and T1's line names the
value on both sides:

```sh
timeout 300 node test/run.js --app=diablo_shareware --time-scale=30 \
  --max-batches=39200 --no-close --watch=0x6d46c0 --watch-log
```

Every *legitimate* head write is T1's and lands where it should: the link at
`0x1500c9dc` (`eip=0x6af9ed`, new head in `esi`) walks the list up
`0x4fc68460 → 0x4fc68a50 → … → 0x4fc68e30`, and the unlink `mov [ecx],eax` at
`0x1500bfe2` (`eip=0x6aefef`) takes it back down. All of those are `0x4fc684xx`
–`0x4fc68exx` nodes on a `0x40` stride.

Then, on the **main** thread:

```
*** WATCHPOINT hit at batch 39165: [0x006d46c0] changed
  Old: 0x00000000  New: 0x4fc69d60  EIP: 0x4fc687d0  prev_eip: 0x006a7d49
```

`EIP` is **inside the sparse arena** — main is executing Storm's generated
row-blitter — and `prev_eip = 0x006a7d49` is `storm+0x15004d49`, the blitter's
per-row trampoline:

```
15004cd1  mov [edx+esi-0x4], eax   ; patch the terminating e9 rel32
15004cf8  mov [eax+ecx-0x4], edx   ; ditto, [struct+0x40] = len, [struct+0x44] = buf
15004d0e  mov edi, [eax+0x10]      ; blit destination
15004d3c  jmp eax                  ; into the unrolled copier
15004d3e  dec [esp+0x4] / jz 0x15004d90
15004d49  add esi,[esp+0xc] / add edi,[esp+0x10] / jmp eax   ; next row
```

So the corruption is a **wild store by the generated blitter**, not by anything
in the audio code: it writes four bytes over `storm+0x150316c0`, and the audio
pump then walks a "list" whose head points at copier bytes. That also explains
why `[ebx+0x18]` reads as `0x4` / `0x1fe` / `0xc7ff0788` — those are copier
opcode bytes, and `0xc7ff0788` is literally `88 07 ff c7` (`mov [edi],al; inc
edi`).

This puts the audio-thread death and the logo-blink bug on the **same**
machinery. Fix the blitter overrun and check both.

**Still open:** why the blitter overruns. Both the copier and the nodes live in
the same `SMemAlloc` arena
(`VirtualAlloc(0, 0x400000, MEM_RESERVE)` then `0x10000` commits at
`0x4fc00000 … 0x4fc60000`, all from `ret=0x006c6ac1`). Remaining emulator
suspects, neither excluded: stale generated-code blocks in the per-thread block
cache (`cache: block decodes 131634, evicted a live block 126403; page
invalidations 4025 that dropped a block 129, last 0x4fc68000`), and a code-write
path that skips `$invalidate_code_write`. Note the logo-blink entry's
"forcing `$cache_lookup` never to reuse a sparse-arena block produced
byte-identical PNGs" test checked **pixels only** — it says nothing about
whether T1 survived.

#### Newly named storm addresses (original VAs)

| VA | What |
|---|---|
| `0x1500ba62` | `IDirectSound::CreateSoundBuffer(desc, &[esi+0x28], NULL)` — so **`[stream+0x28]` is the `IDirectSoundBuffer`** |
| `0x1500bdbc..0x1500be47` | winner-selection walk over the node list (`GetTickCount`, `[edx+0x30]` = next) |
| `0x1500bfba..0x1500bfe2` | the unlink walk (`&head` in `ecx`, `[eax+0x30]` chase) |
| `0x1500c8e0` | node constructor, `ret 0x20`, fastcall `ecx`/`edx` + 8 stack dwords; `SMemAlloc(0x34)`, `rep stosd` of 0xd dwords, then fields `+0x0` event, `+0x14` arg1, **`+0x18` arg2 = the sound buffer**, `+0x1c`, `+0x20`, `+0x24`, `+0x28` |
| `0x1500c9dc` | `mov [0x150316c0],esi` — the **only** site that links a node |
| `0x150102b0` / `0x15010690` | `SMemAlloc(size,file,line)` / `SMemFree(ptr,file,line)` |
| `0x15034b40` | Storm heap `CRITICAL_SECTION` (runtime `0x6d7b40`, owner dword `0x6d7b4c`) |
| `0x150316c4` / `0x150316c8` / `0x150316cc` / `0x150316e8` | flag / pump thread handle (`0xe1000`) / `IDirectSound` object (`0x083e6018`) / stream list head |

Only three call sites reach the constructor (`node tools/xrefs.js storm.dll
0x1500c8e0`): `0x1500bd0c` and `0x1500bd89` inside the pump (arg2 =
`[esi+0x28]`), and `0x1500e97f` with arg2 = 0 (the no-DSound path).

#### Ruled out, each with a measurement

- **A null or stub slot at vtable `+0x2c`.** `--break=storm+0x1500bec4
  --break-once` shows T1 reaching that site ~16 times with `ecx=0x83e6048` — a
  real COM wrapper — and surviving every one. `api_table.json` has all 21
  `IDirectSoundBuffer_*` methods and `$DX_VTBL_DSBUF` is built with 21 slots
  (`09b2-dispatch-table.generated.wat:11658`).
- **A bad `IDirectSoundBuffer` from `CreateSoundBuffer`.** `--trace-api` shows
  `IDirectSound_CreateSoundBuffer(0x083e6018, 0x074ffefc, 0x4fc68448, 0)` from
  ret `0x006aea65`, and `--watch=0x4fc68448 --watch-log` shows it receiving
  `0x083e6048`. The plumbing is right; the pump just isn't reading a node.
- **The stale-`edi` / wild `rep movsd` theory.** `edi=0` at the death and the
  thread ends at EIP=0 — a store fault cannot produce that.
- **`g2w` split-brain over the sparse arena.** `--dump-vmap`: 11 mappings, zero
  overlaps, contiguous backings; `[0] 0x4fc00000..0x4fc10000 → 0x08000000`,
  `[10] 0x4fc10000..0x4fc70000 → 0x080f1000`.
- **Our critical-section emulation being a no-op.** `--watch=0x6d7b4c
  --watch-log` gives 6390 clean `0→1→0` transitions, set at `0x006b32c5`
  (`SMemAlloc` just after its `Enter`) and cleared at `0x006b36a5`
  (`SMemFree`'s `Leave`).
- **`$current_thread_id == 0` making main-owned sections look free.** Main is 1,
  workers are `tid+1`.

#### Two things the rest of this file gets wrong

- **Flags change the execution; repetition does not.** The fatal `ebx` was
  `0x4fc69bb0`, `0x4fc69ce0` and `0x4fc69fc0` — but across three *different*
  flag configurations, and one `--watch=0x6d7b4c` run **never created T1 at
  all** (`cache: full clears M 1`, no `ThreadManager` lines, `gdi: dc_states 1`
  instead of 4). This was first written up as "runs are non-deterministic once
  T1 exists"; that is **withdrawn** — the same command line twice is
  byte-identical, see "Getting to a screen headlessly". The real lesson is
  narrower and sharper: a debugging flag is part of the experiment. Never
  compare a number taken under `--watch` against one taken under `--break`.
- **`--break` and `--watch` propagate to worker WASM instances; `--trace-at`
  does not** (armed on the main instance only, `test/run.js` ~line 6436). A
  `--trace-at` that prints nothing for T1 is not evidence of anything.
- **`--trace-at` fires on *block entry*, not on instruction execution.** A
  self-loop that iterates thousands of times registers **one** hit, so any
  iteration count taken from it is meaningless — 191 rows for the sector loop is
  191 entries into the loop block. Worse, some perfectly real addresses produce
  no output at all because they are not block entries:
  `diabloui+0x20001635` (the `rep stosd` right after the PCX loader call) and
  `storm+0x1500ead4` under `--break` both printed nothing while `--count` says
  they execute. Prefer `--count`: it is native, full speed, takes up to 16
  addresses, and does not lie about either.
- **Cost, measured.** A plain 12000-batch run is 6.5s and a full 40100-batch
  `--count` run is ~55s. `--trace-at` on a hot address is what makes a run take
  five minutes and emit a 57k-line log — the batch budget is not the expensive
  part.

## Emulator-side context worth knowing here

- Storm builds an **unrolled byte copier at runtime** in a sparse `VirtualAlloc`
  arena (guest `0x4fc10000..0x4fc70000`): 8 code bytes per copied byte,
  terminated by an `e9 rel32` rewritten on every call. Any change to code-cache
  invalidation has to survive this.
- `--loop-superops` is off by default because `COPY_RUN` miscompiles Storm's MPQ
  decompression byte copy and renders Diablo's menus as colour noise. If menus
  look like noise, check that flag before investigating anything else.

### The generated copier, read properly

The description above ("8 code bytes per copied byte, terminated by an
`e9 rel32`") is right about the unit and wrong about the shape. Dumped live at
the moment of the disputed store
(`--watch=0x6d46c0 --watch-log --dump=0x4fc687a0:0x60`):

```
0x4fc687c0  8a 06 ff c6 88 07 ff c7  8a 06 ff c6 88 07 ff c7
0x4fc687d0  8a 06 ff c6 88 07 ff c7  e9 d7 f2 cc b0 00 00 00
0x4fc687e0  8a 06 ff c6 88 07 ff c7  8a 06 ff c6 88 07 ff c7
0x4fc687f0  8a 06 ff c6 88 07 ff c7  e9 43 f5 a3 b0 00 00 00
```

The unit is `8a 06 / ff c6 / 88 07 / ff c7` — `mov al,[esi]; inc esi;
mov [edi],al; inc edi` — and this variant has no `0a c3` (`or al,bl`), so it is
a plain copy, not the OR-blit. It is **not one long unrolled run**: it is a
table of `0x20`-byte cells, each three copy units plus a jump and three bytes of
padding. Entering at a cell's first, second or third unit copies 3, 2 or 1 bytes
before the jump, which is how the generator handles a length remainder.

**Both terminators in that window resolve correctly**, so there is no stale
`e9` and the code-invalidation theory gets no support here:

| terminator | rel32 | target | what it is |
|---|---|---|---|
| `0x4fc687d8` | `0xb0ccf2d7` | `0x00937ab4` | an address the run really does execute |
| `0x4fc687f8` | `0xb0a3f543` | `0x006a7d40` | `storm+0x15004d40`, the row trampoline |

Do the arithmetic as `next_insn + (rel32 - 0x100000000)`; getting the borrow
wrong yields a target off by exactly `0x10000000` and invents a bug that is not
there. (It did here, for a while.)

Code invalidation also looks sound by inspection rather than by theory:
`$invalidate_code_write` (`src/03-registers.wat:215`) has an explicit
`$generated_sparse_code_start..end` test *in addition to* `$code_page_test`,
precisely for this arena, and all three store widths (`$gs8`/`$gs16`/`$gs32`)
call it, with `$invalidate_code_range` covering the interior pages of a bulk
copy. If the copier is the culprit, it is not because we missed the write.

### The disputed store is a pointer, not pixels

`[0x6d46c0]` changing `0 → 0x4fc69d60` was read as "a wild store by the
generated blitter". Treat that with suspicion: `0x4fc69d60` is a well-formed
pointer into the arena, and the copier writes **one byte at a time**, so four
consecutive blitted pixels would have to spell a valid allocation address.
`0x1500c9dc` (`mov [0x150316c0],esi`) stores exactly such a pointer as its
normal job.

The overlap that would explain it is real enough to test, and the test is
one run:

```sh
timeout 260 node test/run.js --app=diablo_shareware --time-scale=30 \
  --max-batches=39200 --no-close --watch=0x4fc69d60 --watch-log
# one change all run: 0 -> 0x0000ea9c, EIP 0x4fc687f8, prev_eip 0x00937ec4
```

So `0x4fc69d60` is written **as blit output** by the copier — that region is a
destination buffer at that moment, while Storm's node list head elsewhere holds
it as an allocation. Two different roles for one address is the shape of an
**overlapping allocation**, not of a stray store. That is now the leading
hypothesis for the audio-worker death, and it is *not* yet proved: `--dump-vmap`
reports 11 mappings with zero overlaps, so if the arena is being double-issued
it happens above `VirtualAlloc`, inside Storm's own suballocator, which means
our bug is whatever makes Storm's bookkeeping disagree with itself.

**Caveat on the EIP field.** A watchpoint is checked at block boundaries, so its
`EIP` is where the change was *detected*, not the instruction that made it. In
the `0x6d46c0` hit the register dump (`EAX == EIP == 0x4fc687d0`, consistent
with the `jmp eax` at `0x15004d3c`) shows `EDI = 0x007540e7` — nowhere near the
watched address, which on its own rules out "that block's `mov [edi],al` did
it". Use `prev_eip`, and prefer `--count` on a candidate store site to a
watchpoint's EIP.

## The cache under you changed: page compilation landed (2026-08-24)

`perf/page-compile` merged into main. If you are debugging Diablo's menu art,
read this before re-deriving anything about invalidation, because `6b801a9d`'s
mechanism is **gone** and its guarantee is provided a different way.

What is no longer true:

- **There is no hash block cache.** `$cache_slot` / `$cache_lookup` /
  `$cache_store` and the 4096-slot sweep are deleted. Decoded code lives in
  per-page chunks with an 8KB offset index per page; a page's directory slot is
  the authority on what is compiled. So the board note *"the top 4 bits of the
  cached arena offset now hold the block's page span, read it through
  `$cache_lookup`"* no longer applies — there is no such field and no such
  function.
- **A decoded block never crosses a 4KB page.** The decoder cuts at the page
  edge. This is why the span field was droppable: the bug it existed for — a
  block beginning near the end of page A, running into page B, surviving a
  rewrite of its own tail — cannot be constructed any more. Storm's unrolled
  byte copier entered at `end - 8*count` now decodes as one block per page.
- **Invalidation is per guest offset, not per page.** A write to offset X of a
  code page retires exactly the block covering X, in one load, and the rest of
  the page keeps running compiled. `$invalidate_code_range(ga, len)` walks every
  page of the span and retires per offset inside each, so the "every page it
  covers" property of `6b801a9d` is preserved — as a property of the walk.
  Above a 512-byte span within one page it drops the whole page instead, which
  is the old behaviour kept for the `REP MOVS`-over-code case.
- **The CODE_PAGE_BITMAP bit is never cleared**, deliberately: the page
  directory is per-thread and the bitmap is shared, so clearing it would tell
  the other threads a page holds no code and strand their stale blocks. Storm
  and Smacker rewriting blitters in place is exactly that case.

Your `src/05b-string-ops.wat` change is **kept**: `rep movs`/`stos` invalidate
the whole destination extent. It is spelled `$invalidate_code_write(addr, len)`
now (two params, cheap decline for a single-page write, else the range walk),
and on the backward-dword case it covers 3 bytes more than the endpoint form.
`test/test-sparse-generated-code-cache.js` passes.

**What was not verified, and is yours.** On the merged build the main menu shows
the flaming logo at batch 40000 and no logo at 40100 and 40200
(`--app=diablo_shareware --time-scale=30 --max-batches=40300`). That is the
shape of the symptom `6b801a9d` fixed *and* the shape of the still-open Storm
explode short-read above (12 of 15 logo sprites black at load time), and no
side-by-side run against pre-merge main was done to tell them apart. The merge
was taken with that knowingly unresolved. If the logo did regress, the thing to
suspect is **not** a missing span field — it is whether the per-offset retire
names the right block when generated code is rewritten at an offset that is not
a block start. `$page_retire_at` and section 5.1 of
`docs/page-compile-design.md` are where to look, and `--decode-stats` reports
`page_retires` / `page_range_drops` / exact-hit share for that window.

### The menu logo's decode buffer, diffed against ground truth (2026-08-24, `diablo-pcx-diff`)

New section; nothing above is rewritten. One withdrawal is marked at the end.

**The animated menu logo is `ui_art\smlogo.pcx` (block 22, 390 × 2310, fsize
333,227), not `ui_art\logo.pcx`.** Confirmed two ways: the 900,900-byte
`SMemAlloc` the multi-frame builder makes is exactly 390 × 2310, and all **six**
static call sites of the builder `diabloui+0x20001610` push
`diabloui+0x2001e18c = "ui_art\smlogo.pcx"` (`node tools/xrefs.js diabloui.dll
0x2001e18c`); `"ui_art\logo.pcx"` has one xref and it is not the builder. The
"Logo blinks on the main menu" section above says the builder loads
`ui_art\logo.pcx` (390 × 2310) — that filename is **withdrawn**; the geometry it
quotes was always smlogo's.

#### Getting the guest's buffer out without a src/ change

The builder's decode buffer is `SMemAlloc(w*h)` in `LoadArt`
(`diabloui+0x20009740`), and Storm's `SMemAlloc` bottoms out in a guest
`HeapAlloc`, so `--trace-api=HeapAlloc` names it with no instrumentation:

```
[API #21491] HeapAlloc(hHeap=h:0x00140000, dwFlags=0, dwBytes=0x000dbf30) [ret=0x006c3ff0]
  => 0x00a7bc04        <-- 900,912 = 900,900 + 12; the image plane starts here
[API #21538] HeapAlloc(... dwBytes=0x00051530) => 0x00cb130c   <-- the 333,099-byte PCX body read buffer
```

The block is freed at the end of the builder but **not** overwritten before the
run ends, so a plain post-run `--dump` recovers it:

```sh
node test/run.js --app=diablo_shareware --time-scale=30 --max-batches=40100 \
  --no-close --dump=0xa7bc08:900900
node tools/mpq-extract.js <spawn.mpq> --name='ui_art\smlogo.pcx' --pixels=/tmp/smlogo.idx
```

`--pixels=PATH` (new, uncommitted) writes the decoded 8bpp index plane —
`height * bytesPerLine` bytes, exactly what the guest's buffer should hold.
`--src-of=N` (also new) reports which byte of the compressed PCX stream produced
output byte *N*, which is what turns an image-space offset into a sector index.

#### The four answers

1. **First differing byte: image offset 168,597 (0x29295)** — row 432, column
   117; **frame 2, row 124 of 154**. Everything before it is byte-identical to
   the archive: frames 0 and 1 are perfect (0 differing bytes of 60,060 each),
   frame 2 is perfect for its first 124 rows. 18.7% of the image is right, which
   is the "about 2.5 of 15 frames" the section above measured from the sprites.
2. **The tail is a short decode, not a mis-decode.** From 168,597 to 891,911 the
   guest buffer is **all zero** — 723,315 consecutive zero bytes. The only
   non-zero bytes after the divergence are the last ~9KB, and they are
   `8b 06 8b 1f 81 c6 04 00 00 00 0b c3 89 07 81 c7 04 00 00 00` repeated —
   Storm's runtime-built unrolled **dword OR-blit copier**, i.e. the freed block
   being reused for generated code after the builder returned. That is a
   dump-after-free artifact, not decode output.
3. **Sector 15.** `--src-of=168597` says image byte 168,597 comes from PCX file
   offset **0xFFFF**, which is the **last byte of MPQ sector 15** (4096-byte
   sectors; sector 15 spans 0xF000–0xFFFF). The token there is a run token whose
   *value* byte lives at 0x10000 in sector 16; the guest read the run byte and a
   zero value byte, so it painted a 25-pixel run of index 0 and then literal
   zeros forever. Input bytes 0x80–0xFFFF were all delivered correctly.
4. **Exactly on a sector boundary — the 15/16 one, i.e. file offset 0x10000
   (64 KiB).** Not the 0x20000 chunk boundary, and not an arbitrary offset. The
   guest received `0x10000 - 0x80 = 0xFF80` = 65,408 bytes of the 333,099 it
   asked for.

#### What the emulator gets wrong (best-supported statement)

The whole load runs on **worker thread T1**, over Storm's async 0x20000-chunk
path — which is why every `--trace-at`/`--break` probe on it from the main
instance comes back empty (`--trace-at` is main-only; `--break --break-thread=T1`
produced no hit either). `--trace-api=ReadFile,SetFilePointer` shows the entire
host-side conversation for block 22, and it is *not* short:

```
[API T1] SetFilePointer(h, 0x0009a361)              ; block 22 base
[API T1] ReadFile(h, 0x4fc699a0, 0x0000014c, ...)   ; the 83-entry sector table
[API T1] ReadFile(h, 0x009d702c, 0x00000a19, ...)   ; sector 0 (2585 bytes)
[API T1] SetFilePointer(h, 0x0009a4ad)              ; sector 0's archive offset
[API T1] ReadFile(h, 0x009d702c, 0x00000a19, ...)   ; sector 0 again
[API T1] ReadFile(h, 0x00a67a7c, 0x00014176, ...)   ; 82,294 bytes = sectors 1..31
... later ...
[API T1] ReadFile(h, 0x4fc69480, 0x00000000, ...)   ; a ZERO-length read, then it gives up
```

`0x14176` from archive `0x9aec6` ends exactly at sector 32's archive offset
`0xaf03c`, so Storm read the compressed bytes for **sectors 0..31 — the full
first 0x20000 chunk** — and the host handed all of them over. But only
**sectors 0..15** ever became output. So the compressed input arrived and half
of it was thrown away between the read and the caller's buffer.

Two numeric coincidences worth chasing, both consistent with everything measured:

- The per-sector loop count in `storm+0x1500c2e0` is `ceil(bytes/0x1000)`
  (`lea eax,[ecx+edx-1] / sub edx,edx / div ecx` at `0x1500c6db`, count kept in
  `[esp+0x14]`). 16 iterations instead of 32 means that `bytes` was **0x10000
  where it should have been 0x20000** — the chunk size halved *after* the
  read-span computation, which used 0x20000 correctly.
- Equivalently, delivered `0xFF80` is `0x1FF80 & 0xFFFF`: the chunk's true byte
  count (0x20000 − 0x80) **truncated to 16 bits**. This run cannot separate the
  two — the read starts at file offset 0x80, so "stop at the 64 KiB file
  boundary" and "count truncated to 16 bits" predict the same 0xFF80. A file
  whose body read starts somewhere other than 0x80 would separate them.

Either way the statement that survives is sharper than the one above: **it is
not explode. Explode is fed 16 of the chunk's 32 sectors, because the byte count
that drives the per-sector loop arrives halved (0x10000 for a 0x20000 chunk),
and `SFileReadFile` then reports the short delivery via ERROR_HANDLE_EOF while
`SBmpLoadImage` ignores it and RLE-decodes the zero tail into black.** The next
probe is the register state at `storm+0x1500c6db` (`[esp+0x24]` = the byte count,
`ecx` = 0x1000) **on T1** — and note that reaching it needs a T1-capable
breakpoint, since this whole path never executes on main.

#### Corroboration and non-findings

- The divergence is reproducible and flag-independent in the sense that matters:
  the buffer address `0xa7bc04` and the first-diff offset came from two
  *different* command lines (`--trace-api=...` and `--dump=...`) and agree.
- `frames 3–14 all zero` in the diff matches the sprite payload evidence above
  (12 sprites of exactly 60,992 bytes = the fully-opaque worst case) from a
  completely independent measurement.
- A trap for the next agent: `--count` counters live in **shared memory**
  (`HIT_COUNT_BASE`), so they include worker threads, while `--break`/`--trace-at`
  arm a **per-instance** global. `--count=diabloui+0x20009740` says 15 while
  main-only `--trace-at` sees 12 — the missing 3 are T1's, and 3 of them are this
  bug's. Do not read that gap as a dropped breakpoint.

## Regression test: `test/test-diablo-shareware-art.js` (added 2026-08-24)

The three open bugs above now have one automated check. Run it with:

```sh
node test/test-diablo-shareware-art.js
```

(also wired into `test/run-all.sh`'s `E2E` tier). It spawns **one** pinned run —
`--app=diablo_shareware --time-scale=30 --max-batches=41500 --no-close
--repaint-every=200 --trace-thread`, 15 logo PNGs at batches 39800+3k, Enter at
40000/40060, the Choose Class capture at 41400 — and takes 60–95 s. Captures land
in `build/diablo-shareware-art/`, the run log in
`build/diablo-shareware-art.log`. `node test/test-diablo-shareware-art.js <dir>`
re-scores an existing capture directory without re-running.

What it asserts, all three in pixels or in `[thread-event]` JSON, never in exit
codes or file sizes:

1. **≥13 of 15 logo captures match a frame of `ui_art\smlogo.pcx`.** The 15
   frames are extracted from `spawn.mpq` by `tools/mpq-extract.js
   --frame-height=154` at test time, so the archive is the oracle and there is
   no golden file to rot. Each capture's lit-pixel mask over the 390×154 logo
   rect at (126,0) is scored by IoU against the best-matching archive frame.
   Measured separation: correct art **0.74–0.82**, full-bright colour noise
   **0.25**, solid black **0.00**; the gate is 0.55. Scoring against the archive
   rather than a brightness threshold matters — this rectangle can come back as
   noise, which any "is it lit" count would pass. A secondary check requires ≥3
   *distinct* sprites across the samples, so a frozen animation cannot pass.
2. **≥7 of 9 `ui_art\selhero.pcx` panel outlines are drawn on Choose Class.**
   That art is a mostly-black 640×480 background — the whole frame is ~1.1% lit
   whether or not it loaded — so the assertion is on the nine outline segments,
   each 100% lit in the archive and 0% today, searched ±4 px for placement.
3. **No thread exits with `eip=0`.** Parsed from the `[thread-event]` lines
   `--trace-thread` prints; the test also asserts Storm's worker was spawned at
   all, so a run that never creates T1 cannot pass by omission.

If the emulator's timing moves and the samples land off the menu, the test says
so with its own message ("the main menu was not on screen for N of 15 logo
captures") instead of blaming the art — re-derive `LOGO_FIRST` in that case.
Changing the flags changes the execution, so treat the command line as part of
the test.

Failing output on `9b9a98c9` (page-compile main, 2026-08-24):

```
logo frame IoU vs archive: 0.00 0.00 0.00 0.00 0.00 0.00 0.00 0.81 0.82 0.82 0.74 0.00 0.00 0.00 0.00
logo frames matching the archive: 4/15  (distinct sprites seen: 0,1,2)
choose class panel segments drawn: 0/9
  - only 4 of 15 main-menu logo captures match a frame of ui_art\smlogo.pcx
  - only 0 of 9 ui_art\selhero.pcx panel outlines are drawn on Choose Class
  - Storm's shared async worker (thread 1) died with EIP=0 at batch 39381
```

Only sprites 0, 1 and 2 ever match — the same "3 of 15 decode, the rest are
zeroed" shape the sections above measured from the sprite payload sizes.

## Show Credits

Measured 2026-08-24 on the working tree at `d627e9c5` (which also carried the
uncommitted `host.js` / `lib/filesystem.js` / `src/09a-handlers.wat` /
`src/10-helpers.wat` / `tools/mpq-extract.js` hunks other agents owned at the
time). Every number below includes them.

**Verdict: the screen works; two things on it are broken.** The menu item
transitions, the credits scroll runs and animates, and Escape returns to the
menu. The background art is missing (black), and every line of credits text
renders as a solid white rectangle instead of glyphs. Neither is a new bug in
the credits code — one is the already-documented dead Storm worker, the other is
our `ExtTextOut`/`GetDIBits` memory-DC path.

### Repro

"SHOW CREDITS" is the 4th menu item; the five items sit at y ≈ 213, 256, 299,
342, 385, so it is a click at **(320, 342)**.

```sh
timeout 500 node test/run.js --app=diablo_shareware --time-scale=30 \
  --max-batches=41200 --no-close --repaint-every=200 \
  --input=39400:mousemove:320:342,39500:mousedown:320:342,39620:mouseup:320:342,\
40000:png:/tmp/cr2.png,40001:png:/tmp/cr3.png,41000:png:/tmp/cr6.png
```

Escape gets back out:

```sh
  --input=...,40800:keydown:27,40860:keyup:27,41100:png:/tmp/e1.png
```

The transition is immediate — the screen is already the credits screen at 39800.
The scroll really animates: captures at 40000/40001/40002 differ, and by 41000
different lines are on screen at different widths. It is not a frozen frame.

### 1. The background: the dead shared worker again, nothing new

`ui_art\credits.pcx` is block 1002, csize 115344 / fsize 157403, a single 640x480
PCX of the Tristram tavern (`node tools/mpq-extract.js <spawn.mpq>
--name='ui_art\credits.pcx' --png=/tmp/c.png` renders it correctly host-side, so
the asset and our MPQ decoder are both fine). It is the **only** `ui_art\credits*`
name in the archive — `creditsw.pcx`, `credits.txt`, `cred.pcx`, `credits_l/r.pcx`,
`credits.smk`, `credline.pcx` all miss the hash table.

The credits screen loads exactly one art, and it fails. Counter split across the
transition, same command line, only `--max-batches` differing (39450 vs 41200):

```
                                        pre    post
storm+0x15001d10  SBmpLoadImage          36     37
storm+0x15001e51  its header-read fail    0      1
storm+0x1500ea5e  SFileReadFile sync     58     58   <-- unchanged
storm+0x1500e9c7  SFileReadFile async    25     26
storm+0x1500c8e0  async work-node ctor   33     34
storm+0x1500ead4  ERROR_HANDLE_EOF        1      2
diabloui+0x200097e0 art helper            2      3
diabloui+0x20009949 its failure exit      0      1
```

So the one extra read took the **async** path, enqueued one work node, and came
back with zero bytes. `--trace-fs` confirms it never reached the VFS: **zero**
host `ReadFile`s at `pos=0x2f6024c`, credits.pcx's archive offset, in the whole
run. T1 dies with the documented signature (`prev_eip=0x6aeec4`, `ecx=0x1fe`,
EIP=0) long before the click, so this is the *same* failure as "Choose Class
screen is corrupted", reached by a second route. Nothing credits-specific.

> Note for whoever fixes the worker: `--count` on `storm+0x1500e97f` and
> `storm+0x1500e9d5` reads 0 even when the async path runs every time. Those are
> mid-block addresses. `0x1500e9c7` and `0x1500c8e0` are real block entries and
> are the ones to count.

### 2. The text: our GDI font-sheet rasterization, and it is a *different* bug

The credits are drawn into a plain `SMemAlloc` scroll buffer, not onto a surface.
`diabloui+0x200076a9` is `UiCreditsDialog`'s init: it takes `GetDlgItem(hDlg,
0x3e8)`'s rect, `SMemAlloc`s a **580-wide** buffer (`credits.cpp:0x7a`) and parks
the pointer at `diabloui+0x20020158` (runtime `0x700158`). The scroll geometry
lives at `0x20022bd0` (= 580, the stride) and `0x20022bd4` (= 311, the row count).

Dump it and look at it directly — this is the decisive measurement, because it
separates "the text was composed wrong" from "the blit to screen was wrong":

```sh
timeout 500 node test/run.js --app=diablo_shareware --time-scale=30 \
  --max-batches=41200 --no-close --repaint-every=200 \
  --input=39400:mousemove:320:342,39500:mousedown:320:342,39620:mouseup:320:342 \
  --dump=0x700158:16           # -> buffer pointer, 0x00b75a6c on this run
  # then re-run with --dump=0xb75a6c:180380 and render at stride 580
```

The buffer **already contains solid bars**, so nothing about presentation is
implicated. It holds only **seven distinct byte values** in 180,380 bytes
(`0x00`:121874, `0xe0`:42266, `0xef`:15184, and ~1056 bytes of `0x21`/`0x2c`/
`0x29`/`0x20`). Text rows are 20 px tall on a 22 px pitch.

`0xe0` is not a coincidence. The per-line render loop at `diabloui+0x200079d0`
calls the same helper twice per line: `push 0x1000000` (shadow, colour index 0)
at (x+2, y+2), then `push 0x10000e0` (index 0xE0) at (x, y). The helper at
`diabloui+0x20014b76` is `jmp [0x2002758c]` — IAT slot 16 of `storm.dll` =
**`SGdiTextOut`**. (`0x20014ac8` → slot 43 = `SBltROP3`, the blit of the finished
buffer to the screen.) The main-menu items use the ArtFont sprites instead, which
is why they still render as proper gold glyphs — including on the frame *after*
Escape.

`SGdiTextOut` needs a font sheet, and Storm builds one with **host GDI**, once,
at credits init. Traced (`--trace-api=...`):

1. `CreateCompatibleDC` → memory DC `0x0031008c`
2. 256 × `GetTextExtentPoint32A`, one per charcode
3. `CreateDIBitmap(hdc, &bmih, fdwInit=0, NULL, &bmi, 0)` → `0x0041000b`, 320x320 8bpp
4. `Rectangle(0,0,320,320)`, `SetTextAlign`, `SetTextColor(#000000)`,
   `SetBkColor(#ffffff)`, `SetBkMode(OPAQUE)`
5. **256 × `ExtTextOutA(hdc, x, y, ETO_OPAQUE, lprc=<20x20 cell>, ch, 1, NULL)`** —
   a 16 × 16 grid of 20 × 20 cells
6. `GetDIBits(hdc, 0x41000b, 0, 320, buf=0x00b72864, &bmi, 0)`

Dump that readback (`--dump=0xb72864:102400` at `--max-batches=39900`) and render
it at stride 320. **Only the top ~30% of the sheet has any content, and what is
there is interlaced — every other scanline blank — with glyph forms far larger
than the 20 × 20 cells they were clipped to. The bottom two thirds is all zero**
(0x00 is 82103 of 102400 bytes; the ink/paper values `0x21`/`0xef` are exactly the
two that survive into the scroll buffer's top rows).

That is the whole text bug. Storm reads the sheet back as "anything that is not
the paper index is ink", so a cell of zeros is a **fully inked glyph**, and
`SGdiTextOut` paints the cell solid in the requested colour. 256 solid cells side
by side is the white bar, and its length still tracks the string length, which is
why the screen looks like correctly laid-out text with the glyphs painted out.

**Root cause: our memory-DC text path.** `ExtTextOutA` with `ETO_OPAQUE` into a
DC whose bitmap came from `CreateDIBitmap` (`fdwInit=0`, no initial bits), read
back with `GetDIBits`, does not produce the raster the guest drew. Whether the
loss is in the rasterization or in the readback is **not** determined here; both
are on the same short list. Note it is not a missing API — every call in the list
above succeeds and returns TRUE.

### 3. Exit

Escape returns to the main menu (`e1.png`/`e2.png` above): the five menu items are
back and render as correct gold ArtFont glyphs. Two cosmetic leftovers: the
credits pixels are **not erased** — regular thin white horizontal lines remain
across the whole 640 width and never go away — and the flaming logo is absent on
that frame, which is the separately-tracked logo blink and its ~20% duty cycle,
not something credits did. Exiting by mouse click was not tested.

> **Both leftovers are gone as of 59f11790** (re-measured 2026-08-24, same
> recipe). The "scanlines" were the solid white text bars of §2 seen after the
> fact, not a failed erase — see "State of Diablo Shareware" at the end of this
> file. The logo was present on both re-captured exit frames.

### 4. No crash, no unimplemented API

No trap, no `crash_unimplemented`, no new thread death. The only thread event in
the run is the known T1 exit (`[ThreadManager] Thread 1 EIP=0 …
prev_eip=0x6aeec4 ecx=0x1fe`), which happens before the click and is the cause of
§1.

### Addresses named by this investigation

| VA | What |
|---|---|
| `diabloui+0x200076a9` | `UiCreditsDialog` init; `+0x20007761` loads `ui_art\credits.pcx` via the art helper, `+0x200077ad` `SMemAlloc`s the scroll buffer |
| `diabloui+0x200079d0` | per-line credits render; `+0x20007ab7` shadow pass (colour `0x01000000`), `+0x20007ad2` text pass (colour `0x010000e0`) |
| `diabloui+0x20014b76` | thunk → `storm.dll` IAT slot 16 = `SGdiTextOut` |
| `diabloui+0x20014ac8` | thunk → `storm.dll` IAT slot 43 = `SBltROP3` (scroll buffer → screen) |
| `diabloui+0x20020158` | scroll buffer pointer (runtime `0x700158`) |
| `diabloui+0x20022bd0` / `+0x20022bd4` | scroll buffer stride (580) / row count (311) — runtime `0x702bd0` / `0x702bd4` |
| `storm+0x1500e9c7` | `SFileReadFile` async-dispatch loop exit — a real block entry, unlike `+0x1500e97f` |

`ui_art\credits.pcx` is block 1002, `pos 0x02f6024c`, csize 115344, fsize 157403,
39 sectors, `IMPLODE|ENCRYPTED`.

#### Follow-up: halved, truncated, or neither? (same session, `diablo-pcx-diff`)

**Neither. It is a use-before-fill race: nothing shrinks the count — the data
simply has not arrived yet when the decoder reads the buffer.** The 16-bit
truncation reading in my section above is **withdrawn**; so is the "halved
0x20000 → 0x10000" reading. Measurements, in order:

**1. The chunk byte count that reaches the work node is correct (0x20000).**
`storm+0x1500e95f` is the branch target of the `jb` that skips
`mov eax,0x20000`, so counting it counts the chunks that were *not* clamped:

```
--count=storm+0x1500e93b,storm+0x1500e95f,storm+0x1500e984,storm+0x1500bead, ...
  0x006b193b = 2    chunk-dispatch loop back-edges  -> exactly one read had 3 chunks
  0x006b195f = 13   dispatches that did NOT clamp   -> 2 dispatches DID: two full 0x20000 chunks
  0x006b1984 = 15   node-constructor returns        -> 15 chunk nodes dispatched in all
  0x006aeead = 30   worker jobs that called the sector reader storm+0x1500c0a0
  0x006aeeb9 = 30   worker body entries      0x006aeec4 = 17 sound-job branch
  0x006b1ad4 = 1    the single ERROR_HANDLE_EOF
```

`ui_art\smlogo.pcx`'s body read is 333,099 bytes = 3 chunks (0x20000, 0x20000,
0x1102b), and those are the only two full-size chunks in the whole run. So
`eax` at `0x1500e963` is a clean 0x20000; `0x20000 & 0xFFFF` is 0, not 0xFF80,
which kills the truncation story at its only anchor.

**2. The worker is alive and still producing after the give-up — it is not a
dead worker.** `--watch=0xcc128c --watch-log` on the caller's read buffer
(`0xcb130c` + 0xFF80, i.e. file offset 0x10000, the first byte the image is
missing) fires exactly once:

```
[ThreadManager] T1 WATCH 0xcc128c 0x0 -> 0xe2c1b7fa eip=0x6cf5c8 prev_eip=0x6af8a0 ...
*** WATCHPOINT hit at batch 39381
```

`0xe2c1b7fa` is `fa b7 c1 e2` — **exactly** the archive's bytes at file offset
0x10000. `prev_eip = storm+0x1500c8a0` is explode's **write callback** and
`eip` is inside `storm+0x1502c3c0`. Sector 16 is decompressed correctly, by the
live worker, into the right place — just **late**.

**3. Late relative to the decode — shown inside one flag configuration.** Same
command line, `--max-batches=39381` (so batches 0..39380 run) plus a dump of the
image buffer: the watchpoint has **not** fired yet, and the decoded image
already has its final shape — first divergence at 168,593/168,597, zero tail,
byte-identical to the full run. The picture is finished before the byte that
would have fixed it is written.

**4. The cut does not move when the interleave granularity changes.**
`--batch-size=4000 --max-batches=11000` (same total steps, worker slices 4×
coarser) and `--thread-slices=16` both give a **byte-identical** first
divergence at 168,593. That is expected under the race, not against it: both
knobs scale main's and the worker's step budgets together. What decides the cut
is the *wait deadline*, which is measured in batches:
`lib/thread-manager.js` `checkMainYield()` expires a bounded wait when
`this._now() - startedAt >= waitTimeout`, and the CLI's `_now()` is
`batch * 200`. Storm's `WaitForMultipleObjects(n, handles, TRUE, 255)` at
`storm+0x1500e9d5` therefore gets ~1.3 batches of worker time — which is 16
sectors — and then returns WAIT_TIMEOUT. Storm ignores the return, sums the
per-node delivered bytes, gets 0xFF80 of 0x5152B, and returns FALSE with
`ERROR_HANDLE_EOF`; `SBmpLoadImage` ignores *that* and RLE-decodes the
half-filled buffer.

So the emulator defect is: **a bounded `WaitForMultipleObjects` is expired
against a clock while the worker threads it is waiting on are still runnable and
their events unsignaled.** On real hardware those three chunk jobs finish in far
under 255 ms; here 255 ms of emulated clock buys one worker slice.

Two side observations worth recording:

- By the time the late sector-16 write lands (batch 39381), the read buffer has
  already been **freed and reused** — `$heap_free` (`src/10-helpers.wat:568`)
  only links the block into the free list, it does not clear, and the 12
  all-zero `STransCreate` payloads (60,984 bytes each) are what now occupy that
  address range. So the worker's late write is also a stray store into a live
  sprite. Post-run dumps of the *read* buffer are therefore contaminated and
  cannot be used as decode-time evidence; the image buffer (dumped above) can,
  because nothing reallocated over its first 168 KB.
- `--count` slots live in shared memory and count worker hits; `--break` and
  `--trace-at` are per-instance and never fire for T1 on this path. Every number
  in this subsection came from counters and watchpoints for that reason.

**Smallest instrumentation that would settle what is left** (I could not make
it): in `lib/thread-manager.js`'s bounded-wait branch, keep polling instead of
expiring while `hasActiveThreads()` and the waited-on handles are unsignaled
(or scale `waitTimeout` by the emulation slowdown). That is also the candidate
fix: with it, the three chunk jobs complete and the diff above should come back
`identical`.

## Storm's own heap suballocator (`SMemAlloc`), and the double-issue question

*Added 2026-08-24 by the allocator-RE session. Read-only investigation; no
`src/` or `lib/` edits. All disassembly is of
`test/binaries/candidates/diablo-shareware/installed/storm.dll`, original VAs.*

Short answer to "does Storm's allocator hand the same bytes out twice": **no.
Measured at 106 pages / 2866 live blocks, its bookkeeping is exactly
self-consistent.** What is really happening is one step upstream — the audio
work-queue head ends up holding an address the allocator *never issued*, and the
allocator then quite correctly gives that memory to the code generator. Details
and the measurements are below.

### The call chain

```
SMemAlloc(size, file, line)        0x150102b0   ret 0xc, takes CS 0x15034b40
  └ 0x15020f30 → 0x15020f50 → 0x15020fa0        rounds size up to 16
      ├ size' <= [0x15032fcc]  → 0x15023910     page heap  (the 0x4fc00000 arena)
      └ else                   → 0x15020fe1     HeapAlloc([0x15035f24], 0, size)
SMemFree(ptr, file, line)          0x15010690   ret 0xc, same CS
  └ 0x15021000 → 0x15023860 (ptr → heap/page/record) → 0x150238c0 (release)
```

`[0x15032fcc]` (runtime `0x6d5fcc`) is **480** in this build, so the sparse
arena only ever serves allocations of ≤ 480 bytes; anything bigger is a Win32
`HeapAlloc` and is not in the arena at all.

### 1. Block header layout — there is none in this build

`SMemAlloc` has two modes, selected by `[0x15031f28]` (runtime `0x6d4f28`):

* **Tracking on** (`!= 0`): the block gets a real debug header. Allocation size
  becomes `size + align4(strlen(file)+1+0x14) + 0xa`; the raw base `ebp` gets
  `[+0] line`, `[+4] per-file stats record`, `[+8] prev-link`, `[+0xc] next`,
  `[+0x10] the file-name string`; then, immediately before the returned
  pointer, an 8-byte mid-header `[-8] pointer to the tail guard`, `[-4] word
  offset back to the base`, **`[-2] word 0x6f6d ("mo")`** — that is the Storm
  sentinel — and a **`0xb112` word guard written just past the payload**
  (`0x15010527`/`0x15010531`). `SMemFree` validates both (`0x150106cf`,
  `0x150106f7`) and calls the error reporter on a mismatch.
* **Tracking off** (`== 0`): `SMemAlloc` is a straight `0x15020f30(size)` and
  `SMemFree` a straight `0x15021000(ptr)`. **No header, no magic, no guard
  bytes, no free-list links in the payload.**

**Measured: `[0x6d4f28] == 0` in every run here** (`--dump=0x6d4f28:8`). So do
not go looking for "mo"/`0xb112` in a Diablo dump — Storm is in release mode and
the returned pointer is the whole block. Every byte of bookkeeping lives in the
page header instead.

### 2. Free-list structure — a per-page record array, no list and no coalescing

The arena is one heap descriptor (static, `0x150327b0`, runtime `0x6d57b0`,
0x814 bytes; extra heaps are `HeapAlloc(0x814)` and chained at `[+0]`/`[+4]`):

| offset | meaning |
|---|---|
| `+0x000` / `+0x004` | next / prev heap (circular) |
| `+0x008` | high-water page index |
| `+0x00c` | lowest decommitted page hint |
| `+0x010 .. +0x40f` | **one byte per page: free 16-byte units in that page** (`0xff` = page decommitted) |
| `+0x410 .. +0x80f` | one byte per page: "largest request that failed here" hint (`0xf1` after a free) |
| `+0x810` | data base = `VirtualAlloc(0, 0x400000, MEM_RESERVE)` → `0x4fc00000` |

`0x150235b0` reserves the 4 MB and commits the first `0x10000`; that is exactly
the `0x4fc00000` arena this file has been calling "Storm's sparse region".

Each 4 KB page is:

```
page+0x000  dword cursor   -> next record byte to hand out
page+0x004  dword units left in the current free run
page+0x008  0xf0 record bytes, index == unit index
            0 = free unit, n = an allocated block of n 16-byte units starts here
page+0x0f8  0xff           -> scan sentinel, stops the zero-run scan
page+0x100  240 x 16-byte data units
```

`ptr → record` is `page = ptr & ~0xfff; unit = (ptr-page-0x100)>>4; record =
page+8+unit` (`0x1502388d`), and `record → ptr` is `page + 0x100 + unit*16`
(`0x15023bcf`). Maximum arena block is 240 units, but the 480-byte threshold
caps real requests at 30.

* **Allocation** (`0x15023b90`): fast path takes the tail run at the cursor;
  otherwise it walks the record array skipping allocated blocks by their length
  byte and counting runs of zero bytes. First fit. The caller
  (`0x15023910`/`0x15023a50`) then does `sub [heap+0x10+page], units`.
* **Free** (`0x150238c0`): `add [heap+0x10+page], record; record = 0; hint =
  0xf1`. That is the entire operation — **no free list, no LIFO, no size
  buckets, no coalescing**: adjacency is implicit because a free block is just a
  run of zero record bytes. It cannot corrupt a neighbour's header because there
  are no headers to corrupt.
* When a page reaches `0xf0` free units a counter is bumped, and at 32 such
  pages `0x15023780` walks from the top `VirtualFree(page, 0x1000,
  MEM_DECOMMIT)`-ing each fully-free page and marking its byte `0xff`.

### 3. Where the generated copier's memory comes from — plain `SMemAlloc`

`SCODE.CPP` (`0x1502d13c`). The code-generator descriptor `S` holds **two** code
buffers, and the one the row blitter runs out of is
`[S+0x40] = SMemAlloc(size, "SCODE.CPP", 0x426)` with `[S+0x44] = size`
(`0x150046b1`–`0x150046bc`), freed at `0x1500471d`. The second is `[S+0x10]`
(size `[S+0x14]`), freed at `0x150046e1`. Entry-point tables live at `S+0x18[]`,
`S+0x30[]` and `S+0x48[]`.

> **Correction to "The generated copier, read properly" earlier in this file:**
> that section says "`[struct+0x40] = len, [struct+0x44] = buf`". It is the
> other way round — `+0x40` is the buffer, `+0x44` its length. The stores at
> `0x15004c65`, `0x15004c7a`, `0x15004cd1` and `0x15004cf8` are all
> `mov [buf+size-4], rel32`, i.e. each patches the trailing `e9` of a buffer.
> They therefore write a **rel32, never a pointer** — which matters, because the
> disputed value in the work-queue head *is* a pointer.

So the answer to the crux is: **the copier is a perfectly ordinary tracked
`SMemAlloc` block.** In a live dump its cells show up in the record array like
anything else, e.g. `0x4fc687c0 (2u)`, `0x4fc687e0 (2u)`, `0x4fc69b30 (3u)`,
`0x4fc69d10 (3u)`, `0x4fc69d40 (3u)`. Nothing is carved out behind the
allocator's back.

### 4. Integrity walk — the allocator is clean

`tools/` has nothing that reads a live Storm heap, so this was a scratch parser
over a `--dump` hexdump: for every page, walk the record array, check that every
allocated block's interior record bytes are zero (an overlap would show as a
non-zero byte inside a block), that no block runs past unit 240, that the
`0xff` sentinel is intact, that the cursor is inside the array, and that
`0xf0 − Σ allocated units == [heap+0x10+page]`.

```sh
timeout 540 node test/run.js --app=diablo_shareware --time-scale=30 \
  --max-batches=45000 --no-close --watch=0x6d46c0 --watch-log \
  --dump=0x6d57b0:0x814,0x4fc00000:0x70000,0x6d46c0:8,0x6d4f28:8,0x6d5fc0:0x10
```

Result at batch 39380 and again at 45000 (after T1 is already dead):
**106 pages, 2866 / 2869 live blocks, zero overlaps, zero overruns, every
sentinel `0xff`, every cursor in range, and the per-page free-unit counter
exactly equal to `0xf0 − Σ allocated` on every single page.** No cycle is
possible — the structure is an array, not a list.

Note the arena dump must be `0x4fc00000:0x70000`; `[heap+8]` is a high-water
*index* (105), so a loop over `< npages` silently skips page `0x4fc69000`, which
is the page all of this happens in.

### 5. So who writes the work-queue head? Not the allocator, and not the copier

The queue is guarded by its own `CRITICAL_SECTION 0x15034b28` (runtime
`0x6d7b28`, distinct from the heap's `0x15034b40`/`0x6d7b40`), and both the link
(`0x1500c9dc`) and the two unlink walks (`0x1500bfe2`, `0x1500c026`) run inside
it. Node lifetime: ctor `0x1500c8e0` = `SMemAlloc(0x34)` → 4 units (0x40), so
**every legitimate node address is 0x40-aligned within a page's data area and
its record byte is 4**. Teardown splits on `[node+0x28]`: non-zero unlinks and
does *not* free (`0x1500bfba…0x1500bff8`); zero unlinks **and frees**
(`SMemFree` at `0x1500c033`). Measured to batch 39380: 32 nodes constructed
(`--count=storm+0x1500c921`), 16 through the freeing teardown
(`storm+0x1500bffa` = 16, `storm+0x1500c038` = 16).

Three findings, each from a run whose command line is quoted:

1. **The head always ends up pointing at memory the allocator considers free.**
   Three different executions, three different head values, same verdict:
   `0x4fc69d60` (unit 198), `0x4fc69bf0` (unit 175), `0x4fc69770` — in each case
   the record byte for that unit is 0 in the same dump, and in the 45000-batch
   dump the head is *inside* a live 3-unit copier block (`0x4fc69d40`, offset
   0x20), which is why the pump reads `88 07 ff c7` as its
   `IDirectSoundBuffer`.

2. **That address was never issued by the suballocator.** In the execution whose
   head is `0x4fc69bf0` (unit 175), watching the record byte itself finds *no
   change at all* for the whole run, on either thread:

   ```sh
   timeout 300 node test/run.js --app=diablo_shareware --time-scale=30 \
     --max-batches=39380 --no-close --watch-byte=0x4fc690b7 --watch-log \
     --dump=0x4fc69000:0x100,0x6d46c0:8      # 0 hits
   ```

   The probe is good: the identical run with `--watch-byte=0x4fc690bb` (unit
   179, a copier block) fires `0x0 → 0x3` at batch 39377, and all three runs in
   this family (`--watch-byte` at `0xb7`, at `0xbb`, and none) end with a
   byte-identical page dump, so they are the same execution. A record byte that
   is never set means `SMemAlloc` never returned that unit; and since a
   lost-record-store would leave `0xf0 − Σ records > [heap+0x10+p]`, and the
   equality holds exactly on all 106 pages, the store was not lost either.

3. **The copier's own stores are excluded, twice over.** At the disputed head
   write (`Old 0x0 → New 0x4fc69d60`, batch 39378, reproduced byte-identically
   across runs) the copier's destination register is `EDI=0x0074c3e7`, nowhere
   near `0x6d46c0`; the copier writes one byte at a time; and the four
   generator patch sites write rel32s, not pointers. A watchpoint reports the
   block where the change was *noticed* — here the row-blitter cell, because
   that is simply what main was running — so `EIP=0x4fc687d0 /
   prev_eip=0x006a7d49` names a bystander.

> **Withdrawal.** The earlier claim in "Who clobbers the list head" — "the
> corruption is a **wild store by the generated blitter**" — is not supported.
> The blitter is a bystander (point 3). The later hypothesis in "The disputed
> store is a pointer, not pixels" — an **overlapping allocation** produced by
> Storm's suballocator — is also disproved (points in §4 and §2 above): the
> allocator never double-issues, and the address in the head was never one of
> its allocations. Also withdrawn: "healthy nodes live at `0x4fc684xx..8axx`,
> the corrupt ones are all at `0x4fc69xxx`" — in these runs T1 links and unlinks
> perfectly good nodes at `0x4fc695c0`, `0x4fc69670`, `0x4fc696d0`,
> `0x4fc69a90`, `0x4fc69c80`.

**Where the next session should look.** The remaining suspects for
`[0x150316c0] = <not an allocation>` are, in order: (a) `esi` being wrong at
`0x1500c9dc` — i.e. the ctor result surviving in `esi` across our thunk/context
switches; (b) a node freed by the non-freeing teardown path's *other* owner
while still linked, followed by the page being decommitted or reissued; (c) a
genuinely stray dword store from somewhere we have not enumerated. Note that
`0x1500c9dc` and `0x1500bfe2` are **not block entries** (fall-through), so
`--count` on them reports 0 — use the jz targets `0x1500c921`, `0x1500bffa`,
`0x1500c038` instead, or a watchpoint.

**Two methodology notes that cost time here.** A watchpoint *halts* the run loop
on every change, so watching a hot address perturbs scheduling and gives a
different execution — only compare runs that watch the same address (verify by
`md5` of the same `--dump` range). And `test/run.js` auto-builds: two runs
straddling another agent's commit are two different emulators. This session's
measurements are all on `9b9a98c9` (post page-compile merge), where the failure
still reproduces exactly: `Thread 1 EIP=0 … prev_eip=0x6aeec4 ebx=0x4fc69ce0
ecx=0x4`.

---

## RESOLVED (2026-08-24, `opus5-main`, commit 7d241245): the short MPQ read was a host wait expiring too early

This closes the black menu logo, the black Choose Class panels, and the dead
Storm worker. All three were one defect in `lib/thread-manager.js`, and it was
never in the guest, in Storm's allocator, in the code cache, or in the
decompressor.

### The defect

`checkMainYield()` ages a bounded wait against `this._now()`. The CLI's clock
is `batch * 200`, so **one host batch costs the guest 200 emulated
milliseconds** while executing only a batch's worth of instructions. Storm's
async reader waits `WaitForMultipleObjects(nCount, handles, TRUE, 255)` at
`storm+0x1500e9d5`; 255 emulated ms is 1.3 batches, a couple of hundred
thousand guest instructions. The hardware that number was chosen for would
have given the worker something nearer a hundred million.

So the wait expired with the worker mid-chunk. Storm ignores `WAIT_TIMEOUT`,
sums the bytes it has, finds them short, returns `ERROR_HANDLE_EOF`, and
`SBmpLoadImage` decodes the half-filled buffer. The tail is zeros, and zeros
are opaque black once the PCX RLE loop paints them. That is why the first
wrong byte of `ui_art\smlogo.pcx` sat exactly on the 64KiB sector 15/16
boundary (`diablo-pcx-diff`'s measurement above): sixteen of thirty-two
sectors is simply how many the worker got through in 1.3 batches.

`waitMultipleCooperative()` had the same shape on the INFINITE path — eight
slices, 800k steps, then `WAIT_FAILED`, which is not an answer to an unbounded
wait at all.

### The fix

A bounded wait must now *also* have polled a floor of times before it can
expire, and the floor applies only while `hasActiveThreads()` — a wait nothing
can signal still takes the pre-existing fast exit (the Age of Empires II
5000ms self-semaphore case). Nothing is lost when the work finishes early:
the wait already returns the instant the object is signalled. The floor is
`min(1024, max(4, timeoutMs))` polls, one poll being one host batch.

`waitMultipleCooperative()`'s INFINITE path now pumps until nothing active is
left or a slice executes zero instructions, with a 64M-step livelock backstop.

### Measured before and after

`node test/test-diablo-shareware-art.js`:

|                              | before   | after   |
|------------------------------|----------|---------|
| logo frames matching archive | 4/15     | **15/15** (IoU 0.82–0.84) |
| distinct sprites seen        | 0,1,2    | **1,4,7,10,13** |
| Choose Class panel outlines  | 0/9      | **9/9** (all edges 1.00) |
| Storm's worker T1            | dead at batch 39381, EIP=0 | **alive at exit** |

Run cost is unchanged in practice: 41500 batches at `--time-scale=30` in about
140s on a loaded box. The poll floor costs batches only on an object that is
never signalled, and those already exit early.

Regression-checked: `test-thread-manager`, `test-critical-section-threading`,
`test-worker-thread-stuck-detect`, `test-thread-resource-sync`,
`test-wordpad-thread-startup`, `test-vlan-loopback`, `test-waveout-audio`,
`test-winamp-audio` all pass.

### What this retires, and what it does not

Retired: every hypothesis in this file that tried to explain the short decode
as corruption. The bytes were always correct — there were just fewer of them
than Storm believed. The suballocator walk, the copier's shape, the
invalidation study and the COPY_RUN A/B above are all still accurate and still
worth keeping; none of them was the cause.

**Still open — a genuinely separate bug:** the Show Credits section below finds
credit text rendered as solid white bars, and traces it to our host GDI font
sheet, not to Storm. `SGdiTextOut` builds its 320×320 sheet with
`CreateCompatibleDC` → `CreateDIBitmap(fdwInit=0)` → 256 × `ExtTextOutA(...,
ETO_OPAQUE)` → `GetDIBits`, and the readback comes back with only the top ~30%
populated, interlaced every other scanline, glyphs far larger than their 20×20
cells, and 80% of the buffer zero. Storm reads "not paper index = ink", so a
zeroed cell is a fully inked glyph. Whether the loss is in our rasterization or
in the `GetDIBits` readback is not yet determined. That is the next Diablo
thing to chase.

**Note for anyone writing a bounded wait test:** the general shape of this bug
is not Diablo's. Any guest that waits a real-world number of milliseconds on
work a worker has to do will hit it, because the emulated clock and the
emulated work rate are two hundred times apart. `--tick-ms-per-batch=N`
(added the same day) is the other lever on that ratio.

---

## RESOLVED (2026-08-24, `opus5-main`, commit 59f11790): the credits bars were a colour table we should never have read

The Show Credits section above ends with "whether the loss is in our
rasterization or in the `GetDIBits` readback is not determined". It was
neither. Our 1bpp raster path is correct; the atlas was built against a
garbage palette.

### The defect

`SGdiTextOut` builds its glyph atlas with
`CreateDIBitmap(hdc, &bmih, 0, NULL, &bmi, DIB_RGB_COLORS)` — **no `CBM_INIT`,
no init data** — over a bare 320×320 `planes=1 bpp=1` header. Without
`CBM_INIT` that call makes an *uninitialised* DDB compatible with the DC, and
real GDI never reads `bmiColors` on that path: the bitmap gets the device
palette, which for a monochrome request is plain `{black, white}`.

`$gdi_bitmap_create_dibitmap` passed `copy_palette = 1` unconditionally, so we
copied the two RGBQUADs that happened to follow Storm's header on its stack.
White paper and black text then both resolved against garbage, and the sheet
came back with the paper bit **clear**.

Storm reads "not the paper value = ink". An inverted atlas is therefore not a
blank atlas — it is a *fully inked* one, and every string composed from it is a
filled rectangle. That is the bar.

The fix is one line: `copy_palette` now uses the same `(init && pixels)`
condition as `copy_pixels`, leaving the pointer null so the raster layer falls
through to `$gdi_raster_default_palette`.

**This is not Diablo-specific.** Any `CreateDIBitmap(fdwInit=0)` with a ≤8bpp
header was getting a junk palette.

### Two corrections to the Show Credits section above

Both were measurement artifacts, and both are worth knowing because they are
easy to repeat:

1. **"the readback is ~80% zero, interlaced every other scanline, glyphs far
   larger than their 20×20 cells."** That is what a **1bpp** 320-pixel sheet
   looks like when it is rendered as 8bpp: the real stride is 40 bytes, so
   reading 320 bytes per row consumes eight source rows per displayed row and
   spreads each glyph eight times too wide, and the 12,800 real bytes occupy an
   eighth of a 102,400-byte dump. It is a very convincing picture of a
   rasterizer that gave up partway. `tools/dump2png.js --bpp=1 --flip` shows it
   correctly.
2. **A `--dump=` of the readback buffer shows noise.** `--dump` only fires at
   exit, and Storm frees the atlas scratch buffer as soon as it has copied the
   glyphs out; by exit the address holds something else entirely. Use
   `--input=BATCH:dump-mem:0xADDR:LEN` (added with this commit) to take the
   hexdump while the owner still holds the memory.

### The fast loop, which is the reusable part

Reaching the credits screen costs ~140 s: the menu is ~39,400 batches of real
interpretation in, and boot is work-bound, so no clock flag shortens it. The
atlas, though, is eight GDI calls, and `src/13-exports.wat` already exposes
every one of them. `test/test-diablo-font-sheet.js` replays them against the
render harness in about a second.

It builds the atlas twice — once with a real `{black, white}` table, once with
none — and asserts the two are **byte-identical**, because without `CBM_INIT`
the table is not an input at all. That equivalence is the regression, and it
fails loudly on the old code.

    node test/test-diablo-font-sheet.js     # 21 passed, 0 failed

Reach for that pattern before driving the app: the traced call sequence plus
the `test_call_*` exports is almost always a second-scale reproduction of a
minutes-scale symptom. Two gotchas when you do:

- `test_gdi_get_dibits` is the raw internal and takes **WASM** pointers, while
  `guest_alloc` returns guest addresses — the API handler is what normally does
  the `g2w`. The `test_call_*` wrappers do not have this problem.
- Check the synthetic reproduction against the real trace before believing it.
  Mine initially "reproduced" a `GetDIBits` returning 0, which the real run
  does not do — that was the pointer-domain mistake above, and fixing the
  emulator to match it would have been fixing nothing.

### State of Diablo Shareware after this and 7d241245

Menu logo animates (15/15 frames), Choose Class draws its panels (9/9), Storm's
worker survives, and Show Credits renders readable text over the tavern art.

**The credits-exit scanlines are gone too, and were never a separate bug.**
Re-measured 2026-08-24 on 59f11790 with the recipe in the Show Credits section
(click (320,342) at 39500, Escape at 40800, capture at 41100 and 41300): both
exit frames are the clean menu -- five gold ArtFont items, the flaming logo
present, pure black where the credits had been, no residue at any width. The
"regular thin white horizontal lines across the whole 640 width" that section
records *were the credit lines*: each one was a solid white rectangle spanning
the text's full run, and a row of those reads exactly like scanlines. With real
glyphs there is nothing left to erase. Nothing about the erase path was ever
wrong, so do not go looking for one.

The credits frame itself (`/tmp/cred-exit/c1.png` in that run) now shows white
credit text with its shadow pass over the Tristram tavern art -- both of the two
defects the Show Credits section opened with, the black background and the solid
bars, are closed by 7d241245 and 59f11790 respectively.

No named rendering defect on Diablo Shareware's menu path is open.

## RESOLVED (2026-08-24, `opus5-main`, commit cfff3789): the whole screen went flat grey the instant you picked a class

Past the menu, Single Player → Choose Class rendered correctly and then, from
the moment a class was double-clicked, **every subsequent frame was a uniform
light grey** (`#efefef`) — Enter Name, and everything after it. It looked like
the app had stopped drawing.

It had not. It was drawing perfectly, through a destroyed palette.

### What every trace said, and why none of it helped

This defect is worth recording mostly for how well it hid:

- `--trace-ctrl`: no control paints for the new dialog — true, and irrelevant;
  Diablo does not paint through our control path at all.
- `--dump-backcanvas`: **empty directory**. Diablo renders through DirectDraw
  surfaces, not per-window back-canvases, so this probe cannot see it.
- `--count` on Storm's failure blocks — `SBmpLoadImage`'s failure block
  (`storm+0x15001e51`), `SFileReadFile`'s `ERROR_HANDLE_EOF` return
  (`+0x1500ead4`), `SFileOpenFile`'s open-failed exit (`+0x15002019`): **all
  zero**. No art load failed and no read came up short. (Three hits on
  `SDlgBeginPaint`'s stub tail, which is the documented correct behaviour for
  the `WS_EX_TRANSPARENT` dialogs.)
- Every API returned success. Nothing was unimplemented, nothing trapped.

`--trace-dx` is what turned it around, and only because it prints a colour
histogram beside the surface contents:

```
[dx] Present slot=1 bpp=8 dib=0x3514e4 nzBytes=303410 pal=0x39c4ec
     top=239x261913=#efefef 83x4371=#efefef 0x3790=#efefef 238x2232=#efefef
```

303410 non-zero bytes and many *distinct* indices — a real picture — but
indices 239, 83 and 238 all resolve to the same `#efefef`. The pixels were
never the problem. The palette was.

### The measurement that named it

`$handle_IDirectDraw_CreatePalette` `heap_alloc`s 1024 bytes and memcpys the
caller's table into it; `dx_free` only zeroes the DX_OBJECTS type and never
returns that block, so nothing of ours can free it. And `--trace-dx` showed the
palette contents changing with **no `IDirectDrawPalette_SetEntries` anywhere
near** — 45 `SetPal` calls in the run, the last one thousands of lines earlier.

So watch the block. Its guest address is `g2w`'s inverse of the `pal=` value:
`0x39c4ec - 0x12000 + 0x400000 = 0x78a4ec`.

```sh
node test/run.js --app=diablo_shareware --tick-ms-per-batch=20 \
  --max-batches=41400 --no-close --trace-dx --watch=0x78a4ec --watch-log
# *** WATCHPOINT hit at batch 41102: [0x0078a4ec] changed
#   Old: 0x00000000  New: 0xefefefef  EIP: 0x006a8441  prev_eip: 0x006a843b
```

One write, at the exact batch of the class double-click, from inside storm.dll.
`0xefefefef` is not a pointer or a flag — it is the background index **239**
broadcast to a dword, the signature of a byte fill.

### The arithmetic, which is exact

| | |
|---|---|
| primary DIB, WASM | `0x3514e4` |
| primary DIB, guest | `0x73f4e4` |
| 640×480 bytes | `0x4b000` |
| **end of surface** | **`0x78a4e4`** |
| palette copy, guest | `0x78a4ec` — end + 8 |

The palette is the very next heap block, eight bytes past the last scanline.
And every Storm dialog is created **640×482** (`[CreateWindow] hwnd=0x1001c
style=0x80000040 pos=0,0 size=640x482`) while the primary is 640×480 — the main
window `0x10002` is the only 640×480 one. Two extra rows is 1280 bytes, which
starting 8 bytes past the end covers the whole 1024-byte palette. Not
approximately: exactly.

### The fix, and why it is not a workaround

A real primary surface is the front of a video-memory aperture that keeps going
after the last visible scanline. An app that paints a couple of rows long
scribbles on unused VRAM and nobody ever notices — which is presumably why this
shipped. Ours was a heap block with the next allocation packed directly behind
it, so the same two rows landed on live emulator state.

`CreateSurface` now allocates 16 slack rows past the end of every surface DIB,
primary and back buffer (~10KB on a 640×480 primary). `dib_size` stays the
logical size, so pitch, vidmem accounting and every reader are unchanged.

**Not Diablo-specific.** Any 8bpp app whose colours come out flat or wrong out
of a DirectDraw surface should be retested on cfff3789.

### Ruled out, with the measurement

- **A `$heap_alloc` double-issue.** `--trace-api=HeapAlloc,HeapFree,HeapReAlloc`
  over the whole run: no allocation ever returned a block at or near
  `0x78a4ec`. The neighbour was issued correctly; the guest ran over it. (An
  earlier board entry of mine offered this as evidence for the free-list work
  in `src/10-helpers.wat` — that entry is withdrawn.)
- **A failed art load / short MPQ read**, i.e. a relapse of 7d241245: the three
  Storm counters above are zero.
- **The palette not being copied.** `SetEntries` does `memcpy` into
  `[entry+20]`, and `CreatePalette` allocates its own 1024 bytes rather than
  keeping the caller's pointer. Both are correct.

## Driving Diablo to gameplay headlessly, cheaply (2026-08-24)

The 500-second runs this file used to open with were mostly self-inflicted.

**`--tick-ms-per-batch=20`, not `--time-scale=30`.** The CLI's guest clock is
`batch * TICK_MS_PER_BATCH`, default **200ms a batch** — so at the default each
batch advances a fifth of a second of game time and the menu renders about four
frames of its animated logo per batch. Dropping the tick to 20ms cut the cost of
the menu region from 41s to 9s. `--time-scale` does not help here: it scales
`guestNowMs` for the scheduler, not `get_ticks`, which is what the game reads.

It also *fixes the intro*: at 200ms a batch the Blizzard North logo never
advances — a permanently dark logo through 38,000 batches, which reads
convincingly as a stalled decoder. At 20ms the intro plays and the title card
appears.

**Click to skip, and only late.** Escape on the main menu is "Exit Diablo" and
will end your run (`PostQuitMessage`, `[Exit] code=0`). Clicks in a harmless
corner at 38400/38800/39200/39500/39700/39900 take the menu from batch 40900 to
40150 and the run from 50s to 26s. Clicking *earlier* than 38400 makes it
slower, not faster.

**Reaching each screen** (all with `--no-close --repaint-every=200`):

| Screen | Batch | Cost |
|---|---|---|
| Main menu | ~40,150 | 26s |
| Choose Class | ~40,900 | 53s |
| Enter Name | ~41,600 | ~70s |

Menu geometry: SINGLE PLAYER at (320,214). The class list advances on
**BN_DOUBLECLICKED** — `dblclick:320:298` for Warrior. The name field needs a
**click to focus** at (425,331) before any `keypress` reaches it; typing without
that leaves the field empty and looks like a dead control. OK is at (350,444).

`--wait-slices` (added in ee9ba711) matters here too: while the main thread is
parked in a blocking wait, workers now get 64 slices a batch instead of 4, which
took the Choose Class capture from not finishing inside 75s to 53s.

## Gameplay reached, and what the frozen intro actually was (2026-08-24)

**Diablo Shareware reaches Tristram and renders it correctly.** Verified end to
end on cfff3789: main menu → SINGLE PLAYER → Warrior (double-click) → name field
(click to focus, then type) → OK → loading screen with progress bar → gameplay.
The gameplay frame is right: the cottage and its thatched roof, the player
character beside the door, the stone wall and the river, bare trees, and the
full control panel — CHAR/QUESTS/MAP/MENU on the left, INV/SPELLS on the right,
both orbs, the belt with two potions. No flat grey, no scanline artefacts, no
missing sprites. Two captures 1500 batches apart are byte-identical, which is
correct for an idle character.

**It plays, not just draws.** Clicking the ground at (520,250) and then at
(150,260) walks the character and scrolls the world both ways: the cottage, the
stone wall and the river all move together, with no tearing, no stale tiles and
no black seams at the scroll edge, and the character sprite is correctly
occluded when it walks behind a tree. So the depth sort and the scroll path are
both right, not just the first painted frame.

### The Blizzard North logo was never a decoder bug

The intro logo appears to freeze: at `--tick-ms-per-batch=20` it is
byte-identical from batch 15,000 to batch 37,500, and clicks at 15,500 do not
break it. Every earlier note here treated that as a stalled Smacker decode.
It is not. `--trace-sched` shows the main thread inside smackw32 the whole time,
doing real work — and an API census over the region shows **10,068 timeGetTime
calls against 62 surface Lock/Unlock pairs**. The player is pacing itself off
the clock and the clock is running away from it.

**The headless CPU is emulated far too slow relative to the guest clock.** The
guest-visible speed is `BATCH_SIZE / TICK_MS_PER_BATCH` — but **`BATCH_SIZE` is
a budget of blocks, not steps, and a block is not a fixed amount of work**, so
that ratio is not a constant. Measured here with `--batch-stats` and
`--handler-hist-thread=0`:

| region | ops | blocks | ops/block | ops per guest-second at the 200ms default |
|---|---|---|---|---|
| Smacker intro (batches 1000-6000) | 34.1M | 4.95M | **6.9** | ~34,500 |
| main menu (batches 38400+) | 335.3M | 1.19M | **282** | ~1.4M |

A real Pentium retires ~100M instructions a second, so the intro is being run on
a machine roughly 3,000x too slow *and the menu on one only 70x too slow* — the
same emulator, the same build, 41x apart. Ops per second is flat at 7-9M in both
regions, so nothing is actually slower in the menu; only the unit changed.

**The coupling runs the wrong way.** Guest time advances once per batch, but
work per batch collapses precisely when an app sits in a tight polling loop
waiting for time to pass — short blocks, few ops, clock advancing at full speed.
The more the app waits, the less CPU it is granted per guest-second. That is the
feedback loop behind the frozen logo.

Anything that paces itself against `timeGetTime`/`GetTickCount` — intro videos,
animated menus, fades — therefore renders a fraction of a frame per guest second
and looks stalled. **Raise `--batch-size`, not just the tick.** At
`--batch-size=200000 --tick-ms-per-batch=20` the intro plays through and the
main menu appears at batch ~1500 **with no skip-clicks at all**; the skip-click
recipe below exists only to work around the slow-CPU symptom.

This is not Diablo-specific. Any app whose behaviour depends on how fast the
machine is — a video, a timed fade, a benchmark, a frame-rate governor — is
being told it is running on a 5 kHz machine at our defaults.

### Two working recipes

Cheap-clock (what the art regression test uses), gameplay at batch ~45,000:

```
node test/run.js --app=diablo_shareware --tick-ms-per-batch=20 \
  --max-batches=47000 --no-close --repaint-every=400 \
  --input='38400:mousedown:20:460,38460:mouseup:20:460,...,39900:mousedown:20:460,39960:mouseup:20:460,\
40200:mousemove:320:214,40250:mousedown:320:214,40370:mouseup:320:214,\
41000:mousemove:320:298,41100:dblclick:320:298,\
41300:mousedown:425:331,41360:mouseup:425:331,\
41450:keydown:87,41460:keypress:87,41470:keyup:87,41500:keypress:97,41530:keypress:114,\
41700:keydown:13,41760:keyup:13,45000:png:/tmp/tristram.png'
```

Realistic-clock, menu at batch ~260 with skip-clicks (~52M steps of guest work):

```
node test/run.js --app=diablo_shareware --batch-size=200000 --tick-ms-per-batch=50 ...
```

Wall-clock costs are **not** quoted here on purpose. This box regularly sits at
load 10-40 with other agents sweeping, and the same run measured 45s and 75s
twenty minutes apart. Quote batch counts and step counts, which are stable, and
check `uptime` before believing any seconds figure.

## RESOLVED (2026-08-24): OK on Choose Class could not be clicked

Reported from the browser — pick a class, and the OK button never responds. It
reproduces headlessly too, and it was two stacked defects in
`lib/renderer-input.js`, neither of which is Diablo-specific.

**Why nothing shows up in a trace.** A click that is swallowed by an early
return in `handleMouseDown`/`handleMouseUp` never reaches the guest, so it
makes no API call: `--trace-api` shows a perfectly healthy message pump and
nothing else. `--trace-input` (added with this fix) prints the routing decision
instead, and named the cause on the first run. Reach for it before
disassembling anything.

**Defect 1 — the UP never arrived.** `_dispatchMouseEvent` ended in a flat
`return false`. Its one caller that reads the result records
`_directMouseDown` — the target that owes a matching `WM_LBUTTONUP` — only
`if (dispatchedDirect)`, so for guest-owned child controls that state was never
set and the up-delivery branch was unreachable. Those controls received every
DOWN and never a single UP. A Win32 button fires `BN_CLICKED` on the **up**, so
a single click on one did nothing; double-clicking worked, because
`WM_LBUTTONDBLCLK` is acted on directly. That is exactly the Choose Class
symptom: single-clicking a class never completed, so the game never enabled OK.

**Defect 2 — a click over a disabled child was dropped.** OK and Cancel are
created `WS_DISABLED|BS_OWNERDRAW`; Storm subclasses them
(`SetWindowLongA(hwnd, -4, 0x006aa3c0)`), draws them itself and hit-tests them
against the `GetCursorPos` position it polls every frame. Real `WindowFromPoint`
treats a disabled child as *transparent* and returns the window behind it, so
USER delivers the click to the parent — which is how that idiom works at all.
We returned instead, so the parent never saw it and OK was unclickable by any
means. The gate now clears `deep` and falls through to the parent; a disabled
*top-level* still swallows the event, since there is nothing behind it.

The `_isMouseInputDisabled` gate itself stays — it was added for Dr. Black
Jack, whose grey Split button used to depress and post `WM_COMMAND` before the
first deal. Both apps are covered: the disabled control still gets nothing.

After the fix, `down 350,444 -> child 0x1001c of 0x1001c dispatched=1` /
`up 350,444 -> native child 0x1001c`, and clicking OK advances to Enter Name.

## RESOLVED (2026-08-24): the game sat in the corner of a teal desktop

Reported from the browser as "not scaling to whole screen", with a second
symptom in the same screenshot: the DIABLO art drawn twice, stacked vertically,
over an "Invalid name" complaint. Both came from one defect, and neither
reproduced headlessly.

Diablo takes the display the normal way — `SetCooperativeLevel(hwnd=0x10002,
DDSCL_EXCLUSIVE|DDSCL_FULLSCREEN|DDSCL_ALLOWREBOOT = 0x13)` then
`SetDisplayMode(640, 480, 8)`. Our handler stores the mode, installs the 8bpp
palette, resizes the cooperative window to 640x480 at (0,0), posts
WM_DISPLAYCHANGE/WM_MOVE/WM_SIZE, and makes `GetSystemMetrics(SM_CXSCREEN)`
report the mode instead of the host canvas. All of that worked.

What did not is who the compositor asks. `renderer._repaintOnce` tests
`_isExclusiveFullscreenWindow(top)` — the *topmost* window — and from the main
menu onward that is not the DirectDraw window. Storm stacks every menu on a
screen-sized `SDlgDialog` popup **owned by** the game window; measured in the
browser, hwnd 0x10006 (640x482, z=18, owner=0x10002) sits over hwnd 0x10002
(640x480, z=17, the one carrying `_dxFrameLayer`). The popup failed the test, so
the page dropped out of exclusive mode entirely: the desktop canvas stayed
viewport-sized, the game stayed a 640x480 window at the origin, and the teal
around it was the Win98 desktop showing through.

The duplicated art is the same fault seen from the other side. The exclusive
path composites the whole owned stack through one transform and gates each
window's surface on the newest DirectDraw present (`presentSeq`); the normal
path drew each dialog's back-canvas at its own offset with no such gating, so
two menu dialogs each holding a copy of the art stacked visibly.

`_isExclusiveFullscreenWindow` now also accepts a window whose *owner chain*
reaches the exclusive hwnd (chained — Enter Name is a popup over Choose Class),
and the transform is computed from the exclusive window rather than the topmost
popup, since the 640x482 dialog over a 640x480 mode otherwise stretched every
frame by 482/480. The stack walk below the decision already handled these
popups; its entry condition simply never fired.

Verified in a real browser (`tools/profile-web-frames.js --screenshot`): the
main menu fills the page, transform source is the 640x480 exclusive window, and
Choose Class comes up clean — art intact at the top, portrait and stat panel
correct, no duplication.

> The "Invalid name" half of that screenshot is *not* explained by this and did
> not reproduce: headless, `click:425:331` to focus the field and then
> `keypress` characters puts BOB in it and the screen is correct. The field
> needs the focus click first, and Diablo rejects names with spaces.

## OPEN (2026-08-25): clicking to skip the intro freezes the page for seconds

Reported from the browser: scene changes in the menus are visibly slow, and
skipping the intro video by clicking hangs the game for a few seconds.

### The guest side is measured and is a burst, not general slowness

`--batch-stats=FROM` windowed either side of the skip click, at the browser's
own 100000-block slice (`--batch-size=100000 --tick-ms-per-batch=100`, click at
batch 400):

```
window 400-700:  batches that spent the whole budget: 178 of 300 (59.3%)
window 700-1000: batches that spent the whole budget:   0 of 300 ( 0.0%)
```

Every stalled slice is in the 300 batches after the click and none in the next
300. `--handler-hist --handler-hist-start=400 --handler-hist-stop=700` prices
that burst at **412,582,977 ops over 18,118,569 blocks = 22.8 ops/block**, so
one full-budget slice is 2.28M ops and the burst as a whole is ~412M ops. The
hot handlers are `$th_load32_ro_base_esp` (10.5%), `$th_inc_r` (7.9%),
`$th_test_jcc` (7.5%), `$th_store32_ro_base_esp` (7.2%) and `$th_load8_ro`
(5.6%) — byte-at-a-time decode loops, i.e. Storm tearing down the Smacker
player and decompressing the menu art (`logo.pcx` 535KB, `smlogo.pcx` 333KB,
`title.pcx`) out of `spawn.mpq`. The transition really does have seconds of
work in it; the question is only whether the page stays alive during it.

### A design weakness this exposes, worth knowing before you touch it

`run(max_blocks)` (`src/13-exports.wat:8`) takes a budget in **blocks**, and a
block is not a unit of work — 22.8 ops/block here against the 282 ops/block
CLAUDE.md measures in this same game's menu. So the host cannot bound how long
a slice will hold the thread. Note the asymmetry in `host.js`: the *worker*
path (`runBudgeted`, ~line 1763) is given `maxWallMs` of 4-16ms and is checked
between quanta, while the main thread's `run()` has no wall-clock cap at all
and cannot be interrupted once entered.

### But the obvious fix is NOT the fix — measured, and not shipped

Adding `diablo_shareware` to `autoRunSliceFor` in `lib/browser-shell.js`, the
way `jazz2_demo` and `halflife_uplink` already are, does not help:

| slice | WinePerf cumulative `blockedMs` | `longTasks` |
|---|---|---|
| 100000 (default) | 12159 | 5 |
| 20000 | 12224 | 7 |

Unchanged. And it is not free — a paired interleaved CLI A/B over identical
guest work gives mean user CPU 19.9s at 100000, 23.6s at 20000 (+18%), 24.7s at
10000, 36.3s at 1000 — plus `host.js` derives the *worker* budget from the same
number (`maxTotalSteps: threadBudget * 4`), so a 5x smaller slice also gives
Storm's async worker a 5x smaller budget, which is the opposite of what a
transition bottlenecked on MPQ reads wants. So whatever holds the main thread
for ~12s is **not** the main guest slice. There is a comment saying so at that
switch.

### Health warning on any browser number taken here

Two runs at the *same* setting came back 53ms and 12224ms of `blockedMs`. The
difference tracked `guestFps`/`stepsPerSec` — how far the app happened to get —
not the setting. This box has been at load 35-175 all day and headless Chrome
cannot resolve this question on it. Note also that `tools/profile-web-frames.js`
reports rAF frame intervals, which is *page* fps: it sat at a flat 60.0fps with
"long tasks: none observed" in runs whose own `blockedMs` was 12 seconds.

### The next measurement

Attribute the long tasks, on a quiet box. `--cpu-profile` is the tool, but
check the run actually launched before reading it — an attempt here came back
99.2% `(idle)` with `slice size: null steps` and a 2272-character debug log,
which is a page that never started the app, not an app that did nothing.
Candidates not yet excluded: the DirectDraw present path (`putImageData` moved
670M pixels in one 30s sample), the VFS read of a 535KB MPQ member, and the
`windowCount === 0` branch in `host.js` that calls the **unbudgeted**
`runSlice` instead of `runBudgeted`.

## OPEN (2026-08-25): the title screen was seen in the intro's blue palette

Reported from the browser: the `ui_art\title.pcx` screen — demon face, DIABLO
wordmark, copyright line — came up **blue** instead of dark red. The wordmark
and both text lines were the right bone/beige, so it is not a channel swap of
the whole frame.

**Not the 8bpp blit fast path** (commit `3d83bc2d`). A/B'd directly: built with
an early `(return (i32.const -1))` in the `src_bpp == 8` branch of
`$gdi_raster_bitblt_fast32`, captured the same frame, and the colours are
identical either way. The fast path resolves the palette base once per *blit*,
so the only thing it could miss is a palette change occurring inside a single
blit, which cannot happen.

**Does not reproduce headlessly**, at either resolution:

```sh
node test/run.js --app=diablo_shareware --batch-size=200000 \
  --tick-ms-per-batch=50 --max-batches=800 --no-close --repaint-every=20 \
  --input='760:png:/tmp/title.png'
# add --screen=1280x866 for the browser's canvas size
```

Batch ~760 is the title screen and it is correct at 640x480 and at 1280x866:
red demon, yellow fire, white wordmark. Ground truth to diff against comes from
the archive itself, no emulator in the loop:

```sh
node tools/mpq-extract.js test/binaries/candidates/diablo-shareware/installed/spawn.mpq \
  --name='ui_art\title.pcx' --png=/tmp/title_truth.png
```

An 11% pixel difference against that file is expected and correct — it is the
DIABLO wordmark and the two text lines, which diabloui draws on top afterwards.

### What the palette measurements say

- Only **2** `SetEntries` calls in the first 5100 batches of the intro, both
  `start=1 count=254` on palette slot 2. `$handle_IDirectDrawPalette_SetEntries`
  honours `start` correctly (`memcpy` to `pal_wa + arg2*4`).
- A `--watch` on the live table found exactly two writers and both are Diablo's
  own `SetEntries`; nothing else scribbles on it.
- At batch 850 the table matches `title.pcx`'s own palette entry for entry,
  in `PALETTEENTRY` (R,G,B,flags) order: `c0c0c0`, `c0dcc0`, `a6caf0`,
  `b46400`, `c06c00`, `c88000`, `c88420`, `d09400`, `d4a400`. Entries 0-6 stay
  at the Windows system colours (`0x80` reds, not the PCX's `0xbf`) because
  Diablo starts at index 1 — that is correct, not a bug.
- **The blue ramp is real and is the intro's.** During the Blizzard logo the
  table is `(0,0,4)`, `(0,0,8)`, `(0,0,12)` … and the Blizzard Entertainment
  logo genuinely is blue in this game. A capture of it at batch 240 matches.

So the leading hypothesis is that the reported frame is **the title art shown
while the intro's palette is still installed** — the picture from one scene and
the colour table from the previous one. Everything about the report fits that:
correct structure, uniformly blue, and the two text overlays unaffected because
diabloui draws them through GDI with explicit colours.

### Excluded 2026-08-25: a palette *swap* that never re-presents

`$handle_IDirectDrawSurface_SetPalette` (`src/09a8-handlers-directx.wat:2999`)
does **not** re-present, while `SetEntries` does — so attaching a different
palette object would leave the canvas holding the previous scene's colours,
which is this symptom exactly. It is a real gap and it is reported on the
message board, but **it is not Diablo's**: over a 1000-batch run,

```sh
node test/run.js --app=diablo_shareware --batch-size=200000 --tick-ms-per-batch=50 \
  --max-batches=1000 --no-close --quiet-api --repaint-every=100 \
  --trace-api=IDirectDrawSurface_SetPalette,IDirectDraw_CreatePalette,IDirectDrawPalette_SetEntries
#   IDirectDraw_CreatePalette          x1
#   IDirectDrawSurface_SetPalette      x1  (0x083e6008 = the primary, at boot)
#   IDirectDrawPalette_SetEntries      x3  (all on 0x083e6010, start=1 count=254)
```

One palette object, created once and attached once. Diablo only ever rewrites
entries in place, so it always takes the `SetEntries` path that *does*
re-present. Cross this off.

### The next measurement

Reproduce it in the browser, which is the only place it has been seen, and
capture the palette at that instant. Both hosts re-present on a palette change
(`$handle_IDirectDrawPalette_SetEntries` calls `$dx_present` when the written
table is `$dx_primary_pal_wa`), and on the browser's direct-attach path that
becomes `host_gdi_surface_upload`, which marks the whole surface dirty — so on
paper the refresh should happen. What is worth checking first is
`_flushGdiSurfacePresentation` in `lib/host-imports.js`: it takes the dirty
rect **before** it calls `_refreshGdiSurfacePalette`, and returns early when
there is no dirty rect. Any path that changes the palette without producing one
leaves the canvas holding the previous colours, which is exactly this symptom.

## SOLVED-TO-THE-EDGE (2026-08-25): "Invalid name" is a dialog-focus failure

The multiplayer hero flow now reaches **Enter Name** headlessly, and the
"Invalid name" complaint reproduces there: the field stays empty no matter what
you type, so Diablo validates an empty string. Nothing about the name is wrong —
**not one keystroke reaches the control**.

### Reaching the screen (fast recipe, ~3 min under load)

The `--time-scale=30 --max-batches=39400` recipes elsewhere in this file are the
slow way in. This is the same journey in 2300 batches:

```sh
node test/run.js --app=diablo_shareware --batch-size=200000 \
  --tick-ms-per-batch=50 --max-batches=2300 --no-close --repaint-every=20 \
  --input='1000:mousemove:320:256,1040:mousedown:320:256,1080:mouseup:320:256,\
1300:mousemove:420:298,1340:mousedown:420:298,1380:mouseup:420:298,\
1600:mousemove:348:446,1640:mousedown:348:446,1680:mouseup:348:446,\
2200:png:/tmp/name.png'
```

Batch ~900 is the main menu (items at y = 213/256/299/342/385, so Multi Player
is `(320,256)`); the Choose Class panel is up by ~1300 (Warrior `(420,298)`,
Rogue `(420,341)`, Sorcerer `(420,364)`); `OK` is `(348,446)`. Warrior's panel
comes out right — portrait correct, Level 1 / 30 / 10 / 20 / 25 — so everything
up to here works.

### Where the keystroke dies

`--trace-api=PeekMessageA --trace-api-dedup` at the Enter Name screen:

```
[check_input] msg=0x100 wParam=0x47 lParam=0x0 packed=0x470100
[check_input_hwnd] keyboard → 0 (main_hwnd)
  out: msg=&{hwnd=0x00010002 msg=0x00000100 wP=0x00000047 lP=0x00000000}
[API] IsDialogMessageA        <- called with hDlg=0x00010023
[API] TranslateMessage
[API] DispatchMessageA
[API] DefWindowProcA          <- dropped here
```

`inputEventHwnd` (`lib/host-window.js:20`) routes keyboard to
`get_focus_hwnd()` and falls back to `main_hwnd` when it is zero. It is zero.
So the key is addressed to the *game* window `0x10002`, `IsDialogMessageA`
correctly declines a message that belongs to neither the dialog nor its
children, and `DefWindowProc` eats it. **The routing is right; the focus is
missing.** Real Win98 behaves the same way with a NULL focus window, so this is
not a place where we merely differ — it would fail on the real thing too, which
means focus is supposed to be set and is not.

### There is a real control to focus, and it is not a Static

`node tools/parse-rsrc.js diabloui.dll --out=ui.json` then

```sh
jq -r '.dialogs | to_entries[] | "\(.key) [" +
  ([.value.controls[] | "\(.className):\(.id):st=\(.style)"] | join(" ")) + "]"' ui.json
```

Two of the 29 templates carry a custom class:

```
2147486722 [DIABLOEDIT:1065:st=1342242816 Static:1038 Button:1054 Button:1056]
2147487066 [DIABLOEDIT:1116:st=1342242816 Static:1038 Button:1054 Button:1056]
```

`0x50010000` = `WS_CHILD|WS_VISIBLE|WS_TABSTOP`. `DIABLOEDIT` is registered by
diabloui at startup (`RegisterClassA wndProc=0x006ea130`), and the control is
really created — confirmed at runtime:

```
CreateWindowExA(class="DIABLOEDIT", style=WS_CHILD|WS_VISIBLE|WS_TABSTOP,
  x=265, y=315, w=320, h=33, parent=hwnd:0x00010023, menu=hmenu:0x00000429)
```

So the target exists, is visible, is a tab stop, and is the dialog's first
control. Diablo draws the typed text itself (the pump shows `GetDlgItem` →
`GetWindowRect` → `ScreenToClient` → `InvalidateRect` on `0x10023/0x429` every
frame) and reads it back with `GetDlgItemTextA`.

### Storm owns the dialog manager, and it decided not to set focus

Storm implements dialogs itself — `storm.dll` imports `EndDialog`, `GetDlgItem`,
`GetDlgItemTextA`, `SetFocus` and `IsDialogMessageA` from USER32 but **no
`CreateDialog*`/`DialogBox*` at all**, which is why tracing those APIs returns
nothing. `diabloui.dll` reaches it through `SDlgDialogBox` /
`SDlgDialogBoxParam` / `SDlgCreateDialogParam`.

Storm's builder is at `storm+0x7000` (loaded at `0x6a3000`, origBase
`0x15000000`, so runtime = orig - 0x15000000 + 0x6a3000). The relevant tail:

```
15007199  test esi,esi                 ; per created control
1500719d  mov eax,[esp+0x10]           ; hDlg
150071a1  mov ecx,[esp+0x2c]           ; current default-focus candidate
150071a5  cmp eax,ecx / jnz            ; only the FIRST candidate wins
150071ab  test [ebx],0x8000000         ; WS_DISABLED -> skip
150071b6  "Static"     -> skip
150071cc  "SDlgStatic" -> skip
150071de  mov [esp+0x2c],esi           ; else: this control is default focus
...
15007232  push 0x110 / call SendMessageA   ; WM_INITDIALOG
1500723e  test eax,eax
15007240  jnz 0x1500724a
15007242  mov dword [esp+0x2c],0x0     ; <-- FALSE means "app set focus itself"
...
1500734e  GetPropA(hDlg,"SDlg_EndDialog") ; nonzero -> skip show+focus
15007365  mov eax,[esp+0x2c]
15007369  test eax,eax / jz            ; nothing to focus -> skip
1500736e  call SetFocus                ; ret lands at 0x15007374 = 0x006aa374
```

`--trace-at=0x6aa23e` reads EAX at `0x1500723e`, i.e. exactly what
`WM_INITDIALOG` returned, once per dialog:

```
[TRACE-AT #2] batch=792  EIP=0x006aa23e EAX=0x00000001  EDX=0x00010006
[TRACE-AT #3] batch=1040 EIP=0x006aa23e EAX=0x00000000  EDX=0x0001000e
[TRACE-AT #4] batch=1640 EIP=0x006aa23e EAX=0x00000000  EDX=0x00010023  <- Enter Name
```

Dialog `0x10006` returns TRUE and duly gets `SetFocus(0x00010007)` at
`ret=0x006aa374`. The Enter Name dialog `0x10023` returns **FALSE**, Storm
zeroes its candidate, `SetFocus` is skipped, `$focus_hwnd` stays 0, and every
keystroke afterwards is delivered to the wrong window.

`SetFocus` fires only 4 times in the whole run — `0x10002`, `0x10003`,
`0x10007` (all `ret=0x006aa374`, i.e. Storm's dialog manager) and `0x10008`
(`ret=0x006eaf65` = `diabloui+0x9f65`, a small helper that does
`old=GetFocus(); SetFocus(new); invalidate(old); invalidate(new)`). None of
them names `0x10023` or its `DIABLOEDIT`.

### Proof that focus is the whole story

Clicking inside the Enter Name box before typing moves focus and changes the
routing, and only the routing:

```sh
  ...,1850:mousemove:430:300,1880:mousedown:430:300,1920:mouseup:430:300,
  1980:keydown:71,1990:keypress:103,2000:keyup:71,...
# [check_input_hwnd] keyboard → focus 0x10023
# [check_input] msg=0x102 wParam=0x67   <- WM_CHAR really is delivered
```

The characters now arrive at the *dialog*, and the field is still empty —
because the dialog is not the control. `DIABLOEDIT` (`0x429`) is what has to
hold the focus. That is consistent with the whole diagnosis rather than a second
bug: we moved focus one level too high.

### Note on `keypress`

`run.js`'s `keypress` is `WM_CHAR` and `keydown` is `WM_KEYDOWN`; our
`$handle_TranslateMessage` is a no-op that returns 1 and never synthesizes a
character, because the host posts both messages itself. So a text-entry probe
must inject **both**, in the browser's order and with the browser's codes —
`keydown:71` (VK 'G') then `keypress:103` (char 'g'), matching the real session's
`msg=0x100 wParam=0x47` / `msg=0x102 wParam=0x67`.

### CORRECTION (2026-08-25): `--trace-at` is blind to a nested synchronous call

An earlier revision of this section claimed "the DLGPROC is never entered for
WM_INITDIALOG", on the strength of `--trace-at=0x006efec0` firing exactly once
in a whole run (and then for WM_DRAWITEM). **That claim was wrong, and the
method was wrong.**

`--trace-at` arms a WASM breakpoint and JS inspects EIP *after the exported
`run()` returns*. `$wnd_send_message_inner` runs the guest procedure in a
**nested** `$run`: the nested run hits the breakpoint and returns with EIP
unchanged, the sender immediately loops and calls `$run` again, the CACA0005
return thunk zeroes EIP, and the caller's EIP is restored before control ever
gets back to JS. Every nested synchronous entry is therefore invisible to
`--trace-at`.

`--count` is a native in-interpreter counter and does not have this blind spot:

```sh
node test/run.js --app=diablo_shareware ... --count=0x006efec0
# Hit counts:
#   0x006efec0 = 25
```

**Twenty-five entries, not one.** The DLGPROC runs fine; WM_INITDIALOG reaches
it; `$dialog_default_proc` is not broken.

> Rule for this codebase: `--trace-at` answers "did the *pump* reach this
> address". For anything invoked through `$wnd_send_message` — a wndproc, a
> DLGPROC, a control procedure — use `--count`, or you will measure the
> nesting rather than the code.

### The actual cause: nothing ever gives the dialog the focus

With the DLGPROC confirmed running, disassembling it settles the question.
Diablo's name-dialog DLGPROC is `diabloui+0xeec0` (runtime `0x006efec0`); its
message switch sends WM_INITDIALOG (`eax = msg - 0x110 = 0`, index byte
`[0x2000f24c] = 0`) to `0x2000ef78`, and that handler ends:

```
2000f04b  33 c0      xor eax, eax
2000f04d  5d         pop ebp
...
2000f054  c2 10 00   ret 0x10
```

**It returns FALSE unconditionally, and it never calls `SetFocus`.** Nor does
Storm: the loop it runs after WM_INITDIALOG (`storm+0x72c0`) only ORs style
bits into Buttons and Statics (that is the traced
`SetWindowLongA(0x10026, -16, 0x5800400b)`), and its one `SetFocus` at
`storm+0x736e` is gated on the candidate it just zeroed.

So on real Win98 the focus does not come from the app at all — it comes from
USER, in two steps we do not implement:

1. **Showing/activating a top-level dialog gives it the focus.** Storm calls
   `ShowWindow(hDlg, SW_SHOWNORMAL)` at `storm+0x735f`; real USER activates the
   window and sends it WM_SETFOCUS. In our run the Enter Name dialog **never
   receives WM_SETFOCUS at all** — over the whole run exactly one WM_SETFOCUS
   reaches `DefDlgProcA`, and it is `DefDlgProcA(0x00010003, 0x7, 0x00010002, 0)`,
   the one dialog Storm focuses explicitly.
2. **`DefDlgProc`'s WM_SETFOCUS handler focuses the dialog's first tab stop.**
   That is documented USER behaviour and is precisely what would put the caret
   in `DIABLOEDIT` (`0x10024`, id 1065, `WS_TABSTOP`, the first control in the
   template). Our `$handle_DefDlgProcA` offers WM_SETFOCUS to the DLGPROC and
   then falls through to `$handle_DefWindowProcA`, which has no such rule.

Both are general Win32 gaps, not Diablo quirks, and either one alone leaves
`$focus_hwnd` at 0.

### The fix (landed 2026-08-25, commit 3fe247f2)

Two rules, both in `src/09a5-handlers-window.wat`:

1. **`$handle_DefDlgProcA`** — when the DLGPROC declines `WM_SETFOCUS` (0x0007),
   move the focus to the first visible, enabled `WS_TABSTOP` child via
   `$dialog_next_tabstop(hwnd, 0, 1)`, before the `$handle_DefWindowProcA`
   fallthrough. The new `$dlg_focus_first_tabstop` helper **posts**
   WM_KILLFOCUS/WM_SETFOCUS rather than sending them: this code runs inside a
   guest DefDlgProc call, and a nested synchronous send would re-enter the
   dialog's own wndproc on top of a live x86 frame.
2. **`$handle_ShowWindow`** — an activating show of a top-level *dialog-class*
   window (`$wnd_class_is_dialog`, i.e. cbWndExtra ≥ DLGWINDOWEXTRA) takes the
   focus **only when `$focus_hwnd` is zero**. That guard is what makes this
   safe: it can supply a focus nobody holds, and can never take one away.
   Previously only `main_hwnd` ran an activation chain here, which is exactly
   why a secondary dialog was never told it owned the keyboard.

Verified with the recipe above: `[check_input_hwnd] keyboard → focus 0x10024`
(the DIABLOEDIT) instead of `keyboard → 0 (main_hwnd)`, the field renders the
typed text, and OK advances past it. `test/test-dialog-setfocus-tabstop.js`
covers the four cases (first tab stop wins, a non-tabstop child is skipped, a
disabled tab stop is skipped, and a dialog with no tab stop is left alone).

Do not "fix" this by giving keyboard input to `main_hwnd` when focus is zero:
that is what already happens, and it is what real Windows does.

## Single player runs end to end in ~3000 batches (2026-08-25)

With the focus fix in, the whole new-hero chain is drivable headlessly and
lands in Tristram with a full HUD:

```sh
node test/run.js --app=diablo_shareware --batch-size=200000 \
  --tick-ms-per-batch=50 --max-batches=3000 --no-close --repaint-every=20 \
  --input='1000:mousemove:320:213,1040:mousedown:320:213,1080:mouseup:320:213,\
1300:mousemove:420:298,1340:mousedown:420:298,1380:mouseup:420:298,\
1600:mousemove:348:446,1640:mousedown:348:446,1680:mouseup:348:446,\
1900:keydown:71,1910:keypress:103,1950:keydown:65,1960:keypress:97,\
2000:keydown:76,2010:keypress:108,\
2200:mousemove:348:446,2240:mousedown:348:446,2280:mouseup:348:446,\
2900:png:/tmp/sp6.png'
```

Menu item y coordinates are the same for both modes — Single Player is the
first at `(320,213)`, Multi Player the second at `(320,256)`. Choose Class,
Enter Name and OK are unchanged from the multiplayer recipe. Both the Choose
Class and Enter Name screens render correctly on this path (no blue portrait
panel — that was transient on the multiplayer route).

## OPEN (2026-08-25): the multiplayer Select Connection screen is blank

Clicking OK on Enter Name in *multiplayer* now advances — the name is accepted
and no "Invalid name" box appears — to a new 640x482 top-level dialog `0x10028`
carrying five connection rows (ids 1069–1073, `WS_TABSTOP`), a "Requirements:"
pane, and OK/Cancel. OK is created `WS_DISABLED`, which is consistent with "no
provider selected yet". The screen is entirely black.

Measured, so the usual suspects are already excluded:

- The app is alive: the pump keeps cycling
  GetTickCount / GetCursorPos / GetPropA / PeekMessageA.
- The surfaces are alive and uploading every frame — `--trace-gdi` shows
  `gdi_surface_create` + `gdi_surface_attach(0x200001 → hwnd 0x10002)` +
  `gdi_surface_upload` for the DirectDraw primary, and `0x610002` created
  640x482 32bpp and attached to the new dialog `0x10028`.
- Both are **empty**, not mis-composited: `--dx-surfaces` reports the primary
  as `nonZero=0/1850`, and `--dump-backcanvas --png=` writes a 2061-byte
  all-black back-canvas for the game window and a 2074-byte all-black one for
  `0x10028`.

So nothing is drawing, rather than something drawing to the wrong place. Note
shareware multiplayer needs a network service provider regardless, so this is
not on the path to gameplay — single player above is.

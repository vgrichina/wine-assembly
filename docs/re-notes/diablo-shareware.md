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

### Logo blinks on the main menu

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

### Choose Class screen is corrupted

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

### Storm audio pump thread dies

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

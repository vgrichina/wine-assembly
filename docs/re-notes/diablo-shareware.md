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

Runs are **deterministic**: the same batch number produces a byte-identical PNG
across runs. Anything that looks like a race is not one — look for a counter or
a state machine instead.

Menu geometry in the 640×480 capture: "SINGLE PLAYER" spans about x=175..465,
y=200..228, so a click at (320, 213) selects it. Enter also works once the menu
is actually on screen. `run.js`'s `click` action is invisible to games that
sample the button once per frame — use `mousedown`, a gap, then `mouseup`.

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

> **Withdrawn:** the earlier bullet "A truncated MPQ read … the file involved was
> the title WAV, not the logo." The 82-sector file that stops on a 0x20000
> boundary is `ui_art\smlogo.pcx` (block 22, csize 215,185 / fsize 333,227), not
> a WAV — `node tools/mpq-dir.js <spawn.mpq> --name='ui_art\smlogo.pcx'`. And a
> truncated read is *not* ruled out: it is the mechanism, just one level further
> down than the sector table can show.

### Choose Class screen is corrupted

Superimposed title strings, heavy horizontal striping, mostly black with only
the gold class names and stat labels legible. Given the DirectDraw profile
above, start at the lock rect / pitch and the palette.

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

- **"Runs are deterministic" is false once T1 exists.** The fatal `ebx` was
  `0x4fc69bb0`, `0x4fc69ce0` and `0x4fc69fc0` across three flag configurations,
  and one `--watch=0x6d7b4c` run at the same batch budget **never created T1 at
  all** (`cache: full clears M 1`, no `ThreadManager` lines, `gdi: dc_states 1`
  instead of 4). Byte-identical PNGs at a fixed batch are a weaker claim than
  they look.
- **`--break` and `--watch` propagate to worker WASM instances; `--trace-at`
  does not** (armed on the main instance only, `test/run.js` ~line 6436). A
  `--trace-at` that prints nothing for T1 is not evidence of anything.

## Emulator-side context worth knowing here

- Storm builds an **unrolled byte copier at runtime** in a sparse `VirtualAlloc`
  arena (guest `0x4fc10000..0x4fc70000`): 8 code bytes per copied byte,
  terminated by an `e9 rel32` rewritten on every call. Any change to code-cache
  invalidation has to survive this.
- `--loop-superops` is off by default because `COPY_RUN` miscompiles Storm's MPQ
  decompression byte copy and renders Diablo's menus as colour noise. If menus
  look like noise, check that flag before investigating anything else.

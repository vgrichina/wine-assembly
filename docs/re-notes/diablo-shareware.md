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
| `storm+0x1500bedd` | `call [edi+0x2c]` — `IDirectSoundBuffer::Lock` through the vtable we synthesize |
| `storm+0x150365e4` / `+0x150365e8` | imported `EnterCriticalSection` / `LeaveCriticalSection` |
| `storm+0x150316c0` | head of the list the pump walks (next pointer at `+0x30`) |
| `storm+0x15034b28` | the pump's `CRITICAL_SECTION` |

Storm is **EBP-less**, so `--trace-stack` returns `frames=[]` on anything inside
it. Do not spend time on the frame walker here; use `--count` on candidate call
sites, or `tools/caller_census.js`, to find who called what.

## Open bugs

### Logo blinks on the main menu

The 385×156 logo block appears and disappears across frames while "SHAREWARE",
the menu items, the pentagrams and the version string all stay put.

Ruled out, each with a measurement:

- **Block cache / self-modifying code.** Forcing `$cache_lookup` to never reuse a
  block from the sparse generated-code arena produced byte-identical PNGs.
- **The sparse `VirtualAlloc` arena.** `--dump-vmap` shows 11 mappings and zero
  overlaps; region [10] `0x4fc10000..0x4fc70000` backs `0x080f1000`.
- **A truncated MPQ read.** The sector table proves the read ends exactly on a
  sector boundary; the file involved was the title WAV, not the logo.
- **The Storm audio thread death below.** Real, but a separate fault.

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

## Emulator-side context worth knowing here

- Storm builds an **unrolled byte copier at runtime** in a sparse `VirtualAlloc`
  arena (guest `0x4fc10000..0x4fc70000`): 8 code bytes per copied byte,
  terminated by an `e9 rel32` rewritten on every call. Any change to code-cache
  invalidation has to survive this.
- `--loop-superops` is off by default because `COPY_RUN` miscompiles Storm's MPQ
  decompression byte copy and renders Diablo's menus as colour noise. If menus
  look like noise, check that flag before investigating anything else.

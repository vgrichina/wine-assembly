# RCT.exe (Win98 PE / x86) — RE Notes for wine-assembly init blocker

This is a **focused RE workspace**, not a full /re bootstrap. Wine-assembly already
has its own emulator (the WAT/WASM x86 interpreter) and ~35 RE tools under
`/home/user/wine-assembly/tools/`. We **leverage those** instead of rebuilding.

> **NOTE (2026-04-29)**: The shareware `RCT.exe` is NOT in the repo (binary,
> distribution-restricted). It must be placed at
> `test/binaries/shareware/rct/English/RCT.exe` to reproduce the runs below.
> All addresses are static VAs in that PE (imageBase=0x400000).

## Binary Identification

| Field | Value |
|-------|-------|
| File | `test/binaries/shareware/rct/English/RCT.exe` |
| Format | PE32 (MZ + PE header) |
| Platform | Windows 98 |
| CPU | x86 (32-bit, IA-32) |
| Image base | 0x400000 |
| Engine | Chris Sawyer hand-assembly |

---

## The Question Driving This Workspace

**Is RCT init genuinely a slow loop (forward progress, just painfully slow on our
~16M instr/sec emulator), or is it stuck (no forward progress)?**

Updated answer (2026-04-29): **slow forward through decompression, then stuck in
a tile-walker loop that never produces pixels** — see "Phase B" finding below.

---

## Phase Map (verified empirically 2026-04-29)

| Phase | EIP region | What it does | Outcome |
|-------|-----------|--------------|---------|
| A — boot/decompress | 0x42f5a5 (RLE inner) | Streams ~5–10 MB of asset data through `0x42f535` buffered file reader, RLE-decompressing into ESI buffers | Completes in ~25s of emulator wallclock |
| B — tile walker | 0x436xxx + 0x44437x | Iterates ~19 M times through `0x444374` tile renderer, exits without writing one pixel | Never terminates within 300 K batches |

The 6-min "init" number from prior sessions is reachable only because Phase B
runs forever. **It is not a bounded init step.**

---

## Phase B finding — tile walker writes ZERO pixels (2026-04-29)

Hit counts over a 300 K-batch run from a clean boot:

| EIP | hits | meaning |
|-----|------|---------|
| `0x444374` | 19 256 998 | tile_renderer entry |
| `0x44444e` | 18 265 165 | tile_renderer bail / ret |
| `0x4443bd` | 25 861 | sprite-list entry (tile_id != -1 path) |
| `0x444437` | **0** | sprite-renderer dispatch (the only place pixels get written) |
| `0x436833` | 1 | rotation handler 1 entry |

The walker hits the tile renderer 19 M times. Of those, 25 K reach a non-empty
tile slot (sprite linked-list head). All 25 K **fail the rectangle-overlap
visibility test** at `0x4443e6..0x444404` and bail without dispatching to the
per-sprite-type renderer at `[0x5a7980+ebp*4]`.

**Net pixel writes by RCT in 300 K batches: zero.** This matches the prior
session's observation that the DDraw surface DIBs stay all-zero indefinitely
and that no DDraw API is invoked after the splash logo.

### Why visibility fails 100% — render-target struct is off-map

Dump of `[0x5706b0]` after 200 K batches:

```
0x005706b0  26 0f be 01 35 ed 9b 02 0b 00 85 00 75 02 00 00
            └─fb_ptr────┘ └+4─┘ └+6─┘ └+8─┘ └+a─┘ └+c─┘ └+e─┘
```

| field | value | interpretation |
|-------|-------|----------------|
| +0  fb_ptr  | 0x01be0f26 | guest fb (NEVER written, --watch confirms) |
| +4  vp.left | 0xed35     | **signed −4811** |
| +6  vp.top  | 0x029b     | 667 |
| +8  vp.w    | 0x000b     | 11 |
| +a  vp.h    | 0x0085     | 133 |
| +c  pitch   | 0x0275     | 629 |
| +e  zoom    | 0          | |

The viewport is an 11×133 strip at world X = −4811 .. −4800. The world
sprite array (verified at 0x69e1e4, sprite #0) has bounds e.g.
`(left=3, top=4, right=1288, bottom=32768)` — entirely east of vp.right=−4800.

So the rectangle-overlap test at 0x4443fc fails (`cmp cx, [esi+0x16]; jle bail`
→ vp.right ≤ sprite.left → bail).

### Initializer of the struct — 0x4311c2

`0x4311c2` (`draw_one_cell`?) sets the struct each call:

```
edi = 0x5706b0
[edi+0x6] = [0x5706a6]  ; vp.top  ← global cursor
[edi+0xa] = 1           ; vp.h = 1
[edi+0xe] = [0x5706ae]  ; zoom
[edi+0x4] = [0x5706a4]  ; vp.left ← global cursor
[edi+0x8] = 1           ; vp.w = 1
[0x5706c0] = 0x59f48c
[0x8c8f38] = edi        ; render_target_ptr
call 0x43179f
call 0x43679a           ; rotation_dispatcher
call 0x4337de
call 0x433b50
ret
```

So the function renders ONE 1×1 cell at the global cursor (`[0x5706a4]`,
`[0x5706a6]`). The width/height we observed (11 / 133) is from a different
caller — there are multiple "viewport" structs in the chain (`+0x10` aux ptr,
`+0x18` next-struct link). The 1×1 reset never fires because Phase B's outer
driver hasn't reached it.

The negative origin (−4811) means the outer driver is iterating in a coord
space where the cursor starts off-map and overflows backward. Either:
- The outer driver was never given valid screen dimensions (no WM_PAINT /
  no `BeginPaint` HDC ever flowed in), so it iterates uninitialized state,
  OR
- A scale/origin field in some preceding init was left zero, making the
  iteration produce negative starts

This is the wall. Phase B is **not** "rendering" — it's a deterministic walk
over an empty region.

---

## Walker call chain (static, 2026-04-30)

Static call graph leading into the walker. The bad off-map screen viewport
originates in one of the 4 leaf callers — they pre-load EDI = render-target
struct whose `+0x4 (left)`, `+0x6 (top)`, `+0x8 (w)`, `+0xa (h)` are the
screen rect.

```
0x00431245  pack_viewport_for_walker     ; reads EDI struct {left,top,w,h} -> AX,BX,DX,BP, esi=clip
  └─> 0x00431266  clip_and_split           ; clips against esi, calls walker once or twice
        └─> 0x00431323  tile_walker_outer  ; the loop that writes [0x5706a4..0x5706ae]
```

Writers of `[0x5706a4]` (cursor X), per `tools/xrefs.js`:
- `0x004311c4` — inside `render_one_cell`
- `0x00431357` — inside `tile_walker_outer` itself (cursor advances)

Both are *consumers/iterators* — they receive the bad initial value from
elsewhere. The actual originator is one of the 4 callers of `0x00431245`:

| Callsite | Enclosing fn | Notes |
|----------|--------------|-------|
| `0x00427a85` | `0x00427a57` | Unknown — investigate |
| `0x0043e9c0` | `0x0043e9a0` | Unknown — investigate |
| `0x0044bb58` | `0x0044bb25` | Unknown — investigate |
| `0x00454f15` | `0x00454efb` | Unknown — investigate |

Next step (per dynamic): `--watch=0x5706a4 --watch-log` from boot will show
which caller fires first AND with which value. That pinpoints the origin
without chasing all 4 chains.

### Dynamic resolution (2026-04-30)

`--watch=0x5706a4 --watch-log` over a 30k-batch boot run:

- First write at **batch 28123**, `EIP=0x0043143c`, `prev_eip=0x00431323` —
  inside `tile_walker_outer`. Old=0, New=0x029bed35 (vp.x=-4811, vp.y=667).
- Pre-walker entry at `0x00431245` (`pack_viewport_for_walker`) trace shows
  input struct `EDI=0x008e6bcc`:
  `{fb=0x01be0f26, left=434, top=0, w=200, h=133, pitch=440}` — **reasonable**.
- ESI (after `mov esi,[esi+0x8]`) resolves to clip struct `0x008e81a8`:
  `{+0=0x27a, +2=0x1b3, +4=0, +6=0, +8 dword=0x029beb83, +10 byte=0x09}`.
- The bad coords are **computed** by `0x00431266`'s clip+transform:
  `(world - clip_origin) << zoom + [esi+0x8]`. With zoom=9 and word-truncated
  `[esi+8]=0xeb83 (signed -5245)`, the output is off-map.

So the originator chain (4 callsites of `0x00431245`) is **not** the bug —
they pass sane values. The real defect is the clip struct at `0x008e81a8`
holding wrong values (specifically `+0x8 dword = 0x029beb83`). Find the
writer of `[0x008e81b0]` to identify the missing init step.

---

## Phase A — RLE decompressor (still relevant, as background)

The bulk of pre-Phase-B time is RLE decompression at `0x42f5a5`:

```
0x42f5a5  call 0x42f5b0           ; get next byte
          mov [esi], al
          inc esi
          loop 0x42f5a5           ; ECX bytes to decompress
          ret

0x42f5b0  ; dispatch on state at [0x56f8be]:
          ;   0   -> opcode_fetch  (0x42f5e5)
          ;   neg -> repeat_last   (0x42f5d0)
          ;   pos -> literal_copy  (0x42f5bb -> 0x42f5ca call 0x42f535)

0x42f535  ; buffered file reader: 0x408176 in 0x400-byte chunks
```

Empirical decode rate ~430 KB/s on emulator → ~25 s for full asset set.
Called from `0x42f1c7`, `0x42f865`, `0x42f9bc`, `0x42fa73` (one per asset).

---

## Key Addresses

See `labels.csv`. Highlights:

- `0x4311c2` — render_one_cell (sets 1×1 viewport, calls walker)
- `0x431323` — tile walker outer loop (computes fb offset, recurses into rotation)
- `0x43679a` — rotation dispatcher → `[0x4367b0+ecx*4]` (4 entries)
- `0x436833` — rotation 1 (4-direction tile loop with ax/cx step ±0x20)
- `0x444374` — **tile renderer** (visibility test, sprite walker, dispatcher)
- `0x444437` — `call [0x5a7980+ebp*4]` — the only pixel-writing site
- `0x42f5a5` — RLE decompress inner
- `0x42f535` — buffered file reader

### Sprite-renderer dispatch table @ 0x5a7980

| ebp slot | target | first instr |
|----------|--------|-------------|
| 0 | `0x0054dc7c` | `push esi; test [esi+0xc],0x80; jnz ...; movzx edi,[esi+0x31]; jmp [0x5d2750+edi*4]` (sub-dispatch on sprite kind byte) |
| 1 | `0x00438cec` | (unverified — second sprite type) |
| 2 | `0x0042d466` | (unverified) |
| 3 | `0x0042ddc9` | (unverified) |

Slots 4..N are zeros — only 4 valid types.

---

## Data Map

| Range | Size | Purpose |
|-------|------|---------|
| 0x400000–0x600000 | code | .text |
| 0x5706a0..0x5706c0 | viewport globals | cursor x/y, current write ptr |
| 0x5706b0..0x5706cc | render-target struct | the 1×1 working viewport |
| 0x59f48c, 0x59f490 | linked viewport structs | secondary frames |
| 0x69e1e4..0x7d69e4 | sprite array | 5000 × 256 B = 1.25 MB |
| 0x8c8f38 | render_target_ptr | == &0x5706b0 normally |
| 0x8d8fce..0x8e0fce | tile map | 16384 × 2 B sprite-id heads |
| 0x8d8fc8 | rotation index | dispatched on by 0x43679a |
| 0x01000000..0x01ffffff | (heap) | 16 MB dense data — sprite cache (decompressed CSG1.DAT) |

---

## DDraw flow (verified pre-Phase-B)

RCT loads DDraw dynamically via `LoadLibraryA + GetProcAddress` (no static
import). Sequence observed:

1. `LoadLibraryA("DDRAW.DLL")` + `GetProcAddress("DirectDrawCreate")`
2. `DirectDrawCreate` → object
3. `SetCooperativeLevel`, `SetDisplayMode(640,480,8)`
4. `CreateSurface` × 3 (primary + 2 offscreen)
5. `SetPalette`, one `BitBlt` (splash logo via LoadImageA → GDI blit to offscreen)

**After the splash, ZERO further DDraw calls.** No `Lock`, `Unlock`, `Blt`,
`Flip`. The dump of all three surface DIBs confirms they remain
all-zero. Phase B never reaches a paint point.

---

## What's needed to break Phase B

Hypothesis ladder, cheapest to most invasive:

1. **Speed Phase A** (RLE pattern in WAT emitter) — would compress the wait but
   not unstick Phase B.
2. **Find the missing initializer of `[0x5706a4/a6]`** — track every static
   writer; suspicion is one branch of init (probably in or after `0x430291`
   bytecode dispatch) is being short-circuited by a stub API or unhandled
   message.
3. **Stub the visibility test** (force fall-through at `0x4443fa` / `0x444404`)
   to confirm we'd write SOMETHING to fb_ptr. Diagnostic only.
4. **Trace which API call the outer driver is waiting on** — Phase B might be
   gated on a window-message (WM_PAINT) that our loop never delivers because
   GetMessageA was never reached.

Step 2 is the right next move. The cursor `[0x5706a4]` is a 4-byte global; a
single `--watch=0x5706a4 --watch-log` from boot will show every writer up to
the moment Phase B starts.

---

## Sessions

Use `re_loop_sessions/` for any long-running session logs.

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

## 2026-05-07 — Current Emulator Fixes for RCT Runtime

Two operand-size bugs were confirmed on the live runtime path:

- `66 8F /0` was decoded as 32-bit `POP r/m32`. RCT uses 16-bit memory pops in
  generated-code epilogues around `0x00557bbc`; consuming 4 bytes instead of 2
  corrupted the return stack and sent `ret` to data at `0x008e746c`.
- `66 F7 /6` was decoded/executed as 32-bit `DIV r/m32`. RCT reaches
  `0x00429034: div cx` with `AX=0x0204`, `DX=0x0000`, `CX=0x00ff`; the division
  is valid on real x86. The old handler included stale high EDX bits
  (`EDX=0xffff0000`) in the dividend, causing a false divide exception and the
  `"GSK Exception Trapper"` path.

The fixed line adds 16-bit handlers for `F7 /4..7` and routes `66 F7` to them
for register and memory operands. Validate from here by rerunning past batch
`41790`; the old GSK MessageBox at `0x0040319f -> 0x00402ca0` should disappear.

Validation result: the old GSK path is gone in a 120k-batch run
(`/tmp/rct-after-div16-fix-120k.log`), with zero hits at `0x00429034` and
`0x00402ca0`. The current stop is a different bad-transfer path:
`EIP=0x00012601`, `dbg_prev_eip=0x00012601`, stack top `[esp+0]=0x004301ae`.
Trace the first transfer into `0x00012601` next; this is no longer the
16-bit `DIV` false exception.

Follow-up trace: the bad transfer is a corrupted return from `0x00457eb2`.
The return slot at `0x03fffec8` is valid on entry to `0x00457d3c`
(`0x009026b9`, caller `0x009026b4`), then the generated draw helper called at
`0x00457e41 -> 0x008fb38b` overwrites it byte-by-byte. The concrete writer is
the generated inner loop at `0x008fb75c`, with `EDI` walking into
`0x03fffec8`.

At entry to the inner draw routine (`0x008fb660`), the generated globals are
already wrong for a bounded copy: `[0x008e9028]=0` (width),
`[0x008e902c]=1` (height). The loop at `0x008fb72b` loads `CX=0`, decrements to
`0xffff`, and copies past the 64-byte stack buffer. Next trace target is the
clipping branch state immediately before `0x008fb5d2 call 0x008fb660`; determine
whether the zero width comes from a 16-bit flags/Jcc emulator bug or bad guest
draw metadata/clip inputs.

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

## DDraw / frame presentation (updated 2026-05-06)

RCT loads DDraw dynamically via `LoadLibraryA + GetProcAddress` (no static
import). Sequence observed:

1. `LoadLibraryA("DDRAW.DLL")` + `GetProcAddress("DirectDrawCreate")`
2. `DirectDrawCreate` → object
3. `SetCooperativeLevel`, `SetDisplayMode(640,480,8)`
4. `CreateSurface` × 3 (primary + 2 offscreen)
5. `SetPalette`, one `BitBlt` (splash logo via LoadImageA → GDI blit to offscreen)

For the current branch, a focused `--trace-dx` run shows the game buffer flow:

```
[dx] BltRect dst=7 <- src=-1 dstR=NULL srcR=NULL
[dx] Blt     dst=7 <- src=-1 COLORFILL dstDib=0x017f0d6c flags=0x1000400
[dx] CFill   dst=7 color=0x0 at=0,0
[dx] BltRect dst=8 <- src=-1 dstR=NULL srcR=NULL
[dx] Blt     dst=8 <- src=-1 COLORFILL dstDib=0x017f2d74 flags=0x1000400
[dx] CFill   dst=8 color=0x0 at=0,0
[dx] Lock    slot=8 caps=OFFSCR dib=0x017f2d74 firstNonZero=-1
[dx] Unlock  slot=8 caps=OFFSCR dib=0x017f2d74 firstNonZero=-1
[dx] SetPal  palSlot=6 start=10 count=236 palWA=0x017f0964
```

After setup there are no frame-time DirectDraw `Blt`, `BltFast`, `Flip`,
`Unlock`, or `Present` calls. RCT writes directly into the locked slot-8 DIB
from custom x86 render code. The emulator-side presentation bridge now copies
slot 8 into the renderer back-canvas when the primary stays blank; this is a
display workaround, not the root fix.

At 30k batches:

| Slot | Kind | Size | DIB | State |
|------|------|------|-----|-------|
| 4 | primary | 640x480x8 | 0x017e3cdc | all zero |
| 7 | offscreen logo | 128x64x8 | 0x017f0d6c | all zero |
| 8 | offscreen game buffer | 640x480x8 | 0x017f2d74 | nonzero partial frame |

Slot 8's visible pixels occupy bbox `434,0-633,132`. The renderer back-canvas
has the exact same bbox, so the observed "chunk" is not a pitch/offset mistake
in JS; it is the current guest-memory contents.

At 120k batches the render counters climb much higher, but execution corrupts:

```
0x00431245 = 9336292
0x00444374 = 9336292
0x00444437 = 9336292
EIP=0x00000081
ESP=0xfbaf5808
```

The DirectDraw surfaces are then full of nonzero bytes that look like corrupt
output. Current root problem is execution correctness in/after the software
render loop, not DirectDraw API composition.

### Bad return / data execution trace (2026-05-06)

The low-EIP crash is preceded by execution falling into data, not by a
DirectDraw call:

- `0x008fb7d3` is real generated render-copy code. The local sequence ends at
  `0x008fb7e6: ret`.
- Normal hits at `0x008fb7e6` have an unaligned `ESP` and return to
  `0x008fb5d7`, a helper epilogue (`pop edi; ret`).
- Normal hits at `0x008fb5d7` then return through sane callers such as
  `0x00457e46`.
- The recurring `0x008e746e` address is inside a data table. Running from there
  executes bytes that increment `EDX` and eventually `push esi`; trace-at showed
  `ESP` decreasing by 4 and stack filling with `0x008e75e4` on repeated hits.

The important trace artifacts are:

```
/tmp/rct-baseline-quiet.log
/tmp/rct-dump-8e74.log
/tmp/rct-dump-8fb7.log
/tmp/rct-trace-8e746e.log
/tmp/rct-trace-8fb7e6.log
/tmp/rct-dump-8fb5.log
/tmp/rct-trace-8fb5d7.log
```

`test/run.js` now has late/limited trace-at controls:

```
--trace-at-start-batch=N
--trace-at-limit=N
```

Use those instead of high-volume full-run `--trace-at` when chasing this path.
`--trace-at-start-batch` delays both arming and logging, which avoids
perturbing the hot generated-code path before the failure window. Also note
that the trace-at stack print now uses exact unaligned dword reads; older logs
printed `[esp..]` via aligned `Uint32Array` indexing and can be misleading when
RCT's generated helpers use byte-unaligned `ESP`.

### Root cause and fix: `66 8F /0` decoded as POP m32 (2026-05-07)

The first true bad transfer was not from the generated blitter `ret`; it was
from the RCT epilogue at `0x00557c96`:

```
0x00557c96: ret
before fix: [esp+0] = 0x008e746c
after fix:  [esp+0] = 0x00557a04
```

The enclosing function (`0x00557bbc`) restores a mixed 16/32-bit stack frame:

```
0x00557c4a  66 8f 05 ...   pop m16
...
0x00557c6d  8f 05 ...      pop m32
0x00557c73  66 5d          pop bp
...
0x00557c96  c3             ret
```

The `0x8F` decoder path ignored operand-size prefix `0x66`, so each
`66 8F /0` memory pop consumed 4 bytes instead of 2. `src/07-decoder.wat` now
emits handler 268 for `66 8F /0` memory operands and handler 182 for
`66 8F /0 mod=3`.

Post-fix status:

- The `0x008e746c` / `0x008e746e` data-execution path is gone in focused runs.
- RCT reaches a missing `mmioSeek` after the decoder fix; that API is now
  present and routes to `host_fs_set_file_pointer`.
- A 120k-batch run reaches RCT's own exception trapper MessageBox:

```
"GSK Exception Trapper": "Exception Raised - Unspecified"
EIP=0x042006e0
dbg_prev_eip=0x00402cf8
```

That is the current blocker. The next trace should break around the exception
raise/trapper path (`0x00428ede`, `0x00402cf8`) and dump SEH state and arguments.

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

Step 2 was the right next move for the older no-rendering state. On the current
branch, the `0x008e746c` data-return bug is fixed. Next useful traces should
follow the new GSK exception-trapper path rather than the old generated-helper
return chain.

### Generated draw helper cache invalidation (2026-05-07)

After adding real 16-bit `66 F7 /4..7` semantics, the GSK trapper path stopped
reproducing in the 120k-batch run. The new failure is a low-address return:

```
STUCK at EIP=0x00012601
prev_eip=0x00457eb2
return slot before generated call: 0x009026b9
return slot after overwrite:       0x00012601
```

The overwrite happens inside generated draw code around `0x008fb75c` with
`EDI` pointing into the caller's stack frame. The generated bytes in memory
still contain the clipping guards:

```
0x008fb561  79 21    jns ...
0x008fb56a  78 6b    js  ...
0x008fb56c  74 69    jz  ...
```

But the cached translated path executed from `0x008fb575`, skipping those
guards and reaching the inner copy with width zero. That points at stale
translation for self-modifying/generated code, not at a missing branch
instruction implementation.

Current fix under validation:

- `cache_store` marks image-data pages once they are translated as code.
- `gs8/gs16/gs32` invalidate writes inside the loaded image. A narrower
  `.text` plus executed-generated-page invalidator still let this stale helper
  path reproduce, likely because the rewrite can happen before the page is
  recorded as generated code.
- Fast bulk string ops now invalidate the destination range before
  `memory.copy` / `memory.fill`; the slow `REP STOSD` path uses `gs32`.

### Similar x86 emulation gaps audit (2026-05-07)

The recent RCT fixes came from operand-size override gaps, so the next audit
target is any decoded opcode where `66h` should select a 16-bit form but the
decoder still emits a 32-bit handler.

Fixed in the next pass:

- `0F AF` (`IMUL r, r/m`) ignored `prefix_66` and always emitted the 32-bit
  two-operand IMUL path.
- `0F A3/AB/B3/BB` (`BT/BTS/BTR/BTC r/m, r`) ignored `prefix_66` and used
  32-bit bit indexes/memory words.
- `0F BA /4..7` (`BT/BTS/BTR/BTC r/m, imm8`) ignored `prefix_66` and used the
  32-bit memory/register handlers.

Implementation note: the handler table now extends to 307 entries. New handlers
288-306 cover `66 0F AF`, 16-bit BT/BTS/BTR/BTC register/immediate forms, and
16-bit BT/BTS/BTR/BTC memory forms. The build validates with:

```
[check-handler-count] OK handler table=307 elem entries=307 cache guard=307
```

Lower-priority notes:

- `FF /3` and `FF /5` far call/jump remain effectively unimplemented; RCT has
  not hit them.
- `FF /7` is decoded as a pop form even though group-5 `/7` is invalid on real
  x86. If guest code reaches it, treating it as a pop could hide a real decode
  error.
- `66 0F C8..CF` (`BSWAP`) is undefined/invalid on older x86 and currently
  routes to the 32-bit BSWAP handler. That is probably harmless unless a guest
  probes invalid-op behavior.

---

## Sessions

Use `re_loop_sessions/` for any long-running session logs.

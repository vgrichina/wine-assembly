# RollerCoaster Tycoon — Progress

**Binary:** `test/binaries/shareware/rct/English/RCT.exe`
**Image base:** 0x00400000
**Data files:** `test/binaries/shareware/rct/Data/` — CSG1.DAT, CSG1i.DAT, CSS*.DAT, etc.
**Window:** Fullscreen 640x480 8bpp (Chris Sawyer's custom engine)
**Status (2026-04-30):** PR #1 fixed the `0x67` `LOOP/LOOPE/LOOPNE/JCXZ` decoder trap. With that in place, RCT gets past the splash, loads `SC3.SC4`, and enters the auto-demo/runtime path. The active investigation is now firmly in runtime/render/game-tick, not startup: `timeGetTime` is advancing, the `1x1` viewport write at `0x004311c2` appears intentional and is not the main bug, and `0x0043867d` is active but not the root deadlock. Presentation is also no longer a one-shot init artifact: repeated full-screen `SetDIBitsToDevice` calls occur, but the output remains black. The first hard failure currently seen is the fatal path at batch `1407`, where `0x00430344` compares the `SC3.SC4` scenario result against `word [0x00836522]`; that word stays zero, so the scenario handoff never reports success.

**Current fatal-path evidence (2026-04-30):**

- `timeGetTime` is not frozen in the headless path. A `--count=0x438248,0x43867d` run over 120k batches ended with `0x00438248 = 180` and `0x0043867d = 1466`, so the 25 ms pacing loop at `0x0043867d` is entered and exited repeatedly.
- The pure-GDI present path is active. `--trace-host=gdi_set_dib_to_device` over the same 120k-batch run shows repeated `640x480x8` full-screen presents, all returning `0x1e0` (`cLines=480`). The back-canvas PNG is still solid black, so the next rendering question is now "why are repeated presents black?" rather than "are presents happening at all?"
- The first fatal flag flip is earlier than the steady-state black-frame runs suggest. `--watch=0x560194 --watch-value=0x1` fires at batch `1407`, with `prev_eip=0x00555a9f` and live stack:

```
0x00430344 -> 0x004302a9 -> 0x0043870d -> 0x0043830f -> PostQuitMessage
```

- The compare site is concrete. Batch-1410 dumps show:
  - `0x008e1ac8 = "C:\\Scenarios\\SC3.SC4\0"`
  - `0x00836522..0x0083653f = all zero`

  So the dispatch path resolves `SC3.SC4`, calls `0x0042f986`, then fails at `0x00430344` because `word [0x00836522]` was never initialized to the expected scenario-selection value.
- `0x00430344` is part of the `0x004302aa` command interpreter. The sibling handler at `0x0043015c` performs the same "build scenario path -> call 0x0042f986 -> compare against `[0x00836522]`" sequence, which strongly suggests `0x00836522` is not random scratch but a real scenario-selection state slot that some earlier init/UI path should populate.

**2026-04-30 update — first real rendered frame recovered from the live branch.**

- Artifact-level proof finally split the renderer from the presenter:
  - DirectDraw dump at batch window `28200` shows:
    - `slot 8` (`640x480 offscreen`) is non-zero: `firstNonZero=434`, `checksum=365446`
    - `slot 4` (`640x480 primary`) is still all-zero
  - So RCT's software renderer *is* producing pixels, but the primary surface path is not what the headless compositor sees.
- A targeted headless fallback in `test/run.js` now uses the non-zero fullscreen offscreen surface when the primary remains zero at PNG-capture time.
- Result: `final.png` is no longer the untouched Win98 teal background. With the fallback active, the image contains a real multi-color game frame (`48225` bytes instead of the prior tiny uniform-teal PNG; teal pixel count drops from `307200/307200` to `0/307200`).
- This does **not** prove the canonical primary-surface present path is correct yet; it proves the game frame exists and the missing leg is the present/compositing path from the live offscreen buffer to the visible output.

**2026-04-30 update — present-path split proven with live artifacts.**

- On the current PR branch, end-of-run DirectDraw dump at batch window `28200` now emits real surface artifacts:
  - `slot 4` (`640x480 primary`) stays all-zero
  - `slot 7` (`128x64 offscreen`) stays all-zero
  - `slot 8` (`640x480 offscreen`) is non-zero (`firstNonZero=434`, `checksum=365446`)
- That means RCT's software renderer is filling the fullscreen offscreen game buffer while the canonical primary surface remains untouched.
- The corrected PNG fallback order now proves the offscreen buffer contains a visible frame:
  - before the fix, `final.png` was 100% Win98 teal
  - after repaint-first / offscreen-fallback-last ordering, `final.png` becomes a non-teal multi-color image and the log explicitly reports:
    `PNG fallback used offscreen slot 8 because primary slot 4 is still zero`

**Meaning:** the remaining bug is no longer "RCT does not render". It is specifically "the real game buffer is not being promoted to the canonical primary/present path on this branch." The next correctness step is to replace the PNG-time compatibility fallback with a real runtime `slot 8 -> slot 4` / visible-output present path.

**Meaning:** the investigation can now stop blaming the software renderer itself. The remaining correctness work is to replace the current compatibility fallback with a proper present path that promotes the real game buffer to the visible surface without needing PNG-time intervention.

**2026-05-07 update — GSK trap traced to missing 16-bit `F7` semantics.**

- The old data-execution crash at `0x008e746c` is fixed by decoding `66 8F /0`
  as 16-bit `POP r/m16` instead of 32-bit `POP r/m32`.
- After that fix and `mmioSeek`, the next blocker was RCT's own
  `"GSK Exception Trapper"` MessageBox at batch `41790`.
- Focused trace shows this was not an imported `RaiseException`; it was our
  hardware-SEH path landing in RCT's `__except` body at `0x0040319f`.
- The faulting guest instruction is `0x00429034: 66 f7 f1` (`div cx`). At
  `0x00429031`, the live operands are `AX=0x0204`, `DX=0x0000`, `CX=0x00ff`,
  which is a valid 16-bit division. The stale upper half of EDX is `0xffff`,
  so the 32-bit `DIV` handler incorrectly saw a huge `EDX:EAX` dividend and
  raised `#DE`.
- Action landed: `66 F7 /4..7` now routes to 16-bit MUL/IMUL/DIV/IDIV handlers
  for both register and memory operands. Handler table/cache guard now = `288`.
- Validation after the fix: `build/wine-assembly.wasm` compiles and a
  120k-batch RCT run no longer hits `0x00429034` or the GSK wrapper
  `0x00402ca0`. The next blocker is a new low-address execution stop:
  `EIP=0x00012601`, `dbg_prev_eip=0x00012601`, with `[esp+0]=0x004301ae`.
  The next trace should catch the first branch/return into `0x00012601` and
  inspect the caller around `0x004301ae`.

**2026-05-07 follow-up — low-address stop is a generated draw overwrite.**

- The transfer to `0x00012601` is a `ret` from `0x00457eb2`. The stack return
  slot at `0x03fffec8` originally held the valid generated-code return
  `0x009026b9`, from caller `0x009026b4`.
- Function `0x00457d3c` builds an 8x8 stack buffer at `0x03fffe78` and calls
  the generated sprite/glyph draw helper at `0x008fb38b` with descriptor
  `0x03fffeb8 = {buf=0x03fffe78, x=0, y=0, w=8, h=8}`.
- A watchpoint on `0x03fffec8` shows generated code writing through `EDI` into
  the return-address dword at `0x008fb75c`. The bytes change from
  `0x009026b9 -> 0x00902601 -> 0x00012601`.
- The inner draw helper at `0x008fb660` enters with generated globals
  `[0x008e9028]=0` (width), `[0x008e902c]=1` (height). The width-copy loop then
  loads `CX=0`, decrements it to `0xffff`, and walks far past the 64-byte stack
  buffer.

**Next concrete probe:** prove whether the zero width is caused by an emulator
flag/Jcc bug in the generated clipping code around `0x008fb584..0x008fb5d2`,
or by bad guest draw metadata/clip inputs that real RCT would normally avoid.
The useful dump point is the call to `0x008fb660` / trace at `0x008fb660`,
dumping `0x008e9010:48`, `0x03fffeb8:32`, and the sprite metadata.

**2026-04-30 follow-up — two stale assumptions corrected, one host-side bug fixed.**

- The `0x00430344` trace needs careful reading: that address is the `pop eax` immediately before the compare, not the compare itself. Live trace shows stack-top `0x00000003` at `0x00430344`, so after the pop the compare is effectively `cmp ax, [0x00836522]` with both sides = `3`. The old "slot stays zero" theory is stale on the current branch.
- `FindFirstFile("C:\\Scenarios\\*.SC4")` was genuinely wrong in the host layer. Before this pass, VFS enumeration followed host insertion/order and returned:
  `sc10, sc11, sc15, sc17, sc4, sc8, sc9, sc0, sc3`.
  That is a bad fit for Win98-era app expectations and clearly wrong for RCT's scenario scan. `VirtualFS.findFirstFile()` now sorts matches case-insensitively with numeric ordering, so the same probe now starts:
  `sc0, sc3, sc4, sc8, sc9, sc10, sc11, sc15, sc17`.
- The timer fix still matters directionally: the default guest-loop MM timer path reaches the known runtime renderer (`0x0043688e`, `0x00444374`), while forced `--async-mm-timer` diverges earlier. But the remaining render blocker is not the scenario compare.
- The viewport/off-map diagnosis still reproduces on the live binary after the timer fix. Trace-at on `0x00444374` with dumps of `0x5706a4` / `0x5706b0` shows a stable render-target like:
  - `left = 0xEDE0` (signed `-4640`)
  - `top = 0x029B` (`667`)
  - `w = 0x001D` (`29`)
  - `h = 0x0085` (`133`)
  - `pitch = 0x0263` (`611`)

  So the software renderer is still walking a clipped/off-screen strip instead of a visible viewport when `0x444374` runs.

**Action landed this pass:**

1. `lib/filesystem.js` — deterministic case-insensitive natural sort in `findFirstFile()` / `findNextFile()` results, fixing the bad `*.SC4` enumeration order.
2. `test/run.js` — `--dump-ddraw-surfaces` now reads the live low-memory DX table (`0xE970`, 32 slots) instead of the stale old high-memory table, so future surface dumps match the current branch layout.

**Next concrete probe:** trace who writes the `0x5706a4` / `0x5706a6` viewport globals on the default timer path and compare their source data before `0x431323` / `0x4311c3` against expected on-screen values. The scenario compare is no longer the primary suspect; the viewport-construction path is.

**2026-04-30 update — walker entry traced; bad coords come from clip math, not from caller.**

Probed first call into `0x00431245` (`pack_viewport_for_walker`) at batch 28123 with `--watch=0x5706a4 --watch-log` and `--trace-at=0x00431245 --trace-at-dump=...`:

- Caller's input struct at `EDI=0x008e6bcc` (a render-target struct) has **reasonable** values:
  - `+0 fb_ptr = 0x01be0f26` (in heap)
  - `+4 vp.left = 434`, `+6 vp.top = 0`, `+8 vp.w = 200`, `+a vp.h = 133`, `+c pitch = 440`
- The clip-rect struct passed via `ESI` resolves through `mov esi,[esi+0x8]` to `0x008e81a8`, contents:
  - `+0 = 0x027a (634)`, `+2 = 0x01b3 (435)` — screen size
  - `+4 = 0`, `+6 = 0` — clip origin
  - `+8..+b dword = 0x029beb83` — read as **word = 0xeb83 = -5245**
  - `+10 byte = 0x09` — zoom shift
- The clip+transform math at `0x004312c2..0x004312e1` does:
  `(world - clip) << zoom + [esi+0x8]`. With `world=434`, `clip=0`, `zoom=9`: `434 << 9 = 0x6400` (16-bit), then `+ 0xeb83 = 0x4f83`. Combined with the `0x00431323` adjustments (sub `[edi+4]`, sub `[edi+0xc]`) the result lands at the observed `vp.left=0xed35 (-4811)`, `vp.top=0x029b (667)`, `vp.w=0x000b (11)`.

So the bad off-map coords are **computed**, not received. The two suspects are:

1. The clip-rect ESI struct at `0x008e81a8` was never re-initialized for the actual screen origin — `[esi+0x8]` should be a small positive screen-buffer offset, not `0xeb83`.
2. The zoom shift (9) feeding `shl ax,cl` is too large for an 8-bit framebuffer — but RCT's own asm uses this scheme, so the input world coords are likely meant to be small. The 434/0/200/133 input may be in *map-tile* units that overflow when shifted.

`0x008e81a8` is the next concrete probe target: find writers of that struct's `+0x8` field (and `+0..+0xa`) and compare to what real Win98 RCT puts there during init. The struct is part of an array — original ESI=`0x008e717c`, then `[esi+0x8] = 0x008e81a8` (a linked viewport). Walking the chain or finding a `mov [0x008e81b0],...` pattern via `tools/find_field.js` will identify the missing init step.

**Writers of `[0x008e81b0]` (clip struct +8) found via `--watch=0x008e81b0 --watch-log`:**

| Batch | EIP | Writes | Notes |
|---|---|---|---|
| 25145 | `0x0055d0c3` | 0x0546fec3 | first writer; `prev_eip=0x55a977` |
| 25288 | `0x0055d0c3` | 0x0526fec3 | updates same field |
| 28124 | `0x0055805e` | **0x029beb83** | the BAD value seen at walker entry; `prev_eip=0x55802f` |

The two writer sites are both in `0x55xxxx` (RCT's hand-asm). `0x0055805e` is the immediate cause of the off-map walker. Investigating its enclosing function and the input that produced `0x029beb83` (the high half `0x029b=667` matches `vp.top`, the low half `0xeb83` is the screen offset in question) is the next concrete step toward actual rendering.

**Disasm context (2026-04-30):**

- Writer `0x0055805e` is mid-function; real entry is `0x0055802f` (called from `0x00557eeb`). The site reads `[edi+0x32]` (a flag byte test) and proceeds to copy `[esi+0x4]/+0x6/+0/+2` (left/top/right/bottom corners) into AX/BX/DX/BP. This is a **per-viewport-entry updater** that iterates an array of `0x14`-byte structs.
- Writer `0x0055d0c3` is a **viewport list compactor**: walks `0x008e81a8..0x008e825c` (9 entries × 20 bytes = the viewport array), collects non-empty (`word [esi]!=0`) ones into a pointer list at `0x008e825c`, and terminates the list with NULL.

So the data shape is now clear: there's a fixed array of **9 viewport descriptors** at `0x008e81a8..0x008e8258`, each `0x14` bytes, with a compact-pointer list right after it. The walker fault is that one of these 9 entries has `[+0x8] = 0x029beb83` written by the per-entry updater at `0x55802f`, which expected normalized screen coords but got world-space minus a missing camera origin.

The cleanest next step: trace `0x55802f` entry once after the bad write, dump its input ESI struct (the source of `0x029beb83`), and find what writes the source. That will identify the camera-origin / scroll-position global that was never initialized in our env — almost certainly a value populated by a WM_PAINT / DDraw `Lock` / scenario-load step that's currently a no-op in our DDraw stubs.

**New lead (2026-04-30, high priority): multimedia timer is still double-dispatched in the harness.**

- `test/run.js` is the **only** caller of `instance.exports.fire_mm_timer()`, and it was doing so unconditionally before every batch.
- The guest already has a second `timeSetEvent` path: `GetMessageA` / `PeekMessageA` call `$timer_check_due`, which synthesizes internal `0x7FF0` MM_TIMER messages that `DispatchMessageA/W` turn into the 5-arg `TimeProc` callback.
- This is not a theoretical concern. `abe.md` already documents the same bug shape: JS-side `fire_mm_timer` + guest-side `0x7FF0` caused the timer callback to run twice per tick and corrupted guest state. A follow-up fix (`b152575`) saved caller-saved regs across the async path, but it did **not** remove the duplicate dispatch itself.
- RCT's known hot path still fits that failure mode better than the viewport theory: it relies on `mm_timer`, `InterlockedExchange`, and busy-wait/tick pacing in the runtime path; duplicate timer callbacks can advance frame/tick state too fast, fire re-entrant work in the wrong place, and explain both the black-frame present loop and the `SC3.SC4` handoff state never stabilizing.

**Action landed:** `test/run.js` now leaves multimedia timer delivery to the guest message loop by default. The old async injection path is still available behind `--async-mm-timer` for experiments on binaries that genuinely need out-of-band callback delivery.

**Validate once `test/binaries/shareware/rct/English/RCT.exe` is present locally:**

1. Baseline with the new default:
   `node test/run.js --exe=test/binaries/shareware/rct/English/RCT.exe --max-batches=120000 --batch-size=5000 --count=0x438248,0x43867d --trace-host=gdi_set_dib_to_device`
2. Compare against forced async delivery:
   `node test/run.js --exe=test/binaries/shareware/rct/English/RCT.exe --async-mm-timer --max-batches=120000 --batch-size=5000 --count=0x438248,0x43867d --trace-host=gdi_set_dib_to_device`
3. If the default path is right, expect at least one of:
   - `word [0x00836522]` becomes non-zero before the `0x00430344` compare path
   - the black full-screen presents stop being solid black
   - the runtime no longer enters the same fatal branch at batch `1407`

**Status (2026-04-29):** RCT was regressed by commit 44a423c ("trap 0x67/GS"). The blanket `unreachable` on the addr-size-override prefix is a false positive for `LOOP/LOOPE/LOOPNE/JCXZ` (E0–E3): those have no ModRM, the prefix only swaps the implicit counter ECX→CX. RCT hits this in a `mov cx,N ; … ; 67 e2 f5` init pattern at `0x00452260` (and elsewhere) and crashed at batch 12473 with `[i32] 0xCA5E0067`. Decoder now bypasses the trap when the post-prefix opcode is in `0xE0..0xE3`, packing an `addr16` flag into the operand of handler 46 (LOOP, bit 4) and handler 216 (JCXZ, bit 0). Handlers updated to decrement/test CX (low 16 of ECX) when the flag is set, preserving the high half. RCT now runs through 200k batches with no crash, completes all init APIs, loads `SC3.SC4`, and enters the scene-render walker.

**Status (2026-04-17):** Implicit-show activation chain (commit e33deb0) makes CreateWindowExA with WS_VISIBLE deliver WM_ACTIVATEAPP/ACTIVATE/SETFOCUS/SIZE synchronously, matching real Win32. RCT's video-mode probe at `0x009026af` now sees `[0x568504]` populated (640) by the WM_SIZE handler at `0x0040418e`, so the fatal `jmp 0x555ab6` at 0x9026fd no longer fires. Game progresses past PostQuitMessage into the main WinMain loop and starts running game ticks.

**Session 2 win: decoder SIB-ordering bug.** The `EIP=0x004446cb` "stuck" signature turned out to be a real cache-corruption loop (`0xCAC4BAD0` marker printed repeatedly with `fn=0x008d8fce` — the xchg's `disp` being misread as an opcode). Root cause: `emit_sib_or_abs` has side effects (emits handler 149 + info + disp into the thread stream) and returns a sentinel. The decoder was calling it inline as an argument to `te_raw` **after** already emitting the main handler opcode, so the SIB prologue landed in the wrong order. The `xchg [0x8d8fce+edi*2], ax` at 0x004446e3 triggered this because it's the first SIB-addressed XCHG any tested app has hit.

Fix (two parts, across `src/07-decoder.wat` + `src/05-alu.wat`):
1. **Decoder — hoist** `emit_sib_or_abs` into local `$a` **before** the main `te(handler, op)` at every call site. 26 sites total — all instances of the pattern `(call $te ...) (call $te_raw (call $emit_sib_or_abs))` where `te` precedes `te_raw` in the same sibling list. Affected handlers: 196, 237, 270 (xchg), 252, 277, 173 (cmpxchg), 278, 174 (xadd), 176-179 (BT/BTS/BTR/BTC mem imm), 211 (setcc), 222, 257 (cmov mem), 223, 224, 260, 261 (shld/shrd mem), 225, 226, 264, 265 (bsf/bsr mem), 227-230 (bt/bts/btr/btc mem r), 267 (push m16), 268 (pop m16), 195 (cmpxchg8b).
2. **Handlers — read_addr not read_thread_word** in 173, 174, 176-179, 196, 237, 252, 270, 277, 278. `read_addr` detects the SIB_SENTINEL and returns `ea_temp` (computed by the 149 prologue); plain `read_thread_word` would take the literal sentinel 0xEADEAD as an address. The other affected handlers (222, 223, 224, 225, 226, 227-230, 211, 257, 260, 261, 264, 265, 267, 268, 195) already used `read_addr`.

**Result:** cache-corruption loop gone. RCT now runs past the tile-sort rebuild, through multiple game-tick iterations. Latest 300k-batch run ends at `EIP=0x004368a0` (inside the gate-taken body of the game tick, not inside init), 7205 API calls, stuck-after did not trip. No `0xCAC4BAD0` markers in trace.

**Gemini cross-check.** Ran `gemini -p` over the whole decoder/ALU/FPU trio to audit the pattern; confirmed all 26 sites + 10 handlers. Report saved to `/tmp/claude-rev/decoder-review.md` (one-off, not kept).

**Next:** stay on the runtime/render/game-tick path. The current questions are why `word [0x00836522]` never flips nonzero before the fatal compare at `0x00430344`, and why repeated full-screen `SetDIBitsToDevice` still produces black output even though `timeGetTime` is advancing and the game is clearly past splash/init. Also: any other app previously written off as "random cache corruption" (Pinball, DX games) should be re-tested since this bug was lurking for every SIB-addressed two-way mem instruction.

**Frame-presentation observation (2026-04-29).** This was the first post-`0x67` snapshot, before the later runtime trace showed repeated full-screen presents. At this point the run reached the scene walker and stayed there indefinitely. API trace tail shows: `SC3.SC4` opened (#6354), 394× `ReadFile` + 1× rewind `SetFilePointer` + 393× `ReadFile` + `CloseHandle` (#7145) — the scenario file is read twice (size probe + body). After #7145 there are **no further API calls** for at least 200k batches, including zero `PeekMessageA`. Hot EIPs are concentrated in:

- `0x00436640` — sprite-list walker (8-byte records; `[esi+1]&0x80` is the end-of-list bit; recurses via dispatch table at `[edi+0x59fa74]`, 16 slots).
- `0x00436868` — 2×2 tile-quad painter (calls `0x00444374` four times per quad).
- `0x00444374` — per-tile/sprite renderer (`movzx ax,word [0x8d8fce + idx*2]` is the tile→sprite-id map lookup; bounds-checks against `0x1000`; falls through to a heavy draw subroutine).

In that earlier trace, Lock/Unlock/Blt/StretchDIBits/BitBlt/SetDIBitsToDevice fired only during init (1 each); none appeared during the steady-state loop. Later tracing on the current line superseded that single-present picture: repeated full-screen `SetDIBitsToDevice` does happen, but the image remains black. The walker isn't visibly stuck on a single EIP — it cycles through ~25 distinct PCs in `0x436xxx`/`0x444xxx` — so it's *doing work* but never returning out to the WM pump. Two leading hypotheses:

1. **Slow-but-correct rendering.** RCT's demo scenario draws a deeply-recursive scene tree; under interpreter overhead a single frame may take >>300k batches. If that's the cause, eventually a present chain will fire — needs a much longer run (~5M batches) to confirm.
2. **Walker termination bug.** A bad write somewhere clobbers the end-of-list flag (`byte[esi+1]&0x80`) so the walker never stops. Would explain "lots of work, no API calls". Diagnose with `--watch-byte=<scene-list-end>` once the list root is identified, or `--break=0x004366e3` (walker exit) + step through sibling chain length.

`tools/find_fn.js` confirms walker entry is `0x00436640` (no static xrefs — it's reached through the dispatch table at `0x59fa74`, populated at runtime). Caller-of-walker is therefore the next concrete probe: `--watch-byte=0x59fa74 --watch-log` to see who writes that table, then break at the indirect-call site that finally invokes it.

**Previous status (2026-04-16):** WM_ACTIVATEAPP fix unblocked startup. Game loads all data files, maps CSG1.DAT (15MB) and CSS1.DAT (4.6MB), decompresses CSG sprites, enters main rendering loop. **Fixed:** `src/04-cache.wat` threshold check was `fn >= 270` but recent 16-bit opcode commit (b5b73ee) grew handler table to 280 — caused spurious `0xCAC4BAD0` "cache corruption" resets whenever the game used any 270–279 handler (looked like an infinite loop at `0x008fb473`, a sprite-blit fn). Raised check to `fn >= 280`. **Also fixed:** `GetSystemPaletteEntries` now returns the real 20 reserved Win98 system colors (was zeroing the buffer). Did not change the PostQuit behavior — break-on-PostQuit still fires at batch 12473 with the same trace as before, so palette-entry detection is not what gates the quit. Still exits after ~6216 API calls / GAME.CFG 95-byte write.

## What works

- CRT startup, registry, file system setup
- WM_ACTIVATEAPP/WM_ACTIVATE delivered synchronously during CreateWindowExA (CACA0020-0023 thunks)
- DirectDraw: DirectDrawCreate, EnumDisplayModes, SetCooperativeLevel, SetDisplayMode(640,480,8), CreateSurface (primary + 2 offscreen), CreateClipper, CreatePalette, SetPalette, Lock/Unlock
- DirectPlay: DirectPlayEnumerate (stub)
- DirectInput: CreateDevice (keyboard + mouse), SetDataFormat, GetDeviceState, SetCooperativeLevel, Acquire
- VFS: All data files load via root-relative paths (`\Data\CSG1.DAT`). Sibling dirs (Data/, Scenarios/, Saved Games/) mapped from parent.
- Registry: Demo key `HKLM\Software\Fish Technology Group\RollerCoaster Tycoon Demo Setup` with Path=`C:\`
- Scenario loading: SC.IDX index + 9 .SC4 scenario files enumerated via FindFirstFile(`\Scenarios\*.SC4`)
- CSG1.DAT memory-mapped via MapViewOfFile (15MB), CSG1I.DAT index processed and rebased
- CSS1.DAT memory-mapped (4.6MB sound data)
- CSG sprite decompression runs to completion (~50K batches)
- Main rendering/tick loop enters and runs (InterlockedExchange-based frame sync, mm_timer callback)
- Custom cursors loaded from PE resources (20+ LoadCursorA calls)
- GAME.CFG read/write
- Message loop: PeekMessage/TranslateMessage/DispatchMessage

## Current blocker: game PostQuitMessage's almost immediately after init

Trace summary (after the cache-guard fix shipped in 0004f79):

1. CRT/init/data-file discovery — all fine.
2. CSG1I rebase at 0x008fa065 completes (~33k iters).
3. CreateWindowExA creates `hwnd=0x10002 "RollerCoaster Tycoon"` 640x480 with menu ≠ 0 — *suspicious for a fullscreen DDraw game*.
4. DirectDraw chain: GetCaps → SetCooperativeLevel → SetDisplayMode → CreateSurface (primary) → CreateClipper → Clipper_SetHWnd → CreatePalette → SetPalette.
5. Second CreateSurface (offscreen) → LoadImageA (logo bitmap) → Restore → GetDC → BitBlt(GDI→DDraw surface) → ReleaseDC → SetColorKey → another CreateSurface → SetPalette → Lock/Unlock on something.
6. **CreateFileA("\\Data\\GAME.CFG", GENERIC_WRITE) → WriteFile(95 bytes) → PostQuitMessage(0)** — game saves a 95-byte config and exits cleanly.
7. Shutdown pump (PeekMessage/IsWindow/Translate/Dispatch ×4, DefWindowProc) drains.
8. After WinMain returns, EIP lands in a fill helper at 0x008fa0d5 with EDI=0, EDX=0xfffffeef (a 4-billion-iter spin) — looks like stale-register execution after an incorrect return target or CRT exit path that we mis-dispatch. Interpreter-visible infinite loop, not an RCT bug per se.

**Key observation in the 2026-04-16 trace:** `SetDIBitsToDevice` fired **exactly once** in that 49k-batch run (at the first Unlock, with `nonZero=false`). That specific "only once" observation is no longer current on the active RCT line: later tracing shows repeated full-screen `SetDIBitsToDevice`, but no non-black output yet.

**Why it quits is the real mystery:**
- The 95-byte GAME.CFG write is a config-save. RCT demo's WinMain probably saves cfg whenever WinMain unwinds.
- PostQuitMessage(0) = graceful exit. Something in our environment convinces the game to take the exit branch before it ever runs a real frame.
- Likely suspects: a) WM_ACTIVATEAPP delivered with wParam=FALSE, b) a COM call returning a failure HRESULT that RCT treats as "DirectDraw unavailable, abort", c) GetSystemPaletteEntries returning zeros, making palette detection fail (rct.md prior note mentioned this), d) a malformed surface desc for the offscreen surface causing the image-blit step to set a fatal flag.

**Call chain into PostQuitMessage** (dumped via new `API BREAK ENTRY` stack walk in `test/run.js`):

```
ret=0x004045bb     ; AppExit wrapper at 0x004045ad — just "push 0; call [PostQuitMessage]"
└ called from 0x00555b7a — quit helper at 0x00555b75:
    call 0x00452345   ;; checks [0x5a93d4], runs 5 shutdown calls, sets flag
    call 0x004045ad   ;; -> PostQuitMessage(0)
    ret
└ called from 0x00555aea inside a longjmp-style trampoline at 0x00555ae0:
    mov dword [0x560194], 1          ;; fatal-exit flag
    call 0x00555b75                  ;; run shutdown + PostQuitMessage
    mov esp, [0x008d8fac]            ;; *** longjmp: restore saved ESP ***
    pop ebp ; ret
```

So RCT is taking a `longjmp`-based **fatal-exit** path — the `mov esp,[0x8d8fac]` at `0x00555aef` is the giveaway. The game registered a `setjmp` target early in startup (the saved ESP+EBP live at `[0x8d8fac]`/`[0x8d8fa8]`-ish); somewhere in the DDraw/logo-blit sequence it decides something is unrecoverable, raises the fatal flag at `[0x560194]`, and longjmps out. The 95-byte GAME.CFG write happens inside `0x00452345`'s shutdown chain, not as cause of exit.

**To find *why* the longjmp fires:** watch on `[0x008d8fac]` to find the **setjmp** point (should be reached exactly once during init, likely right after WinMain's main-try entry), then watch on `[0x560194]` (currently 0 → becomes 1) to find the **raise** site. The latter is the real culprit branch.

**Raise site located (2026-04-16, after 84236e4).** `--watch=0x560194 --watch-value=0x1` fires at batch 12473. Two fatal-exit trampolines exist, both pattern `mov [0x560194],1 ; call 0x555b75 ; mov esp,[0x8d8fac] ; pop ebp ; ret`:

| Entry | Raise instruction | Error-code regs |
|---|---|---|
| 0x00555a84 (or nearby, via call)  | `mov [0x560194],1` at 0x00555a9f | uses BX error ID |
| 0x00555ab6 (entered via `jmp`)    | `mov [0x560194],1` at 0x00555ae0 | uses EAX,EBX pair |

RCT takes the **second** one. Call site: **0x009026dc — `jmp 0x555ab6`** after setting `EAX=0x344, EBX=0x346` (error-message string IDs). This is inside a **video-mode probe chain** at 0x009026af:

```
0x009026af  call 0x8fa000         ; init
0x009026b4  call 0x457d3c
0x009026b9  call 0x90252c
0x009026be  mov  al, [0x56fd6b]   ; currently-chosen mode flag
0x009026c3  cmp  al, 0xff ; jnz +2 ; mov al, 1     ; default to mode 1
0x009026c9  call 0x9024b4         ; TRY the selected mode
0x009026ce  or   al, al
0x009026d0  jnz  0x9026e1         ; success → continue init
0x009026d2  mov  eax, 0x344
0x009026d7  mov  ebx, 0x346
0x009026dc  jmp  0x555ab6         ; FATAL EXIT
```

`0x009024b4` dispatches on `al` (1/2/3 branches) and ultimately calls `0x00401220(mode_id)` with `mode_id ∈ {1,3,4,5}`. That callee returns nonzero on success; `[0x56fd6b]` records which mode succeeded. **Our DDraw returns 0/failure for every mode**, so the chain falls through to the fatal `jmp`.

`0x00401220` prologue reads `[0x560100]` (a handle — probably an existing surface/DD object) and calls through IAT slot `[0x562dd4]` before continuing at `0x00401416`. That IAT slot is the video-mode setup import (likely `SetDisplayMode` or `CreateSurface`), and its return is what ultimately decides success.

**Next concrete steps:**
1. `--break=0x00401220` + dump EIP trail: see what mode ids get tried and what return value lands in AL at `0x009024d1`/`0x9024fa`/`0x902522`.
2. Check `[0x00562dd4]` — **NOT an IAT entry**. The .data section is 0x560000-0x56aeb4; PE imports live at RVAs 0x15e000-0x15e2ff (IAT bases for USER32/GDI32/KERNEL32/DINPUT/DPLAYX/DSOUND/etc. are all 0x15e000+). `[0x00562dd4]` is a **runtime-populated function pointer**, set by earlier init code. Find its writer via a store-watch on 0x562dd4 before this code runs.
3. Compare DDraw return chain (SetCooperativeLevel, SetDisplayMode, CreateSurface primary) HRESULTs against real Win98 to find the one we're getting wrong.

**Deeper trace (2026-04-16 session 2).** The initial "0x00401220 returns 0" hypothesis was wrong. Inside the mode-3 path, 0x00401220 actually returns EAX=1 (via 0x4014d3 success branch) — `call 0x4029c4` returned 1 and `call 0x402a68` ran. So the fatal is NOT from the `jz 0x9024c0` branch. Trace-at on 0x00555ad6 captured the actual raise-site state: **EAX=0x300, EBX=0x345**, and the only site in the binary setting `mov ebx, 0x345` is at 0x00902702 (confirmed by byte-pattern scan).

So the real flow is the OTHER fatal branch:

```
0x009026e1  mov [0x560184], 0
0x009026eb  cmp [0x560178], 0    ; [0x560178]=0 at hit → jnz NOT taken
0x009026f2  jnz 0x9026fd
0x009026f4  cmp [0x568504], 0x40 ; [0x568504]=0 at hit → jge NOT taken
0x009026fb  jge 0x90270c
0x009026fd  mov eax, 0x344       ; (then mov eax,0x300 overwrites AL via fatal-trampoline setup — EAX=0x300 at raise)
0x00902702  mov ebx, 0x345
0x00902707  jmp 0x555ab6         ; FATAL
```

**Real gate: `[0x00568504] >= 0x40` (64)**. At fatal-hit batch 12473 it's 0; at batch 12600 it's 0x27a (634). So RCT *does* eventually populate it — the check just runs too early.

**The sole writer is at 0x00404199** (`mov [0x568504], eax`, found via `tools/xrefs.js`). Its enclosing function entry is **0x00404148** (found via `tools/find_fn.js` — `CC`-padding boundary). Function at 0x00404148 sets several resolution-related globals (`[0x568504]`, `[0x568a74]`, `[0x56017c]=1`, conditionally `[0x560178]=1`). Strong signal: this is the **"accept current display mode"** callback that normally runs during DD setup but isn't being invoked in our environment before the probe at 0x9026af.

**Next concrete step:** `tools/xrefs.js RCT.exe 0x00404148 --near=0 --code` to find who calls 0x00404148, then trace whether that caller runs at all before batch 12473 (`--trace-at=<entry>`). That path almost certainly depends on some DDraw call whose return we're mishandling.

## Debugging tools that paid off this session

- `tools/xrefs.js` — cheap way to answer "who writes/reads/branches-to address X". Replaces ad-hoc Python byte-scans.
- `tools/find_fn.js` — given an interior EIP (e.g. from a watch/trace hit), jumps to the containing function's entry. Avoids manual backward `55 8B EC` searches.
- `--trace-at=0xADDR` — fires on every instruction execution at the given EIP (unlike `--break=`, which only fires at block boundaries and silently misses mid-block addresses like 0x555ab6). Use trace-at when a breakpoint "should fire" but doesn't.

**API sequence right before quit** (from `--break-api=PostQuitMessage --trace-api`):
```
#6188 GetSystemPaletteEntries(hdc, 0,   10, buf)
#6189 GetSystemPaletteEntries(hdc, 246, 10, buf)
#6213 CreateFileA("\\Data\\GAME.CFG", GENERIC_WRITE, ..., CREATE_ALWAYS)
#6214 WriteFile(h, buf, 0x5f)           ;; 95-byte config
#6216 PostQuitMessage(0)
```
So whatever decision the game makes, it makes it in the ~24 blocks between the second GetSystemPaletteEntries return and the GAME.CFG write. Not the palette call itself (we now return proper data and PostQuit still fires at the same batch).

**Next steps:**
1. Break at CreateFileA for GAME.CFG-write (filter `str="\Data\GAME.CFG"` *AND* `arg1==0x40000000`) and walk back guest stack to find the decision site.
2. Try `--break=0x005c2b1a` (return site listed by trace) and step backwards through block cache to find the branch that led into the exit path.
3. Revisit COM HRESULTs: any of the 4 `CreateSurface`, `Restore`, `SetColorKey`, `Lock/Unlock`, `BitBlt` calls in the offscreen-logo setup could return a non-OK HRESULT we're miscomputing. Dump all DDraw call returns in the 0-6213 API range and compare against real Win98 expected values.
4. Once quit is avoided, revisit why the render-copy loop writes aren't landing in the primary DIB (the `nonZero=false` from the only Unlock).

## Prior status (resolved)

The game now starts up fully. Prior "memory collision" and "stuck at 0x00440b9f" hypotheses were misreadings:

- `0x008fa065` — trivial CSG1I rebase loop (33244 iters `add [esi],eax; add esi,0x10; loop`). Default `--stuck-after=10` was too aggressive and aborted mid-loop. With `--stuck-after=500 --batch-size=10000` it completes.
- `0x00424f70` — sprite-table walker (8-byte entries; tag in `byte[esi]&0x3c`; recurses into `0x0042e252` for tag 5). Runs to completion.
- `0x00440b9f` — tail of a 5-slot queue-insert helper (`0x00440b29`) called from `0x00438ee8` with `al=0x46 ah=0xff`. **Not a hang** — it's just where the idle event loop's per-frame work most often ends a batch. The game is in its main message pump waiting for input.
- Browser run shows a splash/menu dialog painted via DirectDraw surface blits. Headless `--png` captures only the GDI-composited back-canvas (still teal desktop) because RCT's own rendering goes straight to the primary surface.
- Previous `0xCAC4BAD0` cache-corruption / thunk-zone overlap no longer reproduces — the earlier +32MB memory-layout relocation + guest-heap MapViewOfFile held.

**Next steps:**
1. Capture the DirectDraw primary surface in `--png` so we can see what dialog the game is showing.
2. Inject a click / ENTER via `--input=` to advance past the splash and see what the next phase does.
3. Revisit `--stuck-after` default handling — idle-loop detection should not abort when WM_NULL / timer messages are being pumped normally.

## Key addresses

| Address | Description |
|---------|-------------|
| 0x00403C7D | WndProc |
| 0x00403B2E | PeekMessage-based message check (called from main loop) |
| 0x004010FC | Main function: calls init check, game init, game tick loop |
| 0x00430344 | Current first hard failure: fatal branch compares the `SC3.SC4` scenario result against `word [0x00836522]`, which is still zero at batch 1407 |
| 0x004311C2 | `1x1` viewport write that appears intentional, not the main bug |
| 0x00438248 | Main game tick function |
| 0x0043867D | Active runtime/render path site, but not the root deadlock |
| 0x0042F5A5-0x0042F5D9 | CSG sprite decompression inner loop |
| 0x00444600-0x0044463E | Rendering copy loop (memcpy-like, fires per frame) |
| 0x0040C7A6 | mm_timer callback (InterlockedExchange at 0x00562F2C) |
| 0x008FA065 | CSG1I index rebase loop (`add [esi],eax; add esi,0x10; loop` × 33244) |
| 0x00458720 | CSG data decompression function |
| 0x00424F70 | Sprite-table walk: 8-byte entries, tag in `byte[esi]&0x3c`, recursive call to 0x0042E252 for tag-5 |
| 0x0042E252 | Called from sprite-walk when tag nibble is 5 (sub-entries) |
| 0x00440B9F | Small 5-iter `xchg [esi+ecx*4+0xb0],eax` init (ECX 0..4); ends with `or [esi+0x45],1; pop ecx; ret`. Currently appears stuck — likely re-entered by outer loop. |

## DirectX usage

RCT uses DirectDraw for display mode selection and surface management, but its rendering is custom x86 asm blitting to the DD surface:
- **DirectDraw** — SetDisplayMode(640,480,8), CreateSurface (primary+2 offscreen), Lock/Unlock, palette, SetDIBitsToDevice for presentation
- **DirectSound** — sound effects (CSS*.DAT sound banks)
- **DirectInput** — keyboard and mouse via GetDeviceState
- **DirectPlay** — multiplayer enumeration (stub)

## Current rendering trace (2026-05-06)

The old "no rendering" diagnosis is stale on this branch. A 30k-batch run now
reaches the sprite renderer:

```
0x00431245 = 393221
0x00444374 = 918608
0x00444437 = 1441812
```

DirectDraw API tracing shows only setup-time surface operations:

```
[dx] BltRect dst=7 <- src=-1 COLORFILL
[dx] BltRect dst=8 <- src=-1 COLORFILL
[dx] Lock    slot=8 caps=OFFSCR dib=0x017f2d74 firstNonZero=-1
[dx] Unlock  slot=8 caps=OFFSCR dib=0x017f2d74 firstNonZero=-1
[dx] SetPal  palSlot=6 start=10 count=236 palWA=0x017f0964
```

After that, RCT does not call `Blt`, `BltFast`, `Flip`, `Unlock`, or any other
DirectDraw present method for the frame. Its custom x86 renderer writes directly
into the DIB pointer returned by `IDirectDrawSurface::Lock`.

Surface state at 30k batches:

| Slot | Kind | Size | DIB | State |
|------|------|------|-----|-------|
| 4 | primary | 640x480x8 | 0x017e3cdc | all zero |
| 7 | offscreen logo | 128x64x8 | 0x017f0d6c | all zero |
| 8 | offscreen game buffer | 640x480x8 | 0x017f2d74 | real partial frame |

The valid non-black pixels in slot 8 occupy `434,0-633,132`; the renderer
back-canvas has the exact same bbox. That means the visible "chunk" is not a
JS presentation offset/pitch bug. It is exactly what exists in guest memory at
the stop point.

A longer 120k-batch run makes the render counters climb to `9336292`, but ends
with corrupted control flow:

```
EIP=0x00000081
ESP=0xfbaf5808
```

By that point the DirectDraw surfaces are full of nonzero bytes that look like
corruption/garbage, while the live back-canvas still shows the earlier valid
chunk. Current blocker: execution correctness inside or just after RCT's
software render loop, not DirectDraw composition.

Follow-up control-flow trace:

- Baseline before the low-EIP crash passes through generated render-copy code
  at `0x008fb7d3`, then helper epilogue code around `0x008fb5d7`.
- `0x008fb7e6` is a real `ret`. With exact unaligned stack reads, normal hits
  return to `0x008fb5d7` (`pop edi; ret`), and normal `0x008fb5d7` hits return
  to a sane caller such as `0x00457e46`.
- The repeated `0x008e746e` state is not code. Dump/disasm of
  `0x008e7400..0x008e7600` shows a data table; accidental execution through it
  runs byte sequences that increment `EDX` and repeatedly `push esi`, steadily
  consuming stack until the later `EIP=0x00000081` failure.
- Heavy `--trace-at` runs perturb the exact failure path, so `test/run.js` now
  supports `--trace-at-start-batch=N` (delays arming and logging) and
  `--trace-at-limit=N`, and prints stack dwords via exact unaligned reads
  instead of aligned `Uint32Array` indexing.

Current inference: the visible chunk is a real partial frame. The next bug is a
bad/corrupted return address somewhere in or just after the generated render
helper chain, not a DirectDraw present bug and not a simple aligned-stack print
artifact.

**2026-05-07 fix — `66 8F /0` POP r/m16 decoder bug.**

The bad return source is now identified and fixed. The first real transfer into
the data table was:

```
0x00557c96: ret
[esp+0] = 0x008e746c
```

The enclosing RCT function at `0x00557bbc` uses an epilogue with five
operand-size-prefixed memory pops:

```
66 8f 05 ...   ; pop m16
```

The decoder's `0x8F` path ignored `0x66`, emitting `pop m32` instead of
`pop m16`. That over-advanced `ESP`, so `ret` consumed a viewport/data pointer
as a code address. `src/07-decoder.wat` now routes `66 8F /0` to handler 268
(`POP [addr] 16-bit`) and `66 8F /0 mod=3` to handler 182 (`POP r16`).

Validation after the fix:

- At `0x00557c96`, `[esp+0]` is now `0x00557a04`, not `0x008e746c`.
- The `0x008e746c` / `0x008e746e` data-execution path no longer reproduces in
  the focused run.
- A 120k-batch run no longer hits `EIP=0x00000081` or the `mmioSeek` fallback.
  It now reaches RCT's own exception-trapper MessageBox path after 48k API
  calls, ending stuck in the MessageBox thunk (`EIP=0x042006e0`) with:

```
"GSK Exception Trapper": "Exception Raised - Unspecified"
```

`mmioSeek` was the next missing host API after the decoder fix; it is now wired
through `host_fs_set_file_pointer`.

**2026-05-07 follow-up — generated draw helper cache invalidation.**

After fixing 16-bit `F7` divide semantics, the GSK trapper no longer appears in
the 120k-batch run. The next stop is a low-address return:

```
STUCK at EIP=0x00012601
prev_eip=0x00457eb2
[esp+0]=0x004301ae
```

The return slot was overwritten while executing RCT-generated drawing code near
`0x008fb75c`. A byte dump of the generated helper shows the clipping guards are
present in memory (`jns` / `js` / `jz` around `0x008fb561..0x008fb56c`), but the
translated cached block entered at `0x008fb575` and skipped them. That makes the
helper call the inner copy with width zero, underflowing to `0xffff` and
copying past the local 8x8 stack buffer.

Current emulator change under test: track executed image-data pages as generated
code and invalidate translated blocks when later stores touch them. Bulk string
operations (`REP MOVSB/MOVSD/STOSB/STOSD`) now invalidate destination code pages
before using `memory.copy` / `memory.fill`, because those paths bypass the
normal `gs*` store helpers.

Validation note: the first narrow version, which invalidated only `.text` plus
already-executed generated pages, still reproduced the stale path. The current
compiled variant widens the invalidator to all writes inside the loaded image,
because RCT can rewrite a generated helper before that page has been observed
and recorded as generated code.

**2026-05-07 x86 coverage follow-up — more 16-bit `0F` forms.**

The operand-size audit found another family of gaps adjacent to the RCT fixes:
`66 0F AF` and `66 0F A3/AB/B3/BB/BA` were still routed through 32-bit handlers.
New handlers now cover 16-bit two-operand IMUL and 16-bit BT/BTS/BTR/BTC
register, immediate, and memory forms. Handler table/cache guard is now `307`.

**2026-05-07 regression note — `F7 /4..7` decoder fallthrough.**

Full `npm test` exposed a direct x86 regression after the operand-size work:
`test-x86-ops` showed `MUL dword [mem]` executing its multiply handler and then
falling through to the generic unrecognized-opcode path for the same `F7`
opcode. The group-3 `/4..7` decoder has been rewritten as explicit `mr_reg`
arms, each branching back to decode after emission, so valid MUL/IMUL/DIV/IDIV
forms cannot append a bogus block-end after their real handler.

The same pattern also hit `0F AF`: Calc's bignum multiply emitted the IMUL
handler, then resumed at the second byte as standalone `AF` (`SCASD`), which
advanced `EDI` and shifted the result layout. The `0F AF` decoder now emits a
normal block-end (`th_block_end`, handler `45`) at the post-ModR/M EIP inside
each concrete IMUL arm, so the interpreter commits EIP to the next instruction
without appending the generic unknown-opcode terminator.

**2026-05-07 DirectDraw presentation follow-up.**

After the x86 fixes, RCT can run 120000 batches without a crash or message box:

```
Stats: 62135 API calls, 120000 batches
Hit counts:
  0x00438248 = 1023
  0x0043867d = 7617
```

The game now renders real pixels into DirectDraw. The dumped `640x480x8`
primary surface and matching offscreen surface both have non-zero image data,
203 colors, and checksum `1061936`. The saved compositor PNG and window
back-canvas were still all black because `presentBestDxOffscreen()` only copied
a matching offscreen surface when the primary surface was empty. Since RCT's
primary is now populated directly, the present bridge skipped it entirely.

Implemented fix: present a non-empty DirectDraw primary to the main window
first, then fall back to matching offscreen surfaces. The headless PNG dump also
forces one final DirectDraw present before repainting.

Validation update: a quiet 30000-batch run now writes the DirectDraw primary to
both the compositor PNG and the window back-canvas:

```
Stats: 24485 API calls, 30000 batches
Hit counts:
  0x00438248 = 445
  0x0043867d = 3002
PNG: 640x480, 234 colors, 55887 non-black pixels
DirectDraw primary: 640x480, 234 colors, 55887 non-black pixels
```

Artifacts:

```
/tmp/rct-30k.log
/tmp/rct-30k.png
/tmp/rct-30k_back_65538.png
/tmp/rct-30k-ddraw/manifest.json
```

Harness note: long RCT validations need `--quiet-blocks` in addition to
`--quiet-api`; the default runner logs every changing EIP and the generated draw
loop emits enough block transitions to dominate runtime.

Post-fix validation:

```
timeout 180 ./tools/build.sh
timeout 60 node test/test-web-pinball-assets.js
timeout 2400 npm test
TOTAL: 41 passed, 0 failed
```

**2026-05-07 web launch follow-up.**

The browser app entry originally loaded only `binaries/shareware/rct/English/RCT.exe`.
The local CLI runner recursively preloads companion files from the executable
directory, but the web launcher only fetches files listed in `apps.rct.files`.
That left the browser VFS without RCT's `Data`, `Scenarios`, `Tracks`, and
`Saved Games` trees, which makes the game show the "insert CD" dialog.

Implemented web fix: `index.html` now lists all 76 files under
`binaries/shareware/rct/` and maps them into VFS root-relative paths like
`c:\Data\csg1.dat`, `c:\Scenarios\SC.IDX`, and `c:\Tracks\Manic Miner.TD4`.
The deploy script now also exempts `binaries/shareware/rct/` from the generic
shareware and large-file skips so those assets are available on the hosted web
build.

Useful artifacts from this session:

```
/tmp/rct-dx.log
/tmp/rct-trace-ddraw/manifest.json
/tmp/rct-trace-ddraw/dx_08_offscreen_640x480_8bpp.png
/tmp/rct-long-ddraw/manifest.json
```

## COM objects

| Guest addr | Slot | Type | Notes |
|-----------|------|------|-------|
| 0x083e0000 | 0 | DDraw | Main DirectDraw object |
| 0x083e0008 | 1 | DInput | DirectInput object |
| 0x083e0010 | 2 | DIDevice | Keyboard |
| 0x083e0018 | 3 | DIDevice | Mouse |
| 0x083e0020 | 4 | DDSurface | Primary (640x480x8) |
| 0x083e0028 | 5 | DDClipper | Window clipper |
| 0x083e0030 | 6 | DDPalette | 256-entry palette |
| 0x083e0038 | 7 | DDSurface | Offscreen 1 (icon bitmap) |
| 0x083e0040 | 8 | DDSurface | Offscreen 2 (game buffer) |

## Next steps

1. **Trace slot-8 DIB writes** — watch `0x017f2d74` and sampled row offsets
   while breaking/logging at `0x00444437`; find when the partial frame turns
   into full-surface corruption.
2. **Trace the new exception path** — break around `0x00428ede` /
   `0x00402cf8` and dump the SEH/exception arguments that lead to the GSK
   Exception Trapper MessageBox.
3. **Keep DirectDraw as a presentation bridge only** — there are no frame-time
   DDraw blits to fix for RCT after setup.
4. **Fix GetSystemPaletteEntries** — DONE (2026-04-16). Now returns standard 20 reserved system colors for indices 0-9 and 246-255.

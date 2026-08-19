# Dead Ends Log

Entries here = approaches that wasted effort. Read before starting a task.

## Format
```
### YYYY-MM-DD — task name
- Tried: ...
- Why failed: ...
- Better approach: ...
- Session: N
```

---

## 2026-04-29 — Use --count flag to measure call hotness

- **Tried**: `--count=0x431323,0x436833,...` to measure how often these are hit
- **Why failed**: `--count` only checks EIP at batch boundaries (every ~10K instructions),
  not per-instruction. Short hot functions get missed almost always. Returned `count=1`
  for functions called millions of times.
- **Better approach**: Use `tools/caller_census.js` (embeds probes at callsite+5 in
  the threaded code, accurate per-invocation) or just instrument the WAT emitter.
- **Session**: prior

## 2026-04-29 — Use --trace-stack on arbitrary code addresses

- **Tried**: `--trace-stack=0x431323` to get stack traces at function entry
- **Why failed**: `--trace-stack` is wired only for Win32 API calls, not arbitrary EIPs.
- **Better approach**: `--trace-at-dump` with computed ESP offsets, or the `[esp..]`
  block in normal trace output.
- **Session**: prior

## 2026-04-29 — Assume Phase B is "rendering" because EIP is in 0x44xxxx zone

- **Tried**: After the prior session diagnosed RLE decompression as Phase A and saw
  EIP land in `0x436xxx` / `0x444xxx` afterward, called Phase B "rendering" and
  proposed pattern-detecting the pixel inner loop.
- **Why failed**: Hit counts on `0x444437` (the only pixel-writing dispatch) over
  300 K batches: **zero**. Phase B walks the tile grid 19 M times and bails on
  every sprite. The DDraw surface DIBs remain all-zero. There IS no rendering.
- **Better approach**: Treat Phase B as "stuck in an empty walk" and trace what
  init step failed to populate the cursor at `[0x5706a4/a6]` with a valid origin.
  See REVERSE.md "What's needed to break Phase B".
- **Session**: 2

## 2026-04-29 — `--watch=0x01be0f26` (alleged framebuffer)

- **Tried**: Watch the framebuffer pointer read from render-target struct +0
  for any byte writes, expecting to see the rasterizer touch it.
- **Why failed**: 0 fires across 200 K batches. Confirmed independently by full
  DIB dump (all zero). No sprite ever passes the visibility test, so no pixel
  is ever written, anywhere.
- **Better approach**: Don't try to find the writer of a memory range that
  isn't being written. Find the cause of the visibility failure first
  (off-map viewport, see REVERSE.md).
- **Session**: 2

## 2026-04-29 — `timeout 400 node test/run.js --max-batches=10000000`

- **Tried**: Long run hoping Phase B would eventually self-resolve and produce
  pixels.
- **Why failed**: Times out at exit=124 without ever calling the dump-surfaces
  end-of-run code. Phase B never makes forward progress — running longer just
  means more bails.
- **Better approach**: Cap runs at 200–300 K batches and use `--count` /
  `--watch-log` to characterize the loop. Forward progress is gated by an init
  step, not by wallclock.
- **Session**: 2

## 2026-05-06 — Treat the visible chunk as a DirectDraw presentation bug

- **Tried**: Assume the partial screen in Preview was caused by copying an
  offscreen surface with the wrong pitch, source rect, or destination offset.
- **Why failed**: The raw slot-8 DirectDraw dump and the renderer back-canvas
  have the exact same non-black bbox: `434,0-633,132`. The JS bridge is not
  moving the image incorrectly; it is faithfully showing the partial contents
  present in guest memory at the stop point.
- **Better approach**: Trace RCT's custom x86 writes into slot 8's DIB
  (`0x017f2d74`) and the later control-flow corruption (`EIP=0x00000081`,
  `ESP=0xfbaf5808`). DirectDraw is only setup/presentation after the lock.
- **Session**: 2026-05-06

## 2026-05-06 — Full `--trace-dx` for long render runs

- **Tried**: Run `--trace-dx` through the full render loop hoping frame-time
  DDraw calls would explain the missing screen.
- **Why failed**: The useful DX trace ends after setup. After the slot-8 lock
  and palette update, RCT does not call frame-time `Blt`, `BltFast`, `Flip`, or
  `Unlock`. The rest of the run is expensive CPU/API logging with no additional
  DirectDraw information.
- **Better approach**: Use one short `--trace-dx` run to confirm setup, then
  switch to `--watch`, `--trace-at`, and sampled dumps around the x86 renderer.
- **Session**: 2026-05-06

## 2026-05-06 — Trust old `[esp..]` trace-at output for generated helpers

- **Tried**: Use the old trace-at stack print to infer exact return targets
  around `0x008fb7e6` / `0x008fb5d7`.
- **Why failed**: RCT's generated helper path uses byte-unaligned `ESP`
  values such as `0x03fffe06`. The old printer indexed a `Uint32Array`, which
  effectively aligned the address before reading dwords. That can show the
  wrong return slots.
- **Better approach**: Use the updated `test/run.js` trace-at output, which
  reads `[esp+0]`, `[esp+4]`, etc. with `DataView.getUint32(..., true)`.
  Prefer late, limited traces with `--trace-at-start-batch=N` (delayed arming)
  and `--trace-at-limit=N`.
- **Session**: 2026-05-06

## 2026-05-07 — Keep chasing `0x008e746e` as a generated-code return bug

- **Tried**: Treat the data-table execution as a bad `ret` from generated
  blitter code around `0x008fb7e6` / `0x008fb5d7`.
- **Why failed**: Late exact traces showed those generated returns were sane.
  The first real bad transfer was `0x00557c96: ret`, with `[esp+0] =
  0x008e746c`.
- **Better approach**: Look at the caller epilogue. It used `66 8F /0`
  memory pops, and the decoder was ignoring the `0x66` operand-size prefix for
  opcode `0x8F`, consuming 4 bytes instead of 2. Fixed in `src/07-decoder.wat`.
- **Session**: 2026-05-07

## 2026-05-07 — Treat the GSK trapper as an app-level fatal error

- **Tried**: Follow the `"GSK Exception Trapper"` MessageBox as if RCT had
  raised an intentional app exception or hit an unimplemented Win32 API.
- **Why failed**: There is no imported `RaiseException` on this path. The trap
  is wine-assembly's hardware-SEH dispatcher entering RCT's `__except` body.
  The real failing instruction is `0x00429034: 66 f7 f1` (`div cx`), and live
  operands are valid for 16-bit x86 (`DX:AX=0x00000204`, `CX=0x00ff`).
- **Better approach**: Check operand-size handling in group `F7`. The decoder
  was routing `66 F7 /4..7` to 32-bit MUL/DIV handlers, so stale high EDX bits
  caused a false divide error. Fixed with dedicated 16-bit handlers.
- **Session**: 2026-05-07

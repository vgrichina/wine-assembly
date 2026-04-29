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

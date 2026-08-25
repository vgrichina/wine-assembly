# Loop Microbenchmark Harness

ASCII TLDR:

```text
tools/bench-loops.js injects a synthetic guest loop into a live wasm instance
and times it, with both A/B arms in ONE process alternating every rep.

Measured noise floor: +-1% at load 3.5, against the 24-42% that made every
whole-app A/B in interpreter-dispatch-perf.md unresolvable. That floor tracks
the box -- at load 10.9 the same null control read -5.3% -- so run the null
control in the SAME session and treat it as the threshold, not a constant.

Every shape verifies its own work, because rep_movsd first shipped copying
zeros onto zeros: a memory.copy that never ran would have been byte-identical
and reported DRAM bandwidth for doing nothing.

It found something on its first calibration run: CASE_CHAIN is +57% FASTER on
its own shape while printing 7.7% MORE handler ops. Op count did not just
understate the win, it reported the wrong SIGN. What actually changed is block
ENTRIES: 5.50 -> 2.00 per iteration, because every `jz` in an unfolded ladder
ends a block. ~27ns each.

Every fusion in this repo has been judged on the handler histogram. The handler
histogram cannot see block entries.

Second finding, same run: the same 16MB written through the per-op store path
runs at 122 MB/s and through `rep movsd` (memory.copy) at 52,366 MB/s. A 428x
gap, and it is all $g2w + $invalidate_code_write + the page-cross test.
```

Companion docs: [interpreter-dispatch-perf.md](interpreter-dispatch-perf.md)
(the four timing passes that resolved nothing, and why),
[page-compile-design.md](page-compile-design.md) §14 (CASE_CHAIN's whole-app
result), [loop-idiom-superops-design.md](loop-idiom-superops-design.md).

## 1. Why

`docs/interpreter-dispatch-perf.md` closes with *"this box cannot time these
changes, and no amount of statistics fixes that."* Four passes over five
worktrees; a 24.5-41.9% noise floor against effects of 5-8%; one pass that
manufactured four fake 6-11% "speedups" purely out of position in the round.
Four built, correct, execution-identical branches are still sitting unmerged
because nobody could measure them.

The fix is not better statistics. It is a bigger effect and a tighter loop:

- **Bigger effect.** A synthetic loop that *is* the workload turns a 2%
  whole-app change into a 57% microbenchmark change.
- **Tighter loop.** Both arms run in one process, alternating every rep, with
  the order rotated within each rep. Background drift becomes common-mode
  instead of between-variant, and position bias cancels.

It needs no new WAT and no PE emitter. `test/test-x86-ops.js` already had the
pattern — load a PE for an image base, write raw x86 bytes into it, `set_eip`,
`run` — and `13-exports.wat` already had the counters and the fold toggles.

## 2. Use

```bash
node tools/bench-loops.js --list
node tools/bench-loops.js --bytes=16m --reps=5
node tools/bench-loops.js --shapes=cmp_ladder --toggle=case_chain
node tools/bench-loops.js --shapes=store_stream --bytes=64m --json
```

| flag | meaning |
|---|---|
| `--shapes=a,b` | which loop shapes (default: all) |
| `--bytes=N[k\|m\|g]` | working-set size (default 4m) |
| `--reps=N` | interleaved timed reps (default 9); minima are quoted |
| `--toggle=NAME` | A/B a runtime fold: `case_chain`, `rle_run`, `rect_run` |
| `--top=N` | handlers listed per arm (default 6) |
| `--json` | machine-readable, includes the full per-handler histogram |

Each shape gets a fresh wasm instance, so a block cache or code-page bitmap
carried over from the previous shape cannot make one shape's numbers depend on
run order. Within a shape, the loop is re-emitted at a **fresh code address**
every rep: that is what makes a decode-time fold toggle take effect without a
`clear_cache` export, and it keeps both arms paying the same decode cost.

## 3. Calibrate before believing it

The harness's first job is not to measure anything new. It is to reproduce a
**known sign**, using the runtime fold toggles that already exist.

Measured 2026-08-24, box at load 3.5, `--shapes=cmp_ladder --bytes=1m --reps=6`:

| toggle | run 1 | run 2 |
|---|---|---|
| `case_chain` (the fold this shape uses) | **+57.4%** | **+57.8%** |
| `rect_run` (a fold this shape cannot use — null control) | **+0.7%** | **−0.9%** |

The null control is the part that matters: it is the same code path, the same
interleaving, the same rotation, with a toggle that changes nothing. It comes
back at ±1%. That is the noise floor, and it is 25x tighter than the whole-app
harness.

**Run the null control in the SAME session as the real measurement, every
time.** It is not a one-time calibration, it is an instrument that reports the
noise floor *at that moment*. Re-run an hour later at load 10.9 and the same
null control came back at **−5.3%**, with the real toggle still at +58.6%. The
floor tracks the box; only the null control tells you where it is, and a result
smaller than the concurrent null control is not a result.

A new shape whose null control does not come back near zero on a quiet box has a
layout or aliasing problem, and none of its other numbers mean anything.

## 3.1 Every shape verifies its own work

Each shape carries a `verify` hook, run unconditionally outside the timed
region, that checks the loop actually had its memory and register effect. A
failure is a hard error, not a warning.

This is not defensive decoration. `rep_movsd` originally shipped with an
unfilled source buffer — copying zeros onto zeros, where a `memory.copy` that
never ran is byte-identical to one that did. It would have reported the
machine's DRAM bandwidth for doing nothing, which reads exactly like a
spectacular result. Two of the first verifiers had the same hole one level down
(`lut`'s table mapped 0 → 0, so checking `dst[0] == 0` passed on a loop that
never ran; `stack_traffic` checked spill slots it had not cleared, so it passed
on the previous rep's data). Destination bytes are now explicitly cleared before
each rep and the expected values are non-zero by construction.

When adding a shape: make the expected result impossible to reach by accident,
then confirm the verifier fails when you disable the loop body.

## 4. What it found on the calibration run

### 4.1 Op count reported the wrong sign

```text
  case_chain=1   min  73.8ms   14.00 ops/iter   2.00 blocks/iter
  case_chain=0   min 173.5ms   13.00 ops/iter   5.50 blocks/iter
  => +57.4% time, -7.7% ops, +63.6% block entries
```

The folded arm is 57% faster *while printing more handler ops*. Two things are
going on and both are worth knowing:

**Handlers 420-424 re-record the ops they replaced.** `$th_case_chain`
(`src/06b-core-handlers.wat:522`) deliberately writes the cmps and jzs it
replaced back into the histogram, so totals stay comparable with a
`--no-case-chain` build. So with a fold live, `ops/iter` is the
*unfolded-equivalent* count plus the fold's own dispatch — it is not the
dispatch count. The tool prints a NOTE whenever one is live.

**And the real variable is block entries, which no histogram in this repo
counts.** Every `jz` in an unfolded ladder ends a block, and a block entry costs
an eip store, a cache lookup and a trip round `$run`'s loop — none of which is a
handler dispatch. 99.7ms saved over 3.5 removed entries × 1,048,576 iterations
is roughly **27ns per block entry**.

Every fusion in this repo has been judged on the handler histogram. That is why
`blocks/iter` is in the output: it comes free from the hot-block histogram,
which `13-exports.wat:181` already records under the same gate.

### 4.1a MB/s does not compare across shapes — ns/op does

The shapes move **1, 3 and 16 bytes per iteration**, so a bytes-per-second
figure ranks them by how much data each op happens to carry, not by how much
the interpreter costs. Measured 8MB, load ~10:

| shape | ns/iter | ops/iter | ns/op | B/iter | MB/s |
|---|---|---|---|---|---|
| `lut` | 179.3 | 7 | **25.6** | 3 | 16 |
| `store_stream` | 215.8 | 7 | **30.8** | 16 | 71 |
| `stack_traffic` | 178.6 | 8 | **22.3** | 0 | — |
| `cmp_ladder` | 150.5 | 14\* | 10.8\* | 1 | 6 |

`store_stream` has the highest MB/s of the four and is the **slowest per op** —
it just carries four bytes per store where `lut` carries one. Read `ns/op`
across shapes; `MB/s` only between two arms of one shape, or between two shapes
moving the same bytes by different routes. §4.2 is the one that qualifies.

\* with a fold live, `ops/iter` is the unfolded-equivalent count, so `ns/op` is
understated in the same proportion. The tool prints a NOTE.

### 4.2 The store path is 428x slower than `memory.copy`

Same 16MB written, `--bytes=16m`:

| shape | throughput |
|---|---|
| `store_stream` (`mov [edi+edx*1+disp], eax` ×4) | **122 MB/s** |
| `rep_movsd` (already lowered to `memory.copy`) | **52,366 MB/s** |

The gap is `$g2w` + `$invalidate_code_write` + the page-cross test, paid per
store. `rep movsd` pays it once for the whole range. That is the ceiling on any
"bind once, store many" or region-typed-store work, and it is enormous.

For reference on the same run: `lut` (the Heroes II shape) 32 MB/s, `cmp_ladder`
13 MB/s.

### 4.3 The open contradiction

CASE_CHAIN is **+57%** on its own shape here and was measured at **≤2%,
indistinguishable from zero** on the real app (`page-compile-design.md` §14) —
for a shape that is 24% of Caesar's block entries. Those two numbers do not
reconcile, and one of them is wrong. Candidates:

- The whole-app measurement was taken at a 24-42% noise floor and ≤2% is simply
  what "unresolvable" looks like.
- The microbench's block entries are cheaper or dearer in isolation than amid a
  1861-block working set (`tools/cache-slots.js` is the tool for that half).
- Caesar spends its remaining time somewhere that dilutes a 24% share far more
  than arithmetic suggests.

**Resolving this is the next piece of work, and it is worth more than any new
fusion**, because until it resolves neither harness can be trusted to rank a
change.

## 5. What it does NOT measure

- **Dispatch cost is understated, systematically.** A periodic short loop lets
  the BTB predict every `call_indirect` target perfectly, and the mispredict
  *is* the ~23% `$next` cost in a real profile. A change that wins only on
  dispatch count needs a whole-app confirmation. A change that wins on the
  memory path reproduces here honestly.
- **Whether the shape occurs in real code.** `tools/find-loops.js`,
  `tools/match-loops.js`, `tools/find-rle-nests.js` and `--handler-hist` answer
  that; `find-rle-nests.js` says the Caesar RLE nest is **1 of 287 PEs**. Quote
  that number next to any result from this tool.
- **The cold g2w paths.** Every shape's buffer sits in the direct guest window,
  so only `$g2w`'s fast path runs. The sparse `VirtualAlloc` ranges, the DIB
  range and the code-marked-page retire walk are all untouched. See §6.

## 6. Next: warm mode

Cold mode makes the store path look *cheaper* than it is, in four specific
ways, all pointing the same direction:

| | cold (freshly-loaded notepad) | after a real app has run |
|---|---|---|
| `$g2w` | `VIRTUAL_MAP_TABLE` empty — returns on the first compare, every time | real distribution across 4 cached sparse ranges and the scan |
| `$code_write_is_code` | code-page bitmap nearly empty — declines fast and predicts perfectly | populated, branch is real |
| block cache | empty, no eviction or index contention | Caesar's working set is 1861 blocks in 4096 slots |
| icache | a handful of handlers warm | hundreds |

Warm mode: boot `--app=caesar3_demo` (or RCT, which has a 12x throughput cliff
after ~2500 batches) to a named batch, snapshot EIP/ESP, point EIP at the
injected loop, run, exit. Every export it needs already exists —
`set_eip`/`set_esp`/`run`/`get_eip`, plus `get_virtual_alloc_top` /
`set_virtual_alloc_top` (`13-exports.wat:379`) to carve the streaming buffer out
of the *sparse* range deliberately, so the loop exercises sparse translation
instead of the direct window.

That turns buffer residency into a first-class axis: direct window / sparse
range / DIB range / code-marked page are the four branches the store path
actually has, and only a booted app presents them honestly.

One trap to build in from the start: injecting into a booted app corrupts that
app's state, so a warm run is one-shot. Snapshot, inject, measure, exit. Do not
resume the app afterward and do not reuse the instance across shapes, or you
are measuring the previous shape's damage.

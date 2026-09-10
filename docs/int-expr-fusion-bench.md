# Integer expression-region benchmark

`tools/int-expr-region-bench.js` — the integer twin of the x87 region bench
(`tools/x87-realistic-region-bench.js` / `docs/x87-realistic-region-bench.md`,
landing on a separate branch), answering the "x86 integer expression lowering"
section of `docs/semantic-expression-fusion-benchmark.md`. Both of those
documents are referenced by name rather than linked because they are not on this
branch yet.

**Question.** For an x86 *integer* basic block with an expression-shaped
interior, how much does lowering it at decode time to one dataflow expression
tree — one dispatch per block, intermediates in wasm locals, only live-out
registers materialized at exit, flags computed only where consumed — save over
today's per-op handlers, and over the pair-fused superinstructions we already
have?

**Answer, in one line.** On a hot block the tree is worth **10x-70x** over
per-op handlers, pair fusion is worth **1.0x-1.6x**, and the two are not close;
roughly a third to a half of the tree's win is dispatch elimination and the rest
is keeping intermediates in locals, though *that* split is engine-dependent.

```
node tools/int-expr-region-bench.js
node tools/int-expr-region-bench.js --no-jsc --no-calibrate
INT_EXPR_ROUNDS=9 INT_EXPR_JSON=/tmp/out.json node tools/int-expr-region-bench.js
```

---

## Method

Standalone generated WAT modules, one per arm, compiled through
`lib/compile-wat.js`. Every arm executes the **same guest program over the same
architectural state** and returns an i64 checksum of all of it — eight
registers, the five lazy-flag words plus `saved_cf`, a branch accumulator, the
block budget, and a 64-word window of guest memory. The driver asserts every
arm agrees at every (shape, trips) point and **throws instead of reporting
timings** when they do not. An arm that "wins" by not doing the work fails
loudly. It caught a real bug during development (see *Stale flag fields*).

Arms are interleaved inside one process with the order rotated every round, and
the median of five warm rounds is taken, because this box sits at load 10-40 and
the only defensible output is a ratio between arms measured in one process. Both
runs quoted here were taken at loadavg 2-4.

### The five arms

| arm | what it is |
|---|---|
| `handlers` | one `call_indirect` per guest op. Production-shaped: `br_table` register file over globals (copied from `src/03-registers.wat`), four flag-global stores per ALU op via `$set_flags_add`, operands read from a thread-word stream, loads/stores through a `g2w`-style base add on a mutable global. |
| `pairfused` | adjacent ops greedily fused into two-op handlers, one dispatch per pair, register file and flags still written per op. |
| `tree` | one dispatch selects the whole block. Straight-line in locals; registers loaded at entry, live-out registers written once at exit; flags materialized only where a later op consumes them or where the block's exported state requires it. |
| `tree_lowered` | `tree` over a better-lowered op list — see *Better lowering* below. |
| `directmem` | `tree` with every local replaced by a scratch **global**. Same dispatch elimination, same flag laziness, same write-back discipline; only the storage class differs. This is what isolates the value of locals from the value of losing dispatch. |

The op semantics are written **once**, in `emitOp`. The arms differ only in the
storage/dispatch context (`C`) handed to it, so an arm cannot quietly execute a
different program.

### Pressure and safepoints

Eight live integer registers (including `esp`), the lazy flag word, a branch
accumulator, and a **block budget decremented once per block entry** with a
periodic reset. Every arm pays the budget identically, so a block that costs
nothing still costs that.

`trips` is trips *per entry*: entry and exit materialization are charged once
per call and the block body runs `trips` times inside, which is what makes the
`trips=1` column meaningful — it is the cost of a region that runs once.

### Shapes

| shape | ops | what it is |
|---|---:|---|
| `dot` | 12 | fixed-point 3-vector dot: 3x (load, `imul` mem), 2 adds, `sar 16`, store, both pointers stepped |
| `addr_loop` | 8 | `out[i] = in[i]*100 + bias` with both pointers stepped, `dec`/`jnz` |
| `flag_chain` | 5 | three ALU ops then `cmp` + `jl` — earlier flags dead, the `cmp` flags must be right |
| `adc_chain` | 3 | `add`/`adc`/`adc` — the **barrier control** |
| `fixmul64` | 4 | one-operand `imul` (`edx:eax`) + `shrd eax,edx,16`, pointer step, `dec` |
| `vec4` | 18 | four independent lanes `out[i] = in[i]*3 + 7`, then both pointers stepped |
| `chain16` / `chain32` | 16 / 32 | foldable ALU ops, no barrier, no flag consumer |

**Every shape carries a register dependency from one trip to the next, and the
tool asserts it** (`assertLoopCarried`). This is not cosmetic: an early version
of `dot` and `vec4` recomputed identical values every trip, which makes the body
loop-invariant and lets an engine hoist it out of the trip loop in the
straight-line arms while the dispatched arms still execute it. That would have
reported dead-code elimination as a fusion win. Adding the pointer steps moved
the `dot` tree ratio at 64 trips by less than a rounding step, so no hoisting
was in fact happening — but the guard is what makes that statement checkable
rather than hopeful.

### Stale flag fields — the bug the checksum caught

`$set_flags_logic` writes only `flag_op` and `flag_res`; `$set_flags_shift`
writes `flag_op`, `flag_res` and `flag_b`. So after `add eax,ebx; …; sar eax,16`
the architectural `flag_a` still belongs to the **add**, several ops back. A
region that materializes "the last flag producer" gets this wrong. The tool
therefore computes the last writer of each *field* (`FLAG_FIELDS`), not the last
flag-producing op, and only that op writes that field's local. `chain32` keeps
this covered permanently: it ends on a logic op, so its final `flag_a` comes
from the op before it.

---

## Results

Ratio to arm 1 (`handlers`). Lower is faster. `handlers ns/op` is the baseline
in absolute terms and is **not** a result — it is there so the ratios can be
sanity-checked against the calibration below.

### Node / V8 (v8 in-process, 5 warm rounds, loadavg 3.3)

| shape | ops | trips | handlers ns/op | pair | tree | tree+ | directmem |
|---|---:|---:|---:|---:|---:|---:|---:|
| dot | 12 | 1 | 13.06 | 0.927 | 0.397 | 0.397 | 0.652 |
| dot | 12 | 4 | 9.80 | 0.793 | 0.146 | 0.146 | 0.348 |
| dot | 12 | 64 | 8.66 | 0.763 | 0.034 | 0.034 | 0.196 |
| dot | 12 | 256 | 8.48 | 0.764 | 0.025 | 0.025 | 0.189 |
| addr_loop | 8 | 1 | 17.06 | 0.802 | 0.442 | 0.448 | 0.641 |
| addr_loop | 8 | 4 | 11.16 | 0.708 | 0.179 | 0.180 | 0.351 |
| addr_loop | 8 | 64 | 9.27 | 0.653 | 0.035 | 0.035 | 0.158 |
| addr_loop | 8 | 256 | 9.03 | 0.655 | 0.026 | 0.026 | 0.148 |
| flag_chain | 5 | 1 | 19.10 | 0.982 | 0.612 | 0.614 | 0.775 |
| flag_chain | 5 | 4 | 11.20 | 0.927 | 0.274 | 0.274 | 0.454 |
| flag_chain | 5 | 64 | 8.76 | 0.898 | 0.049 | 0.049 | 0.198 |
| flag_chain | 5 | 256 | 8.47 | 0.908 | 0.034 | 0.034 | 0.178 |
| **adc_chain** | 3 | 1 | 27.65 | **1.000** | 0.728 | 0.727 | 0.840 |
| **adc_chain** | 3 | 4 | 15.35 | 0.914 | 0.337 | 0.337 | 0.559 |
| **adc_chain** | 3 | 64 | 10.31 | 0.931 | **0.096** | 0.095 | 0.304 |
| **adc_chain** | 3 | 256 | 9.88 | 0.931 | 0.072 | 0.072 | 0.283 |
| fixmul64 | 4 | 1 | 23.62 | 0.922 | 0.625 | 0.632 | 0.827 |
| fixmul64 | 4 | 4 | 13.28 | 0.882 | 0.299 | 0.296 | 0.525 |
| fixmul64 | 4 | 64 | 10.22 | 0.845 | 0.075 | **0.061** | 0.306 |
| fixmul64 | 4 | 256 | 10.09 | 0.844 | 0.061 | **0.047** | 0.299 |
| vec4 | 18 | 1 | 14.43 | 0.711 | 0.240 | 0.233 | 0.434 |
| vec4 | 18 | 4 | 12.01 | 0.649 | 0.080 | 0.072 | 0.218 |
| vec4 | 18 | 64 | 11.26 | 0.621 | 0.018 | **0.010** | 0.131 |
| vec4 | 18 | 256 | 11.13 | 0.628 | 0.014 | **0.007** | 0.127 |
| chain16 | 16 | 1 | 13.42 | 0.901 | 0.280 | 0.279 | 0.498 |
| chain16 | 16 | 4 | 11.23 | 0.876 | 0.091 | 0.092 | 0.282 |
| chain16 | 16 | 64 | 10.47 | 0.872 | 0.021 | 0.021 | 0.202 |
| chain16 | 16 | 256 | 10.45 | 0.874 | 0.017 | 0.017 | 0.200 |
| chain32 | 32 | 1 | 11.88 | 0.913 | 0.161 | 0.162 | 0.381 |
| chain32 | 32 | 4 | 10.70 | 0.901 | 0.056 | 0.056 | 0.257 |
| chain32 | 32 | 64 | 10.14 | 0.900 | 0.018 | 0.018 | 0.214 |
| chain32 | 32 | 256 | 10.27 | 0.900 | 0.016 | 0.016 | 0.206 |

Break-even, `tree` vs `directmem`: **1 trip on every shape.** Locals are ahead
from the first execution on V8; there is no crossover to wait for.

### JSC (jsvu shell — labelled JSC, not Safari)

| shape | ops | trips | handlers ns/op | pair | tree | tree+ | directmem |
|---|---:|---:|---:|---:|---:|---:|---:|
| dot | 12 | 1 | 12.03 | 0.736 | 0.417 | 0.412 | 0.491 |
| dot | 12 | 4 | 7.93 | 0.713 | 0.162 | 0.158 | 0.191 |
| dot | 12 | 64 | 6.63 | 0.716 | 0.033 | 0.033 | 0.105 |
| dot | 12 | 256 | 6.49 | 0.709 | 0.022 | 0.022 | 0.096 |
| addr_loop | 8 | 1 | 14.95 | 0.785 | 0.491 | 0.477 | 0.492 |
| addr_loop | 8 | 4 | 8.13 | 0.691 | 0.226 | 0.236 | 0.235 |
| addr_loop | 8 | 64 | 6.13 | 0.587 | 0.046 | 0.047 | 0.101 |
| addr_loop | 8 | 256 | 6.02 | 0.585 | 0.032 | 0.033 | 0.092 |
| flag_chain | 5 | 1 | 17.51 | 0.929 | 0.658 | 0.652 | 0.654 |
| flag_chain | 5 | 4 | 8.84 | 0.863 | 0.330 | 0.330 | 0.331 |
| flag_chain | 5 | 64 | 5.76 | 0.817 | 0.073 | 0.073 | 0.104 |
| flag_chain | 5 | 256 | 5.62 | 0.805 | 0.051 | 0.051 | 0.085 |
| **adc_chain** | 3 | 1 | 27.00 | 0.975 | 0.729 | 0.722 | 0.726 |
| **adc_chain** | 3 | 4 | 12.64 | 0.909 | 0.393 | 0.395 | 0.399 |
| **adc_chain** | 3 | 64 | 8.17 | 0.775 | **0.097** | 0.099 | 0.118 |
| **adc_chain** | 3 | 256 | 7.98 | 0.759 | 0.069 | 0.069 | 0.095 |
| fixmul64 | 4 | 1 | 23.54 | 0.908 | 0.626 | 0.620 | 0.627 |
| fixmul64 | 4 | 4 | 10.67 | 0.870 | 0.367 | 0.362 | 0.369 |
| fixmul64 | 4 | 64 | 6.47 | 0.854 | 0.119 | **0.094** | 0.132 |
| fixmul64 | 4 | 256 | 6.27 | 0.857 | 0.098 | **0.072** | 0.116 |
| vec4 | 18 | 1 | 8.11 | 0.995 | 0.415 | 0.404 | 0.511 |
| vec4 | 18 | 4 | 6.44 | 0.658 | 0.138 | 0.129 | 0.217 |
| vec4 | 18 | 64 | 5.47 | 0.581 | 0.029 | **0.019** | 0.086 |
| vec4 | 18 | 256 | 5.36 | 0.578 | 0.022 | **0.012** | 0.079 |
| chain16 | 16 | 1 | 9.72 | 0.966 | 0.380 | 0.378 | 0.375 |
| chain16 | 16 | 4 | 8.17 | 0.900 | 0.117 | 0.117 | 0.117 |
| chain16 | 16 | 64 | 7.72 | 0.871 | 0.027 | 0.027 | 0.027 |
| chain16 | 16 | 256 | 7.60 | 0.887 | 0.023 | 0.023 | 0.022 |
| chain32 | 32 | 1 | 9.60 | 0.923 | 0.194 | 0.192 | 0.193 |
| chain32 | 32 | 4 | 8.93 | 0.847 | 0.063 | 0.062 | 0.062 |
| chain32 | 32 | 64 | 8.72 | 0.831 | 0.021 | 0.022 | 0.021 |
| chain32 | 32 | 256 | 8.68 | 0.827 | 0.019 | 0.020 | 0.019 |

Break-even, `tree` vs `directmem`: 1 trip on `dot`, `addr_loop`, `fixmul64`,
`vec4`; 4 on `flag_chain` and `adc_chain`; 64 on `chain16`; **never within 256
trips on `chain32`.** On JSC, wasm globals in a pure-register loop cost the same
as locals.

### Generated size and compile cost

Whole-module figures for all eight shapes, so treat them as a shape comparison,
not as a projection budget — a real decode-time lowering emits its region at
runtime.

| arm | WAT bytes | wasm bytes | project ms | compile ms | instantiate ms |
|---|---:|---:|---:|---:|---:|
| handlers | 33389 | 4161 | 14.7 | 2.06 | 0.06 |
| pairfused | 41889 | 5157 | 4.4 | 0.46 | 0.06 |
| tree | 50536 | 5108 | 4.5 | 3.22 | 0.05 |
| tree_lowered | 47539 | 4797 | 3.2 | 13.55 | 0.05 |
| directmem | 48841 | 5213 | 3.2 | 0.12 | 0.03 |

The tree arm is **23% more wasm** than the handler arm for the same eight
shapes — the handler arm shares one body per opcode across every shape, the tree
arm emits a specialized copy per block. That is the standing trade: code size
scales with the number of *blocks* lowered, not with the size of the opcode set.
`tree_lowered` is smaller than `tree` (SIMD collapses 16 lane ops into four
instructions) but takes 4x longer to compile.

### Checksum equality

`checksums_equal: true` on both engines, at all 32 (shape, trips) points, for
all five arms — including the SIMD and i64 rewrites in `tree_lowered`, which is
the only evidence offered that those rewrites are exact rather than
approximately right.

---

## Calibration against the real emulator

The same fixed-point dot body, hand-encoded as x86 and injected into a live
`build/wine-assembly.wasm` instance the way `tools/bench-loops.js` does, so it
runs through the production decoder, `$next` and the real handlers:

```
real emulator, dot shape          14.76 ns per dispatched guest op
synthetic `handlers` arm, dot      8.66 ns per dispatched guest op
synthetic baseline is 59% of real handler cost
```

**The synthetic baseline is roughly 1.7x optimistic, so every ratio above is
conservative.** The missing 41% is the machinery the synthetic arm does not
model: the block-cache lookup, `$run`'s block loop and budget, and the full
`$g2w` path behind each memory-form handler. A real region replaces that too,
so the true saving on a hot block is larger than the table says, not smaller.

Two caveats that push the other way, and neither is small:

- **The dispatch arms are flattered.** Like `bench-loops.js`, a short periodic
  program lets the branch predictor learn every `call_indirect` target, and the
  mispredict is a real share of `$next` in a live profile
  ([interpreter-dispatch-perf.md](interpreter-dispatch-perf.md)). This
  understates dispatch cost by construction.
- **Nothing here says the shapes occur.** `tools/find-loops.js`,
  `tools/match-loops.js` and `--handler-hist` answer that, and the honest prior
  from [loop-idiom-superops-design.md](loop-idiom-superops-design.md) is that
  only ~2% of static self-loops match today's matcher, with `call` and
  `multi-branch` accounting for 58% of declines. **Never quote a ratio from this
  table as an application speedup** — multiply it by the profile share of the
  blocks a lowering would actually cover.

---

## Verdict

### (a) Tree vs pair-fused — not close, and they are not the same lever

Pair fusion is worth **0-45%** (ratio 0.58-1.00, mostly 0.65-0.93). The tree is
worth **10x-70x** at 64+ trips and still **1.4x-2.5x** at a single trip.

The reason is structural, not a matter of degree. Pair fusion removes one
dispatch in two and *nothing else*: the fused handler still reads its register
roles out of an operand word through `br_table`, still writes the register file
per op, still stores four flag globals per ALU op. It recovers the dispatch half
of one op in two, which is exactly where the numbers land — `adc_chain` at one
trip is **1.000**, i.e. pair fusion bought literally nothing there. Wherever
pair fusion looks good (`vec4` 0.62, `addr_loop` 0.65) the shape is
load/`imul`/add/store, and what is being removed is a dispatch between two ops
that were already going to touch the same register.

The tree removes the *representation*: no operand decode, no register file, no
flag encoding, no intermediates in memory. Doing half of that badly does not get
you halfway.

**A pair-fusion program is not a cheap first step toward regions.** It is a
different, much smaller effect that does not compose with the region work, and
the effort spent enumerating profitable pairs does not carry over.

### (b) Locals vs direct memory — locals are most of the win on V8, and none of it on JSC in the easy case

Splitting the tree's win in two, at 64 trips:

| | dispatch elimination alone (`directmem`) | locals on top (`tree`/`directmem`) |
|---|---|---|
| V8 | 3.3x-7.6x | **2.4x-11.3x more** |
| JSC | 7.6x-12.5x | 1.0x-3.2x more |

On V8 the two factors are comparable and locals are often the bigger one —
`vec4` goes 1.00 -> 0.131 on dispatch and then 0.131 -> 0.018 on locals, a
further 7x. Break-even is 1 trip on every shape: there is no amortization to
wait for, because both arms pay the same entry/exit and the difference is pure
per-op storage cost.

On JSC the split is the other way round, and for pure-register chains it
vanishes: `chain16` and `chain32` are **identical** in `tree` and `directmem` to
three digits (0.021 vs 0.021, 0.019 vs 0.019), with break-even at 64 and beyond
256 respectively. JSC keeps wasm globals in registers across a loop when nothing
else is contending; V8 in these modules does not.

**So "put the intermediates in locals" is a V8-shaped optimization.** It is
still the right default — it is never *worse* on either engine, and on the
memory-touching shapes it is worth 2-3x on JSC too — but the 5-10x figure people
will quote from the V8 column is not a portable number, and a design that
depends on it should say so.

### (c) Better lowering — pays exactly where an idiom exists, and one of the three was already free

Three rewrites, three different answers:

| rewrite | V8 (`tree` -> `tree+`, 64 trips) | JSC | verdict |
|---|---|---|---|
| `imul`+`shrd 16` -> one i64 multiply and shift (`fixmul64`) | 0.075 -> 0.061 (**-19%**) | 0.119 -> 0.094 (**-21%**) | pays |
| 4 lanes -> `i32x4` (`vec4`) | 0.018 -> 0.010 (**-44%**) | 0.029 -> 0.019 (**-34%**) | pays most |
| `imul r,100` -> shifts/adds (`addr_loop`) | 0.035 -> 0.035 | 0.046 -> 0.047 | **zero** |

The constant-multiply strength reduction is a **no-op, and slightly negative on
JSC** — the wasm engine already lowers `i32.mul` by a constant, so re-doing it
in the IR only adds nodes for the engine to fold back. That is the reusable
lesson: *do not re-implement optimizations the wasm backend already performs.*
The two rewrites that pay are both ones the backend **cannot** do, because they
change what the architectural state means — dropping the `edx:eax` split that
`shrd` exists to undo, and proving four lanes independent when they are written
through the same architectural register.

So arm 4 is worth having, but only as a small named set of idiom rewrites, not
as a general "optimize the tree" pass. And it costs: `tree_lowered` compiles 4x
slower than `tree`.

### (d) The adc control — behaves exactly as a barrier should, which is what makes the rest believable

`adc_chain` is the worst tree ratio at every trip count on both engines:

```
at 64 trips, V8:   adc_chain 0.096   everything else 0.018 - 0.075
at 64 trips, JSC:  adc_chain 0.097   everything else 0.021 - 0.119
at 1 trip:         adc_chain 0.728 / 0.729  — the worst on both
```

and pair fusion on it is **1.000 at one trip on V8** — no gain at all.

This is the correct shape of a null result rather than a flat one. The tree
still wins something (~10x at 64 trips) because it drops the operand decode and
the register file, which every arm-3 shape gets for free. What it *cannot* drop
is the flag dataflow: every `adc` consumes CF from the op before it, so the
lazy-flag elimination that carries the other shapes is switched off here, the
three ops stay a serial dependency chain, and there is no tree to build. The gap
between 0.096 and the 0.018 of `chain16` — five times less benefit for a block
of the same arithmetic weight — **is the value of flag laziness, measured.**

That the control moves in the right direction by the right amount, rather than
scoring 1.00 or scoring like everything else, is the reason to trust the rest of
the table.

---

## What this does not answer

- Whether the blocks in real guest code are expression-shaped. See
  `tools/match-loops.js --why`; `call` and `multi-branch` are 58% of declines
  today, and neither is in this benchmark.
- Side exits. Every shape here runs to completion. A region that must
  materialize all live architectural state and fall back to the scalar
  interpreter mid-block pays a cost this bench never charges.
- Partial-register writes (`AL`/`AH`/`AX`), `DIV` traps, and possibly-aliasing
  load/store pairs — the brief lists all three as near-misses and all three are
  barriers we have not priced.
- Chrome. `tools/profile-web-frames.js` drives the app page, not a bare wasm
  module, so there is no trivial path; V8-in-Node is reported instead and JSC is
  the second engine.

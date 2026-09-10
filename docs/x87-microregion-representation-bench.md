# x87 micro-region stack representation shootout

This experiment asks a narrow question: once the decoder has proved a balanced
x87 region, how should that region carry `ST(i)` values around its loop?
It does not modify the emulator.  The reusable generator/runner is
`tools/x87-microregion-bench.js`.

## Arms

| arm | representation |
|---|---|
| `arch` | architectural linear-memory ring, mutable TOP, tag byte checks, and get/set/push/pop helpers |
| `fixed` | eight f64 locals, mutable TOP, and an explicit eight-way dynamic get/set selection |
| `hot4` | logical ST0..ST3 locals, with explicit shifts and linear-memory spill/fill for ST4..ST7 |
| `renamed` | eight named f64 locals; the decoder maintains the logical-to-physical map, so FXCH/push/pop rename values at compile time |
| `tuple` | eight-result multi-value tuple passed through a compact `br_table` micro-op dispatcher |
| `scratch` | fixed linear-memory scratch slots without architectural TOP/tags |
| `fused` | fully stackified straight-line Wasm expression tree, an upper bound rather than a generic representation |

All programs are statically rejected on underflow, overflow, an out-of-range
`ST(i)`, or a non-empty loop backedge.  The architectural arm additionally does
its tag checks at runtime.  Runtime seed and iteration values feed every loop,
and every observable pop, integer result, and status word is accumulated into
an i64 checksum.  Every arm must match the fused checksum before a timing is
reported.  The four workloads are a 16-op Alpha-like algebra island, an 11-op
mixed GPR+x87 loop, a 20-op eight-deep push/pop/FXCH stress, and a 12-op
ordered/equal/greater/NaN status boundary.

The loop backedge is balanced, so locals remain live for the steady-state loop;
architectural entry/exit materialization is intentionally outside the timed
body.  A real region must load live x87 inputs once on entry and commit live
outputs/TOP/tags once on every exit.  These numbers therefore measure the
repeatable inner-region benefit, not the break-even trip count.

## Result

Command, on 2026-09-09:

```sh
X87_ITERS=500000 X87_ROUNDS=9 X87_JSON=/tmp/x87-final.json \
  node tools/x87-microregion-bench.js
```

Each cell is time relative to the architectural helper arm; lower is better.
The harness alternates arm order and reports the median warm round.

| engine / workload | fixed | hot4 | renamed | tuple | scratch | fused |
|---|---:|---:|---:|---:|---:|---:|
| Node/V8 Alpha | 1.486x | 0.042x | **0.037x** | 1.397x | 0.249x | 0.035x |
| Node/V8 mixed | 1.693x | 0.220x | **0.205x** | 2.682x | 0.309x | 0.250x |
| Node/V8 deep | 1.114x | 0.161x | **0.074x** | 1.643x | 0.125x | 0.068x |
| Node/V8 status | 0.534x | **0.047x** | 0.071x | 0.720x | 0.112x | 0.058x |
| Chrome/V8 Alpha | 1.545x | **0.033x** | **0.033x** | 1.623x | 0.262x | 0.036x |
| Chrome/V8 mixed | 4.537x | **0.829x** | 0.854x | 7.878x | 0.878x | 0.854x |
| Chrome/V8 deep | 1.539x | 0.232x | **0.118x** | 2.457x | 0.185x | 0.122x |
| Chrome/V8 status | 0.925x | **0.083x** | 0.095x | 1.119x | 0.158x | 0.095x |
| JSC Alpha | 3.076x | **0.056x** | 0.074x | 2.210x | 0.362x | 0.079x |
| JSC mixed | 1.997x | 0.273x | **0.220x** | 3.260x | 0.320x | 0.171x |
| JSC deep | 1.524x | 0.249x | **0.090x** | 2.117x | 0.290x | 0.072x |
| JSC status | 0.600x | 0.049x | **0.038x** | 0.886x | 0.257x | 0.044x |

Absolute nanoseconds vary with system load and aggressive algebraic
optimization, so the stable conclusion is the within-round ordering.  Named
locals are at or near the stackified ceiling on the shallow algebra workload
in all three engines.  On the deliberately deep workload they beat hot4+spill
by 2.2x in Node, 2.0x in Chrome, and 2.8x in JSC.  This is a spill/shift clue:
restricting the cache to four logical stack positions creates more traffic than
letting the Wasm engine allocate the eight fixed locals itself.  It is not proof
of native-register allocation; an engine disassembly/profile would be needed
to claim that.

The other conclusions are negative but useful:

- A dynamic eight-way local selector is larger and usually slower than the
  architectural control: 17,324 Wasm bytes versus 1,690.
- Passing eight multi-values through a per-op dispatcher does not recover
  dispatch cost.  It is 1.1x to 7.9x of the architectural arm here.
- Scratch memory removes TOP/tag/helper overhead, but still trails named locals.
- The decoder-renamed module is the smallest arm at 1,154 Wasm bytes and is
  close to the 1,432-byte fully stackified upper bound in steady state.

## Recommendation

Prototype a generic, bounded region representation with eight named f64 locals
and a decode-time logical stack map.  `FXCH` changes only that map; pushes and
pops allocate/release a name.  Keep status/control-word operations and every
region side exit as explicit materialization boundaries.  Gate installation on
a balanced stack shape and measure real-region entry/exit amortization before
shipping.  Do not pursue dynamic local selection or the multi-value micro-op
dispatcher based on this experiment.

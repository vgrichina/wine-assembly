# Realistic x87 region representation benchmark

This is the finite-trip follow-up to
`docs/x87-microregion-representation-bench.md`. The first shootout measured the
representation ceiling but gave straight-line locals an effectively infinite
hot loop. `tools/x87-realistic-region-bench.js` adds the costs that decide
whether a real region should be installed.

## What is measured

Five arms execute identical state transitions:

| arm | implementation |
|---|---|
| `handler` | production-shaped micro-PC/`br_table` dispatch, direct TOP/tag state, ring-memory stack, and production-style fpu get/set helpers |
| `dispatch` | compact micro-PC/`br_table` dispatch with eight named f64 locals and opcodes specialized to decode-time physical local IDs |
| `fused` | the same named-local dispatcher, but each balanced four-op semantic motif is one dispatch case |
| `region` | generated straight-line named-local region; decode-time stack renaming makes push/pop/FXCH mapping free inside the region |
| `memory` | generated straight-line control that keeps a local TOP but reads/writes the architectural ring directly |

Each invocation includes conservative entry/exit materialization of all eight
f64 stack slots for the named-local arms. Region lengths are 4, 8, 16 and 32
x87 ops, with trip counts 1, 2, 4, 8, 16, 64 and 256. Eight live GPR-like
locals, lazy-flag state, tags, address calculation, budget, and micro-PC remain
live. Safepoint periods 1, 4, 8, 16, 32 and 64 are separate compiled modules.

The timed call is an internal Wasm wrapper, not thousands of JS-to-Wasm calls.
It repeatedly invokes the finite region so entry/exit is charged once per
region invocation. Runtime seeds vary each invocation. Observable f64 pops,
GPRs, flags, tags, TOP, micro-PC and safepoint state are checksummed, and all
five arms must match exactly before a timing is accepted.

The normalized motifs come from real PE instructions, while deliberately
remaining balanced at the loop backedge:

- Alpha: `terran.exe` at 0x413f55/0x41ff5c plus the measured TQI algebra island;
  normalized H190 load, H188 load, H189 add-pop, H188 store-pop.
- Jazz Jackrabbit 2: `jazz2.exe` at 0x414506 and 0x44b49e; normalized integer
  load, square root, multiply, store-pop.
- Half-Life Uplink: `hldemo.exe` at 0x406bf6 and 0x412d74; normalized load,
  multiply, add, store-pop.

These are real instruction motifs, not runtime-frequency-weighted traces. That
limitation matters when predicting whole-app speed.

## Real production-handler calibration

The tool also boots the full current emulator, writes actual x86 loops into a
loaded PE, and executes the real decoder, `$next`, `$fpu_exec_*`, and
H188/H189/H190. This Node-only calibration is kept separate from the small
cross-engine modules. Handler histograms prove that the loops really execute:

| probe | time/invocation | H188 | H189 | H190 |
|---|---:|---:|---:|---:|
| Alpha L4 × T1 | 0.630 us | 2 | 1 | 1 |
| Alpha L4 × T64 | 15.683 us | 128 | 64 | 64 |
| Alpha L32 × T64 | 108.987 us | 1024 | 512 | 512 |
| Jazz2 L4 × T64 | 17.272 us | 64 | 64 | 128 |
| Half-Life L4 × T64 | 17.485 us | 128 | 0 | 128 |

This validates the production baseline and trace classification. It is not
used as a direct speedup denominator: a tiny standalone candidate module and
the complete emulator have different optimization context. Only an embedded
runtime prototype can measure that final ratio honestly.

## Cross-engine result

Final command (2026-09-09, seven rotated warm rounds):

```sh
NODE_PATH=/path/to/repo/node_modules \
X87_REAL_FIXTURE=/path/to/repo/test/binaries/notepad.exe \
X87_REAL_ROUNDS=7 X87_REAL_JSON=/tmp/x87-realistic-final2.json \
node tools/x87-realistic-region-bench.js
```

The table is the median ratio across all three motifs and four region lengths.
The denominator is the production-shaped handler module; lower is better.

| engine | trips | local dispatcher | fused dispatcher | straight region | direct memory |
|---|---:|---:|---:|---:|---:|
| Node V8 | 1 | 0.974 | 0.396 | 0.362 | 0.325 |
| Node V8 | 4 | 0.922 | 0.327 | 0.265 | 0.267 |
| Node V8 | 64 | 0.920 | 0.300 | 0.227 | 0.257 |
| Node V8 | 256 | 0.918 | 0.293 | 0.222 | 0.246 |
| Chrome V8 | 1 | 0.941 | 0.471 | 0.412 | 0.357 |
| Chrome V8 | 4 | 0.882 | 0.357 | 0.333 | 0.294 |
| Chrome V8 | 64 | 0.857 | 0.294 | 0.286 | 0.286 |
| Chrome V8 | 256 | 0.882 | 0.333 | 0.286 | 0.286 |
| JSC shell | 1 | **1.240** | 0.688 | 0.612 | 0.514 |
| JSC shell | 4 | **1.133** | 0.487 | 0.376 | 0.442 |
| JSC shell | 64 | **1.130** | 0.411 | 0.329 | 0.432 |
| JSC shell | 256 | **1.131** | 0.404 | 0.311 | 0.429 |

The important correction to the first experiment is that a generic
one-x87-op-per-dispatch named-local VM does **not** preserve the renamed-local
win. It saves only about 8-14% in V8 and is 13-24% slower in JSC. Local stack
representation alone does not pay for another unpredictable dispatch layer.

Semantic fusion does preserve a large share of the gain. Even at one trip it
is below the handler baseline in the median, and at 64 trips it costs 0.30x in
Node, 0.29x in Chrome and 0.41x in JSC. It still trails direct memory for short
regions because both pay dispatch while only the local arm pays eight-slot
entry/exit materialization.

For the fully generated region, named locals overtake direct ring memory at a
median of roughly four trips in Node and JSC and eight trips in Chrome. At 64
trips the straight region is 0.227/0.286/0.329 of the handler-shaped baseline.
That is the useful break-even result; “one trip beats handlers” is true but
does not prove locals beat a simpler straight-line memory lowering.

## Safepoints, size, and compilation

A focused Node run with 5,000 Alpha L16 × T64 invocations per sample found the
straight region at 1.039/0.944/0.963/0.895/0.908/1.016 us for K=1/4/8/16/32/64.
K=16 was best in that run; checking every op cost about 16%, while K=8 and K=32
were within 8% and 1% of K=16. Separate-module tiering makes smaller differences
uncertain, so this supports a tunable K near 16 rather than a magic constant.

At K=16, the modules containing 12 functions (three motifs × four lengths) are:

| arm | Wasm bytes | project compile | first engine compile |
|---|---:|---:|---:|
| handler | 18,221 | 9.0 ms | 0.3 ms |
| dispatch | 24,043 | 9.5 ms | 0.7 ms |
| fused | 28,500 | 13.5 ms | 0.5 ms |
| region | 27,726 | 17.4 ms | 0.2 ms |
| memory | 28,206 | 14.8 ms | 0.2 ms |

These are batch-module sizes, not per-region bytes. Compile timings are noisy
first-compilation observations rather than a cache-resistant compile benchmark.

Safari WebDriver was attempted, but `safaridriver --diagnose` did not establish
a session and had to be terminated. The JavaScriptCore shell result is therefore
labelled JSC shell, not Safari.

## Recommendation

Do not build a second generic per-op x87 dispatcher merely to host named locals.
The next production experiment should recognize balanced regions, lower them
straight-line with a decode-time eight-local stack map, and materialize TOP,
tags, status and all live values at every side exit. Require an observed trip
count of at least 4-8 before installing a local-stack region. Where a reusable
semantic motif is proven across binaries, a fused dispatcher is a viable
lower-cost intermediate step. Start with a safepoint interval near 16 and keep
it adjustable.

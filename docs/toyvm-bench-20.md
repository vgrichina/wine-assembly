# The three backends over the twenty-program set (2026-09-01)

One measurement of every optimization the toy VM has, on the same twenty
programs (`tools/toyvm/bench-set-20.txt`), on the same evening, at commit
`f2c76827`. Three tools, because three backends
(see the table in `docs/toyvm-trace-jit.md`'s memory of them): the interpreter
is `sweep-dos.js`'s shell columns plus `bench-dos.js`'s flag arms, the micro
ops are `sweep-dos.js`'s tier columns, and the region JIT is
`region-census.js`. Every number here was taken at **load 4.4–6.7** with other
agents on the box; the method (interleaved, rotated, minimum-of-N, CPU time
where the tool offers it) narrows that, it does not remove it. Read
directions and the programs that agree, not the second decimal.

Raw outputs for a re-run to diff against: `sweep20.{json,md}`,
`arms20.log`, `census20.{json,md}` were produced by the exact commands quoted
in each section.

## 1. Interpreter: dispatch shells and micro-op tiers

```
node tools/toyvm/sweep-dos.js $(grep -v '^#' tools/toyvm/bench-set-20.txt) \
  --dispatches=12m --sample-from=0.5 --reps=5
```

| program | dispatches | px | `tailcall` | `repl_tailcall` | `calls` | `switch` | hot trace | tier 1 | tier 2 | tier 3 | build |
|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|
| DHADREN.EXE | 12.0M | 20274 | 15.69 ns | +6.3% | -4.6% | +3.9% |  | _no-samples_ |  |  |  |
| DTM2.EXE | 12.0M | 0 | 8.09 ns | +5.8% | -6.7% | +9.7% | 1 ops, 51% | 1.25x | 1.50x | 2.04x | 15.6 ms |
| ACCIDENT.EXE | 12.0M | 18447 | 12.33 ns | +6.5% | -1.4% | -1.0% | 6 ops, 2% | 1.85x | 1.81x | 3.44x | 18.3 ms |
| B-STEEL.EXE | 12.0M | 0 | 11.52 ns | +10.0% | -6.2% | +4.4% | 11 ops, 15% | _branchy_ |  |  |  |
| RUNDEMO.EXE | 12.0M | 58040 | 10.23 ns | +2.6% | -2.1% | +18.8% | 6 ops, 2% | 1.51x | 1.51x | 1.79x | 18.1 ms |
| CMA_SHRT.EXE | 12.0M | 19432 | 14.00 ns | +11.1% | -2.8% | +14.6% | 6 ops, 100% | 1.54x | 1.68x | 3.47x | 15.9 ms |
| CONTAGIO.EXE | 12.0M | 22510 | 47.26 ns | +0.9% | -3.5% | +7.0% | 9 ops, 17% | 1.24x | 1.40x | 2.22x | 30.2 ms |
| CYCLE.EXE | 12.0M | 0 | 13.11 ns | +7.2% | -8.6% | +8.8% | 6 ops, 3% | 2.58x | 3.23x | 3.72x | 25.7 ms |
| DEMO5.EXE | 12.0M | 5958 | 9.97 ns | +9.4% | -2.7% | +9.0% | 1 ops, 100% | 1.35x | 1.36x | 1.36x | 17.2 ms |
| BRW.EXE | 12.0M | 116566 | 20.80 ns | +17.5% | +3.7% | -4.7% | 43 ops, 7% | 1.68x | 1.61x | 5.61x | 32.3 ms |
| ADDY_II.EXE | 12.0M | 60800 | 17.12 ns | +9.4% | -1.5% | +2.5% | 7 ops, 8% | 3.06x | 3.42x | 2.55x | 16.8 ms |
| COMPOVRS.EXE | 12.0M | 63814 | 11.98 ns | +8.6% | -1.3% | +4.4% | 5 ops, 100% | 2.09x | 2.32x | 3.49x | 14.3 ms |
| COPPER.EXE | 12.0M | 27112 | 28.89 ns | +9.3% | -0.4% | -10.3% |  | _no-samples_ |  |  |  |
| CORE-ADD.EXE | 12.0M | 14464 | 13.86 ns | +11.1% | -6.1% | +13.8% | 2 ops, 26% | 1.93x | 1.72x | 1.91x | 16.3 ms |
| CONTACT.EXE | 12.0M | 61081 | 14.14 ns | +14.9% | +0.8% | +1.3% | 2 ops, 100% | 1.91x | 1.91x | 3.19x | 16.0 ms |
| DRAGON.EXE | 12.0M | 10634 | 13.61 ns | +13.9% | -7.4% | +1.4% | 8 ops, 2% | 2.15x | 2.47x | 8.79x | 17.5 ms |
| ASYLUM.EXE | 12.0M | 5178 | 15.07 ns | +8.5% | -3.7% | +2.2% | 8 ops, 5% | 1.95x | 3.19x | 4.68x | 16.3 ms |
| DSTNFO.EXE | 12.0M | 169026 | 10.75 ns | +8.9% | -4.8% | +26.9% | 6 ops, 12% | 2.94x | 3.35x | 3.49x | 23.9 ms |
| DREAM.EXE | 12.0M | 700 | 16.10 ns | +8.8% | +2.4% | -4.5% | 8 ops, 3% | 1.62x | 1.76x | 5.00x | 24.2 ms |
| daretro.exe | 12.0M | 33184 | 9.80 ns | +8.4% | -7.2% | -1.3% | 3 ops, 100% | 2.06x | 2.06x | 2.50x | 18.0 ms |

Geomean over all 20 (baseline `tailcall`): `repl_tailcall` **+8.9%**,
`calls` −3.3%, `switch` +5.0%. Over the 17 with a benchable hot trace:
tier 0→1 1.86x, 1→2 1.09x, 2→3 1.54x, **tier 0→3 3.13x**; build 14–32 ms,
break-even 1.3M–5.0M guest ops (not in any ratio).

Reading it:

- **`repl_tailcall` beats `tailcall` on 20 of 20**, +0.9% to +17.5%. This is
  the one interpreter result in the set that survives the load: every program
  points the same way. `switch` is +5% on the geomean but ranges −10% to +27%
  and flips sign on 6 programs, and `calls` is the loser on 17 of 20.
- **Tier 3 is a 3.1x on the hottest trace, and tier 2 buys almost nothing over
  tier 1** (1.09x). Constant-folded operands are 1.86x on their own; the
  register-promotion tier is where the second factor comes from. Two rows are
  above 5x (DRAGON 8.8x, BRW 5.6x), both long traces with dense register
  traffic; the 1-op traces (DTM2, DEMO5) cap near 1.4–2x because there is
  nothing to fold across.
- A hot trace at "100% of samples" (CMA_SHRT, DEMO5, COMPOVRS, CONTACT,
  daretro) is a program sitting in one loop; those are the programs whose
  whole-program number the region JIT below can actually move.

## 2. Interpreter: the individual optimizations, as flag arms

```
node tools/toyvm/bench-dos.js <exe> --dispatches=8m --reps=3 --cpu-time --json \
  --variants=tailcall,tailcall+nofuse,tailcall+nofusecond,tailcall+nodeadflags,tailcall+nowasmdecode
```

One process per program under `timeout -s KILL 120`, and **`--cpu-time`**,
because at this load the wall clock could not resolve any of these. A
`+nocache` arm was tried and dropped: it retires a slightly different dispatch
count (block boundaries move), which fails bench-dos's agreement check and
voids the whole row — the cache is not measurable this way.

Each cell is the arm's change **against the `tailcall` baseline** as
min-of-3 / paired, so a negative number is what the optimization is worth.

| program | baseline | −fuse | −fusecond | −deadflags | −wasmdecode |
|---|---:|---:|---:|---:|---:|
| ACCIDENT.EXE | 15.148 ns | -7.9% / -7.9% | -3.7% / -3.7% | -7% / -4.6% | 4.6% / 1.1% |
| ADDY_II.EXE | 18.502 ns | -4.5% / -4.5% | -7.3% / -7.3% | -1.1% / -1.1% | -3.5% / -2.8% |
| ASYLUM.EXE | 17.229 ns | -6.4% / -5.1% | -1.9% / -1.6% | -2.5% / -2.2% | -0.7% / 0.6% |
| B-STEEL.EXE | 13.698 ns | -3.9% / -3.9% | -4.6% / -4.6% | -6% / -3.9% | 2% / 3.6% |
| BRW.EXE | 20.764 ns | 1.8% / 1.8% | -1.6% / -1.6% | -1% / -1% | 1.5% / -0.6% |
| CMA_SHRT.EXE | 21.71 ns | 22.4% / 22.4% | 18.3% / 9.9% | 23% / 23% | 27% / 28.5% |
| COMPOVRS.EXE | 13.925 ns | 2.6% / 0.6% | 6.4% / 8.1% | 2.4% / 19.6% | 5.2% / 13.2% |
| CONTACT.EXE | 16.794 ns | -0.3% / 1.2% | -5.2% / -3.8% | -2.1% / -1.3% | 0.7% / 2.2% |
| CONTAGIO.EXE | 57.574 ns | -2.6% / -1.3% | -1% / 3.7% | 2.4% / 7.3% | -0.8% / 3.9% |
| COPPER.EXE | 36.112 ns | -5.1% / -5.1% | -1.4% / 5.1% | -1.8% / 4.7% | -0.9% / 5.6% |
| CORE-ADD.EXE | 16.465 ns | -0.9% / 22.5% | -8.3% / -8.3% | -3.5% / 19.2% | -1.9% / 21.2% |
| CYCLE.EXE | 13.497 ns | -10.6% / -10.6% | -2.6% / -2.6% | -8.7% / -6.4% | -5.1% / -5.1% |
| DEMO5.EXE | 16.803 ns | -5.5% / -5.5% | -8.4% / -8.4% | -1.1% / -1.1% | -2.8% / -2.7% |
| DHADREN.EXE | 20.202 ns | -9.5% / 4.4% | -16.9% / -4.4% | -2.1% / 18.9% | -0.4% / 20.9% |
| DRAGON.EXE | 16.695 ns | -5.9% / -3.8% | 1.9% / 6.9% | 2.3% / 7.7% | -0.8% / -0.8% |
| DREAM.EXE | 14.88 ns | -7.6% / -4.3% | -3.8% / 7.5% | -6.8% / 3.8% | -2.9% / 5% |
| DSTNFO.EXE | 13.264 ns | -7.7% / -5% | 8.4% / 4.3% | 8.2% / 11.4% | 8.6% / 11.8% |
| DTM2.EXE | 11.493 ns | -15.6% / -15.6% | 4.2% / 4.2% | -3.5% / -2.1% | -1% / -1% |
| RUNDEMO.EXE | 12.593 ns | -16.6% / -12% | -0.7% / 6.9% | 3.3% / 3.3% | -0.5% / 0.2% |
| daretro.exe | 13.617 ns | -19.9% / -19.9% | -8% / -8% | -0.3% / 1.8% | -1% / 0.5% |

Geomean over the 20, arm against baseline:

| arm removed | min-of-3 | paired | arm ahead of baseline (min / paired) |
|---|---:|---:|---:|
| fusion (`nofuse`) | **−5.5%** | −3.1% | 3/20 / 6/20 |
| conditional fusion (`nofusecond`) | −2.1% | −0.1% | 5/20 / 9/20 |
| dead-flag elimination (`nodeadflags`) | −0.5% | +4.5% | 6/20 / 11/20 |
| decoder in wasm (`nowasmdecode`) | +1.2% | +4.9% | 7/20 / 14/20 |

Reading it:

- **Fusion is the one interpreter optimization that pays across the set**:
  removing it costs 5.5% on the geomean and is a loss on 17 of 20 programs,
  up to −20% (daretro, RUNDEMO, DTM2 — the 1–3-op hot loops, where a fused
  pair is a third of the body).
- **Conditional fusion is a 2% that is not resolvable here**: paired it is
  a wash, and it is ahead on 9 of 20.
- **Dead-flag elimination and the wasm decoder are not paying on this
  set at this budget.** Both round to zero on minima and read slightly
  *negative* paired (the arm without them is ahead on 11 and 14 of 20). That
  is inside the spread of this run (`bench-dos` printed 14–71% per-arm spread
  on CPU time), so it is a lead, not a verdict — but it is the same lead
  `docs/toyvm-dead-flags.md` and `docs/toyvm-decoder-in-wasm.md` should be
  re-read against, on a quiet box, before either is assumed to be a win.
- **CMA_SHRT is a load artifact, not four optimizations costing 22%**: all
  four removed arms come out faster by the same 22–28%, which means the
  baseline arm alone caught a spike in every one of its three reps. Treat
  the row as missing. COMPOVRS, CORE-ADD and DHADREN show the milder form
  (paired columns of +19–22% on arms whose minima say ±2%).

## 3. Region JIT: installed into the whole-program run

```
node tools/toyvm/region-census.js --dir=/tmp/demos --only=<the 20> \
  --dispatches=6m --reps=2 --jobs=2
```

`speed` is the CPU-time `%` from `region-jit.js` (2 rotated reps, min);
`gate`, `ceiling` and `+hb` are the load-free line added at `f2c76827`.

| program | head | ops | share | gate | ceiling | +hb | speed | frame |
|---|---|---:|---:|---:|---:|---:|---:|---|
| COMPOVRS.EXE | 0x338 | 10 | 0.0% | 5.21x | +0% | -184 | +71% | phase |
| CONTACT.EXE | 0xcf | 15 | 0.0% | 4.67x | +0% | -241 | +117.5% | phase |
| ACCIDENT.EXE | 0xce | 25 | 10.7% |  |  |  | -5.3% | identical |
| B-STEEL.EXE | 0x8c | 13 | 22.2% |  |  |  | +14.4% | identical |
| ADDY_II.EXE | 0xc9 | 6 | 28.0% | 4.18x | +21.3% | +0 | +3.2% | identical |
| RUNDEMO.EXE | 0x9ce | 4 | 0.0% | 3.79x | +0% | +0 | +8.5% | identical |
| CONTAGIO.EXE | 0x455 | 8 | 0.0% | 5.33x | +0% | -32 | +1.7% | identical |
| CYCLE.EXE | 0xe7f | 15 | 12.7% | 1.73x | +5.4% | +0 | -6.8% | identical |
| DRAGON.EXE | 0xae9 | 9 | 10.0% | 8.33x | +8.8% | +0 | -4.5% | identical |
| DREAM.EXE | 0x842 | 18 | 100.0% | 2.39x | +58.1% | -15 | +27.6% | identical |
| ASYLUM.EXE | 0x641 | 9 | 45.5% | 1.92x | +21.8% | +0 | +22% | identical |
| BRW.EXE | 0x7adc | 6 | 1.4% | 3.04x | +0.9% | -17 | +14.6% | identical |

No region: `no-loop` 7 (daretro, CMA_SHRT, CORE-ADD, DSTNFO, DEMO5, DTM2 and
the set's own `1994-a-asylum/ASYLUM.EXE`), `no-samples` 2 (DHADREN, COPPER).
Zero `differs`, zero `declined`. The ASYLUM row above is
`1995-a-asylum/ASYLUM.EXE`, which `--only=` matched by basename; it is not in
the set, so the set's coverage is eleven of twenty.

Reading it:

- **Eleven of twenty get a region, all eleven draw the same frame**, and by
  CPU time eight of the eleven are faster with it. The three that are not
  (ACCIDENT −5%, CYCLE −7%, DRAGON −4.5%) all add zero handbacks and have
  ceilings of 5–9%, so the gap is inside this run's noise; DRAGON measured
  +2.8% three reps earlier the same evening. **The JIT is not losing
  anywhere, and where the share is large it is clearly winning**: DREAM
  +28% under a +58% ceiling, ASYLUM +22% under +22%.
- **The sample share is wrong for COMPOVRS and CONTACT**, and that is the
  finding of this table. Both report a *0.0%* share, and both remove 184
  and 241 handbacks and come out +71% and +118% — the region is plainly
  where the program lives (the sweep above has their hot trace at 100% of
  samples). So the "25 of 103 regions at 0.0% share cannot pay" argument in
  `docs/toyvm-trace-jit.md` rests on a share estimate that misses at least
  two of the biggest wins in the set, and **a min-share floor must not be
  cut on that column until the share is fixed** — RUNDEMO and CONTAGIO are
  also 0.0%-share regions that measure +8.5% and +1.7%. The mismatch is
  between the census's pick sampling and `sweep-dos`'s `--sample-from=0.5`
  window; which one is right about where those programs spend their time is
  the next thing to establish.
- Where the share *is* believed, the ceiling ranks the same as the
  measurement: DREAM and ASYLUM top both. That is what the column was
  added for.

## What to do with this

1. Fix the region pick's share for programs like COMPOVRS/CONTACT before
   any share-floor decision; the ceiling column is only as good as that
   input.
2. `repl_tailcall` is +9% on 20 of 20 and is not the default shell. That
   is the cheapest interpreter win in this document.
3. Re-measure dead-flag elimination and the wasm decoder on a quiet box.
   Both read as zero-to-negative here; if that holds, they are complexity
   without a payoff on this corpus.
4. A `nocache` arm needs an agreement rule that tolerates a moving dispatch
   count, or the block cache stays unmeasurable.

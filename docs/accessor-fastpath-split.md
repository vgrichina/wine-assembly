# Splitting the guest-memory accessors so V8 inlines their fast paths — a null

Measured 2026-08-31 on branch `worktree-agent-aefd5647b019c4c9d`
(`a9131389`). **Verdict: the shape change does exactly what it was designed to
do and buys 0% throughput. Do not land it for performance.** The interesting
part is what it rules out.

## The hypothesis

`$g2w` (2708 static call sites), `$gs32` (2558) and `$gl32` (2237) were each a
3-6 op fast path fused to a long cold tier — `$g2w`'s ends in a scan over the
sparse VirtualAlloc table. V8's wasm inliner prices the *whole* callee against a
growth budget (`--wasm-inlining-factor=3`, floor `--wasm-inlining-min-budget=50`),
so a caller that only ever needs the three-instruction fast path pays a call
instead. Raising the floor to 600 was measured at ~8% user CPU
([memory: V8 wasm inlining budget](../CLAUDE.md)), and no browser accepts the
flag — so the portable form is to make the fast path its own tiny function.

Done in `src/03-registers.wat`: each accessor is now a wrapper (fast-path test
plus result) over a `$NAME_slow` callee that only a miss reaches.

## The mechanism landed

`node --trace-wasm-inlining`, Heroes II demo, 40000 batches, counting the
verdict at every candidate site:

| callee | before: size / inlined / denied | after: size / inlined / denied |
|---|---|---|
| `$g2w`  | 360 B — 9 sites / 18 denied  | **35 B** — 55 / 12 |
| `$gl32` | 104 B — 18 / 42              | **37 B** — 51 / 9  |
| `$gs32` | 117 B — 5 / 55               | **48 B** — 39 / 22 |

Weighted by V8's own call counts on the split build, `$g2w` is inlined at sites
carrying 2.42M calls against 0.66M denied — the reverse of before.

## And bought nothing

Fixed work, interleaved A/B, user CPU (wall clock is inadmissible on this box —
it sat at load 5-17 throughout). All reps, not just medians:

| workload | base | split |
|---|---|---|
| Caesar III demo, 40000 batches | 92.06, 70.58, 70.89 (med **70.89**) | 70.07, 72.70, 70.75 (med **70.75**) |
| Heroes II demo, 300000 batches | 34.01, 36.33, 33.50, 34.83 (med **34.42**) | 33.60, 33.80, 35.07, 36.06 (med **34.44**) |
| Heroes II, paired inside the thermometer rounds | 45.03 / 53.60 / 49.49 | 45.40 / 54.67 / 49.61 |

The paired rounds are the cleanest read: same round, same load, split is +0.8%,
+2.0%, +0.2% — flat to a hair slower. Startup (sol, 2000 batches, 5 reps) is
flat as well: base median 1.62s, split 1.62s, so this is not the wasm-opt
failure mode (that one tripled lazy-compile time).

`tools/bench-loops.js` cannot arbitrate this: it only ever loads
`build/wine-assembly.wasm`, so two artifacts cannot be interleaved inside one
process and its ±1% floor does not apply. Run as separate processes over three
alternating rounds the per-round deltas were -4.5%, +9.8%, -25% on `lut` — load,
not signal.

## The thermometer did not collapse — and that is the finding

If the split had captured the budget's win, `--wasm-inlining-min-budget=600`
would stop helping the split build. It still helps, as much as ever
(same-round ratios):

| round | base stock → flag | split stock → flag |
|---|---|---|
| 1 | 45.03 → 41.22 (-8.5%) | 45.40 → 40.18 (-11.5%) |
| 2 | 53.60 → 46.47 (-13.3%) | 54.67 → 43.20 (-21.0%) |
| 3 | 49.49 → 45.47 (-8.1%) | 49.61 → 40.31 (-18.7%) |

So the ~8-13% the flag is worth **is not the memory accessors**. With the
accessors inlined, the calls the budget still refuses, weighted by call count
(`node tmp/inline-denied-top.js`, split build, stock V8):

| callee | size | calls at denied sites | calls at inlined sites |
|---|---|---|---|
| `$next` | 106 B | 3,154,969 | 58,067 |
| `$get_reg` | 69 B | 1,619,273 | 740,426 |
| `$set_reg` | 85 B | 1,324,740 | **0** |
| `$invalidate_code_write` | 43 B | 828,446 | 573,540 |
| `$branch_end` | 100 B | 388,936 | 38,308 |
| `$jcc_end` | 80 B | 147,272 | 0 |

`$next` at 98% denied and `$set_reg` at 100% denied are the whole remaining
prize. That is a register/dispatch-shape problem, not a memory-translation one,
and it is where the next attempt at this lever should go.

## What to do with the branch

The split is behaviour-preserving (sol and notepad captures pixel-identical;
`test-x86-ops`, `test-mem-utils-dib-g2w`, `test-thread-manager`,
`test-wat-memory-map`, `test-gdi-p0-p1`, the four sparse/boundary suites,
`test-copy32-bounded-run` and `test-aoe2-span-prefix` all pass) and it makes the
hot path readable, so it is safe to take on style grounds. It is not a
performance change and must not be quoted as one.

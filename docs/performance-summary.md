# Performance: the consolidated ledger

Every performance effort on this interpreter, what it measured, and its verdict.
Read this first; the linked docs carry the detail and the raw numbers.

ASCII TLDR:

```text
                                                                     verdict
  WON  ------------------------------------------------------------------------
  RCT $invalidate_page: stop sweeping a page per store             5.4x  <-- mem
  $th_rect_run: fold Caesar's tile blit row                        +12%  <-- mem
  H424 $th_rle_run: fold Caesar's RLE sprite row           +7% b/s +21% API/s
  LUT_RUN (Heroes II 0x4c755d)                          -2.7% dispatches, ~0 time

  ZERO -------------------------------------------------------------------------
  return_call_indirect in $next                                       0.0%
  $next fast path 4 branches -> 1                                     0.0%
  CASE_CHAIN (H423)             -11.9% dispatches, -24% block entries  <=2%
  Page compilation      -30M hash lookups, 100% index hit, 0 evict     0.0%
  $g2w hot/cold split        7 inlined/8 denied -> 21 inlined/0 denied 0.0%
  Broad SIB fusion (AoE)                       op count DOWN, time UP  LOSS
  Store sinking out of self-loops   1.6% of self-loops promotable    DECLINED

  THE LAW ----------------------------------------------------------------------
  Dispatch-count reductions with the guest's work unchanged measure ~0.
  Memory-path reductions win, and win big.
  Op count is a proof of EQUAL WORK, never a proof of SPEED.
```

## 1. The cost model, as measured

| quantity | value | how |
|---|---|---|
| one handler dispatch | **~8 ns** | `tools/bench-loops.js nop_chain` |
| one block transfer, on top of the dispatch | **~9 ns** | `nop_chain` vs `jmp_chain` pair |
| instructions per dispatch, real EXEs | **56–74 arm64** | SpiderMonkey Ion disassembly, 11 apps |
| of which ceremony (frame + call SP adj, stack/interrupt checks, global addressing) | **36–45%** | same |
| `$next` itself | **193 instructions** | same |
| cycles per dispatch vs instructions | ~190 cy for ~64 instr | **the machine is stalled, not instruction-limited** |
| guest store via `$gs32` vs `memory.copy` | **400–650x slower** | `store_stream` vs `rep_movsd` |

The stall has a name: the `call_indirect` target is produced by a chain of four-plus
dependent loads (table bounds → table base → 16-byte entry → instance ptr → code ptr
→ **signature word loaded from the callee's own code**) ending in `br x8`. That is why
the mispredict hurts — the true target resolves very late, so a wrong guess is caught
late. Ion, not TurboFan, so treat it as structural evidence, not as V8 timings.

Cross-check on the two primitives: 3.5 entries × 9.3 ns + 7 dispatches × 9.4 ns
= 98 ns predicted vs 98.2 ns measured.

## 2. What won, and the one thing they have in common

| change | measured | where |
|---|---|---|
| RollerCoaster Tycoon `$invalidate_page` | **5.4x**, with a bit-identical dispatch count | `aoe-performance-optimization.md` |
| `$th_rect_run` (H422) — Caesar tile blit | **+12% end-to-end** | `loop-idiom-superops-design.md` |
| `$th_rle_run` (H424) — Caesar RLE sprite row | **+7% batches/s, +21% API/s**; 934,297 → 305,604 block entries | `loop-idiom-superops-design.md` |
| LUT_RUN (A1) — Heroes II `0x4c755d` | −2.70% of all dispatches, pixel-identical; time ~0 | ibid §10.1 |

Every winner removed **memory work the guest asked for**, or removed a per-store
host-side tax. None of them won by making a dispatch cheaper. The RCT case is the
cleanest proof available: the dispatch count did not change by a single op and the
app ran 5.4x faster.

The LUT_RUN row is the counterexample worth keeping in view: it removed dispatches
*and* round trips, correctly and for free, and moved the clock ~0. Its own §10.1
explains why — average run length 3.7 bytes, so the loop is called constantly and
does almost nothing each call.

## 3. What measured zero, and why that is a settled result

Four independent attempts, four zeros, on four different mechanisms:

1. **`return_call_indirect` in `$next`** and **4 dispatch branches → 1** — 22
   interleaved samples each, identical 518,446,380 handler ops across all three
   builds, minima within 2.5%. Not frame push/pop, not branch count.
2. **CASE_CHAIN (H423)** — removed 11.9% of all dispatches and 24% of all block
   entries on Caesar gameplay. Nine interleaved pairs: ≤2%, sign flipping in three
   of nine.
3. **Page compilation** — removed ~30M hash lookups, hit its index 100%, halved
   decodes, eliminated eviction entirely. Flat at **all three V8 wasm tiers**
   (default, `--liftoff-only`, `--no-liftoff`), so the tier is not a hidden variable.
4. **`$g2w` hot/cold split** — real and worth keeping (32 wire bytes, inlines at 21
   sites with 0 denials, up from 7/8; the blocker was `--wasm-inlining-factor=3`, not
   the 500-byte cap). Throughput: a null on 100000 fixed Heroes II batches, five
   interleaved reps, 7.80 → 7.75 s with fully overlapping ranges. Guest execution
   byte-identical either way.

And one anti-result from AoE: **broad SIB fusion cut op count and raised wall time**,
because the fused handler was bigger and slower than the two it replaced.

## 4. Three rules these efforts paid for

**4.1 Op count is not time.** A dispatch-count delta proves equal work. It says
nothing about speed, and can point the wrong way. Every fusion needs *both* an
op-count delta and a time measurement.

**4.2 Pacing has two meters.** `$steps` is a per-block 1000-op quantum; `$block_budget`
is the actual batch meter, spent once per block transfer. A super-op that swallows
k block ends must charge both, or a fixed-batch capture lands at a later moment in
the game and reads as a pixel bug. This cost the first CASE_CHAIN build a 3.08%
pixel diff and a 2.8% API-count skew. **420/421/422 still charge only `$steps`.**

**4.3 Never quote a microbench % as an app %.** Multiply it by the profile share of
the machinery it exercises. This is what resolved the CASE_CHAIN contradiction:

```
  block entries   0.205 x  8.0%  =  1.6%
  dispatches      0.127 x 18.4%  =  2.3%
  predicted app-level win           ~2-4%
  measured on the app                2.1%
```

## 5. Measurement discipline

* **Minima, not means. Interleave arms. Rotate order within a round. Run a null
  control.** This box regularly sits at load 4–40 with other agent sessions; base-arm
  spread alone is ±25% there.
* **Fix the duration, compare how far each arm got** — `--max-seconds=N` with a huge
  `--max-batches`. Cost per batch is not constant within a run (Caesar is ~0.1 ms/batch
  through boot and several times that once a city simulates), so a batch count chosen
  to land near a target duration is per-app guesswork that goes stale.
* **`tools/bench-loops.js` earns its ±1% floor only by alternating two arms in ONE
  process.** It does **not** transfer to build-vs-build. Measured at load 5–8, one
  unchanged build spanned **168.2–241.5 ms on `lut` across three runs — a 44% spread
  against itself**, while the two builds under test were indistinguishable. Read alone,
  the first run of the second build looked like a 26% win on all four shapes; the very
  next run of that same binary was the slowest of the set. Point build-vs-build
  questions at `--toggle` (a flag on one binary) or at whole-app fixed-work runs.
* **A flag beats two builds.** `--no-case-chain`, `--loop-superops`, `--no-rle-run`
  all exist so the A/B is one binary.
* Never take fps or latency numbers from headless Chrome; see `lib/perf-hud.js` and
  `tools/profile-web-frames.js --headful`.

## 6. Open levers, ranked by what the cycle math says

190 cycles for ~64 instructions means stalled, not instruction-limited. So:
**(a) remove dispatches that carry real work, (b) shorten the dependency chain,
(c) instruction count last.** Anything that only shaves the tempting 36–45% ceremony
is landing on the axis that is not binding.

1. **Replicated dispatch sites.** All 426 handlers funnel through *one*
   `return_call_indirect` (`src/04-cache.wat:658`). One branch site = one predictor
   entry set shared by 426 targets, so the predictor cannot learn
   "`$th_cmp_r_i32` is usually followed by `$th_jcc_nz`". Inlining the dispatch tail
   into the top-10 handlers gives each its own site and its own history. **This is not
   what the recorded negative covered** — that experiment left the single-site
   structure intact.
2. **Type the handler table.** `(table $handlers 426 funcref)` is untyped, which is why
   the engine emits the signature check whose load is the *last* link in the dependency
   chain. `(ref null $handler_t)` makes it static. Probed: V8 (node 23 / Chrome 151)
   **yes**, JSC (Safari 26.4) **no** — but Safari is already conditional on
   `return_call`. Cost: `lib/compile-wat.js` hardcodes the `0x70` funcref byte at two
   sites (677, 1189).
3. **Handler-pair fusion, work list already collected.** `--handler-hist` builds a pair
   matrix. Top Caesar pairs: `H149→H21` 6.13%, `H345→H149` 6.05%, `H21→H345` 5.65%.
   93% of all SIB effective addresses in that workload are one form
   (`[edi+edx*1+disp]` feeding `store32`) — the argument for a narrow fusion over the
   broad one AoE rejected.
4. **Global traffic in `$next`.** Each global access is 2 instructions (large instance
   offsets). Per dispatch `$next` touches `$steps` (r+w), `$ip` (r+w) and
   `$handler_hist_enabled` — the last is a load on **every dispatch in production for a
   debug-only feature**, and could ride on `$dbg_any`, already read at block ends.
5. **Register-specialised handlers.** `$get_reg` (`src/03-registers.wat:10`) `br_table`s
   to one of eight `global.get`s — a second indirect *plus* a 2-instruction global
   access per register read. `$th_load32_ro_base_ebp` is the pattern already in tree.
   Remaining `set_reg` sources: `H344`/`H345` 52.0M dispatches, `H154` 17.2M, and the
   16-bit cluster (`H166`/`H165`/`H206`/`H210`/`H193`, ~51M).
   A memory-backed register file is the *other* framing and is probably negative:
   12,734 direct `global.get/set $eax..$edi` sites vs 328 indirect ones, and AoE's
   `br_table register helpers` row already lost at +0.6%. Any such file must be
   per-thread partitioned — workers are separate instances over one shared memory.

Declined with a measurement, not an opinion:

* **Store sinking out of self-loops.** Single-block promotable is **134 of 8142
  self-loops across 8 apps (1.6%)**, and 25.2% of Heroes' self-loop *entries* — nearly
  all of it one block, `0x4c755d`, already lowered as LUT_RUN. The remainder is ~3.5%
  of self-loop entries ≈ **0.36% of all block dispatches**. Inside noise. No WAT written.
* **Design B as specified.** §4.1's `call_indirect body[k]` assumes handlers return;
  every handler ends in `return_call $next`.

## 7. Where the detail lives

| doc | what it holds |
|---|---|
| [interpreter-dispatch-perf.md](interpreter-dispatch-perf.md) | the two rejected generic changes, the 512-wide histogram, remaining levers, the four failed timing attempts |
| [loop-idiom-superops-design.md](loop-idiom-superops-design.md) | Design A/B, the shape library, the corpus census, LUT_RUN/COPY_RUN/RLE_RUN results |
| [page-compile-design.md](page-compile-design.md) | address-ordered storage, the parallel index, the §10 verdict, CASE_CHAIN §13–14 |
| [loop-microbench-harness.md](loop-microbench-harness.md) | `tools/bench-loops.js`: shapes, calibration, the ±1% floor and its boundary |
| [aoe-performance-optimization.md](aoe-performance-optimization.md) | the older experiment table, branch/flag-liveness probes, external references |
| [tracing-performance.md](tracing-performance.md) | what each debug flag costs in the hot loop |
| [re-notes/](re-notes/README.md) | per-binary hot bodies and the commands that reach them |

Tools: `tools/bench-loops.js` (synthetic loops), `tools/match-loops.js` (what the
matcher would lower, `--why` for the decline histogram), `tools/find-loops.js`
(candidate finder, over-counts), `tools/find-rle-nests.js`, `tools/cache-slots.js`,
`tools/caller_census.js`, `test/run.js --handler-hist --hot-block-dump=`,
`--decode-stats`, `--max-seconds=`.

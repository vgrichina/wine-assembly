# Interpreter Dispatch: What Has Actually Been Measured

ASCII TLDR:

```text
$next costs ~23% of a Caesar III gameplay profile. Two generic attempts to make
a dispatch CHEAPER both measured exactly zero:
  - return_call_indirect (constant-stack chains)
  - fast path cut from 4 branches to 1
Identical 518,446,380 handler ops across all three builds, so the A/B was exact.
The cost is the mispredicted call_indirect target itself. You cannot make a
dispatch cheaper -- only make FEWER of them.

BUT: "fewer dispatches" is not automatically "faster". The AoE notes already
measured broad SIB fusion as a net LOSS -- op count fell, wall time rose,
because the fused handler was bigger and slower than the two it replaced.
So handler-op count is a proof of EQUAL WORK, not a proof of SPEED.
Every fusion needs both: an op-count delta AND a time measurement.
```

Companion docs: [wasm-stack-threaded-code.md](wasm-stack-threaded-code.md) (the
proposal this constrains), [aoe-performance-optimization.md](aoe-performance-optimization.md)
(the older experiment table), [wasm-engine-support.md](wasm-engine-support.md)
(which engines have the instructions these ideas need).

## The two rejected generic changes

Measured 2026-08-23 in throwaway worktrees at `0fab7b7d`, preserved on branches
`perf/next-tailcall-dispatch` and `perf/next-fastpath-branches`.

| variant | what changed | n | min | p25 | median | max |
|---|---|---|---|---|---|---|
| base | — | 22 | 4.00 | 5.09 | 6.32 | 8.88 |
| tailcall | `return_call_indirect` in `$next` | 22 | 3.90 | 5.06 | 5.59 | 8.56 |
| nextcheck | 4 dispatch branches → 1 | 22 | 3.99 | 5.12 | 5.48 | 8.83 |

CPU seconds, interleaved samples, Caesar III gameplay. Minima within 2.5% of
each other against a per-variant noise band of 4.0–8.9s; the box ran at load
5–45 throughout, which is why the bands are that wide and why only the minima
are quoted. **No measurable win for either.**

1. **`return_call_indirect`.** Handlers already end in `return_call $next`, so
   chains were assumed to be pushing frames. They are not: a chain is one x86
   basic block, and `$steps = 1000` (`src/13-exports.wat:179`) is a backstop,
   not a typical depth. Needed opcode `0x13` added to `lib/compile-wat.js`,
   which already had `return_call` `0x12` plus a `call;return` fallback.
2. **Fast path 4 branches → 1.** The `fn >= 400` guard moved to `$te` at emit
   time, and the `handler_hist_enabled` check merged into the `$steps` test via
   a `$next_slow` path. Removing two of four branches changed nothing.

Caveat on the second one, if it is ever revived: dropping the runtime `fn>=400`
guard means post-emit thread-cache corruption traps instead of clearing the
cache. Two paths can still reach that state — `$run`'s unconditional arena reset
under a nested pump (`src/09c3-controls.wat:14964`, `src/09c9-winhelp-ui.wat:2186`),
and `$te`'s non-recycling overflow backstop writing into the next thread's arena.

**Conclusion: it is neither frame push/pop nor branch count. It is the indirect
call — a `call_indirect` target that changes every op and mispredicts.**

## The trap: op count is not time

This is the most important thing on this page, and it was learned twice.

`--handler-hist-thread=N` gives a **load-independent** count of handler
dispatches. That makes it the right primary metric on a busy box, and it is what
proves two builds did the *same work* — the three variants above all ran exactly
518,446,380 ops, which is why a 2.5% timing spread could be called noise with
confidence.

But it does **not** measure speed. From the AoE experiment table:

> Revert broad SIB fused handlers. They reduced handler dispatch count, but
> larger/slower handlers lost more time than dispatch removal saved.

and

> Revert `br_table` register helpers. WASM still needs nested block labels for
> `br_table`, and this workload was slower in Chrome. (+0.6%)

So a fusion that cuts op count by 5% can still be a regression. The fused
handler must stay *small* — a fusion that adds branches to cover operand shapes
can easily cost more than the dispatch it removed. Narrow, single-shape fusions
are the ones worth having; "broad" fusions have already lost once.

**Required evidence to keep a fusion:** (a) op-count delta from
`--handler-hist-thread=0`, (b) pixel identity via `tools/png-diff.js`, and
(c) a timing measurement on a quiet box. (a) and (b) alone are not enough.

### The workload — and why "run caesar3" is not it

Every number on this page comes from **one** command, the drive-into-the-city
sequence `test/test-caesar3-gameplay.js` runs, with the histogram armed:

```sh
node test/run.js --app=caesar3_demo --screen=800x600 --batch-size=50000 \
  --max-batches=3400 --repaint-every=50 --handler-hist-thread=0 \
  --input='700:mousemove:400:300,760:mousedown:400:300,800:mouseup:400:300,1000:mousemove:400:172,1040:mousedown:400:172,1080:mouseup:400:172,1500:mousemove:548:320,1540:mousedown:548:320,1580:mouseup:548:320,2600:mousemove:613:502,2640:mousedown:613:502,2680:mouseup:613:502' \
  --png=out.png
```

Writing this down is not bookkeeping. `--app=caesar3_demo --max-batches=3400`
*without* the input script looks like the same experiment and is not: the game
sits on its title screen and dispatches **16,664,328** ops against the gameplay
run's ~509M, a 31x difference, and it makes 289 API calls against 23,704. A
fusion aimed at the blitters would measure as nearly nothing there. Four separate
agents were nearly sent down that path by a baseline command quoted without its
input script; the command belongs next to the numbers it produced.

The clicks must be `mousedown`, a gap of batches, `mouseup` — Caesar samples the
button once per frame, so `run.js`'s `click` (both events in one batch) is
invisible to it. `--screen=800x600` matches the DirectDraw exclusive mode so
cursor coordinates need no scaling.

### The 361 cap: fusions flatter themselves 2x

**Fixed 2026-08-23.** `$HANDLER_HIST_COUNT` is now **512**, the matrix is 1MB at
`0x04000000` (the unused gap under `THREAD_CACHE_BASE` — *not* `0x08000000`,
which is `$VIRTUAL_BACKING_BASE`, which is in turn why `tools/wat-memory-map.js`
stops scanning at that address), and `tools/check-handler-count.js` now fails the
build if the handler table outgrows either the matrix side or the 1024-slot
per-handler array. Verified on `heroes2_demo`: the top two pairs in that
workload, `H389->H148` (6.22%) and `H406->H389` (6.20%), were **both invisible**
before the fix — the table read to choose fusions was missing its own largest
entries. Any fusion-candidate list taken before this date should be re-taken.
The rest of this section is what the bug was, kept because the 2x inflation is
baked into numbers already recorded below.

`$HANDLER_HIST_COUNT` was **361** — it is the side of
the dense `count x count` pair matrix, not the number of per-handler counters
(`HANDLER_HIST_COUNTS` holds 1024). Every fused superinstruction is numbered
*above* 361.

If the histogram total sums only `count` slots, a fused pair removes **two**
dispatches from the printed total — the two originals — while the one
replacement dispatch lands in an invisible slot. So the printed drop is exactly
twice the real one.

`test/run.js:3532` now sums `get_handler_hist_slots()` (all 1024) when the export
exists, falling back to `count` when it does not. That export landed *after*
`0fab7b7d`, so **any measurement taken against a build at or before that commit
is inflated 2x** and must be halved or re-run. Check for the export before
trusting a fusion number, and treat a reduction that looks suspiciously close to
`2 x (pair count) / total` as the tell.

**The true baseline is 520,284,956, not 518,446,380.** Two agents derived it
independently, from different experiments, and agreed to the digit; the
1,838,576 difference is handlers 361–399, which the old reader never counted.
Use 520,284,956 for any new comparison. The 518,446,380 figure is kept in the
tables on this page because the numbers recorded against it were taken with the
same blind spot, and rescaling them after the fact would be inventing precision.

For the same reason the 518,446,380 baseline above is *visible* ops, not all ops:
handlers such as `$th_load32_sib` (389) and `$th_lea_sib_pair` (390) already
existed above the cap and were never in it. That does not weaken the three-way
A/B — all three builds had the identical blind spot and the identical total — but
it is not a whole-program op count.

## Re-measured against main @ `eb080a99`

All four experiments were rebased onto current main and re-run with the fixed
512-wide histogram and the workload above, so these supersede every number
further down this page. **Baseline: 509,494,254 dispatches.** (Not 518,446,380
and not 520,284,956 — both predate six commits of main, including ~460 lines of
`07-decoder.wat` and ten new fused handlers at ids 400-409, which is most of the
difference. Three independent captures of the rebased baseline agreed to the
digit.)

```text
branch                          total          delta          op delta
main @ eb080a99             509,494,254            —             —
perf/fuse-cmp-jcc           466,521,428  -42,972,826        -8.43%
perf/fuse-sib-store         483,528,414  -25,965,840        -5.10%
perf/reg-specialised-...    509,494,254            0          0.00%
perf/reg-file-in-memory     509,494,254            0          0.00%
```

Every branch is pixel-identical to the baseline capture (`0 of 480000 pixels
differ`) and passes `test-x86-ops`, `test-shift-equivalence`,
`test-wat-decoder-runaway`, `test-win16-exec` and `test-caesar3-gameplay`.

The two zeros are not failures, they are the metric being the wrong instrument.
Both register experiments move work *inside* a dispatch — specialising a handler
per register, or moving the register file into linear memory — and remove no
dispatches at all, so op count is structurally blind to them and can neither
confirm nor refute either. Both are decidable only by a timing run on a quiet
box; the register-file branch additionally carries +4.73% code size
(860,196 → 900,879 bytes) into a loop that already thrashes icache.

The two fusions compose rather than compete: the `Jcc` fusion's three handlers
kept their exact pre-rebase counts after main's own 404/407 fusions landed
(different `if` arms of the same decoder decision — mod=3 register forms versus
memory forms, mutually exclusive by construction), and every handler not involved
in either fusion has a bit-identical count across all captures.

**None of the four is merge-ready.** Op count proves equal work, never speed, and
this box sat at load 250-360 throughout, so no timing was taken.

## Result: fusing `compute_ea_sib` into `store32`

Measured 2026-08-23, branch `perf/fuse-sib-store`. **Re-measured after rebase:
-25,965,840 of 509,494,254 = -5.10%** — the same absolute reduction as below,
against the corrected baseline. Handler id is now **410**, and the handler was
rewritten onto main's `$sib_ea` helper and reports itself to the SIB consumer
histogram, matching the shape of main's 400-402. New handler
`$th_store32_sib`, emitted by `$emit_store32` for 32-bit non-absolute EAs;
absolute and 16-bit segmented forms keep the generic two-dispatch encoding. The
EA math is fully general (base/index/scale/disp, `0xF` = absent) — no register
specialisation. `$emit_store32` has one call site (`0x89 MOV r/m32, r32`), so the
blast radius is that one opcode form. It mirrors the load side, `$th_load32_sib`
(389), which already existed.

```text
printed total   518,446,380 -> 466,514,700   = -10.02%   <- DO NOT USE
real reduction   25,965,840 removed          = -5.01%    <- the honest number
true post-change ~492,480,540 (466,514,700 visible + 25,965,840 in H400)
```

The 2x gap is the 361 cap described above; the worktree branched at `0fab7b7d`,
before `get_handler_hist_slots` existed. The arithmetic closes to the unit:
baseline SIB consumers 27,673,792 → 1,707,952 (store32 gone from that table
entirely) leaves exactly 25,965,840, which is exactly the baseline top pair
`H149->H21`; and `518,446,380 - 2 x 25,965,840 = 466,514,700`, the observed
total.

Pixel-identical: `0 of 480000 pixels differ, max channel delta 0`. Build clean
(`handler table=401 elem entries=401 cache guard=401`), `test-x86-ops` 69/69,
`test-shift-equivalence` 29376 combos, `test-win16-exec` 58/58,
`test-caesar3-gameplay` PASS with numbers identical to baseline.

The whole `H149 <-> H21 <-> H345` triangle leaves the pair list. What remains of
the SIB table is 1,707,952 EAs led by `$th_mov_m32_i32` (692,183) and
`$th_movsx16` (~864k across three forms) — together ~0.3% of dispatches, so a
second fused handler each would buy roughly 0.2%. Deliberately left generic.

**Still needs a timing run** per the rule above: -5.01% of dispatches is a work
reduction, and the AoE revert is the standing warning that a bigger handler can
give it back.

## Result: fusing flag producers with the `Jcc` that reads them

Measured 2026-08-23, branch `perf/fuse-cmp-jcc`. **Re-measured after rebase:
466,521,428 vs 509,494,254 = -42,972,826 = -8.43%**, with handler ids 410-412.
The delta equals the three fused handlers' hit counts summed, to the unit, and
every uninvolved handler's count is bit-identical across the two runs — a
stronger identity check than the sum arithmetic used below. Three fused handlers —
`$th_cmp_r_i32_jcc`, `$th_alu_r8_i8_jcc`, `$th_alu_r16_i16_jcc` — plus decoder
lookahead (`$jcc_lookahead_cc`) that folds a following `Jcc` into the producer
at emit time.

```text
printed total   518,446,380 -> 432,500,728   = -16.6%   <- DO NOT USE
real reduction   42,972,826 fused dispatches = -8.26%   <- the honest number
true totals     ~520,284,956 -> 477,312,130
```

Same 2x inflation as the SIB result, same cause (the worktree predates the
`HANDLER_HIST_COUNT` fix). The `<361` accounting fell by exactly `2 x` the fused
count, which independently proves the emulated instruction stream is unchanged:
every fused dispatch replaced precisely two. All three named pairs
(`H154->H311`, `H10->H321`, `H207->H311`) leave the top-pairs list.

Pixel-identical (`0 of 480000`, byte-identical files); `test-x86-ops` 80/80
(69 + 11 new directed fused-pair flag cases); shift-equivalence, decoder-runaway,
win16-exec, caesar3-gameplay, notepad-dialogs 5/5 all green.

**The fused handlers still publish the lazy-flag state.** They call the same
`$exec_*` body the unfused handler calls, so the two paths cannot drift. Skipping
the flag store was considered and rejected: EFLAGS is architectural state, not a
private channel to the next instruction (`cmp` + two branches, `SETcc`,
`ADC`/`SBB`, `PUSHF`, a fault with EFLAGS live into an SEH handler are all
ordinary), and the analysis is structurally unavailable anyway — the fused
handler *ends the block* at the folded `Jcc`, and successors are decoded as
independent blocks keyed by entry EIP, so no single-block reasoning can prove who
reads the flags next. Fuse the dispatch, keep the flags.

**Still needs a timing run.** -8.26% of dispatches is a work reduction; the AoE
revert remains the standing warning.

## Result: register file in linear memory (built, unmeasured)

Branch `perf/reg-file-in-memory`. **Re-measured after rebase: 509,494,254,
identical to main to the digit, with per-handler histogram bodies identical line
for line.** The transform is re-run over the tree after every merge rather than
merged by hand, which is safe because `lib/compile-wat.js` *hard-fails* on an
unknown global (unlike an unknown function, which only warns) — a site the
transform misses cannot compile. Verified with a negative control:
`(global.set $eax …)` injected into `06-fpu.wat` gives
`Error: compile-wat: unknown global: $eax`.

All 12,813 direct `global.get/set $eax..$edi`
sites plus the 325 `$get_reg`/`$set_reg` calls rewritten to
`i32.load/store offset=N (global.get $reg_base)`, per-thread partitioned at
`REGFILE_BASE + tid*64` (a full cache line, so no false sharing).
Execution-identical: 518,446,380 dispatches unchanged, PNG byte-identical, plus
five real worker-thread tests including Winamp's MP3 decoder — which runs guest
x86 on workers and would have shredded instantly on a bad partition.

**This measured distribution contradicts the static-count argument below.** Of
the ~328 indirect sites, **96% are in the interpreter inner loop**; of the 12,734
direct sites, **93% are in API-handler code** that runs once per Win32 call, and
7,816 of those are `$esp` (the stdcall arg-read/epilogue idiom) with 4,283 more
`$eax` (return value) — dynamically near-free. So the tax lands on cold code and
the win lands on hot code, which is the opposite of what the site counts suggest.
Counterweights: code size +4.7% (856,950 → 897,541 bytes) on a loop that already
thrashes icache, and `global.get $reg_base` is only CSE-able across call-free
regions, which the interpreter does not have. **Unmeasured for speed.**

One caveat with no equivalent under globals: registers now live at a linear-memory
address inside `g2w`'s direct guest window, so a wild guest pointer can scribble
on them. The guest stack and the GDI tables already carry that exposure, so it is
consistent with the layout rather than new in kind — but it is strictly worse
than per-instance globals.

## Result: register-specialised hot handlers (built, unmeasurable by op count)

Branch `perf/reg-specialised-handlers`, ids 410-449. Forty handlers: eight
register variants each of `add_r_i32`, `sub_r_i32`, `cmp_r_i32`, `load32` and
`alu_r16_i16`, so the hot ones read and write a fixed register instead of calling
`$get_reg`/`$set_reg`. **Op count is exactly unchanged (509,494,254)** — the
change moves traffic between handlers and removes no dispatches — and each family
sums to its generic predecessor's count to within the print cutoff:

```text
family            specialised     generic on main
add   410-417      29,470,685     H3   29,470,685
sub   418-425      12,400,769     H8   12,400,769
cmp   426-433      18,806,152     H10  18,806,717
load32 434-441     12,820,153     H20  12,820,376
alu16 442-449      26,573,690     H207 26,573,690
```

That removes **141.9M-195.1M** dynamic `get_reg`/`set_reg` calls (the range is
the CMP-vs-non-CMP split in the alu16 family, still unmeasured). Static call
counts are unchanged — the win is reachability, not text. It composes with main's
own run handlers (405/406/408), which take their bite first at the `$emit_load32`
tail: they had already absorbed 11% of load32 traffic (14,414,944 → 12,820,376)
independently of this change, and there is no further loss from stacking.

The load32 family is the weakest of the five — 12.8M over eight handlers, with
only five registers carrying real traffic (ecx 5.07M, edx 4.17M, eax 3.39M) — and
is the block to trim if handler count matters.

## Levers that remain

The 512-wide histogram moved the cut line, and the three candidates it exposed
were all invisible under the old 361 cap or below the top-24 print slice:

1. **`H344`/`H345 $th_load32_ro_base_{ebp,esi}` — 21.2M + 30.8M = 52.0M
   dispatches**, each still calling `$set_reg` for its destination. That is the
   largest single remaining `set_reg` source in the profile, larger than any
   family specialised so far. Full specialisation is 8 dst x N bases, but the
   pair data (`H21->H345` 23.9M, `H345->H149` 25.6M) says a handful of
   (dst, base) combinations carry nearly all of it.
2. **`H154 $th_alu_r8_i8` — 17,236,577 (3.38%)**, routed through
   `$get_reg8`/`$set_reg8`, which are built on `$get_reg`/`$set_reg`. Bigger than
   both the sub (12.4M) and load32 (12.8M) families that *were* specialised.
3. **The 16-bit cluster** `H166` 12.75M / `H165` 12.18M / `H206` 8.76M /
   `H210` 8.76M / `H193` 8.76M, all `get_reg16`/`set_reg16` users and tightly
   chained (`H193->H206->H165`, `H166->H442->H311`).

The table below is the older ranking, kept for the pair data.

Ordered by measured promise, from the Caesar III gameplay histogram
(518,446,380 dispatches):

```text
top pairs (fusion candidates)
  H149 $th_compute_ea_sib -> H21  $th_store32                25,965,840  6.13%
  H345 $th_load32_ro_base_esi -> H149 $th_compute_ea_sib     25,623,874  6.05%
  H21  $th_store32 -> H345 $th_load32_ro_base_esi            23,936,067  5.65%
  H154 $th_alu_r8_i8 -> H311 $th_jcc_z                       12,812,297  3.02%
  H165 $th_mov_m16_r16_ro -> H3 $th_add_r_i32                11,976,227  2.83%
  H10  $th_cmp_r_i32 -> H321 $th_jcc_le                      11,960,026  2.82%
  H3   $th_add_r_i32 -> H8 $th_sub_r_i32                     10,856,017  2.56%
  H166 $th_mov_r16_m16_ro -> H207 $th_alu_r16_i16             9,051,072  2.14%
  H207 $th_alu_r16_i16 -> H311 $th_jcc_z                      9,051,072  2.14%

top SIB consumers (recorded 27,673,792, collisions 0)
  H21 $th_store32     op=0x0 [edi+edx*1+disp]  25,734,930  92.99%
  H76 $th_mov_m32_i32 op=0x0 [edx+eax*4+disp]     692,183   2.50%
  H81 $th_movsx16     op=0x2 [none+ecx*2+disp]    507,855   1.84%

top handlers
  H21  $th_store32            33,042,320  6.37%
  H345 $th_load32_ro_base_esi 30,822,447  5.95%
  H3   $th_add_r_i32          29,470,685  5.68%
  H149 $th_compute_ea_sib     27,673,792  5.34%
  H207 $th_alu_r16_i16        26,573,690  5.13%
  H311 $th_jcc_z              25,222,665  4.87%
  H344 $th_load32_ro_base_ebp 21,227,657  4.09%
  H43  $th_jmp                20,521,673  3.96%
  H10  $th_cmp_r_i32          18,806,717  3.63%
  H154 $th_alu_r8_i8          17,236,577  3.32%
```

Note how concentrated the SIB shape is: **93% of all SIB effective addresses in
this workload are one form** (`[edi+edx*1+disp]` feeding `store32`). That is the
argument for a narrow fusion over the broad one AoE rejected.

`get_reg`/`set_reg` are ~10% of the profile. Making them cheaper means a
memory-backed register file. **The argument below is the prior that the built
branch above refuted** — it reasons from static site counts, and the dynamic
distribution puts the tax on cold code and the win on hot code. Kept because the
counterweights it names (the extra dependent load, the AoE `br_table` data point)
are still real. There are
**12,734** direct `global.get/set $eax..$edi` sites in `src/` against only 230
`call $get_reg` + 98 `call $set_reg`. `global.get $eax` is one load from the
instance struct; `i32.load offset=N (global.get $reg_base)` is two dependent
loads. The ~328 indirect sites get cheaper and the ~12,734 direct ones get
dearer, so the net sign is genuinely uncertain and probably negative. The AoE
`br_table register helpers` row (+0.6%) is the closest prior data point and it
lost.

**Whatever such a register file looks like, it must be per-thread partitioned.**
`src/01-header.wat:791` is `(import "host" "memory" (memory 8192 8192 shared))` —
worker threads are separate instances over one shared linear memory. Mutable
globals are per-instance, which is exactly why registers work per-thread today.
A register array at a fixed address would give every thread one register file.
Follow the `$THREAD_BASE = 0x05000000 + tid*0x400000` pattern, via a per-instance
base global.

## Method notes

- Primary metric on a loaded box is the op count, not the clock. State the load
  average when quoting any timing; `uptime` before and after.
- Interleave A/B/C samples in one loop rather than running all of A then all of
  B — background load drifts on the scale of minutes.
- Quote minima, not means, when the noise is one-sided (contention only ever
  makes a run slower).
- `tools/png-diff.js` against a baseline capture is the cheap correctness gate;
  a fusion that changes a pixel changed semantics.
- `/usr/bin/time -p sh -c "node ... >/dev/null 2>&1" 2>&1` — redirections
  written directly on the `time` command apply to `time` itself and silence the
  measurement, not the program.

# The region JIT, in the live run loop

```
   PROFILE (in the run)          PREPARE (off the run)         INSTALL (between slices)
  ┌──────────────────┐          ┌─────────────────────┐        ┌────────────────────────┐
  │ afterSlice hook  │  bundle  │ rank samples        │ wasm   │ instantiate over the   │
  │ samples $ip once │ ───────► │ pick + build region │ ─────► │ SAME memory            │
  │ per slice        │  (data)  │ AUDIT vs tier 0     │ bytes  │ carry every global     │
  │                  │          │ compile-wat + wasm  │        │ rebind, flush cache    │
  └──────────────────┘          └─────────────────────┘        └────────────────────────┘
        ~0 cost                  1.2-5.5s, inline or Worker           8-31 ms
                                                                        │
                                        guest bytes change ◄────────────┘
                                        ⇒ uninstall, flush, re-profile

  STILL SHIPS OFF. `--region-jit` (run-dos.js) and `?jit=1` / the page toggle
  all still default to OFF -- but for a different reason than before. The
  20-program gate is 20/20 byte-identical on frame, pixels, interrupts and
  rendered audio at 12M and 19/20 at 80M (where it was 12/20): DREAM still
  drifts one IRQ boundary by 80M on the shipped clock, and the clock that fixes
  it (`--lattice-clock`) re-times six flag-off witnesses, so it is opt-in.
  The 191-program corpus sweep is not clean either: CRITICAL.EXE draws a
  different picture with the JIT on. See "The correctness gate", "What was wrong" and "The one
  row that still differs".
```

## What ships

* `tools/toyvm/region-live.js` — the **driver**. Profiles a running program
  through `DosSession`'s `afterSlice` hook, builds a serializable bundle
  (`{samples, mem, regs, machine, ...}`), hands it to a backend, and installs
  what comes back. Requires only `vm.js` and `emit.js`, so it costs the page
  bundle 20KB and pulls in nothing else.
* `tools/toyvm/region-prepare.js` — the **prepare half**, and the reason for the
  split. It requires `region-jit.js`, `trace-jit.js` and `lib/compile-wat.js`
  (1.4MB of the 1.4MB), and it takes data in and gives data back, so it runs
  either inline or inside a Worker. `inlineBackend()` is here; `workerBackend(url)`
  is in the driver.
* `tools/toyvm/live.js` — `jit`, `jitUrl`, `jitBackend`, `jitOptions` options,
  `startJit()` / `setJit(on)` / `jitStats()`, and one `jit.pump()` call between
  the slice loop and the paint.
* `tools/toyvm/site.js` — a `JIT` toolbar toggle, persisted in
  `localStorage['toyvm-live']`, overridable with `?jit=0|1`; plus a **`--js-only`**
  mode. `site.css` and `site.js` are whole-file constants in that module, built
  from no sweep value at all, so this rewrites the page's RUNTIME without the
  sweep JSON and screenshots a full run needs — a full run without them drops a
  tile for every program whose PNG is not on this disk. The alternative was
  hand-editing a file whose first line says GENERATED.
  The toggle's button lives in `demos.html`, which IS built from a sweep, so the
  runtime guards `getElementById('lb-jit')` being null: on the pages deployed
  today the toggle is simply unreachable and `?jit=1` still works. Without that
  guard the new runtime would throw on exactly those pages and take the Run
  button down with it.
* `tools/toyvm/run-dos.js` — `--region-jit`, `--region-jit-after`,
  `--region-jit-window`, `--region-jit-regions`, `--region-jit-gate`,
  `--region-jit-gate-iters`, `--region-jit-verbose`.
* `tools/toyvm/region-live-ab.js` — the on/off harness the tables below come
  from, plus `--slice-log-dir=DIR` (see "How to see a moved cut").
* `test/test-toyvm-region-live.js` — two hand-assembled programs run
  interpreted and jitted. The second one's hot loop has a **second exit the
  audit window cannot reach** (a comparison that is true once every 65,536
  iterations, five audit windows in), and the test compares the rendered wav as
  well as the registers, the frame and the text screen — so an install that
  costs the run a handback fails it even when the picture is identical.
* `docs/dos-corpus/live/toyvm-jit-bundle.js` — a **second** browser bundle,
  fetched only when the toggle is on. `toyvm-bundle.js` (the page's own) stayed
  at 1052KB; the JIT bundle is 1415KB and is not loaded otherwise.

Nothing about the interpreter changed. Two globals were added to the state the
install carries (`idtb`/`idtl`, plus `attr_flip`/`vga_reads` by their existing
accessors) — see "What an install has to carry" below.

## The page must not stall, so nothing compiles on its thread

Measured on DRAGON.EXE, one region:

| phase | where | cost |
|---|---|---|
| bundle (copy guest memory + samples) | main thread | **69 ms** |
| pick, gate, build, compile-wat, `WebAssembly.compile` | backend | 1192-5536 ms |
| instantiate + carry state + flush | main thread | **9-31 ms** |

So the main thread pays one memcpy and one instantiate; everything between them
is off it. On the page that "between" is a Worker (`workerBackend`), which the
`live-audio-probe` server makes available because `file://` pages get no Worker
at all. Headless, it is `inlineBackend()` — a CLI run has no frames to drop.

A representative CLI breakdown (ACCIDENT.EXE, `--region-jit-verbose`):
`pick 132.6ms, snapshot 0.0ms, gate 663ms, build 814ms, instantiate 9ms, swap 6.5ms`.

## What an install has to carry

Memory is imported and host-owned, so the new instance sees the same bytes. What
is per-instance is every wasm **global**, and a register left behind is not a
crash — it is a wrong number, later. `carryState` moves STATE (registers,
segments through `$sset` so the shadow bases follow, flags through
`get_flags`/`set_flags` so a deferred lazy-flag rule is materialized and
retired), MACHINE_STATE, and the x87 file.

Two gaps were found while measuring this and are fixed here:

* **`idtb`/`idtl`** had no accessor at all. `lidt` writes them and `$fault`
  reads them to find a gate, so a swap left a protected-mode program taking its
  next interrupt through the real-mode vector table. Added to `MACHINE_STATE`.
* **`attr_flip`** (the VGA attribute controller's index/data flip-flop) and
  **`vga_reads`** (the retrace-read accumulator `dos-loop` drains into
  `machine.clock.retrace`) are neither registers nor settings and were in no
  list. Carried explicitly.

Neither changed any row of the tables below, which is worth saying plainly: they
are correct and they were not the cause of anything measured here.

## A stale region is a wrong picture

Three mechanisms, all from `region-jit.js`, all reused rather than reimplemented:

* `regionBytes` — the guest bytes each absorbed block covered. `compile.js`
  re-checks them at every install of the word and declines the substitution if
  one moved.
* `regionCodeBits` — those bytes are marked as compiled code, so a store into
  them raises `$smc`.
* `guardsHold()` on every pump. A break drops the region, flushes the cache,
  resets the profiler and re-arms sampling.

`test/test-toyvm-region-live.js` is the test for exactly this: a synthetic .COM
runs a hot loop, gets a region installed, then **patches the immediate inside
that loop** and runs it again with a different constant. It asserts the region
was installed, that it was dropped, and that registers, frame, text cells and
character count all match the interpreter — against a closed-form answer
computed in JS, so two agreeing-but-wrong arms cannot pass.

## The clock

A region charges `$steps` per op precisely so the dispatch count does not move,
and the dispatch count is what every timer, retrace and audio deadline is
derived from. The test bounds the drift at **one dispatch per install**, and the
bound is the finding: measured across four rep counts (200/100, 200/200,
400/100, 300/150) the gap was 1 or 2 dispatches against 34-57M and **did not
grow with the iteration count**. It is the slice a swap lands in overshooting by
at most one straight line, not the body mis-billing.

That one-dispatch overshoot is what the **lattice clock** (`--lattice-clock`)
removes: it re-syncs the IRQ grid at the next lattice point instead of letting a
long slice carry its overshoot forward, so the arms agree on every slice
boundary and DREAM at 80M goes from DIFFERS to SAME. It is **opt-in on both
hosts** (`latticeClock: false` in `DosSession` and in `live.js`), because it is
a change to the shipped clock, JIT or not: with the region JIT off it moved the
wav of all six flag-off witnesses (DADEMO3, RUNDEMO, BLIQ, ACME-BIG, CONTAGIO,
CATWALK) against main and blanked BLIQ to 0 pixels. A clock change that
deterministically re-times six programs is not a correctness fix for a flag
that ships off; it is a separate experiment and it stays behind its flag.

## The correctness gate

`region-live-ab.js`, both arms in one process, order rotated, at
`--pit-clock --auto-key --sound-pref=sb --env=ULTRASND=220,1,1,11,7`. "Same"
means the frame hash, the pixel count, the interrupt tally **and a sha256 of the
rendered audio**.

### At 12M dispatches: 20/20 identical

10 programs installed a region; the other 10 declined and are identical by
construction. Mean dispatch/cpu-second change over the installed rows
**+1.2%** (box at load 3-6 — see "the numbers are noise" below). Measured
2026-09-09 on the shipped clock (lattice off) with `--region-jit-gate=0`; the
installed rows:

| program | same | share | gate | off M/cpu-s | on M/cpu-s | % |
|---|---|---:|---:|---:|---:|---:|
| DHADREN.EXE | yes | 25.1% | 8.28x | 116.62 | 105.03 | -9.9% |
| ACCIDENT.EXE | yes | 18.3% | 3.56x | 59.40 | 54.41 | -8.4% |
| RUNDEMO.EXE | yes | 2.5% | 3.35x | 91.60 | 74.84 | -18.3% |
| CONTAGIO.EXE | yes | 7.2% | 2.68x | 41.98 | 70.36 | +67.6% |
| CYCLE.EXE | yes | 3.6% | 5.99x | 110.10 | 108.12 | -1.8% |
| BRW.EXE | yes | 4.3% | 2.50x | 76.49 | 67.78 | -11.4% |
| ADDY_II.EXE | yes | 27.5% | 2.72x | 153.59 | 186.38 | +21.4% |
| DRAGON.EXE | yes | 47.5% | 1.59x | 76.29 | 55.63 | -27.1% |
| ASYLUM.EXE | yes | 3.9% | 3.77x | 78.02 | 79.73 | +2.2% |
| DREAM.EXE | yes | 97.5% | 2.25x | 115.42 | 112.27 | -2.7% |

### With the flag off, nothing moved

Six witnesses (DHADREN, ACCIDENT, RUNDEMO, CYCLE, DRAGON, ADDY_II) at 12M with
`--pit-clock --auto-key --sound-pref=sb --env=ULTRASND=...`, run from this tree
and from a `git archive` export of main: **identical frame hash and identical
wav sha256 on all six**. That is the check that matters for a flag that ships
off, and it covers the one change here that touches the interpreter's own module
— the two globals added to `MACHINE_STATE`, which only add exported accessors.

`tools/toyvm/tree-compare.js` is what asks that question, and it is neither of
the other two harnesses: `region-live-ab.js` runs two ARMS of one build (right
for a flag, useless for a code change, since both arms would be the new code)
and `sweep-diff.js` compares two whole-corpus sweeps and costs hours of
bench work a run-loop change cannot touch. This runs the same programs under
two CHECKOUTS — `git worktree add --detach /tmp/base <sha>`, then
`--base=/tmp/base` — and calls a row SAME only if the frame, the pixel count,
the text page, the interrupt tally and the wav all agree. The handback count is
printed beside every row and is deliberately **not** part of the verdict: a
change that removes handbacks and moves neither picture nor sound is the good
case.

### At 80M dispatches: 19/20 identical, DREAM differs

The same 10 programs installed a region; frame, pixels, interrupts and the wav
sha256 match on nineteen. **DREAM differs at 80M on the shipped clock and is
identical at 12M**: frame `462573cd` against `cb260c25`, 6584 against 6764
pixels, the same 27 interrupts, a different wav, and the arms stop at
80008453 against 80013157 dispatches. That last pair is the cause — DREAM
spends 97.5% of its budget inside the region, so the one-dispatch slice
overshoot the clock section bounds lands on a different IRQ boundary in each
arm, and by 80M the drift has reached the picture. Re-run alone it reproduces
byte for byte, and with `--lattice-clock` on both arms it is SAME (frame,
pixels, ints and wav) at the same budget. So the fix is known and it is the
lattice clock, which does not ship (see "The clock"); until it does, the flag
stays off and this row is the reason a full-budget run is not a passing gate.
Mean dispatch/cpu-second change over the installed rows **+2.3%** at 80M
against **+1.2%** at 12M, box at load 3-6 for both.

| program | same | share | gate | off M/cpu-s | on M/cpu-s | % |
|---|---|---:|---:|---:|---:|---:|
| DHADREN.EXE | yes | 25.1% | 8.10x | 183.99 | 200.80 | +9.1% |
| ACCIDENT.EXE | yes | 18.3% | 3.40x | 85.21 | 83.71 | -1.8% |
| RUNDEMO.EXE | yes | 2.5% | 3.15x | 118.09 | 107.99 | -8.5% |
| CONTAGIO.EXE | yes | 7.2% | 2.59x | 25.47 | 25.99 | +2.0% |
| CYCLE.EXE | yes | 3.6% | 6.66x | 73.29 | 71.44 | -2.5% |
| BRW.EXE | yes | 4.3% | 2.61x | 78.71 | 72.11 | -8.4% |
| ADDY_II.EXE | yes | 27.5% | 2.65x | 84.48 | 88.08 | +4.3% |
| DRAGON.EXE | yes | 47.5% | 1.62x | 93.30 | 92.19 | -1.2% |
| ASYLUM.EXE | yes | 3.9% | 3.65x | 74.55 | 76.75 | +3.0% |
| DREAM.EXE | **NO** | 97.5% | 2.29x | 101.79 | 128.86 | +26.6% |

The ten declining rows are `no self-loop region found` (DTM2, DEMO5, COMPOVRS,
COPPER, CORE-ADD, CONTACT, DSTNFO) or `INCONCLUSIVE` (B-STEEL, CMA_SHRT,
daretro): the audit's arms disagree over an op list that branches internally, so
they did not run the same program and an absent verdict is not a passing one.

It used to be 12/20, in three classes. What follows is what each of them
actually was, because none of them was in the compiled region.

| was | rows | root cause |
|---|---|---|
| audio only (wav differs, everything else identical) | DHADREN, RUNDEMO, CYCLE | the install cost the run one handback, which moved every later slice boundary |
| stops making progress | ACCIDENT, CONTAGIO, BRW, DRAGON | `Machine.setMemory` at the install (a boot-time reset) and a `carryState` ordering bug |
| differs at full budget | DREAM | the region ABSORBED a handback the interpreter took, which moved every later slice boundary |

## What was wrong

**1. `Machine.setMemory` is not a rebind.** The install calls it to point the
machine at the new instance's exports — but it is the boot-time reset:
`installIvt()`, `fillCells()`, `setSystemBda()`, `setVideoBda()`, `syncKbBda()`,
`installVideoRom()`. So a demo that had hooked INT 08h/09h/1Ch lost its own
handlers at the instant the region installed. `Machine.setVmExports(ex)` now
does the one thing that was wanted and nothing else. The tell that this was not
a region bug at all: with `--trap` (a region body of `unreachable`) ACCIDENT,
BRW, CONTAGIO and DRAGON each reproduced their divergence **byte for byte and
never trapped** — not one of them had entered the region.

**2. `carryState` carried the segment registers before the machine state.**
`set_es` goes through `$sset` → `$segbase`, which reads `$cr0`, `$vm86`,
`$gdtb`, `$gdtl` and `$ldtb` — all of them in `MACHINE_STATE`. Carried in the
old order, a protected-mode program came out of the swap with every shadow base
computed as `selector << 4`. That was CONTAGIO (a DOS extender) and BRW. The
carry is now machine state, then registers, then machine state again — the
second pass because `$sset` republishes `$d32` and `$spm` on its way through.

**3. An install must not change the sequence of handbacks, and three things
made it.** A handback is where an armed IRQ is delivered, where a slice's audio
is rendered and therefore where the Sound Blaster's DMA is *fetched* out of the
guest's buffers. So one extra handback shifts every later slice boundary by that
slice's unspent remainder, for the rest of the program:

* `cache.flush()` at the install — unnecessary (a region is an EXTRA entry
  appended to the handler table, so every index already in the arena still names
  the same handler in the new module) and visible: every live block had to be
  compiled again, one handback each. Replaced with `invalidateRange` over the
  region's own guard bytes.
* `invalidateRange` clears the shadow return stack (`$rtop`), which is right for
  a guest store and wrong for an install. The stack is now *checked* instead: an
  entry is stale only if its arena address falls inside a program this install
  is dropping, and whatever prefix is below the lowest such frame is kept. On
  CYCLE.EXE that single miss put all 650,000 following boundaries 33,909
  dispatches early — identical frame, identical pixels, identical interrupts,
  different wav from sample 99,584 on.
* the region's own slice protocol. A region used to test for the end of the
  slice only at its back edge, once per iteration, and with `$steps > 0` rather
  than `>= 0`. The interpreter takes that boundary at EVERY transfer, so the two
  ended slices in different places; and a handler that READS the clock
  (`$vga_status` answers port 3DAh from `$slice_budget - $steps`, and every port
  write is stamped with the same expression by `Machine.audioNow`) has to see
  the same `$steps` the interpreter would have. Both are now emitted per edge
  (`region-jit.js` `edge()` / `boundaryTest`), with `--no-exact-slice` as the
  bisector.

**4. …and a region legitimately REMOVES handbacks, which is the whole point.**
DREAM's interpreter arm took one early exit at `100:7f3` every ~190,000
dispatches — a back edge the compiler could not resolve — and the region
absorbed it. Nothing is wrong with either arm, and yet from the install on their
slice boundaries never coincided again, the timer IRQ landed on a different
instruction and the frame diverged by 180 pixels. No install-side fix can reach
this, so the run loop changed instead, in two places, and both are properties of
the *dispatch clock* rather than of the handback cadence:

* the slice quantum is anchored to the absolute dispatch count
  (`quantum - dispatched % quantum`), so an extra handback costs one short slice
  and the grid **re-syncs at the next lattice point**;
* the audio is rendered at quantum crossings, not at every handback, so an
  extra handback does not split one render into two and read the guest's DMA
  buffer at an instant the other arm never sampled.

`audio.js` had already been made chunk-invariant in its *grid* (frames are a
difference of two absolute totals; port and OPL events past the last rendered
frame are carried rather than folded in at `Infinity`) — but the DMA fetch can
only ever read memory as it is now, which is why the render instant itself had
to go on the lattice.

### How to see a moved cut

`--slice-log=FILE` (run-dos.js) writes the cumulative dispatch count, the
unspent budget and `cs:ip` at every handback, one line each;
`region-live-ab.js --slice-log-dir=DIR` writes one per arm. `diff` them and the
first differing line is the handback where the cut moved, with the reason beside
it. A frame hash says two runs ended somewhere different; this says *where*, and
it is the only thing that separates "the region computed something else" from
"the region ended its slice one instruction along".

## The corpus sweep: two rows still differ, and that is why it stays off

`sweep-dos.js --dir=/tmp/demos --reps=1 --variants=tailcall` (191 programs,
8M dispatches each) run twice — once plain, once `--region-jit` — through
`sweep-diff.js`:

| | regressions | went blank | changed | recovered |
|---|---:|---:|---:|---:|
| off vs on | 0 | 0 | **37** | 1 (QUARTZ, a timeout flake) |
| off vs off (control) | 0 | 0 | **0** | 1 (the same flake) |

**Run the control.** The off-vs-off pair is bit-identical on all 191 rows, so
this sweep has no run-to-run noise at all and every one of those 37 rows is the
JIT's. Without that second baseline the 35 harmless ones below would read as
measurement scatter and the two real ones would have been argued away with them.

* **35 rows moved the dispatch count by 1-9 out of 8,000,000** with the frame
  hash and the pixel count identical. That is a slice boundary landing one
  block later at the very end of the budget, not a different picture.
* **BMGLP.EXE and CRITICAL.EXE draw something else.** Both reproduce exactly,
  every time, in `sweep-dos.js --one=` under both arms:

  | program | region | frame off/on | px off/on | dispatched off/on |
  |---|---|---|---|---|
  | BMGLP.EXE | `0x28c`, 2 blocks, 17 ops, 28.4% of samples, gate 2.39x | `85841133` / `f6942521` | 793 / 649 | 8000003 / 8000005 |
  | CRITICAL.EXE | `0x196`, 2 blocks, 29 ops, 1.8% of samples, gate 2.22x | `8859edaf` / `0e717135` | 2932 / 2933 | 8000002 / 8000011 |

**These are in the region, and they are the class the snapshot audit cannot
see.** Everything in "What was wrong" above was install-side and each one
reproduced under `--trap` (a region body of `unreachable`) *without trapping*.
CRITICAL.EXE **traps** under `--trap`: the guest really executes the compiled
body. It still differs under `--once` (no back edge at all), so it is not the
slice protocol, and unchanged under `--no-exact-slice`. And the audit agreed on
both regions — 2.39x and 2.22x over 4000 iterations with every register and
every byte of memory matching — which is exactly the limit written into
`region-prepare.js`: the audit is a check on the lowering of the ops it *saw
run*, not a proof about a path it never took. `test/test-toyvm-region-live.js`
now has a program whose second exit is only reachable five audit windows in, for
that reason; these two rows say the general case is still open.

At the default profile window (6M in, 6M wide) and 80M dispatches CRITICAL.EXE
is much worse than at the sweep's settings: 245 px against 265, 35,361
dispatches apart, and the wav differs too. It is the row to start from.

## What is NOT done

* **The corpus gate is not clean**, so `--region-jit` and `?jit=1` default OFF
  and this is not on for anyone by accident. BMGLP.EXE at `0x28c` and
  CRITICAL.EXE at `0x196` are the work list, and unlike the four progress stalls
  they really are inside the compiled region.
* **The audit still has no way to say "I never took that exit".** It reports
  DISAGREES, INCONCLUSIVE (arms took different branches) or a ratio; an exit the
  seeded 4000 iterations never reach is silently counted as audited. Making an
  unexercised side exit an INCONCLUSIVE verdict rather than a pass is the change
  that would have declined both rows above.
* **The page's `M steps/s` and audio-underrun numbers were not measured.** The
  runtime now ships (`site.js --js-only`), but `live-audio-probe.js` has no
  `--query=` pass-through, so there is no way to open a tile with `?jit=1` from
  it, and the toolbar button itself arrives with the next `demos.html`
  regeneration. The page path is code-complete and unmeasured.
* The Worker backend has no automated test. `test/test-toyvm-region-live.js`
  exercises the inline backend; the Worker path is the same `prepareRegions`
  call with a `postMessage` around it.

## The numbers are noise, and this is not a hedge

Every wall-clock figure here was taken on a box at load 40-173 with other agents
running corpus sweeps. `region-live-ab.js` quotes dispatches per **user-CPU**
second for that reason, and the gate's speed bar (`--region-jit-gate`, default
1.0x) is a measurement that moves with the box: the same DRAGON region measured
**2.62x and 0.84x an hour apart**. That is why a correctness sweep must pass
`--region-jit-gate=0` — otherwise the arms silently stop installing anything and
the run grades a JIT that never engaged.

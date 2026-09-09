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

  SHIPS OFF. `--region-jit` (run-dos.js) and `?jit=1` / the page toggle both
  default to OFF, because the 80M-dispatch correctness gate is NOT clean:
  20/20 programs identical at 12M, 12/20 at 80M.
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
* `tools/toyvm/region-live-ab.js` — the on/off harness the tables below come from.
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

## The correctness gate

`region-live-ab.js`, both arms in one process, order rotated, at
`--pit-clock --auto-key --sound-pref=sb --env=ULTRASND=220,1,1,11,7`. "Same"
means the frame hash, the pixel count, the interrupt tally **and a sha256 of the
rendered audio**.

### At 12M dispatches: 20/20 identical

10 programs installed a region. Mean dispatch/cpu-second change over the
installed rows **+9.2%** (box at load ~170 — see "the numbers are noise" below;
the same table measured +9.7% with 9 installs an hour earlier, and the row that
changed is DRAGON, whose gate ratio is the one that moves with the box).

### With the flag off, nothing moved

Six witnesses (DHADREN, ACCIDENT, RUNDEMO, CYCLE, DRAGON, ADDY_II) at 12M with
`--pit-clock --auto-key --sound-pref=sb --env=ULTRASND=...`, run from this tree
and from a `git archive` export of main: **identical frame hash and identical
wav sha256 on all six**. That is the check that matters for a flag that ships
off, and it covers the one change here that touches the interpreter's own module
— the two globals added to `MACHINE_STATE`, which only add exported accessors.

### At 80M dispatches: 12/20 identical — this is why the flag ships off

| program | frame | px | dispatched off/on | what it is |
|---|---|---|---|---|
| DHADREN | same | same | 80.0M / 80.0M | audio only (wav differs) |
| RUNDEMO | same | same | 80.0M / 80.0M | audio only |
| CYCLE | same | same | 80.0M / 80.0M | audio only |
| ACCIDENT | differs | 18840 / 18447 | 80.0M / **32.1M** | stops making progress |
| CONTAGIO | same | same | 80.0M / **12.0M** | stops making progress |
| BRW | differs | 118751 / **0** | 80.0M / **12.0M** | stops making progress |
| DRAGON | differs | 1 / 10634 | 80.0M / **58.5M** | stops making progress |
| DREAM | differs | 6584 / 6764 | 80.0M / 80.0M | differs at full budget |

Two classes, and they want different work:

**Audio-only (3 rows).** Frame, pixels, interrupt count and dispatch count all
identical; only the wav sha moves. A region ends its slice at its own back edge
rather than wherever a budget happened to expire, so slice boundaries shift, and
`machine.setClock` samples the guest clock at slice boundaries. The guest work is
the same; the timestamps the audio is rendered against are not.

**Stops making progress (4 rows).** These are real. Run ACCIDENT with `--stuck=0`
and the JIT arm reaches 80M — and paints the same picture it painted at 32M
(`d20f3a58`, 18447px, 1468 ints, 10048 handbacks over the last 48M dispatches at
`10c8:396`). The stuck detector was right: the guest genuinely stopped
progressing after the region at `0xb13` installed. The snapshot gate agreed on
that region (4.33x over 4000 iterations), so whatever is wrong is on an exit or
successor path the seeded snapshot never takes.

DREAM is its own case: both arms run the full budget and paint different
pictures.

**Do not read the 80M throughput column.** Four of the ten installed rows stop
between 12M and 58M, so their dispatch/cpu-second is measured over a different
program than the baseline's. The +29.3% mean over installed rows at 80M is not a
speedup; the 12M table is the one with comparable arms.

## What is NOT done

* **The gate is not clean at 80M**, so `--region-jit` and `?jit=1` default OFF
  and this is not on for anyone by accident. The 4 progress-stall rows are the
  work list; ACCIDENT at `0xb13` is the one with a named address to start from.
* **`sweep-dos.js --dir=/tmp/demos` on vs off was not run.** The box has been at
  load 40-173 throughout, two other agents are sweeping the same corpus, and a
  94-program on/off sweep whose on-arm is known to stall on 4 of 20 known
  programs would produce a diff nobody could adjudicate.
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

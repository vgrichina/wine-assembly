# Frame-pacing census: can we cap guest frame production at display refresh?

Measured 2026-08-31. Tools written for this survey: `tools/pacing-census.js`,
`tools/lock-pause-ab.js`, and one flag, `test/run.js --dx-lock-pause-ms=N`.

## The question

A game that produces 200 frames a second for a 60 Hz screen wastes most of the
CPU it spends. Capping guest frame production at display refresh would be a
large battery win — **unless** the game frame-locks its simulation, advancing
the world once per rendered frame with no clock read. Cap that game and it runs
in slow motion.

So: how many of our games frame-lock, and is that set small enough that a
default-on cap with a per-app `frameLocked` opt-out is safe?

**Answer, up front.** **Zero** measured apps frame-lock in a way a
display-refresh cap would hurt. The one candidate, DX-Ball, turned out to carry
its own `while (timeGetTime() - last < 17)` limiter — 58.8 fps — that the
default headless clock silently defeats; given a realistic clock it pins itself
at 58.67 frames per guest second and goes no higher. See
[the correction](#correction-dxball-is-clock-limited-not-frame-locked).

Recommend **default-off** anyway, because the survey found that the premise does
not hold: **no app measured here produces frames faster than a display.** They
run their main loop at 2-6 frames per guest second and spend up to **113
presentation events on each one**. The waste is presents *per frame*, not frames
per second, and a frame cap does not touch it. A default-on cap would be safe;
it would simply have nothing to bind on.

**And the sweep that followed the dxball correction found the real item.**
Re-running every classified app at two guest clock rates
([Clock sensitivity](#clock-sensitivity-dxball-was-not-the-exception-it-was-the-first-case))
shows that **eight of twenty-two** carry a frame limiter the default headless
clock disables — and that they hold their frame rate by **busy-waiting on the
clock**, not by sleeping: Abe's Oddysee spends 1.77M `timeGetTime` calls in
three guest seconds, DX-Ball 47.3M spin iterations. In the browser, where those
limiters do engage, that is CPU pinned at 100% waiting for a deadline the guest
has already named. **Parking a clock-spinning guest is the battery win here**,
not capping frames.

## What is already capped, and what is not

`host.js:524-620` already caps **presentation**. `_dxFrameSeqNow()` buckets
`performance.now()` into 16.7 ms slots (a nominal 60 Hz, not the real refresh —
a 120 Hz phone still gets 60), and `_presentDxIfDirty` uploads the canonical
surface at most once per bucket, skipping entirely on a hidden tab.

What is **not** capped is the guest. The drive loop runs `run(stepsPerSlice)`
back to back through a `MessageChannel` post for as long as the main thread is
not parked, and `_parkedSleepMs()` only sleeps against a deadline the guest
itself named (a `Sleep(n)`, a bounded wait, a timer due). A `PeekMessage` or
`Sleep(0)` spin pump names no deadline and never parks.

So the waste is not the upload. This census set out to measure whether it is the
guest producing too many *frames*, and found instead that it is the guest
producing too many *presents per frame*: DX-Ball emits 201,121 `$dx_present`
events in 6,000 headless batches, and those are roughly 113 events for each one
of its ~2.5 frames per guest second, one per sprite blitted to the primary. Each
runs the full guest-side present path before `_presentDxIfDirty` coalesces the
upload. That is the recoverable cost, and it is why this census counts *guest*
presents rather than canvas uploads — and why it has to keep presents and frames
apart, which is the trap described below.

## Method

Everything here is a **count**, not a time. The box ran at load 12-51 for the
whole survey and no wall-clock number would have survived that.

### 1. API census per guest second — `tools/pacing-census.js`

```
node tools/pacing-census.js --app=ID --max-batches=8000 --warmup=2500 --timeout=520
```

Runs `test/run.js` twice, streams its `[API] Name` one-liners through a
readline pipe (never a file, never a terminal — the documented 3x cost of
leaving `--quiet-api` off is the cost of *blocking* on stdout) and tallies a
per-API histogram. The second run at `--warmup=N` is subtracted from the first,
so the reported **steady state** excludes startup. That matters more than it
sounds: every game spends its first thousands of batches in `ReadFile` and
`InterlockedDecrement`, and those calls are not pacing.

Rates are per **guest** second (`batches × --tick-ms-per-batch`), because a
batch is a budget of blocks and not a unit of work.

### 2. Two-budget test

Same guest seconds, ~10x the ops: add `-- --batch-size=100000`. If presents per
guest second rise, the app was starved of instructions, not stalled in logic.

### 2b. Clock-sensitivity sweep — `pacing-census.js --clock-sweep`

Added after the dxball correction, and it is now the *first* probe to run on any
new app:

```bash
node tools/pacing-census.js --app=ID --clock-sweep --max-batches=3000
```

It runs the same batch budget twice — once at the default 200 ms of guest time
per batch, once at `--tick-ms-per-batch=1` — and compares counts **per batch**.

**Per batch, not per guest second.** Batches are the controlled variable: at a
fixed `--max-batches` and `--batch-size` the guest is offered the same number of
block budgets whatever the clock says, so a counter that is a pure function of
executed code has the same per-batch count at both rates and a ratio of 1.0.
Per-guest-second rates differ by 200x between these arms *by construction* and
say nothing. This is the same reason the census quotes presents-per-frame rather
than presents-per-second.

**The discriminator is clock reads per frame**, not either counter alone. Both a
defeated limiter and a time-starved app produce fewer frames at the low tick;
they differ in what happens to the polling:

| | frames | clock reads | reads per frame |
|---|---|---|---|
| limiter defeated at 200 ms/batch | **down** | **up** | explodes |
| time-starved at 1 ms/batch | down | down | ~1 |

Measured, and these are the two anchors the classifier is calibrated on:

- **dxball** — frames 0.018x, clock reads **145x**, reads per frame **8000x**.
  That is the limiter engaging (verified against the disassembly).
- **diablo_demo** — frames 0.006x, clock reads 0.006x, reads per frame **1.0x**.
  Everything fell by the same factor: it simply did 1/166th of the work per
  batch because 166x less guest time passed. No limiter, just starvation.

The tool prints both ratios and a verdict of `CLOCK_INSENSITIVE`,
`LIMITER_ENGAGED`, `TIME_STARVED`, `SPIN_AMPLIFIED`, `MORE_FRAMES` or
`NO_FRAMES`. Add a third rate (`--clock-sweep=200,20,1`) only where two
disagree and the trend matters.

### 3. Presentation back-pressure — `--dx-lock-pause-ms=N` + `tools/lock-pause-ab.js`

On real hardware, locking or flipping the primary is where back-pressure lives:
the call blocks until the display is ready. Our emulator returns instantly, so a
game whose loop was throttled by the display on a Pentium free-runs here, and
the "fps" it reports is a number no real machine ever produced. This flag puts
the back-pressure back and asks what the game does about it.

**Seam:** the `h.dx_trace` wrapper in `test/run.js` (~line 2117), on **kind 5**,
which is `$dx_present` in `src/09a8-handlers-directx.wat:4635`. Kind 5 is the
one event every presentation path funnels into — `Unlock` on a primary, `Flip`
on a flip chain, a `Blt`/`BltFast` whose destination is the primary, a palette
`SetEntries` — and it is the same event `host.js` counts as `PRESENT/s`. No WAT
change, no rebuild. Offscreen and back-buffer locks are composition and are
deliberately left at full speed.

The pause is charged as **guest** milliseconds, not host wall time: the headless
clock is batch-driven, so a real sleep would be invisible to the guest. It lands
in `lib/batch-clock.js` as `state.pausedMs`, a uniform shift applied to both the
clock base and its per-batch ceiling, so it can neither reverse the clock nor
break the ceiling invariant. It is 0 and costs one add unless the flag is passed.

> **First version of this flag was wrong and it is worth recording why.** It
> charged the *primary Lock* (`dx_trace` kind 1, flags bit 0). That reaches only
> games that render straight into a locked primary. DX-Ball, which presents by
> blitting to the primary, was charged **0 ms over 6,000 batches** and came back
> "pixel-identical — frame-locked". The measurement had simply never happened.
> Moving the charge to kind 5 turned that same run into the strongest result in
> this document. A null result from an instrument that never fired looks exactly
> like a real null.

`tools/lock-pause-ab.js` runs both arms at an identical batch budget,
screenshots both at the **same batch numbers**, and diffs with
`tools/png-diff.js`. Same batch is the right comparison because the pause adds
guest *time* without adding guest *work*: at a fixed batch both arms have run
the same x86 and differ only in what the clock says.

- picture **DIFFERS** → the game read the clock and compensated → **CLOCK_PACED**
- picture **IDENTICAL**, and the dose was large → nothing noticed → **FRAME_LOCKED**
- picture **IDENTICAL**, dose < 2% of guest time → **INCONCLUSIVE**, not a null

That last line is a guard the tool now enforces, because StarCraft's title
screen presents 82 times in 1,200 guest seconds and was charged 0.1% — an
"identical" that says nothing at all. (StarCraft, re-measured on the corrected
kind-5 seam, then came back **DIFFERS** anyway — see its row.)

**Every FRAME_LOCKED verdict needs a positive control**, and it costs one extra
diff: compare two captures *within the same arm*. If those are identical too,
the app is on a static screen, and "identical across arms" is then a fact about
a still picture rather than about pacing. DX-Ball passes this control loudly —
36.0% and 44.9% of pixels change between its own consecutive captures — which is
what makes its null across arms mean something. `lock-pause-ab.js` now runs this
control itself and downgrades a FRAME_LOCKED verdict to `STATIC SCREEN` when it
fails, so the check cannot be forgotten.

### Traps this survey walked into

**The 200 ms/batch headless clock defeats frame limiters, and a defeated limiter
looks exactly like a frame-locked game.** This is the trap that produced the one
wrong verdict in the first draft of this census, and it is worth stating as a
rule: an app that reads the clock every frame and appears not to act on it is
*more* likely to be clock-limited than clock-ignoring, because
`while (timeGetTime() - last < N)` is the standard shape and `N` is 16-17 ms
while a batch is 200 ms. Every delta check passes on the first read, the spin
body never executes, and the perturbation A/B correctly reports that nothing
changed — because at that clock rate nothing *can*. DX-Ball's limiter spin at
`0x402286` takes **0 hits** at the default clock and **47.3 million** at
`--tick-ms-per-batch=1`. Two cheap defences: disassemble what the clock reads
are compared against before writing FRAME_LOCKED, and re-run the A/B at
`--tick-ms-per-batch=1` — if a limiter exists, frame production falls and spin
iterations appear. CLAUDE.md documents this knob for the opposite symptom (a
timer expiring too fast); this is the same knob for a limiter never engaging.

**A blit is not a frame.** The `[API]` stream has no "frame" event for a GDI
app, so the obvious present metric — sum the blit APIs — counts *draw calls*.
Half-Life Uplink scores 77 "presents" per guest second and is actually running
at **5.4 frames** per guest second: 2720 `BeginPaint`/`EndPaint` pairs, each
issuing about fourteen `SetDIBitsToDevice`/`BitBlt` calls. For a GDI app the
frame counter is `BeginPaint`/`EndPaint`; for a DirectDraw app it is `Flip`, or
`$dx_present` (`dx_trace` kind 5) if it presents by blitting. Reading the blit
sum as a frame rate inflates every GDI app by an order of magnitude and would
have put Half-Life at the top of the battery-waste list it does not belong on.

**`pacing-census.js` runs `run.js` twice and prints only at the end.** Each
subrun gets its own `--timeout`, so `--timeout=520` can take 1040 s, and an
outer `timeout -s KILL 600` produces **zero lines** rather than partial output —
indistinguishable from a crash. Budget the outer kill at twice the inner one, or
lower `--max-batches` for slow apps.

**A killed run reports the batches it ASKED for, not the ones it reached** — and
that turns the warmup subtraction into fiction. `pacing-census.js` derives its
steady window as (full run − warmup run); when the full run is SIGKILLed by its
timeout before it overtakes the warmup run, `batches` still reads 8000, so the
window looks valid while the API delta is negative. StarCraft at
`--batch-size=100000` printed **"steady state … −295,083 API calls
(−268.3/guest-s)"** — a number that reads like data and is an artifact of
subtracting a longer run from a shorter one. The tool now refuses the window and
says why (killed run / negative delta / same end batch) instead of printing it.
The underlying rule is general: **check that the full arm actually got further
than the warmup arm before believing any delta.**

**Pin the wasm for a multi-app sweep.** `run.js` auto-builds, so a sweep of ten
apps on a contended tree rebuilds ten times and each rebuild is a chance to pick
up another lane's half-finished edit. Build once, then pass
`--no-build --wasm=/path/to/pinned.wasm` to every run: the sweep gets faster and,
more importantly, every app in it is measured against the *same* emulator.

**The shared working tree can break the build under you.** Two apps in this
survey (`aoe2`, `mcm`) first reported 0 API calls with an empty histogram; the
cause was another lane's uncommitted region-map work (`region layout MISMATCH`,
then `$TV_IMAGE_TABLE cannot be allocated at 0x1C000000`), not the app. Both
reran clean minutes later. A row of zeros deserves a look at stderr before it
becomes a verdict.

## Results

Rates are steady-state, per guest second, at the default 200 ms/batch unless
noted. "presents" is the sum of the presentation-boundary APIs
(`Flip`/`Blt`/`BltFast`/`Unlock`/`StretchDIBits`/`BitBlt`); where a game has a
true frame counter (`Flip`) it is quoted separately.

| app | bucket | evidence | conf | cap verdict |
|---|---|---|---|---|
| **dxball** | **CLOCK_LIMITED (~59 Hz)** — *was FRAME_LOCKED, corrected; see [the correction](#correction-dxball-is-clock-limited-not-frame-locked) and [docs/re-notes/dxball.md](re-notes/dxball.md)* | It has a real `while (timeGetTime() - last < 17)` limiter at `0x00402286` (17 ms = **58.8 fps**) that the **default headless clock defeats**: at 200 ms of guest time per batch the delta is always already past 17 ms, and the spin body is hit **0 times**. Give it a 1 ms clock and 100x the ops and it saturates at **58.67 frames per guest second** against its 58.82 design cap, burning 47.3M spin iterations to hold there. The lock-pause A/B below is still a correct measurement of the *simulation* — it advances per limited frame, not per millisecond — but "ignores the clock" was wrong. Original evidence: pause added **72.8%** of guest time (3,217,936 ms over 201,121 presents) and the run was **byte-identical** — same 215,051 API calls, same 199,620 present ops, 0/307200 px at all 3 sampled batches, identical PNG file sizes. **Positive control passed**: within the unpaused arm the same three captures differ from each other by 36.0% and 44.9% of pixels (max channel delta 255, a 640x323 playfield), so the game is demonstrably *moving* — it simply does not care what the clock says. Steady state: 310,748 `BltFast` per 1100 guest-s against a `PeekMessageA` pump of only **2.5 passes/guest-s** — i.e. **~113 sprite blits per frame**, and since the `BltFast`-to-primary path calls `$dx_present` (`09a8-handlers-directx.wat:3779,3924`), **~113 presents per frame**. The "two `timeGetTime` reads per pass" are `0x402270` and `0x402295`, the limiter's own head and commit — 303 hits each in a 3000-batch run. | **high** (both the limiter and the frame-locked simulation are now disassembled) | **safe to cap at display refresh** — that *is* its own design point. Do not cap it below refresh. |
| marbles | CLOCK_PACED | Lock-pause A/B **DIFFERS** at all three sampled batches (0.71-0.88% px, a ~70x83 object at a different position) on a 7.2% dose; positive control passes (the off arm moves 0.71% between its own captures). Steady state: 2297 `Flip` / 1100 guest-s = **2.09 frames/guest-s**, with `timeGetTime` 4594 + `GetTickCount` 2297 = exactly **3 clock reads per frame**, and 197,189 `BltFast` = **86 sprite blits per frame**. | **high** | safe |
| captain_claw_demo | CLOCK_PACED | Lock-pause A/B DIFFERS at batch 3600 (5021 px, 510x247 box) at a dose of only 0.37%. Frames **fell 330 → 264 Flips (-20%)** while the sim advanced *further* — textbook delta-timing. Steady state: Flip 622, timeGetTime 1380 + GetTickCount 674 ≈ **3.3 clock reads/frame**, PeekMessage 1.0/frame. | high | safe |
| pinball | CLOCK_PACED | Steady state (batches 2000-6000): StretchDIBits 3671, timeGetTime **1589**, PeekMessageA 791, Sleep 1. ~2.3 present ops and 1 clock read per pump pass. `run.js:2900` already documents that its physics tick only advances when two consecutive `timeGetTime` results differ. | high | safe |
| abedemo | CLOCK_PACED | Steady state: primary Lock/Unlock **1198**, timeGetTime **1196** — exactly **1 clock read per presented frame**. PeekMessage 1713, Dispatch 1054, Sleep 7. | high | safe |
| quake2_demo | CLOCK_PACED | Two-budget: presents 0.03 → **2.50**/guest-s at 10x ops (76x more frames, same guest seconds) — free-running, op-starved. Clock: timeGetTime **2750** per 1375 frames = **2.0 reads/frame**. Presents via Lock/BltFast (software GL path); OpenGL path is `wglSwapBuffers` (`docs/re-notes/quake2-demo.md:140`). | med-high | safe — and it never reaches 60 fps anyway (13.7-15.8 guest fps measured, `quake2-demo.md:476`) |
| jazz2_demo | CLOCK_PACED (with a governor — see caveat) | Two-budget: Flip 129 → **2716** at 10x ops (0.25 → 5.11 presents/guest-s). QPC/Flip constant at 4.0 → 4.6, i.e. it reads the clock a fixed number of times **per frame**. Also Sleep 2.51/guest-s and `timeSetEvent`. | med | safe for speed, **but see the governor caveat below** |
| heroes2_demo | CLOCK_PACED | Steady state: PeekMessage 6426, GetTickCount **3265** + QPC **3161** ≈ **1 clock read per pump pass**, presents 0 (static title). PeekMessage pump per `docs/re-notes/heroes2-demo.md:42`. Lock-pause INCONCLUSIVE (title presents via Blt, 0 ms charged). | med | safe |
| heroes3_demo | TIMER_PACED + CLOCK_PACED | Steady state: **Sleep 134**, timeGetTime 622, QPC 533, PeekMessage 42. A loop with a real `Sleep` in it cannot be sped up or slowed down by a frame cap. | med | free |
| diablo_demo | CLOCK_PACED (at 10x ops; unreached at the default budget) | The cleanest two-budget result in the survey. Default budget: **zero** pump, zero presents across 1100 guest-s — still in DirectSound setup and `ReadFile`. At `--batch-size=100000`, identical guest seconds: `PeekMessageA` 292/guest-s, `GetMessageA`/`Dispatch` 279.5, `timeGetTime` **279,350** against 28,033 surface Lock/Unlock = **10.0 clock reads per present**, 25.5 presents/guest-s. | high | safe |
| diablo_shareware | CLOCK_PACED | Steady state: `timeGetTime` **2016** against 144 `Unlock` (**14 clock reads per present**) and only **8** dispatches — it polls the clock and renders a fraction of a frame, the signature of a time-paced intro rather than a menu pump. Prior work measures the same shape deeper in: 10,068 `timeGetTime` against 62 Lock/Unlock pairs, 162 reads per frame (`docs/re-notes/diablo-shareware.md:2103`). | high | safe |
| starcraft_shareware | CLOCK_PACED | **Lock-pause A/B DIFFERS by 15.02% of the screen** (46148 px, a 398x241 box) at batches 5100 and 5999 — on a dose of only **0.11%** (1376 ms over 1200 guest-s). That tiny dose is enough precisely because its title animation is a `GetTickCount`-gated 100 ms counter (`starcraft-shareware.md:184`): 1376 ms *is* 14 animation ticks. Presents 82 / 1200 guest-s against **3266 clock reads** = 40 reads per present. Independently corroborated by the default-budget census: `timeGetTime` **6053** + `GetTickCount` 1146 against 391 dispatches and 182 `Unlock`, with `Sleep` 382 and DirectSound streaming underneath (1200 `GetCurrentPosition`, 729 Lock/Unlock). Outer pump ends in `Sleep(0)` (`:246`). | **high** | safe |
| mw3 | CLOCK_PACED | Never reached a live menu here (231 API calls in 5500 batches). Re-notes: `PeekMessageA` pump at `0x00559d62`, presents via `Flip`, ~1,581 queueable calls per Flip, **4.1 guest fps measured** (`mechwarrior3-demo.md:483,618`). | low-med | irrelevant — nowhere near 60 fps |
| aoe2 | CLOCK_PACED (from re-notes only) | Headless it **exits at batch 52** during CRT/locale init — a startup dialog, then quit. Gameplay evidence is prior work: three `Blt`s per frame with a CPU redraw through Lock/Unlock (`docs/re-notes/aoe2-trial.md:65`), **21.5-27.9 present fps** in real browser gameplay, interpreter-bound (`docs/aoe-performance-optimization.md:14`). | low-med | irrelevant — below 60 fps |
| worms2_demo | **stuck in asset/audio load** | Steady state has **zero** pump traffic and 4 Flips in 1100 guest-s. The whole API budget is `Enter`/`LeaveCriticalSection` (4743 each) plus a repeating `CreateFileA`/`SetFilePointer`/`IDirectSoundBuffer_Lock` cycle. Never reached a menu. | high (as unreached) | unclassified |
| fallout_demo | **stalled after DirectInput init** | 242 API calls across 1100 guest-s, zero presents, zero pump. Finished `IDirectInputDevice_Acquire` and is spinning in guest code with sporadic file opens. | high (as unreached) | unclassified |
| mcm | **exits during INI parse** | Bit-identical at 68 batches on both budget arms (so the guest exits on its own, `--max-batches` irrelevant), dominated by 702 `GetPrivateProfileStringA`. No window. | high (as unreached) | unclassified |
| halflife_uplink | MESSAGE_DRIVEN (repaint-driven menu) | Steady state: **BeginPaint/EndPaint 2720 over 500 guest-s = 5.4 real frames/guest-s**, and **zero clock reads**. The 77 "presents"/guest-s are 17340 `SetDIBitsToDevice` + 13260 `BitBlt` + 2678 `StretchDIBits` — **14 blits per frame**, not 14 frames. Pump is mixed: PeekMessage 30.6 + GetMessage 15.0 per guest-s. Re-notes: MFC `PeekMessageA` pump at `0x459554`, **~1.2 fps** in-game on Safari (`half-life-uplink.md:154,262`). | med | irrelevant — 5.4 fps, cap never binds |
| aoe1 | MESSAGE_DRIVEN (idle menu) | Steady state: blocking `GetMessageA`/`DispatchMessageA` at **3.71/guest-s**, presents collapsing 0.13 → **0.04**/guest-s, clock 0.04/guest-s. `TextOutA` onto a DirectDraw surface DC. A static menu waiting for input — not the gameplay loop. | med | cap irrelevant in this state |
| diablo2_demo | CLOCK_PACED | The healthiest app at the default budget. Steady state: **227 `Flip`** + 450 `Blt` per 1100 guest-s (**1.02 presents/guest-s**) against `GetLocalTime` 906 + `GetSystemTime` 901 + `GetTickCount` 493 + `QueryPerformanceCounter` 225 = 2525 clock reads = **11 clock reads per frame**, with QPC in the loop. An animated intro/menu, not gameplay. | high | safe — and 1 fps, so a cap never binds |
| caesar3_demo | **stalls at startup** | **50 API calls** in 1100 guest-s: `CreateFileA`/`SetFilePointer`/`GetCurrentDirectoryA` and three `TextOutA`, with a single `timeGetTime` and a single `BltFast`. Opens a window, paints twice, probes files and CWD, then makes no further progress. Not a pacing loop at all. | high (as unreached) | unclassified |
| gta2_demo | **spins, does not present** | Steady state is exactly three APIs repeating: timeGetTime 22000 = PeekMessageA 22000 = `IDirectInputDevice_GetDeviceState` 22000, **presents 0**. Waiting on device state that never arrives. | high (as a spin) | a frame cap does nothing; this is a **separate** battery bug |
| total_annihilation_demo | **spins, does not present** | GetTickCount **8021** over 5500 batches (7.3/guest-s), 3 surface unlocks in the whole run, presents 0. | high (as a spin) | ditto |
| ski32 | MESSAGE_DRIVEN + clock-read | Steady state: blocking `GetMessageA`/`DispatchMessageA` 3005 and `GetTickCount` 3005 over 1100 guest-s — **exactly one clock read per message**, 2.73/guest-s. Presents 3.56/guest-s (3916 `BitBlt`), plus 8712 `TextOutA`. Parked in `GetMessage`, so the park-sleep already covers it. | high | cap irrelevant |
| cave_story | CLOCK_PACED (op-starved) | Two-budget is dramatic: at the default budget it retires **393 batches** and never leaves sound-buffer init (0.24 presents/guest-s); at `--batch-size=100000` it runs all 8000 with a live loop — 71,500 `Blt` (65/guest-s), `PeekMessageA` 10/guest-s, `GetTickCount` 5 + `timeGetTime` 5 = **10 clock reads/guest-s against 5 pump passes** (2 per frame). | med | safe |
| tetrinet | **spins, does not present** | Steady state is `PeekMessageA` 112,245 = `TranslateMessage` = `DispatchMessageA`, **102 pump passes/guest-s**, and **zero** presents and **zero** clock reads. A hot idle-menu spin. | high (as a spin) | cap does nothing; **separate battery bug** |
| blobby_volley | **anomalous — needs a browser measurement** | Steady state is exactly `BitBlt`=11000 and `GetPixel`=5500 over 5500 batches — **precisely 2 blits and 1 GetPixel per batch** — with zero clock reads and no pump, and the 10x-ops arm is **byte-identical**. Not op-starved and not clock-paced; something else quantizes it. Note CLAUDE.md measures this app at **59 game fps / 100% throttled** in a real browser, so its headless shape is not its browser shape. | low | **unresolved — measure in-browser** |
| liquid_war | **stuck loading** | Zero presents, zero pump; steady state is `Enter`/`LeaveCriticalSection` + `ReadFile` with `wait_multiple` at 20 host calls/guest-s. Never drew. | high (as unreached) | unclassified |
| generally | MESSAGE_DRIVEN (file-browser UI) | Steady state: `PeekMessageA` 4402 (4/guest-s) but only 170 `Blt` total and 0.21 presents/guest-s; the work is `SetRect`/`lstrcmpiA`/`FindNextFileA`. A static UI. | med | cap irrelevant |
| sol, freecell, taipei, spider, and the rest of the GDI card/board set | **MESSAGE_DRIVEN** | sol steady state is literally `GetMessageA=1000, DispatchMessageA=1000` over 2000 batches and **nothing else** — parked in `GetMessage`, zero `PeekMessage`, zero clock reads, zero presents. freecell/taipei/spider identical in shape (GetMessage only, no PeekMessage). | high | **cap irrelevant** — already fixed by park-sleep |

### The Jazz 2 caveat, which is the one real trap

Jazz Jackrabbit 2 runs a one-time benchmark at startup and **downgrades its own
assets when it measures a low frame rate**: the comparison at `0x0045d2df`
selects low-resolution movies when the doubled measured FPS is below 25, and we
currently measure 1, so it picks `Logolq.j2v` (320x200x8) over `Logo.j2v`
(640x480x8) — `docs/re-notes/jazz2-demo.md:144`.

A frame cap does not change Jazz 2's *speed*, but it does change a number the
game reads and makes decisions on. Any game with a startup FPS governor must not
be capped during its benchmark. This is an argument for capping at the
presentation seam only after the app has settled, or for excluding the first N
seconds.

## Correction: dxball is clock-limited, not frame-locked

The first version of this census classified DX-Ball as the survey's only
FRAME_LOCKED title. That was challenged on the obvious ground — *"so it runs
faster on a faster computer? there must be some limit"* — and the challenge was
right. Full disassembly and API map: [docs/re-notes/dxball.md](re-notes/dxball.md).

**What it actually does.** `0x00402240` is `WaitFrame(n)`, with a hardware arm
and a software arm:

```
00402270  call 0x40db20              ; now = GetTimeMs()   (303 hits)
00402275  mov  ecx, [0x4349c4]       ; last frame time
0040227f  add  ecx, 0x11             ; last + 17 ms  ==  58.8 fps
00402284  jbe  0x402295              ; already elapsed -> don't wait
00402286  call 0x40db20              ; SPIN until it has            (0 hits!)
00402293  jnb  0x40227f
00402295  call 0x40db20
0040229b  mov  [0x4349c4], eax       ; last = now          (303 hits)
```

That is the exact `while (timeGetTime() - last < N)` shape a frame limiter has.
The two clock reads the original census saw "per pump pass" are `0x402270` and
`0x402295` — **they are the limiter**, not an ignored stats counter.

**Why the census missed it.** At the default `--tick-ms-per-batch=200`, guest
time jumps 200 ms per batch, so `now - last >= 17` is already true on the first
read and control never reaches the spin at `0x402286`. Three runs, same 3000
batches, `--count` on those addresses:

| arm | `0x402286` (spin) | `0x402295` (frames) | guest-s | frames/guest-s |
|---|---|---|---|---|
| default (200 ms/batch) | **0** | 303 | 600 | 0.51 |
| `--tick-ms-per-batch=1` | 88,658 | 36 | 3 | 12.0 |
| `--tick-ms-per-batch=1 --batch-size=100000` | 47,347,690 | **176** | 3 | **58.67** |

Given a realistic clock and enough ops it pins itself at 58.67 frames per guest
second against its own 58.82 design cap — within 0.3% — and goes no higher.

**Why it doesn't use vsync either.** `0x0040adb0` times 32
`IDirectDraw::WaitForVerticalBlank` calls at startup and sets "vblank really
blocks" only if they took more than 400 ms. On real hardware that is ~533 ms at
60 Hz. **Headless it measures under that at both clock rates** (see item 2 of
the correctness list below — our `WaitForVerticalBlank` does park, so why is
still open), and the game correctly concludes there is no usable vsync: it
disables the `Flip` path
(hence **zero `Flip` calls**, all presentation via `BltFast`) and falls back to
the software limiter above. The trace shows exactly 32 `WaitForVerticalBlank`
calls in a whole run, all with `ret=0x0040adcb` — all from that one benchmark.

**Which of the two defeats applies where.** The clock defeat is a *headless
artifact only*: `host.js:223 _guestTickMs` derives the browser guest clock from
real elapsed wall time, so in the browser the 17 ms limiter engages and DX-Ball
should already be sitting near 59 fps on its own. The vsync defeat applies in
**both** hosts, but it is benign — it only routes the game onto its own
software limiter, which is the same 58.8 Hz.

**What this changes.** The FRAME_LOCKED count goes to **zero**. The simulation
is still frame-locked (it advances once per limited frame — that is what the
lock-pause A/B measured, and that result stands), but the frames themselves are
clock-limited to display refresh, so a 60 Hz cap is *what the game asks for* and
cannot change its speed. Only a cap **below** refresh would slow it.

**The general lesson, and it is the census's most transferable one:** a game that
reads the clock and appears to ignore the result is the signature of a limiter
the batch clock defeated, not of a game that ignores time. Before writing
FRAME_LOCKED, disassemble what the reads are compared against.

## Clock sensitivity: dxball was not the exception, it was the first case

The dxball correction raised an obvious follow-up — *if the default headless
clock defeated one frame limiter, how many others is it defeating?* — so every
already-classified app was re-run through the new `--clock-sweep` mode: same
3000-batch budget, once at 200 ms of guest time per batch and once at 1 ms,
compared per batch.

**The answer is: most of them.** Eight of the twenty-two apps that reached any
loop turned out to have a frame limiter that the default clock disables.

| app | frames (1ms / 200ms) | clock reads per frame | verdict | what the limiter is |
|---|---|---|---|---|
| **dxball** | 0.018 | **8000x** | LIMITER | disassembled: `while (timeGetTime() - last < 17)` at `0x00402286` |
| **abedemo** | 0.116 | **6354x** | LIMITER | `timeGetTime` **2,405 → 1,772,728** in the same 3000 batches |
| **pinball** | 0.012 | **954x** | LIMITER | `timeGetTime` 139 → 1634 while `StretchDIBits` 936 → **2** |
| **halflife_uplink** | 0.48 | **224x** | LIMITER | `timeGetTime` **2,791 → 624,737**; frames halve |
| **captain_claw_demo** | 0.025 | **105x** | LIMITER | `GetTickCount` 263 → 2133, `BltFast` 5044 → 6 |
| **diablo2_demo** | 0.057 | **11.3x** | LIMITER | `GetTickCount`-gated |
| **starcraft_shareware** | 0.671 | **9.2x** | LIMITER (sleeps) | `Sleep` 31 → **754**, `PeekMessageA` 68 → 767 |
| **marbles** | 0.000 (`BltFast` 61,901 → 2) | n/a | LIMITER (sleeps) | `Sleep` **0 → 375** appears only at the low tick |
| diablo_demo | 0.006 | 1.0x | TIME_STARVED | everything fell by the same 166x |
| jazz2_demo | 0.356 | 0.82x | TIME_STARVED | `timeSetEvent` multimedia timer |
| ski32 | 0.079 | 0.59x | TIME_STARVED | `SetTimer`/`WM_TIMER` |
| aoe1 | 0.581 | 1.80x | TIME_STARVED | idle menu |
| heroes2_demo | **3.2** | 2.7x | MORE frames at 1 ms | `GetTickCount` 2,014 → **31,236**; its title animation only advances properly at a realistic clock |
| cave_story | 1.0 | 2.3x | SPIN_AMPLIFIED | never reached its loop at this budget |
| quake2_demo | 1.0 | 1.58x | SPIN_AMPLIFIED | counters tiny; no loop reached |
| sol | 1.0 | 1.0x | CLOCK_INSENSITIVE | `BitBlt` 41 in both arms |
| blobby_volley | 1.0 | 1.0x | CLOCK_INSENSITIVE | byte-identical arms |
| tetrinet, total_annihilation_demo, generally, heroes3_demo, diablo_shareware | 1.0 | 1.0x | — | did not reach a pacing loop at 3000 batches |
| gta2_demo | — | — | **EXITS** | see the correctness list below |

### What this means, and what it does not

**It does not mean we run these games too fast for users.** The browser's guest
clock is derived from real elapsed wall time (`host.js:223 _guestTickMs`), so
every one of these limiters engages in the browser. The defeat is a property of
the **headless harness**, whose clock advances 200 ms per batch — 12 display
frames — so any `now - last < 17` test passes on its first read.

**It does mean every headless present rate in this document was measured with
the game's limiter switched off**, including the ones above the correction. That
is exactly why the census's conclusion is stated as presents *per frame*: the
per-frame amplification is clock-rate independent, and the per-second figures
are not.

**And it means the battery finding is different from the one we went looking
for.** These games do not sleep to hold their frame rate; they *busy-wait on the
clock*. Abe's Oddysee issues **1.77 million `timeGetTime` calls in three guest
seconds** to pace itself, DX-Ball burns 47.3 million spin iterations for the
same three, and Half-Life Uplink spends 208 clock reads per batch. In the
browser, where the limiter really engages, that spin is real CPU held at 100%
while the machine has nothing to do. Recognising a guest that is spinning on the
clock and parking it until its own deadline is worth far more than capping
frames — and unlike a cap it is behaviour-preserving by construction, because
the guest is by definition waiting for a time it has already named.

### Correctness list: where a clock really does change behaviour

Three items, and only the first is confirmed:

1. **Headless runs execute frame-limited games unlimited.** Any PNG capture,
   frame hash, present rate or "does it animate" judgement taken at the default
   `--tick-ms-per-batch=200` is taken from a game whose limiter never fires. For
   pass/fail this is usually harmless; for anything about *pacing* it is the
   measurement, not the app. Sweep the clock before believing a pacing number.
2. **DX-Ball's vsync calibration comes in under its threshold at both headless
   clock rates.** It times 32 `IDirectDraw::WaitForVerticalBlank` calls and
   needs >400 ms to enable its hardware `Flip` path; headless it measures under
   that at 200 ms/batch *and* at 1 ms/batch (32 calls, 0 `Flip`, both arms), so
   it always takes the software path. Our `WaitForVerticalBlank` is not a stub —
   it parks on `yield_reason=13` and `run.js:7999` charges the owed guest
   milliseconds — so *why* 32 parks measure under 400 ms is **unresolved**; the
   likely cause is several parks collapsing inside one batch. The browser wakes
   that park on a real `rAF` instead, so DX-Ball may well take the *hardware*
   path there and behave differently from every headless capture of it. Needs a
   browser measurement.
3. **`gta2_demo` exits during startup at a realistic clock.** At
   `--tick-ms-per-batch=1` it runs `GetTickCount / Sleep(0x1f4) / GetTickCount`
   at `0x00bf5726` and then goes straight to `SetUnhandledExceptionFilter` and
   `ExitProcess` — 186 batches, exit code 0, no window. At 200 ms/batch the same
   probe passes and it runs to 3000 batches. A 500 ms calibration that quits
   when the elapsed time looks wrong is a startup gate we can fail; in the
   browser the `Sleep` is real wall time so it probably passes, but that is an
   inference, not a measurement.

### A harness trap the sweep exposed

`run.js --stuck-after=N` (default 10) ends a run after N batches at the same
EIP. It is a *harness* behaviour, and it does not fire equally in both arms: an
app parked in `GetMessage` is waiting for a timer that, at 1 ms of guest time
per batch, is 200x further away, so the low-tick arm trips it and the high-tick
arm does not. Solitaire ended at **39 batches against 3000** that way, which
then read as "77x more frames per batch at the low tick" — an artifact of
dividing by 39. `--clock-sweep` now passes `--stuck-after=100000000` to both
arms unless the caller set one; with that, sol is correctly `CLOCK_INSENSITIVE`
(41 `BitBlt` in both arms). ski32 and diablo2 were re-run for the same reason,
and diablo2 flipped from `SPIN_AMPLIFIED` to `LIMITER_ENGAGED` once its low-tick
arm was allowed to finish.

## Bottom line

Of the apps that reached a classifiable state:

- **0 FRAME_LOCKED.** The one candidate, dxball, turned out to have a 58.8 Hz
  software limiter that the default headless clock defeats (see the correction
  above). Its *simulation* is frame-locked, but its frames are clock-limited to
  display refresh.
- **15 CLOCK_PACED / CLOCK_LIMITED** — dxball, marbles, captain_claw, pinball,
  abedemo, quake2, jazz2,
  heroes2, diablo x2, starcraft, mw3, aoe2, diablo2, cave_story. Capping frames
  cannot change their speed: their simulation is a function of the clock, and the
  clock is not what a frame cap touches.
- **1 TIMER_PACED** — heroes3, a real `Sleep` in the loop. Cap is free.
- **~30 MESSAGE_DRIVEN** — the GDI card/board/puzzle set plus halflife_uplink's
  menu, aoe1, ski32 and generally. Parked in `GetMessage`; park-sleep already
  handles them and a cap is irrelevant.
- **3 that spin without presenting** — gta2, total_annihilation, tetrinet.
- **1 anomaly** — blobby_volley, whose headless shape (exactly 2 blits per batch,
  immune to a 10x op budget) does not match any bucket and does not match its own
  browser behaviour either.
- **8 never reached a pacing loop** — worms2, fallout, aoe2, mcm, liquid_war,
  deus_ex, icewind_dale, caesar3.

And, from the clock sweep that followed:

- **8 of the 22 apps that reached a loop have a frame limiter that the default
  headless clock disables** — dxball, abedemo, pinball, halflife_uplink,
  captain_claw, diablo2, starcraft (sleeps), marbles (sleeps). All eight engage
  in the browser, where the clock is real; the defeat is a property of the
  harness, not of what users run.
- **4 are time-starved rather than limited** — diablo_demo, jazz2, ski32, aoe1:
  frames and clock reads fall together, which is the signature of "less guest
  time passed", not of a limiter.
- **1 renders *more* at a realistic clock** — heroes2's title animation.
- **1 exits at a realistic clock** — gta2's startup timing probe.

### The finding that actually decides this

**Not one measured app is producing frames faster than the display. The waste is
presents *per frame*, not frames per second.**

Once the blit-versus-frame confusion is cleared up (see Traps), every app in this
survey turns out to run its main loop between **2 and 6 frames per guest
second** — dxball 2.5, marbles 2.09, cave_story 5, halflife_uplink 5.4, ski32
2.7. What is enormous is the number of presentation events each frame costs:

| app | frames/guest-s | present events/guest-s | amplification |
|---|---|---|---|
| dxball | 2.5 (`PeekMessage` pump) | 283 (`BltFast`, each calling `$dx_present`) | **113x** |
| marbles | 2.09 (`Flip`) | 179 (`BltFast`) | **86x** |
| halflife_uplink | 5.4 (`BeginPaint`) | 77 (`SetDIBitsToDevice`+`BitBlt`) | **14x** |

(DX-Ball's frame row is confirmed independently by the limiter hit count: 303
frames against 29,376 `BltFast` in a 3000-batch run = **97 blits per frame**, the
same figure by a different counter. The amplification is what matters and it is
clock-rate independent; the absolute frames/guest-s figure is not — see the
correction.)

A display-refresh cap on *frame production* has nothing to bite on here. The
guest is not making too many frames; it is making one frame out of a hundred
separate presentation calls, each of which currently runs the full `$dx_present`
path (`09a8-handlers-directx.wat:3779,3924` are the `BltFast` ones).

**Caveat, stated plainly:** these are *guest*-second rates on the headless
batch clock, and guest seconds are not wall seconds. This census can classify
*how* an app paces itself — which is what was asked — but it cannot say whether
that app exceeds 60 fps on real hardware. Per CLAUDE.md we do not quote fps from
headless runs at all. The one real browser data point we have is Blobby Volley at
**59 game fps, 100% throttled**, which is already at the ceiling; the heavy
titles are documented far below it (AoE 21.5-27.9 present fps, Quake II
13.7-15.8, MW3 4.1, Half-Life ~1.2). So the population a cap could bind on is,
at best, the cheap 2D games — and the burden of proof that any of them exceeds
refresh is a browser measurement nobody has taken yet.

### Default on, or default off?

**Default off, opt in per app** — the opposite of the proposed default-on.

Taken alone, the bucket census now supports default-on even more strongly than
before: the exception set is **empty**. Nothing measured here would be slowed by
a cap at display refresh, and dxball — the one title that looked like an
exception — turns out to be *asking* for exactly that cap in its own code.

The reason to answer the other way anyway is not the exception set. It is that
**the cap addresses a problem the measurements do not find**. No app here
produces frames faster than a display; they produce 2-6 frames a second, each
costing up to 113 presentation events. A cap on frame production would recover
almost nothing from the apps that are actually expensive. Shipping a default-on
mechanism that binds on nothing is cost without benefit, and it is one more
behaviour to debug when an app misbehaves.

Four further reasons the default should be off:

1. **The classification is per *state*, not per app.** Diablo's intro is clock-
   paced and its menu behaves differently; StarCraft's title screen and its
   gameplay have different present rates by two orders of magnitude. An app-level
   flag cannot express that, and every "safe" verdict above is a verdict about
   the state we could reach headlessly.
2. **Jazz 2 reads its own frame rate and changes behaviour.** A cap is not
   guaranteed to be behaviour-preserving even when it is speed-preserving.
3. **The measured win is available without a cap, and is bigger.**
   `_presentDxIfDirty` already discards redundant *uploads*; what remains is the
   guest-side `$dx_present` path running 113 times per DX-Ball frame. Coalescing
   presents within a frame is behaviour-preserving for frame-locked and
   clock-paced apps alike, needs no per-app flag, and targets a 113x factor
   rather than a 2-6 fps one.
4. **Three apps burn CPU while presenting nothing at all** (gta2,
   total_annihilation, tetrinet — the last at 102 pump passes per guest second
   with zero draws). A frame cap cannot help an app that draws no frames. These
   are worth more than the cap is.

Recommended shape if a cap is built anyway: `framePacing: 'cap60' | 'free'` in
`lib/apps.js`, default `'free'`, opt in per app after that app has been measured
in a browser — `lib/apps.js` has no pacing flag today, so this is new surface.

### Biggest battery-win candidates, in order

Note that none of these is a frame-count problem, which is the census's main
result:

0. **Park a guest that is spinning on its own clock.** This is the largest item
   and the clock sweep is what found it. Eight of the twenty-two apps hold their
   frame rate with a busy-wait, not a `Sleep`: at a realistic clock Abe's
   Oddysee issues **1.77M `timeGetTime` calls in three guest seconds**, DX-Ball
   burns **47.3M** spin iterations, Half-Life Uplink runs 208 clock reads per
   batch, Pinball 0.55. In the browser — where the limiter really does engage —
   that is CPU pinned at 100% doing nothing but re-reading the clock. A guest
   sitting in a tight loop whose only host calls are clock reads has named its
   own deadline; parking it until then is behaviour-preserving by construction,
   needs no per-app flag, and applies to every one of those eight.
1. **dxball** — ~113 `$dx_present` calls per frame (283/guest-s against a 2.5/s
   pump). A frame cap buys nothing here because the game already caps itself at
   58.8 Hz; the fix is coalescing presents, since it presents once per sprite
   `BltFast`. Note also that its limiter is a **busy-wait**, not a `Sleep`, so
   holding 59 fps costs 47.3M spin iterations per 3 guest seconds — recognising
   that spin and parking it is a second, independent battery win.
2. **marbles** — same shape, 86 `BltFast` per `Flip`. It already has a real
   `Flip` marking the frame boundary, so the coalescing target is unambiguous.
3. **tetrinet** — 102 `PeekMessage`/`Translate`/`Dispatch` passes per guest
   second at an idle menu, zero presents, zero clock reads. Pure spin.
4. **gta2_demo** — 20 `timeGetTime` + 20 `PeekMessage` + 20 DirectInput polls
   per guest second, zero presents. Spinning on device state that never arrives.
5. **heroes2_demo** — 6426 `PeekMessage` and 6426 clock reads per 1100 guest
   seconds on a **static title screen** with zero presents.
6. **total_annihilation_demo** — 7.3 `GetTickCount`/guest-s, zero presents.

Items 3-6 are all the same bug class — an unparked spin loop that names no
deadline, so `_parkedSleepMs()` never sleeps — and together they are a larger
and safer battery win than the cap this survey was asked to evaluate.

## Spin parking

Items 3-6 above are implemented. A guest that busy-waits inside `timeGetTime`,
`GetTickCount` or `PeekMessage` is now **parked inside the API call** until the
thing it is waiting for can have changed, instead of being handed "not yet"
several million times.

Blocking inside an API call is always behaviour-legal — real Windows can preempt
a thread anywhere, and these calls in particular are where a real machine spends
its quantum — so this needs **no loop analysis at all**. It is form-blind: it
works on a limiter nobody has disassembled, which is the whole reason it is
worth doing rather than lowering each limiter by hand.

### The two detectors

Both live in `src/09a-handlers.wat` (`$clock_spin_step`, `$peek_spin_step`) over
per-instance globals declared in `src/01-header.wat` — per-instance is what makes
them per-thread, since a worker instantiates its own module over the shared
memory.

| | clock detector | empty-PeekMessage detector |
|---|---|---|
| watches | `timeGetTime`, `GetTickCount` (and the `W`/alias paths that forward to them) | the "no message" tail of `PeekMessageA`/`W` |
| K | 8 consecutive | 8 consecutive |
| resets on | a **different millisecond** | a **non-empty peek** |
| resets on | any other Win32 call in between | any other Win32 call in between |
| resets on | a different return address, or a different ESP | same |
| parks with | `yield_reason` 14, deadline = the next millisecond | `yield_reason` 15, deadline = the next timer due |

The reset rules are the whole safety argument, and each is aimed at a specific
false positive:

* **The changed-value rule** is what keeps a healthy 60 fps game out. It reads
  delta-time once a frame and sees a different millisecond every time, so it can
  never accumulate K.
* **The "no other call in between" rule** ($spin_dispatch_seq, bumped once per
  `$win32_dispatch`) is what keeps an ordinary game loop out. The normal shape is
  empty-peek → *render a frame* → empty-peek, and a frame is API calls. Without
  this rule the peek detector would park every game in the corpus on its second
  poll.
* **Return address and ESP** make it one call site at one stack depth, not a
  pump that happens to be called from two places.

There is also a progress guarantee: a clock read is parked on **at most once per
distinct millisecond**. If the host hands the guest back with the clock still
reading the same value, spinning is the honest answer until it moves — otherwise
the pair could ping-pong forever on a clock that is not advancing.

Tier 3 (learning the deadline the guest is actually counting *to*, or lowering
the loop) is deliberately not built.

### What each host does with a park

* **Browser** (`host.js`): the park is a plain parked main thread. The step's
  yield handler records the deadline (`_spinParkDelay`) and clears the yield, and
  the tail's existing `_parkedSleepMs()` turns it into a `setTimeout` — capped at
  `MAX_PARK_SLEEP_MS` (50 ms) like every other park, so a wake source we got
  wrong degrades to 20 Hz polling and never to a hang. A clock park asks for
  ~1 ms; the nested-`setTimeout` 4 ms clamp coalescing several of those is
  desirable, not a bug. Worker threads still get their slice, because the handler
  falls through rather than returning early.
* **Headless CLI** (`test/run.js`): **no guest time is charged.** The batch clock
  already advances `--tick-ms-per-batch` per batch and a park ends its batch, so
  the next batch hands the guest a new millisecond on the schedule the run asked
  for. Charging the way the vblank park does would be a distortion here rather
  than a correction — a vblank deadline is ~17 ms away and needs the lift, while
  a clock park's deadline is the *next millisecond*, which at
  `--tick-ms-per-batch=1` is exactly where the next batch lands. Paying it anyway
  would run the guest clock at two to three times the requested rate and rewrite
  every `GetTickCount` delta the app computes. The one exception is
  `--tick-ms-per-batch=0`, where nothing else would ever move the clock.

### How to verify

**At the default 200 ms of guest time per batch a spin loop never spins** — the
clock leaps past whatever the guest is waiting for on its first read (this is the
same harness artifact as the clock-sensitivity section above). Every measurement
below needs `--tick-ms-per-batch=1 --batch-size=100000`.

```bash
# the A/B: --no-spin-park is the off arm, --spin-park-k=N moves the threshold
node test/run.js --app=abedemo --max-batches=800 --tick-ms-per-batch=1 \
  --batch-size=100000 --quiet-api --no-close --frame-stats --host-census
node test/run.js --app=abedemo ... --no-spin-park

# did the batches stop because the guest was WAITING, or because it ran out of
# budget? A parked spin reports "blocking wait"; an unparked one "budget spent".
node test/run.js --app=abedemo ... --batch-stats=200
```

Read three things: the `[spin-park]` line (trip counts, per thread), `get_ticks`
in the `[host-census]` final table (the host import behind both clock APIs), and
the frame count from `--frame-stats`. **Frames are the safety number** — a park
that bought a CPU reduction by rendering less is a bug, not a win.

Measured 2026-09-01, 800 batches at `--tick-ms-per-batch=1 --batch-size=100000`:

| app | clock reads, park OFF | park ON | frames (present/flush) | wall |
|---|---|---|---|---|
| abedemo | 76,265,793 | **4,731,638** (16x) | 25 / 25 → 25 / 25, unchanged | 30.9s → 4.6s |
| halflife_uplink | 39,647,743 | **6,354** (6200x) | 0 / 1 → 0 / 1, unchanged | 14.1s → 2.0s |

And 2000 batches on the app the sweep turned up on its own:

| app | API calls, park OFF | park ON | frames (present/flush) | wall |
|---|---|---|---|---|
| captain_claw_demo | 48,582,714 | **503,621** (96x) | 10,414 / 5,328 → 10,412 / 5,327 (−0.02%) | 197s → 71.9s |

Captain Claw is the strongest single result: presents agree to two frames out of
ten thousand while 99% of its API traffic disappears. At 500 batches the same
pair is exact — 163 presents in both arms against 32,641,596 vs 216,366 calls.

`--batch-stats=200` on abedemo: after boot, **500 of 500 batches stop on
`blocking wait`** and retire one block each — the steady state is exactly
"eight reads, park, next millisecond".

Abe's residual 4.7 M reads are all in the first ~200 batches, where the app is
still loading and the clock genuinely moves between reads; the detector correctly
does not fire there.

### Where the detectors do not fire, and why that is right

| app | trips | why |
|---|---|---|
| sol, blobby_volley, diablo_demo, jazz2_demo | 0 clock, 0 peek | the healthy set — checked at both 200 ms and 1 ms per batch |
| heroes2_demo | 5 clock, 0 peek | its pump does real work between polls, so the "no other call in between" rule resets the run every time |
| gta2_demo | 0 | its `GetTickCount`/`Sleep`/`GetTickCount` startup probe is untouched: byte-identical exit, API count and register dump in both arms, at 1 ms *and* 200 ms per batch |

**K is the whole knob, and heroes2 shows how sharp it is.** Its clock reads come
in runs of three to seven, so K=8 sees five trips over 1500 batches, while
`--spin-park-k=3` sees 1127 and `--spin-park-k=2` sees 1342 — and its API count
falls from 28,577 to 9,248 to 6,221 across those three arms. A 4.6x reduction is
sitting behind a lower K. It is **not** taken, because a run of two identical
reads is not evidence of a busy-wait and nothing in that measurement checked what
happened to its frames. K=8 is chosen to be boring; `--spin-park-k=N` exists so
the question can be re-opened per app with a frame count beside it.

**The empty-PeekMessage detector is the weaker half of this, and it is worth
being precise about why.** The empty-peek path in `09a5-handlers-window.wat`
*already* set `yield_flag` before any of this existed, so an empty peek has
always ended the guest slice. Two consequences: an empty peek can never repeat
inside one batch, so the run has to accumulate across batches; and in the CLI a
peek spin was never burning much anyway. The cost it addresses is browser-side —
`yield_flag` there ends the slice and the drive loop reposts at **zero delay**,
which is a full-CPU spin, and the park converts that into a sleep bounded by
`next_timer_due_ms`. No app in the corpus reaches a pure peek spin in a state
this harness can drive to (`tetrinet` exits after 32 batches, `gta2_demo` after
4), so the peek half is covered by `test/test-clock-spin-park.js` and by the
detector's own reset rules rather than by an app measurement.

## Unresolved

These did not reach a classifiable state headlessly and are recorded as
unmeasured rather than guessed:

- **deus_ex_demo** — died during CRT init at batch 2529, no window, no pump.
- **icewind_dale_demo** — never left asset loading; the entire run is
  refcounting and `ReadFile`.
- **mw3** — got a D3D device up but retired only 231 API calls over 5,500
  batches; classification is from `docs/re-notes/mechwarrior3-demo.md`.
- **gta2_demo** — hung on DirectInput before reaching gameplay.
- **worms2_demo, fallout_demo, aoe2, mcm, liquid_war, caesar3_demo** — reached a
  state, but not a classifiable one; see their table rows for exactly where each
  stopped.
- **diablo_demo at the default budget** — unreached, but classified from its
  10x-ops arm, which is a real measurement of the same app in the same guest
  seconds.
- **starcraft_shareware at `--batch-size=100000`** — discarded, not recorded: the
  run never finished warmup, and the census printed a negative steady-state count
  from the empty window (see the Traps section).

Roughly a third of the scoped list never reached a pacing loop headlessly. That
is worth stating plainly: this census describes the states we could reach, and
several verdicts above are about a menu or an attract screen rather than about
gameplay.

## Reproducing

```bash
# per-app pacing census, startup excluded
node tools/pacing-census.js --app=marbles --max-batches=8000 --warmup=2500 --timeout=520

# same guest seconds, 10x the ops
node tools/pacing-census.js --app=jazz2_demo --max-batches=8000 --warmup=2500 -- --batch-size=100000

# presentation back-pressure A/B with screenshot diffs
node tools/lock-pause-ab.js --app=dxball --max-batches=6000 --pause-ms=16 --timeout=420

# the flag on its own
node test/run.js --app=marbles --quiet-api --max-batches=3000 --no-close --dx-lock-pause-ms=16

# clock-sensitivity sweep — run this FIRST on any new app
node tools/pacing-census.js --app=ID --clock-sweep --max-batches=3000 --timeout=260

# does a suspected frame limiter engage?  (the dxball correction)
node test/run.js --app=dxball --quiet-api --max-batches=3000 --no-close \
  --tick-ms-per-batch=1 --batch-size=100000 --count=0x402270,0x402286,0x402295

# which static call sites of a clock wrapper actually fire
node tools/caller_census.js --exe=test/binaries/candidates/dxball/installed/dxball.exe \
  --module=exe --callee=0x40db20 --app=dxball --quiet-api --max-batches=3000 --no-close
```

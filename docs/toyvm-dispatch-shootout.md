# The toy VM: comparing dispatch shells on real 16-bit programs

ASCII TLDR:

```text
A second interpreter, generated from one description into four different
dispatch shells, so the ONLY variable between builds is how control reaches the
next handler. Correctness is pinned by 8088 silicon test vectors; speed is
measured on real DOS demos, not on a synthetic loop.

  tailcall        one shared $next, return_call_indirect        baseline
  repl_tailcall   dispatch tail inlined into EVERY handler      (replicated)
  calls           call_indirect + return, loop in the caller
  switch          one giant br_table, every handler body inlined

THE HEADLINE: the synthetic microbench said the giant br_table beat
return_call_indirect by 46-49%. On ten real programs it does not -- and the
shell that actually wins is replication, which the microbench never tested.

Also measured: the min-to-max spread within one arm on this box regularly
exceeds 40%, which is larger than every difference between arms. Minima over
interleaved reps, or nothing.
```

Companion docs: [interpreter-dispatch-perf.md](interpreter-dispatch-perf.md) (what
the *production* interpreter measured, and why "fewer dispatches" is not
"faster"), [loop-microbench-harness.md](loop-microbench-harness.md) (the
synthetic harness whose numbers this contradicts),
[performance-summary.md](performance-summary.md) (the consolidated ledger).

## 1. Why a second interpreter exists

The production interpreter has one dispatch shell and cannot grow another: 426
handlers written by hand in WAT, a hash-consed API table, per-thread cache
partitions. Changing how `$next` reaches a handler means rewriting all of it,
and the two attempts already made
([interpreter-dispatch-perf.md](interpreter-dispatch-perf.md)) each cost a
worktree and measured zero against a noise band wider than the effect.

`tools/toyvm/` is the answer: an 8086/186/386 real-mode interpreter whose
handlers are *generated* from one description (`tools/toyvm/emit.js`) and
wrapped in whichever shell is asked for. Every arm runs bit-identical handler
bodies over a bit-identical op stream. The decoder lives on the host, so decode
cost sits outside the measurement entirely.

x86-16 rather than a simpler toy ISA on purpose: **flags**. The production
interpreter computes them lazily and that design has never been A/B'd against
eager computation on a real workload. A flagless toy could not have asked the
question, and 16-bit x86 comes with a ready-made correctness corpus.

## 2. Correctness first, always

`tools/toyvm/gate.js` runs the VM against
[SingleStepTests/8088](https://github.com/SingleStepTests/8088) — 323 opcode
files recorded off a physical AMD D8088. Every arm must pass before any timing
is quoted, because a dispatch difference and a behaviour difference are
indistinguishable in a wall-clock number.

```bash
node tools/toyvm/gate.js --all --limit=20                    # census, all opcodes
node tools/toyvm/gate.js --ops=00-05 --variant=switch        # one range, one arm
```

`--all` reports two numbers, implemented and correct, deliberately: a decoder
that refuses half the encodings would otherwise score 100%.

Things the corpus taught that no manual says plainly:

* `FLAGS_RESERVED = 0xF002`, `FLAGS_DEFINED = 0x0FD5` — bits 3 and 5 always read 0.
* `push sp` pushes the **already-decremented** SP (unlike 286+).
* Opcodes **0x60–0x6F alias to the sixteen conditional jumps** on an 8088.
* **D0–D3 /6 is SETMO**, not a second SHL, and the CL forms do nothing at all
  (flags included) when CL=0.
* A rotate touches only CF and OF; shifts also define SF/ZF/PF. Getting this
  wrong scored rotates at 0–53% and looked like a shift bug.
* An indirect CALL reads its operand **before** pushing the return address —
  `call sp` is the case that proves it.
* A divide error pushes the **next** instruction's address, and DIV/IDIV leave
  every flag undefined, so the pushed FLAGS word is microcode garbage.
* **DAA and DAS share one rule**, and it is not the manual's two: the high
  correction fires when `old_CF || old_AL > 0x9F || (old_AL > 0x99 && AF_in == 0)`,
  for both. Asymmetric thresholds fix one and break the other. DAS also does
  *not* take CF from the borrow out of `AL-6`.
* **`AAM 0` writes SF/ZF/PF as though the result were zero before it faults**,
  so those bits reach the handler in the pushed FLAGS word. `DIV` by zero does
  not do this.

**D8–DF are skipped, not passing.** The board had no 8087 fitted, so those
vectors record ESC as a dummy read that changes nothing, and a VM that agreed
with them would be a VM without an FPU. They were reporting 100% only because a
store lands at an address the vector does not list and unlisted memory is not
checked. `tools/toyvm/fpu-check.js` is the gate for those: 48 hand-computed
cases through the same `vm.stepOne()`, run on every shell.

## 3. The four shells

All four are in `tools/toyvm/emit.js`; `node tools/toyvm/vm.js --variant=NAME`
builds one.

| variant | dispatch | indirect branch sites |
|---|---|---|
| `tailcall` | handlers end `return_call $next`; `$next` does `return_call_indirect` | 1 |
| `repl_tailcall` | the dispatch sequence is inlined into every handler's tail | N |
| `calls` | `call_indirect` in a loop; handlers return into it | 1 |
| `switch` | one giant `br_table`, every handler body inlined as an arm | 1 |

**There is deliberately no replicated `br_table` twin.** A `br_table`'s arm
labels are only in scope at the innermost point of the block nest, so an arm
cannot re-dispatch after its own block has closed. Replicating it would take N
copies of an N-arm nest — quadratic in handler count.

## 4. The workload: real DOS demos

`tools/toyvm/run-dos.js` runs a real MZ executable on a minimal DOS/BIOS/VGA
machine (`tools/toyvm/dos.js`): a real IVT whose serviced vectors point at a
byte the decoder refuses, so the trace ends there and the host services the call
in JS. `tools/toyvm/fetch-demos.js` pulls the corpus from the Hornet archive —
small archives only, because a large one is a multi-file production with music
and external data the toy DOS layer has no interest in modelling.

```bash
node tools/toyvm/fetch-demos.js --out=/tmp/demos --max=40 --max-kb=70
node tools/toyvm/run-dos.js /tmp/demos/1994-c-copper/COPPER.EXE --png=/tmp/c.png --auto-key
node tools/toyvm/bench-dos.js /tmp/demos/*/*.EXE --dispatches=15m --reps=9
```

`--report` prints the address where the decoder gave up with a byte dump beside
it, which is the whole coverage work list in one line per site. `--auto-key`
answers a blocking console read with Enter so a headless run gets past a "press
any key" title card; a demo that reads any key as "quit" then quits, which is
its own answer about whether it can be benchmarked.

### 4.1 Eight of these demos are not writing pixels at all

Video needed no modelling for a long time, and the reason was a real property of
mode 13h: A000:0000 is inside the guest's own megabyte, one byte is one pixel,
so a demo's stores land in the same array the screenshot reads. That is true
right up until a demo clears bit 3 of the sequencer's memory-mode register.

Unchained — "mode X" — is the same four planes addressed differently. Chain-4
spreads consecutive bytes across the planes for you (`off` is plane `off & 3` at
plane offset `off >> 2`); with it off, one A000 offset names a byte in *every*
plane at once and the sequencer's map mask picks which of them a write reaches.
A demo gets a 256-colour mode with square-ish pixels, page flipping, a
four-pixel-wide fill, and a latch copy that moves four pixels without the value
passing through a register. What it does not get is a linear framebuffer, and
reading one out of A000 anyway is what made those demos screenshot as a quarter
of a picture stretched over the whole frame.

`tools/toyvm/video-census.js` answers how much of the corpus this is, and it
answers it from the registers the guest wrote rather than from the picture —
`dos.js` now models the sequencer, graphics controller and CRTC register files,
which costs nothing because those ports were already trapped:

```bash
node tools/toyvm/video-census.js --dir=/tmp/demos
```

**8 of 199 programs unchain**: ADDY_II, CARRIE, CORE-ADD, CORE-ADV, DASH,
DRAGON, DREAM and brainbug. Four more retime the CRTC without unchaining. The
register files also give the geometry for free instead of assuming 320x200. It
falls out the way the hardware derives it — vertical display end over max scan
line for the row count, horizontal display end at half the dot clock for the
width, the offset register for the logical row stride — so brainbug's 320x400
and mode 13h's own 320x200 come from one expression, and CORE-ADD turns out to
be scrolling a 640-pixel-wide logical page behind a 320-pixel window. Five of
the eight end a run with a nonzero start address, and ADDY_II's walks 0 →
16128 → 32256 as the run goes on: they are page-flipping, which is most of why
they wanted mode X in the first place.

**The guard is the cost.** Plane information only exists at the moment of the
write, so no amount of cleverness at render time can reconstruct it: the routing
has to happen in `$wr8`, in a VM whose entire purpose is measuring what a
dispatch costs. It is written as a key compare rather than a flag test so that
"are we unchained" and "is this address video memory" are the same branch —
`(lin & 0xF0000) | 1` against a control word that holds `0xA0001` while
unchained and zero otherwise. One load of a constant address, an and/or/eq, and
a not-taken branch, against a function that already calls `$lin`. The low bit is
load-bearing: two callers reset the machine with a whole-buffer `mem.fill(0)`,
and a guard that accepted 0 as a key would route the entire low 64K — the IVT,
and every COM program — into the plane store. That bug passed every demo and
failed 1,855 cases of the 8088 gate, which is what the gate is for.

The guard is identical in all four shells, so it moves every arm of the
shootout together and no ratio in §5 depends on it.

### 4.2 Three more were writing to a different shape of plane

Fixing mode X left three screenshots still wrong, and they were wrong the same
way for a different reason: ZERO-BBS.EXE is mode `0Eh` and BAGGER.EXE and
DSTNFO.EXE are mode `10h` — EGA 16-colour modes, which are planar too but at
**four bits per pixel, not eight**. A byte in a plane is eight *pixels* there
rather than one, and a pixel's colour is one bit taken from each of the four
planes. Nothing has to be unchained to get there: chain-4 is a 256-colour
feature and these modes are born planar, so a model that only watched the
memory-mode register could not see them at all. They are in `dos.js` as
`EGA_MODES` now, and each carries its own CRTC seed, so 640x200 and 640x350
come out of the same derivation as everything else.

Three things had to be real before the pictures were:

* **The whole graphics-controller write pipeline.** Mode X needs almost none of
  it — write mode 0 with an all-ones bit mask is a plain store. A 16-colour mode
  drives set/reset, the bit mask and the ALU function on nearly every store,
  because touching one pixel means a read-modify-write of a byte holding eight
  of them, and the hardware performs it. `$vga_wr8` now does the full thing:
  data rotate, the four write modes, set/reset gated by enable-set/reset,
  AND/OR/XOR against the latch, then the bit-mask merge. `$vga_rd8` gained read
  mode 1's colour compare. The control block grew from four words to the full
  nine-register file.
* **The attribute controller.** A 4-bit pixel does not index the DAC, it indexes
  16 attribute-palette registers which *then* index the DAC — and the BIOS
  default scatters them (`00 01 02 03 04 05 14 07 38…3F`), so an identity
  assumption puts eight of the sixteen colours in the wrong place.
* **`int 10h` AH=10h.** All three demos set their palette through the BIOS, not
  through port 0x3C9, which is what EGA-era code does — on an EGA the palette
  registers *were* the colours. Only the `AL=12h` DAC-block call was
  implemented, so those writes were being counted as unhandled and dropped.
  With `AL=00/02/07/10` in, all three set the attribute palette to identity and
  fill 15-16 of their 16 colours; before that, DSTNFO's info file rendered as a
  legible picture in entirely the wrong palette, which is a much more
  convincing kind of wrong than a blank screen.

`run-dos.js` prints the attribute palette and how many of the entries it names
are non-black in the DAC under any 4-bit run, because "the colours look wrong"
is two different bugs — a palette we got wrong, or one the program set by a
route we were not listening on — and that line separates them.

### 4.3 Making the harness measure the VM and not itself

The first honest run of mars.exe reported 344,376 handbacks per 40M dispatches —
103 dispatches per JS round trip. At that ratio the benchmark measures the
harness. Two caches fixed it, and neither can produce a wrong jump:

* **Shadow return stack.** A `ret` reads its target off the guest stack, so no
  arena address can be baked in. `call` records `{guest IP, arena address, CS}`;
  `ret` uses it only when the IP and CS still agree, and empties the stack on
  any mismatch.
* **Indirect-jump target cache.** Direct-mapped, keyed on `CS<<16|IP`, published
  by the host for every block head it compiles. mars dispatches into an unrolled
  span writer through a computed jump 85,655 times at one address.

Result: 198 handbacks, **203,810 dispatches apiece**. Both fall back to the old
hand-back path on a miss.

## 5. What the numbers say

Ten real DOS programs, 15M dispatches each, nine interleaved reps per arm with
the starting arm rotated, minimum of the nine quoted. Every arm's dispatch count
and frame hash agreed before any ratio was printed.

```bash
node tools/toyvm/bench-dos.js --dir=/tmp/demos --dispatches=15m --reps=9
```

| program | `tailcall` ns/disp | `repl_tailcall` | `calls` | `switch` |
|---|---:|---:|---:|---:|
| mars.exe     | 17.87 | **+9.2%**  | −5.7%  | −4.2% |
| ADDY_II.EXE  | 16.73 | **+6.7%**  | −7.1%  | −1.8% |
| COMPOVRS.EXE | 15.59 | **+8.1%**  | −3.8%  | +5.4% |
| COPPER.EXE   | 30.77 | **+6.3%**  | +1.8%  | −26.0% |
| CORE-ADD.EXE | 20.39 | +13.0%     | +2.7%  | **+15.6%** |
| CONTACT.EXE  | 16.49 | **+21.9%** | −2.3%  | −2.0% |
| DRAGON.EXE   | 16.68 | **+11.6%** | −5.3%  | +10.8% |
| ASYLUM.EXE   | 17.19 | **+13.6%** | −1.1%  | +4.3% |
| DSTNFO.EXE   | 13.77 | +6.0%      | −13.8% | **+40.1%** |
| DREAM.EXE    | 16.71 | **+10.7%** | −2.0%  | +12.3% |
| **geomean**  | — | **+10.6%** | **−3.8%** | **+4.2%** |

Three findings, in order of how much they should change anyone's mind:

**1. Replication wins, everywhere.** `repl_tailcall` is ahead on all ten
programs, geomean +10.6%, and it is the one shell the synthetic microbench never
tested. Giving each handler its own `return_call_indirect` site gives the
predictor a separate history slot per *predecessor* opcode, and in a real
instruction stream the next opcode correlates strongly with the current one. One
shared site throws that correlation away.

**2. The giant `br_table` does not reproduce its microbench win.** +4.2% geomean
against a synthetic claim of +46–49% for the same pair, and it is bimodal rather
than merely smaller: DSTNFO +40.1% with a tight 6% spread, COPPER −26.0%,
reproduced across two independent runs on different box loads. A `switch` build
inlines every handler body into one function, so what it costs depends on
whether *that* program's hot handlers still fit the engine's budgets — which is
a per-program property, not a dispatch property.

**3. `calls` is a consistent small loss** (−3.8%), which is the least surprising
line here: the extra return edge per dispatch buys nothing.

**Read the spread column before reading any of this.** Within-arm min-to-max ran
6–63% across these runs — routinely wider than the gap between two arms. That is
why the harness interleaves, rotates the starting arm, quotes minima, and prints
load average either side. A sequential arm-then-arm layout on this box would
have produced a confident number for whichever arm ran during a quiet minute.

### 5.1 None of these programs is waiting for the clock

A batch-driven guest clock is how the main emulator got fooled into reading a
perfectly good Smacker decoder as broken, so the same question has to be asked
here — and the answer is not assumable, because this harness advances **one tick
per handback**, and handbacks range from 31 dispatches (CORE-ADD) to 1.4M
(COPPER). Guest time therefore runs at wildly different speeds relative to guest
*work* depending on the program.

`tools/toyvm/clock-probe.js` settles it by running each program three times at
one dispatch budget with the clock stopped, normal and 16x, and diffing what it
drew:

```bash
node tools/toyvm/clock-probe.js --dir=demos --dispatches=15m
```

**Nine of ten are byte-identical across all three clock rates** — they never read
a clock at all, so the only thing that gets them further is more dispatches.
The tenth, mars.exe, draws a *different but equally complete* landscape at each
rate: it calls INT 1Ah exactly once and seeds its fractal terrain from the tick
count. Clock-sensitive, not clock-starved. Same 51,218 pixels lit every time.

That makes the benchmark numbers in §5 pure interpreter throughput, which is
what they needed to be.

The counters print beside the verdict and name a second thing worth knowing:
**DSTNFO polls the 0x3DA retrace bit 719,968 times** in 15M dispatches, and
CONTACT 81,600 times. A retrace wait is `in al,dx` / `test` / `jcc`, so at three
ops per poll DSTNFO spends **at least 14% of its entire budget** in a three-op
spin loop — and DSTNFO is exactly the program where the giant `br_table` posts
its +40.1% outlier. A tiny hot loop of trivial handler bodies is the one shape
where inlining every arm should win, and it is not representative of the rest of
the corpus.

(In this machine that spin is free: `portIn` toggles the retrace bit on every
read, so a wait always completes in two reads. On real hardware those polls
would block until the beam came round, which is the *other* reason none of these
are time-starved here.)

## 5.2 The whole corpus, and both JIT tiers

§5's table is ten programs picked because they run well. `tools/toyvm/sweep-dos.js`
runs **all 94**, against every version of the VM there is — the four dispatch
shells and the three JIT tiers from
[toyvm-trace-jit.md](toyvm-trace-jit.md) — one child process per program, so a
program that traps or wedges becomes a row instead of taking the sweep with it.

```bash
node tools/toyvm/sweep-dos.js --dir=/tmp/demos --dispatches=12m \
  --sample-from=0.5 --reps=5 --out=/tmp/sweep.json --md=/tmp/sweep.md
```

The shells, over the 50 programs that run at least 1M dispatches:

| shell | geomean vs `tailcall` | the 17 that lit pixels | the 33 that did not |
|---|---:|---:|---:|
| `tailcall` | baseline | baseline | baseline |
| `repl_tailcall` | **+10.5%** | **+11.3%** | **+10.0%** |
| `calls` | −4.1% | −3.4% | −4.4% |
| `switch` | +11.9% | +5.4% | +15.5% |

**`repl_tailcall` is the one result that does not move.** Ten programs gave
+10.6%, and three independent 94-program sweeps gave +9.7%, +9.9% and +10.5%.
It is the same conclusion §5 reached, now with 5x the corpus and a split that
shows it does not depend on whether the program was drawing anything.

`switch` is the opposite: +14.9%/+12.3%/+11.9% across the three sweeps, and the
pixels split pulls it apart — +15.5% on programs that render nothing against
+5.4% on programs that do. A program that renders nothing is disproportionately
one sitting in a tight spin, which is exactly the shape §5.1 already identified
as `switch`'s best case. **Do not read the corpus geomean as `switch`'s value on
a working demo**; the 17-program column is the one that answers that.

And the JIT tiers, over the 34 programs with a hot trace that survived the
padding check:

| | all 34 | 23 **distinct** traces |
|---|---:|---:|
| tier 0 → 1 (stitching) | 1.97x | 1.83x |
| tier 1 → 2 (optimizing) | 1.68x | 1.76x |
| tier 0 → 2 | 3.31x | **3.22x** |

The right-hand column is the honest one, and the reason it exists is §5.3.

### 5.3 Half the corpus shares one hot trace

Eight programs came back with a byte-identical hottest trace, and three more
shared a second one:

```
d1 ed 4a 74 f4 73 f8 33…  x8   AKM-ZORL, CMA_SHRT, CORE-ADV, RUNME2ND,
                               DASH, DIESEL, DRAGON, BKSNOTE
d1 ed 4a 74 f1 73 f5 33…  x3   MINTRO, cd2, B-STEEL
```

`d1 ed` = `shr bp,1`, `4a` = `dec dx`, `74` = `jz`: this is the LZEXE/PKLITE
bit-reader. Nearly everything in this corpus ships compressed, and the depacker
is the *same code* in all of them. A profile that starts at dispatch zero
therefore reports one decompression loop as the hot trace of a dozen unrelated
demos — and averaging that as a dozen data points is counting one loop twelve
times. `--sample-from=0.5` profiles only the tail of each program's own run and
the sweep reports shared traces explicitly, so both numbers are visible.

Two things it took a wrong answer to learn. An absolute `--sample-after=4m`
does **not** work: 27 programs never reach 4M dispatches and silently reported
no samples at all. And even profiling the back half, the depacker still wins in
eight programs — those spend more than half of a 12M-dispatch run unpacking, or
never get past it.

### 5.4 What the sweep says about coverage

Of 94 programs, 50 run ≥1M dispatches and **17 light a pixel**. That is the
real coverage number, and it is much lower than "94 programs benchmarked"
suggests. The sweep prints the corpus's own ISA to-do list, ranked by how many
programs each refused byte would unblock:

| byte | what it is | programs |
|---|---|---:|
| `0x67` | 32-bit address override in real mode | 7 |
| `0xdb`, `0xde`, `0x9b` | x87 — the VM still has none | 5, 2, 2 |
| `0x0f` | two-byte opcodes | 4 |
| `0x66` | operand-size override | 3 |
| `0xf0`, `0xfe`, `0xff`, `0x82`, `0x27`, `0xcc` | LOCK, INC/DEC r/m8, group 5, group 1, DAA, INT3 | 1–2 each |

`0x67` is the same gap §7 named, now counted: it is the single highest-value
opcode in the corpus.

**Every gap in that table has since been implemented, and the table itself was
misleading.** It ranks a *byte*, and a linear sweep decodes string tables and
runs of zeros as code, so several of these counts were data. §7 replaces it with
`opcode-census.js`, which prints the following bytes so the two can be told
apart, and §7.1 has what filling the gaps was worth on screen — which for `0x67`
was nine programs, and for x87 was none.

Three harness defects had to be fixed before any of these numbers meant
anything, and each one had been quietly producing a plausible wrong answer:

* **`.COM` files did not load at all** — 13 programs failed as "not an MZ
  executable". A `.COM` is a flat image at `PSP:0x100`; `loadExe` now dispatches
  on the signature rather than the extension, because the corpus has `.COM`
  files named `.EXE`.
* **The JIT arms answered a 16-bit port read with `0xFF`** where the
  interpreter answers `0xFFFF`. Every trace touching a word-wide port landed on
  different registers, and the agreement check correctly refused to compare
  them — reporting a harness bug as `mismatch`, which reads as an optimizer bug.
* **The padding detector missed zero-byte traces.** It caught runs of identical
  (handler, operands) pairs, but `cchop.exe`'s zeros decode to
  `add [bx+si],al` at *advancing* addresses, so the operands differ while the
  handler does not — and it scored **11.5x**, the largest speedup in the corpus,
  on decoded emptiness. Zero bytes are now sufficient on their own.

The general lesson is the one already in [CLAUDE.md](../CLAUDE.md) about
`--handler-hist`: **an arena-side profile cannot tell code from padding**, and
the biggest number in a sweep is the one most likely to be an artifact.

## 6. Reading this against the microbench

[loop-microbench-harness.md](loop-microbench-harness.md) already carries the
rule — *never quote a microbench % as an app %* — and this is a second,
sharper instance of it. The synthetic dispatch loop reported the giant
`br_table` at +46–49% over `return_call_indirect` on every shape. It measured
~100 small handlers with an inlined body per arm and a perfectly predicted
periodic op sequence. The real VM has roughly twice the handlers, much larger
bodies, and an op sequence whose next handler is genuinely hard to predict —
which is precisely the regime where a single shared branch site stops being an
advantage and replication starts being one.

## 7. Coverage: what the demos still stop on

`tools/toyvm/opcode-census.js` runs every program once and ranks the refused
bytes by how many programs each one would unblock — the leading byte alone is
not enough to name the gap, so it prints the bytes that follow as well, which is
what tells a real instruction from ASCII being decoded as code:

```bash
node tools/toyvm/opcode-census.js --dir=/tmp/demos --dispatches=12m --json=/tmp/census.json
```

On 199 programs, **31 stop on an unimplemented opcode** and 43 stop making
progress for any reason. The census's own ranked table, measured 2026-08-25:

| byte | what it is | programs |
|---|---|---:|
| `f0` | `LOCK` — but every site is `f0 0f 00 00` / `f0 62 00 00`, i.e. zeroed data | 10 |
| `ff` | group 5 `/7`, which does not exist; `ff ff`, `ff f8` — data | 5 |
| `0f` | `SGDT`, `MOV r,DR`, `LSL` — protected-mode probes, deliberately refused | 4 |
| `63` | `ARPL` — protected mode, and two sites are the ASCII of "cal", "cess" | 4 |
| `fe` | `INC/DEC r/m8` group `/2`..`/7`, which do not exist — data | 4 |
| `67` | one real site; the rest are the ASCII of "got ", "gn" | 4 |
| `62`, `f3`, `f1`, `66` | `BOUND`, a `REP` on something unrepeatable, `ICEBP`, `0f ba` | 2–3 each |

**Most of what is left is not an ISA gap.** The census exists because the earlier
sweep's ranked list — where `0x67` topped the table at 7 programs — could not
tell a refused instruction from a refused *byte*, and half of these entries are
a linear decode walking into a string table or a run of zeros. The honest
remaining work list is short: the protected-mode group behind `0f`, and the
handful of programs whose real code is behind a decryptor the trace compiler
reaches before the program has decrypted it.

### 7.1 What the two ISA rounds actually bought

Two rounds of filling gaps, each re-measured against the same 199 programs:

| | blocked | stuck | programs newly drawing |
|---|--:|--:|---|
| before | 59 | — | — |
| 32-bit addressing (`0x67` + SIB), 386 FLAGS, the `0f` extras | 42 | — | 9 |
| x87 | 31 | 43 | 0 |
| FPU environment/BCD/transcendentals, `HLT` | 31 | 43 | 0 |

The first round is the one that shows on screen: nine programs went from blank
to rendering, among them chaos386, CARRIE, MOUSETRO, UKKO and RUNME2ND, and two
more (ACME-VIC, DASH) roughly doubled their pixel count. The 386 FLAGS fix is
the reason — the VM forced bits 12–15 set, as an 8086 does, so every CPU
detection routine in the corpus concluded it was on an 8086 and took its 16-bit
path. RACE.EXE printed "386 or better not detected!!!" until `set_cpu` existed.

The x87 rounds are the opposite, and the table is more useful for saying so than
a coverage percentage would be. FNINIT is the first FPU instruction a demo
executes and it was the single commonest give-up site in the corpus, so
implementing it moved 22 programs off that wall — but **not one of them draws a
pixel it did not draw before**. Most of those sites sit on paths the trace
compiler reaches statically and the program never runs, and the ones that do run
now stop at the next wall along instead. The FPU is right (48 hand-computed
cases in `tools/toyvm/fpu-check.js`, green on all four shells) and it makes the
VM more realistic; it did not make the corpus render.

### 7.2 The 386 bit group

`0f ba` appears in the census table above at two programs, and one of them —
bit.exe — was the only site in the corpus that is unambiguously a real
instruction rather than a linear decode walking into data. The whole group is
now implemented: `0f ba /4../7` (BT/BTS/BTR/BTC with an imm8 index), the
register-index forms `0f a3/ab/b3/bb`, and BSF/BSR at `0f bc/bd`, at both
operand sizes.

The part worth writing down is the addressing rule, because getting it wrong
passes every ordinary bitmap test. A **register** destination masks the bit
index to the operand width, so `bts ax,17` touches bit 1 of AX and nothing
else. A **memory** destination does not mask: the index is a *signed bit
displacement* from the effective address, so `bt [addr],ax` with `ax = -1`
reads the top bit of the byte *before* `addr`, and with `ax = 20` reads a byte
two past the end of the addressed word. Modelling that as a byte address plus a
bit-in-byte is both exact and width-agnostic, which is why every memory form
reads and writes through `$rd8`/`$wr8` whatever the operand size says.

There is no ground truth to fetch for any of this — the SingleStepTests/8088
corpus `gate.js` runs against was recorded off a part where `0f` is `POP CS` —
so `tools/toyvm/bitops-check.js` is the substitute, in the same shape as
`fpu-check.js`: 20 hand-computed cases stepped through the real decoder and the
real handlers, including both signs of memory offset. Green on all four shells.

**It did not unblock bit.exe.** The program is PKLITE-compressed, and after the
bit group landed its only remaining give-up site is a run of `ff` padding at
`110:ffff` that it reaches by a wild far jump out of the depacker stub — a
different bug in a different layer, and the third case in this document of an
ISA fill being correct and buying no pixels.

### 7.3 159 of the 199 programs were never in graphics mode

Everything above §7.2 is about programs that reach mode 13h. That was never
most of the corpus. **159 of 199 never leave mode 3h**, and the capture path
read A000 for all of them — which in text mode holds nothing — so they all came
back as the same black rectangle, indistinguishable from a program that trapped
on its first instruction. Forty rows of the sweep were being read; the other
159 were being assumed. Two of them, ACME-SUX.EXE and AKM_DOB.EXE, went further
and reported ~61,700 "pixels" each: nonzero palette indices against a DAC
neither program ever loaded.

The fix has three parts, and only the first is about rendering.

**The text page is guest memory.** 80×25 cells of `{character, attribute}` at
`B800:0000`. The first version of the console kept that grid in a private array
fed by the DOS and BIOS teletype calls, which works on the programs that use
them — and most of these do not, because painting a text screen through
`INT 21h` is slow and the scene knew it. They store straight into B800. The
grid stayed blank for exactly the programs that had drawn the most. It is now
backed by the guest's own memory at `0xB8000`, so `INT 21h`, the BIOS and a
direct store all land in the same bytes. The surface to photograph is chosen by
`vga.bpp === 0` (never established a graphics mode) rather than by the mode
number, because a demo can retime the CRTC underneath mode 13h.

**A blocking key read with an empty queue is not AL=0.** `INT 21h AH=01/07/08`
and `INT 16h AH=00/10` block. Returning AL=0 from them is not "no key" — it is
the character NUL, delivered as though it had been typed, and every *press any
key* prompt in the corpus was answering itself. a-note.exe took the phantom key,
called `INT 10h AH=00` to restore mode 3 on the way out (which clears the
screen) and exited in 5,434 dispatches: from outside, a program that never drew
anything. A blocking read with nothing queued now sets `blockedOnKey` and stops
the run, which is both closer to the hardware and the moment worth capturing.
`run-dos.js` reports it; `shot-sweep.js` retries such a run with `--auto-key`
and keeps whichever frame has more on it.

**Then the corpus started explaining itself.** With the page visible, a class of
program appeared that had been invisible: the ones that print two lines and
stop. Seven print some version of *you need a VGA card*, and none of them was
wrong about what it had been told — `INT 10h AH=1Ah` (get display combination
code) and `AH=12h BL=10h` (EGA/VGA information) were both answered with AX=0,
which is not a null answer but precisely the *function not supported* reply an
8086-era CGA BIOS gives. Both carry their presence test somewhere unusual —
AH=1Ah proves itself by returning 1Ah in AL, AH=12h by returning BL *changed*
from the 10h it was called with — which is how a stubbed zero passes for a
considered one. About ten more sit on a sound-device menu that ignores Enter and
wants one specific character, so the harness's synthetic keystroke now rotates
`p, n, 1, Enter, space, y, a` — leading with the keys that mean *no sound*,
which is what a headless run wants in every one of these menus.

Coverage over the corpus went from 32 programs putting something on screen to
**~101**. Every one of those fixes came from reading what the demos printed, not
from reading their code, and none of them is visible to an opcode census or a
handler histogram: those programs were decoding and executing perfectly.

### 7.4 The 32-bit round, and four bugs that were not ISA gaps

§7's census called the protected-mode group behind `0f` "deliberately refused",
and that refusal was the single largest blocker left: sixteen of the twenty-seven
programs still photographing black were DOS-extended, and every one of them builds
a flat 32-bit code selector and far-jumps into it one instruction after entering
protected mode. Supporting that meant the D bit (the descriptor's default operand
*and* address size, and whether EIP is allowed past 0xFFFF), the stack's B bit as
a separate `$spm` mask, a jump-target cache keyed on the full 32-bit IP rather
than `cs<<16|ip`, and 32-bit twins for everything whose addressing is implicit
rather than modrm-driven — the port-string ops, the counted-loop terminators, the
A4–AF string ops, and XLAT.

That was the expected half. The unexpected half is that **four of the six things
actually standing between these programs and a picture were not missing
instructions at all**, and none of them is visible to an opcode census, a handler
histogram, or a decoder give-up list — the same blind spot §7.3 describes, one
layer down.

**`vm.js` masked every register read to 16 bits.** Including `gip`. In real mode
that is invisible, because the instruction pointer stays inside 16 bits on its
own; in a 32-bit code segment it is a truncation, and the host loop reads `gip`
to decide what to compile next. ACME-SYW.EXE's return to `0x11c43` became a
compile of `0x1c43`, which is a text banner sitting in its data, and the demo
"hung" 202 handbacks into a picture of its own logo — a symptom that reads
exactly like a decoder bug in the routine it was returning *from*. It was found
by noticing that `0x11c43 & 0xFFFF` is the address it was stuck at.

**The BIOS data area was never in guest memory.** `reset()` fills in the
equipment word and the conventional-memory size, and it runs *before*
`setMemory()` binds the VM's linear memory, so every byte it wrote landed in an
array nothing reads again. Dumping `0040:0010` after a run came back all zeros:
INT 11h and INT 12h had been answering 0 for their entire existence. Only
`setVideoBda` survived, and only because the guest's own INT 10h set-mode calls
it again later — which is why nothing had ever noticed. On top of that the
equipment word's coprocessor bit was clear while the x87 is real and passes
48/48, so CTSLASSE.EXE asked INT 11h, printed *"you need a coprocessor to run
this intro. do not try it with an emulator."* and exited having drawn nothing.

**A 32-bit `POP DS` moves four stack bytes.** The segment register is 16 bits
either way; the operand size decides how far the *stack* moves. Segment push and
pop had one handler each, always 16-bit, emitted whatever the operand size said —
and every DOS extender in this corpus reflects interrupts with `66 1f`.
CONTAGIO.EXE's extender therefore left the stack two bytes low on each reflected
call, drifted into a `ret` that read the wrong word, and spent the rest of the
run spinning inside its own error string *"Unrecognized Data In LE!"*. The
give-up sites the report printed were all ASCII, which reads as a wild jump and
is one — but the cause was two bytes of stack, thousands of instructions earlier.

**Two menus had no options on them.** The auto-key menu reader recognises a
selector followed by `]`, `)`, `.` or `:`. CYBOMAN2.EXE writes `        0>
NoSound` and COLORS.EXE `0 - Silence`, so neither menu contained a single
recognised option and both fell through to the blind key rotation, which never
picks the silent one. This is §7.3's lesson recurring: the program was executing
perfectly and sitting on a prompt.

Measured, on the same commands either side of each fix:

| program | before | after |
|---|---|---|
| CONTAGIO.EXE | 0 px, spinning in an error string | 22510 px |
| CMA_SHRT.EXE | 0 px | 20330 px |
| CYBOMAN2.EXE | 0 px, parked on a Gravis prompt | 61944 px |
| ACME-SYW.EXE | 2.9M dispatches, its own logo | mode 13h unchained, 2.97M planar writes |
| CTSLASSE.EXE | text refusal, exit 0 | 201M dispatches in mode 13h |

`tools/toyvm/int-census.js` then re-ranked what is left, and it is worth
recording what it ruled *out*: **VESA is three programs.** INT 10h AH=4Fh blocks
COLORS, SETUP and CHROME (COUNTDWN joins them by probing AH=6Fh/70h/BFh for
Video7, Paradise and Tseng chipsets). `framebuffer.js` is indexed-palette end to
end — `readFrame` hands back one byte of DAC index per pixel — so hi-colour and a
linear framebuffer mean reworking that whole pipeline. Three programs does not
buy it. The rest of the census tail is faults rather than gaps: the `int 00h`,
`01h`, `03h` and `05h` entries against DPS.COM, BKSNOTE.EXE, CAVEIRA.COM and
STHINTRO.EXE are divide-error, breakpoint and single-step vectors, which means
those programs are *crashing*, and each needs its own diagnosis.

### 7.5 A demo that looked stuck was running a thousand times too slowly

DOPE.EXE photographed as a text screen with 152 cells on it and nothing else.
It had answered its own sound menu (the reader picks `0> NoSound` off the
screen), left text mode, established unchained mode 13h and written 265216
bytes into the planes — and still captured as a console, because inside the
sweep's 300M-dispatch budget it never got far enough to finish a frame.

The number that explains it was not in any report. `--smc-census` — added for
this — keys every self-modify break by the block that stored and the paragraph
range it dirtied, and one line carried nearly the whole count:

```
   134414  873:b18 patched its own next block
```

`873:b15` is `2e 88 27`, `cs: mov [bx],ah`, inside a six-instruction loop with
`dx=0x100` and `cx=0x40`: a 64-entry fade ramp being built into a corner of the
program's own code segment. The decoder treats **any** store through a CS
override as a program editing its instruction stream and ends the block there,
so the loop handed back and recompiled on every single iteration — 138537
traces, 18MB of arena, and **4% of the wall clock actually in wasm**. Read as a
per-batch cost this looks like a slow emulator. It is a trace compiler running
flat out on a table.

The rule itself has to stay: it is why Turbo Pascal's `Intr()` works, writing
the interrupt number into the `int` two instructions ahead. But the signal that
separates the two cases was already being computed and then discarded. `$wr8`
tests every store against the paragraphs that have been compiled and sets
`$smc=2` when one lands in them; `end_smc` overwrote that with `1`. Preserving
it makes `$smc=1` mean precisely *a CS store that touched nothing compiled*,
and after 48 of those at one site the host withdraws the rule for that store
and recompiles the block without the cut. A genuine self-patch never reaches
that path — it writes into the block it is standing in, and that block is
compiled by definition.

| DOPE.EXE, 18M dispatches | before | after |
|---|---|---|
| wall | 9.77s | **0.39s** |
| self-modify breaks | 138414 | 836 |
| traces | 138537 | 889 |
| arena | 18395KB | 165KB |
| share of wall in wasm | 4% | **87%** |

At the sweep budget it draws 3543 pixels where it drew none. The general point
is the one worth keeping: **a static guess about what code does is a
performance decision as well as a correctness one, and the corpus is the only
thing that can tell you which sites it is wrong about.** The report now prints
how many sites a run retired, so that blast radius is visible — DHADREN retires
14 and its frame is unchanged at 20272 pixels.

## 8. Still open

* **A protected-mode INT 9 is invisible to the keyboard.** `keyboardIrq` will
  not raise IRQ1 unless `hookedVector(0x09)` says someone is listening, and that
  reads the **real-mode** IVT. A 32-bit program whose extender installs the
  handler in the protected-mode IDT instead therefore never receives a keystroke
  from any of the three wires. DINO.EXE and DINO386.EXE are the two in this
  corpus: both open on an arrow-driven setup grid ("Use ARROW keys to move
  around, ENTER selects highlighted option") whose cursor sits on Gravis
  Ultrasound with Silence three rows below it, and the code they park in is
  `cmp al,0x48` — the up-arrow scancode — decrementing a menu-row counter. So
  the program is asking; nothing can answer. Ruled out by measurement, not
  guessed: seeding the scancode queue reaches a port-60h poller and did not move
  the cursor, and mirroring the keys into the BIOS ring at 0040:001E did not
  either (DINO is flat 32-bit and writes over that region itself). Two programs,
  so it is recorded rather than built.
* Run the matrix on SpiderMonkey and JavaScriptCore, not just node's V8, and on
  `wasm3`/`iwasm` as a non-JIT control. Every number here is one engine.
* A `typed` handler table (`(ref null $handler_t)`) — the same change
  [performance-summary.md](performance-summary.md) §6 lists as lever 2 for the
  production interpreter. Needs the `0x70` funcref byte in `lib/compile-wat.js`
  (lines 677, 1189) or `wat2wasm`.
* **Handler-count scaling — and the numbers above are now for a smaller VM.**
  The open question was to pad the table and re-measure. It has been padded for
  real instead: filling the ISA gaps in §7.1 took the handler table from 426 to
  **586**, with the x87 bodies among the largest in the module. That is exactly
  the axis `switch` is expected to be sensitive to, since it inlines every body
  into one function, so §5's `switch` numbers should be treated as measured
  against the 426-handler build until the matrix is re-run. Nothing else in §5
  depends on the count.
* **The chained side of the CRTC model.** §4.1 derives geometry from the
  registers, and the unchained path renders from it, but a chained program is
  still read as 320x200 linear no matter what its CRTC says. BAZIRRE.COM is why:
  it programs a real 320x66 chunky mode by stretching each row over six scan
  lines, and reading its 66 rows back at a 320-byte stride produces overlapping
  text — so something else about mode 13h's addressing (the start address is in
  dwords, and the offset register still sets the row stride) is not modelled yet.
  `video-census.js` reports the derived numbers for all 199 programs, and four
  of them retime the CRTC without unchaining, so this is where that picks up.
* **What the text screens ask for that we do not have.** §7.3 made the B800
  page real, and the programs that stop early now say why on it. Two of the five
  classes were ours and are fixed (VGA detection, sound-device menus); three are
  still open, and each is a DOS-side gap rather than a CPU one: **no XMS/EMS
  driver** (4 programs print `HIMEM.SYS NEEDED !!!` or want an expanded-memory
  manager), **missing companion assets** (5 print `File Not Found`,
  `Library file corrupt.`, `Can not init file manager` — those are archives and
  data files the corpus copy does not include, so they may not be fixable here),
  and **one allocator ceiling** (`This demo needs 600k free to run`). None of
  these is visible to an opcode census; they were all read off the screen.
* **Lazy flags vs eager flags** — the question x86-16 was chosen for, and the
  one thing here that has no bearing on dispatch at all.

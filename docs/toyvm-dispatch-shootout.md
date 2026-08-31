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
and after enough of those at one site the host withdraws the rule for that
store and recompiles the block without the cut.

**The first threshold was 48, and that was wrong — the corpus said so.**
MINTRO.EXE went from a full 64000-pixel frame to nothing but its answered sound
menu and a Turbo Pascal exit code 200. The argument for 48 was that a genuine
self-patch can never reach the `$smc=1` path, because it writes into the block
it is standing in and that block is compiled by definition. MINTRO is the
counterexample: it opens `GoldPlay.ovl`, and a Turbo Pascal **overlay** is code
copied into a buffer at run time. The copy is a store into a code segment that
nothing has compiled *yet*, so it reports `$smc=1` every single time, and the
counter cannot tell it from a data table. Worse, the counter is blind by
construction — `benignPatch` invalidates as it counts, and there is no signal
left in the miss count that separates "this address will never be executed"
from "this address is about to be".

So the threshold is not a correctness criterion and cannot be made into one at
this granularity. What it can be is a **cost** criterion, which is the same
shape as any JIT tier-up: retire the cut only once it has demonstrably become
the dominant cost of the run. The two cases sit four orders of magnitude apart
— MINTRO's site fires 48 times in a 255-break run, DOPE's fires 134414 — so
**20000** separates them with room to spare, and never comes near a program
that merely loads an overlay.

| DOPE.EXE, 18M dispatches | before | after |
|---|---|---|
| wall | 9.77s | **0.39s** |
| self-modify breaks | 138414 | 836 |
| traces | 138537 | 889 |
| arena | 18395KB | 165KB |
| share of wall in wasm | 4% | **87%** |

(Those figures are the 48 threshold. At 20000 the storm is paid once instead of
never, and DOPE still ends up ahead — 16295 pixels at the sweep budget against
3543 at 48, because retiring later leaves it more of its budget in graphics.)

Across the corpus the change moved four programs and cost none:

| | before | after |
|---|---|---|
| DOPE.EXE | 0 px | **16295** |
| BP-OZONE.EXE | 26033 | **64000** |
| ANARCHY.EXE | 24889 | **223964** |
| MINTRO.EXE | 64000 | 64000 (was **0** at threshold 48) |

(An earlier version of this table had a fifth row, `ASYLUM.EXE 0 -> 5635`. It
was an artifact of joining the before and after sweeps on **basename**: the
corpus holds two different files called ASYLUM.EXE, one that draws 5635 pixels
and one that draws none, and the join paired each with the other. Keyed on
path, both are unchanged. Join sweep rows on `.exe`, never on `.name` —
SETUP.EXE, BLIQ.EXE and TRIPLEX!.COM are duplicated too.)

The general point is the one worth keeping: **a static guess about what code
does is a performance decision as well as a correctness one, and the corpus is
the only thing that can tell you which sites it is wrong about — including the
sites where your fix for it is wrong.** The report prints how many sites a run
retired, so that blast radius stays visible; DHADREN retires none now and its
frame is unchanged.

### 7.6 "Zero pixels" is not "broken", and counting it that way wastes a session

The sweep photographs 199 programs and reports how many drew VGA pixels. It is
tempting to read the rest as a defect list. It is not one: of the 55 rows that
draw no pixels, **roughly half are the program working correctly**, and the
split matters because the two halves take completely different work.

| what it is | how it looks | examples |
|---|---|---|
| a text production | full screen of ANSI/ASCII art | ASMINST, ANTARES, AZ, ALABTRO, AMORP, ant1, a-note, uman, manhatan, DIGITAL, NFO, STARPORT, README!, DD, BLINKY, NEWSBOX3, CYANIDE |
| a stub launcher | one line naming the real program | `001.EXE` "Type CYANIDE to run this demo.", `002.EXE` "Please run CYANIDE.EXE." |
| a hardware refusal | names the card it wants | rage + AMANAMAN + CULT + CATWALK (Gravis), COLORS (VESA 2.0), CORNETTO |
| not a demo at all | a utility that wants arguments | PKLITE (a file compressor), PLAY.EXE (the DeluxePaint player, wants an `.anm`), SHELLVT (a TSR) |

A `.NFO` viewer whose whole job is to show text cannot be "fixed" into
graphics, and a demo that refuses because it wants a Gravis is telling the
truth. **Read the `screen` field before treating a row as a failure** — it is
in every sweep JSON, and it answers the question in one line.

Two measurements that close off whole hypotheses for the genuinely-blank rest:

* **Timing is not the cause.** All 55 went through `clock-probe.js`: 54 come
  back compute-bound with a byte-identical frame at 0x, 1x and 16x tick rate,
  and **none** are time-starved. So tick pacing, `--tick-scale` and the headless
  clock are all ruled out for this set. (The one clock-sensitive row is
  MINTRO.EXE at 54910 px, which is §7.5's regression seen from the other side.)
* **The blank ones do not share a mechanism.** The unhandled-call census over
  the remaining eleven names `int 2fh AH=16` (DPMI) in three and `int 10h
  AH=4f` (VESA) in two; everything else is one program each, and several are
  not emulator gaps at all. BLAND.EXE prints "failed to load MSE" and looks
  like a file-I/O bug — it is not: it asks for `0xbea1` bytes of a file that is
  exactly `0x28be` long, and `0x28be` is what it gets, because the size field it
  read at offset 0x83 genuinely holds `0xbea1` on disk. BLIQ.EXE is a TSR that
  creates a child PSP with AH=55h and terminates into it, which is a real DOS
  path we do not model (`execStack` is only non-empty after an actual AH=4Bh
  EXEC) — one file, and getting it wrong would break every program that exits
  correctly today.

### 7.7 We were answering "8086" to the one question that asks

COROMER.EXE printed a line about how fast your CPU is and then wedged: 200
handbacks at `110:545`, blank screen, and the decoder refusing `0F 14`. That
last detail is what made it look like a missing instruction, and it was a
consequence rather than the cause. The bytes above it are:

```
mov cl, 32
mov ax, 1
shr ax, cl      ; 8086: shifts 32 times -> 0.   186+: count masked to 5 bits -> 1
cmp ax, 0
jnz <186+ path>
```

This is the standard part probe, and our shift helper looped the full count, so
we answered "8086". The program then did what you do to an 8086: `push cs`
followed by the `0F` that is POP CS **only on that part**. On anything later
`0F` starts a two-byte opcode, our decoder refused `0F 14`, and the run stopped
there. Nothing was wrong with the decoder — a 386 never reaches that byte.

Two things worth keeping from it:

* **The give-up address was three instructions downstream of the bug.** A
  decoder that refuses an opcode reports the opcode, which reads as an ISA gap
  and sends you to look up `0F 14`. The actual defect was a shift, and the only
  thing connecting them was that the program deliberately branches on the
  difference. When a run stops on a refused byte, check whether the program
  *meant* to get there.

* **We cannot be both parts, and the repository runs both.** Masking the count
  unconditionally cost `gate.js` 15427 of 70000 cases on D2/D3 — its vectors
  were recorded on a physical 8088, where the unmasked shift is correct. So the
  masking is a global (`$shmask`) that `set_cpu` raises at 186, exactly like
  `$linmask` for the address bus and `$f_res`/`$f_def` for the FLAGS shape.
  gate.js never calls `set_cpu` and keeps its 70000/70000; the DOS machine, which
  answers CPUID and decodes `0F` opcodes, stops claiming to be an 8086 and draws
  63680 of 64000 pixels. `--cpu=86` reproduces the old blank run, which is what
  proves the bit is what moved it.

### 7.8 A self-patch cut was paying for a recompile it did not need

`$smc=1` means the decoder ended a block at a store through a CS override.
`$smc=2` means `$wr8` saw the store land in a paragraph some compiled region
decoded. The handler for the first case dropped the block the store was about
to fall into — and that was left over from before the two cases were told apart,
when a break could not say which kind it was.

It can now, and the flag is a proof rather than an absence of one: `$smc` is 1
only when `$wr8` *declined* to make it 2, at every width, since `$wr16` and
`$wr32` are built out of `$wr8`. So the store touched no compiled code, and the
block being dropped recompiles into identical words.

The cost of that was not marginal. COMPCODE.EXE keeps a dword variable in its
code segment (`cs: mov [0x656], eax`), so every store cut the block and bought a
full re-decode:

| | traces | arena |
|---|---|---|
| COMPCODE.EXE | 366712 → **164** | 170614KB → 76KB |
| BP-OZONE.EXE | 488373 → **248** | 72024KB → 186KB |
| DHADREN.EXE | 128997 → **850** | 42880KB → 1100KB |
| CARRIE.EXE | 3538 → **1187** | 1191KB → 165KB |

Frame hash, pixel count, dispatch count and break count are identical on every
one — the runs do the same thing, they just stop paying for it. CRYSTAL.COM is
the control: its breaks are the `$smc=2` kind and its 77005 traces are
unchanged, which is what shows the change reaches only the path it argues about.

### 7.9 Two traps in reading a sweep

Both cost real time this session and neither is visible in the output.

* **Join on the path, never the basename.** The corpus has two ASYLUM.EXE, two
  SETUP.EXE, two BLIQ.EXE and several TRIPLEX!.COM. A basename join pairs each
  with the other and manufactures movement: it credited §7.5 with moving ASYLUM
  from 0 pixels to 5635 when both files were flat.

* **`capture-one.sh` skips a program whose row file already exists.** That is
  what makes a killed sweep resumable, and it also means pointing a "fresh"
  sweep at a directory that already has rows in it captures **nothing** and
  silently reports the old run. A sweep of 199 programs that finishes in three
  minutes did not run. Check the row-file timestamps before reading a diff —
  15 programs appeared to have lost their entire picture, and the rows were 16
  hours old.

## 8. Still open

### 8.0 The blank list, by mechanism rather than by name

What is left after §7.7 and §7.8, each entry checked individually rather than
inherited from an older list. The grouping is the point: one of these is four
programs behind a single missing subsystem and the rest are one apiece.

* **16-bit protected mode, four programs.** INTRO.EXE, CTSLASSE.EXE,
  AQUAPHOB.EXE and daretro.exe. The first three probe DPMI (`int 2Fh AX=1687`)
  and get no host; INTRO then switches to protected mode on its own and lands
  with `CS=2`, which is selector index 0 — the null descriptor — so it executes
  at linear 0 and the decoder refuses the interrupt vector table. daretro.exe
  fails one step earlier and more legibly: `bad CS selector at 110:3dd — names
  no GDT descriptor`, with `cr0=11` and a GDT limit of 0x37, seven descriptors,
  against a selector of 0x110. This is the largest single lever left in the
  corpus and it is one subsystem, not four bugs.

  **daretro's message is misleading and the obvious fix is not the fix.** The
  reading it invites is that we refuse CS during the window between `mov cr0`
  and the mandatory far jump, where a real CPU keeps running on the descriptor
  cached at the last real-mode load. That window is real, and relaxing the
  guard for it is faithful — and it changes nothing here, because the far jump
  already works: instrumenting the PE transition puts it at **`cs=8:2567`**, a
  32-bit code segment through a well-formed descriptor. The program gets into
  protected mode and comes back out to `110:3dd` with PE still set, which is
  the actual defect.

  What it runs in there says why that is not a small fix. At `8:2567`:

  ```
  cs: lidt [0x1c6]              mov ax,0x10 / mov ds,ax / es / fs / ss
  mov ax,0x18 / mov gs,ax       mov esp,[0x2255]
  mov ax,0x20 / ltr ax          pushfd / or ah,0x30 / and ah,0xbf / popfd
  in al,0x21 / or al,3 / out 0x21,al
  ```

  That is a protected-mode kernel bringing itself up — its own IDT, a task
  register, IOPL and NT, and the interrupt controller remasked. So daretro is
  not in the DPMI group at all; it hosts its own extender. Recorded because the
  relaxed-guard fix is the first thing anyone will try, it takes an afternoon,
  and it moves nothing.

* **Programs that run to completion and draw nothing.** ACME-BIG.EXE (an
  overlay loader: seek, read a 28-byte MZ header, `AH=48h BX=FFFF` to size the
  free pool, five times, then exit 0) and BLIQ.EXE, which needs child-PSP
  termination through `AH=55h`. Both exit 0 in hundredths of a second. SETUP.EXE
  from the ANGEL directory is the same shape but far slower — 808M dispatches
  inside one `repe cmpsb` pattern search before exiting 0 with an empty screen —
  and it matters twice over, because ANGEL.EXE's only output is "Please run
  setup.exe on your computer!". Note the sweep runs each program in its own VFS,
  so ANGEL could not see SETUP's output even if SETUP wrote one.

* **AUTUMN.EXE unpacks correctly and stops.** It creates `###.tmp`, writes
  0x9837 bytes, reopens it and reads it back in 231 chunks — every read returns
  the byte count asked for — moves 128KB through XMS, sets mode 13h, runs its
  own timer ISR at a healthy 21000 dispatches per handback, and never draws.
  File I/O and XMS are both ruled out by measurement; the defect is downstream
  of both.

* **JULTRO.EXE divides by zero at `5ab:1ff`** and then spins at `5ab:8c`.
  Neither address is an instruction. `--disasm=5ab:80` and `--disasm=5ab:1e0`
  both land in tables: `5ab:80` is thirteen ascending words (`0d39 0d48 0d4f
  0d56 0d5d 0d63 …`, steps of 6-7), and `5ab:1e0` is a byte ramp `f8 f9 fa fb
  fc fd fe` that the disassembler reads as MMX because every other byte is 0F.
  The fault offset settles it on its own: `1ff` is odd and the region is made of
  two-byte units on even boundaries, so execution entered mid-unit. So this is
  the same shape as ASSAULT below — a wild jump, with the divide and the spin
  both downstream of it — and **not** a bad divisor of ours, which is what an
  earlier note here guessed. Whatever computes that far pointer is the bug, and
  it is upstream of everything the fault reports.

* **ASSAULT.EXE** is one program with no shared mechanism. Its decoder give-up
  is on `fe 90`, which is not a valid encoding at all (`FE /2`), so it too has
  jumped into data and the give-up address is a symptom.

Two rows on the blank list are **not** work items, recorded so they stop being
re-investigated: COMPCODE.EXE draws 63508 pixels and only ever photographed
blank because it needed a bigger budget (§7.9's rung), and DIZZY_FI.EXE draws
26896 pixels in a direct run at either build — its zero is a wall-timeout under
box load, which is what the sweep does to a slow program when the machine is
busy, and it comes back on a quiet one.

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
* Run the *dispatch* matrix on SpiderMonkey and JavaScriptCore, not just node's
  V8. Every number in this file is still one engine. The JIT-tier matrix has
  been run across five (node, SpiderMonkey, JavaScriptCore, d8, bun) plus each
  one's baseline-only compiler — see "Five engines" in
  [toyvm-trace-jit.md](toyvm-trace-jit.md) and `tools/toyvm/engine-bench.js`,
  which reruns any bundle it wrote. `wasm3`/`iwasm` as a true non-JIT control is
  still open: these modules import a memory and three host functions, so it
  needs a harness rather than a flag.
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

### 8.0.-1 Three programs share one shape, and it is not three bugs

> **Answered for one of the three, and the shared shape did not survive it.**
> ASSAULT's wild jump was a stale arena address in the shadow return stack —
> §8.2. JULTRO and INTRO are unchanged by that fix, so "execution reached an
> address that holds no instruction" turned out to be a *symptom* the three
> share and not a cause. Read the grouping below as what it was worth: it named
> the right question ("what transfers control there?") and the wrong unit of
> work. One root cause did not move more than one program.


JULTRO, ASSAULT and INTRO are filed separately above as a divide by zero, a bad
opcode and a protected-mode failure. All three are the same thing: **execution
reached an address that holds no instruction**, and every symptom each one
reports is downstream of that.

* JULTRO's `5ab:1ff` is an odd offset in a region of two-byte units — §8.0.
* ASSAULT gives up on `fe 90`, which is not an encoding at all.
* INTRO stops at `2:1a43` with `cs=2`. Selector 2 is index 0, the null
  descriptor, and `$segbase` returns base 0 for it — so the address is linear
  0x1a43, inside the interrupt vector table. A real CPU faults on loading a null
  CS, so the program did not mean to do this either.

INTRO is worth reading past the give-up because its pmode kernel is legible.
`--disasm=8:fb4` and `--disasm=8:fe2` show an interrupt reflector: `movzx ebx,
bl` then `mov dx,[0+ebx*4]` / `mov cx,[2+ebx*4]`, which is `IVT[vector]` fetched
offset-then-segment, with a second copy that reads an 8-byte-entry table at
`cs:[0x4c]` instead. So this demo carries **its own DOS extender**, it services
interrupts by going back out to real mode, and it built a GDT with a 0x26F limit
and ran real code through selector 8 before it lost its way. It is not blocked
on DPMI — it asked (`int 2Fh AX=1687`, twice, unhandled) and then did without.

That makes "16-bit protected mode" the wrong name for what these need. The
question to answer first is the one they share: **what transfers control to an
address nothing was loaded at**, on three programs, in three different modes.
Fixing `$segbase` to give selector 2 its real-mode meaning (the treatment
out-of-GDT-limit selectors already get two lines below the null check) would
only move INTRO's garbage from linear 0x1a43 to linear 0x1a63; it is not the
fix, and the give-up address is not the bug in any of the three.

### 8.0.0 The Gravis group is not an environment variable

AMANAMAN.EXE stops on `Hey ! Where's your ULTRASND environment ?` and rage.exe
on `GUS not found!`, which invites setting `ULTRASND=220,1,1,11,11` in the guest
environment and calling it fixed. **This VM has already run that experiment on
the other card and written the answer down**, in the comment above the env block
in `dos.js`: `BLASTER=` was tried, and a library that reads the variable skips
the probe entirely and goes straight to programming a DMA transfer on the
channel it was promised. Measured, CEN!FB.EXE and BTHERE.EXE hung on
`Initializing .` forever with it set and drew 64000 and 28203 pixels without it.

The rule that encodes — *answer questions the card can be asked, do not
volunteer a configuration nothing is standing behind* — applies with more force
here, not less: there is a Sound Blaster DSP behind the SB probe and there is no
GUS behind anything. So this group needs a GUS whose DRAM sizing loop answers,
or it stays where it is. It is not a one-line win and should not be attempted as
one.

### 8.0.1 SETUP.EXE wants VESA, and that is not the expensive half

`node tools/toyvm/demo-status.js /tmp/shots-final.json` sorts the 199 into 147
demos, 32 text-art screens and 20 work items, and three of those twenty looked
like one mechanism: ANGEL.EXE says `Please run setup.exe on your computer !`,
BYETRO.EXE says `Please run SETUP.EXE to configure.`, and SETUP.EXE itself is
blank. Its `--report` names the gap in one line — `unhandled calls: int 10h
AH=4f x1` — and it spins in a table search at `773:3df` immediately after.

**Answering it was built, measured and reverted.** A VBE 1.2 info block with an
empty mode list (the honest description of a machine whose framebuffer does
320x200 linear and unchained planar and has no bank-switched window) made SETUP
ask the next question instead: `4F01` for **mode 101h**, 640x480x256. So the
real requirement is a banked VBE framebuffer, not an info block. Across the 52
zero-pixel programs only three others touch AH=4Fh at all (SHELLVT.EXE,
ACT1.EXE, AMORP.COM) and none of them changed, and the 24-program regression
sample was identical — so the change was regression-free and had no beneficiary,
which is the same test the daretro guard in §8.0 failed. Reverted on that basis.
Leaving the call unhandled also keeps it in `unhandled calls:`, where it reads
as a work item rather than as a silently wrong answer.

**And the chain is blocked twice over, which is what makes it a poor target.**
ANGEL.EXE opens DRIVERS.VGA and its own ANGEL.EXE successfully — no file is
missing — so what SETUP has to leave behind is a patched byte in one of them.
The VFS is read-only on purpose (a sweep runs 199 programs unattended and none
of them has any business writing to the corpus), so even a SETUP that reached
its menu could not persist an answer. Two subsystems for three programs.

### 8.1 DOS does not end a program by ending it

ACME-BIG.EXE and BLIQ.EXE both stopped within a tenth of a second of starting,
and the trace made it look like they had simply decided to quit: an ordinary
`AH=4Ch`, exit code 0, no error message, no complaint. It was our exit.

Real DOS terminates a program by far-jumping through the address at **PSP+0Ah**,
the INT 22h terminate vector. Nothing about `AH=4Ch` says "stop the machine" —
it says "go to whoever put their address there", and it looks like the end of
the world only because COMMAND.COM normally owns that slot. An overlay loader
that wants control back writes its own address in instead, and both of these do.
Dumping the child PSP ACME-BIG builds is what settled it:

```
204:0000  cd 20 00 9f 00 00 00 00 00 00 4a 04 10 01 00 00
                                        ^^^^^^^^^^^ 0110:044A
```

0x110 is ACME-BIG's own segment. It had told us exactly where to resume and we
were not reading the field. Three things had to change together:

* **`AH=4Ch` follows the vector** when PSP+0Ah is non-zero. That guard is exact
  rather than heuristic — we build every PSP with a zero there and never write
  it ourselves, so a non-zero value is something a guest deliberately stored.
  Every program that exits correctly today still exits.
* **`AH=55h` sets the current PSP.** It is the call EXEC makes internally, which
  is the whole difference between it and `AH=26h`, and without it the child's
  terminate vector is out of reach at exit.
* **`AH=31h`'s "keep DX paragraphs" applies on that path too**, because the
  release is the point of the call: BLIQ hands its subfile the entire remaining
  pool (0x9cc3 paragraphs), the subfile hooks INT 10h and goes resident on 0x40
  of them, and the loader asks for 0x37 more for the next one straight away.

**And then the pool had to be real.** `allocTop` was a frontier and `AH=49h` was
`return true` — a one-way ratchet, which is invisible for a program that
allocates once and fine for the many that never free, but BLIQ's Pascal runtime
takes and returns twenty-odd blocks while starting MIDAS and hit the ceiling on
a machine with 400KB free. `AH=48h/49h/4Ah` now keep a sorted, coalesced free
list below the frontier, with the frontier absorbing anything that touches it so
LIFO allocation never grows the list at all.

The result, all measured against a `75808fbd` worktree on the same box:

| program | before | after |
|---|---|---|
| ACME-BIG.EXE | 0 px, ends in 0.4M dispatches | **64000 px**, its logo, in protected mode |
| ASYLUM.EXE (1995-a) | 0 px, `exited=true code=1` at 1cd:86 | **64000 px**, a full-screen plasma |
| BULLET.EXE | 1894 px, mode 13h linear | **16274 px**, mode 13h unchained |
| BLIQ.EXE | 0.04M dispatches, 40 chars | **31.2M dispatches**, mode 13h unchained, 203k planar writes, SB and EMS up |

A 24-program regression sample was byte-identical on 23 and BULLET was the 24th,
and CONTAGIO.EXE — the `AH=55h` caller this VM already had a comment about —
came back with the same frame hash.

**BLIQ is not finished, but it now says what it wants.** It ends on `MIDAS
Error: Out of conventional memory` followed by `Runtime error 200`, and those
are one fault, not two: the Borland runtime error is reported at offset 0x67,
the same offset as the Pascal heap routine every `AH=48h` in the trace comes
from, so it is a divide by zero inside the allocator reacting to the shortage —
not the famous TP7 delay-calibration bug it looks like. The shortage itself is
real arithmetic: three resident subfiles plus the image hold 412KB, the loader
then asks for 312KB and takes the 221KB that is left, and the next 896-byte ask
has nowhere to go. Nothing in the trace frees those subfile blocks, so either
the loader has an EMS path we are not qualifying for or one of them should not
be resident at that size. That is the next question, and it is a DOS-services
question rather than a CPU one.

### 8.2 A cached return address outlived the code it pointed into

ASSAULT.EXE printed `Loading...patience is a virtue.`, set mode 13h, and then
spent its entire budget at `10ab:ab09` on `fe 90 00 00 00 00 00 00` — mostly
zeros, so the decoder gave up and the run photographed a black screen. Read off
the give-up address alone that is a missing instruction. It is not one.

**The tell is a flag, not a disassembly.** `--no-cache` reproduced it exactly;
`--smc-flush` made the demo draw a full 64000-pixel frame. Those two differ only
in *how much of the compiled cache survives a self-modifying store*, which is
the whole point of keeping them as an A/B pair: a program that behaves
differently under `--smc-flush` has a stale-code bug and not a slow one. That
one line of evidence was worth more than every disassembly taken before it.

**What the program was doing.** ASSAULT is Borland-compiled and links the
floating-point emulator. Its startup installs one handler on each of INT
34h–3Dh (`--report`'s interrupt census shows `2534`…`253d` all pointing at
`12a3:2bd3`), and every floating-point site in the image is assembled as a
two-byte `int 3xh` placeholder. The handler patches each site the first time it
is reached: it reads the vector number back out of the return address, adds
`0xa3ce` to the `CD 3x` word — which turns `int 34h`…`int 3Bh` into `fwait` plus
the matching ESC byte, `CD 3B` → `9B DF` — rewinds the return address by two,
and IRETs so the *real* instruction executes. This is not an exotic path; it is
how every Borland program with `emu.lib` in it starts up, and it is why the
corpus reports thousands of self-modify breaks.

**The bug.** `$rpush`/`$rpop` are a shadow return stack: a `call` remembers the
arena address its `ret` should resume at, and `$rpop` hands it straight back.
The only thing checked on the way out is the guest ip and cs — nothing tells it
whether the region that arena address points into is still live. `flush()` has
always emptied it (`rtop = 0`). `invalidateRange()`, the narrow path that
replaced the flush for most stores so COMPCODE would stop re-decoding itself
1526 times (§7.8), did not. The arena is never overwritten in place, so a
dropped region's bytes stay executable and stay exactly as they were compiled.

So: a call site is patched, its region is correctly dropped, and a `ret`
elsewhere comes back through a frame pushed before the drop and resumes in the
**pre-patch** compilation — which still contains the `int 3Bh` that memory no
longer has.

**And the second interrupt is worse than the first.** The handler is hostile to
being re-entered on a site it has already fixed. Second time round it reads the
*patched* bytes at the return address, computes `0xDF - 0x34 = 0xAB`, fails the
`cmp al,8` that gates the rewind, and IRETs to the un-rewound address — two
bytes into `fild word [0xe8]`. Control lands mid-instruction, walks off into
zeros, and stops at `10ab:ab09`. Every visible symptom is three steps downstream
of a stale 12-byte stack frame.

The fix is one line in `invalidateRange`: clear `rtop` whenever anything is
dropped. It costs the next few `ret`s the slow path and nothing else —
correctness never depended on the shadow stack being right, only speed.

Two things worth keeping from this:

* **`--smc-flush` is a diagnosis, not a workaround.** It exists as the A/B
  partner for exactly this class, and it answered in one run what the
  disassembly could not answer in a dozen.
* **A cache that hands back a raw address needs one invalidation path, not
  two.** The narrow path was added for throughput and was correct about
  *regions*; it was silently incomplete about every other structure holding an
  arena address. `jtab` was handled in the same function and `rtop` was not,
  which is the whole bug.

**Corpus verdict.** Full 199-program sweep, merged and classified against the
previous one: **182 of 199 showing something they meant to** (150 graphics, 32
text art), up from 179. Three programs moved, all forward — ACME-BIG and ASYLUM
from the terminate-vector work in §8.1, ASSAULT from this. Nothing moved
backwards. One row (B-STEEL.EXE) first came back blank and was a sweep flake,
not a regression: the box was at load 25–37 with several agents sweeping, and
re-taking that single row put it back at its usual 307200 pixels. That is worth
saying out loud, because a bucket that moved backwards is exactly what a
regression looks like — **re-take the row before you believe it**, since
`capture-one.sh` writes one row per program precisely so a single re-take is
cheap.

### 8.3 A demo that ran its own virtual-8086 monitor

`daretro.exe` reported `bad CS selector at 110:3dd` and stopped on its first
instruction after entering protected mode. The selector was not bad. At `8:22c6`
the program does `pushfd / or eax,0x20000 / push eax` and `iretd`s — the one and
only way onto a 386's **virtual-8086 mode**, where the CPU is in protected mode
(PE set) but segmentation is real-mode again. Read without that bit, `CS = 0x110`
is a protected-mode selector naming no descriptor, which is exactly the message
we printed.

V86 needed four things, and `VM` could not live in `$flags` for the first of
them: every 16-bit `POPF`/`IRET` masks with `$f_def`, so the bit would evaporate
on the guest's first `popf`. It gets its own global, `$vm86`.

1. `$segbase`/`$segd32` treat a selector as a paragraph again when `$vm86`.
2. `iret32` with bit 17 set in the popped EFLAGS enters V86 — and pops **all
   nine** dwords of the frame (EIP, CS, EFLAGS, ESP, SS, ES, DS, FS, GS), not
   just the first three.
3. `$fault` taken while in V86 is the only way *off* the mode: it builds those
   nine dwords on the ring-0 stack named by the TSS (`ESP0` at TSS+4, `SS0` at
   TSS+8), zeroes the guest's data selectors, and clears `$vm86`.
4. The bad-selector guard and the host's `raise()` both had to learn that a
   V86 `CS` is not a selector.

That got the guest running and produced 1825 identical round trips: enter at
`110:3dd`, trap `vec=0x10`, enter at `110:3dd` again, with the ring-0 stack
falling 0x100 every time until the monitor's frame walked off and it started
printing a hex register dump. The guest never advanced one instruction.

**The bug was reading `INT n` as an interrupt.** The V86 thunk at `110:3dd` is a
BIOS-call gateway — load `ax..bp` from a parameter block, `int 0x10`, store them
back, `int 0xfd` to sign off — and its `int 0x10` was going straight to
`IDT[0x10]`. Dumping the IDT says why that is wrong:

```
1608  97 23 08 00 00 8e 00 00   a0 23 08 00 00 8e 00 00
...
1668  ef 23 08 00 00 8e 00 00   fa 22 08 00 00 8e 00 00   <- vector 0x0d = 8:22fa
1678  f4 23 08 00 00 8e 00 00   f9 23 08 00 00 8e 00 00   <- 0x0f onward = 8:23f9
```

Type byte `0x8E` on every gate: present, 386 interrupt gate, **DPL 0**. The guest
runs at CPL 3, and for the *software-generated* vectors the 386 checks the gate's
DPL against CPL and raises `#GP(vec*8+2)` when the gate is more privileged.
Vector `0x0D` is the only entry with its own handler; everything from `0x0F` up
is one catch-all "unexpected interrupt" register printer. That is the monitor's
whole design — funnel every INT the guest issues into `8:22fa`, read the `cd xx`
back, reflect it — and we were walking into the printer instead.

So `int_imm` gained a third operand, the instruction's **own** ip (a fault
reports the address *of* the instruction, not the one after, because the handler
has to decode it), and routes through a new `$faultsw` that applies the DPL check
in V86. Two details are load-bearing:

* **No gate is a `#GP` too, not a fall-back to the vector table at physical 0.**
  daretro's IDT stops at vector 0x30 and it signs off from V86 with `int 0xfd`.
  Serviced out of the IVT, that INT reached our own DOS stub, came back reported
  as `UNHANDLED`, and the demo took its abort path to `int 21h`/`4Ch` — exiting
  cleanly with a black screen, which reads as a demo that simply drew nothing.
* **`#GP` pushes an error code**, so the V86 frame is ten dwords for it, not
  nine. A handler that pops one anyway would have taken the guest's EIP for it.

`daretro.exe`: 0 non-black pixels → **33184**, mode 13h unchained, 257536 planar
writes. It draws a purple "RENAISSANCE" logo over a scroller field.

The general lesson is the one from §7.7 restated at a different level: *the
question the hardware is being asked matters more than the answer*. We were
answering "which interrupt is this" correctly and completely, for a machine that
was asking "is this INT allowed to take its own gate".

**Corpus verdict.** Full 199-program sweep against the previous one: **183 of
199** (151 graphics, 32 text art), up from 182. One program moved, forward.
B-STEEL.EXE came back blank again and was again a load flake — the box was at
load 8–9 with six sweep jobs — and a single-row re-take put it back at 307200
pixels. Second time for that same row; §8.2's rule holds.

### 8.4 Who is holding the memory, and BLIQ's error 200 is upstream of running out

§8.1 left BLIQ.EXE saying `MIDAS Error: Out of conventional memory` and read the
`Runtime error 200` beside it as a divide by zero inside the allocator reacting
to the shortage. Two of the three claims in that reading do not survive.

The first thing wrong was our own bookkeeping. `AH=48h` refusing a request said
only "no", so the natural question — is the pool exhausted or merely fragmented,
and who has it — had no answer in any trace. A refused allocation now logs the
whole map, each block tagged with the PSP that owned it when it was handed out:

```
alloc 4c79 refused; top=66f8 held=[1cd+39@100 206+37@100 23d+40@100 27d+37@100
  2b4+12a5@100 163c+38@100 1674+2d89@100 43fd+39@100 4436+2289@100 66bf+39@100] free=[]
```

The owner column is new, and needed one piece of real DOS behaviour to mean
anything: **`AH=4Ch` frees every block owned by the PSP that is exiting.** That
is what lets a loader run five subfiles in a row without the machine filling up,
and we did not model it at all — only the `AH=31h` half, which keeps `DX`
paragraphs and releases the rest.

The first run with the column in it printed `23d+9cc3@100`: 629KB held at
segment `0x23d`, on a machine whose allocation frontier was down at `0x27d`. The
entry was stale. `AH=31h` moves the frontier to `keep` and drops every block at
or above it, but the block the resident program is *standing in* straddles
`keep` and was left recorded at its original size. Invisible while nothing
consults `memBlocks` to allocate — and a 629KB false release the moment
something frees by owner, which is exactly what the new path does. It is now
shrunk to `23d+40`, which is the 0x40 paragraphs §8.1 says that subfile keeps.

With an honest map, BLIQ's arithmetic is legible and the causality is the
reverse of what §8.1 assumed:

* The two `exit 200 through the terminate vector` lines land **before** the
  first genuine shortage (`alloc 4c79 refused`). Every `AH=48h BX=FFFF` failure
  before that is the Pascal heap asking how much is free, which is a probe, not
  a shortage. So error 200 is upstream of running out of memory, not downstream.
* It is **not** a stale-code bug. `--smc-flush` reproduces both faults at
  byte-identical dispatch counts, 25691943 and 28423493.
* `--trace-fault` calls them divide faults, and that label is doing more work
  than it can carry. The site is a register-record DOS-call wrapper that patches
  its own `int nn` operand (`cs: mov [0x66], al`), and at the fault the operand
  byte is `f3` — `int 0xF3`, the loader's own subfile callback, installed at
  `2c4:1f5` and read back by every subfile at its offset `0x0a`. The detector
  fires on "the guest is executing its INT 0 vector", which `int 0` and a real
  `div` reach identically, and a third path apparently reaches too.

What is left is a question about BLIQ's loader protocol rather than about memory:
three subfile data blocks (186KB, 139KB, 230KB) accumulate because two of the
three subfiles die before the loader is done with them. Free-by-owner does not
release them and should not — the loader allocated them under its own PSP, which
is what a real MCB would record too.

**Corpus:** 199-program sweep, bucket-for-bucket identical to the previous one.
183 of 199, nothing moved in either direction. B-STEEL.EXE flaked to blank for
the third time and came back at 307200 pixels on a single-row re-take, which by
now is less a warning than a property of that row on a loaded box.

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

### 4.1 Making the harness measure the VM and not itself

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

Sweeping the corpus with `--report` names the remaining gaps by frequency:

| gap | what it is | apps blocked |
|---|---|---|
| `db e3`, `de 43`, `df d6` | x87 FPU — the VM has none at all | 3 |
| `67 88 84 …` | 0x67 32-bit addressing with SIB in real mode | 2 |
| `0f 01 e0` | `SMSW`/protected-mode probes | 1 |
| self-modifying decryptors | a trace compiled before the code decrypts itself | 2 |

The 0x67 gap is the awkward one: the current EA encoding packs kind, segment and
register into one operand word and has no room for base + index + scale + disp32.
Adding it means a third operand word and a second `$ea`.

## 8. Still open

* Run the matrix on SpiderMonkey and JavaScriptCore, not just node's V8, and on
  `wasm3`/`iwasm` as a non-JIT control. Every number here is one engine.
* A `typed` handler table (`(ref null $handler_t)`) — the same change
  [performance-summary.md](performance-summary.md) §6 lists as lever 2 for the
  production interpreter. Needs the `0x70` funcref byte in `lib/compile-wat.js`
  (lines 677, 1189) or `wat2wasm`.
* **Handler-count scaling.** Pad to 426 handlers and re-measure. If `switch`
  loses further, the answer to "does the giant br_table scale" is no, and that
  is directly actionable for the production interpreter.
* **Lazy flags vs eager flags** — the question x86-16 was chosen for, and the
  one thing here that has no bearing on dispatch at all.

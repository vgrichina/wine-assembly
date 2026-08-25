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

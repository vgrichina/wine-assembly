# Not running the loop that waits

## The census said the dispatches were not in the demo

After fusion, dead-flag elimination and trace blocks, the obvious next move was
to find the biggest remaining handler pair and fuse it too. The pair census
(`--handler-pairs`, counts exact) said something else. Core ten, 8M dispatches:

```
RUNDEMO.EXE   250,009   57.7%  cmp_rm8_jz -> cmp_rm8_jz    100.0% of cmp_rm8_jz
ACCIDENT.EXE  275,011    4.7%  cmp_rm8_jz -> cmp_rm8_jz    100.0% of cmp_rm8_jz
CYCLE.EXE     275,011    4.0%  cmp_rm8_jz -> cmp_rm8_jz    100.0% of cmp_rm8_jz
DTM2.EXE      275,012    4.6%  cmp_rm8_jz -> cmp_rm8_jz    100.0% of cmp_rm8_jz
CMA_SHRT.EXE 2,150,171   42.2%  in_8 -> cmp_ri8_jz         100.0% of in_8
```

"100.0% of" means the handler is *only ever* followed by itself. That is not a
hot inner loop with a hot successor — it is one op branching to its own head,
forever: a program polling a byte and waiting. RUNDEMO's own exit line agrees
(`exited=false  waiting for a key`), and the count is near-identical in three
otherwise unrelated demos, which suggests one shared wait routine — though the
demos are packed and unpack themselves, so a static disassembly at the stopping
`cs:ip` reads as garbage and cannot confirm that.

Fusing it would have saved nothing: it is already one fused op. The right answer
is not to run it.

## Why it is safe not to run it

Take a block that is exactly one branch, and whose taken edge is the block's own
head. If the branch is `cmp`/`test` fused with a `Jcc`, or a bare `Jcc`, or a
bare `jmp`, then the block **changes nothing but the flags it just computed** —
no register write, no store, no port, no stack.

So iteration two reads exactly what iteration one read. And nothing else can run
in between:

- No store happens, so no self-patch, so `$smc` cannot become set inside the
  loop.
- Interrupts are injected **between** slices, never inside one. The whole design
  rests on this already — it is why the budget is checked at a block boundary
  rather than mid-block.
- The host cannot touch guest memory while `run()` is inside the arena.

Therefore, once the branch is taken it is taken every time until the step budget
runs out. The loop's outcome is known the moment it is entered.

## The arithmetic is the whole guarantee

An untraced loop turns while `$steps >= 0` at the block transfer, spending `S`
steps per turn, and stops holding the first value below zero. That value is

```
(v % S) - S
```

and nothing else. So the spin handler writes exactly that, sets `$gip` to the
loop head, and hands back:

```wat
(global.set $gip (local.get $t1))
(if (i32.eqz (i32.or (global.get $smc)
                     (i32.lt_s (global.get $steps) (i32.const 0))))
  (then (global.set $steps
          (i32.sub (i32.rem_s (global.get $steps) (i32.const S))
                   (i32.const S)))))
(call $slice_exit)
```

`S` is 1 for a bare `Jcc` or `jmp` — the one step `$next` charges — and 2 for a
fused pair, which charges a second inline for the op it swallowed.

The two early outs are the block transfer's own two, in the same order: a spent
budget or an already-patched slice hands back at once with `$steps` untouched,
because that is what the loop would have done on its very next turn.

**What comes out is therefore the same run.** Same `$steps`, same `$left`, same
`$gip`, same registers, same memory, same slice boundary, same interrupt landing
on the same step, same frame. The only thing that differs is how many dispatches
were retired getting there — which is the point.

## What is eligible, and why it is so narrow

**One op in the block.** A second op in front of the branch could store, could
read a port, could move the register the compare reads — and then the loop is a
loop that ends. The test is not "the ops look pure", it is "there is one op".

That sounds crippling and is not, because **fusion already collapsed the shape
this is aimed at**: `cmp [si],al / jz $` is two instructions, one fused op, one
block. The two optimisations compound — without fusion the same loop is two ops
and this declines it.

**`cmp` and `test` only, among fused pairs.** They are the two ALU ops that
throw their result away. A fused `dec_r16_jnz` is deliberately absent: that loop
counts down and ends, and collapsing it would be wrong rather than slow.

**Never under `oneInsn`.** With TF set the CPU owes the guest an INT 1 after
every instruction, so the loop does *not* run to the end of the slice.

**`in_8 -> cmp_ri8_jz` is correctly declined.** CMA_SHRT spends 84.4% of its
dispatches on that pair — a VGA status-register retrace poll — and the port read
goes out to the host, which returns a different answer each time. It is a real
loop with a real exit and this must not touch it. (It is worth its own look:
2.15M host import calls in an 8M-dispatch run is a different problem with a
different answer.)

## Measured

Exact handler-entry counts (`--handler-hist`), 8M dispatches, `--no-spin` against
the default. Load-independent:

| program | dispatches, no spin | with spin | removed | loops compiled |
|---|---|---|---|---|
| RUNDEMO | 433,539 | 183,550 | **57.7%** | 1 |
| ACCIDENT | 5,865,830 | 5,590,841 | 4.7% | 1 |
| DTM2 | 6,032,210 | 5,757,220 | 4.6% | 1 |
| CYCLE | 6,878,648 | 6,603,659 | 4.0% | 1 |
| CONTAGIO | 7,020,122 | 7,020,122 | 0 | 27 |
| DEMO5 | 7,338,569 | 7,338,569 | — | 0 |
| DHADREN | 6,977,694 | 6,977,694 | — | 0 |
| B-STEEL | 7,281,257 | 7,281,257 | — | 0 |
| BRW | 810,954 | 810,954 | — | 0 |
| CMA_SHRT | 5,095,476 | 5,095,476 | — | 0 (port poll, declined) |

Four of ten, one loop each, and where it hits it is 4-58% of everything the
program dispatches. **CONTAGIO is the row worth reading twice**: 27 collapsed
loops and not one dispatch saved. It compiles 7,000 times over a run, so those
27 are the same handful of `jmp $` parking loops recompiled again and again —
never entered. A count of *sites* is not a count of *work*, and this table
prints both so the difference cannot be quietly assumed away.

**These are dispatches, not wall clock, and the distinction matters here more
than usual.** The step budget is spent either way, so the guest ends the slice
in the same place — what changes is that it gets there without executing a
quarter of a million dispatches. In a run that is driving frames, the slice ends
at the same step but sooner in real time, so the host services the timer sooner
and the demo animates faster on the same budget. No throughput number is quoted:
the box was at load 20-40 throughout.

## Validation

- The whole demo corpus — 199 programs — at 8M dispatches, `--no-spin` against
  the default via `tools/toyvm/equiv-dos.js --allow-arena`: **199 same, 0
  differ**. Handbacks, interrupts, billed dispatch count, frame hash, pixels,
  console text and stopping `cs:ip` identical on every one. The billed dispatch
  count is the strong column here, because it *is* `$steps` — the very number
  the spin arm reconstructs by hand rather than counting out. (DD.EXE hit the
  sweep's per-program timeout at load 30+ with three jobs in flight and came
  back SAME run on its own; it does the same on every sweep.)
- `gate.js` 00-0E at 1500 cases each: 22500/22500. Blind here by construction —
  the gate runs one instruction per block and `oneInsn` disables this — so the
  corpus is the check.

## What this is, in JIT terms

Idle-loop detection, which every serious emulator has and this one did not. What
makes it cheap here is the threaded-code representation: the loop is *one word*
in the arena, its shape is a table lookup rather than an analysis, and the
substitution is a single store into the arena at compile time. There is no trace
recording, no guard, no deoptimisation path — the twin handler contains its own
fallback, and it is the same two tests the block transfer already ran.

## The obvious widening has no beneficiary, and that is measured

The narrow rule looked like the place with headroom: a body of several
*provably pure* ops rather than exactly one, on the back of a real purity
property derived from emitted WAT the way `FLAG_EFFECTS` is. This page used to
end by saying the census had to find such loops before that got built.

It was built — `tools/toyvm/spin-census.js` — and the census says they are not
there.

For every block the compiler emitted, it walks the ops by `ARITY`, asks whether
the last one is a branch back to the block's own head, and weights the answer
by `$ip` samples so a shape is scored by *work* rather than by sites:

```
node tools/toyvm/spin-census.js --dir=/tmp/demos --dispatches=2m
```

| population | core ten, 8M each | whole corpus, 199 programs, 2M each |
|---|---|---|
| one-op self-loops (today's rule) | 6.4% of samples | 1.3% |
| multi-op self-loops, any shape | 0.9% | 3.4% |
| …body pure, flag-only closer | **0.0%** | **0.0%** |
| …body pure, counting closer | 0.0% | 0.7% |

**Not one multi-op self-loop in 199 programs has a pure body and a flag-only
closer.** 93 distinct multi-op shapes exist in the core ten alone, and every one
of them writes a register, stores, or touches a port — which is to say every one
of them is a loop that *ends*. That is not a surprise in hindsight: a loop whose
body changes nothing and whose branch reads only flags is a loop with nowhere to
put a counter, and fusion already collapsed that shape to one op. The rule is
narrow because the population is.

So the purity property is not being built. The third row is a ceiling — a real
analysis accepts fewer shapes than this heuristic, never more — and the ceiling
is zero.

Two things the tool had to get right before that number meant anything, both of
which it got wrong first:

- **The closer's own purity decides the class.** `nop -> nop -> loop32` scored as
  a pure loop over nothing until `loop32`'s decrement of ECX was counted:
  that loop terminates, and collapsing it with `(v % S) - S` would be wrong
  rather than slow. Those now report separately as the fourth row.
- **Purity is an allow-list.** A deny-list spelled `$out` does not match
  `$port_out`, so a loop writing the VGA palette came back pure. Anything not
  named as a known reader is impure, so the next helper nobody thought of fails
  closed.

One caveat on the first row: a collapsed spin loop retires almost no dispatches,
so it draws almost no samples — RUNDEMO's loop is 57.7% of its dispatches in the
table above and 0.0% here. The rows that matter for this question are the
uncollapsed ones, which are sampled honestly.

## What is next in this direction

- **The loops worth folding are the ones that DO stop.** The same census, pointed
  at multi-block inner loops instead of self-loops, finds memory-stream shapes
  carrying **24.8% of the corpus** — an RLE sprite blit around `rep_movsb`,
  ~140 sites of it, whose cost is the setup around the copy rather than the
  copy. That is the production interpreter's `RLE_RUN`/`LUT_RUN` family, worth
  +7% to +12% there. [toyvm-stream-loops.md](toyvm-stream-loops.md).
- **The counted delay loop** is small and adjacent. A pure body behind a
  `loop`/`loop32` is 0.7% of the corpus, and *all* of it is one program:
  ALABTRO.COM spends 96.3% of its run in `nop -> nop -> loop32`. The trip count
  is in CX, so the fold is a different one — charge `min(cx * S, budget)` and
  zero CX — and three sites across 199 programs is not a general primitive. It
  belongs to the counted case of the stream fold, not to this one.
- **The port poll.** `in_8 -> cmp_ri8_jz` cannot be collapsed, but 2.15M crossings
  into JS for a retrace bit can be answered inside wasm. That is a host-interface
  change, not a compiler one — and the census now shows the same
  `in_8 -> test_ri8 -> jnz` shape recurring across the corpus, so it is the
  broader of the two remaining leads.

The next idea after this one — pinning the register a handler reaches, which
the same twin-swap machinery makes almost free to express — was tried and did
not pay. [toyvm-reg-specialization.md](toyvm-reg-specialization.md).

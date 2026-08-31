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

## What is next in this direction

The narrow eligibility rule is where the headroom is, and it should be widened
by evidence rather than ambition:

- **A loop body of several provably pure ops.** Needs a real purity property per
  handler (writes nothing but the flag record), derived from the emitted WAT the
  way `FLAG_EFFECTS` already is. The census does not yet say such loops exist in
  the corpus — find them before building it.
- **The port poll.** `in_8 -> cmp_ri8_jz` cannot be collapsed, but 2.15M crossings
  into JS for a retrace bit can be answered inside wasm. That is a host-interface
  change, not a compiler one.

The next idea after this one — pinning the register a handler reaches, which
the same twin-swap machinery makes almost free to express — was tried and did
not pay. [toyvm-reg-specialization.md](toyvm-reg-specialization.md).

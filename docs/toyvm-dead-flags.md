# Dead flag writes in the toy VM

## The observation

Most flag writes are never read. A basic block is typically a few arithmetic
ops and then a compare and a branch, and only the compare's flags are ever
looked at. Every `add`, `sub`, `or` and `and` before it computed six flags —
or, since [toyvm-lazy-flags.md](toyvm-lazy-flags.md), stored six globals — for
nobody.

Whether a particular write is dead is not a property of the instruction. It is
a property of the **block**, and the compiler has the block in hand: walk it
backwards, and a write is dead if some later op overwrites the whole flag state
before anything reads it.

So `emit.js` generates, for every handler it can, a second copy of that handler
with the flag write deleted, and `compile.js` swaps it in where the walk proves
the write dead. 228 such variants exist today, taking the table from 920 to
1148.

## Two questions the generator has to answer, and cannot answer by hand

For each handler: does it **read** the flags it was entered with, and does it
**overwrite** all of them? A hand-written table of 920 answers would be wrong
within a week, and wrong here means a program computes with a flag that was
deleted — so both are derived from the generated WAT itself.

They cannot be read off a handler's own body. A rotate handler's body says
`call $sh_rcl16` and the `$get_cf` is inside that helper. So `analyzeFlags()`
parses every `(func ...)` in the module, classifies each flag touch, and
propagates read/write sets to a fixpoint over the call edges.

Three things make the difference between an analysis that works and one that
looks like it works:

**Order is the closing paren, not the operator.** WAT is folded, so `cmc` is

```wat
(global.set $flags (i32.xor (global.get $flags) (i32.const 1)))
```

The write is *written* first and *happens* last. Reading events in written
order makes `cmc` a killer that reads nothing, which deletes the compare in
front of it — and `cmp / cmc / ret` is a real sequence, in DEMO5.EXE, which
stopped at a keyboard prompt 1.6M dispatches in and never reached its CGA
picture. Events are ordered by the close of their s-expression.

**A conditional write kills nothing.** `rep_scasb` with CX=0 records nothing at
all. A write only retires an earlier one if it happens *every* time, so an event
counts as a kill only at statement depth — not inside an `(if`, a `(loop` or a
`(block` — and a body containing `(return)` or a `(br` is not credited with
killing anything at all.

**Reaching the host is a read.** `dos-loop.js` reads and writes the flags word
on a hooked IRET, and an interrupt injected at a handback pushes FLAGS onto the
guest stack. A record the guest never reads may still be observed. This is
placed in text order too: a fused `cmp_ri8_jz` hands back through `$jlook` only
after its own compare overwrote the record, so what the host sees is never the
previous op's flags.

The three fall out as `readsIn` (does it read what it was entered with — the
only question that decides whether the write in front of it is live) and
`kills`. `inc` shows why they are separate: `$rec_inc` calls `$get_cf` before it
records, because CF is preserved across an increment, so an `inc` fully
determines the flags afterwards *and* keeps the previous write alive.

## What the walk does

Backwards from the end of the block, with the flags **live at the block end** —
they have to be, since the next block may read them and a handback at a block
end is where an interrupt gets injected.

```
live = e.readsIn ? true : (e.kills ? false : live)
```

and an op with `kills && !live` is swapped for its flagless copy. The liveness
entering it is then computed from the handler that is there *now*: dropping the
write also drops whatever read fed it.

The walk is the same one `fuseTail` does, over the same word range, with the
same refusal — if the arity table and the arena disagree about where the op
boundaries are, it declines rather than rewriting an operand. It runs **after**
fusion, which matters: a fused compare-and-branch reads the record its own half
just made and never the flags it was entered with, which makes it the most
common killer in the corpus and the thing that lets the arithmetic in front of
it go flagless.

## Measured: how much is actually dead

Static count is printed on every run (`N flagless ops of M` words). The number
that matters is the dynamic one — the share of dispatches that landed on a
flagless handler — which comes from `--handler-hist` by summing the `_nf` rows.
Core ten, 8M dispatches:

| program | dispatches on a flagless op |
|---|---|
| DHADREN | 23.5% |
| CYCLE | 22.6% |
| BRW | 17.1% |
| ACCIDENT | 13.3% |
| CONTAGIO | 6.1% |
| DTM2 | 3.6% |
| DEMO5 | 2.2% |
| B-STEEL | 0.6% |
| RUNDEMO | 0.3% |
| CMA_SHRT | 0.3% |

Two orders of magnitude apart, and the reason is visible in DTM2's own pair
census: its hot chain is `sub_ri16 -> sbb_ri16_jb -> cmp_rm8_jz`, and the `sbb`
reads the carry the `sub` just wrote. Nothing there is dead. A program whose
arithmetic feeds addresses rather than conditions has almost all of it dead.

## Measured: what it is worth

**Not resolvable on this box, and the data says so out loud.** Core ten, 20M
dispatches, five interleaved reps, guest-slice CPU time, load 11: geomean
**+2.1% by minimum, -0.8% by paired ratio**, with the two metrics disagreeing on
the sign for four of the ten programs.

The tell is not the disagreement, it is *which* programs won:

| program | flagless dispatches | min | paired |
|---|---|---|---|
| CYCLE | 22.6% | +6.3% | +2.9% |
| ACCIDENT | 13.3% | +5.4% | +5.7% |
| **RUNDEMO** | **0.3%** | **+6.8%** | **+5.9%** |
| DHADREN | 23.5% | +3.8% | **-4.7%** |
| B-STEEL | 0.6% | **-7.3%** | **-11.5%** |

RUNDEMO has essentially nothing to eliminate and "wins" by 6.8%; B-STEEL has
nothing to eliminate and "loses" by 7.3%. That is the noise floor, and it is
wider than anything this change could produce.

The expected size says the same thing from the other end: a flagless `cmp` saves
five or six global stores out of a handler that also pays a dispatch, so even
the 23% programs are arguing over a percent or two.

**It is kept on the argument from construction rather than the measurement.**
The two arms run the same ops with the same operands, retire the same dispatches
and the same `$steps`, and lay out the same arena; one of them does strictly
less work per op. There is no mechanism by which that is slower. So the risk
worth spending effort on is not performance, it is whether "nobody reads this"
is actually true — which is what the sweep below is for, and which is where the
one real bug in this change was found.

## Validation

**The op stream does not change.** Only the handler index in a word changes, so
the two arms lay out the same arena, retire the same steps and take their
interrupts at the same instructions. Unlike fusion, which legitimately shrinks
the arena, dead-flag elimination must be **bit-identical**.

- The whole demo corpus at 8M dispatches, `--no-deadflags` against the default:
  **177 programs, 177 identical** (`/tmp/equiv-deadflags.sh` shape: grep the
  handbacks/frame/console/`cs:ip` lines from both arms and compare) — handbacks, interrupts, traces, arena size,
  recycles, frame hash, pixel count, console text and stopping `cs:ip`.
- `gate.js` 00-0E at 2000 cases each: 30000/30000. Note that the gate is
  **structurally blind** to this, the way it is to the fused-branch
  specialization: it runs one instruction at a time, and a one-instruction block
  has nothing dead in it. The corpus is the check.

`--no-deadflags` on `run-dos.js` and `tailcall+nodeadflags` on `bench-dos.js`
are the A/B partners. `--trace-deadflags` prints every op that lost its write
along with the whole block it was in — a wrong answer here is always a later op
wrongly believed to overwrite the flags, and the block is the only place that
shows which one. `[deadflag] cmp_ri16 in block cmp_ri16 cmc ret` is what found
the folded-order bug.

## What is next in this direction

The variants exist for 228 of 425 flag-writing handlers. The ones without are
mostly the partial writers (`cld`, `sti`, `daa`) and anything whose write goes
through a helper that does other work. Widening that set is mechanical but the
remaining handlers are cold.

The larger prize is not more handlers, it is a longer window. Liveness stops at
the block end because the next block might read the flags — but a compiled
region knows its own successors, and a compare whose flags are dead across the
first instruction of every successor is dead in fact. That is the same
information the trace extension in
[toyvm-superinstructions.md](toyvm-superinstructions.md) needs.

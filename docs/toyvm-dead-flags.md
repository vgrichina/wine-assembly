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

Backwards from the end of the block:

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

## Where the walk starts, which is the whole question

The first version started every block with the flags **live at the end** — the
next block might read them, so assume it does. That is one assumption too many:
this compile emitted the next block too, and it can look.

So the block end is a `liveOut`, and `liveOut` is the OR of the successors'
`liveIn` — a least fixpoint over the region, starting from "nothing is live"
and growing, which is the correct direction for a may-read property and
terminates. **The successors are exactly the control edges the block already
recorded as fixups**: one for a `jmp`, two for a conditional, and *none* for a
`ret`, an indirect jump or a handback, which are the cases that keep the old
answer. A fixup whose target this compile never emitted resolves to 0, which the
branch handlers read as "hand back", so those blocks keep the old answer too.
Nothing here needed a new data structure; the edges were already in hand.

### The block end is also a handback, and that is the part that had to be split

A slice does not end where the step counter hits zero — it ends at the next
block boundary, because `$gip` is only published there (the comment on `CONT` in
`emit.js`, and CARRIE.EXE, which re-ran its unpacking loop's prefix once per
expired slice back when it did not). So **every** block edge is a place the host
can take over and inject an interrupt that pushes FLAGS. That is why
`analyzeFlags` counts reaching the host as a read, and it is why `jmp` — which
touches no flag at all — came back `readsIn: true` and pinned everything in
front of it.

But there are two kinds of host exit and they were the same event:

- `end`, `iret`, a fault, an indirect transfer through `$jlook`: the host
  resumes the guest somewhere this compile knows nothing about.
- the budget-expired or self-patched handback at a block boundary: the host
  resumes at `$gip`, which is **the successor's own head** — a block this
  compile emitted and has just walked.

The second is now its own function, `$slice_exit`, for no reason other than that
the analysis can name it. It yields a second answer per handler, `readsInX`,
which is `readsIn` with slice exits not counted, and the walk uses it for a
block's **last** op when that block's successors are all known. Only the last
op: a handback in the middle of a block resumes at *that instruction's* guest
address and starts a compile this one cannot see.

11 handlers of 1148 differ between the two answers, and they are the ones that
matter — `jmp`, `loop`, `jcxz`, `call_rel`, `ret` and their 32-bit twins.
`tools/toyvm/flag-effects.js` prints the table.

### Why self-modifying code does not break it

A block's flagless decision now depends on bytes outside the block. It does not
depend on bytes outside the **region**: a successor edge never leaves one, since
an edge this compile did not emit is a handback. And the host drops a compiled
region whole (`invalidateRange` in `dos-loop.js`), so a guest that rewrites a
successor throws away the predecessor that was compiled against it.

### What is still assumed

An interrupt injected at a slice exit runs a guest ISR whose code is not a
successor of this block. The CPU pushes FLAGS and the matching IRET restores
them, so the arithmetic bits go out stale and come back stale, and the successor
— which by construction does not read them — cannot tell. The residue is an ISR
that *inspects* the interrupted context's arithmetic flags before writing its
own, which a hardware IRQ handler has no reason to do. TF and IF, the two bits
`dos-loop.js` reads for itself, are outside `FLAGS_ARITH` and are never
deferred, so nothing on the host side moves either way. `--no-crossflags` is the
A/B partner and the corpus check below is what this rests on.

## Measured: how much is actually dead

Static count is printed on every run (`N flagless ops of M` words). The number
that matters is the dynamic one — the share of handler entries that landed on a
flagless handler, which is the sum of the `_nf` rows of `--handler-hist=9999`
over the `handler entries` total on its own header line. (Sum the handler
census only. The *pair* census below it is a second listing of the same
dispatches and adding it in roughly doubles every figure; an earlier version of
this table did that, and the numbers here supersede it.)

Core ten, 8M dispatches, with and without the cross-block window:

| program | flagless dispatches | block-only |
|---|---|---|
| CYCLE | **16.4%** | 15.3% |
| DHADREN | **14.3%** | 13.6% |
| ACCIDENT | **13.9%** | 10.5% |
| BRW | **10.5%** | 9.8% |
| CONTAGIO | **6.6%** | 5.4% |
| DTM2 | **4.1%** | 4.0% |
| B-STEEL | **3.0%** | 0.6% |
| DEMO5 | **2.3%** | 2.3% |
| CMA_SHRT | **0.3%** | 0.3% |
| RUNDEMO | **0.3%** | 0.3% |

Crossing the edge is worth most where the old walk found least: B-STEEL goes
0.6% → 3.0%, a five-fold gain on the program that had almost nothing to
eliminate, and ACCIDENT picks up 3.4 points. Both are programs whose blocks end
in an unconditional `jmp`, which is precisely the terminator the old rule
pinned. Where the win was already large it is incremental — a block ending in a
fused compare-and-branch already killed its own flags, so its predecessors were
never blocked in the first place. The two that do not move at all (RUNDEMO,
CMA_SHRT) have no dead flag writes to find by either rule.

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
| CYCLE | 15.3% | +6.3% | +2.9% |
| ACCIDENT | 10.5% | +5.4% | +5.7% |
| **RUNDEMO** | **0.3%** | **+6.8%** | **+5.9%** |
| DHADREN | 13.6% | +3.8% | **-4.7%** |
| B-STEEL | 0.6% | **-7.3%** | **-11.5%** |

RUNDEMO has essentially nothing to eliminate and "wins" by 6.8%; B-STEEL has
nothing to eliminate and "loses" by 7.3%. That is the noise floor, and it is
wider than anything this change could produce.

The expected size says the same thing from the other end: a flagless `cmp` saves
five or six global stores out of a handler that also pays a dispatch, so even
the 15% programs are arguing over a percent or two. The same holds for the
cross-block window on top of it: it moves the flagless share by a few points on
half the set, which is a fraction of a fraction, and this box resolves neither.

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
  **177 programs, 177 identical** — handbacks, interrupts, traces, arena size,
  recycles, frame hash, pixel count, console text and stopping `cs:ip`.
- The same sweep for the cross-block window, `--no-crossflags` against the
  default: **199 programs, 199 identical**, on the same columns. (199 rather
  than 177 because the sweep tool walks the corpus itself and picks up the
  `.COM` files too.)
- `tools/toyvm/equiv-dos.js` is that sweep. It had been written from scratch
  four times — for fusion, lazy flags, the fused-branch specialization and this
  — as a throwaway shell script that was gone by the next session, so it is a
  tool now: `node tools/toyvm/equiv-dos.js --dir=/tmp/demos --arm=--no-crossflags`.
  It masks the three things an arm is allowed to move (wall clock, throughput,
  the flagless-op count) and diffs everything else line by line.
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
through a helper that does other work. `tools/toyvm/flag-effects.js --no-nf`
lists them; widening the set is mechanical, but the remaining handlers are cold.

The window is now the region rather than the block, and what still stops it is
the handback whose resume point the compiler cannot see: a `ret`, an indirect
jump, an unresolved edge. A `ret` is the one worth taking — the return address
is on the shadow stack and `call_rel` already carries the arena address of its
own return point as an operand, so a call site's successor block is known at
compile time even though the `ret` itself is not. Threading that through would
close the largest remaining class.

Past that it is no longer a liveness question but a shape one: the trace
extension in [toyvm-superinstructions.md](toyvm-superinstructions.md), which
compiles *through* a conditional branch and so removes the block edge instead of
reasoning across it.

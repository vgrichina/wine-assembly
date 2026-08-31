# The loops that are worth folding are not the ones that stop

## How this question came up

The spin fold does not run a loop that cannot end. Widening it — a body of
several *provably pure* ops instead of exactly one — was the obvious next move,
and [toyvm-spin-loops.md](toyvm-spin-loops.md) records that it has **no
beneficiary at all**: zero samples, in 199 programs. A loop whose body changes
nothing has nowhere to put a counter, and fusion already collapsed that shape to
one op.

The census built to answer that question (`tools/toyvm/spin-census.js`) was then
pointed at the general case, and the general case is large.

## What a self-loop census cannot see

The first version only recognised a loop that branches back to *its own block
head*. That is one basic block, and almost nothing real is one basic block: a
blitter is a bounds check, a body and a counter, which is two or three.

Generalising to "a backward edge to any earlier block head in the same region"
needs one bound to be useful. Without it the edge swallows every block in
between and reports the enclosing function: measured on BRW, the top six rows
came back as 69-72 block, ~200-op "loops" whose bodies were full of `call_rel`.
So the census counts **inner** loops — `--max-blocks=8 --max-ops=64` — and every
number below is a floor for that reason and one more: a loop whose head was
compiled into a different region is invisible to it.

## Measured

`$ip` samples, so shares are weighted by work rather than by sites.

```
node tools/toyvm/spin-census.js --dir=/tmp/demos --dispatches=2m
```

| population | core ten, 8M each | whole corpus, 199 programs, 2M each |
|---|---|---|
| one-op self-loops (the spin fold) | 6.4% | 1.3% |
| multi-op self-loops, any shape | 0.9% | 3.4% |
| …body pure, flag-only closer | **0.0%** | **0.0%** |
| …body pure, counting closer | 0.0% | 0.7% |
| multi-block inner loops | 36.1% | 48.0% |
| **…stream-shaped** | **10.0%** | **24.8%** |

**That last row is an upper bound and the real predicate is a third of it.**
`tools/toyvm/loop-match.js` summarizes each loop from
[handler-effects.js](../tools/toyvm/handler-effects.js) — induction variables,
memory streams, trip count, leftover side effects — and applies the fold's
actual conditions:

```
199 programs, 10007 inner-loop sites
matched 1480 sites, 11124 samples -- 8.1% of the run
  LUT_RUN 4.2%   SCAN_RUN 2.8%   FILL_RUN 0.8%   COPY_RUN 0.2%
```

8.1% corpus-wide, and **2.9% on the core ten** against the coarse test's 10.0%.
A 3.4x over-count is exactly the failure `tools/match-loops.js` exists to
prevent for the production interpreter, whose own note is that a loose regex
reads stack-counter loops as `lut`. Quote the predicate, not the shape guess.

The decline histogram is the work list:

```
   1737  in_8            \  a port read: a real loop with a real exit
    930  retf_imm         |
    903  ret              |  1834 sites where the "loop" spans a function
    603  call_rel         |  boundary -- see the caveat below
    229  call_far        /
    704  touches the stack
    544  no memory stream
    344  mixed access widths
    291  writes a segment register
```

**Read the `ret`/`call` rows sceptically.** A `ret` inside a loop body more
likely means the backward-edge interval stitched across a function boundary
than that a real loop contains a return. That subset wants re-reading before it
is treated as headroom. And per §4.4 of
[loop-idiom-superops-design.md](loop-idiom-superops-design.md) a loop
containing a call is not Design B's territory either — a body op that can
re-enter the emulator must disqualify the block, because a wrapper holds `ip`
across iterations and a nested decode can flush the arena underneath it. Loops
with calls are an inlining problem, not a loop-lowering one.

"Stream-shaped" is deliberately coarse — a memory write, plus an induction
variable or a memory read, and *nothing* that leaves the loop's own control (no
call, no interrupt, no port, no return). It says the ops are the right kind, not
that the addresses line up. It is the toy VM's cheap analogue of what
`tools/match-loops.js` asks of a PE for the production interpreter, and the real
predicate will accept fewer.

It is concentrated rather than universal, which matters for what to build:

| program | stream share | the shape carrying it |
|---|---|---|
| ACCIDENT | 36.5% | `mov_rm16 sh4_r16 xor_rr16_nf mov_mr16 cmp_mi16_jnz inc_m16 jmp` |
| RUNDEMO | 33.9% | `mov_rm8 stosb loop sh2_r16 inc_r16 inc_r16 lodsb …` |
| DHADREN | 18.1% | `mov_mi16 jmp mov_rm16 cmp_rm16_ja_t` |
| BRW | 4.4% | `lodsb32 sh5_r8 or_rr8_jz stosb32 loop32` |
| DTM2, CYCLE, CMA_SHRT, DEMO5 | ~0% | — |

## The family, and where the cost actually is

Corpus-wide the top shapes are one family, ~140 sites of it:

```
mov_rm8  lodsb  mov_rr8  push_r16  mov_rr16  sub_rr16  cli  rep_movsb  sti  pop_r16 ...
```

Read a count byte, point `DS:SI` and `ES:DI` at the run, `rep movsb` it, repeat.
An RLE sprite blit — the same shape `tools/find-rle-nests.js` found in Caesar
III for the production interpreter.

**And `rep_movsb` is already one op that copies the whole run inside WAT.** So
the per-run cost is not the copying; it is the ten ops of *setup* around it,
paid once per run, where a run is often only a few bytes. That is exactly the
situation `RLE_RUN` addresses in `src/07b-loop-match.wat`, measured there at
**+7% batches/s and +21% API/s** on Caesar. `rect_run` in the same family is
+12% end-to-end.

BRW's smaller one is worth reading too — `lodsb32 sh5_r8 or_rr8_jz stosb32
loop32` is load, shift, **branch if zero**, store, count down: a transparent-pixel
blit, which is `LUT_RUN`'s shape.

## What the fold has to prove

The production matcher's guards apply unchanged, and they are the work:

- **The streams must not alias.** Source and destination ranges are computed
  once from the induction variables and the trip count, and the fold is declined
  if they intersect — otherwise a copy that overlaps itself byte by byte gives a
  different answer than a bulk move.
- **The induction variables must be affine in the trip count**, so the final
  register state can be written directly rather than iterated to.
- **Step parity is not optional.** A folded loop must charge exactly the steps
  the unfolded one spent, the way fusion charges its swallowed dispatch inline
  and the spin fold writes `(v % S) - S`. Without it `$steps` moves, slice
  boundaries move, interrupts land on different instructions, every frame in the
  corpus legitimately changes, and the 199-program diff stops being a check on
  the transformation. That check is the only reason any of this is verifiable.
- **The budget is spent inside the loop, not around it.** A fold that runs an
  unbounded trip count in one op can overrun a slice by an arbitrary amount; the
  trip count has to be clamped to what the remaining budget pays for, with the
  rest resumed on the next entry.

## The counted delay loop

A pure body behind a `loop`/`loop32` is the fourth row above — 0.7% of the
corpus, three sites, and **all** of the weight is one program (ALABTRO.COM
spends 96.3% of its run in `nop -> nop -> loop32`). The arithmetic differs from
the spin fold's because the loop *ends*: the trip count is in CX, so it is
`min(cx * S, budget_remaining)`, CX decremented by what was run, and a fall
through to the not-taken edge when it reaches zero.

Note it still has to **charge the steps**. A delay loop is the guest deliberately
buying time; making it free would advance the guest past its own timer ticks.
What the fold buys is that the host spends near-zero real CPU getting there —
the same trade the spin fold makes.

Three sites in 199 programs is not a general primitive, so this is written down
rather than built. If it happens, it should fall out of the counted-loop case of
the stream fold above, not be a special case of its own.

## The other two designs, and why one of them looks better

Folding an idiom is Design A in
[loop-idiom-superops-design.md](loop-idiom-superops-design.md). Two alternatives
apply here and both are cheaper to be right about.

**Design B — wrap the loop, run the same ops.** No shape library: if a block
branches to its own head, a wrapper op drives the body in a native loop. It
removes, per iteration, N copies of the `$next` preamble *plus one trip through
the back edge* — the branch handler returning out to `$run`, the run preamble,
a `cache_lookup` — and that back-edge round trip is its largest single item. It
keeps one indirect dispatch per op, so it cannot approach A where A fires; but
it **cannot be semantically wrong**, since it runs the same ops in the same
order, and it fires on every loop rather than on 8.1% of them. Its payoff is
largest on short bodies, and the toy VM's are short: 2-7 ops is typical here.

**Design C — B on the `switch` shell.** The toy VM already has a dispatch shell
that is one giant `br_table` with every handler body inlined into a single
function, so it pays no call frame, no stack-limit check and no interrupt check
per op. B's own accounting says it removes everything except the indirect
*call* — and a `switch` build has no indirect call, only an indirect branch
inside one function. So B-on-switch strictly dominates B-on-tailcall.

Read [toyvm-dispatch-shootout.md](toyvm-dispatch-shootout.md) before assuming a
number: `switch` measured +11.9% corpus geomean but **+5.4% on the programs
that actually rendered**, bimodally (DSTNFO +40.1%, COPPER −26.0%, both
reproduced), because inlining every body into one function makes the result
depend on whether that program's hot handlers fit the engine's budgets.

**Why the hoisting is worth doing here when it failed before.**
[toyvm-superinstructions.md](toyvm-superinstructions.md) rejected a block-head
"charge the whole block's steps at once" op on the grounds that DTM2 runs 3.25
ops per block transfer — one added dispatch to save 3.25 decrements. Inside a
loop the wrapper is one dispatch amortized over *iterations x ops*: a 5-op loop
running 100 times is 500. Same idea, different arithmetic, and that difference
is the entire argument.

**But keep the two hoists apart.** The per-iteration bookkeeping — steps, halt
test, `ip` advance, arena bound check, back edge — is structural and needs no
semantics. Hoisting the *memory* bounds check needs the address range, which is
A's stream analysis. The memory half of the idea rides on the matcher; the
dispatch half does not.

## Status

Nothing is folded. Two tools are built and are what the decision rests on:
`tools/toyvm/handler-effects.js` (what each handler touches, 87.2% readable)
and `tools/toyvm/loop-match.js` (the predicate, 8.1%).

The order that follows from the numbers: **B or C first**, because they fire on
every loop and cannot be wrong, then A on the shapes that match.

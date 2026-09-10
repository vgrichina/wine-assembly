# How much of a DOS demo is an expression?

`tools/toyvm/expr-fold-census.js`, core ten + three, 20M dispatches each.

Three questions, in order: how much of a run is a foldable straight line
("What is measured" below), how blocks END and therefore whether a fold pays
once per entry or once per loop turn ("How blocks END"), and what three
specific modelling declines are costing ("Relaxing the barriers"). The short
answers: 22-50% foldable at a p50 run of 0-2; three quarters of the ops are not
in a loop block at all and only BRW has real collapsible-loop mass; and
partial-register modelling is worth more than the other two relaxations put
together, while constant-address disambiguation is worth nothing.

## The question, and what a "yes" would buy

Threaded code pays a dispatch per guest op and moves every intermediate through
the guest register file in linear memory. A **decode-time integer expression
fold** would take a block's straight-line interior and lower it to one wasm
expression tree: intermediates in wasm locals, only the registers live out of
the block stored back, and **one dispatch for the whole run** instead of one per
op.

That is a strictly bigger idea than the two folds already shipped.
[Fusion](toyvm-superinstructions.md) joins exactly two ops and pays one dispatch
instead of two; [spin loops](toyvm-spin-loops.md) collapse a self-loop that does
nothing. This one would collapse *n* ops of real arithmetic into one dispatch
for any *n*.

So the first question is not how to build it. It is **how much of a real run is
shaped like that** — and this page is that measurement and nothing else. It is a
**ceiling**, not a prediction, for the reason this repo keeps re-learning in
[toyvm-trace-blocks.md](toyvm-trace-blocks.md) §"what it is actually worth":
removing a cost on paper is not the same as the run getting faster.

## What is measured

**The unit is a retired guest op**, not a dispatch. A `cmp_ri8_jz` word is one
dispatch and two guest ops, and it is counted as two — otherwise every fusion
already shipped would read as work that had vanished. The census inverts
`emit.js`'s five rewrite tables (`FUSE`, `TRACE`, `SPIN`, `PSPIN`, `NOFLAG`) to
get a compiled word's constituents back.

**The weights are exact per-block counts, and they are new.** Neither existing
facility could produce them:

* `--handler-hist` is indexed by handler NUMBER. It says a run retired 4.1M
  `mov_rr16` dispatches; it cannot say which block they were in, so it can
  weight an *opcode* census and never a *block* one.
* `region-jit.js`'s profiler samples `$ip` at slice expiry — one sample per
  ~20000 dispatches. On a corpus whose blocks average around three ops that is
  three orders of magnitude short.

So this adds **`--block-hits`** to `run-dos.js`: `isa.IPHIST_BASE`, one u32 per
ARENA WORD, bumped in `$next` (`emit.js:ipHistBump`) while `$ip` still points at
the opcode word. The counter at a block head is the block's entry count; the
counters across its words are its retired-op profile. Exact, and independent of
box load. A block left through the middle — a handback, an expired slice, a
taken branch out of a traced tail — is counted at the ops it actually ran.

The table is reserved unconditionally (1MB, against the ~16MB the pair table
already reserves) so `MEM_PAGES` does not depend on a debug switch: a census
build whose memory is a different size is measuring a different machine.
`--block-hits` costs one load/add/store per dispatch, so **timings from such a
run mean nothing and its counts are exact** — the same deal `--handler-hist`
makes. Verified equal: DTM2 at 3M dispatches with and against the flag produces
identical handbacks, interrupts, traces, arena footprint, frame hash `38c165c5`
and stopping `cs:ip`; only the wall clock differs.

**The ops classified are the arena's**, walked word by word with `ARITY`, so the
classifier sees exactly what the interpreter dispatched, fusions and all — not a
disassembly that might disagree. What each op *does* (registers written, memory
touched and at what width, whether it escapes analysis) comes from
`tools/toyvm/handler-effects.js` rather than a second name table here.

### FOLDABLE

Full width only — 16-bit in real mode, 32-bit under a 32-bit code segment, the
block's width taken from the ops it actually contains:

`mov` (including the `moffs` absolute forms) · `lea` · `add` `sub` `and` `or`
`xor` · `imul2`/`imul3` · `neg` `not` · `inc` `dec` · `shl` `shr` `sal` `sar`
**by immediate** · `movzx` `movsx` · register or memory operands.

`inc`/`dec` are the one addition to the brief's list, on the grounds that they
are `add`/`sub` by one and their carry-preserving quirk only matters to a flag
consumer, which is a barrier anyway. **Their contribution is reported in its own
column so it can be subtracted**, and on two programs it is most of the answer
(BRW 16.4 of 35.2 points, CHROME 16.6 of 30.3).

### BARRIERS

| class | what it is | why it stops a run |
|---|---|---|
| `partial-reg` | any 8-bit op; any 16-bit op under 32-bit code | AL/AH are subfields of AX in the register file, so an intermediate in a wasm local cannot survive one without modelling the overlap |
| `branch` | Jcc, `jmp`, `loop`, `jcxz` | ends the block |
| `terminator-flags` | the `cmp`/`test` feeding the block's terminator | **the normal shape, not a failure** — reported separately for exactly that reason |
| `flags` | a `cmp`/`test` anywhere else, `setcc`, `lahf`/`sahf`, `pushf`/`popf`, `rcl`/`rcr`, `clc`/`stc`/`cmc`, BCD | a real flag write somebody may read |
| `adc-sbb` | `adc`, `sbb` | reads CF |
| `shift-cl` | a shift whose count operand is decode.js's `-1` sentinel | count is CL, not a constant |
| `muldiv` | `mul`, `imul` (1-operand), `div`, `idiv` | implicit DX:AX pair |
| `stack` | push/pop/pusha/popa/enter/leave | |
| `string` | movs/stos/lods/scas/cmps/ins/outs, REP or not | |
| `segment` | segment-register moves, `les`/`lds`/`lfs`/`lgs`, seg push/pop | |
| `call` `ret` `int` | | |
| `io` | `in`, `out` | leaves the VM |
| `fpu` | x87 | |
| `other` | everything left | the classifier's own work list |
| `alias` | a store, then a load inside the same run | splits the run rather than ending it — this classifier proves nothing about addresses, so every load after a store is assumed to alias |

Per block it also reports the foldable op count, the longest maximal foldable
run (with alias splits applied), loads, stores, and a **conservative** live-out
count: every register any op in the block writes.

## The corpus

Core ten (`tools/toyvm/bench-set-core10.txt`), plus three chosen because they
should have long trees: **ENDPART** and **MAINPART** are the two parts of
BlackTech's *Vector Shock* — its own `FILE_ID.DIZ` says "realtime 3D graphics" —
and **CHROME** is a 4KB ASM'95 intro. RUNDEMO, already in the core ten, is
*Vector Shock*'s launcher.

Standard sweep flags: `--pit-clock --auto-key --sound-pref=sb
--env=ULTRASND=220,1,1,11,7`, `--dispatches=20m`.

| program | retired ops | attributed | foldable | of which inc/dec | in >=4-fold blocks | run p50 / p90 / max | loads | stores |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| DHADREN | 2,339,522 | 100.0% | **34.6%** | 14.3% | 35.6% | 1 / 3 / 11 | 387,913 | 155,484 |
| DTM2 | 4,406,067 | 100.0% | **24.5%** | 1.6% | 13.0% | 1 / 2 / 12 | 1,261,141 | 245,276 |
| ACCIDENT | 18,531,892 | 100.0% | **49.6%** | 7.3% | 42.4% | 1 / 4 / 21 | 8,068,001 | 1,441,116 |
| B-STEEL | 13,834,928 | 100.0% | **39.1%** | 6.0% | 20.2% | 1 / 3 / 9 | 3,067,663 | 1,695,322 |
| RUNDEMO | 7,927,776 | 93.9% | **35.0%** | 3.9% | 28.4% | 0 / 2 / 162 | 2,884,029 | 782,960 |
| CMA_SHRT | 9,595,368 | 47.9% | **22.6%** | 0.0% | 13.5% | 1 / 1 / 9 | 1,577,465 | 985,481 |
| CONTAGIO | 2,342,434 | 21.4% | **22.5%** | 6.3% | 7.9% | 1 / 1 / 12 | 454,038 | 178,222 |
| CYCLE | 19,475,725 | 100.0% | **9.6%** | 0.3% | 14.0% | 0 / 0 / 7 | 4,697,877 | 34,831 |
| DEMO5 | 4,033,759 | 81.7% | **24.5%** | 1.9% | 16.3% | 0 / 2 / 41 | 672,355 | 112,152 |
| BRW | 18,158,199 | 99.9% | **35.2%** | 16.4% | 53.7% | 2 / 3 / 13 | 4,244,739 | 1,777,249 |
| ENDPART | 4,783,756 | 100.0% | **30.0%** | 15.1% | 13.3% | 0 / 2 / 11 | 1,414,846 | 665,112 |
| MAINPART | 2,838,891 | 100.0% | **25.5%** | 7.5% | 0.9% | 0 / 2 / 8 | 1,037,779 | 459,943 |
| CHROME | 80,001 | 100.0% | **30.3%** | 16.6% | 5.3% | 1 / 2 / 7 | 11,735 | 9,341 |

**Read `attributed` before anything else in a row.** It is the share of arena
dispatches that landed in a block still compiled at exit. The counter table is
keyed by arena ADDRESS, and a program that recycles the arena reuses one address
for several blocks, so CONTAGIO (21.4%) and CMA_SHRT (47.9%) are censuses of the
minority of their work that survived to be attributed, not of the whole run.
Their rows are indicative; the eleven rows at 82–100% are the measurement.

**And read CHROME's `retired ops`, not its percentage.** 20M *billed* dispatches
produced 80,001 trips through `$next` — it is a spin-loop program, and the
`--handler-hist` caveat applies verbatim: billed is guest work, this is trips
through dispatch. 30.3% of 80,001 ops is not a lever.

### Barriers, by retired ops blocked

| program | branch | partial-reg | terminator-flags | stack | string | adc-sbb | io | shift-cl | flags | muldiv | call | ret | segment | other | fpu | int |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| DHADREN | 19.8% | 17.2% | 9.3% | 3.2% | 1.9% | 0.7% | 4.6% | 0.6% | 3.6% | 0.6% | 1.0% | 1.1% | 0.4% | 1.0% | - | 0.0% |
| DTM2 | 15.7% | 18.0% | 7.1% | 13.9% | 0.0% | 4.0% | 6.0% | 0.0% | 1.5% | 0.5% | 3.2% | 3.2% | 2.2% | 0.1% | 0.0% | 0.0% |
| ACCIDENT | 23.1% | 5.5% | 15.3% | 1.1% | 1.3% | 0.6% | 0.4% | 0.1% | 0.6% | 0.5% | 0.5% | 0.5% | 0.4% | 0.5% | - | 0.0% |
| B-STEEL | 15.4% | 6.8% | 4.0% | 12.3% | 3.1% | 0.2% | 3.0% | 0.0% | 1.6% | 1.0% | 5.1% | 5.1% | 2.9% | 0.4% | - | 0.0% |
| RUNDEMO | 25.0% | 15.5% | 6.4% | 1.0% | 6.1% | 2.2% | 0.1% | 0.1% | 1.8% | 2.5% | 0.2% | 0.2% | 3.2% | 0.8% | - | 0.0% |
| CMA_SHRT | 18.8% | 43.2% | 8.4% | 0.2% | 0.0% | 0.0% | 0.0% | 0.0% | 2.1% | 0.0% | 2.1% | 2.1% | 0.1% | 0.1% | - | 0.0% |
| CONTAGIO | 27.9% | 27.6% | 6.8% | 0.8% | 0.4% | 6.1% | 1.6% | 0.0% | 2.4% | 0.6% | 0.2% | 0.2% | 0.5% | 2.5% | - | 0.0% |
| CYCLE | 48.2% | 6.5% | 21.3% | 3.3% | 0.0% | 4.2% | 0.0% | 0.0% | 4.2% | 1.3% | 0.5% | 0.5% | 0.0% | 0.4% | - | 0.0% |
| DEMO5 | 14.2% | 2.9% | 3.9% | 25.4% | 0.9% | 0.0% | 0.0% | 0.0% | 6.7% | 0.0% | 8.1% | 8.1% | 0.0% | 4.2% | 0.0% | 0.6% |
| BRW | 12.7% | 34.9% | 0.2% | 0.2% | 3.5% | 1.5% | 7.3% | 3.9% | 0.2% | 0.0% | 0.2% | 0.2% | 0.1% | 0.1% | - | 0.0% |
| ENDPART | 25.0% | 25.3% | 3.5% | 2.9% | 9.8% | - | 0.0% | 0.0% | 0.1% | 1.3% | 0.2% | 0.2% | 0.1% | 1.6% | - | 0.0% |
| MAINPART | 26.1% | 22.4% | 0.1% | 0.4% | 18.1% | - | 0.0% | 0.2% | 0.3% | 3.4% | 0.0% | 0.0% | 0.0% | 3.4% | - | 0.0% |
| CHROME | 80,001 ops total — see above | 11.5% | 12.1% | 2.1% | 5.1% | 0.1% | 0.3% | 0.0% | 7.4% | - | - | 0.0% | 0.0% | 1.6% | 0.0% | 0.0% |

**Two barriers are 40–60% of every row, and only one of them is negotiable.**
`branch` + `terminator-flags` is the block boundary itself — that is a fact
about basic-block size (~3 ops, the same 3.25 dispatches per transfer the fusion
census found), not a defect to fix. `partial-reg` is the other, and it is the
interesting one: **17–43% on six of thirteen programs**, and its content is
always the same shape — `mov_rm8`, `mov_mr8`, `add_rm8` — a byte read out of a
LUT or a byte written to a framebuffer, sitting in the middle of otherwise
32-bit address arithmetic.

## Eyeballed

### BRW `8064d:453a` — the shape the fold exists for

32-bit, 127,677 entries, 3.57M retired ops, 28 ops, 21 foldable, longest run 6:

```
movzx8_rm32  0x226039 0x0        [fold]     ; movzx e_, byte [..]
sh4_r32      0x0 0xc             [fold]     ; shl  e_, 12
movzx8_rm32  0x226339 0x1f400    [fold]     ; movzx e_, byte [..]
sh4_r32      0x3 0x6             [fold]     ; shl  e_, 6
add_rr32_nf  0x30                [fold]
add_rm32     0x325039 0x45aa     [fold]     ; + [table]
mov_rm8      0x5029 0x0          [partial-reg]   <-- 8-bit LUT read
mov_mr8      0x227039 0x0        [partial-reg]   <-- 8-bit store
...the same six, twice more, unrolled...
inc_r32 / inc_r32 / dec_r32      [fold]
jnz          -> 0x453a           [branch]
```

Two 8-bit table indices are widened, scaled, summed and added to a base — six
ops of pure integer dataflow, three times over — and each tree is terminated by
the byte load and byte store that consume it. The fold would take those three
6-op trees to three dispatches from eighteen. **The two `mov*8` in the middle
are what keeps it from being one tree of twenty-one.**

### ACCIDENT `a110:31c` — where the alias rule bites

16-bit, 135,088 entries, 2.43M retired ops, 18 ops, **16 foldable, longest run
12**:

```
mov_acc_moffs16  0x6286 0x3      [fold]   ; mov ax,[6286]
sh4_r16          0x0 0x1         [fold]   ; shl ax,1
imul3_rm16_nf    0x738 ..  0x50  [fold]   ; imul r,[..],0x50
add_rr16         0x7             [fold]
mov_rm16         0x23 0x9c00     [fold]   ; load
dec_r16          0x0             [fold]
mov_rr16         0x2             [fold]
... the same five again ...
mov_mr16         0x223 0x9c00    [fold]   ; STORE  (run reaches 12 here)
mov_acc_moffs16  0x6286 0x3      [fold]   ; load after a store -> ALIAS SPLIT
... four more ...
cmp_mi16_jnz                     [terminator-flags+branch]
```

Sixteen consecutive foldable ops and **not one barrier in the interior** — the
run is 12 rather than 16 only because of the alias rule, a `mov [9c00],r` store
followed by a `mov ax,[6286]` load that this classifier cannot prove disjoint.
Both are absolute displacements off DS; a fold that compared constant addresses
would join the two halves into one 16-op tree.

This block is also where the classifier was hand-verified, and it found a bug
doing it: `mov_acc_moffs16` was landing in `other` because it is spelled unlike
every other `mov`. Fixing that one line took ACCIDENT from 41.7% foldable to
**49.6%**, its `other` class from 8.4% to 0.5%, and this block's longest run
from 4 to 12. The general lesson is that a foldable-share number is only as good
as its `other` column, which is why `--why` prints the per-class name histogram.

### RUNDEMO `aa60:91e` — why `max` is a curiosity

The arena-wide longest run is 162, and it is one straight-line 166-op setup
block — `mov` immediates and absolute stores — executed **once**. That is why
p50 and p90 are weighted by block entries and `max` is not: the run length the
machine actually walks into is 0–2 on most programs and 4 at ACCIDENT's p90.

## How blocks END, and where a fold would multiply

The tables above price a fold at *one dispatch per straight-line run, once*. That
undersells exactly one shape and oversells every other: a run inside a block the
machine **re-enters every turn of a loop** is paid for once per turn. So the
census now classifies every block by its terminator, hit-weighted:

* **`self-loop`** — the terminator's TAKEN edge goes back to this block's own
  head. `loop`, `jcxz`, a `dec`/`jnz` pair and a `cmp`/`jcc` pair all land here;
  what matters is where the edge goes, not which instruction spelled it. Read
  out of `emit.js`'s `TAKEN_AT`, which covers the fused, traced and
  spin-collapsed twins too, so a loop the compiler already collapsed is still
  recognised as one.
* **`interior-branch`** — a conditional whose taken edge goes elsewhere.
* **`plain-exit`** — `jmp`, `ret`, `call`, `int`, or a block that runs off its
  end.

**Collapsible loop mass** is the share of retired ops in self-loop blocks whose
*whole body* folds — everything but the closing branch itself, with a `cmp`
fused into the terminator counted as body. That is the population a fold that
lowers a whole loop to one dispatch per turn would be built for.

| program | self-loop | interior-branch | plain-exit | loop | dec/jnz | cmp/jcc | collapsible exact | collapsible all-relax |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| DHADREN | 1.1% | 69.7% | 29.3% | 0.9% | 0.0% | 0.2% | 0.0% | 0.8% |
| DTM2 | 0.9% | 42.5% | 56.6% | 0.0% | 0.9% | 0.0% | 0.0% | 0.0% |
| ACCIDENT | 7.5% | 75.7% | 16.8% | 5.6% | 1.9% | 0.0% | **1.6%** | 2.8% |
| B-STEEL | 3.8% | 50.5% | 45.7% | 3.8% | 0.0% | 0.0% | 0.0% | 0.0% |
| RUNDEMO | 19.9% | 69.4% | 10.7% | 19.8% | 0.1% | 0.0% | 0.6% | 0.7% |
| CMA_SHRT | 0.5% | 71.6% | 27.9% | 0.5% | 0.0% | 0.0% | 0.0% | 0.5% |
| CONTAGIO | 26.7% | 63.5% | 9.8% | 4.2% | 22.5% | 0.0% | 0.0% | 16.8% |
| CYCLE | 3.4% | 82.3% | 14.3% | 0.6% | 2.7% | 0.0% | 0.0% | 0.3% |
| DEMO5 | 0.3% | 35.8% | 63.9% | 0.0% | 0.0% | 0.3% | 0.0% | 0.0% |
| BRW | **55.0%** | 43.1% | 1.8% | 5.9% | **48.3%** | 0.9% | 1.1% | **33.8%** |
| ENDPART | 28.6% | 67.1% | 4.3% | 26.7% | 1.9% | 0.0% | 0.0% | 0.0% |
| MAINPART | **64.9%** | 29.8% | 5.3% | **64.7%** | 0.1% | 0.0% | 0.0% | 0.1% |
| CHROME | 34.0% | 49.0% | 16.9% | 0.0% | 0.0% | 34.0% | 0.0% | 33.0% |

**Three quarters of the corpus's ops are not in a loop block at all.** The modal
shape is `interior-branch` — 30–82% of retired ops, and above 60% on eight of
thirteen. Self-loops carry under 4% on seven programs. So for most of this
corpus the fold's saving really is "once per entry", and the loop-multiplier
argument does not apply.

**Where it does apply, it is one program.** BRW is 55.0% self-loop, and 48.3 of
those 55 points close with `dec`/`jnz` rather than `loop` — an unrolled
fixed-point inner loop with a hand-written counter, exactly the shape §1 of the
verdict already named. MAINPART is 64.9% self-loop and is the counter-example
that matters: **its loops are `loop` around bodies that do not fold**
(`48f60:bb`, 282,220 entries, two ops, zero foldable), so its collapsible mass
is 0.1% against BRW's 33.8%. A high self-loop share is not the same finding as a
high collapsible share and the two must be read together.

**Two rows of collapsible mass are already collapsed.** CHROME's 33.0% and most
of CONTAGIO's 16.8% are `cmp`/`jcc` and `dec`/`jnz` blocks of one or two ops
whose "whole body folds" only because the `flags` relaxation lets the terminator
compare fold. Those are polling loops, and `emit.js`'s SPIN/PSPIN rewrites
already turn them into one handler that does not turn at all — see
[toyvm-spin-loops.md](toyvm-spin-loops.md). Subtract them and the collapsible
population on this corpus is **BRW and nothing else**.

## Relaxing the barriers

Three of the declines above are modelling choices, not facts about x86, and each
is a real piece of compiler work. `--relax=alias,partial,flags` (any subset)
re-classifies the same op stream and rebuilds the runs, so the four arms come
out of ONE run with identical weights and cannot drift the way four separate
runs would.

* **`alias`** — a store followed by a load is not a barrier when the two are
  provably disjoint. The rule, stated in full because it is the whole content:
  two accesses through **different segment registers are assumed to alias**
  (in real mode DS and ES are routinely aimed at overlapping windows and neither
  value is a compile-time constant to the decoder); two accesses through the
  same segment register *and the same base/index registers* differ by exactly
  their displacements whatever those registers hold, so a size-aware comparison
  of the two constants decides it — which covers both cases in the brief, two
  different constant offsets and one base register at two non-overlapping
  displacements. Everything else assumed to alias.
* **`partial`** — AL/AH/AX-style narrow writes and 8-bit loads/stores modelled
  as an insert into and an extract out of the full-width local.
* **`flags`** — flags as values with a per-field last writer inside the block:
  `cmp`/`test` anywhere, `setcc`, `adc`/`sbb` fold. `pushf`/`popf`/`lahf`/`sahf`
  want the architectural word including fields nothing in the block wrote,
  `rcl`/`rcr` and shifts by CL read a carry this analysis does not carry as a
  value, and the BCD group reads AF — all four stay barriers.

`ops undispatched` is the hit-weighted share of retired guest ops that stop
being dispatched: for each maximal run, every op past its head, weighted by that
op's own hit count. It is the number the fold is actually worth on paper.

| program | mode | foldable | ≥4-fold | run p50 | run p90 | ops undispatched | top remaining barrier |
|---|---|---:|---:|---:|---:|---:|---|
| DHADREN | exact | 34.6% | 35.6% | 1 | 3 | 18.4% | branch 19.8% |
| | alias | 34.6% | 35.6% | 1 | 3 | 18.5% | branch 19.8% |
| | partial | 51.7% | 48.9% | 1 | 4 | 31.0% | branch 19.8% |
| | flags | 44.9% | 36.0% | 2 | 3 | 22.3% | branch 19.8% |
| | **all** | **62.1%** | 50.2% | 2 | 5 | 36.1% | branch 19.8% |
| DTM2 | exact | 24.5% | 13.0% | 1 | 2 | 6.9% | partial-reg 18.0% |
| | alias | 24.5% | 13.0% | 1 | 2 | 6.9% | partial-reg 18.0% |
| | partial | 42.4% | 56.9% | 1 | 3 | 11.2% | branch 15.7% |
| | flags | 36.0% | 14.1% | 1 | 2 | 13.7% | partial-reg 18.0% |
| | **all** | **53.8%** | 57.3% | 1 | 3 | 19.3% | branch 15.7% |
| ACCIDENT | exact | 49.6% | 42.4% | 1 | 4 | 29.9% | branch 23.1% |
| | alias | 49.6% | 42.4% | 1 | 4 | 30.2% | branch 23.1% |
| | partial | 55.0% | 46.5% | 1 | 4 | 36.0% | branch 23.1% |
| | flags | 65.9% | 44.4% | 1 | 4 | 37.8% | branch 23.1% |
| | **all** | **71.3%** | 50.3% | 1 | 5 | 44.5% | branch 23.1% |
| B-STEEL | exact | 39.1% | 20.2% | 1 | 3 | 14.0% | branch 15.4% |
| | alias | 39.1% | 20.2% | 1 | 3 | 14.4% | branch 15.4% |
| | partial | 45.9% | 43.7% | 1 | 3 | 17.1% | branch 15.4% |
| | flags | 43.6% | 22.0% | 1 | 3 | 14.8% | branch 15.4% |
| | **all** | **50.4%** | 45.5% | 1 | 3 | 18.5% | branch 15.4% |
| RUNDEMO | exact | 35.0% | 28.4% | 0 | 2 | 20.8% | branch 25.0% |
| | alias | 35.0% | 28.4% | 0 | 2 | 20.8% | branch 25.0% |
| | partial | 50.5% | 52.8% | 1 | 3 | 28.2% | branch 25.0% |
| | flags | 43.7% | 28.5% | 1 | 2 | 22.7% | branch 25.0% |
| | **all** | **59.2%** | 52.8% | 1 | 4 | 32.4% | branch 25.0% |
| CMA_SHRT | exact | 22.6% | 13.5% | 1 | 1 | 7.4% | partial-reg 43.2% |
| | alias | 22.6% | 13.5% | 1 | 1 | 7.4% | partial-reg 43.2% |
| | partial | 65.9% | 62.9% | 2 | 6 | 48.7% | branch 18.8% |
| | flags | 31.1% | 13.5% | 1 | 2 | 12.5% | partial-reg 43.2% |
| | **all** | **74.3%** | 62.9% | 2 | 6 | 53.9% | branch 18.8% |
| CONTAGIO | exact | 22.5% | 7.9% | 1 | 1 | 2.8% | branch 27.9% |
| | alias | 22.5% | 7.9% | 1 | 1 | 2.8% | branch 27.9% |
| | partial | 50.0% | 37.9% | 1 | 5 | 28.7% | branch 27.9% |
| | flags | 36.5% | 13.8% | 1 | 2 | 8.7% | branch 27.9% |
| | **all** | **64.1%** | 43.5% | 2 | 5 | 36.8% | branch 27.9% |
| CYCLE | exact | 9.6% | 14.0% | 0 | 0 | 3.5% | branch 48.2% |
| | alias | 9.6% | 14.0% | 0 | 0 | 3.5% | branch 48.2% |
| | partial | 15.8% | 17.3% | 0 | 1 | 6.0% | branch 48.2% |
| | flags | 35.6% | 17.1% | 1 | 1 | 8.5% | branch 48.2% |
| | **all** | **41.8%** | 18.7% | 1 | 1 | 12.0% | branch 48.2% |
| DEMO5 | exact | 24.5% | 16.3% | 0 | 2 | 9.1% | stack 25.4% |
| | alias | 24.5% | 16.3% | 0 | 2 | 9.1% | stack 25.4% |
| | partial | 27.3% | 19.1% | 0 | 2 | 11.1% | stack 25.4% |
| | flags | 33.0% | 18.3% | 1 | 2 | 12.2% | stack 25.4% |
| | **all** | **35.9%** | 21.3% | 1 | 2 | 14.2% | stack 25.4% |
| BRW | exact | 35.2% | 53.7% | 2 | 3 | 20.3% | partial-reg 34.9% |
| | alias | 35.2% | 53.7% | 2 | 3 | 20.3% | partial-reg 34.9% |
| | partial | 70.1% | 82.9% | 3 | 6 | 45.3% | branch 12.7% |
| | flags | 37.1% | 53.8% | 2 | 3 | 20.3% | partial-reg 34.9% |
| | **all** | **72.0%** | **83.1%** | 3 | 6 | 47.0% | branch 12.7% |
| ENDPART | exact | 30.0% | 13.3% | 0 | 2 | 14.0% | partial-reg 25.3% |
| | alias | 30.0% | 13.3% | 0 | 2 | 14.0% | partial-reg 25.3% |
| | partial | 55.3% | 24.4% | 2 | 3 | 27.7% | branch 25.0% |
| | flags | 33.5% | 17.9% | 1 | 2 | 14.2% | partial-reg 25.3% |
| | **all** | **58.8%** | 28.9% | 2 | 3 | 28.0% | branch 25.0% |
| MAINPART | exact | 25.5% | 0.9% | 0 | 2 | 6.6% | branch 26.1% |
| | alias | 25.5% | 0.9% | 0 | 2 | 6.6% | branch 26.1% |
| | partial | 47.9% | 48.0% | 1 | 3 | 16.3% | branch 26.1% |
| | flags | 25.6% | 0.9% | 0 | 2 | 6.6% | branch 26.1% |
| | **all** | **48.0%** | 48.1% | 1 | 3 | 16.4% | branch 26.1% |
| CHROME | exact | 30.3% | 5.3% | 1 | 2 | 11.4% | branch 29.4% |
| | alias | 30.3% | 5.3% | 1 | 2 | 11.4% | branch 29.4% |
| | partial | 41.8% | 8.6% | 2 | 2 | 19.7% | branch 29.4% |
| | flags | 43.6% | 5.3% | 2 | 2 | 20.8% | branch 29.4% |
| | **all** | **55.1%** | 8.6% | 2 | 3 | 30.3% | branch 29.4% |

### How run length moves, exact → all three

| program | run p50 | run p90 | foldable | ops undispatched | high-byte share of the ops `partial` promotes |
|---|---|---|---|---|---:|
| DHADREN | 1 → 2 | 3 → 5 | 34.6% → 62.1% | 18.4% → 36.1% | 11.2% |
| DTM2 | 1 → 1 | 2 → 3 | 24.5% → 53.8% | 6.9% → 19.3% | 6.6% |
| ACCIDENT | 1 → 1 | 4 → 5 | 49.6% → 71.3% | 29.9% → 44.5% | 17.4% |
| B-STEEL | 1 → 1 | 3 → 3 | 39.1% → 50.4% | 14.0% → 18.5% | 0.1% |
| RUNDEMO | 0 → 1 | 2 → 4 | 35.0% → 59.2% | 20.8% → 32.4% | 21.7% |
| CMA_SHRT | 1 → 2 | 1 → 6 | 22.6% → 74.3% | 7.4% → 53.9% | 18.0% |
| CONTAGIO | 1 → 2 | 1 → 5 | 22.5% → 64.1% | 2.8% → 36.8% | 14.4% |
| CYCLE | 0 → 1 | 0 → 1 | 9.6% → 41.8% | 3.5% → 12.0% | 50.2% |
| DEMO5 | 0 → 1 | 2 → 2 | 24.5% → 35.9% | 9.1% → 14.2% | 63.2% |
| BRW | 2 → 3 | 3 → 6 | 35.2% → 72.0% | 20.3% → 47.0% | 1.0% |
| ENDPART | 0 → 2 | 2 → 3 | 30.0% → 58.8% | 14.0% → 28.0% | 0.4% |
| MAINPART | 0 → 2 | 2 → 3 | 25.5% → 48.0% | 6.6% → 16.4% | 2.1% |
| CHROME | 1 → 2 | 2 → 3 | 30.3% → 55.1% | 11.4% → 30.3% | 4.4% |

**The p50 moves by at most two and the p90 by at most five.** Every one of the
long-run programs stays in single digits: BRW's p90 goes 3 → 6, ACCIDENT's
4 → 5, CMA_SHRT's 1 → 6, and ACCIDENT's p50 does not move at all. So all three
relaxations together do not turn this corpus into one with long expression
trees; they roughly double the *number* of foldable ops and add two to four to
the run the machine walks into.

**High-byte writes are not the partial idiom on the programs where partial
matters most.** The AH/BH/CH/DH share of the ops `partial` promotes is 1.0% on
BRW and 0.1% on B-STEEL — the two programs it buys the most on — and 63.2% on
DEMO5 and 50.2% on CYCLE, where it buys the least. The 1994 VGA idiom is an
8-bit LUT read into **AL** and an 8-bit store, threaded through 32-bit address
arithmetic; the high-byte write is a different, smaller and colder population.

## Eyeballed, part two

### BRW `8064d:453a` under `--relax=partial` — 21 foldable to 27, run 6 to 11

Read out of guest memory at exit rather than off disk, since the code is
depacked (`run-dos.js --disasm=8:453a:30`, cs selector 8, descriptor base
`0x1f80`):

```
8:453a  0f b6 06              movzx eax, byte [esi]              fold
8:453d  c1 e0 0c              shl   eax, 0xc                     fold
8:4540  0f b6 9e 00 f4 01 00  movzx ebx, byte [esi+0x1f400]      fold
8:4547  c1 e3 06              shl   ebx, 6                       fold
8:454a  03 c3                 add   eax, ebx                     fold
8:454c  03 05 aa 45 00 00     add   eax, [0x45aa]                fold     <- exact run ends: 6
8:4552  8a 44 05 00           mov   al, [ebp+eax]                partial-reg -> fold*
8:4556  88 07                 mov   [edi], al                    partial-reg -> fold*
   ...the same eight, at +0xa640 and +0x14c80, twice more...
8:45a4  47                    inc   edi                          fold
8:45a5  46                    inc   esi                          fold
8:45a6  49                    dec   ecx                          fold
8:45a7  75 91                 jnz   453a                         branch (self-loop, dec/jnz)
```

Exact: 21 of 28 ops fold and the longest run is **6** — the two `mov*8` in the
middle cut each unrolled copy in half, three times. Under `--relax=partial` all
27 body ops fold and the longest run is **11** (the third copy's eight, plus
`inc`/`inc`/`dec`). The other two copies stop at **8**, because the byte store
that ends one copy is followed by the `movzx` load that opens the next, and the
alias rule splits there.

**And `--relax=alias` does not recover those two splits.** `mov [edi], al` and
`movzx eax, byte [esi+0xa640]` go through different base registers, so nothing
short of a real alias analysis relates them; BRW's `all` row is 72.0% against
`partial`'s 70.1%, and the 1.9 points are the `flags` relaxation, not this one.
The block's terminator is a `dec ecx`/`jnz` back to its own head, so under
`partial` this is a **fully collapsible loop**: one dispatch per turn instead of
28, and it is 3.57M of BRW's 18.16M retired ops on its own.

### ACCIDENT `a110:31c` under `--relax=alias` — the split is real, and the old explanation was wrong

`run-dos.js --disasm=a11:318:22`. (The census's `cs` column is the segment's
LINEAR BASE, not the selector: `a110` here is real-mode segment `a11`, and
BRW's `8064d` is selector 8's descriptor base. That is worth knowing before
pasting a census address into a disassembler.)

```
a11:031c  a1 86 62           mov  ax, [0x6286]              fold
a11:031f  d1 e0              shl  ax, 1                     fold
a11:0321  6b 3e 84 62 50     imul di, [0x6284], 0x50        fold
a11:0326  03 f8              add  di, ax                    fold
a11:0328  8b 83 00 9c        mov  ax, [bp+di+0x9c00]        fold   (LOAD, ss)
a11:032c  48                 dec  ax                        fold
a11:032d  8b d0              mov  dx, ax                    fold
a11:032f  a1 86 62           mov  ax, [0x6286]              fold
a11:0332  d1 e0              shl  ax, 1                     fold
a11:0334  6b 3e 84 62 50     imul di, [0x6284], 0x50        fold
a11:0339  03 f8              add  di, ax                    fold
a11:033b  89 93 00 9c        mov  [bp+di+0x9c00], dx        fold   (STORE)  <- run reaches 12
a11:033f  a1 86 62           mov  ax, [0x6286]              fold   LOAD after STORE -> split
a11:0342  d1 e0              shl  ax, 1                     fold
a11:0344  6b 3e 84 62 50     imul di, [0x6284], 0x50        fold
a11:0349  03 f8              add  di, ax                    fold
a11:034b  83 bb 00 9c 00     cmp  word [bp+di+0x9c00], 0    terminator-flags
a11:0350  75 40              jnz                            branch
```

Sixteen consecutive foldable ops, no barrier in the interior, longest run 12 —
and **`--relax=alias` leaves it at 12**. The store is `mov [bp+di+0x9c00], dx`:
SS-relative, through a base *register pair* whose value is not known at decode
time. The load after it is `mov ax, ds:[0x6286]`. Different segment registers
and different base forms, so the disjointness rule declines and is right to:
in real mode SS and DS can be aimed at the same paragraph and the decoder cannot
know.

**This corrects the previous version of this page**, which said "both are
absolute displacements off DS" and concluded that comparing constant addresses
would join the two halves into one 16-op tree. It would not. The store is
indexed, not absolute, and the run it ends cannot be extended by any rule that
only compares constants. The claim came from reading the arena's op names
without decoding the packed EA word, which is exactly the error the `--why`
histogram exists to catch one level up.

What `alias` *does* buy on ACCIDENT is 0.3 points of undispatched ops
(29.9% → 30.2%) somewhere else in the run — the largest gain it produces on any
program in the corpus.

## Verdict

**The population is real but shallow, and the ceiling is a lot lower than the
foldable share suggests.**

Foldable ops are **22–50% of retired ops** on the eleven well-attributed
programs (CYCLE's 9.6% is the outlier and it is a menu poller). That looks like
a large lever. It is not, because the fold's saving is not "one dispatch per
foldable op" — it is *one dispatch per foldable RUN*, and the entry-weighted run
length is **p50 0–2, p90 1–4**. A run of two saves one dispatch out of two; at
the corpus's ~3.25 dispatches per block transfer there is simply not much
straight line in front of this lever.

Three findings decide it:

1. **`>=4 foldable ops in the block` is where the mass actually is, and it
   varies 50x across the corpus** — 53.7% on BRW, 42.4% on ACCIDENT, 35.6% on
   DHADREN, against 0.9% on MAINPART and 5.3% on CHROME. The programs that win
   are the ones with unrolled fixed-point inner loops; the ones that lose are
   the ones whose hot code is a two-op block and a branch. **A fold would be a
   per-program result, not a corpus result**, which is the same verdict
   [`find-rle-nests.js`](../CLAUDE.md) reached about Caesar's RLE ladder.

2. **`partial-reg` is the single biggest addressable barrier, at 17–43% on six
   programs**, and every instance is the same idiom: 8-bit LUT reads and 8-bit
   framebuffer stores threaded through full-width address arithmetic. That is
   not an accident of this corpus — it is what a 1994 VGA demo *is*. Extending
   the fold to model AL/AH as subfields of a 32-bit local, rather than declining
   on them, is worth more than any other single extension here: on BRW it would
   join two 6-op trees plus the load and store into one 14-op tree, and on
   CMA_SHRT it addresses 43.2% of the run.

3. **The alias rule costs real length, and the cheap version of it recovers
   none of that.** ACCIDENT's hottest fold block has 16 consecutive foldable ops
   and reports a longest run of 12 purely because a store precedes a load — but
   the store is `mov [bp+di+0x9c00], dx` and the load is `mov ax, ds:[0x6286]`,
   so a rule that compares constant displacements inside one segment declines,
   correctly. Measured across the corpus, `--relax=alias` moves the foldable
   share by **+0.0 points on all thirteen programs** and the undispatched share
   by at most 0.3 (ACCIDENT). It is a null. See "Relaxing the barriers" above.

### Which relaxation buys the most

**`partial`, and it is not close.** It is the only one of the three that is
worth double digits on the programs that matter: +43.2 points of foldable share
on CMA_SHRT, +34.9 on BRW, +27.6 on CONTAGIO, +25.3 on ENDPART, +22.4 on
MAINPART, median +17.1 across the thirteen. It is also the only one that moves
the **≥4-fold mass**, which is where §1 says the lever actually is — BRW 53.7%
→ 82.9%, CMA_SHRT 13.5% → 62.9%, MAINPART 0.9% → 48.0%, DTM2 13.0% → 56.9% —
and the only one that lifts a p90 run past 4 (CMA_SHRT 1 → 6, BRW 3 → 6).

**`flags` is second and it is the complement, not a smaller copy.** Median
+8.7 points, and it is largest exactly where `partial` is smallest: CYCLE +26.0
(against partial's +6.2), CHROME +13.3, ACCIDENT +16.3. Those are the
branch-dense programs whose blocks are a compare and a jump, so modelling flags
as values is what joins their two-op blocks into something. It barely touches the
≥4-fold mass anywhere (ACCIDENT 42.4% → 44.4% is its best), so it buys foldable
*ops*, not longer *trees*.

**`alias` is a null: +0.0 points on every program in the corpus.** It changes
`runMax` on three (CYCLE 7 → 42, BRW 13 → 19, CONTAGIO 10 → 11) and the
undispatched share on three, by at most 0.3 points. The reason is visible in
both eyeballed blocks: the store/load pairs that split real runs go through
*different base registers* or *different segment registers*, which is the case
the rule is required to decline. Constant-address disambiguation is not the
missing piece it was previously reported to be, and it should be the last of the
three to be built, if ever.

The honest summary: **the mechanism is sound and the corpus has a real
population for it, but the median run is too short for a corpus-wide win, and
partial-register modelling is worth more than the base fold.** Build the base
fold only alongside 8-bit subfield modelling; add flags-as-values for the
branch-dense programs; leave alias analysis alone. Expect it to pay on the
fixed-point unrolled programs (BRW above all, then ACCIDENT, DHADREN, CMA_SHRT)
and round to nothing on the branch-dense ones (CYCLE, DTM2, DEMO5).

And expect it to pay **per turn rather than per entry on exactly one program**:
BRW is 55.0% self-loop blocks, 33.8% of its retired ops sit in self-loop blocks
whose entire body folds under all three relaxations, and no other program in the
corpus reaches 3% once the already-collapsed polling loops are subtracted.

None of that is a speed claim. `--block-hits` is an instrumented build and this
box sits at load 10–40; what a fold is worth in nanoseconds is a measurement
nobody has taken, and `docs/toyvm-trace-blocks.md` is the standing reminder of
how far a mechanism argument can be from a run getting faster.

## What the classifier could not handle

* **Arena recycling merges counters.** The counter table is keyed by arena
  address, so a program that recycles the arena accumulates several blocks'
  counts at one address. The tool reports this as `attributed`; CONTAGIO (21.4%)
  and CMA_SHRT (47.9%) are the two rows it materially affects. Fixing it means
  snapshotting the table at every recycle.
* **REP is one op here.** `rep_movsw` over 60KB is one retired guest op in this
  census and 30,000 billed dispatches. That is the right unit for "is this an
  expression" and the wrong one for "how much work is it".
* **`other` still holds two genuinely foldable idioms**: `xchg_rr16` (a pure
  two-register permutation, 0.1–0.3%) and `cbw`/`cwd`/`cdq` (sign extension,
  0.2%). Neither is in the brief's list and neither is big enough to matter, but
  both would fold.
* **Rotates (`rol`/`ror`) are filed under `other`**, not under `flags`. They are
  foldable as dataflow; they are excluded because the brief's list excludes
  them.
* **Addresses are compared only under `--relax=alias`.** The default rule is
  "store then load, in the same run, splits it" and nothing more. With the
  relaxation on, the packed EA word (decode.js's `packEa`: kind 0-3, segment
  4-6, ModRM reg 8-10, A32 base/index/scale above that) is decoded and two
  accesses are disjoint only when they share a segment register AND a base/index
  form and their size-aware displacement ranges do not overlap. Different
  segment registers are assumed to alias — see verdict point 3.
* **`runMax` is now taken over blocks the run actually ENTERED.** Blocks with
  zero entries have no run the machine walks into and are excluded from the
  percentile population, so a `max` here can be one or two below what the
  previous version of this page printed (CMA_SHRT 8 not 9, CONTAGIO 10 not 12).
  Every other exact-mode number on this page reproduces the earlier run
  digit-for-digit.
* **A "collapsible" polling loop is not a new win.** A two-op `cmp`/`jcc`
  self-loop counts as fully-body-foldable under `--relax=flags`, and SPIN/PSPIN
  already collapse those. CHROME's 33.0% and most of CONTAGIO's 16.8% are that.
* **32-bitness is per block, inferred from the ops present.** A 32-bit block
  that happens to contain no `_32` op is read as 16-bit, which makes its 16-bit
  ops foldable when they should be `partial-reg`. This can only over-count, and
  only on a block with no 32-bit op in it at all.
* **The eyeball listings are the arena's op stream, not a disassembly.** A
  32-bit protected-mode block's `cs` is a selector, so there is no `cs<<4`
  arithmetic to feed `dos-disasm.js`, and guest memory has moved on by exit
  anyway. The arena is the more useful listing regardless: it is what the
  interpreter ran.

## Reproducing

```bash
node tools/toyvm/expr-fold-census.js \
  $(grep -v '^#' tools/toyvm/bench-set-core10.txt) \
  --dispatches=20m --pit-clock --auto-key --sound-pref=sb \
  --env=ULTRASND=220,1,1,11,7 --top=20 --show=5 --why --json=/tmp/fold.json
```

The five-mode relaxation sweep and the terminator census are printed
unconditionally — they cost nothing, being a second and third pass over an op
stream that is already in memory. `--relax=alias,partial,flags` (any subset)
additionally selects which mode drives the per-block listing and the eyeball
dump, so an op the mode promotes shows as `fold*(partial-reg)` against the
class it has in the exact census:

```bash
node tools/toyvm/expr-fold-census.js /tmp/demos/1995-c-cma_brw/BRW.EXE \
  --dispatches=20m --pit-clock --auto-key --sound-pref=sb \
  --env=ULTRASND=220,1,1,11,7 --top=6 --show=2 --relax=partial
```

`--why` prints the per-class name histogram, which is the classifier's work
list. `--block-hits` on `run-dos.js` is the raw facility if something else wants
per-block counts.

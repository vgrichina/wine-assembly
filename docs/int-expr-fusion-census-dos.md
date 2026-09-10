# How much of a DOS demo is an expression?

`tools/toyvm/expr-fold-census.js`, core ten + three, 20M dispatches each.

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

3. **The alias rule costs real length.** ACCIDENT's hottest fold block has 16
   consecutive foldable ops and reports a longest run of 12 purely because a
   store precedes a load. Both addresses are compile-time constants. A fold that
   compared constant displacements — not a general alias analysis, just
   "different constant, same segment" — would recover the rest.

The honest summary: **the mechanism is sound and the corpus has a real
population for it, but the median run is too short for a corpus-wide win, and
the two extensions above (8-bit subfields, constant-address disambiguation) are
worth more than the base fold.** Build the base fold only alongside them, and
expect it to pay on the fixed-point unrolled programs (ACCIDENT, BRW, DHADREN,
B-STEEL) and round to nothing on the branch-dense ones (CYCLE, DTM2, MAINPART).

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
* **No addresses are compared, ever.** The alias rule is "store then load, in
  the same run, splits it" and nothing more — see verdict point 3.
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

`--why` prints the per-class name histogram, which is the classifier's work
list. `--block-hits` on `run-dos.js` is the raw facility if something else wants
per-block counts.

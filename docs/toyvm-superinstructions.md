# Superinstructions in the toy VM's threaded code

## The shape of the problem

Threaded code pays for every operation twice: once to do the work, and once to
get to it. `$next` is five steps — charge a step, test the halt flag, load the
handler index, advance the thread pointer, indirect-call — and
`tools/wasm-native.js` puts the compiled form at 193 instructions with a frame
setup, a stack-limit check and an interrupt check at the top of each one. The
handler body underneath is frequently smaller than that.

The classic answer is a superinstruction: take two ops that occur adjacently,
generate one handler that is both bodies, and pay the dispatch once. The
question is only *which* two, and that is a measurement rather than a guess.

## Which pair, and how much of the corpus it is

Handler-pair census over the ten programs in `bench-set-core10.txt`, 8M
dispatches each, counts exact (they do not depend on box load):

```
node tools/toyvm/run-dos.js <exe> --dispatches=8m --handler-hist=999 --handler-pairs=999
```

**An ALU op immediately followed by a Jcc is 10,323,039 of 80,000,000
dispatches — 12.9%.** It is also concentrated: 204 distinct pairs exist, but

| pairs | share of the fusable work |
|---|---|
| top 10 | 63.9% |
| top 20 | 77.7% |
| top 40 | 90.2% |
| top 80 | 99.1% |

and two pairs alone (`cmp_ri8 -> jz`, `cmp_rm8 -> jz`) are 6.0% of *everything*
the corpus runs.

The other number that came out of the same census is the one that ruled the
alternatives out. Summing the block-terminating handlers against all handler
entries gives **3.25 dispatches per block transfer** on DTM2. That kills any
design that adds an op per block: a block-head "charge the whole block's steps
at once" op, which would have removed the per-op step decrement, costs one
dispatch per 3.25 to save 3.25 decrements, and a dispatch is not remotely as
cheap as a decrement. It is also why fusing *inside* the block is worth doing at
all — at 3.25 ops per block, nearly every op is next to a branch.

## The fusion is body concatenation, and that is why it is safe

Every handler reads its operands with `ops(n)`, which loads them at offsets off
`$ip` and then advances `$ip` past them. So two bodies in sequence read two
operand lists in sequence, correctly, with no re-layout, no operand renumbering
and no new code:

```js
h(`${alu}_j${cc}`, a.args + j.args, `${a.body} ...charge... ${j.body}`);
```

The arena loses exactly one word — the Jcc's opcode — and the compiler's whole
edit is to overwrite the first op's index and splice that word out.

`genFusedBranches` in `emit.js` builds these for the census's top twelve first
ops crossed with all sixteen conditions: 192 handlers, taking the table from 728
to 920. Twelve is where the census's tail stops paying; they are 88.5% of all
fusable pairs.

**What is not fused, and how that is enforced.** A fused first half must run to
its end every time: anything that can hand back, fault or return early would
leave `$ip` parked between the two operand lists, and the resume would read the
branch's operands as an instruction. `popf` is the case that matters — it is
19th on the census but ends the block when it raises TF. The generator asserts
on it rather than trusting this paragraph: a first op whose body mentions
`$halt`, `(return)`, `$fault` or `$jlook` is a build error.

## Step parity, and why it makes the corpus diff a real check

A fused pair is one dispatch where there were two, so it would naturally charge
one step where two were charged. That would be a *retiming*: `$steps` decides
where a slice ends, a slice boundary is where interrupts are injected, and the
guest would take its interrupts at different instructions. Every frame in the
corpus would legitimately change, and the run would be un-verifiable — exactly
the situation that hid the COMPOVRS divergence in
[toyvm-decoder-in-wasm.md](toyvm-decoder-in-wasm.md) for a whole afternoon.

So the fused handler charges the step its removed dispatch used to, inline:

```wat
(global.set $steps (i32.sub (global.get $steps) (i32.const 1)))
```

One `sub` against a saved dispatch, and in exchange **a fused run and an
unfused run must be bit-identical**. That is not a nice-to-have; it converts the
entire 146-program corpus into a regression test for the transformation, at the
level of the frame hash rather than "it still runs".

`--no-fuse` is the A/B partner.

## Measured

Fusion is on by default. All figures below are from the same build.

**Dispatch reduction (exact, load-independent).** DTM2, 8M billed dispatches:
handler entries fall from **7,994,552 to 6,032,180 — 24.5% fewer trips through
`$next`** — over 25 distinct fused handlers, led by `cmp_rm8_jz` at 16.4% of
what remains and `sbb_ri16_jb` at 11.8%. DTM2 is branch-dense and well above the
12.9% corpus average; it is the upper end, not the typical case.

**Equivalence.** `--no-fuse` against the default over the whole demo corpus, 8M
dispatches each, comparing handbacks, interrupts, traces, the frame hash and the
stopping `cs:ip`. Over **177 programs: 102 bit-identical, 71 differing only in
the arena footprint** — which shrinks by a word per fused block, DTM2 30KB →
29KB — and **4 differing additionally in compile and recycle counts**
(CONTAGIO, AQUAPHOB, COUNTDWN, ZOKDTPLN). All four are programs that recycle the
arena, and a smaller footprint moves the recycle boundary, so a slightly
different set of blocks gets recompiled. Their frame hashes, pixel counts,
interrupt counts and stopping `cs:ip` are identical, which is the part step
parity was for. **No program's output changed.**

**Throughput.** `tools/bench-dos.js` now A/Bs a compiler switch the way it A/Bs
a dispatch shell (`--variants=tailcall,tailcall+nofuse`) — arms interleaved rep
by rep with the starting arm rotated, minimum of five, and the frame hash and
dispatch count checked to agree across arms before a ratio is printed. Core ten,
20M dispatches, box at load 8 either side, per-arm spread 1–12%:

| program | fused | unfused | fused is |
|---|---|---|---|
| DTM2 | 8.69 ns/disp | 10.81 | **+24.4%** |
| CYCLE | 8.44 | 10.27 | +21.7% |
| B-STEEL | 10.60 | 11.98 | +13.0% |
| RUNDEMO | 12.16 | 13.11 | +7.8% |
| ACCIDENT | 12.61 | 13.43 | +6.5% |
| DHADREN | 13.50 | 14.31 | +6.0% |
| CMA_SHRT | 15.19 | 15.79 | +4.0% |
| DEMO5 | 10.08 | 10.25 | +1.7% |
| BRW | 13.63 | 13.77 | +1.0% |
| CONTAGIO | 27.74 | 27.79 | +0.2% |

**Geomean +8.3%, and fused won on 10 of 10.** Since the two arms retire the same
number of billed dispatches by construction, ns/dispatch is directly comparable
and this ratio is the whole effect.

CONTAGIO's 0.2% is the result that confirms the model rather than the one that
disappoints it: it is the compile-bound program of the set (913,084 handbacks
over 20M dispatches, 27.7 ns/dispatch against DTM2's 8.7), so almost none of its
wall clock is dispatch and there is nothing here for a dispatch optimisation to
take. It is the program the *decoder* work was for.

## What this does not do

It removes a dispatch. It does **not** remove the flag write: the fused body
still computes and stores `$flags` in its first half and reads a bit back out of
it in its second, because a later `adc`, `sbb`, `pushf` or second Jcc may read
those flags and nothing here proves they are dead. Eliding that is the lazy-flag
change, and a fused pair is the natural place to do it — the producer and the
consumer are now inside one handler, where a liveness question that is hard
across a dispatch becomes local. That is the next thing worth pricing.

It also does not touch the block transfer, which at 3.25 ops per block is a
large share of the remaining cost. The trace-JIT answer there is to compile
*through* a conditional branch, emitting the taken edge as a side exit and
letting the not-taken path fall through inline, so the common direction pays no
transfer at all.

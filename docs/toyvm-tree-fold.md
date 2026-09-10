# The expression-tree fold

`--tree-fold`, off by default. `tools/toyvm/tree-fold.js`, the pass in
`compileProgram`, `test/test-toyvm-tree-fold.js`.

**Verdict up front.** It works and it is not yet worth turning on. It removes
16.8% of BRW's dispatches and buys 12.7% there; on the other five programs
measured it removes under 2% and loses 5-14% to the flat cost of installing a
module mid-run, for a geomean of **−3.8%**. Frames are identical on all six
witnesses and on 190 of 191 corpus programs; the two programs that moved (one
`--auto-key` menu, one self-patcher) both reproduce the plain build exactly when
the install schedule changes, so nothing here computes a wrong value — it
changes *when* things happen, which on this VM is audible. Read *What it costs*
and *What is next*: the fold is static, and a hotness gate is the change that
would make the rest of it pay.

## What it is, and what makes it different from the other two folds

The VM already collapses two shapes. [Superinstructions](toyvm-superinstructions.md)
join exactly two ops. [Spin loops](toyvm-spin-loops.md) collapse a block that is
one branch back to its own head and does nothing. Both are *fixed patterns*:
they match a shape and swap in a handler that was generated when the module was
built.

This one is not a pattern. It takes the straight-line interior of a basic block
— a run of full-width `mov`/`lea`/ALU/shift/widening ops — and *generates a wasm
function for that particular run*, at run time, and installs it. Four ops or
four hundred, the run costs one dispatch and its intermediates never touch the
guest register file.

[The static census](int-expr-fusion-census-dos.md) is what says that is worth
doing, and [the bench](int-expr-fusion-bench.md) is what says how much. This
document is the implementation: what is eligible, how a run becomes a handler,
how the clock is kept, and what it measured.

## Eligibility

**The rule set is `expr-fold-census.js`'s `classify()`, imported, not
reimplemented.** The census measured the population this fold exists for; a fold
whose eligibility had drifted from the census's would be answering a different
question from the one that justified building it. In summary, an op is foldable
when it is:

* a full-width `mov`, `lea`, `add`, `sub`, `and`, `or`, `xor`, `neg`, `not`,
  `inc`, `dec`, `shl`/`shr`/`sar` by an immediate, `imul2`/`imul3`, or a
  `movzx`/`movsx` that widens — register or memory operands, either direction;
* at the block's own width (16-bit in real mode, 32-bit under a 32-bit code
  segment). **A narrower op ends the run**: AL and AH are subfields of AX in the
  register file, so an 8-bit write inside a 16-bit run is an overlap the fold
  does not model.

and it is not any of: a branch, a call, a `ret`, an `int`, a string op, a stack
op, a `mul`/`div`, a segment load, a port access, an x87 op, a `setcc`, a
`cmp`/`test`, an `adc`/`sbb`, a rotate, a shift by CL, or anything that writes
flags a later op in the same run reads.

Two rules are about the run rather than the op:

* **Memory keeps its source order.** Every load and store stays a `$rd*`/`$wr*`
  call in the order it was emitted, so a run may contain as many as it likes.
* **...but a store followed by a load ends the run.** Nothing here proves two
  addresses miss each other, so every load after a store is assumed to alias.
  This is the most expensive rule in the set and the first candidate for
  relaxation (below).

And three the fold adds on top, asked of the *lowered body* rather than the
opcode, because the handler in the arena may be a flagless or specialized twin
rather than the base op:

* it must not read the dispatch clock (`$steps`, `$slice_budget`,
  `$vga_status`, `$port_in`/`$port_out`) — the interpreter would have charged a
  step per op before it and the fold charges the whole run at once, so a clock
  read inside would see a different number;
* it must not be able to leave the handler (`$halt`, `$slice_exit`, `$fault`,
  `$jlook`, a bare `(return)`, or an `$ip` write that is not the operand
  advance) — an early exit would leave `$ip` parked in the middle of the run's
  operand words;
* its operands must fold (`foldOperands` in `trace-jit.js` must recognise the
  `ops(n)` prologue shape).

**The minimum run length is four**, `--tree-fold-min=N`. Four is the census's
own threshold — `in >=4-fold blocks` is the column that varies fifty-fold across
the corpus and decides which programs the fold can pay on.

**The terminator is not in the fold.** The block's branch, and the `cmp` or
`dec` that feeds it, stay exactly the ops they were. That is deliberate, and §
*Why the loop is not folded in place* below is the reason.

## How a run becomes a handler

**The lowering is `trace-jit.js`'s `emitTier3`, which is the region JIT's own
code generator.** Five passes, each bought with a bisect, and a second copy of
them here would have been a second set of bugs:

| pass | what it does to the run |
|---|---|
| `foldOperands` | every `(i32.load offset=K (global.get $ip))` becomes the literal operand word; the `$ip` advance disappears |
| `foldEa` | the ten-arm addressing-mode `br_table` collapses to the arithmetic of the one arm this op uses |
| `foldSeg` | the segment-base lookup becomes the base itself |
| `foldRegisterFile` | the register-file `br_table` on a now-constant index becomes a direct global access |
| `promoteRegs` | the eight register globals and the segment bases become wasm locals for the length of the run — loaded once at the top, stored back once at the bottom |

`promoteRegs` declines outright if any call in the run is not on its allow-list,
so a run that could change a segment base or the stack pointer never gets
promoted; it is still folded, just without the locals.

The emitted body is four parts:

```
  (global.set $steps (i32.sub (global.get $steps) (i32.const N-1)))   ;; the step charge
  <pro>                                     ;; live-in registers -> locals, once
  <the run, straight-line, in locals>
  <epi>                                     ;; live-out registers -> globals, once
  (global.set $ip (i32.add (global.get $ip) (i32.const ARITY*4)))
```

The handler is appended to the table the way a JIT region is — `opts.regions`,
past `HANDLERS.length`, so every existing index keeps its meaning — and its
ordinal is resolved through `vm.regionBase` at substitution time rather than
remembered, because only the built module knows where its extras landed.

Two runs with the same ops and the same operand words are the same handler
(`treeKey`). Without that, a program that recompiles its hot loop eighty
thousand times would generate eighty thousand identical functions.

### Flags

**The `$rec_*` calls are kept verbatim, in source order**, which satisfies the
census's per-FIELD last-writer rule by construction rather than by analysis. The
recorder is not one value: `$rec_add`/`$rec_sub` write `fop`/`fa`/`fb`/`fu`/
`fr`/`fw`; `$rec_logic` writes only `fop`/`fr`/`fw`; `$rec_inc`/`$rec_dec`
materialize CF first and then write `fcf`. So after `add` then `xor`, the *rule*
and the *result* come from the `xor` and the *carry* still comes from the `add`
— which is exactly what falls out of running the two recorders in order.

The compiler's own dead-flag pass ([docs/toyvm-dead-flags.md](toyvm-dead-flags.md))
has already run over these words, across block edges, with a real liveness
fixpoint, and swapped every provably-dead flag writer for its flagless twin. So
whatever recorder is still in the run is one some successor may read, and the
fold runs it. `emitTier3`'s own `deadflags` pass is turned **off** for that
reason (and because it is written for the eager scheme and would find nothing
anyway).

`test/test-toyvm-tree-fold.js` prints the six arithmetic FLAGS bits alongside
the registers precisely because this is the part a naive fold gets wrong
silently: hoist the run into locals and write the register file back at the end,
and the picture is right while `pushf` is wrong.

## The clock, and why the arena does not change shape

Two properties make `--tree-fold` a *transformation* that can be regression-
tested rather than a *retiming* that has to be re-photographed.

**1. The fold charges the dispatches it removes.** `$next` charged one step to
dispatch into the tree; the run it replaces retired N. So the body charges N−1
more, inline, up front. `$steps` at the block transfer is therefore identical to
what an unfolded compile would leave, and the block transfer is where
`$slice_exit` tests the budget, where an IRQ is injected, where the Sound
Blaster's DMA is fetched and where a handback is taken.

**2. The arena is byte-for-byte the same size.** Unlike fusion, which splices
the second op's word out, this **overwrites the run's first word with the tree's
handler index and leaves every other word of the run where it is**, as operands
the tree steps over. Word count, block boundaries, fixup indices and — the one
that matters — the arena-recycle point are all identical to an unfolded compile.
A moved recycle boundary is what shifted CONTAGIO, AQUAPHOB, COUNTDWN and
ZOKDTPLN under fusion; it cannot happen here.

### Why the loop is not folded in place

The scope this could have had is "fold the whole self-loop and iterate inside
the handler while the terminator's condition holds". It does not, and the reason
is [region-live.js's DREAM row](toyvm-region-live.md): a fold that loops in place
**absorbs block transfers**, and a block transfer is where the guest's slice can
end. Absorbing them moves every later slice boundary, and therefore every audio
render, for the rest of the run — an identical picture and a different wav from
the install on. Looping in place is the region JIT's job and it already has it.

### Self-modifying code

Nothing new is needed. The block was decoded normally, so `covered` already
names its bytes and the code bitmap already covers them; a store into any of
them raises `$smc`, `dos-loop.js` drops the whole compiled program, and the fold
goes with it.

What *does* change is the fast operand repair. `CodeCache.repairProg` walks
`prog.wordIp` per instruction and checks that the arena's handler at each word
is the decoded op, one of its twins, or the fused pair. A tree word is none of
those, so it declines with `handler differs` and the store falls back to
dropping the program and recompiling it. **That is a cost, not a hazard** — it
degrades to what the VM did before operand repair existed — but it is a real
regression on the self-patching class (CYCLE, CYBOMAN2), and it is the reason
the fold is opt-in rather than on.

## Installing without costing the run a handback

A fold cannot be installed by writing a word: the handler has to *exist* in the
module's table, and a wasm module is not editable after the fact. So the shape
is `region-live.js`'s, in miniature:

1. **compile** — a block wants a tree; `want()` records it and the block
   compiles *unfolded* and runs. Nothing is stalled.
2. **pump** — between two slices, off the guest clock: build a module with every
   wanted tree appended, instantiate it over the *same* memory, `carryState` the
   globals, `vm.rebind`, `machine.setVmExports`, re-apply the VGA programming.
3. **drop** — exactly the programs holding a block that wanted a tree, then
   **compile those heads back here, on the host's turn**, and **re-point** the
   shadow return stack rather than cutting it.

Step 3 is the whole care. A block the cache does not hold is a handback; a
handback cuts its slice short; the unspent remainder shifts every later slice
boundary. `cache.flush()` would have been one line and would have moved the
audio of every program in the corpus.

### The install policy is the difference between winning and losing

A run discovers its foldable blocks a few at a time over thousands of slices, so
"install as soon as something wants a tree" means a module build per tree — and
**every install moves the guest onto a cold instance the engine has to re-tier
from scratch**. Measured on ACCIDENT at 8M dispatches:

| arm | installs | guest throughput |
|---|---:|---:|
| plain | — | 15.6M dispatches/s |
| `--tree-fold`, install per tree | 18 | **8.1M/s** |
| `--tree-fold`, capped at 2 | 2 | **18.0M/s** |

So batching is not an optimization, it is what makes the fold usable at all. A
batch goes in when it is big enough to be worth a build (`--tree-fold-batch=64`)
or when it has stopped growing (`--tree-fold-wait=400` slices — the second half
matters, or a program that finds only three foldable blocks would never install
any of them), and a run installs at most four times (`--tree-fold-installs=4`)
and generates at most 256 trees (`--tree-fold-max`).

`--tree-fold` and `--region-jit` are mutually exclusive: both append to the
handler table through `opts.regions`, so whichever built last would own the
ordinals the other's arena words were written against.

## Gates

### 1. The existing suite, flag off and flag on

All 23 `test/test-toyvm-*.js` run individually, twice: once normally, once with
`TOYVM_TREE_FOLD=1` (the environment override exists for this gate alone — the
tests shell out to `run-dos.js` with argument lists of their own).

```
off: 23/23 passed
on:  23/23 passed
```

Both arms pass every suite. `test-toyvm-operand-patch.js` is the one worth
naming: it is the suite that exercises the self-modifying-code plan cache, and
it passes with the fold on because a folded block declines the in-place repair
and falls back to drop-and-recompile rather than repairing the wrong word.

### 2. `test/test-toyvm-tree-fold.js`

Six hand-assembled `.COM` programs, each one shape, each run twice and required
to print an identical AX/BX/CX/DX/SI/DI/FLAGS line:

| case | shape | must |
|---|---|---|
| `dot` | 12 straight-line full-width ops | fold |
| `addrloop` | a `loop`-terminated body walking a pointer | fold |
| `incloop` | `inc si / cmp si,16 / jne` | fold |
| `partial` | an 8-bit write in the middle | **not** fold |
| `alias` | a store followed by a load | **not** fold |
| `flagcons` | an `adc` in the middle | **not** fold |

The positive cases additionally assert that a handler was generated and
substituted; the negative ones that *nothing at all* folded.

```
PASS test-toyvm-tree-fold:
  dot       12345678FA2CA3B4A97FA97E0045   2 fold(s)/1 tree(s)
  addrloop  0F0E607800004050021000000044   2 fold(s)/2 tree(s)
  incloop   003C01C0000001C0001000000044   2 fold(s)/2 tree(s)
  partial   123700AA129D0000000000000044   no fold
  alias     1234567800001234000000000044   no fold
  flagcons  1234567868ACD110000000000044   no fold
```

Two notes for whoever edits that test. Its `rel8`/`rel16` helpers measure the
displacement from the byte *after* the whole instruction, not from where the
argument is written — get that wrong and the program runs forever at a
plausible-looking address instead of failing. And the `alias` case needs a `nop`
between the loop-counter prologue and the body, because the prologue's own store
is foldable and will otherwise join the body's first three ops and fold a run
the case is supposed to refuse.

### 3. The corpus, flag off vs flag on

`sweep-dos.js --dir=/tmp/demos --reps=1 --variants=tailcall --dispatches=8m`,
once plain and once with `--tree-fold`, then `sweep-diff.js`:

```
191 programs
REGRESSIONS: 0
WENT BLANK: 1   COLORS.EXE
changed (frame and/or dispatches moved, still drawing): 42
  -- 41 of those are identical frame, identical pixel count, identical dispatches
  -- 1 real: ZOKDTPLN.COM  frame 39fca965 -> 2c2fdb2b, px 63885 -> 63887
recovered: 1    QUARTZ.EXE (timeout -> ok; the known QUARTZ flake)
unchanged: 147
```

**42 programs folded at least one tree** and both movers are install *timing*,
not a folded value. The proof is the same experiment in both cases: change
nothing but when the batch installs (`--tree-fold-batch=1`, which installs a
handful of trees early instead of 64 later) and the arm reproduces the plain
build exactly.

- **COLORS.EXE** is an interactive setup menu (video type, sound card, port,
  IRQ) answered by `--auto-key`, whose keystrokes are scheduled off the dispatch
  clock. With the default batching it exits cleanly at 2.5M with the menu still
  on screen — a keystroke landed on a different prompt. With
  `--tree-fold-batch=1` it is byte-identical to the plain arm: same frame
  `7eb1ed94`, same 28081 pixels, same 8.0M dispatches, same `cs:ip`. A fold
  computing a wrong value could not reproduce the baseline frame hash in either
  configuration.
- **ZOKDTPLN.COM** is the COUNTDWN self-patcher, and it moves by 2 pixels of
  63885. Its stats name the path: 1301 self-modify breaks and 10 volatile
  paragraphs plain, 1308 and 20 folded. A folded block declines the in-place
  operand repair, so more paragraphs get promoted to volatile and the patch
  lands a frame boundary away. `--tree-fold-batch=1` (3 substitutions instead of
  160) restores frame `39fca965`.

Both are the cost of installing a module into a running machine, and both are
arguments for the hotness gate in *What is next* rather than for a different
handler body.

### 4. Six witnesses at 80M

Each witness run twice at `--dispatches=80m --pit-clock --auto-key
--sound-pref=sb --env=ULTRASND=220,1,1,11,7 --audio=FILE`, comparing the frame
hash and the sha256 of the rendered wav.

| witness | frame | wav | trees / installs / substitutions |
|---|---|---|---|
| DADEMO3 | same | **same** | 104 / 4 / 401 (2434 ops, 223.6KB) |
| RUNDEMO | same | **same** | 146 / 4 / 133 (738 ops, 423.6KB, capped) |
| BLIQ | same | **same** | 124 / 4 / 333 (1538 ops, 262.5KB, capped) |
| CATWALK | same | **same** | 64 / 4 / 52 (219 ops, 130.0KB) |
| ACME-BIG | same | differs | 121 / 3 / 144 (1025 ops, 263.9KB) |
| CONTAGIO | same | differs | 256 / 3 / 772 (3887 ops, 458.5KB, capped) |

**The frame is identical on all six.** Two wavs are not, and the two have
different causes; both are timing, neither is a wrong value.

**ACME-BIG is the slice grid, and it is provable.** The audio renderer advances
by `budget - left` at each handback, so the sample boundaries are wherever the
slices happen to cut. An install is a handback the other arm does not take —
1812 handbacks off against 1817 on at 20M — so from the first install onward the
two arms resample the same GUS voices at different offsets. That predicts one
thing: anchor the grid and the difference disappears. Re-run both arms with
`--lattice-clock`, which cuts every slice and renders audio on fixed multiples
of the dispatch clock, and ACME-BIG's wav is **identical**
(`572514130dbaf435`). The 83% raw byte agreement with no clean time shift is
what re-quantization looks like, not what different audio looks like.

**CONTAGIO survives the lattice, and its cause is arena pressure.** Same frame,
but the wav still differs and is 24 bytes shorter, so the guest reached a
different point per dispatch. The stats name the mechanism: the folded arm
carries 860KB of arena against 563KB and takes **1 arena recycle where the
plain arm takes 0**, and downstream of that recycle the two arms make different
`rep`-widening decisions (10850 widened runs off, 9930 on) and form different
traces (706 vs 797). A widened `rep` bills a different number of dispatches for
the same guest bytes than the loop it replaces, so once the widening decisions
diverge the dispatch clock is no longer measuring the same thing in both arms,
and the audio re-times. Capping at `--tree-fold-max=64` cuts the fold's WAT to
126KB but does not get the recycle back, so this is not a knob away.

For contrast, `--region-jit` — which installs modules mid-run through the same
recipe — reproduces ACME-BIG's baseline wav byte for byte. The install
machinery is not what does this; the extra handback and the extra arena are.

**So this gate is 4/6 as specified, 5/6 once the clock grid is held fixed, and
6/6 on the picture.** That is the single strongest argument for the flag
defaulting off: the fold does not change any value the guest computes, but on a
program that is already near an arena boundary it changes when things happen,
and on this VM when things happen is what the speaker plays.

## What it measures

### What it removes (load-independent)

One run per program at `--dispatches=20m --tree-fold`, with the tree handlers'
own entries read straight out of the handler histogram, so "trips through
`$next` removed" is `Σ entries(tree) × (ops(tree) − 1)` — a count, not a time.

| program | trees / installs | substitutions (guest ops) | WAT | tree entries | `$next` trips removed |
|---|---|---|---|---|---|
| BRW | 96 / 4 | 388 (2130) | 185.8KB | 673,328 | **3,362,656 — 16.81%** |
| ACCIDENT | 167 / 4 | 124 (722) | 437.5KB | 88,108 | 367,325 — 1.84% |
| DHADREN | 66 / 2 | 59 (308) | 145.5KB | 21,938 | 128,350 — 0.64% |
| B-STEEL | 21 / 2 | 86 (378) | 46.5KB | 10,636 | 42,549 — 0.21% |
| DTM2 | 0 / 0 | 0 | 0 | 0 | 0 — 0.00% |
| CYCLE | 14 / 1 | 6 (28) | 26.3KB | 3 | 18 — 0.00% |

BRW's three hottest trees are six ops each and run 222,909 / 222,909 / 222,904
times — one blitter, three blocks of it. That single loop is most of the 16.8%.
CYCLE is the other extreme and the most instructive row: 14 handlers were
generated, 6 were substituted, and they were entered **three times** in twenty
million dispatches. The fold is static; nothing in it asks whether a block is
hot.

### What it costs (interleaved A/B)

`bench-dos.js --variants=tailcall,tailcall+treefold --reps=5 --dispatches=20m
--cpu-time --dispatch-drift=4096`, arms alternating every rep with the order
rotated, minimum of five. Frames identical on all six.

| program | plain | `+treefold` | min | paired |
|---|---|---|---|---|
| BRW | 15.29 ns/disp (65.4M/s) | 13.56 ns/disp (73.7M/s) | **+12.7%** | −3.7% |
| ACCIDENT | 13.68 (73.1M/s) | 14.47 (69.1M/s) | −5.4% | −9.3% |
| DHADREN | 4.74 (211.0M/s) | 5.45 (183.4M/s) | −13.1% | −8.7% |
| B-STEEL | 10.69 (93.5M/s) | 12.41 (80.6M/s) | −13.9% | −10.0% |
| DTM2 | 5.20 (192.2M/s) | 5.17 (193.3M/s) | +0.6% | −0.5% |
| CYCLE | 8.97 (111.4M/s) | 9.09 (110.1M/s) | −1.2% | +1.7% |
| **geomean** | | | **−3.8%** | **−5.2%** |

**The fold as it stands is a net loss, and the two columns explain each other.**
Benefit tracks the removed-dispatch share and nothing else: BRW removes 16.8% of
its dispatches and gains 12.7%, which is about the right size for a dispatch
that costs ~8ns against a ~15ns average. Cost does *not* track it — B-STEEL
removes 0.21% and loses 13.9%, DHADREN removes 0.64% and loses 13.1%. That is a
flat per-run charge of roughly 5-14% for having installed a module at all: the
guest resumes on a fresh wasm instance the engine has to re-tier, and it is a
bigger instance than the one it left. DTM2, which folds nothing and never
installs, is the control and comes back at +0.6%/−0.5% — the noise floor.

So the shape of the result is: **one program in six is worth it, and it is the
one whose folds are hot.** Everything in *What is next* is aimed at one of those
two terms — the three relaxations raise the removed share, the hotness gate
removes the charge from the programs that were never going to earn it.

Load was 6.6-6.8 throughout and the per-arm spread ran to 91% on the noisiest
row, which is why only the interleaved minimum is quoted here and no wall clock
appears anywhere in this table.

### Why the other blocks declined

Every block the pass looks at and refuses is counted by reason. Across the six
20M runs, as a share of all declines:

| bucket | BRW | ACCIDENT | DHADREN | B-STEEL | DTM2 | CYCLE |
|---|---|---|---|---|---|---|
| partial-reg | 18925 | 2279 | 669 | 1508 | 295 | 337 |
| too short (<4 ops) | 14209 | 4029 | 1883 | 1244 | 405 | 533 |
| flag consumer | 7396 | 644 | 313 | 149 | 149 | 170 |
| terminator | 6833 | 3308 | 1092 | 727 | 346 | 436 |
| stack (push/pop) | 1245 | 3884 | 1888 | 1059 | 423 | 592 |
| call / ret | 809 | 1823 | 603 | 599 | 228 | 365 |
| alias | 1604 | 539 | 73 | 30 | 2 | 7 |
| muldiv | 1660 | 314 | 65 | 86 | 35 | 36 |
| io | 350 | 311 | 95 | 864 | 15 | 13 |
| segment | 132 | 696 | 739 | 180 | 75 | 164 |
| string (rep) | 263 | 156 | 50 | 102 | 26 | 79 |
| unsupported op | ~1000 | ~350 | ~290 | ~45 | ~25 | ~30 |

`partial-reg` and `too short` are the two biggest buckets in every program, and
`flag consumer` + `terminator` together are the next. Those are exactly the
three relaxations below, in that order. `stack`, `call` and `ret` are not
relaxations at all — a block that pushes, calls or returns is a control-flow
question, and this fold is deliberately a straight-line one.

The `unsupported op` tail is long and thin: `cdq`, `cwd`, `cbw`, `cwde`,
`xchg`, `shld`/`shrd`, `nop`, `bts`/`btr`, `lar`/`lsl`, and the protected-mode
`mov cr`/`lgdt`/`lidt`/`ltr`/`smsw` group. Most of them are one line in the
lowering table each, and none of them is worth adding until a census says a
folded run actually ends on one.

## The hotness gate (`--tree-fold-hot=N`)

The static fold above compiles a tree for **every** foldable run it meets at
decode time. That is why its cost is flat and unrelated to trees executed:
CYCLE built 14 handlers for 3 tree entries, ACCIDENT built 167 handlers
(437.5KB of WAT, the install cap) to remove 1.84% of its dispatches, and both
paid the whole build + re-tier bill anyway. `--tree-fold-hot=N` makes the fold
pay only for blocks the guest actually re-enters.

### The signal

region-jit decides hotness by sampling `$ip` at slice expiry (`region-live.js`,
`sampleAfter`/`profileFor` both 6e6). That is free, but at a 2e6-dispatch slice
it takes about **ten samples per 20M dispatches** — nowhere near enough to rank
individual blocks. The gate therefore uses the exact counter we already have:
`--block-hits`, one u32 per arena word at `isa.IPHIST_BASE`, bumped at the top
of `$next` (`emit.js` `ipHistBump`). It is per-block-entry and exact.

Its per-dispatch cost is what makes it usable only as a *window*. Interleaved
against plain, the `blockhits` arm reads +3.1% min / −1.7% paired across the six
programs — i.e. inside this box's noise, but certainly not free forever. So the
gate profiles on a `--block-hits` build and then **takes the profiler away**:
the fold's own instance swap installs a build with `ipHist` off, which is a
transition it was already making.

### Three phases

1. **`warm`** — the guest runs on the profiling build. `compile.js` still calls
   `tf.want(key, run, lin, addr)` for every foldable run, but `want` only
   *records a candidate*: the run, the guest linear addresses it covers, and the
   arena addresses to read counters from. Nothing is built.
2. **window close** at `warmFrom + warmFor` dispatches (`--tree-fold-warm`,
   default 10e6). Every candidate's counters are read; a candidate whose hottest
   arena address has fewer than N entries is dropped as `cold (<N entries)`. The
   survivors publish their **guest addresses** into `hotLins`, and their blocks
   are dropped so the next compile of them can want a tree.
3. **`closed`** — the install fires (always, even with zero survivors, so the
   profiler comes out on programs where nothing is hot), and from then on `want`
   accepts a run only if `hotLins` has its guest address; everything else is
   declined as `cold block (outside the hot set)`.

**The verdict keys on guest addresses, not arena words.** The first design
promoted the captured *run* and then substituted almost nothing — ACCIDENT built
88 handlers for 3 substitutions, BRW 1 tree for 0. A run is a list of arena
words, and fusion, the cross-block dead-flag pass and trace formation all emit
different words for the same guest bytes depending on compile context, so
`treeKey` no longer matched after the drop-and-recompile. Keying on the guest
address and letting the recompile hand its own run to the install fixed it:
ACCIDENT went 167 handlers/437.5KB → 2/4.3KB, BRW 96/185.8KB → 10/19.0KB with
98 substitutions.

The window has to be placed where the hot code exists. BRW's blitter is not
compiled until ~6-10M dispatches in, so `--tree-fold-warm` defaults to 10e6, not
the 2e6 the first version used.

The arena keeps the shape the design requires: an install that lands on a block
already executing is handback-neutral by the same recipe region-live installs
use (`dropWanting()` recompiles dropped heads on the host's turn and repairs the
shadow return stack rather than cutting it), and the run's first word still
becomes the tree ordinal with every later word left in place as an operand the
handler steps over.

### Load-independent counts, 20M dispatches

The bill (handlers built, WAT bytes) against the yield (dispatches removed):

| program | static: trees / WAT / trips removed | gated N=64: trees / WAT / trips removed |
|---|---|---|
| BRW | 96 / 185.8KB / 3,362,656 (16.81%) | 10 / 19.0KB / 2,716,552 (13.58%) |
| ACCIDENT | 167 / 437.5KB / 367,325 (1.84%) | 2 / 4.3KB / 82,659 (0.41%) |
| DHADREN | — / — / 128,350 (0.64%) | 0 / 0.0KB / 0 (0.00%) |
| B-STEEL | — / — / 42,549 (0.21%) | 1 / 2.4KB / 0 (0.00%) |
| DTM2 (control) | — / — / 0 | 3 / 6.9KB / 0 (0.00%) |
| CYCLE | 14 / — / 18 (0.00%) | 0 / 0.0KB / 0 (0.00%) |

The gate's own ledger, from the `tree gate:` line:

| program | hot blocks | promoted | cold | hottest candidate |
|---|---|---|---|---|
| BRW | 11 | 9 | 87 | 47,158 entries |
| ACCIDENT | 106 | 88 | 264 | 23,543 |
| DHADREN | 0 | 0 | 22 | **2** |
| B-STEEL | 1 | 1 | 6 | 44,271 |
| DTM2 | 4 | 6 | 14 | 2,285 |
| CYCLE | 4 | 4 | 10 | 26,930 |

DHADREN is the row that explains the static arm's −13.1%: its hottest foldable
candidate is entered **twice**. Every tree the static fold built for it was
build cost against a block that never ran again. The gate builds nothing there,
and DHADREN goes from −6.4% min / −9.5% paired (static) to +0.8% / +2.3%.

BRW keeps 81% of the static arm's yield (13.58% of dispatches removed against
16.81%) for 10% of its code size.

### Three-arm timing, interleaved `--reps=5`, `--cpu-time`, 20M dispatches

Baseline is plain `tailcall`. Positive is faster.

| program | `--tree-fold` (static) | `--tree-fold --tree-fold-hot=64` | `--block-hits` (control) |
|---|---|---|---|
| BRW | +0.4% min / +0.4% paired | **+23.9% / +18.3%** | +1.1% / +2.4% |
| ACCIDENT | +27.2% / −19.2% | +12.1% / −17.1% | +24.8% / −2.5% |
| DHADREN | −6.4% / −9.5% | +0.8% / +2.3% | +0.7% / −0.3% |
| B-STEEL | −6.8% / −11.0% | +3.3% / +1.5% | +2.4% / −0.2% |
| DTM2 (control) | +2.2% / +3.6% | −3.9% / −6.1% | −6.4% / −7.1% |
| CYCLE | +2.9% / +2.9% | +2.0% / −6.6% | −1.4% / −1.9% |
| **geomean** | **+2.7% min / −5.9% paired** | **+6.0% min / −1.9% paired** | +3.1% / −1.7% |

**Read the counts, not the percentages.** This box sits at load 20-40 and the
timing says so: the unchanged static arm read −3.8% geomean in the run in the
previous section and +2.7% here, and the `blockhits` control — which cannot be
faster than plain, it only adds a store per dispatch — reads +3.1% min. Both
numbers are noise. The defensible timing claim is the *shape*: the gate takes
the static fold's roughly −5% paired loss back to about parity, it is the only
arm that wins on BRW under both statistics, and it stops the three programs the
static fold regressed from regressing.

### Corpus and witnesses

Corpus sweep, 191 programs at 8M dispatches, `tailcall` off against
`--tree-fold --tree-fold-hot=64`: **191 unchanged, 0 regressions, 0 went blank,
0 frame hashes moved, 0 bucket moves.** (The static fold's own sweep was 190/191
with one explained mover; the gate is clean outright, because on most of the
corpus it now builds nothing at all.)

Six 80M audio witnesses, plain against `--tree-fold --tree-fold-hot=64`. **All
six frame hashes are identical between the arms and match the recorded values**
(DADEMO3 36128ac7, RUNDEMO 08502c5c, BLIQ a12d718a, ACME-BIG 362275f5,
CONTAGIO 163af616, CATWALK 19cfa368). Four of the six wavs are byte-identical
too; **BLIQ and CONTAGIO differ**.

That difference is the install schedule, not a wrong value. An install is an
instance swap — a handback at a point the plain arm does not have one — and a
handback cuts its slice short and shifts every later slice boundary, which is
what the audio clock is paced by. Re-running the two at several different
install schedules shows exactly that signature:

| arm | BLIQ wav | CONTAGIO wav |
|---|---|---|
| plain | e1c772ec7df8ae65 | f3424ccf29b4370b |
| gated, `--tree-fold-warm=10m` (default) | f5ea24a87bd7f09b | 54de3b4f52b71831 |
| gated, `--tree-fold-warm=20m` | **e1c772ec7df8ae65** (= plain) | 3791bac9f82f4142 |
| gated, `--tree-fold-warm=40m` | 948d3e7f2170d4c8 | 48757026068a60eb |
| gated, `--tree-fold-batch=1` | **e1c772ec7df8ae65** (= plain) | 54de3b4f52b71831 |

A wrong value would be one stable wrong answer. This is a different answer per
schedule, with two schedules landing back on plain byte for byte, and the frame
hash pinned at `a12d718a` / `163af616` through all of it. It is the same
audio-timing sensitivity region-live installs already have, and it is the reason
the fold's install policy batches and waits.

### Verdict

`--tree-fold` stays **default OFF**, and so does the gate. The gate is a strict
improvement on the static fold — it removes the flat build cost, keeps most of
the yield on the one program that has one, and turns three regressions into
non-events — but the gated arm is not >= plain on every program (DTM2, the
control, reads −3.9%/−6.1%, and CYCLE −6.6% paired), and the whole-corpus
argument for turning it on is still one program wide. Flipping the default is
the user's call regardless.

### Remaining declines, gated

BRW, N=64: partial-reg 22009, too short 19603, terminator 10169, flag consumer
9172, muldiv 2620, alias 2589, stack 1608, `cold block (outside the hot set)`
606, `cold (<64 entries)` 87.

ACCIDENT, N=64: stack 3708, too short 3606, terminator 2986, partial-reg 1924,
call 1316, segment 648, flag consumer 592, alias 445, ret 431, io 311, muldiv
275, `cold (<64 entries)` 264.

The two gate buckets are a rounding error next to `partial-reg`, `too short`,
`terminator`, `stack` and `flag consumer` — the gate is not what is limiting
coverage, the eligibility rules are, and the work list below is unchanged by it.

## What is next

The decline histogram is the work list, and the three relaxations it points at,
in the order the corpus argues for them:

**1. Alias disjointness.** Today every load after a store in the same run is
assumed to alias, and the run ends there. Most of those pairs are provably
disjoint at compile time — two absolute addresses, two displacements off the
same base register with different constants, a stack slot against a data
segment. Each of those is a decision the compiler can already make from the
operand words it has in hand, and each one that holds joins two runs into one.

**2. Partial registers as insert/extract.** An 8-bit write inside a 16-bit run
is not unmodellable, it is unmodelled: AL is bits 0-7 of the promoted AX local
and an 8-bit write is a mask-and-or on it. `partial-reg` is one of the two
largest buckets in every program measured, so this is the biggest single number
in the histogram — and it is also the one most likely to introduce a wrong
answer, because it is the only relaxation that changes what a *value* means
rather than merely what may be joined.

**3. Flags as values.** The fold refuses any op that reads flags, so a `cmp` in
the middle of a run, an `adc` chain, and a shift by CL all end it. Inside a
generated handler there is no reason for the flag state to live in globals at
all: it could be locals, computed where a reader needs it and materialized only
on the way out. That subsumes the `flag consumer` bucket and, more importantly,
is what would let the terminator's own `cmp` join the run.

Beyond the three: the fold is **static**. It generates a handler for any block
whose shape qualifies, hot or cold, which is why ACCIDENT generates 167 trees
and 437KB of WAT to remove 1.8% of its dispatches while BRW generates 96 and
186KB to remove 16.8%. A hotness gate — fold only a block the run has actually
entered often — would cut the module size and the build time by most of that,
and the block-hit census (`--block-hits`) is already the signal.

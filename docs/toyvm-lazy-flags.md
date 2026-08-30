# Lazy flags in the toy VM

## What was there

Every arithmetic instruction called an eager helper that computed all six
arithmetic flags and stored the word. `$flags_sub` is about 35 wasm instructions
plus a call: a shift for SF, an `i32.eqz` for ZF, an `i32.popcnt` of the low byte
for PF, the bit-4 XOR for AF, the sign-agreement test for OF, and the carry out
of the unmasked difference for CF.

It runs on every compare. `cmp_ri8` and `cmp_rm8` alone are 7.8% of the corpus's
dispatches, and almost all of that work is thrown away — a compare is followed by
one conditional branch that reads *one* bit.

## What it is now

`$fop` names a deferred rule (0 = nothing pending, the `$flags` word is
authoritative). `$fa`/`$fb` hold the operands, `$fu` the unmasked result, `$fr`
the result masked to the operand width, `$fw` the width, `$fcf` a carry that has
to survive the instruction (the carry IN of a 32-bit `adc`, and the preserved CF
of `inc`/`dec`). Nine `$rec_*` recorders store and stop; six `$get_*` getters
compute one bit on demand; `$flags_sync` folds a pending record back into the
word. It is the scheme `src/03-registers.wat` uses in the production emulator.

`$fr` is masked at **record** time rather than in the getters, so ZF, SF and PF —
which do not care which rule produced the result — need no branch on `$fop` at
all. ZF is by far the most-read flag in this corpus.

Everything that touches the whole EFLAGS word goes through `$flags_word` (read)
and `$flags_put` (write, retiring the record): PUSHF/POPF, SAHF/LAHF, IRET, the
real-mode and IDT interrupt frames, `$flags_mul`, the shift and rotate helpers,
and every partial writer that preserves bits it does not set. Those are all cold.
The host's `get_flags`/`set_flags` exports go through them too — `gate.js` reads
the word after every case and `dos-loop.js` writes it back on a hooked IRET, and
a raw global access there would read a stale word or leave a pending rule to
overwrite what the host just wrote.

Bits outside `FLAGS_ARITH` (DF for the string ops, IF, TF) are never deferred and
are read and written in place. `bit()` asserts on any arithmetic bit reaching
that path rather than silently returning a stale one.

## Two name collisions, one of which cost the afternoon

The unmasked-result global was originally called `$fs`. That is the **FS segment
register's** global. Every recorded ALU result landed in FS, and `gate.js` read
78 of 60000 with `fs moved 0x00dc->0x0137 but corpus says unchanged` on every
row. It is renamed `$fu`, with the reason written next to the declaration.

The second is subtler and is why `checkNesting()` now also rejects a duplicate
function definition. `genShifts()` appends its helpers to a module-level
`SHIFT_FNS` array instead of returning them, so rebuilding the handler table for
the other arm emitted **both** arms' shift helpers under the same names. The
module still compiled. `lib/compile-wat.js` kept one of each, the run produced
correct output, and the arm being timed was neither of the two.

## Validation

**The op stream does not change.** A compare records its inputs instead of
computing six bits; it consumes the same operands, retires the same dispatch,
charges the same step. So unlike the fusion change — which legitimately shrank
the arena — lazy and eager must agree **exactly**, arena size included.

- `gate.js`, 60000 cases against real-silicon vectors: **60000/60000 on both
  arms**. This is the check the scheme needs most. The gate compares the final
  FLAGS word, and a deferred rule that is wrong for one operand pair is invisible
  in a demo that never branches on that bit.
- The whole demo corpus at 8M dispatches, lazy against the eager build:
  **177 programs, 177 identical** — handbacks, interrupts, traces, arena size,
  recycles, frame hash, pixel count and stopping `cs:ip`.

`--no-lazy` on `run-dos.js` and `gate.js` builds the eager arm;
`tailcall+nolazy` is the `bench-dos.js` arm.

## Measured: it is a wash

Core ten, 20M dispatches, five interleaved reps, guest-slice CPU time, box at
load 13-20:

**geomean +0.1% by minimum, -1.5% by paired ratio; lazy ahead on 6 of 10.** A
second run of the same command disagreed with the first on the *sign* for four
programs. There is no effect here to find at this resolution.

That is not a measurement failure, and the reason is structural:

> **Lazy flags and cmp/Jcc fusion are substitutes for this pair, not
> complements.** Fusion already put the compare and the branch inside one
> handler. Eager computes six flags and the branch reads one bit; lazy stores six
> globals and the branch computes one bit. The work is the same. Laziness pays
> when flags are computed and never read, and a fused `cmp_*_j*` reads one
> immediately, in the same handler, every time.

The programs bear that out: the swing is widest exactly on the branch-dense ones
that fusion already won (DTM2, CONTAGIO), and it does not settle on a sign.

## Why it is kept: the fused pair answers its own condition

Because the win is one step further on, and it needs this. That step is now in.

Inside a fused `cmp_ri8_jz` the producer and the consumer are both known **at
generation time**. The general getters cannot use that: `$get_cf` has to ask
`$fop` which rule is pending and test it against four possibilities before it can
return a bit, because in general it does not know who wrote the record. Inside a
fused handler there is nothing to ask — the first half is the only thing that
could have written it, we generated it, and we know it was a subtract at 16 bits.

So `genFusedBranches` rebuilds the branch half with a condition specialized to
its partner. The `$fop` dispatch collapses to the one arm that can be taken, the
width stops being a global load, and ZF — the most-read flag in this corpus —
becomes an `i32.eqz` of a global with no branch at all. Across the module that
removes **66 of 119 `$get_zf` call sites and 44 of 149 `$get_cf` sites**.

The other five flags still have to be *available* to a later reader, and that
availability is exactly what the record buys. The specialization reads the record
directly; it does not skip writing it.

`bitFrom()` holds those bodies. They are the getters' bodies with the `$fop`
dispatch removed and `$fw` substituted by a constant — deliberately not a second
derivation of the flag rules, which is the thing that would rot.

**Two things enforce the pairing.** The second column of `FUSE_FIRST` names what
each first half records, and it is hand-written, so the generator checks it
against the recorder call the body actually contains: exactly one distinct
`$rec_*`, and it has to be the declared one. An ALU form that grew a second flag
write, or a table row that drifted from its handler, is a build error rather than
a branch silently reading a flag under the wrong formula. `sh2_r16` is in the
list with no rule at all — a shift computes its flags eagerly and retires the
record, so its branch reads the word the general way.

### Measured

`--no-fusecond` (and `tailcall+nofusecond`) is the A/B partner. Core ten, 20M
dispatches, five interleaved reps, guest-slice CPU, box at load 20 climbing to
40: **+1.7% by minimum and +1.4% paired, ahead on 9 of 10 by minimum.** Only
DEMO5 lost, and it is the least branch-dense program in the set — CGA mode 4, the
one non-VGA capture path.

Small, but unlike the lazy A/B above the *direction* is consistent, and it was
taken on a badly loaded box, so it is a floor.

**The gate cannot check this one.** `gate.js` runs single instructions and never
forms a fused pair, so it is blind to the specialization by construction — it
stays at 60000/60000 whether the condition is right or wrong. The corpus is the
check: all **177 programs identical** to the `--no-fusecond` build at 8M
dispatches, arena size included.

## Benchmarking notes this produced

Two changes to `bench-dos.js`, both because this box sits at load 10-40 and the
first attempt at this A/B came back with 39-320% per-arm spread:

- **`--cpu-time`** measures the guest slice's user+sys CPU instead of its wall
  clock. Same fixed work — the arms retire the same dispatches by construction —
  on a meter the other processes cannot move as directly.
- **The paired ratio.** The minimum-of-reps ratio compares two arms' *best*
  moments, which need not be the same moment; under load, whichever arm got the
  quiet rep wins and the winner changes run to run. The paired ratio compares
  each arm against the baseline **within one rep**, seconds apart under the same
  load, and takes the median. Both numbers are printed. When they disagree, as
  they did here, that disagreement is the finding.

Neither removes contention. The absolute figures here are 2-3x worse than the
quiet-box numbers in [toyvm-superinstructions.md](toyvm-superinstructions.md),
and nothing in this file should be quoted as this VM's throughput.

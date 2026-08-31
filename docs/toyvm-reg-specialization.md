# Pinning the register a handler reaches for

## The register file is reached through a jump table

A guest register lives in a wasm global. A handler gets at one by calling
`$rget16` / `$rset8` / … with an index, and those helpers are a `br_table` over
eight arms — the same shape `$get_reg` uses in `src/03-registers.wat`.

When the index is a literal, that whole apparatus folds: the engine inlines the
helper and the `br_table` on a constant becomes one `global.get`. When the index
comes out of the arena — `(local.get $t0)`, loaded from the operand stream — it
cannot fold anything. Every register access is a call and an indirect branch on
a value the compiler is not allowed to know.

**And it does know it.** The index is a word *this compiler wrote into the
arena*. It was a constant the whole time; it was just spelled as a load.

`tools/toyvm/reg-index-census.js` measures how much of a run that costs, by
classifying every handler body and weighting it by `--handler-hist` entries:

| program | dispatches | specializable index | packed / multi-operand | literal index only | no register access |
|---|---|---|---|---|---|
| DHADREN | 6,977,694 | **68.4%** | 11.4% | 4.5% | 15.6% |
| DTM2 | 5,757,220 | **72.0%** | 8.1% | 6.1% | 13.7% |
| ACCIDENT | 5,590,841 | 53.8% | 20.0% | 5.2% | 21.1% |
| CONTAGIO | 7,020,122 | 47.0% | 16.2% | 3.9% | 32.9% |
| CYCLE | 6,603,659 | 46.9% | 35.1% | 3.7% | 14.4% |
| CMA_SHRT | 5,095,476 | 49.9% | 1.1% | 46.0% | 3.0% |
| RUNDEMO | 183,550 | 48.8% | 2.1% | 4.9% | 44.2% |
| BRW | 810,954 | 46.9% | 24.0% | 2.9% | 26.1% |
| DEMO5 | 7,338,569 | 42.4% | 13.7% | 3.6% | 40.3% |
| B-STEEL | 7,281,257 | 36.4% | 11.5% | 11.6% | 40.4% |

## What it does

Eight twins per handler, each the original body with the index expression
replaced by a literal, and the compiler stores the one whose literal is the
value the handler was going to compute.

**The safety argument is one sentence.** A twin is the original body with an
expression replaced by the value that expression was going to evaluate to, so
it cannot mean anything different. Same handler, same arity, same operand still
sitting in the arena, same dispatch, same `$steps`. The corpus diff therefore
stays a strict check rather than a smoke test — see Validation.

That leaves exactly one place for the risk to live: whether the JS that
recomputes the index agrees with the WAT that used to compute it. So the index
expression is not matched against a list of known shapes. It is **resolved** —
backwards through the local that holds it, to the arena word it came from,
through a four-operator subset (`and` / `or` / `shl` / `shr_u` against a
constant). Anything outside that subset declines the handler, and declining is
always safe.

Resolution is what makes the memory forms work at all. `mov_rm16`'s index is
`(local.get $t6)`, and `$t6` is not an operand — `EA_SETUP_PRE` computes it as
`(t0 >> 8) & 7`. The resolver walks that back to operand 0 with the program
`[shr_u 8, and 7]`, which the compiler then runs over the same word. A fused
body needs the same care for a different reason: it is two bodies concatenated,
so it has two operand preambles and `$t0` names a *different* arena word in each
half. Definitions therefore carry a position and the resolver asks for the
latest one before the use.

## The table is hard-capped, so the set is a budget

`--handler-hist`'s pair census is `HIST_SLOTS²` words of the VM's **own linear
memory** — 16MB at 2048 slots, and `MEM_PAGES` is derived from it. Passing 2048
handlers quadruples a table every run allocates, whether or not anyone asked for
a census. With 1581 handlers built, **467 entries are free: 58 handlers at eight
twins each.**

That constraint turned out not to bite, because the distribution is steep.
Ranking every eligible handler by its mean share of dispatches across the
core-ten set:

```
   1  mov_rm16                 4.34%   cumulative  4.3%
   2  cmp_ri8_jz               4.24%   cumulative  8.6%
   3  cmp_rm8_jnz_t            3.67%   cumulative 12.2%
   4  push_r16                 2.97%   cumulative 15.2%
   5  mov_rm8                  2.76%   cumulative 18.0%
  ...
  58  imul_r16_nf              0.15%   cumulative 46.6%   <-- budget
 245  (everything eligible)                        51.3%
```

**58 handlers buy 46.6% of all dispatches; all 245 buy 51.3%.** The tail is
worth 4.7% between it, so the cap costs almost nothing. The list lives in
`tools/toyvm/reg-spec-set.js` with the command that produced it, and a name in
it that no longer exists in the handler table is a build error rather than a
silent skip — a rename means the ranking was taken on a different table.

## Where it sits in the pipeline

Last. Fusion, trace formation, spin collapse and the flag pass each swap a
handler for a different one; this pins whichever handler ends up there, and
nothing looks a handler up afterwards. That ordering is also why the set
contains `dec_r16_nf` and not `dec_r16`: by the time this runs, the flagless
twin is what is in the arena.

## Measured: it does not pay, and it is off

**This is a negative result.** The transformation is correct, it removes the
work it claims to remove, and it makes the VM no faster — the cleanest readings
say slightly slower.

Two independent runs, `tailcall` against `tailcall+regspec`, 15 interleaved reps
per arm, 8M dispatches, `--cpu-time` (box at load 11.7 and 13.5):

| run | DTM2 | ACCIDENT | geomean |
|---|---|---|---|
| 1 | −3.2% min / −2.6% paired | −2.0% min / −1.8% paired | **−2.6% min / −2.2% paired** |
| 2 | — | — | **−2.4% min / −1.4% paired** |

Negative is the specialized arm being slower. The two runs agree on sign and
roughly on size, which nothing earlier in the session did.

**Getting to that took discarding four earlier measurements, and how they failed
is the useful part.** The first A/B (7 reps, 4M dispatches) said the *un*specialized
arm was 10.4% faster; a 21-rep run on the same program said +4.8% on min and
−3.0% on paired — the two estimators disagreeing in sign on one program. Across
the day the readings spanned −3.0% to +10.4%, and they collapsed toward zero
exactly as the configurations got cleaner (more reps, more dispatches, fewer
handbacks). A large number from a noisy configuration is not a large effect.

Two things made the last pair readable. `--cpu-time`, because wall clock at load
12 counts every other process on the box. And picking programs with few
handbacks — DTM2 hands back 495 times in 8M dispatches, so almost nothing but
the interpreter is being timed, while DEMO5 hands back 43,252 times and dilutes
the signal with host work.

`tools/toyvm/trace-jit.js` was the other instrument tried and it cannot serve
here: 60 of 60 programs decline as `padding`, and DTM2's real trace declines as
`unfoldable` because tier 1 does not know the traced twins. The `--passes=`
knob added for this (`--passes=regfold` prices register-file folding alone,
against a tier 2 that normally runs three passes at once) is still the right
instrument for the question and is left in place for a corpus where it applies.

### Why it might be slower

The likeliest mechanism is the one this project already has a negative result
about. `$next` dispatches through **one** indirect call, and its predictor sees
the whole arena's traffic. Before, every `mov_rm16` in a program was one target;
now it is eight. The specialized handler is cheaper, and the branch that reaches
it is less predictable — and [the dispatch work](toyvm-dispatch-shootout.md)
already found that the mispredicted indirect call is the cost that matters and
that removing work from around it does not necessarily help.

Note what this is *not*: both arms run the identical wasm module. Specialization
is a choice about what the compiler writes into the arena, not a build option,
so module size, function count and compile time are held equal by construction.
Whatever the difference is, it is about which handlers execute.

### So it is off by default, and so is the generation

`--reg-spec` turns it on; nothing turns it on by itself. The gate covers the
*generation* of the twins as well as their use, which matters more than it
sounds: 464 twins take the handler table from 1581 to 2045, and the ceiling is
2048 — because `--handler-hist`'s pair census is `HIST_SLOTS²` words of the VM's
own linear memory and `MEM_PAGES` is derived from it. Leaving three free entries
would mean the next person to add an opcode fails the build, which is not a
state to leave a table in on behalf of a change that buys nothing.

## Validation

- The whole demo corpus — 199 programs — at 8M dispatches, specialized against
  unspecialized, via `tools/toyvm/equiv-dos.js --arm=--no-reg-spec`:
  **199 same, 0 differ, 0 timed out.** Handbacks, interrupts, billed dispatch
  count, frame hash, pixels, console text and stopping `cs:ip` identical on
  every one. (The sweep ran while the flag polarity was inverted — the arms
  compared are the same two configurations either way. Notably DD.EXE did not
  time out this time, having done so on both the trace-block and spin sweeps.)
- `gate.js` 60000/60000 — and **structurally blind here**, which is worth
  stating because it looks like it should not be: the gate never calls
  `compileProgram` at all. `vm.stepOne` decodes one instruction and writes the
  words into the arena itself, so no compiler pass of any kind runs. The corpus
  is the only check.

## What is next

- **The measurement, on a quiet machine.** −2% at load 12 is the sign this box
  can resolve, not a settled number. If it is real, the mechanism above is
  testable directly with `tools/wasm-native.js`.
- **Packed operands.** `mov_rr16` and friends pack two 3-bit register fields
  into one arena word, which is why they show in the "packed" column above —
  8.1–35.1% of dispatches, and `CYCLE` is a third of its run. Covering them
  takes 64 twins each, so it needs the table ceiling moved first: the pair
  census would have to become sparse, or be allocated only when asked for.
- If the indirect-call hypothesis is right, **neither of those is worth doing**,
  and the census tool is the lasting part of this work rather than the twins.

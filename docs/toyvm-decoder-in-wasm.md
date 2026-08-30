# Moving the toy VM's decoder into wasm

## Why, and what changed to make it worth doing

`tools/toyvm/decode.js` opens by saying the decoder is on the host *deliberately*:

> Every dispatch variant consumes the identical op stream produced here, so
> decode cost is outside the measurement entirely and the only thing differing
> between builds is how control moves from one handler to the next.

That was the right call for a dispatch shootout, and it is the wrong shape for
the thing the shootout is supposed to inform. Our production interpreter decodes
in WAT (`src/07-decoder.wat`) and caches in WAT (`src/04-cache.wat`); the toy VM
does neither, so any figure it produces is measured against a host/guest split
the real emulator does not have. The dispatch results are quoted as whole-app
percentages, and a whole-app percentage is diluted by however much of the app's
wall clock was JS — which, measured across the ten-program census, ranged from
5% to 85% depending on the program.

Linking far transfers (commit `1b2ba62e`) took the first bite out of that: the
programs whose handbacks were far transfers now sit almost entirely in wasm.
What is left is visible in the per-cause census below.

## Where the remaining handbacks go

Ten programs, 40M dispatches each, counts exact (they do not depend on box
load). `other` is budget expiry plus indirect-jump misses.

| program | handbacks | interrupts | traces | smc | other |
|---|---|---|---|---|---|
| ACCIDENT | 15,336 | 2,282 | 837 | 1 | 12,216 |
| B-STEEL | 4,044 | 97 | 80 | 43 | 3,824 |
| BRW | 3,512 | 10 | 42 | 12 | 3,448 |
| CMA_SHRT | 1,561 | 53 | 235 | 449 | 824 |
| CONTAGIO | 1,895,514 | 172,045 | 517,902 | 173,190 | 1,032,377 |
| CYCLE | 2,000,737 | 2,000,035 | 102 | 0 | 600 |
| DEMO5 | 124,873 | 98,278 | 1,255 | 25,549 | — |
| DHADREN | 144,589 | 3,161 | 220 | 137,696 | 3,512 |
| DTM2 | 1,849 | 49 | 93 | 4 | 1,703 |
| RUNDEMO | 125 | 38 | 65 | 2 | 20 |

Three shapes, and they do not want the same fix:

- **Interrupt-bound** (CYCLE at 100% of its handbacks, DEMO5 at 79%). These are
  DOS/BIOS services in `dos.js`. Staying in JS by decision — the machine is not
  the thing under study, and CYCLE's two million are one `int 16h` keyboard poll.
- **Compile-bound** (CONTAGIO: 517,902 compiles and 173,190 self-modify breaks).
  This is the decoder, and it is what this document is about.
- **Neither** (DTM2, RUNDEMO, B-STEEL, BRW, CMA_SHRT — hundreds to a few
  thousand handbacks across 20–40M dispatches). Already wasm-resident.

The corpus-wide weight of the compile-bound shape is **not yet measured**: the
sweep records pass/pixels only, so "how many of the 199 demos look like
CONTAGIO" is an open question. CONTAGIO and cw2.com (467k traces, 1.5GB of arena
churn, 378k SMC breaks) are two known cases. Measure before quoting a payoff.

## What is actually being bought, and what is not

Worth stating plainly, because the first draft of this document had it wrong:
**moving the decoder into wasm removes no boundary crossing at all.** Decode is
already pure JS writing threaded-code words into a typed array over the wasm
memory; there is no per-instruction call into wasm to eliminate. The guest still
hands back once per compile either way, because the handback is what says
"nothing is compiled at this address yet".

So the entire win is that wasm decodes faster than JS does. That is a real win
where compiling is most of the wall clock — CONTAGIO's 517,902 compiles, cw2.com
churning 1.5GB of arena — and it is nothing at all on the programs in the third
group above. It also means the payoff scales with *coverage*, which decides the
fallback rule below.

## The unit is a block, and the worklist stays on the host

```
compile_block(ip, codeBase, mask, d32, arenaAt, maxWords, oneInsn) -> words written
```

It writes threaded-code words straight into the arena (already wasm memory,
already where they have to end up) and records what the JS cache needs into side
tables read back after the call: branch fixups and the decoded byte ranges that
feed `isa.CODE_BITMAP`. One crossing per block instead of per instruction.

The *worklist* — which blocks still need compiling — stays in `compile.js`. It
already has one, it owns the block cache the answers go into, and a second copy
in wasm could disagree with it about which blocks exist. That disagreement shows
up as a jump into the middle of an instruction a thousand blocks later, which is
the worst possible place to find it.

## The fallback rule: stop, don't decline

The first version declined a whole block whenever any instruction in it was
unimplemented. That is safe and nearly useless, and the differential tester said
so immediately: **0.8% of cases claimed**. Real code contains the whole opcode
range, so one unknown byte anywhere throws away the decode of everything around
it, and partial coverage buys nothing until it is total.

So `compile_block` *stops* instead. It reports why (`dc_stopped`) and where
(`dc_stop_ip`), rewinding its output cursor to the start of the instruction it
could not decode, and the host's decoder picks up from there into the same
arena. Coverage then buys time in proportion to itself.

Correctness never depends on the wasm decoder being complete — only on it being
*right about what it claims*, and on it never claiming something the JS decoder
would refuse. Both are what `tools/toyvm/decode-diff.js` checks.

Two things are deliberately declined rather than implemented:

- **A store through a CS override.** The JS decoder ends the block there so the
  patched bytes get recompiled, *unless* the host has watched that exact linear
  address hit nothing compiled often enough to call it benign. That verdict is
  host state learned at run time; deciding it in wasm without the benign set
  would end blocks the host has already decided not to end, which is not a wrong
  decode but does silently give back the 96% of DOPE.EXE's wall clock the benign
  set was added to recover.
- **More than eight prefix bytes.** Matching `decode.js`'s limit exactly, because
  a byte run one decoder calls an instruction and the other refuses is a block
  that means two different things depending on which one reached it first.

## The differential tester

`tools/toyvm/decode-diff.js` decodes the same bytes both ways and diffs the word
streams, naming the opcode on a mismatch. It compares **one instruction** at a
time against `decodeOne`, not a block against `compileProgram`: the block layout
is the host's rules (end markers, fall-through contiguity), and a difference
there reads as a decode bug when it is not one.

It checks three things, and the second is the one that matters most: the emitted
words, the instruction's **length**, and that wasm never claims an encoding JS
declines. Getting the words right and the length wrong is a decoder that resumes
the next instruction mid-encoding.

`gate.js` catches a wrong stream too, but only by way of a wrong final register
state — which names the instruction that RAN, not the one that decoded wrong,
and says nothing about an encoding whose two decodings happen to behave the same
on the one case tested.

Measured 2026-08-30, ALU/MOV/Jcc implemented:

| corpus | cases | mismatches | claimed |
|---|---|---|---|
| seeded random encodings | 20,000 | 0 | 99.8% |
| every 11th offset of 177 real DOS binaries | 3,490,936 | 0 | 48.9% |

The 48.9% is per *byte offset*, most of which are not instruction boundaries at
all; it is a coverage figure for three opcode families, not a prediction of how
much of a run's decode time moves. That number needs `--handler-hist` weighting
and is not measured yet.

## A generated-WAT trap, now checked

`$dc_modrm` shipped with one close-paren too many. It closed the *module*, not
itself; `lib/compile-wat.js` accepted that silently, dropped every function
after it out of the module, and compiled their calls to nothing. The symptom was
a decoder that returned correct handler indices with zero operands — no crash,
no warning. `tools/check-parens.js` covers `src/*.wat` and never sees generated
text, so `emit.js` now runs its own nesting check before handing the module to
the compiler: a top-level `(func` starting at depth 0 is an error.

## What makes this tractable

The decoder is integer work end to end. The one place it looks string-shaped —
building handler names like `fadd_m32` and looking them up in `H` — resolves to
a constant index at *generation* time, not at decode time. And the effective
address is already packed into a single i32 by `packEa`, in exactly the layout
a wasm decoder would choose.

So the WAT is generated, from the same tables `decode.js` uses, the way
`emit.js` generates its 728 handlers. Sharing the tables is the point: a decoder
written out by hand would drift from the JS one the first time an opcode moved,
and the diff tool would then be reporting on two independent guesses rather than
one table rendered twice.

## Order of work

1. Prefixes, ModRM/EA (both 16- and 32-bit forms), the immediate readers.
   Everything else hangs off these.
2. The families that are most of real code: ALU r/m, MOV, Jcc, PUSH/POP, INC/DEC.
3. Whatever the decline census names next — the same way
   `match-loops.js --why` is read.

Not in scope here, and the next thing worth pricing after it: the block *cache*
is still JS (`DosCache` in `dos-loop.js`), so a compile still returns to the
host to be filed even once the decode itself does not. `src/04-cache.wat` is the
production answer to that.

# Compiling through a conditional branch

## What a block edge costs

A threaded-code op pays a dispatch. A block *transfer* pays a dispatch and then
something else on top of it: the successor's arena address is loaded out of the
operand stream, stored to `$ip`, and the next handler is reached through an
indirect call the predictor has no history for.

`tools/bench-loops.js` prices the two separately, with the dispatch count held
equal by construction (`nop_chain` against `jmp_chain`): **a dispatch is ~8ns
and a block transfer adds ~9ns on top of it.** So the transfer is not a rounding
error next to the dispatch — it is the same size again.

The handler-pair census in
[toyvm-superinstructions.md](toyvm-superinstructions.md) says how often that is
paid: **3.25 dispatches per block transfer**. Fusion removed a dispatch from
that ratio. This removes a transfer.

## What it does

A conditional branch used to end the block. Its two edges were both arena
addresses, both fixed up, and whichever one the condition picked was stored to
`$ip`:

```
[j<cc>][arenaTaken][guestTaken][arenaFall][guestFall]     <- block ends here
```

Now the compiler keeps decoding at the fall-through address and lays that code
out immediately behind the branch, which no longer needs to be told where its
not-taken edge is — it is the next word:

```
[j<cc>_t][arenaTaken][guestTaken][guestFall]  [ ...the not-taken path... ]
```

The taken edge is a side exit and pays what it always paid. The not-taken edge
pays nothing at all: no operand load, no `$ip` store, and the next handler is at
the address `$ip` already holds.

**The fall-through is registered as a real block head at that word.** Anything
else that jumps to it lands in the middle of the trace, and the wasm decoder
stops there, exactly as it would for a block laid out on its own. So this is
trace *formation*, not code duplication — there is never a second copy.

## Why the corpus can still check it

The branch still dispatches, still publishes `$gip`, and still tests the budget
and the self-patch flag at exactly the point it used to. So a traced run retires
**the same dispatches in the same order with the same slice boundaries** as an
untraced one, which is the property that makes the demo corpus a regression test
rather than a smoke test.

What does move is the arena: one word shorter per traced edge, and the blocks
are laid out in a different order. That is the same class of difference fusion
produces, and it has the same downstream consequence — a program that recycles
its arena crosses the recycle boundary at a slightly different place and
recompiles a slightly different set of blocks. CONTAGIO comes out with 7093
compiles against 7092. Its frame, pixels, interrupts, console text and stopping
`cs:ip` are identical, which is the part that matters.

## Fusion and tracing want the same two instructions

`cmp` / `jz` is the pair fusion exists for and the branch tracing extends
through. Doing either one first would cost the other:

- Fuse, then trace, and the trace swap has to find a *fused* branch to swap.
- Trace, then fuse, and `fuseTail` goes looking for a plain `j<cc>` that is no
  longer there.

So the generator builds the traced twin of every fused pair as well as of every
plain branch — `cmp_ri8_jz_t` alongside `cmp_ri8_jz` — and `extendThrough()`
fuses the tail *first* and then swaps whatever is there for its traced twin.
`TRACE` maps handler index to handler index, so the compiler never learns either
naming scheme. The table goes from 1148 handlers to 1356.

## What it will not do

- **Extend past a block that wrote memory.** That is the decryptor rule the main
  compile loop already applies, in its blunt form: what follows such a block is
  very often the bytes it just wrote (COROMER.EXE, AMORP.COM), and decoding them
  now bakes the ciphertext into the trace.
- **Extend into a block that already exists.** Falling into a compiled block is
  what the arena is for. Emitting a second copy would end the way COMPOVRS.EXE
  did — two copies, blocks ending in different places, interrupts landing on
  different instructions, and a different frame from 4M dispatches on.
- **Extend without room.** The tail of a full arena is a handback; there is no
  point starting a trace that cannot finish an instruction.

## Measured: how much of the run is a traced branch

`--handler-hist=9999`, summing the `_t` rows over the `handler entries` total.
Core ten, 8M dispatches — exact, and independent of box load:

| program | dispatches on a traced branch | traced edges |
|---|---|---|
| DTM2 | **28.4%** | 169 |
| RUNDEMO | 16.6% | 86 |
| CYCLE | 12.8% | 155 |
| BRW | 12.2% | 88 |
| DEMO5 | 9.7% | 613 |
| DHADREN | 8.6% | 219 |
| CONTAGIO | 8.0% | 3451 |
| ACCIDENT | 4.5% | 150 |
| B-STEEL | 2.7% | 57 |
| CMA_SHRT | 2.1% | 91 |

Read that as an upper bound on the beneficiaries, not as the saving: a traced
branch only avoids a transfer when it is **not** taken, and the census does not
say which way each one went. DTM2 is the branch-dense end of the corpus and is
where fusion won biggest too, for the same reason — its hot chain is a compare
and a branch.

## Measured: what it is worth

**Not on this box.** Load sat between 20 and 43 for the whole of this work, and
the noise floor established in [toyvm-dead-flags.md](toyvm-dead-flags.md) — a
program with nothing to gain "winning" by 6.8% — is wider than anything here
could produce. `--no-trace-blocks` and `tailcall+notrace` are the A/B partners
and the measurement is left to a quiet machine.

Unlike dead-flag elimination, this one does **not** rest on "strictly less
work": it is strictly less work per not-taken branch, but it also changes where
code sits in the arena, and locality can move either way. The honest claim is
the mechanism plus the share above.

## Validation

- The whole demo corpus — 199 programs — at 8M dispatches, `--no-trace-blocks`
  against the default, via `tools/toyvm/equiv-dos.js --allow-arena`: **199 same,
  0 differ.** Handbacks, interrupts, frame hash, pixel count, console text and
  stopping `cs:ip` identical on every one; arena footprint and compile counts
  allowed to move, and they do. (DD.EXE hit the sweep's per-program timeout at
  load 38 with three jobs in flight and came back SAME run on its own — the same
  load artifact it produced on the dead-flag sweep, not a result.)
- `gate.js` 00-0E at 2000 cases each: 30000/30000. As with fusion and dead
  flags, the gate is structurally blind here — it runs one instruction at a
  time and a one-instruction block has no branch to trace through — so the
  corpus is the check.
- `test-toyvm-live` and `test-toyvm-browser-bundle` PASS.

### One bug this found, which was not in this change

`--handler-hist` indexes two tables by handler number and `isa.HIST_SLOTS` was
1024. The table passed 1024 when the flagless variants took it to 1148, and
nothing said so: the overrun only faults on a program that actually executes a
high-numbered handler, so the census kept working and kept being quoted. Adding
the traced twins took it to 1356 and it crashed with `memory access out of
bounds` on the first program tried. `HIST_SLOTS` is 2048 now, and `emit.js`
asserts the relationship at table-build time so the next growth fails the build
instead of the census.

## What came next

The `_t` twins are what let a *traced* branch also be a spin loop: the loop is
the taken edge, and tracing only changed what happens on the other one. See
[toyvm-spin-loops.md](toyvm-spin-loops.md), which does to the arena's most
frequently dispatched op what this page does to its edges.

## What is next

The unconditional `jmp` is the obvious remaining transfer and it is **not**
available on the same terms. Tracing through a `jmp` means removing its
dispatch, not just its transfer, and that changes `$steps` — every slice would
end at a different instruction, every interrupt would land somewhere else, and
the corpus diff would stop being a check at exactly the moment it was needed.
Fusion solved that by charging the removed step inline, but there is no handler
left to charge it in when the whole op goes away. It needs a different answer
before it is worth attempting.

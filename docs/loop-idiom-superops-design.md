# Loop Idiom Superinstructions

ASCII TLDR:

```text
Heroes II's ICN sprite blitter is ~12.4% of all handler dispatches, and the
plain row copy inside it is ALREADY one op (`rep movsd` -> memory.copy in
05b-string-ops.wat). What is left is not copying:

  0x004c7341  5.03%  RLE control-byte fetch through a cursor kept in MEMORY
  0x004c755d  2.29%  dst[i] = table[src[i]]   <- 9 dispatches per pixel

Two ways to collapse loops like the second one, both matching on SHAPE rather
than on the byte signatures $match_storm_bitreader-style matchers use:

  A  idiom lowering   match the emitted threaded ops against a small library
                      (COPY/FILL/LUT/SCAN run), rewrite the block to one op.
                      Register-parameterized, so it fires on any app's blitter.
                      ~9 dispatches/pixel -> ~1 dispatch/run.

  B  self-loop wrap   any block whose Jcc targets its own entry gets driven by
                      a wrapper handler. Needs no library at all, but keeps one
                      call_indirect per op per iteration, which is the expensive
                      half. Some tens of percent on the blocks it wraps, not
                      90% -- see 4.2, and note the figure there is reasoned,
                      not measured.

Neither touches 0x004c7341. That one wants a third, unrelated change:
promoting a load-modify-store of a fixed global into a block-local.

Nothing here is measured yet. Per interpreter-dispatch-perf.md, an op-count
delta is a proof of EQUAL WORK, not a proof of SPEED -- every phase below
lands with both an op count and a time measurement or it does not land.
```

Companion docs: [interpreter-dispatch-perf.md](interpreter-dispatch-perf.md)
(why "fewer dispatches" is the only lever, and why it is not automatically a
win), [wasm-stack-threaded-code.md](wasm-stack-threaded-code.md),
[aoe-performance-optimization.md](aoe-performance-optimization.md).

## 1. Where the cost actually is

Measured with `--handler-hist` over the Heroes II gameplay window (batches
1400..2600), at `76e47bc3`, 37,433,195 handler ops total. The fused-op rounds
so far took that window from 44,574,078 (`4e967192`) to 38,760,852
(`48bdfdbe`, -13.0%) to its current value (-16.0% cumulative).

The per-handler histogram is flat -- top entry `$th_load32_ro_base_ebp` at
8.29%, then a long tail around 1.5-2%. The per-*block* histogram is not:

| block | share | what it is |
|---|---|---|
| `0x004c7341` | 5.03% | RLE control-byte fetch + dispatch |
| `0x004c735b` | 2.65% | control-byte classification |
| `0x004c7651` | 2.44% | run setup (computes dst, falls into the copy) |
| `0x004c755d` | 2.29% | per-pixel LUT translate |

Four blocks of one function, 12.4% of every dispatch in the profile.

### 1.1 The bulk copy is already one op

```
004c7700  8b ca              mov ecx, edx
004c7702  c1 e9 02           shr ecx, 0x2
004c7705  f3 a5              rep movsd        <- memory.copy
004c7707  8b ca              mov ecx, edx
004c7709  83 e1 03           and ecx, 0x3
004c770c  f3 a4              rep movsb        <- memory.copy
```

`src/05b-string-ops.wat` lowers both to `memory.copy` after translating each
range endpoint through `g2w`. This is why the copy blocks are absent from the
table above, and why "make copying a row one super op" is a question that has
already been answered for the easy case.

### 1.2 The control-byte fetch (0x004c7341)

```
004c7341  33 c0              xor eax, eax
004c7343  8b 0d 80 5d 52 00  mov ecx, [0x525d80]     <- cursor lives in memory
004c7349  41                 inc ecx
004c734a  89 0d 80 5d 52 00  mov [0x525d80], ecx     <- ...and is stored back
004c7350  8a 41 ff           mov al, [ecx-0x1]
004c7353  84 c0              test al, al
004c7355  0f 8d f6 02 00 00  jge 0x4c7651
```

Seven dispatches to consume one RLE command byte, four of them pure cursor
bookkeeping through a fixed address. Not a loop, not an idiom -- see section 5.

### 1.3 The per-pixel LUT translate (0x004c755d)

```
004c755d  33 c0              xor eax, eax           -.  zero-extend
004c755f  46                 inc esi                 |  induction
004c7560  8a 46 ff           mov al, [esi-0x1]       |  LOAD8  src
004c7563  89 35 94 5d 52 00  mov [0x525d94], esi    -+- spill cursor to global
004c7569  4a                 dec edx                 |  counter
004c756a  89 0d 88 5d 52 00  mov [0x525d88], ecx    -+- spill table base
004c7570  8a 04 08           mov al, [eax+ecx]       |  LUT lookup
004c7573  88 46 ff           mov [esi-0x1], al       |  STORE8 dst
004c7576  75 e5              jnz short 0x4c755d     -'  back-edge
```

`dst[i] = table[src[i]]` for `edx` bytes -- the shadow/alpha remap run. Nine
dispatches per pixel. This is the shape both designs below are aimed at, and
it is not specific to this game: Caesar III and Diablo remap sprite runs
through a table the same way.

## 2. The seam

```
 guest bytes            decoder                thread cache            inner interpreter
+-----------+  $d_fetch8  +----------+ $te(fn,op)  +-------------+  $next  +----------+
| 8a 41 ff  | ----------> | decode_  | ----------> | fn0 op0     | ------> | handlers |
| 84 c0     | <- lookahead|  block   |             | fn1 op1     | 8 bytes |  table   |
| 0f 8d ..  |  ($d_pc+n)  +----------+             | fn2 op2 ... | per op  |  [410]   |
+-----------+       ^                              +-------------+         +----------+
                    |                               ^           ^
     current fusions match HERE                     |           |
     (raw bytes, before emit)              A rewrites HERE    B wraps HERE
```

Relevant existing machinery:

- `$decode_block` captures `$tstart` (`src/07-decoder.wat:1422`) and calls
  `$cache_store(start_eip, $tstart)` at the end.
- `$te(fn, op)` appends 8-byte pairs at `$thread_alloc` (`src/04-cache.wat:102`).
  The emitted block is therefore a plain array in linear memory, readable and
  rewritable up until `$cache_store`.
- `$next` (`src/04-cache.wat:126`) decrements `$steps`, loads `(fn, op)`,
  bounds-checks `fn` against 410, optionally records the histogram, then
  `call_indirect`.
- Blocks are keyed by entry EIP, so a branch into the middle of a folded
  region decodes as its own block and runs the ordinary per-op path. Every
  fusion in the tree already relies on this.

## 3. Design A -- idiom lowering

### 3.1 Match on emitted ops, not on raw bytes

Every fusion we have matches raw bytes ahead of `$d_pc`. That surface is
hostile to generality: `mov al,[esi]` has one encoding, `mov al,[esi+0]`,
`mov al,[esi+ebx*1]` and the `movzx` forms have others, and each must be
spelled out by hand. The threaded stream is the canonical form -- one handler
id per semantic operation, addressing mode already resolved.

```
 $tstart                                            $thread_alloc
    |                                                     |
    v                                                     v
    +----+----+----+----+----+----+----+----+----+--------+   before
    | 29 | 41 |344 |312 |149 | 29 | 60 | 55 |jcc | f/t    |
    +----+----+----+----+----+----+----+----+----+--------+
           match against shape library --> LUT_RUN(src=esi, dst=esi-1,
                                                   tbl=ecx, cnt=edx)
    +----------+----------+                                   after
    | 4xx      | packed   |   $thread_alloc rewound to $tstart+16
    | th_lut_  | operands |   $cache_store(start_eip, $tstart) unchanged
    |  run     |          |
    +----------+----------+
```

The rewrite is a pointer rewind plus one `$te`, done between the last
instruction of the block and `$cache_store`.

### 3.2 The shape library

Patterns are written against a tiny abstract form -- `LOAD8 r <- [b+i]`,
`STORE8 [b+i] <- r`, `ADD r,imm`, `DEC r`, `JNZ back` -- with registers as
variables rather than literals:

```
 pattern      recognized shape                            lowering
 ---------------------------------------------------------------------------
 COPY_RUN     dst[i] = src[i];       i++; --n; jnz ^      memory.copy
 FILL_RUN     dst[i] = k;            i++; --n; jnz ^      memory.fill
 LUT_RUN      dst[i] = tbl[src[i]];  i++; --n; jnz ^      tight WAT byte loop
 SCAN_RUN     while (*p++ != k) ;                         tight WAT byte loop
```

There is deliberately no scalar blend pattern -- see 3.2.1.

`COPY_RUN`/`FILL_RUN` reuse the `g2w`-per-endpoint translation already written
for the REP path. `LUT_RUN` and `SCAN_RUN` need their own loops but stay inside
one handler invocation.

**The lowering column is a refinement, not the win.** The win is that the loop
becomes *one* thread-stream op instead of N per element, so the whole dispatch
cost -- `$next` preamble, `call_indirect`, back edge, `$run` round trip -- is
gone whatever the handler body then does. A plain byte-at-a-time WAT loop
already captures roughly an order of magnitude on a 9-dispatches-per-pixel
blitter; `memory.copy`, `memory.fill` and SWAR scanning are second-order polish
on top of that.

Two consequences, both simplifying:

* Implement each pattern with the dumbest correct scalar loop first, measure,
  and only then reach for a bulk op. `LUT_RUN` -- the one that actually hits
  Heroes II's hot block -- has no bulk-op form at all, and does not need one.
* Guards that exist purely to *legalize* a bulk op can relax. A scalar loop
  does not need the run to be contiguous, unit-stride, non-overlapping or
  within one `g2w` page; it only needs the addresses it actually touches to be
  translated. So a matched-but-unlowerable-to-`memory.copy` run is still worth
  matching, and the unit-stride column in 9.4 is a floor on reach, not a gate.

### 3.2.1 Why there is no blend pattern

Alpha/additive blending is the obvious fifth idiom, and the census killed it
twice over.

**In the 8bpp era, blending IS a table lookup.** A palettized surface cannot
average two colours arithmetically, so shadows and translucency go through
`dst = shadow_tbl[dst]` or `dst = trans_tbl[src<<8 | dst]`. `LUT_RUN` is
therefore already the blend superinstruction for Heroes II, Caesar III, Diablo
and StarCraft -- `0x004c755d` in section 1.3 *is* Heroes II's shadow blit.
A scan for arithmetic blends (channel mask + shift + or/add over two loads)
found 16 loops in VirtualDub, 3 in Caesar III, 1 in ScummVM, and **zero** in
Heroes II, Cave Story, Blobby, Doukutsu or qbob.

**In the 16/32bpp era, blending is MMX, and MMX is a different project.**
`tools/scan-simd.js` over the corpus:

| binary | SIMD instrs | breakdown | CPUID sites | confidence |
|---|---|---|---|---|
| VirtualDub | 10919 | mmx 8126, sse2 2213, sse 566 | 5 | HIGH |
| ScummVM | 9273 | mmx 9190, 3dnow 54, sse 29 | 5 | HIGH |
| in_mod.dll (Winamp) | 295 | mmx 294 | 3 | HIGH |
| msvbvm60.dll | 255 | mmx 215, sse2 29 | 0 | medium |
| everything else in a 60-binary sweep | <20 each | scattered | 0 | low (noise) |

`movq`/`movd`/`punpcklbw`/`paddw`/`psubusb`/`pmaddwd` at the top of both big
lists is exactly a blend and mix inner loop. So the two binaries with real
scalar blend arithmetic are the same two that do the bulk of it in MMX, and
every game in the Win98 corpus has none at all. A scalar `BLEND_RUN` would be
built for a population of about twenty loops.

**One consequence for whoever lands MMX:** `$th_cpuid`
(`src/05-alu.wat:2225`) currently reports family 4 model 8 (486DX) with
`EDX = 1`, the FPU bit alone -- no MMX bit 23, no CMOV, no SSE. Both HIGH
binaries CPUID-check (5 sites each), so today they take their scalar fallback
paths and the MMX in them never executes. MMX handlers are inert until CPUID
advertises the bit, and the moment it does, ScummVM's and VirtualDub's pixel
loops move off the scalar path this document is about.

### 3.3 Tolerating loop noise

A matcher that demands exactly the pattern ops will match almost nothing real.
`0x004c755d` carries two stores of loop cursors into fixed globals. They are
hoistable -- write them once, at their exit values, when the super-op returns --
if the block satisfies all of:

- no load from either address anywhere in the block,
- no call op and no branch op other than the terminating back-edge,
- the stored value is the induction variable or a loop-invariant register.

All three are decidable on the op array. If any fails, decline and emit the
ordinary stream.

The same "noise" allowance covers the `xor eax,eax` zero-extend, dead flag
producers, and register moves that are copies of a matched variable.

### 3.4 Runtime guard

Decode-time matching proves shape, never values. The emitted op carries
register indices; the handler re-verifies before taking the fast path:

```
 $th_lut_run:
   n   = reg[cnt]
   src = reg[srcb]   dst = reg[dstb]   tbl = reg[tblb]
                                          +-------------------------------+
   - n == 0, or n > SANE_MAX?  ---------->| any check fails:              |
   - [src, src+n) inside guest bounds? -->|   leave $eip at block start,  |
   - [dst, dst+n) inside guest bounds? -->|   fall through to the ordinary|
   - tbl page resident?  ---------------->|   per-op path for this loop   |
                                          +-------------------------------+
   fast path:
     WAT loop over n bytes
     publish registers at their exit values
     publish lazy flags for `dec cnt -> 0` (flag_op/flag_res/flag_sign_shift)
     $invalidate_code_write at both endpoints of the written range
     charge $steps (see 4.3)
```

Bailing out is what makes it safe to be wrong: a mismatch costs a branch, not
a corruption. Note the lazy-flag obligation -- the block is entered again on
fall-through, and the code after the loop reads ZF from the `dec`.

### 3.5 Precedent in the tree

- `$sbh_match_mode` (`src/10-helpers.wat:243`) already recognizes the MSVC
  small-block-heap scan loop and returns mode 1 or 2 for the two possible
  esi/edi assignments -- a matcher parameterized on one axis by hand. Design A
  is the same idea with the parameters read out of the op instead of
  enumerated.
- `$stack_packet_addr` / `$stack_packet_variant` is a decoder specialization
  *armed at runtime*; its comment records that it "used to test two literal
  EIPs from one particular build of one particular game, in the decoder every
  app runs." If some pattern turns out to need an address hint, that is the
  shape the hint should take -- armed, not compiled in.

### 3.6 Expected effect

`0x004c755d`: 9 dispatches per pixel becomes 1 per run. At 2.29% of the
profile and runs averaging more than a few pixels, that block effectively
disappears. `COPY_RUN` will mostly find loops that are already `rep movs`
elsewhere, so its value is in other apps, not here.

## 4. Design B -- self-loop wrapping

### 4.1 What it does

Purely structural, no library: if a block's terminating Jcc targets the block's
own entry, prepend a wrapper op that drives the body.

```
   before (per iteration)                     after
   ----------------------------               ------------------------------
   $next -> h(op) -> return_call $next         $th_selfloop:
   $next -> h(op) -> return_call $next           loop:
   $next -> h(op) -> return_call $next             ip = body_start
      :   (9 times)                                for k in 0..body_len:
   $next -> th_jcc                                   call_indirect body[k]
      | eip = block start                          if !eval_cc(cc): break
      v                                            if --steps <= 0: break
   run loop: cache_lookup(eip) --+               publish eip, return
      +----- back to $next <-----+
```

### 4.2 What it saves, and what it does not

```
 per body op:              $next overhead                 removed by B?  by A?
 ------------------------------------------------------------------------------
 steps decrement + test                                        yes        yes
 load fn, load op, ip += 8                                     yes        yes
 corruption bound check (fn >= 410)                            yes        yes
 histogram branch                                              yes        yes
 call_indirect (the mispredicted one)                          NO         yes
 handler body work                                             NO      folded

 per iteration:
 th_jcc: two read_thread_word + eval_cc + eip write            yes        yes
 run-loop cache_lookup(eip) on the back-edge                   yes        yes
```

B keeps one indirect call per op per iteration, and per
`interpreter-dispatch-perf.md` that mispredicted target is the expensive half
of a dispatch -- two independent attempts to make dispatch itself cheaper
measured exactly zero. So B cannot approach the near-elimination A gets where
it matches.

How much it *does* get is worth accounting honestly, because the two columns
above are not the whole story. Per iteration of an N-op body, B removes N
copies of the `$next` preamble (all cheap, predictable, non-branching work)
**plus one** trip through the back edge: `$th_jcc`'s two `$read_thread_word`
calls and `$eip` write, the return all the way out to `$run` -- jcc handlers
do **not** tail-call `$next`, they return (`src/05-alu.wat:704`, `:740`,
`:747`) -- the `$run` preamble (`blocks--`, eip==0, thread-arena headroom,
`$yield_flag`, `$dbg_any`) and a `$cache_lookup`. That back-edge round trip is
the single largest item B removes, and it is amortized over N, so B's payoff
falls as the body grows and is largest on the tightest loops.

An earlier draft of this section put a **20-30%** number here. It is removed
rather than replaced: it was a guess, and swapping in a different guess buys
nothing. Per the rule in section 1, B lands with a measurement or it does not
land. The prediction to test is the shape, not the constant -- speedup should
scale roughly as `(back-edge cost + N x preamble) / (N x call_indirect +
back-edge cost)`, i.e. big on 2-4 op loops and small on 12-op ones.

Against that: B needs no shape library, cannot be wrong about semantics (it
runs the same ops in the same order), and fires on every hand-rolled loop in
every app, including ones no idiom describes.

### 4.3 Preemption -- applies to both

`$next` decrements `$steps` and returns at zero; that is how a batch ends and
the host gets the thread back. Any loop living inside a handler must charge
`$steps` or it overruns the batch. The existing bulk path does not:
`src/05b-string-ops.wat` never touches `$steps`, so a 64KB `rep movsd` costs
one step. That is tolerable for a bounded string op. For B's unbounded
self-loop it is not -- B must decrement per iteration and break out cleanly,
republishing `$eip` at the loop entry. A should cap `n` per invocation and
re-enter rather than run a multi-megabyte run inside one step.

### 4.4 Reentrancy and SMC

A body op that can re-enter the emulator (a call, an API thunk, a yield) must
disqualify the block from wrapping -- the wrapper holds `ip` in a local across
iterations, and a nested decode can flush the thread arena underneath it.
`$decode_block` deliberately takes deferred flushes only between blocks for the
same reason. Restrict B to bodies of simple ALU/load/store/lea ops, which is
also what makes the `$steps` accounting exact.

A writing loop must call `$invalidate_code_write` on the destination range, as
the REP path does at both endpoints.

## 5. Not covered: 0x004c7341

Neither design applies -- straight-line, no back-edge, no idiom. Its waste is
that the RLE cursor lives at a fixed address (`0x525d80`) and is
load-inc-store'd every command byte. The optimization it wants is global
promotion: within one block, a fixed address that is loaded, modified and
stored, with no intervening call and no other alias, can live in a local and
be written back once at block exit. That is a third, independent piece of work
with its own aliasing proof obligations; priced separately, and worth pricing,
since it is 5.03% by itself.

## 6. Phasing

| phase | content | effort | gate |
|---|---|---|---|
| A0 | op-array walker + shape matcher scaffolding, no patterns | 1d | build green, zero behaviour change, op count identical |
| A1 | `LUT_RUN` + runtime guard | 1-2d | H2 gameplay op count down, `png-diff` 0 pixels, wall time down |
| A2 | `COPY_RUN`, `FILL_RUN` | 1d | Caesar III + Diablo op counts, no pixel diffs |
| A3 | `SCAN_RUN` | 1d | CRT-heavy app (notepad/wordpad) op count |
| B0 | self-loop detection reusing A0's walker | 0.5d | detection log only, no emit |
| B1 | `$th_selfloop` wrapper, restricted op set | 1d | op count down, wall time down, `$steps` accounting exact |

A0 is shared: B's precondition (block ends in a Jcc to its own entry) is the
same structural test A's matcher needs, so building A first makes B mostly
free.

### 6.1 A0 is smaller than it looks: record op starts, don't declare them

Walking the emitted stream needs op boundaries, and the stream is not
self-describing: a thread word is `[handler_idx, operand]` = 8 bytes, but some
handlers pull extra words with `$read_thread_word` (`src/04-cache.wat:192`),
and how many is written only in each handler's own body.

The obvious fix -- a generated 410-entry `op -> word count` table with a build
gate -- is the wrong one. It *declares* what handlers eat, and a declaration
can rot: add a `$read_thread_word` to a handler and the table is silently a
lie, with a mis-walk rather than a build failure as the symptom.

Instead, **record what the decoder actually did**, which it already knows:

* `$te` (`src/04-cache.wat:143`) is the single choke point for op headers, and
  `$te_raw` (`:161`) the single one for extra words. The decoder has 376 `$te`
  and 252 `$te_raw` call sites and every one goes through those two functions.
* So: reset a counter in `$decode_block` beside its existing
  `(local.set $tstart (global.get $thread_alloc))`, and append the current
  `$thread_alloc` to a scratch array inside `$te`. `$te_raw` is untouched --
  extra words are by definition not op starts.

That is correct by construction, needs no generated table and no build gate,
and costs one store plus an increment per emitted op. Two things make it safe,
both already true of the tree:

1. `$thread_alloc` never rewinds during decode --
   `global.set $thread_alloc` does not appear in `src/07-decoder.wat` at all.
   Existing fusions decide by lookahead before emitting, never by rewriting
   after, so the index is append-only. (A's own rewind-to-`$tstart` resets the
   counter to zero on the same line.) Any future peephole pass that rewinds
   `$thread_alloc` must rewind the index with it.
2. Nothing needs the index at runtime. A's match and emit, and B's back-edge
   detection, all happen inside `$decode_block`; `$next` never walks the
   stream, it executes it. So the index is scratch, reused by every block, and
   costs no per-block memory.

The scratch array is capped; a block that overflows it sets a poison flag and
is simply not matched. Degrading to "no lowering" is always safe, and blocks
that large are not loop idioms.

Recommended order: A0, A1, measure, then decide whether A2/A3 or B1 comes
next based on what A1's numbers actually say.

## 7. How each phase is measured

- **Op count** -- `test/run.js --handler-hist --handler-hist-thread/-start/-stop`
  over the Heroes II gameplay window (batches 1400..2600). Deterministic and
  load-independent; this is the proof of equal work, not of speed. Read the
  totals with the per-handler slot count (`get_handler_hist_slots`), not the
  pair-matrix side.
- **Pixel identity** -- `test/test-heroes2-gameplay.js` plus
  `tools/png-diff.js`; a fusion that changes a pixel is a bug, not a
  tradeoff.
- **Wall time** -- interleaved minima on a quiet box only, per the noise
  discipline in `interpreter-dispatch-perf.md`. Never from headless Chrome.
- **Generality** -- every pattern must fire on at least two unrelated apps
  before it lands, or it is a signature matcher wearing a library's clothes.

## 8. Risk register

| risk | mitigation |
|---|---|
| Guard passes but semantics differ (aliasing src/dst, overlapping runs) | `memory.copy` is memmove-correct; LUT loop must read src before writing dst per byte, and decline when ranges overlap in the wrong direction |
| Hoisted spill observed by something outside the block | Require no load of that address in-block; conservative decline otherwise |
| Lazy flags left inconsistent for fall-through code | Publish the exact `dec -> 0` flag state; covered by the existing fused-op convention |
| Matcher accepts a prefixed/16-bit form | Decline on `$code16`, `$d_addr16`, `prefix_66`, as every existing fusion does |
| Thread arena flush during a wrapped loop | Restrict B's body op set; no calls, thunks or yields |
| Op count falls, wall time rises (the AoE outcome) | Both numbers required at every gate |

## 9. Corpus census

`tools/find-loops.js` sweeps each code section, finds short backward branches
that land on an instruction boundary in the same sweep, and reports every loop
body's family plus a normalized skeleton (mnemonics + operand shapes, so the
same loop over different registers collapses to one string):

```
node tools/find-loops.js <pe> [--min-body=3] [--max-body=20]
                              [--family=lut,blend] [--skeletons=30] [--json]
```

It is a linear sweep, so data embedded in code misdecodes. A skeleton seen once
is a lead; one seen in several binaries is signal. It says nothing about how
*hot* a loop is -- pair it with `--handler-hist` for that.

Run over the corpus (body 3..20 instructions), 2026-08-23:

| set | binaries | loops | notable families |
|---|---|---|---|
| games A (Heroes II, Caesar III, Diablo x2, StarCraft, TA, Worms 2) | 7 | 8114 | lut 610, copy 760, fill 674, scan 1105, load2-store 1068 |
| games B (ScummVM, Claw, Fallout, Liquid War x2, Blobby, TetriNet, GeneRally, Jardinains, Cave Story, SDL, dxball) | 13 | 12305 | lut 734, copy 830, fill 699, scan 1457 |
| Windows apps (notepad, calc, mspaint, winamp, pinball, WEP, explorer98, NT/XP) | 14 | 1640 | scan 348, fill 147, copy 97 |
| DLLs + utilities (CRT/system DLLs, PuTTY, VirtualDub, 7-Zip, screensavers, plugins) | ~35 | large | see recurring skeletons below |

Per-binary highlights: ScummVM 4045, VirtualDub 3703, StarCraft 1763, TA demo
1585, Diablo shareware 1536, Fallout demo 1534, Claw 1284, Heroes II 1050,
Caesar III 762, Winamp 486.

### 9.1 What recurs across binaries

| shape | evidence |
|---|---|
| `mov r,m; add r,i; test r,r; jnz` (sentinel scan) | 305 instances across 6 DLLs -- the CRT `strlen`/`wcschr` core |
| `mov r,m; mov m,r; inc r; dec r; jnz` (byte/dword copy) | 36 across 5 DLLs; 19 across 3 games |
| `mov m,i; add r,i; dec r; jnz` and `mov m,r; inc r; dec r; jnz` (fill) | 11 across 2 games, 10 across 2 Windows apps (Watcom *and* Borland layouts), 15 across 5 games, 14 across 5 DLLs |
| `shr r,i; rcl r,i; shr r,i; rcl r,i; or r,r; jnz` (bit reservoir) | 19 instances across 8 binaries -- 7z.dll/7z.exe, cabinet.dll, imagehlp.dll, asycfilt.dll, d3dxof.dll, olepro32.dll, putty.exe |
| `stosb; inc r; loop` | 14 across 2 (Diablo demo + shareware) |
| arithmetic blend (mask + shift + or/add over two loads) | VirtualDub 16, Caesar III 3, ScummVM 1, **zero** in Heroes II, Cave Story, Blobby, Doukutsu, qbob -- and the two with any do their real blending in MMX, see 3.2.1 |

The bit-reservoir line is worth dwelling on. We already special-case two
decompression inner loops by exact byte signature
(`$match_storm_bitreader`, `$match_smack_huff_walk`). The census says that
*shape* recurs in eight unrelated binaries, which is the argument for
generalizing it into the library rather than adding a third signature.

### 9.2 The negative result that shapes the design

In the games-A set, only 5 exact skeleton strings recurred across 2+ binaries
out of 8114 loops. Exact skeletons are essentially binary-specific: compilers
schedule the same semantics differently, spill different registers, and unroll
by different factors.

That is a direct argument against a skeleton-string matcher and for the
abstract-form matcher in section 3.2: match on *roles* (induction variable,
counter, load, store, back-edge) with the noise allowance of section 3.3, and
treat the skeleton strings only as a discovery tool. A library keyed on exact
skeletons would be `$match_storm_bitreader` again, once per binary.

### 9.3 Revised priority

1. `FILL_RUN` and `COPY_RUN` -- broadest cross-binary and cross-compiler
   evidence, simplest guards, both lower to a single bulk memory op.
2. `LUT_RUN` -- the one that matters for this profile (Heroes II 153 loops,
   Caesar III 181, games-A total 610), and the 8bpp blend path.
3. `SCAN_RUN` -- 305 instances in six DLLs, so it pays across every app that
   links the CRT rather than in one game.
4. Bit-reservoir -- generalize the two existing signature matchers, evidence
   in eight binaries.
5. ~~`BLEND_RUN`~~ -- dropped. 8bpp blending is `LUT_RUN`; 16/32bpp blending is
   MMX in the only two binaries that have any, and belongs to the SIMD work,
   not here. See 3.2.1.

Counts above are static, not dynamic. A shape with 305 static sites and a cold
profile is worth less than one with 4 sites in the hot blitter. Every phase in
section 6 still gates on `--handler-hist` over a real run.

### 9.4 Running the real matcher: how much do we actually match?

Section 9's counts come from `tools/find-loops.js`, whose family guess is a
loose regex -- "two loads and a store" reads as `lut`, which is how Heroes II
scored 187 of them. That is a candidate finder, not the matcher. So the
matcher itself was implemented statically, in `tools/match-loops.js`: the same
roles, the same summary (induction variables, streams, side effects) and the
same four predicates described in section 3, run over the bodies
`find-loops.js` returns. A match there means the predicate held.

The fidelity gap runs in our favour. The real matcher sees *emitted threaded
ops*, which are strictly more canonical than disassembly -- ModRM and SIB are
already resolved, and one handler covers every register pair. So these numbers
are a lower bound on the WAT matcher's reach, not an upper one.

```
app                        loops   COPY   FILL    LUT   SCAN  matched  unit-stride
winamp.exe                   548     27     15      0     10       52   9.5%      37
H2DEMOW (Heroes II)         1215      4      5      5      1       15   1.2%      15
Doukutsu (Cave Story)        416      2      5      0      2        9   2.2%       9
pinball.exe                  287      4      2      1      2        9   3.1%       7
GeneRally.exe                566      2      4      0      2        8   1.4%       8
DIABDEMO.EXE                1295      3      3      0      1        7   0.5%       7
volley.exe (Blobby)          973      0      5      0      1        6   0.6%       6
caesar3.exe                  124      1      5      0      0        6   4.8%       5
notepad.exe                   37      1      0      0      0        1   2.7%       1
mspaint.exe                  258      0      0      0      0        0   0.0%       0
TOTAL                       5719     44     44      6     19      113   2.0%      95
```

**2.0% of static self-loops.** That number should not be read as a verdict on
Design A, for two reasons.

First, the denominator is wrong. `call` (2299) and `multi-branch` (1029) are
59% of all declines, and neither is a matcher weakness: a loop that calls out
or has a second exit is not lowerable to a bulk memory op by any predicate.
Excluding them leaves 2391 in-scope loops and a 4.7% match rate.

Those 3328 loops are **not** Design B's constituency, though an earlier draft
of this section said they were. B as scoped in section 4 is a *same-block*
self-loop wrapper, and a `call` or a second conditional branch ends a block in
our decoder -- so those 3328 are exactly the loops B cannot wrap either. B's
real constituency is the complement: single-block self-loops, which is
`5719 - 2299 (call) - 1029 (multi-branch) - 83 (ret)` = **2308 loops, 40% of
the corpus**. That is still an order of magnitude more sites than A's 113, and
it includes all 113 of them, so the argument for shipping both stands -- it is
just a smaller and more precise claim than the one it replaces. Reaching the
other 3328 needs a multi-block loop wrapper, which is a different design than
either A or B.

Second, and more important, **match rate is not the metric -- hot-block
coverage is.** Heroes II's four hot blocks are 12.4% of the profile. The
matcher takes `0x004c755d` (2.29%), the LUT blitter, and register-generically
also takes its `esi`/`edi`/`eax`/`ebx` twins at `0x004c6c10`, `0x004c6cd2` and
`0x004c762a` -- one predicate, four sites, no per-variant work. The other
three hot blocks, `0x004c7341` at 5.03% among them, decline as
`multi-branch`: they are the multi-exit control-byte decoders of section 5. So
A buys about 2.3 points of that 12.4. The remaining ten do **not** fall to B
either, for the reason above -- multi-exit means multi-block. They are the
case for a third change, and section 5's local-promotion idea is the current
best guess at what it should be.

### 9.5 Two rules the tool forced out

`match-loops.js` first scored 0.8% and rejected the very loop the design was
written for. Reading its decline histogram produced two rules that are now
part of the design, and would otherwise have been discovered late, in WAT:

- **`xor r,r` is a zeroing MOVE, not arithmetic.** 111 declines in Heroes II
  alone. Every compiler emits it ahead of a byte load into the low half.
- **Mirror stores.** `mov [0x525d94], esi` writes an induction variable to a
  fixed address that nothing in the body reads back. That is a register spill
  or a global the code outside the loop reads afterwards -- not a stream. A
  lowering writes the final value once in the epilogue. Real blitters are full
  of them, and treating them as streams rejects the loop.

A third rule is structural rather than empirical: a LUT's *table* load is
addressed by another load's result, so it must be exempt from the stream
requirement by construction. With those three, `0x004c755d` matches:

```
  xor eax, eax          MOVE  eax = 0            <- rule 1
  inc esi               ADDI  iv esi +1
  mov al, [esi-0x1]     LOAD  stream(esi, +1)
  mov [0x525d94], esi   STORE mirror             <- rule 2
  dec edx               ADDI  iv edx -1  (counter)
  mov [0x525d88], ecx   STORE mirror             <- rule 2
  mov al, [eax+ecx]     LOAD  table, fed by load 1, stream-exempt
  mov [esi-0x1], al     STORE stream(esi, +1)
  jnz short 0x4c755d    BRANCH
                        => LUT_RUN size=1 stride=1
```

What is left in the decline histogram after those: `lea` 338, `add r,r` 317,
`shl` 240. Those are genuine arithmetic bodies and are correctly declined --
they are neither copies nor translations, and no amount of matcher generality
turns them into one.

## 10. A0/A1 as built, and what the first measurement says

A0 and A1 are in the tree: `src/07b-loop-match.wat`, the op-start index in
`$te` (6.1), and handler 410 `$th_lut_run`. The switches are
`--trace-loopmatch[=0xEIP]` (dump the ops the matcher sees),
`--loopmatch-stats` (self-loop and match counts at exit) and
`--no-loop-superops` (match and count, but emit the original ops -- the A/B
partner, so both sides of a comparison are the same binary).

### 10.1 The number

Heroes II, gameplay window (`--app=heroes2_demo --batch-size=20000
--max-batches=2600`, three clicks to get into a map):

| | superop off | superop on |
|---|---|---|
| handler dispatches | 71,528,708 | 69,598,446 |
| entries to `0x4c755d` (`--count`) | 229,515 | 62,544 |
| final frame | -- | pixel-identical (`png-diff`: 0 of 307200) |

So the lowering removes **2.70% of all handler dispatches** and 166,971 of the
run's block round trips.

Two things in that table are worth more than the headline.

The first is the entry count. Off, every entry to the block is one iteration of
the loop, so 229,515 entries = 229,515 iterations. On, an entry runs the loop
to completion, so 62,544 entries = 62,544 *calls* -- an average run length of
**3.7 bytes**. The design assumed long runs; this loop is called constantly and
does almost nothing each time. That is why 4.2's "back-edge cost + N x
preamble" accounting matters so much more than the per-element lowering (3.2):
at N = 3.7 the per-element work is the small half of the bill, and essentially
all of the win here is the round trip that no longer happens.

The second is that the win is 2.7% of the *whole run*, which is what this loop
is worth in Heroes II. Nothing about the mechanism is at fault -- it does what
it claims, exactly, and for free at runtime. The pattern is just not where most
of the time goes.

### 10.2 The generality gate is not met

The rule in this document is that a pattern must fire on at least two unrelated
apps before it lands. LUT_RUN currently fires on one. Startup-and-menu windows
(800 batches) of six other graphics-heavy apps produce self-loop blocks and
zero matches:

| app | self-loop blocks | LUT_RUN matches |
|---|---|---|
| starcraft_shareware | 59 | 0 |
| captain_claw_demo | 74 | 0 |
| worms2_demo | 21 | 0 |
| diablo_demo | 16 | 0 |
| caesar3_demo | 9 | 0 |
| fallout_demo | 4 | 0 |
| sol | 6 | 0 |

These are weak negatives -- Heroes II only produces its blitter during
gameplay, and none of these runs reach gameplay. But dumping the blocks that
*are* produced shows the near-misses are not near: StarCraft's SIB-byte-load
self-loops at `0x40b984` and `0x40b7f1` are bit-unpack loops with an `idiv` in
the body, and Claw's `0x4cb624` is a two-stream byte compare. They decline for
the right reason, not for a missing role.

The honest reading is that LUT_RUN as specified is close to Heroes-II-specific,
and the next move is not to generalize the LUT predicate. It is either to go
after the shapes that actually recur (9.1), or to accept 9.4's arithmetic and
build B, whose constituency is 2308 loops rather than 113.

### 10.3 Liquid War: the strongest negative so far

Liquid War 5 (`lwwin.exe`) is a useful check because its profile is unusually
concentrated: two bodies own about 65% of startup -- `0x43ac70`, the packfile
byte-at-a-time read loop that unpacks the 4.3MB `lw.dat`, and `0x466848`,
Allegro's `getpixel`, entered once per pixel with two indirect calls inside.
If Design A had anything to offer a real workload, this is the shape of
workload where it would show.

It has nothing to offer here, and not marginally:

* **Static.** `tools/match-loops.js lwwin.exe --why` finds 1284 self-contained
  loops and classifies COPY 12 / FILL 5 / **LUT 0** / SCAN 4. The LUT_RUN
  predicate cannot fire on this binary at all. 21 loops (1.6%) match something,
  none of it what A1 lowers. The declines are led by `call` (589) and
  `multi-branch` (116) -- Design B territory.
* **Dynamic.** Across the main instance and both worker instances the run
  decodes 26 self-loop blocks and matches 0.
* **Neither hot body is a self-loop block.** `tools/disasm_fn.js 0x43ac70`
  shows the packfile loop running `0x43ac86` to a `jl 0x43ac86` at `0x43acb4`
  across roughly five basic blocks, with a `call 0x43af80` refill and two
  conditional exits. Per 9.4 that is not plain Design B either -- a two-exit
  multi-block loop needs the multi-block wrapper. And `0x466848` is a function
  *entry* (the `getpixel` prologue with its clip tests), so the cost there is
  call-per-pixel, which wants inlining, not loop lowering.

This is the same conclusion as 10.2 arrived at from seven weak negatives, but
reached from a strong one: an app whose profile is dominated by two loops, both
of which Design A is structurally unable to see.

**Instrumentation note.** `--loopmatch-stats` originally read the counters off
the main instance only. Every worker thread is a separate WASM instance with
its own decoder and its own counters, so for an app that parks main and does
its work on a worker the report was a guaranteed zero that meant nothing. It
now prints one line per instance (`M`, `T1`, `T2`, ...), and `--trace-loopmatch`
/ `--no-loop-superops` are re-applied to each worker as it spawns.

**Correction to an earlier caveat.** This section first recorded a headless
deadlock for `--app=liquid_war` and treated the dynamic half as boot-path only.
There was no deadlock: the worktree was 16 commits behind main and missing
`b25ca528 Mount Liquid War's data files where the game looks for them`. After
the merge the same command reaches a real DirectDraw frame and decodes 22,126
self-loop blocks on main, still matching **0**. `tools/loopmatch-decode.js
--why` over that run reduces to 35 unique block shapes, 0 matches, and charges
**57.1% of the declines to `op-count<7`** -- the self-loops this app actually
executes are shorter than LUT_RUN's floor. That is the first quantitative
argument *for* COPY/FILL/SCAN predicates on executed blocks, and it is a
different argument from the static one in 10.4.

### 10.4 Correction: LUT_RUN is not Heroes-II-specific

10.2 concluded that LUT_RUN "is close to Heroes-II-specific". That conclusion
was drawn from two things that could not support it: runtime windows that only
ever reached the boot path of each app, and a static sample of two binaries.
Running the real predicate over the whole candidate corpus (52 PEs, 37,978
self-contained loops) says otherwise:

| app | loops | COPY | FILL | LUT | SCAN | matched |
|---|---|---|---|---|---|---|
| jazz2.exe | 1961 | 10 | 24 | **36** | 88 | 158 (8.1%) |
| starcraft.exe | 1932 | 19 | 21 | **17** | 33 | 90 (4.7%) |
| VirtualDub.exe | 4162 | 52 | 39 | **11** | 138 | 240 (5.8%) |
| diablo_s.exe | 1719 | 55 | 69 | **9** | 3 | 136 (7.9%) |
| H2DEMOW.EXE | 1215 | 4 | 5 | **5** | 1 | 15 (1.2%) |
| tademo.exe | 1700 | 75 | 17 | **3** | 4 | 99 (5.8%) |
| Falldemo.exe | 1704 | 4 | 22 | **2** | 2 | 30 (1.8%) |
| scummvm.exe | 4563 | 33 | 80 | **1** | 7 | 121 (2.7%) |
| QBob.exe | 587 | 7 | 8 | **1** | 1 | 17 (2.9%) |
| *corpus total* | 37978 | 413 | 429 | **85** | 532 | 1459 (3.8%) |

Nine binaries have static LUT_RUN matches, and Heroes II is fifth among them.
Jazz Jackrabbit 2 has seven times as many as the app the pattern was designed
against, and they are unmistakably the same shape -- `0x443d83`, `0x463b49`
and friends are palette-remap inner loops, byte load, table index, byte store,
`dec`/`jnz`. StarCraft's sixteen are the same, six of them running backwards
(stride -1).

So the two-unrelated-apps gate is met on static evidence. What is still
missing is the runtime half: a gameplay-reaching run of jazz2 and StarCraft
with `--loopmatch-stats`, to show the matcher fires there and that the blocks
it fires on are hot. Until that run exists this is a stronger lead than 10.2
admitted, not a landed result.

**A1 does not cover all of them.** `$th_lut_run` is byte-in/byte-out. Ten of
the corpus's LUT matches are `size=2` -- a byte index into a 16-bit table with
a 16-bit store (jazz2 has nine, StarCraft one, e.g. `mov cx, [0x5a3280+ecx*2]`
followed by `mov [edx-0x2], cx`). Widening the store side is a small extension
to the handler and the role table, and it is the cheapest way to grow the
constituency.

**This also weakens the case against chasing COPY/FILL/SCAN.** Corpus-wide
those are 413 / 429 / 532 loops, not the 31 a two-app sample suggested. The
other two arguments still stand -- the `rep`-string forms are already single
handlers (`th_rep_movsb` .. `th_rep_scasw`), and hand-rolled byte copies are
usually short alignment fixups where 10.1's block-round-trip win is smallest
-- but "the constituency is tiny" is not one of them.

### 10.5 The block cache was aliasing 1-3-byte-apart blocks (fixed)

Chasing why Liquid War re-decoded one 7-op block 22,054 times in a single
`--trace-loopmatch` log turned up a defect that has nothing to do with loop
idioms and costs far more than any of them would save.

`$cache_slot` (was inline in `$cache_lookup`/`$cache_store`) indexed the
4096-entry direct-mapped block cache with `(ga >> 2) & 0xFFF`. The `>> 2`
throws away the two low address bits, which is right for a machine with 4-byte
instructions and wrong for x86, where a basic block starts on any byte. Any two
blocks 1-3 bytes apart share a slot. In dense code that is exactly the spacing
of adjacent blocks: Liquid War's `0x466874` and `0x466877`, 6.16M entries each
in a 9000-batch run, evicted each other on every single entry.

Three counters were added to make this visible, since nothing reported it:
`get_cache_stores` / `get_cache_evicts` (a decode whose slot already held a
*different* block -- conflict, as opposed to a compulsory first decode),
`get_cache_clears` (full arena-overflow wipes), and `get_cache_invals` /
`get_cache_inval_hits` / `get_cache_inval_page` (self-modifying-code
invalidations, and the last page that actually dropped a block).
`test/run.js` prints all of them in the final-state block, per instance for the
clears.

Indexing on the whole address instead, with the bits above the index width
folded back in (`(ga ^ (ga >> 12)) & MASK`, which also breaks a fixed 16KB
stride), on the same fixed 9000-batch Liquid War run:

| | before | after |
|---|---|---|
| block decodes | 14,379,380 | 26,788 |
| of which evicted a live block | 14,366,238 | 24,183 |
| full cache wipes (main) | 147 | 0 |
| user CPU for the run | 19.49s | 16.72s |

The wipes are a second-order effect of the same bug: a re-decode allocates
fresh arena and never reclaims the old copy, so the thrash filled the 4MB
per-thread arena 147 times, and each overflow throws away every decoded block
in the process. Page invalidations were 0 throughout -- self-modifying code was
never involved, which is what ruled out the first two hypotheses.

The 14% CPU figure is the honest speedup, not 537x: the run is a fixed number
of *blocks*, so it measures overhead removed at constant guest progress, and
this box was at load 36-60 while measuring. In a real-time game the same saving
shows up as more guest work per frame. Verified unchanged: minesweeper-click
(8/8), notepad-editing (10/10), freecell-move (7/7), liquid-war-candidate.

### 10.6 COPY_RUN: the matcher generalizes, the lowering still does not pay

§10.2 asked for a second idiom before believing A1 generalizes. Here it is,
and it settles two separate questions in opposite directions.

**Where it came from.** `tools/loopmatch-sweep.js` drives ten registered apps
under `--trace-loopmatch --loopmatch-stats --handler-hist-thread=0` and reports,
per app, how many self-loop *shapes* actually executed, how many matched, and a
`hot%` -- the share of the top-20 hottest blocks' entries that are self-loop
blocks. That last column is the one that mattered. Match rate separated nothing
(every app but Heroes II matched zero), but `hot%` separated the corpus
sharply: liquid_war 0.0%, worms2 2.5%, pinball 2.7%, **total_annihilation 31.5%**.

TA's hot self-loops, from `--trace-loopmatch`, are all byte-stream transforms:

| block | share of block entries | shape |
|---|---|---|
| 0x497948 | 8.72% | `mov cl,[edx] / inc edx / mov [eax],cl / inc eax / dec [esp+d] / jnz` |
| 0x481ebd | 6.92% | SIB-addressed masked byte write |
| 0x4937e1 | 6.55% | byte sum/reduce |
| 0x4937b0 | 6.48% | two-stream byte transform |
| 0x497705 | 1.91% | bit unpack |

Together, ~30.6% of all handler dispatches in a 3000-batch run. The first is a
plain counted byte copy, and it was declined twice over by accidents of
LUT_RUN's shape rather than of the idiom: it is one op short of the seven-op
floor, and its trip counter lives on the stack rather than in a register.

**What was built.** A `MEMCTR` role (handler 135, `inc`/`dec dword [base+disp]`)
and a second predicate, `$loop_try_copy`, lowering to super-op 411
(`$th_copy_run`). Two cursors with independent strides and displacements, one
byte register passing through unchanged, and a counter in either a register or
memory. LUT_RUN declines `MEMCTR` explicitly -- its counting gates would not
have noticed one, and the super-op would have silently dropped the decrement.

**The matcher generalized.** COPY_RUN fires in 4 of 10 swept apps
(total_annihilation 7, starcraft 1, diablo 1, pinball 1) where LUT_RUN reached
one. TA's `hot%` fell 31.5 -> 27.2 as 0x497948 left the hot list entirely:
1,044,252 iterations collapsed into 245,077 super-op invocations.

**The lowering did not pay.** Min-of-N over a 3000-batch TA run, same build,
`--no-loop-superops` as the A/B partner:

| | min user CPU | API calls (guest progress) |
|---|---|---|
| superops on | 3.24s | 45905 |
| superops off | 3.21s | 45137 |

A wash, with the lowered build doing 1.7% more guest work. Run-to-run spread on
this box was ±30%, which is why min-of-N and the progress column are both here.
This is the second independent demonstration -- LUT_RUN on Heroes II was the
first -- that removing dispatches from a hot loop does not remove time.

**Why, and what it implies.** The measured average trip count is 4.26
iterations (245,077 invocations, 1,044,252 iterations, via `--count=0x497948`).
The block is entered enormously often and does almost nothing each time: about
1MB copied across 3.6 seconds. So the per-entry cost dominates, and the
super-op's own prologue is a per-entry cost too -- 14 parameter words, three
`$get_reg` calls, a `$set_reg8`, a flags update. Reading the parameter block as
offsets off one base instead of 14 `$read_thread_word` calls, and hoisting the
memory-counter write-back out of the loop when the destination provably cannot
cover it, together moved nothing measurable.

The super-op still calls `$gl8`/`$gs8` per byte, and those stayed. That is the
informative part of the negative: what was removed (dispatch) was not the cost,
and what remains (bounds-checked, translated per-byte memory access) is. It
lines up with the earlier `$next`-dispatch negative result -- fewer dispatches
is simply not the lever on this interpreter.

> **Superseded in part by §10.7.** The A/B above is measured on Total
> Annihilation, and TA turns out to be decode-bound: its working set blows the
> block cache, so ~99% of its block decodes evict a live block. An
> execution-side change cannot show up in that number either way. The negative
> result is real as a statement about this benchmark; it does not support the
> conclusion drawn from it below. Read §10.7 first.

**Consequence for Design A.** Do not add a third predicate expecting a speedup.
The next lever for a byte-stream idiom is a bulk memory primitive --
`memory.copy` for a `+1/+1` copy with no overlap, which skips the per-byte
bounds check entirely -- and that only pays where the trip count is long. It is
not long here. Before building it, measure trip-count distributions, not match
rates or block-entry shares: 0x497948 looked like 8.7% of the machine and was
worth approximately nothing.

Verified unchanged: minesweeper-click (8/8), notepad-editing (10/10),
freecell-move (7/7), liquid-war-candidate, heroes2-gameplay (1722 frames,
adventure map reached).

### 10.7 Page-chunked memory access, and why TA could never have measured it

§10.6 concluded that the cost left in a super-op was per-byte translated
memory access, and that Design A had no more to give. The first half was
right and has now been acted on. The second half rested on a benchmark that
could not have detected the fix.

**Mappings cannot change inside a super-op.** `$g2w`'s own comment states that
map records are append-only — `VirtualFree` currently preserves its backing —
and new records are created only by API calls (`VirtualAlloc`, file mapping,
DLL load). No guest code runs while a super-op is on the stack, so a
translation resolved at the top of a run stays valid for the whole run. There
is nothing to re-validate.

**A page is the largest safe chunk.** Translation is affine per *map record*,
not per page, and the direct guest window is one affine region spanning
0..0x8000000 — so region-granular chunking would be even coarser. But a sparse
reservation committed in pieces gets one record per commit, and `$gl32`'s
comment spells out the consequence: "adjacent guest pages need not have
adjacent WASM backing". A page is therefore the largest span whose guest→WASM
delta is *guaranteed* constant, and it is the same invariant `$gl32`/`$gl16`
already rely on when they skip their cross-page gather.

**What changed.** Both super-ops now resolve per chunk instead of per byte:

```
chunk = min(trips_left, steps_budget, page_room(src), page_room(dst))
  src_wa = g2w(...)            1 call   was 1 per byte ($gl8, page-cached)
  dst_wa = g2w(...)            1 call   was 1 per byte ($gs8, NOT cached)
  invalidate_code_write        1 call   was 1 per byte
  inner: i32.load8_u / i32.store8 / two pointer bumps, nothing else
```

The code-page test is hoisted to once per chunk because a chunk cannot leave
the destination page and nothing executes between its first and last store, so
invalidating up front is exactly what invalidating per byte did. Two shapes
escape to `chunk = 1`, which is bit-for-bit the old behaviour: a cursor that
resolves to `NULL_SENTINEL` (four bytes, not a page, and must never be walked),
and a COPY_RUN whose counter lives in memory the destination might cover.

LUT_RUN gets one more: its 256-byte lookup table is loop-invariant, so its
translation is hoisted out of the entire run when all 256 entries fit in one
page (`tbl & 0xFFF <= 0xF00`). A straddling table keeps `$gl8`, whose page
cache handles two pages well. That takes LUT from three per-byte translations
to zero.

Byte granularity is kept in the inner loop, so overlap semantics are unchanged
— the copy still runs in the original's direction, one byte at a time.
Widening to `memory.copy` or i32 steps is the point at which overlap would
start to matter.

**TA is decode-bound.** This is the finding that matters most here:

| TA, 1000 batches | |
|---|---|
| block decodes | 1,213,167 |
| of which evicted a live block | 1,201,016 (99.0%) |

Its working set exceeds the block cache, so nearly every decode discards a live
block and decode cost dominates the run. §10.6's wash is a property of that
benchmark. If TA is to get faster, the lever is block-cache capacity or
eviction policy, not the loop matcher.

**Heroes II, the honest measurement, is inconclusive on this box.** Min-of-5,
2600 batches, load ~5.5, `--no-loop-superops` as the partner:

| | run times (user CPU) | min | median |
|---|---|---|---|
| superops on | 3.08 4.36 4.17 3.89 4.72 | 3.08 | 4.17 |
| superops off | 3.62 4.23 4.42 3.98 4.22 | 3.62 | 4.22 |

Min says 15%, median says 1%. That is noise at this load, and it should not be
read as a win: `--loopmatch-stats` reports Heroes II matching **6 blocks of
89**, far too small a slice to plausibly move 15% of a run.

**What this leaves.** The change is justified by argument, not by measurement:
it strictly removes work per byte and provably cannot change behaviour. What is
still missing is a way to see it. Before the next attempt at this, build a
deterministic counter — translations performed per run — so the effect can be
read off a single run instead of chased through wall-clock on a loaded box.
That instrument is worth more than another predicate.

Verified unchanged: heroes2-gameplay (byte-identical output — map green 37.3%,
black 39.4%, panel wood 69.7%, 1722 frames), minesweeper-click (8/8),
notepad-editing (10/10), freecell-move (7/7).

## 14. Status 2026-08-23: the lowering is disabled by default

`$loop_emit_enabled` now defaults to **0**. The matcher, the roles, the
predicates and the counters all still run; nothing is emitted unless the host
calls `set_loop_emit(1)` (`test/run.js --loop-superops`).

Why: with the lowering on, Diablo shareware's Choose Class screen renders as
per-pixel colour noise in every panel, while text and the hero portrait
survive. Same run, same input, `--no-loop-superops` as the only difference:
correct render. `--trace-loopmatch` says only two self-loop blocks match on the
main thread out of 387, and both are COPY_RUN at runtime `0x006cf598` =
`storm.dll 0x1502c598`:

```
1502c598  8a 01        mov al, [ecx]
1502c59a  41           inc ecx
1502c59b  88 02        mov [edx], al
1502c59d  42           inc edx
1502c59e  ff 4c 24 10  dec dword [esp+0x10]
1502c5a2  75 f4        jnz short 0x1502c598
```

The enclosing code (`cmp dword [edi+0x8], 0x2000`, `lea ebp,[edi+0x1030]`,
`mov dword [esp+0x14], 0x1000`) is Storm's MPQ decompressor sliding-window
copy. So the corruption happens while the art is being *decompressed*, before
any blit -- which is exactly why the panel backgrounds are noise and the text
drawn afterwards is fine.

What has been ruled out: **chunking is not the cause.** Forcing
`(local.set $chunk (i32.const 1))` in `$th_copy_run` -- i.e. exactly the
original per-byte cadence, one `$g2w` per byte, counter published per chunk --
still renders the broken screen (29.9% of pixels differ from the known-good
capture, max channel delta 255). The divergence is therefore in the super-op's
own semantics or in the parameters `$loop_try_copy` extracts for this shape (a
byte copy with a *memory* counter and both cursors incrementing), not in the
page/budget chunk arithmetic. That is the next thing to bisect: parameter
block first (src/dst/disp/ctr_addr against the guest's own registers at entry),
then the exit publication (`$b`, the two cursors, the DEC flags, `$eip`).

## 15. Status 2026-08-24: the §14 miscompile does not reproduce

Re-ran §14's claim on today's `main` (page-compiled decoded code, `9b9a98c9`
merged; measured at `d627e9c5`). **It does not reproduce.** Everything below is
measured, one flag at a time, with `--loop-superops` the only difference
between the two command lines of each pair.

### 15.1 The flag is live: lowering really is emitted

`bbf4ca05` flipped `$loop_emit_enabled` to 0 but only taught `test/run.js`
`--no-loop-superops`; the positive `--loop-superops` came later. So **at
`bbf4ca05` itself the lowering can no longer be turned on at all** — an A/B
there is two identical runs. On `main` the flag does something: same build,
same 15-frame command line, only the flag differing,

```
              block decodes   pages compiled
  flag off          10571              336
  flag on           12164              432
```

and `--loopmatch-stats` reports `matched 2` on the main thread either way.

### 15.2 The two loops COPY_RUN lowers in Diablo

`--loop-superops --trace-loopmatch` + `tools/loopmatch-decode.js`, marker
`0x100B0002`, runtime VAs `0x006cf598` and `0x006cfa42` (storm delta
`0x1495D000` in that run):

```
storm+0x1502c598   6 ops        storm+0x1502ca42   6 ops
   28  th_load8_ro    op=0x1       28  th_load8_ro    op=0x32
   64  th_inc_r       op=0x1       64  th_inc_r       op=0x2
   29  th_store8_ro   op=0x2       29  th_store8_ro   op=0x31
   64  th_inc_r       op=0x2       64  th_inc_r       op=0x1
  135  th_unary_m32_ro op=0x14     65  th_dec_r       op=0x0
  312  th_jcc_nz                  312  th_jcc_nz
```

`storm+0x1502c598` is the one §14 names, and it is the **PKWARE explode
back-reference copy**, i.e. an *overlapping* copy — the four instructions above
it are

```
1502c584  mov ebp,[edi+8] / lea edx,[ebp+edi+0x30] / mov ecx,edx / sub ecx,eax
```

so `ecx = edx - distance`: source and destination are the same buffer, dst
ahead of src, and short distances are meant to replicate bytes forward. That is
the assumption COPY_RUN's predicate is weakest on (it only requires the two
*base registers* to differ, never that the ranges are disjoint) — and it turns
out to be safe, because `$th_copy_run`'s inner loop is byte-at-a-time ascending
into the same linear memory, which is exactly the semantics the guest's own
loop has. Chunking does not break it either: a chunk never leaves either
cursor's 4 KB page, so every byte still reads whatever the previous byte wrote.

### 15.3 The pixels

* **Choose Class**, the screen §14 says renders as colour noise:

  ```sh
  node test/run.js --app=diablo_shareware --time-scale=30 --max-batches=41500 \
    --no-close --repaint-every=200 \
    --input=39500:keydown:13,39560:keyup:13,41000:png:/tmp/cc.png [--loop-superops]
  ```

  `tools/png-diff.js`: **0 of 307200 pixels differ**. Byte-identical with and
  without the lowering. The art decompresses bit-exactly through COPY_RUN.

* **Main menu**, 15 frames three batches apart from 40000 in each config: the
  flag-on run's frame 10 is **pixel-identical over the logo box (100,0
  440x180) to the flag-off run's frame 0**, and 0.46% different full-frame,
  entirely in the y=193..232 band — the pulsing "SINGLE PLAYER" highlight.
  Enabling the lowering shifts the animation phase; it does not change what
  the art looks like.

* No colour noise appears in any of the 30 captures.

### 15.4 The blank-logo frames are a different defect

Both configs produce a mix of good logo frames and black/torn ones (the logo
flame has a ~45-batch period with ~20% duty at `--time-scale=30`, per the
Diablo notes). Because it happens identically with the lowering off, it is
**not** COPY_RUN — it belongs to the erase/present timing work being tracked
elsewhere. §14's "renders as colour noise" and today's "the logo is missing on
most frames" are not the same symptom, and a single-frame capture cannot tell
them apart: sample ≥15 frames.

### 15.5 What could not be settled, and why

Bisecting to the commit that fixed it is **not runnable from the emulator side
of the tree**: at `bbf4ca05~1` (`e781c01e`, where `$loop_emit_enabled` still
defaulted to 1) Diablo draws nothing at all — 80100 batches, every capture a
flat 2 KB PNG — because the DirectDraw present path for a window owned by a
worker thread (`bd5fa7d9`) and the client-rect present fixes landed later. So
the historical tree cannot show either the good frame or the bad one. The
plausible fixers remain `6b801a9d` (retire a decoded block by every page it
covers) and `9c257a88` (the hash block cache deleted; invalidation is now per
guest offset), both of which change exactly the self-modifying-code
invalidation that a byte copy into Storm's generated-code arena depends on —
but that is inference, not measurement.

### 15.6 Verdict on the predicate

Nothing measured says the predicate is wrong in principle, and the one
assumption it visibly does not check — disjoint source and destination — is
provably not needed for the ascending byte-at-a-time form it lowers to. The
remaining unchecked hole is narrower and still worth closing before the default
is flipped back: **the byte register's parent register is compared against both
cursors but not against a register-resident trip counter**, so a body of the
shape `mov cl,[esi] / mov [edi],cl / inc esi / inc edi / dec ecx / jnz` would
have its counter and its byte register alias, and `$th_copy_run`'s exit
sequence writes `set_reg8(byte_reg)` before `set_reg(ctr_loc)` — the counter
wins and the byte register is lost. Neither Storm loop has that shape, so it is
a latent hazard, not the reported bug. The narrowest correct change is one more
line in the pass-2 predicate:

```
;; the byte register must not live inside the trip counter either
(if (i32.and (i32.eqz $mem_cnt)
             (i32.eq (i32.and $ld_reg 3) $ctr_loc)) (then (return 0)))
```

Recommendation: re-measure the corpus with the lowering on rather than leaving
the default off on the strength of §14, and delete the stale justification from
the `$loop_emit_enabled` comment in `src/07b-loop-match.wat` when the default
is next revisited.

## 16. Universal LUT_RUN descriptor and Diablo II bounded loops

The Heroes counted-loop form and Diablo II's cursor-bounded forms now lower to
one H418 executor. They deliberately do **not** share one permissive recognizer:
the old matcher still proves the counted `DEC/JNZ` shape, while
`$loop_try_lut_bounded` proves the exact `CMP cursor,bound / JB` shape seen in
`d2gfx.dll` and `d2cmp.dll`. A third, deliberately separate recognizer proves
d2gfx's two-moving-source blend loop. All emit the same versioned descriptor;
version zero is the original 22 words:

```
  0..2   source register, stride, displacement
  3..5   destination register, stride, displacement
  6..9   table register, accumulator register, index shift, optional add register
  10..12 termination kind, register, step
  13..18 up to two final register mirrors (address, register, adjustment)
  19..21 fall-through EIP, back-edge EIP, x86 cost per trip
```

Header bit zero selects version one and appends six words:

```
  22..24 second source register, stride, displacement
  25     auxiliary low-byte register
  26     table displacement (also permits an absolute table when table register = -1)
  27     terminating stream (0 = source one, 1 = source two)
```

The version-one index is `(source1_byte << shift) + source2_byte`. This covers
the clipped d2gfx blend at original `0x100033ca` without turning the existing
invariant-row input into mutable state or creating another executor handler.
Recognition stays exact: two full-register zeroes, two byte loads, `SHL 8`,
three cursor increments, an unscaled accumulator-plus-auxiliary SIB lookup, one
byte store, and `CMP source2,bound / JB`. Scratch/cursor/bound aliasing, a
different operation order, a scaled index, a non-`JB` terminator, or any extra
work declines the lowering.

Termination kind 0 is count-to-zero; kind 1 is unsigned source-cursor-below-
bound. The executor handles the optional `(source_byte << 8) + invariant_row`
index used by D2CMP, keeps source and destination accesses inside translated
4KB chunks, resumes at the step budget, publishes the original final registers
and flags, and takes the direct 256-byte table path when translation proves it
safe. The bounded recognizer is intentionally narrow: forward stride one,
exact `JB`, one compare, strict operation order, invariant table/bound/row
registers, and no accumulator/cursor alias. A near-identical `JBE` loop is a
negative regression.

The two families now have independent gates. LUT emission is on by default and
uses `--lut-superops` / `--no-lut-superops`; COPY emission remains off and uses
`--copy-superops` / `--no-copy-superops`. The legacy `--loop-superops` pair
controls both. `test/run.js` applies each choice to every WASM instance rather
than only main. `test/test-lut-run-generalized.js` pins the d2gfx one-source
page-crossing form, the two-moving-source absolute blend-table form with all
three streams crossing pages, the d2cmp invariant-row form, the Heroes counted
form through the same handler, budget resumptions, final scratch/flag state,
and the `JBE` rejection.

### 16.1 Gameplay measurement

On the installed Diablo II demo's stable gameplay window, batches 1500..1660,
the main instance retired 257,258,415 handlers with LUT_RUN versus 262,313,891
before it: 5,055,476 fewer, or 1.93%. H418 processed 1,381,859 pixels in
112,874 resumptions from 133 bounded matches. The former hottest self-loop,
runtime `0x0086e24e` (`d2gfx.dll` original `0x1000324e`), and D2CMP's
`0x00655762` disappeared from the hot-block list. The captured Rogue Encampment
frame still passes the gameplay terrain/orb/color assertions.

This also locates the next ceiling. The dominant remaining d2gfx path at
original `0x10001141..0x100012e2` is a 15-row Duff-style renderer: a jump table
enters one of 32 fully unrolled `load source byte -> table lookup -> store`
suffixes. It is semantically LUT_RUN, but it is straight-line code inside an
outer row loop rather than a self-loop block. The second renderer at
`0x1000134d..0x100016c3` is the same layout with a two-byte 64K blend table.
Recognizing self-loops more broadly cannot touch either. The next local
interpreter optimization should be a conservative unrolled-LUT fold (or a
fixed-count extension of this descriptor), not a looser bounded-loop matcher.

## 17. Fixed unrolled LUT spans

The d2gfx Duff renderers now lower through H431, the nonterminal fixed-span
sibling of H418. This is intentionally a decoder-time subsequence matcher, like
`RECT_RUN`, rather than another `$loop_match_block` recognizer: the indirect
jump has already selected a suffix length, the pixel instructions are straight
line, and the outer row update must remain in the same ordinary basic block.
The matcher runs at every instruction boundary, advances `$d_pc` past only the
proved span, and lets decoding continue into the untouched tail.

Two conservative grammars share the executor:

- One-source translation accepts four or more exact, contiguous descending
  `xor scratch,scratch / load scratch8,[source+d] / load
  scratch8,[scratch+table] / store [destination+d],scratch8` units. The special
  final d2gfx pixel uses a different byte register and stays outside the fold.
- Two-source blending symbolically tracks the scheduled scratch values through
  XOR, two byte loads, `SHL 8`, a 64KB table load and a two-register destination
  store. Loads and clears may cross the preceding store exactly as MSVC
  scheduled them. A span ends only at a store checkpoint whose last flag writer
  is a proved zeroing XOR, so no register-liveness assumption is needed.

Both reject prefixes, segmented/address-size forms, displacement gaps, changing
bases/tables, scaled blend indices, scratch/address aliasing, page-crossing code
and fewer than four output pixels. There are no module names or guest addresses
in the predicate. The six-word descriptor records the starting displacement,
compiled pixel count, original instruction cost, table displacement and exact
final auxiliary-register state. H431 snapshots every address register, walks
the span downward, publishes the scratch registers and XOR lazy flags, charges
the removed x86 instruction count, and `return_call $next`s into the row tail.
The existing LUT-only gate controls H418 and H431 together.

`test/test-lut-span.js` pins both grammars, the scheduled-load case, unchanged
base registers, exact final scratch/flag state, a source/destination page seam,
the shared A/B gate and a displacement-gap near miss.

### 17.1 Diablo II measurement

In the same deterministic gameplay histogram window used for §16.1, H431
reduced main handlers from 257,258,415 (H418 only) to 179,778,066, a further
77,480,349 or 30.12%. The pre-LUT baseline was 262,313,891, making the combined
reduction 31.46%. The outer d2gfx row/jump-table blocks remain hot while the
pixel suffix landings leave the top-block list, which is the expected signature
of a nonterminal subsequence fold. The captured gameplay frame retained its
terrain/orb/color scores. Variable host load made wall time unsuitable for a
speed claim; these are retired-handler counts for identical batches 1500..1660.

## 18. Moving-source LUT and ESP load-run follow-up

The remaining clipped blend loop at d2gfx original `0x100033ca` now lowers to
H418 descriptor version one. In a fresh batches-1500..1660 capture, runtime
`0x0086e3ca` entered 26,522 times instead of the prior capture's 251,520
per-pixel entries: the remaining entries are expected budget resumptions of the
terminal super-op. Aggregate H418 activity was 1,205,355 pixels in 96,689 runs.
The fresh frame had a different terrain workload, so that block comparison is
activation evidence rather than an isolated app-speed percentage.

The same capture also validates a decoder-only extension to H408. Canonical
`mov reg,[esp+disp]` uses a mandatory `24h` SIB byte even though it has no
index; the old raw look-ahead rejected all rm=4 encodings. `$base_mov_at` now
accepts precisely that SIB spelling, handles its shifted disp8/disp32 offsets,
and keeps real indexed SIB operands out. H408's executor already accepted
base=ESP and snapshots the base before all loads, so a write to ESP remains
legal only as the final element. `test/test-load32-esp-run.js` pins all three
displacement widths, the final-base-write case, handler counts, and an indexed
SIB near miss.

H408 executed 2,869,328 load groups in that gameplay window, while the former
`H343 -> H343` top pair disappeared. The resulting frame still scored terrain
102,464, life 3,612, mana 2,910 and 189 quantized colors. Machine load exceeded
80 during the replay, so no wall-time/FPS claim is made.

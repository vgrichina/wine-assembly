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

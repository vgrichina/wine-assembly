# Integer expression fusion: is there a ceiling worth building for?

A **decode-time integer expression fold** would take a basic block whose interior is a chain of
full-width 32-bit integer ops, build one dataflow expression tree out of it, and emit a *single*
threaded-code op for the whole run: intermediates live in wasm locals, and only registers that are
live out get written back to the register file at block exit. It removes one `$next` dispatch per
folded op and one register-file round trip per intermediate.

`tools/bench-loops.js` already prices those primitives: **a dispatch is ~8ns and a block transfer
adds ~9ns on top of it**. So the whole question is *what share of retired ops sit inside such a
run*. If it is small, the fold is not worth building. `tools/expr-fold-census.js` measures that
share.

## What the tool measures

Input is a hot-block dump from a real run:

```
node test/run.js --app=ID --quiet-api --max-batches=999999 --max-seconds=N \
     --handler-hist --handler-hist-thread=0 --handler-hist-start=A --handler-hist-stop=B \
     --hot-block-dump=FILE
```

one line per distinct block, `0xADDR hits`. Every block address is mapped back to a module
(`lib/pe.js`), decoded from its entry with `tools/disasm.js` until a block terminator, and every
instruction is classified. Everything is weighted by the block's hit count, so

> **retired ops = Σ over blocks of `hits × ops_in_block`**

which is dispatches actually executed, not static instruction counts. DLL blocks are mapped with
the `DLL: NAME at 0xLOAD, ..., origBase=0x...` lines `test/run.js` prints unconditionally at load
(`--modules-from=RUNLOG`); blocks outside every known image are reported as an "outside exe" hit
share and not decoded.

Two derived numbers matter more than the raw share:

* **maximal foldable runs** — each run collapses to one dispatch, so *dispatches removed =
  foldable ops − runs*. That is the line the decision rests on.
* the same walk **with the may-alias rule off**, which brackets the answer between "no alias
  analysis at all" and "perfect alias analysis".

### FOLDABLE

Full-register 32-bit `mov` / `lea` / `add` / `sub` / `and` / `or` / `xor` / `imul` (2- and 3-operand)
/ `neg` / `not` / `shl` / `shr` / `sar` **by immediate**, plus `movzx` / `movsx` to a 32-bit
destination and `nop`. Register or `[mem]` operands both allowed; loads and stores may sit inside a
run, but their **order is preserved** — see `alias` below.

### BARRIERS (each ends the run; counted separately, weighted by retired ops)

| class | what ends the run |
|---|---|
| `partial-reg` | any 8/16-bit write (`al`, `ah`, `ax`, `mov [x], si`, `add byte [x], 1`) |
| `adc/sbb` | carry-chained arithmetic |
| `flags` | flag consumers: `setcc`, `cmovcc`, `lahf`/`sahf`, `pushf`/`popf`, `rcl`/`rcr` |
| `terminator-flags` | a `cmp`/`test` immediately feeding a conditional terminator — the *normal* shape, not a failure; the tree simply ends there |
| `shift-cl` | shifts by `cl` |
| `div` | `div`/`idiv` |
| `mul64` | `mul`, one-operand `imul` (64-bit result) |
| `call` / `ret` / `int` / `branch` / `branch-cc` | terminators |
| `string` | `movs`/`stos`/`lods`/`scas`/`cmps`, with or without `rep` |
| `stack` | `push`/`pop`/`enter`/`leave` — a dead temp is renamable but `esp` is live, so this is its own class |
| `segment` | `fs:`/`gs:` accesses and segment-register moves |
| `fpu/simd` | x87, MMX, SSE |
| `alias` | a load that follows a store **inside the same run**: an expression tree reorders freely, and nothing here proves the two do not overlap |
| `other` | `inc`/`dec` (partial flag update, CF preserved), `xchg`, `bswap`, `rol`/`ror`, `shld`/`shrd`, `bt*`, `cdq`/`cwde`, everything else |
| `undecoded` | the disassembler produced `db` — data in code, or a decode desync |

Per block the tool also reports the foldable op count, the longest maximal foldable run, the
number of distinct 32-bit registers written (the conservative live-out set: every register written
is assumed live out), and the load/store counts.

### Classifier verification

Hand-checked against `tools/disasm_fn.js` on the hottest block of the Quake II window,
`ref_soft.dll+0x12570` (67828 hits, 19 ops):

```
F 10012570  mov eax, edx        F 10012583  mov ebp, edx
F 10012572  add edx, ebx        F 10012585  mov [edi], eax
F 10012574  shr eax, 0x10       F 10012587  add edx, ebx
F 10012577  mov esi, edx        F 10012589  shr ebp, 0x10
F 10012579  add edx, ebx        F 1001258c  mov esi, edx
F 1001257b  and esi, 0xffff0000 F 1001258e  add edx, ebx
F 10012581  or eax, esi         F 10012590  and esi, 0xffff0000
                                F 10012596  or ebp, esi
                                F 10012598  mov [edi+0x4], ebp
                                F 1001259b  add edi, 0x8
  1001259e  dec ecx     [other]        — partial flag update, CF preserved
  1001259f  jnz short   [branch-cc]    — consumes ZF from the dec
```

17 of 19 foldable in one run, with the two barriers correctly identified: this is the span
texture-coordinate loop, and `dec`/`jnz` genuinely cannot be inside the tree. The bytes match
`disasm_fn.js` on the same file exactly, so the runtime→file VA arithmetic
(`va − loadAddr + origBase`) is right too.

## Per-app results

Measured 2026-09-10. All runs `--quiet-api --max-batches=999999 --max-seconds≤60`.

| app | window (what it is) | retired ops | foldable | ops in blocks with ≥4 foldable | run p50 / p90 | dispatches removed | top barrier |
|---|---|---|---|---|---|---|---|
| `quake2_demo` | b3000–3100, `+set vid_ref soft +map demo1`, world rendering | 18.64 M | **47.7 %** | 69.6 % | 3 / 9 | **28.8 %** | `fpu/simd` 17.5 % |
| `caesar3_demo` | b3500–3600, city simulating (verified by capture at b3450) | 29.55 M | **67.9 %** | 65.1 % | 3 / 4 | **36.3 %** | `alias` 19.9 % |
| `mw3` | b35–50, **startup only** — see caveat | 103.83 M | **84.1 %** | 98.7 % | 20 / 20 | **70.1 %** | `partial-reg` 9.8 % |
| `heaven7` | b400–500, **precalc loop, not the render loop** — see caveat | 4.13 M | **12.4 %** | 0.0 % | 0 / 1 | **3.0 %** | `branch-cc` 24.1 % |

Alias-relaxed run lengths (perfect alias analysis, the other bracket): quake2 p50 5 / p90 17;
caesar3 p50 5 / p90 **465**; mw3 unchanged at 20; heaven7 unchanged.

Outside-image hit share: quake2 2.4 % (only `gamex86.dll`, which is not on disk in this install),
caesar3 0 %, mw3 0 %, heaven7 0 %. Quake II's window is 97.6 % inside `ref_soft.dll` and `quake2.exe`
once the DLL bases are supplied — **without** `--modules-from` it reads 86.3 % outside and the
foldable share collapses to a meaningless 26 %, so always supply the module map.

> **One correction applies to every `fpu/simd` figure in this document, and to nothing else.**
> The first round's classifier tested a packed-op mnemonic set spelled `/^(p[a-z]+|movq|…)$/`
> *before* its stack case, and `p[a-z]+` matches `push`, `pop`, `pusha`, `popa`, `pushf` and
> `popf` — so every stack instruction was filed under `fpu/simd`, and the `stack` class the
> barrier table documents never appeared in a report. The regex now spells the real MMX/SSE/3DNow
> prefixes out, and **every number in this document has been re-measured on the same dumps with
> the fixed tool.** It is a labelling bug: both classes are barriers, so no foldable share, run
> length, terminator class, collapsible mass or dispatches-removed figure moves. What moves is
> the split — quake2's headline barrier goes from `fpu/simd` 20.3 % to **`fpu/simd` 17.5 %
> + `stack` 2.8 %** (17.5 + 2.8 = 20.3), caesar3 gains `stack` 2.6 %, and Heroes II moved 7.5
> percentage points the same way with its true `fpu/simd` going to zero. The x87 walk below keys
> off the mnemonic and was always right about *which* ops are float; its run boundaries shift by
> well under a percent, because `push`/`pop` now declare the `esp` write that the interleave test
> reads. Wherever a figure below is quoted to one decimal, it is the post-fix figure.

### Caveats on two of the four windows

* **`mw3` never reaches gameplay headless inside 60 s.** At `--batch-size=200000` it managed 96
  batches in 60 s; the documented cockpit route needs batch ~888. The window measured (b35–50) is
  its startup/transition screen, and **98 % of it is two blocks** — `0x526f54` and `0x527075`, a
  16-bit-per-pixel software alpha blend. So 84 % is one loop's number, not the app's.
* **`heaven7` never reaches its render loop headless either.** After the setup dialog it sits in a
  recursive tracer (`cmp byte [edi],0 / jz`, `sub edi,ebx ×2 / call esi`) for the whole 55 s run —
  four PNG captures at b2000/5000/10000/13500 are byte-identical. Its blocks are 1–3 ops with a
  `call` or `ret` at the end, which is why nothing folds.
* `caesar3_demo` did reach a live city (839 KB capture at b3450) within 60 s. `quake2_demo` was
  rendering the demo1 world (125 KB capture at b4000).

### Eyeballed top blocks

**quake2 `ref_soft.dll+0x12570`** — 17/19 foldable, run 17, 6 live-outs. Ideal case; the whole
interior is one tree. Its neighbour `+0x11e94` (63 ops, 28 foldable, run **5**) is the opposite: the
span mapper's `sbb ecx,ecx / adc esi,[base+ecx*4]` carry trick plus `mov al,[esi]` byte stores chop
the block into 5-op fragments. Those two blocks are the same routine and land on opposite sides of
the barrier list.

**caesar3 `0x41d7a0` / `0x41cf0f`** — 470 and 467 ops, ~465 foldable, but run **3**. These are fully
unrolled row copies, `mov eax,[esi+N]` / `mov [edi+edx+M],eax` repeated 225 times. Every load after
a store trips the may-alias rule, so the conservative run is 3 and the alias-relaxed run is 465.
This single shape *is* caesar3's 19.9 % `alias` barrier, and it is also exactly what the existing
`COPY_RUN` / `rect_run` superops already target — so most of caesar3's headroom is not new
territory.

**caesar3 `0x40fa38`** — 7 ops, 5 foldable, run 4: the RLE token decoder (`xor eax,eax` /
`mov al,[esi+1]` / `add edi,eax ×2` / `add esi,2` / `sub ecx,eax` / `jmp`). One 8-bit load in the
middle costs two ops of run length.

**mw3 `0x526f54`** — 42 ops, 36 foldable, run 20, 6 live-outs. A 16-bit blend: three `mov dx,[..]`
partial loads are the only barriers in an otherwise pure `and`/`add`/`shr`/`lea` tree.

**heaven7 `0x409cb6`** — 2 ops (`cmp byte [edi],0` / `jz`), 502072 hits. Nothing to fold.

## Terminator classes, and what the barriers cost

The share of retired ops that is "foldable" says nothing about *shape*, and shape is what decides
whether a fold is worth its machinery. A run of 20 folded ops inside a block that is entered once
per frame saves 19 dispatches once; the same run inside a self-loop saves 19 dispatches per trip.
[docs/int-expr-fusion-bench.md](int-expr-fusion-bench.md) prices exactly that difference in its
`trips=1` and `trips=64` columns. So the census now also reports, hit-weighted:

* **terminator class** — `self-loop` (the terminator jumps back to the block's own head),
  `interior-branch` (a conditional branch elsewhere: one arm of an if/else, or one block of a
  multi-block loop), `plain-exit` (jmp/call/ret/fallthrough);
* for self-loops, the **trip structure** — the last instruction that actually wrote the flags the
  terminator reads, which is `dec`/`inc` for a counted loop and `cmp`/`test` for a compared one.
  It is not necessarily the instruction *before* the branch: mw3's blend loop puts two `mov`s
  between its `dec esi` and its `jnz`, and reading only the previous instruction misclassified
  97.7 % of that app's retired ops as "other" until the walk-back was added;
* the **collapsible mass** — retired ops in blocks whose entire body folds *as a single run*.
  Those are the blocks that become one dispatch. A body that folds but is chopped into four runs
  by alias breaks is four dispatches, so it does not count.

| app | self-loop | interior-branch | plain-exit | self-loop trip structure (share of retired, mean foldable/block) |
|---|---|---|---|---|
| `quake2_demo` | **11.3 %** | 72.1 % | 16.6 % | `dec/jnz` 7.7 % (15.6) · `cmp/jcc` 2.0 % (2.2) · `sub`/jcc 1.6 % (1.0) |
| `caesar3_demo` | **0.0 %** | 68.0 % | 32.0 % | — no self-loop in the hot set at all |
| `mw3` (startup) | **97.7 %** | 1.1 % | 1.1 % | `dec/jnz` 97.7 % (33.9) |
| `heaven7` (precalc) | **0.0 %** | 48.2 % | 51.8 % | — |

caesar3's zero is not a measurement failure: its hot loops are all multi-block, and its two
hottest blocks are the 470-op unrolled row copies, which end in a `jmp`/`jcc` to a *different*
block. Everything caesar3 would gain from a fold is gained once per block entry, never amortised
over trips. quake2 is the mixed case, and its 7.7 % `dec/jnz` mass is one routine — the
`ref_soft.dll` span loop.

**Collapsible mass** (share of retired ops in blocks that fold to one dispatch). `body>=4` drops
bodies of 1–3 ops, which fold trivially and flatter the total:

| app | mode | all blocks | body≥4 | self-loop | self-loop body≥4 |
|---|---|---|---|---|---|
| `quake2_demo` | exact | 3.5 % | 2.5 % | 0.0 % | 0.0 % |
| | flags | 27.2 % | 19.0 % | 9.2 % | 8.9 % |
| | all | **32.9 %** | 24.4 % | **9.3 %** | 8.9 % |
| `caesar3_demo` | exact | 2.6 % | 1.8 % | 0.0 % | 0.0 % |
| | flags | 18.9 % | 8.0 % | 0.0 % | 0.0 % |
| | all | **33.5 %** | 17.8 % | **0.0 %** | 0.0 % |
| `mw3` (startup) | exact | 0.1 % | 0.0 % | 0.0 % | 0.0 % |
| | all | **98.6 %** | 98.1 % | **97.7 %** | 97.7 % |
| `heaven7` (precalc) | exact | 15.6 % | **0.0 %** | 0.0 % | 0.0 % |
| | all | 91.1 % | **0.0 %** | 0.0 % | 0.0 % |

heaven7's two columns are the caveat made numeric: 91 % of its retired ops sit in blocks that
"fully fold", and *none* of them has a body of four ops or more. It is 1–2-op blocks ending in a
`call` or `ret`, and collapsing a one-op body to one dispatch saves nothing.

### Relaxed barrier modes

`--relax=alias,partial,flags` (any subset) re-runs the same walk with one barrier class modelled
instead of refused. The report always prints all five modes; `--relax` selects which get a detailed
barrier histogram.

* **`alias`** — a store followed by a load is a barrier only when the two addresses may overlap.
  Disjoint if: both are constant absolute addresses with non-overlapping size-aware ranges; or the
  same base (and same index/scale) with non-overlapping displacement ranges; or one is `esp`/`ebp`
  based and the other is not, or is absolute. **That last rule is an assumption, not a proof**
  (stack frame vs heap/static): code that takes the address of a local and reaches it through a
  non-frame register violates it. Nothing in these four windows does, but a shipped fold would need
  it made real. A store whose base register has been rewritten since the store loses the
  displacement test and falls back to may-alias.
* **`partial`** — 8/16-bit register and memory accesses are modelled as insert/extract on the
  32-bit value and fold. High-byte (`ah`/`ch`/`dh`/`bh`) writes are counted separately because they
  cost an extra shift on both sides: they are **0.2 % of quake2's retired ops and 0.0 % of the
  other three**, so the awkward case is not the case that matters.
* **`flags`** — flags are carried as values with a per-*field* last writer, so `inc`/`dec`
  (CF-preserving), `adc`/`sbb`, `cmp`/`test` feeding a `jcc`, and `setcc`/`cmovcc` fold.
  `pushf`/`popf`/`lahf`/`sahf`, shifts by `cl` and `rcl`/`rcr` read or write the whole word and
  stay barriers under every mode.

| app | mode | foldable | ops in ≥4-fold blocks | run p50 | p90 | max | dispatches removed | mean run |
|---|---|---|---|---|---|---|---|---|
| `quake2_demo` | exact | 47.7 % | 69.6 % | 3 | 9 | 193 | 28.8 % | 2.52 |
| | alias | 47.7 % | 69.6 % | 4 | 15 | 204 | 30.5 % | 2.78 |
| | partial | 53.7 % | 70.4 % | 4 | 11 | 193 | 32.9 % | 2.58 |
| | flags | 61.0 % | 74.6 % | 4 | 12 | 193 | 41.1 % | 3.07 |
| | **all** | **67.0 %** | 75.3 % | **6** | **18** | 204 | **50.9 %** | 4.18 |
| `caesar3_demo` | exact | 67.9 % | 65.1 % | 3 | 4 | 18 | 36.3 % | 2.15 |
| | alias | 67.9 % | 65.1 % | 3 | 7 | 34 | 38.6 % | 2.32 |
| | partial | 72.6 % | 69.5 % | 3 | 4 | 18 | 40.9 % | 2.29 |
| | flags | 78.8 % | 79.2 % | 3 | 4 | 18 | 41.9 % | 2.14 |
| | **all** | **83.4 %** | 80.5 % | **4** | **7** | 34 | **50.6 %** | 2.55 |
| `mw3` (startup) | exact | 84.1 % | 98.7 % | 20 | 20 | 20 | 70.1 % | 6.03 |
| | alias | 84.1 % | 98.7 % | 20 | 20 | 20 | 70.2 % | 6.05 |
| | partial | 93.9 % | 98.7 % | 32 | 36 | 36 | 86.0 % | 11.92 |
| | flags | 86.8 % | 98.8 % | 20 | 20 | 20 | 75.2 % | 7.51 |
| | **all** | **96.6 %** | 98.8 % | **37** | **41** | 41 | **93.6 %** | 32.51 |
| `heaven7` (precalc) | exact | 12.4 % | 0.0 % | 0 | 1 | 2 | 3.0 % | 1.33 |
| | alias | 12.4 % | 0.0 % | 0 | 1 | 2 | 3.0 % | 1.33 |
| | partial | 12.4 % | 0.0 % | 0 | 1 | 2 | 3.0 % | 1.33 |
| | flags | 51.6 % | 0.0 % | 1 | 2 | 3 | 12.1 % | 1.31 |
| | **all** | **51.6 %** | 0.0 % | 1 | 2 | 3 | 12.1 % | 1.31 |

Remaining barriers under `--relax=alias,partial,flags`, as a share of retired ops: quake2
`fpu/simd` 17.5 %, `branch-cc` 8.5 %, `alias` 4.3 %, `stack` 2.8 %; caesar3 **`alias` 19.7 %**,
`branch-cc` 10.3 %, `stack` 2.6 %; mw3 `branch-cc` 2.7 %; heaven7 `branch-cc` 24.1 %,
`ret` 12.1 %, `call` 12.1 %.

### The two blocks, checked by eye

**`--relax=flags` on quake2 `ref_soft.dll+0x12570`** (runtime `0x00d90570`, 67828 hits). Under the
exact rule this block is 19 ops, 17 foldable, one run of 17, with `dec ecx` and `jnz` as the two
barriers — the disassembly is in the *Classifier verification* section above. Under `flags`,
`dec ecx` is a CF-preserving decrement whose only consumer is the `jnz` two bytes later, so it
joins the tree: the census now reports **18 foldable, run 18, and the block marked FULL**, i.e. the
whole body is one dispatch. The terminator classifier independently calls it
`self-loop:dec/jnz` (the `jnz short 0x10012570` target equals the block head), which is what puts
its 1.29 M retired ops into quake2's 7.7 % `dec/jnz` collapsible mass. This is the one place in
quake2 where the fold would be amortised over trips rather than paid per entry.

**`--relax=alias` on a caesar3 unrolled copy — it does not fire.** `0x41d7a0` is the 470-op row
copy, `mov eax,[esi+0x384]` / `mov [edi+edx],eax` repeated 225 times. Under `alias` its longest run
stays **3**, and caesar3's `alias` barrier only falls from 19.9 % to 19.7 % of retired ops. The
reason is visible in one pair: the store is based on `edi`, the load on `esi`, neither is a frame
register, and no rule in the list proves two arbitrary heap pointers disjoint. The 465-op run in
the "perfect alias analysis" bracket needs a *whole-object* disjointness proof (src buffer vs dst
buffer), which is a different and much larger piece of machinery than displacement arithmetic.

Where `alias` does fire is `0x4a1e8a` (26659 hits, 24 ops), and its arithmetic checks out by hand:

```
F 004a1ec3  mov edx, [ebp+0xc]              1  stack load
F 004a1ec6  mov [0x5c2d04], edx             2  absolute store
F 004a1ecc  mov eax, [ebp+0x10]             3  stack load  vs absolute store -> disjoint
F 004a1ecf  mov [0x5c2d08], eax             4
F 004a1ed4  movsx ecx, word [0x67408c]      5  abs load vs abs stores 0x5c2d04+4, 0x5c2d08+4 -> disjoint
F 004a1edb  mov [0x5c2c28], ecx             6
F 004a1ee1  mov edx, [ebp+0x8]              7  stack load vs absolute stores -> disjoint
F 004a1ee4  shl edx, 0x6                    8
F 004a1ee7  xor eax, eax                    9
  004a1ee9  mov al, [edx+0x5f702c]             partial-reg (folds only under --relax=partial)
```

Exact run **3** (each stack load after an absolute store broke it), `alias` run **9**, matching the
tool. Under `--relax=all` the run extends to **11** and stops at `mov al,[edx+0x5f702c]`: `edx` is
not a frame register, the pending stores are absolute, and the rule refuses to guess — the
conservative direction, correctly taken. Note also that `movsx ecx, word [0x67408c]` reads the very
address `mov [0x67408c], ax` wrote earlier in the block; under `all` that store *is* pending and
the same-absolute-address overlap test would break the run there, which is why the all-mode run is
11 and not the full 23.

### What the relaxations buy

**`flags` is the one that matters, and `alias` is the one that does not.** On the two windows that
are genuinely rendering, `flags` alone moves dispatches removed from 28.8 % to 41.1 % (quake2) and
36.3 % to 41.9 % (caesar3) — more than `alias` and `partial` combined on both — and it is the only
relaxation that moves the *collapsible* mass at all, taking quake2 from 3.5 % to 27.2 % and
caesar3 from 2.6 % to 18.9 %. That is the expected shape: `inc`/`dec`/`cmp` are the loop and
predicate scaffolding sitting between otherwise-contiguous arithmetic, so removing them merges
fragments rather than extending one end. Run *length* is a different ranking: `alias` is what moves
p90 (quake2 9 → 15, caesar3 4 → 7, and both maxima), because it is the only relaxation that lets a
run cross a store. `partial` is cheap and narrow — 5–6 points of foldable share on quake2 and
caesar3, and its awkward high-byte case is 0.2 % of retired ops at worst — but it is the *only*
relaxation that helps mw3's blend loop (run p50 20 → 32), because that loop's sole barriers are
three 16-bit accesses. All three together roughly halve the remaining barrier mass but leave the
two structural ones untouched: quake2 is still 17.5 % `fpu/simd` and caesar3 is still 19.7 %
`alias`, and caesar3's is the unrolled-copy shape that only whole-object disjointness would reach.

## Verdict

**The ceiling is real but modest, and it is smaller than the raw "foldable share" suggests.** On the
two windows that are genuinely rendering, 48 % (quake2) and 68 % (caesar3) of retired ops are
foldable, but the mean run length is only **2.5 and 2.15** — so the dispatches actually removed are
**28.8 % and 36.3 %** of retired ops, and every removed dispatch still costs a live-out writeback at
run exit (the conservative live-out counts here are 2–6 registers per block). At ~8 ns a dispatch
that is an upper bound of roughly a quarter to a third of interpreter dispatch time before any
writeback cost is subtracted, and a large slice of caesar3's share is the unrolled-copy shape the
existing `COPY_RUN`/`rect_run` folds already cover. The two headline numbers on either side —
mw3's 84 % and heaven7's 12 % — are both single-loop artifacts of windows that never reached the
intended workload, and should not be read as an app characterisation. Against that, the barrier
histogram says where a *cheaper* investment lies: `partial-reg` alone is 6 % / 4.6 % / 9.8 % of
retired ops across the three decodable apps, `adc/sbb` is 4.9 % of quake2, and caesar3's 19.9 %
`alias` would fall out of a disjoint-base check on a single addressing pattern. **Recommendation:
do not build the general decode-time expression tree yet.** The measured headroom does not clearly
beat what a narrower fold — same-base disjointness for the copy shape, and full-width handling of
16-bit-into-32-bit loads — would buy for far less machinery, and this census is the tool to re-run
against any such narrower proposal.

The terminator and relaxed-mode sections above sharpen that in two ways. First, **only quake2 has
any collapsible-loop mass at all** (9.3 % of retired ops, one `ref_soft.dll` span loop): caesar3's
hot set contains no self-loop, so every dispatch a fold saves there is saved once per block entry,
with the entry and exit materialisation charged each time — the bench's `trips=1` column, not its
`trips=64` one. Second, if a single barrier class is to be modelled, it is **`flags`**, not
`alias`: it buys more than the other two combined on both rendering windows, and it is what turns
that span loop into a single dispatch.

## Things the classifier cannot do

* **Packed executables.** heaven7 is UPX-packed: `UPX0` has `Raw=0`, so the code that actually runs
  exists nowhere on disk and every block read as `undecodable`. The workaround is
  `--mem=FILE`, which parses a `--input=N:dump-mem:0xADDR:LEN` hexdump as a code image; it is how
  the heaven7 row above was produced, but it only covers the range you thought to dump.
* **Self-modifying and runtime-generated code** in general — same failure mode, same workaround.
* **A DLL that is not on disk.** Quake II's `gamex86.dll` is missing from this install, so 2.4 % of
  its hits stay in the outside-image bucket.
* **Block length is capped** (`--max-ops`, default 256). caesar3's unrolled copies are ~470 ops and
  are silently truncated at the default; the report now names the truncated hit share, and the
  numbers above use `--max-ops=4096`. At 256 caesar3 reads 62.5 % foldable instead of 67.9 %.
* **Live-out is approximated conservatively** as "every 32-bit register written in the block",
  with no cross-block liveness. Real liveness would be smaller, so the writeback cost above is an
  over-estimate — in the fold's favour.
* **`--handler-hist-thread=0` only**, so a multithreaded app's worker blocks are invisible.
* Data-in-code produces `undecoded` (0.1 % on quake2, 0 elsewhere), which is small enough to ignore
  here but would matter on a Borland binary.

## Reproducing

```bash
S=/tmp/fold
# quake2 — soft renderer so the work stays in the interpreter, not behind gpu_gl_call
node test/run.js --app=quake2_demo --args='+set vid_ref soft +map demo1' --quiet-api --no-close \
  --screen=800x600 --batch-size=20000 --max-batches=999999 --max-seconds=55 \
  --handler-hist --handler-hist-thread=0 --handler-hist-start=3000 --handler-hist-stop=3100 \
  --hot-block-dump=$S/q2-hot.txt > $S/q2-run.log 2>&1
node tools/expr-fold-census.js --dump=$S/q2-hot.txt \
  --exe=test/binaries/candidates/quake-2-demo-installer/installed-extracted/Install/Data/quake2.exe \
  --modules-from=$S/q2-run.log --max-ops=4096 --label=quake2_demo --json=$S/q2.json
```

`--modules-from` reads the run log's own `DLL:` lines, so the emulator's load addresses and the
census always agree. Add `--module-dir=` for images that do not sit beside the exe.

The terminator-class, collapsible-mass and relaxed-mode tables are printed by every run; they need
no extra flag. `--relax=alias,partial,flags` (any subset) selects which modes additionally get a
full barrier histogram — the summary table always covers exact, each single relaxation, and all
three. The same numbers are in the `--json=` output under `terminatorClasses`, `selfLoopTrips` and
`modes`, and each of the top blocks carries its own `terminator`, `trip` and per-mode
`{foldable, runs, longest, fullyFoldable}`.

## Three more Win98 apps: Heroes II, Heroes III, StarCraft

Measured 2026-09-10 with the same tool, `--max-ops=4096`, all five modes. Bounded runs
(`--quiet-api --max-batches=999999 --max-seconds<=90`); box load 9-86.

### Classifier fix that landed with this batch

`push`/`pop`/`pusha`/`popa` were being classified **`fpu/simd`**, not `stack`: the packed-op test
was a bare `/^(p[a-z]+|...)$/`, which `push` and `pop` both match, and it ran before the stack
branch. The regex now spells out the real MMX/SSE/3DNow prefixes. This is a *labelling* bug only —
both classes are barriers, so no foldable share, run length, terminator class, collapsible mass or
dispatches-removed number changes; Heroes II's histogram simply moved 7.5 % from `fpu/simd` to
`stack`, and its true `fpu/simd` went to zero. **The quake2/caesar3 rows above have since been
re-measured on the same dumps with the fixed tool** — see the correction note under *Per-app
results* — so quake2's headline barrier now reads `fpu/simd` 17.5 % + `stack` 2.8 % where it once
read `fpu/simd` 20.3 %, and caesar3 gains `stack` 2.6 %. mw3 re-measures identically on every
published figure (84.1 % foldable, 98.7 %, 70.1 % removed, top barrier `partial-reg` 9.8 %) and
merely grows a `stack` 0.3 % line beside a real `fpu/simd` 0.1 %. **heaven7 is the one row that
could not be re-measured**: it is UPX-packed, so the census needs the `--mem` snapshot described
under *Things the classifier cannot do*, and that snapshot was not kept. Its `branch-cc` 24.1 %
top barrier is unaffected either way — the bug only ever moved mass between `fpu/simd` and
`stack`, neither of which is heaven7's headline — but treat any `fpu/simd`/`stack` split for
heaven7 as unmeasured.

### Windows, and what is actually on screen

| app | window | verdict |
|---|---|---|
| `heroes2_demo` | b1500-2400, after NEW GAME / STANDARD / OKAY, `--batch-size=20000` | **real gameplay** — the Broken Alliance adventure map. Captures at b1500 and b2400 differ on 1.05 % of pixels inside a 311x357 box over the map area; the rest of the screen is static UI chrome. 12978 batches ran in 60 s, so the documented gameplay window was reached comfortably. |
| `heroes3_demo` | b110-180, `--batch-size=200000 --thread-slices=1 --tick-ms-per-batch=100` | **intro movie, not gameplay** — the 3DO Smacker logo animation. 37.3 % of pixels change between b110 and b180. |
| `starcraft_shareware` | b300-780, `--threads --batch-size=100000` | **intro cinematic, not gameplay** — the Smacker space-station cinematic. 62.2 % of pixels change between b300 and b780. |

**Neither Heroes III nor StarCraft reaches gameplay inside the time bound, and both fall back into
the same middleware.** Heroes III's documented route (mousedowns at b700/1300/1900/2500, menu at
b3050, map by b4000) does not reproduce on current `main`: the run parks on the 3DO logo from about
batch 200 onward, and captures at b3050, b4000 and b5150 are byte-identical. Batch numbers are also
not a usable anchor for it — with the batch count uncapped, batches that block on the
audio-completion pacing retire nothing and the counter races to 487011 batches in 90 s while the
guest advances one movie. StarCraft's documented route needs batch 4550, and the box delivers
645-1100 batches per 90 s, i.e. roughly seven minutes of wall clock; `--time-scale=100` does clear
the cinematic and reach the "Loading" title screen at about batch 1000, but at load 86 that batch
was no longer reliably reachable inside 90 s, so the title window is not measured here. Both
windows therefore land inside **`smackw32.dll`, and inside literally the same routine** — Heroes
III's `0x1000ef03` and StarCraft's `0x1000ef03` are the same RAD Smacker MMX bit-reader/Huffman
decoder in two builds. They are **not two independent data points**, and neither says anything
about Heroes III's or StarCraft's own 2D engines.

`--handler-hist-thread=0` sees the main thread only. Heroes II runs its Miles mixer on the main
thread (MSS32 blocks are in its hot set); Heroes III spawns a Miles worker and StarCraft runs with
`--threads`, so both hide worker blocks — in both, the Smacker decode being measured is itself on
the main thread.

### Results

| app | window | retired ops | outside images | foldable (exact) | ops in >=4-fold blocks | run p50/p90 | dispatches removed | top barrier (exact) |
|---|---|---|---|---|---|---|---|---|
| `heroes2_demo` | adventure map | 81.15 M | 0.0 % | **48.3 %** | 44.0 % | 2 / 6 | **26.3 %** | `branch-cc` 13.6 % |
| `heroes3_demo` | 3DO intro movie | 5.61 M | 0.0 % | **47.0 %** | 64.0 % | 3 / 4 | **20.8 %** | `partial-reg` 16.2 % |
| `starcraft_shareware` | intro cinematic | 426.33 M | 0.8 % | **43.1 %** | 39.0 % | 2 / 4 | **17.8 %** | `branch-cc` 14.6 % |

Terminator classes, hit-weighted:

| app | self-loop | interior-branch | plain-exit | self-loop trip structure (share of retired, mean foldable/block) |
|---|---|---|---|---|
| `heroes2_demo` | **2.9 %** | 67.1 % | 29.9 % | `dec/jnz` 1.6 % (2.6) · `loop` 1.3 % (0.0) |
| `heroes3_demo` | **0.5 %** | 74.7 % | 24.8 % | `dec/jnz` 0.4 % (5.2) · `cmp/jcc` 0.1 % |
| `starcraft_shareware` | **0.1 %** | 86.4 % | 13.4 % | `cmp/jcc` 0.1 % (4.5) · `dec/jnz` 0.0 % |

Collapsible mass (retired ops in blocks whose entire body folds as one run):

| app | mode | all blocks | body>=4 | self-loop | self-loop body>=4 |
|---|---|---|---|---|---|
| `heroes2_demo` | exact | 11.4 % | 5.0 % | 0.0 % | 0.0 % |
| | flags | 45.3 % | 24.6 % | 0.0 % | 0.0 % |
| | all | **53.7 %** | 31.7 % | **0.2 %** | 0.2 % |
| `heroes3_demo` | exact | 1.8 % | 0.8 % | 0.0 % | 0.0 % |
| | flags | 7.2 % | 2.8 % | 0.0 % | 0.0 % |
| | all | **16.8 %** | 6.0 % | **0.1 %** | 0.0 % |
| `starcraft_shareware` | exact | 1.2 % | 0.4 % | 0.0 % | 0.0 % |
| | flags | 15.4 % | 5.9 % | 0.0 % | 0.0 % |
| | all | **30.2 %** | 13.4 % | **0.1 %** | 0.1 % |

Relaxed barrier modes:

| app | mode | foldable | ops in >=4-fold blocks | run p50 | p90 | max | dispatches removed | mean run |
|---|---|---|---|---|---|---|---|---|
| `heroes2_demo` | exact | 48.3 % | 44.0 % | 2 | 6 | 13 | 26.3 % | 2.19 |
| | alias | 48.3 % | 44.0 % | 2 | 6 | 13 | 26.6 % | 2.23 |
| | partial | 54.4 % | 56.3 % | 2 | 7 | 15 | 30.7 % | 2.30 |
| | flags | 65.8 % | 62.2 % | 3 | 6 | 14 | 39.5 % | 2.50 |
| | **all** | **71.9 %** | 65.9 % | **4** | **7** | 23 | **47.7 %** | 2.97 |
| `heroes3_demo` | exact | 47.0 % | 64.0 % | 3 | 4 | 10 | 20.8 % | 1.79 |
| | alias | 47.0 % | 64.0 % | 3 | 4 | 12 | 20.9 % | 1.80 |
| | partial | 63.2 % | 68.4 % | 3 | 11 | 14 | 37.9 % | 2.50 |
| | flags | 56.3 % | 68.5 % | 3 | 4 | 11 | 28.0 % | 1.99 |
| | **all** | **72.5 %** | 85.2 % | **3** | **11** | 15 | **44.9 %** | 2.63 |
| `starcraft_shareware` | exact | 43.1 % | 39.0 % | 2 | 4 | 13 | 17.8 % | 1.71 |
| | alias | 43.1 % | 39.0 % | 2 | 4 | 28 | 18.0 % | 1.72 |
| | partial | 55.8 % | 53.6 % | 3 | 4 | 15 | 27.1 % | 1.94 |
| | flags | 54.7 % | 50.6 % | 3 | 4 | 14 | 27.2 % | 1.99 |
| | **all** | **67.4 %** | 78.7 % | **3** | **5** | 31 | **37.1 %** | 2.22 |

Remaining barriers under `--relax=alias,partial,flags`, as a share of retired ops:

* `heroes2_demo` — `branch-cc` 13.6 %, **`stack` 8.0 %**, `alias` 4.2 %, `branch` 3.3 %,
  `string` 1.2 %. **`fpu/simd` is 0.0 %**: this window contains no x87 and no MMX at all.
* `heroes3_demo` — `fpu/simd` 10.2 %, `branch-cc` 10.2 %, `alias` 5.6 %, `other` 3.1 %.
* `starcraft_shareware` — `branch-cc` 14.6 %, `fpu/simd` 11.6 %, `alias` 4.1 %, `other` 3.0 %.

### Top blocks

**`heroes2_demo`**

* `0x004c7341` (727440 hits, 7 ops, fold 3, run 2, `interior-branch`) — the ICN sprite decoder's
  command-byte fetch: `xor eax,eax` / `mov ecx,[0x525d80]` / `inc ecx` / `mov [0x525d80],ecx` /
  `mov al,[ecx-1]` / `test al,al` / `jge`. Its stream cursor is a **global**, re-read and written
  back for every single byte.
* `0x00499937` (164020 hits, 24 ops, fold 19, run 6, `plain-exit`) — the per-frame 6-bit VGA to
  BGRA palette rebuild: three unrolled RGB groups plus an alpha store.
* `0x0064ca61` = `MSS32.DLL 0x2000da61` (371383 hits, 6 ops, fold 4, run 4, `interior-branch`,
  FULL) — the Miles mixer's 32-slot voice scan, index and array base both held in globals.

**`heroes3_demo`** (all three are `SMACKW32.DLL`)

* `0x009a6ea0` = `0x1000eea0` (13 ops, fold 6, run 3) — Smacker Huffman symbol lookup: the MMX
  bit-shift register (`movd`/`psrlq`/`pand`) interleaved with an integer table walk.
* `0x009a6f80` = `0x1000ef80` — the identical loop, second copy of the same unrolled arm.
* `0x009a6f03` = `0x1000ef03` (11 ops, fold 8, run 4) — the Smacker tree-node swap: seven chained
  pointer loads/stores through three globals, broken only by `mov al,[0x10014c00]`.

**`starcraft_shareware`** (all three are `smackw32.dll`)

* `0x008e4fad` = `0x1000efad` (3.34 M hits, 7 ops, fold 3, run 1) — the Smacker MMX bit-reader:
  `shr edx,0xd` / `dec al` / `and edx,0xffff8` / `movd ebp,mm0` / `psrlq mm0,1` / `shr ebp,1` /
  `jb`. The MMX pair sits *between* the two integer shifts, which is why a 3-foldable block has a
  longest run of 1.
* `0x008e4ecd` = `0x1000eecd` — the identical bit-reader, second unrolled copy.
* `0x008e4f03` = `0x1000ef03` — the same tree-node swap as Heroes III's third block, byte for byte.

### Hand-verified classifications

* **Heroes II `0x00499937`.** `disasm_fn.js` on `H2DEMOW.EXE` reproduces the census bytes exactly.
  The run is `mov eax,[ebp-4]` / `lea eax,[eax+eax*2]` / `mov ecx,[ebp-0xc]` /
  `movsx eax,byte [eax+ecx]` / `shl eax,2` / `mov ecx,[ebp-4]` = **6 foldable**, ended by
  `mov [0x508084+ecx*4], al`, an 8-bit memory store, correctly `partial-reg`. Three such groups
  plus the trailing `mov eax,[ebp-4]` give 6x3 + 1 = **19 foldable, longest run 6**, exactly what
  the tool reports. Note the terminator: it is `jmp 0x499927` to a *different* block, so this loop
  is `plain-exit`, not a self-loop — its fold would be paid once per entry.
* **Heroes III `0x1000ef03`.** `disasm_fn.js` on the demo's `SMACKW32.DLL` matches byte for byte
  (`8b 29 / 8b 1d 68 4b 01 10 / 89 11 / ...`), which also confirms the runtime->file VA arithmetic
  through a relocated DLL (`0x009a6f03 - 0x998000 + 0x10000000`).
* **StarCraft `0x1000efad`.** `fe c8` is `dec al` (8-bit write -> `partial-reg`, correct) and
  `0f 7e c5` is `movd ebp,mm0` (`fpu/simd`, correct). fold 3 / run 1 is right: the two `shr`s that
  could fold are separated by the MMX pair.

### Are these self-loop-heavy like mw3, or interior-branch-heavy like caesar3?

**All three are firmly on the caesar3 side, and StarCraft is the most extreme case in the census so
far.** Self-loop mass is 2.9 % (Heroes II), 0.5 % (Heroes III) and 0.1 % (StarCraft), against mw3's
97.7 % and quake2's 11.3 %; interior-branch mass is 67 %, 75 % and **86.4 %**, where caesar3 sits at
68 %. Collapsible *self-loop* mass — the bench's `trips=64` column, the only place a fold amortises
— is 0.2 %, 0.1 % and 0.1 % even with every relaxation on, so on these workloads a decode-time
expression fold is charged its entry and live-out materialisation on essentially every block it
fires in, exactly as on caesar3. mw3's shape (one 16-bit alpha-blend self-loop carrying the whole
profile) remains an outlier produced by a startup window, not a property of 2D engines. The reason
is visible in the top blocks and is the same for all three: these are **byte-code interpreters over
compressed streams**, not pixel loops. Heroes II's hottest block is a sprite-opcode dispatch
(`test al,al / jge`, five ways out) whose literal runs are already `rep movsd`, and both Smacker
windows are a Huffman bit-reader that branches on the next bit every trip. A branch per token *is*
the workload, so the block is the loop body and the terminator is always a `jcc` to somewhere else.
The relaxations also rank differently here than in the two rendering windows above: **`flags` is
still the biggest single lever on Heroes II** (26.3 % -> 39.5 % dispatches removed, and it is what
takes the collapsible mass from 11.4 % to 45.3 %), but on the two Smacker windows **`partial`
overtakes it** (Heroes III 20.8 % -> 37.9 %, StarCraft 17.8 % -> 27.1 %), because a bit-reader's
state lives in `al`/`cl` counters and `partial-reg` is their single largest exact-mode barrier at
16.2 % and 12.7 %. `alias` is worth 0.2-0.3 points on all three and is again the relaxation that
does not matter. The structural ceiling differs too: Heroes II's residue after all three
relaxations is `branch-cc` 13.6 % plus `stack` 8.0 % with **zero** `fpu/simd` — a pure-integer 2D
engine, where a fold would be limited only by how often the guest branches — whereas both Smacker
windows keep a 10-12 % `fpu/simd` floor that an integer expression tree can never cross, because
the MMX bit shifter is interleaved into the integer chain instruction by instruction rather than
sitting in a run of its own.

---

# The x87 population, and what OpenGL does to the shape of the work

Two additions to `tools/expr-fold-census.js`, and one comparison the integer census could not
make.

## 1. x87 is now its own expression population

The integer walk counts every x87 instruction as one flat `fpu/simd` barrier. On the two
windows above that is the single largest barrier class (17.5 % of quake2's retired ops), and it
says nothing at all about whether the *float* side is expression-shaped. The census now runs a
second, parallel walk over the same blocks and the same hit weights.

**The integer numbers are unchanged by the x87 walk.** Adding it left the report's integer
section and the JSON's integer keys byte-identical on the same dump — verified by `diff` on both
— and the quake2 row above reproduces exactly: 18,641,438 retired ops, 47.7 % foldable,
p50 3 / p90 9, 28.8 % dispatches removed. Its top barrier reads `fpu/simd` 17.5 % **because of
the separate push/pop fix**, not because of anything here; see the correction note under
*Per-app results*.

### What an x87 run is

A maximal sequence of stack arithmetic whose register naming resolves **statically at decode
time**. Inside a run the x87 stack is renamed: `fld`/`fild`/`fld1`/`fldz`/the constant loads
push, `fstp`/`fistp`/the `p`-suffixed arithmetic pop, `fxch` swaps two names, everything else
leaves TOP alone. Because every operand is written `st(N)` *relative to the current TOP*, the
rename is exact as long as the running delta is known — which it is, from the run's first
instruction. So a run is a float dataflow tree over at most eight named values plus its memory
operands: exactly what a fold would emit as one threaded op. The census tracks the delta and
reports the peak number of live stack slots a run needs, and would end a run at `top-overflow`
if the rename ever needed more than eight (it never did).

Members: `fld fst fstp fld1 fldz fldpi fldl2e fldl2t fldlg2 fldln2 fadd fsub fsubr fmul fdiv
fdivr` (+ their `p`/`i` variants) `fxch fchs fabs fild fist fistp fsqrt fwait fnop`. The
constant loads beyond `fld1`/`fldz` are members rather than transcendentals: they push a
literal and cost nothing to model.

Barriers, each counted as *what ended the run*:

| class | what ends the run |
|---|---|
| `status-word` | `fnstsw`/`fstcw`/`fldcw`/`fclex`/`finit`/`fnsave`/`frstor` — the control and status words are architectural state a value tree does not carry, and the exception flags are sticky, so a fold may not reorder across them |
| `compare` | `fcom*` / `fucom*` / `ficom*` / `fcomi*` / `ftst` / `fxam` — these write the condition codes into the status word, read back some distance away by an `fnstsw`+`sahf` or an `fcomi`+`jcc` |
| `transcendental` | `fsin fcos fsincos fptan fpatan f2xm1 fyl2x fyl2xp1 fscale fprem fprem1 frndint fxtract` |
| `branch` | the block terminator — any `call`/`ret`/`int`/`jmp`/`jcc` |
| `integer-interleave` | an integer instruction touching memory the run also touches, by the same `mayAlias` rule the integer walk uses. An integer op that does **not** is allowed to sit inside the run and is counted separately as *interleaved integer*: it schedules around the tree, not through it |
| `other-fp` | MMX/SSE, `ffree`/`fincstp`/`fdecstp`, `fisttp` |
| `top-overflow` | the static rename would need more than eight live slots |

### The classifier bug this walk found, and how it was closed

The x87 walk is what turned the push/pop misclassification from a suspicion into arithmetic.
`classify()` used to test its SIMD mnemonic set `/^(p[a-z]+|movq|movd|...)$/` **before** its
stack case, and `p[a-z]+` matches `push`, `pop`, `pusha`, `popa`, `pushf` and `popf`. So every
stack instruction was counted in the integer census's `fpu/simd` barrier, and the `stack` class
the barrier table documents never once appeared in a report. On the quake2 software window that
is **527,962 retired ops — 2.8 of the 20.3 percentage points** then attributed to `fpu/simd`.
The x87 walk keys off the mnemonic rather than the class, so it was already reporting the real
float share of that window, **17.5 %** — and 17.5 % + 2.8 % = 20.3 % exactly, which is the
arithmetic that confirmed the diagnosis before any code changed.

`classify()` now spells out the real MMX/SSE/3DNow prefixes (`PACKED`), so `push`/`pop` classify
as `stack` and the two shares are reported separately. Every figure in this document has been
re-measured on the same dumps with the fixed tool. The mnemonic test (`STACK_MN`) is still there
and still load-bearing: `pushf`/`popf`/`pushfd`/`popfd` classify as `flags`, not `stack`, yet
they do touch `[esp]`, and the interleave test has to know that.

### Hand-verified block

`ref_soft.dll+0x11c3b` (runtime `0x00d8fc3b`, 11392 hits in the CLI window, 41 ops). The census
calls it 29 x87 ops, 29 run members, one run of 29, 0 interleaved integer, `interior-branch`.
`node tools/disasm_fn.js ref_soft.dll 0x10011c3b 45` agrees byte for byte:

```
X 10011c3b  fild dword [ebx+0x4]      X 10011c68  fadd dword [0x10027a94]
X 10011c3e  fild dword [ebx]          X 10011c6e  fxch st(4)
X 10011c40  fld st(1)                 X 10011c70  fmul dword [0x10027a90]
X 10011c42  fmul dword [0x10027a88]   X 10011c76  fxch st(1)
X 10011c48  fld st(1)                 X 10011c78  faddp st(2), st
X 10011c4a  fmul dword [0x10027a7c]   X 10011c7a  fxch st(2)
X 10011c50  fld st(2)                 X 10011c7c  fmul dword [0x10027a84]
X 10011c52  fmul dword [0x10027a80]   X 10011c82  fxch st(1)
X 10011c58  fxch st(1)                X 10011c84  fadd dword [0x10027a98]
X 10011c5a  faddp st(2), st           X 10011c8a  fxch st(2)
X 10011c5c  fxch st(1)                X 10011c8c  faddp st(1), st
X 10011c5e  fld st(3)                 X 10011c8e  fld dword [0x10027a5c]
X 10011c60  fmul dword [0x10027a8c]   X 10011c94  fxch st(1)
X 10011c66  fxch st(1)                X 10011c96  fadd dword [0x10027a9c]
                                      X 10011c9c  fdivr st(1), st
  10011c9e  mov ecx, [0x10027ab8]        <- integer-interleave: ENDS the run
```

That is the span-gradient setup: two integer screen coordinates converted with `fild`, run
through a 3x3 texture-transform matrix at `0x10027a7c..0x10027a98` with `fxch` doing all the
scheduling, and divided by a `w` term — 29 x87 ops in one tree, needing 5 live stack slots.
The run ends at `mov ecx,[0x10027ab8]` and not at the next float op, and that is the rule
working as designed rather than a miss: the pending x87 references include `[ebx]` and
`[ebx+4]`, `mayAlias` refuses to prove an absolute address disjoint from a register-based one
unless the register is `esp`/`ebp`, and so the conservative direction is taken. That refusal is
why `integer-interleave` is the *largest* run-ender in every window measured below.

## 2. Software vs OpenGL — and why this had to be measured in a browser

**The OpenGL renderer cannot run headless.** `lib/gl-compat.js`'s `createContext` opens with
`if (!win || typeof document === 'undefined') return 0;`, so in node `wglCreateContext` always
returns 0. A CLI run with `+set vid_ref gl` does load `ref_gl.dll`, resolve the WGL entry
points, `ChoosePixelFormat`, `SetPixelFormat` and call `wglCreateContext` twice — and then
`FreeLibrary`s opengl32 *and* `ref_gl.dll` and `LoadLibraryA("ref_soft.dll")`. The census of
that run is 90 % `ref_soft.dll` with zero `ref_gl.dll`: it is the software renderer wearing a
GL command line. Any "GL" measurement taken from `test/run.js` is that fallback.

So the GL window was taken from **real Chrome with SwiftShader**, driving the actual dropdown,
and reading the hot-block histogram out of the same `get_hot_block_hist_base()` array that
`--hot-block-dump` writes. The software window was re-taken the same way so the two sit on one
axis. The browser software window reproduces the CLI one closely (47.6 % vs 47.7 % foldable,
p50 3 / p90 9 in both, 28.7 % vs 28.8 % dispatches removed, mean run 2.52 in both), which is
what licenses reading the GL column beside it.

Both windows are 25 s of wall clock after a warm-up, `+map demo1`, and both were proven to be
rendering a moving world by two raw frame-layer PNGs through `tools/png-diff.js`: **GL 7.4 % of
640x480 pixels changed**, **software 8.9 % of 320x240**. The GL capture is unmistakably the
demo1 world — textured BSP geometry, viewmodel, HUD.

### Side by side

| | software (browser) | OpenGL (browser) | software (CLI, b3000-3100) |
|---|---:|---:|---:|
| retired ops in window | 717,521,101 | 378,886,832 | 18,641,438 |
| presents in window | 288 | 320 | — |
| frame-layer size | 320x240 (DirectDraw) | 640x480 (GPU) | 320x240 |
| **retired ops per present** | **2.49 M** | **1.18 M** | — |
| hits inside images | 97.3 % | 95.0 % | 97.6 % |
| outside (`gamex86.dll`, not on disk) | 2.7 % | 5.0 % | 2.4 % |
| `ref_soft.dll` | **88.8 %** | 0 % | 90.4 % |
| `ref_gl.dll` | 0 % | **62.6 %** | 0 % |
| `quake2.exe` | 11.2 % | **37.4 %** | 9.6 % |
| host API thunk entries | ~0 | **5.9 M = 1.6 %** of retired ops | ~0 |
| foldable, exact | 47.6 % | **28.1 %** | 47.7 % |
| foldable, `--relax=alias,partial,flags` | 66.6 % | **45.3 %** | 67.0 % |
| run p50 / p90, exact | 3 / 9 | **1 / 4** | 3 / 9 |
| run p50 / p90, all | 6 / 18 | **3 / 6** | 6 / 18 |
| dispatches removed, exact | 28.7 % | **11.2 %** | 28.8 % |
| dispatches removed, all | 50.4 % | **26.2 %** | 50.9 % |
| collapsible mass, exact (all / body>=4) | 3.5 % / 2.4 % | 1.3 % / 0.2 % | 3.5 % / 2.5 % |
| collapsible mass, all (all / self-loop) | 32.7 % / **9.0 %** | 31.1 % / **1.3 %** | 32.9 % / 9.3 % |
| terminator self-loop / interior / plain | 10.9 / 72.2 / 16.9 | **14.5 / 50.9 / 34.6** | 11.3 / 72.1 / 16.6 |

Barrier histogram, exact mode, share of retired ops:

| class | software | OpenGL |
|---|---:|---:|
| `fpu/simd` | 17.8 % | **22.8 %** |
| `branch-cc` | 8.5 % | 11.1 % |
| `stack` | 3.0 % | **9.2 %** |
| `terminator-flags` | 6.0 % | 8.6 % |
| `partial-reg` | 5.9 % | 4.4 % |
| `other` | 3.2 % | **9.3 %** |
| `adc/sbb` | 4.6 % | 0.2 % |
| `alias` | 3.3 % | 0.6 % |
| `call` + `ret` | 1.1 % | **4.0 %** |

Both columns are post-push/pop-fix: before it the two classes were merged and read `fpu/simd`
20.9 % against 32.0 %, which is exactly the pair of rows above added together.

The GL column is a different program. `adc/sbb` and `alias` — the software rasterizer's carry
tricks and its span copies — essentially vanish, `call`/`ret` quadruples, `stack` triples as the
GL path marshals arguments for every driver entry, and float goes from a sixth of all retired ops
to nearly a quarter.

### The x87 population, both renderers

| | software (browser) | OpenGL (browser) | software (CLI, b3000-3100) |
|---|---:|---:|---:|
| x87 ops, share of retired | 17.8 % | **22.8 %** | 17.5 % |
| x87 run members | 16.1 % | 19.2 % | 15.9 % |
| interleaved integer inside runs | 1.8 % | **4.2 %** | 1.7 % |
| x87 runs | 14.66 M | 19.51 M | 366,128 |
| **mean run length** | **7.89** | **3.73** | 8.09 |
| run length p50 / p90 / max | 3 / 23 / 159 | **2 / 11 / 117** | 5 / 23 / 159 |
| **x87 ops in runs >= 4** | **89.9 %** of members | **72.1 %** of members | 90.3 % |
| ... as a share of all x87 ops | 81.3 % | 60.8 % | 82.1 % |
| live stack slots p50 / p90 / max | 1 / 4 / 8 | 1 / 3 / 8 | 1 / 4 / 8 |
| dispatches removed by an x87 fold | **14.1 %** of retired | **14.1 %** of retired | 13.9 % |

x87 run barrier histogram (share of runs ended):

| class | software | OpenGL |
|---|---:|---:|
| `integer-interleave` | 37.5 % | 33.6 % |
| `compare` | 33.3 % | 25.7 % |
| `branch` | 25.4 % | **34.8 %** |
| `status-word` | 3.3 % | 5.7 % |
| `transcendental` | 0.5 % | 0.2 % |

Where the x87 lives, as a share of x87 retired ops:

| terminator class | software | OpenGL |
|---|---:|---:|
| `self-loop` | 1.6 % | **20.4 %** (all but 0.3 pp of it `dec/jnz`) |
| `interior-branch` | 79.0 % | 41.5 % |
| `plain-exit` | 19.4 % | 38.2 % |

### The top three blocks of the OpenGL window

| # | block | hits | ops | retired | what it is |
|---|---|---:|---:|---:|---|
| 1 | `ref_gl.dll+0x50ae` | 861,760 | 20 | 17.2 M (4.5 %) | **GL call setup.** Reads a per-vertex colour index (`mov dl,[eax+edi*4+3]`), looks it up in the float palette at `0x1002cb90`, scales the three components by the constants at `0x100b3b30/34/38`, pushes each with `push ecx` / `fstp dword [esp]` plus an alpha in `ebp`, and `call [0x10052a24]` — a four-float call, i.e. the colour entry — then `lea eax,[0x10038160+edx*4]`, `push eax`, `call [0x10052c08]`, a vertex-pointer call. Arity and rate match the re-note's per-frame census of ~2,750 `glColor4f` and ~6,400 `glVertex3fv`. |
| 2 | `ref_gl.dll+0x4dc4` | 301,440 | 46 | 13.9 M (3.7 %) | **Vertex transform — MD2 keyframe lerp.** Two byte-compressed vertex streams unpacked through the `[esp+0x14]` int->float staging slot with `fild`, each multiplied by a lerp scale vector (`[ebp+n]` and `[edi+n]`), summed, offset by the frame translate `[edx+n]`, and `fstp`d into the interpolated vertex at `[esi-0xc/-8/-4]`. `dec`/`jnz` self-loop over vertices. |
| 3 | `ref_gl.dll+0x48e0` | 487,818 | 25 | 12.2 M (3.2 %) | **Lightmap build.** Per RGB component: `fild` a lightmap byte from `[ecx-2/-3/-4]`, `fmul` by a per-style scale from `[esp+0x30/34/38]`, `fadd` into the running float accumulator at `[eax-0x14/-0x10/-0xc]`, `fstp` back. This is the `s_blocklights` accumulate loop, one style at a time. `dec`/`jnz` self-loop. |

Block 1 is the shape everybody expects of an accelerated renderer — a handful of floats
marshalled onto the stack and handed to the driver. Blocks 2 and 3 are the shape nobody
budgets for: pure guest float loops that never touch the GL seam at all.

### Does the GL path become foldable float trees, or scattered `fld`/`fstp` around API calls?

**Both, and the trees win.** Under OpenGL the float trees are half as long as the software
renderer's — mean run 3.73 against 7.89, p90 11 against 23 — but **72.1 % of x87 run members
still sit in runs of four or more**, and only 34.8 % of runs end at a branch (the class that
contains the call into the GL thunk). The modal run-ender is still an integer memory clash
(33.6 %) and the second is a float compare (25.7 %), which are the shapes of ordinary
arithmetic, not of API marshalling. The "scattered around a call" shape is real and is exactly
block 1 above — 9 x87 ops, longest run 4, ending at `call [0x10052a24]` — but that is 4.5 % of
GL's retired ops, while blocks 2 and 3, which are unbroken float loops, are another 6.9 %.

Three further things sharpen it. x87 is a *larger* share of retired work under GL, not a
smaller one (22.8 % vs 17.8 %): removing the software rasterizer removes integer span code, and
what is left is more float-dense. The float work moves into **self-loops** — 20.4 % of GL's x87
ops are in `dec/jnz` self-loops against 1.6 % under software — so an x87 fold there is
amortised over trips rather than paid once per block entry, which is the opposite of what the
*integer* fold gets on this app. And the payoff is renderer-independent: an x87 fold removes
**14.1 % of retired ops as dispatches under both renderers**, against an integer fold's 28.7 %
software / **11.2 %** OpenGL. Under OpenGL the float fold is worth more than the integer one,
and it is the only one of the two whose value does not collapse when the rasterizer moves to
the host.

### Window caveats

* **The two renderers run at Quake's own different default resolutions** — 320x240 software,
  640x480 OpenGL. "Retired ops per present" therefore compares the two shipped configurations,
  not equal pixel counts. Software does 2.1x the guest work per frame while drawing a quarter
  of the pixels; per pixel the gap is 8x.
* **The browser window is 25 s of wall clock, not a batch range.** The browser scheduler has no
  batch counter to aim at. Every share reported above is hit-weighted and therefore immune to
  how far the demo got; the one load-sensitive number is retired ops per present, and this box
  was under heavy load throughout. A second GL sample taken the same way retired 34.4 M hits in
  its 25 s against the reported run's 64.9 M — same shares, half the absolute work.
* **The hot-block histogram is a hash table and drops collisions**: 450,900 (software) and
  180,571 (OpenGL) against 77.9 M and 64.9 M recorded hits, i.e. 0.6 % and 0.3 %.
* **`gamex86.dll` is missing from this install**, so 2.7 % (software) and 5.0 % (OpenGL) of hits
  are outside every image and undecoded. The GL share is higher because the game DLL's fixed
  per-frame work is a larger fraction of a cheaper frame.
* **The API thunk zone contributes no blocks to the histogram at all** (0 hits in every window,
  software and OpenGL, CLI and browser): a thunk EIP is taken by `$win32_dispatch` and never
  becomes a decoded block, so the thunk share cannot be read out of a hot-block dump. The
  OpenGL figure above was measured at the host-import seam instead, by counting entries into
  `GLCommandStream.Encoder.prototype.call` — 2,788,344 over 151 presents, **18,466 GL host
  entries per frame**, which independently reproduces the re-note's 18,000-22,000. Scaled to the
  reported 320-present window that is ~5.9 M host entries against 378.9 M retired guest ops: one
  host GL call per 64 retired guest ops.
* The `--relax` and terminator tables for the browser windows were taken with
  `--relax=alias,partial,flags --max-ops=4096`, as above.

### Reproducing

```bash
S=/tmp/fold
# software, CLI (the anchor row, identical to the original quake2 row above)
node test/run.js --app=quake2_demo --args='+set vid_ref soft +map demo1' \
  --quiet-api --no-close --screen=800x600 --batch-size=20000 \
  --max-batches=999999 --max-seconds=55 --handler-hist --handler-hist-thread=0 \
  --handler-hist-start=3000 --handler-hist-stop=3100 \
  --hot-block-dump=$S/q2soft-hot.txt > $S/q2soft-run.log 2>&1
node tools/expr-fold-census.js --dump=$S/q2soft-hot.txt \
  --exe=test/binaries/candidates/quake-2-demo-installer/installed-extracted/Install/Data/quake2.exe \
  --modules-from=$S/q2soft-run.log --max-ops=4096 --relax=alias,partial,flags
```

The OpenGL dump needs a browser. Drive `index.html` in Chrome with
`--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`, set
`apps.quake2_demo.args` to `'+set vid_ref gl +map demo1'`, click the real Launch button, wait
for a non-flat frame layer, then over the app's own exports:
`e.reset_handler_hist(); e.set_handler_hist_enabled(1);` ... wait ... `e.set_handler_hist_enabled(0);`
and read the `(addr, hits)` u32 pairs at `e.get_hot_block_hist_base()` — the same array
`--hot-block-dump` writes — into a dump file. Take `--modules-from` from the page's own
`DLL: ... origBase=` console lines; they match the CLI's load addresses exactly
(`gamex86.dll` `0xc12000`, `ref_soft.dll` `0xd7e000`, `ref_gl.dll` `0xf9d000`).

The x87 section, the module attribution and the API-thunk line are printed by every run and
need no extra flag; the same numbers are in `--json=` under `x87`, `modules` and
`apiThunkHits`. `--thunk-base` / `--thunk-size` override the thunk-zone range.

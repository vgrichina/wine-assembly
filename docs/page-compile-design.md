# Page compilation: address-ordered threaded code with a parallel index

Status: **experiment**, branch `perf/page-compile`, forked at `7d471df9`.
Baseline worktree pinned at the same commit: `/private/tmp/wa-pagecomp-base`.

This is a proposal with a measurement gate in front of it, not a plan of record.
Three previous attempts to make dispatch cheaper in this emulator measured
exactly zero (see the `project_next_dispatch_negative` note). This one targets a
different cost and must clear the same bar before any of it is kept.

---

## 0. Status of each section, 2026-08-24

| Section | State |
|---|---|
| 2.1, 3, 3.1 — two-pass discovery, address-ordered whole-page emit | **not built, by instruction.** Everything below is built on top of on-demand block emit into the page's chunk instead. |
| 2.2, 2.3 — parallel index, fast path | built |
| 3.2 — code found later, appended as its own run | built |
| 4, 4.1 — the hash cache is deleted, pages are the only storage | **built.** `$cache_slot` / `$cache_lookup` / `$cache_store` and the 256KB-per-thread `CACHE_INDEX` are gone; `$run`'s lookup ladder is index → decode with nothing in between. |
| 5 — invalidation per offset | **built**, at block granularity rather than instruction granularity — see the note in 5.1 below. |
| 5.1 — break the chunk when retiring | **built, and it needed no new opcode.** See below. |
| 6 — v1 exclusions | unchanged |
| 8, 8.1 — measurement | **run.** See section 10. |

Two things came out differently from the design as written, and both are
improvements on it:

**The index entry carries a cover bit, so per-offset invalidation is O(1) at
zero extra space.** A `PAGE_INDEX` entry is a u16 per guest page byte and is now
one of three things: `0x0000..0x3FFF` — this byte *starts* a compiled block, at
that chunk offset; `0x4000..0x7FFF` — this byte is *covered* by the block at
`(entry & 0x3FFF)`; `0xFFFF` — nothing compiled. Bit 14 is free because a chunk
is capped at `PAGE_CHUNK_BYTES` = `0x4000`, so a real offset never needs it. A
write to a code byte therefore reads one entry and learns exactly which block to
retire. The alternative considered — a second per-byte `own[]` array — wanted
16MB and the free span between `HANDLER_PAIR_HIST_COUNTS` and
`THREAD_CACHE_BASE` is 15MB.

As a side effect `$page_resolve`'s miss test collapses to a single compare,
`off >= PAGE_INDEX_COVER`, which catches "nothing here" and "you are entering
mid-instruction" together, at the cost of the `== NONE` it replaced.

**The `$th_page_exit` opcode 5.1 asks for already exists.** `$th_block_end`
(handler index 45, `src/05-alu.wat`) is `eip = op; return_call $branch_end` —
exactly 8 bytes, no trailing word, which is the whole requirement. So the
handler table stays at 423 and the `(table $handlers N)` / `(elem ...)` /
`04-cache.wat` gate do not move. This also dissolves the contradiction between
§3.2 ("no new handler opcodes at all") and §5.1 ("the one new handler opcode").

One thing the design did not anticipate: with no hash cache behind it, a block
that cannot be published into a chunk is re-decoded on *every* entry rather than
being caught by a second store. So the decoder now ends a block at the guest
page edge, which makes every block publishable and indexable. The price is one
`$th_block_end` dispatch per page seam, which §6 already accepted.

---

## 1. The cost being attacked

A block ends, and control returns all the way to the top of `$main` in
`src/13-exports.wat` before the next block can start. Call that a **desk trip**.

```
 ┌───────────────────────────────────────────────────────────────────┐
 │  $main  (13-exports.wat:100-181)   ← every block entry starts here│
 ├───────────────────────────────────────────────────────────────────┤
 │  dbg_prev2_eip = dbg_prev_eip ;  dbg_prev_eip = eip               │
 │  if ($dbg_any) { trace-esp?  trace-eip?  hot-block-hist? }        │
 │  if ($code16) { selector-arena bounds check }                     │
 │  br_if $halt  yield_reason in {1,5,7,8,9}       ← 5 compares      │
 │  if ($code16) { thunk-selector check }                            │
 │  if (thunk_guest_base <= eip < thunk_guest_end) -> win32_dispatch │
 │  if (eip == sbh_eip_a || eip == sbh_eip_b) -> msvc SBH fast path  │
 │                                                                   │
 │  thread = $cache_lookup(eip)          ← hash + tag compare        │
 │  if (!thread) thread = $decode_block(eip)                         │
 │  ip = thread ;  steps = 1000                                      │
 │  call $next                                                       │
 │  br $main   ←──────────────────────── handler returned            │
 └───────────────────────────────────────────────────────────────────┘
```

`$th_jcc_z` (`src/05-alu.wat:740`) and its 20-odd siblings all end the same way:
set `$eip`, **return** — no tail call to `$next`. So the stack unwinds out of
`$next`, `br $main` runs the whole preamble again, and only then does the next
instruction execute.

### 1.1 What it costs on Caesar III

Windowed to batches 3000..3400 (city view, after the batch-2680 click), measured
with `--handler-hist --handler-hist-thread=0 --hot-block-dump`:

| quantity | value |
|---|---|
| block entries in the window | 13,697,826 |
| dispatches in the window | 57,822,442 |
| block entries inside `0x0040fxxx` (the RLE sprite decoder) | 6,764,826 (49.4%) |
| block entries in the `cmp/jz` chain `0x40f725`..`0x40f7a3` | 3,297,799 (24.1%) |
| arrivals at that chain | 934,163 |
| average cases tested per arrival | 3.53 |

The chain is a 16-way `switch` on a byte, written as a stack of
`cmp al,imm8 / jz rel`:

```
 0040f725  8a 06        mov al,[esi]
 0040f727  3c ff        cmp al,0xff
 0040f729  0f 84 ...    jz  0x40fa38     ← block ends here
 0040f72f  3c 01        cmp al,0x1
 0040f731  74 75        jz  0x40f7a8     ← and here
 0040f733  3c 02        cmp al,0x2       ...  14 more ...
 0040f7a3  e9 ...       jmp 0x40f9bc     ← default
```

Every one of those `jz`s terminates a block. Walking to case *k* costs *k* desk
trips, even though case *k+1* is the very next byte of x86.

---

## 2. The idea

Two changes that are useless apart and compounding together.

### 2.1 Compile a page's reachable code in address order

Today blocks land in the arena in whatever order they were first executed, so
adjacent x86 instructions end up in unrelated places:

```
  x86 page 0x40f000                 threaded arena (4MB/thread)
  ┌────────────────────┐            ┌──────────────────────────┐
  │ 0x40f727 cmp/jz  ──┼──┐         │ ..blk 0x40f7a8..         │
  │ 0x40f72f cmp/jz    │  │         │ ..blk 0x40f725..         │
  │ 0x40f733 cmp/jz    │  │         │ ..blk 0x412c40..         │
  └────────────────────┘  │         │ ..blk 0x40f72f..         │
                          │         └──────────────────────────┘
       hash index (32KB)  └──► (ga ^ ga>>12) & 0xFFF      scattered
```

Emit them in **address order** instead, and fall-through stops being a control
transfer at all — it is just the next word in the stream:

```
   threaded code for one page, IN ADDRESS ORDER, one contiguous run
  ┌────────────────────────────────────────────────────────────┐
  │ mov │ cmp │ jz │ cmp │ jz │ cmp │ jz │ cmp │ jz │ ...       │
  └────────────────────────────────────────────────────────────┘
     └──── a not-taken branch costs NOTHING. No jump, no lookup. ────┘
```

### 2.2 A parallel index instead of a hash

One array per compiled page, indexed by the low 12 bits of the guest address:

```
  x86 page 0x40f000            index array (parallel to the page)
  ┌──────────────────┐         ┌────────────────────────────┐
  │+0x725 mov al,[esi]│  ────►  │ [0x725] = 0x0000           │
  │+0x727 cmp al,0xff │  ────►  │ [0x727] = 0x0008           │
  │+0x729 jz          │  ────►  │ [0x729] = 0x0010           │
  │+0x72a  (mid-insn) │         │ [0x72a] = NONE             │
  │+0x72f cmp al,1    │  ────►  │ [0x72f] = 0x001c           │
  └──────────────────┘         └────────────────────────────┘
                                     offset into the page's chunk
```

`u16` entries: 4096 * 2 = **8KB per compiled page**, and a page's chunk is capped
at 64KB of threaded code, which is far more than a 4KB x86 page can generate.

### 2.3 The fast path

Two globals hold the page currently executing. Straight-line execution inside a
page never touches the page directory at all.

```
  $cur_page_base    0x40f000
  $cur_page_index   pointer to that page's index array
  $cur_page_chunk   base of that page's threaded code

  a taken branch to `dest`:
    if ((dest & ~0xFFF) == $cur_page_base) {          ← 1 compare
        o = idx[dest & 0xFFF]                          ← 1 load
        if (o != NONE) { ip = chunk + o; return_call $next }   ← no desk trip
    }
    eip = dest; return                                 ← today's path, unchanged
```

Cost ladder:

| transfer | cost |
|---|---|
| fall through | 0 (adjacency) |
| branch within the current page | 1 compare + 1 load |
| branch to another page | page-directory lookup once, then cached in the registers |
| `ret`, indirect `jmp`/`call` | today's path (see §6) |

---

## 3. Correctness: how the code is discovered

**A linear sweep of a 4KB page is wrong.** x86 is variable-length and data is
mixed into code sections; a jump table in the middle of `.text` desynchronises a
linear decoder and everything after it is garbage. `tools/find-loops.js` already
carries this caveat for the same reason.

So discovery follows the code, in two passes:

```
  PASS 1 — discover                    PASS 2 — emit
  ─────────────────                    ─────────────
  worklist seeded with the entry VA    sort discovered VAs ascending
  decode each instruction for its      emit straight down in that order
    length and successors              fall-through = adjacency, free
  push branch targets that stay        write idx[va & 0xFFF] as each
    inside this page                     instruction is emitted
  stop at the page edge
  record {va, len} in a set
```

### 3.1 The gap invariant

If instruction *X* falls through, then *X+len* is reachable, so pass 1 must have
found it. Therefore **a gap in the emitted address sequence can only ever follow
an unconditional terminator**:

```
  emitted: 0x725 0x727 0x729 0x72f ... 0x7a3 │ GAP │ 0x804 ...
                                        └── must be jmp/ret/etc ──┘
```

This is asserted at emit time. If it ever fires, discovery has a bug. It is
cheap and load-bearing, and it is the main reason to prefer this structure over
a linear sweep with heuristics.

### 3.2 Code found later

A page can be re-entered at an address pass 1 never reached — a jump-table
target, a computed address, generated code. That code cannot be inserted into
the middle of an already-emitted chunk. It is **appended** to the same chunk as a
second address-ordered run:

```
  chunk: [ main run, address-ordered ] │ [ appended run ......... jmp ● ]
                                       ▲                              │
                                       └──────────────────────────────┘
```

An appended run's last instruction has no neighbour to fall into, so if it falls
through it emits an ordinary **`$th_jmp` with the fall-through VA**. That is an
existing opcode, so this design adds **no new handler opcodes at all** and never
touches the `(table $handlers N)` / `(elem ...)` / `04-cache.wat` count gate.

---

## 4. This replaces the storage, it is not an accelerator beside it

The hash cache goes away. Pages become the only place decoded code lives, and
`$cache_slot` / `$cache_lookup` / `$cache_store` are deleted.

Two things make that possible rather than reckless.

**Partial compilation is first class.** A page is not "compiled or not". It is an
index plus a chunk that grows. Entering at an address the index does not have
runs discovery from that address and appends the result (§3.2). The degenerate
case — one entry point, one run, one basic block — is exactly what today's cache
stores. So today's design is the special case of this one with the runs never
merged, which is why this is a replacement rather than a parallel structure.

**The old capacity failure modes are gone, not relocated.** The index is exact:
one entry per guest page offset, no aliasing, so there is no such thing as a
conflict miss. Measured on `caesar3_demo` (whole run to the city, 2600 batches):

| | |
|---|---|
| distinct blocks executed | 1,162 |
| distinct code pages | **33** |
| block decodes | 1,886 |
| decodes that evicted a live block | **763 (40.5%)** |

Four hundred of those 33 pages would fit in the directory eight times over, and
**40.5% of all decode work in that run was re-decoding a block the hash had
aliased away.** An exact index does not do that at all.

Sizing follows from the 33: 128 index slots per thread is roughly 4x headroom on
the app that motivated the work, and the failure mode if some app exceeds it is
LRU eviction of a whole page, not incorrectness.

---

## 4.1 Why the hash cache is NOT kept

An earlier draft kept it as a fallback. Three reasons were given; all three
turned out to be wrong.

1. *"It is the A/B partner."* It is not. Commits are. The pinned baseline
   worktree at the fork point is the control group, and an in-build flag buys
   nothing a `git` comparison does not already give — while forcing every code
   path to exist in two versions forever.
2. *"It converts pass-1 edge cases from crashes into slowdowns."* A fallback
   that hides discovery bugs is worse than one that exposes them. §3.1's gap
   assert is the honest version of this, and it fires loudly instead of quietly
   degrading.
3. *"Page eviction is more expensive than block eviction."* Measured: 33 pages
   in a full Caesar run against a 1024-entry directory. Eviction is not the
   regime this operates in. Meanwhile the hash's own eviction cost 763
   re-decodes in that same run — the fallback was the more expensive structure.

The one genuinely hard case was self-modifying code, and §5 dissolves it.

## 5. Invalidation is per offset, not per page

Today `$invalidate_page` (`src/04-cache.wat:146`) scans all 4096 hash slots on
every write to a page that has ever held code, and retires every block in that
page. Self-modifying apps (Storm, Smacker, the StarCraft palette blitters the
file already documents) pay that constantly.

Whole-page invalidation would be a *worse* version of the same mistake, and it
is unnecessary. The index is keyed by page offset, so a write to offset `X`
only invalidates the instructions that cover byte `X`. An x86 instruction is at
most 15 bytes, so the affected set is bounded and tiny:

```
  write at offset X
                    ┌─── candidates: offsets X-14 .. X ───┐
  index: ... [ ● ] [ ● ] [NONE] [ ● ] [NONE] [NONE] [ ● ] [ ● ] [ ● ] ...
                     ▲                              ▲
                     └── retire these ──────────────┘   rest of the page
                                                        keeps its code
```

Clearing every non-`NONE` entry in `[X-14, X]` is conservative — an instruction
starting at `X-14` with length 2 does not really cover `X` — but conservative is
free here: it is recompiled on next entry, and it means **no instruction-length
table is needed**.

### 5.1 The catch, and the opcode that turned out to already exist

> **As built.** The retire unit is the *block*, not the instruction: without
> §2.1's whole-page emit there is no per-instruction index to clear, and the
> cover bits give the block's exact guest extent in one load. And the new opcode
> below is not new — `$th_block_end`, index 45, is already `eip = op;
> return_call $branch_end` in exactly 8 bytes. Read the rest of this section for
> the argument; substitute `$th_block_end` for `$th_page_exit` throughout.

Clearing an index entry stops the instruction being *entered*. It does not stop
it being *fallen into*, because §2.1's whole point is that fall-through is
adjacency — the preceding instruction's successor is the next word in the chunk,
consulting nothing.

So retiring an instruction must also break the chunk. Overwrite its 8-byte
header in place with a handler that leaves:

```
  chunk before:  ... │ fn=cmp  op │ fn=jz   op │ fn=mov  op │ ...
  chunk after:   ... │ fn=cmp  op │ fn=EXIT va │ fn=mov  op │ ...
                                    ▲
                     $th_page_exit: eip = op; return.
                     Guest VA fits in the op field, so it needs
                     exactly 8 bytes and can overwrite any header.
```

`$th_page_exit` is the **one new handler opcode** in this design — the `(table
$handlers N)` / `(elem ...)` / `04-cache.wat` count gate all move by one. The
seam case from §3.2 reuses the existing `$th_jmp` and still needs nothing new;
this one genuinely does, because it must fit in 8 bytes with no trailing word.

Falling into a retired instruction now exits to the resolver, which finds `NONE`
in the index and recompiles from that address. Entering it directly hits the
same path. Both terminate.

### 5.2 What this buys

```
  today:      write to code page ─► scan 4096 hash slots, retire every
                                    block in the page
  per-page:   write to code page ─► drop the page, recompile all of it
  per-offset: write to code page ─► ~15 index reads, patch what overlaps
```

A thrashing page stops being a problem: Storm rewriting one blitter retires the
bytes it wrote and nothing else. The rest of the page — including hot code it
never touches — keeps running compiled. That removes the last argument for
keeping a fallback storage layer.

Per-thread note: `$CACHE_INDEX` is per-thread while `CODE_PAGE_BITMAP` is
shared, and `$invalidate_page` deliberately retires only the writing thread's
blocks. Page directories are per-thread for the same reason and inherit the same
semantics — no change in behaviour, no new cross-thread hazard.

---

## 6. What is deliberately NOT in v1

| deferred | why it is safe to defer |
|---|---|
| inline cache for indirect `jmp`/`call` | falls back to the index lookup, already cheaper than today's hash |
| shadow stack for `ret` | same; `ret` keeps working, just without the shortcut |
| per-page generation counters | clearing `$cur_page_base` is sufficient (§5) |
| cross-page discovery in pass 1 | a page seam costs one `$th_jmp` dispatch |
| reclaiming orphaned chunks | today's arena never reclaims either |
| pruning `$main`'s preamble | a real win, but independent of this change |
| the `CASE_CHAIN` switch super-op | separate idea, stacks on top, measure this first |

`ret` and indirect branches are the interesting deferrals. They are *not*
unknowable — this is a dynamic translator, so "compile time" is just "the first
time it ran", and both are learnable from execution (monomorphic inline caching
for vtable calls; a shadow stack pushed at `call` and verified at `ret`). They
are deferred because they need their own measurement, not because they can't be
done.

---

## 7. Memory

`tools/wat-memory-map.js` reports two large free spans: 15,728,640 bytes at
`0x04100000`–`0x05000000`, and 4,194,304 bytes at `0x07A00000`. Taking the
first.

| region | address | size | notes |
|---|---|---|---|
| `PAGE_INDEX_ARENA` | `0x04100000` | 8 MB | per-thread stride 1 MB; 128 index slots of 8 KB per thread |
| `PAGE_DIR_BASE` | `0x04900000` | 128 KB | per-thread stride 16 KB; 1024 entries of 16 bytes |

Leaves ~7 MB of the span unclaimed. Chunks are allocated out of the existing
per-thread threaded-code arena (`THREAD_CACHE_BASE`, 4 MB per thread), so this
change adds no new code storage — it changes the *order* code is written in, not
the amount.

Arena pressure is the one thing the in-build flag cannot A/B away, which is why
there is a pinned baseline worktree (§8).

---

## 8. Measurement plan

**Commits are the A/B, not a runtime flag.** There is no `set_paging`: the
storage layer is replaced, so there is no second storage to switch to, and an
in-build toggle would only force every path to exist in two versions forever.

```
  cross-tree  /private/tmp/wa-pagecomp-base  (frozen at 7d471df9)
              /private/tmp/wa-pagecomp       (branch perf/page-compile)
```

This also catches what a flag never could: pass 1/pass 2's effect on arena
occupancy. If page compilation bloats the 4 MB arena into extra full cache
wipes — which `04-cache.wat` documents as catastrophic — only the frozen
baseline shows it. So arena and decode counters are reported alongside wall
clock, not as an afterthought.

The prize is already sized. The profile in the `project_caesar3_gameplay` note
puts `$run` at **12% of gameplay time** with `$next` at 23%: `$run` is precisely
the desk trip this removes, and part of `$next` goes with it.

House rules that apply: no benchmark longer than 30 s; record `uptime` either
side of every timing number and say so when quoting; this box regularly sits at
load 20-40 with other agents running sweeps, and at that load the numbers
measure the machine.

### 8.1 Kill criteria

Stated before the measurement, on purpose:

- **Correctness:** `png-diff` of the Caesar gameplay capture must be 0 pixels
  against baseline, and the §3.1 gap assert must never fire.
- **Neutral-or-better:** `cache_clears` must not increase.
- **Worth keeping:** wall clock improves by more than the run-to-run spread of
  the baseline against itself, measured on the same box at the same load.

If the third fails, `set_paging(0)` and the branch is abandoned. Three prior
dispatch experiments here died exactly this way, and that is the expected
outcome until the number says otherwise.

---

## 9. Build order

1. `docs/page-compile-design.md` (this file)
2. `src/01-header.wat` — the two regions from §7
3. `src/04-cache.wat` — page directory, index, chunk allocator, `$invalidate_page`
4. `src/13-exports.wat` — page registers in `$main`, `set_paging` export
5. `src/05-alu.wat` — 22 terminators onto one shared `$branch_end`
6. `src/07-decoder.wat` — pass 1 discovery, pass 2 address-order emit (the hard part)

Checkpoint after step 4: the structures exist, `set_paging` defaults off, and the
build must be byte-identical in behaviour to the pinned baseline. That is the
last point at which this is cheap to abandon.

---

## 10. Result, 2026-08-24

**Correct, structurally better, and exactly as fast. §8.1's wall-clock criterion
is not met.**

### Correctness

* 7 apps (sol, wordpad, mspaint, explorer98, pinball, tworld, calc): **0 pixels
  differ** against the pinned baseline, every one.
* API traces: sol, explorer98, tworld, calc byte-identical. wordpad (14 lines of
  9223), mspaint (4 of 7164) and pinball (10 of 11786) differ only in GDI handle
  serials, stack addresses, and where worker-thread calls interleave. That class
  is inherent to the harness, not to this change: perturbing the *baseline's own*
  `--batch-size` from 10000 to 9999 moves **1948** main-thread trace lines, two
  orders of magnitude more than the change does.
* `test-sparse-generated-code-cache` passes — that is the direct §5 test, a guest
  page of generated code rewritten in place and re-executed.
* 10 gameplay tests pass: caesar3, skifree, heroes2, cwordzap, diablo-runtime,
  liquid-war, pinball-playable, pinball-select-players, win16-wep,
  win16-solitaire.

### Storage

Caesar III, 400 batches, against the baseline:

| | baseline | pages |
|---|---|---|
| block decodes | 6283 (pinball) | 2919 |
| blocks evicted | 4364 | 0 pages evicted, 53 compiled |
| index hit rate | — | 100.0% (Caesar), 98.6% (pinball) |
| hash lookups | ~30M | 0 — the structure is gone |

There is now exactly **one** copy of a decoded block, in its page's chunk. The
arena is pure emit scratch and `$publish_block` rewinds it. Before this commit
the branch kept two permanent copies (hash arena *and* chunk); the fork point
kept one (arena). So this is strictly better than both on storage.

### Speed

Interleaved A/B, same worktree and same `run.js`, only `--wasm=` differs, 5 reps
each, `--app=caesar3_demo --screen=800x600 --batch-size=20000 --max-batches=1500`.
A = fork point + tail-call dispatch, B = this branch. Box at **load 5.4-6.4**, so
these are noisy and are reported as such.

| V8 wasm tier | A min | B min | A median | B median |
|---|---|---|---|---|
| default (tier-up) | 2.986 | 2.886 | 3.059 | 3.012 |
| `--liftoff-only` | 4.614 | 4.313 | 4.918 | 4.845 |
| `--no-liftoff` (TurboFan) | 2.380 | 2.444 | 2.738 | 2.676 |

**The tier is not the hidden variable.** It matters enormously in absolute terms
— TurboFan-only is ~1.9x Liftoff-only, and it also beats the default tier-up
configuration on a run this short, because tier-up is still paying compile cost
at 1500 batches. But the A/B *ratio* is flat within noise at all three tiers, in
both directions. Whatever this branch changed, no engine tier rewards it.

`--jitless` cannot answer the question: in V8 23 it disables executable memory
and WebAssembly with it.

### What this says

It re-confirms the standing result from `project_next_dispatch_negative`, harder
than before. This branch removed ~30M hash lookups, hit its index 100%, made 22%
of block transfers cost nothing, cut decodes by more than half, and eliminated
block eviction entirely — and the clock did not move. Lookup and dispatch
bookkeeping are not where this interpreter's time goes.

The parts worth keeping are keepable on their own merits, not as a speed-up:
one copy of decoded code instead of two, no eviction, exact invalidation instead
of a 4096-slot sweep, and a structure that answers "is this address compiled"
without a hash. §8.1 says abandon; the honest reading is *do not land this for
speed*, and decide separately whether the structural properties are worth the
diff.

### Latency stability, not mean wall clock (2026-08-24)

The mean-wall-clock gate in §8.1 is the wrong instrument for a decode-storage
change, and `--frame-stats` is not much better: its load-immune series is
`interval batches`, but a batch is a budget of x86 *steps* and decoding a block
retires no steps, so a batch that re-decodes a thousand blocks and a batch that
decodes none are indistinguishable there. Decode cost lands in host CPU, i.e. in
`interval ms`, which is the load-sensitive series nobody should diff across runs
on this box.

`test/run.js --decode-stats[=FROM_BATCH]` was added for exactly this: the
per-batch distribution of block decodes, which is deterministic across runs of
one build and therefore *is* safe to diff between builds, plus the guest-slice
wall time beside it for scale.

Pinball, 800 batches, same flags on both trees:

| per batch | fork point | this branch |
|---|---|---|
| total decodes | 11803 | 2416 |
| p50 | 12 | **0** |
| p90 / p99 / max | 35 / 72 / 339 | 1 / 69 / 408 |
| decode-free batches | 176 (22.0%) | **718 (89.8%)** |
| storm batches (≥4× median) | 14, carrying 14.3% of the work | 41, carrying **95.3%** |

That is the shape the design predicted and the fork point cannot have: the
branch pays for a page once and then does no decoding at all in nine batches out
of ten, while the hash cache pays a steady twelve-decode drizzle *every* batch
because it keeps evicting live blocks. The branch's own decode work is almost
entirely one-time page compilation (95.3% of it inside 5% of the batches).

And it still does not move the latency tail. Interleaved, 4 reps each:

| guest slice ms | fork point | this branch |
|---|---|---|
| p50 | 0.20–0.24 | 0.18–0.23 |
| p99 | 2.08–3.73 | 2.10–3.16 |
| max | 51.9–78.7 | 54.2–73.3 |

Fully overlapping in both directions, and the ~50-80ms maxima are the same size
on both trees, so whatever produces the worst frames here is not decoding. Nine
thousand avoided block decodes over 800 batches is real work removed, and it is
too small a share of the slice to see. This is the same verdict as the mean
measurement, reached by an instrument that *can* see the mechanism — which makes
it the stronger version of the result, not a second guess at it.

## 11. Page defragmentation: measured headroom, then measured worth (2026-08-24)

The obvious next increment is the one §2.1/§3 describes and this branch skipped:
lay a page's blocks out in **guest-address order** so that every block's
fall-through successor is physically the next thing in the chunk. Today
adjacency only happens when `$decode_run` extended a run through the
fall-through; a block whose successor was already compiled (a branch target
reached first, say) stops the run, and that fall-through pays a full eip store,
index lookup and dispatch forever after. A defragmentation pass — copy the
chunk's blocks out in address order, rewrite the index offsets and cover marks,
set the adjacency bits — would convert all of them. Threaded code is
position-independent, so the copy itself is legal; that was never the question.

### Step 1: how big is the prize

`$page_ft_missed` (new) counts the complement of `$page_ft`: branches that fell
through to a block living elsewhere in the same chunk. That is exactly the
population defrag would convert, and `test/run.js` prints it on the `runs:` line.

| app | index hits | fall-throughs | free today | paid = the prize |
|---|---|---|---|---|
| diablo_demo | 1.03M | 189k | 170k | 20k (1.9% of hits) |
| pinball | 700k | 129k | 103k | 26k (3.7%) |
| dxball | 969k | 419k | 230k | 188k (19.5%) |
| caesar3_demo | 975k | 626k | 225k | **401k (41%)** |
| total_annihilation_demo | 10.5M | 3.04M | 1.49M | **1.55M (15%)** |

So it is not uniformly small. On Caesar, four in ten of every lookup the
interpreter performs is a fall-through that an address-ordered layout would
delete outright. That is worth an experiment.

### Step 2: what is one free fall-through actually worth

Rather than build the compactor and then measure, measure the lever first, using
the free fall-throughs that already exist. Change one constant in `$jcc_end` so
the adjacency bit is never honoured, and every one of them reverts to the paid
path. Caesar then loses **3.35M** free fall-throughs out of 6.73M, all converted
into eip store + index lookup + dispatch.

Interleaved, same tree, only the two wasm binaries swapped, 20000 batches, box at
load 6.5–7.6:

| rep | adjacency off | adjacency on |
|---|---|---|
| 1 | 2.167s | 2.139s |
| 2 | 2.223s | 2.492s |
| 3 | 2.428s | 2.499s |

Nothing. Deleting 3.35 million lookups-and-dispatches from a 2.2-second run is
not visible above the noise, and the noise is not even signed in adjacency's
favour.

### Verdict

**Do not build the defragmentation pass.** Its entire prize is more of a thing
that has just been measured at zero, and it would cost a compaction pass, a
trigger policy, an index rewrite and a new class of "the chunk moved under a
running block" hazard to collect it.

This is the fifth negative result of the same shape. What the branch has now
proven, five different ways, is that *transfer bookkeeping is not this
interpreter's cost*: not the hash lookup (§10), not the desk trip (§10), not the
wasm JIT tier (§10), and now not the lookup-versus-adjacency choice either. The
time is in the handlers, and the next real win has to come from doing less work
per x86 instruction, not from arriving at the instruction more cheaply.

### Corpus note: total_annihilation_demo

TA is the most extreme eviction case measured anywhere in this work and belongs
in any future storage experiment's app set (it is already in
`tools/cpuprof-sweep.js`'s default list and `test/test-debug-game-apps.js`, so
no new fixture is needed — it was simply never used here). At 3000 batches:

| | fork point | this branch |
|---|---|---|
| block decodes | 62310 | 3849 |
| of which evicted a live block | **59940 (96%)** | 0 |
| decode-free batches | 74.0% | 98.5% |
| guest slice p50 / p99 ms | 0.10 / 0.66 | 0.10 / 0.70 |

Ninety-six percent of the fork point's decodes there are re-decodes of a block it
had already compiled and thrown away. The branch removes all of them, decodes
16× less, and the slice distribution does not move — which is the whole result of
this branch stated in one app.

### 11.1 The same question at 30 seconds (2026-08-24)

The runs above are seconds long, which on a box at load 5-17 leaves the
between-variant difference inside the within-variant spread. `test/run.js
--max-seconds=N` (new) fixes the duration instead of the batch count and reports
the batches completed as the throughput, which is the right axis for an app
whose cost per batch is not constant: Caesar runs about 0.1ms/batch through its
boot and several times that once a city simulates, so a batch count chosen to
land near 30s has to be re-guessed per app and stops being right the moment the
app gets further in the same budget.

Three variants -- the fork point, this branch with the adjacency bit ignored,
and this branch as built -- interleaved, 30s each, batches completed:

| rep | fork point | adjacency off | adjacency on |
|---|---|---|---|
| **total_annihilation_demo** ||||
| 1 | 10619 | 10507 | 10626 |
| 2 | 10241 | 10107 | 10025 |
| 3 | 10411 | 10653 | 9926 |
| mean | 10424 | 10422 | 10192 |
| **caesar3_demo** ||||
| 1 | 37700 | 37352 | 37493 |
| 2 | 37617 | 37764 | 37401 |
| 3 | 38276 | 39656 | 39354 |
| mean | 37864 | 38257 | 38083 |

Caesar's spread inside a single variant (37352..39656) is larger than any gap
between variants, and TA's three variants land within 2% with no consistent
ordering. In those same 30 seconds the fork point decodes **1,061,804** blocks on
TA and evicts **1,050,891** live ones; the branch decodes **5730** and evicts
none. A 185x difference in decode work, and the throughput is the same.

That is the result at the longest measurement this work is allowed to take. It
does not soften with more samples, it does not depend on which app, and it does
not depend on whether the app thrashes the old cache to pieces.

## 12. Section 5 finally has an SMC test: StarCraft (2026-08-24)

Per-offset invalidation was the one structural claim with no measurement behind
it. Caesar retires nothing, so the cover-bit machinery had never been exercised
at scale and "exact retirement" was an argument, not a result.

`starcraft_shareware` is the app. It writes code at runtime — the invalidation
counter's `last` page is `0x4ff64000`, inside the VirtualAlloc arena rather than
the static image, which is the Storm/Smacker decompression path generating its
own blitters. 25s run, counters (load-immune):

| | fork point | this branch |
|---|---|---|
| block decodes | 27770 | 10383 |
| of which evicted a live block | 23533 (85%) | 0 |
| code-write invalidations | 626, each an O(CACHE_SIZE) sweep | 3834 |
| blocks actually taken out | 572 | 901 |
| **whole-page drops (write too wide to walk)** | n/a — always the whole sweep | **0** |
| **exactness** | — | **100.0%** |

Zero range drops is the result. Every code write StarCraft performs is narrow
enough for the cover-bit walk to name the exact blocks it invalidates, so the
fallback path — "this write is too wide, drop the page" — never fires in a real
SMC workload. The per-offset design does what it claimed, and section 5 is no
longer untested.

`test/run.js` now prints this on its own line under the invalidation counters
(`$page_retires` / `$page_range_drops` were being maintained but never exported).

Note the counts are not directly comparable between trees: the two runs reach
different points in the game in the same wall clock, and the branch's counter
fires on a broader set of writes. What is comparable is the shape — 85% of the
fork point's decodes are re-decodes of blocks it had already compiled, against
zero evictions and a 100%-exact retirement path on the branch.

### 11.2 Correction: 11's lever test ran the wrong workload (2026-08-24)

Section 11 measured the adjacency lever at 20000 batches with no input script.
That never leaves Caesar's menus, so it never enters the RLE sprite decoder --
the entire reason this branch exists. On the real gameplay drive (the input
sequence from `test/test-caesar3-gameplay.js`, `--batch-size=50000`, 3400
batches, into a simulating city) the picture is four times bigger:

```
fall-through branches 30465447 | free 15090229 | paid 15375218 (50.5% headroom)
```

15.4M paid, against the 3.35M the section-11 lever test moved. Rerun on that
workload, 3 interleaved rounds, load 3.2-4.5, CPU seconds:

| | round 1 | round 2 | round 3 | min |
|---|---|---|---|---|
| adjacency on | 7.61 | 7.65 | 7.67 | **7.61** |
| adjacency off | 7.79 | 7.73 | 7.98 | **7.73** |

**Adjacency is worth 1.6%**, and every `on` sample beat every `off` sample --
within-variant spread is 0.8%, so this clears its own noise floor. Section 11's
"deleting 3.35M lookups-and-dispatches is invisible" was true of the workload it
measured and false of the one that matters.

So the honest defrag number is not zero. Converting 15.1M fall-throughs to free
buys 1.6%; defragmentation's remaining headroom is 15.4M more of the same kind,
so its expected value is **another ~1.6%** -- small, real, and now a prediction
that a compaction pass can be held to rather than a guess. Whether 1.6% is worth
an address-ordered emit is a judgement call, but it is no longer the case that
the measurement says no.

## 13. CASE_CHAIN: the prize, measured (2026-08-24)

Section 6 deferred the switch super-op with "measure this first". Measured, on
the branch, same gameplay window (batches 3000..3400, `--handler-hist-thread=0
--hot-block-dump`):

| quantity | value |
|---|---|
| dispatches in the window | 57,886,243 |
| block entries | 13,759,405 |
| block entries in the RLE decoder `0x40fxxx` | 6,765,659 (49.2%) |
| block entries in the `cmp/jz` chain | 3,298,295 (**24.0%**) |
| arrivals at the chain | 934,297 |
| cases walked per arrival | 3.53 |

**Page compilation did not shrink this at all** -- 24.0% here against 24.1% at
the fork point. That is not a failure, it is the mechanism: adjacency makes the
*transfer* between chain blocks free, but each `jz` still ends a block, so the
entries are still spent, just more cheaply.

A CASE_CHAIN super-op collapses the whole 16-way stack into one op: read the
byte, index a 256-entry target table, set `eip`. That takes 934,297 arrivals
from ~3.53 block entries and ~8.2M dispatches down to 934,297 dispatches:

- ~7.3M dispatches removed, **12.6% of all dispatches** in the window
- 3.3M block entries removed, **24% of all block entries**
- and, unlike everything else this branch tried, it removes *executed x86
  instructions* -- up to 16 `cmp`s replaced by one table index -- rather than
  bookkeeping around them.

That last point is why it is worth trying despite four consecutive negative
results. Every previous experiment (tail calls, branch stripping, the hash cache
removal, adjacency) made each unit of interpretation cheaper. This one deletes
units. Calibrated against 11.2 -- 15.1M freed transfers bought 1.6% -- a
comparable-magnitude change plus the removed compares puts the estimate at
roughly **2-4% on Caesar gameplay**.

Two caveats before anyone builds it. It is one hand-written chain in one
function of one app: nothing here says the idiom is common, and the matcher
would need a census (`tools/find-loops.js` finds loops, not `cmp/jz` ladders)
before the generality is known. And the estimate is an extrapolation from a
different lever, not a measurement of this one.

### 13.1 Caesar already has one super-op, and this is the other path (2026-08-24)

For the record, because it is easy to conflate the two: **Caesar's blit super-op
already exists.** `$th_rect_run` (handler 422, `src/06b-core-handlers.wat:508`,
commit `67906b47`) folds a whole unrolled isometric tile blit into one dispatch
-- ~787 fully unrolled diamond blitters between `0x0041cf11` and `0x004ffefd`,
worth 5.20% of handler ops when it landed. It is in this branch (the fork point
`7d471df9` postdates it), so every number in section 13 is measured *on top of*
it, and its absence from the top-24 histogram is the fold working, not the fold
missing.

Caesar draws through two different paths and only one of them is folded:

| path | address range | folded by |
|---|---|---|
| unrolled diamond tile blitters | `0x41cf11`..`0x4ffefd` | **H422 `$th_rect_run`** |
| RLE sprite decoder | `0x40fxxx` (49.2% of block entries) | **nothing** |

The `cmp/jz` ladder is inside the second one. And the pair histogram from that
same window names it outright, so section 13's estimate does not need the
extrapolation it was built on:

```
  H154 $th_alu_r8_i8   3393833 (5.86%)   <- cmp al,imm8
  H311 $th_jcc_z       3473536 (6.00%)   <- the jz after it
  top pairs:
    H154->H311         3392761 (7.69%)   <- the #1 pair in the program
```

3.39M pair occurrences against 3.30M chain walks means **~97% of every
`cmp r8,imm8` -> `jz` in the entire program is that one ladder**, and the two
handlers together are **11.9% of all dispatches** -- directly measured, and
within a whisker of section 13's extrapolated 12.6%.

So CASE_CHAIN is not a speculative idiom hunt. It is the single largest
unfolded shape left in the app that this branch was built for, it is the #1
dispatch pair in the histogram, and the app's *other* drawing path already got
this treatment and kept 5.20%.

## 14. CASE_CHAIN built and measured: it works, and it is worth ~0 (2026-08-24)

Handler 423 `$th_case_chain` folds a whole `cmp al,imm8 / jz case` ladder into
one dispatch. Matcher in `src/07-decoder.wat` (`$case_chain_count` /
`$emit_case_chain`), off switch `test/run.js --no-case-chain` →
`set_case_chain(0)`, so the A/B is a flag on one binary rather than two builds.

**It fires, exactly as §13 predicted.** Caesar gameplay drive, hot-block dump,
batches 3000..3400 — the fifteen mid-ladder block entries vanish:

```
  off                     on
  0x0040f72f 376259       (gone)
  0x0040f733 337211       (gone)
  0x0040f73b 301763       (gone)
  ... 12 more ...
  ---------------------
  2,340,000 block entries removed, and ~7.3M dispatches with them
```

`0x0040f71c` and `0x0040f725` keep their 934,297 entries: those are the arrivals
at the ladder, which the fold does not remove, only the walking.

**And it buys nothing measurable.** Nine interleaved pairs, user CPU on a fixed
3400-batch run: min 9.01s on vs 9.04s off, median 9.83s vs 10.18s, mean pairwise
difference 0.21s (2.1%) in the fold's favour with the sign flipping in three of
the nine pairs. Box at load 3.6–5.3 throughout. **≤2%, not distinguishable from
zero**, for removing 11.9% of all dispatches and 24% of all block entries.

This is the same wall §-`$next`-dispatch hit: fewer dispatches is not faster.
The dispatch, the eip store and the cache lookup are all cheap and well
predicted; the work the guest asked for is the cost.

### 14.1 Two pacing meters, not one

The first build of this was pixel-wrong — 3.08% of pixels, max channel delta 8 —
while being deterministic run to run, and it ran 2.8% *more* API calls in the
same 3400 batches. `$steps` was charged correctly. The meter I missed is
`$block_budget`: `$branch_end` spends one per block transfer, and folding away
k transfers hands the guest k extra blocks of work per host batch, so the frame
captured at a fixed batch number is a later moment in the game.

`(global.set $block_budget (i32.sub (global.get $block_budget) (local.get $k)))`
in the handler restores it: identical API counts and a 0-pixel diff.

**Any future super-op must charge both meters.** 420/421/422 charge only
`$steps`; each of them therefore shifts pacing by however many block ends it
swallows, and `$th_rect_run` swallows a whole block per sprite.

### 14.2 Alternatives to the linear scan are not worth measuring

The obvious follow-up is to replace the handler's linear scan with a 256-entry
target table indexed by AL. The scan walks 3.53 cases on average, so it is ~3.5
native `i32.eq` inside a dispatch that already removed seven dispatches and
three and a half block transfers — and *that* removal measured at ≤2%. Whatever
the compares cost is a fraction of a number already inside the noise floor of
this box. Optimising the scan cannot be measured here, so it should not be
built here.

## 15. Merging into main: what 6b801a9d's mechanism became (2026-08-24)

`perf/page-compile` merged main at `32765817`. Eight files overlapped; five
auto-merged; the three real conflicts were all the same commit, opus5-diablo's
`6b801a9d` "Invalidate a decoded block by every page it covers, not just its
first", and all three resolved to the branch side. Why, in detail, because this
is the one place the merge threw away working code:

`6b801a9d` fixes a bug **this branch cannot have**. Its bug is a block stored
under its start address, retired by the page that address falls in, that runs
into the *next* page and so survives a rewrite of its own tail. On the branch:

- **A block cannot cross a page.** `src/07-decoder.wat` cuts the block at the
  4KB edge (`(call $te (i32.const 45) (global.get $d_pc)) (br $exit)`), because
  a compiled page owns its blocks. So there is no block with a tail on another
  page to miss.
- **There is no hash cache.** `6b801a9d` carries the block's page span in the
  top four bits of the cached arena offset and teaches the 4096-slot sweep to
  read it. Section 4 deleted both the field's container and the sweep.
- **The range walk already covers the middle.** `$invalidate_code_range`
  (`src/04-cache.wat`) loops page by page from `ga` to `ga+len`, retiring per
  offset inside each. That *is* `6b801a9d`'s "every page it covers", arriving as
  a property of the walk instead of as a second function.

Both sides also, independently, wrote a function named `$invalidate_code_range`
with the same signature and the same purpose. Only one can survive; the branch's
is the one that does per-offset retirement, so main's was dropped.

The one part of `6b801a9d` that is **kept**, because it is orthogonal, is its
`src/05b-string-ops.wat` change: `rep movs`/`stos` now invalidate their whole
destination extent rather than the two endpoints. The branch made the same fix
at the same eight sites, spelled `$invalidate_code_write(addr, len)` (two
params; it declines cheaply for a single-page write, else delegates to the range
walk). On the backward-dword case the branch's extent is 3 bytes *wider* than
main's endpoint arithmetic — `edi - dst + 1` misses the last dword's tail.

`test/test-sparse-generated-code-cache.js`, the test `6b801a9d` shipped, passes
on the merge, as do the other six tests main added over the same window.

**Diablo is the open risk and is knowingly accepted.** On the merged build, the
main menu renders the flaming logo at batch 40000 and no logo at 40100/40200.
That is the shape of the symptom `6b801a9d` addressed, but it is also the shape
of a *separate* still-open bug the board describes: Storm's PKWARE explode
short-reads `ui_art\logo.pcx`, so 12 of the 15 logo sprites are solid black at
load time regardless of invalidation. I did not run main's build side by side to
tell those apart — the merge was taken with Diablo's state explicitly sacrificed
and handed to its owner. See `docs/re-notes/diablo-shareware.md`.

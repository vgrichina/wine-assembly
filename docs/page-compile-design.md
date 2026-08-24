# Page compilation: address-ordered threaded code with a parallel index

Status: **experiment**, branch `perf/page-compile`, forked at `7d471df9`.
Baseline worktree pinned at the same commit: `/private/tmp/wa-pagecomp-base`.

This is a proposal with a measurement gate in front of it, not a plan of record.
Three previous attempts to make dispatch cheaper in this emulator measured
exactly zero (see the `project_next_dispatch_negative` note). This one targets a
different cost and must clear the same bar before any of it is kept.

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

### 5.1 The catch, and the one new opcode

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

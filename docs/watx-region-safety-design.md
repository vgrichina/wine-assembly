# Memory regions in WATX — deleting the magic numbers

Milestone 6 of [docs/watx-migration-plan.md](watx-migration-plan.md). This
document decides the feature before the bulk of it is written. Step 1
(`region.declare-fixed`, the whole map declared, the compiler validating it) has
landed; everything from §4 on is the design for the rest.

## 1. The goal

**Each fixed base address appears exactly ONCE in the tree — in its region
declaration.** Every other occurrence — WAT arithmetic, JS mirrors, tools,
tests, the docs table — references it symbolically or reads generated output.

Validation is not the goal. Validation is the safety net that makes the cleanup
survivable. The goal is that the map becomes *data*: a thing you can move,
because nothing else knows where it was.

That is a real distance from where the tree is. `tools/region-census.js`
(§7) counts **648 raw literals** that are a second copy of the map, and
**171 of the 221 `(data ...)` segments sit at absolute addresses inside no
declared region at all**. Every one of those is a nail holding the map in
place.

### What guarantees exist today

| Guarantee | Who provides it | What it cannot see |
|---|---|---|
| Regions do not overlap | `test/test-wat-memory-map.js` (build gate) | anything not spelled `(global $X i32 ...)` + `(global $X_SIZE i32 ...)` |
| Free-space / collision queries | `tools/wat-memory-map.js` (on demand) | same |
| WAT↔JS constant agreement | `tools/check-wat-js-constants.js` (build gate) | a JS copy whose surrounding code was reshaped until the regex stopped matching |
| An address is inside its region | **nobody** | — |
| The map could be changed at all | **nobody** | — |

The last two rows are the feature. `(i32.const 0x07F60000)` written in two
files is the same token to every tool we have, and
`(i32.add (global.get $DX_OBJECTS) (i32.mul (local.get $slot) (i32.const 0x400)))`
with a `$slot` past `$DX_MAX` is a silent write into `COM_WRAPPERS`.

## 2. This is one family, not a new subsystem

The vendored compiler already carries almost everything Milestone 6 needs:

| Facility | Where | State |
|---|---|---|
| `layout` declarations, hard-error unknown layout/field | `compiler-codegen.js` ~26-62, ~521-547 | complete |
| `load.field` / `store.field` / `load.elem` / `store.elem` / `size-of` / `offset-of` / `elem-addr` | `compiler-codegen.js` ~1121, 2544+ | complete |
| `defmacro` | `compiler-stages.js:43` | complete |
| region family: `region.declare-static` / `-bump` / `-rc`, `region.alloc`, `region.enter/exit` | `compiler-codegen.js:925, 2533` | complete |
| a region symbol resolves to its base in operand position | `compiler-codegen.js:1320-1327` | complete |

**Reused verbatim:** the top-level collection scan; the `(size N)` spelling;
`regionBase`, the name→base map, and the bare-symbol resolution it feeds — a
declared region's `$NAME` in operand position already emits `i32.const <base>`
with no new code. And `layout` + `load.field`/`store.field`/`size-of` carry
Milestone 6 step 3 entirely: a WND record becomes a `layout`, its base stays the
region symbol, and

```wat
(load.field WndRecord hwnd (elem-addr WndRecord $WND_RECORDS (local.get $slot)))
```

is already a compilable sentence. **Layouts-on-regions needs no compiler work
at all**, only source conversion.

**Rejected — `region.declare-static` is FORBIDDEN for this map**, as the
migration plan requires: the `staticCursor` allocation in `region.declare-static`,
which
lays regions out from `STATIC_REGION_BASE = 1024` and would put Wine's map on
top of the decoder scratch, the window tables and `NULL_SENTINEL`. A
`declare-fixed` region contributes nothing to `staticCursor` or `DATA_BASE`, so
it cannot move the bump heap or the interned-string pool (pinned by a test).

**Why not parallel machinery:** two grammars for one concept, two name maps, two
places to look when an address is wrong, and a permanent fork between what the
vendored compiler understands upstream and what this repo understands. The
provenance seal exists to keep the vendored copy explainable as a copy.

## 3. The core principle: allocated by default

**A region is compiler-allocated. A fixed pin requires a documented reason, and
there are exactly two admissible reasons:**

- **(a) guest-visible ABI** — the value leaks into a pointer the guest itself
  holds and does arithmetic on.
- **(b) an alignment or derivation law** — the region's own arithmetic requires
  a property of the address (a power-of-two stride, a mask, a page alignment)
  that must be stated and held.

Chasing that test through the real map is what makes it useful, because most of
the map fails it:

- **Nothing below `GUEST_BASE` needs to be pinned.** The string constants, the
  API hash table, the window/class/control tables, PE staging, the DLL table —
  every one of them is emulator-private state that the guest reaches only by
  forming a pointer below its own ImageBase, which
  `docs/memory-map.md` already describes as "safe by convention". Their
  addresses are historical hand-placement. **Allocate them.**
- **`GUEST_BASE` itself is the single parameter of `$g2w`.** It could float:
  everything downstream is `guest - image_base + GUEST_BASE`. It is pinned today
  because a dozen JS files hold the number, which is a §6 problem, not a §3 one.
- **The guest stack, heap and thunk zone are anchored by their GUEST VAs, not
  their wasm offsets.** The guest sees `ESP` values, heap pointers and thunk
  EIPs; that is the real ABI. So the declaration must be able to say *"this
  region's wasm base is `g2w(<guest VA>)`"* — a **derived** base, not a magic
  wasm offset (§4.3).
- **Thread cache, page arenas and the block index need laws, not addresses.**
  Their arithmetic is `base + tid * stride` with a power-of-two stride and a
  mask derived from a capacity. **Allocate with constraints** (§4.2) rather than
  pin; the constraint is the thing that actually has to hold.

So `region.declare-fixed` stays in the family for the rare justified pin — and
as the migration's bridge (§9) — but the target state is allocation.

## 4. Compiler features

### 4.1 Allocated declarations, and a DETERMINISTIC allocator

```wat
(region.declare $WND_RECORDS (size 0x1800) (align 0x100)
                (owner "per-window records, 256 x 24B"))
```

Reproducible builds are non-negotiable: the same source must yield the same
layout, or nothing downstream — byte identity, the shake test, a diffable
`combined.wat` — means anything.

**Algorithm: declaration-order first-fit above a floor.**

1. Regions are ordered by the position of their declaration in the module's
   top-level form sequence — the same order `src/main.watx` fixes and
   `tools/check-wat-manifest.js` gates. Not by name, not by size: those change
   under an unrelated rename or a capacity bump.
2. A cursor starts at `ALLOC_FLOOR`, declared once per module:
   `(region.floor 0x00001000)`. Wine's floor is `0x1000` — below it live
   `NULL_SENTINEL` at `0xF0` and the decoder scratch, which are pinned by
   `$g2w`'s sink behaviour.
3. Each region is placed at the first cursor position at or above the cursor
   that satisfies its `(align N)`, and the cursor advances past it. First-fit
   *above the cursor*, never backfilling into an earlier gap — backfilling makes
   the layout depend on the size history of every earlier region.
4. Pinned (`declare-fixed`) and derived regions are placed first, at their stated
   addresses, and are treated as obstacles the cursor skips.

**Reproducing today's map exactly.** Stage A of the migration must not move a
byte, so the allocator has to be able to land on the current layout. Two
mechanisms, and the design commits to both:

- **Declaration order.** `src/00-regions.wat` is already emitted in ascending
  base order, so first-fit reproduces the current sequence wherever the gaps are
  incidental.
- **Explicit gaps.** Where the current map has a deliberate hole,
  `(region.gap 0x00040000 (reason "retired CACHE_INDEX_BASE, page compilation"))`
  advances the cursor and *documents why*, instead of a mystery the next reader
  has to preserve out of fear. The gaps are load-bearing today precisely because
  nobody can prove they are not.

`node tools/region-alloc.js --diff` prints allocated-vs-current for every region
and must be empty before stage A can ship. If a gap cannot be explained, it is
declared with `(reason "unknown, preserved")` — an honest marker beats a silent
constant.

### 4.2 Constraints

```wat
(region.declare $THREAD_CACHE_BASE
  (size 0x02000000) (align 0x00100000)
  (stride $THREAD_CACHE_STRIDE (count 8))   ;; size == stride * count, exactly
  (size-is-power-of-2)
  (mask $CACHE_MASK)                        ;; mask == (size / entry) - 1
  (owner "8 x 4MB per-thread decoded-code arenas"))
```

Each clause is a *law* the compiler enforces and, where the value is derived,
**emits nowhere** — the mask stays an ordinary global whose value is checked
against the region, until step 2 lets `(region.mask $R)` replace it. This is the
answer to the `PAGE_DIR_ENTRIES 1024` / `PAGE_DIR_MASK 1023` pair and to
`DLL_TABLE_SIZE == DLL_TABLE_CAPACITY * 32`, relationships
`test/test-wat-memory-map.js` today asserts by hand, one `assert` per pair.

### 4.3 Derived bases

```wat
(region.declare-derived $GUEST_STACK
  (base (g2w 0x07100000))       ;; the guest VA is the ABI; the wasm offset follows
  (size 0x00100000) (align 0x1000)
  (owner "1MB main stack; the guest holds these as ESP"))
```

`g2w` here is a compile-time function of the module's own `$GUEST_BASE` region
and the image base, not a call. It makes the *guest* address the written
constant — which is the one that is actually an ABI — and lets the wasm offset
follow whatever `GUEST_BASE` ends up being. Today the relationship is written
backwards: the wasm offset is the constant and the guest VA is derived at
runtime.

### 4.4 Region-relative data segments

This is the largest single anchor and it is invisible from the WAT side today.
Measured over the real tree: **221 `(data (i32.const 0x…) "…")` segments, of
which 171 are at absolute addresses inside no declared region at all** — the
string-constant pool from `0x100` upward, which has no `_SIZE` global and is
therefore invisible to `wat-memory-map.js`, `test-wat-memory-map.js` and the
declaration set alike. The other 50 sit inside declared regions
(`GDI_BITMAP_FONT_STATIC` 19, `CLASS_NAME_STRINGS` 12,
`TT_FONT_STRING_STORAGE` 8, and singletons).

So: an absolute data offset pins the map forever, and most of them are not even
in a region. The design needs

```wat
(data (region.addr $CLASS_NAME_STRINGS 0x40) "Button\00")
```

— an active data segment whose offset is a region-relative constant, checked
against the region's extent at compile time and emitted as the same
`i32.const` the absolute form emits. Plus a declared home for the string pool
itself (`$STRING_CONSTANTS`), which is the prerequisite: a segment cannot be
region-relative until its region exists.

`tools/check-data-strings.js` and `tools/wasm-data.js --overlaps` keep working
unchanged — they read the *compiled* offsets, which do not change.

## 5. The symbolic spelling of every pattern

If a pattern cannot be written symbolically, its magic number survives. The
inventory, with the spelling each one converts to:

| # | Pattern | Today | Symbolic spelling |
|---|---|---|---|
| 1 | Bare base | `(global.get $DX_OBJECTS)` / `(i32.const 0x07F60000)` | `$DX_OBJECTS` |
| 2 | Base + constant offset | `(i32.add (global.get $X) (i32.const 0x40))` | `(region.addr $X 0x40)` — one `i32.const`, bounds-checked |
| 3 | Base + index × stride | `(i32.add (global.get $WND_RECORDS) (i32.mul $slot (i32.const 24)))` | `(elem-addr WndRecord $WND_RECORDS $slot)` — stride is `size-of` the layout |
| 4 | Per-thread partition | `(i32.add (global.get $THREAD_CACHE_BASE) (i32.mul $tid (i32.const 0x400000)))` | `(region.slot $THREAD_CACHE_BASE $tid)` — stride from `(stride … (count N))`, so the count is checked too |
| 5 | Region end / limit test | `$THREAD_END`, `$THUNK_END` — *separate globals* holding `base + size` | `(region.end $X)`; the twin global is generated or deleted |
| 6 | Mask from capacity | `$PAGE_DIR_MASK 1023` beside `$PAGE_DIR_ENTRIES 1024`; `$CACHE_MASK` | `(region.mask $X)` — derived, so it cannot be off by one |
| 7 | Capacity ↔ extent | `DLL_TABLE_SIZE == DLL_TABLE_CAPACITY * 32`, hand-asserted | `(stride 32 (count $DLL_TABLE_CAPACITY))` on the declaration |
| 8 | Guest↔wasm translation | `guest - image_base + 0x12000` in `$g2w` **and in five JS files** | `(region.addr $GUEST_BASE …)` in WAT; the generated JS mirror (§6) in JS |
| 9 | Window range test | `eip >= thunk_guest_base && eip < thunk_guest_end` | `(region.contains $THUNK_BASE x)` over a derived region (§4.3) |
| 10 | Fixed data segment | `(data (i32.const 0x11300) "…")` | `(data (region.addr $STRING_CONSTANTS 0x…) "…")` (§4.4) |
| 11 | JS copy | `const DX_OBJECTS_WA = 0x07F60000` + a regex in `check-wat-js-constants.js` | `require('./regions.generated').REGIONS.DX_OBJECTS.base` (§6) |
| 12 | Docs table | the hand-drawn diagram in `docs/memory-map.md` | generated from the declarations (§6) |

Patterns 4-7 and 9-10 are the ones that need new spellings; 1-3 exist already.
Pattern 12 is why `docs/memory-map.md` currently still draws "Cache indexes
(256KB)" at `0x07152000`, a region `src/01-header.wat:1460` says page
compilation retired — a hand-drawn map goes stale silently.

### 5.1 What the survey found that changes the design

A file-by-file survey of how these addresses are actually used turned up six
things the naive plan would have walked into.

**The `offset=` memarg is a second, invisible constant addend.** Base-plus-offset
is written two ways, and only one of them looks like arithmetic:

```wat
(i32.load (i32.add (global.get $PE_STAGING) (i32.const 0x3C)))          ;; 08-pe-loader.wat:16
(i32.load offset=4 (global.get $DX_VTBL_REGISTRY))                      ;; 09a8-…-directx.wat:210
```

No region check sees the second form today and none of §5's spellings covers it
either. `(region.addr $R 0x…)` must therefore be usable *as the memarg base*
with the `offset=` folded in and checked — otherwise converting the visible adds
just pushes the debt into the memarg.

**The stride is usually a bare literal even when a global exists.** `WND_RECORDS`
is addressed as `base + slot * 24` (`09c0-window-table.wat:12-13`) while
`$WND_RECORDS_SIZE 0x1800` = 256×24 sits unasserted next to it; `DX_OBJECTS`
writes `32` inline (`09a8-…-directx.wat:606`) although `$DX_ENTRY_SIZE 32`
exists eight lines away. There is also an **inverse** shape — address back to
index, `(i32.div_u (i32.sub $entry $DX_OBJECTS) (i32.const 32))` at `:610` — so
pattern 3 needs a `(region.index $R addr)` companion, not only `elem-addr`.

**Per-thread partitioning does not use its own globals.**
`src/13-exports.wat:2665-2667` computes the thread cache partition from the raw
literals `0x05000000` and `0x400000`, not from `$THREAD_CACHE_BASE` and not from
any stride global (none exists). `$PAGE_DIR_STRIDE` and `$PAGE_INDEX_STRIDE` do
exist and are used — and none of the three `stride × 8 == _SIZE` relations is
asserted anywhere. `THREAD_RPC`'s partitioning has no WAT arithmetic at all: it
lives only in `lib/guest-rpc.js:133`.

**A structural obstacle: a mutable global's initializer cannot `global.get` a
module-defined global.** That is why `$THREAD_BASE`, `$THREAD_END`, `$PAGE_DIR`,
`$PAGE_INDEX` and `$thread_alloc` are declared with literal initializers
(`01-header.wat:1530,1534,1539,1540,2378`) that duplicate the map. A constant
region symbol *is* a `i32.const`, so `(region.slot $R 0)` can be a legal
initializer where `(global.get $R)` cannot — but the design must say so
explicitly, because "just use the global" is the obvious fix and it does not
compile.

**Region ends are spelled three different ways, and one of them is another
region's base.**

- a redundant twin global: `$THUNK_END 0x07152000` alongside
  `$THUNK_BASE 0x07112000` + `$THUNK_BASE_SIZE 0x40000` — the end is stated
  twice and the two are never checked against each other;
- a mutable end recomputed at init, consumed as `end - slack` with **four
  different bare slack literals** (`4096`, `16384`, `16384`, `32768` at
  `04-cache.wat:870,241` and `07-decoder.wat:3026,5353`);
- and, at `10-helpers.wat:592-596`, a bound test against
  `(global.get $PAGE_INDEX_ARENA)` — *the next region's base used as this
  region's limit*, with a comment explaining that `THREAD_CACHE_BASE` was the
  wrong choice. Under an allocator that shape is not merely ugly, it is wrong:
  it silently encodes an adjacency the allocator is free to change.
  `(region.end $R)` is the conversion, and this is the single clearest argument
  for the whole feature.

**`$g2w`'s direct window is a union of regions with no name.** Its upper limit
is the bare literal `0x8000000` in three places (`03-registers.wat:81,177,179`),
which is `$VIRTUAL_BACKING_BASE` spelled as a number. The window covers
`GUEST_BASE` + stack + thunks + PE staging + the DLL tables, so it needs a
declared *span* — a region whose extent is the union of its members
(`(region.declare-span $DIRECT_WINDOW (covers $GUEST_BASE $GUEST_HEAP_BASE …))`)
rather than an unnamed constant. The DIB window next to it is already fully
symbolic (`03-registers.wat:86-92`) and is the model to copy. The thunk-zone EIP
test is replicated in ~10 places with a bare `8` for the thunk stride.

**Precedents that already exist and should be generalized, not reinvented.**
`test/test-wat-memory-map.js:342` already asserts by regex that the treeview
table uses `$TV_TABLE` and not a hard-coded `0x9000` — a one-off of exactly what
`region-census.js --gate` does for every region. And that file's
`highFixedAliases` allow-list (lines 200-241, 40 entries) is precisely what
`(within $R)` plus `region.addr` replaces: those are sub-fields declared as
absolute literals — `$D3DIM_UNIMPL_EXEC_OP 0x07FEB000` inside `$D3DIM_AUX`, the
whole hand-packed `0x07F0CExx` page — flattened at declaration so no gate can
see the containment.

### 5.2 Where the worst concentrations are

The survey's honest estimate is **~45 true magic-address sites in WAT**, not the
several hundred a naive grep reports (window styles like `0x04000000` and colour
masks like `0x00FFFFFF` fall inside `$GUEST_BASE`'s 60 MB span). They cluster:

- **`src/10b-gdi-font.wat` (19) and `src/10f-gdi-dc.wat` (6)** — the same six
  font-name addresses inside `$GDI_BITMAP_FONT_STATIC` (`0x07F0A520`,
  `0x07F0A528`, `0x07F0A534`, `0x07F0A53C`, `0x07F0A564`, `0x07F0A5A0`),
  duplicated across two files with no shared symbol.
- **`src/09a8b-handlers-opengl.wat` (4)** — the GL vendor/renderer/version
  strings at `0x07F0BF60`+, whose `(data …)` segments are declared in
  `01-header.wat:947-950`. The literal is written in one file and the data in
  another: exactly what §4.4's region-relative data segments fix.
- **`src/09ab-handlers-d3dim-core.wat` (4 at declaration level)** — sub-fields
  of `$D3DIM_AUX` declared as absolute constants.
- **`src/13-exports.wat` (3), `src/03-registers.wat` (3),
  `src/01-header.wat` (5 initializers)** — the per-thread and `$g2w` literals
  above.

**And the mask/stride debt is larger and more dangerous than the address debt.**
Fourteen derived globals have no assertion tying them to the extent they come
from — `$PAGE_DIR_MASK 1023` beside `$PAGE_DIR_ENTRIES 1024`, `$CS_MASK 63`
(which is *not* `$CS_TABLE_ENTRIES 256` minus one), `$PAGE_INDEX_SLOTS 128`,
every `$GDI_*_COUNT × _STRIDE` vs its `_SIZE`, `$WND_RECORDS_SIZE` vs stride 24,
`$THREAD_CACHE_BASE_SIZE` vs the 8 threads. Two idioms are in use: a mask stored
as a literal, and a mask computed at the use site as `SLOTS - 1`
(`10c-truetype.wat:3144,3160`, `10g-gdi-raster.wat:3828`). Only the second
cannot drift, and `(region.mask $R)` makes it the only one available. One
derivation has already rotted all the way through: `tools/cache-slots.js:37-49`
still greps `$CACHE_MASK` out of `src/01-header.wat`, and that global no longer
exists.

## 6. Generated mirrors

`tools/gen-region-constants.js` reads `src/00-regions.wat` (via the vendored
parser — one grammar for the map) and writes:

- **`lib/regions.generated.js`** — `REGIONS.NAME = { base, size, end }`, frozen.
  Consumers convert, and each conversion **deletes** its clause from
  `tools/check-wat-js-constants.js`: a value generated from the declaration
  cannot drift from it, so the regex that policed the copy has nothing left to
  police. That gate stays only for the constants that are not regions (Win16
  module ids, the process-handle tag, GPU opcode word counts).

  **The JS side is worse than that gate suggests.** It covers *named* constants
  plus four hand-picked regex sites, and it does not see the roughly **24
  open-coded `- imageBase + 0x12000` g2w recomputations** in
  `lib/dll-loader.js` (8), `lib/host-imports.js` (11), `lib/filesystem.js`,
  `lib/gl-compat.js` and `lib/app-profiles.js` — each an independent copy of the
  `GUEST_BASE` ABI. `lib/mem-utils.js`'s `DIB_GUEST_BASE = 0x50000000` is
  uncovered too. In `test/` there are ~192 hits across ~90 files, of which only
  `test/run.js`'s DX constants are gated; `0x07F60000` is retyped in at least
  four DirectDraw tests and `0x07112000` in `test/test-cross-thread-send.js`.
  `test/test-mem-utils-dib-g2w.js` is the pattern to copy — it *imports* the
  constants instead of retyping them.

  **One disambiguation trap to carry into any JS lint:** `0x50000000` is both
  `$DIB_GUEST_BASE` and `WS_CHILD|WS_VISIBLE`, and it appears as the latter in
  `test/test-dialog-setfocus-tabstop.js:14` and `test/test-def-dlg-proc.js:70`.
  A literal is evidence, never proof — §7 again.
- **the table in `docs/memory-map.md`**, between generated markers. The prose
  stays hand-written; the addresses stop being.

`--check` mode (regenerate, diff, exit 1) joins `tools/build.sh` beside
`gen_dispatch.js --check` and `gen-host-import-sigs.js --check`.

## 7. The census — a completeness detector

`tools/region-census.js` counts raw literals that are a second copy of the map,
per region and per file. It is importable (`require('./region-census').census()`)
and has `--json`, `--region=`, `--file=`, `--gate` and `--record`.

**Calibration is the whole design, and the obvious definition is useless.** "Any
literal inside any declared region" counts **7136** sites, almost none of which
are the map: `$GUEST_BASE` is a 60 MB address *space*, so every guest VA and
every `0x400000` image base falls inside it, and `$CLIENT_RECT` is a 4 KB table
low in memory, so the GDI raster tests' colour constants (`0x6A6A` and friends)
land in it by arithmetic accident. A number that big cannot detect anything,
because nobody can tell a conversion from noise. So a site counts when it is
actually a second copy:

- **BASE** — the literal equals a declared region's base or exclusive end.
- **INTERIOR** — the literal is inside a declared *table* (≤ 64 KB) in the high
  WAT-private map (≥ `0x07000000`), where a number that looks like an address
  is one.

Measured at the declaration commit: **648 sites — 541 base, 41 end, 66
interior.** Banded by what kind of region they name:

| band | sites | confidence |
|---|---|---|
| high private map (≥ `0x07000000`) | 202 | near-certain debt |
| low WAT tables (< `0x12000`) | 255 | mixed — bases like `0x2000`/`0x3000` are also ordinary numbers |
| guest windows and spaces | 191 | mostly the base repeated (the `0x12000` copies in JS) |

Worst files: `src/10b-gdi-font.wat` 38, `test/test-wat-gdi-raster-handlers.js`
35, `test/run.js` 26, `src/09a7c-mixer.wat` 19.

**The census is a completeness detector, not a pacing ratchet.** With the
big-bang plan (§9) it answers "how many raw literals remain", and the answer
should go to approximately zero in one wave. `--gate` still refuses an
*increase* per file, so nothing regrows afterwards, and a region listed in the
baseline's `converted` array must stay at zero. Per-file rather than one total,
deliberately: a single number lets a cleanup in one file pay for a regression in
another, which is how ratchets stop ratcheting.

What it cannot do is prove completeness — a literal is evidence, not proof, and
a missed conversion that happens to be spelled in decimal, or split across an
add, is invisible to it. That is what §8 is for.

## 8. The shake test

**A layout that never moves is a layout nobody has tested.** Byte identity
proves each conversion was *exact*; it cannot prove the conversions were
*complete*, because a missed raw literal that still equals the right address
produces identical bytes. The only way to find the ones that are left is to
move the map and see what breaks.

```sh
WINE_REGION_SHAKE=gap    bash tools/build.sh   # insert a prime gap before each region
WINE_REGION_SHAKE=rotate bash tools/build.sh   # rotate the allocation order
WINE_REGION_SHAKE=pad    bash tools/build.sh   # round every region up to the next prime page count
WINE_REGION_SHAKE=0x9E3779B9 bash tools/build.sh  # a numeric value seeds a pseudorandom permutation
```

The env var reaches the allocator (§4.1) and nothing else; pinned and derived
regions are *not* shaken — moving `GUEST_BASE` or a guest-VA-anchored stack
changes the guest ABI, which is a different experiment. Prime-sized gaps are
deliberate: a shift that is a multiple of every stride in the tree can be
absorbed by an off-by-a-stride bug and stay green.

**Acceptance:** the 234-test pinned pool and the screenshot comparison suite
must be green under **at least three distinct permutations**, including one
`gap` and one `rotate`. A failure under shake localizes a missed literal —
the failing test names the subsystem, and `region-census.js --file=` names the
line. The loop is shake → fix → reshake, and it is the *only* evidence that the
map is data.

Running the pool under a shaken build is not free, so it is a
`tools/shake-sweep.sh` job and an acceptance gate for stage C, not a
per-commit gate. What ships afterwards is the natural allocation.

## 9. The migration: big bang, verified by byte identity

Not a gradual per-region staging. The staging was rejected because a
half-symbolized region is the worst of both worlds — it still cannot move, and
it costs a conversion pass per region.

**Stage A — compiler.** Allocated declarations with the deterministic allocator,
constraints, derived bases, region-relative data segments. The allocator must
**reproduce today's map exactly**, proven by `tools/region-alloc.js --diff`
being empty and by the canonical artifacts staying byte-identical.

**Stage B — symbolization, all at once.** Convert every raw address literal in
the tree to region-symbolic form: all regions, all files, parallelized per file
across agents, using the spellings in §5. **Acceptance is byte identity**: with
the allocator reproducing the current map, a correct conversion changes no
bytes and an incorrect one does. `01daf6ccfbd115e3` / `0ee6414668129ac4` is
therefore a per-file, per-agent correctness oracle, not merely a final check —
which is exactly what makes the fan-out safe.

**Stage C — shake.** §8. Iterate until three permutations are green.

**Stage D — natural allocation ships.** The map becomes data. Pins remain only
for guest-visible ABI, expressed as derivations (§4.3), never as bare wasm
offsets.

`region.declare-fixed` is the bridge: a region can be declared fixed *at its
current address* first — byte-identical, zero risk, already done for all 160 —
and un-pinned to allocated once §5's spellings cover its references.

## 10. Per-region verdict

The full 160-row table is `src/00-regions.wat` itself. The classes, and the
verdict for each:

| Region(s) | Current base | Verdict | Reason / constraints |
|---|---|---|---|
| `GUEST_BASE` | `0x00012000` | **derive** (pin until §6 lands) | the single parameter of `$g2w`; ~171 JS/WAT copies must become generated first |
| `GUEST_STACK` | `0x07012000` | **derived base** | guest holds these as `ESP` — pin the guest VA, derive the wasm offset |
| `GUEST_HEAP_BASE` | `0x03D12000` | **derived base** | guest holds these as heap pointers |
| `THUNK_BASE` / `THUNK_END` | `0x07112000` | **derived base** | thunk EIPs are guest-visible; `THUNK_END` becomes `(region.end $THUNK_BASE)` |
| `DIB_GUEST_BASE` window | `0x50000000` → `0x1C000000` | **pin** | a guest-visible ABI window with its own translation class in `$g2w` |
| `THREAD_CACHE_BASE`, `PAGE_INDEX_ARENA`, `PAGE_DIR_BASE` | `0x05000000`, `0x04100000`, `0x04900000` | **allocate with constraints** | `base + tid*stride`; power-of-two stride, `count` = thread count, mask derived |
| `PE_STAGING`, `DLL_TABLE`, `API_HASH_TABLE` | `0x07192000`, `0x07992000`, `0x07E00000` | **allocate** | emulator-private; historical hand-placement |
| every table below `GUEST_BASE` (WND/class/control/timer/scroll/dialog/paint…) | `0x2000`–`0x12000` | **allocate** | emulator-private; the guest reaches them only by convention |
| the high private map (`0x07E…`–`0x07FF…`: GDI regions, DX objects, COM wrappers, TV tables, histograms) | various | **allocate** | emulator-private; this is also where the census's 202 near-certain literals live |
| string constants at `0x100`+ | undeclared | **declare, then allocate** | 171 data segments sit here with no region at all (§4.4) |

## 11. Rollback — VERDICT

`WINE_WAT_COMPILER=legacy bash tools/build.sh` works because `src/` is standard
WAT. Does a declaration end that?

**Investigated, not assumed.** `lib/compile-wat.js` dispatches top-level forms
through a flat `if (head === '…')` chain (lines 913-1037) over
`iterTopLevel(exprs)`. There is no `else` and no whitelist: a form whose head
matches nothing falls out of the chain and the loop moves on. Unknown top-level
forms are **silently ignored** — a different fact from the previously recorded
"compile-wat only warns on unknown *func calls*", which is about expression
position.

**Proven, twice.** First against a synthetic part, then against the real thing:
`bash tools/build.sh` with all 160 declarations present produces, in **both**
modes,

```
watx    tail 984347 B 01daf6ccfbd115e3   compat 984796 B 0ee6414668129ac4
legacy  tail 984347 B 01daf6ccfbd115e3   compat 984796 B 0ee6414668129ac4
```

**VERDICT: declarations are legacy-safe and rollback survives step 1 intact.**

**The retirement is scheduled, not avoided.** Rollback survives *top-level*
declarations. It cannot survive either addressing spelling: a bare `$REGION` or
a `(region.addr …)` in expression position is not ignored harmlessly — and the
failure mode is worse than "fails validation". Legacy compiles an unknown
expression op to `unreachable` (`lib/compile-wat.js:1528-1532`, verified by
compiling a `(region.addr …)` under it: it *builds*, prints one `unknown op`
warning, and traps at runtime when that path executes). A legacy rollback of a
partially converted tree can therefore ship a module that instantiates cleanly
and dies mid-app. So:

> Stage B's first converted file formally retires `WINE_WAT_COMPILER=legacy`.
> That commit must say so, flip the migration plan's rollback checklist row, and
> update the mode comment in `tools/build.sh`. It is a one-way door, taken
> deliberately at the start of stage B rather than as a side effect of some
> region conversion.

**The door was taken 2026-08-31**: wave 1 of the symbolization landed
expression- and data-position region spellings (d1a22e79 onward), and
`WINE_WAT_COMPILER=legacy` is now a hard error in `tools/build-compile-wat.js`.
The migration plan's §5.1 selector is marked retired.

## 12. Failure-mode catalogue

Every one is a hard compile error carrying `file`, `line`, `col`. None is a
warning: a memory map that compiles with a diagnostic nobody reads is the status
quo. Rows 1-14 are implemented; rows 15-20 accompany their feature.

| # | Condition | Message shape |
|---|---|---|
| 1 | Two regions' extents intersect | `region.declare-fixed $B [0x07F70000,0x07F78000) overlaps $A [0x07F60000,0x07F80000) (declared at 00-regions.wat:41); use (within $A) if the nesting is deliberate` |
| 2 | Region ends past initial memory | `$A ends at 0x20001000, past the 0x20000000 bytes of initial memory (8192 pages)` |
| 3 | Duplicate declaration | `$A is already declared at 00-regions.wat:12` |
| 4 | Missing / dual extent | `$A needs exactly one of (size N) or (end N)` |
| 5 | `end` at or below `base` | `(end 0x800) is not above (base 0x1000)` |
| 6 | Zero size | `(size 0) — a region must have an extent` |
| 7 | Unknown clause | `unknown clause (sixe ...); expected base, size, end, align, owner, within` |
| 8 | Duplicate clause | `duplicate (base ...) clause` |
| 9 | Misaligned base | `base 0x00012004 is not a multiple of its (align 0x1000)` |
| 10 | Non-power-of-two align | `(align 12) is not a power of two` |
| 11 | Non-integer literal | `(size "big") is not an integer literal` |
| 12 | `(within …)` names nothing / does not contain | `(within $OUTER) names no declared region` · `$A […) is not contained in $OUTER […)` |
| 13 | `region.addr` on an unknown region | `unknown region $NOPE; declared regions are …` |
| 14 | `region.addr` offset/span out of bounds, negative, or not a literal | `offset 0x800 runs past the region's 0x800 bytes` · `offset must be a non-negative integer literal` |
| 15 | *(4.1)* allocation runs out of memory | `allocating $A (0x…) past the 0x20000000 bytes of memory; the last placed region was $B` |
| 16 | *(4.1)* an allocated region collides with a pin | `$A cannot be allocated at 0x…: pinned $B occupies it` (the allocator skips pins, so this means a pin above the floor with no room after it) |
| 17 | *(4.2)* a stride/count law fails | `$A (size 0x2000000) is not (stride 0x400000) x (count 8)` |
| 18 | *(4.2)* a power-of-two law fails | `$A declares (size-is-power-of-2) but its size is 0x1800` |
| 19 | *(4.3)* a derived base has no `$GUEST_BASE` region | `(g2w 0x07100000) needs a declared $GUEST_BASE region` |
| 20 | *(4.4)* a data segment's region-relative offset is out of bounds | `(data (region.addr $A 0x900) …) with 0x20 bytes runs past the region's 0x800` |

## 13. Status

**Landed (step 1):**

1. `region.declare-fixed` + `region.addr` / `region.size` / `region.end` in
   `tools/watx-src/compiler-codegen.js`, failure modes 1-14, provenance resealed.
2. `test/watx-compiler-regions.test.js` — 60 checks.
3. `src/00-regions.wat` — **all 160** fixed regions declared, registered in
   `src/main.watx` and `WAT_FILES`; `tools/check-region-decls.js` holds them
   against the `$NAME`/`$NAME_SIZE` globals in `tools/build.sh`.
4. `tools/region-census.js` — the odometer, calibrated in §7.
5. Byte identity proven in both compiler modes (§11).

**Next, in order:** §4.1 allocator (+ `--diff` empty), §4.2-4.4, §6 generators,
then stage B's fan-out, then §8's shake.

# `region.declare-fixed` — memory-region safety in the WATX compiler

Milestone 6 step 1 of [docs/watx-migration-plan.md](watx-migration-plan.md).
This document decides the feature before any of it is written. It is committed
on its own so the decisions can be argued with while they are still cheap to
change.

## 1. The problem this replaces

The fixed memory map is a set of hand-placed hex constants. Today's guarantees
about it are entirely external to the compiler:

| Guarantee | Who provides it today | What it cannot see |
|---|---|---|
| Regions do not overlap | `test/test-wat-memory-map.js`, a build gate | anything not spelled `(global $X i32 ...)` + `(global $X_SIZE i32 ...)` |
| Free space / collision queries | `tools/wat-memory-map.js`, on demand | same |
| WAT↔JS constant agreement | `tools/check-wat-js-constants.js`, a build gate | a JS copy whose surrounding code was reshaped so the regex stops matching |
| An address is inside its region | **nobody** | — |

The last row is the interesting one. `(i32.const 0x07F60000)` and
`(i32.const 0x07F60000)` written 300 lines apart in two different files are the
same token to every tool we have; `(i32.add (global.get $DX_OBJECTS) (i32.mul
(local.get $slot) (i32.const 0x400)))` with a `$slot` one larger than `$DX_MAX`
is a silent write into `COM_WRAPPERS`. The linting tools prove the *declared*
extents are disjoint. Nothing proves the *code* stays inside them.

The three gates above also derive their truth from a regex over source text.
That is why they can only see the `$NAME`/`$NAME_SIZE` convention: a region
whose author did not write a `_SIZE` partner is invisible to all of them, and
`tools/wat-memory-map.js` says so in its own header comment — it lists such
globals as bare *points* because "a bare address tells us something is there
even when its extent is unknown".

`region.declare-fixed` moves the extent into the language, where the compiler —
which already sees every constant in every function body — can act on it.

## 1a. This is one new head in an existing family, not a new subsystem

The vendored compiler already carries almost everything Milestone 6 needs. The
inventory, verified in `tools/watx-src/`:

| Facility | Where | State |
|---|---|---|
| `layout` declarations, hard-error unknown layout/field | `compiler-codegen.js` ~26-62, ~521-547 | complete |
| `load.field` / `store.field` / `load.elem` / `store.elem` / `size-of` / `offset-of` / `elem-addr` | `compiler-codegen.js` ~1121, 2544+ | complete |
| `defmacro` | `compiler-stages.js:43` | complete |
| region **family**: `region.declare-static` / `-bump` / `-rc`, `region.alloc`, `region.enter/exit` | `compiler-codegen.js:925, 2533` | complete |
| region symbol resolves to its base in operand position | `compiler-codegen.js:1320-1327` | complete |

Every existing `region.declare-*` head **allocates**: static regions are laid
out from a `STATIC_REGION_BASE = 1024` cursor, bump/rc regions come from the
heap that starts after them. Wine needs the opposite verb. Its bases are an ABI
it does not get to choose, so the missing operation is *"this region is AT
0x07F60000 and is 0x20000 bytes — verify that, never place it"*.

So this design adds **one head**, `region.declare-fixed`, to the family that is
already there, plus set-level validation and an offset-checked addressing form.
It does not add a parallel region system, a parallel struct system, or a
parallel constant system.

**Reused verbatim** (no new machinery):

- The top-level collection pass that gathers `region.declare-*` forms before
  emission — `region.declare-fixed` joins the same scan and the same
  `regionDecls` array.
- The `(size N)` sub-clause spelling.
- `regionBase`, the name→base map, and **the bare-symbol resolution at
  `compiler-codegen.js:1320-1327`**: `$NAME` in operand position already emits
  `i32.const <base>`. A fixed region declared at 0x07F60000 gets that for free,
  with the exact bytes a hand-written constant emits.
- `layout` + `load.field`/`store.field`/`size-of`/`offset-of` for Milestone 6
  step 3. **Layouts-on-regions needs nothing new at all**: a WND record becomes
  a `layout`, its base stays the declared region symbol, and
  `(load.field WndRecord hwnd (i32.add $WND_RECORDS (i32.mul slot (size-of
  WndRecord))))` is already a compilable sentence today. Step 3 is a source
  conversion, not a compiler feature.

**Added by the one new head:** a base that is an input rather than an output;
set-level validation of the declared bases (§4a); and `region.addr` (§4b), the
offset-checked complement to bare-symbol resolution.

**Why not parallel machinery:** a second declaration form for "Wine's fixed
addresses" would mean two grammars for the same concept, two name maps, two
places to look when an address is wrong, and a permanent fork between what the
vendored compiler upstream understands and what this repo understands. The
provenance seal exists precisely to keep the vendored copy explainable as a
copy; a whole parallel subsystem inside it is the thing that seal is there to
prevent.

## 2. Non-goals for step 1

- **No relocation, ever.** Wine's bases are an ABI shared with JavaScript
  (`lib/mem-utils.js`, `lib/guest-rpc.js`, `lib/host-imports.js`,
  `lib/thread-manager.js`), with tests, and with guest-address translation
  (`g2w`). A declaration states an address; it never chooses one.
- **No consumer conversion.** Step 1 lands declarations and the machinery.
  Rewriting `(global.get $DX_OBJECTS)` sites is step 2.
- **No layouts.** `offset-of` / field addressing is step 3 — and it needs no
  compiler work, only source conversion (§1a).
- **No runtime checks.** Every check in this document happens at compile time
  and costs zero emitted bytes.

## 3. Syntax

A fixed-region declaration is a **top-level module form**:

```wat
(region.declare-fixed $GUEST_BASE
  (base 0x00012000)
  (size 0x03C00000)
  (align 0x1000)
  (owner "PE image window; g2w direct translation target"))
```

- `$NAME` — required, first positional operand, `$`-prefixed. The name is the
  same identifier as the existing `(global $NAME i32 ...)` base global, so the
  declaration and the global that code reads today are trivially cross-checkable
  (§5.1) and step 2's conversion is a rename of nothing.
- `(base N)` — required. A non-negative integer literal, decimal or `0x`.
- `(size N)` — required unless `(end N)` is given; the two are mutually
  exclusive, and `end` is exclusive (`end = base + size`). Both spellings exist
  because the map is documented both ways: `01-header.wat` writes sizes,
  `docs/memory-map.md` and most of the GDI comments write
  `0x07EF0000..0x07EF07FF` ranges, and forcing a subtraction at the point of
  declaration is how an off-by-one enters.
- `(align N)` — optional, default `4`. Must be a power of two. `base` must be a
  multiple of it.
- `(owner "text")` — optional free text. It is not checked; it exists so the
  declaration set is readable as *the* map instead of needing a comment block
  beside it.

Sub-clause order is free. Unknown sub-clauses are a hard error, not ignored —
a typo'd `(sixe 4096)` that silently defaulted would be worse than no
declaration.

**Why parenthesized sub-clauses rather than positional numbers.** It matches the
existing `region.declare-static` spelling — `(region.declare-static $r (size N))`
— so the two families read as one family, and it is what makes `owner`/`align`
addable without a breaking change. It is also, as §6 proves, invisible to the
legacy compiler.

### Where declarations live

A new part, `src/00-regions.wat`. Three constraints decide this:

1. `tools/check-wat-manifest.js` asserts `WAT_FILES` (in `lib/compile-wat.js`)
   == `src/main.watx`'s include list == the `src/*.wat` glob, **as an ordered
   sequence in LC_ALL=C sort order**. A new part must be registered in both
   lists and must sort into its filename's place.
2. The migration plan's "no twin files" rule forbids a parallel `.watx` copy of
   an existing part. It does not forbid a *new* part, and a new part is the
   only way to have one file that is the map.
3. `00-` sorts before `01-header.wat`, so the map is the first thing in
   `build/combined.wat` and the first thing a reader meets. Declaration order
   is irrelevant to validation (the collection pass is order-independent), and
   the part contributes no funcs, globals, data segments, or exports, so it
   cannot perturb any index. Export ordering is a stable sort on top-level form
   index (`3fdae908`); inserting a part at index 0 shifts every key by the same
   amount and a stable sort is unchanged.

## 4. Enforcement model, in adoption order

### (a) Declaration-set validation — step 1, lands now

A single collection pass over the module's top-level forms, next to the existing
`region.declare-*` collector in `compiler-codegen.js`. It runs on every compile,
in both tail-call and compat modes, in streaming and non-streaming pipelines
(non-`func` top-level forms reach `generateWasm`'s `forms` array in both —
`compiler.js:189-196`).

It checks:

1. **Duplicate name.** Two `region.declare-fixed` forms naming `$X`.
2. **Well-formedness.** Missing/dual `size`/`end`, `end <= base`, `size == 0`,
   negative or non-integer literals, unknown sub-clause, non-power-of-two align.
3. **Alignment.** `base % align != 0`.
4. **Memory bounds.** `base + size > memoryBytes`, where `memoryBytes =
   memoryDecl.min * 65536` — the memory *guaranteed to exist at
   instantiation*. Wine imports `(memory 8192 8192 shared)`, so min == max and
   the bound is exactly 0x20000000. Using `min` rather than `max` is the strict
   reading: a region that only exists after a `memory.grow` the compiler cannot
   see is not a *fixed* region, and `declare-fixed` should refuse it rather
   than bless it.
5. **Overlap-freedom.** Sort by base; any two declared regions whose
   `[base, base+size)` intervals intersect is an error naming both, with both
   file:line locations.

Alias regions — a small region deliberately inside a bigger one, which the map
does contain (`test/test-wat-memory-map.js` audits several by hand today) — are
**not** silently permitted. A region that is meant to live inside another
declares `(within $OUTER)`, which turns the overlap error with `$OUTER` into a
containment *requirement* (`base >= outer.base && end <= outer.end`) while
leaving it in overlap checking against everything else. This is deliberate:
"these two overlap on purpose" must be written down at the point of overlap,
not held in a gate's exception list.

### (b) In-bounds constant addressing — step 2

Two spellings, one inherited and one new.

**Inherited, unchanged:** a bare region symbol in operand position is its base.

```wat
$DX_OBJECTS        ;; => (i32.const 0x07F60000)
```

This is `compiler-codegen.js:1320-1327` doing exactly what it already does for
static regions, reached because `region.declare-fixed` populates the same
`regionBase` map. Zero new code, and the emitted bytes are one `i32.const`.

**New:** the offset-checked form, for the case the bare symbol cannot express.

```wat
(region.addr $DX_OBJECTS 0x400)          ;; => (i32.const 0x07F60400)
(region.addr $DX_OBJECTS 0x400 (span 4)) ;; also asserts 0x400+4 <= size
```

with `(region.size $NAME)` and `(region.end $NAME)` as companions;
`(region.addr $NAME 0)` is the base. It compiles to **exactly** `0x41` +
SLEB128(`base + offset`) — the identical bytes the raw constant emits — after
checking `0 <= offset` and `offset + span <= size`.

**Why the bare symbol is not enough on its own.** It carries no offset, so
there is nothing for the compiler to check; `(i32.add $DX_OBJECTS (i32.const
0x40000))` is as unchecked as the hex literal it replaces. `region.addr` is
where a *constant* offset becomes visible to bounds checking. The two coexist
deliberately: the bare symbol is the cheap, family-consistent spelling for "the
base", `region.addr` is the spelling for "a fixed place inside it", and neither
can express a dynamic index (that is what §4c's layouts and, later, an
`elem-addr` over a declared region are for).

**One hazard, accepted and recorded.** Bare-symbol resolution sits in
`compileExpr`'s fallback path, *before* the "Unknown symbol" hard error. A
mistyped local whose name happens to equal a declared region name therefore
compiles to that region's base instead of failing. Wine's region names are also
global names, but globals are read as `(global.get $X)`, never as a bare `$X`,
so there is no ambiguity at any existing use site — the exposure is only to a
typo that collides exactly with a declared name. That is a strictly smaller
surface than today's raw hex constants, and it is the price of not forking the
family.

**Both spellings are WATX-only in expression position, and the first use of
either in `src/` retires the legacy rollback** — see §6.

### (c) JS mirror generation — step 3

`tools/gen-region-constants.js` reads the same `src/00-regions.wat`
declarations and writes `lib/regions.generated.js`:

```js
module.exports.REGIONS = Object.freeze({
  GUEST_BASE: { base: 0x00012000, size: 0x03C00000, end: 0x03C12000 },
  ...
});
```

with `--check` (regenerate into memory, diff, exit 1 on drift) wired into
`tools/build.sh` beside the other generated-artifact gates
(`gen_dispatch.js --check`, `gen-host-import-sigs.js --check`). Consumers
(`lib/mem-utils.js`'s `GUEST_BASE`, `lib/guest-rpc.js`'s `RPC_BASE`/
`SYNC_TABLE`, `lib/host-imports.js`'s `DX_*`, `test/run.js`'s `DX_BASE`) are
converted one at a time afterwards, and each conversion *deletes* its clause
from `tools/check-wat-js-constants.js` — a value generated from the declaration
cannot drift from it, so the regex that policed the copy has nothing left to
police. `check-wat-js-constants.js` stays for the constants that are not
regions (Win16 module ids, the process-handle tag, GPU opcode word counts).

The generator parses the declaration file with the vendored WATX parser
(`tools/watx.js` exports `parseSource`), not a regex — the whole point is that
there is one grammar for the map.

## 5. Agreement with what the tools derive today

### 5.1 `tools/check-region-decls.js` (lands with step 1)

A build gate, run before compilation, that cross-checks every
`region.declare-fixed $X` against the `$X` / `$X_SIZE` globals
`tools/wat-memory-map.js` and `test/test-wat-memory-map.js` derive from
`src/*.wat`:

- declared `base` != `(global $X i32 (i32.const ...))` → error
- declared `size` != `(global $X_SIZE i32 (i32.const ...))` → error
- a declaration for a name with no such global → error (a declaration must
  describe a region that exists, not invent one)

The reverse direction — a sized global with no declaration — is a **warning**
in step 1 and becomes an error when the declaration set is complete. The real
map has several hundred sized regions; requiring all of them on day one would
make the feature un-landable, and a partial set is already useful because every
declared region is checked against every other declared region.

This gate is what makes the declarations *true* rather than decorative. It is
also the mechanism by which the map migrates: as regions are declared, the
regex-derived map shrinks toward the declared one, and when they coincide
`test/test-wat-memory-map.js` becomes redundant and is deleted.

### 5.2 What we expect the real map to say

`tools/wat-memory-map.js` currently reports regions that the `_SIZE` convention
cannot size (listed as points, size 0) and at least one range the ASCII diagram
in `docs/memory-map.md` describes as live but `01-header.wat:1460` says is now
free (`0x07152000..0x07192000`, the old `CACHE_INDEX_BASE`, retired by page
compilation). Declaring the map is expected to surface exactly this class of
staleness. Any such finding is reported, not papered over.

## 6. The rollback story — VERDICT

`WINE_WAT_COMPILER=legacy bash tools/build.sh` works today because `src/` is
pure standard WAT. The question is whether a declaration ends that.

**Investigated, not assumed.** `lib/compile-wat.js` dispatches top-level forms
through a flat `if (head === '...')` chain (lines 913-1037) over
`iterTopLevel(exprs)`. There is no `else` and no whitelist: a form whose head
matches nothing falls out of the chain and the loop moves on. Unknown top-level
forms are therefore **silently ignored** — a distinct fact from the previously
recorded "compile-wat only warns on unknown *func calls*", which is about
expression position, not top level.

**Proven.** `lib/compile-wat.js`'s `compileWat(read, { files })` was run twice
over the real tree: once with `WAT_FILES` as-is, once with a synthetic first
part containing only two `(region.declare-fixed ...)` forms.

```
baseline   984347 bytes  sha256:01daf6ccfbd115e3
with decls 984347 bytes  sha256:01daf6ccfbd115e3
IDENTICAL
```

The baseline is the canonical tail-call hash from the cutover (`23ed9639`), so
this is not a self-consistent pair of wrong numbers.

**VERDICT: option (i).** `region.declare-fixed` declarations are designed to be
legacy-safe, and legacy rollback survives step 1 intact. `bash tools/build.sh`
in both modes is the standing proof, and the byte-identity of the WATX artifact
with declarations present (Deliverable 3) is the other half.

**The retirement is scheduled, not avoided.** Rollback survives *declarations*,
which are top-level. It cannot survive either addressing spelling: a bare
`$REGION` or a `(region.addr ...)` in expression position is not something
legacy ignores harmlessly — an operand vanishes from the stack and the function
miscompiles or fails validation. So:

> The first bare region symbol or `region.addr` (or any other WATX-only
> expression form) written into `src/` formally retires
> `WINE_WAT_COMPILER=legacy`. That commit must say so,
> flip the migration plan's rollback checklist row, and update the mode comment
> in `tools/build.sh`. It is a one-way door and is taken deliberately, in its
> own commit, not as a side effect of a region conversion.

Until then, both modes stay green and both are gated.

## 7. `region.declare-static` — FORBIDDEN here

`region.declare-static` exists in the vendored compiler and is explicitly ruled
out by the migration plan: it **allocates** bases from a `STATIC_REGION_BASE =
1024` cursor (`compiler-codegen.js:946-954`) and would relocate the entire Wine
map into the first 4 KB of linear memory — over the decoder scratch area, the
window tables, and `NULL_SENTINEL`.

What is forbidden is the **head**, not the family. `region.declare-fixed` is a
sibling of `declare-static` and shares its plumbing (see §1a for the full reuse
inventory):

**Reused, mostly verbatim:**

- The collection pass at `compiler-codegen.js:922-937` — one linear scan of
  top-level `forms` keyed on the head symbol. `declare-fixed` is one more head
  in that same `if`.
- The `(size N)` sub-clause spelling.
- `regionBase`, the name→base map, and the bare-symbol resolution it feeds at
  `compiler-codegen.js:1320-1327`. Fixed regions populate the same map and get
  `$NAME` → `i32.const base` with no new code at all.
- Its data-segment collision check (`compiler-codegen.js:956-961`) as the model
  for how a region conflict is reported.

**Rejected:**

- The `staticCursor` allocation, entirely. `declare-fixed` takes `base` as an
  input and never computes one. There is no cursor, no 16-byte rounding, no
  `STATIC_REGION_BASE`, and a `declare-fixed` region contributes nothing to the
  bump heap's start.
- The data-segment-vs-`staticCursor` overlap check as written; `declare-fixed`
  regions are checked against each other and against the memory bound, and data
  segments are already covered by `tools/wasm-data.js --overlaps` on the
  compiled module.
- The `|| 4096` default size. A `declare-fixed` region with an unparseable or
  missing size is an error; defaulting a *memory extent* is how a region ends
  up 4 KB long and quietly overlapped.

## 8. Failure-mode catalogue

Every one is a hard compile error carrying `file`, `line`, `col` (the compiler's
existing `e.line/e.col/e.file` convention, which `tools/build-compile-wat.js`
already renders as `at file:line:col`). None is a warning; a memory map that
compiles with a diagnostic nobody reads is the status quo.

| # | Condition | Message shape |
|---|---|---|
| 1 | Two regions' extents intersect | `region.declare-fixed $A [0x07F60000,0x07F80000) overlaps $B [0x07F70000,0x07F78000) (declared at 00-regions.wat:41)` |
| 2 | `base + size` exceeds initial memory | `region.declare-fixed $A ends at 0x20001000, past the 0x20000000 bytes of initial memory (8192 pages)` |
| 3 | Duplicate declaration of one name | `region.declare-fixed $A is already declared at 00-regions.wat:12` |
| 4 | Missing / dual / malformed extent | `region.declare-fixed $A needs exactly one of (size N) or (end N)` |
| 5 | Unknown sub-clause | `region.declare-fixed $A: unknown clause (sixe 4096); expected base, size, end, align, owner, within` |
| 6 | Misaligned base | `region.declare-fixed $A base 0x00012004 is not a multiple of its (align 0x1000)` |
| 7 | Non-power-of-two align | `region.declare-fixed $A: (align 12) is not a power of two` |
| 8 | `(within $OUTER)` names an undeclared region | `region.declare-fixed $A: (within $OUTER) names no declared region` |
| 9 | `(within $OUTER)` not actually contained | `region.declare-fixed $A [0x1000,0x3000) is not contained in $OUTER [0x2000,0x4000)` |
| 10 | *(step 2)* `region.addr` names no declared region | `region.addr: unknown region $A; declared regions are ...` |
| 11 | *(step 2)* offset/span out of bounds | `region.addr $A offset 0x400 span 4 runs past the region's 0x400 bytes` |
| 12 | *(step 2)* negative or non-constant offset | `region.addr $A: offset must be a non-negative integer literal` |

Rows 10-12 are specified now so step 2 has nothing left to decide, and are
implemented with step 1 (the form is available; nothing in `src/` uses it yet).

## 9. What ships in step 1

1. `region.declare-fixed` + `region.addr` / `region.size` / `region.end` in
   `tools/watx-src/compiler-codegen.js`, with failure modes 1-12. Provenance
   resealed (`tools/check-watx-provenance.js --update` + CHANGELOG entry).
2. `test/watx-compiler-regions.test.js`: declarations parse; every failure mode
   fires with a located error; `region.addr` emits byte-identical bytes to the
   raw `i32.const`; a module with declarations is byte-identical to the same
   module without them.
3. `src/00-regions.wat` covering the regions in `docs/memory-map.md`'s table,
   registered in `src/main.watx` and `WAT_FILES`, plus
   `tools/check-region-decls.js` in `tools/build.sh`.
4. Proof: `bash tools/build.sh` green and canonical hashes unchanged
   (tail 984347 B `01daf6ccfbd115e3`, compat 984796 B `0ee6414668129ac4`) in
   **both** compiler modes.

No consumer address is converted. That is step 2.

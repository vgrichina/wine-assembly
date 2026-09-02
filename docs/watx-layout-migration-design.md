# Struct layouts in WATX — deleting the hand-spelled field offsets

**Summary (the four things worth remembering):**

1. **`src/*.wat` uses the WATX `(layout ...)` system exactly zero times.** All
   **12,587** memory sites reach their fields through hand-spelled arithmetic.
   `tools/struct-offset-census.js` counts and classifies them.
2. **Byte identity holds for loads — measured, not assumed.** `load.field`,
   `load.elem`, `load.field-elem`, `offset-of` and `size-of` compile to *the
   identical wasm bytes* as the add-form spelling already in the tree. That makes
   this migration dramatically safer than the region one: a wave can be required
   to produce a byte-identical `wine-assembly.wasm`.
3. **`store.field` is BROKEN in the production build and nothing noticed**,
   because nothing uses it. It emits a trailing `i32.const 0` even under
   `standardWat: true`, so a store in a void function leaves a value on the stack
   and the module **fails `WebAssembly.validate`**. Wave 0 is a ~3-line compiler
   fix plus the spec-suite case that should have caught it.
4. **Recommended wave 1: the winsock socket record** (`$vsock_rec`,
   `src/09d-winsock.wat`) — 179 sites, one file, one helper, 18 fields, zero
   `offset=` memarg sites, 100% byte-identical-capable, and 14 existing tests.

Sibling of [docs/watx-region-safety-design.md](watx-region-safety-design.md).
That document deleted the magic *base* addresses; this one is about the magic
*field* offsets inside the records those bases point at. The bug class is the
same one, one level down, and it is the level with 20x more sites.

---

## 1. The goal

**Each record field offset appears exactly ONCE in the tree — in its `(layout)`
declaration.** Every access references it by name.

Today a field is reached like this:

```wat
(i32.load (i32.add (call $vsock_rec (local.get $idx)) (i32.const 56)))   ;; flags
(i32.store offset=92 (local.get $dc) (local.get $v))                     ;; a DC field
```

`56` and `92` are the only statement of where those fields live, and they are
restated at every site. A wrong copy is **silent**: it reads a neighbouring
field, which is a plausible integer, and the symptom appears arbitrarily far
away. This is the field-level twin of the region-base bug class that
[§1 of the region doc](watx-region-safety-design.md) describes — with the
difference that a bad region base usually lands in unmapped memory and traps,
while a bad *field* offset lands inside the same record and does not.

### What guarantees exist today

| Guarantee | Who provides it | What it cannot see |
|---|---|---|
| Records do not overlap each other | region declarations (`00-regions.wat`) | anything inside one record |
| A field offset is inside its record | **nobody** | — |
| Two sites agree on a field's offset | **nobody** | — |
| A record's size matches the sum of its fields | **nobody** | — |
| A prose layout comment still describes the code | **nobody** | — |

The last row matters more than it looks. `src/09d-winsock.wat:17-43` carries a
28-line ASCII table of the socket record's fields. It is accurate. It is also
load-bearing documentation that no tool reads and no gate checks, so it is
accurate until the day it is not.

---

## 2. The census

`tools/struct-offset-census.js` reads every file in `WAT_FILES` as
s-expressions, finds every memory op, peels the address expression down to a
base symbol while accumulating constant offsets and any `index * stride` term,
resolves a `local $rec` back to whatever call initialized it, and groups the
sites by that base.

```
struct-offset census — 12587 memory sites over 61 files
  class A (funneled through an address helper): 2710  (1240 byte-identical-capable, 46%)
  class B (raw arithmetic off a table/global) : 6079  (2428 byte-identical-capable, 40%)
  class C (guest-visible, layout IS the ABI)  : 3798  (1668 byte-identical-capable, 44%)
  spelled with an offset= memarg (not byte-identical after conversion): 6543
  width a (layout) field cannot express (16-bit / signed byte)        : 1258
  stores (blocked until store.field drops its trailing i32.const 0)   : 5213
```

### The three classes

- **A — FUNNELED.** The address comes out of one helper call
  (`call $vsock_rec`, `call $wnd_record_addr`, `call $gdi_object_record`). Every
  site in the family already agrees on the base; only the field constants are
  scattered. **These are cheap**: the layout is written once, the helper is
  untouched, and each site's `(i32.add … (i32.const N))` becomes
  `(load.field L name …)`.
- **B — RAW.** The address is spelled from a table global, an absolute
  constant, or a pointer parameter whose provenance is the caller's. Expensive:
  every site is its own chance to be wrong, and the record's identity has to be
  *established* before it can be named.
- **C — GUEST / ABI.** The address descends from `$g2w` or `$GUEST_BASE`, so
  the bytes belong to the guest program: `MSG`, `RECT`, `BITMAPINFO`,
  `WNDCLASS`, `CRITICAL_SECTION`, `WSADATA`, the DirectX structures. A layout is
  still worth writing — arguably *most* worth writing, since these are the
  offsets a mistake makes a guest misbehave over — **but the layout is the Win32
  ABI and must be marked frozen.** See §7.

### Top families by site count

| cls | sites | stores | fields | memarg | u16/i8 | bi% | family | files |
|---|---|---|---|---|---|---|---|---|
| C | 764 | 456 | 30 | 422 | 76 | 39% | `$g2w` @ 09a-handlers | 1 |
| C | 744 | 370 | 26 | 488 | 8 | 34% | `$g2w` @ 09c3-controls | 1 |
| A | 537 | 211 | 10 | 40 | 54 | 83% | `call $dx_from_this` | 09a8, 09aa, 09ab |
| C | 302 | 267 | 45 | 36 | 23 | 80% | `$g2w` @ 09a8-directx | 1 |
| A | 243 | 0 | 4 | 161 | 0 | 34% | `call $loop_op_at` | 07b-loop-match |
| C | 208 | 93 | 93 | 205 | 0 | 1% | `$g2w` @ 09c6-winhelp-core | 1 |
| **A** | **179** | **82** | **18** | **0** | **0** | **100%** | **`call $vsock_rec`** | **09d-winsock** |
| C | 176 | 156 | 24 | 39 | 38 | 61% | `$g2w` @ 09a7-dispatch | 1 |
| B | 171 | 26 | 20 | 163 | 0 | 5% | `param $desc` @ 10g-gdi-raster | 1 |
| A | 160 | 12 | 10 | 160 | 0 | 0% | `call $gdi_object_record` | 10f, 10g, 10e |

`fields` is the count of *distinct constant offsets observed* — a lower bound on
the real field count, and the first sanity check on any layout written for the
family. `bi%` is the share of that family's sites whose current spelling would
compile to identical bytes after conversion (§3).

Full output: `node tools/struct-offset-census.js --min=20`; one family in detail
with its offsets, functions and per-site lines:
`node tools/struct-offset-census.js --base='call $vsock_rec'`.

### What the census cannot see

It groups by base *symbol*, so two unrelated records reached through a
similarly-named local in the same file merge into one family, and one record
reached through two different helpers splits into two. Every family in a wave
must be eyeballed before a layout is written for it. It also treats a pointer
parameter as its own family per file, which is right for "how expensive is this"
and wrong for "is this the same struct as that one" — a struct passed by pointer
into ten functions shows up as ten families.

---

## 3. The compiler: what is actually available, and what it emits

Read `tools/watx-src/compiler-codegen.js` — the `(layout)` lowering at the top
of `lowerIR`, and the `load.field` / `store.field` / `load.elem` / `store.elem` /
`load.field-elem` / `store.field-elem` / `elem-addr` / `size-of` / `offset-of`
handlers around lines 3795-4100.

### 3.1 What a layout carries

```wat
(layout VSock
  (field state i32)            ;; scalar; offset assigned by declaration order
  (field flags u8)             ;; 1 byte
  (field acc_queue i32 15)     ;; ARRAY field: count 15, stride 4 -> 60 bytes
  (field vreg f64 32 16))      ;; explicit stride: 16-byte spacing, f64 access
```

Offsets are assigned by running total, **with no alignment padding inserted** —
the declaration order *is* the layout, which is exactly right for describing
records that already exist. Field types are
`i32 | i64 | f32 | f64 | u8 | s8 | u16 | s16 | weak | ptr*` (`ptr`, `weak` and
`ptr$Rec` are 4 bytes). Bad count/stride is a hard compile error, and so is an
unknown layout or field name — the codegen comments record that these used to
default silently to offset 0 / size 16, which turned a typo into a wild access.

**The type set is CLOSED, and refused at the declaration.** Anything outside the
list above is a located hard error naming the layout, the field, the type and
the set. It was not always: the encoder ended `group[fieldType] || group.i32`, so
an unrecognized name became a 4-byte access and `sizeOfType` laid the struct out
4 bytes wide to match — see the 2026-08-31 field-type entry in
[tools/watx-src/CHANGELOG.md](../tools/watx-src/CHANGELOG.md). Note that `v128`
is a legal valtype and *not* a field type: there is no v128 entry in the encoder,
so it is refused rather than silently narrowed to i32.

**`u16` and the signed widths are now expressible.** The 1,258 16-bit and
`load8_s` sites this section once parked are declarable as `u16`/`s16`/`s8` —
including DxObject's `+12..+18` width/height/bpp/pitch, which the completion
sweep had to decline and spell `u8[2]`. Each lowers to its own sub-width opcode
(`i32.load16_u`/`i32.load16_s`/`i32.load8_s`, and the truncating
`i32.store16`/`i32.store8`) at the alignment the hand-spelled instruction
already uses, so those sites join a byte-identical wave like any other.

### 3.2 Byte identity — MEASURED

This is the verdict that decides the whole migration's risk profile, so it was
measured against the real build compiler (`tools/watx.js`, driven with the same
`mode:'production', standardWat:true` options `tools/watx-closure.js` uses), by
compiling pairs of functions that differ only in spelling and diffing their
code-section bodies:

| pair | result |
|---|---|
| `(i32.load (i32.add p (i32.const 8)))` vs `(load.field L f p)` | **IDENTICAL** |
| field at offset 0 | **IDENTICAL** |
| `i32.load8_u` vs a `u8` field | **IDENTICAL** |
| `base + i*SIZE + off` vs `(load.elem L f base i)` | **IDENTICAL** |
| `p + off + i*4` vs `(load.field-elem L f p i)` | **IDENTICAL** |
| `(i32.mul i (i32.const 36))` vs `(i32.mul i (size-of L))` | **IDENTICAL** |
| `(i32.const 16)` vs `(offset-of L f)` | **IDENTICAL** |
| `(i32.store (i32.add p (i32.const 4)) v)` vs `(store.field L f p v)` | **DIFFER** — see §3.3 |
| `(i32.load offset=8 p)` vs `(load.field L f p)` | **DIFFER** — see §3.4 |

`load.field` lowers to `ptr; i32.const off; i32.add; <load align=natural
offset=0>`, and `offset > 0` is the only condition on the `i32.add` — a
zero-offset field emits neither. That is byte-for-byte the idiom the tree
already uses.

**Consequence: a load-side wave commit can be required to produce a
byte-identical `build/wine-assembly.wasm`.** That is a total oracle. It is
strictly stronger than anything the region migration had (which had to fall back
on the shake test and the app corpus), and it means a load-side wave cannot
regress behaviour at all — only fail to compile, or fail the byte diff.

### 3.3 BLOCKER: `store.field` produces an invalid module

The plain store path guards its trailing value on the dialect:

```js
if (stores[head] && !standardWat) { bytes.byte(OP.i32_const); bytes.sleb(0); }
```

The `store.field`, `store.elem` and `store.field-elem` paths **do not** — each
ends with an unconditional `i32.const 0`. Under `standardWat: true` (which is
what the build uses) a store in a void function therefore leaves an i32 on the
stack. Measured:

```
  VALID    i32.store in void func
  INVALID  store.field in void func
  INVALID  store.field then another statement
```

So **no store site anywhere can be converted until this is fixed**, and 5,213 of
the 12,587 sites are stores. This survived because nothing in `src/`, `lib/`,
`tools/` or `test/` uses a layout op at all — a grep for `load.field|store.field|(layout `
across the whole tree outside `tools/watx-src/` returns only the census tool
this document ships with. `tools/watx-spec-suite.js` has no layout coverage.

**Wave 0 is: add the `!standardWat` guard to the three store paths, add spec-suite
cases for every layout op in both dialects, and add a case that asserts the
emitted module validates.** It is a ~3-line change to vendored compiler code, so
it also needs a `tools/check-watx-provenance.js` / `PROVENANCE.md` note and
coordination with whoever owns `watx-src` on the board.

### 3.4 The memarg fork — 6,543 sites

A site spelled `(i32.load offset=92 (local.get $dc))` is *semantically*
identical to `load.field` but not *byte*-identical: the offset lives in the
instruction's memarg instead of a preceding `i32.const` + `i32.add`. Converting
one direction costs 3 bytes per site and one extra instruction; converting the
other is not expressible.

Two files are almost entirely memarg-spelled (`10f-gdi-dc.wat`,
`10g-gdi-raster.wat`), and two are almost entirely add-spelled
(`09d-winsock.wat`, `09c0-window-table.wat`). The split is per-file, not
per-site, which is a hint about who wrote what and a convenient wave boundary.

**Recommendation: do not migrate memarg sites in the byte-identity waves.** Take
the add-form sites first, where the oracle is total. Then, separately, decide
between:

- **(a)** accept the code-size cost and migrate memarg sites under the corpus /
  frame-hash oracle instead of byte identity; or
- **(b)** teach the compiler a memarg lowering for `load.field`/`store.field`,
  selected by a layout attribute (`(layout Foo (memarg) …)`) since the choice is
  uniform per file. This keeps byte identity for both populations, at the cost of
  one lowering flag. It cannot be chosen per-site automatically — the compiler
  cannot know which shape the source had.

(b) is the better end state and should not block (a)'s waves.

#### RESOLVED — (b) landed, as a per-SITE modifier

**(b), and not (a).** Weighed with waves 1, 2 and 4 already on the ground:

| | (a) migrate memarg sites under a weaker oracle | (b) a second lowering |
|---|---|---|
| oracle for the 6,547 | corpus / frame-hash — behavioural, per-app, and silent about the sites no app exercises | byte identity, total, same as every other wave |
| oracle for the 542 already converted | untouched | untouched |
| cost | +3 bytes and one instruction per site, ~20KB of wasm | one modifier, one shared encoder |
| reviewability | every wave needs a behavioural argument | a wave is a shasum |

(a) is not merely weaker, it is weaker *exactly where this tree is thin*: a
frame-hash oracle says nothing about a field only reached on an error path, and
the whole bug class this migration deletes is the offset nobody exercised. And
carrying two lowerings turned out to cost almost nothing — the six accessors'
final memory instruction now goes through one `emitLayoutAccess()` helper
instead of six hand-written opcode triples, which is *less* emitter surface than
before, and it repaired a latent gap on the way (`load.elem`/`store.elem` had no
`i64` branch and emitted an `i32` access for an `i64` field).

**The one correction to (b) as written above: it is a per-SITE modifier, not a
per-layout attribute.** The sentence "the choice is uniform per file" is true of
`10f`/`10g` and false of the thing that matters — a *layout's* sites. DxObject is
497 add-form and 40 memarg, and wave 4 has already converted 367 of them; a
`(layout DxObject (memarg))` attribute would have silently re-encoded all 367,
which is precisely the ambient behaviour change the migration's oracle exists to
prevent. So the spelling lives where the information is:

```wat
(load.field        TthPoint current_y p)   ;; p; i32.const 4; i32.add; i32.load offset=0
(load.field.memarg TthPoint current_y p)   ;; p;                        i32.load offset=4
```

`.memarg` is accepted on the six accessors that end in a memory instruction
(`load`/`store` × `field`/`elem`/`field-elem`) and is a **hard error** on
`elem-addr`, `size-of` and `offset-of`, which compute an address or a constant
and have no memarg to fold into. On any other head it is left alone and lands on
the existing unknown-head error, so `load.field.memrag` names itself rather than
quietly becoming `load.field`.

The modifier is stripped in exactly one place — `watxLayoutMemargHead()` in
`tools/watx-src/compiler-parser.js` — and both the checker and the code
generator call it. That matters more than it looks: a head normalized in the
generator but not the checker is a head whose *type* is inferred for a spelling
that is not the one being emitted, and an `f64` field read `.memarg` would then
be typed `i32` and fail validation.

Compiler manifest digest `ae2df8439fb10bd2fea4d25698b98ac56fb4f77fd973a87f9b5c4fc0e512e042`.
Inert on the canonical build, proven in two isolated worktrees:
`build/wine-assembly.wasm` is
`13168b57f2e81f7b4b7df6b7885e75b07a929df6c8ed7bc148ffa229972a14e3` with the old
compiler and with the new one.

##### What the codemod needed on top of it

`tools/layout-migrate.js` gained `--memarg` (opt-in, never default — turning it
on globally would change what `--gate` means for VSock, WndRecord and DxObject,
all of which still carry unconverted memarg sites, and their build.sh gates
would start failing with nobody having asked for a conversion) and, more
importantly, **`--base-local-from-call`**.

That second flag is wave 2's finding turned into a mechanism. `--base-local` is
a textual name match with no provenance, and `--skip-func` is a blacklist of the
places somebody *noticed* the name meant something else — neither is checkable,
and byte identity cannot help, because a mislabelled site compiles to exactly
the bytes it replaced. `--base-local-from-call` derives the answer instead: a
local is a record pointer inside a function iff, in that function, it is
assigned at least once and *every* assignment to it is `(local.set $X (call
BASECALL …))`. A parameter never qualifies — there is no assignment in scope to
derive provenance from.

It is not theoretical. Both files considered for the first memarg wave carry the
hazard live:

- `src/10d-gdi-region-path.wat`: 46 assignments to `$entry`, spanning **three**
  records — `$gdi_dc_path_entry`, `$gdi_dc_clip_entry`,
  `$gdi_dc_system_clip_entry` — plus one hand-computed base inside the accessor.
- `src/10c1-truetype-hint.wat`: `$a` has 26 assignments and 2 come from
  `$tth_point`; `$b` has 16 and 2. A global `--base-local=a,b` would have
  labelled 24 and 14 unrelated sites as fields of `TthPoint`, byte-identically.

Per-function provenance converts the two functions where `$a`/`$b` provably hold
points and declines the rest, which is an answer no global name list can give.

### 3.4b `TthPoint` — the first memarg wave (`src/10c1-truetype-hint.wat`)

The pipeline's proof, chosen small and clean on purpose: `call $tth_point`, 72
sites, 53 of them memarg, one file, and a genuine struct rather than a union
(contrast §5.4).

```wat
(layout TthPoint
  (field current_x       i32)   ;; +0   26.6, moved by the hinting program
  (field current_y       i32)   ;; +4
  (field original_x      i32)   ;; +8   26.6, the unhinted outline
  (field original_y      i32)   ;; +12
  (field flags           i32)   ;; +16  $TTH_P_ON_CURVE | _END | _TOUCH_X | _TOUCH_Y
  (field original_high_x i32)   ;; +20  higher-precision original, for IUP
  (field original_high_y i32))  ;; +24  ends at +28 == $TTH_POINT_STRIDE
```

**70 of 72 sites converted, 52 of them memarg-spelled — the first memarg sites in
the tree — and `build/wine-assembly.wasm` is unchanged at
`13168b57f2e81f7b4b7df6b7885e75b07a929df6c8ed7bc148ffa229972a14e3`.** The two
declines are one `i64.store` pair-store writing `current_x` and `original_x` as
a single 8-byte write; the width guard refuses it rather than calling an 8-byte
store a 4-byte field, which is the correct answer and needs §3.1's missing
widths, not a codemod change.

One thing this wave found that every later one will hit:
`test/test-wat-truetype-hinting.js` asserts on the *source text*, requiring
`(i32.load offset=4 (local.get $b))` to appear before the `$a` one inside
`$tth_set_line_vector`. The invariant is real — the vector must run from the
first popped point toward the second — but it was pinned to the hand-spelled
idiom, so a byte-identical conversion read as a regression. The assertion now
accepts either spelling and still pins the operand order. **A source-shape
assertion is invisible to the byte-identity oracle**, which is a second reason a
wave must run the family's own suites and not just diff the shasum.

### 3.5 A missing primitive: no `record-addr`

`elem-addr` gives the address of an element of an *array field inside* a struct.
There is no op for "address of element `i` of an array *of* structs" — the shape
every `*_addr` helper in this tree computes:

```wat
(func $vsock_rec (param $idx i32) (result i32)
  (i32.add (global.get $VSOCK_TABLE) (i32.mul (local.get $idx) (global.get $VSOCK_REC_SIZE))))
```

This is not blocking, because `size-of` already covers it byte-identically:
`(i32.mul (local.get $idx) (size-of VSock))`. But note the helper above uses
`(global.get $VSOCK_REC_SIZE)`, not a literal, so substituting `size-of` there
*does* change bytes (a `global.get` becomes an `i32.const`). Either leave the
helper alone and gate the global against the layout (§6.2), or take the byte
delta deliberately in a wave that is not claiming identity. Prefer the former:
the helper is one line and the global is already the single source of the stride.

---

## 4. Two steps, and the first one is free

The migration of any family splits into two independently-committable steps:

**Step 1 — symbolize (byte-identical, always).** Declare the layout. Replace the
constants *only*: `(i32.const 56)` becomes `(offset-of VSock flags)`,
`(i32.const 128)` becomes `(size-of VSock)`. The expression shape is untouched,
so the wasm is unchanged, and the field offsets now exist in exactly one place.
**This step alone removes the entire silent-wrong-constant bug class.**

**Step 2 — funnel (byte-identical for loads; needs wave 0 for stores).**
Replace the whole access with `load.field` / `store.field` / `load.elem`. This
buys the type information, the unknown-field hard error, and readability.

Step 1 is worth landing on its own for families where step 2 is expensive
(class B, memarg-heavy). It has no oracle risk at all.

---

## 5. Proposed layouts for the top families

Field names come from the layout comments already in the source. Written where
the record is defined, not in a central file — a layout belongs beside the code
that owns the record, the way the region declarations do.

### 5.1 `VSock` — `src/09d-winsock.wat` (wave 1)

Transcribed directly from the ASCII table at `09d-winsock.wat:17-43`, which is
already exactly this declaration in prose:

```wat
(layout VSock
  (field state       i32)      ;; +0   0 free/1 created/2 bound/3 listening/4 connected/5 closed/6 connecting
  (field family      i32)      ;; +4   AF_INET
  (field type        i32)      ;; +8   SOCK_STREAM
  (field proto       i32)      ;; +12  0 or IPPROTO_TCP
  (field local_ip    i32)      ;; +16  host byte order, 0 = INADDR_ANY
  (field local_port  i32)      ;; +20
  (field remote_ip   i32)      ;; +24
  (field remote_port i32)      ;; +28
  (field peer        i32)      ;; +32  peer index, -1 unconnected, -2 out-of-process
  (field mode        i32)      ;; +36  0 blocking / 1 nonblocking (FIONBIO)
  (field rx_buf      i32)      ;; +40  guest pointer to the receive ring
  (field rx_cap      i32)      ;; +44
  (field rx_head     i32)      ;; +48
  (field rx_len      i32)      ;; +52
  (field flags       i32)      ;; +56  bit0 read-closed, bit1 write-closed, bit2 reset, bit3 connect pending
  (field backlog     i32)      ;; +60  clamped 1..15
  (field acc_count   i32)      ;; +64
  (field acc_queue   i32 15))  ;; +68  15 child record indexes, ends at +128
```

`size-of VSock` = 128 = `$VSOCK_REC_SIZE`, and the 18 distinct offsets the
census observed are exactly the 18 fields — the record has no unobserved holes.
`acc_queue` is the array field, reached by `load.field-elem` / `store.field-elem`.

### 5.2 `WndRecord` — `src/09c0-window-table.wat`

24 bytes per slot, 6 observed offsets, 72 sites across three files, reached
through `call $wnd_record_addr`. The natural spelling here is `load.elem` off
`$WND_RECORDS` with the slot as index, which would let `$wnd_record_addr`
disappear entirely — but *that* removes a call and is not byte-identical, so it
is a later, separately-argued change. Keep the helper; convert the field
constants.

Note the surrounding shape: most per-window state does **not** live in this
record at all, but in ~20 *parallel* per-slot tables (`$WND_Z_ORDER_TABLE`,
`$WND_HINSTANCE_TABLE`, `$MENU_DATA_TABLE`, …), each with its own reset function
and its own stride. A layout does not describe that shape, and trying to make it
would be a redesign, not a migration. Out of scope; noted so nobody starts it by
accident.

### 5.3 `DxObject` — `call $dx_from_this`, 537 sites

The largest class-A family and the largest single win available: 537 sites, 10
distinct offsets, only 40 memarg, 83% byte-identical-capable. The 54 untypeable
(16-bit) sites need §3.1 resolved or must stay hand-spelled.

**Corrected in the wave: it spans FIVE files, not three.** This section
originally named `09a8-handlers-directx`, `09aa-handlers-d3dim` and
`09ab-handlers-d3dim-core`; the census's own `files:` column also lists
`09ad-handlers-d3d9` (33 sites) and `09a7-handlers-dispatch` (6). Landed layout,
as declared at the top of `09a8-handlers-directx.wat` — `size-of` is 32, which
is `$DX_ENTRY_SIZE` and the stride `$dx_from_this` multiplies by:

```wat
(layout DxObject
  (field type     i32)     ;; +0   0=free,1=DDraw,2=DDSurface,3=DDPalette,...
  (field refcount i32)     ;; +4
  (field misc0    i32)     ;; +8   DDraw: hwnd | DSBuffer: wave_handle | DIDev: device_type
  (field width    u8 2)    ;; +12  u16 — u8[2] for spacing only (§3.1)
  (field height   u8 2)    ;; +14  u16
  (field bpp      u8 2)    ;; +16  u16
  (field pitch    u8 2)    ;; +18  u16
  (field misc1    i32)     ;; +20  union: dib_ptr | palette | next-light | FVF | width
  (field misc2    i32)     ;; +24  union: color key / size | sample rate | instr off | height
  (field flags    i32))    ;; +28  ends at +32 == $DX_ENTRY_SIZE
```

The u16 pairs are declared `u8[2]`: that fixes the offsets and the total size
while being deliberately the wrong width to load through, so the codemod
declines every `i32.load16_u` site against them instead of widening it to i32
and reading two fields as one. See §10's wave-4 notes for why +8/+20/+24 are
`miscN` and not `hwnd`/`dib_ptr`/`color_key_low`.

### 5.4 `GdiObject` — `call $gdi_object_record`, 160 sites — **DECLINED AS ONE LAYOUT, RESOLVED AS SEVEN VARIANTS** (wave 5)

> **Resolution (wave 5).** The two blockers below both stand, and the second one
> is now fixed rather than merely diagnosed. `src/10d-gdi-region-path.wat`
> declares **seven variant layouts** — `GdiPen`, `GdiBrush`, `GdiPenBrush`,
> `GdiBitmap`, `GdiFont`, `GdiPalette`, `GdiMetafile` — each exactly 48 bytes,
> all agreeing on `handle@0` / `type@4`. `tools/union-gate.js` attributes
> every one of the 160 sites to a variant and checks the attribution against the
> source. **Zero sites converted, and the build is byte-identical** — blocker 1
> is untouched, so conversion still waits on §3.4(b). See §5.4.1.

100% memarg-spelled, so it is the natural first customer of §3.4(b) and should
not be attempted before that is decided.

A wave was run against this family anyway, to find out whether §3.4(b) is the
*only* thing in the way. It is not. **Two independent blockers, and the second
one is new.** No source was changed; the wave converted zero sites, which is the
correct outcome and is why it is written down here rather than landed.

**Blocker 1 — the memarg fork (§3.4), confirmed by measurement.** The census
says 160 of 160 sites carry an `offset=` memarg and 0 are byte-identical-capable:

```
call $gdi_object_record   class A   160 sites (12 stores)
  distinct offsets : 0x4 0x8 0xc 0x10 0x14 0x18 0x1c 0x20 0x24 0x28
  memarg form      : 160   untypeable width: 0   byte-identical-capable: 0
```

That number was *not* taken on trust — the census groups by base symbol and can
mis-attribute (§2), so the add-form idiom itself was grepped across all nine
files that hold sites (`10f` 39, `10g` 38, `10e` 35, `10a` 21, `09a` 10, `10b` 7,
`01-header` 4, `10d` 4, `09a4` 2). Zero hits. There is nothing here for an
add-form wave to convert, and `tools/layout-migrate.js` has nothing to decline
because it never sees a candidate.

**Blocker 2 — this record is a discriminated union, not a struct.** A `(layout)`
assigns one name to one offset (§3.1). This record does not have one name per
offset. The comment above the table says so, and the allocator proves it:
`$gdi_object_adopt` (`10d-gdi-region-path.wat`) stores offsets 8/12/16/20 from
four *positional* parameters — `$style`, `$width`, `$color`, `$flags` — and each
of the seven types (1=pen 2=brush 3=bitmap 4=font 5=palette 6=WMF 7=EMF)
reinterprets them:

| offset | pen / brush | bitmap | font | palette |
|---|---|---|---|---|
| +0 | handle | handle | handle | handle |
| +4 | type | type | type | type |
| +8 | style | width | height | count |
| +12 | width | height | weight | capacity |
| +16 | color | bpp | italic | version |
| +20 | flags | flags (DIB/top-down) | — | flags |
| +24 | — | bitsWa | FNT strike | PALETTEENTRY storage WA |
| +28 | — | stride | guest face ptr | — |
| +32/36/40 | — | paletteWa / paletteCount / surfaceId | — | — |

`+24` alone is `bitsWa`, `strike` and `storage` depending on `+4`. A single
`GdiObject` layout naming it anything would be wrong at two thirds of its sites,
and would compile perfectly — precisely the §9 row "field declared in the wrong
order", except that here no ordering is right. The 10 distinct offsets the
census observed are 10 *slots*, not 10 fields; `size-of` would be 48
(`$GDI_OBJECT_STRIDE`), and the record has 4 unobserved trailing bytes.

**So the wave order changes.** Even after §3.4(b) lands a memarg lowering, this
family still cannot be migrated as one layout. It needs a variant design first —
four layouts sharing a two-field header (`GdiPen`/`GdiBrush`, `GdiBitmap`,
`GdiFont`, `GdiPalette`), each declared at 48 bytes so `size-of` still matches
the stride, with each site converted against the layout its enclosing function's
type check already establishes. That is a *typing* exercise, not a codemod: the
tool cannot know which variant a site is, and the type discriminant is not always
in scope at the site. Under the byte-identity oracle it is still safe to attempt —
a mis-assigned variant that lands on the same offset is byte-identical and
therefore harmless, and one that lands on a different offset changes the shasum
and is caught — but it cannot be a tool run the way wave 1 was.

Two smaller notes for whoever picks this up:

- `tools/layout-migrate.js` requires the `(layout ...)` declaration to be in the
  **same file** as the sites it rewrites. Wave 1 was one file so this never came
  up; this family spans nine, and the declaration belongs in `10d` beside the
  allocator. The tool needs a `--layout-file=` before any multi-file wave
  (wave 2 and wave 4 both hit this).
- No §6.1 gate was added for this base symbol. That gate asserts the raw-site
  count for a **migrated** family is zero; against an unmigrated family it fails
  on all 160 sites immediately. The gate belongs with the conversion, not ahead
  of it.

### 5.4.1 The variant field map, as measured

The table in the section above was the *comment's* claim. Every entry below was
re-derived from the creators (`$gdi_object_alloc` call sites, by the literal
type each passes) and from every consumer, with a file:line for each field. The
comment was right as far as it went and **wrong or incomplete in six places**,
all of them listed at the end.

Common to every variant: `handle@0`, `type@4`. `$gdi_object_adopt` (10d:3812)
writes `+8/+12/+16/+20` from four *positional* parameters for all seven types,
and `+24`..`+44` are left to each creator. `$gdi_object_delete` zero-fills the
whole 48 bytes, which is what keeps a reused slot clean.

**`GdiPen` (type 1)** — created at 09a4:47, 09a4:67, 09a:13282, 01-header:185,
10e:1207, 10e:2261.

| off | field | evidence |
|---|---|---|
| +8 | `style` | PS_*; 10e:376 |
| +12 | `width` | `lopnWidth.x`; 10e:390, 10f:810 |
| +16 | `color` | masked `0x03FFFFFF` at 10d:3841-3845, keeping the PALETTEINDEX/PALETTERGB qualifier byte; 10f:811 |
| +20 | `flags` | a bitfield, not a boolean: bit0 forces PS_NULL (set as `style == 5` at 09a4:49; read 10d:2878, 10f:1852), `0x00000F00` end cap (10g:1745), `0x0000F000` join (10d:2885), `0x00010000` geometric (10d:2883, 10g:1695/1740/3312) |
| +24..+44 | reserved | no pen consumer anywhere |

**`GdiBrush` (type 2)** — created at 09a4:77, 09a4:109, 09a4:2576,
01-header:188, 10a:899, 10e:1235, 10e:2284.

| off | field | evidence |
|---|---|---|
| +8 | `style` | BS_* (0 solid, 2 hatched, 3/6 pattern); 10g:782, 10g:3553 |
| +12 | `hatch` | `lbHatch`, **not** a width; 10f:814, 10g:856 |
| +16 | `color` | 10g:785, 10g:3555 |
| +20 | `flags` | 10f:807 |
| +24 | `pattern_bitmap` | a **HANDLE**, not a pointer, live only when `style` is 3 or 6; stored 10a:906, read 10g:742/791, recursively deleted 10e:2597 |
| +28..+44 | reserved | |

**`GdiPenBrush`** — not an object type; the *view* the three genuinely
polymorphic readers need. `$gdi_object_write_pen_brush` loads `+8` and `+20`
at 10f:806/807 **before** it branches on the type, and `$gdi_object_style`
(10e:376) / `$gdi_object_color` (10e:370) serve pen and brush through one load.
It names `style@8`, `color@16`, `flags@20` and leaves **+12 unnamed**, because
that is the one word pen and brush disagree about — a site that wants it must
first say which type it has.

**`GdiBitmap` (type 3)** — created at 10e:306.

| off | field | evidence |
|---|---|---|
| +8 | `width` | 01-header:472 under `+4 == 3` |
| +12 | `height` | 01-header:479 under `+4 == 3` |
| +16 | `bpp` | 10e:427 |
| +20 | `flags` | bit0 public DIB section (10e:418, 10g:4042), bit1 top-down (10e:318 forwards `(flags>>1)&1`), bit2 owns the +24 block, bit4 `0x10` palette holds DIB_PAL_COLORS indices (set 10a:681, read 10g:808) |
| +24 | `bits` | WASM address; 10e:310, and `w2g`'d out as `CreateDIBSection`'s `ppvBits` at 09a4:2286 |
| +28 | `stride` | 10e:311 |
| +32 | `palette` | RGBQUAD table — **or**, when `palette_count == 3`, a three-DWORD channel-mask triplet for a 16bpp DIB (10g:3941+3943, 10g:5821+5822). A nested discriminant. |
| +36 | `palette_count` | 10e:313 |
| +40 | `self_handle` | the record's **own** handle (10e:314 stores `$handle`), round-tripped back into a record through `desc+68` (10g:5752 → 10g:3690) |

**`GdiFont` (type 4)** — created at 10f:670.

| off | field | evidence |
|---|---|---|
| +8 | `height` | 10f:580 under `+4 == 4` |
| +12 | `weight` | 10f:635 |
| +16 | `italic` | 10f:644, `& 1` |
| +20 | `flags` | bit0 = "a bitmap strike is bound at +24" (10b:1016) — a different meaning from the same bit on a bitmap |
| +24 | `strike` | optional installed FNT strike; 10b:1018 store, 10b:1071 load, and 09a4:1264 uses "+24 is non-zero" to mean "raster face, no sfnt tables, answer GDI_ERROR" |
| +28 | `face` | a **GUEST** pointer (`heap_free`'d at 10e:2600), unlike every other pointer in this union; 10f:678 |
| +32 | `width` | `lfWidth`; 10f:600/608 |
| +36 | `pitch_and_family` | `lfPitchAndFamily & 0xFF`; 10f:619/627 |

**`GdiPalette` (type 5)** — created at 10e:77 as `alloc(5, count, 256, version, 4)`.

| off | field | evidence |
|---|---|---|
| +8 | `count` | mutated after creation by `$gdi_palette_resize` (10e:172) |
| +12 | `capacity` | written 10e:78, **read by nothing** |
| +16 | `version` | written 10e:78, **read by nothing** |
| +20 | `flags` | always 4 |
| +24 | `storage` | PALETTEENTRY storage, a WA; 10e:84, freed 10e:2585 |

**`GdiMetafile` (types 6 WMF and 7 EMF)** — created at 10e:452 as
`alloc(type, size, 0, 0, 4)`.

| off | field | evidence |
|---|---|---|
| +8 | `size` | 10e:472, 487, 1000, 1962, 2558 |
| +12, +16 | reserved | written 0 at 10e:453 and read by nothing |
| +20 | `flags` | always 4 |
| +24 | `bits` | WA; stored 10e:457, read 10e:478/557/999/1961/2557 |

**`flags@20` bit 2 (value 4)** means *"the +24 pointer is a `dib_alloc` block
this record owns; free it on delete"*. Exactly one reader in the tree,
`$gdi_object_delete_full` at 10e:2603. It is meaningful for bitmaps, palettes
and metafiles and dead for pens, brushes and fonts.

**Corrections to the old comment.** (1) Pen and brush are **not** one shape:
`+12` is a pen's `width` and a brush's `hatch`. (2) Brush owns `+24`, a pattern
bitmap **handle** — the comment had no brush `+24` at all, and it is the one
`+24` that is not a pointer. (3) Font owns `+32` and `+36`. (4) Bitmap's `+32`
has its own nested discriminant. (5) `surfaceId@40` is misnamed: it is the
record's own handle. (6) Palette `capacity`/`version` and metafile `+12`/`+16`
are write-only, so they are named `reserved` where nothing reads them.

Two latent inconsistencies found and **not** touched, because neither is on a
live path and both belong to whoever owns those initializers:
`$gdi_bitmap_record_init` (10a:34) masks `flags & 3`, dropping both bit2 (owned)
and bit4 (DIB_PAL_COLORS) that the live `$gdi_bitmap_alloc` path passes through
unmasked; and `$gdi_raster_channel_mask` (10g:3940) resolves `desc+68` without
the DX-range pre-check its two siblings do, so an HDC colliding with a live
object handle would be read as a bitmap.

### 5.4.2 What a variant gate has to check that byte identity would not

Byte identity is unavailable here (blocker 1), so `tools/union-gate.js`
plays its role. Three of its four checks are the obvious ones — every site is
attributed, the offset is a **named, non-reserved** field of that variant, and
every variant is `$GDI_OBJECT_STRIDE` bytes with `handle@0`/`type@4`.

The fourth exists because the first three were **measured to be insufficient**.
Mis-attributing `$gdi_font_weight` from `GdiFont` to `GdiPalette` *passed* all
three: both variants declare a field at `+12` (`weight` and `capacity`), so the
offset is owned, the name resolves, and nothing complains. That is the §9
"declared in the wrong order" failure wearing a different hat.

So the gate also harvests each function's **own** `(i32.eq (i32.load offset=4 …)
(i32.const N))` guards straight out of the source and requires the attributed
variant's type to be among them. The same mis-attribution then fails with
*"attributed to GdiPalette (type 5), but the function's own discriminant guard
tests +4 against 4"*. The check is applied **only** to whole-function
attributions: for the three functions that hold more than one variant
(`$gdi_object_delete_full`, `$gdi_object_write_pen_brush`, `$gdi_brush_sample`)
the harvested guards are a union across arms and prove nothing about any one
site, which is exactly why those 26 sites are attributed per-arm by hand.

Of 160 sites: 24 read only the shared `handle`/`type` prefix, 26 are per-arm
sites in a multi-variant function, 23 are cross-checked against the function's
own guard, and the remainder are typed by their **producer** — the handle came
out of a constructor for a known type — which check (4) cannot verify and which
`--list` names explicitly so the weak attributions stay visible.

### 5.5 `Rect` — the Win32 `RECT`, and the first CLASS-C family (wave 6)

```wat
(; FROZEN: RECT — Win32 ABI, windef.h. … ;)
(layout Rect
  (field left   i32)    ;; +0
  (field top    i32)    ;; +4
  (field right  i32)    ;; +8
  (field bottom i32))   ;; +12  ends at +16 == sizeof(RECT)
```

Declared in `src/09a-handlers.wat`. **206 sites converted** (111 memarg-spelled)
across the **25 functions in that file whose Win32 signature takes an LPRECT**,
and `build/wine-assembly.wasm` is unchanged at `06c4052d…` (991330 bytes).

**Why a second layout for a structure `PaintRect` already describes.** §7 asks
for a stated reason and here it is: the two records have the same four fields
and *opposite ownership*. `PaintRect` is a slot of the emulator's own
PAINT_SCRATCH ring, which hands out 16 opaque bytes — three of its live slots
are a `"X, Y"` status string, a single `'>'` glyph byte, and an address passed
straight to `$w2g`. It therefore cannot carry the FROZEN marker (a slot may
legitimately stop being a rect) and `Rect` cannot be merged into it (a guest
RECT may never stop being one). Merging them would have made the frozen
guarantee meaningless for both.

**What `$g2w` proves, and what it does not.** This is the finding of the wave
and it is a *scaling* finding, not a bug. For every class-A family above,
`--base-call` names the record: a pointer out of `$vsock_rec` is a `VSock` and
can be nothing else, so `--base-local-from-call` is a complete derivation and
the wave is a tool run. Class C has **one** accessor for every guest structure
in the tree. `--base-call=$g2w` proves a local holds a guest pointer and says
nothing whatever about which structure it points at. Read at +0/+4/+8/+12 off a
`$g2w`'d local, in `09a-handlers.wat` alone:

| function | local | what it actually is |
|---|---|---|
| `$handle_GetSystemDirectoryA` | `$dst` | an ANSI path buffer |
| `$handle_CoCreateGuid` | `$wa` | a GUID |
| `$handle_GetLogicalDriveStringsW` | `$buf` | UTF-16 text |
| `$locale_format_enum_a` | `$wa` | a locale format record |
| `$draw_text_ex` | `$params` | `DRAWTEXTPARAMS` (5 fields, not 4) |

All five are byte-identically convertible to `Rect`, and all five would be lies
the oracle cannot see — the §10 wave-4 `color_key_low` trap, one class down and
with no `misc0` escape available, because a guest structure's fields are not
ours to rename.

So the attribution here is **external evidence**: each of the 25 functions takes
an `LPRECT` at that argument position per the SDK, and the list is spelled out
in `tools/build.sh` as `--only-func`. That list *is* the reviewable artifact of
the wave. Adding a name to it is a claim about a Win32 prototype, and it has to
be checked against the SDK — never against whether the build still passes,
because it always will.

Two sites stay raw for cause: `$handle_ScrollWindowEx` pair-zeroes left+top and
right+bottom with two `(i64.store … (i64.const 0))`. The width guard declines
them, which is the correct answer (§3.1) and needs an i64-pair spelling that
does not exist, not a conversion.

---

## 6. Safety: what plays the role the region census played

Three gates, in increasing strength.

### 6.1 The completeness gate — `--gate` on the census

The analogue of `tools/region-census.js --gate`. Once a family is migrated, its
raw site count must stay at zero. Add to `tools/struct-offset-census.js`:

```
node tools/struct-offset-census.js --gate=VSock:'call $vsock_rec'
```

which fails the build if any raw-arithmetic site remains against that base. The
migrated-family list lives in the tool (or a small JSON beside it) and grows one
line per wave. This is what stops the tree from re-growing hand-spelled offsets
against a struct that has a layout — the failure mode that makes a migration
undo itself over six months.

The gate must key on the **base symbol**, not on the offset literals: a grep for
`(i32.const 56)` in `09d-winsock.wat` would fire on every unrelated 56 in the
file, and a gate that cries wolf gets deleted.

### 6.2 The wrong-layout gate — generated offsets, checked against the legacy constants

A layout that compiles is not a layout that is *right*. A transposed field pair
compiles perfectly and produces a working-looking emulator that reads
`remote_ip` where it meant `local_ip`.

`lowerIR(forms, checkResult, { layoutsOnly: true })` already returns exactly the
lowered layout records — name, per-field offset/size/count/stride, totalSize —
without compiling anything. Ship `tools/gen-layout-offsets.js`:

- `--write` emits `build/layout-offsets.json`;
- `--check` fails the build if that file is stale (the `gen_dispatch.js --check`
  pattern);
- **during a wave's transition**, it also takes a table of the legacy constants
  harvested by the census for that family and asserts `offset-of` matches every
  one of them. A layout whose fields do not land on the offsets the code has been
  using for years is wrong, and this says so at build time rather than at Diablo's
  main menu.

The census already prints the observed offset set per family
(`--base=… → distinct offsets`), so the input to that assertion is a
copy-and-paste, and the field count check (`observed offsets == declared fields`)
catches both a missing field and an invented one.

### 6.3 The wave oracle — byte identity

For any wave restricted to add-form loads (and, after wave 0, add-form stores):

```bash
node tools/build-compile-wat.js && shasum -a 256 build/wine-assembly.wasm
```

must be **unchanged across the wave commit**. Not "the corpus still passes" —
unchanged. Where a wave deliberately takes a byte delta (a memarg family, or
`$vsock_rec`'s `global.get` → `size-of`), the commit message must say so and
name the expected delta shape, and the wave falls back to the app corpus.

`tools/watx-differential.js` and `tools/watx-matrix.js` already exist for
comparing builds; the byte-identity check here is a shasum, which is the point.

---

## 7. Frozen layouts, and staying debuggable

### Guest-ABI layouts are frozen

3,798 sites are class C. A layout written for `MSG`, `RECT`, `BITMAPINFOHEADER`,
`WNDCLASSA`, `CRITICAL_SECTION` or `WSADATA` is not our record format — it is
Microsoft's, and the guest binary already contains code that reads and writes
those offsets. Reordering one is not a refactor, it is a wire-format change that
breaks every app at once.

Every such layout carries a `(; FROZEN: … ;)` block comment naming the SDK
structure, and `gen-layout-offsets.js --check` treats a change to a frozen
layout's offsets as a build failure, not a regeneration. Frozen layouts are
still worth writing — they are where a mistake is most expensive — but they are
documentation of someone else's decision.

#### LANDED — `tools/gen-layout-offsets.js`

Three refinements to the sketch above, each because the sketch would not have
worked as written:

1. **The SDK structure name comes FIRST in the marker**, so the tool (and a
   reader scanning a build log) can say *which* structure without a heuristic:

   ```wat
   (; FROZEN: RECT — Win32 ABI, windef.h. Four LONGs, in this order, and the
      guest binary already contains the compiled instructions that read them at
      these offsets. … ;)
   ```

   The first token after `FROZEN:` is the structure; everything after it is
   prose. The marker must sit in the comment block immediately above the
   declaration — a marker separated from its layout by code is not a marker for
   it.

2. **The baseline is `tools/layout-offsets.json`, not `build/`.** `build/` is
   gitignored, so a baseline there could only ever be compared against the same
   build that had just written it, and `--check` would be an assertion that a
   file equals itself. The committed baseline lives beside the generator.

3. **`--write` refuses to record a frozen change** unless
   `--force-unfreeze` is passed. Without that the whole guarantee is one
   `--write` away from being erased by exactly the person who broke it — a
   `--check` failure is a prompt to regenerate for every *other* generated file
   in this build, so muscle memory is the threat model.

The offsets are **not recomputed** by the tool: it loads the vendored compiler
and calls the real `lowerIR(…, { layoutsOnly: true })`. `tools/layout-migrate.js`
already carries a second copy of the field-width table (`FIELD_SIZE`), and
build.sh's DxObject comment records what a drift between two such tables costs;
a third copy would be a third chance to be wrong.

Modes: no arguments prints the whole table; `--at=VSock:0x38` answers the RE
session's question (and answers it for an offset *inside* a field, not only one
that starts there — `--at=VSock:0x4a` reports `acc_queue element 1, 2 bytes
into it`); `--field=VSock:flags` is the reverse; `--check` and `--write` are the
gate. `--check` is wired into `tools/build.sh`.

### Offsets must stay discoverable

`tools/find_field.js` finds guest struct accesses by ModRM displacement, and an
RE session routinely goes "the guest writes `[esi+0x38]` — what is at +0x38 in
our record?". Today the answer is a grep for `0x38` near the right helper. After
the migration the number is gone from the source, so:

- `build/layout-offsets.json` (§6.2) is the machine-readable answer, and
  `gen-layout-offsets.js` without arguments prints a human-readable table:
  `VSock +0x38 flags i32`.
- Give it a lookup mode — `--at=VSock:0x38` and the reverse
  `--field=VSock:flags` — so a debugging session is one command, not a JSON dive.
- Keep the prose layout comment in the source **beside** the declaration for the
  semantic notes a layout cannot carry (what `state == 6` means, which bit of
  `flags` is which). The comment stops being the source of the offsets and
  becomes the source of the meanings, which is what it was always good at.

---

## 8. Waves

Ordered by risk, not by size. Each row's site count is from the census.

| wave | scope | files | sites | byte-identical? | notes |
|---|---|---|---|---|---|
| **0 ✅** | compiler: `!standardWat` guard on the three store paths + layout coverage in a runnable test, the differential and the rejection pairs | `tools/watx-src/compiler-codegen.js` + 4 | — | **yes** — emulator wasm unchanged at `aa65465e…` | **DONE, ae6000fc.** Stores are byte-identical too; §3.3 closed |
| **1 ✅** | `VSock` (`call $vsock_rec`), step 1 + step 2 | `src/09d-winsock.wat` | **172 converted** (94 load, 78 store) | **yes** — `aa65465e…` unchanged | **DONE, e5ab038b.** 2 `acc_queue` array sites correctly declined |
| 2 | `WndRecord` field constants (helper kept) | `09c0`, `09c3`, `09c5` | 72 | partial (46 memarg sites deferred) | first multi-file wave; do not touch the parallel tables |
| 3 | decide §3.4 — memarg lowering, or accept the delta | compiler or none | — | — | gates 6,543 sites |
| — | `GdiObject` (`call $gdi_object_record`) | `10a`,`10b`,`10d`,`10e`,`10f`,`10g`,`09a`,`09a4`,`01` | 160 | n/a — 0 add-form sites | **ATTEMPTED, CONVERTED NOTHING (§5.4).** Blocked twice: all 160 memarg (needs wave 3) *and* the record is a discriminated union, which no single layout can express. Needs a variant design, not a codemod |
| **4 ✅** | `DxObject` (`call $dx_from_this`) | `09a8`, `09aa`, `09ab`, **`09ad`**, **`09a7`** | **367 converted** | **yes** — `85edf30b…` unchanged | **DONE.** Five files, not three; 51 u16 sites declined per §3.1, 8 declined by `--skip-func` |
| **✅** | `GdiDcState` (`call $gdi_dc_state_entry`) — the 96-byte per-HDC slot, 24 fields | `10f`, `10b`, `10c` | **38 converted**, all 38 memarg | **yes** — parent and wave both build `78b1d0e6…` | **DONE, 1d40d3d6.** Only reachable through `.memarg`; base by `--base-local-from-call` because `$dc` also holds host DC descriptors and a surface `$desc` with an unrelated field at +36. Remaining raw sites are the constructor's own `$empty`/`$p` |
| **✅** | `PaintRect` (`call $paint_scratch_take`) — the PAINT_SCRATCH ring's 16-byte RECT | `10-helpers`, `09a`, `09c4`, (`09b`) | **32 converted** | **yes** — `6378dc30…` unchanged | **DELIBERATELY PARTIAL.** Covers the 4 of 9 files unclaimed at the time; the rest are held by other lanes, not declined for cause. Needed the zero-arg `--base-call` fix below before it could convert anything |
| **✅** | `GdiDcPath` (`call $gdi_dc_path_entry`) — the 16-byte GDI_DC_PATH_TABLE slot | `10d` | **72 of 72 converted**, all memarg | **yes** — `45f22aa8…` unchanged on interleaved builds | **DONE.** The strongest case yet for `--base-local-from-call`: 10d spells **three** record types through a local named `$entry`, and provenance converted the 20 path functions while declining all 12 clip ones. All four fields are i32, so a5fc1b72's u16/s16/s8 do not apply |
| 5 | remaining class A families ≥ 20 sites | ~15 files | ~1,100 | mixed | mechanical once 1-4 have set the pattern |
| **6 ▣** | **class C — `Rect` (Win32 `RECT`), the pattern-prover** | `09a-handlers` | **206 converted** | **yes** — `06c4052d…` unchanged | **DONE for one structure in one file (§5.5).** Frozen tooling landed (`tools/gen-layout-offsets.js`). The rest of class C is **not** mechanical — see §10 |
| 6 | class C, the remaining structures | many | ~3,590 | mixed | highest value, highest blast radius; each layout is frozen AND each needs its own external attribution |
| 7 | class B raw families | many | 6,079 | mixed | step 1 (symbolize) only, until a family proves it is one struct |

**Recommended first session: wave 0 + wave 1.** Wave 0 is a three-line fix with
a test; wave 1 is one file, has a total oracle for its 97 loads, a byte-identity
requirement after the store fix, and a dedicated test suite
(`test/test-wat-winsock.js`, `test/test-vlan-*.js`,
`test/test-win16-hearts-vlan.js`) that exercises the record end to end across
two processes. If wave 1's diff is byte-identical and the vlan tests pass, the
pattern is proven and waves 2+ are mechanical.

**Do not do a big bang here.** The region migration could, because its 648
literals were a *base* address each, and a wrong base traps loudly. A wrong field
offset does not trap; it returns a plausible number. The whole reason this
migration is affordable is the byte-identity oracle, and that oracle only tells
you something if the diff it is applied to is small enough to read when it comes
back non-empty.

---

## 9. Failure-mode catalogue

| failure | how it shows | what catches it |
|---|---|---|
| Field declared in the wrong order | reads a neighbouring field; plausible values; symptom far away | §6.2 offset assertion vs the census's observed offsets |
| A field missing from the layout, so every later field shifts | everything after it is wrong at once | §6.2 field-count check + `size-of` vs the record-size global |
| Layout has implicit padding expectations | none — the lowering inserts **no** padding | (documented; do not add padding without changing every consumer) |
| A store site converted before wave 0 | **build fails** — `WebAssembly.validate` rejects the module | the build itself, loudly. This one is safe |
| The base call takes **no arguments** | the codemod converts **nothing** and says so quietly: `base locals verified in 0 function(s)`, which reads like "this family has no convertible sites" | nothing did — `$paint_scratch_take` looked unconvertible for a whole wave. Both matchers keyed on `(call $fn ` *with a trailing space*, which a zero-arg call never has. Fixed in `callsBase()`; if a family reports 0 against files you can see sites in, check the accessor's arity first |
| A gate keyed on **source line numbers** | declaring a layout at the top of a file shifts every site below it, and the gate fails `NOT ATTRIBUTED` on code nobody touched | the gate itself, loudly — it cannot mis-attribute, only lose attribution. `tools/union-gate.js`'s `BY_SITE` is the one that does this (10e/10f/10g). Renumber after checking each site still matches its comment; **never** delete the entry to make the build pass |
| A 16-bit field "converted" by widening it to i32 | reads two fields as one; silent | §3.1 — untypeable sites stay hand-spelled; the census counts them per family |
| memarg site converted inside a byte-identity wave | shasum differs | §6.3 |
| A frozen ABI layout reordered "for tidiness" | every guest app breaks at once | §7 frozen marker + `--check` treating it as an error |
| New raw arithmetic added against a migrated struct | migration silently reverses over months | §6.1 `--gate` |
| Census merges two unrelated records into one family | a layout that fits neither | eyeball every family before writing its layout (§2) |

---

## 10. Status

- `tools/struct-offset-census.js` — **landed** (e2562060) with this document.
- Byte-identity verdict — **measured** (§3.2), against the production compiler
  options, not inferred from reading the codegen.
- **Wave 0 — LANDED (ae6000fc).** The `!standardWat` guard is on all three store
  paths, and the store half of the byte-identity verdict is now proven too:
  `store.field` compiles to the same bytes as
  `(i32.store (i32.add ptr (i32.const N)) v)`. Rebuilding the emulator with the
  fixed compiler and no source change leaves `wine-assembly.wasm` at
  `aa65465e…` byte for byte. Oracle coverage landed with it:
  `test/test-watx-compiler-layout.js`, two `refSource` differential modules, and
  nine rejection pairs. **§3.3 is closed — stores are no longer blocked.**
- **Wave 1 — LANDED (e5ab038b).** `VSock` declared in `src/09d-winsock.wat`
  exactly as §5.1 proposed; all **172** scalar sites (94 loads + 78 stores)
  converted by `tools/layout-migrate.js`; `build/wine-assembly.wasm`
  **byte-identical** at `aa65465e…` (989296 bytes), measured in an isolated
  worktree at HEAD. `build.sh` carries the §6.1 back-stop gate for it. The two
  `acc_queue` array sites were correctly declined — their
  `(i32.add (i32.const 68) (i32.mul i 4))` associativity is not
  `load.field-elem`'s lowering, so converting them would not have been
  byte-identical. They are §4 step-1 (`offset-of`) material.
- `tools/layout-migrate.js` — **landed** with wave 1, and is the wave tool for
  everything below.
- **`GdiObject` — attempted, declined, no source change (§5.4).** Zero of its
  160 sites are convertible: 160/160 are `offset=` memarg (confirmed against the
  add-form idiom by grep across all nine files, not just by the census), and the
  record is a *discriminated union* whose offsets 8-40 mean different things for
  each of seven object types — a shape a single `(layout)` cannot express at all.
  `build/wine-assembly.wasm` unchanged, necessarily: nothing under `src/` was
  touched. The finding moves this family out of "mechanical once wave 3 lands"
  and into "needs a variant-layout design first".
- **Wave 4 — LANDED.** `DxObject` declared in `src/09a8-handlers-directx.wat`;
  **367** sites converted across **five** files (09a8 217, 09aa 80, 09ab 45,
  09ad 19, 09a7 6); `build/wine-assembly.wasm` **byte-identical** at
  `85edf30b…` (990911 bytes), both arms built from detached worktrees at
  `2a5b4d58`. Marbles renders pixel-identically (0/307200 pixels differ).
  `build.sh` carries the §6.1 back-stop, verified to fail (exit 1, all 367
  sites named) on the unconverted tree — a gate that cannot fail is not a gate.
  Declined by design: **51** u16 sites (§3.1) and **8** `--skip-func` sites.
- **Wave 5 — `GdiObject`, done as far as it can go without §3.4(b).** Seven
  variant layouts declared in `src/10d-gdi-region-path.wat` (§5.4.1);
  **0 of 160 sites converted**, because all 160 are memarg-spelled and
  `load.field` lowers to the add form. `build/wine-assembly.wasm` is
  **byte-identical** across the wave — `25961751…` — so the declarations and the
  gate cost nothing and risk nothing. `tools/union-gate.js` attributes all
  160 sites and is wired into `build.sh`; verified to fail the build (exit 1) on
  a planted mis-attribution. When §3.4(b) lands, this family converts in one
  byte-identical pass with its typing already proven.
- **Wave 6 — the class-C PROVER. LANDED for `Rect`, and the honest answer to
  "does this scale" is NO, not the way class A did.** `tools/gen-layout-offsets.js`
  ships with the frozen marker, the committed `tools/layout-offsets.json`
  baseline, the `--at`/`--field` lookup modes and the `--check` build gate;
  `Rect` is declared in `src/09a-handlers.wat` with the FROZEN marker and
  **206 sites are converted**, `build/wine-assembly.wasm` byte-identical at
  `06c4052d…`. Both gates verified to fail: `--check` on a planted extra field
  (and `--write` refusing to record it), and `layout-migrate --gate` on a
  planted raw site in **both** the add form and the memarg form.
- Wave 7 is still design.

### What wave 6 says about the other 3,590 class-C sites

The pattern *works* — the oracle is total, the codemod needs no new flag, the
gate has teeth, and a frozen ABI layout is checkable. What does not carry over
is the thing that made waves 1-5 tool runs:

1. **Class C has no discriminating base call.** Every family so far was named
   by its accessor. Class C's accessor is `$g2w` and there is exactly one of it,
   so `--base-local-from-call` degrades from "which record is this" to "is this
   a guest pointer" — a question whose answer is *yes* for every class-C site in
   the tree, including the string buffers and GUIDs in §5.5's table. **The
   provenance mechanism that made waves 2-5 safe does not exist here.**
2. **So the unit of work is the STRUCTURE, and the evidence is the SDK.** Each
   class-C wave is: pick a Win32 structure, enumerate the functions whose
   prototype takes a pointer to it, list them by name, convert only there. That
   list cannot be derived from the tree — it is external knowledge, checked
   against the SDK by a human, once per function. `Rect` needed 25 such
   judgements for 206 sites (8 sites per judgement); a structure reached from
   fewer places pays worse.
3. **Byte identity is silent about all of it.** Every mis-attribution available
   here compiles to the bytes it replaced. The oracle proves the *program* did
   not change, which is exactly why it says nothing about whether the *name* is
   true. It is not a substitute for the per-function check, and on a class-C
   wave it never will be.
4. **The census cannot even scope the wave.** It groups class C by base symbol,
   so its rows are `$g2w @ 09a-handlers.wat: 764` — one file, dozens of unrelated
   structures. There is no "family" to point a wave at. A per-structure census
   would need to key on the *API signature*, which is `src/api_table.json`'s
   territory, not the census's.
5. **What would actually move the needle**: a `$g2w`-shaped accessor per
   structure (`$g2w_rect(guest) -> wa`) would restore the class-A property and
   turn the rest of class C mechanical again — but it adds a call per site and
   is therefore NOT byte-identical, so it cannot be done under this oracle. That
   is a real trade and it should be decided deliberately, not drifted into.

Realistic read: class C is worth doing for the structures whose offsets are
*load-bearing and repeated* — `RECT`, `POINT`, `MSG`, `BITMAPINFOHEADER`,
`CRITICAL_SECTION` — one structure per commit, each with its function list in
`build.sh`. It is not worth attempting as a sweep, and any plan that quotes
"3,798 sites" as one number has already made the mistake.

**What the next two structures on that list actually cost — and the second
gate class C needs, which is not the SDK one.** `POINT` and `MSG` were taken
straight after `RECT` and they answer the "is class C mechanical yet" question
differently from how the list above implies. `POINT` converted **18 sites over
six functions**; `MSG` converted **nothing at all** and is a documented
decline. Neither number is about how much a program uses the structure —
notepad cannot draw a menu without both — it is about *how this tree spells the
access*:

> **The layout system describes `i32.load`/`i32.store` on a `$g2w`'d local. Most
> guest-structure traffic here is not written that way — it goes through the
> `$gs32`/`$gl32` guest accessors, which take a GUEST address and are calls.**

`$handle_GetMessageA` fills its `LPMSG` with **44 `$gs32` calls** and does
not hold a WASM pointer to it at any point; `$handle_DispatchMessageA` reads
the same MSG back with `$gl32`. Across the whole tree there is exactly **one**
`$g2w`'d local ever used as a MSG (`$msg_wa` in `$handle_TranslateAcceleratorA`,
two field reads), which is well under the bar for a frozen layout, a gate and a
`--only-func` list. The same effect, less totally, is what caps `POINT` at 18:
eleven functions with an `LPPOINT` in their SDK prototype — `GetCursorPos`,
`Get`/`Set`/`OffsetViewportOrgEx`, `Get`/`Set`/`OffsetWindowOrgEx`,
`GetCurrentPositionEx`, `GetBrushOrgEx`, `DPtoLP`, `LPtoDP` — are declined
because of the *access kind*, not because of any doubt about the type.

Two things follow for anyone scoping wave 7. First, **census the accessor
spelling before the SDK prototypes**: `grep 'local.set $X (call $g2w'` inside
the candidate functions is a one-minute upper bound on the wave, and it would
have said "MSG is zero" before any judgement was made. Second, a structure can
be *right* and still not be *worth* a layout, and the honest form of that is a
decline recorded with the count — not a layout declared over two sites.

Two smaller notes from the same wave. `--base-local` (rather than
`--base-local-from-call`) is legitimate for an array walk — `$handle_MapWindowPoints`
does `p = p + 8` and `$handle_PolylineTo` indexes `p + (n-1)*8`, so neither
local is `$g2w`'d on every path — and `--only-func` is what keeps it honest,
because inside those two functions the local is a `POINT*` on every path there
is. And the §10 attribution trap gets sharper as the structure gets smaller:
at eight bytes, `$handle_GetDCOrgEx` (an `LPPOINT`) and
`$handle_QueryPerformanceCounter` (a `LARGE_INTEGER`) sit four lines apart in
`09a7-handlers-dispatch.wat`, write `+0`/`+4` off a `$g2w`'d local both named
`$wa`, and convert byte-identically either way. Only the `--only-func` list
tells them apart.

**Waves 4 and 5 answered the union question two different ways, and the
difference is the variants' *shape*, not their number.** `DxObject` names the
overloaded words `misc0`/`misc1`/`misc2` and keeps one layout, because its
variants agree on width and count and differ only in meaning. `GdiObject` could
not: its readers are *type-specific functions*, so the useful thing is for
`(load.field GdiFont strike …)` to be a compile error in a bitmap function. Rule
of thumb: **name the slot `miscN` when one function reads it for several types;
split the layout when different functions read it for different types.**
`GdiPenBrush` is what the two approaches look like when both apply at once — a
variant that names only the three fields pen and brush agree on, for the three
readers that genuinely serve both.

### Three things wave 4 adds

1. **The census under-reported the family's file span, and it is the one number
   a wave must not take on trust.** §5.3 said three files from the census's
   `files:` column; the family is actually FIVE — `09ad-handlers-d3d9.wat` (33
   sites) and `09a7-handlers-dispatch.wat` (6) were missing. Re-run
   `--base=` yourself and read the file list before scoping a wave; a missed
   file is not a wrong conversion, but it is a §6.1 gate that passes while the
   family is still half hand-spelled.
2. **A discriminated union does not have to end the wave — name the fields for
   what they ARE.** `GdiObject` was declined partly for being a union (§5.4),
   and `DxObject` is one too: +8/+20/+24 mean hwnd/dib_ptr/color-key for a
   surface, wave handle/next-light/sample-rate for a sound buffer, FVF/width and
   instruction-offset/height for D3DIM. The first draft of this layout called
   +20 `dib_ptr` and +24 `color_key_low` after the file's own header comment —
   and the codemod then emitted
   `(store.field DxObject color_key_low … (local.get $size))`, a field name that
   is a lie at 24 of its 29 sites. That is the *same* plausible-but-wrong trap
   §1 is about, one level up, and **byte identity cannot see it**: the bytes are
   identical either way, so the oracle says nothing about whether the name is
   true. The fix is the convention the file had already invented for +8 —
   `misc0`/`misc1`/`misc2` plus a table of per-type meanings — which keeps the
   offsets in one place without asserting a type the record does not have.
   A union blocks a layout only when its variants differ in *width or count*.
3. **`--skip-func`: a local's NAME is not its provenance.** The codemod matches
   `(local.get $entry)` on what it is called. A sweep of all five files found
   three places where that name means something else — 12-byte
   `D3DIM_STATEBLOCKS` records in 09ab's four stateblock functions, a *packed
   debug key* in `$d3dim_lights_refresh`, and a PE message-table cursor in
   09a7's `$message_table_lookup` — the worst being `$d3dim_lights_refresh`,
   where the same local is a real DX entry at one line and the packed key 19
   lines later. Converting those would have compiled, passed every test and
   produced a byte-identical wasm while claiming `refcount` for a bit-packed
   integer. `--skip-func` suppresses *name*-based matching inside named
   functions; a `(call $dx_from_this …)` base still converts there, because that
   one evidences itself. **Do the provenance sweep before the wave, not after:
   the oracle will not do it for you.**

### Two things learned in wave 1 that change the plan slightly

1. **The codemod is the safe path, not the risky one.** Byte identity is a
   *complete* correctness proof — identical bytes are the identical program — so
   a mechanical rewrite verified by shasum is strictly safer than 172 hand edits
   verified by review. Expect later waves to be tool runs, not patches.
2. **`tools/check-test-manifest.sh` only sweeps `test/test-*.js`.** The 20
   `test/watx-compiler-*.test.js` suites are run by nothing at all — no runner,
   no npm script. That is the same blind spot the manifest gate exists to close,
   one filename convention over, and it is part of why the §3.3 defect was
   reachable. Not fixed here; it needs whoever owns those suites to confirm they
   are green before they are wired in.

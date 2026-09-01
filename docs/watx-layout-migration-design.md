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
records that already exist. Field types are `i32 | i64 | f32 | f64 | u8 | ptr*`
(`ptr` is 4 bytes). Bad count/stride is a hard compile error, and so is an
unknown layout or field name — the codegen comments record that these used to
default silently to offset 0 / size 16, which turned a typo into a wild access.

**There is no `u16` and no signed byte.** 1,258 sites in the tree are 16-bit or
`load8_s` accesses and cannot be expressed by a field today.

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
distinct offsets, only 40 memarg, 83% byte-identical-capable. Spans three files
(`09a8-handlers-directx`, `09aa-handlers-d3dim`, `09ab-handlers-d3dim-core`),
which is why it is not wave 1 — a three-file wave wants the one-file wave's
lessons first. The 54 untypeable (16-bit) sites need §3.1 resolved or must stay
hand-spelled.

### 5.4 `GdiObject` — `call $gdi_object_record`, 160 sites

100% memarg-spelled, so it is the natural first customer of §3.4(b) and should
not be attempted before that is decided.

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

Every such layout carries a `(; FROZEN: Win32 ABI — offsets are fixed by the
guest, not by us ;)` block comment naming the SDK structure, and
`gen-layout-offsets.js --check` treats a change to a frozen layout's offsets as
a build failure, not a regeneration. Frozen layouts are still worth writing —
they are where a mistake is most expensive — but they are documentation of
someone else's decision.

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
| **0** | compiler: `!standardWat` guard on `store.field` / `store.elem` / `store.field-elem`; spec-suite coverage for every layout op incl. a validate check | `tools/watx-src/compiler-codegen.js`, `tools/watx-spec-suite.js` | — | n/a (compiler-only; emulator wasm must be byte-identical, since nothing uses these ops) | **blocks every store conversion.** Needs a PROVENANCE note and board coordination |
| **1** | `VSock` (`call $vsock_rec`), step 1 + step 2 | `src/09d-winsock.wat` | 179 (97 load, 82 store) | **yes, 100%** | one file, one helper, 0 memarg, 0 untypeable, layout already written in prose, 14 existing tests |
| 2 | `WndRecord` field constants (helper kept) | `09c0`, `09c3`, `09c5` | 72 | partial (46 memarg sites deferred) | first multi-file wave; do not touch the parallel tables |
| 3 | decide §3.4 — memarg lowering, or accept the delta | compiler or none | — | — | gates 6,543 sites |
| 4 | `DxObject` (`call $dx_from_this`) | `09a8`, `09aa`, `09ab` | 537 | 83% | biggest single win; 54 sites blocked on §3.1 (u16) |
| 5 | remaining class A families ≥ 20 sites | ~15 files | ~1,100 | mixed | mechanical once 1-4 have set the pattern |
| 6 | class C frozen ABI layouts, one structure at a time | many | 3,798 | mixed | highest value, highest blast radius; each layout is a frozen declaration |
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
| A 16-bit field "converted" by widening it to i32 | reads two fields as one; silent | §3.1 — untypeable sites stay hand-spelled; the census counts them per family |
| memarg site converted inside a byte-identity wave | shasum differs | §6.3 |
| A frozen ABI layout reordered "for tidiness" | every guest app breaks at once | §7 frozen marker + `--check` treating it as an error |
| New raw arithmetic added against a migrated struct | migration silently reverses over months | §6.1 `--gate` |
| Census merges two unrelated records into one family | a layout that fits neither | eyeball every family before writing its layout (§2) |

---

## 10. Status

- `tools/struct-offset-census.js` — **landed** with this document.
- Byte-identity verdict — **measured** (§3.2), against the production compiler
  options, not inferred from reading the codegen.
- `store.field` invalid-module defect — **found and reproduced** (§3.3), not yet
  fixed. Wave 0.
- Everything from §4 on is design. Nothing in `src/*.wat` has been changed.

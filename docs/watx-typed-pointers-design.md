# WATX typed pointers, casts, and layout unions

Status: **specification**, user-signed-off 2026-09-01. Three tiers, each with its
own oracle. This document is written against the *actual* internals of
`tools/watx-src/` (parser → stages → codegen), and every rule below cites the
line of the compiler that makes it true or that has to change.

Read [docs/watx-layout-migration-design.md](watx-layout-migration-design.md)
first: `(layout ...)`, the six accessors, the `.memarg` modifier and the
`FROZEN` marker are all from there. This document adds *types on the pointers*
that those accessors take as their base operand.

---

## 0. The problem, stated as it actually bites

`(load.field GdiBitmap bits (local.get $p))` compiles to `p + 24` and an
`i32.load`. Nothing in the compiler knows or asks what `$p` points at. If `$p`
is in fact a font record, `+24` is a bitmap strike pointer read as a pixel
address — a plausible value, no trap, and the symptom lands thousands of
instructions later. `docs/watx-layout-migration-design.md` §5.4 calls this the
wrong-layout bug and it is the single failure mode the layout migration was
unable to close: the migration made the *offsets* symbolic, but the *base* is
still a bare i32.

Two tools exist today because the compiler cannot answer that question:
`tools/gdi-variant-gate.js` (561 lines) and `tools/control-variant-gate.js` (474
lines). Both hold, as hand-maintained JS data, an attribution from "function or
site" to "which variant this record is". That attribution is real reverse
engineering and it deserves to survive; what it does *not* deserve is to live in
a table that has to be re-derived by grep every time a function is renamed.

A typed pointer says it in the source, at the site, in the author's own words:

```wat
(func $gdi_bitmap_bpp (param $rec ptr<GdiBitmap>) (result i32)
  (load.field GdiBitmap bpp (local.get $rec)))
```

and the compiler refuses `(load.field GdiFont height (local.get $rec))` in that
function's body with a located error.

---

## 1. What is already true (so the tiers are smaller than they look)

Four facts about the current compiler, each verified by reading it. They are the
reason this feature is mostly *checking* rather than *plumbing*.

1. **`ptr<Name>` already tokenizes as one symbol.** `compiler-parser.js:35` puts
   `<` and `>` in both `WATX_CHAR_SYMBOL_START` and `WATX_CHAR_SYMBOL`. No
   lexer change.

2. **`ptr<Name>` is already a legal *field* type, four bytes wide.**
   `watxLayoutFieldSize()` (`compiler-stages.js:192`) returns 4 for any token
   whose first three characters are `ptr` — the `ptr$Rec` spelling of §158 of the
   layout-migration design. `ptr<Rec>` gets the same treatment for free. Tier 1
   gives that spelling a *meaning* it does not have today.

3. **`ptr<Name>` already erases to i32 everywhere a valtype is needed.**
   `stackType()` (`compiler-stages.js:287`) prefix-matches `ptr`; `valtypeOf()`
   (`compiler-codegen.js:635`) returns `VALTYPE.i32` for anything it does not
   recognize. So `(param $x ptr<L>)`, `(result ptr<L>)` and `(local $x ptr<L>)`
   *compile today* and produce exactly the i32 they would produce without the
   annotation. **This is the erasure guarantee, and it is a property of code
   that already shipped, not of code this feature adds.**

4. **The advisory type checker does not run in the shipped build.**
   `compile()` passes `requiredOnly: production` (`compiler.js:280`), and
   `checkTypes` returns before `checkFuncBody` under that flag
   (`compiler-stages.js:392`). In streaming mode function bodies are not even
   parsed at check time (`compiler.js:220-234`). **Therefore every diagnostic
   this feature promises must be raised from `compileExpr` in
   `compiler-codegen.js`**, which is the only pass that walks every body in
   every mode. That is where `lookupLayout`/`lookupField`
   (`compiler-codegen.js:882-903`) already raise their located refusals, and the
   new ones follow that pattern exactly.

Fact 3 is what makes the byte-identity oracle credible rather than aspirational.
Fact 4 is what makes "add it to `checkTypes`" the wrong answer.

---

## 2. Tier 1 — typed pointer locals, params, results

### 2.1 Syntax

```wat
(param  $rec ptr<GdiBitmap>)
(result ptr<GdiBitmap>)
(local  $rec ptr<GdiBitmap>)
(let    $rec ptr<GdiBitmap> INIT)
(field  next ptr<WndRecord>)        ;; already legal; now carries a type
```

`ptr` with no `<...>` keeps its present meaning: a 4-byte pointer field of
unknown pointee, documentation only. `ptr<>` and `ptr<` with no closing `>` are
refused.

### 2.2 Type rules

The static pointer type of an expression, written `P(e)`, is either a layout
name or **`⊥` ("unknown")**. It is computed by a new pure function
`ptrTypeOf(expr, func)` in `compiler-codegen.js`:

| expression | `P` |
|---|---|
| bare `$x`, `(local.get $x)` | the declared `ptr<L>` of that param/local, else `⊥` |
| `(cast ptr<L> E)` | `L` (Tier 3) |
| `(call $f ...)` where `$f` declares `(result ptr<L>)` | `L` |
| `(load.field L f p)` / `.memarg` / elem forms, where field `f` has type `ptr<M>` | `M` |
| `(let $x ptr<L> E)` | `L` |
| anything else | `⊥` |

**`⊥` is not `i32`; it is "no claim".** `⊥` is compatible with every pointer
type, in both directions, silently. This is the single most important rule in
the document and it is a deliberate divergence from the brief's "i32 → ptr\<L\>
requires a cast": the tree has 61 `src/*.wat` files and tens of thousands of
untyped i32 pointer expressions, and a rule that demanded a cast at every
boundary between typed and untyped code would either fail the build everywhere
or force a mechanical cast storm that means nothing. Opt-in typing requires an
"unknown" that is quiet. A cast is required to go from a *known-different*
pointer type; it is not required to go from an unclaimed i32.

Compatibility `L ≈ M` holds when:

- `L === M`; or
- one of them is a `(view ...)` declared `(of ... )` over the other (Tier 2 §4.3); or
- `M` is a variant of the `(layout-union L ...)` — a variant pointer is usable
  where the union (prefix) pointer is expected, never the reverse (Tier 2 §4.2).

Otherwise `L ≉ M` and the sites below refuse.

### 2.3 Where it is checked

Four sites, all in `compileExpr`, all located, all hard errors in every mode:

1. **Accessor base.** For `load.field` / `store.field` / `load.elem` /
   `store.elem` / `load.field-elem` / `store.field-elem` / `elem-addr` (and each
   one's `.memarg` spelling), if `P(base) = M ≠ ⊥` and `M ≉ L` where `L` is the
   accessor's layout, refuse.
2. **Local assignment.** `(local.set $x E)`, `(set! $x E)`, `(let $x ptr<B> E)`
   where `$x` is `ptr<B>`, `P(E) = A ≠ ⊥`, `A ≉ B`: refuse.
3. **Call argument.** `(call $f ... E ...)` where the matching param is
   `ptr<B>`, `P(E) = A ≠ ⊥`, `A ≉ B`: refuse.
4. **Return.** `(return E)` in a function declaring `(result ptr<B>)` with
   `P(E) = A ≠ ⊥`, `A ≉ B`: refuse. Fall-through results are **not** checked —
   the last-expression rule is approximate in this compiler (`checkTypes` only
   *warns* about it, `compiler-stages.js:386`) and a hard error resting on an
   approximation is a false positive waiting to happen.

`call_indirect` is **not** checked: its signature is a `(type ...)` reference,
which carries valtypes and cannot carry a pointee. Documented gap, not an
oversight — a table of function pointers is exactly where the type is unknown.

### 2.4 Diagnostics

Following `lookupField`'s shape (`compiler-codegen.js:896`): `file:line:col`,
name what was found and what was expected, and say what to write instead.

```
src/10f-gdi-dc.wat:618:11: load.field GdiFont height: base is ptr<GdiBitmap>,
  not ptr<GdiFont>. A pointer's type is checked at every layout accessor; if
  this record really is a GdiFont here, say so with (cast ptr<GdiFont> ...)
  and the cast becomes the one place a reader can check the claim.
```

An unknown layout inside `ptr<...>` is its own refusal, at the *declaration*
site, for the same reason `checkTypes` refuses an unknown field type at the
declaration (`compiler-stages.js:236`): one diagnostic naming the local, not one
per use.

```
src/10a-gdi-bitmap.wat:44:3: (param $rec ptr<GdiBtimap>): no such (layout ...)
  or (layout-union ...) declaration named 'GdiBtimap' (typo?).
```

### 2.5 The `(field x i8 N)` wart

`i8` is not in `WATX_LAYOUT_FIELD_TYPES` (`compiler-stages.js:186`), so
`checkTypes` refuses it — but only when the body walk runs. Under
`requiredOnly` the field reaches `lowerIR`'s `sizeOfType`, which throws
`WATX internal: no byte width for layout field type 'i8'` — an internal-error
message for a source-level typo, with no file or line. Tier 1 makes the
declaration check unconditional (it is a per-field check on a handful of forms,
not a body walk, so it costs nothing in production) and names the fix:

```
src/09c3-controls.wat:281:5: Layout ControlTextState field flags: 'i8' is not a
  layout field type — spell the signedness: u8 or s8. Layout field types are:
  f32, f64, i32, i64, ptr, s16, s8, u16, u8, weak, ptr<Name>.
```

### 2.6 Erasure guarantee and oracle

Tier 1 emits **no instruction and no byte**. Every annotation reaches
`valtypeOf`/`physicalLocalType` and becomes `i32`, which is what those functions
already do with it (§1 fact 3).

**Oracle:** a full `bash tools/build.sh` produces a `build/wine-assembly.wasm`
whose sha256 equals the pre-change build's, taken in an isolated worktree so no
other lane's edits are in the comparison. Plus the suites the tree already runs:
`tools/watx-differential.js` (against `lib/compile-wat.js`),
`tools/watx-spec-suite.js`, `tools/watx-rejection-pairs.js`, and
`test/watx-compiler-production.test.js`.

---

## 3. Tier 3 — `(cast ptr<Layout> EXPR)`

### 3.1 Default build

```wat
(cast ptr<GdiBitmap> (call $gdi_object_record (local.get $h)))
```

compiles to exactly what `EXPR` compiles to. The handler is
`compileExpr(expr[3], ...)` and nothing else; `exprProducesValue` forwards to
`EXPR`; `inferExprType` returns `'i32'`; `ptrTypeOf` returns the layout. Arity
is exactly 2 and is enforced with the existing `requireArity(2)` helper
(`compiler-codegen.js:2695`) so a `cast` cannot silently swallow a third operand
the way pre-`b0a97b99` direct emitters did.

**Oracle: byte identity again.** Adding a cast to a working file must not change
one byte of the module.

### 3.2 `--checked-casts`

A compiler option (`options.checkedCasts`, surfaced as a flag on
`tools/build-compile-wat.js`) that changes what a cast *into a variant of a
tagged layout-union* emits, and nothing else:

```
  <EXPR>                    ;; the pointer, once
  local.tee $__cast_tmp
  i32.load offset=<tagOff>  ;; the union's tag field, at its declared width
  i32.const <tagValue>
  i32.ne
  if
    unreachable             ;; fail fast — the $crash_unimplemented philosophy
  end
  local.get $__cast_tmp
```

This is the emulator's own rule applied to the compiler: a stub that returns a
plausible wrong answer is worse than a crash that names the problem
(`docs/CLAUDE.md`, "Fail-fast stubs"). A checked build is a **debugging build**,
not the shipped one — it is not byte-identical by construction, and the flag is
off in `tools/build.sh`.

The flag changes **nothing** for:

- a cast into a plain `(layout ...)` — there is no tag to read;
- a cast into a variant of an **untagged** `(layout-union ...)` — likewise;
- a cast into the union or a view name itself — the tag is not being narrowed.

That is a documented no-op, not a silent one: `--checked-casts` prints a count
of casts checked and casts skipped, so "I turned it on and nothing changed" has
an answer.

---

## 4. Tier 2 — `(layout-union ...)`, `(view ...)`, `(enum ...)`

### 4.1 Syntax

```wat
(enum GdiType (PEN 1) (BRUSH 2) (BITMAP 3) (FONT 4)
              (PALETTE 5) (WMF 6) (EMF 7))

(layout-union GdiObject
  (tag type GdiType)
  (prefix
    (field handle i32)
    (field type   i32))
  (variant GdiPen (tag-value PEN)
    (field style i32) (field width i32) (field color i32) (field flags i32)
    (field reserved i32 6))
  (variant GdiBitmap (tag-value BITMAP)
    (field width i32) (field height i32) ...)
  ...)
```

- **`(prefix ...)`** fields are laid out first, at offset 0, and are **prepended
  to every variant at the same offsets**. This is what makes `handle@0` and
  `type@4` true of all seven GDI variants by construction instead of by a gate
  that checks it afterwards.
- **`(tag FIELD ENUM)`** names a field *within the prefix* as the discriminant
  and binds its values to an `(enum ...)`. Optional: an untagged union is legal
  and simply has no tag table and no `--checked-casts` behaviour.
- **`(tag-value X)`** inside a variant names one or more enum members that
  select it (several, for the `GdiMetafile = {WMF, EMF}` and
  `GdiPenBrush = {PEN, BRUSH}` cases). Omitted, the variant matches the enum
  member whose name equals the variant's name with the union's name prefix
  stripped, case-insensitively — so `(variant Bitmap ...)` under `GdiObject`
  matches `BITMAP`. Ambiguity is a refusal, never a guess.
- **The union name is itself a layout** containing exactly the prefix fields,
  followed by a generated `(field __rest u8 N)` padding it to the size of the
  largest variant. This is `GdiObjectAny` generated rather than hand-written:
  `size-of GdiObject` pins the table stride, and reading a non-prefix field
  through the union pointer is already an unknown-field error with no new
  machinery.
- **All variants are padded to the union's size**, so every variant's
  `size-of` is the stride too. A variant declaring more bytes than another is
  fine; the union takes the max.

### 4.2 Typed-pointer rules for unions

- `ptr<Variant>` where `ptr<Union>` is expected: **allowed** (a bitmap record is
  an object record).
- `ptr<Union>` where `ptr<Variant>` is expected: **refused** — that is precisely
  the narrowing a `(cast ...)` exists to spell, and where `--checked-casts`
  earns its keep.
- `ptr<VariantA>` where `ptr<VariantB>` is expected: **refused**.
- Accessing a field through `ptr<Union>` reaches only prefix fields, because the
  union layout only *has* prefix fields.

### 4.3 `(view ...)`

The brief asks for "a partial projection layout … declares fields at explicit
offsets". **Divergence, deliberate:** explicit offsets collide with the existing
`(field name type COUNT [STRIDE])` array sugar (`compiler-codegen.js:42-59`) —
a fourth token already means "element count", and overloading it by position
would make `(field x i32 8)` mean two different things in two different forms.
Worse, an explicitly-offset view is a *second* copy of the offsets it projects,
and this repository has already paid for a second copy of a layout table (the
`layout-migrate.js` FIELD_SIZE drift recorded in `tools/build.sh`).

So a view names what it projects and the compiler takes the offsets from there:

```wat
(view ControlTextState (of ButtonState StaticState ComboBoxState EditState)
  (field text_buf_ptr i32)
  (field text_len     i32))
```

Rules:

- Each `(field ...)` must exist, **by name, at the same offset, with the same
  type**, in *every* layout named in `(of ...)`. A disagreement is a located
  refusal naming the two offsets. This is exactly the `ControlTextState` comment
  in `src/09c3-controls.wat:269-279` turned into a build gate.
- The view's own offsets are the agreed offsets (so a view is **not**
  necessarily a prefix; it can project +8 and +20 and skip +0).
- `(of ...)` may name a `(layout-union ...)`, meaning every variant of it.
- Compatibility: `ptr<X> ≈ ptr<View>` for each `X` in the view's `(of ...)`
  closure, in that direction only. A `ptr<View>` is not usable where a concrete
  member is expected.
- A view is not a variant and carries no tag; `--checked-casts` skips casts into
  one.

### 4.4 The machine-readable table

`lowerIR(forms, checkResult, { layoutsOnly: true })` is the surface
`tools/gen-layout-offsets.js:102` already consumes, and the brief is explicit
that this feature must **extend that surface, not invent a parallel one**. So:

- A `(layout-union ...)` lowers to *N+1* ordinary `{type:'layout-lowered'}`
  records — one per variant plus one for the union name — which appear in the
  `layoutsOnly` array exactly like hand-written layouts. `gen-layout-offsets.js`
  therefore sees union variants with **no change at all**, and
  `tools/layout-offsets.json` gains them as ordinary entries.
- Alongside them, one `{type:'union-lowered', name, tagField, tagFieldOffset,
  tagFieldType, enumName, prefixFields, variants:[{name, tagValues, size}],
  totalSize}` record, and one `{type:'enum-lowered', name, members}` per enum,
  and one `{type:'view-lowered', name, of:[...], fields}` per view.
- Consumers that filter on `f.type === 'layout-lowered'` (which
  `gen-layout-offsets.js` does) are unaffected by the new record kinds. That
  filter is why this is additive rather than breaking.

### 4.5 What replaces `tools/gdi-variant-gate.js`

`tools/union-gate.js`, driven by the compiler's union table rather than by a
hand-maintained variant list, checking for *every* declared union:

1. every variant is the union's size, and agrees with the prefix on every
   prefix field's name/type/offset — now *by construction*, so the gate asserts
   the construction rather than the source;
2. every `(tag-value ...)` names a real member of the bound enum, and no enum
   member is claimed by two variants;
3. **every hand-spelled raw access against the union's records is attributed** —
   the census half of `gdi-variant-gate.js`, which is the part that is real
   reverse engineering and must not be lost. That attribution stays as data in
   the gate; what changes is that the variant *shapes* it checks against come
   from the compiler instead of from a second copy in the gate;
4. an access at an offset the attributed variant does not own as a named,
   non-`reserved` field is a failure — `gdi-variant-gate.js` check (2), kept;
5. an attribution contradicting a `+4 == N` guard in the same function is a
   failure — `gdi-variant-gate.js` check (4), kept, now reading the tag field
   and enum from the union declaration rather than from the gate's own
   `VARIANT_TYPES` table.

**Parity is proven, not asserted:** both gates are run on the tree and must
agree site-for-site, *and* the existing gate's negative plants are re-planted
and must fail both. A gate that has silently stopped running is the failure mode
this repository has already met once
(`project_watx_migration_status`), so "it passes" is not evidence; "it fails on
the plant" is.

`tools/control-variant-gate.js` **stays**. `ControlState` is deliberately not a
union: 13 independent layouts with no shared prefix (`src/09c3-controls.wat:32-74`
says so at length), and an external discriminant in `CONTROL_TABLE.class`. It
gets Tier 1 + Tier 3 typing (§5.3) and keeps its own gate.

---

## 5. Application, in order, each green before the next

1. **`GdiObject`** — the seven `(layout Gdi*)` declarations plus `GdiObjectAny`
   in `src/10d-gdi-region-path.wat:3810-3940` become one `(layout-union
   GdiObject (tag type GdiType) (prefix handle type) ...)`. Declarations emit
   nothing, so this is a **byte-identity** change. `GdiObjectAny`'s name is
   retained as a `(view ...)` alias so the 24 existing prefix-view sites do not
   have to move in the same commit.
2. **The generic union gate** replaces `gdi-variant-gate.js` in `tools/build.sh`,
   after the parity + re-planted-negative evidence of §4.5.
3. **`ControlState` typed retrofit** in `src/09c3-controls.wat`: one
   `(cast ptr<XxxState> ...)` at each of the 13 class wndproc entries where the
   state pointer is obtained, and `ptr<XxxState>` on the state-pointer params of
   the class-named helpers (`$edit_*`, `$lb_*`, `$cb_*`, `$btn_*`, …).
   Byte-identity oracle. This is the step that turns `control-variant-gate.js`'s
   hand-held attribution into something the compiler enforces at every accessor,
   with the gate as the belt to the compiler's braces.

## 6. What each tier can and cannot check

| | can | cannot |
|---|---|---|
| Tier 1 | a typed base used at the wrong layout's accessor; a typed value stored into a differently-typed local; a typed argument at a differently-typed param; a typed `(return ...)` against a typed result | anything about an untyped (`⊥`) expression; `call_indirect`; pointer arithmetic that leaves the type system (`i32.add` on a pointer is `⊥`); fall-through function results; whether the *runtime* value really is that record |
| Tier 2 | that variants agree on the prefix by construction; that a tag value names a real enum member and is claimed once; that a view's fields agree in all its `of` targets; that a union pointer reaches only prefix fields | which variant a runtime record actually is; an untagged union's discriminant |
| Tier 3, default | nothing — it is an *assertion by the author*, and its value is that it is greppable and located | — |
| Tier 3, `--checked-casts` | at runtime, that a narrowing cast into a tagged union variant matches the tag | casts into untagged unions, plain layouts, or views (documented no-op) |

The honest summary: this feature moves the wrong-layout bug from "silent, found
at Diablo's main menu" to "a located compile error, in the files that opt in".
It does not make the emulator memory-safe and it does not verify a single
runtime value unless `--checked-casts` is on.

# WATX compiler — Wine-Assembly changelog

Divergence of this repository's vendored WATX compiler from its import point.
[PROVENANCE.md](PROVENANCE.md) records where the files came from and what they
hash to; this file records what we did to them afterwards.

Rules:

- Every change to a file listed in PROVENANCE.md's `sha256` block gets an entry
  here **and** an updated hash in the same commit. This is enforced, not asked:
  `tools/check-watx-provenance.js` seals the manifest against this file, so an
  entry must quote the new manifest digest or the build gate goes red. Run
  `node tools/check-watx-provenance.js --update` and it prints the digest to
  paste.
- Prefer accepting valid standard WAT unconditionally over adding a
  `standardWat`-gated path (migration plan, §2.3).
- Every compiler change lands with a minimal regression in one of the
  `test/watx-compiler-*.test.js` suites.

## 2026-09-01 — union tags: i64 out, and a tag value must fit its field

Manifest digest: `4b65dae7242af761e175ca09c450eba87df7027a0530f385e190acf093d1d538`

`compiler-codegen.js`. Two review findings on the tagged-union checked cast,
one cause: the tag *declaration* admitted things the tag *comparison* cannot
express. The comparison is a load of the tag field fed into `i32.const` /
`i32.ne` — that is the whole mechanism.

**i64 is no longer a legal tag type.** The f64 fix taught the declaration to
demand an integer, but `i64` passed the regex while the emission stayed
i32-only, so `(tag t E)` on an i64 field compiled and `--checked-casts` emitted
an `i64.load` feeding an `i32.ne` — the same validator-rejected module the f64
fix existed to prevent, through the door it left open. The sound set is
u8/s8/u16/s16/i32; an i64 discriminant has no plausible use before the
comparison grows one.

**A tag value must fit the tag field's width.** A u8 tag loads zero-extended
into 0..255, so a variant claiming `(tag-value 256)` — via an enum member or a
bare literal, including a negative literal on an unsigned tag — builds a
comparison that is false on every record that can exist: the checked cast then
traps on exactly the variant it was meant to admit. Refused at the declaration
with the field's range in the message.

Regressions: `test/watx-compiler-typed-pointers.test.js` 63 → 67 checks (i64
tag refused, enum overflow refused, negative literal on unsigned refused,
boundary value 255 on u8 accepted). Validation-only: the shipped wasm is
byte-identical.

## 2026-09-01 — typed pointers: the places a pointer is stored, tail-called or merely declared

Manifest digest: `1e2c80ee8bce9994aea2a90cc2b34a48e0436e571219e7978cedfd1db81ac2a1`

`compiler-codegen.js`. Five holes in the tier-1/3 implementation of the entry
below, all found by executable review probes against the shipped compiler rather
than by reading it. They share one cause worth recording: the first cut checked
pointers where a pointer is obviously PRODUCED or CONSUMED, and missed every
place one is merely stored, tail-called, or declared.

**A pointer field has a pointee, and only its base was checked.** `(store.field
Node next p wrong)` verified that `p` was a `ptr<Node>` and said nothing about
the value going in. That launders the wrong record into a field every later
reader trusts by declaration — the wrong-layout bug, arriving through the one
door the check did not cover. All three store forms (`store.field`,
`store.elem`, `store.field-elem`) now check the stored value against the field's
declared pointee.

**`(field next ptr<Nope>)` compiled.** Params, locals, lets and results were
resolved against the layout table; field types were not, so a pointee that names
nothing — and the malformed `ptr<` — silently became a plain i32 field. It
cannot be checked where the field is lowered, since the layout it names may be
declared in any of the 61 files in any order, so it is deferred to the end of
`lowerDeclarations` when every name is known.

**`return_call` skipped both checks, in both lowerings.** A tail call passes
arguments and *becomes* this function's result, exactly as `call` plus `return`
does, and both of those were checked. Now its arguments are checked against the
callee's params and its result against the caller's declared `(result ptr<...>)`.

**A tag the compiler cannot load as an integer is refused at the declaration.**
`(tag t E)` naming an `f64` prefix field compiled, and `--checked-casts` then
emitted an `f64.load` feeding an `i32.ne`: a module the validator rejects, from
a flag whose entire purpose is catching mistakes. The tag must be one of
`u8`/`s8`/`u16`/`s16`/`i32`/`i64`.

**`(view V (of) ...)` is refused.** A projection over no targets agreed with
everything vacuously, which is the exact opposite of what a view is for.

Also located: the pre-existing `Unknown layout` / `Unknown field` refusals were
anchored to the layout or field ATOM, which is an interned primitive string with
no source metadata, so both had always reported line 0. They now fall back to the
enclosing form. And a union's `__rest` padding no longer appears in the
unknown-field message — instead, naming a variant's field through the union
reports which variant owns it and the cast that reaches it.

13 new checks in `test/watx-compiler-typed-pointers.test.js` (63 total). Byte
identity holds: none of this emits an instruction.

## 2026-09-01 — typed pointers, layout unions, views and `(cast ...)`

Manifest digest: `645366f9c897b95193b40486a856b69b23a7367f270cb0f63f744eeb1adf0ba2`

`compiler-codegen.js`, `compiler-stages.js`. All three tiers of
[docs/watx-typed-pointers-design.md](../../docs/watx-typed-pointers-design.md),
user-signed-off 2026-09-01. They land together because they are one language
feature and one seal: Tier 2's unions are the thing Tier 1's checking and Tier
3's `--checked-casts` exist to make safe, and splitting them would mean two
provenance seals over one interleaved edit to `compiler-codegen.js`.

**A layout accessor now checks the type of its BASE.** `(load.field GdiBitmap
bits p)` has always compiled to `p + 24` and an `i32.load` with no opinion about
what `p` points at, which is the wrong-layout bug of
`docs/watx-layout-migration-design.md` §5.4: a font record read at +24 yields a
plausible pointer, no trap, and a symptom thousands of instructions away. A
param, local, `let` or result may now be declared `ptr<LayoutName>`, and at
every accessor, `local.set`/`set!`/`let`, `call` argument and explicit `(return
...)` the compiler refuses a pointer whose declared pointee disagrees.

**Unknown is BOTTOM, not i32.** An expression with no pointer claim is
compatible with everything, silently, in both directions. That is what makes
this opt-in across 61 source files instead of a tree-wide cast storm: a cast is
required to move between two KNOWN and different pointer types, never to enter
the type system from ordinary i32 code. `call_indirect` is deliberately outside
it — its signature is a `(type ...)` reference, which carries valtypes and
cannot carry a pointee.

**Checked in codegen, not in `checkTypes`.** `compile()` passes
`requiredOnly: production`, and `checkTypes` returns before it walks a single
function body; in streaming mode the bodies are not even parsed at check time.
A rule enforced there is a rule that does not hold for the artifact we ship, so
these refusals sit in `compileExpr` beside the existing located unknown-layout
and unknown-field ones, and hold in every mode.

**`(cast ptr<L> EXPR)` emits nothing.** In the default build the value of `EXPR`
passes through untouched; the form's whole contribution is to the static type.
Its worth is that the claim is written at the one point where a bare i32 becomes
a typed record, where a reader and a grep can find it, instead of being implicit
in the call graph. `--checked-casts` (off in `tools/build.sh`, and a debugging
build by construction) turns a cast into a *tagged layout-union variant* into a
load-tag/compare/`unreachable` — fail fast, the `$crash_unimplemented`
philosophy. For a plain layout, an untagged union or a view it is a **documented
no-op**, and the counters say so rather than leaving "I turned it on and nothing
happened" a mystery.

One bug found and fixed while testing that flag: the first version allocated the
`$__cast_tmp` scratch local for *any* cast, so a checked build of a module whose
casts were all no-ops grew a local with no instruction behind it. The
local-allocation pass now asks the same `castIsChecked` predicate the emitter
will.

**`(field x i8 4)` is a located refusal instead of an internal error.** `i8` was
never in `WATX_LAYOUT_FIELD_TYPES`, so it reached `lowerIR`'s `sizeOfType` and
threw *"WATX internal: no byte width for layout field type 'i8'"* — a compiler-bug
message, with no file or line, for a source typo. The declaration check now names
the fix: a sub-width field is an access WIDTH, not a valtype, so spell the
signedness (`u8`/`s8`, `u16`/`s16`).

**`(layout-union ...)` states the shared-prefix discipline instead of asking a
gate to check it afterwards.** Eight hand-written layouts that must agree on
`handle` and `type` at +0 and +4, must not overlap, and must all report one
stride is a rule enforced today by `tools/gdi-variant-gate.js` reading the
source back. A union writes the prefix once, prepends it to every variant at
identical offsets, and pads every variant and the union's own layout to the
widest — so `(size-of AnyVariant)` pins one table stride *by construction*.
`(enum ...)` names the discriminant values, `(tag FIELD ENUM)` says which prefix
field carries them, and a variant takes `(tag-value MEMBER ...)` or matches an
enum member by its own name with the union prefix stripped. Two variants
claiming one tag value, a tag outside the prefix, an unknown enum or member, and
a variant name colliding with a layout are all located refusals.

**`(view Name (of A B ...) (field ...)+)` is a partial projection.** It is the
shape `ControlTextState` has today: several unrelated layouts that happen to
agree on two fields, read through one helper. A view does not lay anything out
— it *adopts* its targets' offsets and refuses to exist if they disagree, if a
target lacks the field, or if the types differ. That is the deliberate
divergence recorded in the design doc §4: a view restating explicit offsets
would be a second copy of a table, and the 4th token of `(field ...)` already
means an array count.

**Pointer compatibility is widening only.** A `ptr<Variant>` is accepted where
`ptr<Union>` is wanted, and a member is accepted where a view over it is wanted;
neither holds in reverse, so narrowing a union back to a variant needs the cast
— which is exactly the point at which `--checked-casts` can put a tag test. A
union pointer reaches only prefix fields, and the refusal for a variant field
now names the variant that owns it and the cast that would get there.

Declarations are lowered in three ordered phases (enums, then layouts and
unions, then views) rather than in source order, so a declaration's legality
does not depend on which of the 61 files it happened to be written in. The
lowered union/tag/variant table rides on the existing
`lowerIR({ layoutsOnly: true })` surface that `tools/gen-layout-offsets.js`
already consumes — no parallel channel.

One bug worth recording, because it is why the regression suite asserts offsets
by *running* the module rather than by reading the source: the first
implementation collected a `(prefix ...)` form's children from index 2, which is
right for `(layout NAME ...)` and `(variant NAME ...)` — both keep a name
there — and wrong for `(prefix ...)`, which does not. The first prefix field was
silently dropped. Every variant still compiled, every type check still passed,
and every offset past the tag was short by four bytes.

**Canonical bytes did not move.** Every annotation reaches `valtypeOf` /
`physicalLocalType` and becomes the `i32` those functions already answered for an
unrecognized token, so Tier 1 emits no byte of its own, Tier 3's default lowering
is `compileExpr(EXPR)` and nothing else, and Tier 2 lowers to the ordinary
`layout-lowered` records the compiler already had. Verified by building
`bd715687` in a clean detached worktree and again with only these files copied
in: `build/wine-assembly.wasm` is
`f9f20d1692425690f2188ff71acdf78c65ef6c5449a890a6c9432bd9d08a4b70` (997678 B)
both times. A same-process A/B on a small module also comes back identical with
the annotations and the cast added, and identical again under `--checked-casts`
once the phantom local was fixed.

## 2026-09-01 — direct emitters consume their whole form too

Manifest digest: `a67164cbb7509b6553af6f65df734e9c01e903fbb9d24edd91ab178083187b5e`

`compiler-codegen.js`, `test/watx-compiler-production.test.js`.

The preceding entry closed silent operand loss in the table-driven folded
operators, but the direct emitters had the same failure mode one branch at a
time. Forms including `local.get/set`, `global.get/set`, `return`, `drop`,
`nop`, scalar/SIMD/atomic memory operations, the layout accessors and grouped
`br_table` read the children they expected and returned without proving the
form ended. A surplus call or store therefore vanished while the resulting
wasm remained valid.

All fixed-shape direct emitters now use the same located arity machinery. That
includes zero-operand instructions; local/global operations and declarations;
`let`, `func-slot`, `br`/`br_if`/grouped `br_table`, `return` and `drop`; the
recognized arms of `if`; bulk, scalar, SIMD-lane and atomic memory forms after
their optional memargs have been parsed; region allocation; and every layout
address/load/store helper. Variable-body forms still consume their full body,
and the ordinary `br_table` spelling still consumes every pre-tail operand as
a target label. The type inference comment and implementation for `let` now
match its real local-tee semantics instead of describing the now-refused
trailing-body shape.

This refusal exposed two real production bugs in `src/09a7b-ole.wat`: the
`IStorage::EnumElements` ESP +24 cleanup and the common-dialog `IDispatch::Invoke`
ESP +40 cleanup were accidentally fourth children of an outer `if`, so both
had always been discarded. Their parentheses are corrected and the existing
OLE suite now asserts both post-handler stack pointers.

Coverage adds sixteen accepted/rejected direct-arity pairs, including memargs,
layout access, a trailing `if` expression and grouped `br_table`; the complete
oracle is 132/132. The production-mode suite's bulk-memory refusal assertion
now pins the new function-qualified exact-arity diagnostic rather than the old
unlocated text. Wine parity, SIMD, SIMD-op, SIMD-memarg, atomics, explicit drop,
block-result and differential suites pass, as does the 76-check OLE storage
suite.

## 2026-09-01 — folded operators consume their whole form

Manifest digest: `c92c6ac479994083463da953384d51be9b4fe34d9a0a59471fb54948e98d8f4c`

`compiler-codegen.js`.

The table-driven instruction emitters read only the operands they needed and
never checked that the form ended there. `(i32.or A B C D)` therefore compiled
as `A | B`; `C` and `D` — including any calls or stores inside them — vanished
without a diagnostic. The emitted wasm was valid, so engine validation could
not recover the discarded source. Scalar unary/conversion operators and the
parallel SIMD tables had the same shape.

The common folded-expression dispatch now has one located exact-arity check,
used by every fixed-arity scalar arithmetic/comparison, unary, conversion and
saturating-conversion table; the simple SIMD binary, unary, bitmask, shift,
splat, lane, shuffle and reduction forms; and `select`, `memory.size` and
`memory.grow`. Missing and surplus operands both fail at the instruction's
source location before any child is emitted. Variable-arity control forms and
memory instructions with optional `offset=`/`align=` operands remain under
their own parsers.

Coverage is three accepted/rejected pairs in `tools/watx-rejection-pairs.js`:
the exact reported four-operand `i32.or`, a surplus operand on `i32.eqz`, and a
third vector on `v128.or`. All three reject with located messages while their
well-formed twins compile. The full rejection oracle is 116/116; Wine parity
is 22/22, SIMD is 51/51, and the extended SIMD-op suite is 60/60.

The production tree contains no malformed folded form, so its output remains
`1ed8e600d282ef4d458534ad7b1b4d3f942244ae93d2fe623724d954db4dfd54`
(998,494 bytes) before and after the change.

## 2026-08-31 — positional else is a hard error, as the warning promised

Manifest digest: `780cd7466183a3cc7e5ba3520682233620c545efb8a4112dd70c21756ff09a57`

`compiler-codegen.js`.

`(if COND (then A) B)` — a bare expression in the else slot, without `(else
…)` — is not standard WAT, and it is a shape two compilers read **differently**:
WATX compiles the bare `B` as the else arm, `lib/compile-wat.js` silently
DISCARDED it. One source, two programs, no error on either side, and the symptom
is a missing else branch at runtime an arbitrary distance from the line.

It has warned since the Round 4 review, in a message ending "This will become a
hard error", with the promotion condition stated in the code: *"planned for when
the closure has none left."*

**The condition is met.** A full `tools/build.sh` emits zero of these warnings,
in both dispatch modes. The last site the test suite named — 
`src/09a5-handlers-window.wat:225` — is a proper `(else …)` now. So
`warnPositionalElse` became `failPositionalElse`, and the message says what to
write instead rather than what will happen later.

Two things kept, deliberately:

- **The `sawThenForm` guard.** WATX's own `(if COND A B)` shorthand also has no
  `(then …)`, and it is a deliberate documented spelling, not a mistake. Only
  the mixed form — a standard `(then …)` followed by a bare tail — is refused.
  Refusing the shorthand would break every watjs tree, and the three
  still-compiles assertions in the suite are what pin that.
- **The located message.** `file:line` plus the enclosing function name, because
  the whole failure mode this addresses is one that reads far from its cause.

`test/watx-compiler-literals.test.js` §6 flipped from asserting the warning to
asserting the refusal: the shape is rejected, the message names the shape and
the fix, a two-site module fails on the first, and shorthand / else-less `if` /
proper `(else …)` all still compile. 130 checks, all pass.

Free ratchet: this cost nothing to take, because the tree had already been
cleaned. Warnings whose promotion condition has quietly become true are worth
re-checking for exactly that reason.

## 2026-08-31 — a layout field type is a closed set, and u16/s16/s8 are in it

Manifest digest: `c41cd76154c64d5f8630d3fc7e36cb46937b9d4f3abf2acdbb7decc8b239d669`

`compiler-stages.js`, `compiler-codegen.js`.

`emitLayoutAccess` — the shared encoder behind all six accessors, added in the
memarg entry below — ended with

```js
    const spec = group[fieldType] || group.i32;
```

so a field type its table did not know became a **four-byte i32 access**, and
`lowerIR`'s `sizeOfType` answered `4` for the same unknown type, laying the
struct out to match. Two silently wrong things that agreed with each other: a
hypothetical `(field width u16)` would have compiled clean, read four bytes over
a two-byte field, and put every later field at the wrong offset.

**Where the hole actually was.** The parser *did* check the type — but with
`addWarning`, and a warning is not a refusal. Worse, `addWarning` returns
immediately when `collectWarnings` is false, which is exactly how
`tools/watx-closure.js` builds the emulator, so in the production configuration
the finding was not even printed. And the list it checked against was
`VALTYPE_TOKENS`, the set that types `let` bindings and block results — a
different question. It admitted `v128`, a real valtype with **no** entry in
`emitLayoutAccess`, so a `(field v v128)` was accepted by the checker and then
compiled to a 4-byte access over sixteen declared bytes.

So both halves were wrong, and the fix is one table:

- `WATX_LAYOUT_FIELD_TYPES` in `compiler-stages.js` is now the single source of
  truth for what a `(layout …)` field may declare — name → byte width — with
  `watxLayoutFieldSize()` also applying the `ptr*` prefix rule of §158 of the
  design doc (`ptr`, `ptr$WndRecord`, … are 4-byte fields). The three files are
  concatenated parser → stages → codegen, so codegen sees the binding.
- The checker refuses anything outside it with a **located hard error at the
  declaration** — one diagnostic per bad field, naming the layout, the field,
  the offending type and the supported set, rather than one per access site:

  ```
  Layout 'DxObject': field 'width' has unknown field type 'u24'.
  Layout field types are: f32, f64, i32, i64, ptr, s16, s8, u16, u8, weak, ptr<Name>.
  ```

- The two fallbacks in codegen become **internal compiler-bug guards** that
  `throw`, not user-facing refusals: reaching either now means the checker
  admitted a type one of the tables has no entry for, i.e. the tables drifted.
  `v128` is refused as a field type until both tables gain an entry for the
  0xFD-prefixed `v128.load`/`v128.store`.

**`u16`, `s16` and `s8` are added to the set**, with their own opcodes
(`i32.load16_u` / `i32.load16_s` / `i32.load8_s`, align 1 for the 16-bit pair,
and the truncating `i32.store16` / `i32.store8` for both signednesses — a store
discards the high bits either way). This is not speculative generality: the
DxObject completion sweep found real 16-bit fields at `+12..+18`
(width/height/bpp/pitch) that had to be declined and spelled `u8[2]` because the
type did not exist. They are now declarable, which unlocks those sites for a
later wave. The alignment values are the ones `WATX_LOAD_OPS`/`WATX_STORE_OPS`
already emit for the same instructions, so the byte-identity oracle holds for
the new types too — asserted directly in `test/test-watx-compiler-layout.js`
against hand-spelled twins, add-form and `.memarg` alike.

Coverage: four new pairs in `tools/watx-rejection-pairs.js` (unknown scalar
type, unknown array-field type, `v128`-is-a-valtype-but-not-a-field-type, and
the accepting boundary), 113/113 pairs holding; four new checks in
`test/test-watx-compiler-layout.js` (byte identity for the sub-width accessors,
true-width layout and sign/truncation behaviour through a live instance, the
located refusal, and every declared type accepted). `build/wine-assembly.wasm`
is **byte-identical** across the change —
`6378dc30c8c1a82c8486e979816dec3795bb3c7b3a48218b5265a461a8259929` before and
after, in a detached worktree at HEAD — as no source declares a layout field
outside the previously-working set.

## 2026-08-31 — a layout access can put its field offset in the memarg

Manifest digest: `ae2df8439fb10bd2fea4d25698b98ac56fb4f77fd973a87f9b5c4fc0e512e042`

`compiler-parser.js`, `compiler-stages.js`, `compiler-codegen.js`. Branch (b) of
§3.4 of [docs/watx-layout-migration-design.md](../../docs/watx-layout-migration-design.md).

A layout accessor had exactly one lowering:

```
  (load.field L f p)  ->  p; i32.const OFF; i32.add; i32.load align=2 offset=0
```

which is byte-for-byte the `(i32.load (i32.add p (i32.const OFF)))` idiom, and
that byte identity is the entire oracle the layout migration is gated on. But
**6,547 of the tree's 12,061 struct-field sites are not spelled that way** —
they carry the offset in the instruction instead, `(i32.load offset=8 (local.get
$p))`, which is three bytes shorter and a different encoding. Those sites could
not be converted at all without moving the shasum, so they were parked.

The six accessors that end in a memory instruction — `load.field`,
`store.field`, `load.elem`, `store.elem`, `load.field-elem`,
`store.field-elem` — now accept a **`.memarg` modifier** that selects the other
lowering:

```
  (load.field.memarg L f p)  ->  p; i32.load align=2 offset=OFF
```

Same field, same layout, same byte addressed; the offset is simply encoded in
the place the source already put it. Both populations are now convertible under
byte identity, which is why this is a per-SITE modifier and **not** the
per-layout attribute §3.4 originally sketched: a layout's sites are spelled both
ways in real source (DxObject has 497 add-form and 40 memarg, and wave 4 already
converted 367 of them), so a per-layout flag would have silently re-encoded
work that had already been reviewed and shipped. The choice belongs where the
information is — at the site.

The modifier is stripped in exactly one place, `watxLayoutMemargHead()` in
`compiler-parser.js`, and every head-consuming site in the checker
(`synthesize`, `walkExpr`) and the code generator (`compileExpr`,
`needsAutoDrop`, `inferExprType`) calls it. Stage 1 is where it lives because
all four stage files share one global scope and a head normalized in the
generator but not the checker is a head whose *type* is inferred for a spelling
that is not the one being emitted — an `f64` field read `.memarg` would have
been typed `i32` and the module would have failed validation.

Two refusals come with it, because a modifier that is accepted where it means
nothing is worse than no modifier at all — the site reads as converted while the
offset it names went nowhere:

- `elem-addr.memarg` / `size-of.memarg` / `offset-of.memarg` are a hard error
  naming the reason (those ops compute an address or a constant and perform no
  memory access, so there is no memarg to fold into);
- `.memarg` on anything else (`i32.load.memarg`, a misspelling like
  `load.field.memrag`) is left alone and lands on the existing unknown-head
  error, which names the head the author actually wrote.

**Drive-by, in the same commit because the encoding moved into one helper:** the
final memory instruction for all six accessors is now emitted by
`emitLayoutAccess()` rather than by six hand-written opcode triples. Two of
those six — `load.elem` and `store.elem` — had **no `i64` branch**, so an `i64`
field reached through them emitted an `i32.load`/`i32.store`. That was never a
valid module (the checker types the expression `i64` and the access pushes an
`i32`), so nothing correct can have depended on it; it is now consistent with
the other four.

Inert on the canonical build, PROVEN rather than asserted: `build/wine-assembly.wasm`
is `13168b57f2e81f7b4b7df6b7885e75b07a929df6c8ed7bc148ffa229972a14e3` (990927
bytes) built at `a1408777` with the HEAD compiler and with this one, in two
isolated worktrees — nothing in `src/` spells `.memarg` yet.

Regressions: `test/test-watx-compiler-layout.js` gains five checks (per-op byte
identity against the *memarg-spelled* twin for all eight accessor shapes; the
assertion that the two lowerings genuinely differ, by exactly the three bytes of
`i32.const N; i32.add`, and coincide at offset 0; a cross round-trip proving both
lowerings address the same byte; `.memarg` stores validating as statements under
`standardWat`; and the three no-memory-access refusals).
`tools/watx-differential.js` gains `layout-field-memarg`, whose `refSource` is
the `offset=` spelling — byte-identical. `tools/watx-rejection-pairs.js` gains 7
pairs, 109/109.

## 2026-08-31 — store.field stops leaving a value on the stack

Manifest digest: `a933c58ab262e2f89ec0f4e1ab9a32c9548d89dadff969900bce8670958c0bdf`

`compiler-codegen.js`. `store.field`, `store.elem` and `store.field-elem`
appended an `i32.const 0` unconditionally. In the WATX dialect that is correct —
every form is an expression and a store evaluates to 0 — but under
`standardWat: true`, the mode `tools/watx-closure.js` builds the emulator with, a
store is a **statement**. The plain `i32.store` path a few hundred lines below
has carried a `!standardWat` guard on exactly that value since it was written;
these three never got one, and `needsAutoDrop()` returns false for any head
containing `store` in that dialect, so nothing dropped it either.

The result was not a size regression, it was an invalid module:

```
  VALID    i32.store in void func
  INVALID  store.field in void func
  INVALID  store.field then another statement
```

A store in a function declared to return nothing left an i32 on the stack and
the whole module failed `WebAssembly.validate`.

Nothing in the tree noticed because nothing in the tree used a layout op:
`load.field|store.field|(layout ` over `src/`, `lib/`, `tools/` and `test/`
matched only the census tool added alongside
[docs/watx-layout-migration-design.md](../../docs/watx-layout-migration-design.md).
The spec suite, the differential and the rejection pairs had no layout coverage
at all, which is the actual defect this entry fixes — the missing guard is one
line, the missing oracle is the reason it was reachable.

Coverage added in the same commit:

- `test/test-watx-compiler-layout.js` — validates a store in a void function,
  asserts the WATX dialect still yields its 0, asserts every accessor is
  byte-identical to its hand-spelled twin, and round-trips fields through memory
  to check the offsets are the declared ones. Named `test/test-*.js` rather than
  joining the `test/watx-compiler-*.test.js` family the rules above point at,
  **because nothing runs that family**: no runner, no npm script, and
  `tools/check-test-manifest.sh` only sweeps `test/test-*.js`, so those 20 files
  are in the same blind spot the manifest gate was built to close. This one is in
  run-all.sh's UNIT tier and therefore actually executes. Wiring the other 20 back
  in is somebody's follow-up, not this commit's.
- `tools/watx-differential.js` — `layout-field-scalar` and `layout-elem`. wabt
  has no `(layout ...)` spelling at all, so these use a new optional
  `refSource`: the WATX module uses the accessors, the reference is the
  hand-lowered twin. Both are byte-identical to wabt's encoding of the twin.
- `tools/watx-rejection-pairs.js` — nine rules, each guarding a refusal that used
  to be a silent default (an unknown layout or field resolved to offset 0 /
  size 16, turning one typo into an access to the wrong field).

With the guard in place `store.field` compiles to the same bytes as the
`(i32.store (i32.add ptr (i32.const N)) v)` it replaces, which is what lets a
layout migration wave be gated on an unchanged `build/wine-assembly.wasm`.

## 2026-08-31 — the string pool gets an address instead of a guess

Manifest digest: `bb690346c9e5e1af8c0507518b88d5eca2de46fe60268de179b2d74acbb92c34`

`compiler-codegen.js`. A bare `"text"` literal, `(string ...)` and `(cstring
...)` intern into one pool, placed at `DATA_BASE = align16(max(staticCursor, max
data-segment end))` and documented as sitting "immediately ABOVE the static
regions so its bytes never overlap a region's storage".

That is true only when WATX itself allocated the storage below, via
`region.declare-static/-bump/-rc` — those three heads are what advance
`staticCursor`. A module whose map comes from the `region.declare`/`-fixed`/
`-derived` allocator never advances it, so it stays at `STATIC_REGION_BASE`
(1024) and "above the static regions" degenerates to "above the last data
segment" — which is not above the map but a point in the **middle** of it.

Measured in this repository before the change: one bare `"ceil"` literal added
to `src/08b-dll-loader.wat` was placed at `0x07B7B040`, inside `$D3DIM_AUX`
`[0x07B7B000, 0x07B7C000)`, on top of live Direct3D state — and every build gate
passed. Neither guard could see it. The pre-existing data-segment check covers
only `[1024, staticCursor)`, which is empty here; `tools/wasm-data.js` compares
data **segments** to each other, and a region's storage is not a segment. The
symptom would have been corrupted 3D rendering an arbitrary distance from the
literal. So interned strings were, in practice, unusable in this tree, and the
first author to write one would have paid for it.

Two rules replace the guess:

1. **`(string.pool $REGION)`** — a new top-level declaration that pins the pool
   at that region's base, bounds-checked against the region's size the same way
   any `region.addr` tenant is. Declared at most once; refuses an unknown region
   and refuses a span (a span owns no storage of its own to lend).
2. **Without that declaration the default is checked, not trusted.** A non-empty
   pool whose extent overlaps any declared region's storage is a hard compile
   error naming both ranges and `(string.pool ...)` as the fix.

Neither rule is reached by a module that declares no regions — the byte-identity
case, and watjs's, which interns ~3500 strings and has no region map. Verified:
with no `(string.pool ...)` in the tree the wine-assembly wasm is unchanged.

Also decoupled from the pool: `$bump_ptr`'s initializer was
`DATA_BASE + dataPool.bytes.length`, which double-counts once the pool moves
elsewhere, so with a pinned pool the heap now starts after the data segments
instead. (Unrelated latent issue, left alone and noted here because it is
adjacent: that expression is evaluated in section 6 while the pool is only
filled in section 10, so it reads a length of 0 for anything interned inside a
function body. Pinning the pool makes it moot for this repository.)

Regression: `test/watx-compiler-string-pool.test.js` — pinned placement and
dedupe asserted by reading the bytes back out of an instantiated module, plus
the overlap, overflow and legacy-default refusals. Six matched accept/reject
pairs in `tools/watx-rejection-pairs.js` under the `string pool` group. Not
added to `tools/watx-differential.js`: that corpus is standard WAT only, and
`(string.pool ...)` is a WATX form wabt cannot parse.

## 2026-08-31 — import

Vendored from `../android-emu` `590238be` plus its uncommitted standard folded
`br_table` patch. Compiler files are byte-identical to that source.

Only adaptation: `test/watx-compiler-emit-stack.test.js` check (1) now reads
`tools/build.sh` and `tools/watx-baseline.sh` instead of android-emu's
`tools/build.js`, which does not exist in this repository. The asserted property
— no build path respawns Node with `--stack-size`, because a browser cannot — is
unchanged.

No compiler behavior change.

Manifest digest: `b8dc6490e2fbb757fb08f6acef0c0f860eb549e809003950804afc96ae893256`

## 2026-08-31 — seal the manifest against this changelog

No vendored file changed; the digest above covers the same bytes the import
recorded. What changed is the enforcement.

Manifest digest: `b8dc6490e2fbb757fb08f6acef0c0f860eb549e809003950804afc96ae893256`

External review found the changelog rule was procedural: the gate compared
recorded hashes against file bytes, so editing a compiler file *and*
hand-editing its hash in PROVENANCE.md left the build green with nothing
written down. `tools/check-watx-provenance.js` now checks, on every normal
verify, that PROVENANCE.md's `seal` block matches its own manifest, that this
file quotes the current manifest digest, and that this file's bytes match the
sealed changelog hash. Moving either end without the other is now a build
failure.

## 2026-08-31 — require the full file set, not just a sealed one

No vendored file changed; same digest as above.

The seal binds whatever entries the manifest holds, and said nothing about what
it must hold. External review exploited that: delete `compiler-codegen.js`'s
line, paste the new digest here, re-seal, and the gate reported
`OK (10 vendored files match)` — a monitored file dropped from monitoring, with
every hash check still passing.

`REQUIRED_FILES` in `tools/check-watx-provenance.js` now names the 11 paths, in
code rather than in the sealed document, and a normal verify fails unless the
manifest is exactly that set (duplicates included). `--update` reconciles the
block to the array instead of refusing, so the shrink self-heals and a
legitimate add or removal is still two commands — but the array is source in
the same diff, so coverage cannot change without a reviewer seeing it.

## 2026-08-31 — close the six WATX-side Milestone 2 gap classes

Manifest digest: `ad565a9e69ce06e0f3f1100f415409fa19385999341de232ba1afd167ab1192a`

First changelog entry recording a real edit to the vendored compiler. It teaches
WATX six pieces of standard WAT that the M2 gap census
([docs/watx-migration-gaps.md](../../docs/watx-migration-gaps.md)) found it
rejecting or, worse, silently mis-compiling in Wine-Assembly's own source
closure. Everything here is accepted unconditionally — no `standardWat` flag
gates any of it — per the migration plan's §2.3 rule.

Changed: `compiler-codegen.js` and `compiler-stages.js`. Five new regression
suites join the manifest: `test/watx-compiler-{atomics,simd-ops,simd-memarg,
block-result,lanes}.test.js`.

- **G1 — atomics (144 sites).** The 0xFE-prefix threads family was absent
  entirely; the string `atomic` did not occur anywhere in the compiler, while
  Wine imports a `shared` memory and uses it heavily. The WHOLE standard family
  is implemented, not the subset the tree happens to use today: every
  load/store/rmw width, all seven rmw kinds including `cmpxchg`,
  `memory.atomic.notify` / `wait32` / `wait64`, and `atomic.fence`. Natural
  alignment is required by the proposal, so a disagreeing `align=` is a hard
  compile error rather than a hint the engine reinterprets.
- **G2 — ~20 missing SIMD table entries.** Saturating add/sub, `avgr_u`,
  `bitmask`, `extmul_*`, `extadd_pairwise_*`, `dot_i16x8_s`, `q15mulr_sat_s`,
  the i64x2 comparisons and widening extends, the float rounding ops and the
  int↔float converts. `bitmask` gets its own table because its result is a
  scalar — the shape-prefix inference would otherwise type it `v128` and sink an
  i32 into a v128 local.
- **G3 — `offset=` / `align=` on the v128 memory ops.** These hard-coded
  `align=4 offset=0` and rejected a memarg outright. The scalar memarg loop is
  now a shared `parseMemarg` serving the scalar ops, the v128 ops and the
  atomics; the whole v128 memory family is wired, including the splat/widening
  loads, `loadN_zero`, and the `loadN_lane`/`storeN_lane` forms that carry a
  memarg *and* a lane. `v128.store` is now void in standard-WAT mode, matching
  the scalar stores; legacy mode keeps the WATX i32 0 convention.
- **G4 — labeled `block`/`loop` with an explicit `(result T)`.** Labeled blocks
  were forced to void on purpose ("its br targets do not carry a result value").
  They now parse a signature and `br` / `br_if` carry a branch value, with the
  condition always the last `br_if` operand. Un-signatured blocks keep their old
  behaviour exactly, which is the shape the whole tree is written in.
- **G6 — lane immediates in the standard lane-first position**, for every
  `extract_lane` / `replace_lane` shape, alongside the existing WATX vec-first
  order. The two are told apart with no ambiguity: a lane immediate is always a
  bare number or an `(iNN.const N)`, which a v128 operand can never be. The
  census called this its most dangerous class, and the danger was not the
  rejection — it was `immVal()` defaulting an unreadable lane to `0`, so every
  lane read became lane 0 and the module still validated. That is the bug the
  compiler's own comment at the old line 1385 records being bitten by on
  2026-08-12 and misdiagnosing as a broken `v128.load`. A missing, non-constant
  or out-of-range lane is now a hard error naming the op.
- **G7 — `i8x16.shuffle` lane bytes lane-first**, same treatment, plus a hard
  error on a short or out-of-range lane list instead of a silent zero pad.

Verified: the six pre-existing suites are unchanged at 22 / PASS / 5 / 14 / 15 /
37, the five new ones add 198 checks, and the complete `WAT_FILES` closure now
compiles and validates in both tail-call and compatibility modes with zero
warnings — the six classes above contribute no errors at all. The G6 regression
was re-run against a scratch copy of the compiler with only that fix reverted:
the standard-order module fails validation and the missing-lane module compiles,
validates and silently reads lane 0, exactly as the census described.

## 2026-08-31 — G8: an explicit `(drop)` is the consumer, not a second dropper

Closes the seventh WATX-side gap class from `docs/watx-migration-gaps.md`. The
census originally filed G8 as a Wine-source defect ("the `(drop)` at
`src/09a8-handlers-directx.wat:4449` is dead, delete it"); that verdict was
reversed at `3aa8310f` after it was shown that `lib/compile-wat.js` has **no
auto-drop of any kind** — `drop` is a plain opcode-table entry (`0x1A`) — and
that the line is load-bearing: `$host_gdi_set_dib_to_device` is `(result i32)`
and the enclosing `$dx_blit_entry_rect_to_hdc` has no result, so deleting it
makes the *shipped* legacy module fail validation with "expected 0 elements on
the stack for fallthru, found 1".

WATX's statement compiler synthesized a drop for every value-producing statement
in a statement sequence and then compiled the explicit `(drop)` on top of it, so
the two fought and the second underflowed ("not enough arguments on the stack for
drop"). The fix is a one-token lookahead: `needsAutoDrop(stmt, nextStmt, func)`
in `compiler-codegen.js` suppresses the synthesized drop when the *next* sibling
is a bare `(drop)`, which is then compiled normally and consumes the value. It
is wired into every statement sequence — function body, `begin`, `block`, `loop`,
both `if` arms and the remaining statement-list loops — not just the function
body, so the shape works wherever it is written.

Design decision, deliberately documented in the suite rather than changed: a
value-producing statement with **no** explicit `(drop)` after it is still
auto-dropped exactly as before. That is the status quo every WATX source in the
tree is written against, and promoting it to a hard error is a separate and much
larger change. One drop consumes one value: a *second* bare `(drop)` with nothing
left, and a bare `(drop)` after a void call, are both rejected by wasm validation
rather than silently absorbed — both are asserted.

New suite `test/watx-compiler-explicit-drop.test.js` (33 checks, added to the
provenance checker's `REQUIRED_FILES`) covers the `09a8:4449` shape in function
body, trailing, `begin`, `block`, `loop` and `if`-arm position; the two
no-regression auto-drop cases; the two rejection cases; and the untouched
`(drop EXPR)` operand form. It fails on the pre-fix compiler with exactly the
six underflow errors described above.

Milestone 2 exit gate, with this landed: the real Wine-Assembly source closure
compiles **completely unmodified** — driven from `src/main.watx`'s `(include …)`
list, zero neutralizations, zero in-memory patches — in both modes:
`tailCalls: true` → 984,312 bytes, `tailCalls: false` → 984,761 bytes, 0 warnings
each, and both binaries pass `new WebAssembly.Module()`.

New manifest digest:

  812bb3b0163fd10ef29d6f0e2f1fa9cfde6aff8d5529c4da18d827d94d980235

## 2026-08-31 — M3: exports follow declaration order; negative hex `i64.const`

Two fixes found by the Milestone 3 four-artifact differential
(`node tools/watx-matrix.js`, `docs/watx-migration-plan.md` §M3), which compares
this compiler's artifact against `lib/compile-wat.js`'s section by section.

**1. The export section is emitted in SOURCE DECLARATION order, interleaved
across kinds.** WATX collected exports in two phases — every inline
`(func $f (export "f") …)` clause first, then every top-level `(export …)` /
`(wasm-export …)` form — which grouped the section by *where the export was
written* instead of by declaration position. Standard WAT, and the legacy
compiler this output is differentially compared against, emit one entry per
export in written order, so `src/01-header.wat:870`'s
`(export "memory" (memory 0))` — declared ahead of every function in the closure
— is export #0 there and was export #1430 here. Both artifacts exported all 1431
entries, but the section compares POSITIONALLY, so every entry was misaligned by
one and the gate was red on exports alone.

The fix records the index of the top-level form each export came from
(`formIndex`, set in both `compiler-stages.js`'s checker and `compiler-codegen.js`'s
standalone fallback) and stably sorts the collected list by it. It is a general
declaration-order rule, deliberately **not** a "memory first" special case — the
new suite interleaves memory first, memory last, memory in the middle, globals,
inline clauses and `wasm-export` forms to pin that down. The synthesized implicit
`memory` export that historical WATX modules with no memory form receive still
comes first, unchanged, and is asserted.

**2. A negatively-signed hexadecimal `i64.const` compiled to a silent zero.**
`BigInt('-0x10')` throws — the constructor takes a sign only on a decimal string
— and `parseI64Literal` returned `0n` from its catch, so the literal became
`i64.const 0` with no error and a module that still validated. This is in the
tree: `src/09a7b-ole.wat:3801` writes the OLE compound-file magic as
`(i64.const -0x1EE54E5E1FEE3030)` — `0xE11AB1A1E011CFD0`, the little-endian
`D0 CF 11 E0 A1 B1 1A E1` signature every CFB reader checks for, and the same
constant `:4075` compares against on read — so `$ole_cfb_serialize` wrote eight
zero bytes there and the container carried no signature at all. The sign is now
peeled by hand before `BigInt`, a second sign is rejected, and an unparseable
literal is a **hard error** instead of a plausible-looking 0, since the silence
is what made this expensive to find. `i32.const` was never affected — it goes
through `parseInt`, which handles `-0x…`.

New suites `test/watx-compiler-export-order.test.js` (17 checks) and
`test/watx-compiler-i64-literal.test.js` (21 checks), both added to the
provenance checker's `REQUIRED_FILES` (17 → 19). Run against the pre-fix
compiler they fail 5 and 4 checks respectively; the twelve pre-existing suites
are unchanged.

Measured on the real closure: the export section now MATCHes entry for entry in
both modes, the two `$ole_cfb_*` bodies become byte-identical, and
`node tools/watx-matrix.js --only=abi` reports **MATRIX GREEN** with 6 of 8142
code bodies remaining as diagnostics. Those six are **not** compiler defects:
one (`$next`) is a `return_call_indirect` type INDEX renumber over an identical
signature, which the ABI tool tolerates by design (types are compared as a set);
the other five are the Wine source writing a bare instruction in the else slot of
an `(if COND (then …) X)` with no `(else …)` wrapper. Legacy silently DISCARDS
`X`; WATX compiles it as the else arm. A census over `WAT_FILES` finds 12 such
tails, of which the 10 in `if`s that have no `(else …)` are the divergence — see
the report on `messageboard.txt` for the site list. That is a source defect of
the G5 class, not something to paper over here, so no compiler change was made
for it.

New manifest digest:

  bf54906c2ea0aba43a09042177295a9660fa8846fb8168db9be08a4354f20bcd

## 2026-08-31 — strict numeric literals, and a warning for the positional else

Two of the three findings from the round-4 external review of the vendored
compiler. (The third, a `MATRIX GREEN` on a symmetrically-failing pinned test,
is in `tools/watx-matrix.js`, which is not a vendored file — commit `f2f99acd`.)

**1. Numeric literals parsed permissively and truncated in silence (HIGH).**
`parseInt` and `parseFloat` do not validate. They read a prefix, stop at the
first character they cannot use, and return what they got — so every literal
position in the compiler accepted trailing junk and baked a plausible-looking
wrong constant into the module, with no error and no warning:

```text
(i32.const 1_000)            ->  1        (the digit separator split the token)
(i32.const 123abc)           ->  123
(i64.const 0x10zz)           ->  16n
(f32.const 1.25junk)         ->  1.25
(f64.const 1_000.5)          ->  1
(i32.load offset=16junk …)   ->  offset=16
```

A wrong constant is the worst failure mode this compiler has: the module
compiles, validates, runs, and misbehaves somewhere else entirely. The same
class of bug already cost a session — the negatively-signed hex `i64` above,
which deleted the OLE compound-file signature from every container the emulator
wrote.

Every literal position now validates the token **in its entirety**:
`i32.const`, `i64.const`, `f32.const`, `f64.const`, `offset=`/`align=` memargs,
bare number and numeric-symbol atoms in operand position, global initializers,
active `data` and `elem` segment offsets, and SIMD lane immediates. Junk is a
hard error naming the token and the position.

Trailing junk has two shapes and both are closed. Junk the tokenizer keeps
inside the number (`123abc` — `a`,`b`,`c` are hex digits) is caught by the
validators. Junk it splits off into a second atom (`0x10zz` → `0x10` + `zz`)
is invisible to any validator, because the const form simply dropped the extra
child; so the four `.const` heads and the out-of-body constant forms now also
check **arity** — exactly one atom operand, never a sub-expression, never two.
The `|| '0'` fallback for a missing operand is gone with it.

**THE UNDERSCORE DECISION.** The WAT text format allows `_` between digits:
`1_000` is 1000, `0xFFFF_FFFF` is `0xFFFFFFFF`. Of the three possible outcomes
for `1_000` — parse it as 1000, reject it, or silently produce 1 — only the
last is unacceptable, and the spec answer is the first, so **WATX now parses it
correctly**. `WATX_CHAR_NUMBER` in `compiler-parser.js` carries `_` through a
number token (it used to end the token, which is how `1_000` became the number
`1` followed by a stray symbol `_000`), and the validators accept it only in the
spec position: between two digits of the same run, never leading, trailing or
doubled. A separator is stripped before the value is computed, so every literal
that was already valid keeps its exact previous value and encoding. A census
over `WAT_FILES` found no token that changes tokenization under the wider
number alphabet — the only `_`-after-digit occurrences in the tree are inside
string literals and `;;` comments.

Deliberately **not** supported, and now rejected loudly instead of truncated:
hex floats (`0x1p4`), `inf`/`nan`, and a `+`-signed exponent (`1e+10`). None
occur in the closure. A NEGATIVE exponent does tokenize and still works — there
is one in the tree, `(f64.const 2.2250738585072014e-308)` at
`src/06-fpu.wat:193`, and it is asserted. Two smaller fixes fell out of the
audit: a bare hex atom containing `E` (`0xE1`) took the float branch, where
`parseFloat('0xE1')` is 0 — a silent zero constant, now decided by the `0x`
prefix before the exponent characters; and `offset=1=2` was read as `offset=1`
rather than rejected.

`immVal` is deliberately left lenient: it is also handed shape tokens like the
`i32x4` of a `(v128.const i32x4 …)` and is expected to fall through to its
default on those. The lane positions where a truncated literal would be
silently wrong go through `laneImm`, which is strict.

**2. `(if (cond) (then …) EXPR)` now warns (MED).** Standard WAT spells the
else arm `(else …)`. WATX also accepts a bare fourth child as the else — and
that shape is one the two compilers read DIFFERENTLY: `lib/compile-wat.js`
silently discards the expression, WATX compiles it as the else arm. It stays
accepted for now, because one such site is still in the tree
(`src/09a5-handlers-window.wat:225`, a `$wnd_set_style` call that the shipped
legacy build therefore never makes), but it prints a warning naming the file,
line and function, once per SOURCE SITE rather than per compile of it.
**Promotion to a hard error is planned for when the closure has zero such
sites.** WATX's own `(if COND A B)` shorthand — no `(then …)` either — is a
documented WATX spelling and stays quiet, or every watjs tree would drown in
warnings and the real sites would be invisible.

New suite `test/watx-compiler-literals.test.js` (83 checks), added to the
provenance checker's `REQUIRED_FILES` (19 → 20). It covers all six reproduced
shapes, the junk-in-every-other-position sweep, the unsupported float
spellings, a no-regression table of every literal form that was already valid
(including the negative-hex `i64` from the entry above), and the finding-2
warning: fires for the positional else, silent for a proper `(else …)`, silent
for an else-less `if`, silent for the WATX shorthand, and once per site.

`test/watx-compiler-i64-literal.test.js` needed two edits. Its rejection checks
pinned the exact sentence `Invalid i64 literal`, and `0xZZ` is now caught one
step earlier by the arity check, so the assertion is on rejection rather than on
one wording; and its note that digit separators are unsupported is now stale, so
it asserts `(i64.const 1_000_000) == 1000000` instead.

**Emitted bytes are unchanged.** The full `src/main.watx` closure compiled with
the HEAD compiler and with this one, on the same source tree, gives identical
artifacts in both modes — 984320 B tail / 984769 B compat, same sha256 — and
the only warning the closure prints is the single 09a5 site above. All fifteen
`watx-compiler-*` suites are green and none shrank.

New manifest digest:

  da59b4bab1dde12f248f44f814cd435ebec72d30675ffa581ea21220ac292029

## 2026-08-31 — a bare `+42` operand atom is a literal, like `(i32.const +42)`

Round-5 external review, LOW, follow-up to the entry above.

The tokenizer starts a number only on a digit or a `-`, so a plus-signed literal
written as a BARE atom in operand position (`(i32.add +42 …)`, a WATX spelling —
standard WAT always writes the `.const` form) arrived as the SYMBOL `+42` and was
rejected as an unknown symbol, while `(i32.const +42)` compiled fine. Not a
silent miscompile, and no site in the closure writes one, but an inconsistency
with no rationale behind it. The bare-atom fallback now accepts a leading `+`,
and applies the same int/float split as the number-atom path beside it, so
`+1.5` is a float rather than an integer-literal error and a bare hex atom
containing `E` stays an integer.

`test/watx-compiler-literals.test.js` grows a bare-atom table (`42`, `-42`,
`+42`, `0x2a`, `+0x2a`, `-0x2a`, `1_000`, `+1_000`, plus `0xE1`, `+1.5` and the
rejection of `+4zz`): 83 → 94 checks.

Emitted bytes unchanged again — the closure is byte-identical in both modes,
984320 B tail `d7c03355`, 984769 B compat `bfd6315c`, and the whole
`watx-compiler-*` set is green.

New manifest digest:

  bc39bed62a34e2428addd835615e87fcc5a5e2906205cbec688e05bf61db4817

## 2026-08-31 — type-section order parity: `(type N)` names the same index legacy names

The last body-encoding difference between the legacy and WATX artifacts that was
not a source defect. Body #355 — `$next`, the threaded-code dispatcher — encoded

    13 00 00   ;; return_call_indirect (type 0) (table 0)   lib/compile-wat.js
    13 01 00   ;; return_call_indirect (type 1) (table 0)   WATX

for the one line `(return_call_indirect (type $handler_t) …)` at
`src/04-cache.wat:938`. Both indices resolved to the identical signature
`(i32) -> ()`, so both modules validated and both dispatched correctly; only the
bytes differed.

A `(type N)` operand is a POSITIONAL reference into the type section, so this was
never about that one instruction — it was about the order in which the two
compilers intern signatures. `lib/compile-wat.js` interns in a fixed order: a
first sub-pass over every top-level `(type ...)` declaration, then ONE
source-order pass in which imports and function definitions are interned as they
are encountered. WATX interned lazily and in a different order — all imports,
then the region builtins, then all functions, then whatever a `call_indirect`
demanded — and never interned a named `(type ...)` declaration at all until
something referenced one. Two consequences, both now fixed:

  * `$handler_t` is declared in `src/02-thread-table.wat` before any import, so
    legacy gives it type 0. Under WATX it lost index 0 to the first import
    (`(i32 i32) -> ()`) and landed at 1 — the byte above.
  * imports sorted ahead of functions, which permuted nine further entries
    (indices 15–23 of the shipped module's 74-entry section).

`generateWasm` grows one pass, `internTypesInDeclarationOrder`, placed just before
the first `getTypeIdx` call. Sub-pass A interns every entry of `namedTypes` in
declaration order (Map insertion order is source order). Sub-pass B interns
imports and functions interleaved. It cannot walk `forms` for that interleaving:
by the time the emitter runs, the `(func ...)` forms have been consumed and only
the imports are still top-level — the earlier attempt measured
`forms funcs=0 decls=8141` and correctly declined. So the checker in
`compiler-stages.js`, the one pass where both kinds are still visible, now
records a `declOrder` array of `"import"`/`"func"` tags alongside `functionDecls`
and returns it in both of its result shapes; the emitter walks that with a cursor
into each declaration array. When there is no `checkResult` (a caller invoking
`generateWasm` directly) the function forms ARE still present and the fallback
walk over `forms` reproduces the same sequence. If the tag counts do not match
the declaration counts the pass declines rather than mis-pairing a cursor — the
historical order still produces a correct module, it just may not reproduce
legacy's numbering.

Nothing downstream depends on the order, because `getTypeIdx` dedups: every later
call returns the entry this pass created. Duplicate signatures therefore still
collapse to one entry, which is also what `lib/compile-wat.js` does through its
`sigKey` map — keeping the duplicates would have been the divergence, not the
parity.

Result: the two compilers now emit **byte-identical modules** in both modes —
984347 B tail `01daf6ccfbd115e3` and 984796 B compat `0ee6414668129ac4` from both
`lib/compile-wat.js` and WATX, with `tools/watx-matrix.js --only=abi` reporting
MATRIX GREEN and zero differing bodies (it had reported body #355 differing on
every previous run).

New suite `test/watx-compiler-type-index.test.js` (16 checks) reads the emitted
binary directly — the type section and the raw operand of the one
`call_indirect`/`return_call_indirect` in a body — and pins: a named type
declared before any import takes index 0 and a `return_call_indirect (type $t)`
encodes it; declaration order among distinct named types; duplicate-signature
dedup, with a reference through EITHER name and through an equivalent INLINE
signature resolving to the same entry; imports and functions interleaved in
source order rather than grouped; a working round trip through
`WebAssembly.Instance`; and that an undeclared type name is still a hard error
rather than a silently interned new entry.

The suite joins `REQUIRED_FILES` in `tools/check-watx-provenance.js` (17 → 18
pinned suites), so the seal covers it.

New manifest digest:

  d2c06462422e7a908639c137f94c0f3c17d940061944edef32e71420531ebe94

## 2026-08-31 — `region.declare-fixed`: the head that verifies a base instead of allocating one

Milestone 6 step 1 of `docs/watx-migration-plan.md`, designed in
`docs/watx-region-safety-design.md`.

The compiler already had a region FAMILY — `region.declare-static` / `-bump` /
`-rc`, `region.alloc`, `region.enter/exit`, and bare-symbol resolution of a
region name to its base. Every existing head **allocates**: static regions are
laid out from `STATIC_REGION_BASE = 1024`, bump/rc carve from the heap that
starts after them. wine-assembly's bases are an ABI it shares with JavaScript,
with tests and with guest-address translation (`g2w`), so the one operation it
was missing is the opposite verb: *this region is AT 0x07F60000 and is 0x20000
bytes — verify that, never place it.*

So this is **one new head in the existing family**, not a parallel subsystem:

```wat
(region.declare-fixed $GUEST_BASE (base 0x00012000) (size 0x03C00000)
                      (align 0x1000) (owner "PE image window"))
```

`(size N)` and `(end N)` are mutually exclusive and `end` is exclusive;
`(align N)` defaults to 4 and must be a power of two; `(within $OUTER)` declares
a deliberately nested region, which must be contained in `$OUTER` and is then
exempt from the overlap error against it alone — so "these two overlap on
purpose" is written at the point of overlap instead of living in an external
gate's exception list.

Reused verbatim: the top-level collection scan, the `(size N)` spelling, and
`regionBase` — a fixed region joins the same name→base map, so `$NAME` in
operand position emits `i32.const <base>` through the family's existing symbol
handler with no new resolution path. Rejected: the `staticCursor` allocation
entirely. A `declare-fixed` region contributes nothing to `staticCursor` or
`DATA_BASE`, so it cannot move the bump heap or the interned-string pool.

Validation, all hard errors carrying `e.line/e.col/e.file`: duplicate name,
missing/dual/malformed extent, unknown or duplicate clause, zero size, `end`
below `base`, misaligned base, non-power-of-two align, a region ending past the
memory *guaranteed at instantiation* (`memoryDecl.min * 65536` — a region that
only exists after a `memory.grow` the compiler cannot see is not a fixed
region), pairwise overlap naming both regions and both locations, `(within ...)`
naming an undeclared region or one that does not contain it, and a name declared
both fixed and allocated.

Also added: `(region.addr $NAME OFFSET [(span N)])`, `(region.size $NAME)` and
`(region.end $NAME)`, the offset-checked complement to bare-symbol resolution.
`region.addr` compiles to **exactly one `i32.const`** — byte-identical to the
raw constant it replaces, pinned by the suite — after checking the offset is a
non-negative integer literal and that `offset + span` is within the region.
With no `(span N)` the span is 1, so an address exactly at the region end is
rejected as the one-past-the-end it is.

**Declarations emit nothing.** A module with them is byte-identical to the same
module without them; that is what lets wine-assembly declare its whole fixed
memory map without moving the canonical artifacts (tail `01daf6ccfbd115e3`,
compat `0ee6414668129ac4`). It is also what keeps `WINE_WAT_COMPILER=legacy`
alive through this step: `lib/compile-wat.js` dispatches top-level forms through
a flat `if`-chain with no `else` and no whitelist, so it ignores an unknown
top-level form outright — verified by compiling the real tree twice through it,
with and without a `region.declare-fixed` part, to identical bytes. The
*expression* forms are WATX-only, and the first one written into `src/` retires
that rollback deliberately, in its own commit.

`compiler-stages.js` gained the three new heads in its i32 synthesis list, next
to `region.alloc`.

New suite `test/watx-compiler-regions.test.js` (60 checks): byte-identity with
declarations present and against a static/bump declaration; bare symbol,
`region.addr`, `(span N)`, `region.size` and `region.end` instantiated and
called; `region.addr` and the bare symbol byte-compared against the raw
`i32.const`; every failure mode above, each asserted to name its condition
*and* to carry a nonzero line number; and both tail-call and compat modes. It
joins `REQUIRED_FILES` in `tools/check-watx-provenance.js` (18 → 19 pinned
suites), so the seal covers it.

New manifest digest:

  56bf8193ed55ccda9273b571d77be9adccd9fcab78dbdc6c87120ecc4ccf5bf4

## 2026-08-31 — the deterministic allocator, the laws, derived bases, region-relative data, and the shake

Milestone 6 stage A, the rest of it (`docs/watx-region-safety-design.md` §4.1-§4.4,
§8, failure modes 15-20). Step 1 declared the map; this makes the map *movable*.

`compiler-codegen.js`. The four declaration heads — the pre-existing
`region.declare-static/-bump/-rc`, `region.declare-fixed`, and the two new
`region.declare` (allocated) and `region.declare-derived` (a base computed from a
guest VA) — now share ONE record type, ONE name→base map and ONE validation
pass, and that pass MOVED above the data-segment scan, because a region-relative
segment offset cannot resolve until the regions exist.

- **`(region.declare $N (size N) (align N) (owner "…"))` — allocated.**
  Declaration-order first-fit above `(region.floor N)`, never backfilling into an
  earlier hole (backfilling would make every base depend on the size history of
  every earlier region). `(region.gap N (reason "text"))` advances the cursor and
  *documents* a preserved hole; the reason is mandatory. Pinned and derived
  regions are placed first and are obstacles the cursor skips.
- **Constraints.** `(stride S (count C))` — either operand may name an i32
  constant global, so `DLL_TABLE_SIZE == DLL_TABLE_CAPACITY * 32` becomes one
  statement instead of two numbers that agree by luck; `(size-is-power-of-2)`;
  `(mask $G)`, which asserts the global is one below the region's count (or its
  size when no stride is declared) and refuses a mask over a non-power-of-two
  count. Laws apply to pins too — the constraint is about the extent, not about
  who chose the address.
- **Derived bases.** `(region.declare-derived $R (base (g2w 0xVA)) …)` resolves
  to `$GUEST_BASE + (VA - image base)`, so the written constant is the guest
  address, which is the thing that is actually an ABI. The image base is
  `(region.image-base N)`, defaulting to `0x400000`. A derived base needs a
  PINNED `$GUEST_BASE`: deriving from an allocated one would let the guest ABI
  move with the layout.
- **Region-relative data segments.** `(data (region.addr $R OFF) "…")` places the
  segment at base+off and checks it against the region's extent **including the
  segment's own length** — the bound the absolute form never had. It emits the
  identical `i32.const` the absolute form emits, pinned by a byte comparison in
  the suite.
- **The shake.** `options.regionShake` = `gap` (a prime gap before each region),
  `rotate`, `reverse`, `pad` (prime spacing without resizing, so the stride/mask
  laws stay intact) or a numeric seed (a reproducible LCG shuffle). It reaches
  the allocator and nothing else: pins and derived regions never move, because
  moving `$GUEST_BASE` changes the guest ABI, which is a different experiment.
  The layout is reported on the compile result (`result.regions`) so a build
  banner can say which map an artifact carries; a shaken artifact must never be
  mistakable for a canonical one.
- **Failure modes 15-20** are hard errors with `file`/`line`/`col`: 15 allocation
  past initial memory (naming the last placed region), 16 a pin with no room
  after it (naming the pin), 17 a stride×count that is not the size, 18
  `(size-is-power-of-2)` over a size that is not one, 19 `(g2w …)` with no
  declared `$GUEST_BASE`, 20 a data segment running past its region.

**Round-6 review finding, folded in.** Regions share the `$name` namespace with
functions, globals and locals, and only one of those collisions is intentional —
a region named after the `(global $R i32 (i32.const base))` it replaces, which is
the migration pattern and stays legal. Two are now hard errors: a region named
after a **function** (a bare `$f` would emit the region base while `(call $f)`
still calls the function), and a bare region symbol **shadowed by a local** (the
local silently won, so the address the author wrote could never be read). An
explicit `(local.get $X)` is unambiguous and stays legal. Function contexts gained
`sourceForm` so a diagnostic raised before any inner form has compiled still
carries a line number.

`compiler.js` surfaces `result.regions` — the layout and whether a shake permuted
it. Nothing else on the result changed.

**Byte identity holds.** All 160 regions still compile to tail
`01daf6ccfbd115e3` / compat `0ee6414668129ac4`, and — the load-bearing proof —
so does the tree with every one of those declarations rewritten as
`region.declare` with 30 explicit gaps: `node tools/region-alloc.js --prove`
substitutes the allocated form into the source closure in memory and reports
`984347 B 01daf6ccfbd115e3` / `984796 B 0ee6414668129ac4`. The allocator can land
on the hand-placed map exactly, which is what stage A required before stage B's
fan-out can use byte identity as its correctness oracle.

New suite `test/watx-compiler-alloc.test.js` (76 checks) joins `REQUIRED_FILES`
in `tools/check-watx-provenance.js` (19 → 20 pinned suites);
`test/watx-compiler-regions.test.js` grew to 67 with the namespace-collision
checks.

New manifest digest:

  4b1b8a0321f09da79b98801df2e892627e19facfeb847ce40012ffb28e52461f

## 2026-08-31 — `region.declare-span`, and one data offset that skipped its bounds check

Two changes to `compiler-codegen.js`, both in the Milestone 6 region family.

### `region.declare-span` — a named address LIMIT (design §5.1)

```wat
(region.declare-span $DIRECT_WINDOW (base 0x00000000) (end 0x08000000)
  (owner "03-registers.wat — $g2w's direct-window limit"))
```

`$g2w`'s direct guest window is the motivating case and the design names it:
its upper bound is the bare literal `0x8000000`, written three times in
`src/03-registers.wat`, and it is `$VIRTUAL_BACKING_BASE`'s base spelled as a
number. It could not be declared with any existing head, because it is not
storage — it *contains* `$GUEST_BASE`, the guest heap, the stack, the thunk
zone, PE staging and the whole WAT-private high map, so every other head would
have made the compiler reject the map as 150-way overlapping.

So a span has exactly one distinguishing property, and everything else about it
follows from that property rather than being a separate decision:

- **It is transparent to the overlap sweep**, in both directions. Regions live
  inside it (that is its point), and two spans may nest, so spans are dropped
  from the interval sweep entirely rather than bolted onto `nested()`. The
  regions it covers are still checked against *each other*.
- **It is not an allocator obstacle.** Treating the direct window as a pin
  would push all 167 of Wine's regions above `0x08000000` and invert the map.
- **It is never allocated and never shaken**: it is not in the allocation
  sequence at all, so `WINE_REGION_SHAKE` cannot move a limit — a shake that
  moved the boundary would be testing arithmetic, not addressing.
- **It carries no alignment, nesting or `(stride)`/`(mask)` law**, because it
  owns no bytes for one to be a property of. Its clause set is exactly `(base
  N)`, one of `(size N)`/`(end N)`, and `(owner "text")`; anything else is a
  hard error that lists a *span's* clauses, not the family's.
- **`(owner "…")` is MANDATORY** — the one clause rule a span does not inherit.
  Nothing else in the module can catch a transparent range declared by accident
  or left behind after the limit it named was deleted, so it is required for the
  same reason `(reason "…")` is required on `region.gap`: an undocumented
  transparent range *is* the unnamed constant this head exists to replace, only
  now it has a name and still explains nothing.

What it *does* inherit is the fixed head's symbol resolution, which is the
entire payoff: `$DIRECT_WINDOW`, `(region.end $DIRECT_WINDOW)` and
`(region.addr $DIRECT_WINDOW 0x…)` all resolve through the family's existing
name→base map, with no new resolution path. A span is bound-checked against
initial memory like a pin — transparency excuses it from overlap, never from the
map's edge — and it emits nothing, like every other declaration head.

Failure modes, all hard errors carrying `file`/`line`/`col`: no `(base N)`; no
`(owner "…")`; both or neither of `(size)`/`(end)`; `(end)` at or below
`(base)`; zero extent; a non-integer literal; an extent past initial memory; a
duplicate name (including one shared with a fixed region); a forbidden clause
(`align`, `within`, `stride`, `mask`, `size-is-power-of-2`) or a misspelled one;
a duplicate clause; and `region.addr` past the span's extent.

### Active data segments: `region.addr` is the only region-relative offset

Round-7 review finding, and it was a hole wearing the syntax of the fix. The
data scan treated `region.addr`, `region.end` and `region.size` alike as
region-relative offsets, but failure mode 20 — checking a segment's payload
LENGTH against its region's extent — is applied only in the `region.addr`
branch. So `(data (region.addr $R 0x10) "X")` correctly failed for a 0x10-byte
region while `(data (region.end $R) "X")` and `(data (region.size $R) "X")`
both compiled with no bounds check at all.

Neither is an addressable location, which is why neither has an offset for the
check to be about: a region's end is one past its last byte, so a segment
starting there is out of bounds by construction, and a region's *size* is an
extent, not an address — it only ever named a plausible offset by the accident
of a region based at zero. Both are now hard errors naming
`(data (region.addr $R OFF) …)` as the form to write, and data-offset
diagnostics now carry a source location instead of being bare `Error`s.

### Verification

`test/watx-compiler-regions.test.js` 67 → **119** checks: a `(5) SPANS` section
(transparency in both directions, two nested spans, symbol resolution,
zero-byte emission, the allocator placing *into* a span, the layout kind, and
every failure mode above) and a `(6) DATA SEGMENT OFFSETS` section (the two new
negatives, the payload-length positive and negative, and byte identity between
a region-relative segment and its absolute twin).

All 18 `test/watx-compiler-*.test.js` suites green, `test/test-watx-matrix.js`
48/48. **The compiler change moves no bytes**: `node tools/build-compile-wat.js`
over the same working tree with HEAD's `compiler-codegen.js` and with this one
produces identical artifacts —
`e4b048bab442c28d…` / `fb8116fa10077135…`. The
`src/00-regions.wat` + `src/03-registers.wat` conversion that follows is
byte-identical too, proven the way wave 1 proved its conversions: the HEAD
source closure compiled twice in one process, once pristine and once with only
these two hunks swapped in, equal in both tail-call modes.

One cosmetic note for whoever owns `tools/build-compile-wat.js`: its banner
counts a span in the `(N pinned/derived, M allocated)` tally, where it is
neither. Not touched here — that file is outside this change.

New manifest digest:

  a5c40a9c52e4d3e1024c8e2932f6dd3089192d9cacaf6fb947e40fc80cf71f0b

## 2026-08-31 — a span cannot be storage (round-8 review, HIGH)

External review, with a reproducer that compiled:

```wat
(memory 1)
(region.declare-span $S (base 0x1000) (size 0x100) (owner "test"))
(region.declare-fixed $A (base 0x1000) (size 0x100))
(data (region.addr $S 0) "X")
```

A span joins the same name→base map every other head does — deliberately, since
that is what makes `(region.end $DIRECT_WINDOW)` work — but `region.addr`
resolved against it without ever asking what kind of region it was, and the data
scan accepted the result as a segment offset. So bytes could be stored through
a declaration that **nothing checks for overlap**, and `$A` above sits on top of
them in silence. Transparency is the head's entire purpose and this was
transparency leaking into a place it was never meant to reach: the answer to
"what stops someone declaring their new table as a span?" was review discipline,
which is not an answer.

**`region.addr` is now refused on a span, in every position and at every
offset.** A span has no interior of its own — the bytes between its base and its
end belong to the regions it covers, which have their own names, their own
extents and, unlike the span, their own overlap check. An address computed off a
span is therefore an address in a range nothing polices.

Rejected at offset **zero** as well, not only nonzero. The alternative — allow
`(region.addr $S 0)` as a lower-bound spelling and reject the rest — was
considered and dropped: `(region.addr $S 0)` and a bare `$S` are the same
number, so permitting it buys no expressiveness whatever, and it costs a rule
with a boundary that somebody then has to remember. A boundary at zero is
exactly the sort that gets widened later by one reasonable-sounding exception.

Nothing a limit legitimately needs was lost, which is what makes this a rule
rather than a retreat: `$S` is the lower bound, `(region.end $S)` the upper
bound, and `(region.size $S)` the width for a `lt_u (sub x base) size` range
test. `src/03-registers.wat` uses only `region.end`, so the real tree is
unaffected.

Two diagnostics, not one, because the mistakes are different. A data segment
anchored to a span gets its own message naming the actual error — bytes stored
in a limit, in a range any region may later be declared on top of — instead of
inheriting the general "a span has no interior" one. Bytes in a module are the
least ambiguous evidence that somebody meant storage.

`test/watx-compiler-regions.test.js` 119 → **125**: `region.addr` into a span at
a nonzero offset and at zero, a data segment anchored to a span, the review's
reproducer verbatim, and a positive check that the three-way range test still
compiles. All 18 `watx-compiler-*` suites green, `test/test-watx-matrix.js`
48/48. Byte-identical no-op on the real tree in both modes: the same working
tree built with HEAD's `compiler-codegen.js` and with this one gives
`aff985b4c0dcac92…` / `53530d46d34ccda6…`, and the `03-registers.wat`
conversion re-verifies `IDENTICAL` under the paired HEAD-vs-HEAD+file oracle.

New manifest digest:

  4db2a8f0b64e9ffe4af6372dc9d5c65af2b1f2619de8bf1b92d5ffe762ecd469

## 2026-08-31 — a region constant may initialize a global

One change to `compiler-codegen.js`, and it is the thing standing between the
region allocator and a map that can actually move.

```wat
(global $WND_RECORDS      i32 (region.addr $WND_RECORDS 0))
(global $WND_RECORDS_SIZE i32 (region.size $WND_RECORDS))
(global $console_text_base (mut i32) (region.addr $CONSOLE_TEXT 0))
```

Every region in wine-assembly's map has a `(global $NAME i32 (i32.const 0x…))`
mirror behind it, and that mirror — not the declaration — is what the code
reads: ~1100 `global.get` sites across `src/`. While the initializer is a
literal the map is nailed down, because an allocated region would relocate and
every one of those sites would keep reading the address it used to be at, with
nothing to say so. `region.addr` was legal in an instruction operand and in a
data-segment offset but rejected in a global initializer, which is the one
position that mattered.

The three region constants — `region.addr`, `region.size`, `region.end` — are
now accepted there, resolved through the **same** `regionConstValue` the other
two positions use. That is deliberate rather than convenient: the offset bounds
check on `(region.addr $R OFF)` and the refusal to compute an address off a span
hold in a global initializer for free, because there is one implementation to
hold them.

Three narrow rules, all of them about not inventing meaning:

- **i32 only.** An address is an i32. An `f32`/`f64`/`i64` global initialized
  from a region is a hard error naming the type, not a silent conversion.
- **Mutable globals are allowed.** Several of Wine's mirrors are `(mut i32)`
  cursors seeded at a region's base (`$console_text_base`), and a seed is a
  constant like any other.
- **Nothing else changed.** A literal initializer takes exactly the path it
  always did; `REGION_CONST_HEADS` names the three heads in one place so the
  three positions cannot drift apart.

`test/watx-compiler-regions.test.js` grows to 140 checks: the four resolutions
against an allocated pair, a mutable seed, the byte-identity oracle that makes
converting a mirror a no-op while its region is still pinned, and four
rejections (past the region's extent, off a span, an undeclared region, a
non-i32 global).

New manifest digest:

  72b5cc4a809076c4cb769a32e6b3ccaac869fb83b1bbb86d7c577e32096200d7

## 2026-08-31 — `(v128.const <shape> …)` was a silent miscompile

Found by the wabt differential oracle (`tools/watx-differential.js`), which is
exactly the class of bug an independent encoder oracle exists to find: no test
failed, no diagnostic fired, and the tree was unaffected — WATX's own byte-wise
spelling is what `src/*.wat` uses, and it was always correct.

Standard WAT writes a SIMD constant with a shape token saying how wide its lanes
are:

```wat
(v128.const i8x16 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16)
(v128.const i32x4 0x80000000 0x7fffffff 0xffffffff 1)
```

The `head === 'v128.const'` branch read exactly 16 operands and wrote each one
`& 0xff`. It had no idea a shape token could be there, so:

* the token itself became **lane 0** — `immVal` ran `parseInt('i8x16')`, got
  `NaN`, and took the documented fall-through to the default `0`;
* every later lane **shifted one position** and the sixteenth was **dropped**;
* under any shape wider than `i8x16` each lane was **truncated to one byte**, so
  `i32x4 … 0xffffffff` put a single `0xff` where four bytes belong and the other
  three bytes of that lane came from the neighbouring operands.

The module compiled, validated and ran. It simply computed with a constant
nobody wrote. `0x80000000` is the second half of the same trap: a lane that goes
through a JS `Number` has already lost the sign bit before anything masks it.

Both spellings are now accepted and they are unambiguous — a shape token is a
symbol atom, a byte-wise operand is always a number (or an `(i32.const N)`
subform). All six standard shapes are handled (`i8x16`, `i16x8`, `i32x4`,
`i64x2`, `f32x4`, `f64x2`), each lane encoded little-endian at its own width.
Every integer shape goes through `parseI64Literal`, so a lane written
`0x80000000` or `-1` lands as its two's-complement bit pattern rather than as
whatever a `Number` had left; the float shapes encode through a `DataView` at
the lane's own width.

A malformed constant is a **located error**, not a guess: an unknown shape token
names the six that exist, a lane count that disagrees with its shape says which
shape and how many it got, and the byte-wise form is now strict at 16 operands —
it used to zero-pad a short one and drop the tail of a long one, both silently.

The canonical artifacts cannot move: `src/*.wat` contains **zero** `v128.const`
sites, and `build/wine-assembly.wasm` / `.compat.wasm` hash to
`737ff788821985d8` / `fcc1b67506ea9c49` on both sides. `watx-compiler-simd`
37 → 51: the eight shape cases assert the **stored 16 bytes** rather than a
derived scalar (a wrong lane cannot hide behind an extract that happens to land
on a correct byte), including the byte-wise/`i8x16` pairing that is the whole
bug in one line, plus six rejections. The reproducer
`tools/watx-repro/v128-const-shape.js` flips from exit 1 to exit 0.

New manifest digest:

  c3554e582ff41d577c28137cce7e67eedfa5821359d81d7cd01dd3c12a05fe7e

## 2026-08-31 — multivalue results are refused, not silently emitted

An accepted-invalid module is the worst failure a compiler has, and WATX had
one. `(result i32 i32)` parsed — the type section even encoded both results
correctly — and then the body was emitted as if there were one. V8 caught it at
instantiate:

```text
WebAssembly.Module(): Compiling function #3 failed:
expected 2 elements on the stack for fallthru, found 1 @+116
```

A byte offset into a generated binary, from the engine, long after the compiler
that could have named the file and line let it through. Confirmed from outside
by the wabt differential oracle at the same time.

Nothing downstream of the parse is multi-valued, so this was never one missing
line: a block type is emitted as a **single `VALTYPE` byte** with no path to the
type-index form multivalue requires, `expressionType` reports `results[0]` and
discards the rest, and `funcHasResult` / `exprYieldsValue` are booleans. Real
support is a second value stack through the whole emitter plus block types as
type indices — not a contained change, and nothing in the tree asks for it. So
the honest behaviour is to fail at the declaration, with a location:

```text
function $swap: multivalue results are not supported — 2 result types (i32 i32)
were declared and WATX emits bodies that yield at most one. Return the extra
values through memory or an out-pointer.
```

Five declaration positions are covered — `func`, `block`, `loop`, `if`, and an
imported func — because all five reached the same single-valued emitter and four
of the five produced a module V8 refused. The function check sits in the shared
`funcDecls` loop rather than beside either `(result …)` parse, since there are
**two** parsers (the inline one here and the streaming one in
`compiler-stages.js`) and a rule enforced in one of them holds only for whichever
path the caller happened to take.

`tools/watx-differential.js`: the `multivalue` corpus entry's divergence marker
now states the refusal instead of the old accepted-invalid emit, and the spelling
is listed in `DIALECT_GAPS` beside the float spellings — it is a deliberate,
documented dialect boundary now, not an open bug.

`watx-compiler-block-result` 23 → 34: each of the five positions must fail *here*
and the message must say `multivalue` (so a future refactor cannot satisfy the
test by handing the job back to V8), plus a no-regression case proving the rule
is "more than one", not "a `(result …)` clause at all". Canonical artifacts
byte-identical against a clean worktree build at the same HEAD (`c409c554`):
`71ea98f134a486cd` / `d569961e3e7d6325`.

New manifest digest:

  490113af46201c26a37ea33db1acf145e0bd2bf169488a9143524626dc46ec35

## 2026-08-31 — `(start $f)` was parsed and dropped

The string `start` did not occur anywhere in the compiler. `(start $f)` fell off
the end of the top-level form scan like a comment: no start section was emitted,
the module loaded, it validated, and the one function the author asked to run
before anything else **never ran**.

That is the worst shape a bug can take, because it is invisible from outside —
"start ran and its effect was subtle" and "start was never wired" look identical
unless you go looking for the effect on an instance nothing has called yet. The
differential oracle carries a matching scar in `stripEmptySections`: a start
section's entire payload is a one-byte function index, so `08 01 00` reads
exactly like an empty vector, and a module whose start function never ran once
reported as *byte-identical* to wabt's.

The section is emitted now — id 8, between exports and elements, resolved
through the same `funcIndexMap` every other section uses, so the index space
(imports first, then defined functions) cannot drift from the export and element
sections. Four ways of asking for something impossible are located errors rather
than an engine complaint at instantiate: an unknown function, a second `(start
…)`, and a start function declared with parameters or with a result (the spec
requires `[] -> []`).

`watx-compiler-export-order` 17 → 26, in that suite because a start section is a
section-emission question. The assertion is **behavioural**: instantiate, then
read a mutable global without calling anything — a structural check for section
8 would pass just as happily on a section carrying the wrong function index. The
section-id list is checked to stay ascending alongside it, since a start section
emitted out of order is a module every decoder refuses.

No `src/*.wat` uses `(start …)`, and the canonical artifacts are unchanged:
`71ea98f134a486cd` / `d569961e3e7d6325`.

New manifest digest:

  0f3d663396e77d9e69f1c378f02be71d82fb715e559bfe9e7a1c01f3d7e5e41e

## 2026-08-31 — `\u{…}` escapes stored the letter `u`

WATX had no case for the spec's Unicode escape at all. `\u{1F600}` fell through
to the "unknown escape" branch of both string decoders, which stores the escaped
character as a byte: out came `u`, followed by `{1F600}` copied across
literally. Seven wrong bytes where four belong, with no diagnostic, into a data
segment that then loads at a fixed guest address.

Both decoders share one `decodeUnicodeEscape` now, because there are two string
paths — `decodeWatStringBytes` for `(data …)` segments, `unescapeStr` for the
WATX string pool — and the same escape must not mean two things. The codepoint
is encoded UTF-8, as the spec requires, and `\hh` keeps meaning one raw byte
beside it (they share the escape switch, so that is pinned by a test rather than
left to reading).

Five malformed spellings are rejected instead of guessed: no brace, no closing
brace, non-hexadecimal digits, past `10FFFF`, and a **surrogate half**. The last
is the interesting one — a surrogate is not a Unicode scalar value and has no
UTF-8 encoding, so `String.fromCodePoint` would hand back a lone surrogate that
`TextEncoder` silently replaces with U+FFFD. That is the same class of quiet
wrong constant this entry exists to remove, arrived at from the other direction.
In a data segment the error carries the segment's location through `dataErr`.

`watx-compiler-literals` 94 → 102. The encoding assertion reads the bytes back
out of an instantiated module and compares against Node's own UTF-8 encoding of
the same text — one-, two-, three- and four-byte codepoints in one segment — so
it tests the encoding rather than restating it.

No `src/*.wat` data string uses `\u`, and the artifacts are unchanged:
`71ea98f134a486cd` / `d569961e3e7d6325`.

New manifest digest:

  bddda2054299ac1fd640a7f7b0c76111a9ca491272a717df0b0b7e2592610fac

## 2026-08-31 — a memory declaration takes limits, not clauses

`parseLimits` skipped anything inside a `(memory …)` form it did not recognise,
and the skip was invisible because the limits then fell back to their defaults.
So `(memory (data "…"))` — the spec's inline-data spelling, which also *implies*
the memory's size — matched no branch, contributed no number, and produced a
**silently synthesized 16-page memory containing none of the author's bytes**.
An inline `(export "…")` clause disappeared the same way.

The loop is exhaustive now. Neither form is one this tree needs, and both have a
one-line standard rewrite, which the error hands over: write the limits on the
memory plus a separate `(data (i32.const OFFSET) "…")` segment, and a top-level
`(export "name" (memory 0))`. An unrecognised bare token is named rather than
dropped, and the limits themselves go through `watxParseIntLiteral`, so
`(memory 1 2junk)` joins every other literal position in refusing trailing junk
instead of silently reading `2`.

The rule covers the imported spelling too, since `(import "env" "memory"
(memory …))` parses through the same function — which is the one that matters
here, because that is the form `src/01-header.wat` actually writes.

`watx-compiler-export-order` 26 → 33: four rejections, and three no-regression
cases pinning the spellings that are real — bare limits, min with no maximum,
and `$name` + `shared`.

Artifacts unchanged: `71ea98f134a486cd` / `d569961e3e7d6325`.

New manifest digest:

  5aa98a2aa48835dfa4d20a6d61d7e13299ba3752c0f76fd5a688e762cc17bb72

## 2026-08-31 — macro arity is checked, in both directions

`expandForm` bound arguments with `macro.params.forEach((p, i) => bindings[p] =
args[i])`. That iterates the **parameters**, so it never looks at an argument
past the last one: a surplus argument was dropped without a word, and a missing
one bound `undefined`, which `substitute` then spliced into the body as a hole.
Either way the module compiled and computed as if the extra argument had never
been written — precisely what an edit that reorders or renames a macro's
parameters leaves behind at every call site it did not update.

A macro invocation is a call, and the compiler already holds calls to this
standard (`call $callee: expected 1 args, got 0`). An arity mismatch is now a
located error naming the macro, its parameter list and the count it got.

`watx-compiler-production` grows five assertions: too many, too few, the line
number being the *invocation's* rather than the expansion's, a nullary macro
given an argument, and a correct nested invocation that still compiles and
returns the right value.

`tools/watx-rejection-pairs.js` moves both macro rules onto the new behaviour:
the too-MANY pair loses its `notEnforced` marker, and the too-FEW pair, which
was recorded with a `weakDiagnostic` reading "the refusal should name the macro
and its arity, not report an unresolved symbol inside the caller", now expects
exactly that message. `test/test-watx-rejections.js` goes 86/87 with one rule
unenforced to **87/87 with none**. Verified byte-identical the strict
way — a clean detached worktree at `d3466fac` built twice, once as checked out
and once with only `compiler-stages.js` replaced — because peer edits were live
in `src/` at the time and a working-tree build would have measured those instead:
`71ea98f134a486cd` / `d569961e3e7d6325` both runs.

New manifest digest:

  356d8f714b66112d322c188fef807fef1a42d62e7b8263aa7a0e6fef947e6717

## 2026-08-31 — an optional wasm `name` section (research TODO #2)

An instantiation failure or a trap reports a function **index** and nothing
else — `Compiling function #3849 failed: expected 1 elements on the stack for
fallthru` in a module of 8,386 functions concatenated from sixty-one files,
naming no file, no function and no line. `tools/func-index.js` and
`tools/wasm-func-name.js` exist only to translate that by re-deriving the index
space from the source. A name section puts the answer *in the artifact*, so
node, DevTools and every profiler print `$handle_CreateWindowExA` instead of
`wasm-function[3849]`.

`options.nameSection` (default **false**) emits custom section 0 with the module
name and the function-name map. Off by default is load-bearing, not timidity:
the canonical artifacts' byte-identity is the instrument every change in this
changelog was proved with, and ~195KB of names would take it away.

The map is built from `funcIndexMap` **itself** — imports, then the runtime
builtins, then defined functions — never from a second walk that agrees with it
today. That is the whole point: a name section built from a reconstruction can
name a plausible *wrong* function with total confidence, which is worse than no
section at all. Entries are sorted by index, as the spec requires, rather than
assumed to arrive in order. Local names are skipped; they multiply the size for
a payoff a stack trace does not need.

Opt-in surface: `tools/build-compile-wat.js --names` (or `WINE_WAT_NAMES=1`)
writes `build/wine-assembly.named.wasm` **alongside** the canonical pair,
validated like the other two and labelled non-canonical in the build log.
`compileClosure` gained a `nameSection` option that is only ever set when asked.

Verified against the real closure: 8,386 names = 221 imports + 8,165 defined,
exactly the counts `tools/wasm-func-name.js` derives independently from the WAT,
with sampled indices agreeing by name (`2795 → $handle_OleRun`,
`4193 → $d3dim_fvf_stride`). Building **with** `--names` leaves the canonical
artifacts at `71ea98f134a486cd` / `d569961e3e7d6325`. One honest limitation: a
function with no source identifier is named `$__anonymous_N`, where the
source-walking tool reports its export string instead.

`watx-compiler-export-order` 33 → 40. The assertion is a real trap stack naming
the callee and its caller, with a negative case showing the same frames
anonymous without the section — a structural check for "a section exists" would
pass on a section carrying the wrong indices.

New manifest digest:

  f0067c83ae8d5428d65ed1c0de0b1002dd2edfe7c2133d19941008e2cf2a8613

## 2026-08-31 — one JS character per source byte

`watxSourceTextFromBytes(bytes)` in `compiler-parser.js` is the compiler's
byte→text boundary, and hosts that read sources as bytes are expected to decode
through it rather than through a bare `TextDecoder`.

It exists for one V8 representation rule: a string whose every code point is
below 256 is stored one byte per character, and a **single** code point above
that stores the whole string at two. Wine's sources are ASCII apart from the
box-drawing characters in their banner comments — 21,289 such bytes across 29 of
62 files — so 21 KB of decoration was doubling 10.85 MB of source into 20.53 MB
of live heap (measured: 1.89 bytes per character), held for the entire compile.

The boundary replaces non-ASCII bytes that lie inside a `;;` comment with `?`
and then decodes. One byte in, one character out: the tokenizer never reads
comment text, and every source offset stays exactly the byte offset it already
was, which matters because the streaming pass indexes bodies by offset.

It is deliberately conservative about "inside a comment". The scan tracks the
same two constructs the reader does — `;;` to end of line, and `"…"` with
backslash escapes — and **bails out**, decoding the untouched bytes as UTF-8
exactly as before, the moment a high byte appears anywhere else. A literal
non-ASCII character in a data string keeps its present meaning and its present
cost; nothing silently rewrites a data segment. The two constructs do not nest
into each other: a `;;` inside a string opens no comment, and a quote inside a
comment opens no string.

Measured on the real closure, interleaved A/B (arms alternating, order rotated,
5 reps each, one cold compile per process): live heap after reading the sources
**25.3 → 16.8 MB** in every single run, whole-process max RSS 216.6 → 201.9 MB
(median; this box is loaded and that number is noisy, the heap number is not),
user CPU 2.14 → 2.26 s (+5.6%, the byte scan). `build/wine-assembly.wasm`
`24beaca0…` and `build/wine-assembly.compat.wasm` `4e2891ac…` are unchanged.

Callers moved to the boundary: `tools/watx.js` re-exports it as
`sourceTextFromBytes`, `tools/watx-closure.js` reads buffers instead of `'utf8'`
strings, and `lib/watx-compile-worker.js` now evaluates the compiler bundle
*before* decoding the sources so it can use it (the two halves of the transfer
are decoded separately for that reason alone).

`watx-compiler-production` gains the boundary's regression: one byte per byte
for a comment-only source, byte-identical emission against the UTF-8 decode of
the same file, and the two bail-out cases.

New manifest digest:

  b32bc95c12f8ca4145268e76ae3dea94725b8a75e03b80fb1deeafd4bbb6d6d3

## 2026-08-31 — location packing had room for one more file

A source location is one 30-bit Smi holding a file id and a byte offset into
that file. The original split was six file bits and a 24-bit (16 MB) offset —
64 files. Wine's closure is 62 sources plus `<main>`, so **63 of the 64 ids were
already spoken for**: adding two `src/*.wat` files would have stopped the build
with "WATX location encoding supports at most 64 source files", a message with
no connection to the file somebody had just added. Measured, not inferred: after
a real compile the parser accepted exactly one more distinct filename.

The largest source in the tree is 953 KB, so the offset field was the one with
slack. It is now seven file bits and a 23-bit (8 MB) offset: same Smi, 128 files
(66 spare) and 8× headroom on the biggest source. Both guards still throw, and
both now name the culprit — the file that would have been number 129, or the
file's size against the limit it passed.

`watx-compiler-production` parses 100 distinct filenames and then checks that a
form from a high file id still reports its own file and line, so the packing is
asserted end to end rather than by arithmetic. `tools/watx.js` re-exports
`watxNodeFile` / `watxNodeLine` / `watxNodeCol` for it: decoding the packed
integer by hand is exactly the dependency this change moves.

Artifacts unchanged — `24beaca0…` / `4e2891ac…`.

New manifest digest:

  0d15bb6c0eee9e2eff5e709e1dbc724fbec4268acb56ec10074b36285125d3f9

## 2026-08-31 — The shake gets a placer that flows around the pins

Three of the five region shakes could not compile at all. `gap`, `pad` and
`reverse` each died in pass 3 — "`$THREAD_CACHE_BASE` cannot be allocated at
0x1C000000: pinned `$DIB_BACKING_BASE` occupies it, and nothing fits after it
inside the 0x20000000 bytes of memory" — so `tools/region-shake-smoke.js`'s own
default mode list was 1-of-3 red and the dead modes were simply never run. A
shake mode that silently cannot run is worthless in exactly the way a green run
suggests it is not.

It was the allocator, not capacity. The pins cut the usable space into four
disjoint windows, and the canonical placer carries ONE monotonic cursor and
never backfills — deliberately, because backfilling would make every base depend
on the size history of every earlier region. Under a shake that is a cliff: the
smallest window is 0x100..0x12000, 73 KB holding 54 tiny regions with nothing
spare, and `gap` asks to put 1.11 MB of prime gaps into it. The cursor overflowed
into `$GUEST_BASE`, jumped past it, and abandoned every free byte of every
earlier window; the cascade repeated until 32 MB `$THREAD_CACHE_BASE` had only a
14.68 MB window left. Measured, the map had **5.43 MB of tail slack against
3.55 MB of shake inflation** — it fitted the whole time.

`placeShakenAroundPins` gives the shaken path its own placer: one cursor per free
window, **best fit** across them. Best fit rather than first fit is the fix
itself — first fit by address hands every small region to the lowest window with
room, so the small ones eat the one big window and `$THREAD_CACHE_BASE` came up
318 KB short of its 32 MB in a 47 MB window that had already been spent on
regions with somewhere else to go. A region that fits nowhere at its inflated
footprint drops its gap, then its padding, before it fails; each concession is
counted in `shakeScaledDown` and named in the build banner, because a shake that
quietly could not inflate is a weaker experiment than the one that was asked for.
Today's map needs none: all five modes place with `shakeScaledDown` 0, every mode
moves 114–167 of the 167 allocated regions, and every pin stays put.

**The canonical branch is untouched, byte for byte.** `if (shake) … else …` keeps
the original single-cursor loop verbatim for the build that ships, so a canonical
compile cannot take the new path. Proved rather than asserted:
`build/wine-assembly.wasm` `aa65465e…` and `build/wine-assembly.compat.wasm`
`2ea6bcc4…` are identical before and after.

`region-shake-smoke` is now 3-of-3 IDENTICAL on its default modes (0 of 307200
pixels differ), and `reverse` and `pad` render identically too.
`test/test-region-shake.js` asserts every mode places a legal, different map with
its pins intact, so a future pin move that re-breaks the shake fails loudly
instead of becoming a mode nobody runs.

New manifest digest:

  3f0f07718adcabf62b9787e212768434c2e63759d24377775bc8b28ab9a7740f

## 2026-08-31 — `inf`, `nan`, `nan:0xPAYLOAD` and hex float literals

Four of the five entries in `DIALECT_GAPS` (tools/watx-differential.js) were one
family: standard WAT float spellings that WATX refused with *"expected exactly
one literal operand, got 2"*. The arity error was a symptom — the tokenizer
stopped the literal early and the rest of it arrived as a second atom:

```text
nan:0x400000     stopped at ':'   -> symbol `nan` + number `0x400000`
0x1p-149         stopped at 'p'   -> number `0x1` + symbol `p-149`
1e+10            stopped at '+'   -> number `1e`  + symbol `+10`
inf / -inf       one symbol token already; nothing downstream would encode it
```

**compiler-parser.js** — two new shared helpers, `watxScanNanPayload` and
`watxScanNumberEnd`, and *both* scanners call them: the legacy `tokenize` and
the production `parseSource` table walk. A literal that ends in a different
place in each is the standing trap in this file, so the scan is written once.
A sign may follow the exponent MARKER and nothing else, and the marker is `p`
for a hex literal and `e` for a decimal one — which is what keeps `1-5` from
reading as an exponent and the hex digit `e` in `0x1e-5` from being mistaken
for one. Neither helper validates; the strict literal checkers still own that.

**compiler-codegen.js** — `watxFloatLiteralBytes(raw, what, width)` is now the
single entry point for every `TYPE.const` float site (seven of them: the two
bare-literal paths, the const form, the SIMD lane path, and both halves of the
global-initializer emitter). Three of the four spellings name a BIT PATTERN
rather than a number and cannot go through a JS Number at all:

- assigning any NaN to a `Float32Array`/`Float64Array` may hand back the
  canonical quiet NaN, so the round trip that encodes every other literal would
  quietly replace `nan:0x400000` with a plausible payload. The SIMD lane path
  had exactly this bug in waiting — it stored each lane through a `DataView`.
- `Number()` cannot read a hex float at all; it returns NaN.

So the significand is a `BigInt` and the rounding is done on it, once,
round-to-nearest-ties-to-even, straight into the target format — no intermediate
double, and therefore no double-rounding for f32 to get wrong at the subnormal
boundary. DECIMAL literals are deliberately NOT rerouted: they keep the
`Number()` + typed-array store they always had, so every literal that compiled
before encodes to the same bytes. A hex literal with no `.` and no `p`
(`(f64.const 0x10)`) is an integer in a float position and stays on the old path
for the same reason. A NaN payload of 0 (that is an infinity) or one too wide
for the field is a located error, not a silent wrap into the exponent.

`WATX_FLOAT_LITERAL_RE` gained `[+-]` on the decimal exponent; that is the only
validator change.

**Imported globals.** `(import "m" "g" (global $g i32))` parsed and then failed
at EMIT with *"Unknown global '$g'"* — there was no global index space to put it
in. Imported globals now occupy the FRONT of that space, mirroring
`funcIndexMap`, with a `globalSpace` array over both halves so the bound check
and the mutability check are asked of the INDEX rather than of whichever array
the call site remembered. `(mut i32)` imports work; `global.set` on an immutable
import is refused here with a line instead of by the engine with a byte offset.
This was an `expectDivergence` witness in the differential corpus, now a
positive test.

**Canonical bytes did not move.** No `src/*.wat` uses any of these spellings (the
only `inf`/`nan` occurrences in the tree are in comments) and there are no global
imports, so the offset added to the defined globals is zero. Verified by
building at `421aa080` in a clean detached worktree and again with only these two
files copied in: `build/wine-assembly.wasm` is
`aa65465edc9a4e95c06dadb9c3bc1fb893925cc78e01d4406ad9a6370ebf8bd1` both times.

Evidence:

- `test/watx-compiler-literals.test.js` 102 -> 132 checks. Section 3 asserted
  these six literals as REFUSALS; the assertions flipped to value and BIT checks
  rather than being deleted. The bits are read back through an
  `i32.reinterpret_f32` / `i64.reinterpret_f64` inside the module, because a
  returned NaN is worthless as evidence — a JS NaN has no observable payload,
  so a probe that returned one would pass on the wrong constant.
- `tools/watx-differential.js`: two new modules, `float-literal-bits` (28 f32 +
  24 f64 spellings stored to memory) and `float-literal-positions` (global
  initializers and SIMD lanes). Both come back **byte-identical to wabt**, which
  settles the payload and the hex-float rounding against wat2wasm rather than
  against our own arithmetic. 43/43 modules, one known divergence left
  (multivalue) where there were two.
- `tools/watx-spec-suite.js`: the float files are in the default set now.
  **1048/1048 across 15 files -> 12668/12668 across 24 files**, 0 fail. f32.wast
  and f64.wast alone are 5000 assertions that used to be uncheckable. What is
  still skipped there is not an encoder gap: a wasm float becomes a JS number on
  the way out and a JS NaN has no payload, so `nan:canonical`, `nan:arithmetic`
  and `nan:0x20304` are all checked as "the result is a NaN".

Manifest digest: `8033b7d1ed16150b1d488ddeeec81e8fdf116e3657386c9e3e8729130330815a`

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

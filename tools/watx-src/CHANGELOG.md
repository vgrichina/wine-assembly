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

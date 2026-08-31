# WATX migration — Milestone 2 syntax/opcode gap census

Corpus-driven gap list for
[docs/watx-migration-plan.md](watx-migration-plan.md) §2.3. Every entry below was
produced by running the vendored WATX compiler over Wine-Assembly's **entire**
`WAT_FILES` include closure, classifying whatever it rejected, neutralizing that
class in an in-memory copy, and continuing.

No `src/*.wat` file was edited. The census works on a scratch concatenation only.

## Run identity

| | |
|---|---|
| Wine-Assembly commit | `de455967` (`docs/`, `src/`, `lib/` as of 2026-08-31); census re-verified unchanged at `35a405fb` |
| WATX compiler | vendored at `tools/watx-src/`, landed in `903ca110` |
| WATX upstream | `../android-emu` base `590238be` **plus the uncommitted standard-`br_table` working-tree patch** (see `tools/watx-src/PROVENANCE.md`) |
| Compiler file hashes (SHA-256) | `watx.js` `cc9dfe29…`, `compiler-codegen.js` `1143239e…`, `compiler-parser.js` `1b93cca7…`, `compiler-stages.js` `f66cef4b…`, `compiler.js` `40f9bc10…` |
| Node | v23.10.0 |
| Compile options | `standardWat: true`, `runtimeBuiltins: false`, `strictDeclarations: true`, `strictReferences: true`, `tailCalls: true` / `false` |
| Closure | 61 parts in `WAT_FILES` order, `(module` opener and final `)` stripped in memory (plan §2.2) |

## How far compilation got

**All the way.** After the ten neutralizations below, the complete closure
compiles and the emitted module **validates in both modes**:

| mode | result | bytes | imports | user funcs |
|---|---|---|---|---|
| tail-call (`tailCalls: true`) | `WebAssembly.Module()` accepts it | 984,239 | 220 | 8,144 |
| compatibility (`tailCalls: false`) | `WebAssembly.Module()` accepts it | 984,688 | 220 | 8,144 |

Warnings collected: **0** in both modes. No form was silently ignored: every
divergence surfaced either as a hard compile error or as a `WebAssembly.Module()`
validation failure, never as a warning.

Against the Milestone 2 exit gate — *"WATX emits validating tail and
compatibility modules from the entire current source closure with zero ignored
forms and zero warnings downgraded from hard errors"*:

- **Met, conditionally.** Both modules validate and there are zero warnings.
- **The condition is the neutralization list.** Ten classes had to be rewritten
  in the scratch copy to get there. Closing them for real — in the compiler for
  the seven standard-WAT classes, in `src/` for the three source classes — *is*
  the Milestone 2 work list, and it is short.
- Not yet demonstrated (Milestone 3's job, not this census): decoded-ABI
  equality against the legacy artifact, and execution.

Two things the census did **not** have to work around, both worth recording:

- **The `10d-gdi-region-path.wat` surplus `)` is gone.** Fixed at `1166907c`.
  With the module wrapper stripped, the closure now parses exactly balanced with
  no in-memory repair. Plan finding 1 is closed.
- **Neither generated file contributed a single gap.**
  `01b-api-hashes.generated.wat` and `09b2-dispatch-table.generated.wat` compiled
  clean on the first pass, including the standard folded `br_table` the plan
  called out. No generator change is needed.

## Gap classes, in the order the compiler hit them

Ordered by the sequence encountered. "Fix belongs in" follows the plan's stated
preference: *accept valid standard WAT unconditionally*.

| # | Class | Occurrences | Exemplar (file:line) | What the compiler said | Fix belongs in | Proposed WATX regression |
|---|---|---|---|---|---|---|
| G1 | **Atomic memory ops absent entirely** — `i32.atomic.load/store/rmw.*`. The string `atomic` appears **zero** times in `compiler-codegen.js`; the threads proposal is unimplemented. | 144 (`load` 73, `store` 43, `rmw.cmpxchg` 14, `rmw.add` 7, `rmw.xchg` 5, `rmw.sub` 2) | `src/09a-handlers.wat:124` — `(i32.atomic.load (global.get $VIRTUAL_MAP_STATE))` | `EMIT: Unknown form head 'i32.atomic.load' in $g2w` | **WATX.** These are standard threads-proposal opcodes and Wine imports a `shared` memory; they cannot be rewritten away. Prefix `0xFE`, memarg with the natural alignment forced. | Compile a module with a `shared` memory that does `i32.atomic.load`/`store`/each `rmw` with and without `offset=`, instantiate it, and assert the observed cell values plus the pre-op return value of each `rmw`. |
| G2 | **SIMD ops missing from the opcode table** — saturating add/sub, `avgr_u`, `bitmask`, `extmul_*`, `dot_i16x8_s`, `f32x4.convert_i32x4_u`, `i32x4.trunc_sat_f32x4_u`. (The `_s` twins of the last two are missing too; they simply are not used yet.) | 20 | `src/06c-mmx.wat` — `(i8x16.add_sat_u …)`, `(i32x4.dot_i16x8_s …)` | `EMIT: Unknown form head 'i8x16.add_sat_s'` | **WATX.** All are standard fixed-width SIMD. This is table-entry work, not design work. | One module per shape, each computing a value whose saturation/rounding is observable (e.g. `i8x16.add_sat_u` of `0xF0`+`0x30` must be `0xFF`, not `0x20`), asserted from JS. |
| G3 | **SIMD memory immediates** — `v128.load` / `v128.store` accept no `offset=` / `align=`. The ops themselves exist. | 2 | `src/07b-loop-match.wat:2368` — `(v128.load offset=16 (local.get $src_wa))` | `EMIT: Unknown symbol 'offset=16' in function $th_mmx_mask_copy32` | **WATX.** Standard memarg parsing simply is not wired to the v128 memory ops. | Store a known 32-byte pattern, read it back with `(v128.load offset=16 …)` and assert the second half, so a dropped offset fails rather than passing by luck. |
| G4 | **Labeled `block` with an explicit `(result T)` signature.** `compiler-codegen.js:1836` forces a labeled block to `void` on purpose ("its br targets do not carry a result value") and never parses a `(result T)` clause on `block`/`loop`. | 1 | `src/09a-handlers.wat:2873` — `(block $c (result i32) … (br $c (i32.const 0x43)) …)` | `EMIT: Unknown form head 'result' in $module_file_name` | **WATX.** `(block $l (result T) …)` with value-carrying `br` is core WAT, and the comment shows the current behaviour is a deliberate simplification, not an oversight. `if` already handles `(result T)` (502 sites in the tree rely on it). | A labeled `(block $l (result i32) (br_if $l (i32.const 7) cond) (i32.const 9))` exercised on both paths, plus the `loop` twin. |
| G5 | **Detached `(else …)` — a real Wine source defect.** The `if` at `src/09e-win16-api.wat:1006` is closed one paren early on line 1028, so its `(else …)` ends up as the third child of the enclosing `(then …)`. The legacy compiler swallows it; WATX does not. | 1 | `src/09e-win16-api.wat:1028-1029` — `(br $owner_scan)))))` then `(else (local.set $mod (call $win16_h32 …)))` | `EMIT: Unknown form head 'else' in $win16_GetModuleFileName` | **Wine source.** One paren. Note this is a *behaviour* fix, not cosmetics: today the `(local.set $mod …)` almost certainly runs unconditionally instead of as the else arm. Land it standalone with legacy artifact hashes recorded either side, and re-check Win16 `GetModuleFileName` for DLL selectors (VBRUN100 path). | Not a compiler gap — WATX is already correct. Add instead the negative test: `(if c (then a)) (else b)` at statement level must be a hard error. |
| G6 | **SIMD lane immediates are in the wrong position.** Standard WAT puts the lane index first, right after the opcode: `(i32x4.replace_lane 3 VEC VAL)`. WATX reads `(op VEC LANE VAL)` (`compiler-codegen.js:1412-1434`). | 88 (all 88 sites in the tree are standard-form; zero use the WATX order) | `src/06c-mmx.wat:71` — `(i64x2.replace_lane 1 (i64x2.splat …) (call $xmm_hi_get …))` | Compiled "successfully", then `WebAssembly.Module(): function #869 failed: i64x2.replace_lane[0] expected type v128, found i32.const of type i32` | **WATX.** *This is the most dangerous class in the census*: `replace_lane` fails validation loudly, but `extract_lane` in standard form degrades **silently** — `immVal(expr[3])` on a missing token returns the default `0`, so every lane read becomes lane 0 and the module still validates. The compiler's own comment at `compiler-codegen.js:1385` records having been bitten by exactly this. Accept the lane immediate in either position. | For each `extract_lane` shape, build a vector with distinct lanes and assert `extract_lane 1` ≠ `extract_lane 0`, in standard operand order — a default-to-zero regression must fail. Repeat for `replace_lane`. |
| G7 | **`i8x16.shuffle` lane bytes are in the wrong position.** Same shape as G6: standard WAT is `(i8x16.shuffle l0…l15 a b)`, WATX wants `(i8x16.shuffle a b l0…l15)`. | 9 | `src/06c-mmx.wat:288` — `(i8x16.shuffle 0 16 1 17 2 18 3 19 0 0 0 0 0 0 0 0 …)` | `WebAssembly.Module(): function #879 failed: i8x16.shuffle[0] expected type v128, found i32.const of type i32` | **WATX.** Same one-line fix family as G6. | `punpcklbw`-style shuffle of two known vectors written lanes-first, asserting the interleaved result byte for byte. |
| G8 | **Bare `(drop)` as a stack statement.** WATX auto-drops the value of a non-final statement, so an explicit `(drop)` after a value-returning `(call …)` underflows. wat2wasm accepts the pair. | 1 | `src/09a8-handlers-directx.wat:4449` — `(call $host_gdi_set_dib_to_device …)` followed by `(drop)` | `WebAssembly.Module(): function #3497 failed: not enough arguments on the stack for drop (need 1, got 0)` | **Wine source** (preferred) — delete the redundant `(drop)`, since WATX's auto-drop already covers it and the line is dead in the legacy build too. Fixing it in WATX would require modelling a real operand stack across sibling statements, which is a much larger change for one site. | Negative test: a bare `(drop)` with nothing to drop must be a hard **compile**-time error naming the function, not a validation failure a hundred kilobytes later. |

### Two classes the plan expected that turned out to be non-gaps

| Expected class | Verdict |
|---|---|
| **Standard folded `br_table`** | Already closed by the vendored patch. `(br_table $a $b $default (local.get $i))` compiles, including in `09b2-dispatch-table.generated.wat`. |
| **Anonymous / inline exports** | **Not a gap.** 1,334 functions in the tree are written `(func (export "name") …)` with no `$name`. WATX accepts them and names them `$__anonymous_N`. Worth flagging for Milestone 3 rather than 2: those synthetic names feed the `Function index map`, so `tools/func-index.js` / `wasm-func-name.js` output will differ in *spelling* from the legacy build for 1,334 functions even when every index matches. Compare indices, not names. |
| **Numeric locals / folded operand ordering / named `call_indirect` types** | Not reached. Nothing in the closure uses a numeric local index, and every `call_indirect` in the tree already uses a named `(type $t)` the compiler resolves. |

## Neutralization list (= the Milestone 2 work list)

Applied to the scratch copy, in the order applied. Seven of the ten are
"teach WATX standard WAT"; three are one-line Wine source edits.

| # | Class | Where the real fix goes | Size of the real fix |
|---|---|---|---|
| N1 | Strip `(module` / final `)` | Wine source + `tools/concat-wat.js` | Already specified by plan §2.2 |
| N2 | *(retired)* `10d` surplus `)` | — | Already fixed at `1166907c` |
| N3 | `i32.atomic.*` → non-atomic ops + arity shims | WATX (G1) | New opcode family, `0xFE` prefix |
| N4 | Missing SIMD ops → nearest supported shape | WATX (G2) | ~20 table entries |
| N5 | Drop `offset=` on `v128.load`/`store` | WATX (G3) | Wire existing memarg parser |
| N6 | Labeled typed `block` → nested typed `if` | WATX (G4) | Parse `(result T)` on `block`/`loop` |
| N7 | Re-attach the detached `(else …)` | **Wine source** (G5) | One paren, behaviour-changing |
| N8 | Move 88 lane immediates to WATX position | WATX (G6) | Accept either position |
| N9 | Move 9 `i8x16.shuffle` lane lists | WATX (G7) | Accept either position |
| N10 | Delete the bare `(drop)` | **Wine source** (G8) | One line |

None of N3-N10 is semantics-preserving as written — they exist to reach the next
error, not to produce a runnable module. The 984 KB artifacts above prove the
*syntax and structure* of the closure is within reach of the compiler; they are
not a candidate build and were not executed.

## Reproducing

The driver, the neutralization list and the captured logs live in the census
scratchpad and are not checked in (they are throwaway by construction). To
rebuild: concatenate `WAT_FILES` from `lib/compile-wat.js` in order, strip the
`(module` opener from `01-header.wat` and the trailing `)` from
`13-exports.wat`, apply the table above, and call
`require('tools/watx.js').compile(src, new Map(), {standardWat: true,
runtimeBuiltins: false, strictDeclarations: true, strictReferences: true,
tailCalls: <bool>})`. Feed `result.wasmBinary` to `new WebAssembly.Module()` —
**compiling successfully is not the gate**; G6, G7 and G8 all reported success
and produced invalid wasm.

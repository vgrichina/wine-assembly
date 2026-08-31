# WATX migration plan

Status: active — phase 1 in progress (M0 and M1 complete)
Audited: 2026-08-25
Last updated: 2026-08-31
Audit baseline: Wine-Assembly `0876e5c0`; prepared WATX fork `../android-emu` at `590238be`

## Decision

Migrate Wine-Assembly to WATX, but do it as a dual-compiler cutover rather than
a source rewrite or a flag-day replacement.

The 2026-08-12 recommendation still applies in its main conclusion: WATX can
compile this project and gives us strict diagnostics, includes, layouts and
macros that the current compiler cannot safely provide. Several prerequisites
from that recommendation are already complete, though, and the prepared WATX
fork is not yet a drop-in compiler for the real Wine tree.

```text
                     CURRENT                         TARGET

  src/*.wat ──► lib/compile-wat.js       src/main.watx + included parts
      │                 │                            │
      │                 ├─► tail wasm                ├─► vendored WATX
      │                 └─► compat wasm              │      compiler
      │                                              ├─► tail wasm
      └─ browser source fallback                     └─► compat wasm

                         migration interval
                  ┌─────────────────────────┐
                  │ both compilers build    │
                  │ separate artifacts      │
                  │ ABI + behavior compared │
                  └─────────────────────────┘
```

Do not start by converting structures to layouts or introducing macros. First
make today's standard WAT compile through both compilers with equivalent
behavior. WATX syntax features come only after the WATX artifact is canonical.

The migration is two phases with a hard boundary:

- **Phase 1 — binary fidelity (milestones 0–5).** The existing source compiles
  through both compilers with equivalent behavior and matching decoded ABI,
  tables, globals and data. No WATX-only syntax appears in `src/` during this
  phase; the goal is that the WATX artifact is indistinguishable in behavior
  from the legacy one, then becomes canonical.
- **Phase 2 — maintainability (milestone 6).** Only after cutover, adopt WATX
  features to make the code safer to maintain — **memory-region safety first**:
  the fixed memory map becomes declared, compiler-checked structure instead of
  hand-synchronized hex constants. Layouts and macros follow where diagnostics
  show they pay.

There is only ever **one source tree**. Files are converted in place; no
parallel `.wat`/`.watx` copy of any source part is created or maintained at any
point, in either phase. The only thing duplicated during the migration interval
is built artifacts.

## What changed since the original sessions

| Original recommendation | Current status | Consequence |
|---|---|---|
| Ship prebuilt tail-call and compatibility artifacts | Done. `host.js` loads `build/wine-assembly.wasm` or `.compat.wasm` first and only compiles source on failure or `?compile-wat`. | Preserve this architecture; do not put compilation back on the normal launch path. |
| Add imported shared memory, general globals, data/table/element sections, exports, memargs and missing scalar operations to WATX | Done in the prepared `../android-emu` fork. Its Wine-parity test passes 22/22, and standard folded `br_table` support was added unconditionally on 2026-08-25. | Vendor the prepared fork, not the older `../watjs` compiler. |
| Add `tailCalls: false` lowering | Direct lowering is done and tested. Indirect lowering is implemented but lacks a focused parity regression. | Add that regression, then continue producing both existing artifact names from one source tree. |
| Make WATX build in a browser without a custom JS stack | Done for the Android corpus. Production streaming, a 128 KiB-stack test and a Chrome Worker test pass. | Browser compilation is feasible, but Wine still needs its own browser-memory gate. |
| Reduce compiler memory below 100 MB | Not done. The last 6.81 MB Android benchmark reached 178.36 MB maximum RSS; Wine's clean audited source is 10.23 MB. | Treat peak memory, especially iOS Safari, as an open cutover gate. Never allocate Wine's 512 MB shared memory until the compiler Worker has terminated. |
| Vendor WATX into Wine-Assembly | Done 2026-08-31 in commit `903ca110`: 11 files vendored from the `590238be` working tree with per-file SHA-256 in `PROVENANCE.md`, a `check-watx-provenance.js` build gate, and all six suites passing with `../android-emu` verified absent. | This repository owns its copy now. Milestone 1 exit gate met. |
| Compile the complete Wine source through WATX | Census complete 2026-08-31 (`4108c76c`): the closure compiles and validates in both modes after 8 gap classes are neutralized in scratch — see [watx-migration-gaps.md](watx-migration-gaps.md). The neutralizations are the milestone-2 work list; the emitted modules are proof of reach, not a candidate build. | Close the six WATX-side classes (atomics first, 144 sites) and the two Wine-source ones, then re-run unneutralized. |
| Adopt layouts and macros | Not started, correctly. | Defer until after the compiler cutover. |

The clean audited Wine tree contains 59 source parts, 10,227,829 bytes,
178,240 lines, 7,573 function forms, 1,832 globals, 214 data segments, 426
`return_call`s, 5,691 memory offsets, 101 SIMD operations and 18 `br_table`s.
These are audit-snapshot scale numbers, not invariants.

## Findings from compiling the real tree

The prepared WATX fork is substantially ready, but its focused parity suite is
not equivalent to compiling Wine-Assembly itself.

1. After removing the outer `(module ...)` wrapper in memory, strict parsing of
   clean Wine commit `0876e5c0` finds one surplus `)` in
   `src/10d-gdi-region-path.wat` at its line 2849. The legacy parser tolerates
   unmatched closing tokens; WATX correctly refuses them.

   Resolved at HEAD, and not by the neutral edit this plan prescribed: commit
   `1166907c` (2026-08-30, "Gate WAT structure and restore geometric joins")
   removed it as part of a real fix — the surplus closer had been terminating an
   `(if` early and orphaning a `(return)` in the round-join path, so removing it
   changed behavior. The fragment-balance gate below now proves the file clean.
2. With that token removed only in the audit's in-memory input, the original
   prepared compiler reached emission and rejected Wine's standard folded form:

   ```wat
   (br_table $a $b $default (local.get $index))
   ```

   It previously required:

   ```watx
   (br_table (labels $a $b) $default (local.get $index))
   ```

   Resolved on 2026-08-25: the `../android-emu` compiler now accepts both forms
   unconditionally and regression-tests byte-identical output. The same two-file
   patch is live on `watx.berrry.app` version 123. No Wine source or generator
   rewrite is needed for `br_table`.
3. The existing Wine compiler now hard-errors on unknown functions and globals,
   but it still maps an unknown local or label to index/depth zero and emits
   `unreachable` for an unknown opcode after only a warning. WATX hard-errors on
   these cases. This remains one of the migration's strongest correctness wins.
4. The compiler under `../watjs/tools/watx-src` is not the prepared version: its
   compiler history stops before the Wine-parity, browser-stack, compact-AST and
   two-pass work. The import source must be the `../android-emu` fork at
   `590238be`, plus the 2026-08-25 standard-`br_table` patch, or a descendant
   proven to pass the same suites.

These are the first blockers, not an exhaustive list. Milestone 2 must maintain
a corpus-driven gap list until the complete module validates in both modes.

## Non-negotiable invariants

The migration is accepted only if all of these remain true:

- Default browser launch remains artifact-first.
- A browser can still compile the source itself on demand; this must happen in
  a disposable Worker, never on the UI thread.
- The module imports exactly one `8192 8192 shared` memory from `host.memory`.
- Import and export names, kinds and function signatures remain identical.
- Table limits, element order and every threaded-handler slot remain identical.
- Data-segment offsets and bytes remain identical, including generated API hash
  data and hard-coded ordinal string offsets.
- Global declaration order and initial values remain identical during the
  compatibility cutover.
- Function declaration order remains stable during the cutover so profiler and
  trap tooling (`func-index.js`, `wasm-func-name.js`, `wasm-native.js`) does not
  silently name the wrong code. This is a tooling invariant, not a guest ABI,
  and may be relaxed later only with generated name metadata replacing it.
- `api_table.json` IDs remain append-only and generated dispatch/hash files stay
  fresh.
- Both tail-call and compatibility artifacts validate and execute.
- Fixed memory regions are not relocated by WATX. In particular, do not enable
  WATX's automatic static-region allocator or its three runtime builtins.
- No unknown function, global, local, label, opcode, include, export or element
  target can produce a successful build.

Exact `.wasm` byte equality is welcome but is not the acceptance criterion:
different valid compilers may deduplicate types or encode sections differently.
Compare decoded ABI, tables, globals, data and behavior. If byte equality is
claimed, prove it by hash for both variants.

## Milestone 0 — Freeze the experiment

- Perform migration work in a clean worktree pinned to a named Wine commit.
  Never use the live shared worktree as a parity baseline.
- Record the Wine commit, WATX source commit, Node/browser versions and compiler
  file hashes in every benchmark or differential report.
- Keep WATX artifacts separate:

  ```text
  build/legacy/wine-assembly.wasm
  build/legacy/wine-assembly.compat.wasm
  build/watx/wine-assembly.wasm
  build/watx/wine-assembly.compat.wasm
  ```

- Do not overwrite the canonical `build/wine-assembly*.wasm` yet.

Exit gate: one command builds the clean legacy baseline twice and produces the
same hashes both times.

**Met 2026-08-31** (commit `903ca110`): `tools/watx-baseline.sh` double-built a
clean worktree at Wine `c6a262e0` (node v23.10.0) into `build/legacy/` with
identical SHA-256 both runs (`f585a47d…` tail, `8cd6a8b1…` compat). Canonical
artifacts untouched.

## Milestone 1 — Vendor and pin the prepared compiler

Vendor these components from `../android-emu` commit `590238be`:

```text
tools/watx-src/compiler-parser.js
tools/watx-src/compiler-stages.js
tools/watx-src/compiler-codegen.js
tools/watx-src/compiler.js
tools/watx.js
```

Also bring over focused compiler tests for Wine parity, production mode, stack
safety, `br_table`, bulk memory and SIMD. Add:

- `tools/watx-src/PROVENANCE.md` with source repository, commit and SHA-256 for
  each imported compiler file;
- a freshness/provenance checker that fails if the recorded hashes drift
  without an updated note;
- a Wine-owned changelog for later compiler divergence.

After import, this repository owns its copy. Do not make Wine depend at build or
runtime on `../android-emu`, `../watjs` or a network service.

Compiler options for the compatibility build start as:

```js
{
  mode: 'production',
  runtimeBuiltins: false,
  tailCalls: true // false for the compatibility artifact
}
```

Do not pass `standardWat: true` for the `br_table` case. Valid standard WAT is
now accepted as base compiler behavior; the option must not be required for
Wine's existing folded `br_table` forms to compile.

Exit gate: all vendored compiler suites pass from this repository with no
sibling checkout present.

**Met 2026-08-31** (commit `903ca110`): wine-parity 22, production PASS,
emit-stack 5, br-table 14, bulk-memory 15, simd 37 — re-verified from a
location where `../android-emu` does not resolve. `PROVENANCE.md` pins per-file
SHA-256 (the `br_table` patch was uncommitted at vendor time, so the base
commit alone does not reproduce four of the files); `check-watx-provenance.js`
runs in the `tools/build.sh` gate section. One documented test adaptation:
the emit-stack suite's build-path check reads this repo's build scripts instead
of android-emu's `tools/build.js`.

## Milestone 2 — Make the current source strict and WATX-compilable

### 2.1 One source manifest

Create `src/main.watx` with the ordered includes now held in `WAT_FILES`. There
must be exactly one hand-maintained source order. A generated legacy list is
acceptable; two independently edited lists are not.

Update manifest checks so they cover `src/main.watx`, every `src/*.wat` part and
generated sources. Preserve filename order.

Done 2026-08-31 (`38ef42b4`): `src/main.watx` holds 60 real WATX
`(include "...")` forms — the form `resolveIncludes()` in the vendored compiler
actually implements — and is the authoritative order; `WAT_FILES` stays a
literal array but `tools/check-wat-manifest.js` now fails the build if the two
sequences (not sets) differ.

### 2.2 Independently balanced fragments

- ~~Remove the source-level module opener from `01-header.wat` and the matching
  final close from `13-exports.wat`.~~ Done 2026-08-31 (`b1c221d8`) with a
  four-hash identity proof in a clean worktree at `3a4332bc` — no
  `lib/compile-wat.js` change was needed; its `iterTopLevel()` already accepted
  bare top-level fields.
- ~~Make `tools/concat-wat.js` add the outer module wrapper when producing
  `build/combined.wat` for standard WAT/debug tools.~~ Done in the same commit;
  `build/combined.wat` is byte-identical modulo added comment lines.
- ~~Add a gate that parses every included fragment independently~~ Done
  2026-08-31 (`e5327df2`, promoted in `b1c221d8`): `tools/check-wat-fragments.js`
  is strict — the wrapper allow-list is deleted, all 60 fragments net zero, a
  mid-file negative-depth dip is rejected even when it nets to zero — and it
  runs in `tools/build.sh` right after the manifest check.
- ~~Fix the known `10d-gdi-region-path.wat` surplus close~~ Resolved by
  `1166907c` before this plan started executing (see finding 1 — it was a real
  bug fix, not a neutral cleanup).

The legacy compiler already accepts unwrapped top-level forms, so both compilers
can consume the same normalized fragments.

### 2.3 Close real syntax and opcode gaps

Run WATX against the whole include closure and fix one reported gap at a time.
For every gap:

1. Add a minimal compiler regression.
2. Prefer accepting valid standard WAT unconditionally; compatibility with the
   base language should not depend on `standardWat`.
3. If adopting native WATX syntax instead, update generators first and keep the
   source rewrite mechanical.
4. Re-run both WATX modes and the legacy build after every class of change.

Standard folded `br_table`, the first known item, was closed on 2026-08-25.

The full census ran 2026-08-31 against the vendored compiler snapshot and is
recorded in [watx-migration-gaps.md](watx-migration-gaps.md) (commit
`4108c76c`): eight gap classes, after which the entire closure compiles and
`WebAssembly.Module`-validates in both modes with zero warnings. Six classes
are WATX work (atomics — 144 sites, the largest by far; ~20 missing SIMD table
entries; `v128` memargs; labeled `block (result T)`; standard lane-immediate
position — where a missing lane immediate currently defaults **silently** to
lane 0 instead of erroring, though Wine's own standard-form sites all fail
validation loudly; `i8x16.shuffle` lane bytes) and two are Wine-source fixes
(a detached `(else)`
in `09e-win16-api.wat` that is a real latent behavior bug the legacy compiler
swallows, and one bare `(drop)`). Neither generated file needed any change.
The predicted numeric-locals / folded-ordering / inline-export gaps did not
materialize. The census scaffolding passed `standardWat: true` to reproduce;
that flag stays temporary census scaffolding and is not part of the migration
contract — base-language forms must compile without it, per 2.3's rule.

Exit gate: WATX emits validating tail and compatibility modules from the entire
current source closure with zero ignored forms and zero warnings downgraded from
hard errors.

**Exit gate met 2026-08-31** at compiler commit `aba5ff7f`: all eight census
classes closed (G1–G4, G6–G7 in `7ffa5af7`; G5 as the Wine-source else fix in
`65961f32`; G8 reassigned to WATX and closed in `aba5ff7f`), after which the
unmodified closure at HEAD compiles from `src/main.watx` in both modes —
984,312 B tail / 984,761 B compat — with zero warnings, and both validate.

## Milestone 3 — Differential compiler gate

Add a binary-section comparison tool and a four-artifact build command. Compare:

- imports: module/name/kind/type/limits/shared flag;
- exports: name/kind/type;
- type signatures;
- function declaration order and name-to-index map;
- globals: type, mutability, order and initializer;
- tables and element entries;
- memories;
- data-segment offsets, lengths and bytes;
- code/function counts; and
- absence of tail-call opcodes in both compatibility artifacts.

The comparator exists: `tools/wasm-abi-diff.js` (commits `35a405fb`,
`de455967`) implements this list with code-body bytes as diagnostic-only
(`--strict-code` restores them for same-compiler determinism),
`WebAssembly.validate()` on both inputs first, and `--require-no-tailcalls`
for compat artifacts. On the legacy pair it reports ABI MATCH with exactly the
422 lowered bodies as the only encoding difference. Known limitation, printed
as a warning: current artifacts carry no name section, so two same-signature
internal functions swapping is invisible to the acceptance set — backing the
function-order invariant with compiler-emitted name metadata (or a sidecar
index map) is open work. Related census hazard: 1,334 functions are written
`(func (export "x") ...)` with no `$name`, so WATX synthesizes names that
differ in spelling from the legacy build — compare indices, not names.

Then execute the same test layers against legacy and WATX artifacts:

1. compiler/unit and build gates;
2. quick suite;
3. CLI smoke apps covering Win32, Win16, threads, GDI, DirectDraw, Direct3D,
   OpenGL, audio, help and networking;
4. screenshot comparisons for representative deterministic apps;
5. full unit/e2e/smoke suites; and
6. browser launches using an explicit artifact selector.

Extend `test/run.js --wasm=... --no-build` usage into reusable matrix tooling so
tests never accidentally rebuild and test the wrong compiler's artifact.

The matrix tool exists: `tools/watx-matrix.js` (commit `4aeb0970`) builds all
four artifacts into `build/legacy/` and `build/watx/`, runs the ABI gate on
both pairs, and pins a nine-test behavior matrix to each artifact via
`WINE_ASSEMBLY_WASM` (which `test/run.js` now honors as an implicit
`--wasm= --no-build`). First full run 2026-08-31: **all nine behavioral tests
pass on both artifacts** (Win32, Win16, DirectDraw, threads and VFS coverage —
the WATX-built emulator runs real guests correctly), compat pairs carry zero
`return_call`, and the sole acceptance diff is export-section *order*: the
legacy emitter writes exports in declaration order (`memory` first, from
`01-header.wat`) while WATX groups by kind and emits the memory export last.
Same 1,431 entries either side. The export-order fix landed in `3fdae908`
(declaration-order emission, no special-casing, plus a real WATX bug found in
the audit: `parseI64Literal` silently returned 0 for negative hex `i64`
literals — the OLE compound-file magic among them — now a hard error path with
hand-peeled sign). **MATRIX GREEN** as of that commit: every acceptance
section matches in both modes, no `return_call` in either compat artifact,
9/9 curated tests pass on all four artifacts.

The body audit classified all eight diffs. Two were type-index renumbers
(equivalent by design), and six are **Wine-source defects**: a bare tail
expression sitting in the else slot of an else-less `if`, which the legacy
compiler silently discards and WATX compiles as the else arm. The dropped
code includes `$menu_group_set_disabled`'s MF_GRAYED store (the function is
a no-op in every shipped build), two `$heap_free` calls in `$tv_insert`, and
the d3dim greyscale texture fallback. G5's precedent applies: fix the source
so the intent is explicit and both compilers agree, measuring each behavior
change. A census found 12 bare-tail-in-`if` sites total; the 6 inside `if`s
that already have an `(else …)` compile identically under both compilers and
need no change.

Performance checks come after behavioral equality. On a quiet machine, compare
fixed-duration guest progress and retired operations, not batches per second.
Investigate any material code-size, startup or guest-throughput difference
before cutover.

Exit gate: both WATX artifacts pass the full required matrix and every decoded
ABI/data/table comparison, with any intentional difference documented.

## Milestone 4 — Browser source compilation

Keep the current artifact-first path. Replace only the source-compile branch:

```text
main thread
  └─ probe tail-call support
      └─ start compiler Worker
          ├─ fetch compiler + src/main.watx include closure
          ├─ compile only the supported variant
          ├─ validate and transfer bytes
          └─ terminate Worker
              └─ allocate 8192-page shared memory
                  └─ instantiate Wine
```

Requirements:

- Fetch each source exactly once per attempt so two passes cannot observe
  different revisions.
- Key any persistent cache by compiler hash, source-manifest hash and tail-call
  mode, not only `SOURCE_VERSION`.
- Preserve the current failed-promise reset so one transient update does not
  poison every later Launch.
- Keep a legacy compiler query switch during the migration for browser A/B.
- Measure cold compile time and peak process memory for Wine's 10.23 MB closure.
- Prove a source build in Chromium and Safari, including a real iOS device or
  simulator with the production memory allocation sequence.
- Do not accept "works on desktop Chrome" as proof that the old sub-100-MB
  mobile target is unnecessary. If Safari cannot complete reliably, further
  reduce WATX peak memory before cutover.

Exit gate: artifact-first launch and forced source compilation both pass in the
supported browsers; compiler memory is released before Wine memory allocation.

## Milestone 5 — Cut over and retain rollback

- Switch `tools/build.sh` to make WATX outputs canonical without changing their
  filenames or runtime selection.
- Keep the legacy compiler and differential command through at least one full
  release cycle.
- Update `CLAUDE.md`, build documentation and debugging tools to use the single
  WATX include manifest.
- Make function-index tools consume compiler-produced name metadata rather than
  assuming a textual count forever.
- Deploy the already-built artifacts; do not enable browser source compilation
  by default.

Rollback is one build flag selecting the still-present legacy artifacts. Source
must not fork, and rollback must not require reverting syntax or application
changes.

Exit gate: the deployed artifact is WATX-built, the full deployment smoke passes,
and rollback has been exercised once.

## Milestone 6 — Phase 2: adopt WATX features for maintainability

Only after cutover. The headline goal of phase 2 is **memory-region safety**:
today the fixed memory map is hand-synchronized hex constants spread across
`01-header.wat`, JS mirrors and check tools (`wat-memory-map.js`,
`check-shared-constants`), and nothing stops a WAT edit from silently reading
across a region boundary. The phase-2 endpoint is that every fixed region is
*declared* — base, size, owner — and the compiler enforces what the check
tools today only lint: overlap-freedom, in-bounds constant addressing, and
JS/WAT constant agreement generated from one declaration.

In order:

1. Design and add `region.declare-fixed` to the vendored compiler: validates a
   declared base and size **without relocating anything** — Wine's bases are an
   ABI shared with JavaScript, tests and guest-address translation. It needs
   its own overlap tests before first use. Do **not** use the existing
   `region.declare-static`: the prepared implementation allocates from address
   1024 and would move the map.
2. Convert the memory map one region at a time to declarations; generate the JS
   constant mirror from the same source so it cannot drift.
3. Introduce layouts for one fixed-memory structure at a time. Replace raw
   field offsets with `offset-of`, field loads/stores and typed array
   addressing while keeping the existing explicit base address. Good early
   candidates: WND records, control geometry, timers, DC state and DirectX
   object records — they repeat offsets across many files.
4. Run memory-map, focused subsystem and screenshot tests after each
   conversion.
5. Add small macros for repeated handler epilogues and address calculations
   only after diagnostics show useful expansion locations.

Conversions happen in place in the single source tree — no `.watx` twin files.

## Completion checklist

- [x] Prepared WATX compiler vendored with provenance. (`903ca110`)
- [x] Compiler regression suites run entirely inside this repository. (`903ca110`)
- [x] `src/main.watx` is the single source-order manifest. (`38ef42b4`)
- [x] Every source fragment parses independently. (`b1c221d8` — wrapper moved
      to `concat-wat.js`, gate strict and wired into the build.)
- [x] Full Wine source compiles in both WATX modes. (`aba5ff7f` — unmodified
      closure at HEAD, zero warnings, both modes validate)
- [x] Four-artifact ABI/data/table comparison is green. (`3fdae908` — MATRIX
      GREEN: exports/imports/types/functions/globals/tables/elements/memories/
      data all match both modes; 6 diagnostic body diffs remain, all Wine-source
      bare-tail-in-else-less-`if` defects the legacy compiler drops)
- [ ] Full behavior matrix is green for both WATX artifacts.
- [ ] Chromium and Safari forced-source builds are green.
- [ ] WATX memory high-water mark is acceptable on the target mobile device.
- [ ] Canonical build and deployment use WATX artifacts.
- [ ] Legacy rollback has been exercised.
- [ ] First layout migration lands separately after cutover.

## Audit verification

The prepared compiler was rechecked during this audit with:

```sh
node test/watx-compiler-wine-parity.test.js   # 22 passed
node test/watx-compiler-production.test.js    # PASS
node test/watx-compiler-emit-stack.test.js    # 5 passed
node test/watx-compiler-br-table.test.js      # 14 passed
node test/watx-compiler-bulk-memory.test.js   # 15 passed
node test/watx-compiler-simd.test.js          # 37 passed
```

Historical Codex sessions that produced the original analysis:

```text
019ff8e8-482b-71b2-a3de-fa55fe2c6d16  Wine adoption design
019ff8ec-edcc-7af2-9131-1444b3c560b7  WATX Wine-parity implementation
019ff93f-46a2-7ce0-9a1c-0f9ba665e734  browser/compiler-memory work
```

The durable benchmark source is
`../android-emu/docs/notes/watx-production-compiler-benchmark.md`.

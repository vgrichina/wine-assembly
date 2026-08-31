# WATX migration plan

Status: active plan, not yet started in this repository
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

## What changed since the original sessions

| Original recommendation | Current status | Consequence |
|---|---|---|
| Ship prebuilt tail-call and compatibility artifacts | Done. `host.js` loads `build/wine-assembly.wasm` or `.compat.wasm` first and only compiles source on failure or `?compile-wat`. | Preserve this architecture; do not put compilation back on the normal launch path. |
| Add imported shared memory, general globals, data/table/element sections, exports, memargs and missing scalar operations to WATX | Done in the prepared `../android-emu` fork. Its Wine-parity test passes 22/22, and standard folded `br_table` support was added unconditionally on 2026-08-25. | Vendor the prepared fork, not the older `../watjs` compiler. |
| Add `tailCalls: false` lowering | Direct lowering is done and tested. Indirect lowering is implemented but lacks a focused parity regression. | Add that regression, then continue producing both existing artifact names from one source tree. |
| Make WATX build in a browser without a custom JS stack | Done for the Android corpus. Production streaming, a 128 KiB-stack test and a Chrome Worker test pass. | Browser compilation is feasible, but Wine still needs its own browser-memory gate. |
| Reduce compiler memory below 100 MB | Not done. The last 6.81 MB Android benchmark reached 178.36 MB maximum RSS; Wine's clean audited source is 10.23 MB. | Treat peak memory, especially iOS Safari, as an open cutover gate. Never allocate Wine's 512 MB shared memory until the compiler Worker has terminated. |
| Vendor WATX into Wine-Assembly | Not done. | This is milestone 1. Record provenance and own the fork here afterward. |
| Compile the complete Wine source through WATX | Not done. | This is milestone 2. The first compiler syntax gap is fixed; source normalization still starts with the surplus close below. |
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

## Milestone 2 — Make the current source strict and WATX-compilable

### 2.1 One source manifest

Create `src/main.watx` with the ordered includes now held in `WAT_FILES`. There
must be exactly one hand-maintained source order. A generated legacy list is
acceptable; two independently edited lists are not.

Update manifest checks so they cover `src/main.watx`, every `src/*.wat` part and
generated sources. Preserve filename order.

### 2.2 Independently balanced fragments

- Remove the source-level module opener from `01-header.wat` and the matching
  final close from `13-exports.wat`.
- Make `tools/concat-wat.js` add the outer module wrapper when producing
  `build/combined.wat` for standard WAT/debug tools.
- Add a gate that parses every included fragment independently and rejects
  surplus or missing parentheses before either compiler runs.
- Fix the known `10d-gdi-region-path.wat` surplus close as an isolated,
  behavior-neutral change with legacy artifact hashes recorded before/after.

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
Expected later audit areas include numeric locals, folded operand ordering,
anonymous/inline exports, named `call_indirect` types, SIMD lane/memory
immediates and all generated code.

Exit gate: WATX emits validating tail and compatibility modules from the entire
current source closure with zero ignored forms and zero warnings downgraded from
hard errors.

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

## Milestone 6 — Adopt WATX features incrementally

Only after cutover:

1. Introduce layouts for one fixed-memory structure at a time.
2. Replace raw field offsets with `offset-of`, field loads/stores and typed array
   addressing while keeping the existing explicit base address.
3. Run memory-map, focused subsystem and screenshot tests after each conversion.
4. Add small macros for repeated handler epilogues and address calculations only
   after diagnostics show useful expansion locations.

Good early layout candidates are WND records, control geometry, timers, DC
state and DirectX object records because they repeat offsets across many files.

Do **not** use `region.declare-static` for the existing map: the prepared WATX
implementation allocates those regions from address 1024, whereas Wine's bases
are an ABI shared with JavaScript, tests and guest-address translation. A future
`region.declare-fixed` may validate a declared base without relocating it, but
it needs its own design and overlap tests before use.

## Completion checklist

- [ ] Prepared WATX compiler vendored with provenance.
- [ ] Compiler regression suites run entirely inside this repository.
- [ ] `src/main.watx` is the single source-order manifest.
- [ ] Every source fragment parses independently.
- [ ] Full Wine source compiles in both WATX modes.
- [ ] Four-artifact ABI/data/table comparison is green.
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

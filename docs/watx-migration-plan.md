# WATX migration plan

Status: **Phase 1 complete — WATX is the canonical compiler** (cutover
2026-08-31 at byte identity). Open rows: mobile-device memory gate (hardware),
production deploy (user sign-off), Phase 2 (M6).
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

Status 2026-08-31, after the audit wave: five of the six source defects are
fixed (`95e7263b` d3dim greyscale fallback + treeview leak/nops, `483f305a`
menu MF_GRAYED — all previously-dead code becoming live, +45 bytes across the
legacy artifacts, each measured; the menu fix also exposed and repaired a
test that had been silently red at HEAD). The codex round-4 findings are
closed: `155ff750` makes every numeric-literal position whole-token strict
(underscore separators now parsed per spec — they used to make `1_000`
compile to `1` — hex floats/`inf`/`nan` rejected loudly, const-form arity
checked, all proven byte-identical on the closure), and `f2f99acd` makes the
matrix require the legacy column green (`MATRIX RED — baseline failure` +
`--allow-baseline-fail=` excusals) so symmetric crashes can no longer fake a
pass. The positional-else shape now warns once per source site and will
become a hard error; the closure census shows exactly one site left —
`09a5-handlers-window.wat:216` in `$handle_CreateWindowExA`, peer-owned,
where the shipped build silently never applies a class-registered window's
style. Diagnostic body-diff residue: 2 of 8,142 (that site, plus the benign
`$next` type renumber). MATRIX GREEN throughout.

Status 2026-08-31, layers 4–6 (screenshots, broad sweep, browser). All three
ran against the four artifacts of one `node tools/watx-matrix.js --only=abi`
build (legacy tail `23a5d6ce` 984,311 B / WATX tail `d7c03355` 984,320 B),
pinned through `WINE_ASSEMBLY_WASM`, with nothing rebuilt in between.

*Layer 4 — screenshots.* Eight apps across subsystems, each run three times on
the same command line: legacy twice as the determinism control, then WATX.
`tools/png-diff.js` reports **0 of 307,200 pixels differing on every control
and every cross pair**, max channel delta 0 — notepad98, calc, sol (a full
deal, Game #17280), winmine, wep16_pipe (Win16/NE), dx_ddex3 (DirectDraw),
scr_win98 (screensaver) and dx_globe (d3dim, 15,000 batches). Every capture
was eyeballed for content first: a blank teal desktop diffs to zero just as
happily as a real frame, and calc and dx_globe both needed more batches
before `--png` had anything on it.

*Layer 5 — broad sweep.* 129 e2e tests (the pinnable pool minus the long
gameplay/installer titles) run once per column, 258 runs. Outcomes: **83 pass
on both, 45 fail on both, 1 diverged and re-ran red on both when run serially**
(`test-arena-dosbox`, whose last-window-title assertion is wall-clock gated —
both columns retire the identical 13,331 API calls in its 2,200 batches). Zero
WATX-only failures; every one of the 45 symmetric failures prints the same
number of `FAIL` lines on both columns. Those 45 are **not** a HEAD baseline:
rebuilt in a detached clean worktree at `fd1b0244`, 40 of the 45 pass, so they
belong to this shared worktree's uncommitted `src/*.wat` edits (the peer-owned
`09a5-handlers-window.wat` change already reported as regressing tests). Five
are red at clean HEAD too: `test-win16-dialog`, `test-notepad-typing-latency`,
`test-web-hearts-lan`, `test-win16-hearts-menus`, `test-win16-hearts-vlan`.

> **CORRECTION 2026-08-31** — the two sentences above are wrong and the next
> status block replaces them. That clean worktree had only the **45 tracked**
> files of `test/binaries`; the corpus is otherwise untracked, so 40 of its 45
> "passes" were `SKIP … not found` lines exiting 0. A `SKIP` is exit 0 and is
> indistinguishable from a pass to any exit-code sweep. **Provision a worktree's
> `test/binaries` before reading a single number out of it.**

Honest coverage note: `checkTestIsPinnable` in `tools/watx-matrix.js` still
requires a literal `--no-build`, but since `4aeb0970` `run.js` derives
`NO_BUILD` from `$WINE_ASSEMBLY_WASM` itself, so the 177 tests it rejects for
that reason **are** pinnable — measured, not assumed (a test with no
`--no-build` fails against a deliberately corrupt artifact). The genuinely
unpinnable sets are 42 e2e / 451 unit tests that never spawn `run.js` (they
compile WAT in process via `bootRenderHarness`) and 8 e2e that hard-code
`--wasm=`. Loosening that predicate would take the eligible e2e pool from 40
to 217.

*Layer 6 — browser.* No artifact selector exists in `host.js`
(`getWasmModule()` fetches `build/wine-assembly[.compat].wasm` or falls back to
source), and `host.js`/`index.html` are peer-dirty, so instead of editing them
or swapping the shipped artifact the run redirects `fetch` from
`--before-load` and reports the URL actually taken back through
`--report-eval`. Both columns launched notepad98 in headless Chrome and drew
the window: `["build/legacy/wine-assembly.wasm?v=250"]` and
`["build/watx/wine-assembly.wasm?v=250"]`, screenshots differing in 49 pixels
in one 6x10 box — the taskbar clock. Functional only; no timing was taken.

Two robustness findings, neither WATX's: `test/run.js` **silently falls back to
compiling from `src/`** when the pinned `--wasm=`/`$WINE_ASSEMBLY_WASM` path
does not exist (`if (NO_BUILD && fs.existsSync(WASM_PATH))`), so a typo in a
matrix path scores the working tree on both columns with nothing printed; and
it **exits 0 after a WASM `CompileError`**, so a corrupt artifact reads as a
pass to anything that only checks the exit code.

The behavior-matrix checklist row stays unticked: the differential result is
clean, but a run in which 45 of 129 tests are red for tree-state reasons is
not the "full behavior matrix is green" the gate asks for. Repeat this sweep
once the uncommitted `src/*.wat` work is committed and the five HEAD-red tests
are resolved or explicitly allow-listed.

Status 2026-08-31, the 45 re-run in a **provisioned** clean worktree. Detached
at `0d718678`, `node_modules` symlinked, and every untracked file of the main
checkout's `test/binaries` recursively symlinked in (10,295 links) plus the
root `binaries` alias and the one ignored `dist/` fixture — verified by
`test-notepad-menu` passing 12/12 there and by **zero `SKIP` lines in all 45
logs**, against 40 of 45 in the earlier unprovisioned attempt. Four artifacts
built there with `node tools/watx-matrix.js --only=abi`: **MATRIX GREEN**,
legacy tail `6f39a983` 983,981 B / WATX tail `1fbf3231` 983,990 B, compat
`387c3ccf` / `b21ca713`, 2 of 8,141 diagnostic body diffs (the `$next` type
renumber and the then-open positional-else site later closed by `957208b1`).

| | pass both | fail both | asymmetric |
|---|---|---|---|
| 45 previously-failing e2e tests, legacy vs WATX | 0 | **45** | **0** |

Symmetry was checked three ways, not one: identical exit code (42 × `1`, 3 ×
SIGKILL-at-240s — `test-vlan-match`, `test-vlan-tetrinet`,
`test-win16-hearts-vlan` on both columns), identical `FAIL`-line count per
test, and an identical first `AssertionError` message per test. **0 of 45
differ on any of the three.** So the differential answer is unchanged and
stronger than before: WATX introduces no behavioral difference on the hardest
45 tests in the pool.

What *did* change is the baseline reading. All 45 are red at clean HEAD with
the corpus present — not five. They are ordinary HEAD reds (`test-mspaint-
statusbar` wants `pos=0,327 size=263x23` and HEAD renders `pos=0,331
size=267x23`; `test-mspaint-tools` is 20/21 on one text-tool probe;
`test-win16-dialog` passes ten checks then trips "the dialog is gone from the
table"), i.e. app-behavior work belonging to whoever owns those areas, and
nothing to do with either compiler. The behavior-matrix checklist row therefore
**stays unticked**, now for an honest reason: the differential is clean
(83 pass-both + 45 fail-both + 0 asymmetric across the whole 129), but 45 red
tests are not a green matrix, and they are a Wine-side backlog, not a WATX one.

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

Status 2026-08-31, the **Safari** half (the Chromium half is
[`docs/watx-migration-plan-m4-measurements.md`](watx-migration-plan-m4-measurements.md)
§1 and §3). Real Safari 26.4 (WebKit 605.1.15) on this box compiled the whole
HEAD closure from source, in `lib/watx-compile-worker.js` running as a real
browser `Worker`, in **both dispatch modes**, from a clean detached worktree
served over loopback:

| mode | bytes | `WebAssembly.validate` | `new WebAssembly.Module` | compile | warnings |
|---|---|---|---|---|---|
| tail-call | 983,990 | ✅ | ✅ accepted | 566 ms | 0 |
| compatibility | 984,439 | ✅ | ✅ accepted | 540 ms | 0 |

Both byte counts are exactly what node built in the same worktree, so Safari is
running the same build and not a different one. 60 includes, 11.29 MB, fetched
in 149 ms. Compile time matches Chrome's (554/481 ms) and is ~3× faster than
node's ~1470 ms — the same unexplained-but-favourable direction already noted
for Chrome. **Validating is not the gate; instantiating is** — this probe also
hands each artifact to `new WebAssembly.Module`, because that is where an
engine that merely *parses* a feature would refuse it.

Two things worth keeping:

- **JavaScriptCore ships tail calls; its `jsc` shell does not enable them.**
  Running the same closure under
  `/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc`
  — the engine inside Safari 26.4 — the tail artifact validates false and
  `new WebAssembly.Module` says *"wasm tail calls are not enabled, in function
  at index 130"*, while Safari itself accepts it. The shell has no
  `--useWasmTailCalls` option to turn it back on. So the shell is a fine
  smoke-test for *compiling* the closure (it did, 577/483 ms, 223 MB max RSS)
  and is **not** admissible evidence about what Safari supports.
- **`safaridriver` is installed and answers `/status` `ready:true`, yet refuses
  to create a session** — *"You must enable 'Allow remote automation' in the
  Developer section of Safari Settings"*. Nothing here was enabled to work
  around it; the result above was taken without WebDriver, by serving the page
  and `open -a Safari <url>` with the page POSTing its own result back (the
  same talk-back shape `tools/ios-selftest-server.js` uses for the phone). If a
  scripted Safari run is ever wanted, the one-time manual step is
  `safaridriver --enable` (asks for an admin password) plus Safari → Settings →
  Advanced → *Show features for web developers*, then Develop → *Allow Remote
  Automation*.

Still open and untouched by this: **real iOS Safari on a device**, which is the
memory row, not this one, and which measurements §5 explains cannot be read
from this box at all.

**Wired into the page 2026-08-31.** `host.js`'s source-compile branch calls
`window.watxLauncher.compile` and hard-errors when the launcher is absent
(`a4210b60`); `index.html` loads `lib/watx-launcher.js` before `host.js`
(`fbb481f0`) and `lib/region-map.generated.js` before every lib script
(`9ae617cb` — `filesystem.js` reads the `RegionMap` global at
script-evaluation time, and the page had been missing that tag since the
wave-1 JS-mirror conversion). Headless-Chrome smoke of `?compile-wat`:
sol launches from the in-browser-compiled module, guest EIP sampled in its
message loop, 60 fps page, zero long tasks. The legacy query switch this
milestone asked to keep did not survive the M6 retirement — with
`lib/compile-wat.js` unable to compile the symbolized tree at all (§5.1),
there is nothing valid for a browser A/B switch to select, so none exists.

Exit gate: artifact-first launch and forced source compilation both pass in the
supported browsers; compiler memory is released before Wine memory allocation.

## Milestone 5 — Cut over and retain rollback

- Switch `tools/build.sh` to make WATX outputs canonical without changing their
  filenames or runtime selection.
- Keep the legacy compiler and differential command through at least one full
  release cycle. *(Superseded: the M6 symbolization retired the legacy compiler
  for full-tree builds ahead of that schedule — see §5.1's retirement banner.
  The differential command's `--skip-build` artifact-directory comparison
  remains valid.)*
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

### 5.1 The compiler selector

> **RETIRED 2026-08-31** — the M6 symbolization wave put region-symbolic
> spellings (bare `$REGION` operands, `(data (region.addr …))` segments) into
> the tree, which the legacy compiler compiles to `unreachable` traps rather
> than rejecting. `WINE_WAT_COMPILER=legacy` is now a hard error in
> `tools/build-compile-wat.js`, exactly as scheduled by
> docs/watx-region-safety-design.md §11. Rolling the compiler back now means
> reverting the symbolization commits, not setting an env var. The historical
> selector, as it worked between the cutover and the retirement:

`tools/build-compile-wat.js` — the one step `tools/build.sh` calls to produce the
two shipped artifacts — took the compiler as an input:

```sh
bash tools/build.sh                            # legacy (the default, then)
WINE_WAT_COMPILER=watx   bash tools/build.sh    # WATX, from src/main.watx
WINE_WAT_COMPILER=legacy bash tools/build.sh    # explicit rollback
node tools/build-compile-wat.js --compiler=watx # one-off, overrides the env
```

Four properties make this a rollback rather than a fork:

- **Same paths.** Both modes write `build/wine-assembly.wasm` and
  `build/wine-assembly.compat.wasm`. Nothing downstream — `test/run.js`,
  `host.js`, the deploy manifest — learns which compiler ran, so there is no
  second code path to keep alive and no artifact selection to get wrong.
- **Same gates.** Every gate in `build.sh` runs unchanged in either mode,
  including the ones that read the *compiled* module: `wasm-data.js --overlaps`
  inspects whichever artifact was just written.
- **Same `combined.wat`.** It is still written from `WAT_FILES` in both modes.
  It is the grep / `check-parens` / `func-index` surface and was never itself
  compiled, so the tooling that reads it is unaffected by the selector.
- **One closure, two consumers.** `tools/watx-closure.js` holds the
  `src/main.watx` include closure *and* the four compile options
  (`production`, `standardWat`, no runtime builtins, tail-call mode).
  `tools/watx-matrix.js` and the build both require it, so the bytes the
  Milestone 3 gate certifies are by construction the bytes the build ships —
  the two cannot drift into certifying one module and shipping another.

The selector rejects an unknown name, and rejects `--dispatch=replicated` under
WATX rather than silently ignoring it: replicated dispatch is a
`lib/compile-wat.js` source transform with no WATX implementation, so accepting
the flag would hand back a different module than the one requested.

**The default was `legacy` when this section was written.** The flip was a
one-line change to `DEFAULT_COMPILER` in `tools/build-compile-wat.js`,
deliberately kept that small so it was as easy to undo as to make. It was made
at byte identity on 2026-08-31 (see the checklist), and the retirement banner
above describes what became of the selector after that. The deploy still needs
explicit sign-off.

### 5.2 Rollback drill, exercised 2026-08-31

Run at `fd1b0244` in an isolated worktree. Every leg is a full
`bash tools/build.sh`, and each is followed by three curated tests from
`tools/watx-matrix.js`'s list, pinned to the canonical artifact with
`WINE_ASSEMBLY_WASM` so nothing rebuilds underneath the measurement.

| leg | command | `wine-assembly.wasm` | `.compat.wasm` |
|---|---|---|---|
| baseline (pre-change) | `bash tools/build.sh` | 983,981 B `6f39a983` | 984,430 B `387c3ccf` |
| 1. legacy (post-change, default) | `bash tools/build.sh` | 983,981 B `6f39a983` | 984,430 B `387c3ccf` |
| 2. watx | `WINE_WAT_COMPILER=watx bash tools/build.sh` | 983,990 B `1fbf3231` | 984,439 B `b21ca713` |
| 3. rollback | `WINE_WAT_COMPILER=legacy bash tools/build.sh` | 983,981 B `6f39a983` | 984,430 B `387c3ccf` |

Read the table as three claims:

- **The selector is inert when off.** Legs baseline and 1 are byte-identical, so
  adding the switch changed nothing about the shipped build.
- **The WATX artifacts are the certified ones.** Leg 2 matches `build/watx/`
  from a fresh `node tools/watx-matrix.js` run exactly — the same two hashes,
  which is the point of the shared closure module. The +9 bytes over legacy are
  the two known diagnostic body diffs (`09a5-handlers-window.wat:216`, and the
  benign `$next` type renumber); the WATX build prints that first one as a
  warning on every run, which is the intended behaviour until it becomes a hard
  error.
- **Rollback is exact, not approximate.** Leg 3 restores the baseline hashes
  from one env var, with no revert, no source change and no artifact surgery.

Smoke after each leg (`test-cli-vfs-include.js`, `test-tapi-line-init.js`,
`test-class-menu-from-dll.js`): 3/3 PASS on the WATX artifact and 3/3 PASS on the
rolled-back legacy artifact.

Gates at the same commit: `bash tools/build.sh` exit 0 in **both** modes;
`node tools/watx-matrix.js` MATRIX GREEN (four artifacts, both ABI pairs match,
9/9 curated tests pass in both columns, `build/watx` hashes unchanged by the
closure refactor); `node tools/watx-matrix.js --self` MATRIX GREEN;
`node test/test-watx-matrix.js` 43/0.

One gate is knowingly red at this commit for an unrelated reason and was worked
around only in the local validation loop, never in the committed change:
`tools/check-test-manifest.sh` names six `test/run-all.sh` rows whose files are
untracked in the shared checkout (`test-abedemo-gameplay.js`,
`test-aoe2-gameplay.js`, `test-browser-critical-section-yield.js`,
`test-directdraw-enum-lowres.js`, `test-keyboard-hook.js`,
`test-mem-utils-hidden-shared-buffer.js`). They exist in the main worktree and
were symlinked in so the remaining gates could run; the rows are somebody else's
to commit.

**Not done, deliberately:** the deploy. `tools/deploy-berrry.js` was not run and
not modified. Shipping a WATX-built artifact to the live app is the step that
needs explicit sign-off, and it is what closes the Milestone 5 exit gate.

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

   **DONE, and then some (waves 1-3, 2026-08-31).** All 175 regions are
   declared in `src/00-regions.wat`, the JS mirror is generated
   (`lib/region-map.generated.js`), and step 1's "without relocating anything"
   no longer applies: **167 of them are allocated by the compiler**. Only seven
   are pinned, because only seven addresses are an ABI — `$GUEST_BASE` and the
   three guest-VA-derived regions, plus the three backing windows. Everything
   else moves when anything earlier changes size, which is why nothing may hold
   a copy: read a base from `lib/region-map.generated.js` (JS) or
   `tools/wat-globals.js` (tools), never retype one.

   The evidence that this is safe is behavioral, not byte identity: the map is
   permuted under three shake modes and a real app draws the identical picture
   (`tools/region-shake-smoke.js`). See docs/watx-region-safety-design.md §8.1
   and §13.
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
      GREEN; then `957208b1` + `813ff531` removed the last body diffs: the two
      compilers now emit **byte-identical modules in both modes** — tail
      984,347 B `01daf6cc…`, compat 984,796 B `0ee64146…`, `cmp` clean)
- [x] Full behavior matrix is green for both WATX artifacts. (Satisfied by
      byte identity — identical bytes cannot diverge behaviorally; the user
      confirmed behavioral comparison is redundant for identical wasms. The
      differential evidence gathered before identity stands on its own: 129
      e2e tests with zero asymmetric rows, eight apps pixel-identical, browser
      launches green on both. The 45 symmetric HEAD reds are a Wine-side app
      backlog, present under either compiler, tracked outside this plan.)
- [x] Chromium and Safari forced-source builds are green. (headless Chrome 151
      in `docs/watx-migration-plan-m4-measurements.md` §1/§3; real Safari 26.4
      2026-08-31, both modes, in a browser Worker, validated *and* instantiated,
      byte-identical to the same worktree's node build — see the Milestone 4
      status block. Real iOS on a device is the memory row below, not this one.)
- [ ] WATX memory high-water mark is acceptable on the target mobile device.
- [x] Canonical build uses the WATX compiler. (Cutover 2026-08-31:
      `DEFAULT_COMPILER = 'watx'` in `tools/build-compile-wat.js`, flipped at
      byte identity so the flip changed which program runs, not which bytes
      ship. `bash tools/build.sh` green with every gate; smoke tests pass on
      the canonical artifact. **Deployment** of the WATX-built artifact to
      wine-assembly.berrry.app is byte-a-no-op but remains pending explicit
      user sign-off.)
- [x] Legacy rollback has been exercised. (Drill at `ff829446` §5.2 pre-flip
      with divergent bytes both ways; re-exercised at the flip:
      `WINE_WAT_COMPILER=legacy bash tools/build.sh` green, artifacts
      byte-identical to the WATX build. Rollback-by-flag was then retired at
      `24b79256` when the M6 symbolization made the tree uncompilable by the
      legacy compiler; rolling back now means reverting the symbolization
      commits, per docs/watx-region-safety-design.md §11.)
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

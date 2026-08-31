# WATX compiler — provenance

Milestone 1 of [docs/watx-migration-plan.md](../../docs/watx-migration-plan.md).

## Source

| | |
|---|---|
| Source repository | `/Users/vg/Documents/projects/phone/android-emu` (local checkout; no remote dependency) |
| Base commit | `590238be86d1f042d2ca1b1058bbb9ee4bc5120a` — *Stream WATX functions in two passes*, 2026-08-13 |
| Imported at | 2026-08-31 |
| Imported into | Wine-Assembly `c6a262e0ed5768917504814ac60e70ad2a3bfa95` |
| Node used for verification | v23.10.0 |

**The imported bytes are the WORKING TREE, not the commit.** At vendor time the
standard folded `br_table` patch the migration plan depends on
(§"Findings from compiling the real tree", item 2) was still **uncommitted** in
`../android-emu`. It touches four files:

```text
tools/watx-src/compiler-stages.js      +16 -6    (working tree, uncommitted)
tools/watx-src/compiler-codegen.js     +25 -14   (working tree, uncommitted)
test/watx-compiler-br-table.test.js    +29 -8    (working tree, uncommitted)
test/watx-compiler-production.test.js  +6  -3    (working tree, uncommitted)
```

So `git show 590238be:tools/watx-src/compiler-stages.js` does **not** reproduce
the hash recorded below for that file, and that is expected. Anyone re-deriving
provenance must diff against the sibling working tree, or against a later
android-emu commit that contains the same patch.

That patch is why the plan forbids passing `standardWat: true` for `br_table`:
`(br_table $a $b $default (local.get $i))` is accepted as base compiler
behavior, so no Wine source or generator rewrite is needed.

## What was imported

Compiler (`tools/watx.js` + `tools/watx-src/`), byte-identical to the source
working tree:

- `tools/watx.js` — Node loader: runs the four browser-global stage files in one
  `vm` context and re-exports `compile`, `tokenize`, `parseSexpr`, `parseSource`.
- `tools/watx-src/compiler-parser.js` — stage 1: tokenize, `parseSexpr`, `ParseError`.
- `tools/watx-src/compiler-stages.js` — stages 2-4: `resolveIncludes`, `expandMacros`, `checkTypes`.
- `tools/watx-src/compiler-codegen.js` — stages 5-6: `lowerIR`, `generateWasm`, `disassembleWasm`.
- `tools/watx-src/compiler.js` — pipeline glue: `compile()`, `formatSexpr()`, `formatLowered()`.

Focused compiler suites (`test/`), byte-identical except where noted:

- `test/watx-compiler-wine-parity.test.js` (22 checks)
- `test/watx-compiler-production.test.js` (PASS/FAIL, single verdict)
- `test/watx-compiler-emit-stack.test.js` (5 checks) — **adapted**, see below
- `test/watx-compiler-br-table.test.js` (14 checks)
- `test/watx-compiler-bulk-memory.test.js` (15 checks)
- `test/watx-compiler-simd.test.js` (37 checks)

### The one adaptation

`watx-compiler-emit-stack.test.js` asserts that no build entry point respawns
Node with a larger stack, because a browser cannot do that and the emitter must
work on the default stack. android-emu's entry point is `tools/build.js`, which
does not exist here. The Wine copy reads `tools/build.sh` and
`tools/watx-baseline.sh` instead. Same property, same two checks, Wine-owned
target. No compiler file was modified.

## Ownership

This repository now **owns** these files. Wine must not depend on
`../android-emu`, `../watjs` or `watx.berrry.app` at build or runtime — verified
by `grep`: the only occurrences of those names in the vendored files are
explanatory comments. Later divergence is recorded in
[CHANGELOG.md](CHANGELOG.md), not by re-syncing silently.

## Recorded hashes

`node tools/check-watx-provenance.js` fails if any file below no longer hashes
to its recorded value. When a change here is deliberate, update the hash **and**
add a CHANGELOG entry in the same commit.

```sha256
cc9dfe2962214e5da09162844e98d359b825009a8388bb7726edaed729b37ee2  tools/watx.js
1b93cca731ffc63803cdd6042115bbb66da1ff8cbe6fac86ae99fd8c12485aaa  tools/watx-src/compiler-parser.js
f66cef4b7f0456706196f046042692df1fd78e55f00196fd9346fde65a1f88b4  tools/watx-src/compiler-stages.js
1143239ec045b8c8482a0604036fca0e5a06c1a9412ee5f1cb4cba77b1a2e0d5  tools/watx-src/compiler-codegen.js
40f9bc10c5405f4930619bff535d4d435cb68a3e6bb762d32bc32058b99af453  tools/watx-src/compiler.js
293c1a233359bf142bf5badceb3399c92b79a653a86085681142b2037d80fce4  test/watx-compiler-wine-parity.test.js
aaea455c646e4db3e1b60c034b32bda842c06babd29d8de3b810d73181ecf2c8  test/watx-compiler-production.test.js
a62f1ab8fc157e97fa0ed2bb9ce321464a0b792c4d218e6bbd649c29b06c6519  test/watx-compiler-emit-stack.test.js
5dc16a25724f8a77179a45cc5113de820c35dfaf2b620d8a940ba6c1aca275f8  test/watx-compiler-br-table.test.js
afd4baa36b08662bbba4bc6c0ae6fa695165f9b8a2bfe2d4798d78bdfb3cadbe  test/watx-compiler-bulk-memory.test.js
12ae3c4940039d44b02205d8144a94b321b93ca394b9923396d4da3fdcd54ecc  test/watx-compiler-simd.test.js
```

Every hash above matches the android-emu working tree byte for byte except
`test/watx-compiler-emit-stack.test.js`, whose source hash is
`b8ef7d11e5bc7a133cd28f4ff2573b9515797e420daafb8871720aa872bd6deb`.

## Verified at import

```text
node test/watx-compiler-wine-parity.test.js   # 22 passed, 0 failed
node test/watx-compiler-production.test.js    # PASS
node test/watx-compiler-emit-stack.test.js    # 5 passed, 0 failed
node test/watx-compiler-br-table.test.js      # 14 passed, 0 failed
node test/watx-compiler-bulk-memory.test.js   # 15 passed, 0 failed
node test/watx-compiler-simd.test.js          # 37 passed, 0 failed
```

Re-run in a clean worktree under `/private/tmp` with no `../android-emu`
reachable from it — same six results — which is the milestone's exit gate:
the suites pass from this repository with no sibling checkout present.

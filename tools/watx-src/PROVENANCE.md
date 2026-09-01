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
add a CHANGELOG entry in the same commit — that pairing is enforced by the seal
at the bottom of this file, not left to whoever is editing.

```sha256
b8068704e35bb4e41db2dd17324d5c629ac753faa64416dbdd412a97e36c40ab  tools/watx.js
f7b02737864024e94bb59d191bc0169291db47731cc19d9cf52822c31ba8484a  tools/watx-src/compiler-parser.js
05b4dd8f55b909d466cb4097357935321ade9ee72cd53c45f69da1305044b12c  tools/watx-src/compiler-stages.js
8aaeb2ce94ca3ef693c33636087b6bf9190029d07919e3f07e27e4213f65db2b  tools/watx-src/compiler-codegen.js
b85a780ec3d53fa0a9a9b335839504f24c5ca7288a75885c2c0823b8bd9dd550  tools/watx-src/compiler.js
293c1a233359bf142bf5badceb3399c92b79a653a86085681142b2037d80fce4  test/watx-compiler-wine-parity.test.js
8f545280a756dcaff9762beb4cc45645a2205eb7a9a583d00297d97a6d15cd15  test/watx-compiler-production.test.js
a62f1ab8fc157e97fa0ed2bb9ce321464a0b792c4d218e6bbd649c29b06c6519  test/watx-compiler-emit-stack.test.js
5dc16a25724f8a77179a45cc5113de820c35dfaf2b620d8a940ba6c1aca275f8  test/watx-compiler-br-table.test.js
afd4baa36b08662bbba4bc6c0ae6fa695165f9b8a2bfe2d4798d78bdfb3cadbe  test/watx-compiler-bulk-memory.test.js
d3b11de0f87fdd1bdd839ea391aa551ab70d01fb917f6c696fa11559ff1fe805  test/watx-compiler-simd.test.js
8f3d40789b71d0b93892aa6117362ab5eb171101f794df680d95e34fe20a57e1  test/watx-compiler-atomics.test.js
044022190b5888f5c69f2c480a7501bbeb75de543a7b9ec0c1c34c9a7def6036  test/watx-compiler-simd-ops.test.js
29cf15495c2232e61c104e070054b26c8c63ac141fa29c3ce19c2cba014c8fea  test/watx-compiler-simd-memarg.test.js
0638376e02776a9bdcc0698113d88b97419f61d75671e28fe6e901b0400924f9  test/watx-compiler-block-result.test.js
5958957d1baeef1f1fd3fe7c1b5a9c67a5cb53a4665196a71d818d732298ed88  test/watx-compiler-lanes.test.js
59123677f802de8f7aeb41b81d7b9b9b5bc36f334d455e136b3c936cd3afebde  test/watx-compiler-explicit-drop.test.js
8eed348ed4515fc63c1fde3d3cfcd507a5996eade013ea565aab2ab5df7240e0  test/watx-compiler-export-order.test.js
a1b425dc42f4fd3458cf983710c00c028c11f99afab51bd9b5c90046df0ae15b  test/watx-compiler-i64-literal.test.js
1bf02a515c0b1d3dc50737f177868f505aaa2c0c02b9562fc3925b0adf7af609  test/watx-compiler-literals.test.js
4bcc836d2a63143457c4f8edb5678920bf204db13201d58580fbe64499aed21b  test/watx-compiler-type-index.test.js
3c3fe13c63933d12446b22aad6334fe62e57b21c9968336ef9db11d5848f7ccb  test/watx-compiler-regions.test.js
07596a8750d10d747487c59aae5ae57cf664f42cfb32de4e43143a4bf635dadc  test/watx-compiler-alloc.test.js
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

## The seal

A list of hashes catches an edit to a vendored file. It does not catch editing
a compiler file *and* its recorded hash together, which is the change most
worth explaining and the one that would otherwise leave no trace.

It also does not say what the list must *contain*. A shortened manifest can be
re-sealed as easily as a correct one, and the result — a file quietly no longer
watched — reads as green. So the required set of paths is hard-coded in
`REQUIRED_FILES` in `tools/check-watx-provenance.js`, and a normal verify fails
unless the manifest is exactly that set. Vendoring or dropping a file has to
edit that array in the same commit, which puts the coverage change in the diff
instead of inside a block of hex nobody reads line by line.

`manifest-sha256` is the digest of the `sha256` block above; the CHANGELOG entry
for each change must quote it verbatim, and `changelog-sha256` pins the
CHANGELOG bytes that did so. Every link is checked on a normal verify, so the
manifest cannot move without a changelog entry, and the changelog cannot move
without re-sealing. Both lines are rewritten together by
`node tools/check-watx-provenance.js --update`, which refuses to write until the
CHANGELOG already names the new digest.

```seal
manifest-sha256   780cd7466183a3cc7e5ba3520682233620c545efb8a4112dd70c21756ff09a57
changelog-sha256  e5ae365605b65e8e3e1a28a4f8d40b98a3f5c27e04ca9619109df47a99283d14
```

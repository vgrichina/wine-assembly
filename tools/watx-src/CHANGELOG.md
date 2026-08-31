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

// test/watx-matrix-fixture-side-sensitive.js
//
// A FIXTURE for test/test-watx-matrix.js, not a test of the emulator. It is the
// one thing the matrix's real curated tests cannot be: a test whose verdict
// DIFFERS between the two pinned artifacts.
//
// tools/watx-matrix.js runs each curated test twice, once per artifact, pinning
// it through $WINE_ASSEMBLY_WASM. Every real test either passes on both stub
// artifacts or fails on both, so a suite built only from those can exercise the
// symmetric cases and nothing else — and the asymmetric rows are precisely where
// the gate's rules live: a legacy-PASS/watx-FAIL row is a REGRESSION, and a
// legacy-FAIL/watx-PASS row is a DIVERGENCE that --allow-baseline-fail must not
// be able to excuse (that flag is for a test red on BOTH artifacts).
//
// So this fixture derives its exit code from WHICH artifact it was handed:
// failing when the pinned path lies under a directory named `fail-side`, passing
// otherwise. The suite points --a-dir and --b-dir at scratch directories named
// accordingly and gets either asymmetry on demand.
//
// It is deliberately named outside the `test-*.js` glob, like the
// watx-compiler-*.test.js suites, so test/run-all.sh's manifest check does not
// ask for a tier row for something that is not a test.
//
// checkTestIsPinnable() in the matrix greps a candidate for `run.js` and
// `--no-build` before accepting it; this file names both here, in the comment
// that explains why it does not spawn test/run.js at all — spawning a real guest
// would make the fixture slow and would reintroduce the both-columns-identical
// behaviour it exists to avoid.
'use strict';

const pinned = process.env.WINE_ASSEMBLY_WASM || '';
if (!pinned) {
  console.log('watx-matrix-fixture: FAIL — no $WINE_ASSEMBLY_WASM was pinned');
  process.exit(1);
}
const failSide = /(^|[\\/])fail-side([\\/]|$)/.test(require('path').dirname(pinned));
console.log(`watx-matrix-fixture: pinned=${pinned} verdict=${failSide ? 'FAIL' : 'PASS'}`);
process.exit(failSide ? 1 : 0);

// test/watx-compiler-i64-literal.test.js -- `(i64.const …)` literal parsing, including the
// one form that used to compile to a SILENT ZERO.
//
// `BigInt('-0x10')` throws: the BigInt constructor accepts a sign only on a decimal
// string. WATX's parseI64Literal wrapped the constructor in a try/catch that returned
// `0n`, so every negatively-signed HEX i64 literal in the tree became `i64.const 0` with
// no error, no warning and a module that still compiled and validated.
//
// It is in the tree. src/09a7b-ole.wat:3801 writes the OLE compound-file header magic:
//
//     (i64.store (local.get $base_wa) (i64.const -0x1EE54E5E1FEE3030))
//
// -0x1EE54E5E1FEE3030 is 0xE11AB1A1E011CFD0 two's-complement — the little-endian
// encoding of the D0 CF 11 E0 A1 B1 1A E1 signature every CFB reader checks for, and the
// same constant is compared against at :4075 when reading one back. Under the old
// behaviour `$ole_cfb_serialize` wrote eight zero bytes there, so a structured-storage
// file this emulator produced carried no signature at all. It was caught by the Milestone 3
// four-artifact differential (docs/watx-migration-plan.md §M3): the legacy compiler,
// which parses the literal with `parseInt`-style sign handling, emitted the real constant
// and WATX emitted 0, and those were 2 of the 8 differing code bodies.
//
// Since silence is what made this expensive, an unparseable literal is now a hard error
// rather than a plausible-looking zero — asserted below.
//
// Run: node test/watx-compiler-i64-literal.test.js
'use strict';
const path = require('path');
const { compile } = require(path.join(__dirname, '..', 'tools', 'watx.js'));

let pass = 0, fail = 0;
function ck(name, ok, got) {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${got === undefined ? '' : ` (${got})`}`); }
}
function build(src, options = {}) {
  return compile(src, new Map(), { runtimeBuiltins: false, standardWat: true, tailCalls: false, ...options });
}
// Compile one `(i64.const LIT)` and read the value back out of a running module, so the
// assertion is on emitted bytes rather than on a successful compile.
function valueOf(literal) {
  const r = build(`(memory 1 1)\n(func $m (export "m") (result i64) (i64.const ${literal}))`);
  if (!r.success) return { error: r.error };
  try {
    const X = new WebAssembly.Instance(new WebAssembly.Module(r.wasmBinary), {}).exports;
    return { value: X.m() };
  } catch (e) { return { error: e.message }; }
}

// --- The regression: a negatively-signed hex literal. ------------------------
{
  const got = valueOf('-0x1EE54E5E1FEE3030');
  ck('negative hex i64 literal compiles', !got.error, got.error);
  ck('...is NOT silently zero', got.value !== 0n, String(got.value));
  ck('...and is the OLE CFB magic 0xE11AB1A1E011CFD0',
    got.value === -0x1EE54E5E1FEE3030n, got.value === undefined ? got.error : got.value.toString(16));
  ck('...whose unsigned bit pattern is the D0CF11E0A1B11AE1 signature',
    (BigInt.asUintN(64, got.value ?? 0n)).toString(16) === 'e11ab1a1e011cfd0',
    got.value === undefined ? got.error : BigInt.asUintN(64, got.value).toString(16));
}

// --- The forms that already worked must keep working. ------------------------
const cases = [
  ['0', 0n],
  ['1', 1n],
  ['-1', -1n],
  ['0x10', 16n],
  ['-16', -16n],
  ['+0x20', 32n],
  ['-0x1', -1n],
  // Unsigned literals at or above 2^63 wrap to their signed two's-complement value, which
  // is what keeps the SLEB128 encoding at 10 bytes (the comment on parseI64Literal).
  ['0xFFF8000000000000', -0x0008000000000000n],
  ['0xFFFFFFFFFFFFFFFF', -1n],
  ['9223372036854775807', 9223372036854775807n],   // i64 max
  ['-9223372036854775808', -9223372036854775808n], // i64 min
  ['0x7FFFFFFFFFFFFFFF', 9223372036854775807n],
];
for (const [lit, want] of cases) {
  const got = valueOf(lit);
  ck(`i64.const ${lit} === ${want}`, got.value === want, got.error ?? String(got.value));
}

// Not asserted here: standard WAT's `_` digit separators. The WATX TOKENIZER splits
// `1_000_000` into `1` and `_000_000` before any literal parser sees it, so the gap is in
// tokenization, not in parseI64Literal — a separate fix with its own regression, and no
// source in this tree writes one. `lib/compile-wat.js` does not accept them either.

// --- Silence is the thing being removed: garbage must be an ERROR. -----------
for (const bad of ['0xZZ', 'not_a_number', '--5']) {
  const r = build(`(memory 1 1)\n(func $m (export "m") (result i64) (i64.const ${bad}))`);
  ck(`i64.const ${bad} is rejected, not silently 0`,
    r.success === false && /Invalid i64 literal/.test(String(r.error)), r.error);
}

// --- The same parser serves data-segment i64 constants; check that path too. --
{
  const roundTrip = build(`
(memory 1 1)
(func $store (export "store") (effects heap) (i64.store (i32.const 64) (i64.const -0x1EE54E5E1FEE3030)))
(func $load (export "load") (result i64) (effects heap) (i64.load (i32.const 64)))`);
  ck('i64.store of a negative hex literal compiles', roundTrip.success === true, roundTrip.error);
  if (roundTrip.success) {
    const X = new WebAssembly.Instance(new WebAssembly.Module(roundTrip.wasmBinary), {}).exports;
    X.store();
    ck('...round-trips through memory', X.load() === -0x1EE54E5E1FEE3030n, X.load().toString(16));
  }
}

console.log(`\nwatx-compiler-i64-literal: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

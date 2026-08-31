// test/watx-compiler-lanes.test.js -- WATX migration gaps G6 and G7: SIMD lane immediates
// and `i8x16.shuffle` lane bytes in the STANDARD (lane-first) operand position, plus a
// hard error where the compiler used to default a missing lane to 0.
//
// docs/watx-migration-gaps.md calls G6 "the most dangerous class in the census":
//   * Standard WAT is `(i32x4.replace_lane 3 VEC VAL)` / `(i64x2.extract_lane 1 VEC)`.
//     WATX read `(op VEC LANE ...)`. All 88 lane sites in Wine-Assembly are standard-form,
//     and they failed LOUDLY -- the lane constant landed where a v128 was expected.
//   * The silent hazard is the neighbouring shape: an `extract_lane` whose lane immediate
//     is missing or unreadable in the position WATX parsed still compiled and validated,
//     with `immVal()` quietly defaulting to 0, so EVERY lane read became lane 0. The
//     compiler's own comment at compiler-codegen.js:1385 records being bitten by exactly
//     that on 2026-08-12, when it was misdiagnosed as a broken `v128.load`.
//
// So this suite proves three separate things, and the third is the one that matters:
//   (1) the standard lane-first order works, for every extract_lane / replace_lane shape
//       and for i8x16.shuffle;
//   (2) the legacy WATX vec-first order still works, unchanged (accept either position);
//   (3) a MISSING or UNPARSEABLE lane immediate is a hard COMPILE error. Per the census's
//       prescribed regression, the positive cases below build a vector with DISTINCT lanes
//       and assert `extract_lane 1` != `extract_lane 0`, so a default-to-zero regression
//       fails loudly instead of returning a plausible number.
//
// Run: node test/watx-compiler-lanes.test.js
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

// The source vector at address 0 is written from JS with 16 DISTINCT bytes, so every lane
// of every shape has a different value and no two lanes can be confused.
const r = build(`

;; ── (1) STANDARD lane-first extract_lane, one export per lane index we assert ──
(func $x_i8_s (param $lane i32) (result i32) (effects heap)
  (if i32 (i32.eqz (local.get $lane))
    (then (i8x16.extract_lane_s 0 (v128.load (i32.const 0))))
    (else (i8x16.extract_lane_s 1 (v128.load (i32.const 0))))))
(wasm-export "x_i8_s" $x_i8_s)
(func $x_i8_u (param $lane i32) (result i32) (effects heap)
  (if i32 (i32.eqz (local.get $lane))
    (then (i8x16.extract_lane_u 0 (v128.load (i32.const 0))))
    (else (i8x16.extract_lane_u 15 (v128.load (i32.const 0))))))
(wasm-export "x_i8_u" $x_i8_u)
(func $x_i16_s (param $lane i32) (result i32) (effects heap)
  (if i32 (i32.eqz (local.get $lane))
    (then (i16x8.extract_lane_s 0 (v128.load (i32.const 0))))
    (else (i16x8.extract_lane_s 1 (v128.load (i32.const 0))))))
(wasm-export "x_i16_s" $x_i16_s)
(func $x_i16_u (param $lane i32) (result i32) (effects heap)
  (if i32 (i32.eqz (local.get $lane))
    (then (i16x8.extract_lane_u 0 (v128.load (i32.const 0))))
    (else (i16x8.extract_lane_u 7 (v128.load (i32.const 0))))))
(wasm-export "x_i16_u" $x_i16_u)
(func $x_i32 (param $lane i32) (result i32) (effects heap)
  (if i32 (i32.eqz (local.get $lane))
    (then (i32x4.extract_lane 0 (v128.load (i32.const 0))))
    (else (i32x4.extract_lane 1 (v128.load (i32.const 0))))))
(wasm-export "x_i32" $x_i32)
(func $x_i64 (param $lane i32) (result i64) (effects heap)
  (if i64 (i32.eqz (local.get $lane))
    (then (i64x2.extract_lane 0 (v128.load (i32.const 0))))
    (else (i64x2.extract_lane 1 (v128.load (i32.const 0))))))
(wasm-export "x_i64" $x_i64)
(func $x_f32 (param $lane i32) (result f32) (effects heap)
  (if f32 (i32.eqz (local.get $lane))
    (then (f32x4.extract_lane 0 (v128.load (i32.const 0))))
    (else (f32x4.extract_lane 3 (v128.load (i32.const 0))))))
(wasm-export "x_f32" $x_f32)
(func $x_f64 (param $lane i32) (result f64) (effects heap)
  (if f64 (i32.eqz (local.get $lane))
    (then (f64x2.extract_lane 0 (v128.load (i32.const 0))))
    (else (f64x2.extract_lane 1 (v128.load (i32.const 0))))))
(wasm-export "x_f64" $x_f64)

;; ── (2) LEGACY WATX vec-first order must keep working ──
(func $legacy_i32 (result i32) (effects heap)
  (i32x4.extract_lane (v128.load (i32.const 0)) 2))
(wasm-export "legacy_i32" $legacy_i32)
(func $legacy_i32_const (result i32) (effects heap)
  (i32x4.extract_lane (v128.load (i32.const 0)) (i32.const 3)))
(wasm-export "legacy_i32_const" $legacy_i32_const)

;; ── STANDARD lane-first replace_lane, every shape. Result written to 32. ──
(func $r_i8 (effects heap)
  (v128.store (i32.const 32) (i8x16.replace_lane 5 (v128.load (i32.const 0)) (i32.const 0xEE))))
(wasm-export "r_i8" $r_i8)
(func $r_i16 (effects heap)
  (v128.store (i32.const 32) (i16x8.replace_lane 3 (v128.load (i32.const 0)) (i32.const 0xBEEF))))
(wasm-export "r_i16" $r_i16)
(func $r_i32 (effects heap)
  (v128.store (i32.const 32) (i32x4.replace_lane 2 (v128.load (i32.const 0)) (i32.const 0x11223344))))
(wasm-export "r_i32" $r_i32)
(func $r_i64 (effects heap)
  (v128.store (i32.const 32) (i64x2.replace_lane 1 (v128.load (i32.const 0)) (i64.const 0x0102030405060708))))
(wasm-export "r_i64" $r_i64)
(func $r_f32 (effects heap)
  (v128.store (i32.const 32) (f32x4.replace_lane 1 (v128.load (i32.const 0)) (f32.const 1.5))))
(wasm-export "r_f32" $r_f32)
(func $r_f64 (effects heap)
  (v128.store (i32.const 32) (f64x2.replace_lane 0 (v128.load (i32.const 0)) (f64.const 2.25))))
(wasm-export "r_f64" $r_f64)
;; legacy vec-first replace_lane
(func $r_legacy (effects heap)
  (v128.store (i32.const 32) (i32x4.replace_lane (v128.load (i32.const 0)) 2 (i32.const 0x11223344))))
(wasm-export "r_legacy" $r_legacy)

;; ── (G7) i8x16.shuffle: the punpcklbw interleave from src/06c-mmx.wat, lanes FIRST ──
(func $shuffle_std (effects heap)
  (v128.store (i32.const 32)
    (i8x16.shuffle 0 16 1 17 2 18 3 19 4 20 5 21 6 22 7 23
      (v128.load (i32.const 0)) (v128.load (i32.const 16)))))
(wasm-export "shuffle_std" $shuffle_std)
;; the legacy WATX vectors-first spelling of the SAME shuffle
(func $shuffle_legacy (effects heap)
  (v128.store (i32.const 32)
    (i8x16.shuffle (v128.load (i32.const 0)) (v128.load (i32.const 16))
      0 16 1 17 2 18 3 19 4 20 5 21 6 22 7 23)))
(wasm-export "shuffle_legacy" $shuffle_legacy)`);

ck('lanes: module compiles', r.success === true, r.error);
let X = null, mem = null;
if (r.success) {
  try {
    const inst = new WebAssembly.Instance(new WebAssembly.Module(r.wasmBinary), {});
    X = inst.exports; mem = new Uint8Array(inst.exports.memory.buffer);
    ck('lanes: module VALIDATES (a lane constant in an operand slot would fail here)', true);
  } catch (e) { ck('lanes: module VALIDATES (a lane constant in an operand slot would fail here)', false, e.message); }
}

if (X) {
  // 16 distinct bytes: 0x81, 0x02, 0x03 ... 0x90. Lane 0 of the byte shapes is negative so
  // the _s / _u extracts can be told apart, and no two bytes repeat.
  const srcBytes = [0x81, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
                    0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x90];
  for (let i = 0; i < 16; i++) mem[i] = srcBytes[i];
  for (let i = 0; i < 16; i++) mem[16 + i] = 0xA0 + i;
  const dv = new DataView(mem.buffer);

  // ── (1) extract_lane, standard order. Each pair asserts lane1 != lane0 (the census's
  //        prescribed shape for catching a default-to-zero regression).
  ck('i8x16.extract_lane_s 0 sign-extends (0x81 -> -127)', X.x_i8_s(0) === -127, X.x_i8_s(0));
  ck('i8x16.extract_lane_s 1 reads lane 1, NOT lane 0',
     X.x_i8_s(1) === 0x02 && X.x_i8_s(1) !== X.x_i8_s(0), X.x_i8_s(1));
  ck('i8x16.extract_lane_u 0 zero-extends (0x81 -> 129)', X.x_i8_u(0) === 129, X.x_i8_u(0));
  ck('i8x16.extract_lane_u 15 reads the LAST lane, NOT lane 0',
     X.x_i8_u(1) === 0x90 && X.x_i8_u(1) !== X.x_i8_u(0), X.x_i8_u(1));

  ck('i16x8.extract_lane_s 0 sign-extends lane 0', X.x_i16_s(0) === dv.getInt16(0, true), X.x_i16_s(0));
  ck('i16x8.extract_lane_s 1 reads lane 1, NOT lane 0',
     X.x_i16_s(1) === dv.getInt16(2, true) && X.x_i16_s(1) !== X.x_i16_s(0), X.x_i16_s(1));
  ck('i16x8.extract_lane_u 0 zero-extends lane 0', X.x_i16_u(0) === dv.getUint16(0, true), X.x_i16_u(0));
  ck('i16x8.extract_lane_u 7 reads the LAST lane, NOT lane 0',
     X.x_i16_u(1) === dv.getUint16(14, true) && X.x_i16_u(1) !== X.x_i16_u(0), X.x_i16_u(1));

  ck('i32x4.extract_lane 0', X.x_i32(0) === dv.getInt32(0, true), X.x_i32(0));
  ck('i32x4.extract_lane 1 reads lane 1, NOT lane 0',
     X.x_i32(1) === dv.getInt32(4, true) && X.x_i32(1) !== X.x_i32(0), X.x_i32(1));

  ck('i64x2.extract_lane 0', X.x_i64(0) === dv.getBigInt64(0, true), String(X.x_i64(0)));
  ck('i64x2.extract_lane 1 reads lane 1, NOT lane 0 (the exact 2026-08-12 bug)',
     X.x_i64(1) === dv.getBigInt64(8, true) && X.x_i64(1) !== X.x_i64(0), String(X.x_i64(1)));

  ck('f32x4.extract_lane 0', Object.is(X.x_f32(0), dv.getFloat32(0, true)), X.x_f32(0));
  ck('f32x4.extract_lane 3 reads lane 3, NOT lane 0',
     Object.is(X.x_f32(1), dv.getFloat32(12, true)) && X.x_f32(1) !== X.x_f32(0), X.x_f32(1));

  ck('f64x2.extract_lane 0', Object.is(X.x_f64(0), dv.getFloat64(0, true)), X.x_f64(0));
  ck('f64x2.extract_lane 1 reads lane 1, NOT lane 0',
     Object.is(X.x_f64(1), dv.getFloat64(8, true)) && X.x_f64(1) !== X.x_f64(0), X.x_f64(1));

  // ── (2) legacy WATX order, unchanged ──
  ck('legacy WATX order (vec, bare lane) still reads lane 2',
     X.legacy_i32() === dv.getInt32(8, true), X.legacy_i32());
  ck('legacy WATX order (vec, (i32.const N)) still reads lane 3',
     X.legacy_i32_const() === dv.getInt32(12, true), X.legacy_i32_const());

  // ── replace_lane, standard order ──
  const out = () => Array.from(mem.slice(32, 48));
  X.r_i8();
  ck('i8x16.replace_lane 5 replaces ONLY byte 5',
     out().every((v, i) => v === (i === 5 ? 0xEE : srcBytes[i])), out().join(','));
  X.r_i16();
  ck('i16x8.replace_lane 3 replaces ONLY the 16-bit lane at bytes 6..7',
     out().every((v, i) => v === (i === 6 ? 0xEF : i === 7 ? 0xBE : srcBytes[i])), out().join(','));
  X.r_i32();
  ck('i32x4.replace_lane 2 replaces ONLY the 32-bit lane at bytes 8..11',
     new DataView(mem.buffer).getInt32(40, true) === 0x11223344 &&
     out().every((v, i) => (i >= 8 && i <= 11) || v === srcBytes[i]), out().join(','));
  X.r_i64();
  ck('i64x2.replace_lane 1 replaces ONLY the high 64-bit lane',
     new DataView(mem.buffer).getBigInt64(40, true) === 0x0102030405060708n &&
     out().slice(0, 8).every((v, i) => v === srcBytes[i]), out().join(','));
  X.r_f32();
  ck('f32x4.replace_lane 1 replaces ONLY the second f32 lane',
     new DataView(mem.buffer).getFloat32(36, true) === 1.5 &&
     out().slice(0, 4).every((v, i) => v === srcBytes[i]), out().join(','));
  X.r_f64();
  ck('f64x2.replace_lane 0 replaces ONLY the low f64 lane',
     new DataView(mem.buffer).getFloat64(32, true) === 2.25 &&
     out().slice(8).every((v, i) => v === srcBytes[8 + i]), out().join(','));
  X.r_legacy();
  ck('legacy WATX replace_lane order (vec, lane, value) still works',
     new DataView(mem.buffer).getInt32(40, true) === 0x11223344, out().join(','));

  // ── (G7) shuffle, byte for byte ──
  const wantShuffle = [];
  for (let k = 0; k < 8; k++) { wantShuffle.push(srcBytes[k]); wantShuffle.push(0xA0 + k); }
  X.shuffle_std();
  ck('i8x16.shuffle with STANDARD lanes-first order interleaves byte for byte',
     out().join(',') === wantShuffle.join(','), out().join(','));
  X.shuffle_legacy();
  ck('i8x16.shuffle with the legacy vectors-first order gives the SAME result',
     out().join(',') === wantShuffle.join(','), out().join(','));
}

// ── (3) THE DANGEROUS CLASS: a missing or unparseable lane must be a HARD ERROR ──
// Before this fix each of these compiled AND validated, silently reading lane 0.
const negatives = [
  ['(i32x4.extract_lane (v128.load (i32.const 0)))', 'extract_lane with NO lane immediate'],
  ['(i32x4.extract_lane (v128.load (i32.const 0)) $notalane)', 'extract_lane with a symbol where the lane goes'],
  ['(i32x4.extract_lane (v128.load (i32.const 0)) (local.get $x))', 'extract_lane with a runtime value as the lane'],
  ['(i32x4.extract_lane 4 (v128.load (i32.const 0)))', 'extract_lane with a lane index past the shape (i32x4 has 4 lanes)'],
  ['(i8x16.extract_lane_u 16 (v128.load (i32.const 0)))', 'extract_lane with a lane index past the shape (i8x16 has 16)'],
  ['(i32x4.extract_lane -1 (v128.load (i32.const 0)))', 'extract_lane with a negative lane index'],
];
for (const [form, why] of negatives) {
  const bad = build(`
(func $a (param $x i32) (result i32) (effects heap) ${form})
(wasm-export "a" $a)`);
  ck(`HARD ERROR: ${why}`, bad.success === false, bad.error);
  if (!bad.success) ck(`  ...and the message names the lane immediate (${why})`, /lane/i.test(bad.error || ''), bad.error);
}

const badReplace = build(`
(func $a (effects heap)
  (v128.store (i32.const 32) (i32x4.replace_lane (v128.load (i32.const 0)) (i32.const 2))))
(wasm-export "a" $a)`);
ck('HARD ERROR: replace_lane missing its value operand', badReplace.success === false, badReplace.error);

for (const [form, why] of [
  ['(i8x16.shuffle 0 1 2 3 (v128.load (i32.const 0)) (v128.load (i32.const 16)))', 'shuffle with only 4 lane bytes'],
  ['(i8x16.shuffle 0 32 1 17 2 18 3 19 4 20 5 21 6 22 7 23 (v128.load (i32.const 0)) (v128.load (i32.const 16)))', 'shuffle with a lane byte of 32 (max is 31)'],
  ['(i8x16.shuffle (v128.load (i32.const 0)) (v128.load (i32.const 16)) 0 1 2)', 'legacy-order shuffle with only 3 lane bytes'],
]) {
  const bad = build(`
(func $a (effects heap) (v128.store (i32.const 32) ${form}))
(wasm-export "a" $a)`);
  ck(`HARD ERROR: ${why}`, bad.success === false, bad.error);
  if (!bad.success) ck(`  ...and the message names i8x16.shuffle (${why})`, /shuffle/i.test(bad.error || ''), bad.error);
}

console.log(`\nwatx-compiler-lanes: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

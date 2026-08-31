// test/watx-compiler-simd-ops.test.js -- WATX migration gap G2: fixed-width SIMD opcodes
// that were missing from the vendored compiler's tables (saturating add/sub, avgr_u,
// bitmask, extmul_*, extadd_pairwise_*, dot_i16x8_s, q15mulr_sat_s, the i64x2 comparisons,
// the i64x2 widening extends, the float rounding ops and the int<->float converts).
//
// docs/watx-migration-gaps.md G2 counted 20 rejected sites in src/06c-mmx.wat alone, and
// prescribes the regression shape used here: assert a value whose SATURATION, ROUNDING or
// SIGNEDNESS is observable, so an entry that names the wrong subopcode cannot pass by
// luck. Every case is run in a real instance against a hand-computed answer -- never
// against another SIMD op's output.
//
// The module is generated one function per shape (`vecop`/`scalarop` below) rather than
// one big dispatch: the inputs come from memory at 0 and 16, and vector results go to 32,
// so a wrong lane WIDTH shows up as wrong bytes, not as a coincidentally-equal scalar.
//
// Run: node test/watx-compiler-simd-ops.test.js
'use strict';
const path = require('path');
const { compile } = require(path.join(__dirname, '..', 'tools', 'watx.js'));

let pass = 0, fail = 0;
function ck(name, ok, got) {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${got === undefined ? '' : ` (${got})`}`); }
}

const A = '(v128.load (i32.const 0))';
const B = '(v128.load (i32.const 16))';
const parts = [];
// Binary ops: name -> writes (op A B) to 32.
const binary = [
  'i8x16.add_sat_u', 'i8x16.add_sat_s', 'i8x16.sub_sat_u', 'i8x16.sub_sat_s', 'i8x16.avgr_u',
  'i16x8.add_sat_u', 'i16x8.add_sat_s', 'i16x8.sub_sat_u', 'i16x8.sub_sat_s', 'i16x8.avgr_u',
  'i16x8.q15mulr_sat_s', 'i32x4.dot_i16x8_s',
  'i16x8.extmul_low_i8x16_u', 'i16x8.extmul_high_i8x16_u',
  'i16x8.extmul_low_i8x16_s', 'i16x8.extmul_high_i8x16_s',
  'i32x4.extmul_low_i16x8_s', 'i32x4.extmul_high_i16x8_s',
  'i32x4.extmul_low_i16x8_u', 'i32x4.extmul_high_i16x8_u',
  'i64x2.extmul_low_i32x4_u', 'i64x2.extmul_high_i32x4_u',
  'i64x2.extmul_low_i32x4_s', 'i64x2.extmul_high_i32x4_s',
  'i64x2.eq', 'i64x2.ne', 'i64x2.lt_s', 'i64x2.gt_s', 'i64x2.le_s', 'i64x2.ge_s',
];
// Unary ops: name -> writes (op A) to 32.
const unary = [
  'i16x8.extadd_pairwise_i8x16_u', 'i16x8.extadd_pairwise_i8x16_s',
  'i32x4.extadd_pairwise_i16x8_s', 'i32x4.extadd_pairwise_i16x8_u',
  'i64x2.extend_low_i32x4_u', 'i64x2.extend_high_i32x4_u',
  'i64x2.extend_low_i32x4_s', 'i64x2.extend_high_i32x4_s',
  'f32x4.convert_i32x4_u', 'f32x4.convert_i32x4_s',
  'i32x4.trunc_sat_f32x4_u', 'i32x4.trunc_sat_f32x4_s',
  'i32x4.trunc_sat_f64x2_s_zero', 'i32x4.trunc_sat_f64x2_u_zero',
  'f64x2.convert_low_i32x4_s', 'f64x2.convert_low_i32x4_u',
  'f32x4.ceil', 'f32x4.floor', 'f32x4.trunc', 'f32x4.nearest',
  'f64x2.ceil', 'f64x2.floor', 'f64x2.trunc', 'f64x2.nearest',
  'f32x4.demote_f64x2_zero', 'f64x2.promote_low_f32x4',
];
// Scalar-result ops: name -> returns i32.
const scalar = ['i8x16.bitmask', 'i16x8.bitmask', 'i32x4.bitmask', 'i64x2.bitmask'];

const nameOf = op => op.replace(/[.]/g, '_');
for (const op of binary) {
  parts.push(`(func $${nameOf(op)} (effects heap) (v128.store (i32.const 32) (${op} ${A} ${B})))`);
  parts.push(`(wasm-export "${nameOf(op)}" $${nameOf(op)})`);
}
for (const op of unary) {
  parts.push(`(func $${nameOf(op)} (effects heap) (v128.store (i32.const 32) (${op} ${A})))`);
  parts.push(`(wasm-export "${nameOf(op)}" $${nameOf(op)})`);
}
for (const op of scalar) {
  parts.push(`(func $${nameOf(op)} (result i32) (effects heap) (${op} ${A}))`);
  parts.push(`(wasm-export "${nameOf(op)}" $${nameOf(op)})`);
}

const r = compile(parts.join('\n'), new Map(),
  { runtimeBuiltins: false, standardWat: true, tailCalls: false });
ck('simd-ops: module compiles (every G2 opcode is in the table)', r.success === true, r.error);

let X = null, mem = null;
if (r.success) {
  try {
    const inst = new WebAssembly.Instance(new WebAssembly.Module(r.wasmBinary), {});
    X = inst.exports; mem = new Uint8Array(inst.exports.memory.buffer);
    ck('simd-ops: module instantiates', true);
  } catch (e) { ck('simd-ops: module instantiates', false, e.message); }
}

function put(off, bytes) { for (let i = 0; i < 16; i++) mem[off + i] = bytes[i] & 0xff; }
function out() { return Array.from(mem.slice(32, 48)); }
function rep(v) { return new Array(16).fill(v); }
function run(op, a, b) {
  put(0, a); if (b) put(16, b);
  mem.fill(0, 32, 48);
  X[nameOf(op)]();
  return out();
}
function i32out() { return Array.from(new Int32Array(mem.buffer.slice(32, 48))); }
function u32out() { return Array.from(new Uint32Array(mem.buffer.slice(32, 48))); }
function i64out() { return Array.from(new BigInt64Array(mem.buffer.slice(32, 48))); }
function f32out() { return Array.from(new Float32Array(mem.buffer.slice(32, 48))); }
function f64out() { return Array.from(new Float64Array(mem.buffer.slice(32, 48))); }
function same(got, want) { return got.join(',') === want.join(','); }

if (X) {
  // ── i8x16 saturating arithmetic + rounding average ──
  ck('i8x16.add_sat_u saturates 0xF0+0x30 to 0xFF (the unsaturated op gives 0x20)',
     same(run('i8x16.add_sat_u', rep(0xF0), rep(0x30)), rep(0xFF)), out().slice(0, 4));
  ck('i8x16.add_sat_s saturates 0x70+0x70 to 0x7F',
     same(run('i8x16.add_sat_s', rep(0x70), rep(0x70)), rep(0x7F)), out().slice(0, 4));
  ck('i8x16.sub_sat_u clamps 0x10-0x30 to 0x00',
     same(run('i8x16.sub_sat_u', rep(0x10), rep(0x30)), rep(0x00)), out().slice(0, 4));
  ck('i8x16.sub_sat_s clamps -128-127 to 0x80',
     same(run('i8x16.sub_sat_s', rep(0x80), rep(0x7F)), rep(0x80)), out().slice(0, 4));
  ck('i8x16.avgr_u ROUNDS UP: avgr(3,4) = 4, not 3',
     same(run('i8x16.avgr_u', rep(3), rep(4)), rep(4)), out().slice(0, 4));

  // ── i16x8 saturating arithmetic + rounding average ──
  ck('i16x8.add_sat_u saturates 0xFFFF+0xFFFF to 0xFFFF',
     same(run('i16x8.add_sat_u', rep(0xFF), rep(0xFF)), rep(0xFF)), out().slice(0, 4));
  const lanes16 = v => { const a = []; for (let i = 0; i < 8; i++) { a.push(v & 0xff, (v >> 8) & 0xff); } return a; };
  ck('i16x8.sub_sat_s clamps -32768-32767 to 0x8000',
     same(run('i16x8.sub_sat_s', lanes16(0x8000), lanes16(0x7FFF)), lanes16(0x8000)), out().slice(0, 4));
  ck('i16x8.add_sat_s saturates 0x7FFF+1 to 0x7FFF',
     same(run('i16x8.add_sat_s', lanes16(0x7FFF), lanes16(1)), lanes16(0x7FFF)), out().slice(0, 4));
  ck('i16x8.sub_sat_u clamps 1-2 to 0',
     same(run('i16x8.sub_sat_u', lanes16(1), lanes16(2)), lanes16(0)), out().slice(0, 4));
  ck('i16x8.avgr_u rounds up on 16-bit lanes',
     same(run('i16x8.avgr_u', lanes16(3), lanes16(4)), lanes16(4)), out().slice(0, 4));
  // q15mulr_sat_s: (a*b + 0x4000) >> 15, saturated. -1.0 * -1.0 in Q15 saturates to 0x7FFF.
  ck('i16x8.q15mulr_sat_s saturates the -1.0 * -1.0 case to 0x7FFF',
     same(run('i16x8.q15mulr_sat_s', lanes16(0x8000), lanes16(0x8000)), lanes16(0x7FFF)), out().slice(0, 4));

  // ── dot_i16x8_s: lane k = a[2k]*b[2k] + a[2k+1]*b[2k+1] ──
  run('i32x4.dot_i16x8_s',
      [2,0, 3,0, 4,0, 5,0, 6,0, 7,0, 8,0, 9,0],
      [10,0, 10,0, 10,0, 10,0, 10,0, 10,0, 10,0, 10,0]);
  ck('i32x4.dot_i16x8_s pairs and sums (2*10+3*10=50, 4*10+5*10=90, ...)',
     same(i32out(), [50, 90, 130, 170]), i32out().join(','));

  // ── extmul: low vs high half must read DIFFERENT source lanes ──
  const lowHigh = [1,1,1,1,1,1,1,1, 2,2,2,2,2,2,2,2];
  run('i16x8.extmul_low_i8x16_u', lowHigh, rep(3));
  ck('i16x8.extmul_low_i8x16_u reads the LOW 8 source lanes (1*3 = 3)',
     same(out(), [3,0, 3,0, 3,0, 3,0, 3,0, 3,0, 3,0, 3,0]), out().join(','));
  run('i16x8.extmul_high_i8x16_u', lowHigh, rep(3));
  ck('i16x8.extmul_high_i8x16_u reads the HIGH 8 source lanes (2*3 = 6)',
     same(out(), [6,0, 6,0, 6,0, 6,0, 6,0, 6,0, 6,0, 6,0]), out().join(','));
  run('i16x8.extmul_low_i8x16_s', rep(0xFF), rep(0xFF));   // -1 * -1 = 1
  ck('i16x8.extmul_low_i8x16_s sign-extends (-1 * -1 = 1)',
     same(out(), [1,0, 1,0, 1,0, 1,0, 1,0, 1,0, 1,0, 1,0]), out().join(','));
  run('i16x8.extmul_high_i8x16_u', rep(0xFF), rep(0xFF));  // 255 * 255 = 0xFE01
  ck('i16x8.extmul_high_i8x16_u zero-extends (255 * 255 = 0xFE01)',
     same(out(), lanes16(0xFE01)), out().join(','));

  run('i32x4.extmul_low_i16x8_s',
      [0xFE,0xFF, 0xFE,0xFF, 0xFE,0xFF, 0xFE,0xFF, 0,0, 0,0, 0,0, 0,0],
      [3,0, 3,0, 3,0, 3,0, 0,0, 0,0, 0,0, 0,0]);
  ck('i32x4.extmul_low_i16x8_s sign-extends (-2 * 3 = -6)',
     same(i32out(), [-6, -6, -6, -6]), i32out().join(','));
  run('i32x4.extmul_low_i16x8_u',
      [0xFE,0xFF, 0xFE,0xFF, 0xFE,0xFF, 0xFE,0xFF, 0,0, 0,0, 0,0, 0,0],
      [3,0, 3,0, 3,0, 3,0, 0,0, 0,0, 0,0, 0,0]);
  ck('i32x4.extmul_low_i16x8_u zero-extends the SAME bits (65534 * 3 = 196602)',
     same(u32out(), [196602, 196602, 196602, 196602]), u32out().join(','));
  run('i32x4.extmul_high_i16x8_s',
      [0,0, 0,0, 0,0, 0,0, 0xFE,0xFF, 0xFE,0xFF, 0xFE,0xFF, 0xFE,0xFF],
      [0,0, 0,0, 0,0, 0,0, 3,0, 3,0, 3,0, 3,0]);
  ck('i32x4.extmul_high_i16x8_s reads the high four lanes (-2 * 3 = -6)',
     same(i32out(), [-6, -6, -6, -6]), i32out().join(','));

  run('i64x2.extmul_low_i32x4_u',
      [0xFF,0xFF,0xFF,0xFF, 0,0,0,0, 0,0,0,0, 0,0,0,0],
      [2,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0]);
  ck('i64x2.extmul_low_i32x4_u treats lanes as unsigned (0xFFFFFFFF * 2 = 0x1FFFFFFFE)',
     i64out()[0] === 0x1FFFFFFFEn, String(i64out()[0]));
  run('i64x2.extmul_low_i32x4_s',
      [0xFF,0xFF,0xFF,0xFF, 0,0,0,0, 0,0,0,0, 0,0,0,0],
      [2,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0]);
  ck('i64x2.extmul_low_i32x4_s treats the SAME lanes as signed (-1 * 2 = -2)',
     i64out()[0] === -2n, String(i64out()[0]));
  run('i64x2.extmul_high_i32x4_u',
      [0,0,0,0, 0,0,0,0, 0xFF,0xFF,0xFF,0xFF, 0,0,0,0],
      [0,0,0,0, 0,0,0,0, 2,0,0,0, 0,0,0,0]);
  ck('i64x2.extmul_high_i32x4_u reads the high two lanes',
     i64out()[0] === 0x1FFFFFFFEn, String(i64out()[0]));

  // ── i64x2 comparisons (absent from the table entirely before G2) ──
  const T8 = [255,255,255,255,255,255,255,255], F8 = [0,0,0,0,0,0,0,0];
  const eqA = [7,0,0,0,0,0,0,0, 9,0,0,0,0,0,0,0];
  const eqB = [7,0,0,0,0,0,0,0, 1,0,0,0,0,0,0,0];
  ck('i64x2.eq sets an all-ones mask only in the equal lane',
     same(run('i64x2.eq', eqA, eqB), T8.concat(F8)), out().join(','));
  ck('i64x2.ne is the complement',
     same(run('i64x2.ne', eqA, eqB), F8.concat(T8)), out().join(','));
  const negOne = [0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF, 5,0,0,0,0,0,0,0];
  const oneFive = [1,0,0,0,0,0,0,0, 5,0,0,0,0,0,0,0];
  ck('i64x2.lt_s compares SIGNED (-1 < 1 true, 5 < 5 false)',
     same(run('i64x2.lt_s', negOne, oneFive), T8.concat(F8)), out().join(','));
  ck('i64x2.gt_s (-1 > 1 false, 5 > 5 false)',
     same(run('i64x2.gt_s', negOne, oneFive), F8.concat(F8)), out().join(','));
  ck('i64x2.le_s (-1 <= 1 true, 5 <= 5 true)',
     same(run('i64x2.le_s', negOne, oneFive), T8.concat(T8)), out().join(','));
  ck('i64x2.ge_s (-1 >= 1 false, 5 >= 5 true)',
     same(run('i64x2.ge_s', negOne, oneFive), F8.concat(T8)), out().join(','));

  // ── extadd_pairwise ──
  ck('i16x8.extadd_pairwise_i8x16_u adds unsigned pairs (255+255 = 0x01FE)',
     same(run('i16x8.extadd_pairwise_i8x16_u', rep(0xFF)), lanes16(0x01FE)), out().slice(0, 4));
  ck('i16x8.extadd_pairwise_i8x16_s adds signed pairs (-1 + -1 = -2)',
     same(run('i16x8.extadd_pairwise_i8x16_s', rep(0xFF)), lanes16(0xFFFE)), out().slice(0, 4));
  run('i32x4.extadd_pairwise_i16x8_s', rep(0xFF));
  ck('i32x4.extadd_pairwise_i16x8_s adds signed pairs (-1 + -1 = -2)',
     same(i32out(), [-2, -2, -2, -2]), i32out().join(','));
  run('i32x4.extadd_pairwise_i16x8_u', rep(0xFF));
  ck('i32x4.extadd_pairwise_i16x8_u adds unsigned pairs (65535 + 65535 = 131070)',
     same(u32out(), [131070, 131070, 131070, 131070]), u32out().join(','));

  // ── i64x2 widening extends ──
  const hiLo32 = [0xFF,0xFF,0xFF,0xFF, 1,0,0,0, 2,0,0,0, 0xFF,0xFF,0xFF,0xFF];
  run('i64x2.extend_low_i32x4_u', hiLo32);
  ck('i64x2.extend_low_i32x4_u zero-extends the LOW two lanes (0xFFFFFFFF, 1)',
     i64out()[0] === 0xFFFFFFFFn && i64out()[1] === 1n, i64out().join(','));
  run('i64x2.extend_low_i32x4_s', hiLo32);
  ck('i64x2.extend_low_i32x4_s sign-extends the SAME lanes (-1, 1)',
     i64out()[0] === -1n && i64out()[1] === 1n, i64out().join(','));
  run('i64x2.extend_high_i32x4_u', hiLo32);
  ck('i64x2.extend_high_i32x4_u reads the HIGH two lanes (2, 0xFFFFFFFF)',
     i64out()[0] === 2n && i64out()[1] === 0xFFFFFFFFn, i64out().join(','));
  run('i64x2.extend_high_i32x4_s', hiLo32);
  ck('i64x2.extend_high_i32x4_s sign-extends the high lanes (2, -1)',
     i64out()[0] === 2n && i64out()[1] === -1n, i64out().join(','));

  // ── bitmask (scalar result -- a v128 return type would fail validation outright) ──
  put(0, [0x80,0,0x80,0, 0,0,0,0, 0,0,0,0, 0,0,0,0x80]);
  ck('i8x16.bitmask gathers the sign bit of each byte lane',
     X.i8x16_bitmask() === ((1 << 0) | (1 << 2) | (1 << 15)), X.i8x16_bitmask());
  put(0, [0,0x80, 0,0, 0,0x80, 0,0, 0,0, 0,0, 0,0, 0,0]);
  ck('i16x8.bitmask gathers the sign bit of each 16-bit lane',
     X.i16x8_bitmask() === ((1 << 0) | (1 << 2)), X.i16x8_bitmask());
  put(0, [0,0,0,0x80, 0,0,0,0, 0,0,0,0x80, 0,0,0,0]);
  ck('i32x4.bitmask gathers the sign bit of each 32-bit lane',
     X.i32x4_bitmask() === ((1 << 0) | (1 << 2)), X.i32x4_bitmask());
  put(0, [0,0,0,0,0,0,0,0x80, 0,0,0,0,0,0,0,0]);
  ck('i64x2.bitmask gathers the sign bit of each 64-bit lane',
     X.i64x2_bitmask() === 1, X.i64x2_bitmask());

  // ── int <-> float converts. The _s/_u fork is a real behavioural difference. ──
  const allFF = [0xFF,0xFF,0xFF,0xFF, 0xFF,0xFF,0xFF,0xFF, 0xFF,0xFF,0xFF,0xFF, 0xFF,0xFF,0xFF,0xFF];
  run('f32x4.convert_i32x4_u', allFF);
  ck('f32x4.convert_i32x4_u reads lanes UNSIGNED (0xFFFFFFFF -> 4294967296.0 after rounding)',
     f32out()[0] === 4294967296, f32out()[0]);
  run('f32x4.convert_i32x4_s', allFF);
  ck('f32x4.convert_i32x4_s reads the SAME lanes SIGNED (-1.0)', f32out()[0] === -1, f32out()[0]);

  const f32in = vals => { const b = new ArrayBuffer(16); new Float32Array(b).set(vals); return Array.from(new Uint8Array(b)); };
  const f64in = vals => { const b = new ArrayBuffer(16); new Float64Array(b).set(vals); return Array.from(new Uint8Array(b)); };
  run('i32x4.trunc_sat_f32x4_s', f32in([1e10, -5.9, NaN, 3.7]));
  ck('i32x4.trunc_sat_f32x4_s saturates high, truncates toward zero, NaN -> 0',
     same(i32out(), [2147483647, -5, 0, 3]), i32out().join(','));
  run('i32x4.trunc_sat_f32x4_u', f32in([1e10, -5.9, NaN, 3.7]));
  ck('i32x4.trunc_sat_f32x4_u saturates high and clamps negatives to 0',
     same(u32out(), [4294967295, 0, 0, 3]), u32out().join(','));
  run('i32x4.trunc_sat_f64x2_s_zero', f64in([-2.9, 1e18]));
  ck('i32x4.trunc_sat_f64x2_s_zero converts two lanes and zeroes the top two',
     same(i32out(), [-2, 2147483647, 0, 0]), i32out().join(','));
  run('i32x4.trunc_sat_f64x2_u_zero', f64in([-2.9, 1e18]));
  ck('i32x4.trunc_sat_f64x2_u_zero clamps the negative to 0',
     same(u32out(), [0, 4294967295, 0, 0]), u32out().join(','));
  run('f64x2.convert_low_i32x4_s', [0xFF,0xFF,0xFF,0xFF, 7,0,0,0, 0,0,0,0, 0,0,0,0]);
  ck('f64x2.convert_low_i32x4_s widens the low two i32 lanes signed (-1, 7)',
     same(f64out(), [-1, 7]), f64out().join(','));
  run('f64x2.convert_low_i32x4_u', [0xFF,0xFF,0xFF,0xFF, 7,0,0,0, 0,0,0,0, 0,0,0,0]);
  ck('f64x2.convert_low_i32x4_u widens the SAME lanes unsigned (4294967295, 7)',
     same(f64out(), [4294967295, 7]), f64out().join(','));

  // ── float rounding ──
  const round = f32in([2.5, -2.5, 3.5, -0.5]);
  run('f32x4.floor', round);
  ck('f32x4.floor rounds toward -inf', same(f32out(), [2, -3, 3, -1]), f32out().join(','));
  run('f32x4.ceil', round);
  ck('f32x4.ceil rounds toward +inf', same(f32out(), [3, -2, 4, -0]), f32out().join(','));
  run('f32x4.trunc', round);
  ck('f32x4.trunc rounds toward zero', same(f32out(), [2, -2, 3, -0]), f32out().join(','));
  run('f32x4.nearest', round);
  ck('f32x4.nearest is round-half-to-EVEN (2.5 -> 2, 3.5 -> 4)',
     f32out()[0] === 2 && f32out()[1] === -2 && f32out()[2] === 4 && Object.is(f32out()[3], -0),
     f32out().join(','));
  const round64 = f64in([2.5, -3.5]);
  run('f64x2.floor', round64);
  ck('f64x2.floor rounds toward -inf', same(f64out(), [2, -4]), f64out().join(','));
  run('f64x2.ceil', round64);
  ck('f64x2.ceil rounds toward +inf', same(f64out(), [3, -3]), f64out().join(','));
  run('f64x2.trunc', round64);
  ck('f64x2.trunc rounds toward zero', same(f64out(), [2, -3]), f64out().join(','));
  run('f64x2.nearest', round64);
  ck('f64x2.nearest is round-half-to-even (2.5 -> 2, -3.5 -> -4)',
     same(f64out(), [2, -4]), f64out().join(','));

  // ── width changes between the float shapes ──
  run('f64x2.promote_low_f32x4', f32in([2.5, -2.5, 9, 9]));
  ck('f64x2.promote_low_f32x4 widens the low two f32 lanes', same(f64out(), [2.5, -2.5]), f64out().join(','));
  run('f32x4.demote_f64x2_zero', f64in([2.5, -2.5]));
  ck('f32x4.demote_f64x2_zero narrows two f64 lanes and zeroes the top two',
     same(f32out(), [2.5, -2.5, 0, 0]), f32out().join(','));
}

console.log(`\nwatx-compiler-simd-ops: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

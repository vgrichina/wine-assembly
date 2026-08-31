// REPRODUCER — WATX HIGH: (v128.const <shape> ...) silently emits the wrong constant.
//
// Standard WAT spells a SIMD constant with a shape token that says how wide its
// lanes are:  (v128.const i32x4 0x80000000 0x7fffffff 0xffffffff 1)
// WATX's emitter (tools/watx-src/compiler-codegen.js, the `head === 'v128.const'`
// branch) reads exactly 16 operands from expr[2] and writes each one & 0xff. It
// never looks for the shape token, so:
//
//   * the shape token itself becomes lane 0 — immVal() runs parseInt('i8x16'),
//     gets NaN, and the documented "fall through to the default" writes 0;
//   * every later lane is shifted one position and the last one is DROPPED;
//   * for any shape wider than i8x16 each lane value is truncated to one byte,
//     so 0xffffffff becomes 0xff in a single byte lane and the other three
//     bytes of that lane are somebody else's value.
//
// Nothing diagnoses this. The module compiles, validates and runs — it just
// computes with a constant nobody wrote. WATX's own byte-wise spelling
// (v128.const b0 … b15) is correct and is what src/*.wat uses today, which is
// why the tree is unaffected and why no existing test caught it.
//
// Run: node tools/watx-repro/v128-const-shape.js   (exit 1 while the bug stands)
'use strict';
const path = require('path');
const { compileWatx, compileWabt } = require(path.join(__dirname, '..', 'watx-differential.js'));

const CASES = [
  {
    name: 'i8x16: last lane dropped, lane 0 is the shape token',
    fn: 'c',
    src: `(func $c (result i32) (i8x16.extract_lane_u 15 (v128.const i8x16 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16)))
(export "c" (func $c))`,
    expect: 16,
  },
  {
    name: 'i32x4: 32-bit lanes truncated to one byte each',
    fn: 'c',
    src: `(func $c (result i32) (i32x4.extract_lane 2 (v128.const i32x4 0x80000000 0x7fffffff 0xffffffff 1)))
(export "c" (func $c))`,
    expect: -1,
  },
  {
    name: 'i8x16 through memory: the stored 16 bytes are shifted by one',
    fn: null,
    src: `(memory 1 1)
(export "mem" (memory 0))
(func $store (v128.store (i32.const 0) (v128.const i8x16 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16)))
(export "store" (func $store))`,
    probe: (ex) => { ex.store(); return Array.from(new Uint8Array(ex.mem.buffer, 0, 16)).join(','); },
    expect: '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16',
  },
  {
    // Not sent to wabt: the bare byte-wise form is a WATX extension and
    // wat2wasm refuses it ("Expected one of: i8x16, i16x8, …"). It is here as
    // the control that says the emitter itself is fine and only the shape
    // spelling is unhandled.
    watxOnly: true,
    name: 'CONTROL — WATX\'s own byte-wise spelling is correct',
    fn: 'c',
    src: `(func $c (result i32) (i8x16.extract_lane_u 15 (v128.const 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16)))
(export "c" (func $c))`,
    expect: 16,
  },
];

function value(binary, c) {
  const ex = new WebAssembly.Instance(new WebAssembly.Module(binary), {}).exports;
  return c.probe ? c.probe(ex) : ex[c.fn]();
}

(async () => {
  let bad = 0;
  for (const c of CASES) {
    const watx = value(compileWatx(c.src, { tailCalls: false }), c);
    const wabt = c.watxOnly ? '(watx-only form)' : value(await compileWabt(c.src), c);
    const ok = String(watx) === String(c.expect);
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'BUG '} ${c.name}`);
    console.log(`       expected ${c.expect}   wabt ${wabt}   watx ${watx}`);
  }
  console.log(bad ? `\n${bad} case(s) still miscompile.` : '\nAll cases agree — the bug is fixed; delete this reproducer.');
  process.exit(bad ? 1 : 0);
})();

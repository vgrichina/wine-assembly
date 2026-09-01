// test/watx-compiler-layout.test.js -- the (layout ...) struct family: store.* must NOT
// leave a value on the stack under standardWat, and every accessor must lower to the
// SAME bytes as the hand-spelled arithmetic it replaces.
//
// WHY THIS SUITE EXISTS
// ---------------------
// The layout family (load.field / store.field / load.elem / store.elem /
// load.field-elem / store.field-elem / elem-addr / offset-of / size-of) shipped with no
// coverage anywhere in this tree -- not in the spec suite, not in the differential, not
// here -- because nothing in src/*.wat used it. A grep for `load.field|store.field` over
// src/, lib/, tools/ and test/ returned nothing outside the vendored compiler itself.
//
// That hid a real defect. In the WATX dialect every form is an expression, so a store
// evaluates to 0 and the codegen appends `i32.const 0`. Under `standardWat: true` -- the
// mode tools/watx-closure.js builds the emulator with -- a store is a STATEMENT, and the
// plain `i32.store` path guards that trailing value on `!standardWat`. The three store.*
// layout paths did not. needsAutoDrop() deliberately returns false for any head containing
// "store" in that dialect, so nothing dropped the value either:
//
//     (func $f (param $p i32) (param $v i32)
//       (store.field Rec state (local.get $p) (local.get $v)))
//
// compiled to a body ending `i32.store; i32.const 0; end` in a function declared to return
// nothing -- and the whole module failed WebAssembly.validate. Every store site in any
// migration wave would have hit it.
//
// The second half of the suite is the claim docs/watx-layout-migration-design.md is built
// on: these accessors are SUGAR. `(load.field Rec value p)` must emit exactly the bytes of
// `(i32.load (i32.add p (i32.const 8)))`, so a migration wave can be gated on an unchanged
// build/wine-assembly.wasm shasum -- an oracle strong enough that a byte-identical wave
// needs no behavioural argument at all. If that ever stops holding, the gate silently
// becomes a much weaker one, so it is asserted here rather than assumed.
'use strict';

const assert = require('assert');
const path = require('path');
const { compile } = require(path.join(__dirname, '..', 'tools', 'watx.js'));

const PROD = { mode: 'production', standardWat: true, runtimeBuiltins: false, tailCalls: false };

const LAYOUT = `
(layout Rec
  (field state i32)
  (field flags u8)
  (field pad0 u8)
  (field pad1 u8)
  (field pad2 u8)
  (field value i32)
  (field ports i32 4))`;

function build(src, opts = PROD) {
  const out = compile(src, new Map(), opts);
  assert.ok(out.success, `compile failed: ${out.error}`);
  return Buffer.from(out.wasmBinary);
}

// Function bodies, in declaration order, straight out of the code section.
function codeBodies(wasm) {
  const uleb = (buf, i) => { let r = 0, s = 0, b; do { b = buf[i++]; r |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return [r >>> 0, i]; };
  let i = 8;
  while (i < wasm.length) {
    const id = wasm[i++];
    let size; [size, i] = uleb(wasm, i);
    if (id === 10) {
      let j = i, count; [count, j] = uleb(wasm, j);
      const out = [];
      for (let k = 0; k < count; k++) {
        let bsize; [bsize, j] = uleb(wasm, j);
        out.push(Buffer.from(wasm.slice(j, j + bsize)));
        j += bsize;
      }
      return out;
    }
    i += size;
  }
  return [];
}

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

// ── 1. A store in a void function must produce a VALID module ──────────────
check('store.field in a void function validates (standardWat)', () => {
  const bin = build(`${LAYOUT}
(memory $m 1)
(func $f (param $p i32) (param $v i32)
  (store.field Rec state (local.get $p) (local.get $v)))
(export "f" (func $f))`);
  assert.ok(WebAssembly.validate(bin), 'module failed WebAssembly.validate');
});

check('two consecutive store.fields validate', () => {
  const bin = build(`${LAYOUT}
(memory $m 1)
(func $f (param $p i32) (param $v i32)
  (store.field Rec state (local.get $p) (local.get $v))
  (store.field Rec value (local.get $p) (local.get $v)))
(export "f" (func $f))`);
  assert.ok(WebAssembly.validate(bin), 'module failed WebAssembly.validate');
});

check('store.elem and store.field-elem in a void function validate', () => {
  const bin = build(`${LAYOUT}
(memory $m 1)
(func $f (param $b i32) (param $i i32) (param $v i32)
  (store.elem Rec value (local.get $b) (local.get $i) (local.get $v))
  (store.field-elem Rec ports (local.get $b) (local.get $i) (local.get $v)))
(export "f" (func $f))`);
  assert.ok(WebAssembly.validate(bin), 'module failed WebAssembly.validate');
});

// ── 2. The WATX dialect keeps the expression value ─────────────────────────
// The guard is on the DIALECT, not a deletion: without standardWat a store is
// still an expression evaluating to 0, and something has to be there for it.
check('store.field still yields a value in the WATX dialect', () => {
  const src = `${LAYOUT}
(memory $m 1)
(func $f (param $p i32) (result i32)
  (store.field Rec state (local.get $p) (i32.const 5)))
(export "f" (func $f))`;
  const bin = build(src, { mode: 'production', standardWat: false, runtimeBuiltins: false, tailCalls: false });
  assert.ok(WebAssembly.validate(bin), 'module failed WebAssembly.validate');
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bin), {});
  assert.strictEqual(inst.exports.f(0), 0, 'store.field should evaluate to 0');
});

// ── 3. Byte identity with the hand-spelled twin ────────────────────────────
// Pairs of functions in ONE module, differing only in spelling.
check('every accessor lowers to the hand-spelled bytes', () => {
  const bin = build(`${LAYOUT}
(memory $m 1)
(func $a_hand  (param $p i32) (result i32) (i32.load (i32.add (local.get $p) (i32.const 8))))
(func $a_field (param $p i32) (result i32) (load.field Rec value (local.get $p)))
(func $b_hand  (param $p i32) (result i32) (i32.load (local.get $p)))
(func $b_field (param $p i32) (result i32) (load.field Rec state (local.get $p)))
(func $c_hand  (param $p i32) (result i32) (i32.load8_u (i32.add (local.get $p) (i32.const 4))))
(func $c_field (param $p i32) (result i32) (load.field Rec flags (local.get $p)))
(func $d_hand  (param $p i32) (param $v i32) (i32.store (i32.add (local.get $p) (i32.const 8)) (local.get $v)))
(func $d_field (param $p i32) (param $v i32) (store.field Rec value (local.get $p) (local.get $v)))
(func $e_hand  (param $b i32) (param $i i32) (result i32)
  (i32.load (i32.add (i32.add (local.get $b) (i32.mul (local.get $i) (i32.const 28))) (i32.const 8))))
(func $e_field (param $b i32) (param $i i32) (result i32) (load.elem Rec value (local.get $b) (local.get $i)))
(func $f_hand  (param $p i32) (param $i i32) (result i32)
  (i32.load (i32.add (i32.add (local.get $p) (i32.const 12)) (i32.mul (local.get $i) (i32.const 4)))))
(func $f_field (param $p i32) (param $i i32) (result i32) (load.field-elem Rec ports (local.get $p) (local.get $i)))
(func $g_hand  (param $p i32) (param $i i32) (result i32)
  (i32.add (i32.add (local.get $p) (i32.const 12)) (i32.mul (local.get $i) (i32.const 4))))
(func $g_field (param $p i32) (param $i i32) (result i32) (elem-addr Rec ports (local.get $p) (local.get $i)))
(func $h_hand  (param $i i32) (result i32) (i32.mul (local.get $i) (i32.const 28)))
(func $h_field (param $i i32) (result i32) (i32.mul (local.get $i) (size-of Rec)))
(func $i_hand  (result i32) (i32.const 8))
(func $i_field (result i32) (offset-of Rec value))
(export "a" (func $a_field))`);
  const bodies = codeBodies(bin);
  const labels = ['load.field +8', 'load.field +0', 'load.field u8', 'store.field',
                  'load.elem', 'load.field-elem', 'elem-addr', 'size-of', 'offset-of'];
  assert.strictEqual(bodies.length, 18, `expected 18 function bodies, got ${bodies.length}`);
  for (let k = 0; k < 9; k++) {
    const hand = bodies[k * 2], sugar = bodies[k * 2 + 1];
    assert.ok(hand.equals(sugar),
      `${labels[k]} is NOT byte-identical to its hand-spelled twin\n` +
      `         hand=${hand.toString('hex')}\n         watx=${sugar.toString('hex')}`);
  }
});

// ── 4. The accessors actually address the right bytes ──────────────────────
// Byte identity says the two spellings agree; this says they are both RIGHT.
check('fields round-trip through memory at their declared offsets', () => {
  const bin = build(`${LAYOUT}
(memory $m 1)
(func $set (param $p i32) (param $v i32) (store.field Rec value (local.get $p) (local.get $v)))
(func $get (param $p i32) (result i32) (load.field Rec value (local.get $p)))
(func $raw (param $p i32) (result i32) (i32.load (i32.add (local.get $p) (i32.const 8))))
(func $pset (param $p i32) (param $i i32) (param $v i32) (store.field-elem Rec ports (local.get $p) (local.get $i) (local.get $v)))
(func $pget (param $p i32) (param $i i32) (result i32) (load.field-elem Rec ports (local.get $p) (local.get $i)))
(func $sz (result i32) (size-of Rec))
(export "set" (func $set)) (export "get" (func $get)) (export "raw" (func $raw))
(export "pset" (func $pset)) (export "pget" (func $pget)) (export "sz" (func $sz))
(export "mem" (memory $m))`);
  const ex = new WebAssembly.Instance(new WebAssembly.Module(bin), {}).exports;
  ex.set(64, 0x11223344);
  assert.strictEqual(ex.get(64), 0x11223344, 'load.field did not read back store.field');
  assert.strictEqual(ex.raw(64), 0x11223344, 'the field did not land at its declared +8');
  ex.pset(64, 3, 0xAABB);
  assert.strictEqual(ex.pget(64, 3), 0xAABB, 'array field element did not round-trip');
  // ports is +12, element 3 is +12+12 = +24 from the record base.
  const mem = new Int32Array(ex.mem.buffer);
  assert.strictEqual(mem[(64 + 24) / 4], 0xAABB, 'array element landed at the wrong address');
  assert.strictEqual(ex.sz(), 28, 'size-of is the sum of the declared fields');
});

if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nwatx-compiler-layout: all checks passed');

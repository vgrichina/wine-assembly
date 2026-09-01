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

// ── 3b. The `.memarg` lowering and ITS hand-spelled twin ───────────────────
// §3.4 of the design doc: 6,547 sites in src/*.wat spell the field offset in the
// instruction's memarg (`(i32.load offset=8 (local.get $p))`) rather than as an
// explicit i32.add. That is three bytes shorter and is NOT the same wasm, so
// those sites could not join a byte-identical wave at all. `load.field.memarg`
// is the second lowering: same field, same layout, the offset encoded the other
// way. Each pair below must match its OWN twin -- and section 3c asserts the two
// lowerings really do differ, because a modifier that quietly did nothing would
// pass every check in this section.
check('every .memarg accessor lowers to the memarg-spelled bytes', () => {
  const bin = build(`${LAYOUT}
(memory $m 1)
(func $a_hand  (param $p i32) (result i32) (i32.load offset=8 (local.get $p)))
(func $a_field (param $p i32) (result i32) (load.field.memarg Rec value (local.get $p)))
(func $b_hand  (param $p i32) (result i32) (i32.load (local.get $p)))
(func $b_field (param $p i32) (result i32) (load.field.memarg Rec state (local.get $p)))
(func $c_hand  (param $p i32) (result i32) (i32.load8_u offset=4 (local.get $p)))
(func $c_field (param $p i32) (result i32) (load.field.memarg Rec flags (local.get $p)))
(func $d_hand  (param $p i32) (param $v i32) (i32.store offset=8 (local.get $p) (local.get $v)))
(func $d_field (param $p i32) (param $v i32) (store.field.memarg Rec value (local.get $p) (local.get $v)))
(func $e_hand  (param $b i32) (param $i i32) (result i32)
  (i32.load offset=8 (i32.add (local.get $b) (i32.mul (local.get $i) (i32.const 28)))))
(func $e_field (param $b i32) (param $i i32) (result i32) (load.elem.memarg Rec value (local.get $b) (local.get $i)))
(func $f_hand  (param $p i32) (param $i i32) (result i32)
  (i32.load offset=12 (i32.add (local.get $p) (i32.mul (local.get $i) (i32.const 4)))))
(func $f_field (param $p i32) (param $i i32) (result i32) (load.field-elem.memarg Rec ports (local.get $p) (local.get $i)))
(func $g_hand  (param $b i32) (param $i i32) (param $v i32)
  (i32.store offset=8 (i32.add (local.get $b) (i32.mul (local.get $i) (i32.const 28))) (local.get $v)))
(func $g_field (param $b i32) (param $i i32) (param $v i32) (store.elem.memarg Rec value (local.get $b) (local.get $i) (local.get $v)))
(func $h_hand  (param $p i32) (param $i i32) (param $v i32)
  (i32.store offset=12 (i32.add (local.get $p) (i32.mul (local.get $i) (i32.const 4))) (local.get $v)))
(func $h_field (param $p i32) (param $i i32) (param $v i32) (store.field-elem.memarg Rec ports (local.get $p) (local.get $i) (local.get $v)))
(export "a" (func $a_field))`);
  const bodies = codeBodies(bin);
  const labels = ['load.field.memarg +8', 'load.field.memarg +0', 'load.field.memarg u8',
                  'store.field.memarg', 'load.elem.memarg', 'load.field-elem.memarg',
                  'store.elem.memarg', 'store.field-elem.memarg'];
  assert.strictEqual(bodies.length, 16, `expected 16 function bodies, got ${bodies.length}`);
  for (let k = 0; k < labels.length; k++) {
    const hand = bodies[k * 2], sugar = bodies[k * 2 + 1];
    assert.ok(hand.equals(sugar),
      `${labels[k]} is NOT byte-identical to its hand-spelled twin\n` +
      `         hand=${hand.toString('hex')}\n         watx=${sugar.toString('hex')}`);
  }
});

// ── 3c. The two lowerings are actually different ───────────────────────────
// The modifier's whole reason to exist is that these two populations cannot be
// spelled the same way. If `.memarg` ever became a no-op suffix, section 3b
// would still pass for the zero-offset field (where both lowerings coincide)
// and section 3 would still pass everywhere -- and every memarg wave would then
// silently re-encode its file. So assert the difference directly.
check('.memarg is a different, shorter encoding at a nonzero offset', () => {
  const bin = build(`${LAYOUT}
(memory $m 1)
(func $add    (param $p i32) (result i32) (load.field Rec value (local.get $p)))
(func $memarg (param $p i32) (result i32) (load.field.memarg Rec value (local.get $p)))
(func $add0    (param $p i32) (result i32) (load.field Rec state (local.get $p)))
(func $memarg0 (param $p i32) (result i32) (load.field.memarg Rec state (local.get $p)))
(export "a" (func $add))`);
  const b = codeBodies(bin);
  assert.ok(!b[0].equals(b[1]), 'load.field and load.field.memarg emitted the same bytes at +8');
  assert.strictEqual(b[0].length - b[1].length, 3, 'the memarg form should be exactly 3 bytes shorter (i32.const N; i32.add)');
  // At offset 0 there is nothing to encode either way, so they DO coincide --
  // which is why the assertion above has to be made at a nonzero offset.
  assert.ok(b[2].equals(b[3]), 'at offset 0 the two lowerings should coincide');
});

// ── 3d. Both lowerings address the same byte ───────────────────────────────
check('.memarg reads back what the add-form wrote, and vice versa', () => {
  const bin = build(`${LAYOUT}
(memory $m 1)
(func $set_add (param $p i32) (param $v i32) (store.field Rec value (local.get $p) (local.get $v)))
(func $get_ma  (param $p i32) (result i32) (load.field.memarg Rec value (local.get $p)))
(func $set_ma  (param $p i32) (param $v i32) (store.field.memarg Rec value (local.get $p) (local.get $v)))
(func $get_add (param $p i32) (result i32) (load.field Rec value (local.get $p)))
(func $raw     (param $p i32) (result i32) (i32.load offset=8 (local.get $p)))
(func $pset (param $p i32) (param $i i32) (param $v i32) (store.field-elem.memarg Rec ports (local.get $p) (local.get $i) (local.get $v)))
(func $pget (param $p i32) (param $i i32) (result i32) (load.field-elem Rec ports (local.get $p) (local.get $i)))
(export "set_add" (func $set_add)) (export "get_ma" (func $get_ma))
(export "set_ma" (func $set_ma)) (export "get_add" (func $get_add)) (export "raw" (func $raw))
(export "pset" (func $pset)) (export "pget" (func $pget))`);
  assert.ok(WebAssembly.validate(bin), 'module failed WebAssembly.validate');
  const ex = new WebAssembly.Instance(new WebAssembly.Module(bin), {}).exports;
  ex.set_add(64, 0x0BADF00D);
  assert.strictEqual(ex.get_ma(64), 0x0BADF00D | 0, '.memarg load did not see the add-form store');
  ex.set_ma(128, 0x12345678);
  assert.strictEqual(ex.get_add(128), 0x12345678, 'add-form load did not see the .memarg store');
  assert.strictEqual(ex.raw(128), 0x12345678, 'the .memarg store did not land at +8');
  ex.pset(192, 2, 0x4242);
  assert.strictEqual(ex.pget(192, 2), 0x4242, '.memarg array store did not round-trip');
});

// ── 3e. A .memarg store is still a statement under standardWat ─────────────
check('.memarg stores in a void function validate (standardWat)', () => {
  const bin = build(`${LAYOUT}
(memory $m 1)
(func $f (param $p i32) (param $i i32) (param $v i32)
  (store.field.memarg Rec state (local.get $p) (local.get $v))
  (store.field.memarg Rec value (local.get $p) (local.get $v))
  (store.elem.memarg Rec value (local.get $p) (local.get $i) (local.get $v))
  (store.field-elem.memarg Rec ports (local.get $p) (local.get $i) (local.get $v)))
(export "f" (func $f))`);
  assert.ok(WebAssembly.validate(bin), 'module failed WebAssembly.validate');
});

// ── 3f. The modifier is rejected where there is no memory access ───────────
// elem-addr / size-of / offset-of compute an address or a constant. A `.memarg`
// on one of them is a misunderstanding, and the failure mode if it were merely
// ignored is a site that looks converted and is not.
check('.memarg on a non-accessing layout op is a hard error', () => {
  for (const src of [
    `(func $f (param $p i32) (param $i i32) (result i32) (elem-addr.memarg Rec ports (local.get $p) (local.get $i)))`,
    `(func $f (result i32) (size-of.memarg Rec))`,
    `(func $f (result i32) (offset-of.memarg Rec value))`,
  ]) {
    const out = compile(`${LAYOUT}\n(memory $m 1)\n${src}\n(export "f" (func $f))`, new Map(), PROD);
    assert.ok(!out.success, `expected a compile error for: ${src}`);
    assert.ok(/memarg/.test(out.error || ''), `error should name the modifier, got: ${out.error}`);
  }
});

// ── 3g. The sub-width field types and their hand-spelled twins ─────────────
// u8 was the only sub-width type the emitter knew; every other name fell through
// to the i32 op group, so `(field w u16)` was a FOUR-byte access over a two-byte
// field and the struct was laid out four bytes wide to match. u16/s16/s8 are now
// declared types with their own opcodes, and the claim is the same one the whole
// migration rests on: the accessor is sugar for the hand-spelled instruction,
// byte for byte, memarg included (align 1 for the 16-bit ops, 0 for the 8-bit).
const WIDTHS = `
(layout W
  (field b0 u8)
  (field b1 s8)
  (field h0 u16)
  (field h1 s16)
  (field w0 i32))`;
check('sub-width accessors lower to the hand-spelled bytes', () => {
  const bin = build(`${WIDTHS}
(memory $m 1)
(func $a_hand  (param $p i32) (result i32) (i32.load8_u (local.get $p)))
(func $a_field (param $p i32) (result i32) (load.field W b0 (local.get $p)))
(func $b_hand  (param $p i32) (result i32) (i32.load8_s (i32.add (local.get $p) (i32.const 1))))
(func $b_field (param $p i32) (result i32) (load.field W b1 (local.get $p)))
(func $c_hand  (param $p i32) (result i32) (i32.load16_u (i32.add (local.get $p) (i32.const 2))))
(func $c_field (param $p i32) (result i32) (load.field W h0 (local.get $p)))
(func $d_hand  (param $p i32) (result i32) (i32.load16_s (i32.add (local.get $p) (i32.const 4))))
(func $d_field (param $p i32) (result i32) (load.field W h1 (local.get $p)))
(func $e_hand  (param $p i32) (param $v i32) (i32.store16 (i32.add (local.get $p) (i32.const 2)) (local.get $v)))
(func $e_field (param $p i32) (param $v i32) (store.field W h0 (local.get $p) (local.get $v)))
(func $f_hand  (param $p i32) (param $v i32) (i32.store16 (i32.add (local.get $p) (i32.const 4)) (local.get $v)))
(func $f_field (param $p i32) (param $v i32) (store.field W h1 (local.get $p) (local.get $v)))
(func $g_hand  (param $p i32) (param $v i32) (i32.store8 (i32.add (local.get $p) (i32.const 1)) (local.get $v)))
(func $g_field (param $p i32) (param $v i32) (store.field W b1 (local.get $p) (local.get $v)))
(func $h_hand  (param $p i32) (result i32) (i32.load16_u offset=2 (local.get $p)))
(func $h_field (param $p i32) (result i32) (load.field.memarg W h0 (local.get $p)))
(func $i_hand  (param $p i32) (param $v i32) (i32.store16 offset=4 (local.get $p) (local.get $v)))
(func $i_field (param $p i32) (param $v i32) (store.field.memarg W h1 (local.get $p) (local.get $v)))
(export "a" (func $a_field))`);
  const bodies = codeBodies(bin);
  const labels = ['load u8', 'load s8', 'load u16', 'load s16', 'store u16', 'store s16',
                  'store s8', 'load.memarg u16', 'store.memarg s16'];
  assert.strictEqual(bodies.length, labels.length * 2, `expected ${labels.length * 2} bodies, got ${bodies.length}`);
  for (let k = 0; k < labels.length; k++) {
    const hand = bodies[k * 2], sugar = bodies[k * 2 + 1];
    assert.ok(hand.equals(sugar),
      `${labels[k]} is NOT byte-identical to its hand-spelled twin\n` +
      `         hand=${hand.toString('hex')}\n         watx=${sugar.toString('hex')}`);
  }
});

// The widths also have to be REAL: the struct must be laid out at 1/1/2/2/4 and
// the accesses must touch exactly those bytes. Byte identity above says the two
// spellings agree; this says the layout arithmetic agrees with them.
check('sub-width fields are laid out and accessed at their true widths', () => {
  const bin = build(`${WIDTHS}
(memory $m 1)
(func $sz (result i32) (size-of W))
(func $off_w0 (result i32) (offset-of W w0))
(func $set_h0 (param $p i32) (param $v i32) (store.field W h0 (local.get $p) (local.get $v)))
(func $get_h0 (param $p i32) (result i32) (load.field W h0 (local.get $p)))
(func $get_h1 (param $p i32) (result i32) (load.field W h1 (local.get $p)))
(func $set_h1 (param $p i32) (param $v i32) (store.field W h1 (local.get $p) (local.get $v)))
(func $get_b1 (param $p i32) (result i32) (load.field W b1 (local.get $p)))
(func $set_b1 (param $p i32) (param $v i32) (store.field W b1 (local.get $p) (local.get $v)))
(func $get_w0 (param $p i32) (result i32) (load.field W w0 (local.get $p)))
(export "sz" (func $sz)) (export "off_w0" (func $off_w0))
(export "set_h0" (func $set_h0)) (export "get_h0" (func $get_h0))
(export "set_h1" (func $set_h1)) (export "get_h1" (func $get_h1))
(export "set_b1" (func $set_b1)) (export "get_b1" (func $get_b1))
(export "get_w0" (func $get_w0)) (export "mem" (memory $m))`);
  const ex = new WebAssembly.Instance(new WebAssembly.Module(bin), {}).exports;
  assert.strictEqual(ex.sz(), 10, 'size-of W should be 1+1+2+2+4 = 10');
  assert.strictEqual(ex.off_w0(), 6, 'w0 should sit at +6');
  const u8 = new Uint8Array(ex.mem.buffer);
  // A 16-bit store must write exactly two bytes and leave the next field alone.
  ex.set_h1(64, 0x1234);            // h1 is +4..+5
  ex.set_h0(64, 0xBEEF);            // h0 is +2..+3
  assert.strictEqual(ex.get_h0(64), 0xBEEF, 'u16 load did not read back its own store');
  assert.strictEqual(ex.get_h1(64), 0x1234, 'the u16 store at +2 bled into the field at +4');
  assert.strictEqual(u8[64 + 6], 0, 'a 16-bit field access touched w0 at +6');
  // Signedness is the whole difference between s16 and u16 on load.
  ex.set_h0(96, 0xFFFF); ex.set_h1(96, 0xFFFF);
  assert.strictEqual(ex.get_h0(96), 0xFFFF, 'u16 load must zero-extend');
  assert.strictEqual(ex.get_h1(96), -1, 's16 load must sign-extend');
  ex.set_b1(96, 0x80);
  assert.strictEqual(ex.get_b1(96), -128, 's8 load must sign-extend');
  // And an oversized value truncates rather than spilling into the neighbour.
  ex.set_h0(128, 0x12345678);
  assert.strictEqual(ex.get_h0(128), 0x5678, 'u16 store must truncate to two bytes');
  assert.strictEqual(ex.get_w0(128), 0, 'the truncated high half landed outside the field');
});

// ── 3h. An unrecognized field type is REFUSED at the declaration ───────────
// The refusal is the point of the type list. Before it, emitLayoutAccess read
// `group[fieldType] || group.i32`, so any name the table did not know became a
// four-byte i32 access — the accepted-invalid this project kills on sight. The
// diagnostic has to be at the DECLARATION (one error, naming the field) rather
// than at each access, and it has to carry a line: an error with no location is
// half a diagnostic.
check('an unknown field type is a located refusal naming field, type and the set', () => {
  for (const [what, decl] of [
    ['scalar field',      '(layout Bad (field a i32) (field b u24))'],
    ['array field',       '(layout Bad (field a i32) (field b u24 4))'],
    ['a real valtype that is not a field type', '(layout Bad (field a i32) (field b v128))'],
  ]) {
    const out = compile(`${decl}\n(memory $m 1)\n(func $z (result i32) (size-of Bad))\n(export "z" (func $z))`,
      new Map(), PROD);
    assert.ok(!out.success, `${what}: expected a refusal`);
    const msg = out.error || '';
    assert.ok(/\bb\b/.test(msg), `${what}: error should name the field, got: ${msg}`);
    assert.ok(/u24|v128/.test(msg), `${what}: error should name the offending type, got: ${msg}`);
    assert.ok(/u16/.test(msg) && /f64/.test(msg),
      `${what}: error should list the supported types, got: ${msg}`);
    assert.ok((out.errorLine || 0) > 0, `${what}: refusal has no line number`);
  }
});

// The boundary half: every name in the set must still be accepted. A rule that
// refused everything would pass the check above.
check('every declared field type is accepted, and ptr$Rec names its pointee', () => {
  const out = compile(
    `(layout All (field a i32) (field b i64) (field c f32) (field d f64)
       (field e u8) (field f s8) (field g u16) (field h s16)
       (field i ptr) (field j weak) (field k ptr$All))\n` +
    `(memory $m 1)\n(func $z (result i32) (size-of All))\n(export "z" (func $z))`,
    new Map(), PROD);
  assert.ok(out.success, `every declared field type should compile: ${out.error}`);
  const ex = new WebAssembly.Instance(new WebAssembly.Module(Buffer.from(out.wasmBinary)), {}).exports;
  // 4+8+4+8 +1+1+2+2 +4+4+4
  assert.strictEqual(ex.z(), 42, 'the declared widths did not lay the struct out as declared');
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

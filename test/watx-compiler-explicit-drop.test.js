// test/watx-compiler-explicit-drop.test.js -- WATX migration gap G8: a bare `(drop)` as a
// statement, consuming the value the PREVIOUS sibling statement left on the stack.
//
// This is how standard WAT — and lib/compile-wat.js, Wine-Assembly's own legacy compiler —
// spell "call this i32-returning function for its effect only" inside a void function:
//
//     (call $host_gdi_set_dib_to_device …)      ;; (result i32)
//     (drop)                                    ;; the consumer
//
// docs/watx-migration-gaps.md originally filed G8 as a Wine-source defect ("the line is
// dead in the legacy build too, delete it"). That verdict was REVERSED at 3aa8310f and the
// reversal is the whole point of this suite:
//   * lib/compile-wat.js has NO auto-drop of any kind — `drop` is a plain opcode-table
//     entry (0x1A) and a bare `(drop)` emits a real wasm drop.
//   * `$host_gdi_set_dib_to_device` is `(result i32)` and the enclosing
//     `$dx_blit_entry_rect_to_hdc` has no result, so that i32 has to go somewhere.
//   * DELETING src/09a8-handlers-directx.wat:4449 makes the SHIPPED build fail
//     validation: "expected 0 elements on the stack for fallthru, found 1".
// So the line is load-bearing and the fix belongs in WATX: its statement compiler
// auto-dropped the call's value and then compiled the explicit `(drop)` on top, so the two
// drops fought and the second underflowed.
//
// The design this suite pins down:
//   (1) A bare `(drop)` following a value-producing statement IS that value's consumer;
//       the compiler synthesizes no drop of its own. Compiles, validates, runs.
//   (2) With NO explicit drop, the compiler still auto-drops, exactly as before — that is
//       what the entire existing tree relies on, and it is deliberately NOT a hard error.
//       (Documented choice: silently accepting an unconsumed value is the status quo
//       every WATX source in the tree is written against; making it an error is a
//       separate, much larger change.)
//   (3) One drop consumes ONE value. A second bare `(drop)` with nothing left underflows
//       and must be caught — as a wasm validation failure naming the function, not as a
//       silently mis-encoded body.
//
// Run: node test/watx-compiler-explicit-drop.test.js
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
function instantiate(r) {
  try { return new WebAssembly.Instance(new WebAssembly.Module(r.wasmBinary), {}).exports; }
  catch (e) { return { __error: e.message }; }
}

// ── (1) The shape from src/09a8-handlers-directx.wat:4449 ───────────────────
// An i32-returning callee invoked in statement position inside a VOID function, with an
// explicit bare (drop) after it. The callee records that it ran, so "the drop swallowed
// the call as well" cannot pass silently.
const good = build(`
(func $effect (param $v i32) (result i32) (effects heap)
  (i32.store (i32.const 64) (local.get $v))
  (i32.const 0x1234))
(func $void_caller (effects heap)
  (call $effect (i32.const 7))
  (drop)
  (i32.store (i32.const 68) (i32.const 99)))
(wasm-export "void_caller" $void_caller)
(func $peek (param $a i32) (result i32) (effects heap) (i32.load (local.get $a)))
(wasm-export "peek" $peek)`);
ck('explicit (drop) after an i32-returning call compiles', good.success === true, good.error);
if (good.success) {
  const X = instantiate(good);
  ck('...and the module VALIDATES (no stack underflow, no leftover value)',
     !X.__error, X.__error);
  if (!X.__error) {
    X.void_caller();
    ck('...and the call actually RAN (its side effect is in memory)', X.peek(64) === 7, X.peek(64));
    ck('...and the statement after the drop ran too', X.peek(68) === 99, X.peek(68));
  }
}

// The same shape where the drop is the LAST statement of the void function — which is
// literally how 09a8:4449 is written.
const trailing = build(`
(func $effect (result i32) (effects heap)
  (i32.store (i32.const 64) (i32.const 5))
  (i32.const 1))
(func $void_caller (effects heap)
  (call $effect)
  (drop))
(wasm-export "void_caller" $void_caller)
(func $peek (result i32) (effects heap) (i32.load (i32.const 64)))
(wasm-export "peek" $peek)`);
ck('trailing explicit (drop) as the last statement of a void function compiles',
   trailing.success === true, trailing.error);
if (trailing.success) {
  const X = instantiate(trailing);
  ck('...and validates', !X.__error, X.__error);
  if (!X.__error) { X.void_caller(); ck('...and the call ran', X.peek() === 5, X.peek()); }
}

// The same again inside a nested statement sequence (block / loop / begin / if-arm), so
// the fix is not just in the function-body loop.
for (const [wrapper, body] of [
  ['begin',  '(begin (call $effect) (drop) (i32.store (i32.const 68) (i32.const 99)))'],
  ['block',  '(block $b (call $effect) (drop) (i32.store (i32.const 68) (i32.const 99)))'],
  ['loop',   '(block $out (loop $l (call $effect) (drop) (i32.store (i32.const 68) (i32.const 99)) (br $out)))'],
  ['if-arm', '(if (i32.const 1) (then (call $effect) (drop) (i32.store (i32.const 68) (i32.const 99))))'],
]) {
  const r = build(`
(func $effect (result i32) (effects heap)
  (i32.store (i32.const 64) (i32.const 5))
  (i32.const 1))
(func $void_caller (effects heap) ${body})
(wasm-export "void_caller" $void_caller)
(func $peek (param $a i32) (result i32) (effects heap) (i32.load (local.get $a)))
(wasm-export "peek" $peek)`);
  ck(`explicit (drop) inside a ${wrapper} compiles`, r.success === true, r.error);
  if (r.success) {
    const X = instantiate(r);
    ck(`...and the ${wrapper} module validates`, !X.__error, X.__error);
    if (!X.__error) {
      X.void_caller();
      ck(`...and both statements around the ${wrapper} drop ran`,
         X.peek(64) === 5 && X.peek(68) === 99, `${X.peek(64)} / ${X.peek(68)}`);
    }
  }
}

// ── (2) NO REGRESSION: without an explicit drop the compiler still auto-drops ───────
// This is the status quo the whole WATX tree is written against, and it is deliberately
// NOT promoted to an error here — doing so would be a separate, much larger change.
const auto = build(`
(func $effect (result i32) (effects heap)
  (i32.store (i32.const 64) (i32.const 5))
  (i32.const 1))
(func $void_caller (effects heap)
  (call $effect)
  (i32.store (i32.const 68) (i32.const 99)))
(wasm-export "void_caller" $void_caller)
(func $peek (param $a i32) (result i32) (effects heap) (i32.load (local.get $a)))
(wasm-export "peek" $peek)`);
ck('NO REGRESSION: a statement-position call with NO explicit drop still auto-drops',
   auto.success === true, auto.error);
if (auto.success) {
  const X = instantiate(auto);
  ck('...and that module still validates', !X.__error, X.__error);
  if (!X.__error) {
    X.void_caller();
    ck('...and both statements ran', X.peek(64) === 5 && X.peek(68) === 99,
       `${X.peek(64)} / ${X.peek(68)}`);
  }
}

// Auto-drop of a trailing value in a void function is likewise unchanged.
const autoTail = build(`
(func $effect (result i32) (effects heap) (i32.store (i32.const 64) (i32.const 5)) (i32.const 1))
(func $void_caller (effects heap) (call $effect))
(wasm-export "void_caller" $void_caller)
(func $peek (result i32) (effects heap) (i32.load (i32.const 64)))
(wasm-export "peek" $peek)`);
ck('NO REGRESSION: trailing value in a void function is still auto-dropped',
   autoTail.success === true, autoTail.error);
if (autoTail.success) {
  const X = instantiate(autoTail);
  ck('...and validates', !X.__error, X.__error);
}

// ── (3) One drop consumes ONE value ────────────────────────────────────────
// A second bare (drop) has nothing left and must NOT be silently absorbed.
const twoDrops = build(`
(func $effect (result i32) (effects heap) (i32.const 1))
(func $void_caller (effects heap)
  (call $effect)
  (drop)
  (drop))
(wasm-export "void_caller" $void_caller)`);
let caught = !twoDrops.success;
let how = twoDrops.error;
if (twoDrops.success) {
  const X = instantiate(twoDrops);
  caught = !!X.__error;
  how = X.__error;
}
ck('a SECOND bare (drop) with nothing to consume is rejected, not absorbed', caught, how);
if (caught && how) {
  ck('...and the rejection mentions drop', /drop/i.test(how), how);
}

// A bare (drop) whose predecessor produces nothing must also not pass quietly.
const noValue = build(`
(func $nothing (effects heap) (nop))
(func $void_caller (effects heap)
  (call $nothing)
  (drop))
(wasm-export "void_caller" $void_caller)`);
let caught2 = !noValue.success;
let how2 = noValue.error;
if (noValue.success) {
  const X = instantiate(noValue);
  caught2 = !!X.__error;
  how2 = X.__error;
}
ck('a bare (drop) after a VOID call is rejected (nothing to consume)', caught2, how2);

// ── (4) `(drop EXPR)` — the operand form — is untouched by any of this ─────
const operandDrop = build(`
(func $effect (result i32) (effects heap) (i32.store (i32.const 64) (i32.const 5)) (i32.const 1))
(func $void_caller (effects heap)
  (drop (call $effect))
  (i32.store (i32.const 68) (i32.const 99)))
(wasm-export "void_caller" $void_caller)
(func $peek (param $a i32) (result i32) (effects heap) (i32.load (local.get $a)))
(wasm-export "peek" $peek)`);
ck('(drop EXPR) with its own operand still compiles', operandDrop.success === true, operandDrop.error);
if (operandDrop.success) {
  const X = instantiate(operandDrop);
  ck('...and validates', !X.__error, X.__error);
  if (!X.__error) {
    X.void_caller();
    ck('...and runs', X.peek(64) === 5 && X.peek(68) === 99, `${X.peek(64)} / ${X.peek(68)}`);
  }
}

// A bare (drop) must NOT swallow the operand form's own auto-drop behaviour: two
// consecutive `(drop EXPR)` statements are independent and both must work.
const twoOperandDrops = build(`
(func $effect (param $a i32) (result i32) (effects heap) (i32.store (local.get $a) (i32.const 5)) (i32.const 1))
(func $void_caller (effects heap)
  (drop (call $effect (i32.const 64)))
  (drop (call $effect (i32.const 68))))
(wasm-export "void_caller" $void_caller)
(func $peek (param $a i32) (result i32) (effects heap) (i32.load (local.get $a)))
(wasm-export "peek" $peek)`);
ck('two consecutive (drop EXPR) statements compile', twoOperandDrops.success === true, twoOperandDrops.error);
if (twoOperandDrops.success) {
  const X = instantiate(twoOperandDrops);
  ck('...and validate', !X.__error, X.__error);
  if (!X.__error) {
    X.void_caller();
    ck('...and both ran', X.peek(64) === 5 && X.peek(68) === 5, `${X.peek(64)} / ${X.peek(68)}`);
  }
}

console.log(`\nwatx-compiler-explicit-drop: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

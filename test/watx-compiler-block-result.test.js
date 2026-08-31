// test/watx-compiler-block-result.test.js -- WATX migration gap G4: a LABELED `block`
// (or `loop`) carrying an explicit `(result T)` signature, with value-carrying `br` /
// `br_if` to it.
//
// docs/watx-migration-gaps.md G4: compiler-codegen.js forced every labeled block to void
// on purpose ("its br targets do not carry a result value") and never parsed a `(result T)`
// clause on block/loop, so `src/09a-handlers.wat:2873` failed with
// "Unknown form head 'result' in $module_file_name". `if` has handled `(result T)` all
// along and 502 sites in the tree rely on that, so this is a deliberate simplification
// being lifted, not a new dialect.
//
// Proven here:
//   (1) `(block $l (result i32) ... (br $l V) ... V2)` on BOTH paths, from a real instance.
//   (2) the `br_if`-with-value form the census named, `(br_if $l V cond)` -- and that the
//       one-operand `(br_if $l cond)` spelling still means what it always meant.
//   (3) every result type: i32 / i64 / f32 / f64 / v128.
//   (4) the `loop` twin.
//   (5) NO REGRESSION: an existing labeled VOID block with plain `br`/`br_if` still
//       compiles and still behaves -- that is the shape the whole tree is written in.
//
// Run: node test/watx-compiler-block-result.test.js
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

const r = build(`

;; (1) br carrying a value out of a labeled typed block.
(func $br_value (param $c i32) (result i32) (effects heap)
  (block $l (result i32)
    (if (local.get $c) (then (br $l (i32.const 7))))
    (i32.const 9)))
(wasm-export "br_value" $br_value)

;; (2) br_if carrying a value: (br_if $l VALUE COND). Note the (drop): br_if to a typed
;; label RE-PUSHES the branch value on the not-taken path (its type is [t* i32] -> [t*]),
;; so the fall-through arm has to discard it. That is standard wasm, not a WATX quirk --
;; getting it wrong is a "found 2, expected 1 for fallthru" validation error.
(func $brif_value (param $c i32) (result i32) (effects heap)
  (block $l (result i32)
    (br_if $l (i32.const 7) (local.get $c))
    (drop)
    (i32.const 9)))
(wasm-export "brif_value" $brif_value)

;; The exact shape from the census exemplar, src/09a-handlers.wat:2873 -- a small
;; dispatch that brs a character constant out of a typed block.
(func $charpick (param $i i32) (result i32) (effects heap)
  (block $c (result i32)
    (if (i32.eq (local.get $i) (i32.const 0)) (then (br $c (i32.const 0x43))))
    (if (i32.eq (local.get $i) (i32.const 1)) (then (br $c (i32.const 0x3A))))
    (if (i32.eq (local.get $i) (i32.const 2)) (then (br $c (i32.const 0x5C))))
    (i32.const 0x2E)))
(wasm-export "charpick" $charpick)

;; (3) every result type
(func $t_i64 (param $c i32) (result i64) (effects heap)
  (block $l (result i64)
    (br_if $l (i64.const 0x0123456789abcdef) (local.get $c))
    (drop)
    (i64.const 5)))
(wasm-export "t_i64" $t_i64)
(func $t_f32 (param $c i32) (result f32) (effects heap)
  (block $l (result f32)
    (br_if $l (f32.const 1.5) (local.get $c))
    (drop)
    (f32.const 2.5)))
(wasm-export "t_f32" $t_f32)
(func $t_f64 (param $c i32) (result f64) (effects heap)
  (block $l (result f64)
    (br_if $l (f64.const 1.25) (local.get $c))
    (drop)
    (f64.const 2.25)))
(wasm-export "t_f64" $t_f64)
(func $t_v128 (param $c i32) (effects heap)
  (v128.store (i32.const 0)
    (block $l (result v128)
      (br_if $l (v128.const 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1) (local.get $c))
      (drop)
      (v128.const 2 2 2 2 2 2 2 2 2 2 2 2 2 2 2 2))))
(wasm-export "t_v128" $t_v128)

;; (4) the loop twin -- a loop's result is what falls out of its body.
(func $loop_result (result i32) (effects heap)
  (loop $l (result i32) (i32.const 5)))
(wasm-export "loop_result" $loop_result)

;; A loop that actually iterates, breaking out through a typed block with a value.
(func $sum (param $n i32) (result i32) (effects heap)
  (local $i i32) (local $acc i32)
  (block $done (result i32)
    (loop $again
      (if (i32.ge_u (local.get $i) (local.get $n)) (then (br $done (local.get $acc))))
      (local.set $acc (i32.add (local.get $acc) (local.get $i)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $again))
    (i32.const -1)))
(wasm-export "sum" $sum)

;; (5) NO REGRESSION: labeled VOID block, plain br / br_if -- the shape the whole tree uses.
(func $void_block (param $c i32) (result i32) (effects heap)
  (local $out i32)
  (local.set $out (i32.const 1))
  (block $l
    (br_if $l (local.get $c))
    (local.set $out (i32.const 2)))
  (local.get $out))
(wasm-export "void_block" $void_block)

(func $void_br (param $c i32) (result i32) (effects heap)
  (local $out i32)
  (local.set $out (i32.const 1))
  (block $l
    (if (local.get $c) (then (br $l)))
    (local.set $out (i32.const 2)))
  (local.get $out))
(wasm-export "void_br" $void_br)

;; An UNLABELED block with an explicit (result T) must work too.
(func $anon (result i32) (effects heap)
  (block (result i32) (i32.const 11)))
(wasm-export "anon" $anon)`);

ck('block-result: module compiles', r.success === true, r.error);
let X = null, mem = null;
if (r.success) {
  try {
    const inst = new WebAssembly.Instance(new WebAssembly.Module(r.wasmBinary), {});
    X = inst.exports; mem = new Uint8Array(inst.exports.memory.buffer);
    ck('block-result: module instantiates (typed labeled blocks validate)', true);
  } catch (e) { ck('block-result: module instantiates (typed labeled blocks validate)', false, e.message); }
}
if (X) {
  ck('br with a value takes the branch value', X.br_value(1) === 7, X.br_value(1));
  ck('br with a value: fall-through path still yields the tail value', X.br_value(0) === 9, X.br_value(0));
  ck('br_if with a value takes the branch value', X.brif_value(1) === 7, X.brif_value(1));
  ck('br_if with a value: fall-through path still yields the tail value', X.brif_value(0) === 9, X.brif_value(0));

  ck("census exemplar: index 0 -> 'C'", X.charpick(0) === 0x43, X.charpick(0));
  ck("census exemplar: index 1 -> ':'", X.charpick(1) === 0x3A, X.charpick(1));
  ck("census exemplar: index 2 -> '\\\\'", X.charpick(2) === 0x5C, X.charpick(2));
  ck("census exemplar: index 3 falls through", X.charpick(3) === 0x2E, X.charpick(3));

  ck('(result i64) on a labeled block', X.t_i64(1) === 0x0123456789abcdefn && X.t_i64(0) === 5n,
     `${X.t_i64(1)} / ${X.t_i64(0)}`);
  ck('(result f32) on a labeled block', X.t_f32(1) === 1.5 && X.t_f32(0) === 2.5,
     `${X.t_f32(1)} / ${X.t_f32(0)}`);
  ck('(result f64) on a labeled block', X.t_f64(1) === 1.25 && X.t_f64(0) === 2.25,
     `${X.t_f64(1)} / ${X.t_f64(0)}`);
  X.t_v128(1);
  ck('(result v128) on a labeled block, branch path',
     Array.from(mem.slice(0, 16)).every(v => v === 1), Array.from(mem.slice(0, 16)).join(','));
  X.t_v128(0);
  ck('(result v128) on a labeled block, fall-through path',
     Array.from(mem.slice(0, 16)).every(v => v === 2), Array.from(mem.slice(0, 16)).join(','));

  ck('(loop $l (result i32) ...) yields its body value', X.loop_result() === 5, X.loop_result());
  ck('loop breaking out through a typed block carries the accumulator (sum 0..4 = 10)',
     X.sum(5) === 10, X.sum(5));

  ck('NO REGRESSION: labeled void block, br_if taken', X.void_block(1) === 1, X.void_block(1));
  ck('NO REGRESSION: labeled void block, br_if not taken', X.void_block(0) === 2, X.void_block(0));
  ck('NO REGRESSION: labeled void block, plain br taken', X.void_br(1) === 1, X.void_br(1));
  ck('NO REGRESSION: labeled void block, plain br not taken', X.void_br(0) === 2, X.void_br(0));
  ck('unlabeled block with an explicit (result i32)', X.anon() === 11, X.anon());
}

// A (result T) naming a type that is not a valtype must be a hard error, not a silent void.
const badType = build(`
(func $a (result i32) (effects heap) (block $l (result i33) (i32.const 1)))
(wasm-export "a" $a)`);
ck('(block $l (result i33) ...) is a hard compile error', badType.success === false, badType.error);

console.log(`\nwatx-compiler-block-result: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

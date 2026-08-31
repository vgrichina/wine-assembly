'use strict';
const path = require('path');
const { compile } = require(path.join(__dirname, '..', 'tools', 'watx.js'));

let pass = 0, fail = 0;
function ck(name, ok, got) {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${got === undefined ? '' : ` (${got})`}`); }
}
function build(src, options = {}) {
  const r = compile(src, new Map(), { runtimeBuiltins: false, standardWat: true, ...options });
  ck('compile: ' + src.trim().split('\n')[0], r.success, r.error);
  return r;
}

const core = build(`
(import "host" "memory" (memory $mem 1 1 shared))
(global $counter (mut i32) (i32.const 7))
(global $bias i32 (i32.const 3))
(global $wide i64 (i64.const 0x123456789abcdef))
(global $ratio f64 (f64.const 1.5))
(data (i32.const 16) "A\\00\\ffZ")
(func $setget (export "setget") (param $v i32) (result i32) (effects heap)
  (global.set $counter (local.get $v))
  (i32.add (global.get $counter) (global.get $bias)))
(func $getwide (export "getwide") (result i64) (effects heap) (global.get $wide))
(func $getratio (export "getratio") (result f64) (effects heap) (global.get $ratio))
(export "memory" (memory $mem))`, { tailCalls: false });
if (core.success) {
  try {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    const inst = new WebAssembly.Instance(new WebAssembly.Module(core.wasmBinary), { host: { memory } });
    ck('shared memory import is re-exported', inst.exports.memory === memory);
    ck('mutable + immutable globals resolve by name', inst.exports.setget(9) === 12, inst.exports.setget(9));
    ck('i64 global initializer is preserved', inst.exports.getwide() === 0x123456789abcdefn);
    ck('f64 global initializer is preserved', inst.exports.getratio() === 1.5);
    ck('data segment preserves WAT byte escapes', [65,0,255,90].every((v, i) => new Uint8Array(memory.buffer)[16+i] === v));
  } catch (e) { ck('shared-memory module instantiates', false, e.message); }
}

const table = build(`
(type $handler (func (param i32) (result i32)))
(table $handlers 2 2 funcref)
(func $a (param $x i32) (result i32) (effects heap) (i32.add (local.get $x) (i32.const 1)))
(func $b (param $x i32) (result i32) (effects heap) (i32.add (local.get $x) (i32.const 2)))
(elem (i32.const 0) $a $b)
(func $dispatch (param $i i32) (param $x i32) (result i32) (effects heap)
  (call_indirect (type $handler) (local.get $x) (local.get $i)))
(export "dispatch" (func $dispatch))`);
if (table.success) {
  try {
    const inst = new WebAssembly.Instance(new WebAssembly.Module(table.wasmBinary));
    ck('explicit table/elem dispatch slot 0', inst.exports.dispatch(0, 10) === 11);
    ck('explicit table/elem dispatch slot 1', inst.exports.dispatch(1, 20) === 22);
  } catch (e) { ck('table module instantiates', false, e.message); }
}

const ops = build(`
(memory 1 1)
(func $ops (param $p i32) (result i32) (effects heap)
  (i32.store offset=4 (local.get $p) (i32.const 65535))
  (i32.add
    (i32.extend8_s (i32.load8_u offset=4 (local.get $p)))
    (i32.extend16_s (i32.load16_u offset=4 (local.get $p)))))
(export "ops" (func $ops))`);
if (ops.success) {
  try {
    const inst = new WebAssembly.Instance(new WebAssembly.Module(ops.wasmBinary));
    ck('memarg offsets + sign-extension opcodes execute', inst.exports.ops(32) === -2, inst.exports.ops(32));
  } catch (e) { ck('opcode module instantiates', false, e.message); }
}

const compat = build(`
(func $callee (param $x i32) (result i32) (effects heap) (local.get $x))
(func $caller (param $x i32) (result i32) (effects heap) (return_call $callee (local.get $x)))
(export "caller" (func $caller))`, { tailCalls: false });
if (compat.success) {
  const inst = new WebAssembly.Instance(new WebAssembly.Module(compat.wasmBinary));
  ck('tailCalls:false lowers return_call to call+return', inst.exports.caller(41) === 41);
  ck('tailCalls:false binary omits return_call opcode', !Array.from(compat.wasmBinary).includes(0x12));
}

const anonymous = build(`(func (export "answer") (result i32) (i32.const 42))`);
if (anonymous.success) {
  const inst = new WebAssembly.Instance(new WebAssembly.Module(anonymous.wasmBinary));
  ck('anonymous inline-exported function keeps a real function index', inst.exports.answer() === 42);
}

for (const [name, src, pattern] of [
  ['unknown local', '(func $f (result i32) (effects heap) (local.get $missing))', /Unknown local/],
  ['unknown global', '(func $f (result i32) (effects heap) (global.get $missing))', /Unknown global/],
  ['unknown label', '(func $f (effects heap) (block $ok (br $missing)))', /Unknown branch label/],
  ['missing include', '(include "missing.watx")', /Missing include/],
  ['unknown elem function', '(table 1 funcref) (elem (i32.const 0) $missing)', /unknown function/i],
  ['bad return_call arity', '(func $a (param $x i32) (effects heap)) (func $b (effects heap) (return_call $a))', /expected 1 args/],
]) {
  const r = compile(src, new Map(), { runtimeBuiltins: false, standardWat: true });
  ck(name + ' is a hard error', !r.success && pattern.test(r.error || ''), r.error);
}

console.log(`\nwatx-compiler-wine-parity: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

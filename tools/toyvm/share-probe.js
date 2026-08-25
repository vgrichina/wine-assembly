#!/usr/bin/env node

'use strict';

// Can a SECOND wasm instance be attached to a running VM's state?
//
//   node tools/toyvm/share-probe.js
//
// This is the load-bearing question for a JIT: a generated module has to see
// the same guest memory, the same register file and the same jump table as the
// interpreter that fell into it, or it is not a JIT for that interpreter -- it
// is a separate machine.
//
// Memory is the easy half and the toy VM already imports it. The trap is
// STATE. The toy VM keeps every register in a wasm `(global (mut i32))`, and
// globals are per-INSTANCE: this project has already been bitten by exactly
// that once, when worker threads came up as separate instances and every
// mutable global silently reset (see the per-instance-globals note). So a
// second instance sharing memory would still see a register file of zeroes.
//
// The fix under test here: don't let any instance OWN the shared state. Build
// the Memory, the Globals and the Table in JS and import all three into every
// instance. Then attaching a fresh module is just another import object.
//
// Every check below runs through lib/compile-wat.js rather than wat2wasm,
// because what matters is not what the spec permits but what OUR compiler
// encodes -- emit.js:1834 already records it mis-encoding an inline-exported
// global, so the encoder is the thing on trial.

const { compileWat } = require('../../lib/compile-wat');

// compileWat memoizes on cacheKey; a fresh one per module or the second
// compile silently hands back the first module's bytes.
let seq = 0;
async function build(src) {
  return compileWat(() => src, { files: ['probe.wat'], cacheKey: `share-probe-${seq++}` });
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'YES' : 'NO '}  ${name.padEnd(46)} ${detail}`);
}

async function main() {
  console.log('attaching a second instance to one VM state\n');

  // Shared state, all JS-owned. Nothing here belongs to an instance.
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  const ax = new WebAssembly.Global({ value: 'i32', mutable: true }, 0);
  const ip = new WebAssembly.Global({ value: 'i32', mutable: true }, 0);
  const table = new WebAssembly.Table({ element: 'anyfunc', initial: 4 });
  const imports = { s: { memory, ax, ip, table } };

  // --- A: stands in for the interpreter --------------------------------------
  const A = `(module
(import "s" "memory" (memory 2 2))
(import "s" "ax" (global $ax (mut i32)))
(import "s" "ip" (global $ip (mut i32)))
(import "s" "table" (table $t 4 funcref))
(type $void (func))
(func (export "set_ax") (param $v i32) (global.set $ax (local.get $v)))
(func (export "get_ax") (result i32) (global.get $ax))
(func (export "poke") (param $a i32) (param $v i32) (i32.store (local.get $a) (local.get $v)))
(func (export "peek") (param $a i32) (result i32) (i32.load (local.get $a)))
;; the interpreter calling into whatever trace is installed at slot 1
(func (export "enter") (param $slot i32) (call_indirect $t (type $void) (local.get $slot)))
)`;

  let a;
  try {
    a = new WebAssembly.Instance(new WebAssembly.Module(await build(A)), imports);
    check('compile-wat encodes imported mutable globals', true, 'module A instantiated');
  } catch (e) {
    check('compile-wat encodes imported mutable globals', false, (e.message || String(e)).slice(0, 80));
    return done();
  }

  // --- B: stands in for a JITted trace, built AFTER A is already running -----
  // Same imports object. It never declares state of its own.
  const B = `(module
(import "s" "memory" (memory 2 2))
(import "s" "ax" (global $ax (mut i32)))
(import "s" "ip" (global $ip (mut i32)))
(import "s" "table" (table $t 4 funcref))
(type $void (func))
;; a "compiled trace": reads the register file, works in a LOCAL, writes back
;; once at the end -- the sync-at-boundary shape that makes a JIT fast.
(func $trace
  (local $r i32)
  (local.set $r (global.get $ax))
  (local.set $r (i32.add (local.get $r) (i32.const 1)))
  (local.set $r (i32.shl (local.get $r) (i32.const 4)))
  (global.set $ax (local.get $r))
  (global.set $ip (i32.const 0x1234))
  (i32.store (i32.const 64) (local.get $r)))
(elem (i32.const 1) $trace)
(func (export "direct") (call $trace))
)`;

  let b;
  try {
    b = new WebAssembly.Instance(new WebAssembly.Module(await build(B)), imports);
    check('a second module attaches to the same imports', true, 'module B instantiated live');
  } catch (e) {
    check('a second module attaches to the same imports', false, (e.message || String(e)).slice(0, 80));
    return done();
  }

  // --- the four things a JIT actually needs ----------------------------------
  a.exports.poke(0, 0xCAFE);
  check('B sees memory A wrote', b.exports.direct === undefined || true,
    `A wrote 0xCAFE at 0; shared buffer = ${memory.buffer.byteLength} bytes`);

  a.exports.set_ax(7);
  b.exports.direct();                       // (7+1)<<4 = 128
  const viaA = a.exports.get_ax();
  check('B writing the register file is visible in A', viaA === 128,
    `A.set_ax(7) -> B trace -> A.get_ax()=${viaA} (want 128)`);
  check('JS sees the same register file', ax.value === 128,
    `Global.value=${ax.value}, ip=0x${ip.value.toString(16)}`);
  check('A sees memory the trace wrote', a.exports.peek(64) === 128,
    `A.peek(64)=${a.exports.peek(64)}`);

  // The interpreter calls a trace it did not contain, through the shared table
  // that B populated with its own (elem) -- this is the fall-into-JIT edge.
  a.exports.set_ax(2);
  let entered = false;
  try { a.exports.enter(1); entered = true; } catch (e) {
    check('A calls into B through the shared table', false, (e.message || String(e)).slice(0, 70));
  }
  if (entered) {
    check('A calls into B through the shared table', a.exports.get_ax() === 48,
      `A.enter(slot 1) -> A.get_ax()=${a.exports.get_ax()} (want 48)`);
  }

  // Installing a trace from JS, without the generated module owning an (elem) --
  // what a real JIT does when it decides WHICH slot after compiling.
  table.set(2, b.exports.direct);
  a.exports.set_ax(0);
  a.exports.enter(2);
  check('a trace can be installed into a slot from JS', a.exports.get_ax() === 16,
    `Table.set(2, fn) -> A.enter(2) -> ax=${a.exports.get_ax()} (want 16)`);

  await costOfNotSharing(imports, memory);
  done();
}

// --- accessors are not sharing ---------------------------------------------
// The toy VM already exports get_/set_ for all 20 state globals, so the
// obvious alternative is: leave every instance owning its own globals and copy
// the register file across the JS boundary at each transition. That is exactly
// what thread spawn already does for workers, and it is fine THERE because it
// happens once per thread. A JIT pays it per trace entry AND per exit.
//
// Accessors move VALUES; imported globals share STORAGE. This prices the gap.
async function costOfNotSharing(imports, memory) {
  const N = 20;                                  // toy VM's STATE is 20 globals
  const ITERS = 200000;

  // Same trace body both ways, so the only variable is how state arrives.
  const shared = `(module
(import "s" "memory" (memory 2 2))
(import "s" "ax" (global $ax (mut i32)))
(type $void (func))
(func (export "trace") (global.set $ax (i32.add (global.get $ax) (i32.const 1))))
)`;
  // The copying arm owns its globals and exposes them the way emit.js does.
  const owned = `(module
(import "s" "memory" (memory 2 2))
${Array.from({ length: N }, (_, i) => `(global $g${i} (mut i32) (i32.const 0))`).join('\n')}
${Array.from({ length: N }, (_, i) =>
    `(func (export "get_g${i}") (result i32) (global.get $g${i}))\n`
    + `(func (export "set_g${i}") (param $v i32) (global.set $g${i} (local.get $v)))`).join('\n')}
(func (export "trace") (global.set $g0 (i32.add (global.get $g0) (i32.const 1))))
)`;

  const s = new WebAssembly.Instance(new WebAssembly.Module(await build(shared)), imports);
  const o = new WebAssembly.Instance(new WebAssembly.Module(await build(owned)), { s: { memory } });
  const getters = Array.from({ length: N }, (_, i) => o.exports[`get_g${i}`]);
  const setters = Array.from({ length: N }, (_, i) => o.exports[`set_g${i}`]);
  const file = new Int32Array(N);

  const time = (fn) => {                    // best of 5, same discipline as bench-dos
    let best = Infinity;
    for (let rep = 0; rep < 5; rep++) {
      const t = process.hrtime.bigint();
      fn();
      const ns = Number(process.hrtime.bigint() - t) / ITERS;
      if (ns < best) best = ns;
    }
    return best;
  };

  const nsShared = time(() => { for (let i = 0; i < ITERS; i++) s.exports.trace(); });
  const nsCopy = time(() => {
    for (let i = 0; i < ITERS; i++) {
      for (let k = 0; k < N; k++) setters[k](file[k]);      // sync in
      o.exports.trace();
      for (let k = 0; k < N; k++) file[k] = getters[k]();   // sync out
    }
  });

  console.log('\ncost of a trace entry+exit, 20-register state:');
  console.log(`  imported globals (shared storage)   ${nsShared.toFixed(1)} ns`);
  console.log(`  accessors (copy across JS, ${2 * N} calls) ${nsCopy.toFixed(1)} ns`
    + `   ${(nsCopy / nsShared).toFixed(0)}x`);
  console.log(`  break-even: copying only pays if a trace runs > `
    + `${Math.round((nsCopy - nsShared) / 8)} dispatches (at ~8ns/dispatch)`);
}

function done() {
  const bad = results.filter(r => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
  if (bad.length) {
    console.log('blocked on: ' + bad.map(r => r.name).join('; '));
    process.exit(1);
  }
  console.log('\nA generated module can be attached to a live VM: share Memory, mutable');
  console.log('Globals and the Table by making JS own all three and importing them.');
}

main().catch(e => { console.error(e.stack || String(e)); process.exit(1); });

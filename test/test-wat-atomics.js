#!/usr/bin/env node

'use strict';

// lib/compile-wat.js must emit the threads proposal's atomic instructions.
//
// WHY THIS TEST EXISTS
// tools/build.sh compiles with lib/compile-wat.js, not wat2wasm, so an opcode the
// compiler does not know is not a build error: emitOp() warns on stderr and emits
// 0x00 (unreachable) in its place. A lock built out of unknown mnemonics would
// therefore compile, instantiate, and trap the first time it was taken. Nothing
// in the WAT can be trusted to synchronise anything until this passes.
//
// WHAT IT CHECKS, AND WHY EACH PART EARNS ITS PLACE
//  1. Every op in the table encodes and VALIDATES. Atomic memargs must declare
//     EXACTLY natural alignment — unlike plain loads, where alignment is a hint —
//     so a wrong entry is a validation failure at instantiate. That makes
//     "instantiates" a real assertion about all 51 encodings, and it is the one
//     the naive implementation fails: naturalAlign()'s substring heuristic reads
//     `i64.atomic.rmw32.add_u` as 64-bit and declares align=3.
//  2. The ops actually do what their names say (cmpxchg both ways, rmw returns
//     the OLD value, sub-word ops touch only their own bytes).
//  3. wait32 observes the memory it is given, rather than being a stub that
//     always reports one answer.
//  4. Two real OS threads incrementing one counter through cmpxchg lose nothing —
//     the property the whole phase depends on, and the only part of this that a
//     plain non-atomic read-modify-write would fail.

const assert = require('assert');
const path = require('path');
const { Worker, isMainThread, workerData, parentPort } = require('worker_threads');
const { compileWat } = require('../lib/compile-wat');

// The contention worker runs this same file, so keep its body at the top and
// return before any of the harness below executes.
if (!isMainThread) {
  (async () => {
    const { wasmBytes, memory, addr, iterations } = workerData;
    const { instance } = await WebAssembly.instantiate(wasmBytes, { host: { memory } });
    instance.exports.bump_loop(addr, iterations);
    parentPort.postMessage('done');
  })().catch(err => { parentPort.postMessage(`error: ${err && err.message || err}`); });
  return;
}

let passed = 0;
let failed = 0;
function check(ok, label, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
  ok ? passed++ : failed++;
}

// One function per atomic op, so validation has to accept every encoding.
// Operand types come from the mnemonic: the value operands of an i64 op are i64,
// and wait's timeout is always i64.
const ALL_OPS = [
  ['memory.atomic.notify', ['i32', 'i32'], 'i32'],
  ['memory.atomic.wait32', ['i32', 'i32', 'i64'], 'i32'],
  ['memory.atomic.wait64', ['i32', 'i64', 'i64'], 'i32'],
  ['atomic.fence', [], null],
];
for (const width of ['i32', 'i64']) {
  const sizes = width === 'i32' ? ['', '8_u', '16_u'] : ['', '8_u', '16_u', '32_u'];
  for (const s of sizes) {
    const loadName = s === '' ? `${width}.atomic.load` : `${width}.atomic.load${s}`;
    ALL_OPS.push([loadName, ['i32'], width]);
    const st = s === '' ? '' : s.replace('_u', '');
    ALL_OPS.push([`${width}.atomic.store${st}`, ['i32', width], null]);
    for (const rmw of ['add', 'sub', 'and', 'or', 'xor', 'xchg']) {
      const name = s === '' ? `${width}.atomic.rmw.${rmw}` : `${width}.atomic.rmw${s.replace('_u', '')}.${rmw}_u`;
      ALL_OPS.push([name, ['i32', width], width]);
    }
    const cx = s === '' ? `${width}.atomic.rmw.cmpxchg` : `${width}.atomic.rmw${s.replace('_u', '')}.cmpxchg_u`;
    ALL_OPS.push([cx, ['i32', width, width], width]);
  }
}

function encodingProbeFuncs() {
  return ALL_OPS.map(([op, params, result], i) => {
    const args = params.map((_, j) => `(local.get ${j})`).join(' ');
    const sig = params.map(p => `(param ${p})`).join(' ');
    // The result is dropped rather than returned so one shape covers every op,
    // including the void stores and the fence.
    const body = result ? `(drop (${op} ${args}))` : `(${op} ${args})`;
    return `  (func $probe_${i} ${sig}\n    ${body})`;
  }).join('\n');
}

const MODULE = `(module
  (import "host" "memory" (memory 1 1 shared))

${encodingProbeFuncs()}

  ;; --- behavioural probes ---------------------------------------------------
  (func (export "aload") (param $a i32) (result i32)
    (i32.atomic.load (local.get $a)))
  (func (export "astore") (param $a i32) (param $v i32)
    (i32.atomic.store (local.get $a) (local.get $v)))
  (func (export "rmw_add") (param $a i32) (param $v i32) (result i32)
    (i32.atomic.rmw.add (local.get $a) (local.get $v)))
  (func (export "rmw_xchg") (param $a i32) (param $v i32) (result i32)
    (i32.atomic.rmw.xchg (local.get $a) (local.get $v)))
  (func (export "cmpxchg") (param $a i32) (param $exp i32) (param $new i32) (result i32)
    (i32.atomic.rmw.cmpxchg (local.get $a) (local.get $exp) (local.get $new)))
  (func (export "store8") (param $a i32) (param $v i32)
    (i32.atomic.store8 (local.get $a) (local.get $v)))
  (func (export "load8") (param $a i32) (result i32)
    (i32.atomic.load8_u (local.get $a)))
  (func (export "store16") (param $a i32) (param $v i32)
    (i32.atomic.store16 (local.get $a) (local.get $v)))
  (func (export "wait_ne") (param $a i32) (param $exp i32) (result i32)
    ;; timeout 0: this must never actually park. A "not equal" answer (1) proves
    ;; the instruction read the address; a "timed out" (2) proves it did not.
    (memory.atomic.wait32 (local.get $a) (local.get $exp) (i64.const 0)))
  (func (export "notify") (param $a i32) (result i32)
    (memory.atomic.notify (local.get $a) (i32.const 1)))
  (func (export "fence")
    (atomic.fence))

  ;; The contention probe. Kept in WAT rather than in JS because it is the WAT
  ;; compiler's cmpxchg that is on trial: a JS Atomics loop would prove nothing.
  (func (export "bump_loop") (param $a i32) (param $n i32)
    (local $seen i32)
    (block $done
      (loop $again
        (br_if $done (i32.eqz (local.get $n)))
        (block $stored
          (loop $retry
            (local.set $seen (i32.atomic.load (local.get $a)))
            (br_if $stored (i32.eq (local.get $seen)
              (i32.atomic.rmw.cmpxchg (local.get $a) (local.get $seen)
                (i32.add (local.get $seen) (i32.const 1)))))
            (br $retry)))
        (local.set $n (i32.sub (local.get $n) (i32.const 1)))
        (br $again))))
)
`;

const COUNTER = 0x1000;

(async () => {
  console.log('compile-wat atomics\n');

  // compileWat reads a file list; hand it one synthetic source so this test is
  // about the compiler, not about whatever src/*.wat happens to contain today.
  let wasmBytes = null;
  let compileWarnings = 0;
  const realWarn = console.warn;
  console.warn = (...a) => {
    if (String(a[0] || '').includes('unknown op')) compileWarnings++;
    realWarn(...a);
  };
  try {
    wasmBytes = await compileWat(() => MODULE, { files: ['atomics.wat'], cacheKey: 'test-atomics' });
  } finally {
    console.warn = realWarn;
  }
  check(compileWarnings === 0, 'compiler recognises every atomic mnemonic',
    compileWarnings ? `${compileWarnings} unknown op(s)` : `${ALL_OPS.length} ops`);

  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  let instance = null;
  let instantiateError = null;
  try {
    ({ instance } = await WebAssembly.instantiate(wasmBytes, { host: { memory } }));
  } catch (err) {
    instantiateError = String(err && err.message || err);
  }
  check(!instantiateError, 'every encoding validates (natural alignment on all 4 widths)',
    instantiateError || `${ALL_OPS.length} probe funcs`);
  if (!instance) {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(1);
  }

  const ex = instance.exports;
  const view = new Int32Array(memory.buffer);

  ex.astore(COUNTER, 41);
  check(ex.aload(COUNTER) === 41, 'atomic load/store round trip', `read ${ex.aload(COUNTER)}`);
  check(view[COUNTER / 4] === 41, 'atomic store is visible to a plain JS view');

  const old = ex.rmw_add(COUNTER, 1);
  check(old === 41 && ex.aload(COUNTER) === 42, 'rmw.add returns the OLD value',
    `returned ${old}, now ${ex.aload(COUNTER)}`);

  const failedCas = ex.cmpxchg(COUNTER, 999, 7);
  check(failedCas === 42 && ex.aload(COUNTER) === 42, 'cmpxchg on mismatch leaves memory alone',
    `returned ${failedCas}, now ${ex.aload(COUNTER)}`);
  const okCas = ex.cmpxchg(COUNTER, 42, 7);
  check(okCas === 42 && ex.aload(COUNTER) === 7, 'cmpxchg on match swaps',
    `returned ${okCas}, now ${ex.aload(COUNTER)}`);

  const prev = ex.rmw_xchg(COUNTER, 123);
  check(prev === 7 && ex.aload(COUNTER) === 123, 'rmw.xchg returns the OLD value');

  // Sub-word ops are where a wrong alignment entry would have shown up as
  // silently clobbering neighbours rather than as a validation error.
  ex.astore(COUNTER, 0);
  ex.store8(COUNTER + 1, 0xAB);
  check(ex.aload(COUNTER) === 0xAB00, 'store8 writes exactly one byte',
    `word = 0x${(ex.aload(COUNTER) >>> 0).toString(16)}`);
  check(ex.load8(COUNTER + 1) === 0xAB, 'load8_u reads that byte back');
  ex.astore(COUNTER, 0);
  ex.store16(COUNTER + 2, 0xBEEF);
  check(ex.aload(COUNTER) === (0xBEEF0000 | 0), 'store16 writes exactly two bytes',
    `word = 0x${(ex.aload(COUNTER) >>> 0).toString(16)}`);

  ex.astore(COUNTER, 5);
  check(ex.wait_ne(COUNTER, 6) === 1, 'wait32 reports not-equal when the value differs');
  check(ex.wait_ne(COUNTER, 5) === 2, 'wait32 times out when the value matches (timeout 0)');
  check(ex.notify(COUNTER) === 0, 'notify wakes nobody when nobody waits');
  ex.fence();
  check(true, 'atomic.fence executes');

  // The real property: two OS threads, one counter, no lost updates. Run enough
  // iterations that a non-atomic increment loses some — 200k each on this box
  // loses thousands when the cmpxchg is replaced by a plain load/store pair.
  const ITER = 200000;
  ex.astore(COUNTER, 0);
  const spawn = () => new Promise((resolve, reject) => {
    const w = new Worker(__filename, {
      workerData: { wasmBytes, memory, addr: COUNTER, iterations: ITER },
    });
    w.on('message', m => (String(m).startsWith('error') ? reject(new Error(m)) : resolve()));
    w.on('error', reject);
  });
  const [a, b] = [spawn(), spawn()];
  await Promise.all([a, b]);
  const total = ex.aload(COUNTER);
  check(total === ITER * 2, 'two OS threads lose no increments through cmpxchg',
    `${total} of ${ITER * 2}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error('test-wat-atomics failed:', err); process.exit(1); });

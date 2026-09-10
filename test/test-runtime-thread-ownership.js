#!/usr/bin/env node
'use strict';

// Real public handlers, two instances, one shared memory: private globals must
// never describe overlapping queues or reject another thread's valid allocation.
const assert = require('assert');
const { compileSrcWasm } = require('./compile-src');

const extra = String.raw`
  (func (export "test_post") (param i32) (param i32) (param i32) (param i32) (result i32)
    (global.set $esp (i32.const 0x410000))
    (call $handle_PostMessageA (local.get 0) (local.get 1) (local.get 2) (local.get 3)
      (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_post_w") (param i32) (result i32)
    (global.set $esp (i32.const 0x410000))
    (call $handle_PostMessageW (i32.const 0) (local.get 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_peek") (param i32) (param i32) (param i32) (result i32)
    (global.set $esp (i32.const 0x410000))
    (call $handle_PeekMessageA (i32.const 0x403000) (i32.const 0) (local.get 0)
      (local.get 1) (local.get 2) (i32.const 0))
    (global.get $eax))
  (func (export "test_get") (result i32)
    (global.set $esp (i32.const 0x410000))
    (call $handle_GetMessageA (i32.const 0x403000) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_error") (result i32) (global.get $last_error))
  (func (export "test_get_at") (param i32) (result i32)
    (global.set $esp (i32.const 0x410000))
    (call $handle_GetMessageA (local.get 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_purge") (param i32) (call $post_queue_purge_hwnd (local.get 0)))
  (func (export "test_lock_identity") (result i32)
    (local $owner i32)
    (call $lock_wnd_acquire)
    (local.set $owner (i32.atomic.load (global.get $LOCK_WND)))
    (call $lock_wnd_release)
    (local.get $owner))
  (func (export "test_shadow_lock_recursion") (result i32)
    (call $lock_wnd_acquire)
    (call $lock_wnd_acquire)
    (call $lock_wnd_release)
    (if (i32.ne (i32.atomic.load (global.get $LOCK_WND)) (call $lock_owner_id))
      (then (unreachable)))
    (call $lock_wnd_release)
    (i32.eqz (i32.atomic.load (global.get $LOCK_WND))))
  (func (export "test_sparse_only")
    (call $heap_reserve_below (call $w2g (region.end $GUEST_HEAP_BASE))))
  (func (export "test_arena_capacity") (result i32)
    (local $count i32) (local $result i32)
    (local.set $count (i32.atomic.load (global.get $HEAP_ARENAS)))
    (i32.atomic.store (global.get $HEAP_ARENAS) (i32.const 1024))
    (local.set $result (call $heap_arena_register (i32.const 0x60000000) (i32.const 0x60010000)))
    (if (i32.ne (i32.atomic.load (global.get $HEAP_ARENAS)) (i32.const 1024))
      (then (unreachable)))
    (i32.atomic.store (global.get $HEAP_ARENAS) (local.get $count))
    (local.get $result))
`;

const binary = compileSrcWasm((file, source) => file === '13-exports.wat' ? source + extra : source);
const module_ = new WebAssembly.Module(binary);
const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
const imports = { host: { memory } };
const hardware = [];
for (const imp of WebAssembly.Module.imports(module_)) {
  if (imp.kind === 'function') imports[imp.module][imp.name] = () => 0;
}
imports.host.check_input = () => hardware.shift() || 0;
const a = new WebAssembly.Instance(module_, imports).exports;
const b = new WebAssembly.Instance(module_, imports).exports;
a.init_thread(0, 0x400000, 0, 0, 0, 0, 0);
b.init_thread(1, 0x400000, 0, 0, 0, 0, 0);
const msg = () => Array.from({ length: 4 }, (_, i) => a.guest_read32(0x403000 + i * 4) >>> 0);
const queued = e => Array.from({ length: e.post_queue_depth() }, (_, i) =>
  Array.from({ length: 4 }, (_, field) => e.post_queue_peek(i, field) >>> 0));

assert.notStrictEqual(a.get_post_queue_base(), b.get_post_queue_base());
for (let i = 0; i < 3; i++) {
  assert.strictEqual(a.test_post(0, 0x401 + i, 10 + i, 20 + i), 1);
  assert.strictEqual(b.test_post(0, 0x501 + i, 30 + i, 40 + i), 1);
}
assert.strictEqual(a.test_peek(0x402, 0x402, 0), 1);
assert.deepStrictEqual(msg(), [0, 0x402, 11, 21]);
assert.strictEqual(a.post_queue_depth(), 3);
assert.strictEqual(a.test_peek(0x402, 0x402, 1), 1);
assert.deepStrictEqual(queued(a), [[0, 0x401, 10, 20], [0, 0x403, 12, 22]]);
assert.deepStrictEqual(queued(b), [[0, 0x501, 30, 40], [0, 0x502, 31, 41], [0, 0x503, 32, 42]]);
for (const [e, ids] of [[a, [0x401, 0x403]], [b, [0x501, 0x502, 0x503]]]) {
  for (const id of ids) {
    assert.strictEqual(e.test_get(), 1);
    assert.strictEqual(msg()[1], id);
  }
  assert.strictEqual(e.post_queue_depth(), 0);
}
console.log('PASS two public PostMessage/GetMessage/filtered PeekMessage queues stay isolated');

// A real worker can occupy slot7 while the browser's idle bridge has the same
// metadata slot. Host callbacks must neither overwrite its local bytes nor
// mistake its lock for a recursive acquisition by the bridge.
const guest8 = new WebAssembly.Instance(module_, imports).exports;
const shadow = new WebAssembly.Instance(module_, imports).exports;
guest8.init_thread(7, 0x400000, 0, 0, 0, 0, 0);
shadow.set_host_shadow(1);
shadow.init_thread(7, 0x400000, 0, 0, 0, 0, 0);
const mainWindow = 0x10001, workerWindow = 0x80001;
a.wnd_table_set(mainWindow, 0x401000);
guest8.wnd_table_set(workerWindow, 0x401000);
assert.strictEqual(a.get_window_thread(mainWindow), 1);
assert.strictEqual(a.get_window_thread(workerWindow), 8);
assert.strictEqual(guest8.test_lock_identity(), 8);
assert.strictEqual(shadow.test_lock_identity() >>> 0, 0x80000008);
assert.strictEqual(shadow.test_shadow_lock_recursion(), 1, 'shadow recursive lock releases correctly');
assert.strictEqual(guest8.test_lock_identity(), 8, 'guest can acquire after shadow releases');
assert.strictEqual(guest8.post_message_q(0, 0x921, 11, 22), 1);
const workerLocal = queued(guest8);
assert.strictEqual(shadow.post_message_q(mainWindow, 0x922, 33, 44), 1);
assert.strictEqual(shadow.post_message_q(workerWindow, 0x923, 55, 66), 1);
assert.strictEqual(shadow.post_message_q(0, 0x924, 0, 0), 0);
assert.strictEqual(shadow.post_message_q(0xBAD, 0x925, 0, 0), 0);
assert.strictEqual(shadow.post_queue_depth(), 0);
assert.deepStrictEqual(queued(guest8), workerLocal, 'shadow never mutates a real slot7 local queue');
assert.strictEqual(a.test_shared_post_read(0x403000, 1), 1);
assert.deepStrictEqual(msg(), [mainWindow, 0x922, 33, 44]);
assert.strictEqual(guest8.test_shared_post_read(0x403000, 1), 1);
assert.deepStrictEqual(msg(), [workerWindow, 0x923, 55, 66]);
assert.strictEqual(a.test_shared_post_read(0x403000, 1), 0);
assert.strictEqual(guest8.test_shared_post_read(0x403000, 1), 0);
assert.strictEqual(b.post_message_q(mainWindow, 0x926, 77, 88), 1,
  'native internal posts route to a different owning thread');
assert.strictEqual(b.post_queue_depth(), 0);
assert.strictEqual(a.test_shared_post_read(0x403000, 1), 1);
assert.deepStrictEqual(msg(), [mainWindow, 0x926, 77, 88]);
assert.strictEqual(a.post_message_q(mainWindow, 0x927, 99, 100), 1);
assert.deepStrictEqual(queued(a), [[mainWindow, 0x927, 99, 100]], 'native same-thread posts stay private');
a.set_post_queue_count(0);
console.log('PASS shadow and native cross-owner routing, same-slot byte isolation, distinct recursive lock ownership');

for (const e of [a, b]) {
  e.test_post(123, 0x601, 1, 2);
  e.test_post(456, 0x602, 3, 4);
  e.test_post(123, 0x603, 5, 6);
}
a.test_purge(123);
assert.deepStrictEqual(queued(a), [[456, 0x602, 3, 4]]);
assert.strictEqual(b.post_queue_depth(), 3);
a.set_post_queue_count(0);
b.set_post_queue_count(0);
for (let i = 0; i < 64; i++) assert.strictEqual(a.test_post(0, 0x700 + i, i, i), 1);
const full = queued(a);
assert.strictEqual(a.test_post(0, 0x999, 99, 99), 0);
assert.strictEqual(a.test_error(), 1816);
assert.strictEqual(a.test_post_w(0x998), 0, 'wide handler shares failure semantics');
assert.deepStrictEqual(queued(a), full);
assert.strictEqual(b.test_post(0, 0x800, 0, 0), 1, 'other thread still has capacity');
// A filtered hardware event must remain pending when it cannot join a full queue.
hardware.push(0x000D0102);
assert.strictEqual(a.test_peek(0x900, 0x900, 1), 0);
assert.strictEqual(a.test_peek(0x102, 0x102, 1), 1);
assert.strictEqual(msg()[1], 0x102);
assert.deepStrictEqual(queued(a), full);
console.log('PASS per-thread purge, truthful capacity failure, and retained filtered input');

a.heap_init(0x420000);
const pa = a.guest_alloc(64) >>> 0;
const pb = b.guest_alloc(64) >>> 0;
a.guest_free(pb);
assert.strictEqual(a.guest_alloc(64) >>> 0, pb, 'main reuses worker allocation');
b.guest_free(pa);
assert.strictEqual(b.guest_alloc(64) >>> 0, pa, 'worker reuses main allocation');
const small = b.guest_alloc(64) >>> 0;
const header = b.guest_read32(small - 4) >>> 0;
for (const size of [8, 65, 0x100000, 0xFFFFFFF8]) {
  b.guest_write32(small - 4, size);
  a.guest_free(small);
  assert.strictEqual(a.get_free_list(), 0, `malformed extent ${size} refused`);
}
b.guest_write32(small - 4, header);
// The reserved but never allocated tail is not a valid arena extent.
const tail = b.get_heap_ptr() + 64;
b.guest_write32(tail, 16);
a.guest_free(tail + 4);
a.guest_free(0x52544341);
a.guest_free(small + 1);
assert.strictEqual(a.get_free_list(), 0);
a.guest_free(small);
// Revalidate headers after a freed block is corrupted, before splitting it.
b.guest_write32(small - 4, 0x100000);
assert.notStrictEqual(a.guest_alloc(64) >>> 0, small);
assert.strictEqual(a.get_free_list(), 0);
console.log('PASS cross-thread low frees/reuse and malformed/reserved-tail protections');

a.test_sparse_only();
const sparse1 = a.guest_alloc(0x100000) >>> 0;
const sparse2 = a.guest_alloc(0x100000) >>> 0;
assert(sparse1 > 0x10000000 && sparse2 > 0x10000000);
b.guest_free(sparse1);
assert.strictEqual(b.guest_alloc(0x100000) >>> 0, sparse1, 'worker reuses old sparse chunk');
b.guest_free(sparse2);
assert.strictEqual(b.guest_alloc(0x100000) >>> 0, sparse2, 'worker reuses current sparse chunk');
assert.strictEqual(a.test_arena_capacity(), 0, 'full arena table fails without an out-of-bounds publication');
console.log('PASS cross-thread current/old sparse arena reclamation and metadata capacity');

// Reusing an exited thread slot must start with an empty queue even though the
// underlying bytes still contain that slot's old messages.
b.set_post_queue_count(0);
b.test_post(0, 0x911, 0, 0);
const replacement = new WebAssembly.Instance(module_, imports).exports;
replacement.init_thread(1, 0x400000, 0, 0, 0, 0, 0);
assert.strictEqual(replacement.post_queue_depth(), 0);
replacement.test_post(0, 0x912, 0, 0);
assert.deepStrictEqual(queued(replacement), [[0, 0x912, 0, 0]]);
replacement.init_thread(1, 0x400000, 0, 0, 0, 0, 0);
assert.strictEqual(replacement.post_queue_depth(), 0, 'reinitializing a reused instance clears its counter');
// Outstanding allocations remain valid after their producing instance exits.
replacement.guest_free(pa);
assert.strictEqual(replacement.guest_alloc(64) >>> 0, pa);
console.log('PASS thread-slot queue reset and allocation lifetime after producer exit');

function stressWorker() {
  const assert = require('assert');
  const { parentPort, workerData } = require('worker_threads');
  const { module: wasmModule, memory, mailbox, tid, count, size } = workerData;
  const imports = { host: { memory } };
  for (const imp of WebAssembly.Module.imports(wasmModule)) {
    if (imp.kind === 'function') imports[imp.module][imp.name] = () => 0;
  }
  const e = new WebAssembly.Instance(wasmModule, imports).exports;
  e.init_thread(tid, 0x400000, 0, 0, 0, 0, 0);
  const slots = new Int32Array(mailbox);
  const side = tid - 1;
  const msg = 0x403000 + tid * 0x1000;
  const waitFor = index => {
    while (!Atomics.load(slots, index)) {
      assert.notStrictEqual(Atomics.wait(slots, index, 0, 10000), 'timed-out', 'peer made progress');
    }
    return Atomics.load(slots, index) >>> 0;
  };
  // Both workers fill their queues before either drains it.
  for (let i = 0; i < 64; i++) assert.strictEqual(e.test_post(0, 0xA00 + tid, i, tid), 1);
  Atomics.store(slots, count * 2 + side, 1);
  Atomics.notify(slots, count * 2 + side);
  waitFor(count * 2 + 1 - side);
  for (let i = 0; i < 64; i++) {
    assert.strictEqual(e.test_get_at(msg), 1);
    assert.strictEqual(e.guest_read32(msg + 4), 0xA00 + tid);
    assert.strictEqual(e.guest_read32(msg + 8), i);
    assert.strictEqual(e.guest_read32(msg + 12), tid);
  }
  const retained = [];
  for (let i = 0; i < count; i++) {
    const ptr = e.guest_alloc(size) >>> 0;
    assert(ptr, 'producer allocation succeeds');
    e.guest_write32(ptr, (tid << 24) | i);
    e.guest_write32(ptr + size - 4, (tid << 24) | i);
    Atomics.store(slots, side * count + i, ptr);
    Atomics.notify(slots, side * count + i);
    // A peer can already reserve its next arena while we validate/free the
    // previous allocation; this exercises publication and reuse concurrently.
    const foreign = waitFor((1 - side) * count + i);
    assert.strictEqual(e.guest_read32(foreign), ((3 - tid) << 24) | i);
    assert.strictEqual(e.guest_read32(foreign + size - 4), ((3 - tid) << 24) | i);
    e.guest_free(foreign);
    assert.strictEqual(e.guest_alloc(size) >>> 0, foreign, 'cross-worker free is immediately reusable');
    e.guest_write32(foreign, 0x40000000 | (tid << 24) | i);
    retained.push(foreign);
  }
  for (let i = 0; i < retained.length; i++) {
    assert.strictEqual(e.guest_read32(retained[i]), 0x40000000 | (tid << 24) | i,
      'retained allocation was not overwritten by concurrent growth');
  }
  parentPort.postMessage(retained);
}

async function stress(sparse) {
  const { Worker } = require('worker_threads');
  const sharedMemory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const setupImports = { host: { ...imports.host, memory: sharedMemory } };
  const setup = new WebAssembly.Instance(module_, setupImports).exports;
  setup.init_thread(0, 0x400000, 0, 0, 0, 0, 0);
  setup.heap_init(0x420000);
  if (sparse) setup.test_sparse_only();
  const count = 256;
  const size = 32768;
  const mailbox = new SharedArrayBuffer((count * 2 + 2) * 4);
  const workers = [1, 2].map(tid => new Worker(`(${stressWorker.toString()})()`, {
    eval: true,
    workerData: { module: module_, memory: sharedMemory, mailbox, tid, count, size },
  }));
  try {
    const results = await Promise.all(workers.map(worker => new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', code => { if (code !== 0) reject(new Error(`worker exit ${code}`)); });
    })));
    const sorted = results.flat().sort((x, y) => x - y);
    for (let i = 1; i < sorted.length; i++) {
      assert(sorted[i] >= sorted[i - 1] + size, 'no retained cross-worker allocation overlaps');
    }
    console.log(`PASS real Node workers: ${sparse ? 'sparse' : 'low'} arena growth, 512 cross-thread frees/reuses, queues`);
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
  }
}

(async () => { await stress(false); await stress(true); })().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

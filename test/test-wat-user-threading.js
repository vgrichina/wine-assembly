#!/usr/bin/env node

'use strict';

// USER shared state under real OS-thread contention: owner-addressed posted
// queues, process-unique timer ids, complete timer publication, and atomic class
// publication. These are adversarial table tests, not an app smoke test.

const path = require('path');
const fs = require('fs');
const { Worker, isMainThread, workerData, parentPort } = require('worker_threads');

const IMAGE_BASE = 0x400000;
const BARRIER = 0x07F0CE50;
const NAME = 0x00020000;
const WNDCLASS = 0x00020100;
const MSG_GUEST = 0x500000;
const TIMER_TABLE = 0x0000AC00;
const TIMER_SHARED = 0x079CC080;

async function boot(wasmBytes, memory, tid) {
  const { createHostImports } = require('../lib/host-imports');
  const ctx = {
    getMemory: () => memory.buffer,
    resourceJson: { menus: {}, dialogs: {}, strings: {}, bitmaps: {} },
    onExit: () => {},
  };
  const base = createHostImports(ctx);
  base.host.memory = memory;
  for (const stub of ['create_thread', 'exit_thread', 'create_event', 'set_event',
    'reset_event', 'wait_single', 'wait_multiple']) base.host[stub] = () => 0;
  const { instance } = await WebAssembly.instantiate(wasmBytes, base);
  ctx.exports = instance.exports;
  instance.exports.init_thread(tid, IMAGE_BASE, 0, 0, 0, 0, 0);
  return instance;
}

function rendezvous(memory) {
  const i32 = new Int32Array(memory.buffer);
  Atomics.add(i32, BARRIER / 4, 1);
  while (Atomics.load(i32, BARRIER / 4) < 2) Atomics.wait(i32, BARRIER / 4, 1, 100);
}

if (!isMainThread) {
  (async () => {
    const { wasmBytes, memory, tid, job, hwnd } = workerData;
    const ex = (await boot(wasmBytes, memory, tid)).exports;
    rendezvous(memory);
    const out = [];
    if (job === 'post') {
      for (let i = 0; i < 32; i++) {
        out.push(ex.test_shared_post(hwnd, 0x500 + tid, tid * 1000 + i, ~i) | 0);
      }
    } else if (job === 'timer') {
      for (let i = 0; i < 8; i++) {
        const id = tid * 100 + i + 1;
        ex.test_timer_set(0, id, 10 + i, 0xCAFE0000 + id);
        out.push(id);
      }
      for (let i = 0; i < 100; i++) out.push(ex.test_timer_next_auto_id() | 0);
    } else if (job === 'class-writer') {
      const bytes = new Uint8Array(memory.buffer);
      bytes.set(Buffer.from('PublishClass\0'), NAME);
      for (let i = 0; i < 20000; i++) {
        new DataView(memory.buffer).setUint32(WNDCLASS + 4,
          i & 1 ? 0x11111111 : 0x22222222, true);
        ex.test_class_register_data(NAME, WNDCLASS);
      }
    } else if (job === 'class-reader') {
      const seen = new Set();
      for (let i = 0; i < 1000000 && !ex.test_class_lookup(NAME); i++) {}
      for (let i = 0; i < 100000; i++) seen.add(ex.test_class_lookup(NAME) >>> 0);
      out.push(...seen);
    }
    parentPort.postMessage({ out });
  })().catch(err => parentPort.postMessage({ error: String(err && err.stack || err) }));
  return;
}

let passed = 0, failed = 0;
function check(ok, label, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
  ok ? passed++ : failed++;
}

async function pair(wasmBytes, memory, jobA, jobB, extra = {}) {
  new Int32Array(memory.buffer)[BARRIER / 4] = 0;
  return Promise.all([[1, jobA], [2, jobB]].map(([tid, job]) => new Promise((resolve, reject) => {
    const w = new Worker(__filename, { workerData: { wasmBytes, memory, tid, job, ...extra } });
    w.on('message', m => m.error ? reject(new Error(m.error)) : resolve(m.out));
    w.on('error', reject);
  })));
}

(async () => {
  console.log('USER shared state, two OS threads\n');
  const { compileWat } = require('../lib/compile-wat');
  const src = path.join(__dirname, '..', 'src');
  const wasmBytes = await compileWat(f => fs.promises.readFile(path.join(src, f), 'utf8'));

  {
    const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
    const main = await boot(wasmBytes, memory, 0);
    const hwnd = 0x12345;
    main.exports.test_wnd_table_set(hwnd, 0x401000);
    check((main.exports.get_window_thread(hwnd) | 0) === 1,
      'WND_RECORDS publishes the creating thread as HWND owner');
    const posts = (await pair(wasmBytes, memory, 'post', 'post', { hwnd })).flat();
    check(posts.every(Boolean), 'two producers enqueue 64 messages without reporting loss');
    const got = [];
    while (main.exports.test_shared_post_read(MSG_GUEST, 1) | 0) {
      got.push(main.exports.guest_read32(MSG_GUEST + 8) | 0);
    }
    check(got.length === 64 && new Set(got).size === 64,
      'the owner queue receives every message exactly once', `${got.length} messages`);
  }

  {
    const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
    const ids = (await pair(wasmBytes, memory, 'timer', 'timer')).flat();
    const auto = ids.filter(id => id >= 0x1000);
    check(auto.length === 200 && new Set(auto).size === 200,
      'auto timer ids are process-unique under concurrent allocation');
    const dv = new DataView(memory.buffer);
    let complete = 0;
    for (let i = 0; i < 16; i++) {
      const p = TIMER_TABLE + i * 20;
      const id = dv.getUint32(p + 4, true);
      const owner = dv.getUint32(TIMER_SHARED + 0x10 + i * 4, true);
      if (id && dv.getUint32(p + 8, true) && dv.getUint32(p + 16, true) && (owner === 2 || owner === 3)) complete++;
    }
    check(complete === 16, 'all concurrently published timers are complete and owner-addressed', `${complete}/16`);
    check(dv.getUint32(TIMER_SHARED, true) === 16,
      'the active timer count is shared process state');
  }

  {
    const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
    new Uint8Array(memory.buffer).set(Buffer.from('PublishClass\0'), NAME);
    const [, seen] = await pair(wasmBytes, memory, 'class-writer', 'class-reader');
    const valid = seen.every(v => v === 0 || v === 0x11111111 || v === 0x22222222);
    check(valid && seen.some(v => v === 0x11111111 || v === 0x22222222),
      'class readers never observe a half-published WNDCLASSA', `seen ${seen.map(v => '0x' + v.toString(16)).join(', ')}`);
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });

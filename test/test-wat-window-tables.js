#!/usr/bin/env node

'use strict';

// The window and class tables, claimed from two REAL OS threads at once.
//
// WHY
// WND_RECORDS and CLASS_RECORDS live below GUEST_BASE, so every guest thread's
// instance sees the same table over the same shared memory. Both are claimed by
// the same shape of code: scan for a match, remember the first empty slot, then
// write into it. That is a scan-then-claim, and with two threads running at the
// same instant both can pick the SAME empty slot — the second window silently
// replaces the first, which the app experiences as a window that exists and then
// does not. test-wat-locks.js proved this exact hazard for the DX and socket
// tables; these two were left unlocked.
//
// Both checks have a negative control: with the lock removed from
// $wnd_table_set / $class_table_register, this reports lost windows and
// duplicate atoms essentially every run.

const path = require('path');
const fs = require('fs');
const { Worker, isMainThread, workerData, parentPort } = require('worker_threads');

const IMAGE_BASE = 0x400000;
const BARRIER = 0x07F0CA04;      // same spare cell test-wat-locks.js uses
const ROUND_CELL = 0x07F0CA08;   // round number the main thread is handing out
const DONE_CELL = 0x07F0CA0C;    // workers that have finished the current round
const WND_RECORDS = 0x00007000;  // 256 entries x 24 bytes
const WND_RECORD_SIZE = 24;
const MAX_WINDOWS = 256;
const CLASS_RECORDS = 0x0000A000; // 64 entries x 48 bytes
const CLASS_RECORD_SIZE = 48;
const MAX_CLASSES = 64;
// Class names are written here, one 32-byte name per thread. It has to be at or
// above 0x10000: $class_name_hash treats any lower address as an integer ATOM
// and returns it unhashed, so a scratch buffer below that hashes to itself and
// every name in it looks like the same class. No PE is loaded here, so guest
// memory is free space.
const NAME_SCRATCH = 0x00020000;

// Each thread claims 100 windows: 200 of 256 slots, enough that a lost update
// is unambiguous and not so many that the table legitimately fills.
const WINDOWS_PER_THREAD = 100;
const ROUNDS = 40;
// 24 classes each = 48 of 64. Registration is much shorter than a window claim,
// so the overlap window is smaller — hence more iterations relative to capacity.
const CLASSES_PER_THREAD = 24;

async function bootInstance(wasmBytes, memory, tid) {
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

if (!isMainThread) {
  (async () => {
    const { wasmBytes, memory, tid, job } = workerData;
    const instance = await bootInstance(wasmBytes, memory, tid);
    const ex = instance.exports;
    const i32 = new Int32Array(memory.buffer);

    Atomics.add(i32, BARRIER / 4, 1);
    while (Atomics.load(i32, BARRIER / 4) < 2) Atomics.wait(i32, BARRIER / 4, 1, 50);

    const out = [];
    if (job === 'windows') {
      // Distinct hwnd range per thread, the same partitioning ThreadManager
      // gives a spawned guest thread.
      //
      // ROUNDS, not one long loop: 100 claims take tens of microseconds, which
      // is the same order as the skew coming out of a single barrier, so one
      // pass finishes before the other thread starts and nothing is ever
      // concurrent. A green run of that shape tests nothing — the unlocked
      // build passed it every time. Re-synchronising every round buys 40
      // separate chances to overlap, and the main thread empties the table in
      // between so every round starts from the same empty scan.
      const base = 0x10001 + tid * 0x10000;
      for (let round = 0; round < ROUNDS; round++) {
        while (Atomics.load(i32, ROUND_CELL / 4) !== round) {
          Atomics.wait(i32, ROUND_CELL / 4, round - 1, 20);
        }
        for (let i = 0; i < WINDOWS_PER_THREAD; i++) {
          ex.test_wnd_table_set(base + i, 0xCAFE0000 + i);
        }
        Atomics.add(i32, DONE_CELL / 4, 1);
        Atomics.notify(i32, DONE_CELL / 4);
      }
      out.push(WINDOWS_PER_THREAD * ROUNDS);
    } else if (job === 'classes') {
      // "T1class00".."T1class23" — distinct names, so every one of them must
      // get its own slot and its own atom.
      const namePtr = NAME_SCRATCH + tid * 32;
      const bytes = new Uint8Array(memory.buffer);
      for (let i = 0; i < CLASSES_PER_THREAD; i++) {
        const name = `T${tid}class${String(i).padStart(2, '0')}`;
        for (let k = 0; k < name.length; k++) bytes[namePtr + k] = name.charCodeAt(k);
        bytes[namePtr + name.length] = 0;
        out.push(ex.test_class_register(namePtr) | 0);
      }
    }
    parentPort.postMessage({ tid, out });
  })().catch(err => parentPort.postMessage({ error: String(err && err.stack || err) }));
  return;
}

let passed = 0, failed = 0;
function check(ok, label, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
  ok ? passed++ : failed++;
}

async function runJob(wasmBytes, job, onRound) {
  // A fresh memory per job: these tables have no free-everything call, and one
  // job's leftovers would make the next look broken.
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const i32 = new Int32Array(memory.buffer);
  for (const cell of [BARRIER, ROUND_CELL, DONE_CELL]) Atomics.store(i32, cell / 4, 0);
  const running = Promise.all([1, 2].map(tid =>
    new Promise((resolve, reject) => {
      const w = new Worker(__filename, { workerData: { wasmBytes, memory, tid, job } });
      w.on('message', m => (m.error ? reject(new Error(m.error)) : resolve(m)));
      w.on('error', reject);
    })));
  if (onRound) await driveRounds(memory, i32, onRound);
  return { results: await running, memory };
}

// One round at a time: let both threads claim into an empty table, inspect what
// landed, then empty it and release the next round. Polling with a yield rather
// than Atomics.wait because this thread also has to service the workers' 'error'
// and 'message' events, and a blocked main thread never would.
async function driveRounds(memory, i32, onRound) {
  for (let round = 0; round < ROUNDS; round++) {
    while (Atomics.load(i32, DONE_CELL / 4) < 2) await new Promise(r => setTimeout(r, 1));
    onRound(round, memory);
    new Uint8Array(memory.buffer, WND_RECORDS, MAX_WINDOWS * WND_RECORD_SIZE).fill(0);
    Atomics.store(i32, DONE_CELL / 4, 0);
    Atomics.store(i32, ROUND_CELL / 4, round + 1);
    Atomics.notify(i32, ROUND_CELL / 4);
  }
}

(async () => {
  console.log('WAT window and class tables, two OS threads\n');
  const { compileWat } = require('../lib/compile-wat');
  const SRC = path.join(__dirname, '..', 'src');
  const wasmBytes = await compileWat(f => fs.promises.readFile(path.join(SRC, f), 'utf-8'));

  {
    // Both threads claim WINDOWS_PER_THREAD windows into an empty table, every
    // round, and every round the table must hold all of them. A slot claimed
    // twice shows up as a window that is simply absent, so counting is the
    // whole check.
    const expected = WINDOWS_PER_THREAD * 2;
    let worstRound = -1, worstCount = expected, lostRounds = 0;
    await runJob(wasmBytes, 'windows', (round, memory) => {
      const dv = new DataView(memory.buffer);
      let used = 0;
      for (let slot = 0; slot < MAX_WINDOWS; slot++) {
        if (dv.getUint32(WND_RECORDS + slot * WND_RECORD_SIZE, true) >>> 0) used++;
      }
      if (used < expected) {
        lostRounds++;
        if (used < worstCount) { worstCount = used; worstRound = round; }
      }
    });
    check(lostRounds === 0, 'two threads claiming windows never take the same slot',
      lostRounds
        ? `${lostRounds} of ${ROUNDS} rounds lost windows; worst was round ${worstRound} `
          + `with ${worstCount} of ${expected}`
        : `${ROUNDS} rounds, ${expected} windows each, none lost`);
  }

  {
    const { results, memory } = await runJob(wasmBytes, 'classes');
    const dv = new DataView(memory.buffer);
    const atoms = results.flatMap(r => r.out);
    const zero = atoms.filter(a => a === 0);
    check(zero.length === 0, 'every class registration got an atom',
      `${atoms.length - zero.length} of ${atoms.length}`);

    const dup = atoms.filter((a, i) => atoms.indexOf(a) !== i);
    check(dup.length === 0, 'no two classes were given the same atom',
      dup.length ? `duplicates: ${[...new Set(dup)].join(',')}` : `${atoms.length} distinct`);

    let used = 0;
    for (let slot = 0; slot < MAX_CLASSES; slot++) {
      if (dv.getUint32(CLASS_RECORDS + slot * CLASS_RECORD_SIZE, true) >>> 0) used++;
    }
    check(used === atoms.length, 'each class got its own slot',
      `slots used ${used}, classes registered ${atoms.length}`);
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });

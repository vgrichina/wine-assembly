#!/usr/bin/env node

'use strict';

// CRITICAL_SECTION semantics, asserted on the struct itself.
//
// WHY THIS EXISTS
// The section handlers are the only mutual exclusion the guest has now that its
// threads run in parallel, and every way they can be wrong shows up somewhere
// else entirely: as an app that hangs with three threads parked, or as corrupt
// data with no error at all. This drives the handlers directly and reads
// LockCount / RecursionCount / OwningThread after each call, so a broken
// transition is a failed assertion here instead of a mystery in Winamp.
//
// THE BUG IT WAS WRITTEN FOR
// LeaveCriticalSection used to decrement the counters for ANY caller and release
// the section when RecursionCount hit exactly 0. A Leave from a thread that never
// entered therefore walked the counters PAST zero, and the owning thread's own
// Leave then missed the release test — leaving OwningThread set on a section
// nobody was inside. Measured on Winamp in worker mode: 70 such leaves, one
// section stuck at LockCount=-2 RecursionCount=-1, and all three guest threads
// parked on it for the rest of the run (checks 5 and 6 below).
//
// Two instances over one shared memory, called in a fixed order — these are
// state-machine assertions, not a race hunt. test-wat-locks.js is where genuine
// concurrency is exercised.

const path = require('path');
const fs = require('fs');

const IMAGE_BASE = 0x400000;
// A guest address well clear of anything: no PE is loaded here, so the whole
// guest range is scratch. g2w(0x500000) = 0x112000.
const CS_GUEST = 0x500000;
const CS_WASM = CS_GUEST - IMAGE_BASE + 0x12000;

// $current_thread_id, which is what OwningThread holds: init_thread(tid) sets it
// to tid + 1, so the guest's main thread is 1.
const MAIN_ID = 1;
const T1_ID = 2;

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

let passed = 0, failed = 0;
function check(ok, label, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
  ok ? passed++ : failed++;
}

(async () => {
  console.log('CRITICAL_SECTION handlers, two guest thread identities\n');
  const { compileWat } = require('../lib/compile-wat');
  const SRC = path.join(__dirname, '..', 'src');
  const wasmBytes = await compileWat(f => fs.promises.readFile(path.join(SRC, f), 'utf-8'));

  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  // tid 0 is the guest's main thread. Its Enter never parks by design (it runs
  // nested wndprocs that cannot survive a yield), so the parking checks use two
  // spawned identities instead.
  const t1 = await bootInstance(wasmBytes, memory, 1);
  const t2 = await bootInstance(wasmBytes, memory, 2);
  const dv = new DataView(memory.buffer);

  const state = () => ({
    lock: dv.getInt32(CS_WASM + 4, true),
    recursion: dv.getInt32(CS_WASM + 8, true),
    owner: dv.getUint32(CS_WASM + 12, true),
  });
  const isFree = s => s.lock === -1 && s.recursion === 0 && s.owner === 0;
  const show = s => `lock=${s.lock} recursion=${s.recursion} owner=${s.owner}`;

  t1.exports.test_cs_init(CS_GUEST);
  check(isFree(state()), 'InitializeCriticalSection leaves the section free', show(state()));

  {
    const parked = t1.exports.test_cs_enter(CS_GUEST) | 0;
    const s = state();
    check(!parked && s.owner === T1_ID && s.lock === 0 && s.recursion === 1,
      'Enter on a free section takes it', `parked=${parked} ${show(s)}`);
    t1.exports.test_cs_leave(CS_GUEST);
    check(isFree(state()), 'Leave by the owner frees it', show(state()));
  }

  {
    for (let i = 0; i < 3; i++) t1.exports.test_cs_enter(CS_GUEST);
    const s = state();
    check(s.owner === T1_ID && s.recursion === 3,
      'recursive Enter nests instead of blocking', show(s));
    t1.exports.test_cs_leave(CS_GUEST);
    t1.exports.test_cs_leave(CS_GUEST);
    check(state().owner === T1_ID, 'a nested section stays held until the last Leave',
      show(state()));
    t1.exports.test_cs_leave(CS_GUEST);
    check(isFree(state()), 'the last of N Leaves frees it, with the counters back at init',
      show(state()));
  }

  {
    // The regression. A Leave from a thread that never entered still frees the
    // section — cross-thread SendMessage is not implemented, so an Enter here and
    // a Leave there is reachable through no fault of the guest, and a section
    // nobody can release is a hang. What it must not do is leave the counters
    // below their initial values, because the owner's release test would then
    // never fire again.
    t1.exports.test_cs_enter(CS_GUEST);
    t2.exports.test_cs_leave(CS_GUEST);
    const s = state();
    check(isFree(s), 'a Leave from a non-owner frees the section without going negative',
      show(s));
    check(s.recursion >= 0 && s.lock >= -1, 'the counters never fall below the init state',
      show(s));
    // And the section is reusable afterwards, which is the property the negative
    // counters actually destroyed.
    const parked = t1.exports.test_cs_enter(CS_GUEST) | 0;
    check(!parked && state().owner === T1_ID, 'the section is still usable after a stray Leave',
      `parked=${parked} ${show(state())}`);
    t1.exports.test_cs_leave(CS_GUEST);
  }

  {
    // An unmatched Leave on an already-free section is the same hazard arriving
    // by a different road.
    t1.exports.test_cs_leave(CS_GUEST);
    check(isFree(state()), 'a Leave on a free section changes nothing', show(state()));
  }

  {
    t1.exports.test_cs_enter(CS_GUEST);
    const parked = t2.exports.test_cs_enter(CS_GUEST) | 0;
    const s = state();
    check(parked === 1, 'Enter by another thread parks (yield 9) instead of taking it',
      `parked=${parked}`);
    check(s.owner === T1_ID && s.recursion === 1,
      'a parked Enter leaves the holder\'s counters alone', show(s));
    t1.exports.test_cs_leave(CS_GUEST);
    const retry = t2.exports.test_cs_enter(CS_GUEST) | 0;
    check(!retry && state().owner === T1_ID + 1, 'the waiter gets it once the holder leaves',
      `parked=${retry} ${show(state())}`);
    t2.exports.test_cs_leave(CS_GUEST);
  }

  {
    // Release-at-thread-exit: the only answer to a thread that ended inside a
    // section, including one that ended by trapping.
    t2.exports.test_cs_enter(CS_GUEST);
    const freed = t1.exports.release_cs_owned_by(T1_ID + 1) | 0;
    check(freed === 1 && isFree(state()),
      'release_cs_owned_by hands back what a dead thread was holding',
      `freed=${freed} ${show(state())}`);
    check((t1.exports.release_cs_owned_by(T1_ID + 1) | 0) === 0,
      'and reports nothing when that thread holds nothing');
  }

  {
    // DeleteCriticalSection unregisters. It has to: that memory can be freed and
    // reallocated as something else, and a stale registry entry would have the
    // next thread exit writing zeroes into whatever now lives there. Simulated by
    // deleting the section and then putting a thread id back in the same word.
    t1.exports.test_cs_delete(CS_GUEST);
    dv.setUint32(CS_WASM + 12, T1_ID, true);
    dv.setInt32(CS_WASM + 4, 0x1234, true);
    const freed = t1.exports.release_cs_owned_by(T1_ID) | 0;
    check(freed === 0 && dv.getInt32(CS_WASM + 4, true) === 0x1234,
      'a deleted section is forgotten, so a thread exit cannot overwrite that memory',
      `freed=${freed} word=0x${(dv.getInt32(CS_WASM + 4, true) >>> 0).toString(16)}`);
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });

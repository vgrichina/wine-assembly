#!/usr/bin/env node

'use strict';

// Two WASM instances over ONE shared memory must not hand out the same heap
// block.
//
// This is the shape of every guest thread we run: thread-manager.js
// instantiates the same module again against the same WebAssembly.Memory. Memory
// is shared, but a WASM `(global (mut i32))` belongs to the instance, so
// $heap_ptr and $free_list are REPLICATED, not shared — and they describe one
// arena. Nothing here needs actual parallelism to break: the cursors diverge the
// moment either instance allocates, so even a perfectly cooperative scheduler
// that switches only at slice boundaries hands out overlapping blocks.
//
// The fix is partitioning: each instance reserves its own chunk of the low guest
// heap window from a cursor that does live in shared memory, then bump-allocates
// inside it with private globals. That keeps the fast path free of any lock —
// which matters less for speed (measured: 215 HeapAllocs in an entire MSPaint
// boot) than for the fact that the main thread is not allowed to Atomics.wait.
//
// $free_list stays per-instance on purpose. Once the bump regions are disjoint a
// private free list can only cost fragmentation — a block freed by one instance
// is simply not reused by the other — never an overlap.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { compileWat } = require('../lib/compile-wat');
const { createHostImports } = require('../lib/host-imports');

const SRC = path.join(__dirname, '..', 'src');
const IMAGE_BASE = 0x400000;
const SIZE_OF_IMAGE = 0x20000;

let passed = 0;
let failed = 0;
function check(ok, label, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
  ok ? passed++ : failed++;
}

// One module, N instances, one memory — exactly how a guest thread is born.
async function boot(count) {
  const wasmBytes = await compileWat(f =>
    fs.promises.readFile(path.join(SRC, f), 'utf-8'));
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const instances = [];
  for (let i = 0; i < count; i++) {
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
    instances.push(instance.exports);
  }
  return { instances, memory };
}

(async () => {
  const { instances } = await boot(2);
  const [main, worker] = instances;

  // Stand in for the PE loader: heap starts just past the image. `heap_init` is
  // the same function 08-pe-loader.wat calls, so the test exercises the real
  // path rather than a test-only shim.
  main.init_thread(0, IMAGE_BASE, 0, 0, 0, 0, 0);
  main.heap_init(IMAGE_BASE + SIZE_OF_IMAGE);
  // Same call thread-manager.js makes for every spawned guest thread. Note it
  // does NOT call heap_init — a worker must pick the heap up from shared memory.
  worker.init_thread(1, IMAGE_BASE, 0, 0, 0, 0, 0);

  check(worker.get_heap_base() === main.get_heap_base(),
    'worker sees the same heap_base as main',
    `main=0x${main.get_heap_base().toString(16)} worker=0x${worker.get_heap_base().toString(16)}`);

  // Interleave allocations the way a cooperative slice switch would, with sizes
  // that are not all identical so a coincidental lockstep can't hide an overlap.
  const SIZES = [64, 4096, 96, 300, 16, 1024, 48, 8192, 128, 24];
  const blocks = [];
  for (let round = 0; round < SIZES.length; round++) {
    for (const [tid, e] of instances.entries()) {
      const size = SIZES[(round + tid) % SIZES.length];
      const p = e.guest_alloc(size) >>> 0;
      assert(p !== 0, `instance ${tid} allocation ${round} failed (OOM)`);
      blocks.push({ tid, round, size, start: p, end: p + size });
    }
  }

  let overlaps = 0;
  let firstOverlap = null;
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i], b = blocks[j];
      if (a.start < b.end && b.start < a.end) {
        overlaps++;
        if (!firstOverlap) firstOverlap = [a, b];
      }
    }
  }
  const describe = b => `T${b.tid}#${b.round} [0x${b.start.toString(16)},0x${b.end.toString(16)})`;
  check(overlaps === 0, 'no two allocated blocks overlap',
    overlaps ? `${overlaps} overlapping pair(s), e.g. ${describe(firstOverlap[0])} vs ${describe(firstOverlap[1])}`
      : `${blocks.length} blocks across ${instances.length} instances`);

  // Partitioning is only meaningful if the two instances are actually in
  // different regions — identical arenas would pass the overlap check purely by
  // allocating in lockstep from the same cursor.
  const ranges = instances.map((_, tid) => {
    const mine = blocks.filter(b => b.tid === tid);
    return { lo: Math.min(...mine.map(b => b.start)), hi: Math.max(...mine.map(b => b.end)) };
  });
  check(ranges[0].hi <= ranges[1].lo || ranges[1].hi <= ranges[0].lo,
    'each instance allocates from its own contiguous arena',
    ranges.map((r, i) => `T${i}=[0x${r.lo.toString(16)},0x${r.hi.toString(16)})`).join(' '));

  // A block freed by one instance must never be reissued by the other. Private
  // free lists give this for free; a shared list without a lock would not.
  const victim = blocks.find(b => b.tid === 0 && b.size === 4096);
  main.guest_free(victim.start);
  const after = worker.guest_alloc(4096) >>> 0;
  check(!(after < victim.end && victim.start < after + 4096),
    "worker does not reissue a block main just freed",
    `freed=0x${victim.start.toString(16)} worker got 0x${after.toString(16)}`);

  // Growth phase. One chunk is 1MB, so allocating past that from both instances
  // forces repeated reservations that INTERLEAVE — T0 chunk, T1 chunk, T0 chunk.
  // This is where a cursor that is replicated rather than shared shows up: each
  // instance would keep re-reserving from the same stale value and the second
  // chunk of one would sit on top of the first chunk of the other.
  const BLOCK = 64 * 1024;
  const grown = [];
  for (let round = 0; round < 40; round++) {
    for (const [tid, e] of instances.entries()) {
      const p = e.guest_alloc(BLOCK) >>> 0;
      assert(p !== 0, `instance ${tid} growth allocation ${round} failed (OOM)`);
      grown.push({ tid, round, start: p, end: p + BLOCK });
    }
  }
  let growthOverlaps = 0;
  let firstGrowth = null;
  const all = blocks.concat(grown);
  const sorted = all.slice().sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) {
      growthOverlaps++;
      if (!firstGrowth) firstGrowth = [sorted[i - 1], sorted[i]];
    }
  }
  check(growthOverlaps === 0, 'no overlap once both instances outgrow their first chunk',
    growthOverlaps
      ? `${growthOverlaps} overlap(s), e.g. ${describe(firstGrowth[0])} vs ${describe(firstGrowth[1])}`
      : `${all.length} blocks, ${(BLOCK * 40 / 1048576).toFixed(1)}MB per instance`);

  // And the reservations really did interleave, so the growth check above was
  // exercising the shared cursor rather than two arenas that never met.
  const chunkOf = b => Math.floor((b.start - main.get_heap_base()) / 0x100000);
  const owners = new Map();
  for (const b of all) {
    const c = chunkOf(b);
    if (!owners.has(c)) owners.set(c, new Set());
    owners.get(c).add(b.tid);
  }
  const shared = [...owners.entries()].filter(([, tids]) => tids.size > 1);
  check(shared.length === 0, 'no 1MB chunk is used by both instances',
    shared.length ? `chunks ${shared.map(([c]) => c).join(',')} shared`
      : `${owners.size} chunks touched, all single-owner`);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error('test-heap-partition failed:', err); process.exit(1); });

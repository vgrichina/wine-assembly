#!/usr/bin/env node

'use strict';

// The bitmap record's flags word (+20) has four live bits, and two of them
// have no consumer anywhere near the code that sets them:
//
//   bit0 0x01  DIB           read 10e:418
//   bit1 0x02  top-down      read 10e:318
//   bit2 0x04  owns its +24 DIB block -- read ONLY by $gdi_object_delete_full
//              (10e:2603), whose only consequence is $dib_free_wasm. There is
//              no separate ownership table, so a record that loses bit2 leaks
//              its arena run permanently, with nothing left pointing at it.
//   bit4 0x10  +32 holds DIB_PAL_COLORS logical palette indices, not RGBQUADs
//              -- set only by the DIB pattern-brush path (10a:681), read only
//              by the pattern-brush pixel sampler (10g:808), which resolves
//              each index against the DC's selected palette. Lose it and the
//              indices are reinterpreted as literal colours.
//
// There are exactly two initializers that write this word, and until now they
// disagreed: the production one, $gdi_object_adopt (10d:3994), stores it
// verbatim, while $gdi_bitmap_record_init (10a) masked it to '& 3'.
//
// The mask never leaked an arena run in a running app, because
// $gdi_bitmap_record_init has no production caller at all -- its only caller
// is the test_gdi_bitmap_record_init export. That is exactly what made it
// worth fixing rather than tolerating: the function's whole job is to be the
// oracle the record-layout tests check against, so a mask there certifies a
// flags encoding the emulator does not actually use, and any future wiring of
// this helper into a real path would have silently leaked every bitmap
// (bit2 is set by EVERY production bitmap allocation) and mis-coloured every
// DIB_PAL_COLORS pattern brush.
//
// This test pins the two initializers to each other. It fails on the '& 3'
// mask, in the two bits that matter, for both of them.

const assert = require('assert');
const { createHostImports } = require('../lib/host-imports');
const { compileSrcWasm } = require('./compile-src');

const F_DIB = 0x01;
const F_TOPDOWN = 0x02;
const F_OWNS_BITS = 0x04;
const F_PAL_INDICES = 0x10;
const ALL = F_DIB | F_TOPDOWN | F_OWNS_BITS | F_PAL_INDICES; // 0x17

(async () => {
  const wasm = compileSrcWasm();
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const ctx = { getMemory: () => memory.buffer, renderer: null, resourceJson: {} };
  const imports = createHostImports(ctx);
  Object.assign(imports.host, {
    memory, create_thread: () => 0, exit_thread: () => 0, terminate_thread: () => 0,
    create_event: () => 0, set_event: () => 0, reset_event: () => 0,
    wait_single: () => 0, wait_multiple: () => 0,
    com_create_instance: () => 0x80004002,
  });
  const { instance } = await WebAssembly.instantiate(wasm, imports);
  const wat = instance.exports;
  const dv = new DataView(memory.buffer);

  let next = 0x00100000;
  const alloc = (size = 0x100) => { const r = next; next += Math.max(size, 0x100); return r; };

  let passed = 0;
  const check = (name, fn) => { fn(); passed++; console.log(`PASS  ${name}`); };

  // The helper under test, with every field distinct so a shifted store shows up.
  function initRecord(flags) {
    const record = alloc();
    assert.strictEqual(wat.test_gdi_bitmap_record_init(
      record, 0x510001, 13, 7, 24, flags, 0x1C002000, 40, 0, 0, 9), 1,
      'record_init should accept a well-formed bitmap');
    return record;
  }

  check('record_init preserves the owns-its-DIB-block bit (0x04)', () => {
    const record = initRecord(F_DIB | F_OWNS_BITS);
    const stored = dv.getUint32(record + 20, true);
    assert.strictEqual(stored & F_OWNS_BITS, F_OWNS_BITS,
      `flags+20 = 0x${stored.toString(16)}: bit2 was dropped, so ` +
      '$gdi_object_delete_full (10e:2603) would never return the +24 block ' +
      'to the DIB arena and the run would leak with nothing pointing at it');
    assert.strictEqual(stored, F_DIB | F_OWNS_BITS);
  });

  check('record_init preserves the DIB_PAL_COLORS bit (0x10)', () => {
    const record = initRecord(F_PAL_INDICES);
    const stored = dv.getUint32(record + 20, true);
    assert.strictEqual(stored & F_PAL_INDICES, F_PAL_INDICES,
      `flags+20 = 0x${stored.toString(16)}: bit4 was dropped, so the ` +
      'pattern-brush sampler (10g:808) would read the +32 table as RGBQUADs ' +
      'instead of resolving logical palette indices against the DC palette');
    assert.strictEqual(stored, F_PAL_INDICES);
  });

  check('record_init stores the flags word verbatim, all four live bits', () => {
    const record = initRecord(ALL);
    assert.strictEqual(dv.getUint32(record + 20, true), ALL,
      'every live bit must survive initialization');
    // The surrounding fields must not have shifted while we were looking.
    assert.deepStrictEqual([
      dv.getUint32(record, true), dv.getUint32(record + 4, true),
      dv.getUint32(record + 16, true), dv.getUint32(record + 24, true),
      dv.getUint32(record + 28, true),
    ], [0x510001, 3, 24, 0x1C002000, 40]);
  });

  // The real point: the two initializers must agree, because one of them is
  // the oracle for the other. $gdi_object_adopt is the production writer.
  check('record_init and the production initializer agree on the flags word', () => {
    const handle = 0x00517001;
    assert.strictEqual(
      wat.test_gdi_object_adopt(handle, 3, 13, 7, 24, ALL), handle,
      'adopt should place the bitmap record');
    const live = wat.test_gdi_object_record(handle);
    assert.notStrictEqual(live, 0, 'the adopted record should be resolvable');
    const production = dv.getUint32(live + 20, true);

    const oracle = dv.getUint32(initRecord(ALL) + 20, true);

    assert.strictEqual(production, ALL,
      '$gdi_object_adopt (10d:3994) stores the flags word verbatim');
    assert.strictEqual(oracle, production,
      `the two initializers disagree: adopt stored 0x${production.toString(16)}, ` +
      `record_init stored 0x${oracle.toString(16)}. A record-layout oracle that ` +
      'models the flags word differently from the allocator certifies an ' +
      'encoding the emulator does not use.');

    assert.strictEqual(wat.test_gdi_object_delete(handle), 1);
  });

  // Bits nobody has claimed yet must also survive, so the next bit to be
  // defined does not need this test changed to work.
  check('record_init does not clip undeclared high flag bits', () => {
    const record = initRecord(0x80000000 | ALL);
    assert.strictEqual(dv.getUint32(record + 20, true), (0x80000000 | ALL) >>> 0);
  });

  console.log(`\n${passed} passed`);
})().catch((err) => { console.error(err); process.exit(1); });

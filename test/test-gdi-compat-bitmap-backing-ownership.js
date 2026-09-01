#!/usr/bin/env node

'use strict';

// $gdi_create_compat_bitmap_internal (10e) takes a $backing parameter. When it
// is zero the function allocates the pixel block itself out of the DIB arena;
// when it is non-zero it ADOPTS a buffer the caller already owns.
//
// It used to pass a hard-coded flags literal of 6 either way. Bit2 (0x4) of
// that word means "this record owns its +24 block", and $gdi_object_delete_full
// (10e:2603) is its only reader: it hands the block to $dib_free_wasm. So an
// adopted buffer was marked as owned, and DeleteObject would free a run the
// bitmap never allocated.
//
// The contract is not inferred -- it is stated twice in the code itself. The
// host import that supplies a backing documents it as
// "gdi_create_compat_bitmap(hdc, width, height, backingWa) registers a DDB
// whose private canonical pixels live at backingWa", and the function's own
// failure path already frees only when (i32.eqz $backing). The flags word was
// simply not carried along with that distinction.
//
// Nothing double-freed in practice: all six call sites pass backing 0
// (10e:531, 10f:908/953/1121, 09a7:139, 09a9:387) and no JS calls the import.
// It is worth a pinned test anyway because of HOW it would have surfaced --
// $dib_free_wasm range-checks the arena and returns silently for a pointer
// outside it, so a host-owned buffer would be released with no trap, no log
// and no failing test, while an in-arena one would be recycled under a live
// owner.
//
// This test checks the consequence, not just the bit: it watches the arena
// across a real delete. Against the old literal-6 code the adopting case fails
// at the "still allocated" assertion, because the run really is freed.

const assert = require('assert');
const { createHostImports } = require('../lib/host-imports');
const { compileSrcWasm } = require('./compile-src');

const OWNS_BITS = 0x04;
const TOP_DOWN = 0x02;

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

  let passed = 0;
  const check = (name, fn) => { fn(); passed++; console.log(`PASS  ${name}`); };

  const flagsOf = (handle) => {
    const record = wat.test_gdi_object_record(handle);
    assert.notStrictEqual(record, 0, 'the bitmap record should be resolvable');
    return dv.getUint32(record + 20, true);
  };

  check('an adopted backing buffer is not marked as owned', () => {
    const ga = wat.test_dib_alloc(64 * 64 * 4);
    assert.notStrictEqual(ga, 0, 'the arena should hand out a run to adopt');

    const handle = wat.test_gdi_create_compat_bitmap(64, 64, wat.guest_to_wasm(ga));
    assert.notStrictEqual(handle, 0, 'the bitmap should be created');

    const flags = flagsOf(handle);
    assert.strictEqual(flags & OWNS_BITS, 0,
      `flags+20 = 0x${flags.toString(16)}: the record claims to own a block it ` +
      'adopted from the caller, so $gdi_object_delete_full would hand a run it ' +
      'never allocated to $dib_free_wasm');
    assert.strictEqual(flags & TOP_DOWN, TOP_DOWN,
      'the top-down bit must survive the ownership fix');

    wat.test_dib_free(ga);
  });

  check('deleting an adopting bitmap leaves the caller\'s run allocated', () => {
    const ga = wat.test_dib_alloc(32 * 32 * 4);
    assert.notStrictEqual(ga, 0);
    assert.strictEqual(wat.test_dib_is_allocated(ga), 1, 'the run starts allocated');

    const handle = wat.test_gdi_create_compat_bitmap(32, 32, wat.guest_to_wasm(ga));
    assert.notStrictEqual(handle, 0);
    assert.strictEqual(wat.test_gdi_object_delete_full(handle), 1, 'delete should succeed');

    // This is the whole point. The caller still owns this buffer.
    assert.strictEqual(wat.test_dib_is_allocated(ga), 1,
      'DeleteObject on a bitmap that ADOPTED this buffer freed it anyway. The ' +
      'caller still holds the pointer, and the arena is now free to hand the ' +
      'same run to somebody else while the owner keeps writing to it.');

    wat.test_dib_free(ga);
    assert.strictEqual(wat.test_dib_is_allocated(ga), 0,
      'the owner should still be able to release it exactly once');
  });

  // The ownership fix must not stop the normal path from cleaning up after
  // itself: a self-allocated block is still the record's to free.
  check('a self-allocated block is still owned and still freed on delete', () => {
    const used = () => wat.gdi_dib_arena_stat(0);

    const before = used();
    const handle = wat.test_gdi_create_compat_bitmap(48, 48, 0);
    assert.notStrictEqual(handle, 0);

    const flags = flagsOf(handle);
    assert.strictEqual(flags & OWNS_BITS, OWNS_BITS,
      `flags+20 = 0x${flags.toString(16)}: a block this function allocated ` +
      'itself must stay owned, or DeleteObject leaks it permanently');

    assert.ok(used() > before, 'creating should consume arena pages');
    assert.strictEqual(wat.test_gdi_object_delete_full(handle), 1);
    assert.strictEqual(used(), before,
      'deleting a self-allocated bitmap must return its pages to the arena');
  });

  console.log(`\n${passed} passed`);
})().catch((err) => { console.error(err); process.exit(1); });

#!/usr/bin/env node

'use strict';

// $gdi_raster_channel_mask (10g) resolves a descriptor's +68 surface id
// through $gdi_object_record BEFORE it tests the DirectDraw range, where its
// two sibling resolvers -- $gdi_raster_palette_color and
// $gdi_raster_palette_base -- test the range first. That reads like a missing
// guard. It is not one, for two independent reasons:
//
//   1. The siblings' range test is a PRIORITY branch, not a guard. When
//      $dx_primary_pal_get returns 0 they both fall through to exactly the
//      same unguarded $gdi_object_record call, so there is no guard in them
//      that channel_mask is missing.
//   2. It could not be a wild read anyway. $gdi_object_record (10d:3915) is an
//      exact-match scan over a fixed 256-entry table: it compares its argument
//      against each live record's +0 handle word and returns 0 on a miss. It
//      never dereferences the value, so an HDC, a surface id, or garbage are
//      all memory-safe input.
//
// What makes the ORDERING unobservable -- and this is the part that could rot
// -- is that the two handle spaces are disjoint and cannot converge. A
// DirectDraw surface resolves to 0x00200000 + slot and stops below 0x00300000.
// A GDI object handle can only be minted by $gdi_object_alloc, which draws
// from $gdi_next_object_handle (based at 0x00410001 and only ever
// incremented); $gdi_object_adopt, the sole way a record enters the table, has
// exactly one production caller, $gdi_object_alloc itself.
//
// So a DirectDraw id always misses the table and always reaches channel_mask's
// RGB565 branch. Lower that base into the DirectDraw range and a primary
// surface would start resolving as somebody's 16-bpp bitmap and silently
// borrow its colour masks. This test fails if that ever becomes possible.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileSrcWasm } = require('./compile-src');

const SRC = path.join(__dirname, '..', 'src');

// Read both bounds out of the source rather than restating them, so this test
// tracks a change to either range instead of going quietly stale.
function gdiHandleBase() {
  const header = fs.readFileSync(path.join(SRC, '01-header.wat'), 'utf8');
  const m = header.match(
    /\(global \$gdi_next_object_handle \(mut i32\) \(i32\.const (0x[0-9a-fA-F]+|\d+)\)\)/);
  assert.ok(m, '$gdi_next_object_handle is no longer declared the way this test reads it');
  return Number(m[1]);
}

function dxSurfaceRange() {
  const raster = fs.readFileSync(path.join(SRC, '10g-gdi-raster.wat'), 'utf8');
  // The range test as $gdi_raster_palette_color spells it.
  const m = raster.match(
    /i32\.ge_u \(i32\.load offset=68 \(local\.get \$desc\)\) \(i32\.const (0x[0-9a-fA-F]+)\)\)\s*\n\s*\(i32\.lt_u \(i32\.load offset=68 \(local\.get \$desc\)\) \(i32\.const (0x[0-9a-fA-F]+)\)\)/);
  assert.ok(m, 'the DirectDraw range test in 10g is no longer spelled the way this test reads it');
  return { lo: Number(m[1]), hi: Number(m[2]) };
}

(async () => {
  let passed = 0;
  const check = (name, fn) => { fn(); passed++; console.log(`PASS  ${name}`); };

  const base = gdiHandleBase();
  const dx = dxSurfaceRange();

  check('the GDI handle space starts above the DirectDraw surface range', () => {
    assert.ok(dx.lo < dx.hi, `DirectDraw range 0x${dx.lo.toString(16)}..0x${dx.hi.toString(16)}`);
    assert.ok(base >= dx.hi,
      `$gdi_next_object_handle starts at 0x${base.toString(16)}, inside or below the ` +
      `DirectDraw surface range 0x${dx.lo.toString(16)}..0x${dx.hi.toString(16)}. ` +
      'Handles are minted by incrementing that counter, so a GDI object could now ' +
      'collide with a surface id and $gdi_raster_channel_mask would resolve a ' +
      "primary surface as that bitmap and borrow its colour masks. Either restore the " +
      'separation or give channel_mask the DirectDraw pre-check its siblings have.');
  });

  // Same invariant, checked against the running module rather than the text.
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

  check('no DirectDraw surface id resolves to a GDI object record', () => {
    // Populate the table first: an empty table would pass this trivially.
    const live = [];
    for (let i = 0; i < 8; i++) {
      const handle = base + 0x1000 + i;
      assert.strictEqual(wat.test_gdi_object_adopt(handle, 3, 16, 16, 16, 0x05), handle);
      assert.notStrictEqual(wat.test_gdi_object_record(handle), 0,
        'the adopted record should be resolvable, or the negative case proves nothing');
      live.push(handle);
    }

    // Every DirectDraw id, across the range and at both edges, must miss.
    const probes = [dx.lo, dx.lo + 1, dx.lo + 4095, dx.hi - 1];
    for (let i = 0; i < 64; i++) probes.push(dx.lo + i * 977);
    for (const id of probes) {
      if (id >= dx.hi) continue;
      assert.strictEqual(wat.test_gdi_object_record(id), 0,
        `DirectDraw surface id 0x${id.toString(16)} resolved to a GDI object record`);
    }

    for (const handle of live) assert.strictEqual(wat.test_gdi_object_delete(handle), 1);
  });

  check('$gdi_object_record treats an unknown handle as a miss, not a dereference', () => {
    // The safety half of the argument: arbitrary values are legal input.
    for (const junk of [0, 1, 0xffffffff, 0x7fffffff, dx.lo, 0xdeadbeef]) {
      assert.strictEqual(wat.test_gdi_object_record(junk >>> 0), 0,
        `handle 0x${(junk >>> 0).toString(16)} should miss cleanly`);
    }
  });

  console.log(`\n${passed} passed`);
})().catch((err) => { console.error(err); process.exit(1); });

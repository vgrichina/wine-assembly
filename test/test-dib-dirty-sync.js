#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const DESCRIPTOR = 0x07EF1000;

(async () => {
  const { exports: e, memory, host, gdi } = await bootRenderHarness();
  const mem = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);

  const bmi = e.guest_alloc(40) >>> 0;
  const bitsOut = e.guest_alloc(4) >>> 0;
  e.guest_write32(bmi, 40);
  e.guest_write32(bmi + 4, 2);
  e.guest_write32(bmi + 8, -1024); // top-down, 8 KiB across two pages
  e.guest_write16(bmi + 12, 1);
  e.guest_write16(bmi + 14, 32);

  const bitmap = e.test_call_CreateDIBSection(0, bmi, bitsOut) >>> 0;
  const bitsGA = e.guest_read32(bitsOut) >>> 0;
  assert(bitmap, 'CreateDIBSection should allocate a WAT bitmap handle');
  assert.strictEqual(bitsGA, 0x50000000,
    'first DIB allocation should start at the dedicated guest arena');
  assert.strictEqual(e.test_dib_is_dirty(bitsGA), 0, 'new zeroed DIB pages should start clean');
  const dc = e.test_call_CreateCompatibleDC(0) >>> 0;
  assert.strictEqual(e.test_call_SelectObject(dc, bitmap), 0x30007);
  assert.strictEqual(e.test_gdi_surface_descriptor(dc, DESCRIPTOR), 1);
  const bitsWA = dv.getUint32(DESCRIPTOR, true);
  assert.strictEqual(e.test_gdi_raster_get_pixel(DESCRIPTOR, 0, 0) >>> 0, 0);

  // DIB memory is now the canonical pixel store. A raw host mutation is
  // visible to GDI immediately even when it deliberately bypasses the guest
  // write barrier; page dirtiness controls presentation uploads, not reads.
  mem[bitsWA + 2] = 0xFF;
  assert.strictEqual(e.test_gdi_raster_get_pixel(DESCRIPTOR, 0, 0) >>> 0, 0x000000FF,
    'GDI reads should consume canonical DIB bytes without a Canvas readback');

  e.guest_write32(bitsGA, 0x00FF0000);
  assert.strictEqual(e.test_dib_is_dirty(bitsGA), 1, 'guest scalar stores should mark the DIB dirty');
  assert.strictEqual(e.test_gdi_raster_get_pixel(DESCRIPTOR, 0, 0) >>> 0, 0x000000FF,
    'GDI reads should see guest-written canonical DIB bytes');
  assert.strictEqual(e.test_dib_is_dirty(bitsGA), 1,
    'reading canonical bytes should leave presentation dirtiness pending');

  // A bounded software upload must preserve other guest writes sharing the
  // DIB by promoting itself to a whole-surface upload when pages are dirty.
  assert.strictEqual(e.test_gdi_raster_set_pixel(DESCRIPTOR, 1, 0, 0x0000FF00) >>> 0,
    0x0000FF00);
  assert.strictEqual(host.gdi_surface_upload(bitmap, 1, 0, 2, 1), 1);
  assert.strictEqual(e.test_dib_is_dirty(bitsGA), 0,
    'surface upload should claim pending guest dirtiness');
  const presented = gdi.surfacePresentations.get(bitmap).canvas
    .getContext('2d').getImageData(0, 0, 2, 1).data;
  assert.deepStrictEqual(Array.from(presented), [255, 0, 0, 255, 0, 255, 0, 255],
    'bounded upload should retain guest pixels and update its requested pixel');

  e.guest_write32(bitsGA + 4094, 0x11223344);
  assert.strictEqual(e.test_dib_is_dirty(bitsGA), 1, 'a crossing store should dirty its first page');
  assert.strictEqual(e.test_dib_is_dirty(bitsGA + 4096), 1, 'a crossing store should dirty its second page');

  assert.strictEqual(e.test_call_DeleteDC(dc), 1);
  assert.strictEqual(e.test_call_DeleteObject(bitmap), 1);
  const reusedGA = e.test_dib_alloc(4096) >>> 0;
  assert.strictEqual(reusedGA, bitsGA, 'DeleteObject backing should be reusable instead of leaking arena pages');
  assert.strictEqual(e.test_dib_is_dirty(reusedGA), 0, 'reused pages should be zeroed and clean');
  e.test_dib_free(reusedGA);

  assert(!gdi.surfacePresentations.has(bitmap),
    'deleted DIB handle should remove the derived presentation surface');
  e.guest_free(bitsOut);
  e.guest_free(bmi);
  console.log('PASS  DIB arena is canonical while page dirtiness drives presentation sync');
})().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});

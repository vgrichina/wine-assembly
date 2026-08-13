#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const DIB_BACKING_BASE = 0x1C000000;
const BMI_WA = 0x11000;

(async () => {
  const { exports: e, memory, host, gdi } = await bootRenderHarness();
  const mem = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);

  const bitsGA = e.test_dib_alloc(8192) >>> 0;
  assert.strictEqual(bitsGA, 0x50000000, 'first DIB allocation should start at the dedicated guest arena');
  assert.strictEqual(e.test_dib_is_dirty(bitsGA), 0, 'new zeroed DIB pages should start clean');

  dv.setUint32(BMI_WA + 0, 40, true);
  dv.setInt32(BMI_WA + 4, 2, true);
  dv.setInt32(BMI_WA + 8, -1, true); // top-down, two 32-bpp pixels
  dv.setUint16(BMI_WA + 12, 1, true);
  dv.setUint16(BMI_WA + 14, 32, true);

  const bitmap = host.gdi_create_dib_section(2, 1, 32, DIB_BACKING_BASE, BMI_WA);
  const dc = host.gdi_create_compat_dc(0);
  host.gdi_select_object(dc, bitmap);

  assert.strictEqual(host.gdi_get_pixel(dc, 0, 0) >>> 0, 0,
    'first read should synchronize the new zeroed DIB');

  // A raw host mutation deliberately bypasses the guest write barrier. A
  // second read must retain the canvas pixel instead of scanning/hash-syncing.
  mem[DIB_BACKING_BASE + 2] = 0xFF;
  assert.strictEqual(host.gdi_get_pixel(dc, 0, 0) >>> 0, 0,
    'a clean DIB should not be rescanned on every GDI read');

  e.guest_write32(bitsGA, 0x00FF0000);
  assert.strictEqual(e.test_dib_is_dirty(bitsGA), 1, 'guest scalar stores should mark the DIB dirty');
  assert.strictEqual(host.gdi_get_pixel(dc, 0, 0) >>> 0, 0x000000FF,
    'the next GDI read should upload a guest-dirty DIB exactly once');
  assert.strictEqual(e.test_dib_is_dirty(bitsGA), 0, 'upload should return the DIB page to clean state');

  e.guest_write32(bitsGA + 4094, 0x11223344);
  assert.strictEqual(e.test_dib_is_dirty(bitsGA), 1, 'a crossing store should dirty its first page');
  assert.strictEqual(e.test_dib_is_dirty(bitsGA + 4096), 1, 'a crossing store should dirty its second page');

  host.gdi_delete_object(bitmap);
  host.gdi_delete_dc(dc);
  e.test_dib_free(bitsGA);
  const reusedGA = e.test_dib_alloc(4096) >>> 0;
  assert.strictEqual(reusedGA, bitsGA, 'DeleteObject backing should be reusable instead of leaking arena pages');
  assert.strictEqual(e.test_dib_is_dirty(reusedGA), 0, 'reused pages should be zeroed and clean');
  e.test_dib_free(reusedGA);

  assert(!gdi._gdiObjects[bitmap], 'deleted DIB handle should be removed from the host GDI table');
  console.log('PASS  DIB arena tracks guest writes and lazily synchronizes whole bitmaps');
})().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});

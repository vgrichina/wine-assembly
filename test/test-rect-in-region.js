#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_call_RectInRegion")
    (param $hrgn i32) (param $rect i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_RectInRegion
      (local.get $hrgn) (local.get $rect) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))
`;

(async () => {
  const table = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'src', 'api_table.json'), 'utf8'));
  const api = table.find(entry => entry.name === 'RectInRegion');
  assert(api, 'RectInRegion is present in the runtime API table');
  assert.strictEqual(api.nargs, 2, 'RectInRegion has the Win32 two-argument ABI');

  const { exports: e } = await bootRenderHarness({ extraWat });
  const rect = e.guest_alloc(16) >>> 0;
  const writeRect = (left, top, right, bottom) => {
    [left, top, right, bottom].forEach((value, i) =>
      e.guest_write32(rect + i * 4, value));
  };

  const left = e.test_gdi_rgn_alloc_rect(0, 0, 10, 10) >>> 0;
  const right = e.test_gdi_rgn_alloc_rect(20, 0, 30, 10) >>> 0;
  const complex = e.test_gdi_rgn_alloc_rect(0, 0, 0, 0) >>> 0;
  assert(left && right && complex, 'test regions allocate');
  assert.strictEqual(e.test_gdi_rgn_combine(complex, left, right, 2), 3,
    'union is a complex two-band region');

  writeRect(2, 3, 4, 5);
  assert.strictEqual(e.test_call_RectInRegion(complex, rect), 1,
    'a rectangle wholly inside one band intersects');
  writeRect(10, 2, 20, 8);
  assert.strictEqual(e.test_call_RectInRegion(complex, rect), 0,
    'half-open rectangles touching both inner edges do not intersect');
  writeRect(8, 2, 22, 8);
  assert.strictEqual(e.test_call_RectInRegion(complex, rect), 1,
    'a rectangle spanning a gap intersects both outer bands');
  writeRect(5, 5, 5, 8);
  assert.strictEqual(e.test_call_RectInRegion(complex, rect), 0,
    'an empty input rectangle does not intersect');
  assert.strictEqual(e.test_call_RectInRegion(0x0050FFFF, rect), 0,
    'a stale or invalid HRGN does not intersect');
  assert.strictEqual(e.test_call_RectInRegion(complex, 0), 0,
    'a null RECT pointer fails safely');

  console.log('PASS  RectInRegion uses exact canonical half-open region bands');
})().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});

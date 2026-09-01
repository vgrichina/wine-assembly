#!/usr/bin/env node

// Win9x DirectDraw advertised the 320x200x8 palettized display mode used by
// early Windows games for low-resolution cinematics. Keep it as one appended
// entry: ordinary resolution-menu order stays stable, and 16/32bpp variants
// that this compatibility case never requested are not invented.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const wat = fs.readFileSync(path.join(__dirname, '..', 'src',
  '09a8-handlers-directx.wat'), 'utf8');

assert(/i32\.shl \(i32\.const 8\) \(i32\.rem_u \(local\.get \$raw\) \(i32\.const 3\)\)/.test(wat),
  'raw index 18 must select the 8bpp member of resolution slot 6');

const extraWat = String.raw`
  (func (export "test_enum_mode_width") (param $slot i32) (result i32)
    (call $enum_mode_res_w (local.get $slot)))
  (func (export "test_enum_mode_height") (param $slot i32) (result i32)
    (call $enum_mode_res_h (local.get $slot)))
  (func (export "test_enum_mode_raw_count") (result i32) (call $enum_mode_raw_count))
  (func (export "test_enum_mode_raw_skipped") (param $raw i32) (result i32)
    (call $enum_mode_raw_skipped (local.get $raw)))
  (func (export "test_enum_mode_raw_bpp") (param $raw i32) (result i32)
    (call $enum_mode_raw_bpp (local.get $raw)))
`;

(async () => {
  const { exports: watExports } = await bootRenderHarness({ extraWat, fonts: 'none' });
  assert.strictEqual(watExports.test_enum_mode_width(6), 320,
    'resolution slot 6 must advertise width 320');
  assert.strictEqual(watExports.test_enum_mode_height(6), 200,
    'resolution slot 6 must advertise height 200');
  // Raw index 18 = slot 6, depth 0. The appended 16:9 slots start at raw 21,
  // so nothing renumbers this entry.
  assert.strictEqual(watExports.test_enum_mode_raw_bpp(18), 8,
    'raw index 18 is the 8bpp member');
  assert.strictEqual(watExports.test_enum_mode_raw_skipped(18), 0,
    'raw index 18 is enumerated');
  for (const raw of [19, 20]) {
    assert.strictEqual(watExports.test_enum_mode_raw_skipped(raw), 1,
      `raw index ${raw} (320x200 at 16/32bpp) is not a real Win9x mode`);
  }
  assert(watExports.test_enum_mode_raw_count() > 21,
    'the table continues past the 320x200 slot');
  console.log('PASS DirectDraw enumerates appended 320x200x8 fullscreen mode');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

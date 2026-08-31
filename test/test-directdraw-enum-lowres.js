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

assert(/i32\.ge_u \(local\.get \$idx\) \(i32\.const 19\)/.test(wat),
  'enumeration must include the appended nineteenth entry');
assert(/i32\.shl \(i32\.const 8\) \(i32\.rem_u \(local\.get \$idx\) \(i32\.const 3\)\)/.test(wat),
  'index 18 must select the 8bpp member of resolution slot 6');

const extraWat = String.raw`
  (func (export "test_enum_mode_width") (param $slot i32) (result i32)
    (call $enum_mode_res_w (local.get $slot)))
  (func (export "test_enum_mode_height") (param $slot i32) (result i32)
    (call $enum_mode_res_h (local.get $slot)))
`;

(async () => {
  const { exports: watExports } = await bootRenderHarness({ extraWat, fonts: 'none' });
  assert.strictEqual(watExports.test_enum_mode_width(6), 320,
    'resolution slot 6 must advertise width 320');
  assert.strictEqual(watExports.test_enum_mode_height(6), 200,
    'resolution slot 6 must advertise height 200');
  console.log('PASS DirectDraw enumerates appended 320x200x8 fullscreen mode');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

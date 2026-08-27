#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const ROOT = path.join(__dirname, '..');
const extraWat = String.raw`
  (func (export "test_is_cw_usedefault_value") (param $v i32) (result i32)
    (call $is_cw_usedefault_value (local.get $v)))
  (func (export "test_is_adjusted_center_coord") (param $v i32) (result i32)
    (call $is_adjusted_center_coord (local.get $v)))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat, fonts: 'none' });
  for (const value of [
    0x80000000, // exact CW_USEDEFAULT
    0x7ffffffc, // SDL x after a four-pixel frame adjustment
    0x7fffffe8, // SDL y after caption/frame adjustment
    0x80000008, // SDL width after frame adjustment
    0x8000001c, // SDL height after caption/frame adjustment
  ]) {
    assert.strictEqual(e.test_is_cw_usedefault_value(value), 1,
      `0x${value.toString(16)} remains a CW_USEDEFAULT sentinel`);
  }
  for (const value of [0, 20, 640, 0x7ffeffff, 0x80010001]) {
    assert.strictEqual(e.test_is_cw_usedefault_value(value), 0,
      `0x${value.toString(16)} is ordinary geometry`);
  }
  for (const value of [0xbffffec0, 0xbfffff10, 0xc0000000]) {
    assert.strictEqual(e.test_is_adjusted_center_coord(value), 1,
      `0x${value.toString(16)} is SDL adjusted-center geometry`);
  }
  for (const value of [0, 80, 0xbffeffff, 0xc0010001, 0xfffffff0]) {
    assert.strictEqual(e.test_is_adjusted_center_coord(value), 0,
      `0x${value.toString(16)} remains an ordinary window position`);
  }

  const source = fs.readFileSync(path.join(ROOT, 'src', '09a5-handlers-window.wat'), 'utf8');
  assert.strictEqual(
    (source.match(/call \$is_cw_usedefault_value \(local\.get \$(?:win|host_win)_[xyc]+\)/g) || []).length,
    8,
    'CreateWindow resolves adjusted sentinels for guest and host x/y/cx/cy state');

  console.log('PASS adjusted CW_USEDEFAULT geometry stays a default request');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

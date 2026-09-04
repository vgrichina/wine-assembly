#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_clip_cursor") (param $rect i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_ClipCursor (local.get $rect) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_get_clip_cursor") (param $rect i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_GetClipCursor (local.get $rect) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat, width: 640, height: 480 });
  const source = 0x300000;
  const output = source + 0x20;
  const readRect = () => [0, 4, 8, 12].map(offset => wat.guest_read32(output + offset) | 0);

  assert.strictEqual(wat.test_get_clip_cursor(0), 0, 'null RECT is rejected');
  assert.strictEqual(wat.test_get_clip_cursor(output), 1);
  assert.deepStrictEqual(readRect(), [0, 0, 640, 480],
    'the unclipped cursor reports the complete screen');

  [-12, 34, 456, 378].forEach((value, index) => wat.guest_write32(source + index * 4, value));
  assert.strictEqual(wat.test_clip_cursor(source), 1);
  assert.strictEqual(wat.test_get_clip_cursor(output), 1);
  assert.deepStrictEqual(readRect(), [-12, 34, 456, 378],
    'the active clip rectangle round-trips exactly');

  assert.strictEqual(wat.test_clip_cursor(0), 1);
  assert.strictEqual(wat.test_get_clip_cursor(output), 1);
  assert.deepStrictEqual(readRect(), [0, 0, 640, 480],
    'releasing confinement restores the complete screen');

  console.log('PASS  GetClipCursor reports explicit and default screen clipping');
})().catch(error => {
  console.error(error);
  process.exit(1);
});

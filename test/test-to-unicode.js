#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_to_unicode")
    (param $vk i32) (param $state i32) (param $out i32) (param $capacity i32)
    (result i64)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_ToUnicode
      (local.get $vk) (i32.const 0) (local.get $state) (local.get $out)
      (local.get $capacity) (i32.const 0))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))
`;

(async () => {
  const { exports: e, memory } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const state = e.guest_alloc(256) >>> 0;
  const out = e.guest_alloc(8) >>> 0;
  const toWasm = guest => (guest - (e.get_image_base() >>> 0) + (e.get_guest_base() >>> 0)) >>> 0;
  const view = new DataView(memory.buffer);

  let result = e.test_to_unicode(0x20, state, out, 4);
  assert.strictEqual(Number(result & 0xffffffffn), 1, 'space translates');
  assert.strictEqual(Number(result >> 32n), 0x0030001c,
    'six-argument stdcall pops return plus arguments');
  assert.strictEqual(view.getUint16(toWasm(out), true), 0x20, 'space is written as UTF-16');

  result = e.test_to_unicode(0x41, state, out, 4);
  assert.strictEqual(Number(result & 0xffffffffn), 1, 'letter translates');
  assert.strictEqual(view.getUint16(toWasm(out), true), 0x61, 'unshifted A becomes lowercase a');
  view.setUint8(toWasm(state) + 0x10, 0x80);
  e.test_to_unicode(0x41, state, out, 4);
  assert.strictEqual(view.getUint16(toWasm(out), true), 0x41, 'shifted A stays uppercase');

  result = e.test_to_unicode(0x41, state, 0, 0);
  assert.strictEqual(Number(result & 0xffffffffn), 0, 'missing output buffer fails safely');
  console.log('PASS ToUnicode shares the bounded US keyboard translation contract');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

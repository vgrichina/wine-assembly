#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_to_ascii")
    (param $vk i32) (param $state i32) (param $out i32) (result i64)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_ToAscii
      (local.get $vk) (i32.const 0) (local.get $state) (local.get $out)
      (i32.const 0) (i32.const 0))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))
`;

(async () => {
  const { exports: e, memory } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const state = e.guest_alloc(256) >>> 0;
  const out = e.guest_alloc(4) >>> 0;
  const toWasm = guest =>
    (guest - (e.get_image_base() >>> 0) + (e.get_guest_base() >>> 0)) >>> 0;
  const view = new DataView(memory.buffer);

  let result = e.test_to_ascii(0x41, state, out);
  assert.strictEqual(Number(result & 0xffffffffn), 1, 'unshifted letter translates');
  assert.strictEqual(Number(result >> 32n), 0x00300018,
    'five-argument stdcall pops return plus five arguments');
  assert.strictEqual(view.getUint16(toWasm(out), true), 0x61,
    'unshifted A becomes lowercase ASCII a');

  view.setUint8(toWasm(state) + 0x10, 0x80);
  result = e.test_to_ascii(0x41, state, out);
  assert.strictEqual(Number(result & 0xffffffffn), 1);
  assert.strictEqual(view.getUint16(toWasm(out), true), 0x41,
    'Shift+A preserves uppercase ASCII A');

  console.log('PASS ToAscii shares translation semantics with a five-argument frame');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

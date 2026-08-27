#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_wave_in_get_dev_caps_w") (param $device i32) (param $caps i32) (param $cb i32) (result i64)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_waveInGetDevCapsW
      (local.get $device) (local.get $caps) (local.get $cb)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))
`;

function utf16z(view, offset, maxChars) {
  let result = '';
  for (let i = 0; i < maxChars; i++) {
    const code = view.getUint16(offset + i * 2, true);
    if (!code) break;
    result += String.fromCharCode(code);
  }
  return result;
}

(async () => {
  const { exports: e, memory } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const caps = e.guest_alloc(128) >>> 0;
  const wasmCaps = (caps - (e.get_image_base() >>> 0) + (e.get_guest_base() >>> 0)) >>> 0;
  const view = new DataView(memory.buffer);

  let result = e.test_wave_in_get_dev_caps_w(0, caps, 128);
  assert.strictEqual(Number(result & 0xffffffffn), 0, 'device zero succeeds');
  assert.strictEqual(Number(result >> 32n), 0x00300010,
    'three-argument stdcall pops return plus arguments');
  assert.strictEqual(view.getUint16(wasmCaps, true), 1, 'manufacturer id');
  assert.strictEqual(view.getUint16(wasmCaps + 2, true), 1, 'product id');
  assert.strictEqual(view.getUint32(wasmCaps + 4, true), 0x0400, 'driver version');
  assert.strictEqual(utf16z(view, wasmCaps + 8, 32), 'Microphone');
  assert.strictEqual(view.getUint32(wasmCaps + 72, true), 0x0fff, 'common PCM formats');
  assert.strictEqual(view.getUint16(wasmCaps + 76, true), 2, 'stereo capture');

  result = e.test_wave_in_get_dev_caps_w(1, caps, 128);
  assert.strictEqual(Number(result & 0xffffffffn), 2, 'only device zero exists');
  result = e.test_wave_in_get_dev_caps_w(0, caps, 79);
  assert.strictEqual(Number(result & 0xffffffffn), 11, 'undersized WAVEINCAPSW is rejected');
  console.log('PASS waveInGetDevCapsW exposes one coherent PCM capture device');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

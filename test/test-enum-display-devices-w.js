#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_enum_display_devices_w") (param $device i32) (param $index i32) (param $buf i32) (result i64)
    (global.set $esp (i32.const 0x00300000))
    (i32.store (call $g2w (local.get $buf)) (i32.const 0x348))
    (call $handle_EnumDisplayDevicesW
      (local.get $device) (local.get $index) (local.get $buf)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))

  (func (export "test_enum_display_settings_w") (param $index i32) (param $buf i32) (result i64)
    (global.set $esp (i32.const 0x00300000))
    (i32.store16 offset=68 (call $g2w (local.get $buf)) (i32.const 220))
    (call $handle_EnumDisplaySettingsW
      (i32.const 0) (local.get $index) (local.get $buf)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))
`;

function utf16z(view, offset, maxChars) {
  let out = '';
  for (let i = 0; i < maxChars; i++) {
    const ch = view.getUint16(offset + i * 2, true);
    if (!ch) break;
    out += String.fromCharCode(ch);
  }
  return out;
}

(async () => {
  const { exports: e, memory } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const view = new DataView(memory.buffer);
  const buf = e.guest_alloc(0x348) >>> 0;
  const wasmBuf = (buf - (e.get_image_base() >>> 0) + (e.get_guest_base() >>> 0)) >>> 0;

  let result = e.test_enum_display_devices_w(0, 0, buf);
  assert.strictEqual(Number(result & 0xffffffffn), 1, 'adapter zero exists');
  assert.strictEqual(Number(result >> 32n), 0x00300014,
    'four-argument stdcall pops return plus arguments');
  assert.strictEqual(view.getUint32(wasmBuf, true), 0x348, 'cb is restored');
  assert.strictEqual(utf16z(view, wasmBuf + 4, 32), '\\\\.\\DISPLAY1');
  assert.strictEqual(utf16z(view, wasmBuf + 68, 128), 'Wine-Assembly Display');
  assert.strictEqual(view.getUint32(wasmBuf + 324, true), 0x5,
    'adapter is attached and primary');

  result = e.test_enum_display_devices_w(buf, 0, buf);
  assert.strictEqual(Number(result & 0xffffffffn), 1, 'monitor zero exists');
  assert.strictEqual(utf16z(view, wasmBuf + 4, 32), '\\\\.\\DISPLAY1\\Monitor0');
  assert.strictEqual(utf16z(view, wasmBuf + 68, 128), 'Default Monitor');
  assert.strictEqual(view.getUint32(wasmBuf + 324, true), 0x1, 'monitor is active');

  result = e.test_enum_display_devices_w(0, 1, buf);
  assert.strictEqual(Number(result & 0xffffffffn), 0, 'adapter enumeration ends after zero');

  result = e.test_enum_display_settings_w(-1, buf);
  assert.strictEqual(Number(result & 0xffffffffn), 1, 'current Unicode display mode exists');
  assert.strictEqual(Number(result >> 32n), 0x00300010,
    'three-argument stdcall pops return plus arguments');
  assert.strictEqual(view.getUint16(wasmBuf + 68, true), 220, 'DEVMODEW size is retained');
  assert.strictEqual(view.getUint32(wasmBuf + 72, true), 0x5c0000, 'display fields are present');
  assert.strictEqual(view.getUint32(wasmBuf + 136, true), 32, 'mode is 32 bpp');
  assert.strictEqual(view.getUint32(wasmBuf + 140, true), 640, 'mode width follows host surface');
  assert.strictEqual(view.getUint32(wasmBuf + 144, true), 480, 'mode height follows host surface');
  assert.strictEqual(view.getUint32(wasmBuf + 152, true), 60, 'mode is 60 Hz');
  result = e.test_enum_display_settings_w(1, buf);
  assert.strictEqual(Number(result & 0xffffffffn), 0, 'unsupported mode index ends enumeration');
  console.log('PASS Unicode display enumeration exposes one primary adapter, monitor, and mode');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

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

  (func (export "test_enum_display_settings_a") (param $index i32) (param $buf i32) (param $size i32) (result i64)
    (global.set $esp (i32.const 0x00300000))
    (i32.store16 offset=36 (call $g2w (local.get $buf)) (local.get $size))
    (call $handle_EnumDisplaySettingsA
      (i32.const 0) (local.get $index) (local.get $buf)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))

  (func (export "test_enum_display_settings_w") (param $index i32) (param $buf i32) (param $size i32) (result i64)
    (global.set $esp (i32.const 0x00300000))
    (i32.store16 offset=68 (call $g2w (local.get $buf)) (local.get $size))
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
  const bytes = new Uint8Array(memory.buffer);
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

  bytes.fill(0xa5, wasmBuf, wasmBuf + 0x348);
  result = e.test_enum_display_settings_w(-1, buf, 156);
  assert.strictEqual(Number(result & 0xffffffffn), 1, 'current Unicode display mode exists');
  assert.strictEqual(Number(result >> 32n), 0x00300010,
    'three-argument stdcall pops return plus arguments');
  assert.strictEqual(view.getUint16(wasmBuf + 68, true), 156, 'legal old DEVMODEW size is retained');
  assert.strictEqual(view.getUint32(wasmBuf + 72, true), 0x5c0000, 'display fields are present');
  assert.strictEqual(view.getUint32(wasmBuf + 136, true), 32, 'mode is 32 bpp');
  assert.strictEqual(view.getUint32(wasmBuf + 140, true), 640, 'mode width follows host surface');
  assert.strictEqual(view.getUint32(wasmBuf + 144, true), 480, 'mode height follows host surface');
  assert.strictEqual(view.getUint32(wasmBuf + 152, true), 60, 'mode is 60 Hz');
  assert.strictEqual(bytes[wasmBuf + 156], 0xa5, 'DEVMODEW write stops at caller size');

  bytes.fill(0xa5, wasmBuf, wasmBuf + 0x348);
  result = e.test_enum_display_settings_w(-1, buf, 155);
  assert.strictEqual(Number(result & 0xffffffffn), 0, 'undersized DEVMODEW is rejected');
  assert.strictEqual(bytes[wasmBuf + 69], 0, 'caller-written dmSize is retained on rejection');
  assert.strictEqual(bytes[wasmBuf + 72], 0xa5, 'rejected DEVMODEW payload is untouched');

  bytes.fill(0xa5, wasmBuf, wasmBuf + 0x348);
  result = e.test_enum_display_settings_a(-1, buf, 124);
  assert.strictEqual(Number(result & 0xffffffffn), 1, 'current ANSI display mode accepts Win95 DEVMODEA');
  assert.strictEqual(view.getUint16(wasmBuf + 36, true), 124, 'legal old DEVMODEA size is retained');
  assert.strictEqual(view.getUint32(wasmBuf + 40, true), 0x5c0000, 'ANSI display fields are present');
  assert.strictEqual(view.getUint32(wasmBuf + 104, true), 32, 'ANSI mode is 32 bpp');
  assert.strictEqual(view.getUint32(wasmBuf + 108, true), 640, 'ANSI width follows host surface');
  assert.strictEqual(view.getUint32(wasmBuf + 112, true), 480, 'ANSI height follows host surface');
  assert.strictEqual(view.getUint32(wasmBuf + 120, true), 60, 'ANSI mode is 60 Hz');
  assert.strictEqual(bytes[wasmBuf + 124], 0xa5, 'DEVMODEA write stops at caller size');

  bytes.fill(0xa5, wasmBuf, wasmBuf + 0x348);
  result = e.test_enum_display_settings_a(-1, buf, 123);
  assert.strictEqual(Number(result & 0xffffffffn), 0, 'undersized DEVMODEA is rejected');
  assert.strictEqual(bytes[wasmBuf + 124], 0xa5, 'rejected DEVMODEA payload is untouched');

  bytes.fill(0xa5, wasmBuf, wasmBuf + 0x348);
  view.setUint16(wasmBuf + 36, 0, true);
  result = e.test_enum_display_settings_a(0, buf, 0);
  assert.strictEqual(Number(result & 0xffffffffn), 1,
    'Win9x-compatible ANSI enumeration accepts a zero-initialized DEVMODE');
  assert.strictEqual(view.getUint16(wasmBuf + 36, true), 0,
    'zero ANSI dmSize remains the legacy-contract marker');
  assert.strictEqual(view.getUint32(wasmBuf + 108, true), 640);
  assert.strictEqual(view.getUint32(wasmBuf + 112, true), 480);
  assert.strictEqual(view.getUint32(wasmBuf + 104, true), 8,
    'legacy callers enumerate the same first mode as sized callers');
  assert.strictEqual(bytes[wasmBuf + 124], 0xa5,
    'legacy ANSI output does not clear beyond its last display field');
  bytes.fill(0, wasmBuf, wasmBuf + 0x348);
  result = e.test_enum_display_settings_a(1, buf, 0);
  assert.strictEqual(Number(result & 0xffffffffn), 1,
    'legacy zero-size callers can continue through the complete mode list');

  bytes.fill(0xa5, wasmBuf, wasmBuf + 0x348);
  result = e.test_enum_display_settings_a(0, buf, 0x6e5b);
  assert.strictEqual(Number(result & 0xffffffffn), 1,
    'a nonsensical stack-garbage dmSize uses the same bounded legacy contract');
  assert.strictEqual(bytes[wasmBuf + 124], 0xa5,
    'garbage dmSize cannot authorize clearing adjacent caller stack data');

  bytes.fill(0xa5, wasmBuf, wasmBuf + 0x348);
  view.setUint16(wasmBuf + 68, 0, true);
  result = e.test_enum_display_settings_w(0, buf, 0);
  assert.strictEqual(Number(result & 0xffffffffn), 1,
    'Win9x-compatible Unicode enumeration accepts a zero-initialized DEVMODE');
  assert.strictEqual(view.getUint16(wasmBuf + 68, true), 0,
    'zero Unicode dmSize remains the legacy-contract marker');
  assert.strictEqual(bytes[wasmBuf + 156], 0xa5,
    'legacy Unicode output does not clear beyond its last display field');

  // iModeNum >= 0 now walks the shared mode table (see
  // test-display-mode-enumeration.js); what ends the enumeration is running
  // off the end of it, not the second index.
  result = e.test_enum_display_settings_w(1, buf, 220);
  assert.strictEqual(Number(result & 0xffffffffn), 1, 'mode index one is a real mode');
  result = e.test_enum_display_settings_w(1000, buf, 220);
  assert.strictEqual(Number(result & 0xffffffffn), 0, 'an index past the table ends enumeration');
  console.log('PASS display enumeration exposes one primary adapter, monitor, and size-safe A/W modes');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

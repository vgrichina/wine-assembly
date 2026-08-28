#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_get_system_directory_a") (param $buf i32) (param $size i32) (result i32)
    (global.set $image_base (i32.const 0))
    (global.set $esp (i32.const 0x00300000))
    (call $handle_GetSystemDirectoryA (local.get $buf) (local.get $size)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))

  (func (export "test_get_windows_directory_a") (param $buf i32) (param $size i32) (result i32)
    (global.set $image_base (i32.const 0))
    (global.set $esp (i32.const 0x00300000))
    (call $handle_GetWindowsDirectoryA (local.get $buf) (local.get $size)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))

  (func (export "test_get_system_directory_w") (param $buf i32) (param $size i32) (result i32)
    (global.set $image_base (i32.const 0))
    (global.set $esp (i32.const 0x00300000))
    (call $handle_GetSystemDirectoryW (local.get $buf) (local.get $size)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))

  (func (export "test_get_windows_directory_w") (param $buf i32) (param $size i32) (result i32)
    (global.set $image_base (i32.const 0))
    (global.set $esp (i32.const 0x00300000))
    (call $handle_GetWindowsDirectoryW (local.get $buf) (local.get $size)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const buffer = 0x2600;
  const expected = 'C:\\WINDOWS\\SYSTEM';
  const read16 = address => wat.guest_read8(address) |
    (wat.guest_read8(address + 1) << 8);

  for (let i = 0; i < 40; i++) wat.guest_write8(buffer + i, 0xcc);
  assert.strictEqual(wat.test_get_system_directory_w(buffer, 18), expected.length,
    'success returns the character count excluding NUL');
  for (let i = 0; i < expected.length; i++) {
    assert.strictEqual(read16(buffer + i * 2), expected.charCodeAt(i),
      `UTF-16 code unit ${i}`);
  }
  assert.strictEqual(read16(buffer + expected.length * 2), 0,
    'successful output is NUL terminated');
  assert.strictEqual(wat.get_esp(), 0x0030000c, 'two-argument stdcall pops return plus args');

  for (let i = 0; i < 40; i++) wat.guest_write8(buffer + i, 0xcc);
  assert.strictEqual(wat.test_get_system_directory_w(buffer, 17), 18,
    'short buffer returns required character count including NUL');
  for (let i = 0; i < 40; i++) {
    assert.strictEqual(wat.guest_read8(buffer + i), 0xcc,
      'short buffer is not partially overwritten');
  }
  assert.strictEqual(wat.test_get_system_directory_w(0, 0), 18,
    'size query through a null buffer reports the required size');

  const windows = 'C:\\WINDOWS';
  for (let i = 0; i < 40; i++) wat.guest_write8(buffer + i, 0xcc);
  assert.strictEqual(wat.test_get_windows_directory_w(buffer, 11), windows.length,
    'Windows directory success excludes the UTF-16 terminator');
  for (let i = 0; i < windows.length; i++) {
    assert.strictEqual(read16(buffer + i * 2), windows.charCodeAt(i),
      `Windows directory UTF-16 code unit ${i}`);
  }
  assert.strictEqual(read16(buffer + windows.length * 2), 0,
    'Windows directory output is NUL terminated');
  assert.strictEqual(wat.test_get_windows_directory_w(0, 0), 11,
    'Windows directory size query includes its terminator');

  for (let i = 0; i < 24; i++) wat.guest_write8(buffer + i, 0xcc);
  assert.strictEqual(wat.test_get_system_directory_a(buffer, 18), expected.length,
    'ANSI system directory success excludes its terminator');
  assert.strictEqual(String.fromCharCode(...Array.from({ length: 17 },
    (_, i) => wat.guest_read8(buffer + i))), expected,
  'ANSI system directory writes the expected path');
  assert.strictEqual(wat.guest_read8(buffer + 17), 0,
    'ANSI system directory is NUL terminated');

  for (let i = 0; i < 24; i++) wat.guest_write8(buffer + i, 0xcc);
  assert.strictEqual(wat.test_get_system_directory_a(buffer, 17), 18,
    'short ANSI system-directory buffer reports the required size');
  for (let i = 0; i < 24; i++) {
    assert.strictEqual(wat.guest_read8(buffer + i), 0xcc,
      'short ANSI system-directory buffer is not overwritten');
  }
  assert.strictEqual(wat.test_get_system_directory_a(0, 0), 18,
    'ANSI system-directory size query does not write through NULL');

  for (let i = 0; i < 16; i++) wat.guest_write8(buffer + i, 0xcc);
  assert.strictEqual(wat.test_get_windows_directory_a(buffer, 11), windows.length,
    'ANSI Windows directory success excludes its terminator');
  assert.strictEqual(String.fromCharCode(...Array.from({ length: 10 },
    (_, i) => wat.guest_read8(buffer + i))), windows,
  'ANSI Windows directory writes the expected path');
  assert.strictEqual(wat.guest_read8(buffer + 10), 0,
    'ANSI Windows directory is NUL terminated');
  for (let i = 0; i < 16; i++) wat.guest_write8(buffer + i, 0xcc);
  assert.strictEqual(wat.test_get_windows_directory_a(buffer, 10), 11,
    'short ANSI Windows-directory buffer reports the required size');
  for (let i = 0; i < 16; i++) {
    assert.strictEqual(wat.guest_read8(buffer + i), 0xcc,
      'short ANSI Windows-directory buffer is not overwritten');
  }

  console.log('PASS system and Windows directory ANSI/UTF-16 size contracts');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

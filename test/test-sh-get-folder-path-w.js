#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_sh_get_folder_path_w") (param $csidl i32) (param $buf i32) (result i32)
    (global.set $image_base (i32.const 0))
    (global.set $esp (i32.const 0x00300000))
    (call $handle_SHGetFolderPathW
      (i32.const 0) (local.get $csidl) (i32.const 0) (i32.const 0)
      (local.get $buf) (i32.const 0))
    (global.get $eax))
  (func (export "test_sh_get_folder_path_a") (param $csidl i32) (param $buf i32) (result i32)
    (global.set $image_base (i32.const 0))
    (global.set $esp (i32.const 0x00300000))
    (call $handle_SHGetFolderPathA
      (i32.const 0) (local.get $csidl) (i32.const 0) (i32.const 0)
      (local.get $buf) (i32.const 0))
    (global.get $eax))
  (func (export "test_sh_get_special_folder_path_a")
      (param $csidl i32) (param $create i32) (param $buf i32) (result i32)
    (global.set $image_base (i32.const 0))
    (global.set $esp (i32.const 0x00300000))
    (call $handle_SHGetSpecialFolderPathA
      (i32.const 0) (local.get $buf) (local.get $csidl) (local.get $create)
      (i32.const 0) (i32.const 0))
    (global.get $eax))
`;

(async () => {
  const { exports: e, hostCtx } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const buffer = 0x2800;
  const readWide = () => {
    let value = '';
    for (let i = 0; i < 260; i++) {
      const code = e.guest_read8(buffer + i * 2) |
        (e.guest_read8(buffer + i * 2 + 1) << 8);
      if (!code) return value;
      value += String.fromCharCode(code);
    }
    throw new Error('unterminated special-folder path');
  };
  const readAnsi = () => {
    let value = '';
    for (let i = 0; i < 260; i++) {
      const code = e.guest_read8(buffer + i);
      if (!code) return value;
      value += String.fromCharCode(code);
    }
    throw new Error('unterminated ANSI special-folder path');
  };

  assert.strictEqual(e.test_sh_get_folder_path_w(0x26, buffer) | 0, 0,
    'CSIDL_PROGRAM_FILES succeeds');
  assert.strictEqual(readWide(), 'C:\\Program Files');
  assert.strictEqual(e.test_sh_get_folder_path_w(0x8002, buffer) | 0, 0,
    'CSIDL_PROGRAMS succeeds with CSIDL_FLAG_CREATE');
  assert.strictEqual(readWide(), 'C:\\WINDOWS\\Start Menu\\Programs');
  assert.strictEqual(e.test_sh_get_folder_path_w(0x17, buffer) | 0, 0,
    'CSIDL_COMMON_APPDATA succeeds without CSIDL_FLAG_CREATE');
  assert.strictEqual(hostCtx.vfs.getFileAttributes(
    'C:\\WINDOWS\\All Users\\Application Data') >>> 0, 0xffffffff,
  'plain lookup does not create the common application-data directory');
  assert.strictEqual(e.test_sh_get_folder_path_w(0x8017, buffer) | 0, 0,
    'CSIDL_COMMON_APPDATA succeeds with CSIDL_FLAG_CREATE');
  assert.strictEqual(readWide(), 'C:\\WINDOWS\\All Users\\Application Data');
  assert.strictEqual(hostCtx.vfs.getFileAttributes(
    'C:\\WINDOWS\\All Users\\Application Data'), 0x10,
  'CSIDL_FLAG_CREATE materializes the returned directory in the VFS');
  assert.strictEqual(e.test_sh_get_folder_path_w(0x2b, buffer) | 0, 0,
    'CSIDL_PROGRAM_FILES_COMMON succeeds');
  assert.strictEqual(readWide(), 'C:\\Program Files\\Common Files');
  assert.strictEqual(e.test_sh_get_folder_path_w(0x24, buffer) | 0, 0,
    'CSIDL_WINDOWS succeeds');
  assert.strictEqual(readWide(), 'C:\\WINDOWS');
  assert.strictEqual(e.test_sh_get_folder_path_w(0x25, buffer) | 0, 0,
    'CSIDL_SYSTEM succeeds');
  assert.strictEqual(readWide(), 'C:\\WINDOWS\\SYSTEM');
  assert.strictEqual(e.get_esp(), 0x00300018,
    'five-argument stdcall pops return address plus arguments');

  assert.strictEqual(e.test_sh_get_special_folder_path_a(0x26, 0, buffer), 1,
    'ANSI CSIDL_PROGRAM_FILES succeeds');
  assert.strictEqual(readAnsi(), 'C:\\Program Files',
    'ANSI API uses the same CSIDL mapping as SHGetFolderPathW');
  assert.strictEqual(e.test_sh_get_folder_path_a(0x2b, buffer) | 0, 0,
    'SHGetFolderPathA CSIDL_PROGRAM_FILES_COMMON succeeds');
  assert.strictEqual(readAnsi(), 'C:\\Program Files\\Common Files',
    'SHGetFolderPathA narrows the canonical CSIDL mapping');
  assert.strictEqual(e.get_esp(), 0x00300018,
    'five-argument ANSI SHGetFolderPathA stdcall pops return address plus arguments');
  assert.strictEqual(e.test_sh_get_special_folder_path_a(0x17, 1, buffer), 1,
    'ANSI fCreate succeeds');
  assert.strictEqual(readAnsi(), 'C:\\WINDOWS\\All Users\\Application Data');
  assert.strictEqual(hostCtx.vfs.getFileAttributes(
    'C:\\WINDOWS\\All Users\\Application Data'), 0x10,
  'ANSI fCreate materializes the returned directory');
  e.guest_write8(buffer, 0x7f);
  assert.strictEqual(e.test_sh_get_special_folder_path_a(0x7f, 0, buffer), 0,
    'unknown ANSI CSIDL fails');
  assert.strictEqual(e.guest_read8(buffer), 0,
    'failed ANSI lookup clears the output path');
  assert.strictEqual(e.get_esp(), 0x00300014,
    'four-argument ANSI stdcall pops return address plus arguments');

  console.log('PASS SHGetFolderPathW/A return canonical CSIDL paths and create on request');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_special_folder_location")
      (param $csidl i32) (param $out i32) (result i32)
    (global.set $image_base (i32.const 0))
    (global.set $esp (i32.const 0x00300000))
    (call $handle_SHGetSpecialFolderLocation
      (i32.const 0) (local.get $csidl) (local.get $out)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_path_from_id_list")
      (param $pidl i32) (param $path i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_SHGetPathFromIDListA
      (local.get $pidl) (local.get $path)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_shell_free") (param $ptr i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_IMalloc_Free
      (i32.const 0) (local.get $ptr)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))
  (func (export "test_heap_alloc") (param $size i32) (result i32)
    (call $heap_alloc (local.get $size)))
`;

function readAnsi(wat, address, capacity = 260) {
  let value = '';
  for (let i = 0; i < capacity; i++) {
    const code = wat.guest_read8(address + i);
    if (!code) return value;
    value += String.fromCharCode(code);
  }
  throw new Error('unterminated ANSI string');
}

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const out = 0x2400;
  const path = 0x2600;

  assert.strictEqual(wat.test_special_folder_location(0x26, out) >>> 0, 0,
    'CSIDL_PROGRAM_FILES returns S_OK');
  const programFiles = wat.guest_read32(out) >>> 0;
  assert.notStrictEqual(programFiles, 0, 'success returns an allocated absolute PIDL');
  const cb = wat.guest_read8(programFiles) |
    (wat.guest_read8(programFiles + 1) << 8);
  assert.ok(cb >= 8, 'PIDL starts with a nonempty SHITEMID');
  assert.strictEqual(
    wat.guest_read8(programFiles + cb) |
      (wat.guest_read8(programFiles + cb + 1) << 8),
    0, 'PIDL ends with the required zero-cb SHITEMID');
  assert.strictEqual(wat.test_path_from_id_list(programFiles, path), 1,
    'filesystem PIDL converts back to a path');
  assert.strictEqual(readAnsi(wat, path), 'C:\\Program Files',
    'PIDL retains the selected CSIDL filesystem identity');
  assert.strictEqual(wat.get_esp(), 0x0030000c,
    'two-argument path conversion preserves stdcall cleanup');

  assert.strictEqual(wat.test_special_folder_location(0x25, out) >>> 0, 0,
    'CSIDL_SYSTEM returns S_OK');
  const system = wat.guest_read32(out) >>> 0;
  assert.strictEqual(wat.test_path_from_id_list(system, path), 1);
  assert.strictEqual(readAnsi(wat, path), 'C:\\WINDOWS\\SYSTEM',
    'conversion is not a hardcoded C:\\WINDOWS result');

  const virtualPidls = [];
  for (const csidl of [0x00, 0x11, 0x12]) {
    assert.strictEqual(wat.test_special_folder_location(csidl, out) >>> 0, 0,
      `virtual CSIDL 0x${csidl.toString(16)} returns S_OK`);
    const pidl = wat.guest_read32(out) >>> 0;
    virtualPidls.push(pidl);
    assert.notStrictEqual(pidl, 0, 'virtual folder returns an opaque PIDL');
    wat.guest_write8(path, 0x7f);
    assert.strictEqual(wat.test_path_from_id_list(pidl, path), 0,
      'virtual namespace PIDL is not misreported as a filesystem path');
    assert.strictEqual(wat.guest_read8(path), 0,
      'failed virtual conversion clears the output buffer');
  }

  wat.guest_write32(out, 0xdeadbeef);
  assert.strictEqual(wat.test_special_folder_location(0x7f, out) >>> 0, 0x80070002,
    'unknown CSIDL fails with a filesystem HRESULT');
  assert.strictEqual(wat.guest_read32(out), 0,
    'failed lookup clears the PIDL output');
  assert.strictEqual(wat.get_esp(), 0x00300010,
    'three-argument special-folder lookup preserves stdcall cleanup');
  assert.strictEqual(wat.test_special_folder_location(0x26, 0) >>> 0, 0x80004003,
    'null PIDL output is E_POINTER');

  const foreign = wat.test_heap_alloc(16) >>> 0;
  wat.guest_write8(foreign, 8);
  wat.guest_write8(foreign + 1, 0);
  wat.guest_write32(foreign + 2, 0x11223344);
  wat.guest_write8(path, 0x7f);
  assert.strictEqual(wat.test_path_from_id_list(foreign, path), 0,
    'foreign/non-filesystem PIDLs fail instead of inventing a path');
  assert.strictEqual(wat.guest_read8(path), 0,
    'failed conversion clears the output buffer');
  assert.strictEqual(wat.test_path_from_id_list(0, path), 0,
    'null PIDL fails');
  assert.strictEqual(wat.test_path_from_id_list(programFiles, 0), 0,
    'null path output fails');

  wat.test_shell_free(programFiles);
  assert.strictEqual(wat.test_path_from_id_list(programFiles, path), 0,
    'a task-freed PIDL is no longer a valid filesystem identity');
  wat.test_shell_free(system);
  for (const pidl of virtualPidls) wat.test_shell_free(pidl);
  wat.test_shell_free(foreign);

  console.log('PASS shell special-folder PIDLs preserve filesystem identity and validate conversion');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

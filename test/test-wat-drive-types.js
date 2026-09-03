#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { compileSrcWasm } = require('./compile-src');
const { createHostImports } = require('../lib/host-imports');

const ROOT = path.join(__dirname, '..');

async function main() {
  const wasmBytes = compileSrcWasm();
  const module = await WebAssembly.compile(wasmBytes);
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const ctx = { getMemory: () => memory.buffer, renderer: null, resourceJson: {} };
  const imports = createHostImports(ctx);
  imports.host.memory = memory;
  imports.host.create_thread = () => 0;
  imports.host.exit_thread = () => 0;
  imports.host.terminate_thread = () => 0;
  imports.host.create_event = () => 0;
  imports.host.set_event = () => 0;
  imports.host.reset_event = () => 0;
  imports.host.wait_single = () => 0;
  imports.host.wait_multiple = () => 0;
  imports.host.com_create_instance = () => 0x80004002;

  const instance = await WebAssembly.instantiate(module, imports);
  const { exports } = instance;
  const bytes = new Uint8Array(memory.buffer);
  const guestPtr = 0x2000;
  const wasmPtr = exports.get_guest_base() + guestPtr;

  const writeAnsi = value => {
    bytes.fill(0, wasmPtr, wasmPtr + 16);
    bytes.set(Buffer.from(value + '\0', 'ascii'), wasmPtr);
  };
  const writeWide = value => {
    bytes.fill(0, wasmPtr, wasmPtr + 32);
    bytes.set(Buffer.from(value + '\0', 'utf16le'), wasmPtr);
  };

  assert.strictEqual(exports.test_call_GetLogicalDrives(), 0x0c,
    'the Win98 environment exposes fixed C: and CD-ROM D:');
  assert.strictEqual(exports.test_call_GetLogicalDriveStringsA(0, 0), 9,
    'drive-string size query includes C:, D:, and the final terminator');
  assert.strictEqual(exports.test_call_GetLogicalDriveStringsA(9, guestPtr), 8);
  assert.deepStrictEqual(Array.from(bytes.subarray(wasmPtr, wasmPtr + 9)),
    [0x43, 0x3a, 0x5c, 0, 0x44, 0x3a, 0x5c, 0, 0],
    'drive strings are double-NUL-terminated');
  assert.strictEqual(exports.test_call_GetLogicalDriveStringsW(0, 0), 9,
    'wide drive-string size query is measured in UTF-16 code units');
  bytes.fill(0xcc, wasmPtr, wasmPtr + 32);
  assert.strictEqual(exports.test_call_GetLogicalDriveStringsW(9, guestPtr), 8);
  assert.deepStrictEqual(Array.from(bytes.subarray(wasmPtr, wasmPtr + 18)), [
    0x43, 0, 0x3a, 0, 0x5c, 0, 0, 0,
    0x44, 0, 0x3a, 0, 0x5c, 0, 0, 0,
    0, 0,
  ], 'wide drive strings are double-NUL-terminated');

  // Mounted media can use letters beyond the built-in Win98 C:/D: pair.
  // Both enumeration APIs must observe the same live VFS assignment set.
  ctx.vfs.driveTypes = new Map([['e', 5], ['z', 4], ['not-a-letter', 3]]);
  assert.strictEqual(exports.test_call_GetLogicalDrives() >>> 0, 0x0200001c,
    'mounted E: and Z: are added to the current assignment mask');
  assert.strictEqual(exports.test_call_GetLogicalDriveStringsA(0, 0), 17,
    'four roots plus the final terminator require seventeen characters');
  bytes.fill(0xcc, wasmPtr, wasmPtr + 40);
  assert.strictEqual(exports.test_call_GetLogicalDriveStringsA(16, guestPtr), 17,
    'a short buffer reports the required size including the final terminator');
  assert(bytes.subarray(wasmPtr, wasmPtr + 17).every(value => value === 0xcc),
    'a short buffer is not partially overwritten');
  assert.strictEqual(exports.test_call_GetLogicalDriveStringsA(17, guestPtr), 16);
  assert.deepStrictEqual(Array.from(bytes.subarray(wasmPtr, wasmPtr + 17)), [
    0x43, 0x3a, 0x5c, 0, 0x44, 0x3a, 0x5c, 0,
    0x45, 0x3a, 0x5c, 0, 0x5a, 0x3a, 0x5c, 0, 0,
  ], 'ANSI drive roots are sorted by letter and double-NUL-terminated');
  bytes.fill(0xcc, wasmPtr, wasmPtr + 40);
  assert.strictEqual(exports.test_call_GetLogicalDriveStringsW(17, guestPtr), 16);
  assert.deepStrictEqual(Array.from(bytes.subarray(wasmPtr, wasmPtr + 34)), [
    0x43, 0, 0x3a, 0, 0x5c, 0, 0, 0,
    0x44, 0, 0x3a, 0, 0x5c, 0, 0, 0,
    0x45, 0, 0x3a, 0, 0x5c, 0, 0, 0,
    0x5a, 0, 0x3a, 0, 0x5c, 0, 0, 0, 0, 0,
  ], 'wide drive roots reflect the same live assignment set');
  ctx.vfs.driveTypes.clear();
  assert.strictEqual(exports.test_call_GetDriveTypeA(0), 3, 'NULL means current fixed drive');
  writeAnsi('C:\\');
  assert.strictEqual(exports.test_call_GetDriveTypeA(guestPtr), 3, 'C: is DRIVE_FIXED');
  writeAnsi('D:\\');
  assert.strictEqual(exports.test_call_GetDriveTypeA(guestPtr), 5, 'D: is DRIVE_CDROM');
  writeAnsi('d:\\help');
  assert.strictEqual(exports.test_call_GetDriveTypeA(guestPtr), 5, 'drive letters are case-insensitive');
  for (const letter of ['A', 'B', 'E', 'Z']) {
    writeAnsi(`${letter}:\\`);
    assert.strictEqual(exports.test_call_GetDriveTypeA(guestPtr), 1,
      `${letter}: is DRIVE_NO_ROOT_DIR because it is not advertised`);
  }
  writeAnsi('C');
  assert.strictEqual(exports.test_call_GetDriveTypeA(guestPtr), 1,
    'a path without a drive separator is not a mounted root');
  writeWide('D:\\');
  assert.strictEqual(exports.test_call_GetDriveTypeW(guestPtr), 5, 'Unicode D: is DRIVE_CDROM');
  writeWide('C:\\');
  assert.strictEqual(exports.test_call_GetDriveTypeW(guestPtr), 3, 'Unicode C: is DRIVE_FIXED');
  writeWide('A:\\');
  assert.strictEqual(exports.test_call_GetDriveTypeW(guestPtr), 1,
    'Unicode A: is DRIVE_NO_ROOT_DIR');
  assert.strictEqual(exports.test_call_EnumThreadWindows(1, 0x401000, 0), 1,
    'single-process thread-window enumeration succeeds without fabricating foreign windows');

  console.log('PASS  Win98 drive semantics and single-process window enumeration');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

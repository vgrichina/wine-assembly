#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { createFilesystemImports } = require('../lib/filesystem');
const { bootRenderHarness } = require('./render-helper');

const memory = new WebAssembly.Memory({ initial: 2 });
const ctx = { getMemory: () => memory.buffer };
const host = createFilesystemImports(ctx);
const dv = new DataView(memory.buffer);
const bytes = new Uint8Array(memory.buffer);

function putTime(at, lo, hi) {
  dv.setUint32(at, lo >>> 0, true);
  dv.setUint32(at + 4, hi >>> 0, true);
}

function readTime(at) {
  return { lo: dv.getUint32(at, true), hi: dv.getUint32(at + 4, true) };
}

(async () => {
  const h = ctx.vfs.createFile('C:\\archive.bin', 0x40000100, 2);
  assert(h, 'writable archive fixture opens');

  const creation = { lo: 0x11223344, hi: 0x01BF53E0 };
  const access = { lo: 0x55667788, hi: 0x01BF53E1 };
  const write = { lo: 0x99AABBCC, hi: 0x01BF53E2 };
  putTime(0x100, creation.lo, creation.hi);
  putTime(0x108, access.lo, access.hi);
  putTime(0x110, write.lo, write.hi);

  const notifications = [];
  const originalNotify = ctx.vfs._notifyChange.bind(ctx.vfs);
  ctx.vfs._notifyChange = (path, filter) => {
    notifications.push({ path, filter });
    originalNotify(path, filter);
  };
  assert.strictEqual(host.fs_file_time(h, 1, 0x100, 0x108, 0x110), 0,
    'SetFileTime succeeds on a writable VFS handle');
  assert(notifications.some(n => n.path === 'c:\\archive.bin' && (n.filter & 0x10)),
    'a timestamp change signals FILE_NOTIFY_CHANGE_LAST_WRITE');

  bytes.fill(0, 0x180, 0x198);
  assert.strictEqual(host.fs_file_time(h, 0, 0x180, 0x188, 0x190), 0,
    'GetFileTime succeeds on the same handle');
  assert.deepStrictEqual(readTime(0x180), creation, 'creation time round-trips exactly');
  assert.deepStrictEqual(readTime(0x188), access, 'access time round-trips exactly');
  assert.deepStrictEqual(readTime(0x190), write, 'write time round-trips exactly');

  // NULL leaves a timestamp alone, and all-ones is Win32's preservation
  // sentinel rather than the date 30828-09-14.
  const replacement = { lo: 0x01020304, hi: 0x05060708 };
  putTime(0x120, replacement.lo, replacement.hi);
  putTime(0x128, 0xFFFFFFFF, 0xFFFFFFFF);
  assert.strictEqual(host.fs_file_time(h, 1, 0, 0x120, 0x128), 0);
  assert.strictEqual(host.fs_file_time(h, 0, 0x180, 0x188, 0x190), 0);
  assert.deepStrictEqual(readTime(0x180), creation, 'NULL preserves creation time');
  assert.deepStrictEqual(readTime(0x188), replacement, 'non-NULL access time changes');
  assert.deepStrictEqual(readTime(0x190), write, 'all-ones preserves write time');

  const found = ctx.vfs.findFirstFile('C:\\archive.bin').entry;
  assert.deepStrictEqual(found.creationTime, creation,
    'FindFirstFile sees the same stored creation time');
  assert.deepStrictEqual(found.lastAccessTime, replacement,
    'FindFirstFile sees the same stored access time');
  assert.deepStrictEqual(found.lastWriteTime, write,
    'FindFirstFile sees the same stored write time');

  const pattern = 'C:\\archive.bin\0';
  for (let i = 0; i < pattern.length; i++) bytes[0x300 + i] = pattern.charCodeAt(i);
  assert.notStrictEqual(host.fs_find_first_file(0x300, 0x400, 0), 0xFFFFFFFF,
    'host FindFirstFile succeeds');
  assert.deepStrictEqual(readTime(0x404), creation, 'WIN32_FIND_DATA creation FILETIME');
  assert.deepStrictEqual(readTime(0x40C), replacement, 'WIN32_FIND_DATA access FILETIME');
  assert.deepStrictEqual(readTime(0x414), write, 'WIN32_FIND_DATA write FILETIME');

  assert.strictEqual(host.fs_file_time(0xDEADBEEF, 0, 0, 0, 0), 6,
    'invalid handles report ERROR_INVALID_HANDLE');
  ctx.vfs.setDriveReadOnly('C');
  assert.strictEqual(host.fs_file_time(h, 1, 0x100, 0, 0), 5,
    'read-only drives report ERROR_ACCESS_DENIED');

  // Pin the Win32 handlers too: nullable guest pointers are translated before
  // the host call, stdcall pops four args, and host errors become LastError.
  const calls = [];
  const { exports: wat } = await bootRenderHarness({
    extraWat: String.raw`
      (func (export "test_set_file_time") (param $h i32) (param $c i32) (param $a i32) (param $w i32) (result i64)
        (global.set $esp (i32.const 0x00300000))
        (call $handle_SetFileTime (local.get $h) (local.get $c) (local.get $a) (local.get $w)
          (i32.const 0) (i32.const 0))
        (i64.or (i64.extend_i32_u (global.get $eax))
          (i64.shl (i64.extend_i32_u (global.get $last_error)) (i64.const 32))))
      (func (export "test_get_file_time") (param $h i32) (param $c i32) (param $a i32) (param $w i32) (result i64)
        (global.set $esp (i32.const 0x00300000))
        (call $handle_GetFileTime (local.get $h) (local.get $c) (local.get $a) (local.get $w)
          (i32.const 0) (i32.const 0))
        (i64.or (i64.extend_i32_u (global.get $eax))
          (i64.shl (i64.extend_i32_u (global.get $last_error)) (i64.const 32))))
    `,
    extraHostOverrides: {
      fs_file_time: (...args) => {
        calls.push(args);
        return args[1] ? 0 : 6;
      },
    },
  });
  const imageBase = wat.get_image_base() >>> 0;
  const cGuest = imageBase + 0x1000;
  const wGuest = imageBase + 0x2000;
  let result = wat.test_set_file_time(0x77, cGuest, 0, wGuest);
  assert.strictEqual(Number(result & 0xFFFFFFFFn), 1, 'SetFileTime returns TRUE');
  assert.strictEqual(Number(result >> 32n), 0, 'successful SetFileTime clears LastError');
  assert.deepStrictEqual(calls.shift(), [0x77, 1, 0x13000, 0, 0x14000],
    'SetFileTime forwards nullable translated pointers');
  assert.strictEqual(wat.get_esp() >>> 0, 0x00300014, 'SetFileTime pops four arguments');

  result = wat.test_get_file_time(0x88, 0, 0, 0);
  assert.strictEqual(Number(result & 0xFFFFFFFFn), 0, 'GetFileTime returns FALSE on host failure');
  assert.strictEqual(Number(result >> 32n), 6, 'GetFileTime publishes ERROR_INVALID_HANDLE');
  assert.deepStrictEqual(calls.shift(), [0x88, 0, 0, 0, 0],
    'GetFileTime keeps NULL outputs NULL');
  assert.strictEqual(wat.get_esp() >>> 0, 0x00300014, 'GetFileTime pops four arguments');

  console.log('PASS  SetFileTime persists exact Win32 timestamps through Get/Find');
})().catch(error => {
  console.error(error);
  process.exit(1);
});

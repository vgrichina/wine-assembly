#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { createFilesystemImports } = require('../lib/filesystem');
const { createHostImports } = require('../lib/host-imports');
const RegionMap = require('../lib/region-map.generated');
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

function readSystemTime(at) {
  return Array.from({ length: 8 }, (_, i) => dv.getUint16(at + i * 2, true));
}

(async () => {
  // Calendar time is the host wall clock, not the synthetic guest tick clock.
  // Validate UTC/local field selection and the complete 64-bit FILETIME carry
  // against one deterministic leap-day snapshot.
  const fixedNow = Date.UTC(2024, 1, 29, 23, 58, 59, 321);
  const clockCtx = {
    getMemory: () => memory.buffer,
    renderer: null,
    wallNowMs: () => fixedNow,
  };
  const clockHost = createHostImports(clockCtx).host;
  assert.strictEqual(clockHost.wall_clock(0x600, 0), 1);
  assert.deepStrictEqual(readSystemTime(0x600), [2024, 2, 4, 29, 23, 58, 59, 321],
    'UTC SYSTEMTIME must describe the host wall-clock instant');
  const local = new Date(fixedNow);
  assert.strictEqual(clockHost.wall_clock(0x620, 1), 1);
  assert.deepStrictEqual(readSystemTime(0x620), [
    local.getFullYear(), local.getMonth() + 1, local.getDay(), local.getDate(),
    local.getHours(), local.getMinutes(), local.getSeconds(), local.getMilliseconds(),
  ], 'local SYSTEMTIME must use the host time zone');
  assert.strictEqual(clockHost.wall_clock(0x640, 2), 1);
  const expectedFileTime = 116444736000000000n + BigInt(fixedNow) * 10000n;
  const actualFileTime = BigInt(dv.getUint32(0x644, true)) * 0x100000000n +
    BigInt(dv.getUint32(0x640, true));
  assert.strictEqual(actualFileTime, expectedFileTime,
    'FILETIME must retain the high-word carry for the full wall-clock epoch');

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
  const clockCalls = [];
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
      (func (export "test_get_local_time") (param $out i32) (result i32)
        (global.set $esp (i32.const 0x00300000))
        (call $handle_GetLocalTime (local.get $out) (i32.const 0) (i32.const 0)
          (i32.const 0) (i32.const 0) (i32.const 0))
        (global.get $esp))
      (func (export "test_get_system_time") (param $out i32) (result i32)
        (global.set $esp (i32.const 0x00300000))
        (call $handle_GetSystemTime (local.get $out) (i32.const 0) (i32.const 0)
          (i32.const 0) (i32.const 0) (i32.const 0))
        (global.get $esp))
      (func (export "test_get_system_time_as_file_time") (param $out i32) (result i32)
        (global.set $esp (i32.const 0x00300000))
        (call $handle_GetSystemTimeAsFileTime (local.get $out) (i32.const 0) (i32.const 0)
          (i32.const 0) (i32.const 0) (i32.const 0))
        (global.get $esp))
    `,
    extraHostOverrides: {
      fs_file_time: (...args) => {
        calls.push(args);
        return args[1] ? 0 : 6;
      },
      wall_clock: (out, kind) => {
        clockCalls.push([out, kind]);
        return 1;
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

  const clockGuest = imageBase + 0x3000;
  assert.strictEqual(wat.test_get_local_time(clockGuest) >>> 0, 0x00300008,
    'GetLocalTime pops its pointer argument');
  assert.strictEqual(wat.test_get_system_time(clockGuest) >>> 0, 0x00300008,
    'GetSystemTime pops its pointer argument');
  assert.strictEqual(wat.test_get_system_time_as_file_time(clockGuest) >>> 0, 0x00300008,
    'GetSystemTimeAsFileTime pops its pointer argument');
  assert.deepStrictEqual(clockCalls, [
    [RegionMap.GUEST_BASE + 0x3000, 1],
    [RegionMap.GUEST_BASE + 0x3000, 0],
    [RegionMap.GUEST_BASE + 0x3000, 2],
  ], 'Win32 calendar APIs translate once and select local, UTC, and FILETIME modes');

  console.log('PASS  SetFileTime persists exact Win32 timestamps through Get/Find');
})().catch(error => {
  console.error(error);
  process.exit(1);
});

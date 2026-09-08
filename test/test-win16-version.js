#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { loadWin16Dlls } = require('../lib/dll-loader');
const { bootRenderHarness } = require('./render-helper');

function makeVersionBlob() {
  const blob = Buffer.alloc(92);
  blob.writeUInt16LE(blob.length, 0);
  blob.writeUInt16LE(52, 2);
  const key = 'VS_VERSION_INFO\0';
  for (let i = 0; i < key.length; i++) blob.writeUInt16LE(key.charCodeAt(i), 6 + i * 2);
  blob.writeUInt32LE(0xFEEF04BD, 0x28);
  blob.writeUInt32LE(0x00010000, 0x2C);
  blob.writeUInt32LE(0x00050006, 0x30);
  blob.writeUInt32LE(0x00070008, 0x34);
  return blob;
}

function makeVersionPe(blob) {
  const file = Buffer.alloc(0x400);
  file.writeUInt16LE(0x5A4D, 0);
  file.writeUInt32LE(0x80, 0x3C);
  file.writeUInt32LE(0x00004550, 0x80);
  file.writeUInt16LE(0x014C, 0x84);
  file.writeUInt16LE(1, 0x86);
  file.writeUInt16LE(0xE0, 0x94);
  const opt = 0x98;
  file.writeUInt16LE(0x010B, opt);
  file.writeUInt32LE(3, opt + 92);
  file.writeUInt32LE(0x1000, opt + 112);
  file.writeUInt32LE(0x200, opt + 116);
  const section = 0x178;
  file.write('.rsrc\0\0\0', section, 'ascii');
  file.writeUInt32LE(0x200, section + 8);
  file.writeUInt32LE(0x1000, section + 12);
  file.writeUInt32LE(0x200, section + 16);
  file.writeUInt32LE(0x200, section + 20);
  const root = 0x200;
  file.writeUInt16LE(1, root + 14);
  file.writeUInt32LE(16, root + 16);
  file.writeUInt32LE(0x80000018, root + 20);
  file.writeUInt16LE(1, root + 0x18 + 14);
  file.writeUInt32LE(1, root + 0x18 + 16);
  file.writeUInt32LE(0x80000030, root + 0x18 + 20);
  file.writeUInt16LE(1, root + 0x30 + 14);
  file.writeUInt32LE(0x0409, root + 0x30 + 16);
  file.writeUInt32LE(0x48, root + 0x30 + 20);
  file.writeUInt32LE(0x1100, root + 0x48);
  file.writeUInt32LE(blob.length, root + 0x4C);
  blob.copy(file, 0x300);
  return file;
}

const extraWat = String.raw`
  (func $test_ver_init
    (local $name i32)
    (call $win16_seg_set (i32.const 1) (i32.const 0x00100000)
      (i32.const 0x10000) (i32.const 0) (i32.const 1))
    (call $win16_seg_set (i32.const 2) (i32.const 0x00110000)
      (i32.const 0x10000) (i32.const 1) (i32.const 2))
    (global.set $code16 (i32.const 1))
    (global.set $sreg_cs (call $win16_index_to_sel (i32.const 1)))
    (global.set $seg_base_cs (i32.const 0x00100000))
    (global.set $sreg_ss (call $win16_index_to_sel (i32.const 2)))
    (global.set $seg_base_ss (i32.const 0x00110000))
    (global.set $sreg_ds (call $win16_index_to_sel (i32.const 2)))
    (global.set $seg_base_ds (i32.const 0x00110000))
    (call $win16_dynamic_modules_reset)
    (local.set $name (call $g2w (i32.const 0x00110280)))
    (i32.store8 (local.get $name) (i32.const 3))
    (i32.store offset=1 (local.get $name) (i32.const 0x00524556))
    (drop (call $win16_dynamic_module_id (local.get $name))))

  (func $test_ver_stack (param $argbytes i32)
    (global.set $esp (i32.const 0x00110100))
    (call $gs16 (i32.const 0x00110100) (i32.const 0x0010))
    (call $gs16 (i32.const 0x00110102) (call $win16_index_to_sel (i32.const 1))))

  (func $test_ver_result (result i32)
    (i32.or (i32.and (global.get $eax) (i32.const 0xFFFF))
      (i32.shl (i32.sub (global.get $esp) (i32.const 0x00110000)) (i32.const 16))))

  (func (export "test_ver_module") (result i32)
    (call $test_ver_init)
    (i32.or (i32.const 13)
      (i32.shl (call $win16_module_emulated (i32.const 13)) (i32.const 16))))

  (func (export "test_ver_size") (result i32)
    (call $test_ver_init)
    (call $test_ver_stack (i32.const 8))
    (call $gs16 (i32.const 0x00110104) (i32.const 0x0300))
    (call $gs16 (i32.const 0x00110106) (call $win16_index_to_sel (i32.const 2)))
    (call $gs16 (i32.const 0x00110108) (i32.const 0x0200))
    (call $gs16 (i32.const 0x0011010A) (call $win16_index_to_sel (i32.const 2)))
    (drop (call $win16_ver (i32.const 13) (i32.const 6)))
    (call $test_ver_result))

  (func (export "test_ver_info") (param $len i32) (result i32)
    (call $test_ver_init)
    (call $test_ver_stack (i32.const 16))
    (call $gs16 (i32.const 0x00110104) (i32.const 0x0400))
    (call $gs16 (i32.const 0x00110106) (call $win16_index_to_sel (i32.const 2)))
    (call $gs32 (i32.const 0x00110108) (local.get $len))
    (call $gs32 (i32.const 0x0011010C) (i32.const 0))
    (call $gs16 (i32.const 0x00110110) (i32.const 0x0200))
    (call $gs16 (i32.const 0x00110112) (call $win16_index_to_sel (i32.const 2)))
    (drop (call $win16_ver (i32.const 13) (i32.const 7)))
    (call $test_ver_result))

  (func (export "test_ver_language") (param $capacity i32) (result i32)
    (call $test_ver_init)
    (call $test_ver_stack (i32.const 8))
    (call $gs16 (i32.const 0x00110104) (local.get $capacity))
    (call $gs16 (i32.const 0x00110106) (i32.const 0x0500))
    (call $gs16 (i32.const 0x00110108) (call $win16_index_to_sel (i32.const 2)))
    (call $gs16 (i32.const 0x0011010A) (i32.const 0x0409))
    (drop (call $win16_ver (i32.const 13) (i32.const 10)))
    (call $test_ver_result))

  (func (export "test_ver_query") (result i32)
    (call $test_ver_init)
    (call $test_ver_stack (i32.const 16))
    (call $gs16 (i32.const 0x00110104) (i32.const 0x0354))
    (call $gs16 (i32.const 0x00110106) (call $win16_index_to_sel (i32.const 2)))
    (call $gs16 (i32.const 0x00110108) (i32.const 0x0350))
    (call $gs16 (i32.const 0x0011010A) (call $win16_index_to_sel (i32.const 2)))
    (call $gs16 (i32.const 0x0011010C) (i32.const 0x0360))
    (call $gs16 (i32.const 0x0011010E) (call $win16_index_to_sel (i32.const 2)))
    (call $gs16 (i32.const 0x00110110) (i32.const 0x0400))
    (call $gs16 (i32.const 0x00110112) (call $win16_index_to_sel (i32.const 2)))
    (drop (call $win16_ver (i32.const 13) (i32.const 11)))
    (call $test_ver_result))
`;

(async () => {
  const stageMemory = new ArrayBuffer(1024);
  const stageBytes = new Uint8Array(stageMemory);
  stageBytes[100] = 3;
  stageBytes.set(Buffer.from('VER'), 101);
  const reads = [];
  const loaded = loadWin16Dlls({
    is_win16: () => 1,
    win16_dll_staging: id => 400 + id * 16,
    win16_app_dll_staging_size: () => 64,
    win16_dynamic_module_slot: () => 100,
    load_ne_dll: () => { throw new Error('VER must not be loaded from a file'); },
  }, { buffer: stageMemory }, Uint8Array.of(), 'c:\\setup', (_dir, name) => {
    reads.push(name);
    return null;
  });
  assert.deepStrictEqual(loaded, []);
  assert.deepStrictEqual(reads, ['CARDS'], 'the emulated VER slot must not trigger a file lookup');

  const blob = makeVersionBlob();
  const pe = makeVersionPe(blob);
  const { exports: e, memory, hostCtx } = await bootRenderHarness({ extraWat, fonts: 'none' });
  hostCtx.vfs.files.set('c:\\windows\\temp\\version.dll', {
    data: new Uint8Array(pe), attrs: 0x20,
  });
  const u8 = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  const wa = gp => gp - e.get_image_base() + e.get_guest_base();
  const writeAsciiAt = (gp, value) => {
    for (let i = 0; i < value.length; i++) u8[wa(gp) + i] = value.charCodeAt(i);
    u8[wa(gp) + value.length] = 0;
  };
  const result = value => ({ ax: value & 0xFFFF, sp: value >>> 16 });

  writeAsciiAt(0x00110200, 'C:\\Windows\\Temp\\Version.dll');
  dv.setUint32(wa(0x00110300), 0xDEADBEEF, true);
  assert.strictEqual(e.test_ver_module(), 0x0001000D);
  assert.deepStrictEqual(result(e.test_ver_size() >>> 0), { ax: blob.length, sp: 0x010C });
  assert.strictEqual(dv.getUint32(wa(0x00110300), true), 0);

  u8.fill(0xA5, wa(0x00110400), wa(0x00110400) + blob.length);
  assert.deepStrictEqual(result(e.test_ver_info(blob.length) >>> 0), { ax: 1, sp: 0x0114 });
  assert.deepStrictEqual(Buffer.from(u8.subarray(wa(0x00110400), wa(0x00110400) + blob.length)), blob);

  writeAsciiAt(0x00110200, 'GDI.EXE');
  dv.setUint32(wa(0x00110300), 0xDEADBEEF, true);
  assert.deepStrictEqual(result(e.test_ver_size() >>> 0), { ax: blob.length + 4, sp: 0x010C });
  assert.strictEqual(dv.getUint32(wa(0x00110300), true), 0);
  assert.deepStrictEqual(result(e.test_ver_info(blob.length + 4) >>> 0), { ax: 1, sp: 0x0114 });
  assert.strictEqual(dv.getUint16(wa(0x00110400), true), blob.length + 4);
  assert.strictEqual(dv.getUint32(wa(0x00110400) + 0x30, true), 0x0004000A);
  assert.strictEqual(dv.getUint32(wa(0x00110400) + 0x34, true), 0x08AE0000);
  assert.strictEqual(dv.getUint32(wa(0x00110400) + blob.length, true), 0x04E40409);
  writeAsciiAt(0x00110360, '\\VarFileInfo\\Translation');
  assert.deepStrictEqual(result(e.test_ver_query() >>> 0), { ax: 1, sp: 0x0114 });
  const dataSelector = (2 << 3) | 7;
  assert.strictEqual(dv.getUint32(wa(0x00110350), true), (dataSelector << 16) | 0x045C);
  assert.strictEqual(dv.getUint16(wa(0x00110354), true), 4);

  assert.deepStrictEqual(result(e.test_ver_language(64) >>> 0), { ax: 23, sp: 0x010C });
  const language = Buffer.from(u8.subarray(wa(0x00110500), wa(0x00110500) + 64))
    .subarray(0, 23).toString('ascii');
  assert.strictEqual(language, 'English (United States)');
  assert.deepStrictEqual(result(e.test_ver_language(8) >>> 0), { ax: 7, sp: 0x010C });
  assert.strictEqual(Buffer.from(u8.subarray(wa(0x00110500), wa(0x00110500) + 8)).toString('ascii'),
    'English\0');

  u8.set(blob, wa(0x00110400));
  writeAsciiAt(0x00110360, '\\');
  dv.setUint32(wa(0x00110350), 0, true);
  dv.setUint16(wa(0x00110354), 0, true);
  assert.deepStrictEqual(result(e.test_ver_query() >>> 0), { ax: 1, sp: 0x0114 });
  assert.strictEqual(dv.getUint32(wa(0x00110350), true), (dataSelector << 16) | 0x0428);
  assert.strictEqual(dv.getUint16(wa(0x00110354), true), 52);
  console.log('test-win16-version: PASS');
})().catch(error => { console.error(error); process.exit(1); });

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');
const { createIconResourceExtractor } = require('../lib/resources-icon');

const ROOT = path.join(__dirname, '..');
const extraWat = String.raw`
  (func (export "test_extract_icon_ex")
        (param $wide i32) (param $file i32) (param $index i32)
        (param $large i32) (param $small i32) (param $count i32) (result i64)
    (global.set $esp (i32.const 0x00300000))
    (if (local.get $wide)
      (then (call $handle_ExtractIconExW
        (local.get $file) (local.get $index) (local.get $large)
        (local.get $small) (local.get $count) (i32.const 0)))
      (else (call $handle_ExtractIconExA
        (local.get $file) (local.get $index) (local.get $large)
        (local.get $small) (local.get $count) (i32.const 0))))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))

  (func (export "test_extract_icon")
        (param $wide i32) (param $file i32) (param $index i32) (result i64)
    (global.set $esp (i32.const 0x00300000))
    (if (local.get $wide)
      (then (call $handle_ExtractIconW
        (i32.const 0) (local.get $file) (local.get $index)
        (i32.const 0) (i32.const 0) (i32.const 0)))
      (else (call $handle_ExtractIconA
        (i32.const 0) (local.get $file) (local.get $index)
        (i32.const 0) (i32.const 0) (i32.const 0))))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))

  (func (export "test_icon_size") (param $handle i32) (result i32)
    (local $record i32)
    (local.set $record (call $cursor_record (local.get $handle)))
    (if (i32.eqz (local.get $record)) (then (return (i32.const 0))))
    (i32.or (call $cursor_width (local.get $record))
      (i32.shl (call $cursor_height (local.get $record)) (i32.const 16))))

  (func (export "test_destroy_icon") (param $handle i32) (result i32)
    (call $icon_destroy_handle (local.get $handle)))

  (func (export "test_last_error") (result i32) (global.get $last_error))
`;

const low = value => Number(value & 0xffffffffn) >>> 0;
const high = value => Number(value >> 32n) >>> 0;

(async () => {
  const harness = await bootRenderHarness({ extraWat, fonts: 'none' });
  const { exports: e, memory, hostCtx } = harness;
  const fixture = fs.readFileSync(path.join(ROOT, 'test', 'binaries', 'calc.exe'));
  new Uint8Array(memory.buffer).set(fixture, e.get_staging());
  assert(e.load_pe(fixture.length), 'fixture PE initializes guest allocation');

  const iconExe = fs.readFileSync(path.join(
    ROOT, 'test', 'binaries', 'win98-apps', 'notepad98.exe'));
  const extractor = createIconResourceExtractor(iconExe);
  assert(extractor && extractor.count >= 2, 'Notepad fixture has multiple icon groups');
  const neExe = fs.readFileSync(path.join(
    ROOT, 'test', 'binaries', 'win98-16bit', 'FREECELL.EXE'));
  const rawIcon = extractor.resource(0, 32);
  const ico = Buffer.alloc(22 + rawIcon.length);
  ico.writeUInt16LE(1, 2); // ICONDIR.type
  ico.writeUInt16LE(1, 4); // ICONDIR.count
  ico[6] = 32;
  ico[7] = 32;
  ico.writeUInt16LE(1, 10);
  ico.writeUInt16LE(new DataView(rawIcon.buffer, rawIcon.byteOffset).getUint16(14, true), 12);
  ico.writeUInt32LE(rawIcon.length, 14);
  ico.writeUInt32LE(22, 18);
  ico.set(rawIcon, 22);
  hostCtx.vfs = {
    files: new Map([
      ['c:\\notepad.exe', { data: new Uint8Array(iconExe), attrs: 0x20 }],
      ['c:\\freecell.exe', { data: new Uint8Array(neExe), attrs: 0x20 }],
      ['c:\\sample.ico', { data: new Uint8Array(ico), attrs: 0x20 }],
      ['c:\\plain.bin', { data: Uint8Array.from([1, 2, 3]), attrs: 0x20 }],
    ]),
    _resolvePath(value) {
      return String(value).toLowerCase().replace(/\//g, '\\');
    },
  };

  const bytes = new Uint8Array(memory.buffer);
  const view = new DataView(memory.buffer);
  const wa = guest => e.guest_to_wasm(guest) >>> 0;
  const alloc = size => e.guest_alloc(size) >>> 0;
  const writeA = value => {
    const out = alloc(value.length + 1);
    bytes.set(Buffer.from(value + '\0', 'latin1'), wa(out));
    return out;
  };
  const writeW = value => {
    const out = alloc((value.length + 1) * 2);
    for (let i = 0; i < value.length; i++) {
      view.setUint16(wa(out) + i * 2, value.charCodeAt(i), true);
    }
    view.setUint16(wa(out) + value.length * 2, 0, true);
    return out;
  };
  const pathA = writeA('C:\\NOTEPAD.EXE');
  const pathW = writeW('C:\\NOTEPAD.EXE');
  const missingA = writeA('C:\\MISSING.EXE');
  const invalidA = writeA('C:\\PLAIN.BIN');
  const nePathA = writeA('C:\\FREECELL.EXE');
  const icoPathA = writeA('C:\\SAMPLE.ICO');
  const largeOut = alloc(extractor.count * 4);
  const smallOut = alloc(extractor.count * 4);

  for (const [wide, file] of [[0, pathA], [1, pathW]]) {
    const countOnly = e.test_extract_icon_ex(wide, file, -1, 0, 0, 0);
    assert.strictEqual(low(countOnly), extractor.count);
    assert.strictEqual(high(countOnly), 0x00300018);

    const extracted = e.test_extract_icon_ex(
      wide, file, 0, largeOut, smallOut, extractor.count);
    assert.strictEqual(low(extracted), extractor.count);
    for (let i = 0; i < extractor.count; i++) {
      const large = view.getUint32(wa(largeOut + i * 4), true);
      const small = view.getUint32(wa(smallOut + i * 4), true);
      assert(large && small && large !== small, 'outputs are private HICONs');
      assert.strictEqual(e.test_icon_size(large) >>> 0, (32 << 16) | 32);
      assert.strictEqual(e.test_icon_size(small) >>> 0, (16 << 16) | 16);
      assert.strictEqual(e.test_destroy_icon(large) >>> 0, 1);
      assert.strictEqual(e.test_destroy_icon(small) >>> 0, 1);
      assert.strictEqual(e.test_icon_size(large) >>> 0, 0);
      assert.strictEqual(e.test_icon_size(small) >>> 0, 0);
    }
  }

  const resourceId = extractor.groupIds.find(id => id != null);
  const byResource = e.test_extract_icon_ex(0, pathA, -resourceId, largeOut, 0, 8);
  assert.strictEqual(low(byResource), 1, 'negative index selects one resource id');
  const resourceIcon = view.getUint32(wa(largeOut), true);
  assert.strictEqual(e.test_icon_size(resourceIcon) >>> 0, (32 << 16) | 32);
  assert.strictEqual(e.test_destroy_icon(resourceIcon) >>> 0, 1);

  for (const [wide, file] of [[0, pathA], [1, pathW]]) {
    const countResult = e.test_extract_icon(wide, file, -1);
    assert.strictEqual(low(countResult), extractor.count);
    assert.strictEqual(high(countResult), 0x00300010);
    const iconResult = e.test_extract_icon(wide, file, 0);
    const icon = low(iconResult);
    assert(icon !== 0 && icon !== 1);
    assert.strictEqual(e.test_icon_size(icon) >>> 0, (32 << 16) | 32);
    assert.strictEqual(e.test_destroy_icon(icon) >>> 0, 1);
  }

  assert.strictEqual(
    low(e.test_extract_icon_ex(0, pathA, extractor.count, largeOut, 0, 1)), 0);
  assert.strictEqual(
    low(e.test_extract_icon_ex(0, missingA, 0, largeOut, 0, 1)), 0xffffffff);
  assert.strictEqual(e.test_last_error() >>> 0, 2);
  assert.strictEqual(low(e.test_extract_icon_ex(0, missingA, -1, 0, 0, 0)), 0);
  assert.strictEqual(low(e.test_extract_icon(0, invalidA, 0)), 1);
  assert.strictEqual(e.test_last_error() >>> 0, 193);

  for (const file of [nePathA, icoPathA]) {
    assert.strictEqual(low(e.test_extract_icon_ex(0, file, -1, 0, 0, 0)), 1,
      'NE and ICO containers each report one logical icon');
    assert.strictEqual(low(e.test_extract_icon_ex(0, file, 0, largeOut, 0, 1)), 1);
    const icon = view.getUint32(wa(largeOut), true);
    assert.strictEqual(e.test_icon_size(icon) >>> 0, (32 << 16) | 32);
    assert.strictEqual(e.test_destroy_icon(icon) >>> 0, 1);
  }

  console.log('PASS ExtractIcon A/W/Ex materialize owned PE/NE/ICO icons with Win98 semantics');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

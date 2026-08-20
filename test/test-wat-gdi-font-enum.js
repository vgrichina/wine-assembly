#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  const calls = { measure: 0, metrics: 0 };
  const { exports: wat, memory, hostCtx } = await bootRenderHarness({
    extraWat: `
  (func (export "test_start_EnumFontsA")
        (param $filter i32) (param $callback i32) (param $data i32) (result i32)
    (local $start i32)
    (local.set $start (global.get $esp))
    (call $gs32 (local.get $start) (i32.const 0))
    (call $handle_EnumFontsA (i32.const 0) (local.get $filter)
      (local.get $callback) (local.get $data) (i32.const 0) (i32.const 0))
    (global.get $eip))
  (func (export "test_start_EnumFontFamiliesExW")
        (param $logfont i32) (param $callback i32) (param $data i32) (result i32)
    (local $start i32)
    (local.set $start (global.get $esp))
    (call $gs32 (local.get $start) (i32.const 0))
    (call $handle_EnumFontFamiliesExW (i32.const 0) (local.get $logfont)
      (local.get $callback) (local.get $data) (i32.const 0) (i32.const 0))
    (global.get $eip))`,
    extraHostOverrides: {
      measure_text: () => { calls.measure++; return 8; },
      get_text_metrics: () => { calls.metrics++; return 16 | (8 << 16); },
    },
  });
  const root = path.join(__dirname, '..');
  const exe = fs.readFileSync(path.join(root, 'test', 'binaries', 'calc.exe'));
  new Uint8Array(memory.buffer).set(exe, wat.get_staging());
  assert(wat.load_pe(exe.length), 'PE load must initialize callback continuation thunks');
  hostCtx.vfs.dirs.add('c:\\windows');
  hostCtx.vfs.dirs.add('c:\\windows\\fonts');
  for (const name of [
    'System.fon', 'MSSansSerif.fon', 'Fixedsys.fon', 'Courier.fon', 'Terminal.fon',
  ]) {
    hostCtx.vfs.files.set(`c:\\windows\\fonts\\${name.toLowerCase()}`, {
      data: new Uint8Array(fs.readFileSync(path.join(root, 'fonts', name))),
      attrs: 0x20,
    });
  }

  const bytes = new Uint8Array(memory.buffer);
  const view = new DataView(memory.buffer);
  const imageBase = wat.get_image_base() >>> 0;
  const wa = guest => (0x12000 + ((guest >>> 0) - imageBase)) >>> 0;
  const allocZero = size => {
    const pointer = wat.guest_alloc(size) >>> 0;
    bytes.fill(0, wa(pointer), wa(pointer) + size);
    return pointer;
  };
  const readAnsi = (pointer, limit = 128) => {
    let value = '';
    for (let index = 0; index < limit; index++) {
      const byte = bytes[pointer + index];
      if (!byte) break;
      value += String.fromCharCode(byte);
    }
    return value;
  };
  const readWide = (pointer, limit = 128) => {
    let value = '';
    for (let index = 0; index < limit; index++) {
      const code = view.getUint16(pointer + index * 2, true);
      if (!code) break;
      value += String.fromCharCode(code);
    }
    return value;
  };
  const writeAnsi = value => {
    const pointer = allocZero(value.length + 1);
    bytes.set(Buffer.from(value, 'latin1'), wa(pointer));
    return pointer;
  };
  const writeWide = value => {
    const pointer = allocZero((value.length + 1) * 2);
    [...value].forEach((character, index) =>
      wat.guest_write16(pointer + index * 2, character.charCodeAt(0)));
    return pointer;
  };
  const runCallbacks = () => {
    for (let index = 0; index < 1000 && wat.get_eip(); index++) wat.run(1000);
    assert.strictEqual(wat.get_eip(), 0, 'font callback sequence must restore caller EIP');
  };
  const makeCallback = stopAfterTwo => {
    const callback = allocZero(96);
    const code = [
      0x8b, 0x44, 0x24, 0x10,       // mov eax,[esp+16] (lParam)
      0x8b, 0x08,                   // mov ecx,[eax] (count)
      0xc1, 0xe1, 0x04,             // shl ecx,4
      0x8b, 0x54, 0x24, 0x04,       // mov edx,[esp+4] (ENUMLOGFONTEX*)
      0x8b, 0x52, 0x1c,             // mov edx,[edx+28] (face prefix)
      0x89, 0x54, 0x08, 0x04,       // mov [eax+ecx+4],edx
      0x8b, 0x54, 0x24, 0x0c,       // mov edx,[esp+12] (FontType)
      0x89, 0x54, 0x08, 0x08,       // mov [eax+ecx+8],edx
      0x8b, 0x54, 0x24, 0x08,       // mov edx,[esp+8] (NEWTEXTMETRICEX*)
      0x8b, 0x12,                   // mov edx,[edx] (tmHeight)
      0x89, 0x54, 0x08, 0x0c,       // mov [eax+ecx+12],edx
      0xff, 0x00,                   // inc dword [eax]
    ];
    if (stopAfterTwo) {
      code.push(
        0x8b, 0x10,                 // mov edx,[eax]
        0x31, 0xc0,                 // xor eax,eax
        0x83, 0xfa, 0x02,           // cmp edx,2
        0x0f, 0x92, 0xc0,           // setb al
      );
    } else {
      code.push(0xb8, 0x01, 0x00, 0x00, 0x00); // mov eax,1
    }
    code.push(0xc2, 0x10, 0x00);    // ret 16
    bytes.set(code, wa(callback));
    return callback;
  };

  const candidates = [];
  for (let candidate = wat.test_gdi_bitmap_font_enum_next(0, 0, 0) >>> 0;
       candidate;
       candidate = wat.test_gdi_bitmap_font_enum_next(candidate, 0, 0) >>> 0) {
    candidates.push(candidate);
  }
  const faces = candidates.map(candidate =>
    readAnsi(wat.test_gdi_bitmap_font_enum_face(candidate) >>> 0));
  // The installed strikes first, then every scalable face an application can
  // actually ask for: the substitution table's Win98 names. An application
  // that enumerates before it picks must be offered the names
  // CreateFontIndirect will honour, or its font list contains faces this
  // renderer cannot draw — and, worse, omits ones it can.
  assert.deepStrictEqual(faces, [
    'Arial', 'System', 'MS Sans Serif', 'Fixedsys', 'Courier', 'Terminal',
    'Times New Roman', 'Courier New', 'Tahoma', 'Marlett', 'Symbol',
    'Wingdings', 'Webdings',
  ], 'enumeration must retain Arial first, collapse duplicate FNT strikes, '
    + 'and report the substituted scalable faces');
  assert.strictEqual(wat.test_gdi_bitmap_font_count(), 8,
    'enumeration should lazily install all bundled FNT strikes');
  assert.deepStrictEqual(candidates.map(candidate =>
    wat.test_gdi_bitmap_font_enum_type(candidate) >>> 0),
    [4, 1, 1, 1, 1, 1, 4, 4, 4, 4, 4, 4, 4],
    'strikes report RASTER_FONTTYPE and scalable faces TRUETYPE_FONTTYPE');

  const ansiFilter = writeAnsi('fixedSYS');
  const ansiCandidate = wat.test_gdi_bitmap_font_enum_next(0, wa(ansiFilter), 0) >>> 0;
  assert.strictEqual(readAnsi(wat.test_gdi_bitmap_font_enum_face(ansiCandidate) >>> 0),
    'Fixedsys');
  assert.strictEqual(wat.test_gdi_bitmap_font_enum_next(
    ansiCandidate, wa(ansiFilter), 0), 0);

  const wideFilter = writeWide('terminal');
  const wideCandidate = wat.test_gdi_bitmap_font_enum_next(0, wa(wideFilter), 1) >>> 0;
  assert.strictEqual(readAnsi(wat.test_gdi_bitmap_font_enum_face(wideCandidate) >>> 0),
    'Terminal');

  const lfA = allocZero(192);
  const tmA = allocZero(128);
  assert.strictEqual(wat.test_gdi_bitmap_font_enum_fill(
    ansiCandidate, wa(lfA), wa(tmA), 0), 1);
  assert.strictEqual(readAnsi(wa(lfA) + 28, 32), 'Fixedsys');
  assert.strictEqual(readAnsi(wa(lfA) + 60, 64), 'Fixedsys');
  assert.strictEqual(readAnsi(wa(lfA) + 124, 32), 'Regular');
  assert.strictEqual(readAnsi(wa(lfA) + 156, 32), 'Western');
  assert(view.getInt32(wa(lfA), true) < 0, 'FNT LOGFONT height must select its pixel strike');
  assert.strictEqual(view.getUint8(wa(lfA) + 23), view.getUint8(wa(tmA) + 52));
  assert.strictEqual(view.getUint8(wa(lfA) + 27), view.getUint8(wa(tmA) + 51));
  assert(view.getUint32(wa(tmA), true) > 0);
  assert(view.getUint32(wa(tmA) + 4, true) > 0);
  assert(view.getUint32(wa(tmA) + 20, true) > 0);
  assert(view.getUint32(wa(tmA) + 24, true) >= view.getUint32(wa(tmA) + 20, true));
  assert.strictEqual(view.getUint32(wa(tmA) + 60, true),
    view.getUint32(wa(tmA), true), 'ANSI ntmSizeEM offset');
  assert.strictEqual(view.getUint32(wa(tmA) + 64, true),
    view.getUint32(wa(tmA), true), 'ANSI ntmCellHeight offset');

  const lfW = allocZero(384);
  const tmW = allocZero(128);
  assert.strictEqual(wat.test_gdi_bitmap_font_enum_fill(
    wideCandidate, wa(lfW), wa(tmW), 1), 1);
  assert.strictEqual(readWide(wa(lfW) + 28, 32), 'Terminal');
  assert.strictEqual(readWide(wa(lfW) + 92, 64), 'Terminal');
  assert.strictEqual(readWide(wa(lfW) + 220, 32), 'Regular');
  assert.strictEqual(readWide(wa(lfW) + 284, 32), 'Western');
  assert.strictEqual(view.getUint32(wa(tmW) + 64, true),
    view.getUint32(wa(tmW), true), 'Unicode ntmSizeEM offset');
  assert.strictEqual(view.getUint32(wa(tmW) + 68, true),
    view.getUint32(wa(tmW), true), 'Unicode ntmCellHeight offset');

  assert.deepStrictEqual(calls, { measure: 0, metrics: 0 },
    'installed face enumeration must not consult host font providers');

  const EXPECTED = [
    ['Aria', 4], ['Syst', 1], ['MS S', 1], ['Fixe', 1], ['Cour', 1],
    ['Term', 1], ['Time', 4], ['Cour', 4], ['Taho', 4], ['Marl', 4],
    ['Symb', 4], ['Wing', 4], ['Webd', 4],
  ];
  const callback = makeCallback(false);
  const callbackData = allocZero(4 + 16 * (EXPECTED.length + 2));
  assert(wat.test_start_EnumFontsA(0, callback, callbackData));
  runCallbacks();
  assert.strictEqual(wat.guest_read32(callbackData), EXPECTED.length);
  assert.deepStrictEqual(Array.from({ length: EXPECTED.length }, (_, index) => [
    wat.guest_read32(callbackData + 4 + index * 16),
    wat.guest_read32(callbackData + 8 + index * 16),
  ]), EXPECTED.map(([name, type]) => [Buffer.from(name).readUInt32LE(), type]));
  // Every face reaches the guest with real metrics — a scalable one measured
  // from its own head/hhea/OS-2 at the nominal em, not a filled-in constant.
  for (let index = 0; index < EXPECTED.length; index++) {
    assert(wat.guest_read32(callbackData + 12 + index * 16) > 0,
      `callback ${index} must receive native text metrics`);
  }

  const stopCallback = makeCallback(true);
  const stopData = allocZero(4 + 16 * 4);
  assert(wat.test_start_EnumFontsA(0, stopCallback, stopData));
  runCallbacks();
  assert.strictEqual(wat.guest_read32(stopData), 2,
    'zero callback return must stop before the third face');

  const wideLogfont = allocZero(92);
  bytes[wa(wideLogfont) + 23] = 1; // DEFAULT_CHARSET
  [...'Terminal'].forEach((character, index) =>
    wat.guest_write16(wideLogfont + 28 + index * 2, character.charCodeAt(0)));
  const wideData = allocZero(4 + 16 * 2);
  assert(wat.test_start_EnumFontFamiliesExW(wideLogfont, callback, wideData));
  runCallbacks();
  assert.strictEqual(wat.guest_read32(wideData), 1);
  assert.strictEqual(wat.guest_read32(wideData + 4),
    'T'.charCodeAt(0) | ('e'.charCodeAt(0) << 16),
    'Unicode callback must receive the filtered Terminal face');
  console.log('PASS  installed FNT faces enumerate uniquely with native WAT metrics');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});

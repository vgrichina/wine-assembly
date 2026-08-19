#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  const canvasTextCalls = { bind: 0, mask: 0 };
  const { exports: wat, memory, hostCtx } = await bootRenderHarness({
    extraHostOverrides: {
      gdi_text_bind: () => { canvasTextCalls.bind++; return 1; },
      gdi_text_mask: () => { canvasTextCalls.mask++; return 0; },
    },
    extraWat: `
  (func (export "test_start_EnumMetaFile")
        (param $hdc i32) (param $hmf i32) (param $callback i32)
        (param $data i32) (result i32)
    (local $start i32)
    (local.set $start (global.get $esp))
    (call $gs32 (local.get $start) (i32.const 0))
    (call $handle_EnumMetaFile (local.get $hdc) (local.get $hmf)
      (local.get $callback) (local.get $data) (i32.const 0) (i32.const 0))
    (global.get $eip))
  (func (export "test_call_PlayMetaFileRecord")
        (param $hdc i32) (param $table i32) (param $record i32)
        (param $count i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_PlayMetaFileRecord (local.get $hdc) (local.get $table)
      (local.get $record) (local.get $count) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))`,
  });
  const root = path.join(__dirname, '..');
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
  const exe = fs.readFileSync(path.join(root, 'test', 'binaries', 'calc.exe'));
  new Uint8Array(memory.buffer).set(exe, wat.get_staging());
  assert(wat.load_pe(exe.length), 'PE load must initialize callback continuation thunks');
  const bytes = new Uint8Array(memory.buffer);
  const imageBase = wat.get_image_base() >>> 0;
  const wa = guest => (0x12000 + ((guest >>> 0) - imageBase)) >>> 0;
  let passed = 0;

  const check = (name, fn) => {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  };
  const allocZero = size => {
    const pointer = wat.guest_alloc(size) >>> 0;
    bytes.fill(0, wa(pointer), wa(pointer) + size);
    return pointer;
  };
  const makeWmf = () => {
    const data = allocZero(24);
    wat.guest_write16(data, 1);
    wat.guest_write16(data + 2, 9);
    wat.guest_write16(data + 4, 0x0300);
    wat.guest_write32(data + 6, 12);
    wat.guest_write32(data + 12, 3);
    wat.guest_write32(data + 18, 3);
    return data;
  };
  const makeVectorWmf = (records, objectCount = 2) => {
    const encoded = records.map(({ fn, params = [] }) => ({
      fn,
      params,
      words: 3 + params.length,
    }));
    const totalWords = 9 + encoded.reduce((sum, record) => sum + record.words, 0);
    const data = allocZero(totalWords * 2);
    wat.guest_write16(data, 1);
    wat.guest_write16(data + 2, 9);
    wat.guest_write16(data + 4, 0x0300);
    wat.guest_write32(data + 6, totalWords);
    wat.guest_write16(data + 10, objectCount);
    wat.guest_write32(data + 12, Math.max(...encoded.map(record => record.words)));
    let offset = 18;
    for (const record of encoded) {
      wat.guest_write32(data + offset, record.words);
      wat.guest_write16(data + offset + 4, record.fn);
      for (let i = 0; i < record.params.length; i++) {
        wat.guest_write16(data + offset + 6 + i * 2, record.params[i]);
      }
      offset += record.words * 2;
    }
    return { data, size: totalWords * 2 };
  };
  const makeEmf = () => {
    const data = allocZero(108);
    wat.guest_write32(data, 1);
    wat.guest_write32(data + 4, 88);
    wat.guest_write32(data + 40, 0x464d4520);
    wat.guest_write32(data + 44, 0x00010000);
    wat.guest_write32(data + 48, 108);
    wat.guest_write32(data + 52, 2);
    wat.guest_write16(data + 56, 1);
    wat.guest_write32(data + 88, 14);
    wat.guest_write32(data + 92, 20);
    wat.guest_write32(data + 104, 20);
    return data;
  };
  const emfDwords = (...values) => {
    const payload = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => payload.writeInt32LE(value | 0, index * 4));
    return payload;
  };
  const emfRecord = (type, payload = Buffer.alloc(0)) => {
    const size = (8 + payload.length + 3) & ~3;
    const record = Buffer.alloc(size);
    record.writeUInt32LE(type >>> 0, 0);
    record.writeUInt32LE(size, 4);
    Buffer.from(payload).copy(record, 8);
    return record;
  };
  const emfPolyRecord = (type, points, shortPoints = false) => {
    const payload = Buffer.alloc(20 + points.length * (shortPoints ? 4 : 8));
    const xs = points.map(point => point[0]);
    const ys = points.map(point => point[1]);
    payload.writeInt32LE(Math.min(...xs), 0);
    payload.writeInt32LE(Math.min(...ys), 4);
    payload.writeInt32LE(Math.max(...xs) + 1, 8);
    payload.writeInt32LE(Math.max(...ys) + 1, 12);
    payload.writeUInt32LE(points.length, 16);
    points.forEach(([x, y], index) => {
      if (shortPoints) {
        payload.writeInt16LE(x, 20 + index * 4);
        payload.writeInt16LE(y, 22 + index * 4);
      } else {
        payload.writeInt32LE(x, 20 + index * 8);
        payload.writeInt32LE(y, 24 + index * 8);
      }
    });
    return emfRecord(type, payload);
  };
  const makeVectorEmf = (records, {
    bounds = [0, 0, 64, 48], handles = 8,
  } = {}) => {
    const eof = emfRecord(14, emfDwords(0, 0, 20));
    const encoded = [...records, eof];
    const total = 88 + encoded.reduce((sum, record) => sum + record.length, 0);
    const stream = Buffer.alloc(total);
    stream.writeUInt32LE(1, 0);                  // EMR_HEADER
    stream.writeUInt32LE(88, 4);
    bounds.forEach((value, index) => stream.writeInt32LE(value, 8 + index * 4));
    bounds.forEach((value, index) => stream.writeInt32LE(value, 24 + index * 4));
    stream.writeUInt32LE(0x464d4520, 40);       // ENHMETA_SIGNATURE
    stream.writeUInt32LE(0x00010000, 44);
    stream.writeUInt32LE(total, 48);
    stream.writeUInt32LE(encoded.length + 1, 52);
    stream.writeUInt16LE(handles, 56);
    stream.writeInt32LE(bounds[2] - bounds[0], 72);
    stream.writeInt32LE(bounds[3] - bounds[1], 76);
    stream.writeInt32LE(169, 80);
    stream.writeInt32LE(127, 84);
    let offset = 88;
    for (const record of encoded) {
      record.copy(stream, offset);
      offset += record.length;
    }
    const data = allocZero(total);
    bytes.set(stream, wa(data));
    return { data, size: total };
  };
  const readBytes = (pointer, size) => Array.from(bytes.subarray(wa(pointer), wa(pointer) + size));
  const read16 = pointer => bytes[wa(pointer)] | (bytes[wa(pointer) + 1] << 8);
  const makeRecord = (fn, params = []) => {
    const record = allocZero((3 + params.length) * 2);
    wat.guest_write32(record, 3 + params.length);
    wat.guest_write16(record + 4, fn);
    params.forEach((value, index) => wat.guest_write16(record + 6 + index * 2, value));
    return record;
  };
  const bytesToWords = input => {
    const source = Buffer.from(input);
    const words = [];
    for (let offset = 0; offset < source.length; offset += 2) {
      words.push(source[offset] | ((source[offset + 1] || 0) << 8));
    }
    return words;
  };
  const makeLogFont16 = (face, height = -13, weight = 400) => {
    const logfont = Buffer.alloc(50);
    logfont.writeInt16LE(height, 0);
    logfont.writeInt16LE(weight, 8);
    logfont.write(face, 18, 32, 'latin1');
    return bytesToWords(logfont);
  };
  const makeTextOutParams = (text, x, y) => {
    const encoded = Buffer.from(text, 'latin1');
    const padded = (encoded.length + 1) & ~1;
    const params = Buffer.alloc(2 + padded + 4);
    params.writeInt16LE(encoded.length, 0);
    encoded.copy(params, 2);
    params.writeInt16LE(y, 2 + padded);
    params.writeInt16LE(x, 2 + padded + 2);
    return bytesToWords(params);
  };
  const makeExtTextOutParams = (text, x, y, options, rect, dx) => {
    const encoded = Buffer.from(text, 'latin1');
    const padded = (encoded.length + 1) & ~1;
    const hasRect = (options & 6) !== 0;
    const params = Buffer.alloc(8 + (hasRect ? 8 : 0) + padded + dx.length * 2);
    params.writeInt16LE(y, 0);
    params.writeInt16LE(x, 2);
    params.writeInt16LE(encoded.length, 4);
    params.writeUInt16LE(options, 6);
    let offset = 8;
    if (hasRect) {
      rect.forEach((value, index) => params.writeInt16LE(value, offset + index * 2));
      offset += 8;
    }
    encoded.copy(params, offset);
    offset += padded;
    dx.forEach((value, index) => params.writeInt16LE(value, offset + index * 2));
    return bytesToWords(params);
  };
  const makeRegionParams = scans => {
    const scanBytes = scans.reduce((sum, scan) => sum + 8 + scan.x.length * 2, 0);
    const region = Buffer.alloc(22 + scanBytes);
    const xs = scans.flatMap(scan => scan.x);
    const left = xs.length ? Math.min(...xs) : 0;
    const right = xs.length ? Math.max(...xs) : 0;
    const top = scans.length ? Math.min(...scans.map(scan => scan.top)) : 0;
    const bottom = scans.length ? Math.max(...scans.map(scan => scan.bottom)) : 0;
    region.writeInt16LE(6, 2);
    region.writeInt16LE(region.length, 8);
    region.writeInt16LE(scans.length, 10);
    region.writeInt16LE(scans.reduce((max, scan) => Math.max(max, scan.x.length), 0), 12);
    region.writeInt16LE(left, 14);
    region.writeInt16LE(top, 16);
    region.writeInt16LE(right, 18);
    region.writeInt16LE(bottom, 20);
    let offset = 22;
    for (const scan of scans) {
      region.writeUInt16LE(scan.x.length, offset);
      region.writeUInt16LE(scan.top, offset + 2);
      region.writeUInt16LE(scan.bottom, offset + 4);
      scan.x.forEach((value, index) => region.writeUInt16LE(value, offset + 6 + index * 2));
      region.writeUInt16LE(scan.x.length, offset + 6 + scan.x.length * 2);
      offset += 8 + scan.x.length * 2;
    }
    return bytesToWords(region);
  };
  const countColor = (hdc, left, top, right, bottom, color) => {
    let count = 0;
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        if ((wat.test_call_GetPixel(hdc, x, y) >>> 0) === color) count++;
      }
    }
    return count;
  };
  const makeEnumCallback = stopAfter => {
    const callback = allocZero(96);
    const code = [
      0x8b, 0x44, 0x24, 0x14,       // mov eax,[esp+20] (lParam)
      0x8b, 0x08,                   // mov ecx,[eax] (count)
      0xc1, 0xe1, 0x04,             // shl ecx,4
      0x8b, 0x54, 0x24, 0x0c,       // mov edx,[esp+12] (METARECORD*)
      0x0f, 0xb7, 0x52, 0x04,       // movzx edx,word [edx+4] (rdFunction)
      0x89, 0x54, 0x08, 0x04,       // mov [eax+ecx+4],edx
      0x8b, 0x54, 0x24, 0x10,       // mov edx,[esp+16] (nObj)
      0x89, 0x54, 0x08, 0x08,       // mov [eax+ecx+8],edx
      0x8b, 0x54, 0x24, 0x08,       // mov edx,[esp+8] (HANDLETABLE*)
      0x89, 0x54, 0x08, 0x0c,       // mov [eax+ecx+12],edx
      0xff, 0x00,                   // inc dword [eax]
    ];
    if (stopAfter) {
      code.push(
        0x8b, 0x10,                 // mov edx,[eax]
        0x31, 0xc0,                 // xor eax,eax
        0x83, 0xfa, stopAfter,       // cmp edx,stopAfter
        0x0f, 0x92, 0xc0,           // setb al
      );
    } else {
      code.push(0xb8, 0x01, 0x00, 0x00, 0x00); // mov eax,1
    }
    code.push(0xc2, 0x14, 0x00);    // ret 20
    bytes.set(code, wa(callback));
    return callback;
  };
  const runCallbacks = () => {
    for (let index = 0; index < 1000 && wat.get_eip(); index++) wat.run(1000);
    assert.strictEqual(wat.get_eip(), 0, 'metafile callback sequence must restore caller EIP');
  };

  check('classic WMF bits are owned, copied, typed, and deleted in WAT', () => {
    const source = makeWmf();
    const metafile = wat.test_call_SetMetaFileBitsEx(24, source) >>> 0;
    assert(metafile);
    assert.strictEqual(wat.test_call_GetObjectType(metafile), 9);
    assert.strictEqual(wat.test_call_GetMetaFileBitsEx(metafile, 0, 0), 24);
    const output = allocZero(24);
    assert.strictEqual(wat.test_call_GetMetaFileBitsEx(metafile, 24, output), 24);
    assert.deepStrictEqual(readBytes(output, 24), readBytes(source, 24));
    assert.strictEqual(wat.test_call_DeleteMetaFile(metafile), 1);
    assert.strictEqual(wat.test_call_DeleteMetaFile(metafile), 0);
  });

  check('classic recording serializes and replays canonical pixels', () => {
    const recording = wat.test_call_CreateMetaFileA(0) >>> 0;
    assert(recording);
    const red = wat.test_call_CreateSolidBrush(0x000000ff) >>> 0;
    const rect = allocZero(16);
    wat.guest_write32(rect, 10);
    wat.guest_write32(rect + 4, 10);
    wat.guest_write32(rect + 8, 30);
    wat.guest_write32(rect + 12, 25);
    assert.strictEqual(wat.test_call_FillRect(recording, rect, red), 1);
    assert.strictEqual(wat.test_call_GetPixel(recording, 15, 15) >>> 0, 0x000000ff);
    const metafile = wat.test_call_CloseMetaFile(recording) >>> 0;
    assert(metafile);
    const required = wat.test_call_GetMetaFileBitsEx(metafile, 0, 0) >>> 0;
    assert.strictEqual(required, 640 * 480 * 4 + 130);
    const stream = allocZero(required);
    assert.strictEqual(wat.test_call_GetMetaFileBitsEx(metafile, required, stream), required);
    assert.strictEqual(wat.guest_read32(stream + 6) * 2, required,
      'METAHEADER size must cover the complete stream');
    assert.strictEqual(read16(stream + 60), 0x0f43,
      'recording must use the standard META_STRETCHDIB record');
    assert.strictEqual(wat.guest_read32(stream + 84), 40);
    assert.strictEqual(wat.guest_read32(stream + 88), 640);
    assert.strictEqual(wat.guest_read32(stream + 92) | 0, -480);

    const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    const bitmap = wat.test_call_CreateCompatibleBitmap(0, 640, 480) >>> 0;
    assert(bitmap);
    assert.notStrictEqual(wat.test_call_SelectObject(hdc, bitmap) | 0, -1);
    assert.strictEqual(wat.test_call_PlayMetaFile(hdc, metafile), 1);
    assert.strictEqual(wat.test_call_GetPixel(hdc, 15, 15) >>> 0, 0x000000ff,
      'replay must restore recorded geometry');
    assert.strictEqual(wat.test_call_GetPixel(hdc, 0, 0) >>> 0, 0x00ffffff,
      'replay must preserve the recording surface background');
    assert.strictEqual(wat.test_call_DeleteMetaFile(metafile), 1);
  });

  check('classic WMF vector records replay through canonical WAT state and pixels', () => {
    const { data, size } = makeVectorWmf([
      { fn: 0x0103, params: [8] },                         // META_SETMAPMODE
      { fn: 0x020c, params: [48, 64] },                    // META_SETWINDOWEXT
      { fn: 0x020e, params: [96, 128] },                   // META_SETVIEWPORTEXT
      { fn: 0x02fa, params: [0, 1, 0, 0x00ff, 0] },       // red pen
      { fn: 0x02fc, params: [0, 0, 0x00ff, 0] },          // blue brush
      { fn: 0x012d, params: [0] },                         // select pen
      { fn: 0x012d, params: [1] },                         // select brush
      { fn: 0x001e },                                      // save DC
      { fn: 0x0104, params: [7] },                         // temporary XOR ROP2
      { fn: 0x0127, params: [0xffff] },                    // restore DC -1
      { fn: 0x041b, params: [15, 20, 5, 5] },             // rectangle
      { fn: 0x0418, params: [20, 40, 5, 25] },            // ellipse
      { fn: 0x061c, params: [4, 4, 35, 60, 25, 40] },     // round rectangle
      { fn: 0x0324, params: [3, 45, 5, 60, 5, 52, 20] },  // polygon
      { fn: 0x0325, params: [3, 5, 30, 20, 35, 35, 30] }, // polyline
      { fn: 0x0214, params: [40, 2] },                     // move to
      { fn: 0x0213, params: [40, 30] },                    // line to
      { fn: 0x012d, params: [0x8007] },                    // stock black pen
      { fn: 0x012d, params: [0x8000] },                    // stock white brush
      { fn: 0x01f0, params: [0] },                         // delete pen
      { fn: 0x01f0, params: [1] },                         // delete brush
      { fn: 0x0000 },                                      // EOF
    ]);
    const metafile = wat.test_call_SetMetaFileBitsEx(size, data) >>> 0;
    assert(metafile);

    const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    const bitmap = wat.test_call_CreateCompatibleBitmap(0, 128, 96) >>> 0;
    const callerPen = wat.test_call_CreatePen(0, 1, 0x0000ff00) >>> 0;
    const callerBrush = wat.test_call_CreateSolidBrush(0x0000ffff) >>> 0;
    assert(bitmap && callerPen && callerBrush);
    assert.notStrictEqual(wat.test_call_SelectObject(hdc, bitmap) | 0, -1);
    wat.test_call_SelectObject(hdc, callerPen);
    wat.test_call_SelectObject(hdc, callerBrush);
    const reusable = wat.test_call_CreateSolidBrush(0x00010101) >>> 0;
    assert(reusable);
    assert.strictEqual(wat.test_call_DeleteObject(reusable), 1);

    assert.strictEqual(wat.test_call_PlayMetaFile(hdc, metafile), 1);
    assert.strictEqual(wat.test_call_GetPixel(hdc, 10, 10) >>> 0, 0x000000ff,
      'mapped rectangle edge must use the metafile pen');
    assert.strictEqual(wat.test_call_GetPixel(hdc, 20, 20) >>> 0, 0x00ff0000,
      'mapped rectangle interior must use the metafile brush');
    assert.strictEqual(wat.test_call_GetPixel(hdc, 65, 25) >>> 0, 0x00ff0000,
      'ellipse interior must replay through the integer rasterizer');
    assert.strictEqual(wat.test_call_GetPixel(hdc, 100, 60) >>> 0, 0x00ff0000,
      'round-rectangle interior must replay through the integer rasterizer');
    assert.strictEqual(wat.test_call_GetPixel(hdc, 104, 20) >>> 0, 0x00ff0000,
      'polygon interior must replay through the integer rasterizer');
    assert.strictEqual(wat.test_call_GetPixel(hdc, 20, 80) >>> 0, 0x000000ff,
      'MoveTo/LineTo must honor the mapped current position');
    assert.strictEqual(wat.test_call_GetCurrentObject(hdc, 1) >>> 0, callerPen,
      'playback must restore the caller pen');
    assert.strictEqual(wat.test_call_GetCurrentObject(hdc, 2) >>> 0, callerBrush,
      'playback must restore the caller brush');
    for (let i = 0; i < 140; i++) {
      assert.strictEqual(wat.test_call_PlayMetaFile(hdc, metafile), 1,
        'repeated playback must not exhaust the WAT object table');
    }
    const recycled = wat.test_call_CreateSolidBrush(0x00020202) >>> 0;
    assert(recycled, 'temporary WMF objects must be released after playback');
    assert.strictEqual(wat.test_call_DeleteObject(recycled), 1);
    assert.strictEqual(wat.test_call_DeleteMetaFile(metafile), 1);
  });

  check('classic WMF text records rasterize installed FON glyphs without Canvas', () => {
    const { data, size } = makeVectorWmf([
      { fn: 0x02fb, params: makeLogFont16('MS Sans Serif') }, // create font
      { fn: 0x012d, params: [0] },                            // select font
      { fn: 0x0102, params: [1] },                            // transparent background
      { fn: 0x0209, params: [0x00ff, 0] },                    // red text
      { fn: 0x012e, params: [0] },                            // top-left alignment
      { fn: 0x0108, params: [2] },                            // character extra
      { fn: 0x020a, params: [1, 4] },                         // justification count/extra
      { fn: 0x0521, params: makeTextOutParams('WMF', 4, 3) },
      { fn: 0x0201, params: [0xff00, 0] },                    // green background
      { fn: 0x0a32, params: makeExtTextOutParams(
        'DX', 4, 24, 6, [4, 22, 30, 40], [20, 20]) },
      { fn: 0x0000 },
    ]);
    const metafile = wat.test_call_SetMetaFileBitsEx(size, data) >>> 0;
    const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    const bitmap = wat.test_call_CreateCompatibleBitmap(0, 96, 56) >>> 0;
    const white = wat.test_call_CreateSolidBrush(0x00ffffff) >>> 0;
    const fill = allocZero(16);
    wat.guest_write32(fill + 8, 96);
    wat.guest_write32(fill + 12, 56);
    assert(metafile && hdc && bitmap && white);
    assert.notStrictEqual(wat.test_call_SelectObject(hdc, bitmap) | 0, -1);
    assert.strictEqual(wat.test_call_FillRect(hdc, fill, white), 1);
    wat.test_gdi_dc_set_field(hdc, 32, 6, 0);
    wat.test_gdi_dc_aux_set(hdc, 20, 7, 0);
    wat.test_gdi_dc_aux_set(hdc, 24, 9, 0);
    wat.test_gdi_dc_aux_set(hdc, 28, 3, 0);
    const callerFont = wat.test_call_GetCurrentObject(hdc, 6) >>> 0;
    const callerTextColor = wat.test_gdi_dc_get_field(hdc, 20, 0) >>> 0;
    const callerBkColor = wat.test_gdi_dc_get_field(hdc, 24, 0xffffff) >>> 0;
    const beforeCanvas = { ...canvasTextCalls };

    assert.strictEqual(wat.test_call_PlayMetaFile(hdc, metafile), 1);
    assert.deepStrictEqual(canvasTextCalls, beforeCanvas,
      'installed Win9x bitmap fonts must not invoke Canvas font imports');
    assert(countColor(hdc, 4, 3, 40, 20, 0x000000ff) > 20,
      'META_TEXTOUT must rasterize red bitmap glyphs');
    assert(countColor(hdc, 4, 24, 13, 37, 0x000000ff) > 3,
      'first META_EXTTEXTOUT glyph must begin at the requested origin');
    assert.strictEqual(countColor(hdc, 13, 24, 23, 37, 0x000000ff), 0,
      'signed WMF Dx advances must leave the requested inter-glyph gap');
    assert(countColor(hdc, 24, 24, 30, 37, 0x000000ff) > 3,
      'second glyph must use the widened signed WMF Dx advance');
    assert(countColor(hdc, 4, 22, 30, 40, 0x0000ff00) > 100,
      'ETO_OPAQUE must fill the logical rectangle with the WMF background color');
    assert.strictEqual(countColor(hdc, 30, 22, 38, 40, 0x000000ff), 0,
      'ETO_CLIPPED must reject glyph pixels outside the logical rectangle');
    assert.strictEqual(wat.test_call_GetPixel(hdc, 31, 23) >>> 0, 0x00ffffff,
      'ETO_OPAQUE must not fill outside its logical rectangle');
    assert.strictEqual(wat.test_call_GetCurrentObject(hdc, 6) >>> 0, callerFont,
      'playback must restore the caller font');
    assert.strictEqual(wat.test_gdi_dc_get_field(hdc, 20, 0) >>> 0, callerTextColor,
      'playback must restore the caller text color');
    assert.strictEqual(wat.test_gdi_dc_get_field(hdc, 24, 0xffffff) >>> 0, callerBkColor,
      'playback must restore the caller background color');
    assert.strictEqual(wat.test_gdi_dc_get_field(hdc, 32, 0), 6,
      'playback must restore the caller text alignment');
    assert.strictEqual(wat.test_gdi_dc_aux_get(hdc, 20, 0), 7,
      'playback must restore the caller character spacing');
    assert.strictEqual(wat.test_gdi_dc_aux_get(hdc, 24, 0), 9,
      'playback must restore the caller justification extra');
    assert.strictEqual(wat.test_gdi_dc_aux_get(hdc, 28, 0), 3,
      'playback must restore the caller justification break count');

    for (let i = 0; i < 20; i++) {
      assert.strictEqual(wat.test_call_PlayMetaFile(hdc, metafile), 1,
        'repeated WMF font playback must recycle temporary font objects');
    }
    assert.deepStrictEqual(canvasTextCalls, beforeCanvas,
      'repeated FON replay must remain entirely on the WAT raster path');
    assert.strictEqual(wat.test_call_DeleteObject(white), 1);
    assert.strictEqual(wat.test_call_DeleteMetaFile(metafile), 1);
  });

  check('classic WMF regions replay canonical drawing and mapped clipping', () => {
    const region = makeRegionParams([
      { top: 5, bottom: 15, x: [5, 15, 25, 35] },
      { top: 15, bottom: 25, x: [10, 30] },
    ]);
    const { data, size } = makeVectorWmf([
      { fn: 0x0103, params: [8] },                         // META_SETMAPMODE
      { fn: 0x020c, params: [48, 64] },                    // META_SETWINDOWEXT
      { fn: 0x020e, params: [96, 128] },                   // META_SETVIEWPORTEXT
      { fn: 0x02fc, params: [0, 0x00ff, 0, 0] },          // red brush, slot 0
      { fn: 0x02fc, params: [0, 0x0000, 0x00ff, 0] },     // blue brush, slot 1
      { fn: 0x02fc, params: [0, 0xff00, 0, 0] },          // green brush, slot 2
      { fn: 0x06ff, params: region },                      // region, slot 3
      { fn: 0x0228, params: [3, 0] },                     // fill region red
      { fn: 0x0429, params: [3, 1, 1, 1] },               // frame region blue
      { fn: 0x012a, params: [3] },                         // invert region
      { fn: 0x012d, params: [2] },                         // select green brush
      { fn: 0x012b, params: [3] },                         // paint region green
      { fn: 0x012c, params: [3] },                         // select clip region
      { fn: 0x0416, params: [25, 30, 5, 10] },            // intersect clip rect
      { fn: 0x0415, params: [15, 20, 5, 10] },            // exclude clip rect
      { fn: 0x0220, params: [2, 3] },                      // offset clip y,x
      { fn: 0x012d, params: [0] },                         // select red brush
      { fn: 0x041b, params: [30, 40, 0, 0] },             // clipped rectangle
      { fn: 0x01f0, params: [3] },                         // delete region
      { fn: 0x06ff, params: makeRegionParams([
        { top: 7, bottom: 9, x: [28, 33] },
      ]) },                                                // reuse slot 3
      { fn: 0x0000 },
    ], 4);
    const metafile = wat.test_call_SetMetaFileBitsEx(size, data) >>> 0;
    const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    const bitmap = wat.test_call_CreateCompatibleBitmap(0, 128, 96) >>> 0;
    const white = wat.test_call_CreateSolidBrush(0x00ffffff) >>> 0;
    const cyan = wat.test_call_CreateSolidBrush(0x00ffff00) >>> 0;
    const fill = allocZero(16);
    wat.guest_write32(fill + 8, 128);
    wat.guest_write32(fill + 12, 96);
    assert(metafile && hdc && bitmap && white && cyan);
    assert.notStrictEqual(wat.test_call_SelectObject(hdc, bitmap) | 0, -1);
    assert.strictEqual(wat.test_call_FillRect(hdc, fill, white), 1);
    assert.strictEqual(wat.test_call_PlayMetaFile(hdc, metafile), 1);
    assert.strictEqual(wat.test_call_GetPixel(hdc, 24, 20) >>> 0, 0x0000ff00,
      'PaintRegion must use the selected brush before later clipped output');
    assert.strictEqual(wat.test_call_GetPixel(hdc, 40, 20) >>> 0, 0x00ffffff,
      'disjoint scan spans must preserve the hole in a complex region');
    assert.strictEqual(wat.test_call_GetPixel(hdc, 60, 20) >>> 0, 0x000000ff,
      'mapped selected clip must retain the shifted upper band');
    assert.strictEqual(wat.test_call_GetPixel(hdc, 30, 40) >>> 0, 0x000000ff,
      'intersect/exclude/offset clip mutations must retain the lower band');
    assert.strictEqual(wat.test_call_GetPixel(hdc, 20, 20) >>> 0, 0x0000ff00,
      'excluded clip pixels must remain from PaintRegion');

    const outside = allocZero(16);
    wat.guest_write32(outside, 80);
    wat.guest_write32(outside + 4, 70);
    wat.guest_write32(outside + 8, 90);
    wat.guest_write32(outside + 12, 80);
    assert.strictEqual(wat.test_call_FillRect(hdc, outside, cyan), 1);
    assert.strictEqual(wat.test_call_GetPixel(hdc, 85, 75) >>> 0, 0x00ffff00,
      'PlayMetaFile must restore the caller clip after region playback');

    for (let i = 0; i < 140; i++) {
      assert.strictEqual(wat.test_call_PlayMetaFile(hdc, metafile), 1,
        'created and selected WMF regions must recycle after playback');
    }

    const operationDc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    const operationBitmap = wat.test_call_CreateCompatibleBitmap(0, 48, 32) >>> 0;
    const operationFill = allocZero(16);
    wat.guest_write32(operationFill + 8, 48);
    wat.guest_write32(operationFill + 12, 32);
    assert(operationDc && operationBitmap);
    assert.notStrictEqual(wat.test_call_SelectObject(operationDc, operationBitmap) | 0, -1);
    assert.strictEqual(wat.test_call_FillRect(operationDc, operationFill, white), 1);
    const table = allocZero(16);
    const operationRecords = [
      makeRecord(0x02fc, [0, 0x00ff, 0, 0]),
      makeRecord(0x02fc, [0, 0x0000, 0x00ff, 0]),
      makeRecord(0x02fc, [0, 0xff00, 0, 0]),
      makeRecord(0x06ff, region),
    ];
    for (const record of operationRecords) {
      assert.strictEqual(wat.test_call_PlayMetaFileRecord(operationDc, table, record, 4), 1);
    }
    const handle = wat.guest_read32(table + 12) >>> 0;
    assert((handle & 0xffff0000) === 0x00500000,
      'PlayMetaFileRecord must publish a canonical HRGN in the handle table');
    assert.strictEqual(wat.test_call_PlayMetaFileRecord(
      operationDc, table, makeRecord(0x0228, [3, 0]), 4), 1);
    assert.strictEqual(wat.test_call_GetPixel(operationDc, 7, 7) >>> 0, 0x000000ff,
      'META_FILLREGION must fill each region band with its indexed brush');
    assert.strictEqual(wat.test_call_GetPixel(operationDc, 20, 10) >>> 0, 0x00ffffff,
      'META_FILLREGION must not bridge disjoint spans');
    assert.strictEqual(wat.test_call_PlayMetaFileRecord(
      operationDc, table, makeRecord(0x0429, [3, 1, 1, 1]), 4), 1);
    assert.strictEqual(wat.test_call_GetPixel(operationDc, 5, 5) >>> 0, 0x00ff0000,
      'META_FRAMEREGION must rasterize its indexed brush on the boundary');
    assert.strictEqual(wat.test_call_GetPixel(operationDc, 7, 7) >>> 0, 0x000000ff,
      'META_FRAMEREGION must preserve the region interior');
    assert.strictEqual(wat.test_call_PlayMetaFileRecord(
      operationDc, table, makeRecord(0x012a, [3]), 4), 1);
    assert.strictEqual(wat.test_call_GetPixel(operationDc, 7, 7) >>> 0, 0x00ffff00,
      'META_INVERTREGION must apply DSTINVERT to canonical pixels');
    assert.strictEqual(wat.test_call_PlayMetaFileRecord(
      operationDc, table, makeRecord(0x012d, [2]), 4), 1);
    assert.strictEqual(wat.test_call_PlayMetaFileRecord(
      operationDc, table, makeRecord(0x012b, [3]), 4), 1);
    assert.strictEqual(wat.test_call_GetPixel(operationDc, 7, 7) >>> 0, 0x0000ff00,
      'META_PAINTREGION must use the currently selected brush');
    for (let index = 0; index < 4; index++) {
      assert.strictEqual(wat.test_call_PlayMetaFileRecord(
        operationDc, table, makeRecord(0x01f0, [index]), 4), 1);
    }
    assert.strictEqual(wat.guest_read32(table + 12), 0,
      'META_DELETEOBJECT must delete and clear a region slot');

    const odd = Buffer.from(region.flatMap(word => [word & 0xff, word >>> 8]));
    odd.writeUInt16LE(3, 22);
    const oddRecord = makeRecord(0x06ff, bytesToWords(odd));
    assert.strictEqual(wat.test_call_PlayMetaFileRecord(operationDc, table, oddRecord, 4), 0,
      'odd scan coordinate counts must fail atomically');
    const mismatch = Buffer.from(region.flatMap(word => [word & 0xff, word >>> 8]));
    mismatch.writeUInt16LE(2, 22 + 6 + 4 * 2);
    const mismatchRecord = makeRecord(0x06ff, bytesToWords(mismatch));
    assert.strictEqual(wat.test_call_PlayMetaFileRecord(operationDc, table, mismatchRecord, 4), 0,
      'Count2 mismatches must fail atomically');
    const shortRegion = region.slice(0, -1);
    const shortRecord = makeRecord(0x06ff, shortRegion);
    assert.strictEqual(wat.test_call_PlayMetaFileRecord(operationDc, table, shortRecord, 4), 0,
      'truncated region scan data must fail atomically');

    assert.strictEqual(wat.test_call_DeleteObject(white), 1);
    assert.strictEqual(wat.test_call_DeleteObject(cyan), 1);
    assert.strictEqual(wat.test_call_DeleteMetaFile(metafile), 1);
  });

  check('EnumMetaFile invokes guest callbacks for validated records and honors stop', () => {
    const { data, size } = makeVectorWmf([
      { fn: 0x02fa, params: [0, 1, 0, 0x00ff, 0] }, // create red pen
      { fn: 0x012d, params: [0] },                    // select pen
      { fn: 0x0214, params: [2, 2] },                 // move to
      { fn: 0x0213, params: [2, 20] },                // line to
      { fn: 0x0000 },                                 // EOF
    ]);
    const metafile = wat.test_call_SetMetaFileBitsEx(size, data) >>> 0;
    const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    const bitmap = wat.test_call_CreateCompatibleBitmap(0, 32, 16) >>> 0;
    assert(metafile && hdc && bitmap);
    assert.notStrictEqual(wat.test_call_SelectObject(hdc, bitmap) | 0, -1);

    const callback = makeEnumCallback(0);
    const callbackData = allocZero(4 + 16 * 8);
    assert(wat.test_start_EnumMetaFile(hdc, metafile, callback, callbackData));
    runCallbacks();
    assert.strictEqual(wat.get_eax(), 1, 'complete enumeration returns TRUE');
    assert.strictEqual(wat.guest_read32(callbackData), 5);
    assert.deepStrictEqual(Array.from({ length: 5 }, (_, index) =>
      wat.guest_read32(callbackData + 4 + index * 16)),
    [0x02fa, 0x012d, 0x0214, 0x0213, 0x0000],
    'callbacks must receive every record including META_EOF');
    for (let index = 0; index < 5; index++) {
      assert.strictEqual(wat.guest_read32(callbackData + 8 + index * 16), 2,
        'callback nObj must come from METAHEADER');
      assert(wat.guest_read32(callbackData + 12 + index * 16),
        'callback must receive a live HANDLETABLE');
    }

    const stopCallback = makeEnumCallback(2);
    const stopData = allocZero(4 + 16 * 4);
    assert(wat.test_start_EnumMetaFile(hdc, metafile, stopCallback, stopData));
    runCallbacks();
    assert.strictEqual(wat.guest_read32(stopData), 2);
    assert.strictEqual(wat.get_eax(), 0, 'zero callback return stops enumeration');

    const malformed = makeVectorWmf([{ fn: 0x0214, params: [2, 2] }]);
    wat.guest_write32(malformed.data + 18, 0x1000);
    const bad = wat.test_call_SetMetaFileBitsEx(malformed.size, malformed.data) >>> 0;
    assert(bad);
    const badData = allocZero(32);
    assert.strictEqual(wat.test_start_EnumMetaFile(hdc, bad, callback, badData), 0,
      'out-of-bounds first record must fail before entering the callback');
    assert.strictEqual(wat.get_eax(), 0);
    assert.strictEqual(wat.test_call_DeleteMetaFile(bad), 1);
    assert.strictEqual(wat.test_call_DeleteMetaFile(metafile), 1);
  });

  check('PlayMetaFileRecord preserves handle-table state across record calls', () => {
    const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    const bitmap = wat.test_call_CreateCompatibleBitmap(0, 32, 16) >>> 0;
    const table = allocZero(8);
    assert(hdc && bitmap);
    assert.notStrictEqual(wat.test_call_SelectObject(hdc, bitmap) | 0, -1);

    const createPen = makeRecord(0x02fa, [0, 1, 0, 0x00ff, 0]);
    const selectPen = makeRecord(0x012d, [0]);
    const moveTo = makeRecord(0x0214, [2, 2]);
    const lineTo = makeRecord(0x0213, [2, 20]);
    const deletePen = makeRecord(0x01f0, [0]);
    for (const record of [createPen, selectPen, moveTo, lineTo]) {
      assert.strictEqual(wat.test_call_PlayMetaFileRecord(hdc, table, record, 2), 1);
    }
    const pen = wat.guest_read32(table) >>> 0;
    assert(pen, 'META_CREATEPENINDIRECT must publish the first free handle-table slot');
    assert.strictEqual(wat.test_call_GetObjectType(pen), 1);
    assert.strictEqual(wat.test_call_GetPixel(hdc, 5, 2) >>> 0, 0x000000ff,
      'separate select/move/line records must share DC and object-table state');
    assert.strictEqual(wat.test_call_PlayMetaFileRecord(hdc, table, deletePen, 2), 1);
    assert.strictEqual(wat.guest_read32(table), 0,
      'META_DELETEOBJECT must clear the external handle-table slot');

    const malformed = makeRecord(0x0213, []);
    assert.strictEqual(wat.test_call_PlayMetaFileRecord(hdc, table, malformed, 2), 0,
      'short supported records must fail atomically');
    const truncatedText = makeRecord(0x0521, [4, 0x4241]);
    assert.strictEqual(wat.test_call_PlayMetaFileRecord(hdc, table, truncatedText, 2), 0,
      'META_TEXTOUT must reject a string whose coordinates are truncated');
    const truncatedDx = makeRecord(0x0a32, [10, 10, 2, 0, 0x4241, 8]);
    assert.strictEqual(wat.test_call_PlayMetaFileRecord(hdc, table, truncatedDx, 2), 0,
      'META_EXTTEXTOUT must reject a partial signed Dx array');
  });

  check('enhanced metafile transport supports headers, copy, play, and deletion', () => {
    const source = makeEmf();
    const metafile = wat.test_call_SetEnhMetaFileBits(108, source) >>> 0;
    assert(metafile);
    assert.strictEqual(wat.test_call_GetObjectType(metafile), 13);
    assert.strictEqual(wat.test_call_GetEnhMetaFileBits(metafile, 0, 0), 108);
    const header = allocZero(88);
    assert.strictEqual(wat.test_call_GetEnhMetaFileHeader(metafile, 0, 0), 88);
    assert.strictEqual(wat.test_call_GetEnhMetaFileHeader(metafile, 88, header), 88);
    assert.strictEqual(wat.guest_read32(header + 40) >>> 0, 0x464d4520);
    assert.strictEqual(wat.test_call_GetEnhMetaFilePaletteEntries(metafile, 0, 0), 0);
    const copy = wat.test_call_CopyEnhMetaFileA(metafile, 0) >>> 0;
    assert(copy && copy !== metafile);
    const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    const bitmap = wat.test_call_CreateCompatibleBitmap(0, 64, 64) >>> 0;
    assert.notStrictEqual(wat.test_call_SelectObject(hdc, bitmap) | 0, -1);
    const rect = allocZero(16);
    wat.guest_write32(rect + 8, 64);
    wat.guest_write32(rect + 12, 64);
    assert.strictEqual(wat.test_call_PlayEnhMetaFile(hdc, copy, rect), 1);
    assert.strictEqual(wat.test_call_DeleteEnhMetaFile(metafile), 1);
    assert.strictEqual(wat.test_call_GetEnhMetaFileBits(copy, 0, 0), 108,
      'copy must retain independent storage');
    assert.strictEqual(wat.test_call_DeleteEnhMetaFile(copy), 1);
  });

  check('enhanced vector records replay through canonical WAT state and pixels', () => {
    const { data, size } = makeVectorEmf([
      emfRecord(17, emfDwords(8)),                         // EMR_SETMAPMODE
      emfRecord(9, emfDwords(64, 48)),                    // EMR_SETWINDOWEXTEX
      emfRecord(11, emfDwords(64, 48)),                   // EMR_SETVIEWPORTEXTEX
      emfRecord(38, emfDwords(1, 0, 1, 0, 0x000000ff)),  // red pen
      emfRecord(39, emfDwords(2, 0, 0x0000ff00, 0)),     // green brush
      emfRecord(37, emfDwords(1)),                        // select pen
      emfRecord(37, emfDwords(2)),                        // select brush
      emfRecord(33),                                      // save DC
      emfRecord(20, emfDwords(7)),                        // temporary XOR ROP2
      emfRecord(34, emfDwords(-1)),                       // restore DC
      emfRecord(43, emfDwords(5, 5, 20, 15)),            // rectangle
      emfRecord(42, emfDwords(24, 4, 38, 18)),           // ellipse
      emfRecord(44, emfDwords(40, 4, 60, 18, 4, 4)),     // round rectangle
      emfPolyRecord(3, [[24, 24], [38, 24], [31, 38]]),  // polygon
      emfRecord(27, emfDwords(2, 22)),                    // move to
      emfRecord(54, emfDwords(20, 22)),                   // line to
      emfPolyRecord(4, [[42, 24], [60, 24], [60, 38]]),  // polyline
      emfRecord(27, emfDwords(2, 40)),                    // move to
      emfPolyRecord(89, [[10, 40], [10, 45]], true),      // polyline-to 16
      emfRecord(15, emfDwords(22, 40, 0x00ff0000)),       // blue pixel
      emfRecord(37, emfDwords(0x80000007)),               // stock black pen
      emfRecord(37, emfDwords(0x80000000)),               // stock white brush
      emfRecord(40, emfDwords(1)),                        // delete pen
      emfRecord(40, emfDwords(2)),                        // delete brush
    ]);
    const metafile = wat.test_call_SetEnhMetaFileBits(size, data) >>> 0;
    const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    const bitmap = wat.test_call_CreateCompatibleBitmap(0, 148, 112) >>> 0;
    const callerPen = wat.test_call_CreatePen(0, 1, 0x0000ffff) >>> 0;
    const callerBrush = wat.test_call_CreateSolidBrush(0x00ff00ff) >>> 0;
    const target = allocZero(16);
    wat.guest_write32(target, 10);
    wat.guest_write32(target + 4, 8);
    wat.guest_write32(target + 8, 138);
    wat.guest_write32(target + 12, 104);
    assert(metafile && hdc && bitmap && callerPen && callerBrush);
    assert.notStrictEqual(wat.test_call_SelectObject(hdc, bitmap) | 0, -1);
    wat.test_call_SelectObject(hdc, callerPen);
    wat.test_call_SelectObject(hdc, callerBrush);
    wat.test_gdi_dc_set_field(hdc, 12, 77, 0);
    wat.test_gdi_dc_set_field(hdc, 16, 66, 0);
    wat.test_gdi_dc_set_field(hdc, 36, 1, 1);
    wat.test_gdi_dc_set_field(hdc, 48, 3, 1);
    wat.test_gdi_dc_set_field(hdc, 52, 4, 1);
    wat.test_gdi_dc_set_field(hdc, 64, 5, 1);
    wat.test_gdi_dc_set_field(hdc, 68, 6, 1);

    assert.strictEqual(wat.test_call_PlayEnhMetaFile(hdc, metafile, target), 1);
    assert.strictEqual(wat.test_call_GetCurrentObject(hdc, 1) >>> 0, callerPen);
    assert.strictEqual(wat.test_call_GetCurrentObject(hdc, 2) >>> 0, callerBrush);
    assert.strictEqual(wat.test_gdi_dc_get_field(hdc, 12, 0), 77);
    assert.strictEqual(wat.test_gdi_dc_get_field(hdc, 16, 0), 66);
    assert.strictEqual(wat.test_gdi_dc_get_field(hdc, 36, 0), 1);
    assert.strictEqual(wat.test_gdi_dc_get_field(hdc, 48, 0), 3);
    assert.strictEqual(wat.test_gdi_dc_get_field(hdc, 52, 0), 4);
    assert.strictEqual(wat.test_gdi_dc_get_field(hdc, 64, 0), 5);
    assert.strictEqual(wat.test_gdi_dc_get_field(hdc, 68, 0), 6);
    wat.test_gdi_dc_set_field(hdc, 40, 0, 0);
    wat.test_gdi_dc_set_field(hdc, 44, 0, 0);
    wat.test_gdi_dc_set_field(hdc, 48, 1, 1);
    wat.test_gdi_dc_set_field(hdc, 52, 1, 1);
    wat.test_gdi_dc_set_field(hdc, 56, 0, 0);
    wat.test_gdi_dc_set_field(hdc, 60, 0, 0);
    wat.test_gdi_dc_set_field(hdc, 64, 1, 1);
    wat.test_gdi_dc_set_field(hdc, 68, 1, 1);
    assert.strictEqual(wat.test_call_GetPixel(hdc, 20, 18) >>> 0, 0x000000ff,
      'target-scaled rectangle edge must use the EMF pen');
    assert.strictEqual(wat.test_call_GetPixel(hdc, 30, 28) >>> 0, 0x0000ff00,
      'target-scaled rectangle interior must use the EMF brush');
    assert.strictEqual(wat.test_call_GetPixel(hdc, 72, 30) >>> 0, 0x0000ff00,
      'ellipse interior must use the canonical integer rasterizer');
    assert.strictEqual(wat.test_call_GetPixel(hdc, 110, 30) >>> 0, 0x0000ff00,
      'round-rectangle interior must use the canonical integer rasterizer');
    assert.strictEqual(wat.test_call_GetPixel(hdc, 72, 68) >>> 0, 0x0000ff00,
      '32-bit EMR_POLYGON must fill at the mapped target location');
    assert.strictEqual(wat.test_call_GetPixel(hdc, 30, 52) >>> 0, 0x000000ff,
      'EMR_MOVETOEX/EMR_LINETO must preserve the logical current position');
    assert.strictEqual(wat.test_call_GetPixel(hdc, 110, 56) >>> 0, 0x000000ff,
      '32-bit EMR_POLYLINE must rasterize exact WAT pixels');
    assert.strictEqual(wat.test_call_GetPixel(hdc, 30, 88) >>> 0, 0x000000ff,
      '16-bit EMR_POLYLINETO16 must widen signed points and continue the path');
    assert.strictEqual(wat.test_call_GetPixel(hdc, 54, 88) >>> 0, 0x00ff0000,
      'EMR_SETPIXELV must write the canonical target surface');
    for (let index = 0; index < 140; index++) {
      assert.strictEqual(wat.test_call_PlayEnhMetaFile(hdc, metafile, target), 1,
        'EMF playback objects must be recycled after every call');
    }
    const recycled = wat.test_call_CreateSolidBrush(0x00010101) >>> 0;
    assert(recycled, 'temporary EMF objects must not exhaust the WAT object table');
    assert.strictEqual(wat.test_call_DeleteObject(recycled), 1);
    assert.strictEqual(wat.test_call_DeleteEnhMetaFile(metafile), 1);
  });

  check('enhanced vector clipping and malformed records are bounded', () => {
    const clipped = makeVectorEmf([
      emfRecord(39, emfDwords(1, 0, 0x0000ff00, 0)),
      emfRecord(37, emfDwords(1)),
      emfRecord(30, emfDwords(32, 0, 64, 48)),
      emfRecord(43, emfDwords(0, 0, 64, 48)),
      emfRecord(37, emfDwords(0x80000000)),
      emfRecord(40, emfDwords(1)),
    ]);
    const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    const bitmap = wat.test_call_CreateCompatibleBitmap(0, 128, 96) >>> 0;
    const target = allocZero(16);
    wat.guest_write32(target + 8, 128);
    wat.guest_write32(target + 12, 96);
    const metafile = wat.test_call_SetEnhMetaFileBits(clipped.size, clipped.data) >>> 0;
    assert(metafile && hdc && bitmap);
    assert.notStrictEqual(wat.test_call_SelectObject(hdc, bitmap) | 0, -1);
    const outsideBefore = wat.test_call_GetPixel(hdc, 32, 48) >>> 0;
    assert.strictEqual(wat.test_call_PlayEnhMetaFile(hdc, metafile, target), 1);
    assert.strictEqual(wat.test_call_GetPixel(hdc, 32, 48) >>> 0, outsideBefore,
      'mapped intersect clip must reject pixels outside its right half');
    assert.strictEqual(wat.test_call_GetPixel(hdc, 96, 48) >>> 0, 0x0000ff00,
      'mapped intersect clip must retain pixels inside its right half');
    assert.strictEqual(wat.test_call_DeleteEnhMetaFile(metafile), 1);

    const cases = [];
    cases.push(makeVectorEmf([
      emfRecord(38, emfDwords(1, 0, 1, 0, 0xff)),
      emfRecord(38, emfDwords(1, 0, 1, 0, 0xff)),
    ]));
    cases.push(makeVectorEmf([
      emfRecord(39, emfDwords(8, 0, 0xff00, 0)),
    ], { handles: 8 }));
    const truncatedPoly = emfPolyRecord(4, [[1, 1], [5, 5]]);
    truncatedPoly.writeUInt32LE(3, 24);
    cases.push(makeVectorEmf([truncatedPoly]));
    cases.push(makeVectorEmf([emfRecord(34, emfDwords(-1))]));
    const wrongRecordCount = makeVectorEmf([]);
    wat.guest_write32(wrongRecordCount.data + 52, 3);
    cases.push(wrongRecordCount);
    const wrongEofSize = makeVectorEmf([]);
    wat.guest_write32(wrongEofSize.data + 104, 16);
    cases.push(wrongEofSize);
    for (const malformed of cases) {
      const bad = wat.test_call_SetEnhMetaFileBits(malformed.size, malformed.data) >>> 0;
      assert(bad, 'transport accepts structurally bounded bytes before replay validation');
      assert.strictEqual(wat.test_call_PlayEnhMetaFile(hdc, bad, target), 0,
        'invalid EMF state, object, or point records must fail playback');
      assert.strictEqual(wat.test_call_DeleteEnhMetaFile(bad), 1);
    }
    for (let index = 0; index < 140; index++) {
      const reusable = wat.test_call_CreatePen(0, 1, index) >>> 0;
      assert(reusable, 'failed EMF playback must release temporary WAT objects');
      assert.strictEqual(wat.test_call_DeleteObject(reusable), 1);
    }
  });

  check('WMF/EMF conversion preserves bitmap records and replay pixels', () => {
    const recording = wat.test_call_CreateMetaFileA(0) >>> 0;
    const red = wat.test_call_CreateSolidBrush(0x000000ff) >>> 0;
    const fill = allocZero(16);
    wat.guest_write32(fill, 10);
    wat.guest_write32(fill + 4, 10);
    wat.guest_write32(fill + 8, 30);
    wat.guest_write32(fill + 12, 25);
    assert.strictEqual(wat.test_call_FillRect(recording, fill, red), 1);
    const sourceWmf = wat.test_call_CloseMetaFile(recording) >>> 0;
    const sourceSize = wat.test_call_GetMetaFileBitsEx(sourceWmf, 0, 0) >>> 0;
    const sourceBytes = allocZero(sourceSize);
    assert.strictEqual(
      wat.test_call_GetMetaFileBitsEx(sourceWmf, sourceSize, sourceBytes), sourceSize);

    const emf = wat.test_call_SetWinMetaFileBits(sourceSize, sourceBytes, 0, 0) >>> 0;
    assert(emf, 'SetWinMetaFileBits must convert the bitmap record');
    assert.strictEqual(wat.test_call_GetEnhMetaFileBits(emf, 0, 0), 640 * 480 * 4 + 228);
    const header = allocZero(88);
    assert.strictEqual(wat.test_call_GetEnhMetaFileHeader(emf, 88, header), 88);
    assert.strictEqual(wat.guest_read32(header + 48), 640 * 480 * 4 + 228);

    const emfDc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    const emfBitmap = wat.test_call_CreateCompatibleBitmap(0, 640, 480) >>> 0;
    assert.notStrictEqual(wat.test_call_SelectObject(emfDc, emfBitmap) | 0, -1);
    const target = allocZero(16);
    wat.guest_write32(target + 8, 640);
    wat.guest_write32(target + 12, 480);
    assert.strictEqual(wat.test_call_PlayEnhMetaFile(emfDc, emf, target), 1);
    assert.strictEqual(wat.test_call_GetPixel(emfDc, 15, 15) >>> 0, 0x000000ff,
      'EMR_STRETCHDIBITS replay must preserve recorded color');

    const required = wat.test_call_GetWinMetaFileBits(emf, 0, 0, 8, 0) >>> 0;
    assert.strictEqual(required, 640 * 480 * 4 + 130);
    const wmf = allocZero(required);
    assert.strictEqual(wat.test_call_GetWinMetaFileBits(emf, required, wmf, 8, 0), required);
    assert.strictEqual(read16(wmf + 2), 9);
    assert.strictEqual(read16(wmf + 60), 0x0f43);
    const converted = wat.test_call_SetMetaFileBitsEx(required, wmf) >>> 0;
    assert(converted);
    const wmfDc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    const wmfBitmap = wat.test_call_CreateCompatibleBitmap(0, 640, 480) >>> 0;
    assert.notStrictEqual(wat.test_call_SelectObject(wmfDc, wmfBitmap) | 0, -1);
    assert.strictEqual(wat.test_call_PlayMetaFile(wmfDc, converted), 1);
    assert.strictEqual(wat.test_call_GetPixel(wmfDc, 15, 15) >>> 0, 0x000000ff,
      'EMF-to-WMF conversion must preserve replay pixels');
  });

  check('ICM profile sizing and ResetDCA follow public contracts', () => {
    const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    const size = allocZero(4);
    wat.guest_write32(size, 4);
    assert.strictEqual(wat.test_call_GetICMProfileA(hdc, size, 0), 0);
    assert.strictEqual(wat.guest_read32(size), 29);
    const path = allocZero(29);
    assert.strictEqual(wat.test_call_GetICMProfileA(hdc, size, path), 1);
    assert.strictEqual(Buffer.from(readBytes(path, 28)).toString('latin1'),
      'sRGB Color Space Profile.icm');
    assert.strictEqual(wat.test_call_ResetDCA(hdc, 0) >>> 0, hdc);
    assert.strictEqual(wat.test_call_ResetDCA(0xdeadbeef, 0), 0);
  });

  console.log(`\n${passed}/${passed} checks passed`);
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});

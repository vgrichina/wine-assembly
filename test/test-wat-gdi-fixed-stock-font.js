#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  const calls = { bind: 0, textOut: 0, extTextOut: 0, drawText: 0,
    measure: 0, metrics: 0 };
  const harness = await bootRenderHarness({
    extraHostOverrides: {
      gdi_text_bind: () => { calls.bind++; return 1; },
      gdi_text_out: () => { calls.textOut++; return 1; },
      gdi_ext_text_out: () => { calls.extTextOut++; return 1; },
      gdi_draw_text: () => { calls.drawText++; return 16; },
      measure_text: () => { calls.measure++; return 99; },
      get_text_metrics: () => { calls.metrics++; return 16 | (8 << 16); },
    },
  });
  const { exports: wat, memory, hostCtx } = harness;
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

  const bytes = new Uint8Array(memory.buffer);
  const view = new DataView(memory.buffer);
  const imageBase = wat.get_image_base() >>> 0;
  const wa = guest => (0x12000 + ((guest >>> 0) - imageBase)) >>> 0;
  const allocZero = size => {
    const pointer = wat.guest_alloc(size) >>> 0;
    bytes.fill(0, wa(pointer), wa(pointer) + size);
    return pointer;
  };
  const writeWide = value => {
    const pointer = allocZero((value.length + 1) * 2);
    [...value].forEach((character, index) =>
      wat.guest_write16(pointer + index * 2, character.charCodeAt(0)));
    return pointer;
  };
  const assertNoCanvasText = label => assert.deepStrictEqual(calls, {
    bind: 0, textOut: 0, extTextOut: 0, drawText: 0,
    measure: 0, metrics: 0,
  }, label);

  const bmi = allocZero(40);
  wat.guest_write32(bmi, 40);
  wat.guest_write32(bmi + 4, 128);
  wat.guest_write32(bmi + 8, -64);
  wat.guest_write16(bmi + 12, 1);
  wat.guest_write16(bmi + 14, 32);
  const bitsOut = allocZero(4);
  const bitmap = wat.test_call_CreateDIBSection(0, bmi, bitsOut) >>> 0;
  const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
  assert(bitmap && hdc);
  wat.test_call_SelectObject(hdc, bitmap);

  const text = allocZero(8);
  bytes.set(Buffer.from('MWii\0', 'latin1'), wa(text));
  const size = allocZero(8);
  const stockLogfont = allocZero(60);
  assert.strictEqual(wat.test_call_GetObjectA(0x3001a, 60, stockLogfont), 60);
  assert.strictEqual(wat.guest_read32(stockLogfont), 12,
    'OEM_FIXED_FONT must expose the native Terminal LOGFONT height');
  const fixedStocks = [
    { handle: 0x3001a, height: 12, face: 'Terminal', note: 'OEM fixed' },
    { handle: 0x3001b, height: 13, face: 'Courier', note: 'ANSI fixed' },
    { handle: 0x30020, height: 15, face: 'Fixedsys', note: 'system fixed' },
  ];
  const strikeFace = strike => {
    const source = view.getUint32(strike + 8, true);
    const faceOffset = view.getUint32(strike + 56, true);
    let value = '';
    for (let p = source + faceOffset; bytes[p]; p++) value += String.fromCharCode(bytes[p]);
    return value;
  };
  for (const { handle, height, face, note } of fixedStocks) {
    wat.test_call_SelectObject(hdc, handle);
    const strike = wat.test_gdi_bitmap_font_selected(hdc) >>> 0;
    assert(strike, `stock font ${handle.toString(16)} should select a Wine bitmap`);
    assert.strictEqual(strikeFace(strike), face, note);
    assert.strictEqual(wat.test_call_GetTextExtentExPointA(
      hdc, text, 4, 0x7fffffff, 0, 0, size), 1);
    assert.strictEqual(wat.guest_read32(size), 32, 'four fixed cells should be 32px');
    assert.strictEqual(wat.guest_read32(size + 4), height, `${note} cell height`);
    assert.strictEqual(wat.test_call_TextOutA(hdc, 2, 2, text, 4), 1);
  }
  assertNoCanvasText('all fixed stock font rendering and measurement must stay in WAT');
  assert.strictEqual(wat.test_gdi_bitmap_font_count(), 3,
    'fixed stock selection should load only Terminal, Fixedsys, and Courier');

  const terminal = wat.test_call_CreateFontW(-12, 400, 0, writeWide('Terminal')) >>> 0;
  assert(terminal && wat.test_gdi_bitmap_font_bound(terminal),
    'an explicit Terminal LOGFONT should bind to ANAKRON');
  wat.test_call_SelectObject(hdc, terminal);
  assert.strictEqual(wat.test_call_TextOutA(hdc, 2, 18, text, 4), 1);
  assertNoCanvasText('explicit Terminal rendering must stay in WAT');

  const dibBits = wat.guest_read32(bitsOut) >>> 0;
  const pixel = (x, y) => wat.guest_read32(dibBits + (y * 128 + x) * 4) & 0xffffff;
  const boxDrawing = allocZero(2);
  bytes[wa(boxDrawing)] = 0xb3;
  assert.strictEqual(wat.test_call_PatBlt(hdc, 80, 0, 8, 12, 0x00f00021), 1);
  wat.test_gdi_dc_set_field(hdc, 28, 1, 2); // TRANSPARENT
  wat.test_gdi_dc_set_field(hdc, 20, 0x000000, 0); // black
  assert.strictEqual(wat.test_call_TextOutA(hdc, 80, 0, boxDrawing, 1), 1);
  assert.deepStrictEqual(Array.from({ length: 12 }, (_, y) =>
    Array.from({ length: 8 }, (_, x) => pixel(80 + x, y) === 0 ? x : -1)
      .filter(x => x >= 0)), Array.from({ length: 12 }, () => [4]),
  'CP437 0xb3 must render as one uninterrupted WAT-surface column');
  assertNoCanvasText('CP437 box drawing must stay in WAT');

  const created = wat.test_call_CreateFontW(-16, 400, 0, writeWide('Fixedsys')) >>> 0;
  assert(created && wat.test_gdi_bitmap_font_bound(created),
    'an explicit Fixedsys LOGFONT should bind to the bundled strike');
  wat.test_call_SelectObject(hdc, created);
  assert.strictEqual(wat.test_call_TextOutA(hdc, 2, 24, text, 4), 1);
  assertNoCanvasText('explicit Fixedsys rendering must stay in WAT');

  const nativeSizes = [
    { request: 16, width: 32, height: 15 },
    { request: 18, width: 32, height: 15 },
    { request: 21, width: 64, height: 30 },
    { request: 24, width: 64, height: 30 },
    { request: 32, width: 64, height: 30 },
    { request: 48, width: 128, height: 60 },
    { request: 64, width: 160, height: 75 },
    { request: 80, width: 160, height: 90 },
  ];
  const selected = [];
  for (const { request, width, height } of nativeSizes) {
    const font = wat.test_call_CreateFontW(-request, 400, 0, writeWide('Fixedsys')) >>> 0;
    const strike = wat.test_gdi_bitmap_font_bound(font) >>> 0;
    assert(font && strike, `${request}px Fixedsys should bind to Wine's base strike`);
    assert.strictEqual(view.getUint32(strike + 20, true), 15,
      'Wine Fixedsys source remains one pre-rendered 8x15 strike');
    wat.test_call_SelectObject(hdc, font);
    assert.strictEqual(wat.test_call_GetTextExtentExPointA(
      hdc, text, 4, 0x7fffffff, 0, 0, size), 1);
    assert.strictEqual(wat.guest_read32(size), width, `${request}px request width`);
    assert.strictEqual(wat.guest_read32(size + 4), height, `${request}px request cell`);
    selected.push(strike);
  }
  assert.strictEqual(new Set(selected).size, 1,
    'all native sizes scale the same authentic 8x15 bitmap strike');
  assertNoCanvasText('multi-strike Fixedsys selection must stay in WAT');

  console.log('PASS  fixed stocks use ANAKRON Terminal and Wine Courier/Fixedsys bitmaps');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});

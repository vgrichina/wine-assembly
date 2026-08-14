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
  for (const name of ['W95FA.fon', 'Fixedsys.fon']) {
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
  const fixedStocks = [0x3001a, 0x3001b, 0x30020];
  let selectedStrike = 0;
  for (const handle of fixedStocks) {
    wat.test_call_SelectObject(hdc, handle);
    const strike = wat.test_gdi_bitmap_font_selected(hdc) >>> 0;
    assert(strike, `stock font ${handle.toString(16)} should select Fixedsys`);
    if (selectedStrike) assert.strictEqual(strike, selectedStrike);
    selectedStrike = strike;
    assert.strictEqual(wat.test_call_GetTextExtentExPointA(
      hdc, text, 4, 0x7fffffff, 0, 0, size), 1);
    assert.strictEqual(wat.guest_read32(size), 32, 'four fixed cells should be 32px');
    assert.strictEqual(wat.guest_read32(size + 4), 16, 'fixed stock cell height');
    assert.strictEqual(wat.test_call_TextOutA(hdc, 2, 2, text, 4), 1);
  }
  assertNoCanvasText('all fixed stock font rendering and measurement must stay in WAT');
  assert.strictEqual(wat.test_gdi_bitmap_font_count(), 15,
    'seven UI strikes plus eight Fixedsys strikes should fit the WAT registry');

  const created = wat.test_call_CreateFontW(-16, 400, 0, writeWide('Fixedsys')) >>> 0;
  assert(created && wat.test_gdi_bitmap_font_bound(created),
    'an explicit Fixedsys LOGFONT should bind to the bundled strike');
  wat.test_call_SelectObject(hdc, created);
  assert.strictEqual(wat.test_call_TextOutA(hdc, 2, 24, text, 4), 1);
  assertNoCanvasText('explicit Fixedsys rendering must stay in WAT');

  const nativeHeights = [16, 18, 21, 24, 32, 48, 64, 80];
  const selected = [];
  for (const height of nativeHeights) {
    const font = wat.test_call_CreateFontW(-height, 400, 0, writeWide('Fixedsys')) >>> 0;
    const strike = wat.test_gdi_bitmap_font_bound(font) >>> 0;
    assert(font && strike, `${height}px Fixedsys should bind to a bundled strike`);
    assert.strictEqual(view.getUint32(strike + 20, true), height,
      `${height}px request should select its exact native strike`);
    selected.push(strike);
  }
  assert.strictEqual(new Set(selected).size, nativeHeights.length,
    'each common Fixedsys size should use a distinct native strike');
  assertNoCanvasText('multi-strike Fixedsys selection must stay in WAT');

  console.log('PASS  fixed stock and all common Fixedsys sizes use native WAT bitmap strikes');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});

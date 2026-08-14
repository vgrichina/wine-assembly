#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  const calls = {
    bind: 0, textOut: 0, extTextOut: 0, drawText: 0,
    measure: 0, metrics: 0,
  };
  const harness = await bootRenderHarness({
    extraHostOverrides: {
      gdi_text_bind: () => { calls.bind++; return 1; },
      gdi_text_out: () => { calls.textOut++; return 1; },
      gdi_ext_text_out: () => { calls.extTextOut++; return 1; },
      gdi_draw_text: () => { calls.drawText++; return 12; },
      measure_text: () => { calls.measure++; return 99; },
      get_text_metrics: () => { calls.metrics++; return 12 | (6 << 16); },
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
  const imageBase = wat.get_image_base() >>> 0;
  const wa = guest => (0x12000 + ((guest >>> 0) - imageBase)) >>> 0;
  const allocZero = size => {
    const pointer = wat.guest_alloc(size) >>> 0;
    bytes.fill(0, wa(pointer), wa(pointer) + size);
    return pointer;
  };
  const resetCalls = () => Object.keys(calls).forEach(key => { calls[key] = 0; });
  const assertNoCanvasText = label => assert.deepStrictEqual(calls, {
    bind: 0, textOut: 0, extTextOut: 0, drawText: 0,
    measure: 0, metrics: 0,
  }, label);
  const writeWide = value => {
    const pointer = allocZero((value.length + 1) * 2);
    [...value].forEach((character, index) =>
      wat.guest_write16(pointer + index * 2, character.charCodeAt(0)));
    return pointer;
  };

  const bmi = allocZero(40);
  wat.guest_write32(bmi, 40);
  wat.guest_write32(bmi + 4, 128);
  wat.guest_write32(bmi + 8, -48);
  wat.guest_write16(bmi + 12, 1);
  wat.guest_write16(bmi + 14, 32);
  const bitsOut = allocZero(4);
  const bitmap = wat.test_call_CreateDIBSection(0, bmi, bitsOut) >>> 0;
  const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
  assert(bitmap && hdc);
  wat.test_call_SelectObject(hdc, bitmap);

  const text = allocZero(16);
  bytes.set(Buffer.from('Default UI\0', 'latin1'), wa(text));
  const size = allocZero(8);
  const rect = allocZero(16);
  wat.guest_write32(rect + 8, 120);
  wat.guest_write32(rect + 12, 40);

  assert.strictEqual(wat.test_gdi_bitmap_font_count(), 0);
  assert.strictEqual(wat.test_call_TextOutA(hdc, 2, 2, text, 10), 1);
  assert.strictEqual(wat.test_gdi_bitmap_font_count(), 2,
    'first stock-font draw should lazily install Wine System strikes');
  assert(wat.test_gdi_bitmap_font_selected(hdc), 'SYSTEM_FONT should select Wine System');
  assert.strictEqual(wat.test_call_GetTextExtentExPointA(
    hdc, text, 10, 0x7fffffff, 0, 0, size), 1);
  assert(wat.guest_read32(size) > 0 && wat.guest_read32(size + 4) === 16);
  assert.strictEqual(wat.test_call_ExtTextOutA(hdc, 2, 16, 0, 0, text, 10), 1);
  assert.strictEqual(wat.test_call_DrawTextA(hdc, text, 10, rect, 0x20), 16);
  assertNoCanvasText('SYSTEM_FONT text and measurements must remain in WAT');

  assert.strictEqual(wat.test_call_SelectObject(hdc, 0x30021) >>> 0, 0x3001d);
  assert(wat.test_gdi_bitmap_font_selected(hdc), 'DEFAULT_GUI_FONT should select Wine MS Sans Serif');
  assert.strictEqual(wat.test_call_GetTextExtentExPointA(
    hdc, text, 10, 0x7fffffff, 0, 0, size), 1);
  assert.strictEqual(wat.guest_read32(size + 4), 13, 'Win98 dialog font cell height');
  assert.strictEqual(wat.test_call_TextOutA(hdc, 2, 30, text, 10), 1);
  assertNoCanvasText('DEFAULT_GUI_FONT must remain in WAT');

  const uiFont = wat.test_call_CreateFontW(-12, 400, 0, writeWide('MS Sans Serif')) >>> 0;
  assert(uiFont && wat.test_gdi_bitmap_font_bound(uiFont),
    'MS Sans Serif should bind to its bundled Wine bitmap strike');
  assert.strictEqual(wat.test_call_SelectObject(hdc, uiFont) >>> 0, 0x30021);
  assert.strictEqual(wat.test_gdi_dc_get_field(hdc, 88, 0) >>> 0, uiFont);
  const uiRecord = wat.test_gdi_object_record(uiFont) >>> 0;
  assert.strictEqual(new DataView(memory.buffer).getUint32(uiRecord + 4, true), 4);
  assert.strictEqual(new DataView(memory.buffer).getUint32(
    wat.test_gdi_bitmap_font_bound(uiFont), true), 1);
  assert.strictEqual(wat.test_gdi_bitmap_font_selected(hdc),
    wat.test_gdi_bitmap_font_bound(uiFont));
  assert.strictEqual(wat.test_call_TextOutA(hdc, 50, 30, text, 10), 1);
  assertNoCanvasText('Win9x UI face aliases must remain in WAT');

  const scalableFont = wat.test_call_CreateFontW(-12, 400, 0, writeWide('Arial')) >>> 0;
  assert(scalableFont && !wat.test_gdi_bitmap_font_bound(scalableFont),
    'explicit scalable document faces should not be silently replaced');
  wat.test_call_SelectObject(hdc, scalableFont);
  resetCalls();
  assert.strictEqual(wat.test_call_TextOutA(hdc, 2, 2, text, 10), 1);
  assert(calls.bind > 0 && calls.textOut > 0,
    'unsupported scalable faces should retain the documented Canvas fallback');

  assert.strictEqual(wat.test_gdi_bitmap_font_count(), 8,
    'four Wine resources plus Terminal should install eight bitmap strikes');

  console.log('PASS  System and MS Sans Serif stock/alias text uses Wine bitmaps without Canvas');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});

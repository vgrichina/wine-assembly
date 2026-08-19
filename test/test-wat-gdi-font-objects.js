#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  const harness = await bootRenderHarness();
  const { exports: wat, memory } = harness;
  const bytes = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  const imageBase = wat.get_image_base() >>> 0;
  const wa = guest => (0x12000 + ((guest >>> 0) - imageBase)) >>> 0;
  const allocZero = size => {
    const guest = wat.guest_alloc(size) >>> 0;
    assert(guest, `guest_alloc(${size}) failed`);
    bytes.fill(0, wa(guest), wa(guest) + size);
    return guest;
  };
  const writeWide = value => {
    const guest = allocZero((value.length + 1) * 2);
    [...value].forEach((character, index) =>
      wat.guest_write16(guest + index * 2, character.charCodeAt(0)));
    return guest;
  };
  const readAnsiGuest = (guest, limit = 64) => {
    let result = '';
    for (let i = 0; i < limit; i++) {
      const ch = bytes[wa(guest) + i];
      if (!ch) break;
      result += String.fromCharCode(ch);
    }
    return result;
  };
  const readWideGuest = (guest, limit = 32) => {
    let result = '';
    for (let i = 0; i < limit; i++) {
      const ch = dv.getUint16(wa(guest + i * 2), true);
      if (!ch) break;
      result += String.fromCharCode(ch);
    }
    return result;
  };
  const createSurfaceDc = () => {
    const bmi = allocZero(40);
    wat.guest_write32(bmi, 40);
    wat.guest_write32(bmi + 4, 64);
    wat.guest_write32(bmi + 8, -32);
    wat.guest_write16(bmi + 12, 1);
    wat.guest_write16(bmi + 14, 32);
    const bitsOut = allocZero(4);
    const bitmap = wat.test_call_CreateDIBSection(0, bmi, bitsOut) >>> 0;
    const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    assert(bitmap && hdc, 'canonical text surface creation failed');
    assert.notStrictEqual(wat.test_call_SelectObject(hdc, bitmap) | 0, -1);
    return { bitmap, hdc };
  };

  const face = writeWide('Arial');
  const font = wat.test_call_CreateFontW(-17, 600, 1, face) >>> 0;
  assert(font >= 0x410001, `dynamic font handle must come from WAT namespace: 0x${font.toString(16)}`);
  assert.strictEqual(wat.test_call_GetObjectType(font), 6, 'GetObjectType must report OBJ_FONT');

  const record = wat.test_gdi_object_record(font) >>> 0;
  assert(record, 'WAT font object record must exist');
  assert.strictEqual(dv.getUint32(record, true), font);
  assert.strictEqual(dv.getUint32(record + 4, true), 4);
  assert.strictEqual(dv.getInt32(record + 8, true), -17);
  assert.strictEqual(dv.getInt32(record + 12, true), 600);
  assert.strictEqual(dv.getUint32(record + 16, true), 1);
  const ownedFaceGuest = dv.getUint32(record + 28, true);
  assert(ownedFaceGuest, 'font record must retain a WAT-owned face-name allocation');
  assert.strictEqual(readAnsiGuest(ownedFaceGuest), 'Arial');

  const logfontA = allocZero(60);
  assert.strictEqual(wat.test_call_GetObjectA(font, 60, logfontA), 60);
  assert.strictEqual(wat.guest_read32(logfontA) | 0, -17);
  assert.strictEqual(wat.guest_read32(logfontA + 16), 600);
  assert.strictEqual(bytes[wa(logfontA) + 20], 1);
  assert.strictEqual(readAnsiGuest(logfontA + 28), 'Arial');

  const logfontW = allocZero(92);
  assert.strictEqual(wat.test_call_GetObjectW(font, 92, logfontW), 92);
  assert.strictEqual(wat.guest_read32(logfontW) | 0, -17);
  assert.strictEqual(wat.guest_read32(logfontW + 16), 600);
  assert.strictEqual(bytes[wa(logfontW) + 20], 1);
  assert.strictEqual(readWideGuest(logfontW + 28), 'Arial');

  const { bitmap, hdc } = createSurfaceDc();
  assert.strictEqual(wat.test_call_SelectObject(hdc, font) >>> 0, 0x3001d);
  assert.strictEqual(wat.test_call_GetTextFaceA(hdc, 0, 0), 6,
    'GetTextFace sizing form includes the terminator');
  const shortFace = allocZero(4);
  assert.strictEqual(wat.test_call_GetTextFaceA(hdc, 4, shortFace), 3);
  assert.strictEqual(readAnsiGuest(shortFace, 4), 'Ari');
  const wideFace = allocZero(64);
  assert.strictEqual(wat.test_call_GetTextFaceW(hdc, 32, wideFace), 5);
  assert.strictEqual(readWideGuest(wideFace), 'Arial');

  const text = allocZero(4);
  bytes.set(Buffer.from('abc\0', 'latin1'), wa(text));
  const size = allocZero(8);
  assert.strictEqual(wat.test_call_GetTextExtentExPointA(
    hdc, text, 3, 0x7fffffff, 0, 0, size), 1);
  // The derived LOGFONT state (-17px, weight 600, italic) used to be checked by
  // watching it cross into Canvas through gdi_text_bind. There is no such
  // crossing now: the same state selects a strike rasterized from Arial's
  // substitute, so check the strike and the extent it produces instead.
  const strike = wat.test_gdi_bitmap_font_selected(hdc) >>> 0;
  assert(strike, 'a bold italic Arial request must resolve to a rasterized strike');
  const width = wat.guest_read32(size);
  const height = wat.guest_read32(size + 4);
  assert(width > 0 && height > 0, `extent should be positive, got ${width}x${height}`);
  const perChar = allocZero(12);
  assert.strictEqual(wat.test_call_GetTextExtentExPointA(
    hdc, text, 3, 0x7fffffff, 0, perChar, size), 1);
  assert.strictEqual(wat.guest_read32(perChar + 8), width,
    'the last progressive width must equal the whole-string extent');

  assert.notStrictEqual(wat.test_call_SelectObject(hdc, 0x3001d) | 0, -1);
  assert.strictEqual(wat.test_call_DeleteObject(font), 1);
  assert.strictEqual(wat.test_call_GetObjectType(font), 0);
  assert.strictEqual(wat.test_gdi_object_record(font), 0);
  assert.strictEqual(wat.test_call_DeleteObject(bitmap), 1);
  assert.strictEqual(wat.test_call_DeleteDC(hdc), 1);

  const root = path.join(__dirname, '..');
  const header = fs.readFileSync(path.join(root, 'src', '01-header.wat'), 'utf8');
  const hostImports = fs.readFileSync(path.join(root, 'lib', 'host-imports.js'), 'utf8');
  assert(!/\(import\s+"host"\s+"create_font"/.test(header),
    'WAT must not import semantic font-object creation');
  assert(!/^\s+create_font:/m.test(hostImports),
    'JavaScript must not expose semantic font-object creation');
  // Nor any part of the old text path: measurement, metrics, DC/font binding
  // and glyph rasterization are all WAT-side now, and a host that reintroduces
  // one of these makes text render differently in the browser and in Node.
  for (const name of ['gdi_text_bind', 'gdi_text_mask', 'measure_text', 'get_text_metrics']) {
    assert(!new RegExp(`\\(import\\s+"host"\\s+"${name}"`).test(header),
      `WAT must not import ${name}`);
    assert(!new RegExp(`^\\s+${name}:`, 'm').test(hostImports),
      `JavaScript must not expose ${name}`);
  }

  console.log('PASS  WAT owns font handles, LOGFONT state, face queries, strike selection, and deletion');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});

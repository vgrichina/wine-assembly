#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  const binds = [];
  let memoryRef = null;
  const harness = await bootRenderHarness({
    extraHostOverrides: {
      gdi_text_bind: (...args) => { binds.push(args); return 1; },
      measure_text: (_token, _text, count) => count * 7,
      get_text_metrics: () => 17 | (7 << 16),
    },
  });
  const { exports: wat, memory } = harness;
  memoryRef = memory;
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
  const readAnsiWa = (pointer, limit = 64) => {
    let result = '';
    for (let i = 0; i < limit; i++) {
      const ch = bytes[(pointer >>> 0) + i];
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
  binds.length = 0;
  assert.strictEqual(wat.test_call_GetTextExtentExPointA(
    hdc, text, 3, 0x7fffffff, 0, 0, size), 1);
  assert.strictEqual(wat.guest_read32(size), 21);
  assert(binds.length > 0, 'unsupported face must bind Canvas before fallback measurement');
  const bind = binds[binds.length - 1];
  assert.strictEqual(bind.length, 11);
  assert.deepStrictEqual(bind.slice(7, 10), [-17, 600, 1]);
  assert.strictEqual(readAnsiWa(bind[10]), 'Arial',
    'Canvas fallback must receive derived WAT face state through gdi_text_bind');

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

  // Keep the captured memory alive through every pointer assertion above.
  assert(memoryRef === memory);
  console.log('PASS  WAT owns font handles, LOGFONT state, face queries, fallback binding, and deletion');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});

#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  const { exports: wat, memory, hostCtx } = await bootRenderHarness();
  const bytes = new Uint8Array(memory.buffer);
  const imageBase = wat.get_image_base() >>> 0;
  const wa = guest => (0x12000 + ((guest >>> 0) - imageBase)) >>> 0;
  const allocZero = size => {
    const pointer = wat.guest_alloc(size) >>> 0;
    bytes.fill(0, wa(pointer), wa(pointer) + size);
    return pointer;
  };
  const writeAnsi = (value, extra = 1) => {
    const pointer = allocZero(value.length + extra);
    bytes.set(Buffer.from(value, 'latin1'), wa(pointer));
    return pointer;
  };
  const writeWide = value => {
    const pointer = allocZero((value.length + 1) * 2);
    [...value].forEach((character, index) =>
      wat.guest_write16(pointer + index * 2, character.charCodeAt(0)));
    return pointer;
  };
  const writeRect = (pointer, left, top, right, bottom) => {
    wat.guest_write32(pointer, left);
    wat.guest_write32(pointer + 4, top);
    wat.guest_write32(pointer + 8, right);
    wat.guest_write32(pointer + 12, bottom);
  };

  // One solid 8x8 glyph, used as every character's default glyph. Uniform
  // metrics make prefix removal, tab expansion, ellipsis, and advances exact.
  const fnt = Buffer.alloc(142);
  fnt.writeUInt16LE(0x0200, 0);
  fnt.writeUInt32LE(fnt.length, 2);
  fnt.writeUInt16LE(8, 74);
  fnt.writeUInt16LE(400, 83);
  fnt.writeUInt16LE(8, 88);
  fnt.writeUInt16LE(8, 91);
  fnt.writeUInt16LE(8, 93);
  fnt[95] = 65;
  fnt[96] = 65;
  fnt[97] = 0;
  fnt.writeUInt32LE(134, 105);
  fnt.writeUInt16LE(8, 118);
  fnt.writeUInt16LE(126, 120);
  fnt.writeUInt16LE(0, 122);
  fnt.writeUInt16LE(134, 124);
  fnt.fill(0xff, 126, 134);
  fnt.write('Compat\0', 134, 'latin1');
  hostCtx.vfs.files.set('c:\\compat.fon', { data: new Uint8Array(fnt), attrs: 0x20 });

  const path = writeAnsi('COMPAT.FON');
  assert.strictEqual(wat.test_call_AddFontResourceA(path), 1);

  const width = 96;
  const height = 64;
  const bmi = allocZero(40);
  wat.guest_write32(bmi, 40);
  wat.guest_write32(bmi + 4, width);
  wat.guest_write32(bmi + 8, -height);
  wat.guest_write16(bmi + 12, 1);
  wat.guest_write16(bmi + 14, 32);
  const bitsOut = allocZero(4);
  const bitmap = wat.test_call_CreateDIBSection(0, bmi, bitsOut) >>> 0;
  const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
  assert(bitmap && hdc);
  wat.test_call_SelectObject(hdc, bitmap);

  const face = allocZero(32);
  [...'Compat'].forEach((character, index) =>
    wat.guest_write16(face + index * 2, character.charCodeAt(0)));
  const font = wat.test_call_CreateFontW(-8, 400, 0, face) >>> 0;
  assert(font);
  wat.test_call_SelectObject(hdc, font);
  assert(wat.test_gdi_bitmap_font_selected(hdc));

  const dibBits = wat.guest_read32(bitsOut) >>> 0;
  const pixel = (x, y) => wat.guest_read32(dibBits + (y * width + x) * 4) & 0xffffff;
  const clear = () => assert.strictEqual(
    wat.test_call_PatBlt(hdc, 0, 0, width, height, 0x00F00021), 1);
  const readPath = () => {
    const count = wat.test_call_GetPath(hdc, 0, 0, 0) | 0;
    assert(count >= 0);
    const points = allocZero(Math.max(1, count) * 8);
    const types = allocZero(Math.max(1, count));
    assert.strictEqual(wat.test_call_GetPath(hdc, points, types, count) | 0, count);
    return {
      points: Array.from({ length: count }, (_, index) => [
        wat.guest_read32(points + index * 8) | 0,
        wat.guest_read32(points + index * 8 + 4) | 0,
      ]),
      types: Array.from(bytes.subarray(wa(types), wa(types) + count)),
    };
  };
  wat.test_gdi_dc_set_field(hdc, 28, 1, 2); // TRANSPARENT
  wat.test_gdi_dc_set_field(hdc, 20, 0x000000, 0); // black

  const glyphA = writeAnsi('A');
  clear();
  const beforePath = bytes.slice(wa(dibBits), wa(dibBits) + width * height * 4);
  assert.strictEqual(wat.test_call_BeginPath(hdc), 1);
  assert.strictEqual(wat.test_call_TextOutA(hdc, 2, 2, glyphA, 1), 1);
  assert.strictEqual(wat.test_call_EndPath(hdc), 1);
  assert.deepStrictEqual(bytes.slice(wa(dibBits), wa(dibBits) + width * height * 4), beforePath,
    'FNT TextOut inside a bracket must record geometry without touching pixels');
  const glyphPath = readPath();
  assert.strictEqual(glyphPath.points.length, 8 * 8 * 4);
  assert.deepStrictEqual(glyphPath.points.slice(0, 4), [[2, 2], [3, 2], [3, 3], [2, 3]]);
  assert.deepStrictEqual(glyphPath.types.slice(0, 4), [6, 2, 2, 3]);
  assert.notStrictEqual(wat.test_call_SelectObject(hdc, 0x30014) | 0, -1); // BLACK_BRUSH
  assert.strictEqual(wat.test_call_FillPath(hdc), 1);
  assert.strictEqual(pixel(2, 2), 0);
  assert.notStrictEqual(wat.test_call_SelectObject(hdc, 0x30010) | 0, -1); // WHITE_BRUSH

  const calc = allocZero(16);
  const prefixed = writeAnsi('A&A');
  writeRect(calc, 0, 0, 80, 20);
  assert.strictEqual(wat.test_call_DrawTextA(hdc, prefixed, 3, calc, 0x400), 8);
  assert.strictEqual(wat.guest_read32(calc + 8), 16,
    'DrawText must hide a mnemonic prefix from measurement');

  const escaped = writeAnsi('A&&A');
  writeRect(calc, 0, 0, 80, 20);
  assert.strictEqual(wat.test_call_DrawTextA(hdc, escaped, 4, calc, 0x400), 8);
  assert.strictEqual(wat.guest_read32(calc + 8), 24,
    'DrawText must collapse an escaped ampersand to one visible glyph');
  writeRect(calc, 0, 0, 80, 20);
  assert.strictEqual(wat.test_call_DrawTextA(hdc, prefixed, 3, calc, 0x400 | 0x800), 8);
  assert.strictEqual(wat.guest_read32(calc + 8), 24,
    'DT_NOPREFIX must render ampersands literally');

  const tabbed = writeAnsi('A\tA');
  writeRect(calc, 0, 0, 90, 20);
  assert.strictEqual(wat.test_call_DrawTextA(hdc, tabbed, 3, calc, 0x400 | 0x40), 8);
  assert.strictEqual(wat.guest_read32(calc + 8), 72,
    'DT_EXPANDTABS must advance to the default eight-cell tab stop');

  const ellipsis = writeAnsi('AAAAAA', 8);
  const ellipsisRect = allocZero(16);
  writeRect(ellipsisRect, 0, 0, 32, 12);
  clear();
  assert.strictEqual(wat.test_call_DrawTextA(
    hdc, ellipsis, 6, ellipsisRect, 0x20 | 0x8000 | 0x10000), 8);
  assert.strictEqual(Buffer.from(bytes.subarray(wa(ellipsis), wa(ellipsis) + 4)).toString('latin1'), 'A...',
    'DT_END_ELLIPSIS|DT_MODIFYSTRING must expose the shortened string');
  const ellipsisInk = Array.from({ length: 40 }, (_, x) => pixel(x, 3) === 0 ? x : -1)
    .filter(x => x >= 0);
  assert.strictEqual(pixel(31, 3), 0,
    `ellipsis must fill the available four glyph cells (ink: ${ellipsisInk.join(',')})`);
  assert.strictEqual(pixel(32, 3), 0xffffff, 'ellipsis must stay inside the DrawText rectangle');

  const pathEllipsis = writeAnsi('AA\\AA', 8);
  assert.strictEqual(wat.test_call_DrawTextA(
    hdc, pathEllipsis, 5, ellipsisRect, 0x20 | 0x4000 | 0x10000), 8);
  assert.strictEqual(
    Buffer.from(bytes.subarray(wa(pathEllipsis), wa(pathEllipsis) + 6)).toString('latin1'),
    '...\\AA', 'DT_PATH_ELLIPSIS must preserve the final slash and path tail');

  const wordEllipsis = writeAnsi('AAAAAA', 8);
  assert.strictEqual(wat.test_call_DrawTextA(
    hdc, wordEllipsis, 6, ellipsisRect, 0x20 | 0x40000 | 0x10000), 8);
  assert.strictEqual(
    Buffer.from(bytes.subarray(wa(wordEllipsis), wa(wordEllipsis) + 4)).toString('latin1'),
    'A...', 'DT_WORD_ELLIPSIS must shorten an overflowing single line');

  const textAA = writeAnsi('AA');
  const paired = allocZero(16);
  wat.guest_write32(paired, 12);
  wat.guest_write32(paired + 4, 4);
  wat.guest_write32(paired + 8, 12);
  wat.guest_write32(paired + 12, -2);
  wat.test_gdi_dc_set_field(hdc, 32, 0, 0); // TA_LEFT | TA_TOP
  clear();
  const beforePairedPath = bytes.slice(wa(dibBits), wa(dibBits) + width * height * 4);
  assert.strictEqual(wat.test_call_BeginPath(hdc), 1);
  assert.strictEqual(wat.test_call_ExtTextOutAWithDx(
    hdc, 0, 0, 0x2000, 0, textAA, 2, paired), 1);
  assert.strictEqual(wat.test_call_EndPath(hdc), 1);
  assert.deepStrictEqual(bytes.slice(wa(dibBits), wa(dibBits) + width * height * 4),
    beforePairedPath, 'FNT ExtTextOut with ETO_PDY must record without rasterizing');
  const pairedPath = readPath();
  assert.strictEqual(pairedPath.points.length, 2 * 8 * 8 * 4);
  assert(pairedPath.points.some(([x, y]) => x === 12 && y === 4),
    'the second glyph path must honor its paired X/Y advance');
  assert.strictEqual(wat.test_call_AbortPath(hdc), 1);
  clear();
  assert.strictEqual(wat.test_call_ExtTextOutAWithDx(
    hdc, 0, 0, 0x2000, 0, textAA, 2, paired), 1);
  assert.strictEqual(pixel(3, 3), 0, 'ETO_PDY must render the first glyph at the origin');
  assert.strictEqual(pixel(15, 3), 0xffffff, 'ETO_PDY must not leave the second glyph on the first baseline');
  assert.strictEqual(pixel(15, 7), 0, 'ETO_PDY must apply the paired vertical advance');

  wat.test_gdi_dc_set_field(hdc, 32, 1, 0); // TA_LEFT | TA_TOP | TA_UPDATECP
  wat.test_gdi_current_pos_set(hdc, 4, 20);
  clear();
  assert.strictEqual(wat.test_call_ExtTextOutAWithDx(
    hdc, 70, 40, 0x2000, 0, textAA, 2, paired), 1);
  assert.strictEqual(pixel(5, 21), 0, 'TA_UPDATECP must ignore the explicit ExtTextOut origin');
  assert.strictEqual(pixel(71, 41), 0xffffff);
  assert.strictEqual(wat.test_gdi_dc_get_field(hdc, 12, 0), 28,
    'TA_UPDATECP must store the final paired X advance');
  assert.strictEqual(wat.test_gdi_dc_get_field(hdc, 16, 0), 22,
    'TA_UPDATECP must store the final paired Y advance');

  const arialFace = allocZero(32);
  [...'Arial'].forEach((character, index) =>
    wat.guest_write16(arialFace + index * 2, character.charCodeAt(0)));
  const scalable = wat.test_call_CreateFontW(-13, 400, 0, arialFace) >>> 0;
  assert(scalable);
  assert.notStrictEqual(wat.test_call_SelectObject(hdc, scalable) | 0, -1);
  // Arial used to resolve to nothing here and fall through to Canvas. It now
  // rasterizes from its vendored substitute into a strike of its own, which is
  // what keeps the path geometry below identical between Node and the browser.
  const arialStrike = wat.test_gdi_bitmap_font_selected(hdc) >>> 0;
  assert(arialStrike, 'Arial must rasterize into a strike of its own');
  assert.notStrictEqual(arialStrike, wat.test_gdi_bitmap_font_bound(0x30021) >>> 0,
    'a scalable face must not be answered with the bundled UI bitmap strike');
  wat.test_gdi_dc_set_field(hdc, 32, 0, 0); // TA_LEFT | TA_TOP
  clear();
  const beforeScalablePath = bytes.slice(wa(dibBits), wa(dibBits) + width * height * 4);
  assert.strictEqual(wat.test_call_BeginPath(hdc), 1);
  assert.strictEqual(wat.test_call_TextOutA(hdc, 10, 10, glyphA, 1), 1);
  assert.strictEqual(wat.test_call_EndPath(hdc), 1);
  assert.deepStrictEqual(bytes.slice(wa(dibBits), wa(dibBits) + width * height * 4),
    beforeScalablePath,
    'scalable TextOut must return only a glyph mask and leave destination pixels untouched');
  const scalablePath = readPath();
  assert(scalablePath.points.length > 0 && scalablePath.points.length % 4 === 0);
  assert(scalablePath.types.every((type, index) => type === [6, 2, 2, 3][index % 4]));
  assert.notStrictEqual(wat.test_call_SelectObject(hdc, 0x30014) | 0, -1); // BLACK_BRUSH
  assert.strictEqual(wat.test_call_FillPath(hdc), 1);
  assert(Array.from({ length: 20 * 20 }, (_, index) =>
    pixel(5 + index % 20, 5 + Math.floor(index / 20)) === 0).some(Boolean),
  'filling the scalable glyph path must paint canonical WAT pixels');
  assert.notStrictEqual(wat.test_call_SelectObject(hdc, 0x30010) | 0, -1); // WHITE_BRUSH

  wat.test_gdi_dc_set_field(hdc, 32, 0, 0); // TA_LEFT | TA_TOP
  clear();
  const beforeScalableDx = bytes.slice(wa(dibBits), wa(dibBits) + width * height * 4);
  assert.strictEqual(wat.test_call_BeginPath(hdc), 1);
  assert.strictEqual(wat.test_call_ExtTextOutAWithDx(
    hdc, 2, 2, 0x2000, 0, textAA, 2, paired), 1);
  assert.strictEqual(wat.test_call_EndPath(hdc), 1);
  assert.deepStrictEqual(bytes.slice(wa(dibBits), wa(dibBits) + width * height * 4),
    beforeScalableDx, 'scalable ETO_PDY must return masks without rasterizing');
  const scalableDxPath = readPath();
  assert(scalableDxPath.points.some(([x, y]) => x >= 14 && y >= 6),
    'scalable ETO_PDY must apply WAT-owned X/Y placement to the second glyph');
  assert.strictEqual(wat.test_call_AbortPath(hdc), 1);

  clear();
  assert.strictEqual(wat.test_call_ExtTextOutAWithDx(
    hdc, 2, 2, 0x2000, 0, textAA, 2, paired), 1);
  const scalableDxPixels = [];
  for (let y = 0; y < 30; y++) {
    for (let x = 0; x < 50; x++) {
      if (pixel(x, y) === 0) scalableDxPixels.push([x, y]);
    }
  }
  assert(scalableDxPixels.some(([x]) => x < 14),
    'ordinary scalable ETO_PDY must commit the first glyph to canonical pixels');
  assert(scalableDxPixels.some(([x, y]) => x >= 14 && y >= 6),
    'ordinary scalable ETO_PDY must use WAT placement for the second glyph');

  wat.test_gdi_dc_set_field(hdc, 32, 0, 0); // TA_LEFT | TA_TOP
  clear();
  const beforeScalableDrawText = bytes.slice(wa(dibBits), wa(dibBits) + width * height * 4);
  const scalableDrawRect = allocZero(16);
  writeRect(scalableDrawRect, 2, 2, 90, 40);
  assert.strictEqual(wat.test_call_BeginPath(hdc), 1);
  assert(wat.test_call_DrawTextA(hdc, prefixed, 3, scalableDrawRect, 0) > 0);
  assert.strictEqual(wat.test_call_EndPath(hdc), 1);
  assert.deepStrictEqual(bytes.slice(wa(dibBits), wa(dibBits) + width * height * 4),
    beforeScalableDrawText,
    'scalable DrawText must use WAT layout and masks without touching destination pixels');
  const scalableDrawPath = readPath();
  assert(scalableDrawPath.points.length > scalablePath.points.length,
    'scalable DrawText must record both visible glyphs and the mnemonic underline');
  assert(scalableDrawPath.types.every((type, index) => type === [6, 2, 2, 3][index % 4]));
  assert.strictEqual(wat.test_call_AbortPath(hdc), 1);

  clear();
  writeRect(scalableDrawRect, 2, 2, 94, 40);
  assert.strictEqual(wat.test_call_BeginPath(hdc), 1);
  assert(wat.test_call_DrawTextA(hdc, tabbed, 3, scalableDrawRect, 0x40) > 0);
  assert.strictEqual(wat.test_call_EndPath(hdc), 1);
  const scalableTabbedPath = readPath();
  assert(scalableTabbedPath.points.some(([x]) => x >= 40),
    'scalable DrawText must apply its WAT-owned expanded-tab position');
  assert.strictEqual(wat.test_call_AbortPath(hdc), 1);

  writeRect(scalableDrawRect, 2, 2, 40, 20);
  assert.strictEqual(wat.test_call_BeginPath(hdc), 1);
  assert(wat.test_call_DrawTextA(hdc, prefixed, 3, scalableDrawRect, 0x400) > 0);
  assert.strictEqual(wat.test_call_EndPath(hdc), 1);
  assert.strictEqual(readPath().points.length, 0,
    'DT_CALCRECT must update layout bounds without adding scalable path geometry');
  assert.strictEqual(wat.test_call_AbortPath(hdc), 1);

  const wideNonAscii = writeWide('\u0100');
  writeRect(scalableDrawRect, 2, 2, 40, 24);
  assert.strictEqual(wat.test_call_BeginPath(hdc), 1);
  assert(wat.test_call_DrawTextW(hdc, wideNonAscii, 1, scalableDrawRect, 0x800) > 0);
  assert.strictEqual(wat.test_call_EndPath(hdc), 1);
  assert(readPath().points.length > 0,
    'scalable DrawTextW must preserve non-ASCII UTF-16 instead of stealing a marker bit');
  assert.strictEqual(wat.test_call_AbortPath(hdc), 1);

  clear();
  writeRect(scalableDrawRect, 2, 2, 94, 40);
  assert(wat.test_call_DrawTextA(hdc, tabbed, 3, scalableDrawRect, 0x40) > 0);
  const scalableDrawPixels = [];
  for (let y = 0; y < 30; y++) {
    for (let x = 0; x < width; x++) {
      if (pixel(x, y) === 0) scalableDrawPixels.push([x, y]);
    }
  }
  assert(scalableDrawPixels.some(([x]) => x < 20),
    'ordinary scalable DrawText must commit its first Canvas glyph into canonical WAT pixels');
  assert(scalableDrawPixels.some(([x]) => x >= 40),
    'ordinary scalable DrawText must use WAT tab placement for the second Canvas glyph run');

  wat.test_gdi_dc_set_field(hdc, 32, 1, 0); // TA_LEFT | TA_TOP | TA_UPDATECP
  wat.test_gdi_current_pos_set(hdc, 4, 20);
  assert.strictEqual(wat.test_call_BeginPath(hdc), 1);
  assert.strictEqual(wat.test_call_ExtTextOutAWithDx(
    hdc, 70, 40, 0x2000, 0, textAA, 2, paired), 1);
  assert.strictEqual(wat.test_call_EndPath(hdc), 1);
  assert.strictEqual(wat.test_gdi_dc_get_field(hdc, 12, 0), 28,
    'scalable ETO_PDY must publish the summed WAT X advance');
  assert.strictEqual(wat.test_gdi_dc_get_field(hdc, 16, 0), 22,
    'scalable ETO_PDY must publish the summed WAT Y advance');
  assert.strictEqual(wat.test_call_AbortPath(hdc), 1);

  wat.test_gdi_dc_set_field(hdc, 32, 1, 0); // TA_LEFT | TA_TOP | TA_UPDATECP
  wat.test_gdi_current_pos_set(hdc, 5, 30);
  clear();
  assert.strictEqual(wat.test_call_TextOutA(hdc, 70, 40, glyphA, 1), 1);
  assert(wat.test_gdi_dc_get_field(hdc, 12, 0) > 5,
    'scalable Canvas fallback must publish its advance into WAT current-position state');
  assert.strictEqual(wat.test_gdi_dc_get_field(hdc, 16, 0), 30);

  assert.strictEqual(wat.test_call_DeleteObject(scalable), 1);

  assert.strictEqual(wat.test_call_RemoveFontResourceA(path), 1);
  console.log('PASS  WAT text paths own FNT geometry and scalable Canvas masks');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});

#!/usr/bin/env node
// Direct host-GDI regression coverage for ExtTextOut rectangle semantics.
//
// Native RichEdit paints long lines with ExtTextOut(... ETO_CLIPPED ...).
// The regular TextOut path has no rectangle argument, so this coverage keeps
// ExtTextOut clipping and null-text opaque erases from collapsing back to
// plain glyph drawing.

const assert = require('assert');
const { createHostImports } = require('../lib/host-imports');

try {
  require('skia-canvas');
} catch (_) {
  console.log('SKIP  gdi exttextout clipping test requires skia-canvas');
  process.exit(0);
}

const DX_OBJECTS_WA = 0x07FF0000;
const DX_ENTRY_SIZE = 32;
const slot = 7;
const w = 96;
const h = 32;
const pitch = w * 4;
const dibWa = 0x1000;
const textWa = 0x3000;
const clipRectWa = 0x3100;
const opaqueRectWa = 0x3120;
const memory = new ArrayBuffer(0x08010000);
const mem = new Uint8Array(memory);
const dv = new DataView(memory);
const hdc = 0x200000 + slot;

const entry = DX_OBJECTS_WA + slot * DX_ENTRY_SIZE;
dv.setUint32(entry, 2, true); // DDSurface
dv.setUint16(entry + 12, w, true);
dv.setUint16(entry + 14, h, true);
dv.setUint16(entry + 16, 32, true);
dv.setUint16(entry + 18, pitch, true);
dv.setUint32(entry + 20, dibWa, true);

function setPixel(x, y, r, g, b) {
  const off = dibWa + y * pitch + x * 4;
  mem[off] = b;
  mem[off + 1] = g;
  mem[off + 2] = r;
  mem[off + 3] = 0;
}

function getPixel(x, y) {
  const off = dibWa + y * pitch + x * 4;
  return [mem[off + 2], mem[off + 1], mem[off]];
}

function writeRect(wa, left, top, right, bottom) {
  dv.setInt32(wa, left, true);
  dv.setInt32(wa + 4, top, true);
  dv.setInt32(wa + 8, right, true);
  dv.setInt32(wa + 12, bottom, true);
}

for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) setPixel(x, y, 255, 255, 255);
}

const text = 'MMMMMMMMMMMM';
for (let i = 0; i < text.length; i++) mem[textWa + i] = text.charCodeAt(i);
mem[textWa + text.length] = 0;
writeRect(clipRectWa, 0, 0, 18, 24);
writeRect(opaqueRectWa, 30, 2, 42, 12);

const { host } = createHostImports({
  getMemory: () => memory,
  exports: {},
});

host.dx_surface_sync(slot, 0);
host.gdi_set_bk_mode(hdc, 1); // TRANSPARENT: outside-clip glyph spill is easy to detect.
host.gdi_set_text_color(hdc, 0x000000);
host.gdi_ext_text_out(hdc, 0, 5, 0x4, clipRectWa, textWa, text.length, 0);
host.gdi_set_bk_color(hdc, 0x0000ff);
host.gdi_ext_text_out(hdc, 0, 0, 0x2, opaqueRectWa, 0, 0, 0);
host.dx_surface_sync(slot, 1);

function countDark(x0, x1, y0, y1) {
  let dark = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const [r, g, b] = getPixel(x, y);
      if (r < 100 && g < 100 && b < 100) dark++;
    }
  }
  return dark;
}

const insideClipDark = countDark(0, 18, 0, 24);
// Skia can leave a few antialiased pixels near the clipped glyph edge. Scan
// well past the 18px clip rect so this catches real unbounded text drawing.
const outsideClipDark = countDark(40, 70, 0, 24);
const opaquePixel = getPixel(35, 6);

assert(insideClipDark > 0, 'clipped ExtTextOut should draw glyph pixels inside the clip rect');
assert.strictEqual(outsideClipDark, 0, 'ETO_CLIPPED should prevent glyph pixels outside the clip rect');
assert.deepStrictEqual(opaquePixel, [255, 0, 0], 'ETO_OPAQUE should fill rect with background color even when text is null');

console.log('PASS  ExtTextOut clips glyphs and supports null-text opaque erases');

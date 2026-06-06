const assert = require('assert');
const { createHostImports } = require('../lib/host-imports');

try {
  require('skia-canvas');
} catch (_) {
  console.log('SKIP ddraw surface dirty rect test requires skia-canvas');
  process.exit(0);
}

const DX_OBJECTS_WA = 0x07FF0000;
const DX_ENTRY_SIZE = 32;
const slot = 5;
const w = 64;
const h = 64;
const pitch = w * 4;
const dibWa = 0x1000;
const textWa = 0x3000;
const memory = new ArrayBuffer(0x08010000);
const mem = new Uint8Array(memory);
const dv = new DataView(memory);

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

for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) setPixel(x, y, 10, 20, 30);
}

const { host } = createHostImports({
  getMemory: () => memory,
  exports: {},
});

host.dx_surface_sync(slot, 0);
setPixel(50, 50, 80, 90, 100);
mem[textWa] = 65; // "A"
mem[textWa + 1] = 0;

host.gdi_text_out(0x200000 + slot, 1, 1, textWa, 1, 0);
host.dx_surface_sync(slot, 1);

assert.deepStrictEqual(
  getPixel(50, 50),
  [80, 90, 100],
  'dirty rect canvas->DIB sync should not overwrite unchanged surface pixels'
);

console.log('PASS  DirectDraw surface DC dirty rect sync preserves untouched DIB pixels');

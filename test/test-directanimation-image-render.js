#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { createHostImports } = require('../lib/host-imports');
const { VirtualFS } = require('../lib/filesystem');

const memory = new ArrayBuffer(4096);
const vfs = new VirtualFS();
const rgba = new Uint8Array([
  0x12, 0x34, 0x56, 0xFF,
  0xE0, 0xA0, 0x20, 0xFF,
]);
vfs.files.set('c:\\frame01.jpg', {
  data: new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9]),
  attrs: 0x20,
  decodedImage: { width: 2, height: 1, rgba },
});

const ctx = {
  getMemory: () => memory,
  vfs,
  onExit: () => {},
};
const { host } = createHostImports(ctx);
const pathWa = 0x100;
const path = 'C:\\FRAME01.JPG';
const dv = new DataView(memory);
for (let i = 0; i < path.length; i++) dv.setUint16(pathWa + i * 2, path.charCodeAt(i), true);
dv.setUint16(pathWa + path.length * 2, 0, true);

const imageId = host.da_image_resolve(pathWa);
assert(imageId > 0, 'DirectAnimation should resolve a decode-marked VFS image by UTF-16 path');

const time = new ArrayBuffer(8);
new DataView(time).setFloat64(0, 0, true);
const timeWords = new Uint32Array(time);
assert.strictEqual(host.da_image_blit(imageId, timeWords[0], timeWords[1],
  0x200, 2, 1, 8, 32), 1);
assert.deepStrictEqual(Array.from(new Uint8Array(memory, 0x200, 8)), [
  0x56, 0x34, 0x12, 0xFF,
  0x20, 0xA0, 0xE0, 0xFF,
], '32bpp DirectDraw storage should receive BGRA pixels');

assert.strictEqual(host.da_image_blit(imageId, timeWords[0], timeWords[1],
  0x300, 2, 1, 4, 16), 1);
const expected565 = [0xAA, 0x11, 0x04, 0xE5];
assert.deepStrictEqual(Array.from(new Uint8Array(memory, 0x300, 4)), expected565,
  '16bpp DirectDraw storage should receive little-endian RGB565 pixels');

console.log('PASS  DirectAnimation resolves mounted decoded images and blits canonical DirectDraw pixels');

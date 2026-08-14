#!/usr/bin/env node

const assert = require('assert');
const { createCanvas } = require('../lib/canvas-compat');
const { createHostImports } = require('../lib/host-imports');
const { Win98Renderer } = require('../lib/renderer');

function makeBmp() {
  const bmp = new Uint8Array(70);
  const dv = new DataView(bmp.buffer);
  bmp[0] = 0x42;
  bmp[1] = 0x4D;
  dv.setUint32(2, bmp.length, true);
  dv.setUint32(10, 54, true);
  dv.setUint32(14, 40, true);
  dv.setInt32(18, 2, true);
  dv.setInt32(22, 2, true);
  dv.setUint16(26, 1, true);
  dv.setUint16(28, 24, true);
  dv.setUint32(34, 16, true);
  // Bottom-up BGR rows: blue/white, then red/green.
  bmp.set([255, 0, 0, 255, 255, 255, 0, 0], 54);
  bmp.set([0, 0, 255, 0, 255, 0, 0, 0], 62);
  return bmp;
}

const memory = new ArrayBuffer(1024);
const path = 'wall.bmp';
new Uint8Array(memory, 64, path.length + 1).set(
  Uint8Array.from([...path].map(ch => ch.charCodeAt(0)).concat(0)));
const bmp = makeBmp();
let applied = null;
const hostCtx = {
  getMemory: () => memory,
  renderer: {
    canvas: { width: 8, height: 6 },
    setDesktopWallpaper: (dib, tiled) => { applied = { dib, tiled }; return true; },
  },
};
const { host } = createHostImports(hostCtx);
hostCtx.vfs.files.set('c:\\wall.bmp', { data: bmp, attrs: 0x80 });
assert.strictEqual(host.set_wallpaper(64, 1), 1);
assert(applied && applied.tiled, 'tiled mode was not forwarded to the renderer');
assert.deepStrictEqual(Array.from(applied.dib.pixels.subarray(0, 4)), [255, 0, 0, 255],
  'BMP top-left red pixel was not decoded');
assert.strictEqual(hostCtx.desktopWallpaper.path, path);

const screen = createCanvas(8, 6);
const renderer = new Win98Renderer(screen);
assert(renderer.setDesktopWallpaper(applied.dib, false));
renderer._repaintOnce();
let pixels = screen.getContext('2d').getImageData(0, 0, 8, 6).data;
const pixel = (x, y) => Array.from(pixels.subarray((y * 8 + x) * 4, (y * 8 + x) * 4 + 4));
assert.deepStrictEqual(pixel(0, 0), [0, 128, 128, 255], 'centered wallpaper lost teal surround');
assert.deepStrictEqual(pixel(3, 2), [255, 0, 0, 255], 'centered wallpaper origin is wrong');
assert.deepStrictEqual(pixel(4, 3), [255, 255, 255, 255], 'centered wallpaper pixels are wrong');

assert(renderer.setDesktopWallpaper(applied.dib, true));
renderer._repaintOnce();
pixels = screen.getContext('2d').getImageData(0, 0, 8, 6).data;
assert.deepStrictEqual(pixel(0, 0), [255, 0, 0, 255], 'tiled wallpaper did not start at desktop origin');
assert.deepStrictEqual(pixel(2, 0), [255, 0, 0, 255], 'tiled wallpaper did not repeat horizontally');
assert.deepStrictEqual(pixel(0, 2), [255, 0, 0, 255], 'tiled wallpaper did not repeat vertically');

const browserScreen = createCanvas(8, 6);
browserScreen.parentElement = { style: {} };
const browserRenderer = new Win98Renderer(browserScreen);
browserRenderer.transparentDesktop = true;
assert(browserRenderer.setDesktopWallpaper(applied.dib, true));
assert(/^url\("data:image\/png/.test(browserScreen.parentElement.style.backgroundImage),
  'browser wallpaper was not installed below the transparent emulator canvas');
assert.strictEqual(browserScreen.parentElement.style.backgroundRepeat, 'repeat');
assert.strictEqual(browserScreen.parentElement.style.backgroundPosition, 'left top');

const invalidCtx = { getMemory: () => memory, readFile: () => new Uint8Array([1, 2, 3]) };
assert.strictEqual(createHostImports(invalidCtx).host.set_wallpaper(64, 0), 0,
  'invalid wallpaper file unexpectedly succeeded');

console.log('PASS  wallpaper host decodes a VFS BMP and preserves centered/tiled mode');
console.log('PASS  renderer composites centered and tiled wallpaper pixels without smoothing');
console.log('PASS  transparent browser desktop keeps wallpaper below its icon layer');
console.log('PASS  invalid wallpaper data fails cleanly');

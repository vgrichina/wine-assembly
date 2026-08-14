#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { createHostImports } = require('../lib/host-imports');
const { Win98Renderer } = require('../lib/renderer');

function writeBgra(bytes, base, stride, x, y, r, g, b) {
  const p = base + y * stride + x * 4;
  bytes[p] = b;
  bytes[p + 1] = g;
  bytes[p + 2] = r;
  bytes[p + 3] = 0;
}

const memory = new ArrayBuffer(64 * 1024);
const bytes = new Uint8Array(memory);
let repaintRequests = 0;
const renderer = {
  windows: { 0x77: {} },
  scheduleRepaint() { repaintRequests++; },
  attachWindowSurface(hwnd, canvas) {
    this.windows[hwnd]._backCanvas = canvas;
    return true;
  },
  detachWindowSurface() { return true; },
};
const { host, gdi } = createHostImports({
  getMemory: () => memory,
  exports: {},
  renderer,
});

const id = 0x1234;
const bits = 0x1000;
assert.strictEqual(host.gdi_surface_create(id, 8, 8, 32, bits, 32, 1, 0, 0), 1);
const presentation = gdi.surfacePresentations.get(id);
assert(presentation);
let conversionCalls = 0;
const rgbaRect = presentation.surface.rgbaRect.bind(presentation.surface);
presentation.surface.rgbaRect = (...args) => {
  conversionCalls++;
  return rgbaRect(...args);
};

writeBgra(bytes, bits, 32, 1, 1, 255, 0, 0);
writeBgra(bytes, bits, 32, 5, 4, 0, 255, 0);
assert.strictEqual(host.gdi_surface_upload(id, 1, 1, 4, 4), 1);
assert.strictEqual(host.gdi_surface_upload(id, 4, 2, 6, 5), 1);
assert.strictEqual(conversionCalls, 0,
  'memory-surface writes must not synchronously convert pixels');
assert.strictEqual(presentation.flushCount, 0);
assert.deepStrictEqual(presentation.surface.dirtyRect, { x: 1, y: 1, w: 5, h: 4 });
assert.strictEqual(repaintRequests, 0,
  'an unattached memory DC must not schedule compositor work');

assert.strictEqual(host.gdi_surface_attach(id, 0x77), 1);
assert.strictEqual(repaintRequests, 1);
assert.strictEqual(presentation.flushCount, 0,
  'attaching must retain deferred canonical pixels');
assert.strictEqual(presentation.canvas._waFlushCanonicalSurface(), 1);
assert.strictEqual(conversionCalls, 1);
assert.strictEqual(presentation.flushCount, 1);
assert.strictEqual(presentation.flushedPixels, 20,
  'the first compositor flush must convert the unioned dirty rectangle once');
assert.strictEqual(presentation.surface.dirtyRect, null);

const ctx = presentation.canvas.getContext('2d');
assert.deepStrictEqual(Array.from(ctx.getImageData(1, 1, 1, 1).data),
  [255, 0, 0, 255]);
assert.deepStrictEqual(Array.from(ctx.getImageData(5, 4, 1, 1).data),
  [0, 255, 0, 255]);
assert.strictEqual(conversionCalls, 1,
  'reading an already-current Canvas must not reconvert pixels');

writeBgra(bytes, bits, 32, 2, 6, 0, 0, 255);
assert.strictEqual(host.gdi_surface_upload(id, 2, 6, 3, 7), 1);
assert.strictEqual(conversionCalls, 1);
assert.deepStrictEqual(Array.from(ctx.getImageData(2, 6, 1, 1).data),
  [0, 0, 255, 255],
  'an explicit Canvas read must act as a presentation boundary');
assert.strictEqual(conversionCalls, 2);
assert.strictEqual(presentation.flushCount, 2);

assert.strictEqual(host.gdi_surface_delete(id), 1);
assert.strictEqual(gdi.surfacePresentations.has(id), false);

const order = [];
const compositorContext = {
  imageSmoothingEnabled: true,
  clearRect() {}, fillRect() {}, save() {}, restore() {},
  drawImage(source) { order.push(['draw', source]); },
};
const compositor = new Win98Renderer({
  width: 8,
  height: 8,
  getContext: () => compositorContext,
});
const canonicalCanvas = {
  width: 8,
  height: 8,
  _waFlushCanonicalSurface() { order.push(['flush']); return 1; },
};
compositor._desktopSurfaceCanvas = canonicalCanvas;
compositor._setExclusiveFullscreen = () => {};
compositor._paintCaretOverlay = () => {};
compositor._menuPaintDropdown = () => {};
compositor._paintResizeOutline = () => {};
compositor.updateTaskbar = () => {};
compositor._profileFinish = () => {};
compositor._repaintOnce();
assert.deepStrictEqual(order, [['flush'], ['draw', canonicalCanvas]],
  'the compositor must flush canonical pixels immediately before drawing');
console.log('PASS  canonical GDI writes coalesce until a compositor or read boundary');

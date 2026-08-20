#!/usr/bin/env node
const assert = require('assert');
const { createCanvas } = require('../lib/canvas-compat');
const { createHostImports } = require('../lib/host-imports');
const { g2w } = require('../lib/mem-utils');

const IMAGE_BASE = 0x400000;
const HWND = 0x10001;

function makeHarness(width, height, clientRect) {
  const memory = new ArrayBuffer(1024 * 1024);
  const canvas = createCanvas(width, height);
  const c = canvas.getContext('2d');
  let repaints = 0;
  const win = {
    hwnd: HWND,
    x: 100,
    y: 50,
    w: width,
    h: height,
    isChild: false,
    style: 0,
    clientRect: {
      x: 100 + (clientRect.x | 0),
      y: 50 + (clientRect.y | 0),
      w: clientRect.w | 0,
      h: clientRect.h | 0,
    },
  };
  const exports = {
    get_image_base: () => IMAGE_BASE,
    wnd_window_screen_x: () => 100,
    wnd_window_screen_y: () => 50,
    wnd_client_screen_x: () => win.clientRect.x,
    wnd_client_screen_y: () => win.clientRect.y,
  };
  const renderer = {
    windows: { [HWND]: win },
    wasm: { exports },
    getWindowCanvas: (hwnd) => hwnd === HWND ? { canvas, ctx: c } : null,
    scheduleRepaint: () => { repaints++; },
    _usesOwnWindowSurface: () => false,
  };
  const ctx = { getMemory: () => memory, renderer, exports };
  const { host } = createHostImports(ctx);
  return { memory, canvas, c, host, get repaints() { return repaints; } };
}

function putRect(memory, guestPtr, l, t, r, b) {
  const dv = new DataView(memory);
  const wa = g2w(guestPtr, IMAGE_BASE, memory);
  dv.setInt32(wa, l, true);
  dv.setInt32(wa + 4, t, true);
  dv.setInt32(wa + 8, r, true);
  dv.setInt32(wa + 12, b, true);
}

function fillPattern(c, w, h) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      c.fillStyle = `rgb(${(x * 11) & 255},${(y * 23) & 255},${(x * 5 + y * 7) & 255})`;
      c.fillRect(x, y, 1, 1);
    }
  }
}

function rgbAt(c, x, y) {
  const d = c.getImageData(x, y, 1, 1).data;
  return [d[0], d[1], d[2]];
}

function samePixel(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function testClientDefaultDoesNotScrollChrome() {
  const h = makeHarness(18, 12, { x: 2, y: 3, w: 12, h: 6 });
  h.c.fillStyle = 'rgb(0,0,160)';
  h.c.fillRect(0, 0, 18, 12);
  for (let y = 3; y < 9; y++) {
    for (let x = 2; x < 14; x++) {
      h.c.fillStyle = `rgb(${40 + x},${60 + y},${100 + x + y})`;
      h.c.fillRect(x, y, 1, 1);
    }
  }
  const chromeBefore = rgbAt(h.c, 2, 2);
  const oldClientTop = rgbAt(h.c, 5, 3);
  h.host.gdi_scroll_window(HWND, 0, 1, 0, 0);
  assert.deepStrictEqual(rgbAt(h.c, 2, 2), chromeBefore, 'default scroll must not touch non-client chrome');
  assert.deepStrictEqual(rgbAt(h.c, 5, 3), [255, 255, 255], 'newly exposed client row is cleared');
  assert.deepStrictEqual(rgbAt(h.c, 5, 4), oldClientTop, 'client content moved down by dy');
  assert.strictEqual(h.repaints, 1, 'scroll schedules repaint');
}

function testScrollAndClipRectsIntersect() {
  const h = makeHarness(20, 10, { x: 0, y: 0, w: 20, h: 10 });
  fillPattern(h.c, 20, 10);
  const before = new Map();
  for (const [x, y] of [[3, 3], [4, 3], [7, 6], [10, 3]]) {
    before.set(`${x},${y}`, rgbAt(h.c, x, y));
  }

  const scrollRect = IMAGE_BASE + 0x2000;
  const clipRect = IMAGE_BASE + 0x2020;
  putRect(h.memory, scrollRect, 2, 2, 12, 7);
  putRect(h.memory, clipRect, 4, 2, 10, 7);
  h.host.gdi_scroll_window(HWND, 2, 0, scrollRect, clipRect);

  assert(samePixel(rgbAt(h.c, 3, 3), before.get('3,3')), 'pixels left of clip stay unchanged');
  assert.deepStrictEqual(rgbAt(h.c, 4, 3), [255, 255, 255], 'left exposed strip inside clip is cleared');
  assert.deepStrictEqual(rgbAt(h.c, 6, 3), before.get('4,3'), 'scroll copies from clipped source rect');
  assert.deepStrictEqual(rgbAt(h.c, 9, 6), before.get('7,6'), 'bottom-right clipped copy is preserved');
  assert(samePixel(rgbAt(h.c, 10, 3), before.get('10,3')), 'pixels right of clip stay unchanged');
  assert.strictEqual(h.repaints, 1, 'rect-limited scroll schedules repaint');
}

testClientDefaultDoesNotScrollChrome();
testScrollAndClipRectsIntersect();
console.log('PASS test-gdi-scroll-window-rect');

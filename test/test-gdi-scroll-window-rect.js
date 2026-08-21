#!/usr/bin/env node

'use strict';

// ScrollWindowEx's rect handling: the scroll rect bounds what moves, the clip
// rect bounds what may be touched at all, and the strip the copy vacates is
// repainted in the window background -- inside the clip only.
//
// This used to drive host.gdi_scroll_window, a JS import removed in 78d7289
// when the GDI bridge was cut down to primitives; scrolling has rasterized
// inside WAT since. Rewritten against $gdi_scroll_window, which is where the
// rect arithmetic now lives. The plain "scroll the whole client" case is
// covered by test-wat-gdi-window-surface; what is only here is the
// scroll-rect/clip-rect intersection, and that chrome stays put.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createCanvas } = require('../lib/canvas-compat');
const { createHostImports } = require('../lib/host-imports');
const { Win98Renderer } = require('../lib/renderer');
const { compileWat } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const HWND = 0x10001;
const WHITE = 0x00ffffff;

async function boot(width, height) {
  const wasm = await compileWat(file =>
    fs.promises.readFile(path.join(ROOT, 'src', file), 'utf8'));
  const renderer = new Win98Renderer(createCanvas(640, 480));
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const ctx = { getMemory: () => memory.buffer, renderer, resourceJson: {}, exports: null };
  const base = createHostImports(ctx);
  base.host.memory = memory;
  for (const name of ['create_thread', 'exit_thread', 'create_event', 'set_event',
                      'reset_event', 'wait_single', 'wait_multiple']) {
    base.host[name] = () => 0;
  }
  base.host.com_create_instance = () => 0x80004002;
  const { instance } = await WebAssembly.instantiate(wasm, base);
  ctx.exports = instance.exports;
  const wat = instance.exports;
  renderer.windows[HWND] = {
    hwnd: HWND, x: 100, y: 50, w: width, h: height, zOrder: 1,
    style: 0x10000000, visible: true, isChild: false,
    clientRect: { x: 100, y: 50, w: width, h: height },
    wasm: instance, wasmMemory: memory,
  };
  wat.wnd_table_set(HWND, 0);
  wat.ctrl_set_geom(HWND, 100, 50, width, height);
  wat.wnd_set_style_export(HWND, 0x10000000);
  return { wat, renderer };
}

// The RECT pair ScrollWindowEx takes, at WASM addresses -- $gdi_scroll_window
// reads them directly rather than through g2w.
function putRect(wat, guestPtr, l, t, r, b) {
  wat.guest_write32(guestPtr, l);
  wat.guest_write32(guestPtr + 4, t);
  wat.guest_write32(guestPtr + 8, r);
  wat.guest_write32(guestPtr + 12, b);
  return guestPtr - wat.get_image_base() + 0x12000;
}

function paintPattern(wat, hdc, w, h) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Distinct per pixel and never white, so "was cleared" and "was moved"
      // can never be confused.
      wat.test_call_SetPixel(hdc, x, y, ((x + 1) | ((y + 1) << 8) | (0x40 << 16)) >>> 0);
    }
  }
}

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log(`  ok  ${label}`);
}

async function main() {
  {
    const { wat } = await boot(18, 12);
    // Client area inset from the window: 2,3 .. 14,9.
    wat.test_gdi_client_rect_set(HWND, 2, 3, 14, 9);
    const whole = wat.test_call_GetWindowDC(HWND) >>> 0;
    const client = wat.test_call_GetDC(HWND) >>> 0;
    assert(whole && client, 'both DCs must allocate');
    paintPattern(wat, whole, 18, 12);
    const chromeBefore = wat.test_call_GetPixel(whole, 1, 1) >>> 0;
    const clientTopBefore = wat.test_call_GetPixel(client, 3, 0) >>> 0;

    assert.strictEqual(wat.test_gdi_scroll_window(HWND, 0, 1, 0, 0), 1);

    check('a default scroll leaves the non-client chrome alone', () => {
      assert.strictEqual(wat.test_call_GetPixel(whole, 1, 1) >>> 0, chromeBefore);
    });
    check('client content moves by dy', () => {
      assert.strictEqual(wat.test_call_GetPixel(client, 3, 1) >>> 0, clientTopBefore);
    });
    check('the row the scroll vacated is cleared', () => {
      assert.strictEqual(wat.test_call_GetPixel(client, 3, 0) >>> 0, WHITE);
    });
  }

  {
    const { wat } = await boot(20, 10);
    wat.test_gdi_client_rect_set(HWND, 0, 0, 20, 10);
    const client = wat.test_call_GetDC(HWND) >>> 0;
    paintPattern(wat, client, 20, 10);
    const before = (x, y) => wat.test_call_GetPixel(client, x, y) >>> 0;
    const at33 = before(3, 3), at43 = before(4, 3), at76 = before(7, 6), at103 = before(10, 3);

    const scratch = wat.guest_alloc(64) >>> 0;
    const scrollRect = putRect(wat, scratch, 2, 2, 12, 7);
    const clipRect = putRect(wat, scratch + 16, 4, 2, 10, 7);
    assert.strictEqual(wat.test_gdi_scroll_window(HWND, 2, 0, scrollRect, clipRect), 1);

    check('pixels left of the clip rect are untouched', () => {
      assert.strictEqual(before(3, 3), at33);
    });
    check('the exposed strip is cleared only inside the clip', () => {
      assert.strictEqual(before(4, 3), WHITE);
    });
    check('the copy source is the clipped rect, not the scroll rect', () => {
      assert.strictEqual(before(6, 3), at43);
    });
    check('the clipped copy keeps its bottom-right corner', () => {
      assert.strictEqual(before(9, 6), at76);
    });
    check('pixels right of the clip rect are untouched', () => {
      assert.strictEqual(before(10, 3), at103);
    });
  }

  console.log(`PASS test-gdi-scroll-window-rect (${passed} checks)`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

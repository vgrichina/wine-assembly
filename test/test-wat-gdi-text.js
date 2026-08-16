#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');
const { mountBundledFonts } = require('./render-helper');

async function main() {
  const root = path.join(__dirname, '..');
  const wasm = await compileWat(file => fs.promises.readFile(path.join(root, 'src', file), 'utf8'));
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  // Text is rasterized from mounted strikes now, so a host with an empty font
  // directory measures every string as zero pixels wide.
  const ctx = { getMemory: () => memory.buffer, renderer: null, resourceJson: {} };
  const base = createHostImports(ctx);
  mountBundledFonts(ctx);
  base.host.memory = memory;
  base.host.create_thread = () => 0;
  base.host.exit_thread = () => 0;
  base.host.create_event = () => 0;
  base.host.set_event = () => 0;
  base.host.reset_event = () => 0;
  base.host.wait_single = () => 0;
  base.host.wait_multiple = () => 0;
  base.host.com_create_instance = () => 0x80004002;
  const { instance } = await WebAssembly.instantiate(wasm, base);
  const wat = instance.exports;
  // The VFS reads guest memory through ctx.exports, so a font file cannot be
  // loaded until this is set — and with no host text path left, no font means
  // no text at all.
  ctx.exports = wat;

  const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
  const bitmap = wat.test_call_CreateCompatibleBitmap(hdc, 160, 32) >>> 0;
  assert(hdc && bitmap);
  assert.strictEqual(wat.test_call_SelectObject(hdc, bitmap), 0x30007);

  const ansi = wat.guest_alloc(4) >>> 0;
  wat.guest_write32(ansi, 0x00420941); // "A\tB\0"
  const stops = wat.guest_alloc(8) >>> 0;
  wat.guest_write32(stops, 20);
  wat.guest_write32(stops + 4, 40);

  // These widths come from the bundled Wine System strike (SYSTEM_FONT, a 16px
  // cell with A=8 and B=10), which is what the DC selects by default. They used
  // to be Canvas's approximation of a 12px cell, measured from whatever font
  // the host machine resolved.
  const explicit = wat.test_call_GetTabbedTextExtentA(hdc, ansi, 3, 2, stops) >>> 0;
  assert.strictEqual(explicit & 0xffff, 30,
    'A, tab to explicit x=20, then B (10px) in the stock System strike');
  assert.strictEqual(explicit >>> 16, 16, 'native Win98 SYSTEM_FONT cell height');
  const defaultTabs = wat.test_call_GetTabbedTextExtentA(hdc, ansi, 3, 0, 0) >>> 0;
  assert.strictEqual(defaultTabs & 0xffff, 66,
    'default tabs repeat every eight average character cells');
  wat.guest_write32(stops, 16);
  const repeating = wat.test_call_GetTabbedTextExtentA(hdc, ansi, 3, 1, stops) >>> 0;
  assert.strictEqual(repeating & 0xffff, 26,
    'one explicit tab value is a repeating interval, not a one-shot stop');
  wat.guest_write32(stops, 20);

  const wide = wat.guest_alloc(8) >>> 0;
  wat.guest_write16(wide, 65);
  wat.guest_write16(wide + 2, 9);
  wat.guest_write16(wide + 4, 66);
  wat.guest_write16(wide + 6, 0);
  assert.strictEqual(wat.test_call_GetTabbedTextExtentW(hdc, wide, 3, 2, stops), explicit,
    'ANSI and UTF-16 tab layout must share the same canonical algorithm');

  const before = new Uint8Array(memory.buffer).slice();
  const drawn = wat.test_call_TabbedTextOutA(hdc, 5, 4, ansi, 3, 2, stops, 5) >>> 0;
  assert.strictEqual(drawn & 0xffff, 30);
  const descriptor = 0x07EF1000;
  assert.strictEqual(wat.test_gdi_surface_descriptor(hdc, descriptor), 1);
  const dv = new DataView(memory.buffer);
  const bits = dv.getUint32(descriptor, true);
  const stride = dv.getUint32(descriptor + 12, true);
  const after = new Uint8Array(memory.buffer);
  assert(after.subarray(bits, bits + stride * 32).some((value, index) => value !== before[bits + index]),
    'tabbed output must rasterize each run back into canonical WAT pixels');

  assert.strictEqual(wat.test_call_TabbedTextOutW(hdc, 5, 4, wide, 3, 2, stops, 5), drawn);
  assert.strictEqual(wat.test_call_GetTabbedTextExtentA(hdc, ansi, -1, 0, 0), 0,
    'negative explicit counts are rejected');
  assert.strictEqual(wat.test_call_GetTabbedTextExtentA(hdc, ansi, 3, 1, 0), 0,
    'a nonzero tab count requires a tab-stop array');

  assert.strictEqual(wat.test_call_DeleteObject(bitmap), 1);
  assert.strictEqual(wat.test_call_DeleteDC(hdc), 1);
  console.log('PASS  WAT owns ANSI/Wide tab layout and canonical text measurement binding');
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});

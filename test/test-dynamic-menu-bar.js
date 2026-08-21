#!/usr/bin/env node
'use strict';

// Runtime-created menu bars (CreateMenu/CreatePopupMenu/AppendMenu) are not
// RT_MENU resources. JigSawed is a VB1 app and its File -> Open route exists
// only in this form, including a nested Options submenu.

const assert = require('assert');
const { createWindowHost, serializeHostMenuTree } = require('../lib/host-window');

const ROOT = 0x800001;
const FILE = 0x800002;
const OPTIONS = 0x800003;
const SHAPE = 0x800004;
const item = (text, id, flags = 0) => ({
  flags, id, submenu: flags & 0x10 ? id : 0, popup: !!(flags & 0x10),
  separator: !!(flags & 0x800), disabled: !!(flags & 3), text,
});
const menus = new Map([
  [ROOT, [item('&File', FILE, 0x10), item('&Options', OPTIONS, 0x10)]],
  [FILE, [item('&Open...\tCtrl+O', 100), item('', 0, 0x800), item('E&xit', 101)]],
  [OPTIONS, [item('&Shape', SHAPE, 0x10), item('&Sound', 200, 0x08)]],
  [SHAPE, [item('&Square', 300), item('&Jigsaw', 301, 0x03)]],
]);

const blob = serializeHostMenuTree(menus, ROOT);
const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
const ascii = (off, len) => String.fromCharCode(...blob.subarray(off, off + len));

assert.strictEqual(dv.getUint32(0, true), 2, 'two menu-bar headings');
const fileBar = 4;
const optionsBar = 20;
assert.strictEqual(ascii(dv.getUint32(fileBar, true), dv.getUint32(fileBar + 4, true)), '&File');
assert.strictEqual(ascii(dv.getUint32(optionsBar, true), dv.getUint32(optionsBar + 4, true)), '&Options');

const fileChildren = dv.getUint32(fileBar + 8, true);
assert.strictEqual(dv.getUint32(fileChildren, true), 3);
const open = fileChildren + 4;
assert.strictEqual(dv.getUint32(open + 20, true), 100);
assert.strictEqual(ascii(dv.getUint32(open, true), dv.getUint32(open + 4, true)), '&Open...');
assert.strictEqual(ascii(dv.getUint32(open + 8, true), dv.getUint32(open + 12, true)), 'Ctrl+O');
assert(dv.getUint32(open + 28 + 16, true) & 1, 'separator flag must reach the WAT blob');

const optionsChildren = dv.getUint32(optionsBar + 8, true);
const shape = optionsChildren + 4;
const shapeChildren = dv.getUint32(shape + 24, true);
assert.strictEqual(dv.getUint32(shapeChildren, true), 2, 'nested popup item count');
assert.strictEqual(dv.getUint32(shapeChildren + 4 + 20, true), 300);
assert.strictEqual(dv.getUint32(shapeChildren + 4 + 28 + 20, true), 301);
assert(dv.getUint32(shapeChildren + 4 + 28 + 16, true) & 2,
  'disabled nested item must reach the WAT blob');
assert(dv.getUint32(optionsChildren + 4 + 28 + 16, true) & 4,
  'checked item must reach the WAT blob');

// Exercise the actual host import seam: it must copy the serialized bytes to
// WASM memory, retain the original HMENU identity, and tell the renderer that
// WAT already owns a ready menu instead of asking for an RT_MENU resource.
const memory = new ArrayBuffer(1 << 20);
let installed = null;
let rendered = null;
const watExports = {
  guest_alloc: () => 0x400000,
  guest_free: () => {},
  guest_write8: (guest, value) => { new Uint8Array(memory)[0x1000 + guest - 0x400000] = value; },
  menu_set_source_guest: (hwnd, guest, len, source) => {
    const wa = 0x1000 + guest - 0x400000;
    installed = { hwnd, source, bytes: new Uint8Array(memory.slice(wa, wa + len)) };
  },
};
const renderer = {
  wasm: { exports: watExports },
  setMenu: (hwnd, menu, ready) => { rendered = { hwnd, menu, ready }; },
};
const ctx = {
  renderer, exports: watExports, _hostMenus: menus,
  getMemory: () => memory,
};
const host = createWindowHost(ctx, {
  readStr: () => '', readStrW: () => '', cursorCssForHandle: () => 'default',
});
host.imports.set_menu(0x10002, ROOT);
assert(installed, 'set_menu must install a dynamic blob');
assert.strictEqual(installed.hwnd, 0x10002);
assert.strictEqual(installed.source, ROOT, 'GetMenu identity must remain the CreateMenu handle');
assert.deepStrictEqual([...installed.bytes], [...blob]);
assert.deepStrictEqual(rendered, { hwnd: 0x10002, menu: ROOT, ready: true });

console.log('PASS dynamic CreateMenu/AppendMenu bars bridge into WAT menu rendering');

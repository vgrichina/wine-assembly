#!/usr/bin/env node
// Standalone ToolbarWindow32 regression. Loads the WAT module without a guest
// EXE, creates a WAT-native toolbar, then verifies TB_INSERTBUTTONA shifts the
// stored TBBUTTON array with overlap-safe semantics and HINST_COMMCTRL
// built-in bitmap strips are loadable through TB_ADDBITMAP.

'use strict';

const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');

const TB_ADDBITMAP = 0x0413;
const TB_BUTTONSTRUCTSIZE = 0x041E;
const TB_ADDBUTTONSA = 0x0414;
const TB_INSERTBUTTONA = 0x0415;
const TB_GETBUTTON = 0x0417;
const TB_BUTTONCOUNT = 0x0418;
const TB_GETITEMRECT = 0x041D;
const TBSTATE_ENABLED = 0x04;
const TBSTYLE_BUTTON = 0x00;

async function main() {
  const wasmBytes = await compileWat(f => fs.promises.readFile(path.join(SRC_DIR, f), 'utf-8'));
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const ctx = {
    getMemory: () => memory.buffer,
    renderer: null,
    resourceJson: { menus: {}, dialogs: {}, strings: {}, bitmaps: {} },
    onExit: () => {},
  };
  const base = createHostImports(ctx);
  let commonControlBitmapHandle = 0;
  const realLoadBitmap = base.host.gdi_load_bitmap;
  base.host.gdi_load_bitmap = (hInstance, resourceId) => {
    const h = realLoadBitmap(hInstance, resourceId);
    if ((hInstance | 0) === -1 && (resourceId >>> 0) === 0) {
      commonControlBitmapHandle = h >>> 0;
    }
    return h;
  };
  base.host.memory = memory;
  base.host.create_thread = () => 0;
  base.host.exit_thread = () => 0;
  base.host.create_event = () => 0;
  base.host.set_event = () => 0;
  base.host.reset_event = () => 0;
  base.host.wait_single = () => 0;
  base.host.wait_multiple = () => 0;
  base.host.com_create_instance = () => 0x80004002;

  const { instance } = await WebAssembly.instantiate(wasmBytes, base);
  const e = instance.exports;
  const u8 = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  const wa = g => g - e.get_image_base() + 0x12000;

  const checks = [];
  function check(name, pass, info = '') {
    checks.push({ name, pass: !!pass });
    console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (info ? '  (' + info + ')' : ''));
  }
  function writeStr(s) {
    const g = e.guest_alloc(s.length + 1);
    const p = wa(g);
    for (let i = 0; i < s.length; i++) u8[p + i] = s.charCodeAt(i);
    u8[p + s.length] = 0;
    return g;
  }
  function writeButtonAt(p, i, image, command, state = TBSTATE_ENABLED, style = TBSTYLE_BUTTON) {
    const off = p + i * 20;
    dv.setInt32(off + 0, image, true);
    dv.setInt32(off + 4, command, true);
    u8[off + 8] = state;
    u8[off + 9] = style;
    u8[off + 10] = 0;
    u8[off + 11] = 0;
    dv.setUint32(off + 12, 0, true);
    dv.setInt32(off + 16, -1, true);
  }
  function allocButtons(buttons) {
    const g = e.guest_alloc(buttons.length * 20);
    const p = wa(g);
    u8.fill(0, p, p + buttons.length * 20);
    buttons.forEach((b, i) => writeButtonAt(p, i, b.image, b.command, b.state, b.style));
    return g;
  }
  function allocAddBitmap(hInst, nId) {
    const g = e.guest_alloc(8);
    const p = wa(g);
    dv.setInt32(p + 0, hInst, true);
    dv.setInt32(p + 4, nId, true);
    return g;
  }
  function countColorPixels(bmp) {
    if (!bmp || !bmp.pixels) return 0;
    let colorful = 0;
    for (let i = 0; i + 3 < bmp.pixels.length; i += 4) {
      const r = bmp.pixels[i];
      const g = bmp.pixels[i + 1];
      const b = bmp.pixels[i + 2];
      const a = bmp.pixels[i + 3];
      if (!a) continue;
      if (r === 192 && g === 192 && b === 192) continue;
      if (Math.max(r, g, b) - Math.min(r, g, b) >= 32) colorful++;
    }
    return colorful;
  }
  function readButton(idx) {
    const g = e.guest_alloc(20);
    const p = wa(g);
    u8.fill(0, p, p + 20);
    const ok = e.send_message(toolbar, TB_GETBUTTON, idx, g);
    return {
      ok,
      image: dv.getInt32(p + 0, true),
      command: dv.getInt32(p + 4, true),
      state: u8[p + 8],
      style: u8[p + 9],
    };
  }
  function readRect(idx) {
    const g = e.guest_alloc(16);
    const p = wa(g);
    u8.fill(0, p, p + 16);
    const ok = e.send_message(toolbar, TB_GETITEMRECT, idx, g);
    return {
      ok,
      left: dv.getInt32(p + 0, true),
      top: dv.getInt32(p + 4, true),
      right: dv.getInt32(p + 8, true),
      bottom: dv.getInt32(p + 12, true),
    };
  }

  const baselineSlots = e.wnd_count_used();
  check('ToolbarWindow32 is protected from registered-class fallback',
    e.test_is_builtin_control_class(writeStr('ToolbarWindow32')) === 1);
  const toolbar = e.test_create_toolbar(0, 0, 220, 28, 0);
  check('toolbar hwnd allocated', toolbar !== 0, 'hwnd=0x' + toolbar.toString(16));
  check('create added 2 slots (parent + toolbar)', e.wnd_count_used() === baselineSlots + 2);

  check('TB_BUTTONSTRUCTSIZE accepts 20-byte TBBUTTON',
    e.send_message(toolbar, TB_BUTTONSTRUCTSIZE, 20, 0) === 1);
  check('TB_ADDBITMAP loads HINST_COMMCTRL standard small-color strip',
    e.send_message(toolbar, TB_ADDBITMAP, 15, allocAddBitmap(-1, 0)) === 0 &&
      commonControlBitmapHandle !== 0,
    `hbitmap=0x${commonControlBitmapHandle.toString(16)}`);
  const commonControlBitmap = base.gdi._gdiObjects[commonControlBitmapHandle];
  check('HINST_COMMCTRL standard strip has expected geometry',
    commonControlBitmap &&
      commonControlBitmap.w === 240 &&
      commonControlBitmap.h === 15,
    commonControlBitmap ? `${commonControlBitmap.w}x${commonControlBitmap.h}` : 'missing');
  check('HINST_COMMCTRL standard strip has colored icon pixels',
    countColorPixels(commonControlBitmap) > 200,
    `colorPixels=${countColorPixels(commonControlBitmap)}`);

  const initial = allocButtons([
    { image: 0, command: 101 },
    { image: 1, command: 102 },
    { image: 2, command: 103 },
  ]);
  check('TB_ADDBUTTONSA adds initial records',
    e.send_message(toolbar, TB_ADDBUTTONSA, 3, initial) === 1);
  check('TB_BUTTONCOUNT is 3 after add',
    e.send_message(toolbar, TB_BUTTONCOUNT, 0, 0) === 3);

  const inserted = allocButtons([{ image: 9, command: 199 }]);
  check('TB_INSERTBUTTONA inserts in the middle',
    e.send_message(toolbar, TB_INSERTBUTTONA, 1, inserted) === 1);
  check('TB_BUTTONCOUNT is 4 after insert',
    e.send_message(toolbar, TB_BUTTONCOUNT, 0, 0) === 4);

  const buttons = [0, 1, 2, 3].map(readButton);
  const commands = buttons.map(b => b.command);
  const images = buttons.map(b => b.image);
  check('TB_INSERTBUTTONA preserves command order through overlapping shift',
    JSON.stringify(commands) === JSON.stringify([101, 199, 102, 103]),
    'got ' + JSON.stringify(commands));
  check('TB_INSERTBUTTONA preserves bitmap-index order through overlapping shift',
    JSON.stringify(images) === JSON.stringify([0, 9, 1, 2]),
    'got ' + JSON.stringify(images));
  check('TB_GETBUTTON keeps inserted button enabled',
    buttons[1].state === TBSTATE_ENABLED && buttons[1].style === TBSTYLE_BUTTON,
    `state=${buttons[1].state} style=${buttons[1].style}`);

  const rects = [0, 1, 2, 3].map(readRect);
  const monotonicRects = rects.every((r, i) =>
    r.ok === 1 &&
    r.left < r.right &&
    (i === 0 || r.left >= rects[i - 1].right));
  check('TB_GETITEMRECT stays monotonic after insert',
    monotonicRects,
    'rects=' + JSON.stringify(rects));

  console.log('');
  const failed = checks.filter(c => !c.pass).length;
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});

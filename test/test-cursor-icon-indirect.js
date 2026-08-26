#!/usr/bin/env node

'use strict';

// CreateIconIndirect / SetCursor for cursors the guest BUILDS itself.
//
// Heroes of Might & Magic II never calls LoadCursor: it draws its hand pointer
// into a pair of bitmaps and hands them to CreateIconIndirect. That used to be
// a return-constant stub handing back one fixed handle and dropping the
// bitmaps, so SetCursor fell through its IDC_* switch and the page kept the
// arrow. What this checks is the whole chain: distinct handles per cursor, the
// AND/XOR planes composited to the pixels the guest drew, the guest's own
// hotspot reaching the host, GetIconInfo answering with copies, and DestroyIcon
// freeing the slot.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');
const { createHostImports } = require('../lib/host-imports');

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log(`  ok  ${label}`);
}

(async () => {
  const pushes = [];
  // The real host import, wired to a canvas that only has a style -- which is
  // all a cursor needs. Calling it from the recording stub keeps this test on
  // the shipping encoder rather than on a description of it.
  let cssCanvas = null;
  let cssHost = null;
  const harness = await bootRenderHarness({
    extraHostOverrides: {
      set_cursor_image: (hcur, width, height, hotX, hotY, bgraWa) => {
        if (cssHost) cssHost.host.set_cursor_image(hcur, width, height, hotX, hotY, bgraWa);
        const px = [];
        if (bgraWa) {
          const mem = new Uint8Array(harness.memory.buffer, bgraWa >>> 0, width * height * 4);
          for (let i = 0; i < width * height; i++) {
            px.push([mem[i * 4 + 2], mem[i * 4 + 1], mem[i * 4 + 0], mem[i * 4 + 3]]);
          }
        }
        pushes.push({ hcur: hcur >>> 0, width, height, hotX, hotY, pixels: px, hadBits: !!bgraWa });
      },
      set_cursor: () => {},
    },
    extraWat: `
    (func (export "test_call_CreateIconIndirect") (param $info i32) (result i32)
      (local $saved_esp i32)
      (local.set $saved_esp (global.get $esp))
      (call $handle_CreateIconIndirect
        (local.get $info) (i32.const 0) (i32.const 0) (i32.const 0)
        (i32.const 0) (i32.const 0))
      (global.set $esp (local.get $saved_esp))
      (global.get $eax))
    (func (export "test_call_GetIconInfo") (param $icon i32) (param $info i32) (result i32)
      (local $saved_esp i32)
      (local.set $saved_esp (global.get $esp))
      (call $handle_GetIconInfo
        (local.get $icon) (local.get $info) (i32.const 0) (i32.const 0)
        (i32.const 0) (i32.const 0))
      (global.set $esp (local.get $saved_esp))
      (global.get $eax))
    (func (export "test_call_SetCursor") (param $hcur i32) (result i32)
      (local $saved_esp i32)
      (local.set $saved_esp (global.get $esp))
      (call $handle_SetCursor
        (local.get $hcur) (i32.const 0) (i32.const 0) (i32.const 0)
        (i32.const 0) (i32.const 0))
      (global.set $esp (local.get $saved_esp))
      (global.get $eax))
    (func (export "test_call_DestroyIcon") (param $icon i32) (result i32)
      (local $saved_esp i32)
      (local.set $saved_esp (global.get $esp))
      (call $handle_DestroyIcon
        (local.get $icon) (i32.const 0) (i32.const 0) (i32.const 0)
        (i32.const 0) (i32.const 0))
      (global.set $esp (local.get $saved_esp))
      (global.get $eax))
  ` });
  const wat = harness.exports;
  cssCanvas = { style: {} };
  cssHost = createHostImports({
    getMemory: () => harness.memory.buffer,
    renderer: { canvas: cssCanvas },
    resourceJson: { menus: {}, dialogs: {}, strings: {}, bitmaps: {} },
    onExit: () => {},
  });

  const alloc = size => wat.guest_alloc(size) >>> 0;
  const writeBytes = (ptr, bytes) => {
    for (let i = 0; i < bytes.length; i++) wat.guest_write8(ptr + i, bytes[i]);
  };

  // A W x H monochrome cursor as Win32 stores one: a 1bpp bitmap of height 2H,
  // AND plane over XOR plane. The rows are described here as strings so the
  // intended picture is readable -- '1' is a set bit.
  //   AND=0 XOR=0 -> opaque black, AND=0 XOR=1 -> opaque white,
  //   AND=1 XOR=0 -> transparent.
  const monoBitmap = (rows) => {
    const w = rows[0].length;
    const h = rows.length;
    const stride = ((w + 15) >> 4) << 1;   // DDB rows are WORD aligned
    const bytes = new Uint8Array(stride * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (rows[y][x] === '1') bytes[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
    const p = alloc(bytes.length);
    writeBytes(p, bytes);
    return wat.test_call_CreateBitmap(w, h, 1, 1, p) >>> 0;
  };

  const iconInfo = ({ fIcon = 0, xHot = 0, yHot = 0, mask = 0, color = 0 }) => {
    const p = alloc(20);
    wat.guest_write32(p + 0, fIcon);
    wat.guest_write32(p + 4, xHot);
    wat.guest_write32(p + 8, yHot);
    wat.guest_write32(p + 12, mask);
    wat.guest_write32(p + 16, color);
    return p;
  };

  // A 4x4 cursor that uses all four AND/XOR combinations exactly once per
  // corner, so a plane swap or a flipped row cannot pass. Stacked AND (top 4
  // rows) over XOR (bottom 4), which is how Win32 lays a mono mask out.
  //
  //   .WKK    (0,0) transparent  (1,0) white  (2,0) black
  //   KKKK
  //   WWWW
  //   KKKK    (3,3) AND=1 XOR=1 -- invert, which we draw as opaque black
  const ART_AND = [
    '1000',
    '0000',
    '0000',
    '0001',
  ];
  const ART_XOR = [
    '0100',
    '0000',
    '1111',
    '0001',
  ];
  const crossMask = () => monoBitmap(ART_AND.concat(ART_XOR));

  let handleA, handleB;

  check('CreateIconIndirect returns a distinct non-zero handle per cursor', () => {
    handleA = wat.test_call_CreateIconIndirect(
      iconInfo({ xHot: 1, yHot: 2, mask: crossMask() })) >>> 0;
    handleB = wat.test_call_CreateIconIndirect(
      iconInfo({ xHot: 3, yHot: 0, mask: crossMask() })) >>> 0;
    assert.ok(handleA !== 0, 'first handle is zero');
    assert.ok(handleB !== 0, 'second handle is zero');
    assert.notStrictEqual(handleA, handleB, 'two cursors shared one handle');
    assert.strictEqual(handleA & 0xFFFF0000, 0x00CC0000, 'handle is not tagged as a cursor');
  });

  check('CreateIconIndirect rejects a NULL ICONINFO', () => {
    assert.strictEqual(wat.test_call_CreateIconIndirect(0) >>> 0, 0);
  });

  check('SetCursor pushes the composited pixels the guest drew', () => {
    pushes.length = 0;
    wat.test_call_SetCursor(handleA);
    assert.strictEqual(pushes.length, 1, 'no cursor image reached the host');
    const p = pushes[0];
    assert.strictEqual(p.hcur, handleA);
    assert.strictEqual(p.width, 4, 'width');
    assert.strictEqual(p.height, 4, 'height: the mask is 2H tall, the cursor is H');
    assert.ok(p.hadBits, 'first push carried no pixels');
    const at = (x, y) => p.pixels[y * 4 + x];
    // Print what was composited: a wrong row or plane order is a picture
    // problem, and a diff of two [r,g,b,a] tuples cannot show it.
    for (let y = 0; y < 4; y++) {
      let line = '';
      for (let x = 0; x < 4; x++) {
        const px = at(x, y);
        line += px[3] === 0 ? '.' : (px[0] > 127 ? 'W' : 'K');
      }
      console.log(`      ${line}`);
    }
    assert.deepStrictEqual(at(0, 0), [0, 0, 0, 0], 'AND=1 XOR=0 is not transparent');
    assert.deepStrictEqual(at(1, 0), [255, 255, 255, 255], 'AND=0 XOR=1 is not white');
    assert.deepStrictEqual(at(2, 0), [0, 0, 0, 255], 'AND=0 XOR=0 is not opaque black');
    assert.deepStrictEqual(at(3, 3), [0, 0, 0, 255], 'AND=1 XOR=1 (invert) is not drawn');
    assert.ok(p.pixels.some(px => px[3] !== 0), 'cursor rasterized to nothing at all');
  });

  check('the hotspot reaching the host is the guest\'s own', () => {
    pushes.length = 0;
    wat.test_call_SetCursor(handleB);
    assert.strictEqual(pushes[0].hotX, 3);
    assert.strictEqual(pushes[0].hotY, 0);
    pushes.length = 0;
    wat.test_call_SetCursor(handleA);
    assert.strictEqual(pushes[0].hotX, 1);
    assert.strictEqual(pushes[0].hotY, 2);
  });

  check('re-selecting a cursor costs no second rasterization', () => {
    pushes.length = 0;
    wat.test_call_SetCursor(handleA);
    wat.test_call_SetCursor(handleA);
    assert.strictEqual(pushes.length, 2, 'the host is not told about every selection');
    assert.strictEqual(pushes[1].hadBits, false,
      'pixels were re-sent for a cursor the host already has');
  });

  check('SetCursor returns the previous cursor', () => {
    wat.test_call_SetCursor(handleA);
    assert.strictEqual(wat.test_call_SetCursor(handleB) >>> 0, handleA);
  });

  check('GetIconInfo reports the record back, with its own bitmap copies', () => {
    const info = alloc(20);
    for (let i = 0; i < 20; i += 4) wat.guest_write32(info + i, 0);
    assert.notStrictEqual(wat.test_call_GetIconInfo(handleA, info) >>> 0, 0, 'returned FALSE');
    assert.strictEqual(wat.guest_read32(info + 0) >>> 0, 0, 'fIcon: a cursor, not an icon');
    assert.strictEqual(wat.guest_read32(info + 4) >>> 0, 1, 'xHotspot');
    assert.strictEqual(wat.guest_read32(info + 8) >>> 0, 2, 'yHotspot');
    const mask = wat.guest_read32(info + 12) >>> 0;
    assert.ok(mask !== 0, 'no mask bitmap handed back');
    // The caller owns what GetIconInfo returns, so it must not be our own
    // bitmap -- deleting it would gut the cursor.
    pushes.length = 0;
    wat.test_call_SetCursor(handleB);
    wat.test_call_SetCursor(handleA);
    assert.ok(pushes.length >= 1, 'cursor stopped being presentable');
  });

  check('the host presents it as a .cur data URL with the guest\'s hotspot', () => {
    wat.test_call_SetCursor(handleB);
    wat.test_call_SetCursor(handleA);
    const css = cssCanvas.style.cursor || '';
    assert.ok(/^url\(data:image\/x-icon;base64,[A-Za-z0-9+/=]+\) 1 2, default$/.test(css),
      `canvas.style.cursor is ${JSON.stringify(css)}`);
    const cur = Buffer.from(css.slice(css.indexOf(',') + 1, css.indexOf(')')), 'base64');
    const dv = new DataView(cur.buffer, cur.byteOffset, cur.byteLength);
    assert.strictEqual(dv.getUint16(2, true), 2, 'idType: a cursor, not an icon');
    assert.strictEqual(cur[6], 4, 'ICONDIRENTRY width');
    assert.strictEqual(cur[7], 4, 'ICONDIRENTRY height');
    assert.strictEqual(dv.getUint16(10, true), 1, 'hotspot x');
    assert.strictEqual(dv.getUint16(12, true), 2, 'hotspot y');
    assert.strictEqual(dv.getUint16(36, true), 32, 'biBitCount: 32bpp, so alpha survives');
    assert.strictEqual(dv.getInt32(30, true), 8, 'biHeight covers colour + mask');
    // DIB rows run bottom-up, so the picture's top row is the last one here.
    const topRow = 62 + 3 * 4 * 4;
    assert.strictEqual(cur[topRow + 3], 0, 'the transparent corner became opaque');
    assert.strictEqual(cur[topRow + 4 + 3], 255, 'the white pixel lost its alpha');
    assert.strictEqual(cur[topRow + 4 + 0], 255, 'the white pixel is not white');
  });

  check('DestroyIcon frees the slot and the handle stops resolving', () => {
    assert.notStrictEqual(wat.test_call_DestroyIcon(handleA) >>> 0, 0, 'returned FALSE');
    const info = alloc(20);
    for (let i = 0; i < 20; i += 4) wat.guest_write32(info + i, 0xdeadbeef | 0);
    wat.test_call_GetIconInfo(handleA, info);
    assert.strictEqual(wat.guest_read32(info + 12) >>> 0, 0,
      'a destroyed cursor still reports a mask bitmap');
    // ... and the freed slot is handed to the next cursor.
    const again = wat.test_call_CreateIconIndirect(
      iconInfo({ xHot: 2, yHot: 2, mask: crossMask() })) >>> 0;
    assert.strictEqual(again, handleA, 'the freed slot was not reused');
  });

  console.log(`\n${passed} checks passed`);
})().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});

#!/usr/bin/env node

'use strict';

const assert = require('assert');
const apiTable = require('../src/api_table.json');
const { createHostImports } = require('../lib/host-imports');
const { bootRenderHarness } = require('./render-helper');

const memory = new ArrayBuffer(64 * 1024);
const dv = new DataView(memory);
const resized = [];
const invalidated = [];
const renderer = {
  canvas: { width: 480, height: 340 },
  _nextZ: 100,
  scheduleRepaint() {},
  invalidate(hwnd) { invalidated.push(hwnd >>> 0); },
  _computeClientRect() {},
  windows: {
    101: { hwnd: 101, visible: true, isChild: false, x: 5, y: 5, w: 120, h: 90,
      style: 0x00c00000, wasm: { exports: { post_resize_messages: hwnd => resized.push(hwnd) } } },
    102: { hwnd: 102, visible: true, isChild: false, _minimized: true,
      x: 10, y: 300, w: 160, h: 28, style: 0x00c00000 },
    103: { hwnd: 103, visible: true, isChild: false, isPopup: true,
      x: 40, y: 40, w: 100, h: 80, style: 0x80c00000 },
    104: { hwnd: 104, visible: true, isChild: false, x: 210, y: 80, w: 150, h: 110,
      style: 0x00c00000, wasm: { exports: { post_resize_messages: hwnd => resized.push(hwnd) } } },
    105: { hwnd: 105, visible: false, isChild: false, x: 20, y: 20, w: 90, h: 70,
      style: 0x00c00000 },
    201: { hwnd: 201, visible: true, isChild: true, parentHwnd: 200,
      x: 5, y: 5, w: 50, h: 40, style: 0x40000000 },
    202: { hwnd: 202, visible: true, isChild: true, parentHwnd: 200,
      x: 80, y: 20, w: 60, h: 45, style: 0x40000000 },
  },
};

const { host } = createHostImports({
  getMemory: () => memory,
  renderer,
  exports: {},
});

for (const [index, hwnd] of [101, 102, 103, 104, 105].entries()) {
  dv.setUint32(0x40 + index * 4, hwnd, true);
}
dv.setInt32(0x20, 0, true);
dv.setInt32(0x24, 0, true);
dv.setInt32(0x28, 480, true);
dv.setInt32(0x2c, 340, true);

assert.strictEqual(host.arrange_windows(3, 0x10000, 0x20, 5, 0x40), 2,
  'Shell32 ArrangeWindows counts only visible, non-iconic, non-popup windows');
assert.deepStrictEqual(
  [101, 104].map(hwnd => {
    const win = renderer.windows[hwnd];
    return [win.x, win.y, win.w, win.h];
  }),
  [[0, 0, 240, 340], [240, 0, 240, 340]],
  'eligible windows tile vertically across the requested rectangle');
assert.deepStrictEqual(
  [renderer.windows[102]._minimized, renderer.windows[102].x, renderer.windows[103].x,
    renderer.windows[105].x],
  [true, 10, 40, 20],
  'minimized, popup, and hidden windows retain their state and geometry');
assert.deepStrictEqual(resized, [101, 104], 'only arranged windows receive resize messages');
assert.deepStrictEqual(invalidated, [101, 104], 'only arranged windows are invalidated');

assert.strictEqual(host.arrange_windows(3, 200, 0x20, 0, 0), 2,
  'NULL lpKids enumerates eligible children of the requested parent');
assert.deepStrictEqual(
  [201, 202].map(hwnd => {
    const win = renderer.windows[hwnd];
    return [win.x, win.y, win.w, win.h];
  }),
  [[0, 0, 240, 340], [240, 0, 240, 340]],
  'parent-child enumeration uses the same tiling operation');

const extraWat = String.raw`
  (func (export "test_arrange_windows")
      (param $parent i32) (param $reserved i32) (param $rect i32)
      (param $count i32) (param $kids i32) (param $stack i32) (result i64)
    (global.set $esp (local.get $stack))
    (call $handle_ArrangeWindows
      (local.get $parent) (local.get $reserved) (local.get $rect)
      (local.get $count) (local.get $kids) (i32.const 0))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))
`;

(async () => {
  assert.strictEqual(apiTable.find(api => api.name === 'ArrangeWindows').nargs, 5,
    'the undocumented Shell32 ordinal keeps its five-argument Win98 ABI');
  const calls = [];
  const { exports: wat } = await bootRenderHarness({
    extraWat,
    fonts: 'none',
    extraHostOverrides: {
      arrange_windows: (...args) => { calls.push(args); return 2; },
    },
  });
  const imageBase = wat.get_image_base() >>> 0;
  const guestBase = wat.get_guest_base() >>> 0;
  const rect = imageBase + 0x1000;
  const kids = imageBase + 0x2000;
  const stack = 0x074ff000;
  const packed = wat.test_arrange_windows(0x10000, 0x12345678, rect, 3, kids, stack);
  assert.strictEqual(Number(packed & 0xffffffffn), 2,
    'ArrangeWindows returns the renderer arranged-window count');
  assert.strictEqual(Number(packed >> 32n) >>> 0, stack + 24,
    'ArrangeWindows cleans five stdcall arguments plus the return address');
  assert.deepStrictEqual(calls.shift(), [3, 0x10000, guestBase + 0x1000, 3, guestBase + 0x2000],
    'handler forwards parent and translates nullable RECT/HWND-array pointers');

  wat.test_arrange_windows(200, 0, 0, 0, 0, stack);
  assert.deepStrictEqual(calls.shift(), [3, 200, 0, 0, 0],
    'NULL pointers stay NULL so the host enumerates the parent children');
  console.log('PASS Win98 Shell32 ArrangeWindows tiles only eligible windows');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

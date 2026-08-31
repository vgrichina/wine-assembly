#!/usr/bin/env node
'use strict';

// Browser pointer handlers run outside the guest's GetMessage/DispatchMessage
// call stack. A dialog BUTTON must therefore be queued into that pump. If the
// renderer invokes it synchronously and BN_CLICKED opens a nested DoModal, the
// browser event cannot return to deliver input to the new dialog.

const assert = require('assert');
const { installInputHandlers } = require('../lib/renderer-input');

class FakeRenderer {}
installInputHandlers(FakeRenderer);

let synchronousRoutes = 0;
const wasm = {
  exports: {
    ctrl_get_class: hwnd => hwnd === 0x40002 ? 1 : 0,
    wnd_get_proc_export: hwnd => hwnd === 0x40002 ? 0xFFFF0001 : 0,
    wnd_get_style_export: () => 0,
    dialog_route_mouse_screen: () => { synchronousRoutes++; return 1; },
  },
};
const dialog = {
  hwnd: 0x40001,
  visible: true,
  isDialog: true,
  x: 20,
  y: 20,
  w: 300,
  h: 180,
  wasm,
};
const renderer = new FakeRenderer();
renderer.wasm = wasm;
renderer.windows = { 0x40001: dialog };
renderer.inputQueue = [];
renderer._mouseX = 132;
renderer._mouseY = 79;
renderer._mouseButtonsMask = 1;
renderer._pointerInputWasm = wasm;
renderer._wakeMessageWait = () => {};
renderer._hitTestDeepChild = () => ({ hwnd: 0x40002, sx: 100, sy: 60 });
renderer._mapExclusiveInputPoint = (x, y) => ({ x, y, outside: false });
renderer._applyCursorClip = (x, y) => ({ x, y });
renderer._mouseMaskForButton = () => 1;
renderer._inputWasmAtPoint = () => wasm;
renderer._modalDialogHwnd = () => 0x40001;
renderer._handleNativeScrollbarUp = () => false;
renderer._signalDirectInputDevice = () => {};
renderer._setMousePoint = (x, y) => {
  renderer._mouseX = x;
  renderer._mouseY = y;
};
renderer._windowRectScreen = win => ({ x: win.x, y: win.y, w: win.w, h: win.h });
renderer._computeClientRect = win => {
  win.clientRect = { x: win.x, y: win.y, w: win.w, h: win.h };
};
renderer.scheduleRepaint = () => {};
renderer.repaint = () => {};

assert.strictEqual(renderer._queueNativeDialogChildMouseDown(
  dialog, 132, 79, 0x0201, 1), true,
'WAT dialog BUTTON down should enter the guest queue');
assert.strictEqual(synchronousRoutes, 0,
  'dialog BUTTON down must not synchronously enter its parent wndproc');
assert.deepStrictEqual(renderer.inputQueue[0], {
  type: 'mouse',
  hwnd: 0x40002,
  msg: 0x0201,
  wParam: 1,
  lParam: (19 << 16) | 32,
  mouseX: 132,
  mouseY: 79,
  mouseButtons: 1,
});

renderer.handleMouseUp(132, 79, 0);
assert.strictEqual(synchronousRoutes, 0,
  'dialog BUTTON up must not synchronously send BN_CLICKED');
assert.deepStrictEqual(renderer.inputQueue[1], {
  type: 'mouse',
  hwnd: 0x40002,
  msg: 0x0202,
  wParam: 0,
  lParam: (19 << 16) | 32,
  mouseX: 132,
  mouseY: 79,
  mouseButtons: 0,
});

console.log('PASS  browser dialog BUTTON clicks stay on the guest message pump');

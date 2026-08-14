#!/usr/bin/env node
'use strict';

// Dialog-button releases must re-enter a native modal loop through
// GetMessage/DispatchMessage. A synchronous out-of-band UP can let the button
// set its completion state while leaving the loop blocked inside GetMessage.

const assert = require('assert');
const { installInputHandlers } = require('../lib/renderer-input');

class FakeRenderer {}
installInputHandlers(FakeRenderer);

let routedSynchronously = 0;
const wasm = {
  exports: {
    get_capture_hwnd: () => 0x10002,
    wnd_top_level: () => 0x10001,
    wnd_get_owner: () => 0x90001,
    wnd_mouse_msg_origin_x: () => 40,
    wnd_mouse_msg_origin_y: () => 50,
    ctrl_get_class: () => 1,
    send_message: () => { routedSynchronously++; return 0; },
    dialog_route_mouse: () => { routedSynchronously++; return 1; },
  },
};

const renderer = new FakeRenderer();
renderer.wasm = wasm;
renderer.windows = {
  0x10001: {
    hwnd: 0x10001,
    visible: true,
    isChild: false,
    x: 20,
    y: 20,
    w: 300,
    h: 220,
    wasm,
  },
};
renderer.inputQueue = [];
renderer._dialogBtnDrag = {
  parent: 0x10001,
  downLParam: 0,
  clientX: 20,
  clientY: 20,
  wasm,
};
renderer._mapExclusiveInputPoint = (x, y) => ({ x, y, outside: false });
renderer._applyCursorClip = (x, y) => ({ x, y });
renderer._mouseMaskForButton = () => 1;
renderer._inputWasmAtPoint = () => wasm;
renderer._modalDialogHwnd = () => 0;
renderer._handleNativeScrollbarUp = () => false;
renderer._signalDirectInputDevice = () => {};
renderer._setMousePoint = (x, y) => { renderer._mouseX = x; renderer._mouseY = y; };
renderer._wakeMessageWait = () => {};
renderer.scheduleRepaint = () => {};
renderer.repaint = () => {};

renderer.handleMouseUp(55, 70, 1);

assert.strictEqual(routedSynchronously, 0,
  'captured dialog button must not receive a synchronous out-of-band mouse-up');
assert.strictEqual(renderer.inputQueue.length, 1, 'mouse-up should be queued');
assert.deepStrictEqual(renderer.inputQueue[0], {
  type: 'mouse',
  hwnd: 0x10002,
  msg: 0x0202,
  wParam: 0,
  lParam: (20 << 16) | 15,
  mouseX: 55,
  mouseY: 70,
  mouseButtons: 0,
});

console.log('PASS  captured dialog mouse-up is queued for modal-loop dispatch');

let watRoutedSynchronously = 0;
const watModalWasm = {
  exports: {
    get_capture_hwnd: () => 0x20002,
    dialog_route_mouse: () => { watRoutedSynchronously++; return 1; },
  },
};
const watRenderer = new FakeRenderer();
watRenderer.wasm = watModalWasm;
watRenderer.windows = {
  0x20001: {
    hwnd: 0x20001,
    visible: true,
    isChild: false,
    x: 20,
    y: 20,
    w: 300,
    h: 220,
    wasm: watModalWasm,
  },
};
watRenderer.inputQueue = [];
watRenderer._dialogBtnDrag = {
  parent: 0x20001,
  downLParam: 0,
  clientX: 20,
  clientY: 20,
  wasm: watModalWasm,
};
watRenderer._mapExclusiveInputPoint = (x, y) => ({ x, y, outside: false });
watRenderer._applyCursorClip = (x, y) => ({ x, y });
watRenderer._mouseMaskForButton = () => 1;
watRenderer._inputWasmAtPoint = () => watModalWasm;
watRenderer._modalDialogHwnd = () => 0x20001;
watRenderer._handleNativeScrollbarUp = () => false;
watRenderer._signalDirectInputDevice = () => {};
watRenderer._setMousePoint = (x, y) => { watRenderer._mouseX = x; watRenderer._mouseY = y; };
watRenderer._wakeMessageWait = () => {};
watRenderer.scheduleRepaint = () => {};
watRenderer.repaint = () => {};

watRenderer.handleMouseUp(55, 70, 1);

assert.strictEqual(watRoutedSynchronously, 1,
  'WAT-owned modal dialog should retain synchronous mouse-up routing');
assert.strictEqual(watRenderer.inputQueue.length, 0,
  'WAT-owned modal dialog should not queue its mouse-up');

console.log('PASS  WAT-owned modal dialog mouse-up stays synchronous');

function capturedControlCase(ctrlClass, owner) {
  const sent = [];
  const captureWasm = {
    exports: {
      get_capture_hwnd: () => 0x30002,
      wnd_top_level: () => 0x30001,
      wnd_get_owner: () => owner,
      wnd_mouse_msg_origin_x: () => 40,
      wnd_mouse_msg_origin_y: () => 50,
      ctrl_get_class: () => ctrlClass,
      dialog_route_mouse: () => 0,
      send_message: (hwnd, msg, wParam, lParam) => {
        sent.push({ hwnd, msg, wParam, lParam: lParam >>> 0 });
        return 0;
      },
    },
  };
  const r = new FakeRenderer();
  r.wasm = captureWasm;
  r.windows = {
    0x30001: {
      hwnd: 0x30001, visible: true, isChild: false,
      x: 20, y: 20, w: 300, h: 220, wasm: captureWasm,
    },
  };
  r.inputQueue = [];
  r._dialogBtnDrag = {
    parent: 0x30001, downLParam: 0,
    clientX: 20, clientY: 20, wasm: captureWasm,
  };
  r._mapExclusiveInputPoint = (x, y) => ({ x, y, outside: false });
  r._applyCursorClip = (x, y) => ({ x, y });
  r._mouseMaskForButton = () => 1;
  r._inputWasmAtPoint = () => captureWasm;
  r._modalDialogHwnd = () => 0;
  r._handleNativeScrollbarMove = () => false;
  r._handleNativeScrollbarUp = () => false;
  r._signalDirectInputDevice = () => {};
  r._setMousePoint = (x, y) => { r._mouseX = x; r._mouseY = y; };
  r._wakeMessageWait = () => {};
  r.scheduleRepaint = () => {};
  r.repaint = () => {};
  r._mouseButtonsMask = 1;
  r.handleMouseMove(55, 70);
  r.handleMouseUp(55, 70, 1);
  return { sent, queued: r.inputQueue };
}

const trackbar = capturedControlCase(19, 0x90001);
assert.deepStrictEqual(trackbar.sent, [
  { hwnd: 0x30002, msg: 0x0200, wParam: 1, lParam: (20 << 16) | 15 },
  { hwnd: 0x30002, msg: 0x0202, wParam: 0, lParam: (20 << 16) | 15 },
], 'captured WAT trackbar move and release should dispatch synchronously');
assert.strictEqual(trackbar.queued.length, 0);

const ownerlessButton = capturedControlCase(1, 0);
assert.strictEqual(ownerlessButton.sent.length, 2,
  'ownerless main-dialog WAT button should dispatch synchronously');
assert.strictEqual(ownerlessButton.queued.length, 0);

console.log('PASS  WAT capture dispatches directly outside owned guest modal buttons');

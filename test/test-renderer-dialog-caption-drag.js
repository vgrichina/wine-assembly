#!/usr/bin/env node
// Owned resource dialogs should be movable from their non-client caption.
// Winamp's About window is a CreateDialogParamA dialog; child routing must
// not swallow caption drags before the renderer can commit the move.

const assert = require('assert');
const { Win98Renderer } = require('../lib/renderer');

const canvas = {
  getContext() {
    return {
      save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
      clearRect() {}, fillRect() {}, strokeRect() {}, fillText() {},
      measureText() { return { width: 0 }; },
      drawImage() {}, putImageData() {}, getImageData() { return { data: new Uint8ClampedArray(4) }; },
    };
  },
};

function makeRenderer(wasm) {
  const r = new Win98Renderer(canvas);
  r.wasm = wasm;
  return r;
}

{
  const moves = [];
  const wasm = {
    exports: {
      hittest_sync(hwnd, x, y) {
        assert.strictEqual(hwnd, 100);
        return y < 33 ? 2 : 1; // HTCAPTION above the dialog client origin.
      },
      host_move_commit(hwnd, x, y) {
        moves.push({ hwnd, x, y });
      },
    },
  };

  const r = makeRenderer(wasm);
  r.windows[1] = {
    hwnd: 1,
    visible: true,
    isChild: false,
    x: 0,
    y: 0,
    w: 200,
    h: 100,
    style: 0x00c80000,
    zOrder: 1,
    wasm,
  };
  r.windows[100] = {
    hwnd: 100,
    visible: true,
    isChild: false,
    isDialog: true,
    ownerHwnd: 1,
    x: 10,
    y: 10,
    w: 300,
    h: 200,
    clientRect: { x: 13, y: 33, w: 294, h: 163 },
    style: 0x80c808c0,
    zOrder: 2,
    wasm,
  };

  r.handleMouseDown(50, 20, 1);
  assert(r._draggingWin, 'caption mousedown should start a dialog window drag');

  r.handleMouseMove(90, 70);
  r.handleMouseUp(90, 70, 1);

  assert.strictEqual(r.windows[100].x, 50);
  assert.strictEqual(r.windows[100].y, 60);
  assert.deepStrictEqual(moves, [{ hwnd: 100, x: 50, y: 60 }]);
  assert.strictEqual(r._draggingWin, null, 'mouseup should complete the active drag');
  assert(!r.inputQueue.some(e => e.type === 'mouse'), 'caption drag should not leak a client mouse event');
}

{
  const calls = [];
  const r = makeRenderer(null);
  const wasm = {
    exports: {
      send_message(hwnd, msg, wParam, lParam) {
        calls.push({ fn: 'send_message', hwnd, msg, wParam, lParam });
      },
      wnd_destroy_tree(hwnd) {
        calls.push({ fn: 'wnd_destroy_tree', hwnd });
      },
      destroy_dialog_frame(hwnd) {
        calls.push({ fn: 'destroy_dialog_frame', hwnd });
        for (const k of Object.keys(r.windows)) {
          if (r.windows[k] && r.windows[k].parentHwnd === hwnd) delete r.windows[k];
        }
        delete r.windows[hwnd];
      },
    },
  };
  r.wasm = wasm;
  r.windows[200] = {
    hwnd: 200,
    visible: true,
    isChild: false,
    isDialog: true,
    ownerHwnd: 1,
    x: 20,
    y: 20,
    w: 320,
    h: 180,
    style: 0x80c808c0,
    zOrder: 2,
    wasm,
  };
  r.windows[201] = {
    hwnd: 201,
    visible: true,
    isChild: true,
    parentHwnd: 200,
    x: 8,
    y: 34,
    w: 300,
    h: 130,
    style: 0x50000000,
    zOrder: 3,
    wasm,
  };

  r._closeWatDialogFrame(200, wasm);

  assert.deepStrictEqual(calls, [
    { fn: 'send_message', hwnd: 200, msg: 0x0010, wParam: 0, lParam: 0 },
    { fn: 'wnd_destroy_tree', hwnd: 200 },
    { fn: 'destroy_dialog_frame', hwnd: 200 },
  ]);
  assert.strictEqual(r.windows[200], undefined, 'fallback close should remove the dialog frame');
  assert.strictEqual(r.windows[201], undefined, 'fallback close should remove owned child windows');
}

{
  const r = makeRenderer(null);
  const wasm = {
    exports: {
      wnd_window_screen_x(hwnd) {
        return hwnd === 300 ? 340 : 0;
      },
      wnd_window_screen_y(hwnd) {
        return hwnd === 300 ? 140 : 100;
      },
      wnd_screen_w(hwnd) {
        return hwnd === 300 ? 451 : 275;
      },
      wnd_screen_h(hwnd) {
        return hwnd === 300 ? 362 : 116;
      },
      wnd_client_screen_x(hwnd) {
        return hwnd === 300 ? 343 : 3;
      },
      wnd_client_screen_y(hwnd) {
        return hwnd === 300 ? 163 : 123;
      },
      get_client_rect_l() { return 0; },
      get_client_rect_t() { return 0; },
      get_client_rect_r(hwnd) { return hwnd === 300 ? 445 : 269; },
      get_client_rect_b(hwnd) { return hwnd === 300 ? 339 : 89; },
    },
  };
  r.wasm = wasm;
  r.windows[1] = {
    hwnd: 1,
    visible: true,
    isChild: false,
    x: 0,
    y: 100,
    w: 275,
    h: 116,
    style: 0x00c80000,
    zOrder: 1,
    wasm,
  };
  r.windows[300] = {
    hwnd: 300,
    visible: true,
    isChild: true,
    isDialog: true,
    parentHwnd: 200,
    x: 7,
    y: 33,
    w: 451,
    h: 362,
    clientRect: { x: 343, y: 163, w: 445, h: 339 },
    style: 0x50000000,
    zOrder: 4,
    wasm,
  };

  r.handleMouseUp(66, 129, 1);

  const up = r.inputQueue.find(e => e.type === 'mouse' && e.msg === 0x0202);
  assert(up, 'mouseup outside a moved dialog child should reach the underlying app window');
  assert.strictEqual(up.hwnd, 1);
}

console.log('PASS  renderer owned dialog captions close, drag, and preserve app mouse-up');

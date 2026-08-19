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
      nc_sysbutton_down(hwnd) {
        assert.strictEqual(hwnd, 200);
        return 20;
      },
      nc_sysbutton_up() {
        throw new Error('top-level dialogs must use the synchronous close path');
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
    ownerHwnd: 0,
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

  r.handleMouseDown(327, 30, 1);
  r.handleMouseUp(327, 30, 1);

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

{
  const calls = [];
  const mainWasm = {
    exports: {
      dialog_route_mouse_screen() {
        calls.push('wrong-app');
        return 0;
      },
    },
  };
  const dialogWasm = {
    exports: {
      dialog_route_mouse_screen(hwnd, msg) {
        calls.push({ hwnd, msg });
        return 1;
      },
      get_capture_hwnd() {
        return 401;
      },
      wnd_top_level() {
        return 400;
      },
      wnd_mouse_msg_origin_x() {
        return 100;
      },
      wnd_mouse_msg_origin_y() {
        return 130;
      },
    },
  };
  const r = makeRenderer(mainWasm);
  r.windows[400] = {
    hwnd: 400,
    visible: true,
    isChild: false,
    isDialog: true,
    ownerHwnd: 0,
    x: 10,
    y: 10,
    w: 280,
    h: 300,
    clientRect: { x: 13, y: 33, w: 274, h: 264 },
    style: 0x80c808c0,
    zOrder: 5,
    wasm: dialogWasm,
  };

  r.handleMouseDown(120, 150, 0);
  r.wasm = mainWasm; // Repaint may select another app while the pointer is held.
  r.handleMouseMove(140, 180);
  r.handleMouseUp(120, 150, 0);

  assert.deepStrictEqual(calls, [
    { hwnd: 400, msg: 0x0201 },
  ]);
  const dialogMove = r.inputQueue.find(event => event && event.msg === 0x0200);
  assert(dialogMove, 'captured dialog control should receive moves after another app repaints');
  assert.strictEqual(dialogMove.hwnd, 401);
  assert.strictEqual(dialogMove.lParam, (50 << 16) | 40);
  const dialogUp = r.inputQueue.find(event => event && event.msg === 0x0202);
  assert(dialogUp, 'captured native dialog control should receive queued mouse-up');
  assert.strictEqual(dialogUp.hwnd, 401);
  assert.strictEqual(dialogUp.lParam, (20 << 16) | 20);
}

{
  const wrongCalls = [];
  const firstWasm = {
    exports: {
      wnd_child_from_point_deep() {
        wrongCalls.push('wrong-app-hit-test');
        return 0;
      },
      get_capture_hwnd() {
        wrongCalls.push('wrong-app-capture');
        return 0;
      },
    },
  };
  const secondWasm = {
    exports: {
      wnd_child_from_point_deep(hwnd) {
        assert.strictEqual(hwnd, 500);
        return 501;
      },
      wnd_window_screen_x(hwnd) {
        return hwnd === 501 ? 40 : 20;
      },
      wnd_window_screen_y(hwnd) {
        return hwnd === 501 ? 60 : 20;
      },
      wnd_mouse_msg_origin_x(hwnd) {
        return hwnd === 501 ? 40 : 20;
      },
      wnd_mouse_msg_origin_y(hwnd) {
        return hwnd === 501 ? 60 : 20;
      },
      wnd_top_level(hwnd) {
        return hwnd === 501 ? 500 : hwnd;
      },
      get_capture_hwnd() {
        return 501;
      },
      get_focus_hwnd() {
        return 0;
      },
      set_focus() {},
    },
  };
  const r = makeRenderer(firstWasm);
  r.windows[500] = {
    hwnd: 500,
    visible: true,
    isChild: false,
    x: 20,
    y: 20,
    w: 280,
    h: 220,
    clientRect: { x: 20, y: 20, w: 280, h: 220 },
    style: 0,
    zOrder: 2,
    wasm: secondWasm,
  };

  r.handleMouseDown(50, 70, 0);
  assert.strictEqual(r.wasm, secondWasm, 'native child interaction should activate its owning app context');
  r.wasm = firstWasm; // A repaint may leave another app as the drawing context.
  r.handleMouseMove(80, 100);

  assert.deepStrictEqual(wrongCalls, [], 'native child routing must not query the previously active app');
  const events = r.inputQueue.filter(event => event && event.type === 'mouse');
  assert.deepStrictEqual(events.map(event => [event.hwnd, event.msg, event.lParam]), [
    [501, 0x0201, (10 << 16) | 10],
    [501, 0x0200, (40 << 16) | 40],
  ]);
}

console.log('PASS  renderer dialogs and native child input route to their owning app');

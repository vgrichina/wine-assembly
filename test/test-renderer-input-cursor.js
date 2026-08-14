#!/usr/bin/env node
// Fast regression for resize cursors leaking into an app's client area.

const { installInputHandlers } = require('../lib/renderer-input');

class FakeRenderer {}
installInputHandlers(FakeRenderer);

function renderer(cursor, hit) {
  const wasm = {
    exports: {
      hittest_sync: () => hit,
      post_message_q: () => {},
      get_capture_hwnd: () => 0,
    },
  };
  const r = new FakeRenderer();
  r.canvas = { style: { cursor } };
  r.wasm = wasm;
  r.windows = {
    65537: {
      hwnd: 65537, visible: true, isChild: false,
      x: 20, y: 20, w: 300, h: 300, wasm,
      clientRect: { x: 23, y: 61, w: 294, h: 256 },
    },
  };
  r._mapExclusiveInputPoint = (x, y) => ({ x, y, outside: false });
  r._applyCursorClip = (x, y) => ({ x, y });
  r._setMousePoint = () => {};
  r._signalDirectInputDevice = () => {};
  r._handleNativeScrollbarMove = () => false;
  r._computeClientRect = () => {};
  r._mouseMsgOriginScreen = () => ({ x: 23, y: 61 });
  r._dispatchMouseEvent = () => {};
  return r;
}

const checks = [];
function check(name, actual, expected) {
  const pass = actual === expected;
  checks.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}: ${actual}`);
}

const stale = renderer('ew-resize', 1);
stale.handleMouseMove(100, 100);
check('client entry clears stale resize cursor', stale.canvas.style.cursor, 'default');

const custom = renderer('crosshair', 1);
custom.handleMouseMove(100, 100);
check('app-selected client cursor is preserved', custom.canvas.style.cursor, 'crosshair');

const edge = renderer('nwse-resize', 17);
edge.handleMouseMove(319, 319);
check('cursor remains while pointer is on resize edge', edge.canvas.style.cursor, 'nwse-resize');

const posted = [];
const dispatched = [];
const childWasm = {
  exports: {
    get_capture_hwnd: () => 0,
    wnd_child_from_point_deep: () => 65539,
    wnd_window_screen_x: () => 80,
    wnd_window_screen_y: () => 90,
    hittest_sync: () => 1,
    post_message_q: (...args) => posted.push(args),
  },
};
const child = new FakeRenderer();
child.canvas = { style: { cursor: 'crosshair' } };
child.wasm = childWasm;
child.windows = {
  65537: {
    hwnd: 65537, visible: true, isChild: false,
    x: 20, y: 20, w: 300, h: 300, wasm: childWasm,
    clientRect: { x: 23, y: 61, w: 294, h: 256 },
  },
};
child._mapExclusiveInputPoint = (x, y) => ({ x, y, outside: false });
child._applyCursorClip = (x, y) => ({ x, y });
child._setMousePoint = () => {};
child._signalDirectInputDevice = () => {};
child._handleNativeScrollbarMove = () => false;
child._computeClientRect = () => {};
child._mouseMsgOriginScreen = () => ({ x: 23, y: 61 });
child._dispatchMouseEvent = (_win, evt) => dispatched.push(evt);
child.handleMouseMove(150, 200);

check('child hover targets deepest hwnd', dispatched[0] && dispatched[0].hwnd, 65539);
check('child hover uses child-local coordinates', dispatched[0] && dispatched[0].lParam,
  (110 << 16) | 70);
check('child hover sends WM_SETCURSOR to child', posted[0] && posted[0][0], 65539);

const passed = checks.filter(Boolean).length;
console.log(`\n${passed}/${checks.length} checks passed`);
process.exit(passed === checks.length ? 0 : 1);

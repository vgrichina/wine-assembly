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

const passed = checks.filter(Boolean).length;
console.log(`\n${passed}/${checks.length} checks passed`);
process.exit(passed === checks.length ? 0 : 1);

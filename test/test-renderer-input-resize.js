#!/usr/bin/env node
// Fast regression for classic outline resize and one-shot resize commit.

const { installInputHandlers } = require('../lib/renderer-input');

class FakeRenderer {}
installInputHandlers(FakeRenderer);

let committed = null;
const wasm = {
  exports: {
    host_resize_commit: (...args) => { committed = args; },
    hittest_sync: () => 17,
  },
};
const win = {
  hwnd: 65537, x: 20, y: 20, w: 275, h: 400, wasm,
  _backCanvas: { width: 275, height: 400 },
  _backCtx: {}, _backW: 275, _backH: 400,
};
const r = new FakeRenderer();
r.canvas = { style: { cursor: 'nwse-resize' } };
r.wasm = wasm;
r.windows = { 65537: win };
r._resizingWin = {
  hwnd: win.hwnd, win, wasm, hit: 17,
  startX: 294, startY: 419,
  origX: win.x, origY: win.y, origW: win.w, origH: win.h,
};
r._mapExclusiveInputPoint = (x, y) => ({ x, y, outside: false });
r._applyCursorClip = (x, y) => ({ x, y });
r._setMousePoint = () => {};
r._signalDirectInputDevice = () => {};
r._mouseMaskForButton = () => 1;
r._inputWasmAtPoint = () => wasm;
r.queuePaint = () => {};
r.repaint = () => {};

const checks = [];
function check(name, pass, detail = '') {
  checks.push(!!pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
}

r.handleMouseMove(360, 455);
check('window geometry remains stable during drag',
  win.x === 20 && win.y === 20 && win.w === 275 && win.h === 400,
  `${win.x},${win.y} ${win.w}x${win.h}`);
check('old backing canvas remains attached during drag', !!win._backCanvas);
check('resize outline follows proposed rectangle',
  r._resizeOutline && r._resizeOutline.x === 20 && r._resizeOutline.y === 20 &&
  r._resizeOutline.w === 341 && r._resizeOutline.h === 436,
  JSON.stringify(r._resizeOutline));

r.handleMouseUp(360, 455, 1);
check('geometry changes once on release',
  win.x === 20 && win.y === 20 && win.w === 341 && win.h === 436,
  `${win.x},${win.y} ${win.w}x${win.h}`);
check('guest receives one final resize commit',
  committed && committed.join(',') === '65537,20,20,341,436',
  JSON.stringify(committed));
check('outline is removed after commit', r._resizeOutline === null);
check('old-size backing canvas is released only at commit', win._backCanvas === null);

const passed = checks.filter(Boolean).length;
console.log(`\n${passed}/${checks.length} checks passed`);
process.exit(passed === checks.length ? 0 : 1);

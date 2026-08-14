#!/usr/bin/env node

const assert = require('assert');
const { createCanvas } = require('../lib/canvas-compat');
const { Win98Renderer } = require('../lib/renderer');

const renderer = new Win98Renderer(createCanvas(320, 80));
const parent = {
  hwnd: 0x10001,
  className: 'RegEdit_RegEdit',
  x: 0,
  y: 0,
  w: 300,
  h: 80,
  isChild: false,
  visible: true,
};
const status = {
  hwnd: 0x10004,
  parentHwnd: parent.hwnd,
  className: 'msctls_statusbar32',
  x: 0,
  y: 63,
  w: 300,
  h: 17,
  isChild: true,
  visible: true,
};
renderer.windows[parent.hwnd] = parent;
renderer.windows[status.hwnd] = status;

assert.strictEqual(renderer._usesOwnWindowSurface(status), false,
  'a child control drawing into its top-level WAT surface must not get a guessed child canvas');
renderer._compositeChildSurfaces(parent);
assert.strictEqual(status._backCanvas, undefined,
  'compositing must not create a fallback surface that covers canonical parent pixels');

const explicitSurface = createCanvas(status.w, status.h);
assert.strictEqual(renderer.attachWindowSurface(status.hwnd, explicitSurface), true);
assert.strictEqual(renderer._usesOwnWindowSurface(status), true,
  'an explicitly attached canonical child surface remains independently composited');
assert.strictEqual(renderer.detachWindowSurface(status.hwnd, explicitSurface), true);
assert.strictEqual(renderer._usesOwnWindowSurface(status), false);

console.log('PASS  child controls use the top-level canonical surface unless explicitly attached');

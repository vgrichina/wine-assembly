#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createCanvas } = require('../lib/canvas-compat');
const { Win98Renderer } = require('../lib/renderer');

const renderer = new Win98Renderer(createCanvas(640, 480));
let cursorCount = -1;
let currentCursor = 0x67F00;
const guestExports = {
  get_cursor_display_count: () => cursorCount,
  get_cursor: () => currentCursor,
  clip_cursor_active: () => 0,
};
const wasm = { exports: guestExports };
renderer.wasm = wasm;
renderer.windows[1] = {
  hwnd: 1, visible: true, isChild: false, x: 0, y: 0, w: 640, h: 480,
  wasm, zOrder: 1,
};

assert.strictEqual(renderer.wantsHiddenMouse(320, 240), true,
  'a negative ShowCursor display count should hide the browser cursor');
assert.strictEqual(renderer.wantsRelativeMouse(320, 240), false,
  'a hidden cursor alone must not capture an ordinary desktop window');

renderer._exclusiveTransform = {
  hwnd: 1,
  srcX: 0, srcY: 0, srcW: 640, srcH: 480,
  dstX: 0, dstY: 0, dstW: 640, dstH: 480,
};
assert.strictEqual(renderer.wantsRelativeMouse(320, 240), true,
  'an exclusive software-cursor guest should opt into relative capture without requiring exclusive DirectInput');

cursorCount = 0;
assert.strictEqual(renderer.wantsHiddenMouse(320, 240), false,
  'a nonnegative ShowCursor count should restore the browser cursor');
assert.strictEqual(renderer.wantsRelativeMouse(320, 240), false,
  'a visible unclipped guest should retain absolute browser input');

currentCursor = 0;
assert.strictEqual(renderer.wantsHiddenMouse(320, 240), true,
  'SetCursor(NULL) should hide the browser cursor independently of ShowCursor');
assert.strictEqual(renderer.wantsRelativeMouse(320, 240), false,
  'SetCursor(NULL) alone should not force an absolute-pointer game into relative capture');

const browserSource = fs.readFileSync(path.join(__dirname, '..', 'lib/browser-input.js'), 'utf8');
const pageSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
assert(browserSource.includes("classList.toggle('guest-cursor-hidden', hidden)"),
  'the browser input bridge should mirror guest cursor visibility onto the canvas');
assert(browserSource.includes('mouseButtonPoint(e, pointerLocked())'),
  'a locked button-down should use the moving guest cursor rather than frozen client coordinates');
assert(pageSource.includes('canvas.guest-cursor-hidden { cursor: none !important; }'),
  'guest cursor hiding must outrank inline SetCursor styles');

console.log('PASS  hidden software cursors drive browser visibility and relative capture');

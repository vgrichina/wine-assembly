#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createCanvas } = require('../lib/canvas-compat');
const { Win98Renderer } = require('../lib/renderer');

const renderer = new Win98Renderer(createCanvas(1280, 960));
const guestExports = {
  clip_cursor_active: () => 1,
  clip_cursor_left: () => 100,
  clip_cursor_top: () => 50,
  clip_cursor_right: () => 740,
  clip_cursor_bottom: () => 530,
  wnd_mouse_msg_origin_x: () => 100,
  wnd_mouse_msg_origin_y: () => 50,
  post_message_q: () => 1,
};
const wasm = { exports: guestExports };
renderer.wasm = wasm;
renderer.windows[7] = {
  hwnd: 7, visible: true, isChild: false, x: 100, y: 50, w: 640, h: 480,
  clientRect: { x: 100, y: 50, w: 640, h: 480 }, zOrder: 1, wasm,
};
renderer._exclusiveTransform = {
  hwnd: 7,
  srcX: 100, srcY: 50, srcW: 640, srcH: 480,
  dstX: 0, dstY: 0, dstW: 1280, dstH: 960,
};

assert.strictEqual(renderer.wantsRelativeMouse(640, 480), true,
  'an exclusive guest ClipCursor region should opt into browser pointer lock');
assert.strictEqual(renderer.wantsRelativeMouse(1279, 959), true,
  'the full clipped image remains eligible at its lower-right edge');

renderer.setMousePosition(420, 290); // guest SetCursorPos recenter
renderer.handleRelativeMouseMove(40, -20); // logical canvas delta at 2x scale
assert.strictEqual(renderer._mouseX, 440,
  'relative X should start at the guest cursor and cross the presentation transform once');
assert.strictEqual(renderer._mouseY, 280,
  'relative Y should start at the guest cursor and cross the presentation transform once');
const move = renderer.inputQueue.find(event => event && event.msg === 0x0200);
assert(move, 'relative motion should enter the ordinary Win32 WM_MOUSEMOVE queue');
assert.strictEqual(move.lParam >>> 0, ((230 << 16) | 340) >>> 0,
  'queued client coordinates should describe the relative guest position');

renderer.setMousePosition(420, 290); // Quake recenters after consuming motion
renderer.handleRelativeMouseMove(40, -20);
assert.deepStrictEqual([renderer._mouseX, renderer._mouseY], [440, 280],
  'a second physical delta must not accumulate the stale absolute DOM cursor');

guestExports.clip_cursor_active = () => 0;
assert.strictEqual(renderer.wantsRelativeMouse(640, 480), false,
  'releasing ClipCursor should leave ordinary desktop pointer semantics intact');

const browserSource = fs.readFileSync(path.join(__dirname, '..', 'lib/browser-input.js'), 'utf8');
assert(browserSource.includes('canvas.requestPointerLock()'),
  'the trusted canvas mousedown path should request browser pointer lock');
assert(browserSource.includes('renderer.handleRelativeMouseMove(delta.x, delta.y)'),
  'locked movementX/Y should enter the renderer relative-mouse path');

console.log('PASS  ClipCursor-gated pointer lock preserves relative guest mouse motion');

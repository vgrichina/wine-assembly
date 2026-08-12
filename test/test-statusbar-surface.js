#!/usr/bin/env node

const assert = require('assert');
const { createCanvas } = require('../lib/canvas-compat');
const { Win98Renderer } = require('../lib/renderer');

const renderer = new Win98Renderer(createCanvas(320, 80));
const status = {
  hwnd: 0x10004,
  className: 'msctls_statusbar32',
  title: 'My Computer\\HKEY_LOCAL_MACHINE',
  x: 0,
  y: 0,
  w: 300,
  h: 17,
  isChild: true,
  visible: false,
};
renderer.windows[status.hwnd] = status;

renderer._ensureStatusBarFallbackSurface(status);
const surface = renderer.getWindowCanvas(status.hwnd);
surface.ctx.fillStyle = '#ff00ff';
surface.ctx.fillRect(0, 0, status.w, status.h);

status.visible = true;
renderer._ensureStatusBarFallbackSurface(status);
const pixel = surface.ctx.getImageData(280, 8, 1, 1).data;
assert.deepStrictEqual(Array.from(pixel.slice(0, 3)), [192, 192, 192],
  'showing a status bar must reconstruct a backing surface overwritten while hidden');

console.log('PASS  status bar reconstructs its copied text surface after hidden memory reuse');

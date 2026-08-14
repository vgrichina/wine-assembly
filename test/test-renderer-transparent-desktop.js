#!/usr/bin/env node
// Browser desktop icons live below the emulator canvas. A canonical software
// GDI desktop surface must not make that canvas opaque in browser desktop mode.

const assert = require('assert');
const { Win98Renderer } = require('../lib/renderer');

function makeRenderer(transparentDesktop) {
  const calls = [];
  const ctx = {
    imageSmoothingEnabled: true,
    clearRect: (...args) => calls.push(['clearRect', ...args]),
    fillRect: (...args) => calls.push(['fillRect', ...args]),
    drawImage: (...args) => calls.push(['drawImage', ...args]),
    save() {}, restore() {},
  };
  const canvas = { width: 640, height: 480, getContext: () => ctx };
  const r = new Win98Renderer(canvas);
  r.transparentDesktop = transparentDesktop;
  r._desktopSurfaceCanvas = { width: 640, height: 480, tag: 'desktop' };
  r._setExclusiveFullscreen = () => {};
  r._paintCaretOverlay = () => {};
  r._menuPaintDropdown = () => {};
  r._paintResizeOutline = () => {};
  r.updateTaskbar = () => {};
  r._profileFinish = () => {};
  return { r, calls };
}

const browser = makeRenderer(true);
browser.r._repaintOnce();
assert(browser.calls.some(call => call[0] === 'clearRect'),
  'browser desktop mode did not clear the canvas background');
assert(!browser.calls.some(call => call[0] === 'drawImage' && call[1] === browser.r._desktopSurfaceCanvas),
  'opaque canonical desktop surface covered the HTML icon layer');

const headless = makeRenderer(false);
headless.r._repaintOnce();
assert(headless.calls.some(call => call[0] === 'drawImage' && call[1] === headless.r._desktopSurfaceCanvas),
  'headless/debug mode stopped compositing the canonical desktop surface');

console.log('PASS  browser desktop stays transparent above its HTML icons');
console.log('PASS  headless/debug renderer still composites canonical desktop pixels');

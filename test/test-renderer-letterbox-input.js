#!/usr/bin/env node

const assert = require('assert');
const { createCanvas } = require('../lib/canvas-compat');
const { Win98Renderer } = require('../lib/renderer');

const renderer = new Win98Renderer(createCanvas(1920, 1080));
renderer._exclusiveTransform = {
  hwnd: 7,
  srcX: 100,
  srcY: 50,
  srcW: 640,
  srcH: 480,
  dstX: 320,
  dstY: 60,
  dstW: 1280,
  dstH: 960,
};

// Logical-stage fallback: each bar follows its corresponding guest edge and
// the other axis continues to track the pointer.
assert.deepStrictEqual(renderer._mapExclusiveInputPoint(0, 540), { x: 100, y: 290 });
assert.deepStrictEqual(renderer._mapExclusiveInputPoint(1919, 540), { x: 739, y: 290 });
assert.deepStrictEqual(renderer._mapExclusiveInputPoint(960, 0), { x: 420, y: 50 });
assert.deepStrictEqual(renderer._mapExclusiveInputPoint(960, 1079), { x: 420, y: 529 });
assert.deepStrictEqual(renderer._mapExclusiveInputPoint(-200, 1300), { x: 100, y: 529 });

// DPR1.5 sharp/GPU presentation fills more of the screen than the integer
// staging rectangle. Input must follow the visible physical viewport, then
// clamp its pillarboxes, rather than using the hidden dstX/dstW above.
renderer._exclusivePresentationViewport = {
  nativeX: 100,
  nativeY: 50,
  nativeW: 640,
  nativeH: 480,
  dstX: 360,
  dstY: 0,
  dstW: 2160,
  dstH: 1620,
  outputW: 2880,
  outputH: 1620,
};
assert.deepStrictEqual(renderer._mapExclusiveInputPoint(240, 0), { x: 100, y: 50 },
  'visible physical top-left should map to native top-left');
assert.deepStrictEqual(renderer._mapExclusiveInputPoint(1680, 1080), { x: 739, y: 529 },
  'visible physical bottom-right boundary should clamp to native bottom-right');
assert.deepStrictEqual(renderer._mapExclusiveInputPoint(0, 540), { x: 100, y: 290 },
  'left pillarbox should retain vertical tracking at the left guest edge');
assert.deepStrictEqual(renderer._mapExclusiveInputPoint(1919, 540), { x: 739, y: 290 },
  'right pillarbox should retain vertical tracking at the right guest edge');

// Prove this is not merely a helper result: captured browser movement in the
// bar updates the virtual cursor instead of being discarded as outside.
renderer._exclusivePresentationViewport = null;
renderer.windows[7] = {
  hwnd: 7,
  visible: true,
  isChild: false,
  x: 100,
  y: 50,
  w: 640,
  h: 480,
  clientRect: { x: 100, y: 50, w: 640, h: 480 },
  style: 0,
  zOrder: 1,
};
renderer.handleMouseMove(0, 540);
assert.strictEqual(renderer._mouseX, 100);
assert.strictEqual(renderer._mouseY, 290);
renderer.inputQueue.length = 0;
renderer.handleMouseDown(960, 540, 1);
renderer.handleMouseMove(0, 540);
renderer.handleMouseUp(0, 540, 1);
assert(renderer.inputQueue.some(event => event.msg === 0x0202),
  'release in a letterbox bar should reach the guest instead of getting lost');
assert.strictEqual(renderer._mouseX, 100,
  'dragging into the left bar should leave the virtual cursor on the left edge');
assert.strictEqual(renderer._mouseButtonsMask, 0,
  'release in a letterbox bar should clear the virtual button state');

// Alpha's 400x192 opening is centred in a 640x480 exclusive primary. Its
// declarative crop must fill the output at the movie aspect, map input back to
// the native rectangle, and expire as soon as the menu changes backing size.
renderer.presentationCanvas = createCanvas(1920, 1080);
renderer.exclusiveCrop = {
  sourceW: 640, sourceH: 480, x: 120, y: 144, w: 400, h: 192,
};
const alphaWin = {
  hwnd: 9, x: 100, y: 50, w: 1100, h: 534,
  _dxFrameLayer: { canvas: createCanvas(640, 480) },
};
const movieView = renderer._computeExclusiveView(alphaWin);
assert.deepStrictEqual(
  { x: movieView.transform.srcX, y: movieView.transform.srcY,
    w: movieView.transform.srcW, h: movieView.transform.srcH },
  { x: 220, y: 194, w: 400, h: 192 },
  'matching exclusive movie backing selects the native centred sub-frame');
assert.deepStrictEqual(
  { x: movieView.viewport.cropX, y: movieView.viewport.cropY,
    w: movieView.viewport.cropW, h: movieView.viewport.cropH },
  { x: 120, y: 144, w: 400, h: 192 },
  'presentation crops window-local movie pixels');
assert.strictEqual(movieView.viewport.dstW, 1920,
  'the cinematic expands to the full available output width');
assert.strictEqual(movieView.viewport.background, '#000000',
  'the cinematic keeps black letterbox bars');
alphaWin._dxFrameLayer.canvas = createCanvas(1100, 568);
const menuView = renderer._computeExclusiveView(alphaWin);
assert.strictEqual(menuView.transform.srcW, alphaWin.w,
  'a different menu backing size automatically disables the movie crop');

console.log('PASS  letterbox mouse input follows the corresponding guest edges');

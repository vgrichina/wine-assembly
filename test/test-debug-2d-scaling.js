#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createCanvas } = require('../lib/canvas-compat');
const { Win98Renderer } = require('../lib/renderer');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

assert(html.includes('id="presentation-scale-select"'),
  'debug toolbar should expose the 2D scaling selector');
assert(html.includes('<option value="nearest" selected>Nearest fit</option>'));
assert(html.includes('<option value="integer">Integer pixels</option>'));
assert(html.includes('<option value="sharp-bilinear">Sharp bilinear</option>'));
assert(html.includes('<option value="browser-hq">Browser HQ</option>'));
assert(html.includes('<option value="sharp-hq">Sharp HQ</option>'));
assert(html.includes('<option value="scale-auto">Scale (2x / 3x / 4x)</option>'));
assert(!html.includes('<option value="scale2x">'));
assert(!html.includes('<option value="scale3x">'));
assert(html.includes('<option value="fsr1">FSR 1 (EASU + RCAS)</option>'));
assert(html.includes('id="presentation-dedither-select"'));
assert(html.includes('<option value="mdapt">MDAPT</option>'));
assert(html.includes('<option value="jinc2">Jinc2</option>'));
assert(html.includes('id="crt-scanlines-toggle"'));
assert(html.includes('id="crt-mask-toggle"'));
assert(html.includes('id="crt-glow-toggle"'));
assert(!html.includes('<option value="stretch"'),
  'presentation scaling must never offer aspect-ratio stretching');
assert(html.includes('MIN_BACKING_HEIGHT / displayH'),
  'screen backing dimensions should use one uniform width/height scale');

const renderer = new Win98Renderer(createCanvas(1920, 1080));
const game = { hwnd: 7, x: 0, y: 0, w: 640, h: 480 };

const styledCanvas = createCanvas(640, 480);
styledCanvas.style = {};
const styledRenderer = new Win98Renderer(styledCanvas);
assert.strictEqual(styledCanvas.style.imageRendering, 'pixelated');
styledRenderer.setPresentationScaleMode('browser-hq');
assert.strictEqual(styledCanvas.style.imageRendering, 'auto',
  'browser HQ should not be defeated by the element-level pixelated filter');
styledRenderer.setPresentationScaleMode('integer');
assert.strictEqual(styledCanvas.style.imageRendering, 'pixelated',
  'integer scaling should retain nearest CSS/Retina presentation');

renderer.presentationScaleMode = 'nearest';
let transform = renderer._computeExclusiveTransform(game);
assert.deepStrictEqual(
  { x: transform.dstX, y: transform.dstY, w: transform.dstW, h: transform.dstH },
  { x: 240, y: 0, w: 1440, h: 1080 },
  'nearest fit should preserve 4:3 and pillarbox a 16:9 display');
assert.strictEqual(transform.dstW * transform.srcH, transform.dstH * transform.srcW,
  'nearest fit should preserve source aspect ratio');

renderer.presentationScaleMode = 'integer';
transform = renderer._computeExclusiveTransform(game);
assert.deepStrictEqual(
  { x: transform.dstX, y: transform.dstY, w: transform.dstW, h: transform.dstH },
  { x: 320, y: 60, w: 1280, h: 960 },
  'integer scaling should select the largest whole pixel multiple that fits');
assert.strictEqual(transform.dstW / transform.srcW, 2);
assert.strictEqual(transform.dstH / transform.srcH, 2);

renderer.canvas.width = 480;
renderer.canvas.height = 320;
transform = renderer._computeExclusiveTransform(game);
assert.deepStrictEqual(
  { x: transform.dstX, y: transform.dstY, w: transform.dstW, h: transform.dstH },
  { x: 26, y: 0, w: 427, h: 320 },
  'integer mode should use proportional fit when the source must be reduced');
assert(Math.abs(transform.dstW / transform.dstH - game.w / game.h) < 0.002,
  'downscaling should preserve aspect ratio to the nearest destination pixel');

renderer.canvas.width = 1920;
renderer.canvas.height = 1080;
renderer.presentationCanvas = { width: 2880, height: 1620 };
renderer.presentationScaleMode = 'integer';
transform = renderer._computeExclusiveTransform(game);
let physical = renderer._computeExclusivePresentationViewport(transform);
assert.deepStrictEqual(
  { multiplier: physical.multiplier, x: physical.dstX, y: physical.dstY,
    w: physical.dstW, h: physical.dstH },
  { multiplier: 3, x: 480, y: 90, w: 1920, h: 1440 },
  'DPR1.5 integer scaling should choose a 3x native-to-physical multiplier');
renderer._exclusiveTransform = transform;
renderer._exclusivePresentationViewport = physical;
assert.deepStrictEqual(renderer.mapCanvasPoint(320, 60), { x: 0, y: 0 },
  'input should map from the physical integer viewport rather than its hidden logical stage');
assert.deepStrictEqual(renderer.mapCanvasPoint(960, 540), { x: 320, y: 240 });

renderer.presentationCanvas = { width: 1920, height: 1080 };
physical = renderer._computeExclusivePresentationViewport(transform);
assert.strictEqual(physical.multiplier, 2,
  'DPR1 physical output should select 2x for a 640x480 game in 1920x1080');
renderer.presentationCanvas = { width: 3840, height: 2160 };
physical = renderer._computeExclusivePresentationViewport(transform);
assert.strictEqual(physical.multiplier, 4,
  'DPR2 physical output should select 4x for the same game and CSS viewport');

renderer.presentationCanvas = { width: 2880, height: 1620 };
renderer.presentationScaleMode = 'sharp-bilinear';
transform = renderer._computeExclusiveTransform(game);
assert.deepStrictEqual(
  { w: transform.dstW, h: transform.dstH },
  { w: 1280, h: 960 },
  'sharp scaling should keep a lossless integer staging image in the logical canvas');
physical = renderer._computeExclusivePresentationViewport(transform);
assert.deepStrictEqual(
  { multiplier: physical.multiplier, x: physical.dstX, y: physical.dstY,
    w: physical.dstW, h: physical.dstH },
  { multiplier: 3, x: 360, y: 0, w: 2160, h: 1620 },
  'sharp scaling should select its integer stage from the full physical destination');
for (const mode of ['nearest', 'browser-hq', 'scale-auto', 'fsr1']) {
  renderer.presentationScaleMode = mode;
  const modeTransform = renderer._computeExclusiveTransform(game);
  const modeViewport = renderer._computeExclusivePresentationViewport(modeTransform);
  assert.deepStrictEqual(
    { x: modeViewport.dstX, y: modeViewport.dstY,
      w: modeViewport.dstW, h: modeViewport.dstH },
    { x: 360, y: 0, w: 2160, h: 1620 },
    `${mode} should use the native 4:3 ratio in the physical Retina viewport`);
}
renderer.presentationScaleMode = 'sharp-bilinear';
renderer._exclusiveFullscreen = true;
const screenDraws = [];
renderer.ctx = {
  imageSmoothingEnabled: false,
  imageSmoothingQuality: 'low',
  drawImage(...args) {
    screenDraws.push({
      smoothing: this.imageSmoothingEnabled,
      quality: this.imageSmoothingQuality,
      args,
    });
  },
};
let stageSpec = null;
renderer._createOffscreen = (width, height) => {
  const stageDraws = [];
  const ctx = {
    imageSmoothingEnabled: true,
    clearRect() {},
    drawImage(...args) { stageDraws.push({ smoothing: this.imageSmoothingEnabled, args }); },
  };
  stageSpec = { width, height, stageDraws };
  return { width, height, getContext() { return ctx; } };
};
renderer._drawPresentedCanvas(createCanvas(640, 480), 240, 0, 1440, 1080);
assert.deepStrictEqual(
  { width: stageSpec.width, height: stageSpec.height },
  { width: 1280, height: 960 },
  'sharp bilinear should first upscale to the largest fitting integer stage');
assert.strictEqual(stageSpec.stageDraws[0].smoothing, false,
  'integer pre-scale should use nearest-neighbour sampling');
assert.strictEqual(screenDraws[0].smoothing, true,
  'only the final small resize should use bilinear sampling');
assert.strictEqual(screenDraws[0].quality, 'low',
  'sharp bilinear should request the browser low-quality filter');
assert.strictEqual(renderer.ctx.imageSmoothingEnabled, false,
  'sharp scaling should restore the compositor sampling state');
assert.strictEqual(renderer.ctx.imageSmoothingQuality, 'low',
  'sharp scaling should restore the compositor quality state');

screenDraws.length = 0;
renderer.presentationScaleMode = 'browser-hq';
renderer._drawPresentedCanvas(createCanvas(640, 480), 240, 0, 1440, 1080);
assert.strictEqual(screenDraws.length, 1,
  'browser HQ should draw directly without an integer staging pass');
assert.strictEqual(screenDraws[0].smoothing, true);
assert.strictEqual(screenDraws[0].quality, 'high',
  'browser HQ should request the browser high-quality filter');
assert.strictEqual(renderer.ctx.imageSmoothingEnabled, false);
assert.strictEqual(renderer.ctx.imageSmoothingQuality, 'low');

screenDraws.length = 0;
renderer.presentationScaleMode = 'sharp-hq';
renderer._drawPresentedCanvas(createCanvas(640, 480), 240, 0, 1440, 1080);
assert.strictEqual(screenDraws[0].smoothing, true);
assert.strictEqual(screenDraws[0].quality, 'high',
  'sharp HQ should combine the integer staging pass with browser HQ filtering');
assert.deepStrictEqual(
  { width: renderer._presentationScaleCanvas.width, height: renderer._presentationScaleCanvas.height },
  { width: 1280, height: 960 });

const fastRenderer = new Win98Renderer(createCanvas(1920, 1080));
fastRenderer._exclusiveFullscreen = true;
fastRenderer.presentationScaleMode = 'sharp-hq';
const fastDraws = [];
fastRenderer.ctx = {
  imageSmoothingEnabled: false,
  imageSmoothingQuality: 'low',
  drawImage(...args) {
    fastDraws.push({ smoothing: this.imageSmoothingEnabled, quality: this.imageSmoothingQuality, args });
  },
};
fastRenderer._createOffscreen = () => {
  throw new Error('redundant sharp-HQ stage created');
};
let integerBlits = 0;
fastRenderer._blitSurface = () => { integerBlits++; };
const fastSource = createCanvas(800, 600);
fastRenderer._drawPresentedCanvas(fastSource, 0, 13, 940, 705);
assert.strictEqual(fastDraws.length, 1,
  'sub-2x sharp HQ should directly use the browser high-quality filter');
assert.strictEqual(fastDraws[0].quality, 'high');
fastDraws.length = 0;
fastRenderer._drawPresentedCanvas(fastSource, 160, 60, 1600, 1200);
assert.strictEqual(integerBlits, 1,
  'exact-integer sharp HQ should directly use nearest-neighbour presentation');
assert.strictEqual(fastDraws.length, 0,
  'exact-integer sharp HQ should not run an unnecessary smoothing pass');

assert.strictEqual(renderer.setPresentationScaleMode('browser-hq'), 'browser-hq');
assert.strictEqual(renderer.setPresentationScaleMode('sharp-hq'), 'sharp-hq');
assert.strictEqual(renderer.setPresentationScaleMode('scale-auto'), 'scale-auto');
assert.strictEqual(renderer.setPresentationScaleMode('scale2x'), 'scale-auto',
  'stored legacy Scale2x selections should migrate to the automatic scaler');
assert.strictEqual(renderer.setPresentationScaleMode('scale3x'), 'scale-auto',
  'stored legacy Scale3x selections should migrate to the automatic scaler');
assert.strictEqual(renderer.setPresentationScaleMode('fsr1'), 'fsr1');
assert.strictEqual(renderer.setPresentationDeditherMode('mdapt'), 'mdapt');
assert.strictEqual(renderer.setPresentationDeditherMode('jinc2'), 'jinc2');
assert.strictEqual(renderer.setPresentationDeditherMode('checkerboard'), 'mdapt',
  'stored placeholder choices should migrate to MDAPT');
assert.strictEqual(renderer.setPresentationDeditherMode('unknown'), 'off');

assert.deepStrictEqual(
  renderer.setPresentationEffects({ scanlines: 1, mask: false, glow: true }),
  { scanlines: true, mask: false, glow: true });
assert.deepStrictEqual(renderer.presentationEffects,
  { scanlines: true, mask: false, glow: true },
  'CRT effects should remain independent from the selected scaler');

assert.strictEqual(renderer.setPresentationScaleMode('unknown'), 'nearest',
  'unknown modes should fail closed to nearest-neighbour');

const nativeRenderer = new Win98Renderer(createCanvas(4, 4));
const nativeTop = {
  hwnd: 100, x: 0, y: 0, w: 4, h: 4, visible: true, isChild: false,
  style: 0, _backCanvas: createCanvas(4, 4),
};
nativeTop._backCanvas.getContext('2d').fillStyle = '#ff0000';
nativeTop._backCanvas.getContext('2d').fillRect(0, 0, 4, 4);
const nativeChild = {
  hwnd: 101, parentHwnd: 100, x: 1, y: 1, w: 2, h: 2,
  visible: true, isChild: true, style: 0, zOrder: 1,
  _canonicalOwnSurface: true, _backCanvas: createCanvas(2, 2),
};
nativeChild._backCanvas.getContext('2d').fillStyle = '#00ff00';
nativeChild._backCanvas.getContext('2d').fillRect(0, 0, 2, 2);
nativeRenderer.windows = { 100: nativeTop, 101: nativeChild };
const nativeComposite = nativeRenderer._buildExclusivePresentationSource(nativeTop);
const nativePixels = nativeComposite.getContext('2d').getImageData(0, 0, 4, 4).data;
const nativePixel = (x, y) => Array.from(nativePixels.slice((y * 4 + x) * 4, (y * 4 + x) * 4 + 4));
assert.deepStrictEqual(nativePixel(0, 0), [255, 0, 0, 255]);
assert.deepStrictEqual(nativePixel(1, 1), [0, 255, 0, 255],
  'exclusive presentation should composite own child surfaces at native resolution');
let presented = null;
nativeRenderer.presentationCanvas = createCanvas(12, 8);
nativeRenderer.presentationFilter = {
  present(...args) { presented = args; return true; },
};
nativeRenderer.presentationScaleMode = 'fsr1';
nativeRenderer.presentationDeditherMode = 'jinc2';
nativeRenderer._exclusivePresentationSource = nativeComposite;
nativeRenderer._exclusivePresentationViewport = {
  cropX: 0, cropY: 0, cropW: 4, cropH: 4,
  nativeX: 0, nativeY: 0, nativeW: 4, nativeH: 4,
  dstX: 2, dstY: 0, dstW: 8, dstH: 8,
  outputW: 12, outputH: 8, multiplier: 2,
};
nativeRenderer._presentDisplayCanvas();
assert.strictEqual(presented[0], nativeComposite,
  'exclusive GPU scalers should receive the native composite, not the logical screen canvas');
assert.strictEqual(presented[1], 'fsr1');
assert.strictEqual(presented[3].viewport, nativeRenderer._exclusivePresentationViewport);
assert.strictEqual(presented[3].dedither, 'jinc2',
  'dedither should be applied to the native exclusive composite before scaling');

console.log('PASS  scaling uses native exclusive sources, physical Retina multipliers, and aspect-preserving viewports');

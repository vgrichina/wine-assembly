#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  PresentationFilter,
  SCALE2X_FRAGMENT_SHADER,
  SCALE3X_FRAGMENT_SHADER,
  MDAPT_PASS0_FRAGMENT_SHADER,
  MDAPT_PASS2_FRAGMENT_SHADER,
  MDAPT_PASS4_FRAGMENT_SHADER,
  JINC2_DEDITHER_FRAGMENT_SHADER,
  FSR_EASU_FRAGMENT_SHADER,
  POST_FRAGMENT_SHADER,
} = require('../lib/presentation-filter');
const { hasPageScript } = require('./browser-runtime-scripts');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

assert(html.includes('<canvas id="screen-present" aria-hidden="true"></canvas>'),
  'page should expose a derived physical-pixel presentation canvas');
assert(html.indexOf('id="screen-present"') < html.indexOf('id="screen"'),
  'transparent logical input canvas should remain above the presentation canvas');
assert(html.includes('Math.round(displayW * dpr)'));
assert(html.includes('Math.round(displayH * dpr)'));
assert(html.includes('Number(window.devicePixelRatio)'));
assert(html.includes('<option value="scale-auto">Scale (2x / 3x / 4x)</option>'));
assert(!html.includes('<option value="scale2x">'));
assert(!html.includes('<option value="scale3x">'));
assert(html.includes('<option value="fsr1">FSR 1 (EASU + RCAS)</option>'));
assert(html.includes('id="presentation-dedither-select"'));
assert(html.includes('<option value="off" selected>Off</option>'));
assert(html.includes('<option value="mdapt">MDAPT</option>'));
assert(html.includes('<option value="jinc2">Jinc2</option>'));
assert(html.includes("localStorage.setItem(PRESENTATION_DEDITHER_KEY, normalized)"),
  'dedither selection should persist independently from scaling and CRT');
assert(html.includes('renderer.setPresentationDeditherMode(normalized)'));
assert(html.includes('id="crt-scanlines-toggle"'));
assert(html.includes('id="crt-mask-toggle"'));
assert(html.includes('id="crt-glow-toggle"'));
assert(html.includes("localStorage.setItem(PRESENTATION_CRT_KEY, JSON.stringify(effects))"),
  'CRT choices should persist independently from the scaling mode');
assert(html.includes('renderer.setPresentationEffects(effects)'));
assert(hasPageScript('lib/presentation-filter.js'));

const draws = [];
const context = {
  imageSmoothingEnabled: false,
  imageSmoothingQuality: 'low',
  clearRect() {},
  drawImage(...args) {
    draws.push({
      smoothing: this.imageSmoothingEnabled,
      quality: this.imageSmoothingQuality,
      args,
    });
  },
};
const output = {
  width: 1,
  height: 1,
  getContext(type) { return type === '2d' ? context : null; },
};
const source = { width: 320, height: 200 };
const filter = new PresentationFilter(output, { createCanvas: () => null });
filter.resize(1280, 800);
assert.deepStrictEqual([output.width, output.height], [1280, 800],
  'physical output should accept DPR-scaled dimensions independently of the source');

filter.present(source, 'nearest');
assert.strictEqual(draws[0].smoothing, false);
assert.deepStrictEqual(draws[0].args.slice(1), [0, 0, 320, 200, 0, 0, 1280, 800]);
assert.strictEqual(filter.lastBackend, 'canvas-nearest');

draws.length = 0;
filter.present(source, 'browser-hq');
assert.strictEqual(draws[0].smoothing, true);
assert.strictEqual(draws[0].quality, 'high');
assert.strictEqual(context.imageSmoothingEnabled, false,
  'presentation should restore Canvas smoothing state');
assert.strictEqual(context.imageSmoothingQuality, 'low',
  'presentation should restore Canvas quality state');

draws.length = 0;
filter._blitPixelScaleStage({ width: 960, height: 600 });
assert.strictEqual(draws[0].smoothing, true,
  'a non-exact canonical stage should receive one browser-HQ correction');
assert.strictEqual(draws[0].quality, 'high');
assert.deepStrictEqual(draws[0].args.slice(1), [0, 0, 960, 600, 0, 0, 1280, 800]);
assert.strictEqual(context.imageSmoothingEnabled, false);
assert.strictEqual(context.imageSmoothingQuality, 'low');

draws.length = 0;
filter.present(source, 'scale-auto');
assert.strictEqual(filter.lastBackend, 'canvas-hq',
  'automatic pixel scaling should safely fall back to browser HQ when WebGL is unavailable');
assert.strictEqual(draws.length, 1);
assert.strictEqual(draws[0].smoothing, true);
assert.strictEqual(filter.lastPixelScaleMultiplier, 4,
  'automatic pixel scaling should select its canonical stage from physical pixels');

draws.length = 0;
filter.present(source, 'nearest', {}, { dedither: 'mdapt' });
assert.strictEqual(filter.lastDeditherMode, 'mdapt');
assert.strictEqual(filter.lastDeditherBackend, 'unavailable',
  'dedither should leave the source intact when WebGL is unavailable');
assert.strictEqual(filter.lastBackend, 'canvas-nearest');

draws.length = 0;
filter.present(source, 'fsr1');
assert.strictEqual(filter.lastBackend, 'canvas-hq',
  'FSR1 should safely fall back to browser HQ when WebGL is unavailable');
assert.strictEqual(draws[0].smoothing, true);

// The GPU paths upload one whole texture and place only the destination quad,
// so a viewport crop has to be applied to the source *before* they see it.
// Single-app zoom on a phone crops the desktop canvas down to the app window:
// without the pre-crop the whole desktop lands in the app's slot, which is
// exactly what a WebGL-capable browser showed while headless (--disable-gpu,
// 2D paths, crop passed to drawImage) looked right.
{
  const stageDraws = [];
  const stages = [];
  const makeStage = () => {
    const stage = {
      width: 0,
      height: 0,
      getContext(type) {
        // No WebGL in Node: the GPU paths must fall back, and the crop still
        // has to have happened by then.
        if (type !== '2d') return null;
        if (!stages.includes(stage)) stages.push(stage);
        return {
          imageSmoothingEnabled: true,
          clearRect() {},
          drawImage(...args) { stageDraws.push(args); },
        };
      },
    };
    return stage;
  };
  const zoomDraws = [];
  const zoomContext = {
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low',
    clearRect() {},
    fillRect() {},
    drawImage(...args) { zoomDraws.push(args); },
  };
  const zoomOutput = {
    width: 1,
    height: 1,
    getContext: type => (type === '2d' ? zoomContext : null),
  };
  const zoomFilter = new PresentationFilter(zoomOutput, { createCanvas: makeStage });
  zoomFilter.resize(710, 1294);
  const desktop = { width: 400, height: 730 };
  const viewport = {
    cropX: 78, cropY: 40, cropW: 154, cropH: 235,
    nativeX: 78, nativeY: 40, nativeW: 154, nativeH: 235,
    dstX: 0, dstY: 105, dstW: 710, dstH: 1083,
    outputW: 710, outputH: 1294, multiplier: 4, background: '#008080',
  };

  zoomFilter.present(desktop, 'scale-auto', {}, { viewport });
  assert.strictEqual(stages.length, 1, 'the crop should go through one staging canvas');
  assert.deepStrictEqual([stages[0].width, stages[0].height], [154, 235],
    'the staging canvas should be the size of the crop rectangle');
  assert.deepStrictEqual(stageDraws[0].slice(1), [78, 40, 154, 235, 0, 0, 154, 235],
    'the crop rectangle should be blitted out of the desktop canvas 1:1');
  assert.strictEqual(zoomDraws[0][0], stages[0],
    'the presented image should be the cropped stage, not the whole desktop');
  assert.deepStrictEqual(zoomDraws[0].slice(1), [0, 0, 154, 235, 0, 105, 710, 1083],
    'the crop is already applied, so the downstream viewport starts at the origin');
  assert.strictEqual(viewport.cropX, 78, 'the caller-owned viewport must not be mutated');

  // The plain 2D paths already crop in drawImage: no staging blit for them.
  stages.length = 0;
  stageDraws.length = 0;
  zoomDraws.length = 0;
  zoomFilter.present(desktop, 'nearest', {}, { viewport });
  assert.strictEqual(stages.length, 0, 'the 2D path should keep its single cropping blit');
  assert.strictEqual(zoomDraws[0][0], desktop);
  assert.deepStrictEqual(zoomDraws[0].slice(1), [78, 40, 154, 235, 0, 105, 710, 1083]);
}

assert(SCALE2X_FRAGMENT_SHADER.includes('same_color(B, H)'));
assert(SCALE2X_FRAGMENT_SHADER.includes('same_color(D, F)'));
assert(SCALE2X_FRAGMENT_SHADER.includes('same_color(D, B)'));
assert(SCALE2X_FRAGMENT_SHADER.includes('same_color(H, F)'));
assert(SCALE3X_FRAGMENT_SHADER.includes('fract(source) * 3.0'));
assert(SCALE3X_FRAGMENT_SHADER.includes('same_color(E, I)'));
assert(MDAPT_PASS0_FRAGMENT_SHADER.includes('color_distance'));
assert(MDAPT_PASS2_FRAGMENT_SHADER.includes('smoothstep(vec2(1.25, 5.25)'));
assert(MDAPT_PASS4_FRAGMENT_SHADER.includes('center*c.rgb+pu*u+pd*d+pl*l+pr*r'));
assert(JINC2_DEDITHER_FRAGMENT_SHADER.includes('for (int y=-1;y<=2;y++)'));
assert(JINC2_DEDITHER_FRAGMENT_SHADER.includes('mix(unclamped,filtered,0.8)'));
assert(FSR_EASU_FRAGMENT_SHADER.includes('easu_tap'));
assert(FSR_EASU_FRAGMENT_SHADER.includes('12 EASU taps') ||
  FSR_EASU_FRAGMENT_SHADER.includes('vec3 o = sample_pixel'));
assert(POST_FRAGMENT_SHADER.includes('rcas'));
assert(POST_FRAGMENT_SHADER.includes('u_crt_flags'));

console.log('PASS  DPR presentation exposes auto 2x/3x/4x scaling, FSR1, and independent CRT effects');

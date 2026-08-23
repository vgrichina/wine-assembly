#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  PresentationFilter,
  SCALE2X_FRAGMENT_SHADER,
  SCALE3X_FRAGMENT_SHADER,
  DEDITHER_CHECKERBOARD_FRAGMENT_SHADER,
  DEDITHER_ORDERED2_FRAGMENT_SHADER,
  FSR_EASU_FRAGMENT_SHADER,
  POST_FRAGMENT_SHADER,
} = require('../lib/presentation-filter');

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
assert(html.includes('<option value="checkerboard">Checkerboard</option>'));
assert(html.includes('<option value="ordered2">Ordered 2x2</option>'));
assert(html.includes("localStorage.setItem(PRESENTATION_DEDITHER_KEY, normalized)"),
  'dedither selection should persist independently from scaling and CRT');
assert(html.includes('renderer.setPresentationDeditherMode(normalized)'));
assert(html.includes('id="crt-scanlines-toggle"'));
assert(html.includes('id="crt-mask-toggle"'));
assert(html.includes('id="crt-glow-toggle"'));
assert(html.includes("localStorage.setItem(PRESENTATION_CRT_KEY, JSON.stringify(effects))"),
  'CRT choices should persist independently from the scaling mode');
assert(html.includes('renderer.setPresentationEffects(effects)'));
assert(html.includes('lib/presentation-filter.js?v=4'));

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
filter.present(source, 'nearest', {}, { dedither: 'checkerboard' });
assert.strictEqual(filter.lastDeditherMode, 'checkerboard');
assert.strictEqual(filter.lastDeditherBackend, 'unavailable',
  'dedither should leave the source intact when WebGL is unavailable');
assert.strictEqual(filter.lastBackend, 'canvas-nearest');

draws.length = 0;
filter.present(source, 'fsr1');
assert.strictEqual(filter.lastBackend, 'canvas-hq',
  'FSR1 should safely fall back to browser HQ when WebGL is unavailable');
assert.strictEqual(draws[0].smoothing, true);

assert(SCALE2X_FRAGMENT_SHADER.includes('same_color(B, H)'));
assert(SCALE2X_FRAGMENT_SHADER.includes('same_color(D, F)'));
assert(SCALE2X_FRAGMENT_SHADER.includes('same_color(D, B)'));
assert(SCALE2X_FRAGMENT_SHADER.includes('same_color(H, F)'));
assert(SCALE3X_FRAGMENT_SHADER.includes('fract(source) * 3.0'));
assert(SCALE3X_FRAGMENT_SHADER.includes('same_color(E, I)'));
assert(DEDITHER_CHECKERBOARD_FRAGMENT_SHADER.includes('cross_pair'));
assert(DEDITHER_CHECKERBOARD_FRAGMENT_SHADER.includes('diagonal_pair'));
assert(DEDITHER_ORDERED2_FRAGMENT_SHADER.includes('stable_phase'));
assert(DEDITHER_ORDERED2_FRAGMENT_SHADER.includes('0.25 * (a + b0 + c + d)'));
assert(FSR_EASU_FRAGMENT_SHADER.includes('easu_tap'));
assert(FSR_EASU_FRAGMENT_SHADER.includes('12 EASU taps') ||
  FSR_EASU_FRAGMENT_SHADER.includes('vec3 o = sample_pixel'));
assert(POST_FRAGMENT_SHADER.includes('rcas'));
assert(POST_FRAGMENT_SHADER.includes('u_crt_flags'));

console.log('PASS  DPR presentation exposes auto 2x/3x/4x scaling, FSR1, and independent CRT effects');

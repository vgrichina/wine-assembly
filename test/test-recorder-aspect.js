#!/usr/bin/env node
'use strict';

// Drive the public Record button across desktop/fullscreen/resize transitions.
// The capture surface must never resize after captureStream, and every source
// must retain its aspect ratio inside the fixed encoded frame.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const screen = { width: 1264, height: 767 };
const renderer = { windows: {} };
let nextFrame, canvas, recordingSize;
let draw, fill, depth = 0;
let translation = [0, 0];
const ctx = {
  fillRect(...args) { fill = args; },
  save() { depth++; },
  restore() { depth--; },
  translate(...args) { translation = args; },
  drawImage(...args) { draw = args; },
};
const track = { stop() {} };
const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
const window = { wineShell: { renderer } };
const sandbox = {
  window, console: { log() {}, warn() {}, error() {} }, Date,
  document: {
    getElementById: id => id === 'screen' ? screen : null,
    createElement(tag) {
      assert.strictEqual(tag, 'canvas');
      canvas = {
        getContext: () => ctx,
        captureStream() { recordingSize = [canvas.width, canvas.height]; return stream; },
      };
      return canvas;
    },
  },
  requestAnimationFrame(fn) { nextFrame = fn; return 1; },
  cancelAnimationFrame() {}, setInterval() { return 1; }, clearInterval() {},
  MediaStream: function () { return stream; },
  MediaRecorder: class {
    static isTypeSupported() { return true; }
    start() {}
  },
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/recorder.js'), 'utf8'), sandbox);
window.toggleRecording();
assert.deepStrictEqual(recordingSize, [2528, 1534]);

function check(w, h) {
  nextFrame();
  assert.deepStrictEqual([canvas.width, canvas.height], recordingSize, 'encoder surface stays fixed');
  const [pw, ph] = draw.slice(-2);
  assert(Math.abs(pw / ph - w / h) < 1e-10, 'source aspect survives');
  assert.deepStrictEqual(fill, [0, 0, ...recordingSize], 'old frame and bars cleared');
  assert(Math.abs(translation[0] * 2 + pw - canvas.width) < 1e-9, 'centered horizontally');
  assert(Math.abs(translation[1] * 2 + ph - canvas.height) < 1e-9, 'centered vertically');
  assert.strictEqual(depth, 0, 'drawing state restored');
}
check(1264, 767);
renderer._exclusiveFullscreen = true;
renderer._exclusiveTransform = { dstX: 121, dstY: 0, dstW: 1022, dstH: 767 };
check(1022, 767);
assert.deepStrictEqual(draw.slice(1, 5), [121, 0, 1022, 767], 'fullscreen uses presented crop');
screen.width = 800; screen.height = 600;
renderer._exclusiveTransform = null;
check(800, 600);
screen.width = 600; screen.height = 900;
check(600, 900);
renderer._exclusiveFullscreen = false;
renderer._exclusiveTransform = { srcX: 10, srcY: 20, srcW: 320, srcH: 240 };
check(320, 240);
assert.deepStrictEqual(draw.slice(1, 5), [10, 20, 320, 240], 'single-app uses source crop');
console.log('PASS recorder keeps fixed encoded dimensions and source aspect across five transitions');

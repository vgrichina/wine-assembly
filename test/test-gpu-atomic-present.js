#!/usr/bin/env node
'use strict';

// A guest GPU frame can span several cooperative run slices. Browser input
// may repaint between them, so the compositor must keep seeing the last
// SwapBuffers snapshot instead of the WebGL canvas currently being mutated.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { WebGLBackend } = require('../lib/gpu-backend');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
assert(html.includes('lib/gpu-backend.js?v=2') &&
  html.includes('lib/gl-command-stream.js?v=1') &&
  html.includes('lib/gl-compat.js?v=3'),
  'the browser entrypoint cache-busts the GPU backend, command stream, and GL frontend');

const copies = [];
const presentationContext = {
  imageSmoothingEnabled: true,
  clearRect(x, y, width, height) { copies.push(['clear', x, y, width, height]); },
  drawImage(source, x, y, width, height) {
    this.canvas.frame = source.frame;
    copies.push(['copy', source.frame, x, y, width, height]);
  },
};
const presentationCanvas = {
  width: 0, height: 0, frame: 'never-presented',
  getContext(kind) {
    assert.strictEqual(kind, '2d');
    presentationContext.canvas = this;
    return presentationContext;
  },
};
const gl = { flushes: 0, flush() { this.flushes++; } };
const liveCanvas = {
  width: 640, height: 480, frame: 'complete-A',
  ownerDocument: {
    createElement(kind) {
      assert.strictEqual(kind, 'canvas');
      return presentationCanvas;
    },
  },
  getContext(kind) {
    assert.strictEqual(kind, 'webgl');
    return gl;
  },
};

const backend = new WebGLBackend(liveCanvas);
const exposed = backend.getPresentationSurface();
assert.notStrictEqual(exposed, liveCanvas,
  'the compositor surface must not alias the mutable WebGL draw canvas');

backend.present();
assert.strictEqual(exposed.frame, 'complete-A');
liveCanvas.frame = 'partial-B-after-645-draws';
assert.strictEqual(exposed.frame, 'complete-A',
  'a repaint before SwapBuffers must retain the prior complete frame');
assert.strictEqual(copies.filter(value => value[0] === 'copy').length, 1,
  'drawing does not publish implicit frames');

liveCanvas.width = 800;
liveCanvas.height = 600;
liveCanvas.frame = 'complete-B';
assert.strictEqual(backend.present(), exposed);
assert.strictEqual(exposed.frame, 'complete-B');
assert.deepStrictEqual([exposed.width, exposed.height], [800, 600],
  'the atomic presentation surface tracks guest display-mode changes');
assert.strictEqual(gl.flushes, 2);
assert.strictEqual(presentationContext.imageSmoothingEnabled, false,
  'frame snapshots remain pixel-exact');

console.log('PASS generic GPU presentation is atomic at present/SwapBuffers');

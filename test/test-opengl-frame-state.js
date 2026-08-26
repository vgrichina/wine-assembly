#!/usr/bin/env node
'use strict';

// Quake II rewrites small regions of several lightmap textures while toggling
// depth writes and multiplicative blending every frame. Keep those texture,
// raster-state, and presentation paths independent: a subimage must update the
// selected lightmap only, and SwapBuffers must not invent another GL frame.
const assert = require('assert');
const { FixedFunctionGL, OpenGLHostBridge, CALL_INDEX, constants: GL } = require('../lib/gl-compat');

class Backend {
  constructor() {
    this.gl = {
      ARRAY_BUFFER: 0x8892, STREAM_DRAW: 0x88e0,
      TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800,
      TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803,
      NEAREST_MIPMAP_LINEAR: 0x2702, LINEAR: 0x2601, REPEAT: 0x2901,
    };
    this.nextTexture = 1;
    this.capabilities = [];
    this.depthMasks = [];
    this.blends = [];
    this.updates = [];
    this.presents = 0;
  }
  createProgram() { return { attributes: {}, uniforms: {} }; }
  createBuffer() { return {}; }
  createTexture() { return { id: this.nextTexture++ }; }
  setTextureParameter() {}
  bindTexture(texture) { this.boundTexture = texture; }
  setCapability(capability, enabled) { this.capabilities.push([capability, enabled]); }
  setDepthMask(value) { this.depthMasks.push(!!value); }
  setBlendFunc(src, dst) { this.blends.push([src, dst]); }
  updateTexture2D(texture, image) { this.updates.push({ texture, image }); }
  present() { this.presents++; }
  deleteTexture() {}
  deleteBuffer() {}
  destroy() {}
}

const memory = new ArrayBuffer(0x1000);
const view = new DataView(memory);
const stack = 0x100;
const pixelsWa = 0x500;
const pixelsGa = 0x4e300500;
const pixels = new Uint8Array(memory, pixelsWa, 4 * 3 * 4);
for (let i = 0; i < pixels.length; i++) pixels[i] = i;

const backend = new Backend();
const frontend = new FixedFunctionGL(backend);
let repaintCount = 0, presentCallbacks = 0;
const bridge = new OpenGLHostBridge({
  getMemory: () => memory,
  exports: { guest_to_wasm: pointer => pointer === pixelsGa ? pixelsWa : 0 },
  renderer: { needsRepaint: false, repaint: () => repaintCount++ },
  onPresent: () => presentCallbacks++,
});
bridge.current = 1;
bridge.contexts.set(1, {
  frontend, backend,
  layer: { canvas: {}, backend, writeSeq: 0 },
});

function call(name, args) {
  args.forEach((value, index) => view.setUint32(stack + 4 + index * 4, value >>> 0, true));
  return bridge.call(CALL_INDEX[name], stack, 0);
}

call('glEnable', [GL.DEPTH_TEST]);
call('glEnable', [GL.TEXTURE_2D]);
call('glDepthMask', [0]);
call('glEnable', [GL.BLEND]);
call('glBlendFunc', [0, 0x0300]); // GL_ZERO, GL_SRC_COLOR lightmap pass
call('glDisable', [GL.BLEND]);
call('glBlendFunc', [0x0302, 0x0303]); // normal alpha state restoration
call('glDepthMask', [1]);

frontend.bindTexture(1024);
const lightmapTexture = backend.boundTexture;
call('glTexSubImage2D', [GL.TEXTURE_2D, 0, 7, 11, 4, 3,
  GL.RGBA, GL.UNSIGNED_BYTE, pixelsGa]);

assert.deepStrictEqual(backend.depthMasks, [false, true],
  'Quake lightmap pass must restore depth writes');
assert.deepStrictEqual(backend.blends, [[0, 0x0300], [0x0302, 0x0303]],
  'multiplicative lightmap blending must not leak into later alpha geometry');
assert(frontend.enabled.has(GL.DEPTH_TEST) && frontend.enabled.has(GL.TEXTURE_2D),
  'world depth and texture state remains enabled');
assert(!frontend.enabled.has(GL.BLEND), 'lightmap blend state is disabled after its pass');
assert.strictEqual(backend.updates.length, 1);
assert.strictEqual(backend.updates[0].texture, lightmapTexture,
  'subimage update targets the selected lightmap object');
assert.deepStrictEqual([
  backend.updates[0].image.x, backend.updates[0].image.y,
  backend.updates[0].image.width, backend.updates[0].image.height,
], [7, 11, 4, 3]);
assert.deepStrictEqual(Array.from(backend.updates[0].image.pixels), Array.from(pixels),
  'sparse guest lightmap bytes reach WebGL unchanged');

assert.strictEqual(call('gpuPresent', []), 1);
assert.strictEqual(backend.presents, 1);
assert.strictEqual(bridge.contexts.get(1).layer.writeSeq, 1);
assert.strictEqual(presentCallbacks, 1,
  'one SwapBuffers call contributes exactly one GL FPS event');
assert.strictEqual(repaintCount, 1, 'one SwapBuffers call schedules one composite');

console.log('PASS OpenGL per-frame lightmap/state/present isolation');

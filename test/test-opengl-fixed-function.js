#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { FixedFunctionGL, OpenGLHostBridge, CALL_INDEX, constants: GL } = require('../lib/gl-compat');

class FakeBackend {
  constructor() {
    this.gl = {
      ARRAY_BUFFER: 0x8892, STREAM_DRAW: 0x88E0, FLOAT: 0x1406,
      TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800,
      TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803,
      NEAREST_MIPMAP_LINEAR: 0x2702, LINEAR: 0x2601, REPEAT: 0x2901,
      TRIANGLES: 4,
    };
    this.draws = []; this.uniforms = new Map(); this.uploads = [];
    this.parameters = [];
  }
  createProgram() { return { attributes: { aPosition: 0, aColor: 1, aTexCoord: 2 }, uniforms: {} }; }
  createBuffer() { return {}; }
  updateBuffer(_buffer, _target, data) { this.vertices = Array.from(data); }
  useProgram() {}
  setUniform(_program, name, _kind, value) { this.uniforms.set(name, value); }
  bindTexture() {}
  draw(command) { this.draws.push(command); }
  createTexture() { return {}; }
  setTextureParameter(texture, pname, value) {
    assert(texture, 'texture parameters must never target WebGL null binding');
    this.parameters.push({ texture, pname, value });
  }
  uploadTexture2D(_texture, image) { this.uploads.push(image); }
  updateTexture2D(_texture, image) { this.uploads.push(image); }
  deleteTexture() {}
  destroy() {}
  setCapability() {}
}

const backend = new FakeBackend();
const gl = new FixedFunctionGL(backend);
gl.begin(GL.QUADS);
gl.vertex(-1, -1, 0); gl.vertex(1, -1, 0);
gl.vertex(1, 1, 0); gl.vertex(-1, 1, 0);
gl.end();
assert.strictEqual(backend.draws.length, 1);
assert.strictEqual(backend.draws[0].mode, GL.TRIANGLES,
  'GL_QUADS must lower to WebGL triangles');
assert.strictEqual(backend.draws[0].count, 6,
  'one quad must become two complete triangles');

gl.matrixMode = GL.MODELVIEW;
gl._multMatrix(require('../lib/gl-compat').identity());
gl._multMatrix(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0,
  0, 0, 1, 0, 2, 3, 4, 1]));
assert.deepStrictEqual(Array.from(gl._matrix().slice(12, 15)), [2, 3, 4],
  'matrix frontend keeps OpenGL column-major post-multiply semantics');

gl.bindTexture(7);
gl.texImage(0, 4, 2, 2, 0, GL.RGBA, GL.UNSIGNED_BYTE,
  new Uint8Array(16));
assert.strictEqual(backend.uploads.length, 1);
assert.strictEqual(backend.uploads[0].alignment, 1,
  'guest texture rows use deterministic byte alignment');

gl.bindTexture(0);
gl.texParameter(GL.TEXTURE_MIN_FILTER, GL.LINEAR);
assert(gl.defaultTexture,
  'desktop GL texture zero has a mutable WebGL backing object');
assert.strictEqual(backend.parameters.at(-1).texture, gl.defaultTexture,
  'texture-zero parameters target the owned default texture');

// Gameplay geometry lives in Quake's high sparse VirtualAlloc arena. Verify
// pointer-valued GL calls use the emulator's canonical translator instead of
// assuming every guest address is image-relative linear memory.
const bridgeMemory = new ArrayBuffer(4096);
const bridgeView = new DataView(bridgeMemory);
const guestVertex = 0x4e306050, vertexBacking = 0x200, stack = 0x100;
bridgeView.setUint32(stack + 4, guestVertex, true);
[1.25, -2.5, 3.75].forEach((value, index) =>
  bridgeView.setFloat32(vertexBacking + index * 4, value, true));
const seenVertices = [];
let guestPresents = 0;
const bridge = new OpenGLHostBridge({
  getMemory: () => bridgeMemory,
  exports: {
    get_image_base: () => 0x00400000,
    guest_to_wasm: pointer => pointer === guestVertex ? vertexBacking : 0xF0,
  },
  onPresent: () => { guestPresents++; },
});
bridge.current = 1;
bridge.contexts.set(1, { frontend: {
  vertex: (...values) => seenVertices.push(values),
}, backend: { present() {} }, layer: { writeSeq: 0 } });
bridge.call(CALL_INDEX.glVertex3fv, stack, 0);
assert.deepStrictEqual(seenVertices, [[1.25, -2.5, 3.75]],
  'glVertex3fv resolves sparse guest pointers through guest_to_wasm');
bridge.call(CALL_INDEX.gpuPresent, stack, 0);
assert.strictEqual(guestPresents, 1,
  'generic GPU presentation contributes exactly one guest FPS sample');
assert.strictEqual(bridge.contexts.get(1).layer.writeSeq, 1,
  'generic GPU presentation advances its compositor sequence');

console.log('PASS OpenGL fixed-function lowering (quad, matrix, texture)');

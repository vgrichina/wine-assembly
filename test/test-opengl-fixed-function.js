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
    this.depthRanges = [];
    this.polygonOffsets = [];
    this.capabilities = [];
    this.uniformCalls = 0;
  }
  createProgram() { return { attributes: { aPosition: 0, aColor: 1, aTexCoord: 2 }, uniforms: {} }; }
  createBuffer() { return {}; }
  updateBuffer(_buffer, _target, data) { this.vertices = Array.from(data); }
  useProgram() {}
  setUniform(_program, name, _kind, value) { this.uniformCalls++; this.uniforms.set(name, value); }
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
  setCapability(capability, enabled) { this.capabilities.push([capability, enabled]); }
  setDepthRange(nearValue, farValue) { this.depthRanges.push([nearValue, farValue]); }
  setPolygonOffset(factor, units) { this.polygonOffsets.push([factor, units]); }
}

const backend = new FakeBackend();
const gl = new FixedFunctionGL(backend);
const triangle = new Float32Array(3 * 9);
for (const stack of Object.values(gl.matrices)) {
  stack.slice = () => { throw new Error('matrix-stack slice allocated'); };
}
gl.enqueuePacked(GL.TRIANGLES, triangle);
gl.flushPendingDraw();
assert.strictEqual(backend.draws.length, 1);
assert.strictEqual(backend.draws[0].mode, GL.TRIANGLES,
  'packed desktop geometry reaches the WebGL triangle backend');
assert.strictEqual(backend.draws[0].count, 3,
  'one packed triangle produces one complete WebGL triangle');

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

const mergedBackend = new FakeBackend();
const merged = new FixedFunctionGL(mergedBackend);
merged.enqueuePacked(GL.TRIANGLES, triangle);
merged.enqueuePacked(GL.TRIANGLES, triangle);
assert.strictEqual(mergedBackend.draws.length, 0, 'compatible packed draws remain deferred');
merged.flushPendingDraw();
assert.strictEqual(mergedBackend.draws.length, 1, 'adjacent compatible draws merge into one WebGL draw');
assert.strictEqual(mergedBackend.draws[0].count, 6, 'merged draw contains both triangles');
assert.strictEqual(mergedBackend.vertices.length, 6 * 9, 'merged interleaved upload is contiguous');
const initialUniformCalls = mergedBackend.uniformCalls;
merged.enqueuePacked(GL.TRIANGLES, triangle);
merged.flushPendingDraw();
assert.strictEqual(mergedBackend.uniformCalls, initialUniformCalls,
  'unchanged fixed-function uniforms are not reissued on later draws');

const depthBackend = new FakeBackend();
const depthFrontend = new FixedFunctionGL(depthBackend);
depthFrontend.setDepthRange(1, 0);
assert.deepStrictEqual(depthBackend.depthRanges, [[0, 1]],
  'desktop reversed depth range is submitted to WebGL in legal order');
depthFrontend.enqueuePacked(GL.TRIANGLES, triangle);
depthFrontend.flushPendingDraw();
assert.strictEqual(depthBackend.uniforms.get('uProjection')[10], -1,
  'reversed depth range negates clip-space Z to preserve desktop GL mapping');
depthFrontend.setDepthRange(0, 1);
depthFrontend.enqueuePacked(GL.TRIANGLES, triangle);
depthFrontend.flushPendingDraw();
assert.strictEqual(depthBackend.uniforms.get('uProjection')[10], 1,
  'restoring forward depth range restores the original projection');

const bridgeMemory = new ArrayBuffer(4096);
const bridgeView = new DataView(bridgeMemory);
const stack = 0x100;
let guestPresents = 0;
const bridge = new OpenGLHostBridge({
  getMemory: () => bridgeMemory,
  exports: {},
  onPresent: () => { guestPresents++; },
});
bridge.current = 1;
bridge.contexts.set(1, { frontend: {
  backend,
}, backend: { present() {} }, layer: { writeSeq: 0 } });
assert.throws(() => bridge.call(CALL_INDEX.glVertex3fv, stack, 0),
  /must pass through GLCommandStream\.Encoder/,
  'raw immediate vertices cannot bypass the mandatory buffered state layer');
bridgeView.setFloat32(stack + 4, -1, true);
bridgeView.setFloat32(stack + 8, -2, true);
bridge.call(CALL_INDEX.glPolygonOffset, stack, 0);
assert.deepStrictEqual(backend.polygonOffsets, [[-1, -2]],
  'GoldSrc polygon offset reaches the WebGL backend with both float arguments');

const matrixFrontend = new FixedFunctionGL(new FakeBackend());
matrixFrontend.matrixMode = GL.PROJECTION;
bridge.contexts.set(1, {
  frontend: matrixFrontend,
  backend: { present() {} },
  layer: { writeSeq: 0 },
});
for (const [index, value] of [60, 4 / 3, 1, 101].entries()) {
  bridgeView.setFloat64(stack + 4 + index * 8, value, true);
}
bridge.call(CALL_INDEX.gluPerspective, stack, 0);
const projection = matrixFrontend._matrix();
assert(Math.abs(projection[0] - 1.299038) < 1e-5 &&
  Math.abs(projection[5] - 1.732051) < 1e-5 &&
  Math.abs(projection[10] + 1.02) < 1e-5,
  'gluPerspective applies the documented GLdouble projection matrix');

matrixFrontend.matrixMode = GL.MODELVIEW;
const lookAtValues = [0, 0, 5, 0, 0, 0, 0, 1, 0];
lookAtValues.forEach((value, index) => bridgeView.setFloat64(stack + 4 + index * 8, value, true));
bridge.call(CALL_INDEX.gluLookAt, stack, 0);
assert.deepStrictEqual(Array.from(matrixFrontend._matrix().slice(12, 16)), [0, 0, -5, 1],
  'gluLookAt applies orientation and eye translation in OpenGL column-major order');
gl.setEnabled(GL.POLYGON_OFFSET_FILL, true);
assert.deepStrictEqual(backend.capabilities.at(-1), [GL.POLYGON_OFFSET_FILL, true],
  'polygon-offset fill follows desktop GL enable state');
bridge.call(CALL_INDEX.gpuPresent, stack, 0);
assert.strictEqual(guestPresents, 1,
  'generic GPU presentation contributes exactly one guest FPS sample');
assert.strictEqual(bridge.contexts.get(1).layer.writeSeq, 1,
  'generic GPU presentation advances its compositor sequence');

const contextCounts = [];
const lifecycleBridge = new OpenGLHostBridge({
  getMemory: () => bridgeMemory,
  exports: {},
  onContextCountChange: count => contextCounts.push(count),
});
const lifecycleWin = {};
const lifecycleLayer = {};
lifecycleWin._gpuFrameLayer = lifecycleLayer;
lifecycleWin._dxFrameLayer = lifecycleLayer;
lifecycleBridge.current = 7;
lifecycleBridge.contexts.set(7, {
  frontend: { destroy() {} }, win: lifecycleWin, layer: lifecycleLayer,
});
assert.strictEqual(lifecycleBridge.makeCurrent(7), 1);
assert.strictEqual(lifecycleBridge.makeCurrent(0), 1);
assert.deepStrictEqual(contextCounts, [1, 0],
  'releasing a current context reports the software-renderer transition');
assert.strictEqual(lifecycleBridge.deleteContext(7), 1,
  'live OpenGL context can be deleted during renderer replacement');
assert.deepStrictEqual(contextCounts, [1, 0, 0],
  'deleting the last context reports the software-renderer transition');
assert.strictEqual(lifecycleWin._gpuFrameLayer, null,
  'renderer replacement detaches the old GPU presentation layer');

console.log('PASS OpenGL packed fixed-function rendering (state, matrix, texture)');

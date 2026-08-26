#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { WebGLBackend } = require('../lib/gpu-backend');

let next = 1;
const calls = [];
const gl = {
  VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
  ARRAY_BUFFER: 5, ELEMENT_ARRAY_BUFFER: 6, STREAM_DRAW: 7,
  TEXTURE_2D: 8, TEXTURE0: 100, UNPACK_ALIGNMENT: 9,
  FLOAT: 10, UNSIGNED_SHORT: 11,
  createShader: () => ({ id: next++ }), shaderSource() {}, compileShader() {},
  getShaderParameter: () => true, getShaderInfoLog: () => '', deleteShader() {},
  createProgram: () => ({ id: next++ }), attachShader() {}, linkProgram() {},
  getProgramParameter: () => true, getProgramInfoLog: () => '', deleteProgram() {},
  getAttribLocation: (_p, n) => n === 'a' ? 0 : 1,
  getUniformLocation: (_p, n) => ({ n }), useProgram() {},
  createBuffer: () => ({ id: next++ }), bindBuffer: (...a) => calls.push(['bindBuffer', ...a]),
  bufferData: (...a) => calls.push(['bufferData', ...a]), deleteBuffer() {},
  createTexture: () => ({ id: next++ }), activeTexture() {}, bindTexture() {},
  pixelStorei() {}, texImage2D: (...a) => calls.push(['texImage2D', ...a]),
  texSubImage2D() {}, texParameteri() {}, deleteTexture() {},
  enableVertexAttribArray() {}, vertexAttribPointer() {}, drawArrays: (...a) => calls.push(['drawArrays', ...a]),
  drawElements() {}, uniformMatrix4fv() {}, uniform1i() {}, uniform1f() {}, uniform4fv() {},
  enable() {}, disable() {}, viewport() {}, scissor() {}, depthFunc() {}, depthMask() {},
  depthRange() {}, blendFunc() {}, cullFace() {}, frontFace() {}, lineWidth() {},
  clearColor() {}, clear() {}, readPixels() {}, finish() {}, flush() {}, getParameter: () => 4096,
  getError: () => 0,
};
const canvas = { getContext: name => name === 'webgl' ? gl : null };
const gpu = new WebGLBackend(canvas);
const buffer = gpu.createBuffer();
gpu.updateBuffer(buffer, gl.ARRAY_BUFFER, new Float32Array([1, 2, 3]), gl.STREAM_DRAW);
assert(calls.some(call => call[0] === 'bufferData'), 'backend uploads normalized buffer data');
const texture = gpu.createTexture();
gpu.uploadTexture2D(texture, {
  internalFormat: 0x1908, width: 1, height: 1, format: 0x1908,
  type: 0x1401, pixels: new Uint8Array([1, 2, 3, 4]),
});
assert(calls.some(call => call[0] === 'texImage2D'), 'backend owns texture upload');
console.log('PASS generic WebGL/GLES backend resource contract');

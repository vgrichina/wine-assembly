#!/usr/bin/env node
'use strict';

const assert = require('assert');
const Stream = require('../lib/gl-command-stream');
const RPC = require('../lib/guest-rpc');
const { OpenGLHostBridge } = require('../lib/gl-compat');

const memory = new ArrayBuffer(64 * 1024);
const dv = new DataView(memory);
const stack = 0x100;
const submissions = [];
const executed = [];

const coloredVertices = count => {
  const vertices = [];
  for (let i = 0; i < count; i++) {
    vertices.push(i, 0, 0, i + 1, 0, 0, 1, 0, 0);
  }
  return vertices;
};
const redChannels = geometry => Array.from(
  { length: geometry.vertices.length / 9 },
  (_unused, i) => geometry.vertices[i * 9 + 3]);
const expectFlatColors = (mode, count, expected, label) => {
  const geometry = Stream.normalizeImmediate(mode, coloredVertices(count), 0x1D00);
  assert.deepStrictEqual(redChannels(geometry), expected, label);
  return geometry;
};

expectFlatColors(0x0004, 6, [3, 3, 3, 6, 6, 6],
  'independent triangles use each triangle third vertex under GL_FLAT');
expectFlatColors(0x0001, 4, [2, 2, 4, 4],
  'independent lines use each line second vertex under GL_FLAT');
expectFlatColors(0x0007, 8, [4, 4, 4, 4, 4, 4, 8, 8, 8, 8, 8, 8],
  'both triangles lowered from a quad retain its fourth provoking vertex');
expectFlatColors(0x0008, 6, [4, 4, 4, 4, 4, 4, 6, 6, 6, 6, 6, 6],
  'both triangles in each quad-strip polygon retain that polygon provoking vertex');
expectFlatColors(0x0009, 5, Array(9).fill(1),
  'a legacy GL_POLYGON uses its first vertex across the complete fan');
expectFlatColors(0x0006, 5, [3, 3, 3, 4, 4, 4, 5, 5, 5],
  'each triangle-fan triangle uses its own final vertex');
expectFlatColors(0x0005, 5, [3, 3, 3, 4, 4, 4, 5, 5, 5],
  'triangle-strip winding changes do not change its provoking vertex sequence');
expectFlatColors(0x0003, 4, [2, 2, 3, 3, 4, 4],
  'line strips use each segment endpoint under GL_FLAT');
const flatLoop = expectFlatColors(0x0002, 4, [2, 2, 3, 3, 4, 4, 1, 1],
  'the closing line-loop segment is shaded by vertex one');
assert.strictEqual(flatLoop.mode, 0x0001,
  'line loops lower to independent WebGL lines');

const submit = batch => {
  submissions.push({ bytes: batch.bytes, commands: batch.commands });
  return Stream.replay(batch, (opcode, aux, capture) => {
    const stackView = new DataView(capture.buffer);
    executed.push({
      opcode, aux, capture,
      arg0: stackView.getUint32(capture.stackOffset + 4, true),
    });
    return opcode === 12 ? 0x504 : 0;
  });
};

const encoder = new Stream.Encoder({
  getMemory: () => memory,
  guestToWasm: pointer => pointer,
  submit,
  capacity: 256,
  shared: false,
});
assert.strictEqual(encoder._memoryView(), encoder._memoryView(),
  'command argument reads reuse one DataView for fixed guest memory');

// Value arguments are snapshots too: changing the guest stack while commands
// wait for the frame barrier must not change an earlier command.
dv.setUint32(stack + 4, 0x0BE2, true);
encoder.call(10, stack, 0); // glEnable
dv.setUint32(stack + 4, 0x0B71, true);
assert.strictEqual(submissions.length, 0, 'ordinary GL calls stay local until a barrier');
assert.strictEqual(encoder.call(12, stack, 0), 0x504, 'query returns the last replay result');
assert.deepStrictEqual(executed.map(x => x.opcode), [10, 12], 'barrier preserves command order');
assert.strictEqual(executed[0].arg0, 0x0BE2, 'queued stack arguments are copied immediately');

// Newly appended GL entry points retain the established opcode ABI and copy
// their complete argument stack through the Worker stream.
dv.setFloat32(stack + 4, -1.25, true);
dv.setFloat32(stack + 8, 2.5, true);
encoder.call(57, stack, 0); // glPolygonOffset
encoder.call(11, stack, 0); // glFinish
const polygonOffsetCommand = executed.find(x => x.opcode === 57);
assert(polygonOffsetCommand, 'polygon offset is transported as appended opcode 57');
const polygonOffsetStack = new DataView(polygonOffsetCommand.capture.buffer);
assert.strictEqual(polygonOffsetCommand.capture.stackBytes, 12,
  'polygon offset captures return address plus two float arguments');
assert.strictEqual(polygonOffsetStack.getFloat32(polygonOffsetCommand.capture.stackOffset + 4, true), -1.25);
assert.strictEqual(polygonOffsetStack.getFloat32(polygonOffsetCommand.capture.stackOffset + 8, true), 2.5);

// Small generic client pointers are copied into the stream because engines
// commonly reuse scratch storage between calls.
const matrix = 0x500;
dv.setUint32(stack + 4, matrix, true);
for (let i = 0; i < 16; i++) dv.setFloat32(matrix + i * 4, i + 0.25, true);
encoder.call(34, stack, 0); // glLoadMatrixf
for (let i = 0; i < 16; i++) dv.setFloat32(matrix + i * 4, 99, true);
encoder.call(11, stack, 0); // glFinish
const matrixCommand = executed.find(x => x.opcode === 34);
assert(matrixCommand.capture.pointerOffset, 'small pointer payload is stored in the batch');
const matrixCopy = new DataView(matrixCommand.capture.buffer,
  matrixCommand.capture.pointerOffset, matrixCommand.capture.pointerLength);
assert.deepStrictEqual([0, 1, 15].map(i => matrixCopy.getFloat32(i * 4, true)),
  [0.25, 1.25, 15.25], 'queued pointer input survives guest scratch reuse');

// glBegin/glEnd traffic is compiled locally into one interleaved geometry
// record. Boundary-sensitive fans are expanded so adjacent records can later
// be concatenated safely by the fixed-function frontend.
const packedCalls = [];
const sparseColor = 0x4e306060, colorBacking = 0x600;
const sparseVertex = 0x4e306080, vertexBacking = 0x620;
const packedEncoder = new Stream.Encoder({
  getMemory: () => memory,
  guestToWasm: pointer => pointer === sparseColor ? colorBacking
    : pointer === sparseVertex ? vertexBacking : pointer,
  capacity: 2048,
  shared: false,
  submit: batch => Stream.replay(batch, (opcode, mode, capture) => {
    packedCalls.push({ opcode, mode, capture });
    return 0;
  }),
});
const setFloatArgs = values => values.forEach((value, i) => dv.setFloat32(stack + 4 + i * 4, value, true));
dv.setUint32(stack + 4, 0x1D00, true); // GL_FLAT stays encoder-local.
packedEncoder.call(19, stack, 0);
dv.setUint32(stack + 4, 0x0006, true); // GL_TRIANGLE_FAN
packedEncoder.call(21, stack, 0);
setFloatArgs([0.25, 0.5, 0.75, 1]);
packedEncoder.call(25, stack, 0);
// GoldSrc resolves this scalar extension dynamically rather than using the
// vector glColor4ubv form. It must update packed immediate-mode state without
// forcing a Worker round trip.
[0xFF, 0, 0xFF, 0].forEach((value, i) => dv.setUint32(stack + 4 + i * 4, value, true));
packedEncoder.call(56, stack, 0);
new Uint8Array(memory, colorBacking, 3).set([0x20, 0x80, 0xFE]);
dv.setUint32(stack + 4, sparseColor, true);
packedEncoder.call(58, stack, 0);
setFloatArgs([0.125, 0.875]);
packedEncoder.call(28, stack, 0);
for (const [index, vertexValues] of [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]].entries()) {
  if (index === 0) {
    vertexValues.forEach((value, i) => dv.setFloat32(vertexBacking + i * 4, value, true));
    dv.setUint32(stack + 4, sparseVertex, true);
    packedEncoder.call(31, stack, 0);
    [9, 9, 9].forEach((value, i) => dv.setFloat32(vertexBacking + i * 4, value, true));
    continue;
  }
  setFloatArgs(vertexValues);
  packedEncoder.call(30, stack, 0);
}
packedEncoder.call(22, stack, 0);
packedEncoder.call(11, stack, 0);
assert.deepStrictEqual(packedCalls.map(call => call.opcode), [Stream.PACKED_DRAW_OPCODE, 11],
  'immediate calls collapse into one internal draw command');
assert.strictEqual(packedCalls[0].mode, 0x0004, 'triangle fan is normalized to independent triangles');
assert.strictEqual(packedCalls[0].capture.pointerLength, 6 * 9 * 4,
  'four fan vertices compile to two interleaved triangles');
const packedVertices = new Float32Array(packedCalls[0].capture.buffer,
  packedCalls[0].capture.pointerOffset, packedCalls[0].capture.pointerLength / 4);
assert.deepStrictEqual(Array.from(packedVertices.slice(3, 9)),
  Array.from(new Float32Array([0x20 / 255, 0x80 / 255, 0xFE / 255, 1, 0.125, 0.875])),
  'sparse vector color and vertex pointers reach packed geometry through guest_to_wasm');
const packedCommandCount = packedEncoder.commands;
packedEncoder.call(31, stack, 0);
packedEncoder.call(22, stack, 0);
assert.strictEqual(packedEncoder.commands, packedCommandCount,
  'unmatched immediate calls remain guest no-ops and cannot leak into replay');

// Capacity pressure submits an execution batch but cannot publish a frame.
let presents = 0;
const overflowOpcodes = [];
const overflow = new Stream.Encoder({
  getMemory: () => memory,
  guestToWasm: pointer => pointer,
  capacity: 256,
  shared: false,
  submit: batch => Stream.replay(batch, opcode => {
    overflowOpcodes.push(opcode);
    if (opcode === 55) presents++;
    return opcode === 55 ? 1 : 0;
  }),
});
dv.setUint32(stack + 4, 0x0BE2, true);
for (let i = 0; i < 12; i++) overflow.call(10, stack, 0); // glEnable
assert(overflow.submissions > 0, 'full command buffer submits before overflow');
assert.strictEqual(presents, 0, 'overflow submission does not implicitly present');
assert.strictEqual(overflow.call(55, stack, 0), 1, 'explicit presentation is a barrier');
assert.strictEqual(presents, 1, 'only gpuPresent publishes a frame');
assert.strictEqual(overflowOpcodes.at(-1), 55);

// Texture pixels are deliberately absent from the command buffer. The upload
// is isolated and replayed synchronously while the guest is parked, so replay
// can borrow the original shared guest allocation without a staging copy.
const texture = 0x1000;
const textureBytes = 64 * 64 * 4;
new Uint8Array(memory, texture, textureBytes).fill(0xA7);
for (let i = 0; i < 9; i++) dv.setUint32(stack + 4 + i * 4, 0, true);
dv.setUint32(stack + 4 + 3 * 4, 64, true);      // width
dv.setUint32(stack + 4 + 4 * 4, 64, true);      // height
dv.setUint32(stack + 4 + 6 * 4, 0x1908, true);  // GL_RGBA
dv.setUint32(stack + 4 + 7 * 4, 0x1401, true);  // GL_UNSIGNED_BYTE
dv.setUint32(stack + 4 + 8 * 4, texture, true);
let borrowed = null;
const textureOpcodes = [];
const textureEncoder = new Stream.Encoder({
  getMemory: () => memory,
  guestToWasm: pointer => pointer,
  shared: false,
  submit: batch => Stream.replay(batch, (opcode, _aux, capture) => {
    textureOpcodes.push(opcode);
    if (opcode !== 45) return 0;
    borrowed = capture;
    const direct = new Uint8Array(memory, texture, capture.pointerLength);
    assert.strictEqual(direct[0], 0xA7, 'replay reads the live guest allocation');
    return 0;
  }),
});
dv.setUint32(stack + 4, 0x0BE2, true);
textureEncoder.call(10, stack, 0); // queued before the synchronous upload
for (let i = 0; i < 9; i++) dv.setUint32(stack + 4 + i * 4, 0, true);
dv.setUint32(stack + 4 + 3 * 4, 64, true);
dv.setUint32(stack + 4 + 4 * 4, 64, true);
dv.setUint32(stack + 4 + 6 * 4, 0x1908, true);
dv.setUint32(stack + 4 + 7 * 4, 0x1401, true);
dv.setUint32(stack + 4 + 8 * 4, texture, true);
textureEncoder.call(45, stack, 0);
assert.strictEqual(textureEncoder.submissions, 1,
  'borrowed texture upload appends to pending work and submits once');
assert.deepStrictEqual(textureOpcodes, [10, 45], 'single texture submission preserves command order');
assert(borrowed && borrowed.pointerBorrowed, 'large texture is marked as borrowed guest memory');
assert.strictEqual(borrowed.pointerOffset, 0, 'texture bytes are not copied into the command buffer');
assert.strictEqual(borrowed.pointerLength, textureBytes);
assert(borrowed.stackBytes + Stream.HEADER_BYTES < 128,
  'large upload batch contains only command metadata and arguments');
let replayPixels = null;
const bridge = new OpenGLHostBridge({
  getMemory: () => memory,
  exports: { guest_to_wasm: pointer => pointer },
});
assert.strictEqual(bridge._dv(), bridge._dv(),
  'host replay reuses one DataView for fixed guest memory');
bridge.current = 1;
bridge.contexts.set(1, {
  frontend: {
    gl: {},
    texImage(_level, _internal, _width, _height, _border, _format, _type, pixels) {
      replayPixels = pixels;
    },
  },
});
const bridgeEncoder = new Stream.Encoder({
  getMemory: () => memory,
  guestToWasm: pointer => pointer,
  shared: false,
  submit: batch => bridge.replay(batch),
});
bridgeEncoder.call(45, stack, 0);
assert.strictEqual(replayPixels.buffer, memory,
  'GL frontend receives a view of guest memory, not a copied texture payload');
assert.strictEqual(replayPixels.byteOffset, texture);

// A buffered stream can outlive another guest thread's wglMakeCurrent call.
// Replay therefore resolves the current context by originating Worker slot.
const ownerCalls = [];
const ownerBridge = new OpenGLHostBridge({ getMemory: () => memory, exports: {} });
ownerBridge.contexts.set(11, { frontend: { gl: {}, setEnabled: value => ownerCalls.push(['a', value]) } });
ownerBridge.contexts.set(22, { frontend: { gl: {}, setEnabled: value => ownerCalls.push(['b', value]) } });
ownerBridge.currentByOwner.set(1, 11);
ownerBridge.currentByOwner.set(2, 22);
dv.setUint32(stack + 4, 0x0BE2, true);
const ownerBatches = [];
const ownerEncoder = new Stream.Encoder({
  getMemory: () => memory,
  guestToWasm: pointer => pointer,
  shared: false,
  submit: batch => { ownerBatches.push({ ...batch }); return 0; },
});
ownerEncoder.call(10, stack, 0);
ownerEncoder.flush();
ownerBridge.replay(ownerBatches[0], 2);
ownerBridge.replay(ownerBatches[0], 1);
assert.deepStrictEqual(ownerCalls, [['b', 0x0BE2], ['a', 0x0BE2]],
  'batch replay retains per-thread WGL current-context ownership');

// Pin the Worker-side protocol endpoint independently of WebGL: one pending
// RPC status is acknowledged only after the whole batch has replayed.
const rpcMemory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
const rpcView = RPC.views(rpcMemory, 0).i32;
const brokerOps = [];
const broker = RPC.createMainBroker(rpcMemory, {
  gpu_gl_batch: batch => Stream.replay(batch, opcode => { brokerOps.push(opcode); return 77; }),
}, {});
let brokerBatch = null;
const brokerEncoder = new Stream.Encoder({
  getMemory: () => memory,
  guestToWasm: pointer => pointer,
  shared: false,
  submit: batch => { brokerBatch = batch; return 0; },
});
brokerEncoder.call(10, stack, 0);
brokerEncoder.call(12, stack, 0);
Atomics.store(rpcView, RPC.SLOT.STATUS, RPC.STATUS_REQ);
assert.strictEqual(broker.serveGlBatch({ slot: 0, batch: brokerBatch }), true);
assert.deepStrictEqual(brokerOps, [10, 12], 'main broker replays one ordered GL batch');
assert.strictEqual(Atomics.load(rpcView, RPC.SLOT.RESULT), 77);
assert.strictEqual(Atomics.load(rpcView, RPC.SLOT.STATUS), RPC.STATUS_RESP,
  'worker is acknowledged only after replay completes');

console.log('PASS buffered OpenGL ordering, overflow, barriers, and zero-copy textures');

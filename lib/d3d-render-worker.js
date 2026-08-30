// Consumer for lib/d3d-command-stream.js. It instantiates the same module over
// shared memory with inert host imports: D3DIM rasterization is WAT-native and
// presentation remains fenced on the ordinary browser-owner path.
'use strict';

const IS_WEB = typeof importScripts === 'function';
let parentPort = null;
if (!IS_WEB) parentPort = require('worker_threads').parentPort;
const send = IS_WEB ? (msg => self.postMessage(msg)) : (msg => parentPort.postMessage(msg));
const listen = IS_WEB
  ? (fn => { self.onmessage = event => fn(event.data || {}); })
  : (fn => parentPort.on('message', msg => fn(msg || {})));

let instance = null;
let memory = null;
let control = null;
let buffers = null;
let stateGuest = 0;
let verticesGuest = 0;
let initializedImage = 0;
let targetBytes = null;
const CTRL = {
  READY: 0, COMPLETED: 1, ERROR: 2,
  BATCHES: 4, COMMANDS: 5, REPLAY_US: 6,
};
const HEADER_BYTES = 32;
const STATE_BYTES = 4096;
const VERTEX_CAPACITY = 0x400000;

function inertImports(sigs) {
  const host = { memory };
  for (const [name, sig] of Object.entries(sigs || {})) {
    host[name] = sig.results && sig.results.length ? (() => 0) : (() => {});
  }
  return { host };
}

function ensureWorkspace(imageBase) {
  imageBase >>>= 0;
  if (initializedImage === imageBase && stateGuest && verticesGuest) return;
  if (initializedImage) throw new Error('D3D render Worker image base changed');
  const ex = instance.exports;
  // Renderer-only initialization establishes address translation and a private
  // heap arena without assigning a guest thread's page/cache partitions.
  ex.d3dim_worker_init(imageBase);
  stateGuest = ex.guest_alloc(STATE_BYTES) >>> 0;
  verticesGuest = ex.guest_alloc(VERTEX_CAPACITY) >>> 0;
  if (!stateGuest || !verticesGuest) throw new Error('D3D render Worker workspace allocation failed');
  initializedImage = imageBase;
}

function replay(msg) {
  ensureWorkspace(msg.imageBase);
  const source = buffers[msg.index | 0];
  const limit = Math.min(msg.bytes >>> 0, source.buffer.byteLength >>> 0);
  const view = source.view;
  const bytes = source.bytes;
  const ex = instance.exports;
  const stateWa = ex.guest_to_wasm(stateGuest) >>> 0;
  const verticesWa = ex.guest_to_wasm(verticesGuest) >>> 0;
  let offset = 0;
  let commands = 0;
  while (offset < limit) {
    if (offset + HEADER_BYTES > limit) throw new RangeError('truncated D3D command header');
    const recordBytes = view.getUint32(offset, true);
    const stateBytes = view.getUint32(offset + 20, true);
    const vertexBytes = view.getUint32(offset + 24, true);
    if (recordBytes < HEADER_BYTES + STATE_BYTES || offset + recordBytes > limit
        || stateBytes !== STATE_BYTES || vertexBytes > VERTEX_CAPACITY
        || HEADER_BYTES + stateBytes + vertexBytes > recordBytes) {
      throw new RangeError('invalid D3D command record');
    }
    targetBytes.set(bytes.subarray(offset + HEADER_BYTES,
      offset + HEADER_BYTES + stateBytes), stateWa);
    targetBytes.set(bytes.subarray(offset + HEADER_BYTES + stateBytes,
      offset + HEADER_BYTES + stateBytes + vertexBytes), verticesWa);
    ex.d3dim_worker_draw(
      view.getUint32(offset + 4, true), view.getUint32(offset + 8, true),
      view.getUint32(offset + 12, true), verticesGuest,
      view.getUint32(offset + 16, true), stateGuest);
    offset += recordBytes;
    commands++;
  }
  if (offset !== limit || commands !== (msg.commands | 0)) {
    throw new RangeError('D3D command batch count mismatch');
  }
}

listen(async msg => {
  try {
    if (msg.t === 'init') {
      memory = msg.memory;
      control = new Int32Array(msg.control);
      buffers = msg.buffers.map(buffer => ({
        buffer, view: new DataView(buffer), bytes: new Uint8Array(buffer),
      }));
      targetBytes = new Uint8Array(memory.buffer);
      const result = await WebAssembly.instantiate(msg.module, inertImports(msg.sigs));
      instance = result.exports ? result : (result.instance || result);
      if (!instance.exports.d3dim_worker_init || !instance.exports.d3dim_worker_draw) {
        throw new Error('D3D render Worker exports missing');
      }
      Atomics.store(control, CTRL.READY, 1);
      Atomics.notify(control, CTRL.READY);
      send({ t: 'ready' });
      return;
    }
    if (msg.t === 'batch') {
      const started = performance.now();
      replay(msg);
      Atomics.add(control, CTRL.BATCHES, 1);
      Atomics.add(control, CTRL.COMMANDS, msg.commands | 0);
      Atomics.add(control, CTRL.REPLAY_US,
        Math.max(0, Math.round((performance.now() - started) * 1000)));
      Atomics.store(control, CTRL.COMPLETED, msg.seq | 0);
      Atomics.notify(control, CTRL.COMPLETED);
    }
  } catch (error) {
    if (control) {
      Atomics.store(control, CTRL.ERROR, 1);
      Atomics.notify(control, CTRL.COMPLETED);
      Atomics.notify(control, CTRL.READY);
    }
    send({ t: 'error', error: String(error && error.stack || error) });
  }
});

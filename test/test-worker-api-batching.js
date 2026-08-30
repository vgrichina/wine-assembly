#!/usr/bin/env node
'use strict';

// AoE2's gameplay loop exposed two artificial Worker transports: every API
// dispatch posted no-op logging messages, and GetKeyboardState parked once for
// each of its 256 entries. Keep normal logging local and snapshot the keyboard
// through one pointer-safe synchronous import.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const RPC = require('../lib/guest-rpc');
const D3D = require('../lib/d3d-command-stream');
const { createWindowHost } = require('../lib/host-window');

const ROOT = path.resolve(__dirname, '..');

// The Worker import factory creates views at THREAD_RPC near the end of the
// fixed 512MB address space. SharedArrayBuffer reserves this virtually; the
// test touches only one 256-byte control block.
const memory = { buffer: new SharedArrayBuffer(8192 * 65536) };
const sigs = {
  log: { params: ['i32', 'i32'], results: [] },
  log_i32: { params: ['i32'], results: [] },
  log_api_exit: { params: [], results: [] },
  dx_trace: { params: ['i32', 'i32', 'i32', 'i32', 'i32'], results: [] },
};

let posted = 0;
const quiet = RPC.createWorkerImports(memory, sigs, () => { posted++; }, {
  slot: 0,
  forwardGlLogs: false,
});
quiet.imports.host.log(0, 0);
quiet.imports.host.log_i32(0xC0DE0001);
quiet.imports.host.log_api_exit();
assert.strictEqual(posted, 0,
  'trace-disabled API hooks must not post messages to the browser');
assert.deepStrictEqual(quiet.stats, { sync: 0, async: 0, local: 3 },
  'suppressed hooks are reported as Worker-local work');

const beforeDx = posted;
quiet.imports.host.dx_trace(15, 7, 4, 0x1c4, 12);
assert.strictEqual(posted, beforeDx + 1,
  'D3D trace values use ordered fire-and-forget Worker transport');
assert.deepStrictEqual(quiet.stats, { sync: 0, async: 1, local: 3 },
  'D3D trace must never add a synchronous Worker round trip');

const tracedMessages = [];
const traced = RPC.createWorkerImports(memory, sigs, message => tracedMessages.push(message), {
  slot: 0,
  forwardGlLogs: true,
});
traced.imports.host.log(0, 0);
traced.imports.host.log_i32(0xC0DE0001);
traced.imports.host.log_api_exit();
assert.strictEqual(tracedMessages.length, 3,
  'verbose/API-trace mode must preserve all three logging hooks');
assert(tracedMessages.every(message => message.t === 'call'),
  'enabled logging remains ordered fire-and-forget transport');

const keyboardMemory = new ArrayBuffer(1024);
const renderer = {
  peekKeyDownState(vKey) {
    return vKey === 0x01 || vKey === 0x41 ? 0x8000 : 0;
  },
};
const windowHost = createWindowHost({
  renderer,
  getMemory: () => keyboardMemory,
}, {
  readStr: () => '',
  readStrW: () => '',
  cursorCssForHandle: () => '',
  cursorCssFromPixels: () => '',
  builtCursorCssFor: () => '',
});
assert.strictEqual(windowHost.imports.get_keyboard_state(128), 1,
  'keyboard snapshot succeeds for an in-bounds 256-byte destination');
const keys = new Uint8Array(keyboardMemory, 128, 256);
assert.strictEqual(keys[0x01], 0x80, 'mouse-button VK state is included');
assert.strictEqual(keys[0x41], 0x80, 'held keyboard VK state is included');
assert.strictEqual(keys[0x40], 0, 'released keys remain clear');
assert.strictEqual(windowHost.imports.get_keyboard_state(900), 0,
  'out-of-bounds snapshots fail without partially writing memory');

const wat = fs.readFileSync(path.join(ROOT, 'src/09a-handlers.wat'), 'utf8');
const begin = wat.indexOf('(func $handle_GetKeyboardState');
const end = wat.indexOf('\n  (func ', begin + 1);
assert(begin >= 0 && end > begin, 'GetKeyboardState handler is present');
const handler = wat.slice(begin, end);
assert(handler.includes('(call $host_get_keyboard_state'),
  'GetKeyboardState uses the batched host snapshot');
assert(!handler.includes('$host_get_key_down_state') && !handler.includes('(loop'),
  'GetKeyboardState no longer performs 256 scalar host calls');

const generated = require('../lib/host-import-sigs.generated.json');
assert.deepStrictEqual(generated.sigs.get_keyboard_state,
  { params: ['i32'], results: ['i32'] },
  'generated Worker signature includes the snapshot import');

// D3DIM's opt-in Worker transport must own every byte before the guest handler
// frees/reuses its temporary packed vertices. A synchronous fake consumer also
// exercises sequence publication and the mandatory fence without timing races.
const d3dMemory = { buffer: new SharedArrayBuffer(16384) };
const d3dBytes = new Uint8Array(d3dMemory.buffer);
const descriptor = 64;
const state = 512;
const vertices = 8192;
new Uint32Array(d3dMemory.buffer, descriptor, 6).set([
  0x1000, 4, 3, vertices, 3, state,
]);
d3dBytes.fill(0x5a, state, state + D3D.STATE_BYTES);
d3dBytes.fill(0xa5, vertices, vertices + 96);
const replayed = [];
class FakeRenderWorker {
  postMessage(message) {
    if (message.t === 'init') {
      this.control = new Int32Array(message.control);
      this.buffers = message.buffers;
      Atomics.store(this.control, D3D.CTRL.READY, 1);
      return;
    }
    if (message.t === 'batch') {
      replayed.push(new Uint8Array(this.buffers[message.index], 0, message.bytes).slice());
      Atomics.store(this.control, D3D.CTRL.COMPLETED, message.seq);
      Atomics.notify(this.control, D3D.CTRL.COMPLETED);
    }
  }
  terminate() {}
}
const d3d = new D3D.Encoder({
  memory: d3dMemory, module: {}, sigs: {}, capacity: 8192, bufferCount: 2,
  guestToWasm: value => value, getImageBase: () => 0x400000,
  workerFactory: () => new FakeRenderWorker(),
});
assert.strictEqual(d3d.call(D3D.DRAW_OPCODE, descriptor), 1,
  'valid D3DIM draw is accepted by the render command stream');
d3dBytes.fill(0, state, state + D3D.STATE_BYTES);
d3dBytes.fill(0, vertices, vertices + 96);
assert.strictEqual(d3d.call(D3D.FENCE_OPCODE, 0), 1,
  'D3DIM fence waits through the last submitted sequence');
assert.strictEqual(replayed.length, 1, 'fence submitted exactly one pending batch');
assert.strictEqual(replayed[0][D3D.HEADER_BYTES], 0x5a,
  'device state was copied before the guest reused it');
assert.strictEqual(replayed[0][D3D.HEADER_BYTES + D3D.STATE_BYTES], 0xa5,
  'canonical vertices were copied before the guest freed them');
assert.deepStrictEqual(d3d.stats,
  {
    queued: 1, submissions: 1, fences: 1, waits: 0, fallbacks: 0,
    bytes: D3D.STATE_BYTES + 96, waitMs: 0,
    maxBatchBytes: D3D.HEADER_BYTES + D3D.STATE_BYTES + 96,
  },
  'single draw/fence command accounting is exact');
assert.strictEqual(d3d.call(D3D.FENCE_OPCODE, 0), 1,
  'an idle fence still observes the completed sequence');
assert.strictEqual(replayed.length, 1,
  'an idle fence must not resubmit stale bytes from a rotated ring slot');

console.log('PASS Worker API logging, keyboard snapshots, and D3D draws are batched');

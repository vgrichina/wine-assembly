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

console.log('PASS Worker API logging and keyboard snapshots are batched');

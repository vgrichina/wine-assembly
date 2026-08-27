#!/usr/bin/env node
'use strict';

// Threads mode holds browser repaint publication to the end of a guest slice
// so a WM_PAINT erase cannot become visible before its text draw. Input that
// arrives during a long slice must therefore create an early *complete-block*
// boundary, or edit text can sit invisibly until the remaining budget expires.

const assert = require('assert');
const RPC = require('../lib/guest-rpc');
const { installInputHandlers } = require('../lib/renderer-input');
const { bootRenderHarness } = require('./render-helper');

class RendererProbe {
  constructor() {
    this.inputQueue = [];
    this.windows = {};
    this.wasm = null;
    this.mainWasm = null;
    this._exited = false;
    this._inputPendingPublishers = new Set();
  }
}
installInputHandlers(RendererProbe);

(async () => {
  assert.strictEqual(RPC.SLOT.INPUT_WAKE, 9, 'JS and WAT reserve RPC slot 9 for input wake');

  const publishedMemory = new WebAssembly.Memory({
    initial: 8192, maximum: 8192, shared: true,
  });
  const broker = RPC.createMainBroker(publishedMemory, {}, {});
  const publishedRpc = new Int32Array(
    publishedMemory.buffer, RPC.RPC_BASE, RPC.CTRL_INTS);
  broker.publish({ inputPending: 3, inputWake: true });
  assert.strictEqual(Atomics.load(publishedRpc, RPC.SLOT.INPUT_PENDING), 3,
    'main broker publishes the live input queue depth');
  assert.strictEqual(Atomics.load(publishedRpc, RPC.SLOT.INPUT_WAKE), 1,
    'main broker publishes the one-shot wake independently of queue depth');

  const renderer = new RendererProbe();
  renderer._keyboardOwnerRunsInGuestWorker = () => true;
  const published = [];
  renderer._inputPendingPublishers.add((depth, wake) => published.push({ depth, wake }));
  renderer.handleKeyDown(0x43, { code: 'KeyC' });
  renderer.handleKeyPress(0x43);
  renderer.handleKeyUp(0x43, { code: 'KeyC' });
  assert.deepStrictEqual(published, [
    { depth: 1, wake: true },
    { depth: 2, wake: true },
    { depth: 3, wake: true },
  ], 'each Worker keyboard message publishes queue depth and a wake pulse');
  renderer.takeInput();
  assert.deepStrictEqual(published[published.length - 1], { depth: 2, wake: false },
    'dequeue republishes depth without creating another wake pulse');

  const { exports: e, memory } = await bootRenderHarness({ fonts: 'none' });
  const code = 0x00030000;
  e.guest_write8(code, 0xeb); // jmp $-2: one stable block per dispatch
  e.guest_write8(code + 1, 0xfe);
  e.set_eip(code);
  const rpc = new Int32Array(memory.buffer, RPC.RPC_BASE, RPC.CTRL_INTS);

  e.set_current_thread_id(2);
  Atomics.store(rpc, RPC.SLOT.INPUT_WAKE, 1);
  e.run(5);
  assert.strictEqual(e.get_last_run_blocks(), 5,
    'a guest-created thread keeps its slice budget');
  assert.strictEqual(Atomics.load(rpc, RPC.SLOT.INPUT_WAKE), 1,
    'a guest-created thread cannot consume slot 0 input wake');

  e.set_current_thread_id(1);
  e.run(100000);
  assert.strictEqual(e.get_last_run_blocks(), 0,
    'guest main returns before starting another block after the wake');
  assert.strictEqual(e.get_last_run_halt(), 3,
    'input wake reports an ordinary cooperative boundary');
  assert.strictEqual(Atomics.load(rpc, RPC.SLOT.INPUT_WAKE), 0,
    'input wake is consumed once so the next slice runs normally');

  e.run(5);
  assert.strictEqual(e.get_last_run_blocks(), 5,
    'the slice after the one-shot wake receives its normal budget');

  console.log('PASS Worker keyboard input ends only slot 0 current slice at a complete block');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

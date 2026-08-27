#!/usr/bin/env node
'use strict';

// Threads mode holds browser repaint publication to the end of a guest slice
// so a WM_PAINT erase cannot become visible before its text draw. Input that
// arrives during a long slice must therefore create an early *complete-block*
// boundary, or edit text can sit invisibly until the remaining budget expires.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
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

  // Ending the slice that was already running is only half the latency fix.
  // The following slice dequeues and paints the key; if it receives the normal
  // 100k budget, that completed paint is still held from the browser for the
  // duration of a second long slice. Exercise the actual browser drive loop
  // with a controllable Worker to keep the post-input slices short.
  const hostSource = fs.readFileSync(path.join(__dirname, '..', 'host.js'), 'utf8');
  const context = { URLSearchParams, console, setTimeout };
  vm.runInNewContext(hostSource + '\n;globalThis.WineAssembly = WineAssembly;', context);
  const wine = new context.WineAssembly();
  const scheduled = [];
  const sliceSteps = [];
  const sliceResolvers = [];
  wine._scheduleStep = step => scheduled.push(step);
  wine._beginGuestTickBatch = () => {};
  wine._guestTickMs = () => 0;
  wine._presentDxIfDirty = () => {};
  wine.renderer = {
    inputQueue: [], _inputPendingPublishers: new Set(),
    beginWorkerGuestSlice() {}, endWorkerGuestSlice() {}, flushRepaint() {},
  };
  wine.guestWorker = {
    broker: { publish() {} },
    slice(steps) {
      sliceSteps.push(steps);
      return new Promise(resolve => sliceResolvers.push(resolve));
    },
  };
  wine._runThreaded(100000);
  assert.deepStrictEqual(sliceSteps, [100000], 'idle Worker begins with its configured slice');
  sliceResolvers.shift()({ eip: 1, yield: 0, focusHwnd: 0, blocks: 100000, ms: 200 });
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(scheduled.length, 1, 'completed full slice schedules its successor');
  scheduled.shift()();
  assert.deepStrictEqual(sliceSteps, [100000, 6000],
    'a 200ms full slice adapts to a presentation-sized 12ms block budget');
  for (const publish of wine.renderer._inputPendingPublishers) publish(3, true);
  sliceResolvers.shift()({ eip: 1, yield: 0, focusHwnd: 0, blocks: 6000, ms: 12 });
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(scheduled.length, 1, 'adapted in-flight slice schedules its successor');
  scheduled.shift()();
  assert.deepStrictEqual(sliceSteps, [100000, 6000, 1000],
    'the slice that dequeues and paints keyboard input is capped at 1k blocks');
  wine.running = false;
  sliceResolvers.shift()({ eip: 1, yield: 0, focusHwnd: 0, blocks: 1000, ms: 2 });
  await new Promise(resolve => setImmediate(resolve));

  console.log('PASS Worker keyboard input creates complete-block and short presentation boundaries');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

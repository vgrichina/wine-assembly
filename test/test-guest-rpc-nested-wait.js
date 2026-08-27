#!/usr/bin/env node
'use strict';

// A wait reached from inside a synchronous WndProc cannot return the emulator's
// scheduler sentinel: doing so unwinds the recursive interpreter frame. Worker
// guests park locally on the shared event/semaphore table instead, leaving the
// browser thread free to service the worker that will signal the object.

const assert = require('assert');
const path = require('path');
const { Worker } = require('worker_threads');
const RPC = require('../lib/guest-rpc');
const { GuestThreadHost } = require('../lib/guest-thread-host');
const { ThreadManager } = require('../lib/thread-manager');

const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
const sync = new Int32Array(
  memory.buffer, RPC.SYNC_TABLE, RPC.SYNC_OBJECTS * RPC.SYNC_ENTRY_INTS);

function publish(index, handle, type, state, extra) {
  const base = index * RPC.SYNC_ENTRY_INTS;
  Atomics.store(sync, base + 2, state | 0);
  Atomics.store(sync, base + 3, extra | 0);
  Atomics.store(sync, base + 0, handle | 0);
  Atomics.store(sync, base + 1, type | 0);
  return base;
}

function beginWorkerWait(handles, waitAll, timeout) {
  const source = `
    const { parentPort, workerData } = require('worker_threads');
    const RPC = require(workerData.rpcPath);
    parentPort.postMessage('ready');
    const result = RPC.waitSharedSyncObjects(
      workerData.memory, workerData.handles, workerData.waitAll, workerData.timeout);
    parentPort.postMessage({ result });
  `;
  const worker = new Worker(source, {
    eval: true,
    workerData: {
      rpcPath: path.join(__dirname, '..', 'lib', 'guest-rpc.js'),
      memory, handles, waitAll, timeout,
    },
  });
  return new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.once('message', message => {
      assert.strictEqual(message, 'ready');
      const result = new Promise((done, fail) => {
        worker.once('error', fail);
        worker.once('message', result => {
          worker.terminate().finally(() => done(result.result));
        });
      });
      resolve({ worker, result });
    });
  });
}

async function main() {
  assert.strictEqual(ThreadManager.prototype.pumpThreadsOnce.call({
    workerBackend: {},
    _runningThreadHandle: 0,
    runSlice: () => { throw new Error('cooperative scheduler must not run'); },
  }), 0, 'cs_pump is an explicit no-op for the real Worker backend');

  const event = 0x0E000042;
  const eventBase = publish(0, event, 1, 0, 0); // auto-reset, unsignaled
  const eventWait = await beginWorkerWait([event], false, 1000);
  setTimeout(() => {
    Atomics.store(sync, eventBase + 2, 1);
    Atomics.notify(sync, eventBase + 2);
  }, 20);
  assert.strictEqual(await eventWait.result, 0, 'nested Worker wait wakes on SetEvent');
  assert.strictEqual(Atomics.load(sync, eventBase + 2), 0,
    'a successful wait consumes an auto-reset event');

  const first = 0x0E000043;
  const second = 0x0E000044;
  const firstBase = publish(1, first, 1, 1, 0);
  const secondBase = publish(2, second, 1, 0, 0);
  const allWait = await beginWorkerWait([first, second], true, 1000);
  setTimeout(() => {
    Atomics.store(sync, secondBase + 2, 1);
    Atomics.notify(sync, secondBase + 2);
  }, 20);
  assert.strictEqual(await allWait.result, 0, 'wait-all completes after every event is ready');
  assert.strictEqual(Atomics.load(sync, firstBase + 2), 0);
  assert.strictEqual(Atomics.load(sync, secondBase + 2), 0);

  const semaphore = 0x0E000045;
  publish(3, semaphore, 2, 2, 4);
  assert.strictEqual(RPC.waitSharedSyncObjects(memory, [event, semaphore], false, 0), 1,
    'wait-any reports the signaled semaphore index');
  assert.strictEqual(Atomics.load(sync, 3 * RPC.SYNC_ENTRY_INTS + 2), 1,
    'a successful semaphore wait consumes one count');
  assert.strictEqual(RPC.waitSharedSyncObjects(memory, [event], false, 0), 0x102,
    'a zero-time wait reports WAIT_TIMEOUT');
  assert.strictEqual(RPC.waitSharedSyncObjects(memory, [0xDEADBEEF], false, 0), null,
    'non-shared handles fall back to ThreadManager');

  // Exercise the actual import wrapper: nested depth takes the local path,
  // while depth zero still performs the ordinary broker handshake.
  const wrappedEvent = 0x0E000046;
  publish(4, wrappedEvent, 1, 1, 1); // manual-reset, signaled
  let depth = 1;
  const posts = [];
  const sigs = { wait_single: { params: ['i32', 'i32'], results: ['i32'] } };
  const built = RPC.createWorkerImports(memory, sigs, message => {
    posts.push(message.t);
    if (message.t !== 'rpc') return;
    assert.strictEqual(message.t, 'rpc');
    const block = RPC.views(memory, 0).i32;
    block[RPC.SLOT.RESULT] = 0x55;
    Atomics.store(block, RPC.SLOT.STATUS, RPC.STATUS_RESP);
    Atomics.notify(block, RPC.SLOT.STATUS);
  }, { getSyncMsgDepth: () => depth });
  assert.strictEqual(built.imports.host.wait_single(wrappedEvent, 0), 0);
  assert.deepStrictEqual(posts, ['nestedWaitBegin', 'nestedWaitEnd'],
    'nested event wait asks the host to keep secondary Workers moving');
  depth = 0;
  assert.strictEqual(built.imports.host.wait_single(wrappedEvent, 0), 0x55);
  assert.strictEqual(posts.filter(type => type === 'rpc').length, 1,
    'ordinary wait retains the broker path');

  const host = new GuestThreadHost({
    memory, module: {}, sigs: {}, hostImports: {}, clockIntervalMs: 0,
  });
  let slices = 0;
  host.threadManager = {
    runWorkerSlices: async () => {
      slices++;
      if (slices === 3) host._setNestedWaitActive(false);
      return slices === 1 ? 0 : 1;
    },
  };
  host._setNestedWaitActive(true);
  while (host._nestedWaitPump) await new Promise(resolve => setTimeout(resolve, 1));
  assert.strictEqual(slices, 3,
    'the host keeps driving secondary Worker slices until the nested wait ends');

  console.log('PASS guest Worker nested waits stay inside the recursive WndProc frame');
}

main().catch(error => { console.error(error); process.exit(1); });

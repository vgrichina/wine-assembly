#!/usr/bin/env node
'use strict';

// A late CreateThread can arrive after the direct low guest heap has reached
// emulator-private memory. Its stack then lives in the sparse high guest arena,
// so worker setup must use the WAT's full guest-to-WASM translation rather than
// assuming every allocation is image-relative.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { compileSrcWasm } = require('./compile-src');
const { createHostImports } = require('../lib/host-imports');
const { GuestThreadHost, WorkerLink } = require('../lib/guest-thread-host');

const root = path.join(__dirname, '..');

async function main() {
  // DLL bootstrap is another Worker protocol boundary. Safari/WebKit rejects
  // the complete message if a host callback survives anywhere in its object
  // graph, even when a Win16 app has no PE DLLs to load.
  {
    const host = new GuestThreadHost({
      memory: null, module: null, sigs: {}, hostImports: {},
    });
    let message = null;
    host.link = {
      _ask: async value => {
        message = value;
        structuredClone(value);
        return { results: [] };
      },
    };
    const bytes = Uint8Array.of(0x4D, 0x5A);
    const exeBytes = Uint8Array.of(0x4E, 0x45);
    const configs = [{
      name: 'CARDS.DLL', path: 'C:\\WINDOWS\\SYSTEM\\CARDS.DLL', bytes,
      provider: { read() {} },
    }];
    const opts = {
      exeName: 'WEP16_RODENT.EXE', extraArgs: '-test', maxBlocks: 1234,
      registerDllResources() {}, advanceGuestTime() {},
      nested: { callback() {} },
    };
    await host.loadDlls(configs, exeBytes, opts);
    assert.deepStrictEqual(Object.keys(message.configs[0]).sort(), ['bytes', 'name', 'path']);
    assert.deepStrictEqual(message.opts, {
      exeName: 'WEP16_RODENT.EXE', extraArgs: '-test', maxBlocks: 1234,
    });
    assert.strictEqual(message.configs[0].bytes, bytes);
    assert.strictEqual(message.exeBytes, exeBytes);
    assert.strictEqual(configs[0].provider.read instanceof Function, true,
      'marshalling must not mutate the caller config');
    assert.strictEqual(opts.advanceGuestTime instanceof Function, true,
      'marshalling must not mutate the caller options');

    const link = new WorkerLink({
      slot: 7, memory: null, module: null, sigs: {}, broker: {},
    });
    link.worker = {
      postMessage() { throw new Error('The object can not be cloned.'); },
    };
    await assert.rejects(link._ask({ t: 'loadDlls' }, 1000),
      /worker 7 could not post loadDlls: The object can not be cloned/);
    assert.strictEqual(link._pending.size, 0,
      'a synchronous structured-clone failure must clear the pending request');
  }

  const module = await WebAssembly.compile(compileSrcWasm());
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const ctx = {
    getMemory: () => memory.buffer,
    resourceJson: { menus: {}, dialogs: {}, strings: {}, bitmaps: {} },
    onExit: () => {},
  };
  const imports = createHostImports(ctx);
  imports.host.memory = memory;
  const sigs = JSON.parse(fs.readFileSync(
    path.join(root, 'lib', 'host-import-sigs.generated.json'), 'utf8')).sigs;
  const host = new GuestThreadHost({
    memory, module, sigs, hostImports: imports.host,
    workerUrl: path.join(root, 'lib', 'guest-worker.js'),
    clockIntervalMs: 0,
  });

  try {
    await host.start();
    const imageBase = 0x00400000;
    await host.callExport('init_thread', 0, imageBase, imageBase, 0x00600000,
      0x07500000, 0x07501000, 1, 1);
    // A 1MB private low-heap chunk starting here would cross PAGE_INDEX_ARENA
    // after g2w translation, forcing guest_alloc onto the sparse arena.
    const pageIndexArena = 0x04100000;
    const nearLowHeapEnd = imageBase + pageIndexArena - 0x12000 - 0x80000;
    await host.callExport('heap_init', nearLowHeapEnd);

    const thread = await host.spawnThread({
      tid: 1,
      imageBase,
      codeStart: imageBase,
      codeEnd: 0x00600000,
      thunkBase: 0x07500000,
      thunkEnd: 0x07501000,
      numThunks: 1,
      dllCount: 0,
      vlanIp: 0,
      tlsNextIndex: 0,
      stackSize: 0x10000,
      param: 0x12345678,
      startAddr: 0x00401000,
      hwndBase: 0x00020001,
    });
    assert(thread.stackBase >= 0x40000000,
      `expected sparse guest stack, got 0x${thread.stackBase.toString(16)}`);
    assert.strictEqual(await thread.callExport('guest_read32', thread.stackTop - 4),
      0x12345678);
    assert.strictEqual(await thread.callExport('guest_read32', thread.stackTop - 8), 0);
  } finally {
    host.stop();
  }

  console.log('PASS guest Worker clone boundary and sparse high-memory stack');
}

main().catch(error => { console.error(error); process.exit(1); });

#!/usr/bin/env node
'use strict';

// A late CreateThread can arrive after the direct low guest heap has reached
// emulator-private memory. Its stack then lives in the sparse high guest arena,
// so worker setup must use the WAT's full guest-to-WASM translation rather than
// assuming every allocation is image-relative.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { compileWat } = require('../lib/compile-wat');
const { createHostImports } = require('../lib/host-imports');
const { GuestThreadHost } = require('../lib/guest-thread-host');

const root = path.join(__dirname, '..');

async function main() {
  const module = await WebAssembly.compile(await compileWat(file =>
    fs.promises.readFile(path.join(root, 'src', file), 'utf8')));
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

  console.log('PASS guest Worker initializes a thread stack in sparse high memory');
}

main().catch(error => { console.error(error); process.exit(1); });

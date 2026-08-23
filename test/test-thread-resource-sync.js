#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { compileWat } = require('../lib/compile-wat');
const { createHostImports } = require('../lib/host-imports');

const IMAGE_BASE = 0x400000;
const RSRC_RVA = 0x16000;
const DATA_RVA = 0x17000;
const GUEST_WASM_BASE = 0x12000;
const g2w = guest => guest - IMAGE_BASE + GUEST_WASM_BASE;

(async () => {
  const src = path.join(__dirname, '..', 'src');
  const wasmBytes = await compileWat(file =>
    fs.promises.readFile(path.join(src, file), 'utf8'));
  const memory = new WebAssembly.Memory({
    initial: 8192, maximum: 8192, shared: true,
  });
  const ctx = {
    getMemory: () => memory.buffer,
    resourceJson: { menus: {}, dialogs: {}, strings: {}, bitmaps: {} },
    onExit: () => {},
  };
  const imports = createHostImports(ctx);
  imports.host.memory = memory;
  for (const name of ['create_thread', 'exit_thread', 'create_event',
    'set_event', 'reset_event', 'wait_single', 'wait_multiple']) {
    imports.host[name] = () => 0;
  }
  const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
  const wat = instance.exports;
  ctx.exports = wat;

  // A minimal PE RT_STRING tree: type 6 -> bundle 37 -> en-US -> DATA_RVA.
  // Bundle 37 contains ID 578 at slot 2, the Explorer "Start" string.
  const dv = new DataView(memory.buffer);
  const root = g2w(IMAGE_BASE + RSRC_RVA);
  const entry = (base, id, child) => {
    dv.setUint32(base + 16, id, true);
    dv.setUint32(base + 20, child, true);
    dv.setUint16(base + 14, 1, true);
  };
  entry(root, 6, 0x80000020);
  entry(root + 0x20, 37, 0x80000040);
  entry(root + 0x40, 0x0409, 0x00000060);
  dv.setUint32(root + 0x60, DATA_RVA, true);
  dv.setUint32(root + 0x64, 16, true);
  const data = g2w(IMAGE_BASE + DATA_RVA);
  dv.setUint16(data + 0, 0, true);
  dv.setUint16(data + 2, 0, true);
  dv.setUint16(data + 4, 5, true);
  for (const [i, ch] of [...'Start'].entries()) {
    dv.setUint16(data + 6 + i * 2, ch.charCodeAt(0), true);
  }

  wat.init_thread(1, IMAGE_BASE, 0, 0, 0, 0, 0, RSRC_RVA);
  assert.strictEqual(wat.get_rsrc_rva(), RSRC_RVA,
    'worker initialization copies the main PE resource-directory RVA');
  assert.strictEqual(wat.rsrc_find_data_wa(6, 37), data,
    'worker resource lookup reaches the process-shared EXE string bundle');

  console.log('PASS  worker instances inherit main PE resource metadata');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

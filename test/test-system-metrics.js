#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');

async function main() {
  const root = path.join(__dirname, '..');
  const wasm = await compileWat(file => fs.promises.readFile(path.join(root, 'src', file), 'utf8'));
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const imports = createHostImports({ getMemory: () => memory.buffer, renderer: null, resourceJson: {} });
  imports.host.memory = memory;
  imports.host.create_thread = () => 0;
  imports.host.exit_thread = () => 0;
  imports.host.create_event = () => 0;
  imports.host.set_event = () => 0;
  imports.host.reset_event = () => 0;
  imports.host.wait_single = () => 0;
  imports.host.wait_multiple = () => 0;
  imports.host.com_create_instance = () => 0x80004002;
  const { instance } = await WebAssembly.instantiate(wasm, imports);
  const wat = instance.exports;

  assert.strictEqual(wat.test_call_GetSystemMetrics(11), 32, 'SM_CXICON');
  assert.strictEqual(wat.test_call_GetSystemMetrics(12), 32, 'SM_CYICON');
  assert.strictEqual(wat.test_call_GetSystemMetrics(49), 16, 'SM_CXSMICON');
  assert.strictEqual(wat.test_call_GetSystemMetrics(50), 16, 'SM_CYSMICON');
  console.log('PASS  Win98 icon metrics are nonzero and image-list compatible');
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});

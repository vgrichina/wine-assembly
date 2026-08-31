#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileSrcWasm } = require('./compile-src');

async function main() {
  const root = path.join(__dirname, '..');
  const wasm = compileSrcWasm();
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const imports = createHostImports({ getMemory: () => memory.buffer, renderer: null, resourceJson: {} });
  imports.host.memory = memory;
  imports.host.create_thread = () => 0;
  imports.host.exit_thread = () => 0;
  imports.host.terminate_thread = () => 0;
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
  assert.strictEqual(wat.test_call_GetSystemMetrics(31), 18, 'SM_CYSIZE');
  assert.strictEqual(wat.test_call_GetSystemMetrics(32), 4, 'SM_CXFRAME');
  assert.strictEqual(wat.test_call_GetSystemMetrics(33), 4, 'SM_CYFRAME');
  assert.strictEqual(wat.test_call_GetSystemMetrics(45), 2, 'SM_CXEDGE');
  assert.strictEqual(wat.test_call_GetSystemMetrics(46), 2, 'SM_CYEDGE');
  assert.strictEqual(wat.test_call_GetSystemMetrics(49), 16, 'SM_CXSMICON');
  assert.strictEqual(wat.test_call_GetSystemMetrics(50), 16, 'SM_CYSMICON');
  assert.strictEqual(wat.test_call_GetSystemMetrics(31)
    + 2 * wat.test_call_GetSystemMetrics(33) + 1, 27,
  'Explorer tray baseline includes an 18px size button and the classic frame');
  console.log('PASS  Win98 classic icon and non-client sizing metrics');
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});

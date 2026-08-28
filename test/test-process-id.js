#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { compileWat } = require('../lib/compile-wat');
const { createHostImports } = require('../lib/host-imports');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

async function main() {
  const wasmBytes = await compileWat(file =>
    fs.promises.readFile(path.join(SRC, file), 'utf8'));
  const module = await WebAssembly.compile(wasmBytes);
  const memory = new WebAssembly.Memory({
    initial: 8192,
    maximum: 8192,
    shared: true,
  });
  const ctx = {
    getMemory: () => memory.buffer,
    processId: 4321,
    renderer: null,
    resourceJson: {},
  };
  const imports = createHostImports(ctx);
  imports.host.memory = memory;
  imports.host.create_thread = () => 0;
  imports.host.exit_thread = () => 0;
  imports.host.create_event = () => 0;
  imports.host.set_event = () => 0;
  imports.host.reset_event = () => 0;
  imports.host.wait_single = () => 0;
  imports.host.wait_multiple = () => 0;
  imports.host.com_create_instance = () => 0x80004002;

  const mainInstance = await WebAssembly.instantiate(module, imports);
  assert.strictEqual(mainInstance.exports.get_process_id(), 1000,
    'an unconfigured standalone process keeps the compatibility PID');
  mainInstance.exports.set_process_id(ctx.processId);
  assert.strictEqual(mainInstance.exports.get_process_id(), 4321,
    'the host-assigned PID is visible to the main thread');

  // ThreadManager creates another instance of the same module over this same
  // memory. Instantiation must neither erase nor fork process identity.
  const workerInstance = await WebAssembly.instantiate(module, imports);
  assert.strictEqual(workerInstance.exports.get_process_id(), 4321,
    'worker threads inherit the process PID through shared memory');
  workerInstance.exports.set_process_id(5678);
  assert.strictEqual(mainInstance.exports.get_process_id(), 5678,
    'all thread instances observe one process identity');

  assert.strictEqual(mainInstance.exports.test_reserve_tls_index(), 0,
    'the main thread reserves the first process TLS index');
  assert.strictEqual(workerInstance.exports.test_reserve_tls_index(), 1,
    'a worker reserves the next index rather than duplicating the main thread');
  assert.strictEqual(mainInstance.exports.get_tls_next_index(), 2,
    'the main thread observes the worker allocation through shared memory');
  workerInstance.exports.set_tls_next_index(1);
  assert.strictEqual(mainInstance.exports.get_tls_next_index(), 2,
    'stale spawn metadata cannot move the TLS cursor backwards');
  mainInstance.exports.set_tls_next_index(5);
  assert.strictEqual(workerInstance.exports.test_reserve_tls_index(), 5,
    'raising inherited metadata advances the same process cursor monotonically');
  for (let expected = 6; expected < 64; expected++) {
    const owner = expected & 1 ? mainInstance : workerInstance;
    assert.strictEqual(owner.exports.test_reserve_tls_index(), expected,
      `TLS reservation ${expected} is unique across instances`);
  }
  assert.strictEqual(mainInstance.exports.test_reserve_tls_index() >>> 0, 0xffffffff,
    'the 65th process TLS allocation reports TLS_OUT_OF_INDEXES');
  assert.strictEqual(workerInstance.exports.get_tls_next_index(), 64,
    'TLS exhaustion leaves the shared cursor at the 64-slot capacity');
  assert.strictEqual(mainInstance.exports.test_call_TlsGetValue(64), 0,
    'TlsGetValue rejects an index beyond the per-thread vector');
  assert.strictEqual(mainInstance.exports.test_call_TlsSetValue(64, 0x12345678), 0,
    'TlsSetValue rejects an index instead of writing past the TLS vector');
  assert.strictEqual(mainInstance.exports.test_call_TlsFree(64), 0,
    'TlsFree rejects an index beyond the process capacity');

  console.log('PASS  process IDs and TLS indexes are stable and shared by threads');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

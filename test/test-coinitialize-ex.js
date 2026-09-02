#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { ThreadManager } = require('../lib/thread-manager');
const { bootRenderHarness } = require('./render-helper');
const apiTable = require('../src/api_table.json');

const extraWat = String.raw`
  (func (export "test_co_initialize") (param $reserved i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_CoInitialize
      (local.get $reserved) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_co_initialize_ex")
      (param $reserved i32) (param $flags i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_CoInitializeEx
      (local.get $reserved) (local.get $flags) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_ole_initialize") (param $reserved i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_OleInitialize
      (local.get $reserved) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_co_uninitialize")
    (global.set $esp (i32.const 0x00300000))
    (call $handle_CoUninitialize
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0)))
  (func (export "test_ole_uninitialize")
    (global.set $esp (i32.const 0x00300000))
    (call $handle_OleUninitialize
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0)))
`;

(async () => {
  for (const [name, nargs] of [
    ['CoInitialize', 1], ['CoInitializeEx', 2], ['CoUninitialize', 0],
    ['OleInitialize', 1], ['OleUninitialize', 0],
  ]) {
    assert.strictEqual(apiTable.find(api => api.name === name).nargs, nargs,
      `${name} keeps its documented stdcall arity`);
  }

  let manager = null;
  const harness = await bootRenderHarness({
    extraWat,
    fonts: 'none',
    extraHostOverrides: {
      com_initialize_thread: (reserved, flags, tid) =>
        manager.initializeComApartment(reserved, flags, tid),
      com_uninitialize_thread: tid => manager.uninitializeComApartment(tid),
    },
  });
  const e = harness.exports;
  manager = new ThreadManager(null, harness.memory, harness.instance,
    () => ({ host: {} }), {});
  manager._log = () => {};

  const S_OK = 0;
  const S_FALSE = 1;
  const E_INVALIDARG = 0x80070057;
  const RPC_E_CHANGED_MODE = 0x80010106;
  const COINIT_MULTITHREADED = 0;
  const COINIT_APARTMENTTHREADED = 2;

  assert.strictEqual(e.test_co_initialize(1) >>> 0, E_INVALIDARG,
    'CoInitialize rejects its reserved pointer');
  assert.strictEqual(e.test_co_initialize_ex(0, 0x10) >>> 0, E_INVALIDARG,
    'CoInitializeEx rejects flags outside the Win32 COINIT set');
  assert.strictEqual(e.test_co_initialize_ex(0, COINIT_APARTMENTTHREADED), S_OK,
    'the first STA initialization returns S_OK');
  assert.strictEqual(e.get_esp() >>> 0, 0x0030000c,
    'CoInitializeEx pops its two arguments');
  assert.strictEqual(e.test_co_initialize(0), S_FALSE,
    'a nested compatible CoInitialize returns S_FALSE');
  assert.strictEqual(e.test_ole_initialize(0), S_FALSE,
    'OleInitialize shares the current STA apartment and nesting count');
  assert.strictEqual(e.get_esp() >>> 0, 0x00300008,
    'OleInitialize pops its one argument');
  assert.strictEqual(e.test_co_initialize_ex(0, COINIT_MULTITHREADED) >>> 0,
    RPC_E_CHANGED_MODE, 'an STA cannot be changed to MTA');

  e.test_co_uninitialize();
  e.test_ole_uninitialize();
  e.test_co_uninitialize();
  assert.strictEqual(e.get_esp() >>> 0, 0x00300004,
    'zero-argument uninitialization pops only the return address');
  assert.strictEqual(e.test_co_initialize_ex(0, COINIT_MULTITHREADED), S_OK,
    'balanced teardown permits clean MTA reinitialization');
  assert.strictEqual(e.test_ole_initialize(0) >>> 0, RPC_E_CHANGED_MODE,
    'OleInitialize cannot change an existing MTA into an STA');
  e.test_co_uninitialize();
  assert.strictEqual(e.test_ole_initialize(0), S_OK,
    'after MTA teardown OleInitialize can establish a new STA');
  e.test_ole_uninitialize();

  const workerHandle = manager.createThread(0x401000, 0, 0, 0, 0);
  assert(workerHandle, 'the manager exposes a distinct pending guest thread');
  e.set_current_thread_id(2);
  assert.strictEqual(e.test_co_initialize_ex(0, COINIT_MULTITHREADED), S_OK,
    'a guest worker owns an independent MTA apartment');
  e.set_current_thread_id(1);
  assert.strictEqual(e.test_ole_initialize(0), S_OK,
    'the main browser thread can independently own an STA');
  e.set_current_thread_id(2);
  assert.strictEqual(e.test_ole_initialize(0) >>> 0, RPC_E_CHANGED_MODE,
    'the worker MTA remains incompatible with OLE STA initialization');
  e.test_co_uninitialize();
  e.set_current_thread_id(1);
  e.test_ole_uninitialize();

  console.log('PASS COM/OLE initialization owns balanced per-thread Win98 apartments');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

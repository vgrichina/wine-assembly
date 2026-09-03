#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');
const { ThreadManager } = require('../lib/thread-manager');

const ROOT = path.join(__dirname, '..');

const extraWat = String.raw`
  (func (export "test_seed_dll_thread_flags")
    (global.set $dll_count (i32.const 2))
    (memory.fill (global.get $DLL_TABLE) (i32.const 0) (global.get $DLL_TABLE_SIZE))
    (memory.fill (global.get $DLL_FLAGS_TABLE) (i32.const 0) (global.get $DLL_FLAGS_TABLE_SIZE))
    (i32.store (global.get $DLL_TABLE) (i32.const 0x00600000))
    (i32.store offset=32 (global.get $DLL_TABLE) (i32.const 0x00700000))
    ;; Slot 1 advertises IMAGE_DIRECTORY_ENTRY_TLS and must keep notifications.
    (i32.store offset=4 (global.get $DLL_FLAGS_TABLE) (i32.const 1)))

  (func (export "test_call_DisableThreadLibraryCalls") (param $module i32) (result i32)
    (global.set $esp (i32.const 0))
    (call $handle_DisableThreadLibraryCalls
      (local.get $module) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
`;

async function main() {
  const { exports: e } = await bootRenderHarness({ extraWat, fonts: 'none' });
  e.test_seed_dll_thread_flags();

  assert.strictEqual(e.dll_thread_notifications_enabled(0x00600000), 1,
    'an ordinary loaded DLL initially receives thread notifications');
  e.test_call_SetLastError(0x1234);
  assert.strictEqual(e.test_call_DisableThreadLibraryCalls(0x00600000), 1,
    'a loaded DLL without static TLS can disable notifications');
  assert.strictEqual(e.test_call_GetLastError(), 0x1234,
    'successful DisableThreadLibraryCalls preserves LastError');
  assert.strictEqual(e.dll_thread_notifications_enabled(0x00600000), 0,
    'the disabled state is visible to thread creation');
  assert.strictEqual(e.test_call_DisableThreadLibraryCalls(0x00600000), 1,
    'disabling an already-disabled DLL remains successful');

  e.test_call_SetLastError(0x1234);
  assert.strictEqual(e.test_call_DisableThreadLibraryCalls(0x00700000), 0,
    'a DLL with active static TLS cannot disable notifications');
  assert.strictEqual(e.test_call_GetLastError(), 87,
    'static TLS failure reports ERROR_INVALID_PARAMETER');
  assert.strictEqual(e.dll_thread_notifications_enabled(0x00700000), 1,
    'the static-TLS DLL remains on the notification list');

  for (const module of [0, 0x00400000, 0x00dead00]) {
    e.test_call_SetLastError(0x1234);
    assert.strictEqual(e.test_call_DisableThreadLibraryCalls(module), 0,
      `invalid/non-DLL module 0x${module.toString(16)} is rejected`);
    assert.strictEqual(e.test_call_GetLastError(), 87,
      'invalid module failure reports ERROR_INVALID_PARAMETER');
  }

  const manager = Object.create(ThreadManager.prototype);
  const dll = { loadAddr: 0x00600000 };
  assert.strictEqual(manager._dllWantsThreadNotifications({}, dll), true,
    'an older external WASM module retains notify-all compatibility');
  assert.strictEqual(manager._dllWantsThreadNotifications({
    dll_thread_notifications_enabled: module => module === 0x00700000,
  }, dll), false, 'cooperative thread creation consults live WAT loader state');

  const detachCalls = [];
  manager.setLoadedDlls([
    { loadAddr: 0x00600000, dllMain: 0x00601000 },
    { loadAddr: 0x00700000, dllMain: 0x00701000 },
  ], (_exports, loadAddr, dllMain, _log, options) => {
    detachCalls.push({ loadAddr, dllMain, reason: options.reason });
  });
  const thread = { instance: { exports: {
    dll_thread_notifications_enabled: module => module === 0x00700000,
  } } };
  manager._notifyThreadDetach(thread);
  manager._notifyThreadDetach(thread);
  assert.deepStrictEqual(detachCalls, [
    { loadAddr: 0x00700000, dllMain: 0x00701000, reason: 3 },
  ], 'detach runs once, in reverse load order, and skips disabled DLLs');

  const threadManagerSource = fs.readFileSync(
    path.join(ROOT, 'lib', 'thread-manager.js'), 'utf8');
  const guestWorkerSource = fs.readFileSync(
    path.join(ROOT, 'lib', 'guest-worker.js'), 'utf8');
  assert(threadManagerSource.includes('loadedDlls: this._loadedDlls.map'),
    'real Worker creation receives the loaded DLL entry-point list');
  assert(guestWorkerSource.includes('reason: 2, lpReserved: 0, advanceGuestTime'),
    'real Workers deliver DLL_THREAD_ATTACH with dynamic-load context');
  assert(guestWorkerSource.includes('ex.dll_thread_notifications_enabled(dll.loadAddr | 0)'),
    'real Workers suppress only DLLs disabled in shared loader state');
  assert(guestWorkerSource.includes('notifyGuestThreadDetach(ex)'),
    'real Workers deliver DLL_THREAD_DETACH before natural teardown');

  console.log('PASS  DisableThreadLibraryCalls controls cooperative and browser Worker notifications');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

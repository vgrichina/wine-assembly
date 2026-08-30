#!/usr/bin/env node

'use strict';

const assert = require('assert');
const apiTable = require('../src/api_table.json');
const { ThreadManager } = require('../lib/thread-manager');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_mutex_init")
    (global.set $image_base (i32.const 0)))

  (func (export "test_create_mutex_a") (param $name i32) (param $owner i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_CreateMutexA
      (i32.const 0) (local.get $owner) (local.get $name)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_create_mutex_w") (param $name i32) (param $owner i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_CreateMutexW
      (i32.const 0) (local.get $owner) (local.get $name)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_open_mutex_a") (param $name i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_OpenMutexA
      (i32.const 0x00100000) (i32.const 0) (local.get $name)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_open_mutex_w") (param $name i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_OpenMutexW
      (i32.const 0x00100000) (i32.const 0) (local.get $name)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_release_mutex") (param $handle i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_ReleaseMutex
      (local.get $handle) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_wait_mutex_now") (param $handle i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_WaitForSingleObject
      (local.get $handle) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_last_error") (result i32)
    (global.get $last_error))
`;

(async () => {
  assert.strictEqual(apiTable.find(entry => entry.name === 'OpenMutexW').nargs, 3,
    'OpenMutexW is available to Unicode import callers');
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  let tm = null;
  const readName = (ptr, wide) => {
    if (!ptr) return '';
    const dv = new DataView(memory.buffer);
    let value = '';
    for (let i = 0; i < 512; i++) {
      const ch = (wide & 1) ? dv.getUint16(ptr + i * 2, true) : dv.getUint8(ptr + i);
      if (!ch) break;
      value += String.fromCharCode(ch);
    }
    return value;
  };
  const harness = await bootRenderHarness({
    extraWat,
    fonts: 'none',
    memory,
    extraHostOverrides: {
      create_event: (_manual, initialOwner, nameWa, kind) => {
        assert(kind & 2, 'mutex handlers select the private mutex object kind');
        return tm.createMutex(initialOwner, readName(nameWa, kind), 1);
      },
      open_event: (nameWa, kind) => {
        assert(kind & 2, 'OpenMutex selects the private mutex object kind');
        return tm.openMutex(readName(nameWa, kind));
      },
      set_event: taggedHandle => {
        const value = taggedHandle >>> 0;
        assert(value & 0x80000000, 'ReleaseMutex selects release rather than SetEvent');
        return tm.releaseMutex(value & 0x7fffffff, 1);
      },
      wait_single: (handle, timeout) => tm.waitSingle(handle, timeout, 1),
    },
  });
  const wat = harness.exports;
  tm = new ThreadManager({}, memory, harness.instance, () => ({ host: {} }));
  tm._log = () => {};
  wat.test_mutex_init();

  const ansiName = 0x2000;
  const wideName = 0x2100;
  const name = 'Fable Browser Mutex';
  [...name].forEach((ch, i) => {
    wat.guest_write8(ansiName + i, ch.charCodeAt(0));
    wat.guest_write16(wideName + i * 2, ch.charCodeAt(0));
  });
  wat.guest_write8(ansiName + name.length, 0);
  wat.guest_write16(wideName + name.length * 2, 0);

  assert.strictEqual(wat.test_open_mutex_w(wideName), 0,
    'no process-external named mutex is present');
  assert.strictEqual(wat.test_last_error(), 2,
    'OpenMutexW reports ERROR_FILE_NOT_FOUND');

  const handle = wat.test_create_mutex_w(wideName, 1) >>> 0;
  assert(handle, 'CreateMutexW allocates a real synchronization handle');
  assert.strictEqual(wat.test_last_error(), 0);
  assert.strictEqual(tm.waitSingle(handle, 0, 2), 0x102,
    'an initial owner blocks a different browser Worker thread');

  assert.strictEqual(wat.test_create_mutex_a(ansiName, 0) >>> 0, handle,
    'ANSI and Unicode APIs resolve the same named mutex');
  assert.strictEqual(wat.test_last_error(), 183,
    'creating an existing mutex reports ERROR_ALREADY_EXISTS');
  assert.strictEqual(wat.test_open_mutex_a(ansiName) >>> 0, handle);
  assert.strictEqual(wat.test_open_mutex_w(wideName) >>> 0, handle);

  assert.strictEqual(wat.test_release_mutex(handle), 1,
    'the owning main guest thread can release the mutex');
  assert.strictEqual(wat.test_last_error(), 0);
  assert.strictEqual(wat.test_wait_mutex_now(handle), 0,
    'WaitForSingleObject acquires a released mutex through the WAT handler');
  assert.strictEqual(wat.test_release_mutex(handle), 1);

  assert.strictEqual(tm.waitSingle(handle, 0, 2), 0,
    'a Worker thread acquires the mutex');
  assert.strictEqual(tm.waitSingle(handle, 0, 2), 0,
    'mutex acquisition is recursive for its owner');
  assert.strictEqual(wat.test_release_mutex(handle), 0,
    'a different guest thread cannot release the Worker-owned mutex');
  assert.strictEqual(wat.test_last_error(), 288, 'non-owner release reports ERROR_NOT_OWNER');
  assert.strictEqual(tm.releaseMutex(handle, 2), 1);
  assert.strictEqual(tm.waitSingle(handle, 0, 3), 0x102,
    'one recursive release retains ownership');
  assert.strictEqual(tm.releaseMutex(handle, 2), 1);
  assert.strictEqual(tm.waitSingle(handle, 0, 3), 0,
    'the final recursive release wakes another thread');
  assert.strictEqual(tm.releaseMutex(handle, 3), 1);

  assert.strictEqual(wat.test_release_mutex(0x123456), 0);
  assert.strictEqual(wat.test_last_error(), 6, 'invalid mutex handles report ERROR_INVALID_HANDLE');

  const abandoned = tm.createMutex(true, '', 2);
  tm._abandonMutexesOwnedBy(2);
  assert.strictEqual(tm.waitSingle(abandoned, 0, 3), 0x80,
    'a thread exiting while owning a mutex produces WAIT_ABANDONED_0');
  assert.strictEqual(tm.releaseMutex(abandoned, 3), 1,
    'the abandoned waiter becomes the new owner');

  console.log('PASS  mutex APIs preserve names, ownership, recursion, release, and abandonment');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

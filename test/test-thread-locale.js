#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { ThreadManager } = require('../lib/thread-manager');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_get_thread_locale") (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_GetThreadLocale
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_set_thread_locale") (param $locale i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_SetThreadLocale
      (local.get $locale) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_create_thread") (result i32)
    (global.set $esp (i32.const 0x00300000))
    ;; Sixth argument, lpThreadId, is NULL.
    (call $gs32 (i32.add (global.get $esp) (i32.const 24)) (i32.const 0))
    (call $handle_CreateThread
      (i32.const 0) (i32.const 0x10000) (i32.const 0x00401000)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_set_last_error") (param $value i32)
    (global.set $last_error (local.get $value)))
  (func (export "test_get_last_error") (result i32)
    (global.get $last_error))
`;

(async () => {
  let manager = null;
  const creators = [];
  const harness = await bootRenderHarness({
    extraWat,
    fonts: 'none',
    extraHostOverrides: {
      create_thread: (start, param, stack, flags, threadIdWa, creatorTid) => {
        creators.push(creatorTid >>> 0);
        return manager.createThread(start, param, stack, flags, threadIdWa, creatorTid);
      },
      get_thread_locale: tid => manager.getThreadLocale(tid),
      set_thread_locale: (locale, tid) => manager.setThreadLocale(locale, tid),
    },
  });
  const e = harness.exports;
  manager = new ThreadManager(null, harness.memory, harness.instance,
    () => ({ host: {} }), {});
  manager._log = () => {};

  assert.strictEqual(e.test_get_thread_locale(), 0x0409,
    'the main thread starts at the emulated user locale');
  assert.strictEqual(e.get_esp() >>> 0, 0x00300004,
    'GetThreadLocale pops only its return address');

  e.test_set_last_error(0x1234);
  assert.strictEqual(e.test_set_thread_locale(0x0419), 1,
    'SetThreadLocale accepts a concrete LCID');
  assert.strictEqual(e.test_get_last_error(), 0x1234,
    'successful SetThreadLocale preserves LastError');
  assert.strictEqual(e.test_get_thread_locale(), 0x0419,
    'GetThreadLocale returns the calling thread setting');

  const child = e.test_create_thread() >>> 0;
  assert(child, 'CreateThread returns a real pending thread handle');
  assert.deepStrictEqual(creators, [1],
    'the WAT passes the creating thread identity to the host authority');
  assert.strictEqual(manager.getThreadLocale(2), 0x0419,
    'a new thread inherits its creator locale');
  assert.strictEqual(e.get_esp() >>> 0, 0x0030001c,
    'CreateThread preserves its six-argument stdcall frame');

  e.set_current_thread_id(2);
  assert.strictEqual(e.test_get_thread_locale(), 0x0419,
    'the child observes its inherited locale through the API');
  assert.strictEqual(e.test_set_thread_locale(0x0407), 1,
    'the child can independently select German');
  const grandchild = e.test_create_thread() >>> 0;
  assert(grandchild, 'a child can create another pending thread');
  assert.deepStrictEqual(creators, [1, 2]);
  assert.strictEqual(manager.getThreadLocale(3), 0x0407,
    'a grandchild inherits the immediate creator locale');

  e.set_current_thread_id(1);
  assert.strictEqual(e.test_get_thread_locale(), 0x0419,
    'changing a child locale does not mutate its parent');
  assert.strictEqual(e.test_set_thread_locale(0x0400), 1,
    'LOCALE_USER_DEFAULT is accepted');
  assert.strictEqual(e.test_get_thread_locale(), 0x0409,
    'LOCALE_USER_DEFAULT resolves to the emulated user LCID');

  e.test_set_last_error(0x5678);
  assert.strictEqual(e.test_set_thread_locale(0), 0,
    'an invalid zero LCID fails');
  assert.strictEqual(e.test_get_last_error(), 87,
    'a rejected LCID reports ERROR_INVALID_PARAMETER');
  assert.strictEqual(e.test_get_thread_locale(), 0x0409,
    'a rejected LCID preserves the prior locale');
  assert.strictEqual(e.get_esp() >>> 0, 0x00300004,
    'the follow-up getter keeps its zero-argument stdcall cleanup');

  console.log('PASS thread locale is retained, isolated, and inherited across Win98 threads');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

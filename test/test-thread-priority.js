#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_get_thread_priority") (param $thread i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_GetThreadPriority
      (local.get $thread) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_set_thread_priority")
      (param $thread i32) (param $priority i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_SetThreadPriority
      (local.get $thread) (local.get $priority) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_set_process_priority") (param $priority i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_SetPriorityClass
      (i32.const -1) (local.get $priority) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_set_last_error") (param $value i32)
    (global.set $last_error (local.get $value)))
  (func (export "test_get_last_error") (result i32)
    (global.get $last_error))
`;

(async () => {
  const CURRENT_THREAD = -2;
  const REAL_THREAD = 0x0e1000;
  const main = { priority: 0 };
  const worker = { priority: 0 };
  const setCalls = [];
  const resolve = (handle, tid) => {
    handle >>>= 0;
    tid >>>= 0;
    if (handle === 0xfffffffe) return tid === 1 ? main : tid === 2 ? worker : null;
    return handle === REAL_THREAD ? worker : null;
  };

  const { exports: e } = await bootRenderHarness({
    extraWat,
    fonts: 'none',
    extraHostOverrides: {
      get_thread_priority: (handle, tid) => {
        const thread = resolve(handle, tid);
        return thread ? thread.priority : 0x7fffffff;
      },
      set_thread_priority: (handle, priority, tid) => {
        setCalls.push([handle >>> 0, priority | 0, tid >>> 0]);
        const thread = resolve(handle, tid);
        if (!thread) return 0;
        thread.priority = priority | 0;
        return 1;
      },
    },
  });

  e.test_set_last_error(0x1234);
  assert.strictEqual(e.test_get_thread_priority(CURRENT_THREAD), 0,
    'the main current thread starts at THREAD_PRIORITY_NORMAL');
  assert.strictEqual(e.test_get_last_error(), 0x1234,
    'successful GetThreadPriority preserves LastError');
  assert.strictEqual(e.get_esp() >>> 0, 0x00300008,
    'GetThreadPriority pops its one stdcall argument');

  e.set_current_thread_id(2);
  assert.strictEqual(e.test_set_thread_priority(CURRENT_THREAD, 2), 1,
    'a worker can set THREAD_PRIORITY_HIGHEST through its contextual pseudo handle');
  assert.deepStrictEqual(setCalls.pop(), [0xfffffffe, 2, 2],
    'the WAT passes current thread identity to the process thread authority');
  assert.strictEqual(e.test_get_thread_priority(REAL_THREAD), 2,
    'a durable handle observes the same worker priority');

  assert.strictEqual(e.test_set_thread_priority(REAL_THREAD, -2), 1,
    'a durable handle can set THREAD_PRIORITY_LOWEST');
  assert.strictEqual(e.test_get_thread_priority(CURRENT_THREAD), -2,
    'the contextual pseudo handle observes the durable-handle mutation');
  assert.strictEqual(e.get_esp() >>> 0, 0x00300008,
    'a later GetThreadPriority still cleans its stdcall frame');

  const callsBeforeInvalidPriority = setCalls.length;
  assert.strictEqual(e.test_set_thread_priority(REAL_THREAD, 3), 0,
    'a non-realtime Win98 process rejects an intermediate realtime-only value');
  assert.strictEqual(e.test_get_last_error(), 87,
    'an invalid thread priority reports ERROR_INVALID_PARAMETER');
  assert.strictEqual(setCalls.length, callsBeforeInvalidPriority,
    'invalid values never reach or mutate the host thread object');
  assert.strictEqual(e.test_get_thread_priority(REAL_THREAD), -2,
    'a rejected priority preserves the prior value');

  assert.strictEqual(e.test_set_thread_priority(REAL_THREAD, 0x10000), 0,
    'post-Win98 background-processing mode is rejected');
  assert.strictEqual(e.test_get_last_error(), 87);

  assert.strictEqual(e.test_set_process_priority(0x100), 1,
    'the process can enter REALTIME_PRIORITY_CLASS');
  assert.strictEqual(e.test_set_thread_priority(REAL_THREAD, 3), 1,
    'a realtime process accepts its documented intermediate priority range');
  assert.strictEqual(e.test_get_thread_priority(CURRENT_THREAD), 3);

  e.test_set_last_error(0x5678);
  assert.strictEqual(e.test_set_thread_priority(0x7777, 0), 0,
    'a fabricated thread handle cannot change priority');
  assert.strictEqual(e.test_get_last_error(), 6,
    'SetThreadPriority reports ERROR_INVALID_HANDLE');
  assert.strictEqual(e.get_esp() >>> 0, 0x0030000c,
    'failed SetThreadPriority pops its two stdcall arguments');
  assert.strictEqual(e.test_get_thread_priority(0x7777), 0x7fffffff,
    'GetThreadPriority returns THREAD_PRIORITY_ERROR_RETURN for an invalid handle');
  assert.strictEqual(e.test_get_last_error(), 6,
    'failed GetThreadPriority reports ERROR_INVALID_HANDLE');

  console.log('PASS thread priority has Win98 values, handle identity, state, and errors');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

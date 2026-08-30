#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_find_first_change_notification_a") (param $path i32) (param $subtree i32) (param $filter i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (global.set $last_error (i32.const 0))
    (call $handle_FindFirstChangeNotificationA
      (local.get $path) (local.get $subtree) (local.get $filter)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_find_first_change_notification_w") (param $path i32) (param $subtree i32) (param $filter i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (global.set $last_error (i32.const 0))
    (call $handle_FindFirstChangeNotificationW
      (local.get $path) (local.get $subtree) (local.get $filter)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_find_next_change_notification") (param $handle i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_FindNextChangeNotification (local.get $handle)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_find_close_change_notification") (param $handle i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (global.set $last_error (i32.const 0))
    (call $handle_FindCloseChangeNotification (local.get $handle)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_wait_change_notification") (param $handle i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_WaitForSingleObject (local.get $handle) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_last_error") (result i32) (global.get $last_error))
`;

(async () => {
  const events = new Map();
  let nextHandle = 0xE010;
  const harness = await bootRenderHarness({
    extraWat,
    fonts: 'none',
    extraHostOverrides: {
      create_event: (manualReset, initialState) => {
        const handle = nextHandle++;
        events.set(handle, { manualReset: !!manualReset, signaled: !!initialState });
        return handle;
      },
      wait_single: handle => {
        const event = events.get(handle >>> 0);
        return event && event.signaled ? 0 : 0x102;
      },
    },
  });
  const { exports: wat, hostCtx } = harness;
  hostCtx.signalSyncHandle = handle => {
    const event = events.get(handle >>> 0);
    if (!event) return 0;
    event.signaled = true;
    return 1;
  };
  hostCtx.resetSyncHandle = handle => {
    const event = events.get(handle >>> 0);
    if (!event) return 0;
    event.signaled = false;
    return 1;
  };
  hostCtx.closeSyncHandle = handle => events.delete(handle >>> 0) ? 1 : 0;
  hostCtx.vfs.dirs.add('c:\\watch');

  const strA = value => {
    const p = wat.guest_alloc(value.length + 1) >>> 0;
    for (let i = 0; i < value.length; i++) wat.guest_write8(p + i, value.charCodeAt(i));
    wat.guest_write8(p + value.length, 0);
    return p;
  };
  const strW = value => {
    const p = wat.guest_alloc((value.length + 1) * 2) >>> 0;
    for (let i = 0; i < value.length; i++) {
      wat.guest_write8(p + i * 2, value.charCodeAt(i));
      wat.guest_write8(p + i * 2 + 1, 0);
    }
    wat.guest_write8(p + value.length * 2, 0);
    wat.guest_write8(p + value.length * 2 + 1, 0);
    return p;
  };

  const pathA = strA('C:\\watch');
  const handle = wat.test_find_first_change_notification_a(pathA, 0, 0x01) >>> 0;
  assert(events.has(handle), 'FindFirst creates a real waitable event');
  assert.strictEqual(events.get(handle).manualReset, true);
  assert.strictEqual(wat.test_wait_change_notification(handle), 0x102,
    'new notification starts nonsignalled');
  assert(hostCtx.vfs.createFile('C:\\watch\\one.txt', 0x40000000, 2));
  assert.strictEqual(wat.test_wait_change_notification(handle), 0,
    'a matching VFS mutation satisfies WaitForSingleObject');
  assert(hostCtx.vfs.createFile('C:\\watch\\two.txt', 0x40000000, 2));
  assert.strictEqual(wat.test_find_next_change_notification(handle), 1);
  assert.strictEqual(wat.test_wait_change_notification(handle), 0,
    'FindNext preserves a change recorded while the handle was signalled');
  assert.strictEqual(wat.test_find_next_change_notification(handle), 1);
  assert.strictEqual(wat.test_wait_change_notification(handle), 0x102,
    'FindNext rearms to nonsignalled once no change is pending');
  assert.strictEqual(wat.test_find_close_change_notification(handle), 1);
  assert(!events.has(handle), 'FindClose releases the underlying wait object');
  assert.strictEqual(wat.test_find_next_change_notification(handle), 0,
    'a closed notification cannot be rearmed');
  assert.strictEqual(wat.test_last_error(), 6);

  const pathW = strW('C:\\watch');
  const wideHandle = wat.test_find_first_change_notification_w(pathW, 1, 0x02) >>> 0;
  assert(events.has(wideHandle), 'wide creation shares the real notification core');
  assert(hostCtx.vfs.createDirectory('C:\\watch\\nested'));
  assert.strictEqual(wat.test_wait_change_notification(wideHandle), 0);
  assert.strictEqual(wat.test_find_close_change_notification(wideHandle), 1);

  assert.strictEqual(wat.test_find_first_change_notification_a(pathA, 0, 0), -1,
    'an empty filter is rejected');
  assert.strictEqual(wat.test_last_error(), 87,
    'an empty filter reports ERROR_INVALID_PARAMETER');
  assert.strictEqual(wat.test_find_close_change_notification(-1), 0,
    'INVALID_HANDLE_VALUE is not a valid change-notification handle');
  assert.strictEqual(wat.test_last_error(), 6,
    'invalid notification close reports ERROR_INVALID_HANDLE');
  assert.strictEqual(wat.get_esp(), 0x00300008,
    'one-argument API has the correct stdcall cleanup');
  console.log('PASS  Win32 directory notifications signal, latch, rearm, and close');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

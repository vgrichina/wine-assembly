#!/usr/bin/env node
'use strict';

// A WH_CBT hook may observe a system control without subclassing it. USER then
// returns from HCBT_CREATEWND to the native control path; 0xFFFF0002 is an
// emulator wndproc marker and must never become the guest EIP.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_child_cbt_native_return")
      (param $hwnd i32) (param $ret i32) (param $stack i32)
    (local $idx i32) (local $slot i32)
    (local.set $idx (global.get $num_thunks))
    (local.set $slot
      (i32.add (global.get $THUNK_BASE)
        (i32.mul (local.get $idx) (i32.const 8))))
    (i32.store (local.get $slot) (i32.const 0xCACA0026))
    (i32.store offset=4 (local.get $slot) (i32.const 0))
    (global.set $num_thunks (i32.add (local.get $idx) (i32.const 1)))

    (call $wnd_table_set (local.get $hwnd) (global.get $WNDPROC_CTRL_NATIVE))
    (global.set $child_cbt_saved_hwnd (local.get $hwnd))
    (global.set $child_cbt_saved_ret (local.get $ret))
    (global.set $pending_child_create (local.get $hwnd))
    (global.set $pending_child_size_hwnd (local.get $hwnd))
    (global.set $pending_child_size (i32.const 0x01E00280))
    (global.set $esp (local.get $stack))
    (global.set $eip (i32.const 0xFFFF0002))
    (global.set $eax (i32.const 0))
    (call $win32_dispatch (local.get $idx)))

  (func (export "test_pending_child_create") (result i32)
    (global.get $pending_child_create))
  (func (export "test_pending_child_size") (result i32)
    (global.get $pending_child_size))
  (func (export "test_pending_child_size_hwnd") (result i32)
    (global.get $pending_child_size_hwnd))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const hwnd = 0x10085;
  const ret = 0x0042A5B0;
  const stack = 0x074FF64C;

  e.test_child_cbt_native_return(hwnd, ret, stack);

  assert.strictEqual(e.get_eip() >>> 0, ret,
    'unsubclassed native control resumes the CreateWindowEx caller');
  assert.strictEqual(e.get_eax() >>> 0, hwnd,
    'CreateWindowEx returns the native control HWND');
  assert.strictEqual(e.get_esp() >>> 0, stack,
    'the CBT hook already restored the caller stack');
  assert.strictEqual(e.test_pending_child_create() >>> 0, 0,
    'the completed create is no longer pending');
  assert.strictEqual(e.test_pending_child_size_hwnd() >>> 0, hwnd,
    'the native control keeps its queued WM_SIZE target');
  assert.strictEqual(e.test_pending_child_size() >>> 0, 0x01E00280,
    'the native control keeps its queued WM_SIZE dimensions');

  console.log('PASS  unsubclassed native control returns safely from WH_CBT');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

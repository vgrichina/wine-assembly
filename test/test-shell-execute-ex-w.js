#!/usr/bin/env node

'use strict';

const assert = require('assert');
const apiTable = require('../src/api_table.json');
const { bootRenderHarness } = require('./render-helper');

const extraWat = `
  (func (export "test_get_proc_shell_execute_ex_w") (param $stack i32) (result i32)
    (local $name i32)
    (local.set $name (call $heap_alloc (i32.const 17)))
    (i32.store (call $g2w (local.get $name)) (i32.const 0x6c656853)) ;; "Shel"
    (i32.store offset=4 (call $g2w (local.get $name)) (i32.const 0x6578456c)) ;; "lExe"
    (i32.store offset=8 (call $g2w (local.get $name)) (i32.const 0x65747563)) ;; "cute"
    (i32.store offset=12 (call $g2w (local.get $name)) (i32.const 0x00577845)) ;; "ExW\\0"
    (global.set $esp (local.get $stack))
    (call $handle_GetProcAddress
      (global.get $image_base) (local.get $name) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))

  (func (export "test_call_shell_execute_ex_w") (param $stack i32) (param $info i32) (result i32)
    (global.set $esp (local.get $stack))
    (call $handle_ShellExecuteExW
      (local.get $info) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
`;

(async () => {
  const api = apiTable.find(entry => entry.name === 'ShellExecuteExW');
  assert(api, 'ShellExecuteExW must be available to dynamic GetProcAddress callers');
  assert.strictEqual(api.nargs, 1, 'ShellExecuteExW has one stdcall argument');

  const { exports: wat, memory } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const stack = 0x074ff000;
  const info = wat.guest_alloc(60) >>> 0;
  const infoWa = info - (wat.get_image_base() >>> 0) + (wat.get_guest_base() >>> 0);
  const view = new DataView(memory.buffer);

  assert.notStrictEqual(wat.test_get_proc_shell_execute_ex_w(stack) >>> 0, 0,
    'GetProcAddress(ShellExecuteExW) returns a callable thunk');
  assert.strictEqual(wat.test_call_shell_execute_ex_w(stack, info), 1,
    'ShellExecuteExW reports success');
  assert.strictEqual(view.getUint32(infoWa + 28, true), 33,
    'ShellExecuteExW sets SHELLEXECUTEINFO.hInstApp to a success value');
  assert.strictEqual(wat.get_esp() >>> 0, stack + 8,
    'ShellExecuteExW pops its argument and return address');

  console.log('PASS ShellExecuteExW resolves dynamically and reports success');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

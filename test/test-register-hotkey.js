#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

let queuedKey = 0;
let inputReads = 0;

const extraWat = String.raw`
  (global $test_hotkey_msg (mut i32) (i32.const 0))

  (func (export "test_register_hotkey")
      (param $hwnd i32) (param $id i32) (param $mods i32) (param $vk i32)
      (result i64)
    (global.set $last_error (i32.const 0))
    (global.set $esp (i32.const 0x00300000))
    (call $handle_RegisterHotKey
      (local.get $hwnd) (local.get $id) (local.get $mods) (local.get $vk)
      (i32.const 0) (i32.const 0))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))

  (func (export "test_unregister_hotkey")
      (param $hwnd i32) (param $id i32) (result i64)
    (global.set $last_error (i32.const 0))
    (global.set $esp (i32.const 0x00300000))
    (call $handle_UnregisterHotKey
      (local.get $hwnd) (local.get $id)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))

  (func (export "test_hotkey_last_error") (result i32)
    (global.get $last_error))

  (func (export "test_peek_hotkey")
      (param $remove i32) (param $min i32) (param $max i32) (result i32)
    (if (i32.eqz (global.get $test_hotkey_msg))
      (then (global.set $test_hotkey_msg (call $heap_alloc (i32.const 28)))))
    (global.set $esp (i32.const 0x00300000))
    (call $handle_PeekMessageA
      (global.get $test_hotkey_msg) (i32.const 0)
      (local.get $min) (local.get $max) (local.get $remove) (i32.const 0))
    (global.get $eax))

  (func (export "test_hotkey_msg_field") (param $field i32) (result i32)
    (call $gl32 (i32.add (global.get $test_hotkey_msg)
      (i32.mul (local.get $field) (i32.const 4)))))

  (func (export "test_hotkey_modifiers") (param $vk i32) (result i32)
    (call $hotkey_current_modifiers (local.get $vk)))

  (func (export "test_host_key_down") (param $vk i32) (result i32)
    (call $host_get_key_down_state (local.get $vk)))

  (func (export "test_hotkey_match") (param $msg i32) (param $vk i32) (result i32)
    (call $hotkey_match (local.get $msg) (local.get $vk)))
`;

function unpackCall(value) {
  return {
    result: Number(value & 0xffffffffn),
    esp: Number(value >> 32n),
  };
}

(async () => {
  const { exports: wat, renderer } = await bootRenderHarness({
    extraWat,
    extraHostOverrides: {
      check_input: () => {
        inputReads++;
        const value = queuedKey;
        queuedKey = 0;
        return value;
      },
      check_input_hwnd: () => 0,
      check_input_lparam: () => 0x00250001,
    },
  });

  let call = unpackCall(wat.test_register_hotkey(0, 7, 0x06, 0x4b));
  assert.deepStrictEqual(call, { result: 1, esp: 0x00300014 },
    'RegisterHotKey succeeds and pops four stdcall arguments');

  call = unpackCall(wat.test_register_hotkey(0, 8, 0x06, 0x4b));
  assert.strictEqual(call.result, 0, 'the same desktop chord cannot be registered twice');
  assert.strictEqual(wat.test_hotkey_last_error(), 1409,
    'a conflicting chord reports ERROR_HOTKEY_ALREADY_REGISTERED');

  call = unpackCall(wat.test_register_hotkey(0, 9, 0x4000, 0x41));
  assert.strictEqual(call.result, 0, 'Win98 rejects the later MOD_NOREPEAT flag');
  assert.strictEqual(wat.test_hotkey_last_error(), 87);

  renderer.pokeKeyDownState(0x10, true);
  renderer.pokeKeyDownState(0x11, true);
  renderer.pokeKeyDownState(0x4b, true);
  assert.strictEqual(renderer.peekKeyDownState(0x10), 0x8000);
  assert.strictEqual(wat.test_host_key_down(0x10), 0x8000,
    'WAT sees the renderer physical key state');
  assert.strictEqual(wat.test_hotkey_modifiers(0x4b), 0x06,
    'physical Ctrl+Shift state maps to Win32 MOD flags');
  assert.notStrictEqual(wat.test_hotkey_match(0x0100, 0x4b), 0,
    'the registered chord matches a hardware key-down');
  queuedKey = (0x4b << 16) | 0x0100;

  assert.strictEqual(wat.test_peek_hotkey(0, 0, 0), 1, 'PM_NOREMOVE sees the hot key');
  assert.strictEqual(wat.test_hotkey_msg_field(0), 0,
    'a thread hot key keeps hwnd NULL');
  assert.strictEqual(wat.test_hotkey_msg_field(1), 0x0312, 'message is WM_HOTKEY');
  assert.strictEqual(wat.test_hotkey_msg_field(2), 7, 'wParam is the registration id');
  assert.strictEqual(wat.test_hotkey_msg_field(3), 0x004b0006,
    'lParam is MAKELONG(MOD_CONTROL|MOD_SHIFT, VK_K)');
  assert.strictEqual(inputReads, 1);

  assert.strictEqual(wat.test_peek_hotkey(1, 0, 0), 1,
    'PM_REMOVE returns the same cached WM_HOTKEY');
  assert.strictEqual(wat.test_hotkey_msg_field(1), 0x0312);
  assert.strictEqual(inputReads, 1, 'PM_REMOVE consumes the cached event without a host reread');

  call = unpackCall(wat.test_unregister_hotkey(0, 7));
  assert.deepStrictEqual(call, { result: 1, esp: 0x0030000c },
    'UnregisterHotKey removes the registration and pops two arguments');
  call = unpackCall(wat.test_unregister_hotkey(0, 7));
  assert.strictEqual(call.result, 0);
  assert.strictEqual(wat.test_hotkey_last_error(), 1419,
    'removing it twice reports ERROR_HOTKEY_NOT_REGISTERED');

  queuedKey = (0x4b << 16) | 0x0100;
  assert.strictEqual(wat.test_peek_hotkey(1, 0, 0), 1);
  assert.strictEqual(wat.test_hotkey_msg_field(1), 0x0100,
    'after unregistering, the same input remains an ordinary WM_KEYDOWN');
  assert.strictEqual(wat.test_hotkey_msg_field(2), 0x4b);

  console.log('PASS  RegisterHotKey delivers desktop-local WM_HOTKEY messages');
})().catch(err => {
  console.error(err);
  process.exit(1);
});

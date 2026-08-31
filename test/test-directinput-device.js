#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');
const apiTable = require('../src/api_table.json');

const extraWat = `
  (func (export "test_call_IDirectInputDevice_EnumObjects") (param $stack i32) (result i32)
    (global.set $esp (local.get $stack))
    (call $handle_IDirectInputDevice_EnumObjects
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $esp))
  (func (export "test_di_root_create") (param $version i32) (result i32)
    (local $obj i32)
    (global.set $DX_VTBL_DINPUT (i32.const 0x51000000))
    (local.set $obj (call $dx_create_com_obj (i32.const 6) (global.get $DX_VTBL_DINPUT)))
    (i32.store offset=8 (call $dx_from_this (local.get $obj)) (local.get $version))
    (local.get $obj))
  (func (export "test_di_mouse_create") (result i32)
    (local $obj i32)
    (global.set $DX_VTBL_DIDEV2 (i32.const 0x52000000))
    (local.set $obj (call $dx_create_com_obj (i32.const 7) (global.get $DX_VTBL_DIDEV2)))
    (i32.store offset=8 (call $dx_from_this (local.get $obj)) (i32.const 2))
    (i32.store offset=16 (call $dx_from_this (local.get $obj)) (i32.const 0x0700))
    (local.get $obj))
  (func (export "test_di_keyboard_create") (result i32)
    (local $obj i32)
    (global.set $DX_VTBL_DIDEV2 (i32.const 0x52000000))
    (local.set $obj (call $dx_create_com_obj (i32.const 7) (global.get $DX_VTBL_DIDEV2)))
    (i32.store offset=8 (call $dx_from_this (local.get $obj)) (i32.const 1))
    (i32.store offset=16 (call $dx_from_this (local.get $obj)) (i32.const 0x0700))
    (local.get $obj))
  (func (export "test_di_enum_devices")
        (param $root i32) (param $stack i32) (param $filter i32)
        (param $flags i32) (param $callback i32) (param $ref i32) (result i32)
    (global.set $font_enum_ret_thunk (i32.const 0x0BAD0011))
    (call $gs32 (local.get $stack) (i32.const 0x12345678))
    (global.set $esp (local.get $stack))
    (call $handle_IDirectInput_EnumDevices
      (local.get $root) (local.get $filter) (local.get $callback)
      (local.get $ref) (local.get $flags) (i32.const 0))
    (global.get $esp))
  (func (export "test_di_enum_objects")
        (param $obj i32) (param $stack i32) (param $filter i32)
        (param $callback i32) (param $ref i32) (result i32)
    (global.set $font_enum_ret_thunk (i32.const 0x0BAD0011))
    (call $gs32 (local.get $stack) (i32.const 0x12345678))
    (global.set $esp (local.get $stack))
    (call $handle_IDirectInputDevice_EnumObjects
      (local.get $obj) (local.get $callback) (local.get $ref)
      (local.get $filter) (i32.const 0) (i32.const 0))
    (global.get $esp))
  (func (export "test_di_enum_continue") (param $callback_result i32) (result i32)
    ;; Simulate stdcall RET 8 from callback: return address + two arguments.
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
    (global.set $eax (local.get $callback_result))
    (call $di_enum_continue)
    (global.get $esp))
  (func (export "test_di_get_eip") (result i32) (global.get $eip))
  (func (export "test_di_get_info") (param $obj i32) (param $info i32) (result i32)
    (global.set $esp (i32.const 0x074fe000))
    (call $handle_IDirectInputDevice_GetDeviceInfo
      (local.get $obj) (local.get $info) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_di_get_caps") (param $obj i32) (param $caps i32) (result i32)
    (global.set $esp (i32.const 0x074fe000))
    (call $handle_IDirectInputDevice_GetCapabilities
      (local.get $obj) (local.get $caps) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_di_mouse_seed_delta") (param $dx i32) (param $dy i32)
    (i32.atomic.store offset=0 (global.get $DI_MOUSE_INPUT_STATE) (local.get $dx))
    (i32.atomic.store offset=4 (global.get $DI_MOUSE_INPUT_STATE) (local.get $dy)))
  (func (export "test_di_mouse_seed_overflow") (param $dx i32) (param $dy i32)
    (i32.atomic.store offset=272 (global.get $DI_MOUSE_INPUT_STATE) (local.get $dx))
    (i32.atomic.store offset=276 (global.get $DI_MOUSE_INPUT_STATE) (local.get $dy)))
  (func (export "test_di_mouse_queue_event") (param $event i32)
    (local $tail i32)
    (local.set $tail (i32.atomic.load offset=12 (global.get $DI_MOUSE_INPUT_STATE)))
    (i32.atomic.store
      (i32.add (global.get $DI_MOUSE_INPUT_STATE)
        (i32.add (i32.const 16)
          (i32.shl (i32.and (local.get $tail) (i32.const 63)) (i32.const 2))))
      (local.get $event))
    (i32.atomic.store offset=12 (global.get $DI_MOUSE_INPUT_STATE)
      (i32.add (local.get $tail) (i32.const 1))))
  (func (export "test_di_mouse_peek_delta") (param $axis i32) (result i32)
    (if (result i32) (local.get $axis)
      (then (call $di_mouse_delta_peek_y))
      (else (call $di_mouse_delta_peek_x))))
  (func (export "test_di_mouse_get_data")
        (param $obj i32) (param $buffer i32) (param $count i32) (param $flags i32)
        (result i32)
    (global.set $esp (i32.const 0x074ff000))
    (call $handle_IDirectInputDevice_GetDeviceData
      (local.get $obj) (i32.const 16) (local.get $buffer) (local.get $count)
      (local.get $flags) (i32.const 0))
    (global.get $eax))
  (func (export "test_di_mouse_get_state")
        (param $obj i32) (param $buffer i32) (result i32)
    (global.set $esp (i32.const 0x074ff000))
    (call $handle_IDirectInputDevice_GetDeviceState
      (local.get $obj) (i32.const 16) (local.get $buffer)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_di_set_buffer_size")
        (param $obj i32) (param $property i32)
    (global.set $esp (i32.const 0x074ff000))
    (call $handle_IDirectInputDevice_SetProperty
      (local.get $obj) (i32.const 1) (local.get $property)
      (i32.const 0) (i32.const 0) (i32.const 0)))
  (func (export "test_di_buffer_size") (param $obj i32) (result i32)
    (i32.load offset=12 (call $dx_from_this (local.get $obj))))
`;

(async () => {
  assert.strictEqual(
    apiTable.find(api => api.name === 'IDirectInputDevice_EnumObjects').nargs,
    4,
    'EnumObjects metadata includes this + callback + ref + flags'
  );
  const { exports: wat } = await bootRenderHarness({ extraWat });
  const stack = 0x074ff000;

  assert.strictEqual(
    wat.test_call_IDirectInputDevice_EnumObjects(stack) >>> 0,
    stack + 20,
    'IDirectInputDevice::EnumObjects must pop this + 3 parameters + return address'
  );
  assert.strictEqual(wat.get_eax() >>> 0, 0x80070057,
    'EnumObjects rejects a null callback instead of silently succeeding');

  const mouse = wat.test_di_mouse_create() >>> 0;
  const keyboard = wat.test_di_keyboard_create() >>> 0;
  const root = wat.test_di_root_create(0x0700) >>> 0;
  const count = 0x00410100;
  const data = 0x00410200;

  // Win98-era DirectInput enumerates the system mouse and keyboard through
  // the guest callback. The callback owns only the descriptor lifetime and
  // controls whether the walk continues.
  const callback = 0x00420000;
  const ref = 0xfeed1234;
  let callbackStack = wat.test_di_enum_devices(root, stack, 0, 1, callback, ref) >>> 0;
  assert.strictEqual(wat.test_di_get_eip() >>> 0, callback);
  assert.strictEqual(wat.guest_read32(callbackStack) >>> 0, 0x0bad0011,
    'EnumDevices returns through the generic callback continuation');
  assert.strictEqual(wat.guest_read32(callbackStack + 8) >>> 0, ref);
  let descriptor = wat.guest_read32(callbackStack + 4) >>> 0;
  assert.deepStrictEqual([
    wat.guest_read32(descriptor),
    wat.guest_read32(descriptor + 4) >>> 0,
    wat.guest_read32(descriptor + 8) >>> 0,
    wat.guest_read32(descriptor + 36) >>> 0,
  ], [580, 0x6f1d2b60, 0x11cfd5a0, 0x0202],
  'first descriptor is the traditional system mouse');
  assert.strictEqual(String.fromCharCode(...Array.from({ length: 5 }, (_, i) =>
    wat.guest_read8(descriptor + 40 + i))), 'Mouse');

  callbackStack = wat.test_di_enum_continue(1) >>> 0;
  descriptor = wat.guest_read32(callbackStack + 4) >>> 0;
  assert.deepStrictEqual([
    wat.guest_read32(descriptor + 4) >>> 0,
    wat.guest_read32(descriptor + 36) >>> 0,
  ], [0x6f1d2b61, 0x0403], 'DIENUM_CONTINUE advances to the system keyboard');
  assert.strictEqual(wat.test_di_enum_continue(1) >>> 0, stack + 24,
    'continuing past the final device restores the caller stack');
  assert.strictEqual(wat.test_di_get_eip() >>> 0, 0x12345678);

  callbackStack = wat.test_di_enum_devices(root, stack, 3, 1, callback, ref) >>> 0;
  descriptor = wat.guest_read32(callbackStack + 4) >>> 0;
  assert.strictEqual(wat.guest_read32(descriptor + 36) >>> 0, 0x0403,
    'legacy DIDEVTYPE_KEYBOARD filtering skips the mouse');
  assert.strictEqual(wat.test_di_enum_continue(0) >>> 0, stack + 24,
    'DIENUM_STOP restores the original caller immediately');
  assert.strictEqual(wat.test_di_enum_devices(root, stack, 0, 0x100, callback, ref) >>> 0,
    stack + 24, 'force-feedback filtering produces an honest empty enumeration');

  callbackStack = wat.test_di_enum_objects(mouse, stack, 0, callback, ref) >>> 0;
  descriptor = wat.guest_read32(callbackStack + 4) >>> 0;
  assert.deepStrictEqual([
    wat.guest_read32(descriptor),
    wat.guest_read32(descriptor + 4) >>> 0,
    wat.guest_read32(descriptor + 20),
    wat.guest_read32(descriptor + 24),
  ], [316, 0xa36d02e0, 0, 1], 'mouse enumeration begins with relative X axis');
  wat.test_di_enum_continue(1);
  descriptor = wat.guest_read32(wat.test_di_enum_continue(1) + 4) >>> 0;
  assert.deepStrictEqual([
    wat.guest_read32(descriptor + 4) >>> 0,
    wat.guest_read32(descriptor + 20),
  ], [0xa36d02e2, 8], 'mouse axis order is X, Y, wheel');

  callbackStack = wat.test_di_enum_objects(mouse, stack, 0x0c, callback, ref) >>> 0;
  descriptor = wat.guest_read32(callbackStack + 4) >>> 0;
  assert.deepStrictEqual([
    wat.guest_read32(descriptor + 4) >>> 0,
    wat.guest_read32(descriptor + 20),
    wat.guest_read32(descriptor + 24),
  ], [0xa36d02f0, 12, 0x304], 'button filtering starts at DIMOUSESTATE button 0');
  wat.test_di_enum_continue(0);

  callbackStack = wat.test_di_enum_objects(keyboard, stack, 0, callback, ref) >>> 0;
  descriptor = wat.guest_read32(callbackStack + 4) >>> 0;
  assert.deepStrictEqual([
    wat.guest_read32(descriptor + 4) >>> 0,
    wat.guest_read32(descriptor + 8) >>> 0,
    wat.guest_read32(descriptor + 20),
    wat.guest_read32(descriptor + 24),
  ], [0x55728220, 0x11cfd33c, 1, 0x104],
  'keyboard enumeration starts with DIK_ESCAPE');
  wat.test_di_enum_continue(0);

  const info = 0x00410400;
  const caps = 0x00410700;
  wat.guest_write32(info, 580);
  assert.strictEqual(wat.test_di_get_info(mouse, info) >>> 0, 0);
  assert.deepStrictEqual([
    wat.guest_read32(info), wat.guest_read32(info + 4) >>> 0,
    wat.guest_read32(info + 36) >>> 0,
  ], [580, 0x6f1d2b60, 0x0202], 'GetDeviceInfo returns the same system-mouse identity');
  wat.guest_write32(caps, 44);
  assert.strictEqual(wat.test_di_get_caps(mouse, caps) >>> 0, 0);
  assert.deepStrictEqual([
    wat.guest_read32(caps), wat.guest_read32(caps + 8) >>> 0,
    wat.guest_read32(caps + 12), wat.guest_read32(caps + 20),
  ], [44, 0x0202, 3, 3], 'GetCapabilities reports legacy mouse type, axes, and buttons');

  // Both transitions happened before DirectInput polled. A live-state-only
  // implementation sees released -> released and permanently loses the click.
  wat.test_di_mouse_queue_event(1);
  wat.test_di_mouse_queue_event(2);
  wat.guest_write32(count, 4);
  wat.test_di_mouse_get_data(mouse, 0, count, 1);
  assert.strictEqual(wat.guest_read32(count), 2,
    'count-only peek retains both edges of a completed browser click');
  wat.guest_write32(count, 1);
  wat.test_di_mouse_get_data(mouse, data, count, 0);
  assert.deepStrictEqual([wat.guest_read32(count), wat.guest_read32(data), wat.guest_read32(data + 4)],
    [1, 12, 0x80], 'first one-record poll receives the queued left-button press');
  wat.guest_write32(count, 1);
  wat.test_di_mouse_get_data(mouse, data, count, 0);
  assert.deepStrictEqual([wat.guest_read32(count), wat.guest_read32(data), wat.guest_read32(data + 4)],
    [1, 12, 0], 'second one-record poll receives the queued left-button release');

  // A fast diagonal move followed immediately by a click must preserve the
  // event order. Delivering button edges before Y hit-tests at the old row.
  wat.test_di_mouse_queue_event((5 << 28) | 7);
  wat.test_di_mouse_queue_event((6 << 28) | 0x0ffffffd);
  wat.test_di_mouse_queue_event(1);
  wat.test_di_mouse_queue_event(2);
  wat.guest_write32(count, 4);
  assert.strictEqual(wat.test_di_mouse_get_data(mouse, data, count, 1) >>> 0, 0);
  assert.strictEqual(wat.guest_read32(count), 4, 'DIGDD_PEEK reports ordered motion and click records');
  assert.deepStrictEqual([
    wat.guest_read32(data), wat.guest_read32(data + 4) | 0,
    wat.guest_read32(data + 16), wat.guest_read32(data + 20) | 0,
    wat.guest_read32(data + 32), wat.guest_read32(data + 36) | 0,
    wat.guest_read32(data + 48), wat.guest_read32(data + 52) | 0,
  ], [0, 7, 4, -3, 12, 0x80, 12, 0],
  'buffered mouse records preserve X, Y, press, release order');

  wat.guest_write32(count, 1);
  assert.strictEqual(wat.test_di_mouse_get_data(mouse, data, count, 0) >>> 0, 0);
  assert.deepStrictEqual([wat.guest_read32(data), wat.guest_read32(data + 4) | 0], [0, 7]);
  wat.guest_write32(count, 1);
  wat.test_di_mouse_get_data(mouse, data, count, 0);
  assert.deepStrictEqual([wat.guest_read32(data), wat.guest_read32(data + 4) | 0], [4, -3]);
  wat.guest_write32(count, 1);
  wat.test_di_mouse_get_data(mouse, data, count, 0);
  assert.deepStrictEqual([wat.guest_read32(data), wat.guest_read32(data + 4) | 0], [12, 0x80]);
  wat.guest_write32(count, 1);
  wat.test_di_mouse_get_data(mouse, data, count, 0);
  assert.deepStrictEqual([wat.guest_read32(data), wat.guest_read32(data + 4) | 0], [12, 0]);

  // Motion coalesced after a saturated browser ring remains visible after
  // ordinary queued records drain, in X-before-Y order.
  wat.test_di_mouse_seed_overflow(37, -21);
  wat.guest_write32(count, 4);
  wat.test_di_mouse_get_data(mouse, 0, count, 1);
  assert.strictEqual(wat.guest_read32(count), 2,
    'count-only peek includes coalesced overflow axes');
  wat.guest_write32(count, 2);
  wat.test_di_mouse_get_data(mouse, data, count, 0);
  assert.deepStrictEqual([
    wat.guest_read32(data), wat.guest_read32(data + 4) | 0,
    wat.guest_read32(data + 16), wat.guest_read32(data + 20) | 0,
  ], [0, 37, 4, -21], 'DirectInput drains coalesced overflow after the ring');

  wat.test_di_mouse_seed_delta(11, -9);
  assert.strictEqual(wat.test_di_mouse_get_state(mouse, data) >>> 0, 0);
  assert.deepStrictEqual([wat.guest_read32(data) | 0, wat.guest_read32(data + 4) | 0], [11, -9],
    'GetDeviceState consumes its physical relative-motion accumulator');

  // MCM allocates exactly DIPROP_BUFFERSIZE records on its stack. Mouse
  // events accumulated while its startup MessageBox was open used to make a
  // count-only peek report the whole browser FIFO; the following read then
  // overwrote MCM's saved return address with a DIDEVICEOBJECTDATA.dwOfs.
  const property = 0x00410300;
  wat.guest_write32(property, 20);      // DIPROPDWORD.dwSize
  wat.guest_write32(property + 4, 16);  // DIPROPHEADER.dwHeaderSize
  wat.guest_write32(property + 16, 2);  // dwData = buffer capacity
  wat.test_di_set_buffer_size(mouse, property);
  assert.strictEqual(wat.test_di_buffer_size(mouse), 2,
    'DIPROP_BUFFERSIZE is retained on the DirectInput device');
  wat.test_di_mouse_queue_event((5 << 28) | 1);
  wat.test_di_mouse_queue_event((6 << 28) | 2);
  wat.test_di_mouse_queue_event((5 << 28) | 3);
  wat.test_di_mouse_queue_event((6 << 28) | 4);
  wat.guest_write32(count, 0xffffffff);
  wat.test_di_mouse_get_data(mouse, 0, count, 1);
  assert.strictEqual(wat.guest_read32(count), 2,
    'count-only peek is capped to the configured DirectInput buffer size');
  wat.guest_write32(data + 32, 0xfeedface);
  wat.guest_write32(count, 0xffffffff);
  wat.test_di_mouse_get_data(mouse, data, count, 0);
  assert.strictEqual(wat.guest_read32(count), 2,
    'buffered read cannot deliver more records than DIPROP_BUFFERSIZE');
  assert.strictEqual(wat.guest_read32(data + 32) >>> 0, 0xfeedface,
    'buffered read leaves memory after the configured record array intact');

  console.log('PASS  DirectInput enumerates Win98 devices/objects and preserves browser input');
})().catch(error => {
  console.error(error);
  process.exit(1);
});

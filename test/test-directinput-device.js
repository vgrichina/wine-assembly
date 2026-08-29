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
  (func (export "test_di_mouse_create") (result i32)
    (local $obj i32)
    (global.set $DX_VTBL_DIDEV2 (i32.const 0x52000000))
    (local.set $obj (call $dx_create_com_obj (i32.const 7) (global.get $DX_VTBL_DIDEV2)))
    (i32.store offset=8 (call $dx_from_this (local.get $obj)) (i32.const 2))
    (local.get $obj))
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
  assert.strictEqual(wat.get_eax(), 0, 'EnumObjects succeeds after enumerating no host devices');

  const mouse = wat.test_di_mouse_create() >>> 0;
  const count = 0x00410100;
  const data = 0x00410200;

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

  console.log('PASS  DirectInput preserves EnumObjects, mouse edges, and physical movement');
})().catch(error => {
  console.error(error);
  process.exit(1);
});

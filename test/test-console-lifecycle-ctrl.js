#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_ctrl_reset")
    (call $console_ctrl_reset)
    (i32.atomic.store (region.addr $CONSOLE_INPUT 0xC10) (i32.const 1))
    (i32.store (global.get $CONSOLE_INPUT) (i32.const 0))
    (i32.store (region.addr $CONSOLE_INPUT 4) (i32.const 0))
    (i32.store (region.addr $CONSOLE_INPUT 24) (i32.const 0))
    (call $console_input_set_mode (i32.const 3)))
  (func (export "test_set_ctrl_handler") (param $handler i32) (param $add i32)
        (result i32)
    (global.set $esp (i32.const 0x00500000))
    (call $handle_SetConsoleCtrlHandler
      (local.get $handler) (local.get $add) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_prepare_ctrl_dispatch")
    (global.set $esp (i32.const 0x00500000))
    (global.set $eip (i32.const 0x00405000))
    (global.set $current_thunk_eip (i32.const 0x00403000))
    (global.set $font_enum_ret_thunk (i32.const 0x00404000)))
  (func (export "test_signal_ctrl") (param $event i32) (result i32)
    (drop (call $console_ctrl_queue (local.get $event)))
    (call $console_ctrl_maybe_begin))
  (func (export "test_return_from_ctrl") (param $handled i32)
    ;; Model HandlerRoutine's stdcall RET 4.
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
    (global.set $eax (local.get $handled))
    (i32.store (global.get $THUNK_BASE) (i32.const 0xCACA0011))
    (i32.store offset=4 (global.get $THUNK_BASE) (i32.const 0))
    (call $win32_dispatch (i32.const 0)))
  (func (export "test_push_host_key") (param $msg i32) (param $vk i32)
        (result i32)
    (call $console_input_push_host_key
      (local.get $msg) (local.get $vk) (i32.const 1)))
  (func (export "test_attach_char") (param $ch i32)
    (call $console_input_attach_char
      (local.get $ch) (call $console_vk_for_char (local.get $ch))))
  (func (export "test_set_input_mode") (param $mode i32)
    (call $console_input_set_mode (local.get $mode)))
  (func (export "test_ctrl_count") (result i32)
    (i32.atomic.load (region.addr $CONSOLE_INPUT 0xC1C)))
  (func (export "test_ctrl_pending") (result i32)
    (i32.atomic.load (region.addr $CONSOLE_INPUT 0xC14)))
  (func (export "test_ctrl_ignored") (result i32)
    (i32.atomic.load (region.addr $CONSOLE_INPUT 0xC18)))
  (func (export "test_ctrl_dispatching") (result i32)
    (global.get $console_ctrl_dispatching))
  (func (export "test_input_count") (result i32)
    (call $console_input_count))
  (func (export "test_last_error") (result i32)
    (global.get $last_error))
  (func (export "test_read_console_input") (param $buffer i32) (param $read i32)
        (result i32)
    (global.set $esp (i32.const 0x00500000))
    (global.set $eip (i32.const 0x00405000))
    (global.set $current_thunk_eip (i32.const 0x00403000))
    (global.set $font_enum_ret_thunk (i32.const 0x00404000))
    (call $handle_ReadConsoleInputA
      (i32.const 1) (local.get $buffer) (i32.const 1) (local.get $read)
      (i32.const 0) (i32.const 0))
    (global.get $eax))
`;

(async () => {
  const exits = [];
  const hostEvents = [];
  let currentHostEvent = null;
  const { exports: wat } = await bootRenderHarness({
    extraWat,
    fonts: 'none',
    extraHostOverrides: {
      exit: code => exits.push(code >>> 0),
      check_input: () => {
        currentHostEvent = hostEvents.shift() || null;
        return currentHostEvent
          ? ((currentHostEvent.vk << 16) | currentHostEvent.msg) >>> 0
          : 0;
      },
      check_input_wparam: () => currentHostEvent ? currentHostEvent.vk : 0,
      check_input_lparam: () => currentHostEvent ? currentHostEvent.lparam : 0,
      check_input_hwnd: () => 0,
    },
  });

  wat.test_ctrl_reset();
  assert.strictEqual(wat.test_set_ctrl_handler(0x00401000, 1), 1);
  assert.strictEqual(wat.test_set_ctrl_handler(0x00402000, 1), 1);
  assert.strictEqual(wat.test_ctrl_count(), 2);
  assert.strictEqual(wat.get_esp() >>> 0, 0x0050000c,
    'SetConsoleCtrlHandler did not pop its two-argument stdcall frame');

  wat.test_prepare_ctrl_dispatch();
  assert.strictEqual(wat.test_signal_ctrl(0), 1);
  assert.strictEqual(wat.get_eip() >>> 0, 0x00402000,
    'control event did not call the most recently registered handler first');
  assert.strictEqual(wat.get_esp() >>> 0, 0x004fffe8);
  assert.strictEqual(wat.guest_read32(0x004fffe8) >>> 0, 0x00404000,
    'HandlerRoutine did not return through CACA0011');
  assert.strictEqual(wat.guest_read32(0x004fffec), 0,
    'HandlerRoutine received the wrong control event');
  assert.strictEqual(wat.guest_read32(0x004ffff0) >>> 0, 0x4c544343,
    'CCTL continuation marker is missing');

  wat.test_return_from_ctrl(0);
  assert.strictEqual(wat.get_eip() >>> 0, 0x00401000,
    'FALSE did not continue to the previous handler');
  wat.test_return_from_ctrl(1);
  assert.strictEqual(wat.get_eip() >>> 0, 0x00403000,
    'TRUE did not resume the interrupted console API thunk');
  assert.strictEqual(wat.get_esp() >>> 0, 0x00500000,
    'handler chain did not restore the interrupted API stack');
  assert.strictEqual(wat.test_ctrl_dispatching(), 0);
  assert.deepStrictEqual(exits, [], 'claimed Ctrl+C ran the default exit handler');

  assert.strictEqual(wat.test_set_ctrl_handler(0x00402000, 0), 1);
  assert.strictEqual(wat.test_ctrl_count(), 1);
  assert.strictEqual(wat.test_set_ctrl_handler(0x00402000, 0), 0,
    'removing an unregistered handler succeeded');
  assert.strictEqual(wat.test_last_error(), 87);

  // NULL changes only the Ctrl+C ignore attribute. Ctrl+Break still invokes
  // the installed handler.
  assert.strictEqual(wat.test_set_ctrl_handler(0, 1), 1);
  assert.strictEqual(wat.test_ctrl_ignored(), 1);
  wat.test_prepare_ctrl_dispatch();
  assert.strictEqual(wat.test_signal_ctrl(0), 0);
  assert.strictEqual(wat.test_ctrl_pending(), 0);
  assert.strictEqual(wat.get_eip() >>> 0, 0x00405000);
  assert.strictEqual(wat.test_signal_ctrl(1), 1);
  assert.strictEqual(wat.get_eip() >>> 0, 0x00401000,
    'Ctrl+Break was incorrectly suppressed by the Ctrl+C ignore attribute');
  assert.strictEqual(wat.guest_read32(0x004fffec), 1);
  wat.test_return_from_ctrl(1);
  assert.strictEqual(wat.test_set_ctrl_handler(0, 0), 1);
  assert.strictEqual(wat.test_ctrl_ignored(), 0);

  // With processed input enabled, the C chord becomes a signal, not console
  // keyboard input. Its WM_CHAR and key-up are suppressed as one chord.
  wat.test_ctrl_reset();
  assert.strictEqual(wat.test_set_ctrl_handler(0x00401000, 1), 1);
  assert.strictEqual(wat.test_push_host_key(0x0100, 0x11), 1); // Ctrl down
  assert.strictEqual(wat.test_push_host_key(0x0100, 0x43), 1); // C down
  assert.strictEqual(wat.test_ctrl_pending(), 1);
  assert.strictEqual(wat.test_input_count(), 1);
  wat.test_attach_char(3);
  assert.strictEqual(wat.test_input_count(), 1, 'Ctrl+C WM_CHAR leaked into input');
  assert.strictEqual(wat.test_push_host_key(0x0101, 0x43), 1); // C up
  assert.strictEqual(wat.test_input_count(), 1, 'Ctrl+C key-up leaked into input');
  assert.strictEqual(wat.test_push_host_key(0x0101, 0x11), 1); // Ctrl up
  assert.strictEqual(wat.test_input_count(), 2);

  // Disabling ENABLE_PROCESSED_INPUT makes the same chord ordinary input.
  wat.test_ctrl_reset();
  wat.test_set_input_mode(0);
  wat.test_push_host_key(0x0100, 0x11);
  wat.test_push_host_key(0x0100, 0x43);
  wat.test_attach_char(3);
  assert.strictEqual(wat.test_ctrl_pending(), 0);
  assert.strictEqual(wat.test_input_count(), 2,
    'unprocessed Ctrl+C did not remain in the input buffer');

  // Exercise the real blocking console API boundary: Ctrl down is returned as
  // ordinary input, then C down redirects the intact ReadConsoleInputA frame
  // into the registered HandlerRoutine.
  wat.test_ctrl_reset();
  assert.strictEqual(wat.test_set_ctrl_handler(0x00401000, 1), 1);
  const inputRecord = wat.guest_alloc(20) >>> 0;
  const readCount = wat.guest_alloc(4) >>> 0;
  hostEvents.push({ msg: 0x0100, vk: 0x11, lparam: 1 });
  assert.strictEqual(wat.test_read_console_input(inputRecord, readCount), 1);
  assert.strictEqual(wat.guest_read32(readCount), 1);
  hostEvents.push({ msg: 0x0100, vk: 0x43, lparam: 1 });
  wat.test_read_console_input(inputRecord, readCount);
  assert.strictEqual(wat.get_eip() >>> 0, 0x00401000,
    'ReadConsoleInputA did not redirect processed Ctrl+C to HandlerRoutine');
  assert.strictEqual(wat.get_esp() >>> 0, 0x004fffe8,
    'ReadConsoleInputA popped its frame before the control callback');
  wat.test_return_from_ctrl(1);
  assert.strictEqual(wat.get_eip() >>> 0, 0x00403000);
  assert.strictEqual(wat.get_esp() >>> 0, 0x00500000);

  // Without a registered handler the default handler terminates the process.
  wat.test_ctrl_reset();
  wat.test_prepare_ctrl_dispatch();
  assert.strictEqual(wat.test_signal_ctrl(0), 1);
  assert.deepStrictEqual(exits, [0]);
  assert.strictEqual(wat.get_eip(), 0);

  console.log('PASS console Ctrl+C/Ctrl+Break registration, filtering, LIFO callbacks, and default exit');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

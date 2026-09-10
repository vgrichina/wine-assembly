#!/usr/bin/env node
'use strict';

// DialogBoxParamA owns the message loop while a modal dialog is open. Window
// timers must still reach that loop; mIRC 5.9 uses one to leave its installer
// scan phase after the payload has been read.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const ROOT = path.join(__dirname, '..');
const extraWat = String.raw`
  (func (export "test_start_dialog_pump")
      (param $hwnd i32) (param $dlgproc i32) (param $stack i32)
    (call $wnd_table_set (local.get $hwnd) (local.get $dlgproc))
    (global.set $dlg_pump_hwnd (local.get $hwnd))
    (global.set $dlg_proc (local.get $dlgproc))
    (global.set $dlg_callback_yield_pending (i32.const 0))
    (global.set $yield_reason (i32.const 0))
    (global.set $yield_flag (i32.const 0))
    (global.set $handler_set_eip (i32.const 0))
    (global.set $esp (local.get $stack))
    (global.set $eip (global.get $dlg_loop_thunk)))

  (func (export "test_start_dialog_post")
      (param $hwnd i32) (param $dlgproc i32) (param $stack i32)
      (param $msg i32) (param $wparam i32) (param $lparam i32)
    (call $wnd_table_set (local.get $hwnd) (global.get $WNDPROC_DIALOG))
    (drop (call $dialog_proc_set (local.get $hwnd) (local.get $dlgproc)))
    (global.set $dlg_pump_hwnd (local.get $hwnd))
    (global.set $dlg_proc (local.get $dlgproc))
    (global.set $dlg_callback_yield_pending (i32.const 0))
    (global.set $yield_reason (i32.const 0))
    (global.set $yield_flag (i32.const 0))
    (global.set $handler_set_eip (i32.const 0))
    (global.set $post_queue_count (i32.const 0))
    (drop (call $post_queue_push
      (local.get $hwnd) (local.get $msg)
      (local.get $wparam) (local.get $lparam)))
    (global.set $esp (local.get $stack))
    (global.set $eip (global.get $dlg_loop_thunk)))

  (func (export "test_clear_post_queue")
    (global.set $post_queue_count (i32.const 0)))
`;

function u32(value) {
  return [value, value >>> 8, value >>> 16, value >>> 24].map(v => v & 0xff);
}

(async () => {
  let now = 0;
  let input = 0;
  let inputHwnd = 0;
  let inputLparam = 0;
  const { exports: e, memory } = await bootRenderHarness({
    extraWat,
    extraHostOverrides: {
      get_ticks: () => now,
      check_input: () => { const value = input; input = 0; return value; },
      check_input_hwnd: () => inputHwnd,
      check_input_lparam: () => inputLparam,
    },
  });
  const fixture = fs.readFileSync(path.join(ROOT, 'test', 'binaries', 'calc.exe'));
  new Uint8Array(memory.buffer).set(fixture, e.get_staging());
  assert(e.load_pe(fixture.length), 'fixture PE initializes dialog continuation thunks');

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const toWasm = guest => (guest - imageBase + guestBase) >>> 0;
  const bytes = new Uint8Array(memory.buffer);
  const view = new DataView(memory.buffer);
  const seen = e.guest_alloc(16) >>> 0;
  const proc = e.guest_alloc(64) >>> 0;
  const stack = (e.guest_alloc(4096) + 4080) >>> 0;

  // WndProc(hwnd, msg, wParam, lParam): record all four arguments and return.
  bytes.set(Uint8Array.from([
    0x8b, 0x44, 0x24, 0x04, 0xa3, ...u32(seen),
    0x8b, 0x44, 0x24, 0x08, 0xa3, ...u32(seen + 4),
    0x8b, 0x44, 0x24, 0x0c, 0xa3, ...u32(seen + 8),
    0x8b, 0x44, 0x24, 0x10, 0xa3, ...u32(seen + 12),
    0x31, 0xc0,
    0xc2, 0x10, 0x00,
  ]), toWasm(proc));

  const hwnd = 0x10002;
  const timerId = 0x465;
  e.test_start_dialog_pump(hwnd, proc, stack);
  e.test_timer_set(hwnd, timerId, 25, 0);
  now = 25;
  e.run(100000);

  const seenWa = toWasm(seen);
  assert.strictEqual(view.getUint32(seenWa, true), hwnd,
    'modal dialog pump dispatches the due timer to its hwnd');
  assert.strictEqual(view.getUint32(seenWa + 4, true), 0x0113,
    'modal dialog pump synthesizes WM_TIMER');
  assert.strictEqual(view.getUint32(seenWa + 8, true), timerId,
    'modal dialog pump preserves the timer id');
  assert.strictEqual(view.getUint32(seenWa + 12, true), 0,
    'ordinary window timer has no callback lParam');

  new Uint8Array(memory.buffer, seenWa, 16).fill(0);
  const commandHwnd = 0x10003;
  e.test_start_dialog_post(commandHwnd, proc, stack,
    0x0111, 1, 0x10004);
  e.run(100000);
  assert.strictEqual(view.getUint32(seenWa, true), commandHwnd,
    'modal dialog pump dispatches a queued command to its dialog hwnd');
  assert.strictEqual(view.getUint32(seenWa + 4, true), 0x0111,
    'modal dialog pump preserves queued WM_COMMAND');
  assert.strictEqual(view.getUint32(seenWa + 8, true), 1,
    'modal dialog pump preserves queued IDOK');
  assert.strictEqual(view.getUint32(seenWa + 12, true), 0x10004,
    'modal dialog pump preserves the BUTTON hwnd');
  assert.strictEqual(e.get_sync_msg_depth(), 0,
    'queued dialog command does not enter the recursive synchronous sender');

  new Uint8Array(memory.buffer, seenWa, 16).fill(0);
  e.test_start_dialog_post(commandHwnd, proc, stack, 0, 0, 0);
  e.test_clear_post_queue();
  inputHwnd = commandHwnd;
  inputLparam = 0x10004;
  input = (1 << 16) | 0x0111;
  e.run(1);
  assert.strictEqual(e.get_eip() >>> 0, proc,
    'targeted host input enters the retained DLGPROC on the guest continuation');
  assert.strictEqual(e.get_esp() >>> 0, stack - 20,
    'host input leaves the callback frame live across scheduler slices');
  assert.strictEqual(view.getUint32(seenWa, true), 0,
    'host input must not synchronously execute the callback inside the modal pump');
  assert.strictEqual(e.get_sync_msg_depth(), 0,
    'host input must not enter the recursive synchronous sender');
  e.run(100000);
  assert.deepStrictEqual(Array.from({ length: 4 }, (_, i) =>
    view.getUint32(seenWa + i * 4, true)), [commandHwnd, 0x0111, 1, 0x10004],
  'resumed input callback preserves HWND, message, IDOK and BUTTON HWND');
  assert.strictEqual(e.get_esp() >>> 0, stack,
    'resumed input callback restores its caller stack');

  console.log('PASS  DialogBox modal pump dispatches timers, posted commands and host input');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

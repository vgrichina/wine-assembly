#!/usr/bin/env node
'use strict';

// Browser Worker mode has two WebAssembly instances over one process memory:
// the guest Worker owns the parked MessageBox call, while the main-thread
// renderer shadow hit-tests and dispatches its WAT-built button. Private WASM
// globals cannot carry modal completion between those instances.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_modal_begin") (param $hwnd i32)
    (global.set $esp (i32.const 0x00120000))
    (call $gs32 (global.get $esp) (i32.const 0x00401000))
    (call $modal_begin (local.get $hwnd) (i32.const 20)))

  (func (export "test_modal_done") (param $result i32)
    (call $modal_done (local.get $result)))

  (func (export "test_modal_pump") (result i32)
    (call $modal_pump_step (global.get $modal_loop_thunk)))

  (func (export "test_modal_result") (result i32)
    (global.get $modal_result))
`;

(async () => {
  const memory = new WebAssembly.Memory({
    initial: 8192, maximum: 8192, shared: true,
  });
  const worker = await bootRenderHarness({ extraWat, memory });
  const shadow = await bootRenderHarness({ extraWat, memory });
  const guest = worker.exports;
  const ui = shadow.exports;
  const hwnd = 0x10002;

  guest.test_modal_begin(hwnd);
  assert.strictEqual(guest.modal_dialog_hwnd() >>> 0, hwnd,
    'guest Worker publishes its common-modal hwnd');
  assert.strictEqual(ui.modal_dialog_hwnd() >>> 0, hwnd,
    'renderer shadow observes the Worker modal through shared memory');

  assert.strictEqual(guest.test_modal_pump(), 1, 'open modal remains in its pump');
  assert.strictEqual(guest.get_yield_reason(), 15, 'idle native modal uses queue sleep');
  guest.clear_yield();

  ui.test_modal_done(1);
  assert.strictEqual(ui.modal_dialog_hwnd() >>> 0, hwnd,
    'shadow only signals completion; the owning Worker performs teardown');
  assert.strictEqual(guest.test_modal_pump(), 0,
    'owning Worker consumes the shared completion on its next pump turn');
  assert.strictEqual(guest.test_modal_result(), 1,
    'MessageBox returns the button result in the owning instance');
  assert.strictEqual(guest.modal_dialog_hwnd(), 0,
    'Worker teardown clears the shared modal hwnd for the renderer');

  guest.test_modal_begin(hwnd);
  ui.modal_cancel_if_hwnd(hwnd);
  assert.strictEqual(guest.test_modal_pump(), 0,
    'renderer-side modal cancellation also resumes the owning Worker');
  assert.strictEqual(guest.test_modal_result(), 0,
    'renderer-side cancellation preserves the cancel result');

  console.log('PASS  common modal completion crosses renderer/guest Worker instances');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

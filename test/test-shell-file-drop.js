#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_drop_window_setup")
    (global.set $next_hwnd (i32.const 0x10002))
    (global.set $main_hwnd (i32.const 0x10001))
    (call $wnd_table_set (i32.const 0x10001) (i32.const 0x00401000))
    (drop (call $wnd_set_style (i32.const 0x10001) (i32.const 0x10000000)))
    ;; Prove DragAcceptFiles changes only WS_EX_ACCEPTFILES.
    (call $ctrl_set_ex_style (i32.const 0x10001) (i32.const 0x200)))

  (func (export "test_drag_accept") (param $accept i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_DragAcceptFiles (i32.const 0x10001) (local.get $accept)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (call $ctrl_get_ex_style (i32.const 0x10001)))

  (func (export "test_drag_query") (param $wide i32) (param $hdrop i32)
        (param $index i32) (param $dst i32) (param $cch i32) (result i64)
    (global.set $esp (i32.const 0x00300000))
    (if (local.get $wide)
      (then (call $handle_DragQueryFileW
        (local.get $hdrop) (local.get $index) (local.get $dst) (local.get $cch)
        (i32.const 0) (i32.const 0)))
      (else (call $handle_DragQueryFileA
        (local.get $hdrop) (local.get $index) (local.get $dst) (local.get $cch)
        (i32.const 0) (i32.const 0))))
    (i64.or (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))

  (func (export "test_drag_finish") (param $hdrop i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_DragFinish (local.get $hdrop)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp)))
`;

function low32(value) { return Number(value & 0xffffffffn) >>> 0; }
function high32(value) { return Number(value >> 32n) >>> 0; }

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat, fonts: 'none' });
  wat.test_drop_window_setup();

  assert.strictEqual(wat.drop_target_at(0x10001, 10, 10), 0,
    'a normal window is not a legacy file-drop target');
  assert.strictEqual(wat.test_drag_accept(1) >>> 0, 0x210,
    'DragAcceptFiles adds WS_EX_ACCEPTFILES without losing WS_EX_CLIENTEDGE');
  assert.strictEqual(wat.drop_target_at(0x10001, 10, 10) >>> 0, 0x10001,
    'the browser bridge resolves the registered destination HWND');
  assert.strictEqual(wat.test_drag_accept(0) >>> 0, 0x200,
    'disabling file drops removes only WS_EX_ACCEPTFILES');
  wat.test_drag_accept(1);

  const names = ['C:\\WINDOWS\\TEMP\\Dropped Files\\one.txt',
    'C:\\WINDOWS\\TEMP\\Dropped Files\\two.zip'];
  const payload = names.flatMap(name => [...Buffer.from(name, 'latin1'), 0]);
  payload.push(0);
  const size = 20 + payload.length;
  const hdrop = wat.guest_alloc(size) >>> 0;
  assert(hdrop, 'DROPFILES allocation');
  wat.guest_write32(hdrop, 20);
  wat.guest_write32(hdrop + 4, 17);
  wat.guest_write32(hdrop + 8, 29);
  wat.guest_write32(hdrop + 12, 0);
  wat.guest_write32(hdrop + 16, 0);
  payload.forEach((byte, index) => wat.guest_write8(hdrop + 20 + index, byte));

  let result = wat.test_drag_query(0, hdrop, -1, 0, 0);
  assert.strictEqual(low32(result), 2, 'iFile=-1 returns the dropped-file count');
  assert.strictEqual(high32(result), 0x00300014,
    'DragQueryFileA pops four arguments and its return address');

  result = wat.test_drag_query(0, hdrop, 1, 0, 0);
  assert.strictEqual(low32(result), names[1].length,
    'a null destination measures the selected ANSI path');

  const ansi = wat.guest_alloc(128) >>> 0;
  result = wat.test_drag_query(0, hdrop, 0, ansi, 128);
  assert.strictEqual(low32(result), names[0].length);
  const ansiText = Buffer.from(Array.from({ length: names[0].length },
    (_, index) => wat.guest_read8(ansi + index))).toString('latin1');
  assert.strictEqual(ansiText, names[0]);
  assert.strictEqual(wat.guest_read8(ansi + names[0].length), 0,
    'ANSI result is terminated');

  const short = wat.guest_alloc(5) >>> 0;
  result = wat.test_drag_query(0, hdrop, 0, short, 5);
  assert.strictEqual(low32(result), 4, 'a short buffer reports copied characters');
  assert.strictEqual(Buffer.from(Array.from({ length: 5 },
    (_, index) => wat.guest_read8(short + index))).toString('latin1'), 'C:\\W\0');

  const wide = wat.guest_alloc(256) >>> 0;
  result = wat.test_drag_query(1, hdrop, 1, wide, 128);
  assert.strictEqual(low32(result), names[1].length);
  assert.strictEqual(high32(result), 0x00300014,
    'DragQueryFileW has the same four-argument stdcall shape');
  const wideCodes = Array.from({ length: names[1].length + 1 }, (_, index) =>
    wat.guest_read8(wide + index * 2) | (wat.guest_read8(wide + index * 2 + 1) << 8));
  assert.strictEqual(String.fromCharCode(...wideCodes.slice(0, -1)), names[1]);
  assert.strictEqual(wideCodes.at(-1), 0, 'Unicode result is terminated');

  assert.strictEqual(wat.post_message_q(0x10001, 0x0233, hdrop, 0), 1);
  assert.strictEqual(wat.post_queue_peek(0, 0) >>> 0, 0x10001);
  assert.strictEqual(wat.post_queue_peek(0, 1) >>> 0, 0x0233);
  assert.strictEqual(wat.post_queue_peek(0, 2) >>> 0, hdrop,
    'WM_DROPFILES carries the HDROP in wParam');

  wat.test_drag_finish(hdrop);
  assert.strictEqual(wat.guest_alloc(size) >>> 0, hdrop,
    'DragFinish returns the DROPFILES block to the guest heap');

  console.log('PASS  Win98 file-drop registration, WM_DROPFILES payload queries, and release');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_create_control_class") (param $class i32) (result i32)
    (call $ctrl_create_child
      (i32.const 0) (local.get $class) (i32.const 77)
      (i32.const 0) (i32.const 0) (i32.const 20) (i32.const 10)
      (i32.const 0) (i32.const 0)))

  (func (export "test_call_GetClassNameA")
    (param $hwnd i32) (param $buf i32) (param $max i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_GetClassNameA
      (local.get $hwnd) (local.get $buf) (local.get $max)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_GetClassNameW")
    (param $hwnd i32) (param $buf i32) (param $max i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_GetClassNameW
      (local.get $hwnd) (local.get $buf) (local.get $max)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))
`;

(async () => {
  const { exports: e, memory } = await bootRenderHarness({ extraWat });
  const bytes = new Uint8Array(memory.buffer);
  const base = e.get_guest_base() >>> 0;
  const buf = e.guest_alloc(64) >>> 0;

  const readAnsi = () => {
    let value = '';
    for (let p = base + buf; bytes[p]; p++) value += String.fromCharCode(bytes[p]);
    return value;
  };
  const readWide = () => {
    let value = '';
    const view = new DataView(memory.buffer);
    for (let p = base + buf; view.getUint16(p, true); p += 2) {
      value += String.fromCharCode(view.getUint16(p, true));
    }
    return value;
  };

  for (const [controlClass, expected] of [
    [1, 'Button'], [2, 'Edit'], [3, 'Static'],
    [4, 'ListBox'], [5, 'ComboBox'], [7, 'ScrollBar'],
  ]) {
    const hwnd = e.test_create_control_class(controlClass) >>> 0;
    bytes.fill(0xcc, base + buf, base + buf + 64);
    assert.strictEqual(e.test_call_GetClassNameA(hwnd, buf, 32), expected.length);
    assert.strictEqual(readAnsi(), expected,
      `GetClassNameA reports ${expected} for WAT control class ${controlClass}`);
  }

  const button = e.test_create_control_class(1) >>> 0;
  bytes.fill(0xcc, base + buf, base + buf + 64);
  assert.strictEqual(e.test_call_GetClassNameA(button, buf, 4), 3);
  assert.strictEqual(readAnsi(), 'But', 'ANSI result honors nMaxCount including NUL');

  bytes.fill(0xcc, base + buf, base + buf + 64);
  assert.strictEqual(e.test_call_GetClassNameW(button, buf, 32), 6);
  assert.strictEqual(readWide(), 'Button', 'wide API uses the same standard-control name');

  console.log('PASS  GetClassNameA/W identify WAT-owned standard controls');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

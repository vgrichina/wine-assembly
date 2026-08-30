#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_start_directplay_enumerate")
      (param $ansi i32) (param $callback i32) (param $context i32) (result i32)
    (global.set $esp (i32.const 0x074FF000))
    (call $gs32 (global.get $esp) (i32.const 0))
    (if (local.get $ansi)
      (then
        (call $handle_DirectPlayEnumerateA
          (local.get $callback) (local.get $context) (i32.const 0)
          (i32.const 0) (i32.const 0) (i32.const 0)))
      (else
        (call $handle_DirectPlayEnumerate
          (local.get $callback) (local.get $context) (i32.const 0)
          (i32.const 0) (i32.const 0) (i32.const 0))))
    (global.get $eip))

  (func (export "test_null_directplay_enumerate") (result i64)
    (global.set $eip (i32.const 0))
    (global.set $esp (i32.const 0x074FF000))
    (call $gs32 (global.get $esp) (i32.const 0))
    (call $handle_DirectPlayEnumerateA
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))
`;

(async () => {
  const { exports: e, memory } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const root = path.join(__dirname, '..');
  const exe = fs.readFileSync(path.join(root, 'test', 'binaries', 'calc.exe'));
  new Uint8Array(memory.buffer).set(exe, e.get_staging());
  assert(e.load_pe(exe.length), 'PE load initializes callback continuation thunks');

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const wa = guest => (guest - imageBase + guestBase) >>> 0;
  const bytes = new Uint8Array(memory.buffer);
  const callback = e.guest_alloc(16) >>> 0;
  // BOOL CALLBACK callback(...): return TRUE and pop five stdcall arguments.
  bytes.set([0xb8, 1, 0, 0, 0, 0xc2, 0x14, 0], wa(callback));

  const readAnsi = pointer => {
    let value = '';
    for (let index = 0; index < 128; index++) {
      const byte = e.guest_read8(pointer + index);
      if (!byte) break;
      value += String.fromCharCode(byte);
    }
    return value;
  };
  const runCallback = () => {
    for (let index = 0; index < 1000 && e.get_eip(); index++) e.run(1000);
    assert.strictEqual(e.get_eip(), 0, 'callback continuation restores the API caller');
    assert.strictEqual(e.get_eax(), 0, 'DirectPlayEnumerate returns DP_OK');
    assert.strictEqual(e.get_esp() >>> 0, 0x074ff00c,
      'API and callback both honor their stdcall frame sizes');
  };

  for (const [ansi, context] of [[0, 0x12345678], [1, 0x87654321]]) {
    assert.strictEqual(e.test_start_directplay_enumerate(ansi, callback, context) >>> 0,
      callback, 'enumeration enters the guest callback');
    const stack = e.get_esp() >>> 0;
    const guid = e.guest_read32(stack + 4) >>> 0;
    const name = e.guest_read32(stack + 8) >>> 0;
    assert.strictEqual(e.guest_read32(guid) >>> 0, 0x36e95ee0);
    assert.strictEqual(e.guest_read32(guid + 4) >>> 0, 0x11cf8577);
    assert.strictEqual(e.guest_read32(guid + 8) >>> 0, 0x80000c96);
    assert.strictEqual(e.guest_read32(guid + 12) >>> 0, 0x824e53c7,
      'callback receives DPSPGUID_TCPIP');
    assert.strictEqual(readAnsi(name), 'Internet TCP/IP Connection For DirectPlay');
    assert.strictEqual(e.guest_read32(stack + 12), 6, 'provider major version is 6');
    assert.strictEqual(e.guest_read32(stack + 16), 0, 'provider minor version is 0');
    assert.strictEqual(e.guest_read32(stack + 20) >>> 0, context >>> 0,
      'caller context survives callback setup');
    runCallback();
  }

  const nullResult = e.test_null_directplay_enumerate();
  assert.strictEqual(Number(nullResult & 0xffffffffn) >>> 0, 0x80070057,
    'a NULL callback returns DPERR_INVALIDPARAMS');
  assert.strictEqual(Number(nullResult >> 32n) >>> 0, 0x074ff00c,
    'invalid-parameter return still consumes the two-argument frame');

  console.log('PASS  DirectPlayEnumerate exposes the Win98 TCP/IP provider through a guest callback');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

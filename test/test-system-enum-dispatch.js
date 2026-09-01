#!/usr/bin/env node

'use strict';

// The one-string system enumerators borrow CACA0011, whose default frame is
// only one saved return address. Pin the typed SYS1 frame separately: callback
// RET 4 must expose marker/allocation/return in that order, and dispatch must
// free the allocation while restoring the API caller's exact EIP/ESP.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_system_enum_enter") (result i32)
    (global.set $image_base (i32.const 0x00400000))
    (global.set $esp (i32.const 0x00500000))
    (global.set $eip (i32.const 0x00409999))
    (global.set $font_enum_ret_thunk (i32.const 0x00402000))
    ;; The source string goes in $TEST_SCRATCH, the region declared for exactly
    ;; this. 0x2DA used to be spelled here, which was an interior address of
    ;; $STRING_CONSTANTS — a live region — so the test both wrote over real
    ;; string data and held a copy of a map the allocator re-places.
    (i32.store (region.addr $TEST_SCRATCH 0) (i32.const 0x32353132))
    (i32.store8 offset=4 (region.addr $TEST_SCRATCH 0) (i32.const 0))
    (call $system_string_enum_a
      (i32.const 0x00401000) (region.addr $TEST_SCRATCH 0) (i32.const 0x00401234))
    (global.get $esp))
  (func (export "test_system_enum_return") (result i32)
    ;; Model the callback's stdcall RET 4: return address plus LPSTR argument.
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
    (i32.store (global.get $THUNK_BASE) (i32.const 0xCACA0011))
    (i32.store offset=4 (global.get $THUNK_BASE) (i32.const 0))
    (call $win32_dispatch (i32.const 0))
    (global.get $eax))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat });
  const esp = wat.test_system_enum_enter() >>> 0;
  assert.strictEqual(esp, 0x004fffec);
  assert.strictEqual(wat.get_eip() >>> 0, 0x00401000,
    'enumerator enters the guest callback');
  assert.strictEqual(wat.guest_read32(esp) >>> 0, 0x00402000,
    'callback returns through CACA0011');
  const text = wat.guest_read32(esp + 4) >>> 0;
  assert(text, 'callback receives an allocated guest string');
  assert.strictEqual(wat.guest_read32(esp + 8) >>> 0, 0x31535953,
    'RET 4 exposes the SYS1 typed marker');
  assert.strictEqual(wat.guest_read32(esp + 12) >>> 0, text,
    'typed frame retains the allocation to release');
  assert.strictEqual(wat.guest_read32(esp + 16) >>> 0, 0x00401234,
    'typed frame retains the API return address');

  assert.strictEqual(wat.test_system_enum_return(), 1);
  assert.strictEqual(wat.get_eip() >>> 0, 0x00401234,
    'dispatch resumes the API caller');
  assert.strictEqual(wat.get_esp() >>> 0, 0x00500000,
    'dispatch consumes the whole typed frame');

  console.log('PASS system enumeration callback continuation restores EIP/ESP');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

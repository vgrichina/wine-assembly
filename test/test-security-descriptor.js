#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_call_InitializeSecurityDescriptor")
    (param $descriptor i32) (param $revision i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_InitializeSecurityDescriptor
      (local.get $descriptor) (local.get $revision)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_AllocateAndInitializeSid")
    (param $authority i32) (param $count i32)
    (param $sub0 i32) (param $sub1 i32) (param $out i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (global.set $esp (i32.const 0x07000000))
    ;; Arguments 6-10 are unused subauthorities; argument 11 is the output.
    (call $gs32 (i32.const 0x07000018) (i32.const 0))
    (call $gs32 (i32.const 0x0700001C) (i32.const 0))
    (call $gs32 (i32.const 0x07000020) (i32.const 0))
    (call $gs32 (i32.const 0x07000024) (i32.const 0))
    (call $gs32 (i32.const 0x07000028) (i32.const 0))
    (call $gs32 (i32.const 0x0700002C) (local.get $out))
    (call $handle_AllocateAndInitializeSid
      (local.get $authority) (local.get $count)
      (local.get $sub0) (local.get $sub1) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_SetSecurityDescriptorOwner")
    (param $descriptor i32) (param $sid i32) (param $defaulted i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_SetSecurityDescriptorOwner
      (local.get $descriptor) (local.get $sid) (local.get $defaulted)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_EqualSid") (param $a i32) (param $b i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_EqualSid
      (local.get $a) (local.get $b)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_FreeSid") (param $sid i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_FreeSid
      (local.get $sid) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat });
  const descriptor = e.guest_alloc(20) >>> 0;
  assert.strictEqual(e.test_call_InitializeSecurityDescriptor(descriptor, 1), 1);
  assert.strictEqual(e.guest_read8(descriptor), 1, 'descriptor revision is initialized');
  assert.strictEqual(e.guest_read32(descriptor + 4), 0, 'owner starts empty');
  assert.strictEqual(e.test_call_InitializeSecurityDescriptor(descriptor, 2), 0,
    'unsupported descriptor revisions fail');

  const authority = e.guest_alloc(6) >>> 0;
  for (let i = 0; i < 6; i++) e.guest_write8(authority + i, i === 5 ? 5 : 0);
  const outA = e.guest_alloc(4) >>> 0;
  const outB = e.guest_alloc(4) >>> 0;
  assert.strictEqual(e.test_call_AllocateAndInitializeSid(
    authority, 2, 0x20, 0x220, outA), 1);
  assert.strictEqual(e.test_call_AllocateAndInitializeSid(
    authority, 2, 0x20, 0x220, outB), 1);
  const sidA = e.guest_read32(outA) >>> 0;
  const sidB = e.guest_read32(outB) >>> 0;
  assert(sidA && sidB && sidA !== sidB, 'each call allocates a real SID');
  assert.strictEqual(e.guest_read8(sidA), 1);
  assert.strictEqual(e.guest_read8(sidA + 1), 2);
  assert.strictEqual(e.guest_read8(sidA + 7), 5);
  assert.strictEqual(e.guest_read32(sidA + 8) >>> 0, 0x20);
  assert.strictEqual(e.guest_read32(sidA + 12) >>> 0, 0x220);
  assert.strictEqual(e.test_call_EqualSid(sidA, sidB), 1,
    'EqualSid compares equivalent layouts, not pointer identity');
  e.guest_write32(sidB + 12, 0x221);
  assert.strictEqual(e.test_call_EqualSid(sidA, sidB), 0);

  assert.strictEqual(e.test_call_SetSecurityDescriptorOwner(descriptor, sidA, 1), 1);
  assert.strictEqual(e.guest_read32(descriptor + 4) >>> 0, sidA);
  assert.strictEqual(e.guest_read8(descriptor + 2) & 1, 1,
    'SE_OWNER_DEFAULTED is recorded');
  assert.strictEqual(e.test_call_SetSecurityDescriptorOwner(descriptor, sidA, 0), 1);
  assert.strictEqual(e.guest_read8(descriptor + 2) & 1, 0,
    'clearing defaulted clears the control bit');

  assert.strictEqual(e.test_call_FreeSid(sidA), 0, 'FreeSid returns NULL');
  assert.strictEqual(e.test_call_FreeSid(sidB), 0);

  console.log('PASS  classic security descriptor and SID construction contract');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

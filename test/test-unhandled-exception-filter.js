#!/usr/bin/env node

'use strict';

// SetUnhandledExceptionFilter / UnhandledExceptionFilter.
//
// A CRT installs a top-level filter at startup and expects the previous one
// back so it can put it there again on the way out; a DLL that installs its
// own is expected to chain to whatever it displaced. Returning a fabricated 0
// tells every caller it is the first one and quietly drops the filter that was
// already there.
//
// UnhandledExceptionFilter itself is where a fault nobody claimed ends up --
// msvcrt's _XcptFilter tail is `push [ebp+0xc]; call [UnhandledExceptionFilter]`
// -- so it must survive being called and report the exception in the record it
// was handed, including the degenerate null-pointer forms that are legal input.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_set_unhandled_filter") (param $filter i32) (result i32)
    (global.set $image_base (i32.const 0))
    (global.set $esp (i32.const 0x00300000))
    (call $handle_SetUnhandledExceptionFilter (local.get $filter) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_stored_filter") (result i32)
    (global.get $unhandled_exception_filter))
  (func (export "test_add_vectored_filter") (param $first i32) (param $filter i32) (result i64)
    (global.set $image_base (i32.const 0))
    (global.set $esp (i32.const 0x00300000))
    (call $handle_AddVectoredExceptionHandler (local.get $first) (local.get $filter)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))
  (func (export "test_remove_vectored_filter") (param $handle i32) (result i64)
    (global.set $image_base (i32.const 0))
    (global.set $esp (i32.const 0x00300000))
    (call $handle_RemoveVectoredExceptionHandler (local.get $handle) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))
  (func (export "test_unhandled_filter") (param $pointers i32) (result i64)
    (global.set $image_base (i32.const 0))
    (global.set $esp (i32.const 0x00300000))
    (call $handle_UnhandledExceptionFilter (local.get $pointers) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat });

  // --- the setter round-trips ---
  assert.strictEqual(wat.test_set_unhandled_filter(0x00401234) >>> 0, 0,
    'the first caller is told there was no previous filter');
  assert.strictEqual(wat.test_stored_filter() >>> 0, 0x00401234,
    'the filter is actually stored, not discarded');
  assert.strictEqual(wat.test_set_unhandled_filter(0x00405678) >>> 0, 0x00401234,
    'the second caller gets the filter it displaced');
  assert.strictEqual(wat.test_stored_filter() >>> 0, 0x00405678);
  // Clearing is a real operation: passing NULL restores default handling and
  // still reports what was there.
  assert.strictEqual(wat.test_set_unhandled_filter(0) >>> 0, 0x00405678,
    'clearing the filter reports the one being removed');
  assert.strictEqual(wat.test_stored_filter() >>> 0, 0);

  // --- the bounded vectored registration round-trips its opaque handle ---
  const vector = 0x00408765;
  const added = wat.test_add_vectored_filter(1, vector);
  assert.strictEqual(Number(added & 0xffffffffn), vector,
    'registration returns a non-null opaque handle');
  assert.strictEqual(Number(added >> 32n), 0x0030000c,
    'two-argument stdcall pops return plus arguments');
  const removed = wat.test_remove_vectored_filter(vector);
  assert.strictEqual(Number(removed & 0xffffffffn), 1,
    'the returned handle removes its registration');
  assert.strictEqual(Number(removed >> 32n), 0x00300008,
    'one-argument removal pops return plus argument');
  assert.strictEqual(Number(wat.test_remove_vectored_filter(vector) & 0xffffffffn), 0,
    'a stale handle no longer removes anything');

  // --- the filter itself ---
  const EXECUTE_HANDLER = 1;
  const record = 0x2700;
  const pointers = 0x2800;
  wat.guest_write32(record + 0, 0xC0000005);   // ExceptionCode: ACCESS_VIOLATION
  wat.guest_write32(record + 4, 0);            // ExceptionFlags: continuable
  wat.guest_write32(record + 8, 0);            // nested record
  wat.guest_write32(record + 12, 0x00404040);  // ExceptionAddress
  wat.guest_write32(pointers + 0, record);
  wat.guest_write32(pointers + 4, 0);          // ContextRecord

  const espBefore = 0x00300000;
  const handled = wat.test_unhandled_filter(pointers);
  assert.strictEqual(Number(handled & 0xffffffffn), EXECUTE_HANDLER,
    'reports EXCEPTION_EXECUTE_HANDLER so the caller runs its own __except');
  assert.strictEqual(Number(handled >> 32n), espBefore + 8,
    'stdcall with one argument pops the return address and the argument');

  // A null EXCEPTION_POINTERS, and a non-null one whose ExceptionRecord is
  // null, are both legal. Neither may be dereferenced and neither may trap --
  // this function is the last thing standing between a fault and the process.
  const nullPointers = wat.test_unhandled_filter(0);
  assert.strictEqual(Number(nullPointers & 0xffffffffn), EXECUTE_HANDLER,
    'a null EXCEPTION_POINTERS is survivable');
  assert.strictEqual(Number(nullPointers >> 32n), espBefore + 8);

  wat.guest_write32(pointers + 0, 0);
  const nullRecord = wat.test_unhandled_filter(pointers);
  assert.strictEqual(Number(nullRecord & 0xffffffffn), EXECUTE_HANDLER,
    'a null ExceptionRecord inside a valid EXCEPTION_POINTERS is survivable');
  assert.strictEqual(Number(nullRecord >> 32n), espBefore + 8);

  console.log('PASS  unhandled exception filter stores, chains and survives null records');
})().catch(err => { console.error(err); process.exit(1); });

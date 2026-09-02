#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_call_DdeInitialize")
      (param $pid i32) (param $callback i32) (param $flags i32)
      (param $reserved i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_DdeInitializeA
      (local.get $pid) (local.get $callback) (local.get $flags)
      (local.get $reserved) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_DdeCreateStringHandle")
      (param $id i32) (param $string i32) (param $codepage i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_DdeCreateStringHandleA
      (local.get $id) (local.get $string) (local.get $codepage)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_DdeNameService")
      (param $id i32) (param $service i32) (param $reserved i32)
      (param $command i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_DdeNameService
      (local.get $id) (local.get $service) (local.get $reserved)
      (local.get $command) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_DdeFreeStringHandle")
      (param $id i32) (param $string i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_DdeFreeStringHandle
      (local.get $id) (local.get $string) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_dde_hsz_refs")
      (param $id i32) (param $handle i32) (result i32)
    (local $entry i32)
    (local.set $entry (call $dde32_hsz_find (local.get $handle) (local.get $id)))
    (if (result i32) (local.get $entry)
      (then (call $gl32 (i32.add (local.get $entry) (i32.const 8))))
      (else (i32.const 0))))

  (func (export "test_call_DdeConnect")
    (param $id i32) (param $service i32) (param $topic i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_DdeConnect
      (local.get $id) (local.get $service) (local.get $topic) (i32.const 0)
      (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_DdeClientTransaction")
    (param $data i32) (param $size i32) (param $conv i32)
    (param $item i32) (param $format i32) (param $type i32)
    (param $result_ptr i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (global.set $esp (i32.const 0x07000000))
    ;; Sixth argument wType, seventh timeout, eighth result pointer.
    (call $gs32 (i32.const 0x07000018) (local.get $type))
    (call $gs32 (i32.const 0x0700001C) (i32.const 1000))
    ;; Eighth argument pdwResult follows the return address and seven args.
    (call $gs32 (i32.const 0x07000020) (local.get $result_ptr))
    (call $handle_DdeClientTransaction
      (local.get $data) (local.get $size) (local.get $conv)
      (local.get $item) (local.get $format) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_DdeDisconnect") (param $conv i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_DdeDisconnect
      (local.get $conv) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_DdeGetLastError") (param $id i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_DdeGetLastError
      (local.get $id) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_make_dde_data")
      (param $id i32) (param $source i32) (param $size i32) (result i32)
    (call $dde32_data_create (local.get $id) (local.get $source) (local.get $size)))

  (func (export "test_call_DdeGetData")
      (param $handle i32) (param $destination i32) (param $maximum i32)
      (param $offset i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_DdeGetData
      (local.get $handle) (local.get $destination) (local.get $maximum)
      (local.get $offset) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_DdeFreeDataHandle") (param $handle i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_DdeFreeDataHandle
      (local.get $handle) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_DdeUninitialize") (param $id i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_DdeUninitialize
      (local.get $id) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))
`;

(async () => {
  const { exports: e, memory } = await bootRenderHarness({ extraWat });
  const root = path.join(__dirname, '..');
  const exe = fs.readFileSync(path.join(root, 'test', 'binaries', 'calc.exe'));
  new Uint8Array(memory.buffer).set(exe, e.get_staging());
  assert(e.load_pe(exe.length), 'PE load initializes the guest heap');

  const pid = e.guest_alloc(4) >>> 0;
  e.guest_write32(pid, 0);
  assert.strictEqual(e.test_call_DdeInitialize(pid, 0, 0, 0) >>> 0, 0x4006,
    'DdeInitialize requires a callback');
  assert.strictEqual(e.test_call_DdeInitialize(pid, 0x401000, 0, 1) >>> 0, 0x4006,
    'DdeInitialize rejects its nonzero reserved argument');
  assert.strictEqual(e.test_call_DdeInitialize(pid, 0x401000, 0, 0), 0);
  const id = e.guest_read32(pid) >>> 0;
  assert(id, 'DdeInitialize publishes a live instance id');
  assert.strictEqual(e.test_call_DdeInitialize(pid, 0x402000, 0, 0), 0,
    'a nonzero pid value reinitializes the same DDEML instance');
  assert.strictEqual(e.guest_read32(pid) >>> 0, id);

  const putString = value => {
    const out = e.guest_alloc(value.length + 1) >>> 0;
    for (let i = 0; i < value.length; i++) e.guest_write8(out + i, value.charCodeAt(i));
    e.guest_write8(out + value.length, 0);
    return out;
  };
  const progmanInput = putString('PROGMAN');
  const progman = e.test_call_DdeCreateStringHandle(id, progmanInput, 1004) >>> 0;
  assert(progman, 'DdeCreateStringHandle returns an owned HSZ');
  // Prove the handle owns a copy instead of aliasing the caller's buffer.
  e.guest_write8(progmanInput, 'X'.charCodeAt(0));
  const progmanAgain = e.test_call_DdeCreateStringHandle(id, putString('progman'), 1004) >>> 0;
  assert.strictEqual(progmanAgain, progman,
    'DDE string handles intern their copied names case-insensitively');
  assert.strictEqual(e.test_call_DdeNameService(id, progman, 1, 1), 0,
    'DdeNameService rejects its reserved second HSZ');
  assert.strictEqual(e.test_call_DdeGetLastError(id), 0x4006,
    'the instance records the validation error');
  assert.strictEqual(e.test_call_DdeGetLastError(id), 0,
    'DdeGetLastError clears the instance error');
  assert.strictEqual(e.test_call_DdeNameService(id, progman, 0, 1), 1,
    'DdeNameService registers and retains a service name');
  assert.strictEqual(e.test_dde_hsz_refs(id, progman), 3,
    'two caller references plus the service registration retain the HSZ');

  const secondPid = e.guest_alloc(4) >>> 0;
  e.guest_write32(secondPid, 0);
  assert.strictEqual(e.test_call_DdeInitialize(secondPid, 0x403000, 0, 0), 0);
  const secondId = e.guest_read32(secondPid) >>> 0;
  assert.notStrictEqual(secondId, id, 'separate DDEML instances receive unique ids');
  assert.strictEqual(e.test_call_DdeNameService(secondId, progman, 0, 1), 0,
    'an HSZ cannot cross DDEML instance ownership');
  assert.strictEqual(e.test_call_DdeGetLastError(secondId), 0x4006);

  const conv = e.test_call_DdeConnect(id, progman, progman) >>> 0;
  assert(conv, 'the browser Win98 Program Manager conversation is process-local');
  assert.notStrictEqual(conv, progman, 'HCONV and HSZ are distinct typed handles');

  const result = e.guest_alloc(4) >>> 0;
  const command = putString('[CreateGroup("Games")]');
  e.guest_write32(result, 0);
  assert.strictEqual(
    e.test_call_DdeClientTransaction(command, 23, conv, 0, 0, 0x4050, result),
    1, 'shortcut execute transaction returns Boolean success');
  assert.strictEqual(e.guest_read32(result), 0x8000,
    'synchronous execute reports DDE_FACK');
  assert.strictEqual(
    e.test_call_DdeClientTransaction(0, 0, conv, 0, 1, 0x20b0, result),
    0, 'the virtual Program Manager does not invent request data');
  assert.strictEqual(e.test_call_DdeGetLastError(id), 0x4009,
    'an unsupported transaction records DMLERR_NOTPROCESSED');
  assert.strictEqual(
    e.test_call_DdeClientTransaction(command, 23, 0, 0, 0, 0x4050, result),
    0,
    'an invalid conversation is rejected');

  const source = e.guest_alloc(6) >>> 0;
  for (let i = 0; i < 6; i++) e.guest_write8(source + i, 0xa0 + i);
  const data = e.test_make_dde_data(id, source, 6) >>> 0;
  assert(data, 'the DDE data repository allocates an owned object');
  e.guest_write8(source + 2, 0xff);
  assert.strictEqual(e.test_call_DdeGetData(data, 0, 0, 4), 6,
    'a null destination returns the complete object size');
  const destination = e.guest_alloc(8) >>> 0;
  assert.strictEqual(e.test_call_DdeGetData(data, destination, 3, 2), 3,
    'DdeGetData applies offset and caller capacity');
  assert.deepStrictEqual([
    e.guest_read8(destination), e.guest_read8(destination + 1),
    e.guest_read8(destination + 2),
  ], [0xa2, 0xa3, 0xa4], 'DdeGetData reads the retained copy');
  assert.strictEqual(e.test_call_DdeFreeDataHandle(data), 1);
  assert.strictEqual(e.test_call_DdeGetData(data, destination, 3, 0), 0,
    'a freed data handle is invalid');
  assert.strictEqual(e.test_call_DdeGetLastError(id), 0x4006);
  assert.strictEqual(e.test_call_DdeFreeDataHandle(data), 0,
    'a stale data handle cannot be freed twice');

  assert.strictEqual(e.test_call_DdeDisconnect(conv), 1);
  assert.strictEqual(e.test_call_DdeDisconnect(conv), 0,
    'a disconnected conversation is invalidated');
  assert.strictEqual(e.test_call_DdeFreeStringHandle(id, progman), 1,
    'the caller may release its first interned HSZ reference');
  assert.strictEqual(e.test_dde_hsz_refs(id, progman), 2);
  assert.strictEqual(e.test_call_DdeNameService(id, 0, 0, 2), 1,
    'DNS_UNREGISTER with a null HSZ removes every service');
  assert.strictEqual(e.test_dde_hsz_refs(id, progman), 1);
  assert.strictEqual(e.test_call_DdeFreeStringHandle(id, progmanAgain), 1,
    'unregistering releases the service reference but preserves the caller reference');
  assert.strictEqual(e.test_call_DdeFreeStringHandle(id, progmanAgain), 0,
    'a fully released HSZ becomes invalid');
  assert.strictEqual(e.test_call_DdeUninitialize(id), 1,
    'DdeUninitialize frees all remaining instance resources');
  assert.strictEqual(e.test_call_DdeUninitialize(id), 0,
    'an instance cannot be uninitialized twice');
  assert.strictEqual(e.test_call_DdeGetLastError(id), 0x4003,
    'a dead instance reports DMLERR_DLL_NOT_INITIALIZED');
  assert.strictEqual(e.test_call_DdeUninitialize(secondId), 1);

  console.log('PASS  Win32 DDEML owns Program Manager instance, string, conversation and data state');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

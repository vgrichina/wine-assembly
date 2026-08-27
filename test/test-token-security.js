#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_call_OpenThreadToken")
    (param $thread i32) (param $access i32) (param $as_self i32) (param $out i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_OpenThreadToken
      (local.get $thread) (local.get $access) (local.get $as_self) (local.get $out)
      (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_OpenProcessToken")
    (param $process i32) (param $access i32) (param $out i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_OpenProcessToken
      (local.get $process) (local.get $access) (local.get $out)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_GetTokenInformation")
    (param $token i32) (param $class i32) (param $info i32)
    (param $length i32) (param $return_length i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_GetTokenInformation
      (local.get $token) (local.get $class) (local.get $info)
      (local.get $length) (local.get $return_length) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_LookupAccountSidW")
    (param $sid i32) (param $name i32) (param $name_len i32)
    (param $domain i32) (param $domain_len i32) (param $use i32) (result i32)
    (local $saved_esp i32) (local $frame i32)
    (local.set $saved_esp (global.get $esp))
    (local.set $frame (call $heap_alloc (i32.const 32)))
    (global.set $esp (local.get $frame))
    (call $gs32 (i32.add (local.get $frame) (i32.const 24)) (local.get $domain_len))
    (call $gs32 (i32.add (local.get $frame) (i32.const 28)) (local.get $use))
    (call $handle_LookupAccountSidW
      (i32.const 0) (local.get $sid) (local.get $name) (local.get $name_len)
      (local.get $domain) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_GetLengthSid") (param $sid i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_GetLengthSid
      (local.get $sid) (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))

  (func (export "test_call_InitializeAcl") (param $acl i32) (param $size i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_InitializeAcl (local.get $acl) (local.get $size) (i32.const 2)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp)) (global.get $eax))
  (func (export "test_call_AddAccessAllowedAce") (param $acl i32) (param $mask i32) (param $sid i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_AddAccessAllowedAce (local.get $acl) (i32.const 2) (local.get $mask)
      (local.get $sid) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp)) (global.get $eax))
  (func (export "test_call_GetAce") (param $acl i32) (param $index i32) (param $out i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_GetAce (local.get $acl) (local.get $index) (local.get $out)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp)) (global.get $eax))
  (func (export "test_call_InitializeSecurityDescriptor") (param $sd i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_InitializeSecurityDescriptor (local.get $sd) (i32.const 1)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp)) (global.get $eax))
  (func (export "test_call_SetSecurityDescriptorDacl") (param $sd i32) (param $acl i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_SetSecurityDescriptorDacl (local.get $sd) (i32.const 1) (local.get $acl)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp)) (global.get $eax))

  (func (export "test_get_last_error") (result i32)
    (global.get $last_error))
`;

(async () => {
  const { exports: e, memory } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const toWasm = guest => (guest - imageBase + guestBase) >>> 0;
  const out = e.guest_alloc(256) >>> 0;
  const view = new DataView(memory.buffer);
  const readWide = guest => {
    let result = '';
    for (let p = toWasm(guest); view.getUint16(p, true); p += 2)
      result += String.fromCharCode(view.getUint16(p, true));
    return result;
  };

  view.setUint32(toWasm(out), 0xdeadbeef, true);
  assert.strictEqual(e.test_call_OpenThreadToken(-2, 8, 1, out), 0,
    'a non-impersonating thread has no token');
  assert.strictEqual(view.getUint32(toWasm(out), true), 0,
    'failed OpenThreadToken clears the output handle');
  assert.strictEqual(e.test_get_last_error(), 1008,
    'OpenThreadToken reports ERROR_NO_TOKEN for the process fallback');

  assert.strictEqual(e.test_call_OpenProcessToken(-1, 8, out), 1,
    'TOKEN_QUERY opens the process token');
  const token = view.getUint32(toWasm(out), true);
  assert.notStrictEqual(token, 0, 'process token has an opaque handle');

  assert.strictEqual(e.test_call_GetTokenInformation(token, 2, 0, 0, out + 4), 0,
    'the first TokenGroups query performs buffer sizing');
  assert.strictEqual(e.test_get_last_error(), 122,
    'sizing query reports ERROR_INSUFFICIENT_BUFFER');
  assert.strictEqual(view.getUint32(toWasm(out + 4), true), 28,
    'administrator TOKEN_GROUPS reports its exact packed size');

  assert.strictEqual(e.test_call_GetTokenInformation(token, 2, out + 8, 28, out + 4), 1,
    'the sized TokenGroups query succeeds');
  assert.strictEqual(view.getUint32(toWasm(out + 8), true), 1,
    'emulated installer process has one enabled group');
  assert.strictEqual(view.getUint32(toWasm(out + 12), true), out + 20,
    'SID_AND_ATTRIBUTES points to the packed SID');
  assert.strictEqual(view.getUint32(toWasm(out + 16), true), 4,
    'administrator group carries SE_GROUP_ENABLED');
  assert.deepStrictEqual([
    view.getUint8(toWasm(out + 20)),
    view.getUint8(toWasm(out + 21)),
    view.getUint8(toWasm(out + 27)),
    view.getUint32(toWasm(out + 28), true),
    view.getUint32(toWasm(out + 32), true),
  ], [1, 2, 5, 32, 544],
  'process group is S-1-5-32-544 (BUILTIN\\Administrators)');
  assert.strictEqual(e.test_call_GetLengthSid(out + 20), 16,
    'GetLengthSid accounts for the SID header and two subauthorities');
  assert.strictEqual(e.test_get_last_error(), 0,
    'successful token query clears last error');

  const name = out + 64;
  const domain = out + 128;
  const nameLen = out + 192;
  const domainLen = out + 196;
  const use = out + 200;
  view.setUint32(toWasm(nameLen), 0, true);
  view.setUint32(toWasm(domainLen), 0, true);
  assert.strictEqual(e.test_call_LookupAccountSidW(out + 20, 0, nameLen, 0, domainLen, use), 0,
    'LookupAccountSidW supports a sizing query');
  assert.strictEqual(view.getUint32(toWasm(nameLen), true), 15,
    'account-name sizing includes the terminator');
  assert.strictEqual(view.getUint32(toWasm(domainLen), true), 8,
    'domain sizing includes the terminator');
  assert.strictEqual(e.test_get_last_error(), 122,
    'account sizing reports ERROR_INSUFFICIENT_BUFFER');
  view.setUint32(toWasm(nameLen), 15, true);
  view.setUint32(toWasm(domainLen), 8, true);
  assert.strictEqual(e.test_call_LookupAccountSidW(out + 20, name, nameLen, domain, domainLen, use), 1,
    'LookupAccountSidW resolves the emulated administrator group');
  assert.strictEqual(readWide(name), 'Administrators');
  assert.strictEqual(readWide(domain), 'BUILTIN');
  assert.strictEqual(view.getUint32(toWasm(nameLen), true), 14,
    'successful account-name length excludes the terminator');
  assert.strictEqual(view.getUint32(toWasm(domainLen), true), 7,
    'successful domain length excludes the terminator');
  assert.strictEqual(view.getUint32(toWasm(use), true), 4,
    'administrator group resolves as SidTypeAlias');

  const acl = e.guest_alloc(128) >>> 0;
  const aceOut = e.guest_alloc(4) >>> 0;
  const sd = e.guest_alloc(20) >>> 0;
  assert.strictEqual(e.test_call_InitializeAcl(acl, 128), 1,
    'InitializeAcl accepts an ACL_REVISION buffer');
  assert.strictEqual(view.getUint8(toWasm(acl)), 2);
  assert.strictEqual(view.getUint16(toWasm(acl + 2), true), 128);
  assert.strictEqual(view.getUint16(toWasm(acl + 4), true), 0);
  assert.strictEqual(e.test_call_AddAccessAllowedAce(acl, 0x1301ff, out + 20), 1,
    'AddAccessAllowedAce appends the administrator SID');
  assert.strictEqual(view.getUint16(toWasm(acl + 4), true), 1,
    'ACL header tracks its ACE count');
  assert.strictEqual(e.test_call_GetAce(acl, 0, aceOut), 1,
    'GetAce returns the appended record');
  const ace = view.getUint32(toWasm(aceOut), true);
  assert.strictEqual(ace, acl + 8);
  assert.strictEqual(view.getUint8(toWasm(ace)), 0,
    'record is ACCESS_ALLOWED_ACE_TYPE');
  assert.strictEqual(view.getUint32(toWasm(ace + 4), true), 0x1301ff,
    'ACE preserves its access mask');
  assert.strictEqual(e.test_call_InitializeSecurityDescriptor(sd), 1);
  assert.strictEqual(e.test_call_SetSecurityDescriptorDacl(sd, acl), 1,
    'SetSecurityDescriptorDacl attaches the absolute ACL');
  assert.strictEqual(view.getUint32(toWasm(sd + 12), true), acl);
  assert.strictEqual(view.getUint16(toWasm(sd + 2), true) & 4, 4,
    'security descriptor marks its DACL present');

  console.log('PASS NT token fallback exposes enabled BUILTIN\\Administrators');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const ROOT = path.join(__dirname, '..');

const extraWat = String.raw`
  (func (export "test_set_resource_root") (param $root i32)
    (global.set $rsrc_rva (i32.sub (local.get $root) (global.get $image_base))))

  (func (export "test_begin_enum_resource_names")
      (param $type i32) (param $callback i32) (param $lparam i32) (result i32)
    (global.set $esp (i32.const 0x07000000))
    ;; A zero return address lets the callback continuation halt cleanly after
    ;; the last resource name.
    (call $gs32 (global.get $esp) (i32.const 0))
    (call $handle_EnumResourceNamesA
      (i32.const 0) (local.get $type) (local.get $callback) (local.get $lparam)
      (i32.const 0) (i32.const 0))
    (global.get $eip))

  (func (export "test_enum_resource_thunk") (result i32)
    (global.get $enum_rsrc_thunk))
`;

function u32(value) {
  return [value, value >>> 8, value >>> 16, value >>> 24].map(v => v & 0xff);
}

(async () => {
  const { exports: e, memory } = await bootRenderHarness({ extraWat, fonts: 'none' });

  // Loading any PE initializes the callback-thunk table and establishes the
  // guest-address translation used by the synthetic resource directory.
  const fixture = fs.readFileSync(path.join(ROOT, 'test', 'binaries', 'calc.exe'));
  new Uint8Array(memory.buffer).set(fixture, e.get_staging());
  assert(e.load_pe(fixture.length), 'fixture PE initializes callback support');

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const toWasm = guest => (guest - imageBase + guestBase) >>> 0;
  const bytes = new Uint8Array(memory.buffer);
  const view = new DataView(memory.buffer);
  const write16 = (guest, value) => view.setUint16(toWasm(guest), value, true);
  const write32 = (guest, value) => view.setUint32(toWasm(guest), value >>> 0, true);

  const root = e.guest_alloc(0x200) >>> 0;
  bytes.fill(0, toWasm(root), toWasm(root + 0x200));
  // Root directory: one integer type, 256, whose name directory contains two
  // named entries followed by one MAKEINTRESOURCE entry.
  write16(root + 12, 0);
  write16(root + 14, 1);
  write32(root + 16, 0x100);
  write32(root + 20, 0x80000020);
  write16(root + 0x20 + 12, 2);
  write16(root + 0x20 + 14, 1);
  write32(root + 0x30, 0x80000080);
  write32(root + 0x38, 0x800000a0);
  write32(root + 0x40, 7);
  const putResourceName = (offset, text) => {
    write16(root + offset, text.length);
    for (let i = 0; i < text.length; i++) write16(root + offset + 2 + i * 2, text.charCodeAt(i));
  };
  putResourceName(0x80, 'ALPHA');
  putResourceName(0xa0, 'BETA');
  e.test_set_resource_root(root);

  const observed = e.guest_alloc(32) >>> 0;
  const callback = e.guest_alloc(96) >>> 0;
  bytes.fill(0, toWasm(observed), toWasm(observed + 32));

  // ENUMRESNAMEPROCA: retain type/module/lParam, then record either the first
  // four ANSI bytes of a named resource or the integer ID itself.
  bytes.set(Uint8Array.from([
    0x8b, 0x44, 0x24, 0x08,             // mov eax,[esp+8]  (lpType)
    0xa3, ...u32(observed + 16),
    0x8b, 0x44, 0x24, 0x04,             // mov eax,[esp+4]  (hModule)
    0xa3, ...u32(observed + 20),
    0x8b, 0x44, 0x24, 0x10,             // mov eax,[esp+16] (lParam)
    0xa3, ...u32(observed + 24),
    0x8b, 0x44, 0x24, 0x0c,             // mov eax,[esp+12] (lpName)
    0x8b, 0x0d, ...u32(observed),        // mov ecx,[count]
    0x3d, 0x00, 0x00, 0x01, 0x00,       // cmp eax,0x10000
    0x72, 0x04,                         // jb integer_name
    0x8b, 0x10,                         // mov edx,[eax]
    0xeb, 0x02,                         // jmp store_name
    0x89, 0xc2,                         // integer_name: mov edx,eax
    0x89, 0x14, 0x8d, ...u32(observed + 4), // mov [observed+4+ecx*4],edx
    0x41,                               // inc ecx
    0x89, 0x0d, ...u32(observed),        // mov [count],ecx
    0xb8, 0x01, 0x00, 0x00, 0x00,       // mov eax,TRUE
    0xc2, 0x10, 0x00,                   // ret 16
  ]), toWasm(callback));

  assert.notStrictEqual(e.test_enum_resource_thunk() >>> 0, 0,
    'EnumResourceNames continuation thunk is initialized');
  assert.strictEqual(
    e.test_begin_enum_resource_names(0x100, callback, 0xdecafbad) >>> 0,
    callback,
    'enumeration enters the first guest callback');
  for (let i = 0; i < 30 && e.get_eip(); i++) e.run(5000);

  assert.strictEqual(e.get_eip() >>> 0, 0,
    'the final callback resumes the saved API caller');
  assert.strictEqual(e.get_eax() >>> 0, 1,
    'enumerating every name returns TRUE');
  assert.strictEqual(e.get_esp() >>> 0, 0x07000014,
    'EnumResourceNamesA pops its return address and four arguments');
  assert.strictEqual(view.getUint32(toWasm(observed), true), 3,
    'callback runs once for every type-directory entry');
  assert.deepStrictEqual([
    view.getUint32(toWasm(observed + 4), true),
    view.getUint32(toWasm(observed + 8), true),
    view.getUint32(toWasm(observed + 12), true),
  ], [0x48504c41, 0x41544542, 7],
  'named UTF-16 entries become ANSI strings while integer IDs stay integers');
  assert.strictEqual(view.getUint32(toWasm(observed + 16), true), 0x100,
    'callback receives the original resource type');
  assert.strictEqual(view.getUint32(toWasm(observed + 20), true), 0,
    'callback receives the original NULL module');
  assert.strictEqual(view.getUint32(toWasm(observed + 24), true), 0xdecafbad,
    'callback receives the caller lParam unchanged');

  console.log('PASS EnumResourceNamesA enumerates ANSI names and integer IDs');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

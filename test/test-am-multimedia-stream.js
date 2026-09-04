#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_create_amstream")
      (param $clsid i32) (param $iid i32) (param $out i32) (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_CoCreateInstance
      (local.get $clsid) (i32.const 0) (i32.const 1) (local.get $iid)
      (local.get $out) (i32.const 0))
    (global.get $eax))

  (func (export "test_release_amstream") (param $this i32) (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_IAMMultiMediaStream_Release
      (local.get $this) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))

  (func (export "test_load_cursor_file") (param $file i32) (result i32)
    (global.set $esp (i32.const 0x30000))
    (call $handle_LoadCursorFromFileA
      (local.get $file) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))

  (func (export "test_last_error") (result i32) (global.get $last_error))
`;

(async () => {
  const { exports: wat, memory } = await bootRenderHarness({
    extraWat, fonts: 'none',
  });
  const exe = fs.readFileSync(path.join(__dirname, 'binaries', 'calc.exe'));
  new Uint8Array(memory.buffer).set(exe, wat.get_staging());
  assert(wat.load_pe(exe.length));

  const clsid = wat.guest_alloc(16) >>> 0;
  const iid = wat.guest_alloc(16) >>> 0;
  const out = wat.guest_alloc(4) >>> 0;
  // CLSID_AMMultiMediaStream and IID_IAMMultiMediaStream. This is the known
  // DirectX Media class identity used by Darkstone's startup path.
  wat.guest_write32(clsid, 0x49c47ce5);
  wat.guest_write32(clsid + 4, 0x11d09ba4);
  wat.guest_write32(clsid + 8, 0xc0001282);
  wat.guest_write32(clsid + 12, 0x452cc34f);
  wat.guest_write32(iid, 0xbebe595c);
  wat.guest_write32(iid + 4, 0x11d09a6f);
  wat.guest_write32(iid + 8, 0xc000de8f);
  wat.guest_write32(iid + 12, 0x9d18d94f);

  assert.strictEqual(wat.test_create_amstream(clsid, iid, out) >>> 0, 0);
  const stream = wat.guest_read32(out) >>> 0;
  assert(stream, 'CLSID_AMMultiMediaStream creates a usable COM object');
  const vtable = wat.guest_read32(stream) >>> 0;
  assert(vtable, 'multimedia stream has a vtable');
  for (let slot = 0; slot < 19; slot++) {
    assert(wat.guest_read32(vtable + slot * 4), `vtable slot ${slot} is populated`);
  }
  assert.strictEqual(wat.test_release_amstream(stream), 0,
    'the caller can release the one owned reference');

  assert.strictEqual(wat.test_load_cursor_file(0), 0);
  assert.strictEqual(wat.test_last_error(), 87);
  assert.strictEqual(wat.test_load_cursor_file(clsid) >>> 0, 0x67f00,
    'a file-backed cursor gets the runtime custom-cursor handle');
  assert.strictEqual(wat.test_last_error(), 0);

  console.log('PASS  Darkstone DirectX Media probe and file cursors are supported');
})().catch(error => {
  console.error(error);
  process.exit(1);
});

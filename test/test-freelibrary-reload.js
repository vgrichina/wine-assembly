#!/usr/bin/env node
'use strict';

// A mapped PE remains resident after FreeLibrary in this emulator, so a later
// LoadLibrary returns the same HMODULE. That successful load must start a new
// lifetime: Quake II unloads/reloads gamex86.dll while restoring a map and
// treats a false result from the following FreeLibrary as a fatal error.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_call_LoadLibraryA") (param $name i32) (result i32)
    (local $sp i32)
    (local.set $sp (global.get $esp))
    (call $handle_LoadLibraryA (local.get $name)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $sp))
    (global.get $eax))

  (func (export "test_call_FreeLibrary") (param $module i32) (result i32)
    (local $sp i32)
    (local.set $sp (global.get $esp))
    (call $handle_FreeLibrary (local.get $module)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $sp))
    (global.get $eax))
`;

async function main() {
  const { exports: e, memory } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const bytes = new Uint8Array(memory.buffer);
  const guestToWasm = guest =>
    (guest - (e.get_image_base() >>> 0) + (e.get_guest_base() >>> 0)) >>> 0;
  const writeAscii = value => {
    const guest = e.guest_alloc(value.length + 1) >>> 0;
    const wasm = guestToWasm(guest);
    for (let i = 0; i < value.length; i++) bytes[wasm + i] = value.charCodeAt(i);
    bytes[wasm + value.length] = 0;
    return guest;
  };

  const ddrawName = writeAscii('ddraw.dll');
  const dsoundName = writeAscii('dsound.dll');
  const ddraw = e.test_call_LoadLibraryA(ddrawName) >>> 0;
  const dsound = e.test_call_LoadLibraryA(dsoundName) >>> 0;
  assert(ddraw && dsound && ddraw !== dsound, 'static modules receive distinct handles');

  assert.strictEqual(e.test_call_FreeLibrary(0), 0,
    'a null module handle is never a successful unload');
  assert.strictEqual(e.test_call_FreeLibrary(ddraw), 1,
    'the first unload of a live handle succeeds');
  e.test_call_LoadLibraryA(dsoundName);
  assert.strictEqual(e.test_call_FreeLibrary(ddraw), 0,
    'loading a different module does not re-arm an already freed handle');

  assert.strictEqual(e.test_call_LoadLibraryA(ddrawName) >>> 0, ddraw,
    'a resident module is loaded again at the same handle');
  assert.strictEqual(e.test_call_FreeLibrary(ddraw), 1,
    'the reloaded handle has a fresh unload lifetime');
  assert.strictEqual(e.test_call_FreeLibrary(ddraw), 0,
    'a consecutive repeated unload still terminates NSIS-style loops');

  console.log('PASS  FreeLibrary accepts a mapped handle after it is loaded again');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

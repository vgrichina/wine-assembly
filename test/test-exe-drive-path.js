#!/usr/bin/env node
'use strict';

// A program launched from mounted D: media must see D: in
// GetModuleFileName/argv. Speed Demons' language chooser derives its sibling
// setup_GB.exe path from that value; reporting the old hard-coded C: drive
// makes its English button launch a file that does not exist.

const assert = require('assert');
const { createHostImports } = require('../lib/host-imports');
const { compileSrcWasm } = require('./compile-src');
const { exeDriveForPath, setExeDrive } = require('../lib/process-boot');

(async () => {
  assert.strictEqual(exeDriveForPath('D:\\setup.exe'), 0x44);
  assert.strictEqual(exeDriveForPath('e:/games/demo.exe'), 0x45);
  assert.strictEqual(exeDriveForPath('/host/demo.exe'), 0x43);

  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const ctx = { getMemory: () => memory.buffer, renderer: null, resourceJson: {} };
  const imports = createHostImports(ctx);
  imports.host.memory = memory;
  imports.host.create_thread = () => 0;
  imports.host.exit_thread = () => 0;
  imports.host.terminate_thread = () => 0;
  imports.host.create_event = () => 0;
  imports.host.set_event = () => 0;
  imports.host.reset_event = () => 0;
  imports.host.wait_single = () => 0;
  imports.host.wait_multiple = () => 0;

  const { instance } = await WebAssembly.instantiate(compileSrcWasm(), imports);
  const e = instance.exports;
  const u8 = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  const wa = gp => gp - e.get_image_base() + e.get_guest_base();
  const staging = e.get_staging();
  u8.set(Buffer.from('setup.exe', 'ascii'), staging);
  e.set_exe_name(staging, 9);
  setExeDrive(e, 'D:\\setup.exe');

  const output = e.guest_alloc(260);
  assert.strictEqual(e.test_call_GetModuleFileNameA(0, output, 260), 12);
  let end = wa(output);
  while (u8[end]) end++;
  assert.strictEqual(Buffer.from(u8.subarray(wa(output), end)).toString('ascii'),
    'D:\\setup.exe');

  const wide = e.test_call_GetCommandLineW();
  let command = '';
  for (let p = wa(wide); dv.getUint16(p, true); p += 2) {
    command += String.fromCharCode(dv.getUint16(p, true));
  }
  assert.strictEqual(command, 'D:\\setup.exe');

  e.set_exe_drive('?'.charCodeAt(0));
  const fallback = e.guest_alloc(260);
  e.test_call_GetModuleFileNameA(0, fallback, 260);
  assert.strictEqual(String.fromCharCode(u8[wa(fallback)]), 'C',
    'invalid host metadata falls back to the normal C: application drive');

  console.log('PASS  mounted executables report their guest drive in module path and argv');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

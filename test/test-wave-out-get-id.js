#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileSrcWasm } = require('./compile-src');

const ROOT = path.join(__dirname, '..');
const extraWat = String.raw`
  (func (export "test_wave_out_get_id")
        (param $open_handle i32) (param $query_handle i32)
        (param $device_id i32) (result i32)
    (local $saved_esp i32)
    (i32.store (i32.const 0xD160) (local.get $open_handle))
    (local.set $saved_esp (global.get $esp))
    (call $handle_waveOutGetID
      (local.get $query_handle) (local.get $device_id)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))
`;

async function main() {
  // Plain append: src fragments are self-balanced now, so there is no trailing
  // `)` to splice before — the old regex matched nothing and dropped the export.
  const wasm = compileSrcWasm((file, source) =>
    file === '13-exports.wat' ? `${source}\n${extraWat}\n` : source);
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const imports = createHostImports({
    getMemory: () => memory.buffer,
    renderer: null,
    resourceJson: {},
  });
  imports.host.memory = memory;
  Object.assign(imports.host, {
    create_thread: () => 0, exit_thread: () => 0, terminate_thread: () => 0,
    create_event: () => 0, set_event: () => 0, reset_event: () => 0,
    wait_single: () => 0, wait_multiple: () => 0,
    com_create_instance: () => 0x80004002,
  });

  const { instance } = await WebAssembly.instantiate(wasm, imports);
  const e = instance.exports;
  const exe = fs.readFileSync(path.join(ROOT, 'test', 'binaries', 'calc.exe'));
  new Uint8Array(memory.buffer).set(exe, e.get_staging());
  assert(e.load_pe(exe.length), 'fixture PE initializes guest memory');

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const deviceId = e.guest_alloc(4) >>> 0;
  const deviceIdWa = (deviceId - imageBase + guestBase) >>> 0;
  const dv = new DataView(memory.buffer);
  const handle = 0x000b0003;

  dv.setUint32(deviceIdWa, 0xdeadbeef, true);
  assert.strictEqual(e.test_wave_out_get_id(handle, handle, deviceId) >>> 0, 0,
    'the current waveOut handle succeeds');
  assert.strictEqual(dv.getUint32(deviceIdWa, true), 0,
    'the single emulated waveOut device has ID zero');

  dv.setUint32(deviceIdWa, 0xdeadbeef, true);
  assert.strictEqual(e.test_wave_out_get_id(handle, handle + 1, deviceId) >>> 0, 5,
    'a stale waveOut handle returns MMSYSERR_INVALHANDLE');
  assert.strictEqual(dv.getUint32(deviceIdWa, true), 0xdeadbeef,
    'an invalid handle does not modify the output');
  assert.strictEqual(e.test_wave_out_get_id(handle, handle, 0) >>> 0, 11,
    'a NULL output returns MMSYSERR_INVALPARAM');

  console.log('PASS waveOutGetID validates the handle and returns the sole device ID');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

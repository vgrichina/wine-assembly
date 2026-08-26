#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');
const apiTable = require('../src/api_table.json');

const ROOT = path.join(__dirname, '..');
const extraWat = String.raw`
  (func (export "test_system_ordinal_api_id")
        (param $dll_name i32) (param $ordinal i32) (result i32)
    (call $system_ordinal_api_id (local.get $dll_name) (local.get $ordinal)))
`;

async function main() {
  const wasm = await compileWat(async file => {
    const source = await fs.promises.readFile(path.join(ROOT, 'src', file), 'utf8');
    return file === '13-exports.wat'
      ? source.replace(/\n\)\s*$/, `\n${extraWat}\n)\n`)
      : source;
  });
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const imports = createHostImports({ getMemory: () => memory.buffer, renderer: null, resourceJson: {} });
  imports.host.memory = memory;
  Object.assign(imports.host, {
    create_thread: () => 0, exit_thread: () => 0,
    create_event: () => 0, set_event: () => 0, reset_event: () => 0,
    wait_single: () => 0, wait_multiple: () => 0,
    com_create_instance: () => 0x80004002,
  });

  const { instance } = await WebAssembly.instantiate(wasm, imports);
  const e = instance.exports;
  const exe = fs.readFileSync(path.join(ROOT, 'test', 'binaries', 'calc.exe'));
  new Uint8Array(memory.buffer).set(exe, e.get_staging());
  assert(e.load_pe(exe.length), 'fixture PE initializes API hashes');

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const dllName = e.guest_alloc(16) >>> 0;
  const dllNameWa = (dllName - imageBase + guestBase) >>> 0;
  new Uint8Array(memory.buffer).set(Buffer.from('DSOUND.dll\0', 'latin1'), dllNameWa);
  const id = name => apiTable.find(entry => entry.name === name).id;

  assert.strictEqual(e.test_system_ordinal_api_id(dllName, 1), id('DirectSoundCreate'));
  assert.strictEqual(e.test_system_ordinal_api_id(dllName, 2), id('DirectSoundEnumerateA'));
  assert.strictEqual(e.test_system_ordinal_api_id(dllName, 3), -1,
    'unsupported DSOUND ordinals remain explicit diagnostics');

  new Uint8Array(memory.buffer).set(Buffer.from('C:\\WINDOWS\\SYSTEM\\COMCTL32.DLL\0', 'latin1'), dllNameWa);
  assert.strictEqual(e.test_system_ordinal_api_id(dllName, 17), id('InitCommonControls'));
  assert.strictEqual(e.test_system_ordinal_api_id(dllName, 18), -1,
    'unsupported COMCTL32 ordinals remain explicit diagnostics');
  console.log('PASS Win98 system DLL ordinal resolution');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

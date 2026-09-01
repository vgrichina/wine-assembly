#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileSrcWasm } = require('./compile-src');
const apiTable = require('../src/api_table.json');

const ROOT = path.join(__dirname, '..');
const extraWat = String.raw`
  (func (export "test_system_ordinal_api_id")
        (param $dll_name i32) (param $ordinal i32) (result i32)
    (call $system_ordinal_api_id (local.get $dll_name) (local.get $ordinal)))
`;

async function main() {
  // Plain append: src fragments are self-balanced, so there is no trailing `)`
  // for the old splice to match — it silently dropped the fragment.
  const wasm = compileSrcWasm((file, source) =>
    file === '13-exports.wat' ? `${source}\n${extraWat}\n` : source);
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const imports = createHostImports({ getMemory: () => memory.buffer, renderer: null, resourceJson: {} });
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

  // DPLAYX sits at 1-based list position 4 and DSOUND at 6. The DSOUND rule
  // used to test for 4 and therefore answered every dplayx ordinal with a
  // DirectSound id: RollerCoaster Tycoon's ordinal 2 came back as
  // DirectSoundEnumerateA, whose handler pushes four callback arguments where
  // DirectPlayEnumerateA's callback pops five, and the guest returned to EIP 0.
  // Ordinals are the retail DX6 dplayx.dll's (tools/pe-exports.js).
  new Uint8Array(memory.buffer).set(Buffer.from('DPLAYX.dll\0', 'latin1'), dllNameWa);
  assert.strictEqual(e.test_system_ordinal_api_id(dllName, 1), id('DirectPlayCreate'));
  assert.strictEqual(e.test_system_ordinal_api_id(dllName, 2), id('DirectPlayEnumerateA'));
  assert.strictEqual(e.test_system_ordinal_api_id(dllName, 4), id('DirectPlayLobbyCreateA'));
  assert.strictEqual(e.test_system_ordinal_api_id(dllName, 9), id('DirectPlayEnumerate'));
  assert.strictEqual(e.test_system_ordinal_api_id(dllName, 3), -1,
    'unsupported DPLAYX ordinals remain explicit diagnostics');

  new Uint8Array(memory.buffer).set(Buffer.from('C:\\WINDOWS\\SYSTEM\\COMCTL32.DLL\0', 'latin1'), dllNameWa);
  assert.strictEqual(e.test_system_ordinal_api_id(dllName, 17), id('InitCommonControls'));
  assert.strictEqual(e.test_system_ordinal_api_id(dllName, 18), -1,
    'unsupported COMCTL32 ordinals remain explicit diagnostics');

  new Uint8Array(memory.buffer).set(Buffer.from('C:\\WINDOWS\\SYSTEM\\WS2_32.DLL\0', 'latin1'), dllNameWa);
  assert.strictEqual(e.test_system_ordinal_api_id(dllName, 115), id('WSAStartup'),
    'WS2_32 exposes the WinSock 1.1 WSAStartup ordinal used by Baldur\'s Gate');
  assert.strictEqual(e.test_system_ordinal_api_id(dllName, 116), id('WSACleanup'));
  assert.strictEqual(e.test_system_ordinal_api_id(dllName, 114), -1,
    'unsupported WS2_32 ordinals remain explicit diagnostics');
  console.log('PASS Win98 system DLL ordinal resolution');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

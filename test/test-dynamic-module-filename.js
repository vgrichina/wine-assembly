#!/usr/bin/env node
'use strict';

// A self-extracted DLL can validate the directory it was loaded from. The
// module handle must therefore name that DLL, not silently fall back to the
// process executable as the old dynamic-loader path did.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileSrcWasm } = require('./compile-src');

const ROOT = path.join(__dirname, '..');

async function main() {
  const wasm = compileSrcWasm();
  const memory = new WebAssembly.Memory({
    initial: 8192,
    maximum: 8192,
    shared: true,
  });
  const imports = createHostImports({
    getMemory: () => memory.buffer,
    renderer: null,
    resourceJson: {},
  });
  imports.host.memory = memory;
  Object.assign(imports.host, {
    create_thread: () => 0,
    exit_thread: () => 0,
    terminate_thread: () => 0,
    create_event: () => 0,
    set_event: () => 0,
    reset_event: () => 0,
    wait_single: () => 0,
    wait_multiple: () => 0,
    com_create_instance: () => 0x80004002,
  });

  const { instance } = await WebAssembly.instantiate(wasm, imports);
  const e = instance.exports;
  const exe = fs.readFileSync(path.join(ROOT, 'test', 'binaries', 'calc.exe'));
  new Uint8Array(memory.buffer).set(exe, e.get_staging());
  assert(e.load_pe(exe.length), 'fixture PE initializes guest address mapping');

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const wa = guest => (guest - imageBase + guestBase) >>> 0;
  const bytes = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  const writeAscii = value => {
    const guest = e.guest_alloc(value.length + 1) >>> 0;
    for (let i = 0; i < value.length; i++) bytes[wa(guest) + i] = value.charCodeAt(i);
    bytes[wa(guest) + value.length] = 0;
    return guest;
  };
  const readAscii = guest => {
    let result = '';
    for (let p = wa(guest); bytes[p]; p++) result += String.fromCharCode(bytes[p]);
    return result;
  };

  const module = 0x0053c000;
  const modulePath = 'C:\\WINDOWS\\~glh0000.tmp';
  dv.setUint32(e.get_dll_table(), module, true);
  e.test_set_dll_count(1);
  e.set_dll_path(0, writeAscii(modulePath));

  const buffer = e.guest_alloc(260) >>> 0;
  const length = e.test_call_GetModuleFileNameA(module, buffer, 260) >>> 0;
  assert.strictEqual(readAscii(buffer), modulePath,
    'loaded module handle reports its recorded load path');
  assert.strictEqual(length, modulePath.length,
    'GetModuleFileNameA returns the loaded module path length');
  console.log('test-dynamic-module-filename: PASS');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

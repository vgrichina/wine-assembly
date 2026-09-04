#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileSrcWasm } = require('./compile-src');

const ROOT = path.join(__dirname, '..');
const extraWat = String.raw`
  (func (export "test_shell_link_create") (result i32)
    (call $shell_link_init_vtables)
    (call $dx_create_com_obj (i32.const 36) (global.get $SHELL_LINK_VTBL)))
`;

async function main() {
  const wasm = compileSrcWasm((filename, source) =>
    filename === '13-exports.wat' ? `${source}\n${extraWat}\n` : source);
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const context = { exports: null, getMemory: () => memory.buffer };
  const imports = createHostImports(context);
  imports.host.memory = memory;
  Object.assign(imports.host, {
    exit: () => {},
    log: () => {},
    log_i32: () => {},
    crash_unimplemented: () => {},
    wait_multiple: () => 0,
    terminate_thread: () => 0,
  });

  const { instance } = await WebAssembly.instantiate(wasm, imports);
  const e = instance.exports;
  context.exports = e;
  const exe = fs.readFileSync(path.join(ROOT, 'test', 'binaries', 'calc.exe'));
  new Uint8Array(memory.buffer).set(exe, e.get_staging());
  assert(e.load_pe(exe.length), 'fixture PE initializes COM thunks');
  e.init_dx_com_thunks();

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const wa = guest => (guest - imageBase + guestBase) >>> 0;
  const dv = new DataView(memory.buffer);
  const read = guest => e.guest_read32(guest) >>> 0;
  const write = (guest, value) => e.guest_write32(guest, value >>> 0);
  const alloc = bytes => e.guest_alloc(bytes) >>> 0;

  function wide(text) {
    const guest = alloc((text.length + 1) * 2);
    for (let i = 0; i < text.length; i++) {
      dv.setUint16(wa(guest) + i * 2, text.charCodeAt(i), true);
    }
    dv.setUint16(wa(guest) + text.length * 2, 0, true);
    return guest;
  }

  function iid(data1, validSuffix = true) {
    const guest = alloc(16);
    write(guest, data1);
    write(guest + 4, 0);
    write(guest + 8, validSuffix ? 0x000000c0 : 0x000000c1);
    write(guest + 12, 0x46000000);
    return guest;
  }

  function runThunk(fn, args, label) {
    e.call_func(fn, args[0] || 0, args[1] || 0, args[2] || 0, args[3] || 0);
    for (let i = 0; i < 300 && e.get_eip(); i++) e.run(5000);
    assert.strictEqual(e.get_eip(), 0, label + ' must terminate');
    return e.get_eax() >>> 0;
  }

  function callMethod(object, slot, ...args) {
    const fn = read(read(object) + slot * 4);
    assert(fn, `COM slot ${slot} has a thunk`);
    return runThunk(fn, [object, ...args], `COM slot ${slot}`);
  }

  const shell = e.test_shell_link_create() >>> 0;
  assert(shell, 'Shell Link object is allocated');
  assert(Array.from({ length: 21 }, (_, slot) => read(read(shell) + slot * 4)).every(Boolean),
    'IShellLinkA exposes all 21 methods');

  assert.strictEqual(callMethod(shell, 20, wide('C:\\Games\\Pocket Tanks\\ptanks.exe')), 0,
    'SetPath succeeds');
  assert.strictEqual(callMethod(shell, 11, wide('-windowed')), 0, 'SetArguments succeeds');
  assert.strictEqual(callMethod(shell, 9, wide('C:\\Games\\Pocket Tanks')), 0,
    'SetWorkingDirectory succeeds');

  const persistOut = alloc(4);
  assert.strictEqual(callMethod(shell, 0, iid(0x0000010b), persistOut), 0,
    'QueryInterface exposes IPersistFile');
  const persist = read(persistOut);
  assert(persist && persist !== shell, 'IPersistFile has its own interface pointer');
  assert(Array.from({ length: 9 }, (_, slot) => read(read(persist) + slot * 4)).every(Boolean),
    'IPersistFile exposes all 9 methods');

  const badOut = alloc(4);
  write(badOut, 0xcccccccc);
  assert.strictEqual(callMethod(shell, 0, iid(0x0000010b, false), badOut), 0x80004002,
    'QueryInterface validates the full IID');
  assert.strictEqual(read(badOut), 0, 'failed QueryInterface clears its output');

  const linkPath = 'C:\\WINDOWS\\Desktop\\Pocket Tanks.lnk';
  assert.strictEqual(callMethod(persist, 6, wide(linkPath), 1), 0,
    'IPersistFile::Save writes the shortcut');
  const saved = context.vfs.files.get(linkPath.toLowerCase());
  assert(saved, 'shortcut exists in the VFS');
  assert.strictEqual(saved.data.length, 76, 'shortcut contains one Shell Link Header');
  const header = new DataView(saved.data.buffer, saved.data.byteOffset, saved.data.byteLength);
  assert.strictEqual(header.getUint32(0, true), 0x4c, 'shortcut header size is canonical');
  assert.strictEqual(header.getUint32(4, true), 0x00021401, 'shortcut carries CLSID_ShellLink');
  assert.strictEqual(header.getUint32(12, true), 0x000000c0);
  assert.strictEqual(header.getUint32(16, true), 0x46000000);
  assert.strictEqual(header.getUint32(60, true), 1, 'shortcut defaults to SW_SHOWNORMAL');

  const clsid = alloc(16);
  assert.strictEqual(callMethod(persist, 3, clsid), 0);
  assert.deepStrictEqual([read(clsid), read(clsid + 4), read(clsid + 8), read(clsid + 12)],
    [0x00021401, 0, 0x000000c0, 0x46000000], 'GetClassID is exact');
  assert.strictEqual(callMethod(persist, 4), 1, 'saved link reports clean state');

  callMethod(persist, 2);
  callMethod(shell, 2);
  console.log('PASS  Shell Link COM persists a valid minimal .lnk through IPersistFile');
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

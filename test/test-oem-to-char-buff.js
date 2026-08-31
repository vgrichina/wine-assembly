#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileSrcWasm } = require('./compile-src');
const apiTable = require('../src/api_table.json');

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
  assert(e.load_pe(exe.length), 'fixture PE should initialize API thunks');

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const wa = guest => (guest - imageBase + guestBase) >>> 0;
  const bytes = new Uint8Array(memory.buffer);
  const source = e.guest_alloc(16) >>> 0;
  const destination = e.guest_alloc(16) >>> 0;
  const thunkWa = 0x07112000;
  const thunkGuest = (thunkWa - guestBase + imageBase) >>> 0;
  const dv = new DataView(memory.buffer);
  const savedName = dv.getUint32(thunkWa, true);
  const savedId = dv.getUint32(thunkWa + 4, true);

  function callApi(name, ...args) {
    const api = apiTable.find(entry => entry.name === name);
    assert(api, `${name} must exist in api_table.json`);
    assert.strictEqual(api.nargs, args.length, `${name} argument count`);
    dv.setUint32(thunkWa + 4, api.id >>> 0, true);
    e.call_func(thunkGuest, ...args, 0);
    for (let i = 0; i < 500 && e.get_eip(); i++) e.run(5000);
    assert.strictEqual(e.get_eip(), 0, `${name} call must terminate`);
    assert.strictEqual(e.get_eax() >>> 0, 1, `${name} returns TRUE`);
  }

  // The counted form converts every byte, including bytes after an embedded
  // NUL. CP437 80/81/82/9c are C cedilla/u-umlaut/e-acute/pound in CP1252.
  bytes.set([0x41, 0x00, 0x80, 0x81, 0x82, 0x9c], wa(source));
  bytes.fill(0xcc, wa(destination), wa(destination) + 16);
  callApi('OemToCharBuffA', source, destination, 6);
  assert.deepStrictEqual([...bytes.slice(wa(destination), wa(destination) + 8)],
    [0x41, 0x00, 0xc7, 0xfc, 0xe9, 0xa3, 0xcc, 0xcc],
    'OemToCharBuffA converts the exact byte count across embedded NUL');

  bytes.set([0x80, 0x81, 0x82, 0x9c, 0x00, 0x42], wa(source));
  bytes.fill(0xcc, wa(destination), wa(destination) + 16);
  callApi('OemToCharA', source, destination);
  assert.deepStrictEqual([...bytes.slice(wa(destination), wa(destination) + 7)],
    [0xc7, 0xfc, 0xe9, 0xa3, 0x00, 0xcc, 0xcc],
    'OemToCharA converts through the terminator and stops');

  bytes.set([0xc7, 0xfc, 0xe9, 0xa3, 0x00, 0x42], wa(source));
  bytes.fill(0xcc, wa(destination), wa(destination) + 16);
  callApi('CharToOemA', source, destination);
  assert.deepStrictEqual([...bytes.slice(wa(destination), wa(destination) + 7)],
    [0x80, 0x81, 0x82, 0x9c, 0x00, 0xcc, 0xcc],
    'CharToOemA performs the inverse CP1252-to-CP437 conversion');

  // Windows permits the ANSI string form to convert in place.
  bytes.set([0xc7, 0xfc, 0xe9, 0x00], wa(source));
  callApi('CharToOemA', source, source);
  assert.deepStrictEqual([...bytes.slice(wa(source), wa(source) + 4)],
    [0x80, 0x81, 0x82, 0x00], 'CharToOemA supports in-place conversion');

  // Euro is absent from CP437 and therefore becomes the default '?'.
  bytes.set([0x80, 0x00, 0xfc], wa(source));
  bytes.fill(0xcc, wa(destination), wa(destination) + 16);
  callApi('CharToOemBuffA', source, destination, 3);
  assert.deepStrictEqual([...bytes.slice(wa(destination), wa(destination) + 5)],
    [0x3f, 0x00, 0x81, 0xcc, 0xcc],
    'CharToOemBuffA converts exactly cch bytes and substitutes unrepresentable input');

  dv.setUint32(thunkWa, savedName, true);
  dv.setUint32(thunkWa + 4, savedId, true);
  console.log('test-oem-to-char-buff: PASS');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

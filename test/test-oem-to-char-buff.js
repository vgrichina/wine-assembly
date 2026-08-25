#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');
const apiTable = require('../src/api_table.json');

const ROOT = path.join(__dirname, '..');

async function main() {
  const wasm = await compileWat(file =>
    fs.promises.readFile(path.join(ROOT, 'src', file), 'utf8'));
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
  const source = e.guest_alloc(8) >>> 0;
  const destination = e.guest_alloc(8) >>> 0;
  bytes.set([0x41, 0x00, 0x80, 0x42], wa(source));
  bytes.fill(0xcc, wa(destination), wa(destination) + 8);

  const api = apiTable.find(entry => entry.name === 'OemToCharBuffA');
  assert(api, 'OemToCharBuffA must exist in api_table.json');
  const thunkWa = 0x07112000;
  const thunkGuest = (thunkWa - guestBase + imageBase) >>> 0;
  const dv = new DataView(memory.buffer);
  const savedName = dv.getUint32(thunkWa, true);
  const savedId = dv.getUint32(thunkWa + 4, true);
  dv.setUint32(thunkWa + 4, api.id >>> 0, true);
  e.call_func(thunkGuest, source, destination, 4, 0);
  for (let i = 0; i < 500 && e.get_eip(); i++) e.run(5000);
  dv.setUint32(thunkWa, savedName, true);
  dv.setUint32(thunkWa + 4, savedId, true);

  assert.strictEqual(e.get_eip(), 0, 'OemToCharBuffA call must terminate');
  assert.strictEqual(e.get_eax() >>> 0, 1, 'OemToCharBuffA returns TRUE');
  assert.deepStrictEqual([...bytes.slice(wa(destination), wa(destination) + 6)],
    [0x41, 0x00, 0x80, 0x42, 0xcc, 0xcc],
    'the exact requested byte count is copied, including bytes after NUL');
  console.log('test-oem-to-char-buff: PASS');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

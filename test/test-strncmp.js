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
  (func (export "test_make_api_thunk") (param $api_id i32) (result i32)
    (local $addr i32)
    (local.set $addr (i32.add (global.get $THUNK_BASE)
      (i32.mul (global.get $num_thunks) (i32.const 8))))
    (i32.store (local.get $addr) (i32.const 0))
    (i32.store offset=4 (local.get $addr) (local.get $api_id))
    (global.set $num_thunks (i32.add (global.get $num_thunks) (i32.const 1)))
    (call $update_thunk_end)
    (i32.add (i32.sub (local.get $addr) (global.get $GUEST_BASE))
             (global.get $image_base)))
`;

const u32 = value => [value, value >>> 8, value >>> 16, value >>> 24]
  .map(v => v & 0xff);

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
  assert(e.load_pe(exe.length), 'fixture PE initializes API dispatch');

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const wa = guest => (guest - imageBase + guestBase) >>> 0;
  const bytes = new Uint8Array(memory.buffer);
  const alloc = size => e.guest_alloc(size) >>> 0;
  const writeBytes = values => {
    const guest = alloc(values.length);
    bytes.set(values, wa(guest));
    return guest;
  };

  const api = apiTable.find(entry => entry.name === 'strncmp');
  assert(api, 'strncmp is registered');
  assert.strictEqual(api.convention, 'cdecl');
  assert.strictEqual(api.nargs, 3);
  const thunk = e.test_make_api_thunk(api.id) >>> 0;
  const strnicmpApi = apiTable.find(entry => entry.name === '_strnicmp');
  assert(strnicmpApi, '_strnicmp is registered');
  assert.strictEqual(strnicmpApi.convention, 'cdecl');
  assert.strictEqual(strnicmpApi.nargs, 3);
  const strnicmpThunk = e.test_make_api_thunk(strnicmpApi.id) >>> 0;

  const call = (targetThunk, left, right, count) => {
    const args = [left, right, count];
    const code = [];
    for (const arg of [...args].reverse()) code.push(0x68, ...u32(arg));
    code.push(0xb8, ...u32(targetThunk), 0xff, 0xd0, 0x83, 0xc4, 0x0c,
      0xc2, 0x0c, 0x00);
    const wrapper = alloc(code.length);
    bytes.set(code, wa(wrapper));
    e.call_func(wrapper, 0, 0, 0, 0);
    for (let i = 0; i < 1000 && e.get_eip(); i++) e.run(5000);
    assert.strictEqual(e.get_eip(), 0, 'strncmp wrapper terminates');
    return e.get_eax() | 0;
  };

  const abcX = writeBytes(Buffer.from('abcX\0', 'latin1'));
  const abcY = writeBytes(Buffer.from('abcY\0', 'latin1'));
  assert.strictEqual(call(thunk, abcX, abcY, 3), 0,
    'bytes after count do not participate');
  assert(call(thunk, abcX, abcY, 4) < 0, 'first differing unsigned byte determines order');
  assert(call(thunk, abcY, abcX, 4) > 0, 'comparison order is reversible');

  const nulA = writeBytes(Uint8Array.from([0x61, 0x00, 0xff]));
  const nulB = writeBytes(Uint8Array.from([0x61, 0x00, 0x01]));
  assert.strictEqual(call(thunk, nulA, nulB, 3), 0, 'a shared NUL ends the comparison');

  const high = writeBytes(Uint8Array.from([0x80, 0x00]));
  const low = writeBytes(Uint8Array.from([0x7f, 0x00]));
  assert(call(thunk, high, low, 1) > 0, 'characters compare as unsigned bytes');
  assert.strictEqual(call(thunk, 0, 0, 0), 0, 'count zero does not dereference either pointer');

  const mixed = writeBytes(Buffer.from('TeStX\0', 'latin1'));
  const lower = writeBytes(Buffer.from('testY\0', 'latin1'));
  assert.strictEqual(call(strnicmpThunk, mixed, lower, 4), 0,
    '_strnicmp folds ASCII case within count');
  assert(call(strnicmpThunk, mixed, lower, 5) < 0,
    '_strnicmp reports the first folded difference');
  assert.strictEqual(call(strnicmpThunk, 0, 0, 0), 0,
    '_strnicmp count zero does not dereference either pointer');

  console.log('PASS strncmp/_strnicmp bounded cdecl comparisons');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

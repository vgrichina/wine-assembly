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

const u32 = value => [value, value >>> 8, value >>> 16, value >>> 24].map(v => v & 0xff);

async function main() {
  // Plain append: src fragments are self-balanced now, so there is no trailing
  // `)` to splice before — the old regex matched nothing and dropped extraWat.
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
  assert(e.load_pe(exe.length), 'fixture PE initializes API dispatch');

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const wa = guest => (guest - imageBase + guestBase) >>> 0;
  const bytes = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  const alloc = size => e.guest_alloc(size) >>> 0;
  const writeAscii = value => {
    const guest = alloc(value.length + 1);
    bytes.set(Buffer.from(value + '\0', 'latin1'), wa(guest));
    return guest;
  };

  const api = apiTable.find(entry => entry.name === '_vsnprintf');
  assert(api, '_vsnprintf is registered');
  assert.strictEqual(api.convention, 'cdecl');
  const thunk = e.test_make_api_thunk(api.id) >>> 0;
  const format = writeAscii('value=%d');
  const argptr = alloc(4);
  dv.setUint32(wa(argptr), 42, true);

  const call = (buffer, count) => {
    const args = [buffer, count, format, argptr];
    const code = [];
    for (const arg of [...args].reverse()) code.push(0x68, ...u32(arg));
    code.push(0xb8, ...u32(thunk), 0xff, 0xd0, 0x83, 0xc4, 0x10, 0xc2, 0x10, 0x00);
    const wrapper = alloc(code.length);
    bytes.set(code, wa(wrapper));
    e.call_func(wrapper, 0, 0, 0, 0);
    for (let i = 0; i < 1000 && e.get_eip(); i++) e.run(5000);
    assert.strictEqual(e.get_eip(), 0, '_vsnprintf wrapper terminates');
    return e.get_eax() | 0;
  };

  const full = alloc(16);
  bytes.fill(0xcc, wa(full), wa(full) + 16);
  assert.strictEqual(call(full, 16), 8, 'complete output returns its character count');
  assert.strictEqual(Buffer.from(bytes.slice(wa(full), wa(full) + 9)).toString('latin1'), 'value=42\0');

  const short = alloc(8);
  bytes.fill(0xcc, wa(short), wa(short) + 8);
  assert.strictEqual(call(short, 5), -1, 'truncated Win9x CRT output returns -1');
  assert.strictEqual(Buffer.from(bytes.slice(wa(short), wa(short) + 5)).toString('latin1'), 'value');
  assert.strictEqual(bytes[wa(short) + 5], 0xcc, 'truncation does not append a NUL beyond count');

  console.log('PASS _vsnprintf bounded cdecl formatting');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

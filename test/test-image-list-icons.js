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
  (func (export "test_free_list_head") (result i32)
    (global.get $free_list))
`;

const u32 = value => [value, value >>> 8, value >>> 16, value >>> 24].map(v => v & 0xff);

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
  assert(e.load_pe(exe.length), 'fixture PE initializes API dispatch');

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const wa = guest => (guest - imageBase + guestBase) >>> 0;
  const bytes = new Uint8Array(memory.buffer);
  const alloc = size => e.guest_alloc(size) >>> 0;
  const makeCaller = name => {
    const api = apiTable.find(entry => entry.name === name);
    assert(api, `${name} is registered`);
    const thunk = e.test_make_api_thunk(api.id) >>> 0;
    return args => {
      assert.strictEqual(args.length, api.nargs, `${name} argument count`);
      const code = [];
      for (const arg of [...args].reverse()) code.push(0x68, ...u32(arg >>> 0));
      code.push(0xb8, ...u32(thunk), 0xff, 0xd0, 0xc2, 0x10, 0x00);
      const wrapper = alloc(code.length);
      bytes.set(code, wa(wrapper));
      e.call_func(wrapper, 0, 0, 0, 0);
      for (let i = 0; i < 1000 && e.get_eip(); i++) e.run(5000);
      assert.strictEqual(e.get_eip(), 0, `${name} wrapper terminates`);
      return e.get_eax() >>> 0;
    };
  };

  const create = makeCaller('ImageList_Create');
  const destroy = makeCaller('ImageList_Destroy');
  const replace = makeCaller('ImageList_ReplaceIcon');
  const get = makeCaller('ImageList_GetIcon');
  const imageList = create([16, 16, 1, 0, 4]);
  assert(imageList, 'ImageList_Create returns a handle');

  assert.strictEqual(replace([imageList, 0xffffffff, 0x650001]), 0,
    'i=-1 appends the first icon');
  assert.strictEqual(replace([imageList, 0xffffffff, 0x650002]), 1,
    'i=-1 appends subsequent icons');
  assert.strictEqual(get([imageList, 0, 0]), 0x650001,
    'ImageList_GetIcon returns the retained first icon');
  assert.strictEqual(get([imageList, 1, 0]), 0x650002,
    'ImageList_GetIcon returns the retained second icon');
  assert.strictEqual(replace([imageList, 0, 0x650003]), 0,
    'an in-range index replaces its icon');
  assert.strictEqual(get([imageList, 0, 0]), 0x650003,
    'replacement updates the requested slot');
  assert.strictEqual(replace([imageList, 9, 0x650004]), 0xffffffff,
    'an out-of-range replacement fails');
  assert.strictEqual(get([imageList, 9, 0]), 0,
    'an out-of-range lookup fails');

  const iconArray = e.guest_read32(imageList + 24) >>> 0;
  assert(iconArray, 'icon append should allocate an icon-handle array');
  assert.strictEqual(destroy([0]), 0, 'destroying a null image list fails');
  assert.strictEqual(destroy([imageList]), 1, 'destroying a live image list succeeds');
  assert.strictEqual(e.test_free_list_head() >>> 0, imageList - 4,
    'destroy should return the image-list block to the heap');
  assert.strictEqual(e.guest_read32(imageList) >>> 0, iconArray - 4,
    'destroy should return the icon-handle array behind the image-list block');
  assert.strictEqual(destroy([imageList]), 0, 'destroying the same image list twice fails');

  console.log('PASS image-list icon append, lookup, replacement, and destruction semantics');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

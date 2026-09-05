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
  const dv = new DataView(memory.buffer);
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
  const addMasked = makeCaller('ImageList_AddMasked');
  const replace = makeCaller('ImageList_ReplaceIcon');
  const get = makeCaller('ImageList_GetIcon');
  const getIconInfo = makeCaller('GetIconInfo');
  const destroyIcon = makeCaller('DestroyIcon');
  const drawIcon = makeCaller('DrawIcon');
  const imageList = create([16, 16, 1, 0, 4]);
  assert(imageList, 'ImageList_Create returns a handle');

  assert.strictEqual(replace([imageList, 0xffffffff, 0x123451]), 0,
    'i=-1 appends the first icon');
  assert.strictEqual(replace([imageList, 0xffffffff, 0x123452]), 1,
    'i=-1 appends subsequent icons');
  const firstCopy = get([imageList, 0, 0]);
  const secondCopy = get([imageList, 1, 0]);
  assert(firstCopy && firstCopy !== 0x123451,
    'ImageList_GetIcon creates an owned copy of the retained first icon');
  assert(secondCopy && secondCopy !== 0x123452 && secondCopy !== firstCopy,
    'each retained entry gets independent icon identity');
  assert.strictEqual(destroyIcon([firstCopy]), 1, 'caller can destroy the first returned icon');
  assert.strictEqual(destroyIcon([firstCopy]), 0, 'returned icon lifetime ends exactly once');
  assert.strictEqual(destroyIcon([secondCopy]), 1, 'caller can destroy the second returned icon');
  assert.strictEqual(replace([imageList, 0, 0x123453]), 0,
    'an in-range index replaces its icon');
  const replacementCopy = get([imageList, 0, 0]);
  assert(replacementCopy && replacementCopy !== 0x123453,
    'replacement updates the requested slot but still returns an owned copy');
  assert.strictEqual(destroyIcon([replacementCopy]), 1);
  assert.strictEqual(replace([imageList, 9, 0x123454]), 0xffffffff,
    'an out-of-range replacement fails');
  assert.strictEqual(get([imageList, 9, 0]), 0,
    'an out-of-range lookup fails');

  const iconArray = e.guest_read32(imageList + 24) >>> 0;
  assert(iconArray, 'icon append should allocate an icon-handle array');
  const ownedReplacement = e.guest_read32(iconArray) >>> 0;
  const ownedSecond = e.guest_read32(iconArray + 4) >>> 0;
  assert(ownedReplacement && ownedReplacement !== 0x123453,
    'image list copies the replacement instead of saving the caller HICON');
  assert(ownedSecond && ownedSecond !== 0x123452,
    'image list owns an independent copy of every appended icon');
  assert.strictEqual(destroy([0]), 0, 'destroying a null image list fails');
  assert.strictEqual(destroy([imageList]), 1, 'destroying a live image list succeeds');
  assert.strictEqual(e.test_free_list_head() >>> 0, imageList - 4,
    'destroy should return the image-list block to the heap');
  assert.strictEqual(e.guest_read32(imageList) >>> 0, iconArray - 4,
    'destroy should return the icon-handle array behind the image-list block');
  assert.strictEqual(destroyIcon([ownedReplacement]), 0,
    'destroying the image list releases its private replacement copy');
  assert.strictEqual(destroyIcon([ownedSecond]), 0,
    'destroying the image list releases its private appended copy');
  assert.strictEqual(destroy([imageList]), 0, 'destroying the same image list twice fails');

  // Bitmap-backed lists have no retained HICON to borrow. GetIcon must crop
  // the requested cell and materialize the image-list colour key as an AND
  // mask, then keep both planes alive independently of the source list.
  const bitmapList = create([4, 4, 1, 0, 4]);
  const strip = e.test_call_CreateBitmap(8, 4, 1, 32, 0) >>> 0;
  const stripBits = e.test_gdi_bitmap_storage(strip) >>> 0;
  assert(bitmapList && strip && stripBits, 'bitmap-backed image-list fixture exists');
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 8; x++) {
      const within = x & 3;
      const border = within === 0 || within === 3 || y === 0 || y === 3;
      const color = border ? 0x00ff00ff : (x < 4 ? 0x000000ff : 0x0000ff00);
      dv.setUint32(stripBits + (y * 8 + x) * 4, color, true);
    }
  }
  assert.strictEqual(addMasked([bitmapList, strip, 0x00ff00ff]), 0,
    'ImageList_AddMasked adds both four-pixel cells');
  assert.strictEqual(e.guest_read32(bitmapList + 12) >>> 0, 2,
    'bitmap strip exposes two image-list entries');
  const bitmapIcon = get([bitmapList, 1, 0]);
  assert(bitmapIcon, 'ImageList_GetIcon materializes a bitmap-strip entry');
  const info = alloc(20);
  assert.strictEqual(getIconInfo([bitmapIcon, info]), 1,
    'materialized image-list icon has real ICONINFO');
  assert.strictEqual(e.guest_read32(info) >>> 0, 1, 'materialized entry is an icon, not a cursor');
  const mask = e.guest_read32(info + 12) >>> 0;
  const color = e.guest_read32(info + 16) >>> 0;
  assert(mask && color, 'GetIconInfo returns independent mask and colour planes');
  assert.strictEqual(e.test_gdi_object_width(mask) >>> 0, 4);
  assert.strictEqual(e.test_gdi_object_height(mask) >>> 0, 4);
  assert.strictEqual(e.test_gdi_object_width(color) >>> 0, 4);
  assert.strictEqual(e.test_gdi_object_height(color) >>> 0, 4);
  e.test_call_DeleteObject(mask);
  e.test_call_DeleteObject(color);

  assert.strictEqual(destroy([bitmapList]), 1, 'source bitmap list can be destroyed first');
  e.test_call_DeleteObject(strip);
  const target = e.test_call_CreateBitmap(8, 8, 1, 32, 0) >>> 0;
  const targetBits = e.test_gdi_bitmap_storage(target) >>> 0;
  const background = 0x00123456;
  for (let i = 0; i < 64; i++) dv.setUint32(targetBits + i * 4, background, true);
  const targetDc = e.test_call_CreateCompatibleDC(0) >>> 0;
  e.test_call_SelectObject(targetDc, target);
  assert.strictEqual(drawIcon([targetDc, 2, 2, bitmapIcon]), 1,
    'DrawIcon accepts the materialized image-list HICON');
  assert.strictEqual(dv.getUint32(targetBits + (2 * 8 + 2) * 4, true), background,
    'the image-list mask leaves the transparent border untouched');
  assert.strictEqual(dv.getUint32(targetBits + (3 * 8 + 3) * 4, true), 0x0000ff00,
    'the requested second cell paints its green image pixels');
  assert.strictEqual(dv.getUint32(targetBits + (7 * 8 + 7) * 4, true), background,
    'natural 4px icon size does not overpaint the destination');
  assert.strictEqual(destroyIcon([bitmapIcon]), 1,
    'materialized mask and colour planes have caller-owned lifetime');
  assert.strictEqual(destroyIcon([bitmapIcon]), 0);
  e.test_call_DeleteDC(targetDc);
  e.test_call_DeleteObject(target);

  console.log('PASS image-list owned icon extraction, mask pixels, replacement, and destruction semantics');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

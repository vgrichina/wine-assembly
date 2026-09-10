#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { compileSrcWasm } = require('./compile-src');
const { createHostImports } = require('../lib/host-imports');

const extraWat = String.raw`
  (func (export "test_virtual_reset")
    (call $zero_memory (global.get $VIRTUAL_MAP_STATE)
      (i32.add (global.get $VIRTUAL_MAP_STATE_SIZE)
        (global.get $VIRTUAL_MAP_TABLE_SIZE)))
    (call $zero_memory (global.get $GUEST_PAGE_TABLE)
      (global.get $GUEST_PAGE_TABLE_SIZE))
    (i32.store (i32.add (global.get $VIRTUAL_MAP_STATE) (i32.const 4))
      (global.get $VIRTUAL_BACKING_BASE))
    (global.set $virtual_alloc_top (global.get $VIRTUAL_ALLOC_TOP_INIT)))
  (func (export "test_virtual_alloc")
      (param $size i32) (param $protect i32) (result i32)
    (global.set $esp (i32.const 0x00500000))
    (call $handle_VirtualAlloc
      (i32.const 0) (local.get $size) (i32.const 0x3000)
      (local.get $protect) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_virtual_protect")
      (param $address i32) (param $size i32) (param $protect i32)
      (param $old_out i32) (result i32)
    (global.set $esp (i32.const 0x00500000))
    (call $handle_VirtualProtect
      (local.get $address) (local.get $size) (local.get $protect)
      (local.get $old_out) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_page_protect") (param $address i32) (result i32)
    (i32.and
      (i32.atomic.load
        (i32.add (global.get $GUEST_PAGE_TABLE)
          (i32.and (i32.shr_u (local.get $address) (i32.const 10))
            (i32.const 0x003FFFFC))))
      (global.get $GUEST_PTE_PROTECT_MASK)))
  (func (export "test_last_error") (result i32)
    (global.get $last_error))
`;

async function main() {
  const wasm = compileSrcWasm((filename, source) =>
    filename === '13-exports.wat' ? `${source}\n${extraWat}\n` : source);
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const context = {
    exports: null,
    getMemory: () => memory.buffer,
    renderer: null,
    resourceJson: { menus: {}, dialogs: {}, strings: {}, bitmaps: {} },
    onExit: () => {},
  };
  const imports = createHostImports(context);
  imports.host.memory = memory;
  imports.host.create_thread = () => 0;
  imports.host.exit_thread = () => 0;
  imports.host.terminate_thread = () => 0;
  imports.host.create_event = () => 0;
  imports.host.set_event = () => 0;
  imports.host.reset_event = () => 0;
  imports.host.wait_single = () => 0;
  imports.host.wait_multiple = () => 0;
  imports.host.com_create_instance = () => 0x80004002;
  const { instance } = await WebAssembly.instantiate(wasm, imports);
  const e = instance.exports;
  context.exports = e;

  const oldOut = 0x00402000;
  const read32 = address => (e.guest_read8(address) |
    (e.guest_read8(address + 1) << 8) |
    (e.guest_read8(address + 2) << 16) |
    (e.guest_read8(address + 3) << 24)) >>> 0;

  e.test_virtual_reset();
  assert.strictEqual(e.test_virtual_alloc(0x1000, 0x08), 0,
    'VirtualAlloc must reject PAGE_WRITECOPY for private pages');
  assert.strictEqual(e.test_last_error(), 87,
    'invalid private protection must set ERROR_INVALID_PARAMETER');

  const base = e.test_virtual_alloc(0x3000, 0x02) >>> 0;
  assert.notStrictEqual(base, 0, 'PAGE_READONLY sparse allocation must succeed');
  for (const offset of [0, 0x1000, 0x2000]) {
    assert.strictEqual(e.test_page_protect(base + offset), 0x02,
      'VirtualAlloc must publish the requested protection on every committed page');
  }

  e.guest_write32(oldOut, 0xcccccccc);
  assert.strictEqual(e.test_virtual_protect(base + 0xfff, 2, 0x04, oldOut), 1,
    'a two-byte range crossing a page boundary must protect both pages');
  assert.strictEqual(read32(oldOut), 0x02,
    'VirtualProtect must return the first page previous protection');
  assert.strictEqual(e.test_page_protect(base), 0x04);
  assert.strictEqual(e.test_page_protect(base + 0x1000), 0x04);
  assert.strictEqual(e.test_page_protect(base + 0x2000), 0x02,
    'page rounding must not change the following untouched page');

  assert.strictEqual(e.test_virtual_protect(base + 0x1000, 1, 0x104, oldOut), 1,
    'PAGE_GUARD may modify a readable/writable committed page');
  assert.strictEqual(read32(oldOut), 0x04);
  assert.strictEqual(e.test_page_protect(base + 0x1000), 0x104,
    'guard modifier must be retained verbatim in the PTE');

  e.guest_write32(oldOut, 0xcccccccc);
  assert.strictEqual(e.test_virtual_protect(base, 1, 0x101, oldOut), 0,
    'PAGE_GUARD cannot be combined with PAGE_NOACCESS');
  assert.strictEqual(read32(oldOut), 0xcccccccc,
    'failed validation must leave lpflOldProtect untouched');
  assert.strictEqual(e.test_page_protect(base), 0x04,
    'failed validation must not modify any page');

  e.guest_write32(oldOut, 0xcccccccc);
  assert.strictEqual(e.test_virtual_protect(base + 0x2fff, 2, 0x01, oldOut), 0,
    'a range crossing into an uncommitted page must fail atomically');
  assert.strictEqual(e.test_last_error(), 487,
    'an uncommitted page in the range must set ERROR_INVALID_ADDRESS');
  assert.strictEqual(read32(oldOut), 0xcccccccc,
    'failed committed-range validation must leave old protection untouched');
  assert.strictEqual(e.test_page_protect(base + 0x2000), 0x02,
    'all-or-nothing failure must preserve earlier committed pages');

  assert.strictEqual(e.test_virtual_protect(base + 0x2000, 1, 0x01, oldOut), 1,
    'PAGE_NOACCESS itself is a valid committed-page protection');
  assert.strictEqual(read32(oldOut), 0x02);
  assert.strictEqual(e.test_page_protect(base + 0x2000), 0x01);

  // This commit models metadata only. Win98 had no DEP, and access enforcement
  // is deliberately a separate opt-in path so promotion cannot change games.
  e.guest_write8(base + 0x2000, 0x5a);
  assert.strictEqual(e.guest_read8(base + 0x2000), 0x5a,
    'permission metadata must not silently enable enforcement');

  console.log('PASS VirtualAlloc/VirtualProtect retain page-rounded sparse PAGE_* metadata');
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

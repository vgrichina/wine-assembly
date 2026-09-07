#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');
const RegionMap = require('../lib/region-map.generated.js');

function makeReturningPe() {
  const bytes = Buffer.alloc(0x400);
  const pe = 0x80;
  const opt = pe + 24;
  const section = opt + 0xe0;

  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(pe, 0x3c);
  bytes.writeUInt32LE(0x00004550, pe);
  bytes.writeUInt16LE(0x014c, pe + 4);
  bytes.writeUInt16LE(1, pe + 6);
  bytes.writeUInt16LE(0xe0, pe + 20);
  bytes.writeUInt16LE(0x010f, pe + 22);

  bytes.writeUInt16LE(0x010b, opt);
  bytes.writeUInt32LE(0x200, opt + 4);
  bytes.writeUInt32LE(0x1000, opt + 16);
  bytes.writeUInt32LE(0x1000, opt + 20);
  bytes.writeUInt32LE(0x400000, opt + 28);
  bytes.writeUInt32LE(0x1000, opt + 32);
  bytes.writeUInt32LE(0x200, opt + 36);
  bytes.writeUInt32LE(0x2000, opt + 56);
  bytes.writeUInt32LE(0x200, opt + 60);

  bytes.write('.text\0\0\0', section, 'ascii');
  bytes.writeUInt32LE(1, section + 8);
  bytes.writeUInt32LE(0x1000, section + 12);
  bytes.writeUInt32LE(0x200, section + 16);
  bytes.writeUInt32LE(0x200, section + 20);
  bytes.writeUInt32LE(0x60000020, section + 36);
  bytes[0x200] = 0xc3;
  return bytes;
}

(async () => {
  const harness = await bootRenderHarness();
  const wat = harness.exports;
  const memory = harness.memory;
  const pe = makeReturningPe();
  new Uint8Array(memory.buffer).set(pe, wat.get_staging());

  assert.strictEqual(wat.load_pe(pe.length) >>> 0, 0x401000);
  const imageBase = wat.get_image_base() >>> 0;
  const g2w = address => RegionMap.g2w(address >>> 0, imageBase);
  const view = new DataView(memory.buffer);
  const initialEsp = wat.get_esp() >>> 0;
  const stackBase = (initialEsp + 4) >>> 0;
  const fsBase = wat.get_fs_base() >>> 0;

  assert.strictEqual(view.getUint32(g2w(initialEsp), true), 0,
    'the process entry point must return to the clean EIP-zero sentinel');
  assert.strictEqual(view.getUint32(g2w(fsBase + 4), true), stackBase,
    'TIB StackBase must describe the top of the reserved stack region');
  assert.strictEqual(view.getUint32(g2w(fsBase + 8), true),
    (stackBase - 0x100000) >>> 0,
    'TIB StackLimit must remain one megabyte below StackBase');

  wat.run(1000);
  assert.strictEqual(wat.get_eip() >>> 0, 0,
    'a native PE entry point that returns must terminate cleanly');
  assert.strictEqual(wat.get_esp() >>> 0, stackBase,
    'RET must consume exactly the seeded return address');

  console.log('PASS  returning PE entry point exits through the initial stack sentinel');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

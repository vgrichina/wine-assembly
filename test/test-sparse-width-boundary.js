#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { compileWat } = require('../lib/compile-wat');
const { createHostImports } = require('../lib/host-imports');

const extraWat = String.raw`
  (func (export "test_sparse_map") (param $guest i32) (param $size i32) (result i32)
    (call $virtual_map_commit (local.get $guest) (local.get $size)))
  (func (export "test_g2w") (param $guest i32) (result i32)
    (call $g2w (local.get $guest)))
  (func (export "test_gl16") (param $guest i32) (result i32)
    (call $gl16 (local.get $guest)))
  (func (export "test_gl32") (param $guest i32) (result i32)
    (call $gl32 (local.get $guest)))
  (func (export "test_gs16") (param $guest i32) (param $value i32)
    (call $gs16 (local.get $guest) (local.get $value)))
  (func (export "test_gs32") (param $guest i32) (param $value i32)
    (call $gs32 (local.get $guest) (local.get $value)))
`;

async function main() {
  const root = path.join(__dirname, '..');
  const srcDir = path.join(root, 'src');
  const bytes = await compileWat(async filename => {
    const source = await fs.promises.readFile(path.join(srcDir, filename), 'utf8');
    if (filename !== '13-exports.wat') return source;
    return source.replace(/\n\)\s*$/, `\n${extraWat}\n)\n`);
  });
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const context = { exports: null, getMemory: () => memory.buffer };
  const imports = createHostImports(context);
  imports.host.memory = memory;
  imports.host.exit = () => {};
  imports.host.log = () => {};
  imports.host.log_i32 = () => {};
  imports.host.crash_unimplemented = () => {};
  imports.host.wait_multiple = () => 0;
  imports.host.shell_execute = () => 33;
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  const e = instance.exports;
  context.exports = e;

  const exe = fs.readFileSync(path.join(__dirname, 'binaries', 'notepad.exe'));
  new Uint8Array(memory.buffer).set(exe, e.get_staging());
  e.load_pe(exe.length);

  // Interleave an unrelated allocation so adjacent guest pages have backing
  // addresses far apart, as happens in the StarCraft installer worker.
  const page1 = 0x30000000;
  const page2 = page1 + 0x1000;
  assert.strictEqual(e.test_sparse_map(page1, 0x1000) >>> 0, page1);
  assert.strictEqual(e.test_sparse_map(0x28000000, 0x3000) >>> 0, 0x28000000);
  assert.strictEqual(e.test_sparse_map(page2, 0x1000) >>> 0, page2);
  assert.notStrictEqual(
    (e.test_g2w(page1 + 0xfff) + 1) >>> 0,
    e.test_g2w(page2) >>> 0,
    'fixture must use non-contiguous WASM backing');

  const read8 = address => e.guest_read8(address) & 0xff;
  const write8 = (address, value) => e.guest_write8(address, value);
  const seed = [0x10, 0x21, 0x32, 0x43, 0x54, 0x65, 0x76, 0x87];
  const seedBase = page1 + 0xffc;
  for (let i = 0; i < seed.length; i++) write8(seedBase + i, seed[i]);

  assert.strictEqual(e.test_gl16(page1 + 0xfff) >>> 0, 0x5443,
    'word read should gather across sparse backing');
  assert.strictEqual(e.test_gl32(page1 + 0xffd) >>> 0, 0x54433221,
    'dword read at page offset 0xffd should gather across sparse backing');
  assert.strictEqual(e.test_gl32(page1 + 0xffe) >>> 0, 0x65544332,
    'dword read at page offset 0xffe should gather across sparse backing');
  assert.strictEqual(e.test_gl32(page1 + 0xfff) >>> 0, 0x76655443,
    'dword read at page offset 0xfff should gather across sparse backing');

  e.test_gs16(page1 + 0xfff, 0xbbaa);
  assert.deepStrictEqual(
    [read8(page1 + 0xffe), read8(page1 + 0xfff), read8(page2), read8(page2 + 1)],
    [0x32, 0xaa, 0xbb, 0x65],
    'word store should scatter only its two bytes');

  for (const offset of [0xffd, 0xffe, 0xfff]) {
    for (let i = -1; i < 5; i++) write8(page1 + offset + i, 0xcc);
    e.test_gs32(page1 + offset, 0x78563412);
    assert.deepStrictEqual(
      Array.from({ length: 6 }, (_, i) => read8(page1 + offset - 1 + i)),
      [0xcc, 0x12, 0x34, 0x56, 0x78, 0xcc],
      `dword store at page offset 0x${offset.toString(16)} should scatter without touching neighbors`);
  }

  console.log('PASS  word/dword accesses cross non-contiguous sparse backing safely');
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

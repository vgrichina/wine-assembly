#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { compileWat } = require('../lib/compile-wat');
const { createHostImports } = require('../lib/host-imports');

const extraWat = String.raw`
  (func (export "test_lcmap_string_identity")
        (param $src i32) (param $count i32) (param $dst i32)
        (param $dst_count i32) (param $wide i32) (result i32)
    (call $lcmap_string_identity
      (local.get $src) (local.get $count) (local.get $dst)
      (local.get $dst_count) (local.get $wide)))
  (func (export "test_get_last_error") (result i32)
    (global.get $last_error))
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

  const src = e.guest_alloc(16) >>> 0;
  const dst = e.guest_alloc(16) >>> 0;
  const ansi = Buffer.from('C:\\Temp\0', 'ascii');
  ansi.forEach((value, i) => e.guest_write8(src + i, value));
  for (let i = 0; i < 16; i++) e.guest_write8(dst + i, 0xcc);

  assert.strictEqual(e.test_lcmap_string_identity(src, -1, 0, 0, 0), ansi.length,
    'NULL destination query includes the ANSI terminator for cchSrc=-1');
  assert.strictEqual(e.test_lcmap_string_identity(src, -1, dst, ansi.length, 0), ansi.length);
  assert.deepStrictEqual(
    Array.from({ length: ansi.length }, (_, i) => e.guest_read8(dst + i)),
    [...ansi],
    'ANSI cchSrc=-1 copies only the finite string and its terminator');
  assert.strictEqual(e.guest_read8(dst + ansi.length), 0xcc,
    'ANSI copy does not write beyond the normalized source length');

  for (let i = 0; i < 16; i++) e.guest_write8(dst + i, 0xcc);
  assert.strictEqual(e.test_lcmap_string_identity(src, -1, dst, ansi.length - 1, 0), 0,
    'an undersized destination fails instead of truncating');
  assert.strictEqual(e.test_get_last_error(), 122);
  assert.strictEqual(e.guest_read8(dst), 0xcc, 'failed mapping leaves destination untouched');
  assert.strictEqual(e.test_lcmap_string_identity(src, 3, dst, 3, 0), 3);
  assert.deepStrictEqual([0, 1, 2].map(i => e.guest_read8(dst + i)), [...ansi.subarray(0, 3)],
    'explicit ANSI counts remain character-bounded');

  const wideSrc = e.guest_alloc(12) >>> 0;
  const wideDst = e.guest_alloc(12) >>> 0;
  [0x41, 0x62, 0].forEach((value, i) => e.guest_write16(wideSrc + i * 2, value));
  for (let i = 0; i < 12; i++) e.guest_write8(wideDst + i, 0xcc);
  assert.strictEqual(e.test_lcmap_string_identity(wideSrc, -1, wideDst, 3, 1), 3,
    'wide cchSrc=-1 returns a character count including the terminator');
  assert.deepStrictEqual([0, 1, 2].map(i =>
    e.guest_read8(wideDst + i * 2) | (e.guest_read8(wideDst + i * 2 + 1) << 8)),
  [0x41, 0x62, 0]);
  assert.strictEqual(e.guest_read8(wideDst + 6), 0xcc,
    'wide mapping copies exactly two bytes per normalized character');

  console.log('PASS  LCMapStringA/W normalize -1 lengths and bound destination copies');
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

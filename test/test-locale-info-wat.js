#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { compileWat } = require('../lib/compile-wat');
const { createHostImports } = require('../lib/host-imports');

const extraWat = String.raw`
  (func (export "test_locale_info")
        (param $type i32) (param $out i32) (param $count i32)
        (param $wide i32) (result i32)
    (call $locale_info
      (local.get $type) (local.get $out) (local.get $count) (local.get $wide)))
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

  const output = e.guest_alloc(64) >>> 0;
  assert.strictEqual(e.test_locale_info(0x1002, 0, 0, 0), 14,
    'LOCALE_SENGCOUNTRY size query includes the terminator');
  assert.strictEqual(e.test_locale_info(0x1002, output, 14, 0), 14);
  assert.strictEqual(Buffer.from(Array.from({ length: 14 }, (_, i) =>
    e.guest_read8(output + i))).toString('ascii'), 'United States\0');

  for (let i = 0; i < 32; i++) e.guest_write8(output + i, 0xcc);
  assert.strictEqual(e.test_locale_info(0x1002, output, 13, 0), 0,
    'undersized country buffer fails without truncating');
  assert.strictEqual(e.test_get_last_error(), 122);
  assert.strictEqual(e.guest_read8(output), 0xcc);

  assert.strictEqual(e.test_locale_info(0x1002, output, 14, 1), 14);
  assert.strictEqual(String.fromCharCode(...Array.from({ length: 13 }, (_, i) =>
    e.guest_read8(output + i * 2) | (e.guest_read8(output + i * 2 + 1) << 8))),
  'United States');
  assert.strictEqual(e.guest_read8(output + 26), 0);
  assert.strictEqual(e.guest_read8(output + 27), 0);

  assert.strictEqual(e.test_locale_info(0x0e, output, 2, 0), 2);
  assert.strictEqual(e.guest_read8(output), '.'.charCodeAt(0),
    'existing decimal-separator behavior remains intact');

  console.log('PASS  GetLocaleInfoA/W reports the Win98 en-US English country name');
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

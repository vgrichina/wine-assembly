#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { compileWat } = require('../lib/compile-wat');
const { createHostImports } = require('../lib/host-imports');

const extraWat = String.raw`
  (func (export "test_call_OpenFile") (param $name i32) (param $style i32) (result i32)
    (global.set $esp (i32.const 0x07000000))
    (call $handle_OpenFile (local.get $name) (i32.const 0) (local.get $style)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
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
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  const e = instance.exports;
  context.exports = e;

  function ansi(value) {
    const p = e.guest_alloc(value.length + 1) >>> 0;
    for (let i = 0; i < value.length; i++) e.guest_write8(p + i, value.charCodeAt(i));
    e.guest_write8(p + value.length, 0);
    return p;
  }

  const tempName = ansi('C:\\WINDOWS\\TEMP\\_INS0566._MP');
  const created = e.test_call_OpenFile(tempName, 0x1002) >>> 0;
  assert.notStrictEqual(created, 0xffffffff, 'OF_CREATE|OF_READWRITE creates the file');
  assert(context.vfs.files.has('c:\\windows\\temp\\_ins0566._mp'));
  assert.strictEqual(context.vfs.handles.get(created).access >>> 0, 0xc0000000,
    'OF_READWRITE requests both read and write access');

  context.vfs.files.get('c:\\windows\\temp\\_ins0566._mp').data = new Uint8Array([1, 2, 3]);
  const recreated = e.test_call_OpenFile(tempName, 0x1002) >>> 0;
  assert.notStrictEqual(recreated, 0xffffffff);
  assert.strictEqual(context.vfs.files.get('c:\\windows\\temp\\_ins0566._mp').data.length, 0,
    'OF_CREATE truncates an existing destination');

  const missing = e.test_call_OpenFile(ansi('C:\\missing.bin'), 0) >>> 0;
  assert.strictEqual(missing, 0xffffffff, 'ordinary OF_READ remains OPEN_EXISTING');

  console.log('PASS  OpenFile honors OF_CREATE and ANSI read/write access modes');
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

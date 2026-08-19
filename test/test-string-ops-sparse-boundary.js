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

  // Create adjacent guest mappings with non-contiguous WASM backing, matching
  // the interleaved commit order seen in Blobby Volley's render worker.
  const dstMap1 = 0x30000000;
  const dstMap2 = 0x30001000;
  assert.strictEqual(e.test_sparse_map(dstMap1, 0x1000) >>> 0, dstMap1);
  assert.strictEqual(e.test_sparse_map(0x28000000, 0x1000) >>> 0, 0x28000000);
  assert.strictEqual(e.test_sparse_map(dstMap2, 0x1000) >>> 0, dstMap2);

  const imageBase = e.get_image_base() >>> 0;
  const direct = guest => guest - imageBase + 0x12000;
  const source = imageBase + 0x9000;
  const destination = dstMap1 + 0xff0;
  const values = [
    0x10203040, 0x11213141, 0x12223242, 0x13233343,
    0x14243444, 0x15253545, 0x16263646, 0x17273747,
  ];
  for (let i = 0; i < values.length; i++) {
    e.guest_write32(source + i * 4, values[i]);
    e.guest_write32(destination + i * 4, 0);
  }

  // STD; REP MOVSD; CLD; RET. The backward copy starts at the highest dword
  // and crosses from dstMap2 into dstMap1.
  const code = imageBase + 0x2000;
  new Uint8Array(memory.buffer).set([0xfd, 0xf3, 0xa5, 0xfc, 0xc3], direct(code));
  const stack = imageBase + 0xd00000;
  e.set_esp(stack);
  e.guest_write32(stack, 0);
  e.set_esi(source + values.length * 4 - 4);
  e.set_edi(destination + values.length * 4 - 4);
  e.set_ecx(values.length);
  e.set_eip(code);
  e.run(100000);

  assert.strictEqual(e.get_eip() >>> 0, 0, 'test code should return to the sentinel');
  assert.strictEqual(e.get_ecx() >>> 0, 0, 'REP MOVSD should consume ECX');
  assert.strictEqual(e.get_esi() >>> 0, source - 4, 'DF copy should decrement ESI');
  assert.strictEqual(e.get_edi() >>> 0, destination - 4, 'DF copy should decrement EDI');
  for (let i = 0; i < values.length; i++) {
    assert.strictEqual(e.guest_read32(destination + i * 4) >>> 0, values[i],
      `dword ${i} should cross the sparse-map boundary intact`);
  }

  console.log('PASS  REP MOVSD crosses non-contiguous sparse backing safely');
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

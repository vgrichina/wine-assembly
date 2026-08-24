#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { compileWat } = require('../lib/compile-wat');
const { createHostImports } = require('../lib/host-imports');

const extraWat = String.raw`
  (func (export "test_sparse_map_for_code") (param $guest i32) (param $size i32) (result i32)
    (call $virtual_map_commit (local.get $guest) (local.get $size)))
  (func (export "test_sparse_code_start") (result i32)
    (global.get $generated_sparse_code_start))
  (func (export "test_sparse_code_end") (result i32)
    (global.get $generated_sparse_code_end))
  (func (export "test_sparse_code_condition") (param $guest i32) (result i32)
    (i32.and
      (i32.ge_u (local.get $guest) (global.get $VIRTUAL_ALLOC_MIN))
      (i32.lt_u (local.get $guest) (global.get $VIRTUAL_ALLOC_TOP_INIT))))
  ;; $page_probe, not the old $cache_lookup: the hash block cache is gone and the
  ;; per-page byte index is the only record that an address is compiled
  ;; (docs/page-compile-design.md section 4).
  (func (export "test_sparse_cache_lookup") (param $guest i32) (result i32)
    (call $page_probe (local.get $guest)))
`;

async function main() {
  const root = path.join(__dirname, '..');
  const bytes = await compileWat(async filename => {
    const source = await fs.promises.readFile(path.join(root, 'src', filename), 'utf8');
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

  const code = 0x4ff60000;
  assert.strictEqual(e.test_sparse_map_for_code(code, 0x1000) >>> 0, code);
  assert.strictEqual(e.test_sparse_code_condition(code), 1,
    'sparse code address should lie in the tracked VirtualAlloc arena');
  const stack = (e.get_image_base() + 0xd00000) >>> 0;
  const le32 = value => [value, value >>> 8, value >>> 16, value >>> 24].map(v => v & 0xff);

  function install(value) {
    const machineCode = [0xb8, ...le32(value), 0xc3]; // mov eax,value; ret
    machineCode.forEach((byte, index) => e.guest_write8(code + index, byte));
  }

  function execute() {
    e.set_esp(stack);
    e.guest_write32(stack, 0);
    e.set_eip(code);
    e.run(1000);
    assert.strictEqual(e.get_eip() >>> 0, 0, 'generated probe should return to the sentinel');
    return e.get_eax() >>> 0;
  }

  install(0x11223344);
  assert.strictEqual(execute(), 0x11223344, 'first sparse generated block should execute');
  assert.notStrictEqual(e.test_sparse_cache_lookup(code) >>> 0, 0,
    'executing sparse code should populate the decoded-block cache');
  assert.strictEqual(e.test_sparse_code_start() >>> 0, code,
    'executing sparse code should register its page for invalidation');
  assert.strictEqual(e.test_sparse_code_end() >>> 0, code + 0x1000,
    'sparse generated-code tracking should cover the complete page');
  install(0x55667788);
  assert.strictEqual(execute(), 0x55667788,
    'rewriting sparse generated code must invalidate its decoded block');

  console.log('PASS  sparse generated-code writes invalidate decoded blocks');
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

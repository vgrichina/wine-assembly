#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { compileSrcWasm } = require('./compile-src');
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
  (func (export "test_sparse_guest_to_wasm") (param $guest i32) (result i32)
    (call $g2w (local.get $guest)))
  (func (export "test_sparse_last_error") (result i32)
    (global.get $last_error))
  (func (export "test_call_FlushInstructionCache")
      (param $process i32) (param $base i32) (param $size i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_FlushInstructionCache
      (local.get $process) (local.get $base) (local.get $size)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
`;

async function main() {
  const root = path.join(__dirname, '..');
  // Plain append: src fragments are self-balanced now, so there is no trailing
  // `)` to splice before — the old regex matched nothing and dropped extraWat.
  const bytes = compileSrcWasm((filename, source) =>
    filename === '13-exports.wat' ? `${source}\n${extraWat}\n` : source);

  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const instantiate = async () => {
    const context = { exports: null, getMemory: () => memory.buffer };
    const imports = createHostImports(context);
    imports.host.memory = memory;
    imports.host.exit = () => {};
    imports.host.log = () => {};
    imports.host.log_i32 = () => {};
    imports.host.crash_unimplemented = () => {};
    imports.host.wait_multiple = () => 0;
    imports.host.terminate_thread = () => 0;
    imports.host.shell_execute = () => 33;
    const { instance } = await WebAssembly.instantiate(bytes, imports);
    context.exports = instance.exports;
    return instance;
  };
  const instance = await instantiate();
  const e = instance.exports;

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

  // A decoded block is retired by the page it STARTS on, so a block that
  // begins near the end of one page and runs into the next used to survive a
  // rewrite of its own tail. Storm's byte copier is exactly that shape: a long
  // run of unrolled `mov al,[esi]/inc esi/mov [edi],al/inc edi` entered at
  // end-8*count and terminated by a `jmp` it patches per call, so a copy of
  // more than ~500 bytes starts a page below the jump it rewrites.
  const spanCode = 0x4ff70ff0;
  assert.strictEqual(e.test_sparse_map_for_code(0x4ff70000, 0x2000) >>> 0, 0x4ff70000);

  function installSpanning(value) {
    // 16 nops carry the block across the page boundary; the payload the test
    // rewrites sits on the second page.
    const machineCode = [...new Array(16).fill(0x90), 0xb8, ...le32(value), 0xc3];
    machineCode.forEach((byte, index) => e.guest_write8(spanCode + index, byte));
  }

  function executeSpanning() {
    e.set_esp(stack);
    e.guest_write32(stack, 0);
    e.set_eip(spanCode);
    e.run(1000);
    assert.strictEqual(e.get_eip() >>> 0, 0, 'spanning probe should return to the sentinel');
    return e.get_eax() >>> 0;
  }

  // The rewrite has to touch ONLY the second page: writing the whole probe
  // again would invalidate the start page too and the test would pass either
  // way.
  function patchSpanning(value) {
    le32(value).forEach((byte, index) => e.guest_write8(spanCode + 17 + index, byte));
  }

  installSpanning(0x0a0b0c0d);
  assert.strictEqual(executeSpanning(), 0x0a0b0c0d,
    'page-spanning sparse block should execute');
  patchSpanning(0x1a1b1c1d);
  assert.strictEqual(executeSpanning(), 0x1a1b1c1d,
    'rewriting the tail of a page-spanning block must invalidate it');

  // FlushInstructionCache is process-wide on Win98. Our real Worker backend
  // has one decoded-code cache per WASM instance over the same guest bytes, so
  // this uses two instances to catch the deceptively easy local-only fix.
  const worker = await instantiate();
  const w = worker.exports;
  w.init_thread(1, e.get_image_base(), e.get_code_start(), e.get_code_end(),
    e.get_thunk_base(), e.get_thunk_end(), e.get_num_thunks(), e.get_rsrc_rva());
  const sharedCode = 0x4ff80000;
  assert.strictEqual(e.test_sparse_map_for_code(sharedCode, 0x1000) >>> 0, sharedCode);
  assert.strictEqual(w.test_sparse_map_for_code(sharedCode, 0x1000) >>> 0, sharedCode);
  const sharedWa = e.test_sparse_guest_to_wasm(sharedCode) >>> 0;
  const sharedBytes = new Uint8Array(memory.buffer);
  const workerStack = (stack - 0x1000) >>> 0;
  const codeFor = value => Uint8Array.from([0xb8, ...le32(value), 0xc3]);
  const executeShared = (wat, valueStack) => {
    wat.set_esp(valueStack);
    wat.guest_write32(valueStack, 0);
    wat.set_eip(sharedCode);
    wat.run(1000);
    assert.strictEqual(wat.get_eip() >>> 0, 0);
    return wat.get_eax() >>> 0;
  };

  sharedBytes.set(codeFor(0x10203040), sharedWa);
  assert.strictEqual(executeShared(e, stack), 0x10203040);
  assert.strictEqual(executeShared(w, workerStack), 0x10203040);
  assert.notStrictEqual(e.test_sparse_cache_lookup(sharedCode) >>> 0, 0);
  assert.notStrictEqual(w.test_sparse_cache_lookup(sharedCode) >>> 0, 0);

  // Patch through the shared backing store, deliberately bypassing every x86
  // store helper. An invalid process handle must neither claim success nor
  // publish an invalidation; the second instance therefore still runs its old
  // decoded immediate until the valid flush below.
  sharedBytes.set(codeFor(0x50607080), sharedWa);
  assert.strictEqual(e.test_call_FlushInstructionCache(0x1234, sharedCode, 5), 0);
  assert.strictEqual(e.test_sparse_last_error(), 6);
  assert.strictEqual(executeShared(w, workerStack), 0x10203040,
    'invalid process handles do not flush another instance');

  const workerClears = w.get_cache_clears();
  assert.strictEqual(e.test_call_FlushInstructionCache(-1, sharedCode + 1, 4), 1);
  assert.strictEqual(e.test_sparse_cache_lookup(sharedCode) >>> 0, 0,
    'the calling instance retires the exact decoded range immediately');
  assert.strictEqual(executeShared(e, stack), 0x50607080);
  assert.strictEqual(executeShared(w, workerStack), 0x50607080,
    'a sibling Worker observes the process flush before its next slice');
  assert.strictEqual(w.get_cache_clears(), workerClears + 1,
    'a sibling Worker drops its complete instance-local cache');

  // NULL requests the whole cache. It is deferred to the next safe block
  // boundary in the caller and broadcast to every sibling instance.
  const mainClears = e.get_cache_clears();
  const workerFullClears = w.get_cache_clears();
  assert.strictEqual(e.test_call_FlushInstructionCache(-1, 0, 0), 1);
  assert.strictEqual(executeShared(e, stack), 0x50607080);
  assert.strictEqual(executeShared(w, workerStack), 0x50607080);
  assert.strictEqual(e.get_cache_clears(), mainClears + 1);
  assert.strictEqual(w.get_cache_clears(), workerFullClears + 1);

  const processHandle = (0x000e2000 | (e.get_process_id() & 0xfff)) >>> 0;
  assert.strictEqual(e.test_call_FlushInstructionCache(processHandle, sharedCode, 0), 1,
    'OpenProcess handles accept a successful empty range');

  console.log('PASS  sparse writes and process-wide FlushInstructionCache invalidate decoded blocks');
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

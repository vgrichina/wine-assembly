#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_get_command_line_a") (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_GetCommandLineA
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_get_main_args") (param $argc i32) (param $argv i32) (param $envp i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle___getmainargs
      (local.get $argc) (local.get $argv) (local.get $envp)
      (i32.const 0) (i32.const 0) (i32.const 0)))
  (func (export "test_p_acmdln") (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle___p__acmdln
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat, fonts: 'none' });

  const memory = new Uint8Array(e.memory.buffer);
  const guestBase = e.get_guest_base() >>> 0;
  const extra = Buffer.from('one "two words" three', 'ascii');
  memory.set(extra, 0x500);
  e.set_extra_cmdline(0x500, extra.length);

  const readCString = guest => {
    let result = '';
    for (let wa = guestBase + (guest >>> 0); memory[wa] !== 0; wa++) {
      result += String.fromCharCode(memory[wa]);
    }
    return result;
  };

  const first = e.test_get_command_line_a() >>> 0;
  const afterFirst = e.get_heap_ptr() >>> 0;
  const second = e.test_get_command_line_a() >>> 0;
  const afterSecond = e.get_heap_ptr() >>> 0;

  assert.notStrictEqual(first, 0, 'GetCommandLineA returns a command-line buffer');
  assert.strictEqual(second, first, 'GetCommandLineA returns a process-stable pointer');
  assert.strictEqual(afterSecond, afterFirst, 'repeated GetCommandLineA does not allocate');

  const argcOut = 0x00600000;
  const argvOut = argcOut + 4;
  const envpOut = argcOut + 8;
  e.test_get_main_args(argcOut, argvOut, envpOut);
  const argc = e.guest_read32(argcOut) >>> 0;
  const argv = e.guest_read32(argvOut) >>> 0;
  assert.strictEqual(argc, 4, '__getmainargs exposes executable plus three arguments');
  assert.deepStrictEqual(Array.from({ length: argc }, (_, i) =>
    readCString(e.guest_read32(argv + i * 4) >>> 0)),
  ['C:\\app.exe', 'one', 'two words', 'three']);
  assert.strictEqual(e.guest_read32(argv + argc * 4) >>> 0, 0, 'argv is NULL-terminated');
  assert.strictEqual(e.guest_read32(e.guest_read32(envpOut) >>> 0) >>> 0, 0,
    'empty envp is NULL-terminated');
  const acmdlnCell = e.test_p_acmdln() >>> 0;
  assert.strictEqual(e.guest_read32(acmdlnCell) >>> 0, first,
    '__p__acmdln points at the same full command line');
  assert.strictEqual(readCString(first), 'C:\\app.exe one "two words" three',
    'GetCommandLineA preserves the raw quoted command line');
  console.log('PASS GetCommandLineA, _acmdln, and argv share one stable command-line source');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

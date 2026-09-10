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
  (func (export "test_get_proc_address") (param $name i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_GetProcAddress
      (i32.const 0x00400000) (local.get $name) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
`;

const checkCommandLine = async (extraText, expectedArgv, expectedRaw, exeName = 'app.exe') => {
  const { exports: e } = await bootRenderHarness({ extraWat, fonts: 'none' });

  const memory = new Uint8Array(e.memory.buffer);
  const guestBase = e.get_guest_base() >>> 0;
  const readCString = guest => {
    let result = '';
    for (let wa = guestBase + (guest >>> 0); memory[wa] !== 0; wa++) {
      result += String.fromCharCode(memory[wa]);
    }
    return result;
  };

  const staging = e.get_staging() >>> 0;
  const exe = Buffer.from(exeName, 'ascii');
  memory.set(exe, staging);
  e.set_exe_name(staging, exe.length);
  const extra = Buffer.from(extraText, 'ascii');
  memory.set(extra, staging);
  e.set_extra_cmdline(staging, extra.length);

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
  assert.strictEqual(argc, expectedArgv.length,
    '__getmainargs exposes executable plus parsed arguments');
  assert.deepStrictEqual(Array.from({ length: argc }, (_, i) =>
    readCString(e.guest_read32(argv + i * 4) >>> 0)), expectedArgv);
  assert.strictEqual(e.guest_read32(argv + argc * 4) >>> 0, 0, 'argv is NULL-terminated');
  assert.strictEqual(e.guest_read32(e.guest_read32(envpOut) >>> 0) >>> 0, 0,
    'empty envp is NULL-terminated');
  const acmdlnCell = e.test_p_acmdln() >>> 0;
  assert.strictEqual(e.guest_read32(acmdlnCell) >>> 0, first,
    '__p__acmdln points at the same full command line');
  const acmdlnName = 0x00600100;
  memory.set(Buffer.from('_acmdln\0', 'ascii'), guestBase + acmdlnName);
  assert.strictEqual(e.test_get_proc_address(acmdlnName) >>> 0, acmdlnCell,
    'GetProcAddress returns the exported _acmdln data cell, not a call thunk');
  assert.strictEqual(readCString(first), expectedRaw,
    'GetCommandLineA preserves the raw command line');
};

(async () => {
  await checkCommandLine('one "two words" three',
    ['C:\\app.exe', 'one', 'two words', 'three'],
    'C:\\app.exe one "two words" three');

  await checkCommandLine('-c c:\\queen.ini --path=c:\\ queen',
    ['C:\\app.exe', '-c', 'c:\\queen.ini', '--path=c:\\', 'queen'],
    'C:\\app.exe -c c:\\queen.ini --path=c:\\ queen');

  await checkCommandLine('-deleter',
    ['C:\\Black and White Setup.exe', '-deleter'],
    '"C:\\Black and White Setup.exe" -deleter',
    'Black and White Setup.exe');

  console.log('PASS GetCommandLineA, _acmdln, and argv share one stable command-line source');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

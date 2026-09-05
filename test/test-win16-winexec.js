#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_win16_winexec") (result i32)
    (call $win16_seg_set (i32.const 1) (i32.const 0x00100000)
      (i32.const 0x10000) (i32.const 0) (i32.const 1))
    (call $win16_seg_set (i32.const 2) (i32.const 0x00110000)
      (i32.const 0x10000) (i32.const 1) (i32.const 2))
    (call $win16_seg_set (i32.const 3) (i32.const 0x00120000)
      (i32.const 0x10000) (i32.const 2) (i32.const 3))
    (global.set $code16 (i32.const 1))
    (global.set $sreg_cs (call $win16_index_to_sel (i32.const 1)))
    (global.set $seg_base_cs (i32.const 0x00100000))
    (global.set $sreg_ss (call $win16_index_to_sel (i32.const 2)))
    (global.set $seg_base_ss (i32.const 0x00110000))
    (global.set $esp (i32.const 0x00110100))
    ;; Far return, then Pascal's rightmost argument first: show, command.
    (call $gs16 (i32.const 0x00110100) (i32.const 0x0020))
    (call $gs16 (i32.const 0x00110102) (call $win16_index_to_sel (i32.const 1)))
    (call $gs16 (i32.const 0x00110104) (i32.const 5))
    (call $gs16 (i32.const 0x00110106) (i32.const 0x0040))
    (call $gs16 (i32.const 0x00110108) (call $win16_index_to_sel (i32.const 3)))
    (call $win16_WinExec)
    (global.get $eax))
  (func (export "test_win16_winexec_esp") (result i32) (global.get $esp))
  (func (export "test_win16_winexec_eip") (result i32) (global.get $eip))
`;

(async () => {
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const launches = [];
  const readString = pointer => {
    const bytes = new Uint8Array(memory.buffer);
    let value = '';
    for (let p = pointer; bytes[p]; p++) value += String.fromCharCode(bytes[p]);
    return value;
  };
  const { exports: e } = await bootRenderHarness({
    extraWat,
    memory,
    extraHostOverrides: {
      shell_execute(hwnd, operation, file, params, directory, show) {
        launches.push({
          hwnd, operation: readString(operation), file: readString(file),
          params, directory, show,
        });
        return 33;
      },
    },
  });

  const command = 'C:\\WINDOWS\\TEMP\\_INS0432._MP -fD:\\SETUP.INS';
  for (const [i, byte] of Buffer.from(command + '\0', 'ascii').entries()) {
    e.guest_write8(0x00120040 + i, byte);
  }
  assert.strictEqual(e.test_win16_winexec(), 33,
    'Win16 WinExec returns the browser child-launch result');
  assert.deepStrictEqual(launches, [{
    hwnd: 0, operation: 'WinExec', file: command,
    params: 0, directory: 0, show: 5,
  }], 'Win16 WinExec forwards the command and parsing marker');
  assert.strictEqual(e.test_win16_winexec_esp(), 0x0011010a,
    'WinExec removes its far return and six-byte Pascal argument list');
  assert.strictEqual(e.test_win16_winexec_eip(), 0x00100020,
    'WinExec returns to its Win16 caller');

  console.log('PASS  Win16 WinExec launches decompressed VFS child executables');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_winexec") (param $command i32) (param $show i32) (result i32)
    (global.set $image_base (i32.const 0))
    (global.set $esp (i32.const 0x00300000))
    (call $handle_WinExec
      (local.get $command) (local.get $show) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0))
    (global.get $eax))
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
    fonts: 'none',
    memory,
    extraHostOverrides: {
      shell_execute(hwnd, op, file, params, directory, show) {
        launches.push({ hwnd, op, file: readString(file), params, directory, show });
        return 33;
      },
    },
  });

  const command = 0x2800;
  for (const [i, byte] of Buffer.from('pockettanks.exe\0', 'ascii').entries()) {
    e.guest_write8(command + i, byte);
  }
  assert.strictEqual(e.test_winexec(command, 1), 33,
    'WinExec returns the process-launch success code');
  assert.deepStrictEqual(launches, [{
    hwnd: 0, op: 0, file: 'pockettanks.exe', params: 0, directory: 0, show: 1,
  }], 'WinExec forwards the relative command to the shared launch boundary');
  assert.strictEqual(e.get_esp(), 0x0030000c,
    'WinExec pops its two stdcall arguments and return address');

  console.log('PASS WinExec forwards relative sibling executables to the VFS process launcher');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

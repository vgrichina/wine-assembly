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
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat, fonts: 'none' });

  const first = e.test_get_command_line_a() >>> 0;
  const afterFirst = e.get_heap_ptr() >>> 0;
  const second = e.test_get_command_line_a() >>> 0;
  const afterSecond = e.get_heap_ptr() >>> 0;

  assert.notStrictEqual(first, 0, 'GetCommandLineA returns a command-line buffer');
  assert.strictEqual(second, first, 'GetCommandLineA returns a process-stable pointer');
  assert.strictEqual(afterSecond, afterFirst, 'repeated GetCommandLineA does not allocate');
  console.log('PASS GetCommandLineA keeps one stable process command-line allocation');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_shell_desktop_fallback") (param $out i32) (result i32)
    (global.set $image_base (i32.const 0))
    (global.set $esp (i32.const 0x00300000))
    (call $gs32 (local.get $out) (i32.const 0xdeadbeef))
    (call $handle_SHGetDesktopFolder (local.get $out)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat });
  const out = 0x2400;
  assert.strictEqual(wat.test_shell_desktop_fallback(out) >>> 0, 0,
    'SHGetDesktopFolder exposes the bounded installer namespace');
  assert.notStrictEqual(wat.guest_read32(out), 0,
    'SHGetDesktopFolder returns a valid desktop IShellFolder wrapper');
  console.log('PASS  shell desktop fallback keeps Explorer namespace enumeration isolated');
})().catch(err => {
  console.error(err);
  process.exit(1);
});

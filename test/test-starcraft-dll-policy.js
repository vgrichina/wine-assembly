#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { isLoadableDll, dllPath } = require('../lib/dll-registry');
const { bootRenderHarness } = require('./render-helper');

assert.strictEqual(isLoadableDll('storm.dll'), true,
  'Blizzard Storm must load from the app directory as a real PE DLL');
assert.strictEqual(isLoadableDll('STORM.DLL'), true,
  'app-local DLL policy must be case-insensitive');
assert.strictEqual(dllPath('storm.dll'), null,
  'Storm is app-local and must not resolve to a bundled system DLL');

const extraWat = String.raw`
  (func (export "test_sparse_map") (param $guest i32) (param $size i32) (result i32)
    (call $virtual_map_commit (local.get $guest) (local.get $size)))
  (func (export "test_starcraft_strupr") (param $string i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle__strupr (local.get $string) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_starcraft_fullpath") (param $dst i32) (param $src i32) (param $cap i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle__fullpath (local.get $dst) (local.get $src) (local.get $cap)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat });
  const string = 0x30000ffb;
  wat.test_sparse_map(string & ~0xfff, 0x1000);
  wat.test_sparse_map((string & ~0xfff) + 0x1000, 0x1000);
  wat.test_sparse_map((string & ~0xfff) + 0x2000, 0x1000);
  const input = 'Storm.dll';
  for (let i = 0; i < input.length; i++) wat.guest_write8(string + i, input.charCodeAt(i));
  wat.guest_write8(string + input.length, 0);
  assert.strictEqual(wat.test_starcraft_strupr(string) >>> 0, string,
    '_strupr returns its original guest pointer');
  const output = Array.from({ length: input.length }, (_, i) =>
    String.fromCharCode(wat.guest_read8(string + i))).join('');
  assert.strictEqual(output, 'STORM.DLL',
    '_strupr uppercases in place across a sparse page boundary');

  const src = string + 0x100;
  const dst = (string & ~0xfff) + 0x1ff8;
  const sound = 'C:\\sound\\Misc\\Button.wav';
  for (let i = 0; i < sound.length; i++) wat.guest_write8(src + i, sound.charCodeAt(i));
  wat.guest_write8(src + sound.length, 0);
  assert.strictEqual(wat.test_starcraft_fullpath(dst, src, 260) >>> 0, dst,
    '_fullpath returns the caller destination');
  const full = Array.from({ length: sound.length }, (_, i) =>
    String.fromCharCode(wat.guest_read8(dst + i))).join('');
  assert.strictEqual(full, 'C:\\sound\\misc\\button.wav',
    '_fullpath resolves an absolute StarCraft asset path across sparse pages');
  console.log('PASS  StarCraft loads and initializes its app-local Storm runtime');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

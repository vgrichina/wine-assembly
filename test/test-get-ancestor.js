#!/usr/bin/env node

'use strict';

const assert = require('assert');
const apiTable = require('../src/api_table.json');
const { bootRenderHarness } = require('./render-helper');

const extraWat = `
  (func (export "test_add_window") (param $hwnd i32) (param $parent i32) (param $owner i32)
    (call $wnd_table_set (local.get $hwnd) (global.get $WNDPROC_DIALOG))
    (call $wnd_set_parent (local.get $hwnd) (local.get $parent))
    (call $wnd_set_owner (local.get $hwnd) (local.get $owner)))

  (func (export "test_get_ancestor") (param $hwnd i32) (param $flags i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_GetAncestor
      (local.get $hwnd) (local.get $flags) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))
`;

(async () => {
  assert.strictEqual(apiTable.find(entry => entry.name === 'GetAncestor').nargs, 2,
    'GetAncestor is available to dynamic import callers');
  const { exports: wat } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const ownerRoot = 0x10020;
  const popup = 0x10021;
  const child = 0x10022;
  wat.test_add_window(ownerRoot, 0, 0);
  wat.test_add_window(popup, 0, ownerRoot);
  wat.test_add_window(child, popup, 0);

  assert.strictEqual(wat.test_get_ancestor(child, 1) >>> 0, popup,
    'GA_PARENT returns the immediate parent');
  assert.strictEqual(wat.test_get_ancestor(child, 2) >>> 0, popup,
    'GA_ROOT stops at the child hierarchy root');
  assert.strictEqual(wat.test_get_ancestor(child, 3) >>> 0, ownerRoot,
    'GA_ROOTOWNER follows the root popup owner');
  assert.strictEqual(wat.test_get_ancestor(popup, 1), 0,
    'GA_PARENT does not substitute a top-level owner');
  assert.strictEqual(wat.test_get_ancestor(0x7ffffffe, 2), 0,
    'an invalid window has no ancestor');
  assert.strictEqual(wat.test_get_ancestor(child, 99), 0,
    'an unsupported flag returns NULL');

  console.log('PASS GetAncestor distinguishes parent, root, and root owner');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

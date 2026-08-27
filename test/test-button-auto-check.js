#!/usr/bin/env node
'use strict';

// USER changes the state before BN_CLICKED only for the automatic BUTTON
// styles. Framework-owned plain CHECKBOX/3STATE controls must see their old
// state so their subclass can implement the transition itself.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_create_check_button") (param $kind i32) (result i32)
    (call $ctrl_create_child
      (i32.const 0) (i32.const 1) (i32.const 100)
      (i32.const 0) (i32.const 0) (i32.const 20) (i32.const 20)
      (i32.or (i32.const 0x50010000) (local.get $kind)) (i32.const 0)))

  (func (export "test_click_button") (param $hwnd i32)
    (drop (call $button_wndproc
      (local.get $hwnd) (i32.const 0x0201) (i32.const 1) (i32.const 0)))
    (drop (call $button_wndproc
      (local.get $hwnd) (i32.const 0x0202) (i32.const 0) (i32.const 0))))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat });
  const state = hwnd => e.send_message(hwnd, 0x00f0, 0, 0) | 0;
  const click = kind => {
    const hwnd = e.test_create_check_button(kind) >>> 0;
    assert.strictEqual(state(hwnd), 0, `BUTTON kind ${kind} starts unchecked`);
    e.test_click_button(hwnd);
    return state(hwnd);
  };

  assert.strictEqual(click(2), 0, 'BS_CHECKBOX does not change state automatically');
  assert.strictEqual(click(5), 0, 'BS_3STATE does not change state automatically');
  assert.strictEqual(click(3), 1, 'BS_AUTOCHECKBOX toggles before BN_CLICKED');
  assert.strictEqual(click(6), 1, 'BS_AUTO3STATE advances before BN_CLICKED');

  console.log('PASS  only automatic BUTTON styles change check state on click');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

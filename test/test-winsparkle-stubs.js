#!/usr/bin/env node
'use strict';

const assert = require('assert');
const apiTable = require('../src/api_table.json');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_winsparkle_set") (result i64)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_win_sparkle_set_appcast_url
      (i32.const 0x2800) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (i64.or (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))
  (func (export "test_winsparkle_get") (result i64)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_win_sparkle_get_automatic_check_for_updates
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (i64.or (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))
`;

(async () => {
  const imported = [
    'win_sparkle_check_update_with_ui', 'win_sparkle_get_last_check_time',
    'win_sparkle_get_update_check_interval', 'win_sparkle_set_update_check_interval',
    'win_sparkle_get_automatic_check_for_updates',
    'win_sparkle_set_automatic_check_for_updates', 'win_sparkle_set_appcast_url',
    'win_sparkle_cleanup', 'win_sparkle_init',
  ];
  for (const name of imported) {
    const api = apiTable.find(entry => entry.name === name);
    assert(api, `${name} resolves`);
    assert.strictEqual(api.convention, 'cdecl', `${name} keeps caller stack ownership`);
  }

  const { exports: e } = await bootRenderHarness({ extraWat, fonts: 'none' });
  for (const result of [e.test_winsparkle_set(), e.test_winsparkle_get()]) {
    assert.strictEqual(Number(result & 0xffffffffn), 0, 'disabled updater returns zero');
    assert.strictEqual(Number(result >> 32n), 0x00300004,
      'cdecl handler pops only the thunk return address');
  }
  console.log('PASS WinSparkle imports expose one disabled cdecl updater state');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_reg_set_value_a")
        (param i32 i32 i32 i32 i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_RegSetValueA
      (local.get 0) (local.get 1) (local.get 2) (local.get 3)
      (local.get 4) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))
  (func (export "test_reg_set_value_w")
        (param i32 i32 i32 i32 i32) (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_RegSetValueW
      (local.get 0) (local.get 1) (local.get 2) (local.get 3)
      (local.get 4) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))
  (func (export "test_reg_query_value")
        (param i32 i32 i32 i32 i32) (result i32)
    (call $reg_query_value
      (local.get 0) (local.get 1) (local.get 2) (local.get 3) (local.get 4)))
  (func (export "test_reg_create_key_ex_a")
        (param $root i32) (param $subkey i32) (param $phk i32) (param $disp i32)
        (result i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (global.set $esp (i32.const 0x00300000))
    (call $gs32 (i32.add (global.get $esp) (i32.const 32)) (local.get $phk))
    (call $gs32 (i32.add (global.get $esp) (i32.const 36)) (local.get $disp))
    (call $handle_RegCreateKeyExA
      (local.get $root) (local.get $subkey) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0))
    (global.set $esp (local.get $saved_esp))
    (global.get $eax))
`;

(async () => {
  const { exports: e, memory } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const u8 = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  const wa = guest => (guest - (e.get_image_base() >>> 0) + (e.get_guest_base() >>> 0)) >>> 0;
  const allocA = value => {
    const g = e.guest_alloc(value.length + 1) >>> 0;
    u8.set(Buffer.from(value, 'latin1'), wa(g));
    u8[wa(g) + value.length] = 0;
    return g;
  };
  const allocW = value => {
    const g = e.guest_alloc(value.length * 2 + 2) >>> 0;
    for (let i = 0; i < value.length; i++) dv.setUint16(wa(g) + i * 2, value.charCodeAt(i), true);
    dv.setUint16(wa(g) + value.length * 2, 0, true);
    return g;
  };
  const readA = (g, limit = 128) => {
    let out = '';
    for (let i = 0; i < limit && u8[wa(g) + i]; i++) out += String.fromCharCode(u8[wa(g) + i]);
    return out;
  };
  const readW = (g, limit = 128) => {
    let out = '';
    for (let i = 0; i < limit; i++) {
      const ch = dv.getUint16(wa(g) + i * 2, true);
      if (!ch) break;
      out += String.fromCharCode(ch);
    }
    return out;
  };

  const HKCU = 0x80000001;
  const createSub = allocA('Software\\RegCreateDispositionTest');
  const createdKey = e.guest_alloc(4) >>> 0;
  const disposition = e.guest_alloc(4) >>> 0;
  assert.strictEqual(e.test_reg_create_key_ex_a(HKCU, createSub, createdKey, disposition), 0);
  assert.strictEqual(e.guest_read32(disposition) >>> 0, 1,
    'RegCreateKeyExA reports REG_CREATED_NEW_KEY for a new key');
  assert.strictEqual(e.test_reg_create_key_ex_a(HKCU, createSub, createdKey, disposition), 0);
  assert.strictEqual(e.guest_read32(disposition) >>> 0, 2,
    'RegCreateKeyExA reports REG_OPENED_EXISTING_KEY when the key already exists');

  const aSub = allocA('Software\\RegSetValueATest');
  const aValue = allocA('ANSI default');
  assert.strictEqual(e.test_reg_set_value_a(HKCU, aSub, 1, aValue, 13), 0,
    'RegSetValueA creates its subkey and stores the default value');
  const aOut = e.guest_alloc(64) >>> 0;
  const aCb = e.guest_alloc(4) >>> 0;
  e.guest_write32(aCb, 64);
  assert.strictEqual(e.test_reg_query_value(HKCU, aSub, aOut, aCb, 0), 0,
    'RegQueryValueA can read the value just set');
  assert.strictEqual(readA(aOut), 'ANSI default');

  const wSub = allocW('Software\\RegSetValueWTest');
  const wValue = allocW('Wide default');
  assert.strictEqual(e.test_reg_set_value_w(HKCU, wSub, 1, wValue, 26), 0,
    'RegSetValueW creates its subkey and stores the default value');
  const wOut = e.guest_alloc(128) >>> 0;
  const wCb = e.guest_alloc(4) >>> 0;
  e.guest_write32(wCb, 128);
  assert.strictEqual(e.test_reg_query_value(HKCU, wSub, wOut, wCb, 1), 0,
    'RegQueryValueW can read the value just set');
  assert.strictEqual(readW(wOut), 'Wide default');

  const rootValue = allocA('root default');
  assert.strictEqual(e.test_reg_set_value_a(HKCU, 0, 1, rootValue, 13), 0,
    'RegSetValueA accepts a null subkey on a predefined root');
  console.log('PASS registry create disposition and RegSetValueA/W default values');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

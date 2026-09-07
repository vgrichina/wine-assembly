#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_shell_import_alias")
      (param $dll i32) (param $hint_name i32) (param $canonical i32) (result i64)
    (i64.or
      (i64.extend_i32_u
        (call $import_hint_override_api_id
          (local.get $dll) (call $g2w (local.get $hint_name))))
      (i64.shl
        (i64.extend_i32_u (call $lookup_api_id (call $g2w (local.get $canonical))))
        (i64.const 32))))
`;

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat, fonts: 'none' });

  function writeString(value, hint = false) {
    const address = wat.guest_alloc(value.length + 1 + (hint ? 2 : 0)) >>> 0;
    const offset = hint ? 2 : 0;
    if (hint) {
      wat.guest_write8(address, 0);
      wat.guest_write8(address + 1, 0);
    }
    for (let i = 0; i < value.length; i++) {
      wat.guest_write8(address + offset + i, value.charCodeAt(i));
    }
    wat.guest_write8(address + offset + value.length, 0);
    return address;
  }

  const shell = writeString('SHELL32.DLL');
  const user = writeString('USER32.DLL');
  for (const [legacy, canonical] of [
    ['SHGetPathFromIDList', 'SHGetPathFromIDListA'],
    ['SHBrowseForFolder', 'SHBrowseForFolderA'],
  ]) {
    const hintName = writeString(legacy, true);
    const canonicalName = writeString(canonical);
    const result = BigInt.asUintN(64,
      wat.test_shell_import_alias(shell, hintName, canonicalName));
    const aliasId = Number(result & 0xffffffffn) >>> 0;
    const canonicalId = Number(result >> 32n) >>> 0;
    assert.notStrictEqual(aliasId, 0xffff, `${legacy} resolves`);
    assert.strictEqual(aliasId, canonicalId, `${legacy} reuses ${canonical}`);
    assert.strictEqual(
      Number(BigInt.asUintN(64,
        wat.test_shell_import_alias(user, hintName, canonicalName)) & 0xffffffffn) >>> 0,
      0xffffffff,
      `${legacy} alias is scoped to SHELL32`);
  }
  console.log('PASS Win9x unsuffixed shell imports resolve to ANSI handlers');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

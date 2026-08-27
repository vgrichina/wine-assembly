#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_d3d9_set_null_shaders") (param $pixel i32) (param $shader i32) (result i64)
    (global.set $esp (i32.const 0x00300000))
    (if (local.get $pixel)
      (then (call $handle_IDirect3DDevice9_SetPixelShader
        (i32.const 0x1234) (local.get $shader) (i32.const 0)
        (i32.const 0) (i32.const 0) (i32.const 0)))
      (else (call $handle_IDirect3DDevice9_SetVertexShader
        (i32.const 0x1234) (local.get $shader) (i32.const 0)
        (i32.const 0) (i32.const 0) (i32.const 0))))
    (i64.or (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat, fonts: 'none' });
  for (const pixel of [0, 1]) {
    let result = e.test_d3d9_set_null_shaders(pixel, 0);
    assert.strictEqual(Number(result & 0xffffffffn), 0,
      'NULL shader selects the fixed-function pipeline');
    assert.strictEqual(Number(result >> 32n), 0x0030000c,
      'shader setter pops this, shader, and return address');
    result = e.test_d3d9_set_null_shaders(pixel, 1);
    assert.strictEqual(Number(result & 0xffffffffn) >>> 0, 0x8876086c,
      'unsupported programmable shader handles are rejected');
  }
  console.log('PASS D3D9 NULL vertex/pixel shaders select fixed-function rendering');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_d3d9_create_shader") (param $pixel i32) (param $out i32) (result i64)
    (global.set $esp (i32.const 0x00300000))
    (call $gs32 (local.get $out) (i32.const 0x12345678))
    (if (local.get $pixel)
      (then (call $handle_IDirect3DDevice9_CreatePixelShader
        (i32.const 0x1000) (i32.const 0x2000) (local.get $out)
        (i32.const 0) (i32.const 0) (i32.const 0)))
      (else (call $handle_IDirect3DDevice9_CreateVertexShader
        (i32.const 0x1000) (i32.const 0x2000) (local.get $out)
        (i32.const 0) (i32.const 0) (i32.const 0))))
    (i64.or (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))
`;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const out = e.guest_alloc(4) >>> 0;
  for (const pixel of [0, 1]) {
    const result = e.test_d3d9_create_shader(pixel, out);
    assert.strictEqual(Number(result & 0xffffffffn) >>> 0, 0x8876086c,
      'unsupported programmable shader returns D3DERR_INVALIDCALL');
    assert.strictEqual(e.guest_read32(out) >>> 0, 0, 'failure clears output interface');
    assert.strictEqual(Number(result >> 32n), 0x00300010,
      'shader creation pops this, bytecode, output, and return address');
  }
  console.log('PASS unsupported D3D9 shader creation fails recoverably with NULL output');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

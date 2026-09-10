#!/usr/bin/env node
'use strict';
const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');
(async () => {
  const methods = ['IDirect3DDevice9_CreateVertexShader', 'IDirect3DDevice9_CreatePixelShader',
    'IDirect3DDevice9_SetVertexShader', 'IDirect3DDevice9_GetVertexShader',
    'IDirect3DShader9_GetFunction', 'IDirect3DShader9_QueryInterface',
    'IDirect3DShader9_AddRef', 'IDirect3DShader9_Release', 'IDirect3DShader9_GetDevice',
    'IDirect3DDevice9_Release'];
  const { exports: e } = await bootRenderHarness({ fonts: 'none', extraWat: `
    (func (export "new_device") (result i32)
      (local $device i32)
      (local.set $device (call $dx_create_com_obj (i32.const 20) (global.get $DX_VTBL_D3DDEV9)))
      (store.field DxObject misc1 (call $dx_from_this (local.get $device)) (call $d3d9_program_alloc))
      (local.get $device))
    (func (export "device_refs") (param $device i32) (result i32)
      (load.field DxObject refcount (call $dx_from_this (local.get $device))))
    ${methods.map(name => `(func (export "${name}") (param $a i32) (param $b i32) (param $c i32) (result i32)
      (global.set $esp (i32.const 0x00300000))
      (call $handle_${name} (local.get $a) (local.get $b) (local.get $c) (i32.const 0) (i32.const 0) (i32.const 0))
      (global.get $eax))`).join('\n')}
  ` });
  const device = e.new_device(), second = e.new_device(), code = 0x00408000, out = code+256,
    copy = code+512, size = code+1024, iid = code+1088;
  const words = [0xfffe0101, 1, 0xc00f0000, 0x90e40000, 0xffff];
  words.forEach((v,i) => e.guest_write32(code+i*4,v));
  assert.strictEqual(e.IDirect3DDevice9_CreateVertexShader(device, code, out), 0);
  assert.strictEqual(e.get_esp(), 0x00300010);
  const shader = e.guest_read32(out) >>> 0;
  assert.ok(shader); assert.strictEqual(e.device_refs(device), 2);
  assert.strictEqual(e.IDirect3DDevice9_CreatePixelShader(device, code, out) >>> 0, 0x8876086c);
  assert.strictEqual(e.guest_read32(out), 0);
  e.guest_write32(code, 0); // original caller storage may immediately be reused
  assert.strictEqual(e.IDirect3DShader9_GetFunction(shader, 0, size), 0);
  assert.strictEqual(e.guest_read32(size), words.length*4);
  e.guest_write32(copy-4, 0xdeadbeef); e.guest_write32(copy+words.length*4, 0xdeadbeef);
  assert.strictEqual(e.IDirect3DShader9_GetFunction(shader, copy, size), 0);
  words.forEach((v,i) => assert.strictEqual(e.guest_read32(copy+i*4) >>> 0,v));
  assert.strictEqual(e.guest_read32(copy-4) >>> 0,0xdeadbeef);
  assert.strictEqual(e.guest_read32(copy+words.length*4) >>> 0,0xdeadbeef);
  e.guest_write32(size,4); e.guest_write32(copy,0xdeadbeef);
  assert.strictEqual(e.IDirect3DShader9_GetFunction(shader,copy,size) >>> 0,0x8876086c);
  assert.strictEqual(e.guest_read32(copy) >>> 0,0xdeadbeef);
  [0xefc5557e,0x46136265,0x8543948a,0x36eb8978].forEach((v,i)=>e.guest_write32(iid+i*4,v));
  assert.strictEqual(e.IDirect3DShader9_QueryInterface(shader,iid,out),0);
  assert.strictEqual(e.guest_read32(out) >>> 0,shader);
  assert.strictEqual(e.IDirect3DShader9_Release(shader),1);
  e.guest_write32(iid,0);
  assert.strictEqual(e.IDirect3DShader9_QueryInterface(shader,iid,out) >>> 0,0x80004002);
  assert.strictEqual(e.guest_read32(out),0);
  assert.strictEqual(e.IDirect3DShader9_GetDevice(shader,out),0);
  assert.strictEqual(e.guest_read32(out) >>> 0,device);
  assert.strictEqual(e.IDirect3DDevice9_Release(device),2);
  assert.strictEqual(e.IDirect3DDevice9_SetVertexShader(second,shader) >>> 0,0x8876086c);
  assert.strictEqual(e.IDirect3DDevice9_SetVertexShader(device,shader),0);
  assert.strictEqual(e.IDirect3DShader9_Release(shader),0);
  assert.strictEqual(e.device_refs(device),1,'bound internal shader must not create a device ref cycle');
  assert.strictEqual(e.IDirect3DDevice9_GetVertexShader(device,out),0);
  assert.strictEqual(e.guest_read32(out) >>> 0,shader);
  assert.strictEqual(e.device_refs(device),2,'GetShader resurrects an external reference');
  assert.strictEqual(e.IDirect3DShader9_Release(shader),0);
  assert.strictEqual(e.IDirect3DDevice9_Release(device),0,'final device release drops bound shader');
  assert.strictEqual(e.IDirect3DDevice9_Release(second),0);
  console.log('PASS D3D9 shader COM bytecode ownership, QI, ABI, bindings and external/internal lifetime');
})().catch(error => { console.error(error); process.exitCode = 1; });

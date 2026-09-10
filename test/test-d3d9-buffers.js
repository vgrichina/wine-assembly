#!/usr/bin/env node
'use strict';
const assert=require('assert');
const {bootRenderHarness}=require('./render-helper');
(async()=>{
  const names=['Lock','Unlock','GetDesc','QueryInterface','Release','GetDevice'];
  const {exports:e}=await bootRenderHarness({fonts:'none',extraWat:`
    (func (export "device") (result i32) (local $d i32)
      (local.set $d (call $dx_create_com_obj (i32.const 20) (global.get $DX_VTBL_D3DDEV9)))
      (store.field DxObject misc1 (call $dx_from_this (local.get $d)) (call $d3d9_program_alloc))
      (local.get $d))
    (func (export "create") (param $d i32) (param $length i32) (param $usage i32)
      (param $format i32) (param $pool i32) (param $out i32) (param $kind i32) (result i32)
      (call $d3d9_buffer_create (local.get $d) (local.get $length) (local.get $usage)
        (local.get $format) (local.get $pool) (local.get $out) (local.get $kind)) (global.get $eax))
    (func (export "bind") (param $d i32) (param $b i32) (param $kind i32)
      (param $offset i32) (param $stride i32) (result i32)
      (call $d3d9_buffer_bind (local.get $d) (local.get $b) (local.get $kind)
        (local.get $offset) (local.get $stride)) (global.get $eax))
    ${names.map(name=>`(func (export "${name}") (param $a i32) (param $b i32) (param $c i32)
      (param $d i32) (param $f i32) (result i32)
      (global.set $esp (i32.const 0x074ff000))
      (call $handle_IDirect3DBuffer9_${name} (local.get $a) (local.get $b) (local.get $c)
        (local.get $d) (local.get $f) (i32.const 0)) (global.get $eax))`).join('\n')}
  `});
  e.init_dx_com_thunks();
  const d=e.device(),other=e.device(),out=0x00409000,desc=out+128,iid=out+256;
  const read=p=>e.guest_read32(p)>>>0,invalid=0x8876086c;
  assert.strictEqual(e.create(d,96,8,0x4102,1,out,6),0);const vb=read(out);
  assert.strictEqual(e.create(d,12,512,102,0,out,7),0);const ib=read(out);
  assert.ok(read(vb));assert.strictEqual(read(vb),read(ib),'shared resource vtable');
  e.guest_write32(desc+24,0xdeadbeef);
  assert.strictEqual(e.GetDesc(vb,desc),0);
  assert.deepStrictEqual(Array.from({length:6},(_,i)=>read(desc+i*4)),[100,6,8,1,96,0x4102]);
  assert.strictEqual(read(desc+24),0xdeadbeef);
  e.guest_write32(desc+20,0xdeadbeef);
  assert.strictEqual(e.GetDesc(ib,desc),0);
  assert.deepStrictEqual(Array.from({length:5},(_,i)=>read(desc+i*4)),[102,7,512,0,12]);
  assert.strictEqual(read(desc+20),0xdeadbeef,'INDEXBUFFER_DESC has no FVF field');
  assert.strictEqual(e.Lock(vb,24,0,out,0),0);assert.strictEqual(read(out),vb+88);
  e.guest_write32(read(out),0x12345678);
  assert.strictEqual(e.Lock(vb,0,4,out,0)>>>0,invalid,'nested lock');
  assert.strictEqual(e.Unlock(vb),0);assert.strictEqual(e.Unlock(vb)>>>0,invalid);
  assert.strictEqual(e.Lock(vb,95,2,out,0)>>>0,invalid,'end bounds');
  assert.strictEqual(e.Lock(vb,0,4,out,16)>>>0,invalid,'WRITEONLY cannot lock READONLY');
  assert.strictEqual(e.Lock(vb,0,4,out,0x2000)>>>0,invalid,'DISCARD requires dynamic');
  assert.strictEqual(e.Lock(ib,0,0,out,0x2000),0);assert.strictEqual(read(out),ib+64);
  assert.strictEqual(e.Unlock(ib),0);
  assert.strictEqual(e.create(d,12,512,101,1,out,7)>>>0,invalid,'managed/dynamic invalid');
  assert.strictEqual(read(out),0);
  assert.strictEqual(e.bind(other,vb,6,0,24)>>>0,invalid,'cross-device binding');
  assert.strictEqual(e.bind(d,ib,6,0,24)>>>0,invalid,'wrong buffer kind');
  assert.strictEqual(e.bind(d,vb,6,96,24)>>>0,invalid,'stream offset bounds');
  assert.strictEqual(e.bind(d,vb,6,24,24),0);
  assert.strictEqual(e.bind(d,ib,7,0,0),0);
  assert.strictEqual(e.Release(vb),0,'internal binding retains allocation, not external count');
  assert.strictEqual(read(vb+88),0x12345678);
  [0xb64bb1b5,0x4df6fd70,0xd01991bf,0xe35524a1].forEach((v,i)=>e.guest_write32(iid+i*4,v));
  assert.strictEqual(e.QueryInterface(vb,iid,out),0);assert.strictEqual(read(out),vb);
  assert.strictEqual(e.QueryInterface(ib,iid,out)>>>0,0x80004002);assert.strictEqual(read(out),0);
  assert.strictEqual(e.Release(vb),0);
  assert.strictEqual(e.bind(d,0,6,0,0),0);
  assert.strictEqual(e.Release(ib),0);assert.strictEqual(e.bind(d,0,7,0,0),0);
  console.log('PASS D3D9 vertex/index buffers: descriptors, lock bounds, QI and binding lifetime');
})().catch(error=>{console.error(error);process.exitCode=1;});

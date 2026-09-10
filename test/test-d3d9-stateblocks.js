#!/usr/bin/env node
'use strict';
const assert=require('assert');
const {bootRenderHarness}=require('./render-helper');
(async()=>{
  const methods=['BeginStateBlock','EndStateBlock','SetRenderState','GetRenderState','SetFVF','GetFVF','SetSamplerState','GetSamplerState','SetTexture','GetTexture','SetTransform','GetTransform','GetGammaRamp','SetGammaRamp','CreateVertexDeclaration','SetVertexDeclaration','GetVertexDeclaration'];
  const blockMethods=['Capture','Apply','Release','QueryInterface','GetDevice'];
  for(const stage of ['Vertex','Pixel'])for(const op of ['Create','Set','Get'])methods.push(op+stage+'Shader');
  for(const stage of ['Vertex','Pixel'])for(const op of ['Set','Get'])methods.push(op+stage+'ShaderConstantF');
  const {exports:e}=await bootRenderHarness({fonts:'none',extraWat:`
    (func (export "texture") (param $device i32) (param $out i32) (result i32)
      (call $d3d9_texture_create (local.get $device) (i32.const 2) (i32.const 2)
        (i32.const 1) (i32.const 0) (i32.const 21) (i32.const 1) (local.get $out))
      (global.get $eax))
    (func (export "releaseTexture") (param $texture i32) (result i32)
      (global.set $esp (i32.const 0x074ff000))
      (call $handle_IDirect3DShader9_Release (local.get $texture) (i32.const 0)
        (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)) (global.get $eax))
    (func (export "device") (param $out i32) (result i32)
      (local $d i32)
      (call $d3dim_create_device (i32.const 0) (i32.const 0) (local.get $out) (global.get $DX_VTBL_D3DDEV9))
      (local.set $d (call $gl32 (local.get $out)))
      (store.field DxObject type (call $dx_from_this (local.get $d)) (i32.const 20))
      (store.field DxObject misc1 (call $dx_from_this (local.get $d)) (call $d3d9_program_alloc))
      (local.get $d))
    ${[...methods.map(n=>['IDirect3DDevice9',n]),...blockMethods.map(n=>['IDirect3DStateBlock9',n])].map(([type,name])=>`
    (func (export "${name}") (param $a i32) (param $b i32) (param $c i32) (param $d i32) (result i32)
      (global.set $esp (i32.const 0x074ff000))
      (call $handle_${type}_${name} (local.get $a) (local.get $b) (local.get $c)
        (local.get $d) (i32.const 0) (i32.const 0)) (global.get $eax))`).join('\n')}
  `});
  e.init_dx_com_thunks();
  const out=0x00409000,d=e.device(out),invalid=0x8876086c;
  const read=p=>e.guest_read32(p)>>>0;
  const state=id=>{assert.strictEqual(e.GetRenderState(d,id,out),0);return read(out);};
  const mat=out+64,copy=mat+64;
  const ramp=out+256,rampCopy=ramp+1536;
  e.GetGammaRamp(d,0,ramp);
  for(let channel=0;channel<3;channel++)for(let i=0;i<256;i+=2)
    assert.strictEqual(read(ramp+channel*512+i*2),i|((i+1)<<16),'default WORD ramp 0..255');
  e.guest_write32(ramp,0x12345678);e.SetGammaRamp(d,0,0,ramp);
  e.guest_write32(ramp,0);e.GetGammaRamp(d,0,rampCopy);
  assert.strictEqual(read(rampCopy),0x12345678,'gamma data is copied, independent of caller memory');
  e.GetGammaRamp(d,1,ramp);assert.strictEqual(read(ramp),0,'invalid swap chain leaves output untouched');
  const matrix=()=>Array.from({length:16},(_,i)=>read(copy+i*4));
  const identity=Array.from({length:16},(_,i)=>i%5===0?0x3f800000:0);
  for(const type of [2,3,16,23,256,511]) {
    assert.strictEqual(e.GetTransform(d,type,copy),0);assert.deepStrictEqual(matrix(),identity);
  }
  assert.strictEqual(e.SetTransform(d,24,mat)>>>0,invalid);
  assert.strictEqual(e.SetTransform(d,16,0)>>>0,invalid);
  for(let i=0;i<16;i++)e.guest_write32(mat+i*4,0x3f000000+i);
  const recorded=Array.from({length:16},(_,i)=>read(mat+i*4));
  assert.strictEqual(e.texture(d,out),0);const t=read(out);
  assert.strictEqual(e.SetTexture(d,1,t),0);
  assert.strictEqual(e.SetRenderState(d,22,1),0);assert.strictEqual(e.SetRenderState(d,27,0),0);
  assert.strictEqual(e.EndStateBlock(d,out)>>>0,invalid);assert.strictEqual(read(out),0);
  assert.strictEqual(e.BeginStateBlock(d),0);
  assert.strictEqual(e.BeginStateBlock(d)>>>0,invalid,'nested recording rejected');
  assert.strictEqual(e.SetRenderState(d,22,2),0);assert.strictEqual(e.SetRenderState(d,22,3),0);
  assert.strictEqual(e.SetSamplerState(d,2,5,2),0);
  assert.strictEqual(e.SetTransform(d,23,mat),0);
  assert.strictEqual(e.GetTransform(d,23,copy),0);assert.deepStrictEqual(matrix(),identity);
  e.guest_write32(mat,0); // immutable recorded copy, not a retained guest pointer
  assert.strictEqual(e.SetTexture(d,0,t),0);assert.strictEqual(e.SetTexture(d,0,0),0);
  assert.strictEqual(e.SetTexture(d,0,t),0);
  assert.strictEqual(read(t+20),2,'one live and one recorded reference despite repeated writes');
  assert.strictEqual(e.GetTexture(d,0,out),0);assert.strictEqual(read(out),0,'recording leaves live binding unchanged');
  assert.strictEqual(e.releaseTexture(t),0,'recorded allocation survives external release');
  assert.strictEqual(e.GetSamplerState(d,2,5,out),0);assert.strictEqual(read(out),1,'sampler recording leaves live state unchanged');
  assert.strictEqual(state(22),1,'recording does not mutate live render state');
  assert.strictEqual(e.EndStateBlock(d,0)>>>0,invalid,'null output retains recording');
  assert.strictEqual(e.EndStateBlock(d,out),0);const b=read(out);assert.ok(read(b));
  assert.strictEqual(e.SetRenderState(d,27,1),0);
  assert.strictEqual(e.Apply(b),0);assert.strictEqual(state(22),3,'last recorded value wins');
  assert.strictEqual(e.GetSamplerState(d,2,5,out),0);assert.strictEqual(read(out),2);
  assert.strictEqual(e.GetTransform(d,23,copy),0);assert.deepStrictEqual(matrix(),recorded);
  assert.strictEqual(e.GetTransform(d,16,copy),0);assert.deepStrictEqual(matrix(),identity,'transform slots are independent');
  assert.strictEqual(e.GetTexture(d,0,out),0);assert.strictEqual(read(out),t);
  assert.strictEqual(e.releaseTexture(t),0);
  assert.strictEqual(read(t+20),3,'Apply adds live reference and preserves unrecorded stage');
  assert.strictEqual(state(27),1,'unrecorded state preserved');
  assert.strictEqual(e.SetRenderState(d,22,2),0);assert.strictEqual(e.SetSamplerState(d,2,5,1),0);
  assert.strictEqual(e.SetTexture(d,0,0),0);
  assert.strictEqual(e.SetTransform(d,23,mat),0);
  assert.strictEqual(e.Capture(b),0);assert.strictEqual(read(t+20),1,'Capture drops old recorded texture reference');
  assert.strictEqual(e.SetTexture(d,0,t),0);
  e.guest_write32(mat,0x40000000);assert.strictEqual(e.SetTransform(d,23,mat),0);
  assert.strictEqual(e.SetSamplerState(d,2,5,2),0);
  assert.strictEqual(e.SetRenderState(d,22,1),0);assert.strictEqual(e.SetRenderState(d,27,0),0);
  assert.strictEqual(e.Apply(b),0);assert.strictEqual(state(22),2);assert.strictEqual(state(27),0);
  assert.strictEqual(e.GetSamplerState(d,2,5,out),0);assert.strictEqual(read(out),1,'Capture refreshes selected sampler values');
  assert.strictEqual(e.GetTransform(d,23,copy),0);assert.strictEqual(read(copy),0,'Capture refreshes selected transform');
  assert.strictEqual(e.GetTexture(d,0,out),0);assert.strictEqual(read(out),0,'Apply restores captured null binding');
  assert.strictEqual(e.SetTexture(d,0,t),0);assert.strictEqual(e.Capture(b),0);
  assert.strictEqual(read(t+20),3);
  assert.strictEqual(e.Release(b),0);
  assert.strictEqual(read(t+20),2,'block destruction releases captured texture');
  assert.strictEqual(e.SetTexture(d,0,0),0);assert.strictEqual(e.SetTexture(d,1,0),0);
  const elements=out+4096;
  e.guest_write32(elements,0);e.guest_write32(elements+4,3); // FLOAT4 POSITION0
  e.guest_write32(elements+8,255);e.guest_write32(elements+12,17); // END
  assert.strictEqual(e.CreateVertexDeclaration(d,elements,out),0);const decl=read(out);
  assert.strictEqual(e.SetFVF(d,0x4002),0);
  assert.strictEqual(e.BeginStateBlock(d),0);
  assert.strictEqual(e.SetVertexDeclaration(d,decl),0);
  assert.strictEqual(e.SetVertexDeclaration(d,0),0);assert.strictEqual(e.SetVertexDeclaration(d,decl),0);
  assert.strictEqual(read(decl+20),1,'recorded declaration keeps only one reference');
  assert.strictEqual(e.GetVertexDeclaration(d,out),0);assert.strictEqual(read(out),0);
  assert.strictEqual(e.GetFVF(d,out),0);assert.strictEqual(read(out),0x4002,'recording does not clear live FVF');
  assert.strictEqual(e.EndStateBlock(d,out),0);const db=read(out);
  assert.strictEqual(e.releaseTexture(decl),0); // common resource Release helper
  assert.strictEqual(e.Apply(db),0);assert.strictEqual(read(decl+20),2);
  assert.strictEqual(e.GetFVF(d,out),0);assert.strictEqual(read(out),0);
  assert.strictEqual(e.SetFVF(d,0x4002),0);assert.strictEqual(e.Capture(db),0);
  assert.strictEqual(e.SetFVF(d,0x102),0);assert.strictEqual(e.Apply(db),0);
  assert.strictEqual(e.GetFVF(d,out),0);assert.strictEqual(read(out),0x4002,'Capture restores FVF and declaration as one selection');
  assert.strictEqual(e.Release(db),0);
  for(const stage of ['Vertex','Pixel']) {
    const set=e['Set'+stage+'ShaderConstantF'],get=e['Get'+stage+'ShaderConstantF'];
    for(let i=0;i<12;i++)e.guest_write32(elements+i*4,100+i);
    assert.strictEqual(set(d,0,elements,3),0);
    assert.strictEqual(e.BeginStateBlock(d),0);
    for(let i=0;i<8;i++)e.guest_write32(elements+i*4,200+i);
    assert.strictEqual(set(d,1,elements,2),0);
    assert.strictEqual(set(d,2,elements,1),0);
    assert.strictEqual(get(d,1,copy,1),0);assert.strictEqual(read(copy),104);
    assert.strictEqual(e.EndStateBlock(d,out),0);const cb=read(out);
    assert.strictEqual(e.Apply(cb),0);
    assert.strictEqual(get(d,0,copy,3),0);
    assert.strictEqual(read(copy),100,'unrecorded constant register preserved');
    assert.strictEqual(read(copy+16),200);assert.strictEqual(read(copy+32),200,'overlapping final write wins');
    e.guest_write32(elements,300);assert.strictEqual(set(d,1,elements,1),0);
    assert.strictEqual(e.Capture(cb),0);
    e.guest_write32(elements,400);assert.strictEqual(set(d,1,elements,1),0);
    assert.strictEqual(e.Apply(cb),0);assert.strictEqual(get(d,1,copy,1),0);assert.strictEqual(read(copy),300);
    assert.strictEqual(e.Release(cb),0);
    const words=stage==='Vertex'?[0xfffe0101,1,0xc00f0000,0x90e40000,0xffff]:[0xffff0101,1,0x800f0000,0x90e40000,0xffff];
    words.forEach((v,i)=>e.guest_write32(elements+i*4,v));
    assert.strictEqual(e['Create'+stage+'Shader'](d,elements,out),0);const shader=read(out);
    assert.strictEqual(e.BeginStateBlock(d),0);
    assert.strictEqual(e['Set'+stage+'Shader'](d,shader),0);
    assert.strictEqual(e['Set'+stage+'Shader'](d,shader),0);assert.strictEqual(read(shader+20),1);
    assert.strictEqual(e['Get'+stage+'Shader'](d,out),0);assert.strictEqual(read(out),0);
    assert.strictEqual(e.EndStateBlock(d,out),0);const sb=read(out);
    assert.strictEqual(e.releaseTexture(shader),0);
    assert.strictEqual(e.Apply(sb),0);assert.strictEqual(read(shader+20),2);
    assert.strictEqual(e['Get'+stage+'Shader'](d,out),0);assert.strictEqual(read(out),shader);
    assert.strictEqual(e.releaseTexture(shader),0);
    assert.strictEqual(e['Set'+stage+'Shader'](d,0),0);
    assert.strictEqual(e.Capture(sb),0);assert.strictEqual(e.Apply(sb),0);
    assert.strictEqual(e['Get'+stage+'Shader'](d,out),0);assert.strictEqual(read(out),0);
    assert.strictEqual(e.Release(sb),0);
  }
  assert.strictEqual(e.BeginStateBlock(d),0);
  assert.throws(()=>e.SetFVF(d,0x4002),WebAssembly.RuntimeError,
    'uncaptured state categories fail explicitly rather than changing live device state');
  assert.strictEqual(e.EndStateBlock(d,out),0);assert.strictEqual(e.Release(read(out)),0);
  console.log('PASS D3D9 selective state recording, last-write wins, Capture/Apply and lifetime');
})().catch(error=>{console.error(error);process.exitCode=1;});

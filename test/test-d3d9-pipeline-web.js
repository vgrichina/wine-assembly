#!/usr/bin/env node
'use strict';
const assert = require('assert');
const http = require('http');
const path = require('path');
const puppeteer = require('puppeteer');
const { compileSrcWasm } = require('./compile-src');
(async () => {
  const methods = ['CreateVertexShader','CreatePixelShader','SetVertexShader','SetPixelShader',
    'SetVertexShaderConstantF','SetPixelShaderConstantF','SetFVF','SetRenderState','SetTexture',
    'CreateVertexDeclaration','SetVertexDeclaration','GetVertexDeclaration','GetFVF','GetDeviceCaps',
    'SetStreamSource','SetIndices','DrawPrimitive','DrawPrimitiveUP','Present'];
  const extra = `
    (func (export "buffer") (param $d i32) (param $out i32) (param $index i32) (result i32)
      (global.set $esp (i32.const 0x00300000))
      (call $gs32 (i32.add (global.get $esp) (i32.const 24)) (local.get $out))
      (call $gs32 (i32.add (global.get $esp) (i32.const 28)) (i32.const 0))
      (if (local.get $index) (then
        (call $handle_IDirect3DDevice9_CreateIndexBuffer (local.get $d) (i32.const 8) (i32.const 0)
          (i32.const 101) (i32.const 1) (i32.const 0)))
      (else
        (call $handle_IDirect3DDevice9_CreateVertexBuffer (local.get $d) (i32.const 96) (i32.const 0)
          (i32.const 0x4102) (i32.const 1) (i32.const 0)))) (global.get $eax))
    (func (export "buffer_lock") (param $b i32) (param $out i32) (result i32)
      (call $handle_IDirect3DBuffer9_Lock (local.get $b) (i32.const 0) (i32.const 0)
        (local.get $out) (i32.const 0) (i32.const 0)) (global.get $eax))
    (func (export "buffer_unlock") (param $b i32) (result i32)
      (call $handle_IDirect3DBuffer9_Unlock (local.get $b) (i32.const 0) (i32.const 0)
        (i32.const 0) (i32.const 0) (i32.const 0)) (global.get $eax))
    (func (export "buffer_draw") (param $d i32) (param $base i32) (param $min i32)
      (param $num i32) (param $start i32) (result i32)
      (global.set $esp (i32.const 0x00300000))
      (call $gs32 (i32.add (global.get $esp) (i32.const 24)) (local.get $start))
      (call $gs32 (i32.add (global.get $esp) (i32.const 28)) (i32.const 1))
      (call $handle_IDirect3DDevice9_DrawIndexedPrimitive (local.get $d) (i32.const 4)
        (local.get $base) (local.get $min) (local.get $num) (i32.const 0)) (global.get $eax))
    (func (export "indexed") (param $d i32) (param $v i32) (param $indices i32)
      (param $format i32) (param $min i32) (param $num i32) (result i32)
      (global.set $esp (i32.const 0x00300000))
      (call $gs32 (i32.add (global.get $esp) (i32.const 24)) (local.get $indices))
      (call $gs32 (i32.add (global.get $esp) (i32.const 28)) (local.get $format))
      (call $gs32 (i32.add (global.get $esp) (i32.const 32)) (local.get $v))
      (call $gs32 (i32.add (global.get $esp) (i32.const 36)) (i32.const 24))
      (call $handle_IDirect3DDevice9_DrawIndexedPrimitiveUP (local.get $d) (i32.const 4)
        (local.get $min) (local.get $num) (i32.const 1) (i32.const 0))
      (global.get $eax))
    (func (export "create_texture") (param $d i32) (param $out i32) (result i32)
      (global.set $esp (i32.const 0x00300000))
      (call $gs32 (i32.add (global.get $esp) (i32.const 24)) (i32.const 21))
      (call $gs32 (i32.add (global.get $esp) (i32.const 28)) (i32.const 1))
      (call $gs32 (i32.add (global.get $esp) (i32.const 32)) (local.get $out))
      (call $gs32 (i32.add (global.get $esp) (i32.const 36)) (i32.const 0))
      (call $handle_IDirect3DDevice9_CreateTexture (local.get $d) (i32.const 1) (i32.const 1)
        (i32.const 1) (i32.const 0) (i32.const 0)) (global.get $eax))
    (func (export "lock_texture") (param $t i32) (param $out i32) (result i32)
      (call $handle_IDirect3DTexture9_LockRect (local.get $t) (i32.const 0) (local.get $out)
        (i32.const 0) (i32.const 0) (i32.const 0)) (global.get $eax))
    (func (export "unlock_texture") (param $t i32) (result i32)
      (call $handle_IDirect3DTexture9_UnlockRect (local.get $t) (i32.const 0) (i32.const 0)
        (i32.const 0) (i32.const 0) (i32.const 0)) (global.get $eax))
    (func (export "create_device") (param $pp i32) (param $out i32) (result i32)
      (global.set $esp (i32.const 0x00300000))
      (call $gs32 (i32.add (global.get $esp) (i32.const 24)) (local.get $pp))
      (call $gs32 (i32.add (global.get $esp) (i32.const 28)) (local.get $out))
      (call $handle_IDirect3D9_CreateDevice (i32.const 0) (i32.const 0) (i32.const 1)
        (i32.const 1) (i32.const 0) (i32.const 0))
      (global.get $eax))
    (func (export "target_bits") (param $device i32) (result i32)
      (load.field DxObject misc1 (call $d3ddev_rt_entry (local.get $device))))
    ${methods.map(name => `(func (export "${name}") (param $a i32) (param $b i32) (param $c i32)
      (param $d i32) (param $f i32) (result i32)
      (global.set $esp (i32.const 0x00300000))
      (call $handle_IDirect3DDevice9_${name} (local.get $a) (local.get $b) (local.get $c)
        (local.get $d) (local.get $f) (i32.const 0))
      (global.get $eax))`).join('\n')}`;
  const bytes = compileSrcWasm((file, source) => file === '13-exports.wat' ? source+'\n'+extra : source);
  // This endpoint serves only an empty isolated test document, not repo files.
  const server = http.createServer((req,res) => {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp' }); res.end('<!doctype html><title>D3D9 pipeline test</title>');
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true,
      executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      args: ['--no-first-run','--no-default-browser-check'] });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    for (const file of ['gpu-backend.js','d3d9-shader.js','d3d9-backend.js','d3d9-host.js'])
      await page.addScriptTag({ path: path.join(__dirname,'../lib',file) });
    const result = await page.evaluate(async base64 => {
      const bytes = Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
      const module = await WebAssembly.compile(bytes);
      const memory = new WebAssembly.Memory({initial:8192,maximum:8192,shared:true});
      const host = {memory};
      for(const i of WebAssembly.Module.imports(module)) if(i.kind==='function') host[i.name]=()=>0;
      const renderer = {windows:{1:{w:16,h:16,clientRect:{w:16,h:16}}}};
      let e, presents=0;
      const bridge = new D3D9Host.Bridge({getMemory:()=>memory.buffer,
        enableProgrammable:true,guestToWasm:p=>e.guest_to_wasm(p)>>>0,renderer:()=>renderer,onPresent:()=>presents++});
      host.gpu_gl_call=(op,ptr,aux)=>op===0x30000 ? D3D9Shader.validateMemory(memory.buffer,ptr,aux)
        : op>=0x30001&&op<=0x30005 ? bridge.call(op,ptr,aux) : 0;
      host.get_window_client_size=()=>16|(16<<16);
      e=(await WebAssembly.instantiate(module,{host})).exports;
      e.init_dx_com_thunks();
      const write=(p,words)=>words.forEach((v,i)=>e.guest_write32(p+i*4,v));
      const pp=0x00408000,out=pp+256,vsCode=pp+512,psCode=pp+1024,vptr=pp+2048,cptr=pp+4096;
      write(pp,[16,16,22,1,0,0,1,1,1,0,0,0,0,0]);
      const calls=[]; calls.push(e.create_device(pp,out)); const device=e.guest_read32(out)>>>0;
      calls.push(e.GetDeviceCaps(device,cptr));
      const caps=[152,156,188,192,196,200,204].map(offset=>e.guest_read32(cptr+offset)>>>0);
      write(vsCode,[0xfffe0101,1,0xc00f0000,0x90e40000,1,0xd00f0000,0xa0e40000,0xffff]);
      write(psCode,[0xffff0101,5,0x800f0000,0x90e40000,0xa0e40000,0xffff]);
      calls.push(e.CreateVertexShader(device,vsCode,out)); const vs=e.guest_read32(out)>>>0;
      calls.push(e.CreatePixelShader(device,psCode,out)); const ps=e.guest_read32(out)>>>0;
      calls.push(e.SetVertexShader(device,vs),e.SetPixelShader(device,ps),e.SetFVF(device,0x4002));
      const floats=(p,values)=>write(p,Array.from(new Uint32Array(new Float32Array(values).buffer)));
      floats(vptr,[-1,-1,0.25,1,3,-1,0.25,1,-1,3,0.25,1]);
      floats(cptr,[0.8,0.4,0.2,1]); calls.push(e.SetVertexShaderConstantF(device,0,cptr,1));
      floats(cptr,[0.5,0.5,0.5,1]); calls.push(e.SetPixelShaderConstantF(device,0,cptr,1));
      calls.push(e.SetRenderState(device,22,1));
      calls.push(e.DrawPrimitiveUP(device,4,1,vptr,16));
      const beforePresent=!!renderer.windows[1]._gpuFrameLayer;
      calls.push(e.Present(device));
      const ptr=e.target_bits(device)>>>0;
      const pixel=Array.from(new Uint8Array(memory.buffer,ptr+(8*16+8)*4,4));
      write(vsCode,[0xfffe0101,31,0x80000000,0x900f0000,31,0x80000005,0x900f0001,
        1,0xc00f0000,0x90e40000,1,0xe00f0000,0x90e40001,1,0xd00f0000,0xa0e40000,0xffff]);
      write(psCode,[0xffff0101,66,0xb00f0000,5,0x800f0000,0xb0e40000,0x90e40000,0xffff]);
      calls.push(e.CreateVertexShader(device,vsCode,out));const texturedVS=e.guest_read32(out)>>>0;
      calls.push(e.CreatePixelShader(device,psCode,out));const texturedPS=e.guest_read32(out)>>>0;
      calls.push(e.SetVertexShader(device,texturedVS),e.SetPixelShader(device,texturedPS),e.SetFVF(device,0x4102));
      floats(vptr,[-1,-1,0.25,1,0.5,0.5,3,-1,0.25,1,0.5,0.5,-1,3,0.25,1,0.5,0.5]);
      floats(cptr,[0.5,0.25,1,1]);calls.push(e.SetVertexShaderConstantF(device,0,cptr,1));
      calls.push(e.create_texture(device,out));const texture=e.guest_read32(out)>>>0;
      calls.push(e.lock_texture(texture,out));const bits=e.guest_read32(out+4)>>>0;
      e.guest_write32(bits,0xffc8a050);
      calls.push(e.unlock_texture(texture),e.SetTexture(device,0,texture),e.DrawPrimitiveUP(device,4,1,vptr,24),e.Present(device));
      const texturedPixel=Array.from(new Uint8Array(memory.buffer,ptr+(8*16+8)*4,4));
      const iptr=cptr+256;
      // Prefix an unused vertex; index rebasing must preserve the three real UVs.
      floats(vptr,[0,0,0,0,0,0,-1,-1,0.25,1,0.5,0.5,3,-1,0.25,1,0.5,0.5,-1,3,0.25,1,0.5,0.5]);
      write(iptr,[0x00020001,3]);
      floats(cptr,[1,0.5,0.25,1]);calls.push(e.SetVertexShaderConstantF(device,0,cptr,1));
      calls.push(e.indexed(device,vptr,iptr,101,1,3),e.Present(device));
      const indexedPixel=Array.from(new Uint8Array(memory.buffer,ptr+(8*16+8)*4,4));
      // A real >65535 index checks that INDEX32 is not silently narrowed.
      const high=65536,highVertices=0x00800000;
      floats(highVertices+high*24,[-1,-1,0.25,1,0.5,0.5,3,-1,0.25,1,0.5,0.5,-1,3,0.25,1,0.5,0.5]);
      write(iptr,[high,high+1,high+2]);
      floats(cptr,[0.25,1,0.5,1]);calls.push(e.SetVertexShaderConstantF(device,0,cptr,1));
      calls.push(e.indexed(device,highVertices,iptr,102,high,3),e.Present(device));
      const indexed32Pixel=Array.from(new Uint8Array(memory.buffer,ptr+(8*16+8)*4,4));
      const invalid=e.indexed(device,highVertices,iptr,102,high+1,2)>>>0;
      const invalidMessage=bridge.lastError&&bridge.lastError.message;
      calls.push(e.buffer(device,out,0));const vb=e.guest_read32(out)>>>0;
      calls.push(e.buffer(device,out,1));const ib=e.guest_read32(out)>>>0;
      calls.push(e.buffer_lock(vb,out));const vbBits=e.guest_read32(out)>>>0;
      floats(vbBits,[0,0,0,0,0,0,-1,-1,0.25,1,0.5,0.5,3,-1,0.25,1,0.5,0.5,-1,3,0.25,1,0.5,0.5]);
      calls.push(e.buffer_unlock(vb),e.buffer_lock(ib,out));const ibBits=e.guest_read32(out)>>>0;
      write(ibBits,[0x00029999,0x00040003]); // unused prefix; indices 2,3,4
      calls.push(e.buffer_unlock(ib),e.SetStreamSource(device,0,vb,24,24),e.SetIndices(device,ib));
      floats(cptr,[1,1,1,1]);calls.push(e.SetVertexShaderConstantF(device,0,cptr,1));
      // Offset=24, base=-2 and min=2 jointly address the three real vertices.
      calls.push(e.buffer_draw(device,-2,2,3,1),e.Present(device));
      const bufferPixel=Array.from(new Uint8Array(memory.buffer,ptr+(8*16+8)*4,4));
      const badBufferRange=e.buffer_draw(device,-3,2,3,1)>>>0;
      const badIndexRange=e.buffer_draw(device,-2,2,3,2)>>>0;
      calls.push(e.buffer_lock(vb,out));const lockedDraw=e.buffer_draw(device,-2,2,3,1)>>>0;
      calls.push(e.buffer_unlock(vb));
      calls.push(e.SetStreamSource(device,0,vb,0,24),e.DrawPrimitive(device,4,1,1),e.Present(device));
      // Declare UV before position: the VS DCL semantics, not array order,
      // must bind the correct registers. Declaration owns an immutable copy.
      const declPtr=cptr+512;
      write(declPtr,[16<<16,0x00050001,0,3,255,17]);
      calls.push(e.CreateVertexDeclaration(device,declPtr,out));const declaration=e.guest_read32(out)>>>0;
      write(declPtr,[0,0,0,0,0,0]);
      calls.push(e.SetVertexDeclaration(device,declaration),e.GetVertexDeclaration(device,out));
      const declarationIdentity=(e.guest_read32(out)>>>0)===declaration;
      calls.push(e.GetFVF(device,out));const declarationFVF=e.guest_read32(out);
      floats(cptr,[0.5,0.5,0.5,1]);calls.push(e.SetVertexShaderConstantF(device,0,cptr,1));
      calls.push(e.DrawPrimitive(device,4,1,1),e.Present(device));
      const declarationPixel=Array.from(new Uint8Array(memory.buffer,ptr+(8*16+8)*4,4));
      const layer=renderer.windows[1]._gpuFrameLayer;
      const result={calls,caps,pixel,texturedPixel,indexedPixel,indexed32Pixel,bufferPixel,invalid,
        declarationPixel,declarationIdentity,declarationFVF,badBufferRange,badIndexRange,lockedDraw,
        beforePresent,presents,hasLayer:!!layer,lastError:invalidMessage};
      bridge.call(0x30004,0,device);
      return result;
    },bytes.toString('base64'));
    assert.deepStrictEqual(result.calls,result.calls.map(()=>0),JSON.stringify(result));
    assert.deepStrictEqual(result.caps,[4,0,1,255,0xfffe0101,96,0xffff0101]);
    assert.strictEqual(result.beforePresent,false,'draw must not publish incomplete frame');
    assert.strictEqual(result.presents,7); assert.ok(result.hasLayer);
    [26,51,102,255].forEach((v,i)=>assert.ok(Math.abs(result.pixel[i]-v)<=1,JSON.stringify(result)));
    [80,40,100,255].forEach((v,i)=>assert.ok(Math.abs(result.texturedPixel[i]-v)<=1,JSON.stringify(result)));
    [20,80,200,255].forEach((v,i)=>assert.ok(Math.abs(result.indexedPixel[i]-v)<=1,JSON.stringify(result)));
    [40,160,50,255].forEach((v,i)=>assert.ok(Math.abs(result.indexed32Pixel[i]-v)<=1,JSON.stringify(result)));
    [80,160,200,255].forEach((v,i)=>assert.ok(Math.abs(result.bufferPixel[i]-v)<=1,JSON.stringify(result)));
    [40,80,100,255].forEach((v,i)=>assert.ok(Math.abs(result.declarationPixel[i]-v)<=1,JSON.stringify(result)));
    assert.strictEqual(result.declarationFVF,0);assert.ok(result.declarationIdentity);
    assert.strictEqual(result.invalid,0x8876086c);
    for(const key of ['badBufferRange','badIndexRange','lockedDraw'])assert.strictEqual(result[key],0x8876086c,key);
    assert.match(result.lastError,/index outside declared vertex range/);
    console.log('PASS full WAT D3D9 shaders/textures + UP/buffer INDEX16/32 draw/present -> canonical BGRA pixels');
  } finally { if(browser) await browser.close(); await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);process.exitCode=1;});

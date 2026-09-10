#!/usr/bin/env node
'use strict';
const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');
(async () => {
  const {exports:e}=await bootRenderHarness({fonts:'none',extraWat:`
    (func (export "new_device") (result i32)
      (local $device i32)
      (local.set $device (call $dx_create_com_obj (i32.const 20) (global.get $DX_VTBL_D3DDEV9)))
      (store.field DxObject misc1 (call $dx_from_this (local.get $device)) (call $d3d9_program_alloc))
      (local.get $device))
    (func (export "texture") (param $d i32) (param $w i32) (param $h i32) (param $levels i32) (param $out i32) (result i32)
      (call $d3d9_texture_create (local.get $d) (local.get $w) (local.get $h) (local.get $levels)
        (i32.const 0) (i32.const 21) (i32.const 1) (local.get $out)) (global.get $eax))
    (func (export "lock") (param $t i32) (param $level i32) (param $out i32) (param $rect i32) (result i32)
      (call $d3d9_texture_lock (local.get $t) (local.get $level) (local.get $out) (local.get $rect) (i32.const 0)) (global.get $eax))
    (func (export "unlock") (param $t i32) (param $level i32) (result i32)
      (call $handle_IDirect3DTexture9_UnlockRect (local.get $t) (local.get $level) (i32.const 0)
        (i32.const 0) (i32.const 0) (i32.const 0)) (global.get $eax))
    (func (export "desc") (param $t i32) (param $level i32) (param $out i32) (result i32)
      (call $d3d9_texture_desc (local.get $t) (local.get $level) (local.get $out)) (global.get $eax))
    (func (export "release_texture") (param $t i32) (result i32)
      (call $handle_IDirect3DTexture9_Release (local.get $t) (i32.const 0) (i32.const 0)
        (i32.const 0) (i32.const 0) (i32.const 0)) (global.get $eax))
    (func (export "surface") (param $t i32) (param $level i32) (param $out i32) (result i32)
      (call $d3d9_texture_surface (local.get $t) (local.get $level) (local.get $out)) (global.get $eax))
    (func (export "release_surface") (param $s i32) (result i32)
      (call $d3d9_texture_surface_release (local.get $s)))
    (func (export "surface_lock") (param $s i32) (param $out i32) (result i32)
      (call $handle_IDirect3DSurface9_LockRect (local.get $s) (local.get $out) (i32.const 0)
        (i32.const 0) (i32.const 0) (i32.const 0)) (global.get $eax))
    (func (export "surface_unlock") (param $s i32) (result i32)
      (call $d3d9_texture_surface_unlock (local.get $s)) (global.get $eax))
  `});
  e.init_dx_com_thunks();
  const d=e.new_device(),out=0x00409000,locked=out+128,desc=out+256,rect=out+512;
  assert.strictEqual(e.texture(d,8,4,0,out),0);
  const t=e.guest_read32(out)>>>0;
  assert.ok(e.guest_read32(t)); assert.strictEqual(e.guest_read32(t+32),4);
  let original;
  for(const [level,[w,h]] of [[8,4],[4,2],[2,1],[1,1]].entries()) {
    e.guest_write32(desc-4,0xdeadbeef);e.guest_write32(desc+32,0xdeadbeef);
    assert.strictEqual(e.desc(t,level,desc),0);
    assert.strictEqual(e.guest_read32(desc),21);assert.strictEqual(e.guest_read32(desc+4),1);
    assert.strictEqual(e.guest_read32(desc+24),w);assert.strictEqual(e.guest_read32(desc+28),h);
    assert.strictEqual(e.guest_read32(desc-4)>>>0,0xdeadbeef);assert.strictEqual(e.guest_read32(desc+32)>>>0,0xdeadbeef);
    assert.strictEqual(e.lock(t,level,locked,0),0);assert.strictEqual(e.guest_read32(locked),w*4);
    const bits=e.guest_read32(locked+4)>>>0;if(!level)original=bits;
    e.guest_write32(bits,0xff123456+level);
    assert.strictEqual(e.lock(t,level,locked,0)>>>0,0x8876086c,'nested lock fails');
    assert.strictEqual(e.unlock(t,level),0);assert.strictEqual(e.unlock(t,level)>>>0,0x8876086c);
  }
  [2,1,5,3].forEach((v,i)=>e.guest_write32(rect+i*4,v));
  assert.strictEqual(e.lock(t,0,locked,rect),0);
  assert.strictEqual(e.guest_read32(locked),32);
  assert.strictEqual(e.guest_read32(locked+4)>>>0,original+40);
  assert.strictEqual(e.unlock(t,0),0);
  e.guest_write32(rect,0xffffffff);assert.strictEqual(e.lock(t,0,locked,rect)>>>0,0x8876086c);
  assert.strictEqual(e.lock(t,4,locked,0)>>>0,0x8876086c);
  assert.strictEqual(e.texture(d,0,4,0,out)>>>0,0x8876086c);
  assert.strictEqual(e.texture(d,2049,4,0,out)>>>0,0x8876086c);
  assert.strictEqual(e.texture(d,8,4,5,out)>>>0,0x8876086c);
  assert.strictEqual(e.surface(t,0,out),0);const surface=e.guest_read32(out)>>>0;
  assert.strictEqual(e.surface(t,0,out),0);assert.strictEqual(e.guest_read32(out)>>>0,surface);
  assert.strictEqual(e.release_surface(surface),1);
  assert.strictEqual(e.surface_lock(surface,locked),0);
  assert.strictEqual(e.guest_read32(locked+4)>>>0,original,'surface aliases texture pixels');
  assert.strictEqual(e.lock(t,0,locked,0)>>>0,0x8876086c,'surface shares parent lock state');
  assert.strictEqual(e.surface_unlock(surface),0);
  assert.strictEqual(e.release_texture(t),1,'surface retains parent texture');
  assert.strictEqual(e.surface_lock(surface,locked),0,'parent survives original texture release');
  assert.strictEqual(e.surface_unlock(surface),0);
  assert.strictEqual(e.release_surface(surface),0);
  console.log('PASS D3D9 mip allocation, lock bounds, surface identity/aliasing and parent lifetime');
})().catch(error=>{console.error(error);process.exitCode=1;});

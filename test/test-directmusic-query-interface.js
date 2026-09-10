#!/usr/bin/env node
'use strict';

const { createHostImports } = require('../lib/host-imports');
const { compileSrcWasm } = require('./compile-src');

const extraWat = String.raw`
  (func (export "test_create_directmusic") (result i32)
    (call $dx_create_com_obj
      (i32.const 35) (call $init_com_vtable (i32.const 3076) (i32.const 3))))

  (func (export "test_create_amstream") (result i32)
    (call $dx_create_com_obj
      (i32.const 36)
      (call $init_com_vtable
        (global.get $API_ID_IAMMultiMediaStream_BASE) (i32.const 19))))

  (func (export "test_create_gamma_control") (result i32)
    (call $dx_create_com_obj
      (i32.const 2) (call $init_com_vtable (i32.const 3079) (i32.const 5))))

  (func (export "test_directmusic_refcount") (param $obj i32) (result i32)
    (load.field DxObject refcount (call $dx_from_this (local.get $obj))))

  (func (export "test_call_IDirectMusic_QueryInterface")
        (param $obj i32) (param $iid i32) (param $out i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_IDirectMusic_QueryInterface
      (local.get $obj) (local.get $iid) (local.get $out)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))

  (func (export "test_call_IAMMultiMediaStream_QueryInterface")
        (param $obj i32) (param $iid i32) (param $out i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_IAMMultiMediaStream_QueryInterface
      (local.get $obj) (local.get $iid) (local.get $out)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))

  (func (export "test_call_IDirectDrawGammaControl_QueryInterface")
        (param $obj i32) (param $iid i32) (param $out i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_IDirectDrawGammaControl_QueryInterface
      (local.get $obj) (local.get $iid) (local.get $out)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))

  (func (export "test_call_IDirectMusic_Release") (param $obj i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_IDirectMusic_Release
      (local.get $obj) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
`;

async function main() {
  const wasm = compileSrcWasm((file, source) =>
    file === '13-exports.wat' ? `${source}\n${extraWat}\n` : source);
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const imports = createHostImports({ getMemory: () => memory.buffer, renderer: null, resourceJson: {} });
  imports.host.memory = memory;
  Object.assign(imports.host, {
    create_thread: () => 0, exit_thread: () => 0, terminate_thread: () => 0,
    create_event: () => 0,
    set_event: () => 0, reset_event: () => 0, wait_single: () => 0,
    wait_multiple: () => 0, com_create_instance: () => 0x80004002,
  });
  const { instance } = await WebAssembly.instantiate(wasm, imports);
  const e = instance.exports;
  e.init_dx_com_thunks();
  const dv = new DataView(memory.buffer);
  const wa = gp => gp - e.get_image_base() + e.get_guest_base();
  const alloc = n => e.guest_alloc(n) >>> 0;
  let pass = 0;
  let fail = 0;
  const check = (name, ok) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    ok ? pass++ : fail++;
  };
  const writeGuid = words => {
    const value = alloc(16);
    words.forEach((word, i) => dv.setUint32(wa(value) + i * 4, word, true));
    return value;
  };

  const iunknown = writeGuid([0, 0, 0x000000c0, 0x46000000]);
  const idirectmusic = writeGuid([0x6536115a, 0x11d27b2d, 0x000018ba, 0x12ac75f8]);
  const iamstream = writeGuid([0xbebe595c, 0x11d09a6f, 0xc000de8f, 0x9d18d94f]);
  const gammaControl = writeGuid([0x69c11c3e, 0x11d1b46b, 0xc0007aad, 0x4e9bc24f]);
  const wrongSuffix = writeGuid([0x6536115a, 0, 0, 0]);
  const unsupported = writeGuid([0x6536115b, 0x11d27b2d, 0x000018ba, 0x12ac75f8]);
  const out = alloc(4);
  const obj = e.test_create_directmusic() >>> 0;
  check('creates the bounded IDirectMusic object with one caller reference',
    obj !== 0 && e.test_directmusic_refcount(obj) === 1);

  check('IDirectMusic QueryInterface returns E_POINTER for null output without AddRef',
    (e.test_call_IDirectMusic_QueryInterface(obj, idirectmusic, 0) >>> 0) === 0x80004003 &&
    e.test_directmusic_refcount(obj) === 1 && (e.get_esp() >>> 0) === 0x00300010);

  dv.setUint32(wa(out), 0xfeedface, true);
  check('IDirectMusic QueryInterface rejects an unsupported IID and clears output',
    (e.test_call_IDirectMusic_QueryInterface(obj, unsupported, out) >>> 0) === 0x80004002 &&
    dv.getUint32(wa(out), true) === 0 && e.test_directmusic_refcount(obj) === 1);

  dv.setUint32(wa(out), 0xfeedface, true);
  check('IDirectMusic QueryInterface compares the complete GUID',
    (e.test_call_IDirectMusic_QueryInterface(obj, wrongSuffix, out) >>> 0) === 0x80004002 &&
    dv.getUint32(wa(out), true) === 0 && e.test_directmusic_refcount(obj) === 1);

  check('IDirectMusic QueryInterface accepts IUnknown and AddRefs the result',
    e.test_call_IDirectMusic_QueryInterface(obj, iunknown, out) === 0 &&
    dv.getUint32(wa(out), true) === obj && e.test_directmusic_refcount(obj) === 2);
  check('balancing the IUnknown query leaves the caller reference',
    e.test_call_IDirectMusic_Release(obj) === 1);

  check('IDirectMusic QueryInterface accepts its own IID and AddRefs the result',
    e.test_call_IDirectMusic_QueryInterface(obj, idirectmusic, out) === 0 &&
    dv.getUint32(wa(out), true) === obj && e.test_directmusic_refcount(obj) === 2);
  check('balancing the interface query leaves the caller reference',
    e.test_call_IDirectMusic_Release(obj) === 1);
  check('final caller release destroys the DirectMusic object',
    e.test_call_IDirectMusic_Release(obj) === 0);

  const stream = e.test_create_amstream() >>> 0;
  check('IAMMultiMediaStream accepts its own IID after the shared-helper split',
    e.test_call_IAMMultiMediaStream_QueryInterface(stream, iamstream, out) === 0 &&
    dv.getUint32(wa(out), true) === stream && e.test_directmusic_refcount(stream) === 2);
  check('IAMMultiMediaStream rejects the unrelated IDirectMusic IID',
    (e.test_call_IAMMultiMediaStream_QueryInterface(stream, idirectmusic, out) >>> 0) === 0x80004002 &&
    dv.getUint32(wa(out), true) === 0 && e.test_directmusic_refcount(stream) === 2);
  check('IAMMultiMediaStream references balance to destruction',
    e.test_call_IDirectMusic_Release(stream) === 1 &&
    e.test_call_IDirectMusic_Release(stream) === 0);

  const gamma = e.test_create_gamma_control() >>> 0;
  check('IDirectDrawGammaControl accepts its own IID after the shared-helper split',
    e.test_call_IDirectDrawGammaControl_QueryInterface(gamma, gammaControl, out) === 0 &&
    dv.getUint32(wa(out), true) === gamma && e.test_directmusic_refcount(gamma) === 2);
  check('IDirectDrawGammaControl rejects the unrelated IDirectMusic IID',
    (e.test_call_IDirectDrawGammaControl_QueryInterface(gamma, idirectmusic, out) >>> 0) === 0x80004002 &&
    dv.getUint32(wa(out), true) === 0 && e.test_directmusic_refcount(gamma) === 2);
  check('IDirectDrawGammaControl references balance to destruction',
    e.test_call_IDirectMusic_Release(gamma) === 1 &&
    e.test_call_IDirectMusic_Release(gamma) === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

#!/usr/bin/env node
'use strict';

const { createHostImports } = require('../lib/host-imports');
const { compileSrcWasm } = require('./compile-src');

const extraWat = String.raw`
  (func (export "test_call_IEnumSTATSTG_QueryInterface")
        (param $obj i32) (param $iid i32) (param $out i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_IEnumSTATSTG_QueryInterface
      (local.get $obj) (local.get $iid) (local.get $out)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))

  (func (export "test_call_IEnumFORMATETC_QueryInterface")
        (param $obj i32) (param $iid i32) (param $out i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_IEnumFORMATETC_QueryInterface
      (local.get $obj) (local.get $iid) (local.get $out)
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
  const iid = (data1, suffix = true) => {
    const value = alloc(16);
    dv.setUint32(wa(value), data1, true);
    if (suffix) {
      dv.setUint32(wa(value) + 8, 0x000000c0, true);
      dv.setUint32(wa(value) + 12, 0x46000000, true);
    }
    return value;
  };
  const refcount = obj => dv.getUint32(wa(obj) + 4, true);
  const out = alloc(4);
  const iunknown = iid(0);
  const ienumStatstg = iid(0x0d);
  const ienumFormatetc = iid(0x103);
  const ienumStatdata = iid(0x105);
  const unsupported = iid(0x10e); // IDataObject
  const malformedFormatetc = iid(0x103, false);

  const storage = e.test_ole_create_storage(0) >>> 0;
  const statstg = e.test_ole_create_stat_enum(storage) >>> 0;
  e.test_ole_release(storage);
  check('IEnumSTATSTG QueryInterface rejects a null output pointer without AddRef',
    (e.test_call_IEnumSTATSTG_QueryInterface(statstg, ienumStatstg, 0) >>> 0) === 0x80004003 &&
    refcount(statstg) === 1 && (e.get_esp() >>> 0) === 0x00300010);
  dv.setUint32(wa(out), 0xfeedface, true);
  check('IEnumSTATSTG QueryInterface clears unsupported output and returns E_NOINTERFACE',
    (e.test_call_IEnumSTATSTG_QueryInterface(statstg, unsupported, out) >>> 0) === 0x80004002 &&
    dv.getUint32(wa(out), true) === 0 && refcount(statstg) === 1);
  check('IEnumSTATSTG QueryInterface accepts IUnknown and owns the returned reference',
    e.test_call_IEnumSTATSTG_QueryInterface(statstg, iunknown, out) === 0 &&
    dv.getUint32(wa(out), true) === statstg && refcount(statstg) === 2);
  e.test_ole_release(statstg);
  check('IEnumSTATSTG QueryInterface accepts its complete IID',
    e.test_call_IEnumSTATSTG_QueryInterface(statstg, ienumStatstg, out) === 0 &&
    dv.getUint32(wa(out), true) === statstg && refcount(statstg) === 2);
  e.test_ole_release(statstg);
  e.test_ole_release(statstg);

  const dataObject = e.test_ole_create_data_object(0, 0) >>> 0;
  const formatetc = e.test_ole_create_format_enum(dataObject) >>> 0;
  e.test_ole_release(dataObject);
  check('IEnumFORMATETC QueryInterface accepts IEnumFORMATETC but not IEnumSTATDATA',
    e.test_call_IEnumFORMATETC_QueryInterface(formatetc, ienumFormatetc, out) === 0 &&
    dv.getUint32(wa(out), true) === formatetc && refcount(formatetc) === 2);
  e.test_ole_release(formatetc);
  dv.setUint32(wa(out), 0xfeedface, true);
  check('IEnumFORMATETC QueryInterface validates the complete IID and clears rejection output',
    (e.test_call_IEnumFORMATETC_QueryInterface(formatetc, malformedFormatetc, out) >>> 0) === 0x80004002 &&
    dv.getUint32(wa(out), true) === 0 && refcount(formatetc) === 1 &&
    (e.test_call_IEnumFORMATETC_QueryInterface(formatetc, ienumStatdata, out) >>> 0) === 0x80004002);
  e.test_ole_release(formatetc);

  const staticObject = e.test_ole_create_static_handler(0) >>> 0;
  const cacheEnum = e.test_ole_create_cache_enum(staticObject) >>> 0;
  const adviseEnum = e.test_ole_create_advise_enum(staticObject) >>> 0;
  check('cache IEnumSTATDATA QueryInterface accepts IEnumSTATDATA and rejects IEnumFORMATETC',
    e.test_call_IEnumFORMATETC_QueryInterface(cacheEnum, ienumStatdata, out) === 0 &&
    dv.getUint32(wa(out), true) === cacheEnum && refcount(cacheEnum) === 2);
  e.test_ole_release(cacheEnum);
  check('cache IEnumSTATDATA keeps its interface identity despite the shared vtable',
    (e.test_call_IEnumFORMATETC_QueryInterface(cacheEnum, ienumFormatetc, out) >>> 0) === 0x80004002 &&
    dv.getUint32(wa(out), true) === 0 && refcount(cacheEnum) === 1);
  check('advise IEnumSTATDATA QueryInterface accepts IUnknown and IEnumSTATDATA',
    e.test_call_IEnumFORMATETC_QueryInterface(adviseEnum, iunknown, out) === 0 &&
    dv.getUint32(wa(out), true) === adviseEnum && refcount(adviseEnum) === 2);
  e.test_ole_release(adviseEnum);
  check('advise IEnumSTATDATA rejects IEnumFORMATETC',
    (e.test_call_IEnumFORMATETC_QueryInterface(adviseEnum, ienumFormatetc, out) >>> 0) === 0x80004002 &&
    dv.getUint32(wa(out), true) === 0 && refcount(adviseEnum) === 1);
  e.test_ole_release(cacheEnum);
  e.test_ole_release(adviseEnum);
  e.test_ole_release(staticObject);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

async function main() {
  const wasm = await compileWat(file => fs.promises.readFile(path.join(SRC, file), 'utf8'));
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const imports = createHostImports({ getMemory: () => memory.buffer, renderer: null, resourceJson: {} });
  imports.host.memory = memory;
  Object.assign(imports.host, {
    create_thread: () => 0, exit_thread: () => 0, create_event: () => 0,
    set_event: () => 0, reset_event: () => 0, wait_single: () => 0,
    wait_multiple: () => 0, com_create_instance: () => 0x80004002,
  });
  const { instance } = await WebAssembly.instantiate(wasm, imports);
  const e = instance.exports;
  e.init_dx_com_thunks();
  const dv = new DataView(memory.buffer);
  const wa = gp => gp - e.get_image_base() + e.get_guest_base();
  const alloc = n => e.guest_alloc(n) >>> 0;
  let pass = 0, fail = 0;
  const check = (name, ok) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    ok ? pass++ : fail++;
  };

  const clsid = alloc(16);
  for (let i = 0; i < 16; i++) dv.setUint8(wa(clsid) + i, i * 11 + 3);
  const object = e.test_ole_create_static_handler(clsid) >>> 0;
  check('creates a refcounted static IOleObject', object !== 0);

  const iidPersistStorage = alloc(16);
  dv.setUint32(wa(iidPersistStorage), 0x0000010a, true);
  const out = alloc(4);
  check('QueryInterface exposes embedded IPersistStorage',
    e.test_ole_static_query(object, iidPersistStorage, out) === 0 &&
    dv.getUint32(wa(out), true) === object + 12);
  check('secondary interface shares the root reference count', e.test_ole_release(object) === 1);

  const unknownIid = alloc(16);
  dv.setUint32(wa(unknownIid), 0x0000010d, true); // IViewObject
  check('unsupported view interface fails explicitly',
    (e.test_ole_static_query(object, unknownIid, out) >>> 0) === 0x80004002 && dv.getUint32(wa(out), true) === 0);

  const lockbytes = e.test_ole_create_lockbytes(0, 1) >>> 0;
  const storage = e.test_ole_create_storage(lockbytes) >>> 0;
  e.test_ole_static_set_storage(object, storage);
  check('static handler owns its persistence storage', e.test_ole_release(storage) === 1);
  check('final handler release drops the storage reference', e.test_ole_release(object) === 0);
  check('caller lockbytes reference remains independently releasable', e.test_ole_release(lockbytes) === 0);

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) process.exit(1);
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

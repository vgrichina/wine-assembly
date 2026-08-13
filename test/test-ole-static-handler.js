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
  const u8 = new Uint8Array(memory.buffer);
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

  const iidOleCache = alloc(16);
  dv.setUint32(wa(iidOleCache), 0x0000011e, true);
  check('QueryInterface exposes the embedded static-presentation IOleCache',
    e.test_ole_static_query(object, iidOleCache, out) === 0 &&
    dv.getUint32(wa(out), true) === object + 52);
  check('IOleCache shares the root reference count', e.test_ole_release(object) === 1);

  const iidViewObject = alloc(16);
  dv.setUint32(wa(iidViewObject), 0x0000010d, true);
  check('QueryInterface exposes the cached-presentation IViewObject',
    e.test_ole_static_query(object, iidViewObject, out) === 0 &&
    dv.getUint32(wa(out), true) === object + 56);
  check('IViewObject shares the root reference count', e.test_ole_release(object) === 1);

  const iidViewObject2 = alloc(16);
  dv.setUint32(wa(iidViewObject2), 0x0000011d, true);
  check('QueryInterface exposes the extended IViewObject2 contract',
    e.test_ole_static_query(object, iidViewObject2, out) === 0 &&
    dv.getUint32(wa(out), true) === object + 56);
  check('IViewObject2 shares the root reference count', e.test_ole_release(object) === 1);

  const unknownIid = alloc(16);
  dv.setUint32(wa(unknownIid), 0x00000119, true); // IAdviseSink
  check('unsupported interfaces fail explicitly',
    (e.test_ole_static_query(object, unknownIid, out) >>> 0) === 0x80004002 && dv.getUint32(wa(out), true) === 0);

  const writeWide = text => {
    const value = alloc((text.length + 1) * 2);
    for (let i = 0; i < text.length; i++) dv.setUint16(wa(value) + i * 2, text.charCodeAt(i), true);
    dv.setUint16(wa(value) + text.length * 2, 0, true);
    return value;
  };

  const persistObject = e.test_ole_create_static_handler(clsid) >>> 0;
  const sourceStorage = e.test_ole_create_storage(0) >>> 0;
  const unknownName = writeWide('UnknownPayload');
  const unknownStream = e.test_ole_create_stream(sourceStorage, unknownName) >>> 0;
  const payload = alloc(5);
  u8.set(Uint8Array.from([9, 8, 7, 6, 5]), wa(payload));
  const count = alloc(4);
  e.test_ole_stream_write(unknownStream, payload, 5, count);
  e.test_ole_release(unknownStream);
  const childName = writeWide('OpaqueChild');
  const unknownChild = e.test_ole_create_child_storage(sourceStorage, childName) >>> 0;
  e.test_ole_release(unknownChild);
  e.test_ole_set_class(sourceStorage, clsid);
  e.test_ole_storage_set_state_bits(sourceStorage, 0x12340000, 0xffffffff);

  check('IPersistStorage Load retains its source and starts clean',
    e.test_ole_persist_initialize(persistObject, sourceStorage, 1) === 0 &&
    e.test_ole_persist_storage(persistObject) === sourceStorage &&
    e.test_ole_persist_state(persistObject) === 1 &&
    e.test_ole_persist_dirty(persistObject) === 0 &&
    dv.getUint32(wa(sourceStorage) + 4, true) === 2);
  check('IPersistStorage rejects repeated Load or InitNew initialization',
    (e.test_ole_persist_initialize(persistObject, sourceStorage, 0) >>> 0) === 0x800401f1);

  const destinationStorage = e.test_ole_create_storage(0) >>> 0;
  const obsoleteName = writeWide('Obsolete');
  const obsoleteStream = e.test_ole_create_stream(destinationStorage, obsoleteName) >>> 0;
  e.test_ole_release(obsoleteStream);
  const persistSaveHr = e.test_ole_persist_save(persistObject, destinationStorage, 0) >>> 0;
  const obsoleteAfterSave = e.test_ole_find_stream(destinationStorage, obsoleteName) >>> 0;
  check('IPersistStorage Save enters no-scribble after a successful copy',
    persistSaveHr === 0 && e.test_ole_persist_state(persistObject) === 2 &&
    e.test_ole_persist_dirty(persistObject) === 0);
  check('IPersistStorage Save atomically removes stale destination content', obsoleteAfterSave === 0);
  if (obsoleteAfterSave) e.test_ole_release(obsoleteAfterSave);
  const copiedUnknown = e.test_ole_find_stream(destinationStorage, unknownName) >>> 0;
  const copiedChild = e.test_ole_find_storage(destinationStorage, childName) >>> 0;
  const copiedPayload = alloc(5);
  if (copiedUnknown) e.test_ole_stream_seek(copiedUnknown, 0);
  const copiedClass = alloc(16);
  e.test_ole_get_class(destinationStorage, copiedClass);
  const copiedReadHr = copiedUnknown ? e.test_ole_stream_read(copiedUnknown, copiedPayload, 5, count) >>> 0 : 0xffffffff;
  check('Save As preserves unknown streams and their bytes',
    copiedUnknown !== 0 && copiedReadHr === 0 &&
    Array.from(u8.slice(wa(copiedPayload), wa(copiedPayload) + 5)).join(',') === '9,8,7,6,5');
  check('Save As preserves unknown nested storage', copiedChild !== 0);
  check('Save As preserves root CLSID and state bits',
    Array.from(u8.slice(wa(copiedClass), wa(copiedClass) + 16)).every((byte, i) => byte === ((i * 11 + 3) & 0xff)) &&
    dv.getUint32(wa(destinationStorage) + 56, true) === 0x12340000);
  if (copiedUnknown) e.test_ole_release(copiedUnknown);
  if (copiedChild) e.test_ole_release(copiedChild);
  check('a second Save is rejected while the object is in no-scribble mode',
    (e.test_ole_persist_save(persistObject, destinationStorage, 0) >>> 0) === 0x8000ffff);

  check('HandsOffStorage after Save releases the old storage and records handoff state',
    e.test_ole_persist_hands_off(persistObject) === 0 &&
    e.test_ole_persist_state(persistObject) === 4 &&
    e.test_ole_persist_storage(persistObject) === 0 &&
    dv.getUint32(wa(sourceStorage) + 4, true) === 1);
  check('SaveCompleted requires a replacement storage while hands-off',
    (e.test_ole_persist_save_completed(persistObject, 0) >>> 0) === 0x80070057 &&
    e.test_ole_persist_state(persistObject) === 4);
  check('SaveCompleted adopts the Save As storage and returns to normal mode',
    e.test_ole_persist_save_completed(persistObject, destinationStorage) === 0 &&
    e.test_ole_persist_state(persistObject) === 1 &&
    e.test_ole_persist_storage(persistObject) === destinationStorage &&
    dv.getUint32(wa(destinationStorage) + 4, true) === 2);
  check('HandsOffStorage from normal can be completed with another storage',
    e.test_ole_persist_hands_off(persistObject) === 0 &&
    e.test_ole_persist_state(persistObject) === 3 &&
    e.test_ole_persist_save_completed(persistObject, sourceStorage) === 0 &&
    e.test_ole_persist_state(persistObject) === 1);
  e.test_ole_release(persistObject);
  check('final persistent handler release drops its current storage reference',
    dv.getUint32(wa(sourceStorage) + 4, true) === 1);
  e.test_ole_release(destinationStorage);
  e.test_ole_release(sourceStorage);

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

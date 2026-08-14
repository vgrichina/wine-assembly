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
  const readWide = value => {
    let text = '';
    for (let i = 0; ; i++) {
      const ch = dv.getUint16(wa(value) + i * 2, true);
      if (!ch) return text;
      text += String.fromCharCode(ch);
    }
  };

  const hostApp = writeWide('WordPad Host');
  const hostObject = writeWide('Document One');
  check('SetHostNames retains independent application and object names',
    e.test_ole_static_set_host_names(object, hostApp, hostObject) === 0 &&
    dv.getUint32(wa(object) + 116, true) !== hostApp &&
    dv.getUint32(wa(object) + 120, true) !== hostObject &&
    readWide(dv.getUint32(wa(object) + 116, true)) === 'WordPad Host' &&
    readWide(dv.getUint32(wa(object) + 120, true)) === 'Document One');
  dv.setUint16(wa(hostApp), 'X'.charCodeAt(0), true);
  dv.setUint16(wa(hostObject), 'Y'.charCodeAt(0), true);
  check('stored host names do not alias later caller mutation',
    readWide(dv.getUint32(wa(object) + 116, true)) === 'WordPad Host' &&
    readWide(dv.getUint32(wa(object) + 120, true)) === 'Document One');

  const extent = alloc(8);
  dv.setUint32(wa(extent), 640, true);
  dv.setUint32(wa(extent) + 4, 480, true);
  check('SetExtent rejects unsupported aspects without changing object state',
    (e.test_ole_static_set_extent(object, 2, extent) >>> 0) === 0x8004006b &&
    dv.getUint32(wa(object) + 40, true) === 0 &&
    e.test_ole_persist_dirty(object) === 0);
  const extentOut = alloc(8);
  check('content extent round-trips exactly and marks persistent state dirty',
    e.test_ole_static_set_extent(object, 1, extent) === 0 &&
    e.test_ole_static_get_extent(object, 1, extentOut) === 0 &&
    dv.getUint32(wa(extentOut), true) === 640 &&
    dv.getUint32(wa(extentOut) + 4, true) === 480 &&
    e.test_ole_persist_dirty(object) === 1);

  const testSite = e.test_ole_create_test_site() >>> 0;
  const clientSiteOut = alloc(4);
  check('SetClientSite owns one reference to a local in-process client site',
    testSite !== 0 && e.test_ole_static_set_client_site(object, testSite) === 0 &&
    dv.getUint32(wa(testSite) + 4, true) === 2 &&
    dv.getUint32(wa(testSite) + 12, true) === 1 &&
    dv.getUint32(wa(object) + 144, true) === 1);
  check('setting the same client site is reference-count neutral',
    e.test_ole_static_set_client_site(object, testSite) === 0 &&
    dv.getUint32(wa(testSite) + 4, true) === 2 &&
    dv.getUint32(wa(testSite) + 12, true) === 1);
  check('GetClientSite returns an independently referenced local interface',
    e.test_ole_static_get_client_site(object, clientSiteOut) === 0 &&
    dv.getUint32(wa(clientSiteOut), true) === testSite &&
    dv.getUint32(wa(testSite) + 4, true) === 3 &&
    dv.getUint32(wa(testSite) + 12, true) === 2 &&
    e.test_ole_release(testSite) === 2 &&
    dv.getUint32(wa(testSite) + 16, true) === 1);

  const adviseSinkA = e.test_ole_create_test_site() >>> 0;
  const adviseSinkB = e.test_ole_create_test_site() >>> 0;
  const adviseConnectionA = alloc(4);
  const adviseConnectionB = alloc(4);
  check('IOleObject Advise assigns stable connections and owns local sinks',
    e.test_ole_static_advise(object, adviseSinkA, adviseConnectionA) === 0 &&
    e.test_ole_static_advise(object, adviseSinkB, adviseConnectionB) === 0 &&
    dv.getUint32(wa(adviseConnectionA), true) === 1 &&
    dv.getUint32(wa(adviseConnectionB), true) === 2 &&
    dv.getUint32(wa(object) + 152, true) === 2 &&
    dv.getUint32(wa(adviseSinkA) + 4, true) === 2 &&
    dv.getUint32(wa(adviseSinkB) + 4, true) === 2);
  const adviseEnum = e.test_ole_create_advise_enum(object) >>> 0;
  check('EnumAdvise creates an owned stable two-sink snapshot',
    adviseEnum !== 0 && dv.getUint32(wa(adviseSinkA) + 4, true) === 3 &&
    dv.getUint32(wa(adviseSinkB) + 4, true) === 3);
  check('Unadvise rejects unknown IDs without mutating live connections',
    (e.test_ole_static_unadvise(object, 99) >>> 0) === 0x80040004 &&
    dv.getUint32(wa(object) + 152, true) === 2);
  check('Unadvise removes only its connection and releases the live sink',
    e.test_ole_static_unadvise(object, 1) === 0 &&
    dv.getUint32(wa(object) + 152, true) === 1 &&
    dv.getUint32(wa(adviseSinkA) + 4, true) === 2 &&
    dv.getUint32(wa(adviseSinkB) + 4, true) === 3);
  const adviseItems = alloc(32 * 3);
  const adviseFetched = alloc(4);
  const adviseNextHr = e.test_ole_cache_enum_next(adviseEnum, 3, adviseItems, adviseFetched) >>> 0;
  check('IEnumSTATDATA returns advisory sinks and stable connection IDs with AddRef',
    adviseNextHr === 1 && dv.getUint32(wa(adviseFetched), true) === 2 &&
    dv.getUint32(wa(adviseItems) + 24, true) === adviseSinkA &&
    dv.getUint32(wa(adviseItems) + 28, true) === 1 &&
    dv.getUint32(wa(adviseItems) + 32 + 24, true) === adviseSinkB &&
    dv.getUint32(wa(adviseItems) + 32 + 28, true) === 2 &&
    dv.getUint32(wa(adviseSinkA) + 4, true) === 3 &&
    dv.getUint32(wa(adviseSinkB) + 4, true) === 4);
  e.test_ole_release(adviseSinkA);
  e.test_ole_release(adviseSinkB);
  e.test_ole_format_free(adviseItems);
  e.test_ole_format_free(adviseItems + 32);
  e.test_ole_format_enum_reset(adviseEnum);
  e.test_ole_format_enum_skip(adviseEnum, 1);
  const adviseClone = e.test_ole_clone_cache_enum(adviseEnum) >>> 0;
  const originalAdvise = alloc(32);
  const clonedAdvise = alloc(32);
  check('EnumAdvise Clone preserves its cursor and independent sink ownership',
    adviseClone !== 0 &&
    e.test_ole_cache_enum_next(adviseEnum, 1, originalAdvise, 0) === 0 &&
    e.test_ole_cache_enum_next(adviseClone, 1, clonedAdvise, 0) === 0 &&
    dv.getUint32(wa(originalAdvise) + 24, true) === adviseSinkB &&
    dv.getUint32(wa(clonedAdvise) + 24, true) === adviseSinkB);
  e.test_ole_release(adviseSinkB);
  e.test_ole_release(adviseSinkB);
  e.test_ole_format_free(originalAdvise);
  e.test_ole_format_free(clonedAdvise);
  e.test_ole_release(adviseClone);
  e.test_ole_release(adviseEnum);
  check('snapshot release and final Unadvise restore both caller sink references',
    e.test_ole_static_unadvise(object, 2) === 0 &&
    dv.getUint32(wa(adviseSinkA) + 4, true) === 1 &&
    dv.getUint32(wa(adviseSinkB) + 4, true) === 1);
  e.test_ole_release(adviseSinkA);
  e.test_ole_release(adviseSinkB);

  const userTypeOut = alloc(4);
  check('GetUserType returns caller-owned static-object text',
    e.test_ole_static_get_user_type(0, userTypeOut) === 0 &&
    readWide(dv.getUint32(wa(userTypeOut), true)) === 'Static Object');
  check('static-object misc status advertises recomposition and static identity',
    dv.getUint32(wa(object) + 136, true) === 9);

  check('Close rejects invalid save options without changing lifecycle state',
    (e.test_ole_static_close(object, 3) >>> 0) === 0x80070057 &&
    dv.getUint32(wa(object) + 124, true) === 0);
  check('SAVEIFDIRTY close invokes the local client site and clears dirty state',
    e.test_ole_static_close(object, 0) === 0 &&
    dv.getUint32(wa(testSite) + 20, true) === 1 &&
    e.test_ole_persist_dirty(object) === 0 &&
    dv.getUint32(wa(object) + 124, true) === 1);
  e.test_ole_static_set_extent(object, 1, extent);
  e.test_ole_static_run(object);
  e.test_ole_static_lock_running(object, 1, 0);
  e.test_ole_static_lock_running(object, 1, 0);
  e.test_ole_static_lock_running(object, 0, 0);
  check('running locks retain a started object until the final unlock',
    dv.getUint32(wa(object) + 128, true) === 1 &&
    dv.getUint32(wa(object) + 132, true) === 1);
  e.test_ole_static_lock_running(object, 0, 1);
  check('last-unlock-close records NOSAVE and stops the static object',
    dv.getUint32(wa(object) + 124, true) === 2 &&
    dv.getUint32(wa(object) + 128, true) === 0 &&
    dv.getUint32(wa(object) + 132, true) === 0);
  e.test_ole_static_set_contained(object, 1);
  check('contained-object state toggles independently of close and persistence',
    dv.getUint32(wa(object) + 140, true) === 1 && e.test_ole_persist_dirty(object) === 1);

  const makeFormat = (id, aspect = 1, tymed = 1) => {
    const value = alloc(20);
    u8.fill(0, wa(value), wa(value) + 20);
    dv.setUint16(wa(value), id, true);
    dv.setUint32(wa(value) + 8, aspect, true);
    dv.setInt32(wa(value) + 12, -1, true);
    dv.setUint32(wa(value) + 16, tymed, true);
    return value;
  };
  const makeMedium = bytes => {
    const handle = alloc(bytes.length);
    u8.set(bytes, wa(handle));
    const value = alloc(12);
    u8.fill(0, wa(value), wa(value) + 12);
    dv.setUint32(wa(value), 1, true);
    dv.setUint32(wa(value) + 4, handle, true);
    return { value, handle };
  };

  const cacheObject = e.test_ole_create_static_handler(clsid) >>> 0;
  const dibFormat = makeFormat(8);
  const opaqueFormat = makeFormat(0xc401);
  const opaqueTarget = alloc(8);
  dv.setUint32(wa(opaqueTarget), 8, true);
  dv.setUint32(wa(opaqueTarget) + 4, 0x11223344, true);
  dv.setUint32(wa(opaqueFormat) + 4, opaqueTarget, true);
  const dibConnection = alloc(4);
  const opaqueConnection = alloc(4);
  check('IOleCache assigns stable connections to distinct presentations',
    e.test_ole_cache_add(cacheObject, dibFormat, 1, dibConnection) === 0 &&
    e.test_ole_cache_add(cacheObject, opaqueFormat, 2, opaqueConnection) === 0 &&
    dv.getUint32(wa(dibConnection), true) === 1 &&
    dv.getUint32(wa(opaqueConnection), true) === 2 &&
    e.test_ole_cache_count(cacheObject) === 2);
  const duplicateConnection = alloc(4);
  check('IOleCache reuses a matching connection without duplicating the entry',
    e.test_ole_cache_add(cacheObject, dibFormat, 9, duplicateConnection) === 0 &&
    dv.getUint32(wa(duplicateConnection), true) === 1 &&
    e.test_ole_cache_count(cacheObject) === 2);

  const opaqueMedium = makeMedium(Uint8Array.from([1, 2, 3, 0]));
  check('IOleCache SetData copies an opaque presentation independently',
    e.test_ole_cache_set_data(cacheObject, opaqueFormat, opaqueMedium.value, 0) === 0);
  u8[wa(opaqueMedium.handle)] = 9;
  const opaqueOut = alloc(12);
  e.test_ole_cache_get(cacheObject, opaqueFormat, opaqueOut);
  check('cached opaque presentation bytes do not alias the caller medium',
    u8[wa(dv.getUint32(wa(opaqueOut) + 4, true))] === 1);
  e.test_ole_release_medium(opaqueOut);

  const dibMedium = makeMedium(Uint8Array.from([40, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 24, 0]));
  check('IOleCache SetData transfers fRelease ownership and selects CF_DIB for rendering',
    e.test_ole_cache_set_data(cacheObject, dibFormat, dibMedium.value, 1) === 0 &&
    dv.getUint32(wa(dibMedium.value), true) === 0 &&
    dv.getUint32(wa(dibMedium.value) + 4, true) === 0 &&
    e.test_ole_cache_render_valid(cacheObject) === 1);
  const clipboardData = e.test_ole_static_get_clipboard_data(cacheObject) >>> 0;
  const clipboardOpaqueOut = alloc(12);
  check('IOleObject GetClipboardData snapshots every cached presentation',
    clipboardData !== 0 && e.test_ole_data_count(clipboardData) === 2 &&
    e.test_ole_data_query(clipboardData, dibFormat) === 0 &&
    e.test_ole_data_query(clipboardData, opaqueFormat) === 0 &&
    e.test_ole_data_get(clipboardData, opaqueFormat, clipboardOpaqueOut) === 0 &&
    u8[wa(dv.getUint32(wa(clipboardOpaqueOut) + 4, true))] === 1);
  e.test_ole_release_medium(clipboardOpaqueOut);
  const replacementMedium = makeMedium(Uint8Array.from([4, 5, 6, 0]));
  e.test_ole_cache_set_data(cacheObject, opaqueFormat, replacementMedium.value, 0);
  const replacementOut = alloc(12);
  e.test_ole_cache_get(cacheObject, opaqueFormat, replacementOut);
  check('IOleCache replaces one presentation without disturbing other entries',
    e.test_ole_cache_count(cacheObject) === 2 &&
    u8[wa(dv.getUint32(wa(replacementOut) + 4, true))] === 4 &&
    e.test_ole_cache_render_valid(cacheObject) === 1);
  e.test_ole_release_medium(replacementOut);
  const cacheEnum = e.test_ole_create_cache_enum(cacheObject) >>> 0;
  check('IOleCache EnumCache creates a stable multi-presentation snapshot', cacheEnum !== 0);
  const storedOpaqueFormat = makeFormat(0xc401);
  const storedOpaqueTarget = alloc(8);
  dv.setUint32(wa(storedOpaqueTarget), 8, true);
  dv.setUint32(wa(storedOpaqueTarget) + 4, 0x11223344, true);
  dv.setUint32(wa(storedOpaqueFormat) + 4, storedOpaqueTarget, true);
  dv.setUint32(wa(opaqueTarget) + 4, 0xdeadbeef, true);
  check('IOleCache rejects unknown connection removal without mutation',
    (e.test_ole_cache_uncache(cacheObject, 99) >>> 0) === 0x80040004 &&
    e.test_ole_cache_count(cacheObject) === 2);
  check('IOleCache Uncache removes only the selected connection and refreshes render selection',
    e.test_ole_cache_uncache(cacheObject, 1) === 0 &&
    e.test_ole_cache_count(cacheObject) === 1 &&
    e.test_ole_cache_render_valid(cacheObject) === 0 &&
    e.test_ole_cache_get(cacheObject, storedOpaqueFormat, replacementOut) === 0);
  e.test_ole_release_medium(replacementOut);

  const independentOpaqueOut = alloc(12);
  check('GetClipboardData result remains independent of later cache replacement and removal',
    e.test_ole_data_count(clipboardData) === 2 &&
    e.test_ole_data_query(clipboardData, dibFormat) === 0 &&
    e.test_ole_data_get(clipboardData, storedOpaqueFormat, independentOpaqueOut) === 0 &&
    u8[wa(dv.getUint32(wa(independentOpaqueOut) + 4, true))] === 1);
  e.test_ole_release_medium(independentOpaqueOut);

  const initializedObject = e.test_ole_create_static_handler(clsid) >>> 0;
  check('IOleObject InitFromData rejects non-IDataObject local objects without mutation',
    (e.test_ole_static_init_from_data(initializedObject, cacheObject) >>> 0) === 0x80004002 &&
    e.test_ole_cache_count(initializedObject) === 0);
  const initializedOpaqueOut = alloc(12);
  check('IOleObject InitFromData atomically imports all local IDataObject presentations',
    e.test_ole_static_init_from_data(initializedObject, clipboardData) === 0 &&
    e.test_ole_cache_count(initializedObject) === 2 &&
    e.test_ole_cache_render_valid(initializedObject) === 1 &&
    e.test_ole_persist_dirty(initializedObject) === 1 &&
    e.test_ole_cache_get(initializedObject, storedOpaqueFormat, initializedOpaqueOut) === 0 &&
    u8[wa(dv.getUint32(wa(initializedOpaqueOut) + 4, true))] === 1);
  e.test_ole_release_medium(initializedOpaqueOut);
  e.test_ole_release(initializedObject);
  e.test_ole_release(clipboardData);

  const statItems = alloc(32 * 3);
  const statFetched = alloc(4);
  const statNextHr = e.test_ole_cache_enum_next(cacheEnum, 3, statItems, statFetched) >>> 0;
  const firstStat = statItems;
  const secondStat = statItems + 32;
  check('IEnumSTATDATA Next returns exact format, ADVF, sink, and connection fields',
    statNextHr === 1 && dv.getUint32(wa(statFetched), true) === 2 &&
    dv.getUint16(wa(firstStat), true) === 8 && dv.getUint32(wa(firstStat) + 20, true) === 1 &&
    dv.getUint32(wa(firstStat) + 24, true) === 0 && dv.getUint32(wa(firstStat) + 28, true) === 1 &&
    dv.getUint16(wa(secondStat), true) === 0xc401 && dv.getUint32(wa(secondStat) + 20, true) === 2 &&
    dv.getUint32(wa(secondStat) + 24, true) === 0 && dv.getUint32(wa(secondStat) + 28, true) === 2);
  const enumeratedTarget = dv.getUint32(wa(secondStat) + 4, true) >>> 0;
  check('IEnumSTATDATA snapshot deep-copies target metadata before live mutation',
    enumeratedTarget !== 0 && enumeratedTarget !== opaqueTarget &&
    dv.getUint32(wa(enumeratedTarget) + 4, true) === 0x11223344);
  e.test_ole_format_free(firstStat);
  e.test_ole_format_free(secondStat);
  e.test_ole_format_enum_reset(cacheEnum);
  e.test_ole_format_enum_skip(cacheEnum, 1);
  const cacheEnumClone = e.test_ole_clone_cache_enum(cacheEnum) >>> 0;
  const originalStat = alloc(32);
  const clonedStat = alloc(32);
  check('IEnumSTATDATA Clone preserves an independent cursor and owned FORMATETC',
    cacheEnumClone !== 0 &&
    e.test_ole_cache_enum_next(cacheEnum, 1, originalStat, 0) === 0 &&
    e.test_ole_cache_enum_next(cacheEnumClone, 1, clonedStat, 0) === 0 &&
    dv.getUint16(wa(originalStat), true) === 0xc401 &&
    dv.getUint16(wa(clonedStat), true) === 0xc401);
  e.test_ole_format_free(originalStat);
  e.test_ole_format_free(clonedStat);
  e.test_ole_release(cacheEnumClone);
  e.test_ole_release(cacheEnum);
  e.test_ole_release(cacheObject);

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
  check('final handler release drops its owned local client-site reference',
    dv.getUint32(wa(testSite) + 4, true) === 1 &&
    dv.getUint32(wa(testSite) + 16, true) === 2);
  check('caller client-site reference remains independently releasable', e.test_ole_release(testSite) === 0);
  check('caller lockbytes reference remains independently releasable', e.test_ole_release(lockbytes) === 0);

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail) process.exit(1);
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

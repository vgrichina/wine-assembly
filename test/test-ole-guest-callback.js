#!/usr/bin/env node
'use strict';

// Exercise the real IOleObject API thunks against a DLL-private-style guest
// COM vtable. The callbacks are guest x86, not WAT test helpers, so this proves
// the suspended API frame resumes through the continuation dispatcher.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');
const apiTable = require('../src/api_table.json');

const ROOT = path.join(__dirname, '..');

async function main() {
  const wasm = await compileWat(file => fs.promises.readFile(path.join(ROOT, 'src', file), 'utf8'));
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const imports = createHostImports({ getMemory: () => memory.buffer, renderer: null, resourceJson: {} });
  imports.host.memory = memory;
  Object.assign(imports.host, {
    create_thread: () => 0,
    exit_thread: () => 0,
    create_event: () => 0,
    set_event: () => 0,
    reset_event: () => 0,
    wait_single: () => 0,
    wait_multiple: () => 0,
    com_create_instance: () => 0x80004002,
  });
  const { instance } = await WebAssembly.instantiate(wasm, imports);
  const e = instance.exports;

  // Loading a PE initializes the shared CACA continuation thunk block.
  const exe = fs.readFileSync(path.join(ROOT, 'test', 'binaries', 'calc.exe'));
  new Uint8Array(memory.buffer).set(exe, e.get_staging());
  assert(e.load_pe(exe.length), 'fixture PE should initialize continuation thunks');
  e.init_dx_com_thunks();

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const wa = guest => (guest - imageBase + guestBase) >>> 0;
  const bytes = new Uint8Array(memory.buffer);
  const read = guest => e.guest_read32(guest) >>> 0;
  const write = (guest, value) => e.guest_write32(guest, value >>> 0);
  const alloc = size => e.guest_alloc(size) >>> 0;

  const makeGuestSite = (releaseSequence = 0) => {
    if (!releaseSequence) {
      releaseSequence = alloc(4);
      write(releaseSequence, 0);
    }
    const code = alloc(128);
    const vtable = alloc(32);
    const site = alloc(40);
    bytes.fill(0, wa(code), wa(code) + 128);
    bytes.fill(0, wa(vtable), wa(vtable) + 32);
    bytes.fill(0, wa(site), wa(site) + 40);
    const addRef = code;
    const release = code + 20;
    const saveObject = code + 48;
    const onSave = code + 72;
    const onClose = code + 88;
    bytes.set([
      0x8b, 0x44, 0x24, 0x04,       // mov eax,[esp+4]
      0xff, 0x40, 0x04,             // inc dword [eax+4] (refcount)
      0xff, 0x40, 0x08,             // inc dword [eax+8] (AddRef calls)
      0x8b, 0x40, 0x04,             // mov eax,[eax+4]
      0xc2, 0x04, 0x00,             // ret 4
    ], wa(addRef));
    bytes.set([
      0x8b, 0x44, 0x24, 0x04,       // mov eax,[esp+4]
      0xff, 0x48, 0x04,             // dec dword [eax+4]
      0xff, 0x40, 0x0c,             // inc dword [eax+12] (Release calls)
      0x8b, 0x50, 0x20,             // mov edx,[eax+32] (sequence counter)
      0xff, 0x02,                   // inc dword [edx]
      0x8b, 0x0a,                   // mov ecx,[edx]
      0x89, 0x48, 0x24,             // mov [eax+36],ecx (observed order)
      0x8b, 0x40, 0x04,             // mov eax,[eax+4]
      0xc2, 0x04, 0x00,             // ret 4
    ], wa(release));
    bytes.set([
      0x8b, 0x44, 0x24, 0x04,       // mov eax,[esp+4]
      0xff, 0x40, 0x10,             // inc dword [eax+16] (SaveObject calls)
      0x8b, 0x40, 0x14,             // mov eax,[eax+20] (configured HRESULT)
      0xc2, 0x04, 0x00,             // ret 4
    ], wa(saveObject));
    bytes.set([
      0x8b, 0x44, 0x24, 0x04,       // mov eax,[esp+4]
      0xff, 0x40, 0x18,             // inc dword [eax+24] (OnSave calls)
      0xc2, 0x04, 0x00,             // ret 4
    ], wa(onSave));
    bytes.set([
      0x8b, 0x44, 0x24, 0x04,       // mov eax,[esp+4]
      0xff, 0x40, 0x1c,             // inc dword [eax+28] (OnClose calls)
      0xc2, 0x04, 0x00,             // ret 4
    ], wa(onClose));
    write(vtable + 4, addRef);
    write(vtable + 8, release);
    write(vtable + 12, saveObject);
    write(vtable + 24, onSave);
    write(vtable + 28, onClose);
    write(site, vtable);
    write(site + 4, 1);
    write(site + 32, releaseSequence);
    return site;
  };

  const callMethod = (object, index, ...args) => {
    const fn = read(read(object) + index * 4);
    assert(fn, `method ${index} must have an API thunk`);
    const argv = [object, ...args, 0, 0, 0, 0].slice(0, 4);
    e.call_func(fn, argv[0], argv[1], argv[2], argv[3]);
    for (let i = 0; i < 200 && e.get_eip(); i++) e.run(5000);
    assert.strictEqual(e.get_eip(), 0, `method ${index} callback continuation must terminate`);
    return e.get_eax() >>> 0;
  };

  // Reuse one loaded import-thunk slot to exercise a public API handler that
  // calc.exe does not itself import. The thunk record is restored after the
  // suspended guest callback chain has completely returned.
  const callApi = name => {
    const api = apiTable.find(entry => entry.name === name);
    assert(api, `${name} must exist in api_table.json`);
    const thunkWa = 0x07112000;
    const thunkGuest = (thunkWa - guestBase + imageBase) >>> 0;
    const view = new DataView(memory.buffer);
    const savedName = view.getUint32(thunkWa, true);
    const savedId = view.getUint32(thunkWa + 4, true);
    view.setUint32(thunkWa + 4, api.id >>> 0, true);
    e.call_func(thunkGuest, 0, 0, 0, 0);
    for (let i = 0; i < 400 && e.get_eip(); i++) e.run(5000);
    view.setUint32(thunkWa, savedName, true);
    view.setUint32(thunkWa + 4, savedId, true);
    assert.strictEqual(e.get_eip(), 0, `${name} callback continuation must terminate`);
    return e.get_eax() >>> 0;
  };

  const releaseMedium = medium => {
    e.test_start_ReleaseStgMedium(medium);
    for (let i = 0; i < 200 && e.get_eip(); i++) e.run(5000);
    assert.strictEqual(e.get_eip(), 0, 'ReleaseStgMedium callback continuation must terminate');
  };

  const makeFormat = (id, tymed = 1, aspect = 1, lindex = 0xffffffff) => {
    const format = alloc(20);
    write(format, id);
    write(format + 4, 0);
    write(format + 8, aspect);
    write(format + 12, lindex);
    write(format + 16, tymed);
    return format;
  };

  const makeWide = text => {
    const value = alloc((text.length + 1) * 2);
    const view = new DataView(memory.buffer);
    for (let i = 0; i < text.length; i++) view.setUint16(wa(value) + i * 2, text.charCodeAt(i), true);
    view.setUint16(wa(value) + text.length * 2, 0, true);
    return value;
  };

  let checks = 0;
  const check = (name, condition, detail = '') => {
    assert(condition, detail ? `${name}: ${detail}` : name);
    checks++;
    console.log(`PASS  ${name}${detail ? `  ${detail}` : ''}`);
  };

  const object = e.test_ole_create_static_handler(0) >>> 0;
  const siteA = makeGuestSite();
  check('SetClientSite AddRefs and owns a DLL-private guest interface',
    callMethod(object, 3, siteA) === 0 &&
    read(siteA + 4) === 2 && read(siteA + 8) === 1 &&
    read(object + 16) === siteA && read(object + 144) === 2);

  check('reassigning the same guest client site is reference-neutral',
    callMethod(object, 3, siteA) === 0 && read(siteA + 4) === 2 && read(siteA + 8) === 1);

  const out = alloc(4);
  check('GetClientSite returns an independently AddRefed guest interface',
    callMethod(object, 4, out) === 0 && read(out) === siteA &&
    read(siteA + 4) === 3 && read(siteA + 8) === 2);
  check('the caller can release its GetClientSite reference through guest x86',
    callMethod(siteA, 2) === 2 && read(siteA + 12) === 1);

  const siteB = makeGuestSite();
  const replacementHr = callMethod(object, 3, siteB);
  check('client-site replacement AddRefs new before releasing old',
    replacementHr === 0 &&
    read(siteB + 4) === 2 && read(siteB + 8) === 1 &&
    read(siteA + 4) === 1 && read(siteA + 12) === 2 &&
    read(object + 16) === siteB && read(object + 144) === 2);

  const extent = alloc(8);
  write(extent, 640);
  write(extent + 4, 480);
  assert.strictEqual(e.test_ole_static_set_extent(object, 1, extent), 0);
  write(siteB + 20, 0x80004005);
  check('failed guest SaveObject propagates HRESULT and preserves dirty state',
    callMethod(object, 6, 0) === 0x80004005 &&
    read(siteB + 16) === 1 && e.test_ole_persist_dirty(object) === 1);

  write(siteB + 20, 0);
  check('successful guest SaveObject clears dirty state during Close',
    callMethod(object, 6, 0) === 0 &&
    read(siteB + 16) === 2 && e.test_ole_persist_dirty(object) === 0);

  check('clearing the client site releases the owned guest reference',
    callMethod(object, 3, 0) === 0 &&
    read(siteB + 4) === 1 && read(siteB + 12) === 1 &&
    read(object + 16) === 0 && read(object + 144) === 0);
  check('ordinary final Release still destroys a site-free static handler',
    callMethod(object, 2) === 0);

  const adviseObject = e.test_ole_create_static_handler(0) >>> 0;
  const adviseSinkA = makeGuestSite();
  const adviseSinkB = makeGuestSite();
  const connectionA = alloc(4);
  const connectionB = alloc(4);
  check('Advise AddRefs DLL-private sinks and assigns stable connections',
    callMethod(adviseObject, 19, adviseSinkA, connectionA) === 0 &&
    callMethod(adviseObject, 19, adviseSinkB, connectionB) === 0 &&
    read(connectionA) === 1 && read(connectionB) === 2 &&
    read(adviseSinkA + 4) === 2 && read(adviseSinkA + 8) === 1 &&
    read(adviseSinkB + 4) === 2 && read(adviseSinkB + 8) === 1 &&
    read(adviseObject + 152) === 2);
  check('Unadvise removes only its guest sink and calls Release',
    callMethod(adviseObject, 20, 1) === 0 &&
    read(adviseSinkA + 4) === 1 && read(adviseSinkA + 12) === 1 &&
    read(adviseSinkB + 4) === 2 && read(adviseObject + 152) === 1);
  check('final handler destruction releases every remaining guest sink',
    callMethod(adviseObject, 2) === 0 &&
    read(adviseSinkB + 4) === 1 && read(adviseSinkB + 12) === 1);

  const finalObject = e.test_ole_create_static_handler(0) >>> 0;
  const finalSite = makeGuestSite();
  const finalSink = makeGuestSite();
  const finalConnection = alloc(4);
  assert.strictEqual(callMethod(finalObject, 3, finalSite), 0);
  assert.strictEqual(callMethod(finalObject, 19, finalSink, finalConnection), 0);
  check('final static-handler Release balances both client-site and sink ownership',
    callMethod(finalObject, 2) === 0 &&
    read(finalSite + 4) === 1 && read(finalSite + 12) === 1 &&
    read(finalSink + 4) === 1 && read(finalSink + 12) === 1);

  const notifyObject = e.test_ole_create_static_handler(0) >>> 0;
  const notifySite = makeGuestSite();
  const notifySinkA = makeGuestSite();
  const notifySinkB = makeGuestSite();
  const notifyConnectionA = alloc(4);
  const notifyConnectionB = alloc(4);
  assert.strictEqual(callMethod(notifyObject, 3, notifySite), 0);
  assert.strictEqual(callMethod(notifyObject, 19, notifySinkA, notifyConnectionA), 0);
  assert.strictEqual(callMethod(notifyObject, 19, notifySinkB, notifyConnectionB), 0);
  assert.strictEqual(e.test_ole_static_set_extent(notifyObject, 1, extent), 0);
  check('successful dirty Close notifies every guest sink OnSave then OnClose',
    callMethod(notifyObject, 6, 0) === 0 &&
    read(notifySite + 16) === 1 && e.test_ole_persist_dirty(notifyObject) === 0 &&
    read(notifySinkA + 24) === 1 && read(notifySinkA + 28) === 1 &&
    read(notifySinkB + 24) === 1 && read(notifySinkB + 28) === 1);

  check('clean Close emits OnClose without a redundant OnSave',
    callMethod(notifyObject, 6, 0) === 0 &&
    read(notifySite + 16) === 1 &&
    read(notifySinkA + 24) === 1 && read(notifySinkA + 28) === 2 &&
    read(notifySinkB + 24) === 1 && read(notifySinkB + 28) === 2);

  assert.strictEqual(e.test_ole_static_set_extent(notifyObject, 1, extent), 0);
  write(notifySite + 20, 0x80004005);
  check('failed guest SaveObject suppresses advisory save/close notifications',
    callMethod(notifyObject, 6, 0) === 0x80004005 &&
    e.test_ole_persist_dirty(notifyObject) === 1 &&
    read(notifySinkA + 24) === 1 && read(notifySinkA + 28) === 2 &&
    read(notifySinkB + 24) === 1 && read(notifySinkB + 28) === 2);

  check('OLECLOSE_NOSAVE emits only OnClose and preserves dirty state',
    callMethod(notifyObject, 6, 1) === 0 &&
    e.test_ole_persist_dirty(notifyObject) === 1 &&
    read(notifySinkA + 24) === 1 && read(notifySinkA + 28) === 3 &&
    read(notifySinkB + 24) === 1 && read(notifySinkB + 28) === 3);

  check('notification object final Release balances site and sink references',
    callMethod(notifyObject, 2) === 0 &&
    read(notifySite + 4) === 1 && read(notifySite + 12) === 1 &&
    read(notifySinkA + 4) === 1 && read(notifySinkA + 12) === 1 &&
    read(notifySinkB + 4) === 1 && read(notifySinkB + 12) === 1);

  const enumObject = e.test_ole_create_static_handler(0) >>> 0;
  const enumSinkA = makeGuestSite();
  const enumSinkB = makeGuestSite();
  const enumConnectionA = alloc(4);
  const enumConnectionB = alloc(4);
  assert.strictEqual(callMethod(enumObject, 19, enumSinkA, enumConnectionA), 0);
  assert.strictEqual(callMethod(enumObject, 19, enumSinkB, enumConnectionB), 0);

  const malformedEnumOut = alloc(4);
  const enumSinkAVtable = read(enumSinkA);
  const enumSinkAAddRef = read(enumSinkAVtable + 4);
  write(enumSinkAVtable + 4, 0);
  check('EnumAdvise rejects a malformed guest AddRef before publishing a snapshot',
    callMethod(enumObject, 21, malformedEnumOut) === 0x80004002 &&
    read(malformedEnumOut) === 0 &&
    read(enumSinkA + 4) === 2 && read(enumSinkB + 4) === 2);
  write(enumSinkAVtable + 4, enumSinkAAddRef);

  const enumOut = alloc(4);
  check('EnumAdvise independently AddRefs every DLL-private snapshot sink',
    callMethod(enumObject, 21, enumOut) === 0 && read(enumOut) !== 0 &&
    read(enumSinkA + 4) === 3 && read(enumSinkA + 8) === 2 &&
    read(enumSinkB + 4) === 3 && read(enumSinkB + 8) === 2);
  const adviseEnum = read(enumOut);

  check('an EnumAdvise snapshot retains a sink after live Unadvise',
    callMethod(enumObject, 20, read(enumConnectionA)) === 0 &&
    read(enumSinkA + 4) === 2 && read(enumSinkA + 12) === 1 &&
    read(enumSinkB + 4) === 3);

  const malformedItems = alloc(32);
  const malformedFetched = alloc(4);
  const malformedCloneOut = alloc(4);
  write(malformedFetched, 0xcccccccc);
  write(enumSinkAVtable + 4, 0);
  check('IEnumSTATDATA Next rejects malformed guest AddRef without advancing',
    callMethod(adviseEnum, 3, 1, malformedItems, malformedFetched) === 0x80004002 &&
    read(malformedFetched) === 0 && read(adviseEnum + 20) === 0 &&
    read(enumSinkA + 4) === 2 && read(enumSinkB + 4) === 3);
  check('IEnumSTATDATA Clone rejects malformed guest AddRef without publishing',
    callMethod(adviseEnum, 6, malformedCloneOut) === 0x80004002 &&
    read(malformedCloneOut) === 0 &&
    read(enumSinkA + 4) === 2 && read(enumSinkB + 4) === 3);
  write(enumSinkAVtable + 4, enumSinkAAddRef);

  const cloneOut = alloc(4);
  const cloneHr = callMethod(adviseEnum, 6, cloneOut);
  check('IEnumSTATDATA Clone AddRefs all guest snapshot references',
    cloneHr === 0 && read(cloneOut) !== 0 &&
    read(enumSinkA + 4) === 3 && read(enumSinkA + 8) === 3 &&
    read(enumSinkB + 4) === 4 && read(enumSinkB + 8) === 3);
  const adviseClone = read(cloneOut);

  const enumItems = alloc(64);
  const enumFetched = alloc(4);
  check('IEnumSTATDATA Next AddRefs returned guest sinks with stable connections',
    callMethod(adviseEnum, 3, 2, enumItems, enumFetched) === 0 &&
    read(enumFetched) === 2 &&
    read(enumItems + 24) === enumSinkA && read(enumItems + 28) === 1 &&
    read(enumItems + 56) === enumSinkB && read(enumItems + 60) === 2 &&
    read(enumSinkA + 4) === 4 && read(enumSinkB + 4) === 5);
  assert.strictEqual(callMethod(read(enumItems + 24), 2), 3);
  assert.strictEqual(callMethod(read(enumItems + 56), 2), 4);

  check('final enumerator Release drops its two guest snapshot references',
    callMethod(adviseEnum, 2) === 0 &&
    read(enumSinkA + 4) === 2 && read(enumSinkA + 12) === 3 &&
    read(enumSinkB + 4) === 3 && read(enumSinkB + 12) === 2);

  const cloneItems = alloc(64);
  const cloneFetched = alloc(4);
  check('a clone remains independently usable after the source enumerator is gone',
    callMethod(adviseClone, 3, 2, cloneItems, cloneFetched) === 0 &&
    read(cloneFetched) === 2 &&
    read(cloneItems + 24) === enumSinkA && read(cloneItems + 56) === enumSinkB &&
    read(enumSinkA + 4) === 3 && read(enumSinkB + 4) === 4);
  assert.strictEqual(callMethod(read(cloneItems + 24), 2), 2);
  assert.strictEqual(callMethod(read(cloneItems + 56), 2), 3);

  const enumSinkBVtable = read(enumSinkB);
  const enumSinkBRelease = read(enumSinkBVtable + 8);
  write(enumSinkBVtable + 8, 0);
  check('final enumerator Release is atomic when a guest Release slot is malformed',
    callMethod(adviseClone, 2) === 1 && read(adviseClone + 4) === 1 &&
    read(enumSinkA + 4) === 2 && read(enumSinkB + 4) === 3);
  write(enumSinkBVtable + 8, enumSinkBRelease);

  check('clone and live-object destruction balance all guest advisory ownership',
    callMethod(adviseClone, 2) === 0 && callMethod(enumObject, 2) === 0 &&
    read(enumSinkA + 4) === 1 && read(enumSinkA + 8) === 5 && read(enumSinkA + 12) === 5 &&
    read(enumSinkB + 4) === 1 && read(enumSinkB + 8) === 5 && read(enumSinkB + 12) === 5);

  const hglobalSequence = alloc(4);
  write(hglobalSequence, 0);
  const hglobalPayload = alloc(8);
  const hglobalReleaser = makeGuestSite(hglobalSequence);
  const hglobalMedium = alloc(12);
  write(hglobalPayload, 0x44332211);
  write(hglobalMedium, 1);
  write(hglobalMedium + 4, hglobalPayload);
  write(hglobalMedium + 8, hglobalReleaser);
  releaseMedium(hglobalMedium);
  check('ReleaseStgMedium delegates guest-released HGLOBAL cleanup without freeing payload',
    read(hglobalPayload) === 0x44332211 &&
    read(hglobalReleaser + 4) === 0 && read(hglobalReleaser + 12) === 1 &&
    read(hglobalReleaser + 36) === 1 &&
    read(hglobalMedium) === 0 && read(hglobalMedium + 4) === 0 && read(hglobalMedium + 8) === 0);

  const dualSequence = alloc(4);
  write(dualSequence, 0);
  const guestStream = makeGuestSite(dualSequence);
  const guestStreamReleaser = makeGuestSite(dualSequence);
  const dualGuestMedium = alloc(12);
  write(dualGuestMedium, 4);
  write(dualGuestMedium + 4, guestStream);
  write(dualGuestMedium + 8, guestStreamReleaser);
  releaseMedium(dualGuestMedium);
  check('ReleaseStgMedium releases guest IStream before guest pUnkForRelease',
    read(guestStream + 4) === 0 && read(guestStream + 12) === 1 && read(guestStream + 36) === 1 &&
    read(guestStreamReleaser + 4) === 0 && read(guestStreamReleaser + 12) === 1 &&
    read(guestStreamReleaser + 36) === 2 && read(dualGuestMedium) === 0);

  const mixedLocalStream = e.test_ole_create_stream(0, 0) >>> 0;
  assert.strictEqual(e.test_ole_addref(mixedLocalStream), 2);
  const mixedGuestReleaser = makeGuestSite();
  const mixedMedium = alloc(12);
  write(mixedMedium, 4);
  write(mixedMedium + 4, mixedLocalStream);
  write(mixedMedium + 8, mixedGuestReleaser);
  releaseMedium(mixedMedium);
  check('ReleaseStgMedium preserves local-interface behavior beside a guest releaser',
    read(mixedLocalStream + 4) === 1 &&
    read(mixedGuestReleaser + 4) === 0 && read(mixedGuestReleaser + 12) === 1 &&
    read(mixedMedium) === 0);
  assert.strictEqual(e.test_ole_release(mixedLocalStream), 0);

  const malformedSequence = alloc(4);
  write(malformedSequence, 0);
  const malformedStream = makeGuestSite(malformedSequence);
  const malformedReleaser = makeGuestSite(malformedSequence);
  const malformedMedium = alloc(12);
  const malformedReleaseVtable = read(malformedReleaser);
  const malformedReleaseMethod = read(malformedReleaseVtable + 8);
  write(malformedMedium, 8);
  write(malformedMedium + 4, malformedStream);
  write(malformedMedium + 8, malformedReleaser);
  write(malformedReleaseVtable + 8, 0);
  releaseMedium(malformedMedium);
  check('ReleaseStgMedium leaves the whole medium intact if a guest Release slot is malformed',
    read(malformedMedium) === 8 && read(malformedMedium + 4) === malformedStream &&
    read(malformedMedium + 8) === malformedReleaser && read(malformedSequence) === 0 &&
    read(malformedStream + 4) === 1 && read(malformedReleaser + 4) === 1);
  write(malformedReleaseVtable + 8, malformedReleaseMethod);
  releaseMedium(malformedMedium);
  assert.strictEqual(read(malformedStream + 4), 0);
  assert.strictEqual(read(malformedReleaser + 4), 0);

  const ownedSequence = alloc(4);
  write(ownedSequence, 0);
  const ownedObject = e.test_ole_create_data_object(0, 0) >>> 0;
  const ownedStreamFormat = alloc(20);
  write(ownedStreamFormat, 0xc510);
  write(ownedStreamFormat + 4, 0);
  write(ownedStreamFormat + 8, 1);
  write(ownedStreamFormat + 12, 0xffffffff);
  write(ownedStreamFormat + 16, 4);
  const ownedStream = makeGuestSite(ownedSequence);
  const ownedStreamReleaser = makeGuestSite(ownedSequence);
  const ownedStreamMedium = alloc(12);
  write(ownedStreamMedium, 4);
  write(ownedStreamMedium + 4, ownedStream);
  write(ownedStreamMedium + 8, ownedStreamReleaser);
  check('IDataObject SetData transfers DLL-private stream and releaser ownership',
    callMethod(ownedObject, 7, ownedStreamFormat, ownedStreamMedium, 1) === 0 &&
    read(ownedStreamMedium) === 0 && read(ownedStreamMedium + 4) === 0 &&
    read(ownedStreamMedium + 8) === 0 &&
    read(ownedStream + 4) === 1 && read(ownedStreamReleaser + 4) === 1);

  const ownedHglobalFormat = alloc(20);
  write(ownedHglobalFormat, 0xc511);
  write(ownedHglobalFormat + 4, 0);
  write(ownedHglobalFormat + 8, 1);
  write(ownedHglobalFormat + 12, 0xffffffff);
  write(ownedHglobalFormat + 16, 1);
  const ownedHglobalPayload = alloc(8);
  write(ownedHglobalPayload, 0x78563412);
  const ownedHglobalReleaser = makeGuestSite(ownedSequence);
  const ownedHglobalMedium = alloc(12);
  write(ownedHglobalMedium, 1);
  write(ownedHglobalMedium + 4, ownedHglobalPayload);
  write(ownedHglobalMedium + 8, ownedHglobalReleaser);
  check('IDataObject owns multiple transferred DLL-private media entries',
    callMethod(ownedObject, 7, ownedHglobalFormat, ownedHglobalMedium, 1) === 0 &&
    read(ownedHglobalMedium) === 0 && read(ownedHglobalReleaser + 4) === 1);

  const ownedStreamReleaserVtable = read(ownedStreamReleaser);
  const ownedStreamReleaserRelease = read(ownedStreamReleaserVtable + 8);
  write(ownedStreamReleaserVtable + 8, 0);
  check('final IDataObject Release validates every guest callback before teardown',
    callMethod(ownedObject, 2) === 1 && read(ownedObject + 4) === 1 &&
    read(ownedSequence) === 0 && read(ownedStream + 4) === 1 &&
    read(ownedStreamReleaser + 4) === 1 && read(ownedHglobalReleaser + 4) === 1);
  write(ownedStreamReleaserVtable + 8, ownedStreamReleaserRelease);
  check('final IDataObject Release tears down guest media in entry and COM order',
    callMethod(ownedObject, 2) === 0 &&
    read(ownedStream + 4) === 0 && read(ownedStream + 36) === 1 &&
    read(ownedStreamReleaser + 4) === 0 && read(ownedStreamReleaser + 36) === 2 &&
    read(ownedHglobalReleaser + 4) === 0 && read(ownedHglobalReleaser + 36) === 3 &&
    read(ownedHglobalPayload) === 0x78563412);

  const cacheSequence = alloc(4);
  write(cacheSequence, 0);
  const cacheRoot = e.test_ole_create_static_handler(0) >>> 0;
  const cacheInterface = cacheRoot + 52;
  const cacheFormat = alloc(20);
  write(cacheFormat, 0xc512);
  write(cacheFormat + 4, 0);
  write(cacheFormat + 8, 1);
  write(cacheFormat + 12, 0xffffffff);
  write(cacheFormat + 16, 1);
  const cachePayload = alloc(8);
  write(cachePayload, 0xa5a55a5a);
  const cacheReleaser = makeGuestSite(cacheSequence);
  const cacheMedium = alloc(12);
  write(cacheMedium, 1);
  write(cacheMedium + 4, cachePayload);
  write(cacheMedium + 8, cacheReleaser);
  check('IOleCache SetData transfers a DLL-private presentation releaser',
    callMethod(cacheInterface, 7, cacheFormat, cacheMedium, 1) === 0 &&
    read(cacheMedium) === 0 && read(cacheReleaser + 4) === 1);
  check('final static-handler Release runs guest cached-media teardown without an advise sink',
    callMethod(cacheInterface, 2) === 0 && read(cacheReleaser + 4) === 0 &&
    read(cacheReleaser + 12) === 1 && read(cacheReleaser + 36) === 1 &&
    read(cachePayload) === 0xa5a55a5a);

  const getDataObject = e.test_ole_create_data_object(0, 0) >>> 0;
  const getDataFormat = makeFormat(0xc519, 4);
  const getDataStream = makeGuestSite();
  const getDataReleaser = makeGuestSite();
  const getDataStoredMedium = alloc(12);
  write(getDataStoredMedium, 4);
  write(getDataStoredMedium + 4, getDataStream);
  write(getDataStoredMedium + 8, getDataReleaser);
  assert.strictEqual(callMethod(
    getDataObject, 7, getDataFormat, getDataStoredMedium, 1), 0);
  const getDataOut = alloc(12);
  write(getDataOut, 0xcccccccc);
  write(getDataOut + 4, 0xcccccccc);
  write(getDataOut + 8, 0xcccccccc);
  const getDataVtable = read(getDataStream);
  const getDataAddRef = read(getDataVtable + 4);
  write(getDataVtable + 4, 0);
  const malformedGetDataHr = callMethod(getDataObject, 3, getDataFormat, getDataOut);
  check('IDataObject GetData rejects a malformed guest AddRef before publishing output',
    malformedGetDataHr === 0x80004002 &&
    read(getDataOut) === 0 && read(getDataOut + 4) === 0 && read(getDataOut + 8) === 0 &&
    read(getDataStream + 4) === 1 && read(getDataStream + 8) === 0,
    `hr=0x${malformedGetDataHr.toString(16)} out=${read(getDataOut)},${read(getDataOut + 4)},${read(getDataOut + 8)} refs=${read(getDataStream + 4)} addrefs=${read(getDataStream + 8)}`);
  write(getDataVtable + 4, getDataAddRef);
  check('IDataObject GetData returns a DLL-private stream with a real guest AddRef',
    callMethod(getDataObject, 3, getDataFormat, getDataOut) === 0 &&
    read(getDataOut) === 4 && read(getDataOut + 4) === getDataStream &&
    read(getDataOut + 8) === 0 && read(getDataStream + 4) === 2 &&
    read(getDataStream + 8) === 1 && read(getDataReleaser + 4) === 1);
  releaseMedium(getDataOut);
  check('the returned guest stream reference releases independently of stored media',
    read(getDataStream + 4) === 1 && read(getDataStream + 12) === 1 &&
    read(getDataReleaser + 4) === 1 && read(getDataOut) === 0);
  assert.strictEqual(callMethod(getDataObject, 2), 0);
  assert.strictEqual(read(getDataStream + 4), 0);
  assert.strictEqual(read(getDataReleaser + 4), 0);

  const getStorageObject = e.test_ole_create_data_object(0, 0) >>> 0;
  const getStorageFormat = makeFormat(0xc51a, 8);
  const getStorageGuest = makeGuestSite();
  const getStorageStoredMedium = alloc(12);
  write(getStorageStoredMedium, 8);
  write(getStorageStoredMedium + 4, getStorageGuest);
  write(getStorageStoredMedium + 8, 0);
  assert.strictEqual(callMethod(
    getStorageObject, 7, getStorageFormat, getStorageStoredMedium, 1), 0);
  const getStorageOut = alloc(12);
  check('IDataObject GetData applies the same guest AddRef contract to IStorage',
    callMethod(getStorageObject, 3, getStorageFormat, getStorageOut) === 0 &&
    read(getStorageOut) === 8 && read(getStorageOut + 4) === getStorageGuest &&
    read(getStorageGuest + 4) === 2 && read(getStorageGuest + 8) === 1);
  releaseMedium(getStorageOut);
  assert.strictEqual(read(getStorageGuest + 4), 1);
  assert.strictEqual(callMethod(getStorageObject, 2), 0);
  assert.strictEqual(read(getStorageGuest + 4), 0);

  const retainedObject = e.test_ole_create_data_object(0, 0) >>> 0;
  const retainedFormat = makeFormat(0xc51b, 4);
  const retainedOld = makeGuestSite();
  const retainedMedium = alloc(12);
  write(retainedMedium, 4);
  write(retainedMedium + 4, retainedOld);
  write(retainedMedium + 8, 0);
  const retainedOldVtable = read(retainedOld);
  const retainedOldAddRef = read(retainedOldVtable + 4);
  write(retainedOldVtable + 4, 0);
  const malformedRetainHr = callMethod(
    retainedObject, 7, retainedFormat, retainedMedium, 0);
  check('IDataObject SetData(FALSE) rejects malformed guest AddRef atomically',
    malformedRetainHr === 0x80004002 && read(retainedObject + 16) === 0 &&
    read(retainedMedium) === 4 && read(retainedMedium + 4) === retainedOld &&
    read(retainedOld + 4) === 1 && read(retainedOld + 8) === 0,
    `hr=0x${malformedRetainHr.toString(16)} refs=${read(retainedOld + 4)} addrefs=${read(retainedOld + 8)}`);
  write(retainedOldVtable + 4, retainedOldAddRef);
  check('IDataObject SetData(FALSE) retains a DLL-private stream through guest AddRef',
    callMethod(retainedObject, 7, retainedFormat, retainedMedium, 0) === 0 &&
    read(retainedMedium) === 4 && read(retainedMedium + 4) === retainedOld &&
    read(retainedMedium + 8) === 0 && read(retainedOld + 4) === 2 &&
    read(retainedOld + 8) === 1 && read(retainedObject + 16) === 1);

  const retainedNew = makeGuestSite();
  const retainedNewMedium = alloc(12);
  write(retainedNewMedium, 4);
  write(retainedNewMedium + 4, retainedNew);
  write(retainedNewMedium + 8, 0);
  const retainedOldRelease = read(retainedOldVtable + 8);
  write(retainedOldVtable + 8, 0);
  const retainedRollbackHr = callMethod(
    retainedObject, 7, retainedFormat, retainedNewMedium, 0);
  check('failed SetData(FALSE) rolls guest AddRef back and preserves prior ownership',
    retainedRollbackHr === 0x80004002 && read(retainedObject + 16) === 1 &&
    read(retainedOld + 4) === 2 && read(retainedOld + 12) === 0 &&
    read(retainedNew + 4) === 1 && read(retainedNew + 8) === 1 &&
    read(retainedNew + 12) === 1 && read(retainedNewMedium) === 4 &&
    read(retainedNewMedium + 4) === retainedNew,
    `hr=0x${retainedRollbackHr.toString(16)} oldRefs=${read(retainedOld + 4)} newRefs=${read(retainedNew + 4)}`);
  write(retainedOldVtable + 8, retainedOldRelease);
  check('SetData(FALSE) replacement retires the old guest ref after retaining the new one',
    callMethod(retainedObject, 7, retainedFormat, retainedNewMedium, 0) === 0 &&
    read(retainedOld + 4) === 1 && read(retainedOld + 12) === 1 &&
    read(retainedNew + 4) === 2 && read(retainedNew + 8) === 2 &&
    read(retainedNew + 12) === 1 && read(retainedNewMedium) === 4);
  assert.strictEqual(callMethod(retainedObject, 2), 0);
  assert.strictEqual(read(retainedNew + 4), 1);
  assert.strictEqual(callMethod(retainedOld, 2), 0);
  assert.strictEqual(callMethod(retainedNew, 2), 0);

  const retainedCacheRoot = e.test_ole_create_static_handler(0) >>> 0;
  const retainedCache = retainedCacheRoot + 52;
  const retainedCacheFormat = makeFormat(0xc51c, 8);
  const retainedStorage = makeGuestSite();
  const retainedStorageMedium = alloc(12);
  write(retainedStorageMedium, 8);
  write(retainedStorageMedium + 4, retainedStorage);
  write(retainedStorageMedium + 8, 0);
  check('IOleCache SetData(FALSE) retains DLL-private storage without consuming input',
    callMethod(retainedCache, 7,
      retainedCacheFormat, retainedStorageMedium, 0) === 0 &&
    read(retainedStorageMedium) === 8 &&
    read(retainedStorageMedium + 4) === retainedStorage &&
    read(retainedStorage + 4) === 2 && read(retainedStorage + 8) === 1 &&
    read(retainedCacheRoot + 104) === 1);
  assert.strictEqual(callMethod(retainedCache, 2), 0);
  assert.strictEqual(read(retainedStorage + 4), 1);
  assert.strictEqual(callMethod(retainedStorage, 2), 0);

  const clipboardCacheRoot = e.test_ole_create_static_handler(0) >>> 0;
  const clipboardCache = clipboardCacheRoot + 52;
  const clipboardStreamFormat = makeFormat(0xc51d, 4);
  const clipboardStorageFormat = makeFormat(0xc51e, 8);
  const clipboardStream = makeGuestSite();
  const clipboardStorage = makeGuestSite();
  const clipboardStreamMedium = alloc(12);
  const clipboardStorageMedium = alloc(12);
  write(clipboardStreamMedium, 4);
  write(clipboardStreamMedium + 4, clipboardStream);
  write(clipboardStreamMedium + 8, 0);
  write(clipboardStorageMedium, 8);
  write(clipboardStorageMedium + 4, clipboardStorage);
  write(clipboardStorageMedium + 8, 0);
  assert.strictEqual(callMethod(clipboardCache, 7,
    clipboardStreamFormat, clipboardStreamMedium, 1), 0);
  assert.strictEqual(callMethod(clipboardCache, 7,
    clipboardStorageFormat, clipboardStorageMedium, 1), 0);
  const clipboardOut = alloc(4);
  write(clipboardOut, 0xcccccccc);
  const clipboardStorageVtable = read(clipboardStorage);
  const clipboardStorageAddRef = read(clipboardStorageVtable + 4);
  write(clipboardStorageVtable + 4, 0);
  const malformedClipboardHr = callMethod(
    clipboardCacheRoot, 10, 0, clipboardOut);
  check('GetClipboardData preflights every guest AddRef before retaining any entry',
    malformedClipboardHr === 0x80004002 && read(clipboardOut) === 0 &&
    read(clipboardStream + 4) === 1 && read(clipboardStream + 8) === 0 &&
    read(clipboardStorage + 4) === 1 && read(clipboardStorage + 8) === 0,
    `hr=0x${malformedClipboardHr.toString(16)} streamAddRefs=${read(clipboardStream + 8)} storageAddRefs=${read(clipboardStorage + 8)}`);
  write(clipboardStorageVtable + 4, clipboardStorageAddRef);
  const clipboardStorageRelease = read(clipboardStorageVtable + 8);
  write(clipboardStorageVtable + 8, 0);
  check('GetClipboardData also preflights the Release needed by the returned medium',
    callMethod(clipboardCacheRoot, 10, 0, clipboardOut) === 0x80004002 &&
    read(clipboardOut) === 0 && read(clipboardStream + 8) === 0 &&
    read(clipboardStorage + 8) === 0);
  write(clipboardStorageVtable + 8, clipboardStorageRelease);
  check('GetClipboardData AddRefs every DLL-private cached stream/storage entry',
    callMethod(clipboardCacheRoot, 10, 0, clipboardOut) === 0 &&
    read(clipboardOut) !== 0 && read(clipboardStream + 4) === 2 &&
    read(clipboardStream + 8) === 1 && read(clipboardStorage + 4) === 2 &&
    read(clipboardStorage + 8) === 1);
  const clipboardSnapshot = read(clipboardOut);
  const clipboardSnapshotEntries = read(clipboardSnapshot + 12);
  check('GetClipboardData publishes a complete two-entry snapshot with normal releasers',
    read(clipboardSnapshot + 16) === 2 &&
    read(clipboardSnapshotEntries + 20) === 4 &&
    read(clipboardSnapshotEntries + 24) === clipboardStream &&
    read(clipboardSnapshotEntries + 28) === 0 &&
    read(clipboardSnapshotEntries + 52) === 8 &&
    read(clipboardSnapshotEntries + 56) === clipboardStorage &&
    read(clipboardSnapshotEntries + 60) === 0);
  check('destroying the source cache leaves guest media owned by its snapshot',
    callMethod(clipboardCache, 2) === 0 &&
    read(clipboardStream + 4) === 1 && read(clipboardStream + 12) === 1 &&
    read(clipboardStorage + 4) === 1 && read(clipboardStorage + 12) === 1);
  check('final clipboard snapshot Release balances every retained guest medium',
    callMethod(clipboardSnapshot, 2) === 0 &&
    read(clipboardStream + 4) === 0 && read(clipboardStream + 12) === 2 &&
    read(clipboardStorage + 4) === 0 && read(clipboardStorage + 12) === 2);

  const initSource = e.test_ole_create_data_object(0, 0) >>> 0;
  const initStreamFormat = makeFormat(0xc51f, 4);
  const initStorageFormat = makeFormat(0xc525, 8);
  const initStream = makeGuestSite();
  const initStorage = makeGuestSite();
  const initStreamMedium = alloc(12);
  const initStorageMedium = alloc(12);
  write(initStreamMedium, 4);
  write(initStreamMedium + 4, initStream);
  write(initStreamMedium + 8, 0);
  write(initStorageMedium, 8);
  write(initStorageMedium + 4, initStorage);
  write(initStorageMedium + 8, 0);
  assert.strictEqual(callMethod(
    initSource, 7, initStreamFormat, initStreamMedium, 1), 0);
  assert.strictEqual(callMethod(
    initSource, 7, initStorageFormat, initStorageMedium, 1), 0);

  const initTarget = e.test_ole_create_static_handler(0) >>> 0;
  const initTargetCache = initTarget + 52;
  const initOldFormat = makeFormat(0xc526, 4);
  const initOld = makeGuestSite();
  const initOldMedium = alloc(12);
  write(initOldMedium, 4);
  write(initOldMedium + 4, initOld);
  write(initOldMedium + 8, 0);
  assert.strictEqual(callMethod(
    initTargetCache, 7, initOldFormat, initOldMedium, 1), 0);

  const initStorageVtable = read(initStorage);
  const initStorageAddRef = read(initStorageVtable + 4);
  write(initStorageVtable + 4, 0);
  check('InitFromData preflights every imported guest AddRef before changing cache state',
    callMethod(initTarget, 9, initSource, 0, 0) === 0x80004002 &&
    read(initTarget + 104) === 1 && read(initOld + 4) === 1 &&
    read(initStream + 4) === 1 && read(initStream + 8) === 0 &&
    read(initStorage + 4) === 1 && read(initStorage + 8) === 0);
  write(initStorageVtable + 4, initStorageAddRef);

  const initOldVtable = read(initOld);
  const initOldRelease = read(initOldVtable + 8);
  write(initOldVtable + 8, 0);
  check('InitFromData validates old guest cleanup before retaining new media',
    callMethod(initTarget, 9, initSource, 0, 0) === 0x80004002 &&
    read(initTarget + 104) === 1 && read(initOld + 4) === 1 &&
    read(initStream + 8) === 0 && read(initStorage + 8) === 0);
  write(initOldVtable + 8, initOldRelease);

  check('InitFromData retains all guest media, swaps atomically, and retires the old cache',
    callMethod(initTarget, 9, initSource, 0, 0) === 0 &&
    read(initTarget + 104) === 2 && read(initOld + 4) === 0 &&
    read(initOld + 12) === 1 && read(initStream + 4) === 2 &&
    read(initStream + 8) === 1 && read(initStorage + 4) === 2 &&
    read(initStorage + 8) === 1);
  const initEntries = read(initTarget + 100);
  check('InitFromData publishes normal independently releasable cache media',
    read(initEntries + 28) === 4 && read(initEntries + 32) === initStream &&
    read(initEntries + 36) === 0 && read(initEntries + 68) === 8 &&
    read(initEntries + 72) === initStorage && read(initEntries + 76) === 0);
  check('source and imported cache own balanced independent guest references',
    callMethod(initSource, 2) === 0 && read(initStream + 4) === 1 &&
    read(initStorage + 4) === 1 && callMethod(initTarget, 2) === 0 &&
    read(initStream + 4) === 0 && read(initStream + 12) === 2 &&
    read(initStorage + 4) === 0 && read(initStorage + 12) === 2);

  const replaceSequence = alloc(4);
  write(replaceSequence, 0);
  const replaceObject = e.test_ole_create_data_object(0, 0) >>> 0;
  const replaceFormat = makeFormat(0xc520, 5);
  const replaceStream = makeGuestSite(replaceSequence);
  const replaceReleaser = makeGuestSite(replaceSequence);
  const replaceOldMedium = alloc(12);
  write(replaceOldMedium, 4);
  write(replaceOldMedium + 4, replaceStream);
  write(replaceOldMedium + 8, replaceReleaser);
  assert.strictEqual(callMethod(replaceObject, 7, replaceFormat, replaceOldMedium, 1), 0);
  const replacementPayload = alloc(8);
  write(replacementPayload, 0x1234abcd);
  const replacementMedium = alloc(12);
  write(replacementMedium, 1);
  write(replacementMedium + 4, replacementPayload);
  write(replacementMedium + 8, 0);
  check('IDataObject SetData replacement asynchronously retires guest media in COM order',
    callMethod(replaceObject, 7, replaceFormat, replacementMedium, 1) === 0 &&
    read(replaceStream + 4) === 0 && read(replaceStream + 36) === 1 &&
    read(replaceReleaser + 4) === 0 && read(replaceReleaser + 36) === 2 &&
    read(replacementMedium) === 0 && read(replaceObject + 16) === 1);
  assert.strictEqual(callMethod(replaceObject, 2), 0);

  const atomicObject = e.test_ole_create_data_object(0, 0) >>> 0;
  const atomicFormat = makeFormat(0xc521);
  const atomicPayload = alloc(8);
  write(atomicPayload, 0x0badc0de);
  const atomicReleaser = makeGuestSite();
  const atomicOldMedium = alloc(12);
  write(atomicOldMedium, 1);
  write(atomicOldMedium + 4, atomicPayload);
  write(atomicOldMedium + 8, atomicReleaser);
  assert.strictEqual(callMethod(atomicObject, 7, atomicFormat, atomicOldMedium, 1), 0);
  const atomicNewPayload = alloc(8);
  write(atomicNewPayload, 0x55aa55aa);
  const atomicNewMedium = alloc(12);
  write(atomicNewMedium, 1);
  write(atomicNewMedium + 4, atomicNewPayload);
  write(atomicNewMedium + 8, 0);
  const atomicVtable = read(atomicReleaser);
  const atomicRelease = read(atomicVtable + 8);
  write(atomicVtable + 8, 0);
  check('IDataObject replacement rejects a malformed retired Release atomically',
    callMethod(atomicObject, 7, atomicFormat, atomicNewMedium, 1) === 0x80004002 &&
    read(atomicNewMedium) === 1 && read(atomicNewMedium + 4) === atomicNewPayload &&
    read(atomicReleaser + 4) === 1 && read(atomicReleaser + 12) === 0 &&
    read(atomicPayload) === 0x0badc0de && read(atomicObject + 16) === 1);
  write(atomicVtable + 8, atomicRelease);
  assert.strictEqual(callMethod(atomicObject, 7, atomicFormat, atomicNewMedium, 1), 0);
  assert.strictEqual(read(atomicReleaser + 4), 0);
  assert.strictEqual(callMethod(atomicObject, 2), 0);

  const textSequence = alloc(4);
  write(textSequence, 0);
  const textObject = e.test_ole_create_data_object(0, 0) >>> 0;
  const unrelatedTextFormat = makeFormat(0xc524, 4);
  const unrelatedTextStream = makeGuestSite(textSequence);
  const unrelatedTextReleaser = makeGuestSite(textSequence);
  const unrelatedTextMedium = alloc(12);
  write(unrelatedTextMedium, 4);
  write(unrelatedTextMedium + 4, unrelatedTextStream);
  write(unrelatedTextMedium + 8, unrelatedTextReleaser);
  assert.strictEqual(e.test_ole_data_set(
    textObject, unrelatedTextFormat, unrelatedTextMedium, 1), 0);
  const oldTextFormat = makeFormat(1);
  const oldTextPayload = alloc(8);
  bytes.set([0x6f, 0x6c, 0x64, 0], wa(oldTextPayload));
  const oldTextReleaser = makeGuestSite(textSequence);
  const oldTextMedium = alloc(12);
  write(oldTextMedium, 1);
  write(oldTextMedium + 4, oldTextPayload);
  write(oldTextMedium + 8, oldTextReleaser);
  assert.strictEqual(e.test_ole_data_set(textObject, oldTextFormat, oldTextMedium, 1), 0);
  const newTextPayload = alloc(8);
  bytes.set([0x6e, 0x65, 0x77, 0], wa(newTextPayload));
  const newTextMedium = alloc(12);
  write(newTextMedium, 1);
  write(newTextMedium + 4, newTextPayload);
  write(newTextMedium + 8, 0);
  check('canonical text synthesis retires replaced guest media and moves unrelated ownership intact',
    callMethod(textObject, 7, oldTextFormat, newTextMedium, 1) === 0 &&
    read(oldTextReleaser + 4) === 0 && read(oldTextReleaser + 12) === 1 &&
    read(unrelatedTextStream + 4) === 1 && read(unrelatedTextStream + 8) === 0 &&
    read(unrelatedTextStream + 12) === 0 && read(unrelatedTextReleaser + 4) === 1 &&
    read(textObject + 16) === 4 && read(newTextMedium) === 0);
  assert.strictEqual(callMethod(textObject, 2), 0);
  assert.strictEqual(read(unrelatedTextStream + 4), 0);
  assert.strictEqual(read(unrelatedTextReleaser + 4), 0);

  const inputTextObject = e.test_ole_create_data_object(0, 0) >>> 0;
  const inputTextFormat = makeFormat(1);
  const inputTextPayload = alloc(8);
  bytes.set([0x69, 0x6e, 0x70, 0], wa(inputTextPayload));
  const inputTextReleaser = makeGuestSite();
  const inputTextMedium = alloc(12);
  write(inputTextMedium, 1);
  write(inputTextMedium + 4, inputTextPayload);
  write(inputTextMedium + 8, inputTextReleaser);
  const inputTextVtable = read(inputTextReleaser);
  const inputTextRelease = read(inputTextVtable + 8);
  write(inputTextVtable + 8, 0);
  check('canonical text fRelease validates a guest releaser before publishing formats',
    callMethod(inputTextObject, 7, inputTextFormat, inputTextMedium, 1) === 0x80004002 &&
    read(inputTextObject + 16) === 0 && read(inputTextMedium) === 1 &&
    read(inputTextMedium + 4) === inputTextPayload && read(inputTextReleaser + 4) === 1);
  write(inputTextVtable + 8, inputTextRelease);
  check('canonical text fRelease completes its DLL-private input releaser asynchronously',
    callMethod(inputTextObject, 7, inputTextFormat, inputTextMedium, 1) === 0 &&
    read(inputTextMedium) === 0 && read(inputTextReleaser + 4) === 0 &&
    read(inputTextReleaser + 12) === 1 && read(inputTextPayload) === 0x00706e69);
  assert.strictEqual(callMethod(inputTextObject, 2), 0);

  const cacheMutationSequence = alloc(4);
  write(cacheMutationSequence, 0);
  const cacheMutationRoot = e.test_ole_create_static_handler(0) >>> 0;
  const cacheMutationInterface = cacheMutationRoot + 52;
  const cacheMutationFormat = makeFormat(0xc522, 5);
  const cacheMutationStream = makeGuestSite(cacheMutationSequence);
  const cacheMutationReleaser = makeGuestSite(cacheMutationSequence);
  const cacheMutationOld = alloc(12);
  write(cacheMutationOld, 4);
  write(cacheMutationOld + 4, cacheMutationStream);
  write(cacheMutationOld + 8, cacheMutationReleaser);
  assert.strictEqual(callMethod(cacheMutationInterface, 7,
    cacheMutationFormat, cacheMutationOld, 1), 0);
  const cacheMutationPayload = alloc(8);
  write(cacheMutationPayload, 0xcafef00d);
  const cacheMutationNew = alloc(12);
  write(cacheMutationNew, 1);
  write(cacheMutationNew + 4, cacheMutationPayload);
  write(cacheMutationNew + 8, 0);
  const cacheMutationVtable = read(cacheMutationReleaser);
  const cacheMutationRelease = read(cacheMutationVtable + 8);
  write(cacheMutationVtable + 8, 0);
  check('IOleCache SetData replacement rejects a malformed guest Release atomically',
    callMethod(cacheMutationInterface, 7, cacheMutationFormat, cacheMutationNew, 1) === 0x80004002 &&
    read(cacheMutationNew) === 1 && read(cacheMutationNew + 4) === cacheMutationPayload &&
    read(cacheMutationStream + 4) === 1 && read(cacheMutationReleaser + 4) === 1 &&
    read(cacheMutationRoot + 104) === 1);
  write(cacheMutationVtable + 8, cacheMutationRelease);
  check('IOleCache SetData replacement asynchronously retires guest media in COM order',
    callMethod(cacheMutationInterface, 7, cacheMutationFormat, cacheMutationNew, 1) === 0 &&
    read(cacheMutationStream + 4) === 0 && read(cacheMutationStream + 36) === 1 &&
    read(cacheMutationReleaser + 4) === 0 && read(cacheMutationReleaser + 36) === 2 &&
    read(cacheMutationNew) === 0 && read(cacheMutationRoot + 104) === 1);

  const uncacheFormat = makeFormat(0xc523);
  const uncachePayload = alloc(8);
  write(uncachePayload, 0xfaceb00c);
  const uncacheReleaser = makeGuestSite();
  const uncacheMedium = alloc(12);
  write(uncacheMedium, 1);
  write(uncacheMedium + 4, uncachePayload);
  write(uncacheMedium + 8, uncacheReleaser);
  assert.strictEqual(callMethod(cacheMutationInterface, 7, uncacheFormat, uncacheMedium, 1), 0);
  const uncacheEntries = read(cacheMutationRoot + 100);
  const uncacheConnection = read(uncacheEntries + 40);
  const uncacheVtable = read(uncacheReleaser);
  const uncacheRelease = read(uncacheVtable + 8);
  write(uncacheVtable + 8, 0);
  check('IOleCache Uncache rejects a malformed guest Release without removing its entry',
    callMethod(cacheMutationInterface, 4, uncacheConnection) === 0x80004002 &&
    read(cacheMutationRoot + 104) === 2 && read(uncacheReleaser + 4) === 1 &&
    read(uncacheReleaser + 12) === 0 && read(uncachePayload) === 0xfaceb00c);
  write(uncacheVtable + 8, uncacheRelease);
  check('IOleCache Uncache asynchronously releases and removes guest-owned media',
    callMethod(cacheMutationInterface, 4, uncacheConnection) === 0 &&
    read(cacheMutationRoot + 104) === 1 && read(uncacheReleaser + 4) === 0 &&
    read(uncacheReleaser + 12) === 1 && read(uncachePayload) === 0xfaceb00c);
  assert.strictEqual(callMethod(cacheMutationInterface, 2), 0);

  // Turn a normal emulator stream into a DLL-private-style interface by
  // copying its API-thunk vtable. Its object layout and method behavior stay
  // real, while ole_interface_is_local deliberately treats the new vtable as
  // external and therefore exercises Clone through suspended guest x86.
  const flushSource = e.test_ole_create_stream(0, 0) >>> 0;
  const localStreamVtable = read(flushSource);
  const guestStreamVtable = alloc(14 * 4);
  for (let i = 0; i < 14; i++) write(guestStreamVtable + i * 4, read(localStreamVtable + i * 4));
  // Wrap Clone in guest x86 and rewrite its returned local clone to the same
  // DLL-private-style vtable. Seek, CopyTo, and Release then all resume through
  // operation 17 instead of taking the local fast path.
  const guestCloneCode = alloc(40);
  bytes.set([
    0x8b, 0x44, 0x24, 0x08,       // mov eax,[esp+8] (ppstm)
    0x50,                         // push eax
    0x8b, 0x44, 0x24, 0x08,       // mov eax,[esp+8] (this after push)
    0x50,                         // push eax
    0xb8, 0, 0, 0, 0,             // mov eax,local Clone API thunk
    0xff, 0xd0,                   // call eax
    0x8b, 0x54, 0x24, 0x08,       // mov edx,[esp+8] (ppstm)
    0x8b, 0x12,                   // mov edx,[edx] (clone)
    0x8b, 0x4c, 0x24, 0x04,       // mov ecx,[esp+4] (source)
    0x8b, 0x09,                   // mov ecx,[ecx] (guest vtable)
    0x89, 0x0a,                   // mov [edx],ecx
    0xc2, 0x08, 0x00,             // ret 8
  ], wa(guestCloneCode));
  write(guestCloneCode + 11, read(localStreamVtable + 13 * 4));
  write(guestStreamVtable + 13 * 4, guestCloneCode);
  write(flushSource, guestStreamVtable);
  const flushBytes = Buffer.from('hello guest stream');
  const flushInput = alloc(flushBytes.length);
  bytes.set(flushBytes, wa(flushInput));
  const flushCount = alloc(4);
  assert.strictEqual(e.test_ole_stream_write(flushSource, flushInput, flushBytes.length, flushCount), 0);
  e.test_ole_stream_seek(flushSource, 6);
  // Keep one caller reference so the test can prove that final clipboard-owner
  // retirement releases only its own guest stream reference after publication.
  assert.strictEqual(e.test_ole_addref(flushSource), 2);
  const flushFormat = makeFormat(0xc524, 4);
  const flushMedium = alloc(12);
  write(flushMedium, 4);
  write(flushMedium + 4, flushSource);
  write(flushMedium + 8, 0);
  const flushOwner = e.test_ole_create_data_object(0, 0) >>> 0;
  assert.strictEqual(e.test_ole_data_set(flushOwner, flushFormat, flushMedium, 1), 0);
  e.test_ole_set_clipboard(flushOwner);
  assert.strictEqual(e.test_ole_release(flushOwner), 1);
  const flushHr = callApi('OleFlushClipboard');
  const durableOwner = e.test_ole_get_clipboard() >>> 0;
  const durableMedium = alloc(12);
  const durableGetHr = e.test_ole_data_get(durableOwner, flushFormat, durableMedium) >>> 0;
  const durableStream = read(durableMedium + 4);
  const durableOutput = alloc(flushBytes.length);
  e.test_ole_stream_seek(durableStream, 0);
  const durableReadHr = e.test_ole_stream_read(
    durableStream, durableOutput, flushBytes.length, flushCount) >>> 0;
  check('OleFlushClipboard deep-copies a DLL-private stream through Clone/Seek/CopyTo',
    flushHr === 0 && durableOwner !== flushOwner && durableGetHr === 0 &&
    durableStream !== flushSource && durableReadHr === 0 &&
    Buffer.from(bytes.subarray(wa(durableOutput), wa(durableOutput) + flushBytes.length)).equals(flushBytes));
  check('guest stream snapshot preserves the source position and retires only clipboard ownership',
    e.test_ole_stream_position(flushSource) === 6 && read(flushSource + 4) === 1);
  e.test_ole_stream_seek(durableStream, 6);
  check('durable stream starts at the original logical seek position',
    e.test_ole_stream_position(durableStream) === 6);
  const changedByte = alloc(1);
  bytes[wa(changedByte)] = '!'.charCodeAt(0);
  e.test_ole_stream_seek(flushSource, 0);
  assert.strictEqual(e.test_ole_stream_write(flushSource, changedByte, 1, flushCount), 0);
  e.test_ole_stream_seek(durableStream, 0);
  assert.strictEqual(e.test_ole_stream_read(
    durableStream, durableOutput, flushBytes.length, flushCount), 0);
  check('mutating the provider stream after flush cannot change the durable clipboard value',
    bytes[wa(durableOutput)] === 'h'.charCodeAt(0));
  e.test_ole_release_medium(durableMedium);
  assert.strictEqual(e.test_ole_release(durableOwner), 1);
  assert.strictEqual(e.test_ole_release(flushSource), 0);

  const rejectedSource = e.test_ole_create_stream(0, 0) >>> 0;
  const rejectedLocalVtable = read(rejectedSource);
  const rejectedGuestVtable = alloc(14 * 4);
  for (let i = 0; i < 14; i++) write(rejectedGuestVtable + i * 4, read(rejectedLocalVtable + i * 4));
  write(rejectedSource, rejectedGuestVtable);
  const rejectedClone = read(rejectedGuestVtable + 13 * 4);
  write(rejectedGuestVtable + 13 * 4, 0);
  const rejectedOwner = e.test_ole_create_data_object(0, 0) >>> 0;
  const rejectedGlobalFormat = makeFormat(0xc525, 1);
  const rejectedGlobalPayload = alloc(8);
  write(rejectedGlobalPayload, 0x12345678);
  const rejectedGlobalMedium = alloc(12);
  write(rejectedGlobalMedium, 1);
  write(rejectedGlobalMedium + 4, rejectedGlobalPayload);
  write(rejectedGlobalMedium + 8, 0);
  assert.strictEqual(e.test_ole_data_set(
    rejectedOwner, rejectedGlobalFormat, rejectedGlobalMedium, 1), 0);
  const rejectedStreamFormat = makeFormat(0xc526, 4);
  const rejectedStreamMedium = alloc(12);
  write(rejectedStreamMedium, 4);
  write(rejectedStreamMedium + 4, rejectedSource);
  write(rejectedStreamMedium + 8, 0);
  assert.strictEqual(e.test_ole_data_set(
    rejectedOwner, rejectedStreamFormat, rejectedStreamMedium, 1), 0);
  e.test_ole_set_clipboard(rejectedOwner);
  const rejectedHr = callApi('OleFlushClipboard');
  check('OleFlushClipboard rejects a malformed later guest format without partial publication',
    rejectedHr === 0x80004002 && e.clipboard_ole_data_object() === rejectedOwner &&
    e.test_ole_data_count(rejectedOwner) === 2 && read(rejectedGlobalPayload) === 0x12345678);
  const identityCloneCode = alloc(24);
  bytes.set([
    0x8b, 0x44, 0x24, 0x04,       // mov eax,[esp+4] (this)
    0xff, 0x40, 0x04,             // inc dword [eax+4] (returned reference)
    0x8b, 0x54, 0x24, 0x08,       // mov edx,[esp+8] (ppstm)
    0x89, 0x02,                   // mov [edx],eax
    0x31, 0xc0,                   // xor eax,eax (S_OK)
    0xc2, 0x08, 0x00,             // ret 8
  ], wa(identityCloneCode));
  write(rejectedGuestVtable + 13 * 4, identityCloneCode);
  e.test_ole_stream_seek(rejectedSource, 7);
  check('OleFlushClipboard rejects a non-independent Clone without moving or leaking the source',
    callApi('OleFlushClipboard') === 0x80004002 &&
    e.clipboard_ole_data_object() === rejectedOwner &&
    e.test_ole_stream_position(rejectedSource) === 7 && read(rejectedSource + 4) === 1);
  write(rejectedGuestVtable + 13 * 4, rejectedClone);
  e.test_ole_set_clipboard(0);
  assert.strictEqual(read(rejectedOwner + 4), 1);
  assert.strictEqual(callMethod(rejectedOwner, 2), 0);

  const flushStorageSource = e.test_ole_create_storage(0) >>> 0;
  const localStorageVtable = read(flushStorageSource);
  const guestStorageVtable = alloc(18 * 4);
  for (let i = 0; i < 18; i++) write(guestStorageVtable + i * 4, read(localStorageVtable + i * 4));
  write(flushStorageSource, guestStorageVtable);
  const rootStreamName = makeWide('RootData');
  const rootStream = e.test_ole_create_stream(flushStorageSource, rootStreamName) >>> 0;
  const rootStorageBytes = Buffer.from('root-storage-value');
  const rootStorageInput = alloc(rootStorageBytes.length);
  bytes.set(rootStorageBytes, wa(rootStorageInput));
  assert.strictEqual(e.test_ole_stream_write(
    rootStream, rootStorageInput, rootStorageBytes.length, flushCount), 0);
  assert.strictEqual(e.test_ole_release(rootStream), 1);
  const childName = makeWide('Nested');
  const leafName = makeWide('Leaf');
  const childStorage = e.test_ole_create_child_storage(flushStorageSource, childName) >>> 0;
  const leafStream = e.test_ole_create_stream(childStorage, leafName) >>> 0;
  const leafBytes = Buffer.from('recursive-leaf');
  const leafInput = alloc(leafBytes.length);
  bytes.set(leafBytes, wa(leafInput));
  assert.strictEqual(e.test_ole_stream_write(leafStream, leafInput, leafBytes.length, flushCount), 0);
  assert.strictEqual(e.test_ole_release(leafStream), 1);
  assert.strictEqual(e.test_ole_release(childStorage), 1);
  const storageClsid = alloc(16);
  write(storageClsid, 0x89abcdef);
  write(storageClsid + 4, 0x01234567);
  write(storageClsid + 8, 0x76543210);
  write(storageClsid + 12, 0xfedcba98);
  e.test_ole_set_class(flushStorageSource, storageClsid);
  assert.strictEqual(e.test_ole_storage_set_state_bits(
    flushStorageSource, 0x13579bdf, 0xffffffff), 0);
  assert.strictEqual(e.test_ole_addref(flushStorageSource), 2);
  const flushStorageFormat = makeFormat(0xc527, 8);
  const flushStorageMedium = alloc(12);
  write(flushStorageMedium, 8);
  write(flushStorageMedium + 4, flushStorageSource);
  write(flushStorageMedium + 8, 0);
  const flushStorageOwner = e.test_ole_create_data_object(0, 0) >>> 0;
  assert.strictEqual(e.test_ole_data_set(
    flushStorageOwner, flushStorageFormat, flushStorageMedium, 1), 0);
  e.test_ole_set_clipboard(flushStorageOwner);
  assert.strictEqual(e.test_ole_release(flushStorageOwner), 1);
  const flushStorageHr = callApi('OleFlushClipboard');
  const durableStorageOwner = e.test_ole_get_clipboard() >>> 0;
  const durableStorageMedium = alloc(12);
  assert.strictEqual(e.test_ole_data_get(
    durableStorageOwner, flushStorageFormat, durableStorageMedium), 0);
  const durableStorage = read(durableStorageMedium + 4);
  const durableRootStream = e.test_ole_find_stream(durableStorage, rootStreamName) >>> 0;
  const durableRootOutput = alloc(rootStorageBytes.length);
  e.test_ole_stream_seek(durableRootStream, 0);
  const durableRootReadHr = e.test_ole_stream_read(
    durableRootStream, durableRootOutput, rootStorageBytes.length, flushCount) >>> 0;
  const durableChild = e.test_ole_find_storage(durableStorage, childName) >>> 0;
  const durableLeaf = e.test_ole_find_stream(durableChild, leafName) >>> 0;
  const durableLeafOutput = alloc(leafBytes.length);
  e.test_ole_stream_seek(durableLeaf, 0);
  const durableLeafReadHr = e.test_ole_stream_read(
    durableLeaf, durableLeafOutput, leafBytes.length, flushCount) >>> 0;
  check('OleFlushClipboard recursively copies a DLL-private storage through guest Stat/CopyTo',
    flushStorageHr === 0 && durableStorageOwner !== flushStorageOwner &&
    durableStorage !== flushStorageSource && durableRootReadHr === 0 && durableLeafReadHr === 0 &&
    Buffer.from(bytes.subarray(
      wa(durableRootOutput), wa(durableRootOutput) + rootStorageBytes.length)).equals(rootStorageBytes) &&
    Buffer.from(bytes.subarray(
      wa(durableLeafOutput), wa(durableLeafOutput) + leafBytes.length)).equals(leafBytes));
  const durableStorageClsid = alloc(16);
  const durableStorageStat = alloc(72);
  e.test_ole_get_class(durableStorage, durableStorageClsid);
  assert.strictEqual(e.test_ole_fill_stat(durableStorage, durableStorageStat, 1), 0);
  check('guest storage flush preserves root CLSID and state bits',
    read(durableStorageClsid) === 0x89abcdef &&
    read(durableStorageClsid + 4) === 0x01234567 &&
    read(durableStorageClsid + 8) === 0x76543210 &&
    read(durableStorageClsid + 12) === 0xfedcba98 &&
    read(durableStorageStat + 64) === 0x13579bdf);
  check('guest storage owner retirement balances only its source reference',
    read(flushStorageSource + 4) === 1);
  const changedStorageByte = alloc(1);
  bytes[wa(changedStorageByte)] = '?'.charCodeAt(0);
  const mutableRootStream = e.test_ole_find_stream(flushStorageSource, rootStreamName) >>> 0;
  e.test_ole_stream_seek(mutableRootStream, 0);
  assert.strictEqual(e.test_ole_stream_write(mutableRootStream, changedStorageByte, 1, flushCount), 0);
  assert.strictEqual(e.test_ole_release(mutableRootStream), 1);
  e.test_ole_stream_seek(durableRootStream, 0);
  assert.strictEqual(e.test_ole_stream_read(
    durableRootStream, durableRootOutput, rootStorageBytes.length, flushCount), 0);
  check('mutating the provider storage after flush cannot change the durable tree',
    bytes[wa(durableRootOutput)] === 'r'.charCodeAt(0));
  assert.strictEqual(e.test_ole_release(durableLeaf), 1);
  assert.strictEqual(e.test_ole_release(durableChild), 1);
  assert.strictEqual(e.test_ole_release(durableRootStream), 1);
  e.test_ole_release_medium(durableStorageMedium);
  assert.strictEqual(e.test_ole_release(durableStorageOwner), 1);
  assert.strictEqual(e.test_ole_release(flushStorageSource), 0);

  console.log(`\n${checks}/${checks} guest COM callback checks passed`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});

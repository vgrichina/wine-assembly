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

  console.log(`\n${checks}/${checks} guest COM callback checks passed`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});

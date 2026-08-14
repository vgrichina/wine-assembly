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

  let checks = 0;
  const check = (name, condition) => {
    assert(condition, name);
    checks++;
    console.log(`PASS  ${name}`);
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

  console.log(`\n${checks}/${checks} guest COM callback checks passed`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});

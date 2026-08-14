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

  const makeGuestSite = () => {
    const code = alloc(64);
    const vtable = alloc(32);
    const site = alloc(24);
    const addRef = code;
    const release = code + 20;
    const saveObject = code + 40;
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
      0x8b, 0x40, 0x04,             // mov eax,[eax+4]
      0xc2, 0x04, 0x00,             // ret 4
    ], wa(release));
    bytes.set([
      0x8b, 0x44, 0x24, 0x04,       // mov eax,[esp+4]
      0xff, 0x40, 0x10,             // inc dword [eax+16] (SaveObject calls)
      0x8b, 0x40, 0x14,             // mov eax,[eax+20] (configured HRESULT)
      0xc2, 0x04, 0x00,             // ret 4
    ], wa(saveObject));
    write(vtable + 4, addRef);
    write(vtable + 8, release);
    write(vtable + 12, saveObject);
    write(site, vtable);
    write(site + 4, 1);
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
  check('client-site replacement AddRefs new before releasing old',
    callMethod(object, 3, siteB) === 0 &&
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

  const finalObject = e.test_ole_create_static_handler(0) >>> 0;
  const finalSite = makeGuestSite();
  assert.strictEqual(callMethod(finalObject, 3, finalSite), 0);
  check('final static-handler Release calls the owned guest client site first',
    callMethod(finalObject, 2) === 0 &&
    read(finalSite + 4) === 1 && read(finalSite + 12) === 1);

  console.log(`\n${checks}/${checks} guest COM callback checks passed`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});

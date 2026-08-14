#!/usr/bin/env node
'use strict';

// Exercise the public process-local ROT, its stable IEnumMoniker snapshots,
// and both emulator-local and DLL-private COM ownership paths.

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
  const exe = fs.readFileSync(path.join(ROOT, 'test', 'binaries', 'calc.exe'));
  new Uint8Array(memory.buffer).set(exe, e.get_staging());
  assert(e.load_pe(exe.length), 'fixture PE should initialize continuation thunks');
  e.init_dx_com_thunks();

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const wa = guest => (guest - imageBase + guestBase) >>> 0;
  const dv = new DataView(memory.buffer);
  const bytes = new Uint8Array(memory.buffer);
  const alloc = size => e.guest_alloc(size) >>> 0;
  const read = guest => e.guest_read32(guest) >>> 0;
  const write = (guest, value) => e.guest_write32(guest, value >>> 0);

  function writeWide(text) {
    const guest = alloc((text.length + 1) * 2);
    for (let i = 0; i < text.length; i++) dv.setUint16(wa(guest) + i * 2, text.charCodeAt(i), true);
    dv.setUint16(wa(guest) + text.length * 2, 0, true);
    return guest;
  }

  function readWide(guest, max = 32768) {
    let text = '';
    for (let i = 0; i < max; i++) {
      const code = dv.getUint16(wa(guest) + i * 2, true);
      if (!code) break;
      text += String.fromCharCode(code);
    }
    return text;
  }

  function writeComIid(data1, validSuffix = true) {
    const iid = alloc(16);
    write(iid, data1);
    write(iid + 4, 0);
    write(iid + 8, validSuffix ? 0x000000c0 : 0x000000c1);
    write(iid + 12, 0x46000000);
    return iid;
  }

  function runThunk(fn, args, label) {
    const savedEsp = e.get_esp() >>> 0;
    let esp = savedEsp;
    for (let i = args.length - 1; i >= 0; i--) {
      esp = (esp - 4) >>> 0;
      write(esp, args[i]);
    }
    esp = (esp - 4) >>> 0;
    write(esp, 0);
    e.set_esp(esp);
    e.set_eip(fn);
    for (let i = 0; i < 1000 && e.get_eip(); i++) e.run(5000);
    assert.strictEqual(e.get_eip(), 0, `${label} must terminate`);
    assert.strictEqual(e.get_esp() >>> 0, savedEsp, `${label} must balance stdcall stack`);
    return e.get_eax() >>> 0;
  }

  function callMethod(object, index, ...args) {
    const fn = read(read(object) + index * 4);
    assert(fn, `COM slot ${index} must have a callable thunk`);
    return runThunk(fn, [object, ...args], `COM slot ${index}`);
  }

  function callApi(name, ...args) {
    const api = apiTable.find(entry => entry.name === name);
    assert(api, `${name} must exist in api_table.json`);
    const thunkWa = 0x07112000;
    const thunkGuest = (thunkWa - guestBase + imageBase) >>> 0;
    const savedName = dv.getUint32(thunkWa, true);
    const savedId = dv.getUint32(thunkWa + 4, true);
    dv.setUint32(thunkWa + 4, api.id >>> 0, true);
    const result = runThunk(thunkGuest, args, name);
    dv.setUint32(thunkWa, savedName, true);
    dv.setUint32(thunkWa + 4, savedId, true);
    return result;
  }

  function createMoniker(text) {
    const out = alloc(4);
    assert.strictEqual(callApi('CreateFileMoniker', writeWide(text), out), 0);
    return read(out);
  }

  function createBindCtx() {
    const out = alloc(4);
    assert.strictEqual(callApi('CreateBindCtx', 0, out), 0);
    return read(out);
  }

  function createRot() {
    const out = alloc(4);
    assert.strictEqual(callApi('GetRunningObjectTable', 0, out), 0);
    return read(out);
  }

  function makeGuestUnknown({ queryInterface = true, addRef = true, release = true } = {}) {
    const code = alloc(80);
    const vtable = alloc(12);
    const object = alloc(20);
    bytes.fill(0, wa(code), wa(code) + 80);
    bytes.fill(0, wa(vtable), wa(vtable) + 12);
    bytes.fill(0, wa(object), wa(object) + 20);
    const queryFn = code;
    const addRefFn = code + 24;
    const releaseFn = code + 48;
    bytes.set([
      0x8b, 0x44, 0x24, 0x04, // mov eax,[esp+4]
      0x8b, 0x54, 0x24, 0x0c, // mov edx,[esp+12]
      0x89, 0x02,             // mov [edx],eax
      0xff, 0x40, 0x04,       // inc [eax+4]
      0xff, 0x40, 0x08,       // inc [eax+8]
      0x31, 0xc0,             // xor eax,eax
      0xc2, 0x0c, 0x00,       // ret 12
    ], wa(queryFn));
    bytes.set([
      0x8b, 0x44, 0x24, 0x04, // mov eax,[esp+4]
      0xff, 0x40, 0x04,       // inc [eax+4]
      0xff, 0x40, 0x08,       // inc [eax+8]
      0x8b, 0x40, 0x04,       // mov eax,[eax+4]
      0xc2, 0x04, 0x00,       // ret 4
    ], wa(addRefFn));
    bytes.set([
      0x8b, 0x44, 0x24, 0x04, // mov eax,[esp+4]
      0xff, 0x48, 0x04,       // dec [eax+4]
      0xff, 0x40, 0x0c,       // inc [eax+12]
      0x8b, 0x40, 0x04,       // mov eax,[eax+4]
      0xc2, 0x04, 0x00,       // ret 4
    ], wa(releaseFn));
    if (queryInterface) write(vtable, queryFn);
    if (addRef) write(vtable + 4, addRefFn);
    if (release) write(vtable + 8, releaseFn);
    write(object, vtable);
    write(object + 4, 1);
    return object;
  }

  let checks = 0;
  function check(name, condition) {
    assert(condition, name);
    checks++;
    console.log(`PASS  ${name}`);
  }

  const invalidOut = alloc(4);
  write(invalidOut, 0xcccccccc);
  check('GetRunningObjectTable validates reserved and output arguments',
    callApi('GetRunningObjectTable', 0, 0) === 0x80004003 &&
    callApi('GetRunningObjectTable', 1, invalidOut) === 0x80070057 && read(invalidOut) === 0);

  const rotA = createRot();
  const rotB = createRot();
  check('ROT wrappers expose ten slots and have independent interface lifetimes',
    rotA !== rotB &&
    Array.from({ length: 10 }, (_, index) => read(read(rotA) + index * 4)).every(Boolean));

  const objectA = createMoniker('C:\\objects\\first.rtf');
  const keyA = createMoniker('C:\\docs\\Shared.rtf');
  const cookieAOut = alloc(4);
  check('Register validates flags and all required arguments atomically',
    callMethod(rotA, 3, 4, objectA, keyA, cookieAOut) === 0x80070057 && read(cookieAOut) === 0 &&
    callMethod(rotA, 3, 0, 0, keyA, cookieAOut) === 0x80070057 && read(cookieAOut) === 0);
  check('Register retains local object and moniker with a stable nonzero cookie',
    callMethod(rotA, 3, 1, objectA, keyA, cookieAOut) === 0 &&
    read(cookieAOut) !== 0 && read(objectA + 4) === 2 && read(keyA + 4) === 2);
  const cookieA = read(cookieAOut);
  const bindCtx = createBindCtx();
  const bindOut = alloc(4);
  check('file-moniker binding queries the ROT and retains a local bound object',
    callMethod(keyA, 8, bindCtx, 0, writeComIid(0), bindOut) === 0 &&
    read(bindOut) === objectA && read(objectA + 4) === 4 &&
    callMethod(read(bindOut), 2) === 3);
  check('binding rejects unsupported interfaces and unregistered values without output',
    callMethod(keyA, 8, bindCtx, 0, writeComIid(0x7fffffff), bindOut) === 0x80004002 && read(bindOut) === 0 &&
    callMethod(createMoniker('C:\\missing-bind.rtf'), 8, bindCtx, 0, writeComIid(0), bindOut) === 0x800401ea && read(bindOut) === 0);

  const equivalentKey = createMoniker('c:/DOCS/shared.RTF');
  const equivalentRunning = callMethod(rotB, 5, equivalentKey);
  const missingRunning = callMethod(rotB, 5, createMoniker('C:\\missing.rtf'));
  check('IsRunning uses normalized moniker value across ROT wrappers',
    equivalentRunning === 0 && missingRunning === 1);
  const objectOut = alloc(4);
  check('GetObject returns an independently AddRefed registered object',
    callMethod(rotB, 6, equivalentKey, objectOut) === 0 && read(objectOut) === objectA &&
    read(objectA + 4) === 4 && callMethod(read(objectOut), 2) === 3);

  const timeOut = alloc(8);
  check('registration records an initial nonzero FILETIME',
    callMethod(rotA, 8, keyA, timeOut) === 0 && (read(timeOut) !== 0 || read(timeOut + 4) !== 0));
  const exactTime = alloc(8);
  write(exactTime, 0x12345678);
  write(exactTime + 4, 0x10203040);
  check('NoteChangeTime and value lookup preserve exact FILETIME bits',
    callMethod(rotB, 7, cookieA, exactTime) === 0 &&
    callMethod(rotA, 8, equivalentKey, timeOut) === 0 &&
    read(timeOut) === 0x12345678 && read(timeOut + 4) === 0x10203040);

  const objectB = createMoniker('C:\\objects\\second.rtf');
  const keyB = createMoniker('C:\\DOCS\\SHARED.RTF');
  const cookieBOut = alloc(4);
  check('duplicate moniker registration succeeds with warning and a distinct cookie',
    callMethod(rotB, 3, 0, objectB, keyB, cookieBOut) === 0x000401e7 &&
    read(cookieBOut) !== 0 && read(cookieBOut) !== cookieA);
  const cookieB = read(cookieBOut);
  check('newest duplicate is a deterministic lookup result',
    callMethod(rotA, 6, keyA, objectOut) === 0 && read(objectOut) === objectB &&
    callMethod(read(objectOut), 2) === 2);

  const enumOut = alloc(4);
  check('EnumRunning returns a seven-slot IEnumMoniker snapshot',
    callMethod(rotA, 9, enumOut) === 0 && read(enumOut) !== 0 &&
    Array.from({ length: 7 }, (_, index) => read(read(read(enumOut)) + index * 4)).every(Boolean));
  const enumerator = read(enumOut);
  check('Revoke removes only its cookie and balances duplicate ownership',
    callMethod(rotB, 4, cookieB) === 0 &&
    read(objectB + 4) === 1 && read(keyB + 4) === 2 && callMethod(rotA, 5, keyA) === 0);

  const values = alloc(8);
  const fetched = alloc(4);
  check('snapshot Next survives live revocation and returns caller-owned monikers',
    callMethod(enumerator, 3, 2, values, fetched) === 0 && read(fetched) === 2 &&
    read(values) === keyB && read(values + 4) === keyA);
  callMethod(read(values), 2);
  callMethod(read(values + 4), 2);
  const cloneOut = alloc(4);
  check('IEnumMoniker Reset, Skip, and Clone preserve independent cursors',
    callMethod(enumerator, 5) === 0 && callMethod(enumerator, 4, 1) === 0 &&
    callMethod(enumerator, 6, cloneOut) === 0 && callMethod(read(cloneOut), 5) === 0 &&
    callMethod(enumerator, 3, 1, values, 0) === 0 && read(values) === keyA &&
    callMethod(read(cloneOut), 3, 1, values + 4, 0) === 0 && read(values + 4) === keyB);
  callMethod(read(values), 2);
  callMethod(read(values + 4), 2);

  check('releasing ROT wrappers does not erase process-local registrations',
    callMethod(rotA, 2) === 0 && callMethod(rotB, 2) === 0 &&
    (() => {
      const rot = createRot();
      const running = callMethod(rot, 5, equivalentKey);
      callMethod(rot, 2);
      return running === 0;
    })());

  const guestRot = createRot();
  const guestObject = makeGuestUnknown();
  const guestKey = createMoniker('C:\\docs\\guest.rtf');
  const guestCookieOut = alloc(4);
  check('Register invokes DLL-private AddRef before publishing the cookie',
    callMethod(guestRot, 3, 1, guestObject, guestKey, guestCookieOut) === 0 &&
    read(guestCookieOut) !== 0 && read(guestObject + 4) === 2 && read(guestObject + 8) === 1);
  check('GetObject AddRefs a DLL-private result for its caller',
    callMethod(guestRot, 6, guestKey, objectOut) === 0 && read(objectOut) === guestObject &&
    read(guestObject + 4) === 3 && read(guestObject + 8) === 2 &&
    callMethod(guestObject, 2) === 2);
  check('file-moniker binding runs guest QueryInterface then retains the result',
    callMethod(guestKey, 8, bindCtx, 0, writeComIid(0), bindOut) === 0 &&
    read(bindOut) === guestObject && read(guestObject + 4) === 4 && read(guestObject + 8) === 4 &&
    callMethod(guestObject, 2) === 3);
  check('Revoke invokes DLL-private Release and removes the registration',
    callMethod(guestRot, 4, read(guestCookieOut)) === 0 &&
    read(guestObject + 4) === 2 && read(guestObject + 12) === 3 &&
    callMethod(guestRot, 5, guestKey) === 1);

  const malformedKey = createMoniker('C:\\docs\\malformed.rtf');
  const noAddRef = makeGuestUnknown({ addRef: false });
  const noRelease = makeGuestUnknown({ release: false });
  check('malformed DLL-private objects fail without a partial registration',
    callMethod(guestRot, 3, 0, noAddRef, malformedKey, guestCookieOut) === 0x80004002 &&
    callMethod(guestRot, 3, 0, noRelease, malformedKey, guestCookieOut) === 0x80004002 &&
    read(guestCookieOut) === 0 && callMethod(guestRot, 5, malformedKey) === 1);

  check('invalid cookies and absent timestamps return documented results',
    callMethod(guestRot, 4, 0x7fffffff) === 0x80070057 &&
    callMethod(guestRot, 7, 0x7fffffff, exactTime) === 0x80070057 &&
    callMethod(guestRot, 8, malformedKey, timeOut) === 1 && read(timeOut) === 0 && read(timeOut + 4) === 0);

  check('file-moniker IsRunning consults the shared ROT by value',
    callMethod(keyA, 15, bindCtx, 0, 0) === 0 &&
    callMethod(malformedKey, 15, bindCtx, 0, 0) === 1);
  check('file-moniker GetTimeOfLastChange delegates to retained ROT state',
    callMethod(keyA, 16, bindCtx, 0, timeOut) === 0 &&
    read(timeOut) === 0x12345678 && read(timeOut + 4) === 0x10203040);

  check('final revocation balances retained local references',
    callMethod(guestRot, 4, cookieA) === 0 &&
    read(objectA + 4) === 2 && read(keyA + 4) >= 2 &&
    callMethod(guestRot, 5, equivalentKey) === 1);
  check('snapshot destruction balances all retained monikers',
    callMethod(enumerator, 2) === 0 && callMethod(read(cloneOut), 2) === 0 &&
    read(keyA + 4) === 1 && read(keyB + 4) === 1);

  check('caller-owned objects and wrappers release cleanly',
    callMethod(guestRot, 2) === 0 && callMethod(bindCtx, 2) === 0 &&
    read(objectA + 4) === 1 && read(guestObject + 4) === 1 && callMethod(guestObject, 2) === 0 &&
    [objectA, keyA, equivalentKey, objectB, keyB, guestKey, malformedKey]
      .every(object => callMethod(object, 2) === 0));

  console.log(`\n${checks}/${checks} checks passed`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});

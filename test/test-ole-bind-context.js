#!/usr/bin/env node
'use strict';

// Exercise the public IBindCtx and IEnumString vtables, including ownership of
// both emulator-native and DLL-private guest COM objects.

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
    const argv = [...args, 0, 0, 0, 0].slice(0, 4);
    e.call_func(fn, argv[0], argv[1], argv[2], argv[3]);
    for (let i = 0; i < 500 && e.get_eip(); i++) e.run(5000);
    assert.strictEqual(e.get_eip(), 0, `${label} must terminate`);
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
    assert(args.length <= 4, `${name} exceeds call_func argument bridge`);
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

  function createBindCtx() {
    const out = alloc(4);
    write(out, 0xcccccccc);
    const hr = callApi('CreateBindCtx', 0, out);
    return { hr, object: read(out), out };
  }

  function createMoniker(text) {
    const out = alloc(4);
    assert.strictEqual(callApi('CreateFileMoniker', writeWide(text), out), 0);
    return read(out);
  }

  function makeGuestUnknown(sequence = 0, { addRef = true, release = true } = {}) {
    if (!sequence) {
      sequence = alloc(4);
      write(sequence, 0);
    }
    const code = alloc(64);
    const vtable = alloc(12);
    const object = alloc(24);
    bytes.fill(0, wa(code), wa(code) + 64);
    bytes.fill(0, wa(vtable), wa(vtable) + 12);
    bytes.fill(0, wa(object), wa(object) + 24);
    const addRefFn = code;
    const releaseFn = code + 20;
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
      0x8b, 0x50, 0x10,       // mov edx,[eax+16]
      0xff, 0x02,             // inc [edx]
      0x8b, 0x0a,             // mov ecx,[edx]
      0x89, 0x48, 0x14,       // mov [eax+20],ecx
      0x8b, 0x40, 0x04,       // mov eax,[eax+4]
      0xc2, 0x04, 0x00,       // ret 4
    ], wa(releaseFn));
    if (addRef) write(vtable + 4, addRefFn);
    if (release) write(vtable + 8, releaseFn);
    write(object, vtable);
    write(object + 4, 1);
    write(object + 16, sequence);
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
  check('CreateBindCtx validates the output pointer', callApi('CreateBindCtx', 0, 0) === 0x80004003);
  check('CreateBindCtx rejects nonzero reserved and clears output',
    callApi('CreateBindCtx', 1, invalidOut) === 0x80070057 && read(invalidOut) === 0);

  const created = createBindCtx();
  check('CreateBindCtx returns a caller-owned object', created.hr === 0 && created.object !== 0);
  const bindVtable = read(created.object);
  check('IBindCtx exposes all 13 callable slots',
    bindVtable !== 0 && Array.from({ length: 13 }, (_, index) => read(bindVtable + index * 4)).every(Boolean));

  const qiOut = alloc(4);
  check('IBindCtx QueryInterface validates the complete IID',
    callMethod(created.object, 0, writeComIid(0x0e), qiOut) === 0 && read(qiOut) === created.object &&
    callMethod(created.object, 2) === 1 &&
    callMethod(created.object, 0, writeComIid(0x0e, false), qiOut) === 0x80004002 && read(qiOut) === 0);

  const options = alloc(40);
  bytes.fill(0xcc, wa(options), wa(options) + 40);
  write(options, 16);
  check('GetBindOptions returns documented BIND_OPTS defaults',
    callMethod(created.object, 7, options) === 0 &&
    read(options) === 16 && read(options + 4) === 0 && read(options + 8) === 2 && read(options + 12) === 0 &&
    read(options + 16) === 0xcccccccc);
  write(options, 36);
  for (let offset = 4; offset < 36; offset += 4) write(options + offset, 0x1000 + offset);
  check('Set/GetBindOptions preserves every BIND_OPTS3 field',
    callMethod(created.object, 6, options) === 0 &&
    (() => {
      const output = alloc(36);
      write(output, 36);
      if (callMethod(created.object, 7, output) !== 0) return false;
      for (let offset = 4; offset < 36; offset += 4) {
        if (read(output + offset) !== 0x1000 + offset) return false;
      }
      return true;
    })());
  write(options, 20);
  check('bind option methods reject unsupported structure sizes',
    callMethod(created.object, 6, options) === 0x80070057 &&
    callMethod(created.object, 7, options) === 0x8000ffff);

  const bound = createMoniker('C:\\bound.rtf');
  check('duplicate RegisterObjectBound calls own duplicate references',
    read(bound + 4) === 1 &&
    callMethod(created.object, 3, bound) === 0 &&
    callMethod(created.object, 3, bound) === 0 && read(bound + 4) === 3);
  check('RevokeObjectBound removes one matching registration',
    callMethod(created.object, 4, bound) === 0 && read(bound + 4) === 2);
  check('ReleaseBoundObjects releases every remaining bound reference',
    callMethod(created.object, 5) === 0 && read(bound + 4) === 1 &&
    callMethod(created.object, 4, bound) === 0x800401e9);

  const valueA = createMoniker('C:\\value-a.rtf');
  const valueB = createMoniker('C:\\value-b.rtf');
  const keyName = writeWide('Name');
  const keyLower = writeWide('name');
  const keySecond = writeWide('Second');
  check('RegisterObjectParam retains its local COM value',
    callMethod(created.object, 9, keyName, valueA) === 0 && read(valueA + 4) === 2);
  const paramOut = alloc(4);
  check('object parameter keys are case-sensitive',
    callMethod(created.object, 10, keyLower, paramOut) === 0x80004005 && read(paramOut) === 0);
  check('GetObjectParam returns an independently AddRefed value',
    callMethod(created.object, 10, keyName, paramOut) === 0 && read(paramOut) === valueA &&
    read(valueA + 4) === 3 && callMethod(valueA, 2) === 2);
  check('parameter replacement retains new before releasing old',
    callMethod(created.object, 9, keyName, valueB) === 0 &&
    read(valueA + 4) === 1 && read(valueB + 4) === 2);
  check('a second parameter is independently retained',
    callMethod(created.object, 9, keySecond, valueA) === 0 && read(valueA + 4) === 2);

  const enumOut = alloc(4);
  check('EnumObjectParam returns a seven-slot IEnumString snapshot',
    callMethod(created.object, 11, enumOut) === 0 && read(enumOut) !== 0 &&
    Array.from({ length: 7 }, (_, index) => read(read(read(enumOut)) + index * 4)).every(Boolean));
  const stringEnum = read(enumOut);
  check('revoking a live parameter does not mutate an existing snapshot',
    callMethod(created.object, 12, keySecond) === 0 && read(valueA + 4) === 1);
  const names = alloc(8);
  const fetched = alloc(4);
  check('IEnumString Next returns caller-owned snapshot strings',
    callMethod(stringEnum, 3, 2, names, fetched) === 0 && read(fetched) === 2 &&
    readWide(read(names)) === 'Second' && readWide(read(names + 4)) === 'Name');
  callApi('CoTaskMemFree', read(names));
  callApi('CoTaskMemFree', read(names + 4));
  check('IEnumString Reset and partial Next report S_OK/S_FALSE exactly',
    callMethod(stringEnum, 5) === 0 &&
    callMethod(stringEnum, 3, 1, names, 0) === 0 && readWide(read(names)) === 'Second' &&
    callMethod(stringEnum, 3, 2, names, fetched) === 1 && read(fetched) === 1 && readWide(read(names)) === 'Name');
  callApi('CoTaskMemFree', read(names));
  const cloneOut = alloc(4);
  check('IEnumString Clone preserves an independent cursor',
    callMethod(stringEnum, 5) === 0 && callMethod(stringEnum, 4, 1) === 0 &&
    callMethod(stringEnum, 6, cloneOut) === 0 &&
    callMethod(read(cloneOut), 5) === 0 &&
    callMethod(stringEnum, 3, 1, names, 0) === 0 && readWide(read(names)) === 'Name');
  callApi('CoTaskMemFree', read(names));
  check('IEnumString QueryInterface and releases balance snapshot ownership',
    callMethod(stringEnum, 0, writeComIid(0x101), qiOut) === 0 && read(qiOut) === stringEnum &&
    callMethod(stringEnum, 2) === 1 && callMethod(stringEnum, 2) === 0 &&
    callMethod(read(cloneOut), 2) === 0);

  const rotOut = alloc(4);
  check('GetRunningObjectTable returns a reference-counted ten-slot interface',
    callMethod(created.object, 8, rotOut) === 0 && read(rotOut) !== 0 &&
    Array.from({ length: 10 }, (_, index) => read(read(read(rotOut)) + index * 4)).every(Boolean));
  const rot = read(rotOut);
  check('IRunningObjectTable QueryInterface and Release balance',
    callMethod(rot, 0, writeComIid(0x10), qiOut) === 0 && read(qiOut) === rot &&
    callMethod(rot, 2) === 1 && callMethod(rot, 2) === 0);

  const guestCtx = createBindCtx().object;
  const releaseSequence = alloc(4);
  write(releaseSequence, 0);
  const guestBound = makeGuestUnknown(releaseSequence);
  check('RegisterObjectBound invokes DLL-private AddRef for each duplicate',
    callMethod(guestCtx, 3, guestBound) === 0 &&
    callMethod(guestCtx, 3, guestBound) === 0 &&
    read(guestBound + 4) === 3 && read(guestBound + 8) === 2);
  check('guest bound revocation and bulk release invoke DLL-private Release',
    callMethod(guestCtx, 4, guestBound) === 0 &&
    callMethod(guestCtx, 5) === 0 &&
    read(guestBound + 4) === 1 && read(guestBound + 12) === 2);

  const guestOld = makeGuestUnknown(releaseSequence);
  const guestNew = makeGuestUnknown(releaseSequence);
  const guestKey = writeWide('GuestValue');
  check('guest parameter replacement AddRefs new and releases old',
    callMethod(guestCtx, 9, guestKey, guestOld) === 0 &&
    callMethod(guestCtx, 9, guestKey, guestNew) === 0 &&
    read(guestOld + 4) === 1 && read(guestOld + 12) === 1 &&
    read(guestNew + 4) === 2 && read(guestNew + 8) === 1);
  check('GetObjectParam AddRefs a DLL-private result for its caller',
    callMethod(guestCtx, 10, guestKey, paramOut) === 0 && read(paramOut) === guestNew &&
    read(guestNew + 4) === 3 && callMethod(guestNew, 2) === 2);
  check('final IBindCtx Release balances remaining guest ownership',
    callMethod(guestCtx, 2) === 0 && read(guestNew + 4) === 1 && read(guestNew + 12) === 2);

  const malformedCtx = createBindCtx().object;
  const noAddRef = makeGuestUnknown(0, { addRef: false });
  const noRelease = makeGuestUnknown(0, { release: false });
  check('malformed guest objects are rejected without partial registration',
    callMethod(malformedCtx, 3, noAddRef) === 0x80004002 &&
    callMethod(malformedCtx, 3, noRelease) === 0x80004002 &&
    read(noAddRef + 4) === 1 && read(noRelease + 4) === 1);

  check('object parameter revocation reports S_FALSE when absent',
    callMethod(created.object, 12, writeWide('Missing')) === 1);
  check('final context release balances every local parameter value',
    callMethod(created.object, 2) === 0 && read(valueB + 4) === 1);
  check('test-owned local objects release cleanly',
    callMethod(bound, 2) === 0 && callMethod(valueA, 2) === 0 && callMethod(valueB, 2) === 0 &&
    callMethod(malformedCtx, 2) === 0);

  console.log(`\n${checks}/${checks} checks passed`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});

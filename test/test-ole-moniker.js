#!/usr/bin/env node
'use strict';

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
  assert(e.load_pe(exe.length), 'fixture PE should initialize API continuation thunks');
  e.init_dx_com_thunks();

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const wa = guest => (guest - imageBase + guestBase) >>> 0;
  const dv = new DataView(memory.buffer);
  const alloc = bytes => e.guest_alloc(bytes) >>> 0;
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
    e.call_func(fn, args[0] || 0, args[1] || 0, args[2] || 0, args[3] || 0);
    for (let i = 0; i < 200 && e.get_eip(); i++) e.run(5000);
    assert.strictEqual(e.get_eip(), 0, `${label} must terminate`);
    return e.get_eax() >>> 0;
  }

  function callMethod(object, index, ...args) {
    const fn = read(read(object) + index * 4);
    assert(fn, `IMoniker slot ${index} must have an API thunk`);
    return runThunk(fn, [object, ...args], `IMoniker slot ${index}`);
  }

  function callApi(name, ...args) {
    const api = apiTable.find(entry => entry.name === name);
    assert(api, `${name} must exist in api_table.json`);
    assert(args.length <= 4, `${name} test call exceeds call_func argument bridge`);
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

  let checks = 0;
  function check(name, condition) {
    assert(condition, name);
    checks++;
    console.log(`PASS  ${name}`);
  }

  function createMoniker(pathText) {
    const out = alloc(4);
    write(out, 0xcccccccc);
    const hr = callApi('CreateFileMoniker', writeWide(pathText), out);
    return { hr, object: read(out), out };
  }

  const originalPath = 'C:\\Documents\\Mixed Case\\sample.rtf';
  const created = createMoniker(originalPath);
  check('CreateFileMoniker returns an object with caller ownership', created.hr === 0 && created.object !== 0);

  const vtable = read(created.object);
  check('file moniker exposes all 23 inherited IMoniker slots',
    vtable !== 0 && Array.from({ length: 23 }, (_, index) => read(vtable + index * 4)).every(Boolean));

  const displayOut = alloc(4);
  check('GetDisplayName returns a CoTaskMem-owned exact UTF-16 path',
    callMethod(created.object, 20, 0, 0, displayOut) === 0 &&
    read(displayOut) !== 0 && readWide(read(displayOut)) === originalPath);
  const firstDisplay = read(displayOut);
  dv.setUint16(wa(firstDisplay), 'X'.charCodeAt(0), true);
  callApi('CoTaskMemFree', firstDisplay);
  check('display-name buffers do not alias the immutable moniker value',
    callMethod(created.object, 20, 0, 0, displayOut) === 0 &&
    readWide(read(displayOut)) === originalPath);
  callApi('CoTaskMemFree', read(displayOut));

  const iidUnknown = writeComIid(0x00000000);
  const iidMoniker = writeComIid(0x0000000f);
  const iidPersist = writeComIid(0x0000010c);
  const iidPersistStream = writeComIid(0x00000109);
  const qiOut = alloc(4);
  for (const [name, iid] of [
    ['IUnknown', iidUnknown],
    ['IMoniker', iidMoniker],
    ['IPersist', iidPersist],
    ['IPersistStream', iidPersistStream],
  ]) {
    write(qiOut, 0);
    check(`QueryInterface exposes ${name}`,
      callMethod(created.object, 0, iid, qiOut) === 0 && read(qiOut) === created.object);
  }
  const malformedIid = writeComIid(0x0000000f, false);
  write(qiOut, 0xcccccccc);
  check('QueryInterface validates the complete IID suffix',
    callMethod(created.object, 0, malformedIid, qiOut) === 0x80004002 && read(qiOut) === 0);

  const clsid = alloc(16);
  check('GetClassID reports CLSID_FileMoniker exactly',
    callMethod(created.object, 3, clsid) === 0 &&
    read(clsid) === 0x00000303 && read(clsid + 4) === 0 &&
    read(clsid + 8) === 0x000000c0 && read(clsid + 12) === 0x46000000);
  check('immutable file monikers report clean IPersistStream state', callMethod(created.object, 4) === 1);

  const equivalent = createMoniker('c:/documents/mixed case/SAMPLE.RTF').object;
  const different = createMoniker('C:\\Documents\\other.rtf').object;
  check('IsEqual follows case-insensitive slash-neutral filename semantics',
    callMethod(created.object, 13, equivalent) === 0 && callMethod(equivalent, 13, created.object) === 0);
  check('IsEqual returns S_FALSE for a different file value', callMethod(created.object, 13, different) === 1);
  const hashA = alloc(4);
  const hashB = alloc(4);
  check('equal file monikers produce equal stable hashes',
    callMethod(created.object, 14, hashA) === 0 && callMethod(equivalent, 14, hashB) === 0 &&
    read(hashA) === read(hashB));

  const systemType = alloc(4);
  check('IsSystemMoniker identifies MKSYS_FILEMONIKER',
    callMethod(created.object, 22, systemType) === 0 && read(systemType) === 2);
  const enumOut = alloc(4);
  write(enumOut, 0xcccccccc);
  check('simple file monikers enumerate no composite components',
    callMethod(created.object, 12, 1, enumOut) === 0 && read(enumOut) === 0);
  const bindCtxOut = alloc(4);
  assert.strictEqual(callApi('CreateBindCtx', 0, bindCtxOut), 0);
  const bindCtx = read(bindCtxOut);
  check('unregistered file monikers report not running',
    callMethod(created.object, 15, bindCtx, 0, 0) === 1);
  assert.strictEqual(callMethod(bindCtx, 2), 0);

  const unsupportedOut = alloc(8);
  write(unsupportedOut, 0xcccccccc);
  write(unsupportedOut + 4, 0xcccccccc);
  check('persistence reports explicit E_NOTIMPL without fabricated size',
    callMethod(created.object, 7, unsupportedOut) === 0x80004001 &&
    read(unsupportedOut) === 0 && read(unsupportedOut + 4) === 0);
  write(unsupportedOut, 0xcccccccc);
  check('composition reports explicit E_NOTIMPL with a null result',
    callMethod(created.object, 11, different, 0, unsupportedOut) === 0x80004001 && read(unsupportedOut) === 0);
  write(unsupportedOut, 0xcccccccc);
  check('inverse reports MK_E_NOINVERSE with a null result',
    callMethod(created.object, 17, unsupportedOut) === 0x800401ec && read(unsupportedOut) === 0);
  write(unsupportedOut, 0xcccccccc);
  check('CommonPrefixWith reports MK_E_NOPREFIX until composition lands',
    callMethod(created.object, 18, different, unsupportedOut) === 0x800401ee && read(unsupportedOut) === 0);

  const nullOut = alloc(4);
  write(nullOut, 0xcccccccc);
  check('CreateFileMoniker rejects a null path without publishing an object',
    callApi('CreateFileMoniker', 0, nullOut) === 0x800401e4 && read(nullOut) === 0);
  write(nullOut, 0xcccccccc);
  check('CreateFileMoniker rejects an empty path without publishing an object',
    callApi('CreateFileMoniker', writeWide(''), nullOut) === 0x800401e4 && read(nullOut) === 0);
  check('CreateFileMoniker validates its output pointer',
    callApi('CreateFileMoniker', writeWide('C:\\valid.rtf'), 0) === 0x80004003);

  // Balance four successful QueryInterface calls, then the three creation refs.
  check('QueryInterface and creation references balance through final Release',
    callMethod(created.object, 2) === 4 &&
    callMethod(created.object, 2) === 3 &&
    callMethod(created.object, 2) === 2 &&
    callMethod(created.object, 2) === 1 &&
    callMethod(created.object, 2) === 0 &&
    callMethod(equivalent, 2) === 0 &&
    callMethod(different, 2) === 0);

  console.log(`\n${checks}/${checks} checks passed`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});

#!/usr/bin/env node
// The two DLL yield pumps in lib/process-boot.js, on a fake guest.
//
// Both hosts used to carry their own transcription of these, and the failure
// paths are the halves that differed: a LoadLibrary that finds nothing has to
// return 0 *and* resume the parked caller, while a COM DLL that is missing has
// to report REGDB_E_CLASSNOTREG and drop CoCreateInstance's five stdcall args.
// Get either wrong and the guest keeps running with a corrupted stack, which is
// the kind of bug that surfaces thousands of instructions later.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { mountLoadedDllFiles, stageAndLoadPe, readGuestCString,
  handleLoadLibraryYield, handleComDllYield } = require('../lib/process-boot');

function syntheticLargePe() {
  const bytes = Buffer.alloc(0x300);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.writeUInt32LE(0x00004550, 0x80);
  bytes.writeUInt16LE(1, 0x86);
  bytes.writeUInt16LE(0xe0, 0x94);
  bytes.writeUInt32LE(0x1000, 0x80 + 40);
  bytes.writeUInt32LE(0x400000, 0x80 + 52);
  const section = 0x80 + 24 + 0xe0;
  bytes.write('.rsrc\0\0\0', section, 'ascii');
  bytes.writeUInt32LE(0x100, section + 8);
  bytes.writeUInt32LE(0x1000, section + 12);
  bytes.writeUInt32LE(0x100, section + 16);
  bytes.writeUInt32LE(0x200, section + 20);
  // Packer-style combined CODE/IDATA/UDATA flags. UDATA does not make the
  // section BSS when PointerToRawData and SizeOfRawData describe real bytes.
  bytes.writeUInt32LE(0xe00000e0, section + 36);
  for (let i = 0x200; i < bytes.length; i++) bytes[i] = i & 0xff;
  return bytes;
}

function fakeGuest(name, { nameGetter }) {
  const memory = new ArrayBuffer(0x20000);
  const mem = new Uint8Array(memory);
  const at = 0x1000;
  for (let i = 0; i < name.length; i++) mem[at + i] = name.charCodeAt(i);
  const state = { eax: 0xdeadbeef, esp: 0x2000, eip: 0x401000, yield: 5, cleared: 0 };
  const exports = {
    get_image_base: () => 0x400000,
    get_eip: () => state.eip,
    set_eip: (v) => { state.eip = v; },
    get_esp: () => state.esp,
    set_esp: (v) => { state.esp = v; },
    set_eax: (v) => { state.eax = v >>> 0; },
    clear_yield: () => { state.yield = 0; state.cleared++; },
  };
  exports[nameGetter] = () => at;
  return { memory, exports, state, mem, at };
}

(async () => {
  const pageSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const hostSource = fs.readFileSync(path.join(__dirname, '..', 'host.js'), 'utf8');
  assert.match(pageSource, /lib\/process-boot\.js\?v=5/,
    'the browser must not reuse the loader that parsed oversized NE files as PE');
  assert.match(pageSource, /host\.js\?v=295/);
  assert.match(hostSource, /static SOURCE_VERSION = '295'/,
    'the current host imports need a matching browser artifact key');

  const peBytes = syntheticLargePe();
  const peMemory = new ArrayBuffer(0x5000);
  const peMem = new Uint8Array(peMemory);
  const peExports = {
    get_staging: () => 0x100,
    get_staging_size: () => 0x240,
    get_guest_base: () => 0x2000,
    load_pe: size => {
      assert.strictEqual(size, 0x240);
      assert.deepStrictEqual([...peMem.subarray(0x3040, 0x3080)], [...peBytes.subarray(0x240, 0x280)],
        'mixed UDATA section bytes beyond staging must exist before WAT processes imports/resources');
      return 0x401000;
    },
  };
  const stagedPe = stageAndLoadPe(peExports, peMemory, peBytes, () => {});
  assert.strictEqual(stagedPe.entry, 0x401000);
  assert.deepStrictEqual([...peMem.subarray(0x100, 0x140)], [...peBytes.subarray(0, 0x40)],
    'the bounded staging prefix is still copied normally');
  console.log('PASS  oversized PE section tails are prehydrated before WAT loading');

  const neBytes = Buffer.alloc(0x300, 0xa5);
  neBytes.writeUInt16LE(0x5a4d, 0);
  neBytes.writeUInt32LE(0x80, 0x3c);
  neBytes.writeUInt16LE(0x454e, 0x80);
  const neMemory = new ArrayBuffer(0x1000);
  const neMem = new Uint8Array(neMemory);
  const neLog = [];
  const stagedNe = stageAndLoadPe({
    get_staging: () => 0x100,
    get_staging_size: () => 0x240,
    load_pe: size => {
      assert.strictEqual(size, 0x240);
      assert.deepStrictEqual([...neMem.subarray(0x100, 0x340)], [...neBytes.subarray(0, 0x240)]);
      assert.strictEqual(neMem[0x340], 0, 'the appended self-extractor archive must not overflow staging');
      return 0x87000123;
    },
  }, neMemory, neBytes, message => neLog.push(message));
  assert.strictEqual(stagedNe.entry, 0x87000123);
  assert(neLog.some(message => message.includes('appended self-extractor data stays in the VFS')),
    'an oversized NE should take the Win16 overlay path instead of the PE parser');
  console.log('PASS  oversized NE self-extractor stages safely without PE parsing');

  const dllVfs = { files: new Map() };
  const stockShell = Uint8Array.of(0x4d, 0x5a, 0x90, 0);
  assert.strictEqual(mountLoadedDllFiles(dllVfs, [
    { name: 'SHELL32.DLL', bytes: stockShell },
  ]), 1);
  assert.strictEqual(dllVfs.files.get('c:\\shell32.dll').data, stockShell);
  assert.strictEqual(dllVfs.files.get('c:\\windows\\system\\shell32.dll').data, stockShell,
    'the file reopened by stock shell code must be the exact loaded PE bytes');
  console.log('PASS  loaded DLL bytes remain visible in the Win98 system directory');

  const g = fakeGuest('C:\\Plugins\\in_mp3.dll', { nameGetter: 'get_loadlib_name' });
  assert.strictEqual(readGuestCString(g.memory, g.at), 'C:\\Plugins\\in_mp3.dll');

  let asked = null;
  const missing = await handleLoadLibraryYield({
    exports: g.exports,
    memoryBuffer: g.memory,
    findDll: (fileName, fullName) => { asked = [fileName, fullName]; return null; },
  });
  assert.strictEqual(missing, null, 'a DLL that is not there loads nothing');
  assert.deepStrictEqual(asked, ['in_mp3.dll', 'C:\\Plugins\\in_mp3.dll'],
    'the lookup gets both the bare filename and the path the guest asked for');
  assert.strictEqual(g.state.eax, 0, 'LoadLibraryA returns NULL');
  assert.strictEqual(g.state.esp, 0x2000, 'the WAT handler already adjusted ESP; the pump must not touch it');
  assert.ok(g.state.cleared > 0 && g.state.yield === 0, 'the yield is cleared or the run loop spins');
  console.log('PASS  LoadLibrary yield: a missing DLL returns NULL and clears the yield');

  const empty = fakeGuest('', { nameGetter: 'get_loadlib_name' });
  empty.exports.get_loadlib_name = () => 0;
  await handleLoadLibraryYield({ exports: empty.exports, memoryBuffer: empty.memory, findDll: () => { throw new Error('should not be asked'); } });
  assert.strictEqual(empty.state.eax, 0, 'a nameless LoadLibrary still answers');
  assert.strictEqual(empty.state.yield, 0);
  console.log('PASS  LoadLibrary yield: a nameless request answers instead of hanging');

  const c = fakeGuest('shdocvw.dll', { nameGetter: 'get_com_dll_name' });
  const comMissing = await handleComDllYield({
    exports: c.exports,
    memoryBuffer: c.memory,
    findDll: () => null,
  });
  assert.strictEqual(comMissing, null);
  assert.strictEqual(c.state.eax, 0x80040154, 'CoCreateInstance reports REGDB_E_CLASSNOTREG');
  assert.strictEqual(c.state.esp, 0x2000 + 24, 'the failure path drops the return address and five stdcall args');
  assert.strictEqual(c.state.yield, 0);
  console.log('PASS  COM DLL yield: a missing in-proc server fails the call and unwinds its args');

  const throwing = fakeGuest('shdocvw.dll', { nameGetter: 'get_com_dll_name' });
  await handleComDllYield({
    exports: throwing.exports,
    memoryBuffer: throwing.memory,
    findDll: () => { throw new Error('network is down'); },
  });
  assert.strictEqual(throwing.state.eax, 0x80040154, 'a lookup that throws is a lookup that found nothing');
  assert.strictEqual(throwing.state.esp, 0x2000 + 24);
  console.log('PASS  COM DLL yield: a lookup that throws still leaves the guest runnable');
})();

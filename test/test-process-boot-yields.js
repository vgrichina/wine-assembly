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
const { readGuestCString, handleLoadLibraryYield, handleComDllYield } = require('../lib/process-boot');

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

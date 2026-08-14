#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWatSnapshot } = require('../lib/compile-wat');
const { loadDll } = require('../lib/dll-loader');

const ROOT = path.join(__dirname, '..');

function makeMinimalDll(totalSize, options = {}) {
  const bytes = Buffer.alloc(totalSize);
  const pe = 0x80;
  const opt = pe + 24;
  const section = opt + 0xe0;

  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(pe, 0x3c);
  bytes.writeUInt32LE(0x00004550, pe);
  bytes.writeUInt16LE(0x014c, pe + 4);
  bytes.writeUInt16LE(1, pe + 6);
  bytes.writeUInt16LE(0xe0, pe + 20);
  bytes.writeUInt16LE(0x210e, pe + 22);

  bytes.writeUInt16LE(0x010b, opt);
  const rawSize = options.wsockStartupOrdinal ? 0x400 : 0x200;
  bytes.writeUInt32LE(rawSize, opt + 4);
  bytes.writeUInt32LE(0x1000, opt + 16);
  bytes.writeUInt32LE(0x1000, opt + 20);
  bytes.writeUInt32LE(0x2000, opt + 24);
  bytes.writeUInt32LE(0x10000000, opt + 28);
  bytes.writeUInt32LE(0x1000, opt + 32);
  bytes.writeUInt32LE(0x200, opt + 36);
  bytes.writeUInt32LE(0x2000, opt + 56);
  bytes.writeUInt32LE(0x200, opt + 60);
  bytes.writeUInt16LE(2, opt + 68);
  bytes.writeUInt32LE(16, opt + 92);
  if (options.wsockStartupOrdinal) {
    bytes.writeUInt32LE(0x1100, opt + 104);
    bytes.writeUInt32LE(40, opt + 108);
  }

  bytes.write('.text\0\0\0', section, 'ascii');
  bytes.writeUInt32LE(rawSize, section + 8);
  bytes.writeUInt32LE(0x1000, section + 12);
  bytes.writeUInt32LE(rawSize, section + 16);
  bytes.writeUInt32LE(0x200, section + 20);
  bytes.writeUInt32LE(0x60000020, section + 36);
  Buffer.from([0xb8, 1, 0, 0, 0, 0xc2, 0x0c, 0]).copy(bytes, 0x200);
  if (options.wsockStartupOrdinal) {
    bytes.writeUInt32LE(0x1140, 0x300); // OriginalFirstThunk
    bytes.writeUInt32LE(0x1130, 0x30c); // DLL name RVA
    bytes.writeUInt32LE(0x1150, 0x310); // FirstThunk
    bytes.write('WSOCK32.dll\0', 0x330, 'ascii');
    bytes.writeUInt32LE(0x80000073, 0x340); // WSAStartup ordinal 115
    bytes.writeUInt32LE(0x80000073, 0x350);
  }
  return bytes;
}

async function main() {
  const wasm = await compileWatSnapshot(file =>
    fs.promises.readFile(path.join(ROOT, 'src', file), 'utf8'));
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const ctx = { exports: null, getMemory: () => memory.buffer, renderer: null, resourceJson: {} };
  const imports = createHostImports(ctx);
  imports.host.memory = memory;
  const module = await WebAssembly.compile(wasm);
  for (const entry of WebAssembly.Module.imports(module)) {
    imports[entry.module] = imports[entry.module] || {};
    if (entry.kind === 'function' && typeof imports[entry.module][entry.name] !== 'function') {
      imports[entry.module][entry.name] = () => 0;
    }
  }
  const instance = await WebAssembly.instantiate(module, imports);
  ctx.exports = instance.exports;
  const e = instance.exports;
  const dv = new DataView(memory.buffer);

  assert.strictEqual(e.get_staging_size() >>> 0, 0x00800000,
    'PE staging should have room for large Win98 resource DLLs');

  const first = loadDll(e, memory.buffer, makeMinimalDll(0x400));
  const table = e.get_dll_table() >>> 0;
  assert.strictEqual(dv.getUint32(table, true), first.loadAddr >>> 0,
    'first DLL metadata should be recorded');

  const second = loadDll(e, memory.buffer,
    makeMinimalDll(0x004c0800, { wsockStartupOrdinal: true }));
  assert.strictEqual(e.get_dll_count(), 2);
  assert.strictEqual(dv.getUint32(table, true), first.loadAddr >>> 0,
    'staging a 4.75MB resource DLL must not overwrite prior DLL metadata');
  assert.strictEqual(dv.getUint32(table + 32, true), second.loadAddr >>> 0,
    'large DLL metadata should occupy the next table entry');

  const imageBase = e.get_image_base() >>> 0;
  const entryWa = (second.dllMain >>> 0) - imageBase + 0x12000;
  assert.deepStrictEqual(Array.from(new Uint8Array(memory.buffer, entryWa, 8)),
    [0xb8, 1, 0, 0, 0, 0xc2, 0x0c, 0],
    'large DLL executable section should map from the intact staging buffer');

  const g2w = guest => (guest >>> 0) - imageBase + 0x12000;
  assert.strictEqual(Buffer.from(memory.buffer, 0x11300, 11).toString('ascii'), 'WSOCK32.dll',
    'static WinSock ordinal map should contain the DLL name');
  assert.strictEqual(Buffer.from(memory.buffer,
    g2w((second.loadAddr >>> 0) + 0x1130), 11).toString('ascii'), 'WSOCK32.dll',
    'synthetic large DLL should retain its import descriptor name');
  const iatThunk = dv.getUint32(g2w((second.loadAddr >>> 0) + 0x1150), true);
  const thunkWa = 0x07112000;
  assert.strictEqual(iatThunk, 0x07100000,
    'WSOCK32 ordinal import should point at the first host thunk');
  assert.strictEqual(dv.getUint32(thunkWa, true), 0x80000073,
    'host thunk should retain the source WSOCK32 ordinal');
  assert.strictEqual(dv.getUint32(thunkWa + 4, true), 923,
    'WSOCK32 ordinal 115 should resolve to the existing WSAStartup API ID');

  const wsadata = e.guest_alloc(400) >>> 0;
  const wsadataWa = g2w(wsadata);
  assert.strictEqual(e.test_call_WSAStartup(0x0101, wsadata), 0);
  assert.strictEqual(dv.getUint16(wsadataWa, true), 0x0101,
    'WinSock 1.1 request should negotiate wVersion 1.1');
  assert.strictEqual(dv.getUint16(wsadataWa + 2, true), 0x0202,
    'WinSock provider should advertise 2.2 as wHighVersion');
  assert.strictEqual(e.test_call_WSAStartup(0x0202, wsadata), 0);
  assert.strictEqual(dv.getUint16(wsadataWa, true), 0x0202,
    'WinSock 2.2 request should negotiate wVersion 2.2');

  assert.strictEqual(e.test_call_joyGetNumDevs(), 0,
    'joystick enumeration should report no attached devices');
  assert.strictEqual(e.test_call_joyGetDevCapsA(0, wsadata, 404), 6,
    'joystick capabilities should report MMSYSERR_NODRIVER');
  assert.strictEqual(e.test_call_joySetCapture(1, 0, 10, 1), 167,
    'joystick capture should report JOYERR_UNPLUGGED');
  assert.strictEqual(e.test_call_joyReleaseCapture(0), 0,
    'releasing an absent joystick capture should be harmless');
  assert.strictEqual(e.test_call_SetProcessWorkingSetSize(-1, -1, -1), 1,
    'fixed WASM memory should accept advisory process working-set trimming');

  assert.throws(() => loadDll(e, memory.buffer, Buffer.alloc(0x00800001)),
    /PE staging capacity/, 'oversized DLLs should fail before corrupting fixed memory');

  console.log('PASS  4.75MB DLL staging preserves metadata and executable sections');
  console.log('PASS  oversized DLL staging fails explicitly');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

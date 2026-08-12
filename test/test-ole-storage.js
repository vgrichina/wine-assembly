#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

async function main() {
  const wasm = await compileWat(file => fs.promises.readFile(path.join(SRC, file), 'utf8'));
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const ctx = { getMemory: () => memory.buffer, renderer: null, resourceJson: {} };
  const imports = createHostImports(ctx);
  imports.host.memory = memory;
  imports.host.create_thread = () => 0;
  imports.host.exit_thread = () => 0;
  imports.host.create_event = () => 0;
  imports.host.set_event = () => 0;
  imports.host.reset_event = () => 0;
  imports.host.wait_single = () => 0;
  imports.host.wait_multiple = () => 0;
  imports.host.com_create_instance = () => 0x80004002;

  const { instance } = await WebAssembly.instantiate(wasm, imports);
  const e = instance.exports;
  e.init_dx_com_thunks();
  const u8 = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  const wa = gp => gp - e.get_image_base() + e.get_guest_base();

  let passed = 0;
  let failed = 0;
  function check(name, ok, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
    if (ok) passed++; else failed++;
  }
  function alloc(bytes) { return e.guest_alloc(bytes); }
  function writeWide(text) {
    const gp = alloc((text.length + 1) * 2);
    for (let i = 0; i < text.length; i++) dv.setUint16(wa(gp) + i * 2, text.charCodeAt(i), true);
    dv.setUint16(wa(gp) + text.length * 2, 0, true);
    return gp;
  }
  function writeBytes(bytes) {
    const gp = alloc(bytes.length);
    u8.set(bytes, wa(gp));
    return gp;
  }

  const lockbytes = e.test_ole_create_lockbytes(0, 1) >>> 0;
  const storage = e.test_ole_create_storage(lockbytes) >>> 0;
  const name = writeWide('ObjectData');
  const stream = e.test_ole_create_stream(storage, name) >>> 0;
  check('creates distinct ILockBytes, IStorage and IStream objects',
    lockbytes !== 0 && storage !== 0 && stream !== 0 && new Set([lockbytes, storage, stream]).size === 3);

  const payload = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0x4f, 0x4c, 0x45, 0x21]);
  const input = writeBytes(payload);
  const count = alloc(4);
  const writeHr = e.test_ole_stream_write(stream, input, payload.length, count) >>> 0;
  check('IStream write grows the backing buffer', writeHr === 0 && dv.getUint32(wa(count), true) === payload.length && e.test_ole_stream_size(stream) === payload.length);

  e.test_ole_stream_seek(stream, 0);
  const output = alloc(16);
  u8.fill(0xcc, wa(output), wa(output) + 16);
  const readHr = e.test_ole_stream_read(stream, output, 16, count) >>> 0;
  const roundTrip = Array.from(u8.slice(wa(output), wa(output) + payload.length));
  check('IStream read returns S_FALSE at EOF with exact byte count', readHr === 1 && dv.getUint32(wa(count), true) === payload.length);
  check('IStream bytes round-trip without text transcoding', roundTrip.every((v, i) => v === payload[i]));

  const lookupName = writeWide('objectdata');
  const opened = e.test_ole_find_stream(storage, lookupName) >>> 0;
  check('IStorage opens named streams case-insensitively', opened === stream);
  e.test_ole_release(opened);

  const clsid = writeBytes(Uint8Array.from({ length: 16 }, (_, i) => i * 13 + 7));
  const clsidOut = alloc(16);
  e.test_ole_set_class(storage, clsid);
  e.test_ole_get_class(storage, clsidOut);
  check('IStorage persists the 16-byte class identifier',
    Array.from(u8.slice(wa(clsidOut), wa(clsidOut) + 16)).every((v, i) => v === u8[wa(clsid) + i]));

  check('COM reference counts are tracked', e.test_ole_addref(stream) === 3 && e.test_ole_release(stream) === 2);
  check('caller stream release preserves the storage-owned stream', e.test_ole_release(stream) === 1);

  const reopened = e.test_ole_find_stream(storage, name) >>> 0;
  e.test_ole_stream_seek(reopened, 0);
  const reread = alloc(payload.length);
  check('storage-owned stream remains readable after caller release',
    e.test_ole_stream_read(reopened, reread, payload.length, count) === 0 &&
    Array.from(u8.slice(wa(reread), wa(reread) + payload.length)).every((v, i) => v === payload[i]));
  e.test_ole_release(reopened);

  const globalPayload = writeBytes(Uint8Array.from([9, 8, 7, 6]));
  const globalStream = e.test_ole_create_hglobal_stream(globalPayload, 0) >>> 0;
  check('CreateStreamOnHGlobal exposes the caller HGLOBAL without copying',
    globalStream !== 0 && (e.test_ole_get_hglobal(globalStream) >>> 0) === globalPayload && e.test_ole_stream_size(globalStream) >= 4);
  e.test_ole_stream_seek(globalStream, 0);
  const globalOut = alloc(4);
  check('HGLOBAL-backed IStream reads the original allocation',
    e.test_ole_stream_read(globalStream, globalOut, 4, count) === 0 &&
    Array.from(u8.slice(wa(globalOut), wa(globalOut) + 4)).join(',') === '9,8,7,6');
  e.test_ole_release(globalStream);
  // fDeleteOnRelease=FALSE leaves ownership with the caller.
  u8[wa(globalPayload)] = 5;
  check('non-owning HGLOBAL stream leaves the caller allocation valid', u8[wa(globalPayload)] === 5);

  const createdGlobalStream = e.test_ole_create_hglobal_stream(0, 0) >>> 0;
  check('NULL HGLOBAL stream creates a stable backing handle',
    createdGlobalStream !== 0 && (e.test_ole_get_hglobal(createdGlobalStream) >>> 0) !== 0 && e.test_ole_stream_size(createdGlobalStream) === 0);
  e.test_ole_release(createdGlobalStream);

  e.test_ole_release(storage);
  e.test_ole_release(lockbytes);
  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed) process.exit(1);
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

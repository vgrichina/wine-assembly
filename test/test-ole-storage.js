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

  e.test_ole_stream_seek(stream, 3);
  const clone = e.test_ole_stream_clone(stream) >>> 0;
  check('IStream Clone returns a distinct interface at the source cursor',
    clone !== 0 && clone !== stream && e.test_ole_stream_position(clone) === 3);
  e.test_ole_stream_seek(stream, 0);
  check('cloned streams keep independent seek cursors',
    e.test_ole_stream_position(stream) === 0 && e.test_ole_stream_position(clone) === 3);

  const clonePatch = writeBytes(Uint8Array.from([0xaa, 0xbb]));
  check('writing through a clone updates the shared backing bytes',
    e.test_ole_stream_write(clone, clonePatch, 2, count) === 0 &&
    e.test_ole_stream_position(clone) === 5 && e.test_ole_stream_position(stream) === 0);
  const sharedOut = alloc(payload.length);
  check('the original stream observes clone writes without sharing its cursor',
    e.test_ole_stream_read(stream, sharedOut, payload.length, count) === 0 &&
    u8[wa(sharedOut) + 3] === 0xaa && u8[wa(sharedOut) + 4] === 0xbb);

  check('SetSize through a clone updates shared size',
    e.test_ole_stream_set_size(clone, 3) === 0 &&
    e.test_ole_stream_size(stream) === 3 && e.test_ole_stream_size(clone) === 3);
  check('shrinking does not clamp independent cursors',
    e.test_ole_stream_position(stream) === payload.length && e.test_ole_stream_position(clone) === 5);
  check('growing a previously shrunk stream zero-fills the exposed range',
    e.test_ole_stream_set_size(stream, 8) === 0 && e.test_ole_stream_size(clone) === 8 &&
    (() => {
      e.test_ole_stream_seek(clone, 3);
      const zeros = alloc(5);
      return e.test_ole_stream_read(clone, zeros, 5, count) === 0 &&
        Array.from(u8.slice(wa(zeros), wa(zeros) + 5)).every(byte => byte === 0);
    })());

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

  const folderName = writeWide('Folder');
  const childStorage = e.test_ole_create_child_storage(storage, folderName) >>> 0;
  const grandchildName = writeWide('Grandchild');
  const grandchildStorage = e.test_ole_create_child_storage(childStorage, grandchildName) >>> 0;
  const siblingName = writeWide('Sibling');
  const siblingStorage = e.test_ole_create_child_storage(storage, siblingName) >>> 0;
  check('IStorage creates independent nested and sibling storage nodes',
    childStorage !== 0 && grandchildStorage !== 0 && siblingStorage !== 0 &&
    e.test_ole_storage_parent(childStorage) === storage &&
    e.test_ole_storage_parent(grandchildStorage) === childStorage &&
    e.test_ole_storage_parent(siblingStorage) === storage);
  e.test_ole_release(siblingStorage);

  const foldedFolderName = writeWide('fOlDeR');
  const reopenedChild = e.test_ole_find_storage(storage, foldedFolderName) >>> 0;
  check('IStorage opens nested storages case-insensitively without confusing sibling links',
    reopenedChild === childStorage);
  e.test_ole_release(reopenedChild);

  const collisionName = writeWide('Element');
  const childStream = e.test_ole_create_stream(childStorage, collisionName) >>> 0;
  const foldedCollisionName = writeWide('eLeMeNt');
  check('streams and child storages share one case-insensitive element namespace',
    childStream !== 0 && e.test_ole_create_child_storage(childStorage, foldedCollisionName) === 0);
  e.test_ole_release(childStream);
  e.test_ole_release(grandchildStorage);

  check('COM reference counts include storage and clone ownership',
    e.test_ole_addref(stream) === 4 && e.test_ole_release(stream) === 3);
  check('caller stream release preserves storage and clone ownership', e.test_ole_release(stream) === 2);

  const reopened = e.test_ole_find_stream(storage, name) >>> 0;
  e.test_ole_stream_seek(reopened, 0);
  const reread = alloc(payload.length);
  check('storage-owned stream remains readable after caller release',
    e.test_ole_stream_read(reopened, reread, payload.length, count) === 0 &&
    Array.from(u8.slice(wa(reread), wa(reread) + 3)).every((v, i) => v === payload[i]) &&
    Array.from(u8.slice(wa(reread) + 3, wa(reread) + payload.length)).every(v => v === 0));
  e.test_ole_release(reopened);

  e.test_ole_release(storage);
  e.test_ole_stream_seek(clone, 0);
  const cloneAfterOriginalRelease = alloc(8);
  check('a clone keeps the shared backing alive after original and storage release',
    e.test_ole_stream_read(clone, cloneAfterOriginalRelease, 8, count) === 0 &&
    dv.getUint32(wa(count), true) === 8);
  e.test_ole_release(clone);

  const retainedGrandchild = e.test_ole_find_storage(childStorage, writeWide('GRANDCHILD')) >>> 0;
  check('a retained child storage survives root release with its subtree intact',
    e.test_ole_storage_parent(childStorage) === 0 && retainedGrandchild === grandchildStorage &&
    e.test_ole_storage_parent(retainedGrandchild) === childStorage);
  e.test_ole_release(retainedGrandchild);
  e.test_ole_release(childStorage);

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

  const owningGlobalStream = e.test_ole_create_hglobal_stream(0, 0) >>> 0;
  const owningGlobalClone = e.test_ole_stream_clone(owningGlobalStream) >>> 0;
  const ownedHandle = e.test_ole_get_hglobal(owningGlobalStream) >>> 0;
  check('HGLOBAL stream clones expose the same backing handle',
    owningGlobalClone !== 0 && (e.test_ole_get_hglobal(owningGlobalClone) >>> 0) === ownedHandle);
  e.test_ole_release(owningGlobalStream);
  check('an HGLOBAL clone retains its root after original interface release',
    (e.test_ole_get_hglobal(owningGlobalClone) >>> 0) === ownedHandle);
  e.test_ole_release(owningGlobalClone);

  e.test_ole_release(lockbytes);
  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed) process.exit(1);
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

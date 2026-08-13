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
  function readWide(gp, max = 256) {
    let text = '';
    for (let i = 0; i < max; i++) {
      const code = dv.getUint16(wa(gp) + i * 2, true);
      if (!code) break;
      text += String.fromCharCode(code);
    }
    return text;
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

  const renamedStreamName = writeWide('Payload');
  check('RenameElement updates a stream name without changing its identity',
    e.test_ole_rename_element(childStorage, foldedCollisionName, renamedStreamName) === 0 &&
    e.test_ole_find_stream(childStorage, foldedCollisionName) === 0 &&
    (() => {
      const renamed = e.test_ole_find_stream(childStorage, writeWide('pAyLoAd')) >>> 0;
      const same = renamed === childStream;
      if (renamed) e.test_ole_release(renamed);
      return same;
    })());
  check('RenameElement rejects a cross-type name collision',
    (e.test_ole_rename_element(childStorage, renamedStreamName, grandchildName) >>> 0) === 0x80030050);
  check('DestroyElement removes lookup ownership but preserves a retained stream',
    e.test_ole_destroy_element(childStorage, renamedStreamName) === 0 &&
    e.test_ole_find_stream(childStorage, renamedStreamName) === 0 &&
    e.test_ole_stream_set_size(childStream, 4) === 0 && e.test_ole_stream_size(childStream) === 4);
  check('DestroyElement reports a missing element',
    (e.test_ole_destroy_element(childStorage, renamedStreamName) >>> 0) === 0x80030002);
  e.test_ole_release(childStream);

  const renamedGrandchildName = writeWide('Nested');
  check('RenameElement updates a child storage name case-insensitively',
    e.test_ole_rename_element(childStorage, writeWide('GRANDCHILD'), renamedGrandchildName) === 0 &&
    e.test_ole_find_storage(childStorage, grandchildName) === 0 &&
    (() => {
      const renamed = e.test_ole_find_storage(childStorage, writeWide('nEsTeD')) >>> 0;
      const same = renamed === grandchildStorage;
      if (renamed) e.test_ole_release(renamed);
      return same;
    })());

  const detachedName = writeWide('Detached');
  const detachedStorage = e.test_ole_create_child_storage(childStorage, detachedName) >>> 0;
  const detachedStream = e.test_ole_create_stream(detachedStorage, writeWide('StillHere')) >>> 0;
  check('DestroyElement detaches a retained storage with its subtree intact',
    detachedStorage !== 0 && detachedStream !== 0 &&
    e.test_ole_destroy_element(childStorage, detachedName) === 0 &&
    e.test_ole_find_storage(childStorage, detachedName) === 0 &&
    e.test_ole_storage_parent(detachedStorage) === 0 &&
    (() => {
      const retained = e.test_ole_find_stream(detachedStorage, writeWide('stillhere')) >>> 0;
      const same = retained === detachedStream;
      if (retained) e.test_ole_release(retained);
      return same;
    })());
  e.test_ole_release(detachedStream);
  e.test_ole_release(detachedStorage);

  const copyStreamName = writeWide('CopyBytes');
  const copySourceStream = e.test_ole_create_stream(childStorage, copyStreamName) >>> 0;
  const copyPayload = writeBytes(Uint8Array.from([1, 2, 3, 4]));
  e.test_ole_stream_write(copySourceStream, copyPayload, 4, count);
  const nestedCopyStreamName = writeWide('NestedBytes');
  const nestedCopySource = e.test_ole_create_stream(grandchildStorage, nestedCopyStreamName) >>> 0;
  e.test_ole_stream_write(nestedCopySource, writeBytes(Uint8Array.from([8, 9])), 2, count);
  const copyDestination = e.test_ole_create_storage(0) >>> 0;
  check('IStorage CopyTo deep-copies mixed stream/storage trees',
    e.test_ole_copy_storage(childStorage, copyDestination) === 0 &&
    (() => {
      const copiedStream = e.test_ole_find_stream(copyDestination, writeWide('copybytes')) >>> 0;
      const copiedNested = e.test_ole_find_storage(copyDestination, writeWide('nested')) >>> 0;
      const copiedNestedStream = copiedNested
        ? e.test_ole_find_stream(copiedNested, writeWide('nestedbytes')) >>> 0 : 0;
      const ok = copiedStream !== 0 && copiedStream !== copySourceStream &&
        copiedNested !== 0 && copiedNested !== grandchildStorage && copiedNestedStream !== 0;
      if (copiedNestedStream) e.test_ole_release(copiedNestedStream);
      if (copiedNested) e.test_ole_release(copiedNested);
      if (copiedStream) e.test_ole_release(copiedStream);
      return ok;
    })());
  e.test_ole_stream_seek(copySourceStream, 0);
  e.test_ole_stream_write(copySourceStream, writeBytes(Uint8Array.from([0xee])), 1, count);
  const independentCopy = e.test_ole_find_stream(copyDestination, copyStreamName) >>> 0;
  e.test_ole_stream_seek(independentCopy, 0);
  const independentOut = alloc(1);
  check('IStorage CopyTo stream bytes are independent after the copy',
    e.test_ole_stream_read(independentCopy, independentOut, 1, count) === 0 &&
    u8[wa(independentOut)] === 1);
  e.test_ole_release(independentCopy);
  check('IStorage CopyTo rejects copying a tree into its own descendant',
    (e.test_ole_copy_storage(childStorage, grandchildStorage) >>> 0) === 0x80030005);
  e.test_ole_release(copySourceStream);
  e.test_ole_release(nestedCopySource);
  e.test_ole_release(copyDestination);

  const moveSource = e.test_ole_create_storage(0) >>> 0;
  const moveDestination = e.test_ole_create_storage(0) >>> 0;
  const moveStreamName = writeWide('MoveStream');
  const movedStreamName = writeWide('MovedStream');
  const moveStream = e.test_ole_create_stream(moveSource, moveStreamName) >>> 0;
  check('MoveElementTo transfers a stream without changing interface identity',
    e.test_ole_move_element(moveSource, moveStreamName, moveDestination, movedStreamName, 0) === 0 &&
    e.test_ole_find_stream(moveSource, moveStreamName) === 0 &&
    (() => {
      const moved = e.test_ole_find_stream(moveDestination, writeWide('movedstream')) >>> 0;
      const same = moved === moveStream;
      if (moved) e.test_ole_release(moved);
      return same;
    })());
  const moveFolderName = writeWide('MoveFolder');
  const movedFolderName = writeWide('MovedFolder');
  const moveFolder = e.test_ole_create_child_storage(moveSource, moveFolderName) >>> 0;
  check('MoveElementTo transfers a storage subtree without changing identity',
    e.test_ole_move_element(moveSource, moveFolderName, moveDestination, movedFolderName, 0) === 0 &&
    e.test_ole_storage_parent(moveFolder) === moveDestination &&
    e.test_ole_find_storage(moveSource, moveFolderName) === 0);
  check('MoveElementTo rejects cycles without unlinking the source storage',
    (e.test_ole_move_element(moveDestination, movedFolderName, moveFolder, writeWide('Cycle'), 0) >>> 0) === 0x80030005 &&
    e.test_ole_storage_parent(moveFolder) === moveDestination);
  const collisionStream = e.test_ole_create_stream(moveSource, writeWide('Occupied')) >>> 0;
  check('MoveElementTo rejects destination collisions without losing the source',
    (e.test_ole_move_element(moveSource, writeWide('Occupied'), moveDestination, movedFolderName, 0) >>> 0) === 0x80030050 &&
    e.test_ole_find_stream(moveSource, writeWide('occupied')) !== 0);
  const copiedMoveName = writeWide('CopiedMove');
  check('STGMOVE_COPY copies a stream while retaining the source element',
    e.test_ole_move_element(moveSource, writeWide('Occupied'), moveDestination, copiedMoveName, 1) === 0 &&
    e.test_ole_find_stream(moveSource, writeWide('occupied')) !== 0 &&
    e.test_ole_find_stream(moveDestination, writeWide('copiedmove')) !== 0);
  e.test_ole_release(collisionStream);
  e.test_ole_release(moveStream);
  e.test_ole_release(moveFolder);
  e.test_ole_release(moveSource);
  e.test_ole_release(moveDestination);

  const enumStorage = e.test_ole_create_storage(0) >>> 0;
  const enumAlphaName = writeWide('Alpha');
  const enumBetaName = writeWide('Beta');
  const enumFolderName = writeWide('EnumFolder');
  const enumAlpha = e.test_ole_create_stream(enumStorage, enumAlphaName) >>> 0;
  const enumBeta = e.test_ole_create_stream(enumStorage, enumBetaName) >>> 0;
  e.test_ole_stream_set_size(enumAlpha, 5);
  e.test_ole_stream_set_size(enumBeta, 2);
  const enumFolder = e.test_ole_create_child_storage(enumStorage, enumFolderName) >>> 0;
  const enumClsid = writeBytes(Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i));
  e.test_ole_set_class(enumFolder, enumClsid);
  const statEnum = e.test_ole_create_stat_enum(enumStorage) >>> 0;
  check('IStorage EnumElements creates a snapshot enumerator', statEnum !== 0);
  e.test_ole_rename_element(enumStorage, enumAlphaName, writeWide('AlphaNow'));
  e.test_ole_destroy_element(enumStorage, enumBetaName);
  e.test_ole_rename_element(enumStorage, enumFolderName, writeWide('FolderNow'));
  e.test_ole_release(enumAlpha);
  e.test_ole_release(enumBeta);
  e.test_ole_release(enumFolder);
  e.test_ole_release(enumStorage);

  const stats = alloc(72 * 4);
  const enumFetched = alloc(4);
  const enumHr = e.test_ole_stat_enum_next(statEnum, 4, stats, enumFetched) >>> 0;
  const fetchedStats = [];
  for (let i = 0; i < dv.getUint32(wa(enumFetched), true); i++) {
    const stat = stats + i * 72;
    const statName = dv.getUint32(wa(stat), true) >>> 0;
    fetchedStats.push({
      name: readWide(statName),
      type: dv.getUint32(wa(stat) + 4, true),
      size: dv.getUint32(wa(stat) + 8, true),
      clsid: Array.from(u8.slice(wa(stat) + 48, wa(stat) + 64)),
    });
    e.guest_free(statName);
  }
  check('IEnumSTATSTG Next returns S_FALSE with an exact partial fetched count',
    enumHr === 1 && fetchedStats.length === 3);
  check('IEnumSTATSTG snapshot preserves names, types, sizes and storage CLSID after live mutation',
    fetchedStats.some(s => s.name === 'Alpha' && s.type === 2 && s.size === 5) &&
    fetchedStats.some(s => s.name === 'Beta' && s.type === 2 && s.size === 2) &&
    fetchedStats.some(s => s.name === 'EnumFolder' && s.type === 1 &&
      s.clsid.every((v, i) => v === 0xa0 + i)));

  check('IEnumSTATSTG Reset and Skip update the snapshot cursor',
    e.test_ole_stat_enum_reset(statEnum) === 0 && e.test_ole_stat_enum_skip(statEnum, 1) === 0);
  const statEnumClone = e.test_ole_clone_stat_enum(statEnum) >>> 0;
  const oneStat = alloc(72);
  const cloneStat = alloc(72);
  const originalNextHr = e.test_ole_stat_enum_next(statEnum, 1, oneStat, 0) >>> 0;
  const cloneNextHr = e.test_ole_stat_enum_next(statEnumClone, 1, cloneStat, 0) >>> 0;
  const originalNamePtr = dv.getUint32(wa(oneStat), true) >>> 0;
  const cloneNamePtr = dv.getUint32(wa(cloneStat), true) >>> 0;
  check('IEnumSTATSTG Clone starts at the same cursor with independent name ownership',
    statEnumClone !== 0 && originalNextHr === 0 && cloneNextHr === 0 &&
    readWide(originalNamePtr) === readWide(cloneNamePtr) && originalNamePtr !== cloneNamePtr);
  e.guest_free(originalNamePtr);
  e.guest_free(cloneNamePtr);
  check('IEnumSTATSTG cloned cursors advance independently',
    e.test_ole_stat_enum_skip(statEnum, 1) === 0 &&
    e.test_ole_stat_enum_next(statEnum, 1, oneStat, 0) === 1 &&
    e.test_ole_stat_enum_next(statEnumClone, 1, cloneStat, 0) === 0);
  const cloneLastName = dv.getUint32(wa(cloneStat), true) >>> 0;
  e.guest_free(cloneLastName);
  e.test_ole_release(statEnumClone);
  e.test_ole_release(statEnum);
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

  const retainedGrandchild = e.test_ole_find_storage(childStorage, writeWide('NESTED')) >>> 0;
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

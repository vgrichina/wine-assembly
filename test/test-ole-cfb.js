#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const FREE = 0xffffffff;
const END = 0xfffffffe;

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
  const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
    if (ok) passed++; else failed++;
  };
  const alloc = bytes => e.guest_alloc(bytes);
  const writeWide = text => {
    const gp = alloc((text.length + 1) * 2);
    for (let i = 0; i < text.length; i++) dv.setUint16(wa(gp) + i * 2, text.charCodeAt(i), true);
    return gp;
  };
  const writeBytes = bytes => {
    const gp = alloc(bytes.length);
    u8.set(bytes, wa(gp));
    return gp;
  };
  const putStream = (storage, name, bytes) => {
    const stream = e.test_ole_create_stream(storage, writeWide(name)) >>> 0;
    const count = alloc(4);
    if (bytes.length) e.test_ole_stream_write(stream, writeBytes(bytes), bytes.length, count);
    return stream;
  };

  const lockbytes = e.test_ole_create_lockbytes(0, 1) >>> 0;
  const storage = e.test_ole_create_storage(lockbytes) >>> 0;
  const clsid = Uint8Array.from({ length: 16 }, (_, i) => 0x40 + i);
  e.test_ole_set_class(storage, writeBytes(clsid));
  e.test_ole_storage_set_state_bits(storage, 0x10203040, -1);
  const smallBytes = Uint8Array.from({ length: 130 }, (_, i) => (i * 17 + 3) & 0xff);
  const largeBytes = Uint8Array.from({ length: 5000 }, (_, i) => (i * 29 + 7) & 0xff);
  const nestedBytes = Uint8Array.from([9, 8, 7, 6, 5]);
  const small = putStream(storage, 'Small', smallBytes);
  const large = putStream(storage, 'Large', largeBytes);
  const child = e.test_ole_create_child_storage(storage, writeWide('Folder')) >>> 0;
  const nested = putStream(child, 'Nested', nestedBytes);
  const redChild = e.test_ole_create_child_storage(storage, writeWide('Zed')) >>> 0;
  const redBytes = Uint8Array.from([0xaa, 0xbb, 0xcc]);
  const redStream = putStream(redChild, 'RedStream', redBytes);

  const hr = e.test_ole_cfb_serialize(storage, lockbytes) >>> 0;
  const data = e.test_ole_lockbytes_data(lockbytes) >>> 0;
  const size = e.test_ole_lockbytes_size(lockbytes) >>> 0;
  const bytes = u8.slice(wa(data), wa(data) + size);
  const cfb = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  check('CFB writer serializes the in-memory storage tree', hr === 0 && size >= 512);
  check('CFB header has the v3 signature and byte/sector orders',
    Array.from(bytes.slice(0, 8)).join(',') === '208,207,17,224,161,177,26,225' &&
    cfb.getUint16(26, true) === 3 && cfb.getUint16(28, true) === 0xfffe &&
    cfb.getUint16(30, true) === 9 && cfb.getUint16(32, true) === 6);

  const sector = id => bytes.subarray(512 + id * 512, 1024 + id * 512);
  const fatSectorCount = cfb.getUint32(44, true);
  const fat = [];
  for (let i = 0; i < fatSectorCount; i++) {
    const sid = cfb.getUint32(76 + i * 4, true);
    const view = new DataView(sector(sid).buffer, sector(sid).byteOffset, 512);
    for (let j = 0; j < 128; j++) fat.push(view.getUint32(j * 4, true));
  }
  const readChain = (first, table, unit, source) => {
    const chunks = [];
    const seen = new Set();
    let id = first >>> 0;
    while (id !== END) {
      if (id === FREE || id >= table.length || seen.has(id)) throw new Error(`invalid chain ${id.toString(16)}`);
      seen.add(id);
      chunks.push(source(id));
      id = table[id] >>> 0;
    }
    const result = new Uint8Array(chunks.length * unit);
    chunks.forEach((chunk, i) => result.set(chunk, i * unit));
    return result;
  };
  const dirBytes = readChain(cfb.getUint32(48, true), fat, 512, sector);
  const directories = [];
  for (let offset = 0; offset + 128 <= dirBytes.length; offset += 128) {
    const view = new DataView(dirBytes.buffer, dirBytes.byteOffset + offset, 128);
    const nameBytes = view.getUint16(64, true);
    const type = view.getUint8(66);
    if (!type) continue;
    let name = '';
    for (let i = 0; i + 2 < nameBytes; i += 2) name += String.fromCharCode(view.getUint16(i, true));
    directories.push({
      name, type,
      color: view.getUint8(67),
      left: view.getUint32(68, true),
      right: view.getUint32(72, true),
      child: view.getUint32(76, true),
      start: view.getUint32(116, true),
      size: view.getUint32(120, true),
      clsid: Array.from(new Uint8Array(view.buffer, view.byteOffset + 80, 16)),
      state: view.getUint32(96, true),
    });
  }
  const byName = name => directories.find(entry => entry.name === name);
  check('CFB directory preserves root, storage and stream identities',
    byName('Root Entry')?.type === 5 && byName('Folder')?.type === 1 && byName('Zed')?.type === 1 &&
    byName('Small')?.type === 2 && byName('Large')?.type === 2 && byName('Nested')?.type === 2);
  const collectTree = first => {
    const ids = [];
    const visit = id => {
      if (id === FREE) return;
      if (id >= directories.length) throw new Error(`invalid directory id ${id}`);
      visit(directories[id].left);
      ids.push(id);
      visit(directories[id].right);
    };
    visit(first);
    return ids;
  };
  const rootChildren = collectTree(directories[0].child).map(id => directories[id].name).sort();
  const folderId = directories.findIndex(entry => entry.name === 'Folder');
  const folderChildren = collectTree(directories[folderId].child).map(id => directories[id].name);
  const zedId = directories.findIndex(entry => entry.name === 'Zed');
  const zedChildren = collectTree(directories[zedId].child).map(id => directories[id].name);
  check('CFB directory sibling trees retain root and nested parentage',
    rootChildren.join(',') === 'Folder,Large,Small,Zed' && folderChildren.join(',') === 'Nested' &&
    zedChildren.join(',') === 'RedStream');
  const validateRedBlack = first => {
    const walk = id => {
      if (id === FREE) return 1;
      const node = directories[id];
      const leftBlack = walk(node.left);
      const rightBlack = walk(node.right);
      if (leftBlack !== rightBlack) throw new Error(`black-height mismatch at ${node.name}`);
      if (node.color === 0 &&
          ((node.left !== FREE && directories[node.left].color === 0) ||
           (node.right !== FREE && directories[node.right].color === 0))) {
        throw new Error(`red-red edge at ${node.name}`);
      }
      return leftBlack + (node.color === 1 ? 1 : 0);
    };
    if (first !== FREE && directories[first].color !== 1) throw new Error('directory root is not black');
    return walk(first) > 0;
  };
  check('CFB directory sibling links form valid red-black trees',
    validateRedBlack(directories[0].child) && validateRedBlack(directories[folderId].child) &&
    validateRedBlack(directories[zedId].child));
  check('CFB root directory preserves CLSID and state bits',
    byName('Root Entry').clsid.every((value, i) => value === clsid[i]) &&
    byName('Root Entry').state === 0x10203040);

  const miniFatFirst = cfb.getUint32(60, true);
  const miniFatCount = cfb.getUint32(64, true);
  const miniFatBytes = miniFatCount ? readChain(miniFatFirst, fat, 512, sector) : new Uint8Array();
  const miniFatView = new DataView(miniFatBytes.buffer, miniFatBytes.byteOffset, miniFatBytes.byteLength);
  const miniFat = Array.from({ length: miniFatBytes.length / 4 }, (_, i) => miniFatView.getUint32(i * 4, true));
  const rootMini = byName('Root Entry');
  const miniStream = rootMini.size ? readChain(rootMini.start, fat, 512, sector).subarray(0, rootMini.size) : new Uint8Array();
  const readPayload = entry => entry.size < 4096
    ? readChain(entry.start, miniFat, 64, id => miniStream.subarray(id * 64, id * 64 + 64)).subarray(0, entry.size)
    : readChain(entry.start, fat, 512, sector).subarray(0, entry.size);
  check('CFB mini-FAT round-trips multiple small-stream chains',
    Array.from(readPayload(byName('Small'))).every((value, i) => value === smallBytes[i]) &&
    Array.from(readPayload(byName('Nested'))).every((value, i) => value === nestedBytes[i]) &&
    Array.from(readPayload(byName('RedStream'))).every((value, i) => value === redBytes[i]));
  check('CFB FAT round-trips a multi-sector regular stream chain',
    Array.from(readPayload(byName('Large'))).every((value, i) => value === largeBytes[i]));

  e.test_ole_release(nested);
  e.test_ole_release(redStream);
  e.test_ole_release(redChild);
  e.test_ole_release(child);
  e.test_ole_release(small);
  e.test_ole_release(large);
  e.test_ole_release(storage);
  e.test_ole_release(lockbytes);
  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

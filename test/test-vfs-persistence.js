#!/usr/bin/env node
const assert = require('assert');
const { VirtualFS } = require('../lib/filesystem');
const VfsPersistence = require('../lib/vfs-persistence');

class MemoryStorage {
  constructor() { this.values = new Map(); }
  get length() { return this.values.size; }
  key(index) { return Array.from(this.values.keys())[index] || null; }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

async function run() {
  const storage = new MemoryStorage();
  const first = new VirtualFS();
  const persistence = VfsPersistence.attach(first, {
    appId: 'diablo_demo',
    patterns: ['c:\\save\\*.sav'],
    storage,
  });
  assert.strictEqual(persistence.restored, 0);

  const ignored = first.createFile('C:\\TEMP\\scratch.tmp', 0x40000000, 2);
  first.writeFile(ignored, Uint8Array.from([9, 9]), 2);
  const save = first.createFile('C:\\Save\\Game00.sav', 0x40000000, 2);
  first.writeFile(save, Uint8Array.from([1, 2, 3, 4]), 4);
  await Promise.resolve();
  assert.strictEqual(storage.length, 1, 'only opted-in save paths reach browser storage');

  const second = new VirtualFS();
  const restored = VfsPersistence.attach(second, {
    appId: 'diablo_demo',
    patterns: ['c:\\save\\*.sav'],
    storage,
  });
  assert.strictEqual(restored.restored, 1, 'a later process restores the saved file');
  assert.deepStrictEqual(Array.from(second.files.get('c:\\save\\game00.sav').data), [1, 2, 3, 4]);

  second.deleteFile('c:\\save\\game00.sav');
  restored.flush();
  assert.strictEqual(storage.length, 0, 'deleting a save removes its persisted copy');

  const bounded = new VirtualFS();
  VfsPersistence.attach(bounded, {
    appId: 'diablo_demo',
    patterns: ['c:\\save\\*.sav'],
    maxFileBytes: 3,
    storage,
  });
  const tooLarge = bounded.createFile('c:\\save\\level1.sav', 0x40000000, 2);
  bounded.writeFile(tooLarge, Uint8Array.from([1, 2, 3, 4]), 4);
  await Promise.resolve();
  assert.strictEqual(storage.length, 0, 'oversized files are not written to localStorage');

  console.log('PASS  Browser VFS persistence restores only bounded opt-in app files');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});

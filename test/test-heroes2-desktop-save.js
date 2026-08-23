#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { APPS, DESKTOP_APPS, LOCAL_CANDIDATE_APPS, DEBUG_ONLY_APPS } = require('../lib/apps');
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
  const desktopIds = DESKTOP_APPS.map(([id]) => id);
  const localDesktopIds = LOCAL_CANDIDATE_APPS.map(([id]) => id);
  const debugIds = DEBUG_ONLY_APPS.map(([id]) => id);
  assert(!desktopIds.includes('heroes2_demo'), 'the local demo is not exposed on the public desktop');
  assert(localDesktopIds.includes('heroes2_demo'), 'Heroes II is on the localhost desktop');
  assert(debugIds.includes('heroes2_demo'), 'Heroes II remains reachable in the debug selector');

  const app = APPS.heroes2_demo;
  assert.deepStrictEqual(app.persistFiles, ['c:\\*.gm?', 'c:\\*.gmc']);

  const storage = new MemoryStorage();
  const first = new VirtualFS();
  const persistence = VfsPersistence.attach(first, {
    appId: 'heroes2_demo',
    patterns: app.persistFiles,
    storage,
  });

  const autosave = first.createFile('C:\\AUTOSAVE.GM1', 0x40000000, 2);
  first.writeFile(autosave, Uint8Array.from([0x48, 0x32, 0x01]), 3);
  const campaign = first.createFile('C:\\ROLAND.GMC', 0x40000000, 2);
  first.writeFile(campaign, Uint8Array.from([0x43, 0x41, 0x4d]), 3);
  const unrelated = first.createFile('C:\\README.TXT', 0x40000000, 2);
  first.writeFile(unrelated, Uint8Array.from([0]), 1);
  await Promise.resolve();
  persistence.flush();
  assert.strictEqual(storage.length, 2, 'only Heroes II save formats persist');

  const second = new VirtualFS();
  const restored = VfsPersistence.attach(second, {
    appId: 'heroes2_demo',
    patterns: app.persistFiles,
    storage,
  });
  assert.strictEqual(restored.restored, 2, 'both save formats restore on relaunch');
  assert.deepStrictEqual(Array.from(second.files.get('c:\\autosave.gm1').data), [0x48, 0x32, 0x01]);
  assert.deepStrictEqual(Array.from(second.files.get('c:\\roland.gmc').data), [0x43, 0x41, 0x4d]);

  console.log('PASS  Heroes II localhost desktop launch persists GM1-GM6 and GMC saves');
}

run().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});

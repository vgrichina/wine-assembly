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
  const savedWriteTime = { lo: 0x89abcdef, hi: 0x01bf53eb };
  assert.strictEqual(first.setFileTimes(save, null, null, savedWriteTime), 0);
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
  assert.deepStrictEqual(second.files.get('c:\\save\\game00.sav').lastWriteTime, savedWriteTime,
    'persistent files keep their Win32 last-write timestamp');

  second.deleteFile('c:\\save\\game00.sav');
  restored.flush();
  assert.strictEqual(storage.length, 0, 'deleting a save removes its persisted copy');

  const bounded = new VirtualFS();
  const boundedPersistence = VfsPersistence.attach(bounded, {
    appId: 'diablo_demo',
    patterns: ['c:\\save\\*.sav'],
    maxFileBytes: 3,
    storage,
  });
  const tooLarge = bounded.createFile('c:\\save\\level1.sav', 0x40000000, 2);
  bounded.writeFile(tooLarge, Uint8Array.from([1, 2, 3, 4]), 4);
  await Promise.resolve();
  assert.strictEqual(storage.length, 0, 'oversized files are not written to localStorage');
  assert.strictEqual(boundedPersistence.pendingCount, 1, 'oversized saves remain visibly unsaved');
  assert.strictEqual(boundedPersistence.lastFlush.saved, 0);

  const flakyStorage = new MemoryStorage();
  let failWrites = true;
  let failDeletes = false;
  let attempts = 0;
  flakyStorage.setItem = function (key, value) {
    attempts++;
    if (failWrites && key.includes('retry.sav')) throw new Error('quota exceeded');
    MemoryStorage.prototype.setItem.call(this, key, value);
  };
  flakyStorage.removeItem = function (key) {
    attempts++;
    if (failDeletes) throw new Error('storage unavailable');
    MemoryStorage.prototype.removeItem.call(this, key);
  };
  const retryVfs = new VirtualFS();
  const reports = [];
  const retry = VfsPersistence.attach(retryVfs, {
    appId: 'retry_test', patterns: ['c:\\save\\*.sav'], storage: flakyStorage,
    onFlush: report => reports.push(report),
  });
  const retryHandle = retryVfs.createFile('c:\\save\\retry.sav', 0x40000000, 2);
  retryVfs.writeFile(retryHandle, Uint8Array.from([7, 8]), 2);
  retryVfs.createFile('c:\\save\\other.sav', 0x40000000, 2);
  assert.strictEqual(retry.flush(), 1, 'flush counts durable saves, not attempts');
  assert.deepStrictEqual(retry.lastFlush, { attempted: 2, saved: 1, failed: 1, pending: 1 });
  await Promise.resolve();
  await Promise.resolve();
  assert.strictEqual(attempts, 2, 'a failed flush does not requeue itself or run its stale microtask');
  assert.strictEqual(retry.lastFlush.failed, 1, 'a stale microtask cannot erase the failure report');
  failWrites = false;
  assert.strictEqual(retry.flush(), 1, 'an explicit flush retries without another file mutation');
  assert.strictEqual(retry.pendingCount, 0);
  assert.deepStrictEqual(reports.map(report => report.pending), [1, 0],
    'flush notifications report failure and subsequent recovery without an intervening stale flush');
  const restoredRetry = new VirtualFS();
  VfsPersistence.attach(restoredRetry, {
    appId: 'retry_test', patterns: ['c:\\save\\*.sav'], storage: flakyStorage,
  });
  assert.deepStrictEqual(Array.from(restoredRetry.files.get('c:\\save\\retry.sav').data), [7, 8]);

  failDeletes = true;
  retryVfs.deleteFile('c:\\save\\retry.sav');
  await Promise.resolve();
  assert.strictEqual(retry.pendingCount, 1, 'failed deletion retains its tombstone intent');
  const attemptsAfterDelete = attempts;
  await Promise.resolve();
  assert.strictEqual(attempts, attemptsAfterDelete, 'failed auto-flush has no busy retry loop');
  failDeletes = false;
  retryVfs.createFile('c:\\save\\wake.sav', 0x40000000, 2);
  await Promise.resolve();
  assert.strictEqual(retry.pendingCount, 0, 'the next mutation retries the failed deletion');
  assert.strictEqual(flakyStorage.length, 2, 'the deleted save is gone and other files remain');

  failWrites = true;
  retryVfs.createFile('c:\\save\\retry.sav', 0x40000000, 2);
  assert.strictEqual(retry.detach(), 0, 'detach reports a failed final flush truthfully');
  assert.strictEqual(retry.pendingCount, 1, 'detach keeps failures retryable on the retained handle');
  failWrites = false;
  assert.strictEqual(retry.flush(), 1);

  const observerVfs = new VirtualFS();
  const observer = VfsPersistence.attach(observerVfs, {
    appId: 'observer', patterns: ['c:\\save\\*.sav'], storage: new MemoryStorage(),
    onFlush() { throw new Error('UI observer failed'); },
  });
  observerVfs.createFile('c:\\save\\game.sav', 0x40000000, 2);
  assert.strictEqual(observer.flush(), 1, 'a failing observer cannot turn a durable save into a failure');
  assert.strictEqual(observer.pendingCount, 0);

  const { createBrowserShell, persistenceFlushReporter } = require('../lib/browser-shell');
  const oldDocument = global.document;
  const oldWindow = global.window;
  const status = { textContent: '' };
  const log = { textContent: '' };
  global.document = { getElementById: id => id === 'status' ? status : null };
  global.window = {};
  try {
    const shell = createBrowserShell({ apps: {} });
    const firstWine = { stop() {} };
    const secondWine = { stop() {} };
    let currentWine = firstWine;
    const reportFirst = persistenceFlushReporter(currentWine, 'first', log, shell.runningApps);
    shell.runningApps.push({ wine: firstWine, name: 'first' });
    currentWine = secondWine;
    const reportSecond = persistenceFlushReporter(currentWine, 'second', log, shell.runningApps);
    shell.runningApps.push({ wine: secondWine, name: 'second' });
    reportFirst({ pending: 1 });
    assert(firstWine._vfsPersistenceWarning.startsWith('first:'));
    assert.strictEqual(secondWine._vfsPersistenceWarning, undefined,
      'saving app A after launching B still reports against A');
    reportSecond({ pending: 2 });
    const secondWarning = secondWine._vfsPersistenceWarning;
    reportFirst({ pending: 0 });
    assert.strictEqual(status.textContent, secondWarning, 'recovering A does not clear B warning');
    firstWine._vfsPersistence = { flush: () => reportFirst({ pending: 1 }) };
    shell.stopRunningApp(shell.runningApps[0]);
    assert.strictEqual(shell.runningApps.length, 1);
    assert(status.textContent.startsWith('first:'), 'stopping A preserves its failed final-flush warning');
    assert.strictEqual(secondWine._vfsPersistenceWarning, secondWarning);
    reportFirst({ pending: 0 });
    assert.strictEqual(status.textContent, secondWarning, 'recovery restores the remaining app warning');
    reportSecond({ pending: 0 });
    assert.strictEqual(status.textContent, 'Running 1 app(s)');
    assert(log.textContent.includes('first: pending save files saved'));
  } finally {
    if (oldDocument === undefined) delete global.document; else global.document = oldDocument;
    if (oldWindow === undefined) delete global.window; else global.window = oldWindow;
  }

  console.log('PASS  Browser VFS persistence restores only bounded opt-in app files');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});

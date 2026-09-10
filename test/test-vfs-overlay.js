#!/usr/bin/env node
// Writable C:\ overlay — phase ⑤ of docs/design-byo-media.md.
//
// Every case here is one line of that doc's "Overlay semantics" section:
// copy-on-write over a mounted base file (both branches), create, delete as a
// whiteout that enumeration honours, rename, the read-only-drive rule, and a
// hydration round trip that is byte-exact through the on-disk Node store.
//
// No emulator: this is the VFS and the two lib/ files, so it runs in a second
// and a failure names the rule it broke rather than an app that stopped.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { VirtualFS } = require('../lib/filesystem');
const VfsOverlay = require('../lib/vfs-overlay');
const {
  memoryStore, nodeDirStore, opfsStore, removeOpfsScope, assertStore, metaOf,
} = require('../lib/overlay-store');
const byteProvider = require('../lib/byte-provider');

const browserShellSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'browser-shell.js'), 'utf8');
assert.match(browserShellSource,
  /wine\._vfsOverlayTimer = wine\._vfsOverlayDurable \? setInterval/,
  'session imports must not repeatedly clone their growing installer output into a memory store');
assert.match(browserShellSource,
  /if \(wine\._vfsOverlayDurable\) void flushBrowserOverlay\(wine, 'stop'\)/,
  'stopping a session import must not serialize its live VFS into a redundant memory copy');

const GENERIC_WRITE = 0x40000000;
const GENERIC_READ = 0x80000000;
const GENERIC_ALL = 0x10000000;
const CREATE_ALWAYS = 2;
const OPEN_EXISTING = 3;

let failures = 0;
const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

function bytes(text) { return new Uint8Array(Buffer.from(text, 'latin1')); }
function text(data) { return Buffer.from(data).toString('latin1'); }

function writeGuestFile(vfs, guestPath, contents) {
  const handle = vfs.createFile(guestPath, GENERIC_WRITE, CREATE_ALWAYS);
  assert.ok(handle, `createFile(${guestPath}) failed`);
  const data = bytes(contents);
  const result = vfs.writeFile(handle, data, data.length);
  assert.ok(result.ok, `writeFile(${guestPath}) failed`);
  vfs.closeHandle(handle);
  return handle;
}

function enumerate(vfs, pattern) {
  const first = vfs.findFirstFile(pattern);
  if (!first.handle) return [];
  const names = [first.entry.name];
  for (;;) {
    const next = vfs.findNextFile(first.handle);
    if (!next) break;
    names.push(next.name);
  }
  vfs.findClose(first.handle);
  return names.filter(n => n !== '.' && n !== '..');
}

// A base "mount": a zip/ISO-style provider-backed entry, exactly as
// lib/zip-mount.js and lib/iso9660.js create them. Deliberately async-only —
// no `readRangeSync` — because that is the shape of every interesting source
// (a remote Range read, an OPFS handle on the main thread) and the only one
// where copy-on-write has a question to answer.
class AsyncOnlyProvider {
  constructor(data, name) {
    this.bytes = data;
    this.size = data.length;
    this.name = name;
  }
  readRange(off, len) {
    return Promise.resolve(this.bytes.subarray(off, Math.min(this.size, off + len)));
  }
  close() {}
}

function notFound(name) {
  const error = new Error(`${name} was not found`);
  error.name = 'NotFoundError';
  return error;
}

// The four OPFS methods the store uses, backed by Maps so the browser backend
// can be proved across fresh store instances without a browser or IndexedDB.
class FakeOpfsFileHandle {
  constructor(dir, name) { this.dir = dir; this.name = name; }
  async getFile() {
    if (!this.dir.files.has(this.name)) throw notFound(this.name);
    const snapshot = new Uint8Array(this.dir.files.get(this.name));
    return {
      size: snapshot.length,
      arrayBuffer: async () => snapshot.buffer.slice(
        snapshot.byteOffset, snapshot.byteOffset + snapshot.byteLength),
    };
  }
  async createWritable() {
    let staged = new Uint8Array(0);
    let finished = false;
    return {
      write: async value => { staged = new Uint8Array(value); },
      close: async () => {
        if (finished) return;
        this.dir.files.set(this.name, new Uint8Array(staged));
        finished = true;
      },
      abort: async () => { finished = true; },
    };
  }
}

// Web Locks model: independent store instances share an origin lock manager.
class FakeLocks {
  constructor() { this.names = new Map(); }
  request(name, options, callback) {
    let state = this.names.get(name);
    if (!state) this.names.set(name, state = { active: [], queue: [] });
    return new Promise((resolve, reject) => {
      const job = { options, callback, resolve, reject };
      const available = () => !state.active.length ||
        (options.mode === 'shared' && state.active.every(j => j.options.mode === 'shared'));
      if (options.ifAvailable && (!available() || state.queue.length)) {
        Promise.resolve().then(() => callback(null)).then(resolve, reject);
        return;
      }
      state.queue.push(job);
      const drain = () => {
        while (state.queue.length) {
          const next = state.queue[0];
          if (state.active.length && (next.options.mode !== 'shared' ||
              state.active.some(j => j.options.mode !== 'shared'))) return;
          state.queue.shift();
          state.active.push(next);
          Promise.resolve().then(() => next.callback({ name })).then(next.resolve, next.reject)
            .finally(() => { state.active.splice(state.active.indexOf(next), 1); drain(); });
        }
      };
      drain();
    });
  }
}
const locks = new FakeLocks();

test('OPFS writers serialize fresh indexes and reclaim obsolete immutable blobs', async () => {
  const root = new FakeOpfsDirectoryHandle();
  const a = opfsStore('writers', { root, locks });
  const b = opfsStore('writers', { root, locks });
  const file = (path, data) => ({ path, kind: 'file', data: bytes(data) });
  await Promise.all([a.list(), b.list()]);
  await Promise.all([a.writeBatch([file('a', 'AAA')]), b.writeBatch([file('b', 'BBB')])]);
  assert.strictEqual(text(await a.read('a')), 'AAA');
  assert.strictEqual(text(await b.read('b')), 'BBB');
  assert.strictEqual((await a.list()).length, 2);
  await b.writeBatch([file('a', 'NEW')]);
  await opfsStore('writers', { root, locks }).list();
  assert.strictEqual(text(await a.read('a')), 'NEW');
  await b.list();
  const blobDir = [...root.dirs.get('wine-assembly').dirs.get('overlays').dirs.values()][0].dirs.get('blobs');
  assert.strictEqual(blobDir.files.size, 2, 'obsolete blobs are reclaimed after commit');
  await assert.rejects(opfsStore('unsafe', { root, locks: {} }).list(), /Web Locks/);
});

test('OPFS failed index publication preserves data and recovers without orphan collisions', async () => {
  const root = new FakeOpfsDirectoryHandle();
  const store = opfsStore('failure', { root, locks });
  const file = data => ({ path: 'save', kind: 'file', data: bytes(data) });
  await store.writeBatch([file('OLD')]);
  const original = FakeOpfsFileHandle.prototype.createWritable;
  FakeOpfsFileHandle.prototype.createWritable = async function () {
    const writable = await original.call(this);
    if (this.name === 'index.json') writable.close = async () => { throw new Error('index failure'); };
    return writable;
  };
  try {
    await assert.rejects(store.writeBatch([file('NEW-LONG')]), /index failure/);
    await assert.rejects(store.remove('save'), /index failure/);
  } finally { FakeOpfsFileHandle.prototype.createWritable = original; }
  assert.strictEqual(text(await store.read('save')), 'OLD');
  assert.strictEqual(text(await opfsStore('failure', { root, locks }).read('save')), 'OLD');
  await store.writeBatch([file('RETRY')]);
  assert.strictEqual(text(await store.read('save')), 'RETRY');
});

test('OPFS hydration captures one index and holds writers until snapshot reads complete', async () => {
  const root = new FakeOpfsDirectoryHandle();
  const a = opfsStore('snapshot', { root, locks });
  const b = opfsStore('snapshot', { root, locks });
  await a.writeBatch([
    { path: 'c:\\a', kind: 'file', data: bytes('OLD-A') },
    { path: 'c:\\b', kind: 'file', data: bytes('OLD-B') },
  ]);
  let unblock, started;
  const gate = new Promise(resolve => { unblock = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  let indexReads = 0, blocked = false;
  const original = FakeOpfsFileHandle.prototype.getFile;
  FakeOpfsFileHandle.prototype.getFile = async function () {
    if (this.name === 'index.json') indexReads++;
    if (this.name.endsWith('.bin') && !blocked) {
      blocked = true; started(); await gate;
    }
    return original.call(this);
  };
  try {
    const vfs = new VirtualFS();
    const hydrate = VfsOverlay.attach(vfs, { store: a }).hydrate();
    await entered;
    let written = false;
    const writer = b.writeBatch([{ path: 'c:\\b', kind: 'file', data: bytes('NEW-B') }])
      .then(() => { written = true; });
    await Promise.resolve();
    assert.strictEqual(written, false);
    assert.strictEqual(indexReads, 1, 'hydration reads the index once for all files');
    unblock();
    await hydrate;
    await writer;
    assert.strictEqual(text(vfs.files.get('c:\\a').data), 'OLD-A');
    assert.strictEqual(text(vfs.files.get('c:\\b').data), 'OLD-B');
    assert.strictEqual(text(await a.read('c:\\b')), 'NEW-B');
  } finally { unblock(); FakeOpfsFileHandle.prototype.getFile = original; }
});


test('Node failed replacement and deletion keep the old committed bytes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-overlay-atomic-'));
  const store = nodeDirStore(dir);
  const file = data => ({ path: 'save', kind: 'file', data: bytes(data) });
  try {
    await store.writeBatch([file('OLD')]);
    const rename = fs.renameSync;
    fs.renameSync = () => { throw new Error('index rename failure'); };
    try {
      await assert.rejects(store.writeBatch([file('NEW-LONG')]), /index rename failure/);
      await assert.rejects(store.remove('save'), /index rename failure/);
    } finally { fs.renameSync = rename; }
    assert.strictEqual(text(await store.read('save')), 'OLD');
    assert.strictEqual(text(await nodeDirStore(dir).read('save')), 'OLD');
    await store.writeBatch([file('RETRY')]);
    assert.strictEqual(text(await store.read('save')), 'RETRY');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

class FakeOpfsDirectoryHandle {
  constructor() {
    this.dirs = new Map();
    this.files = new Map();
  }
  async getDirectoryHandle(name, options) {
    if (!this.dirs.has(name)) {
      if (!options || !options.create) throw notFound(name);
      this.dirs.set(name, new FakeOpfsDirectoryHandle());
    }
    return this.dirs.get(name);
  }
  async getFileHandle(name, options) {
    if (!this.files.has(name)) {
      if (!options || !options.create) throw notFound(name);
      this.files.set(name, new Uint8Array(0));
    }
    return new FakeOpfsFileHandle(this, name);
  }
  async removeEntry(name) {
    if (this.files.delete(name)) return;
    if (this.dirs.delete(name)) return;
    throw notFound(name);
  }
  async *keys() {
    for (const name of this.dirs.keys()) yield name;
    for (const name of this.files.keys()) yield name;
  }
}

function mountProviderFile(vfs, guestPath, contents) {
  const provider = new AsyncOnlyProvider(bytes(contents), guestPath);
  return vfs.setProviderFile(guestPath, {
    provider: byteProvider.cached(provider), attrs: 0x20,
  });
}

// ---------------------------------------------------------------- semantics

test('store interface is validated at attach, not at eviction time', () => {
  assert.throws(() => assertStore({ list() {}, read() {} }, 'x'), /missing writeBatch/);
  assert.throws(() => VfsOverlay.attach(new VirtualFS(), { store: {} }), /missing list/);
});

test('create, modify and delete are journalled as file/whiteout records', async () => {
  const vfs = new VirtualFS();
  const store = memoryStore();
  const overlay = VfsOverlay.attach(vfs, { store });

  writeGuestFile(vfs, 'C:\\keep.txt', 'hello');
  vfs.createDirectory('C:\\sub');
  writeGuestFile(vfs, 'C:\\sub\\gone.txt', 'temporary');
  assert.ok(vfs.deleteFile('C:\\sub\\gone.txt'));

  const report = await overlay.flush();
  assert.strictEqual(report.failed, 0, JSON.stringify(report.errors));
  const records = await store.list();
  const byPath = new Map(records.map(r => [r.path, r]));
  assert.strictEqual(byPath.get('c:\\keep.txt').kind, 'file');
  assert.strictEqual(byPath.get('c:\\keep.txt').size, 5);
  assert.strictEqual(byPath.get('c:\\sub').kind, 'dir');
  assert.strictEqual(byPath.get('c:\\sub\\gone.txt').kind, 'whiteout',
    'a deleted file must be recorded as a whiteout, not simply forgotten');
});

test('a whiteout survives re-mounting the base: enumeration does not resurrect it', async () => {
  const store = memoryStore();

  const first = new VirtualFS();
  mountProviderFile(first, 'C:\\game\\data.dat', 'from the archive');
  mountProviderFile(first, 'C:\\game\\readme.txt', 'read me');
  const overlay = VfsOverlay.attach(first, { store });
  assert.deepStrictEqual(enumerate(first, 'C:\\game\\*').sort(),
    ['data.dat', 'readme.txt']);
  assert.ok(first.deleteFile('C:\\game\\readme.txt'));
  await overlay.flush();

  // Second process: the base mount runs again, then the overlay replays.
  const second = new VirtualFS();
  mountProviderFile(second, 'C:\\game\\data.dat', 'from the archive');
  mountProviderFile(second, 'C:\\game\\readme.txt', 'read me');
  const replay = VfsOverlay.attach(second, { store });
  const report = await replay.hydrate();
  assert.strictEqual(report.whiteouts, 1);
  assert.deepStrictEqual(enumerate(second, 'C:\\game\\*'), ['data.dat'],
    'FindFirstFile over the re-mounted base resurrected a deleted file');
  assert.strictEqual(second.getFileAttributes('C:\\game\\readme.txt'), 0xFFFFFFFF);
});

test('copy-on-write over a resident base file keeps the base mount intact', async () => {
  const store = memoryStore();
  const first = new VirtualFS();
  mountProviderFile(first, 'C:\\game\\config.ini', 'volume=5');
  // Case 1 of the doc's three: pre-materialized, so the bytes are resident.
  await first.materialize('C:\\game\\config.ini');
  const overlay = VfsOverlay.attach(first, { store });
  writeGuestFile(first, 'C:\\game\\config.ini', 'volume=9');
  await overlay.flush();

  const second = new VirtualFS();
  mountProviderFile(second, 'C:\\game\\config.ini', 'volume=5');
  const replay = VfsOverlay.attach(second, { store });
  await replay.hydrate();
  const entry = second.files.get('c:\\game\\config.ini');
  assert.strictEqual(text(entry.data), 'volume=9',
    'the overlay copy must win over the base mount');
});

test('an unresident provider file opened for write fails loudly, not silently', () => {
  for (const [name, access] of [
    ['GENERIC_WRITE', GENERIC_WRITE],
    ['GENERIC_ALL', GENERIC_ALL],
  ]) {
    const vfs = new VirtualFS();
    mountProviderFile(vfs, 'C:\\game\\big.dat', 'x'.repeat(64));
    const overlay = VfsOverlay.attach(vfs, { store: memoryStore() });
    // Case 2: nothing has filled the chunk cache, so CreateFile-for-write has
    // no synchronous way to copy on write and must not pretend otherwise.
    const handle = vfs.createFile('C:\\game\\big.dat', access, OPEN_EXISTING);
    assert.strictEqual(handle, 0,
      `${name} must fail at open rather than park later in WriteFile`);
    assert.strictEqual(overlay.lastError, VfsOverlay.ERROR_NOT_READY);
    assert.strictEqual(overlay.errors.length, 1);
    assert.match(overlay.errors[0].message, /materialize/);
    // Read-only opens of the same file are unaffected.
    const reader = vfs.createFile('C:\\game\\big.dat', GENERIC_READ, OPEN_EXISTING);
    assert.ok(reader, 'a read-only open of a lazy entry must still succeed');
  }
});

test('a read-only drive refuses every mutation with ERROR_WRITE_PROTECT', () => {
  const vfs = new VirtualFS();
  mountProviderFile(vfs, 'D:\\setup\\install.dat', 'disc');
  vfs.setDriveReadOnly('D', true);
  const overlay = VfsOverlay.attach(vfs, { store: memoryStore() });

  const refusals = [
    ['createFile', () => vfs.createFile('D:\\new.txt', GENERIC_WRITE, CREATE_ALWAYS)],
    ['deleteFile', () => vfs.deleteFile('D:\\setup\\install.dat')],
    ['createDirectory', () => vfs.createDirectory('D:\\newdir')],
    ['removeDirectory', () => vfs.removeDirectory('D:\\setup')],
    ['moveFile', () => vfs.moveFile('D:\\setup\\install.dat', 'D:\\moved.dat')],
    ['copyFile', () => vfs.copyFile('D:\\setup\\install.dat', 'D:\\copy.dat', 0)],
    ['setFileAttributes', () => vfs.setFileAttributes('D:\\setup\\install.dat', 0x80)],
  ];
  for (const [name, run] of refusals) {
    overlay.lastError = 0;
    vfs.lastFsError = 0;
    assert.ok(!run(), `${name} on a read-only drive must fail`);
    assert.strictEqual(overlay.lastError, VfsOverlay.ERROR_WRITE_PROTECT,
      `${name} did not latch ERROR_WRITE_PROTECT`);
    assert.strictEqual(vfs.lastFsError, VfsOverlay.ERROR_WRITE_PROTECT);
  }
  assert.deepStrictEqual(overlay.dirtyPaths(), [],
    'nothing on a read-only drive may enter the journal');
});

test('rename records the whiteout and the create in one batch', async () => {
  const store = memoryStore();
  const first = new VirtualFS();
  const overlay = VfsOverlay.attach(first, { store });
  writeGuestFile(first, 'C:\\notes.txt', 'draft');
  assert.ok(first.moveFile('C:\\notes.txt', 'C:\\final.txt'));
  await overlay.flush();

  const second = new VirtualFS();
  await VfsOverlay.attach(second, { store }).hydrate();
  assert.deepStrictEqual(enumerate(second, 'C:\\*.txt'), ['final.txt']);
  assert.strictEqual(text(second.files.get('c:\\final.txt').data), 'draft');
});

test('paths are journalled under VirtualFS normalization, case-folded once', async () => {
  const store = memoryStore();
  const first = new VirtualFS();
  const overlay = VfsOverlay.attach(first, { store });
  writeGuestFile(first, 'C:\\Docs\\Mixed Case.TXT', 'one');
  // The same file under a different spelling must update the same record.
  writeGuestFile(first, 'c:/docs/./mixed case.txt', 'two');
  await overlay.flush();
  const records = await store.list();
  const files = records.filter(r => r.kind === 'file');
  assert.strictEqual(files.length, 1, 'two spellings produced two records');
  assert.strictEqual(files[0].path, 'c:\\docs\\mixed case.txt');

  const second = new VirtualFS();
  await VfsOverlay.attach(second, { store }).hydrate();
  assert.strictEqual(text(second.files.get('c:\\docs\\mixed case.txt').data), 'two');
});

// -------------------------------------------------------------- OPFS store

test('the browser OPFS store survives reload byte-exactly and isolates imports', async () => {
  const root = new FakeOpfsDirectoryHandle();
  const first = new VirtualFS();
  first.files.set('c:\\old.txt', { data: bytes('base'), attrs: 0x20 });
  const overlay = VfsOverlay.attach(first, {
    store: opfsStore('kept-disc-a', { root, locks }),
  });
  writeGuestFile(first, 'C:\\installed\\game.exe', 'MZ\0browser overlay');
  assert.ok(first.deleteFile('C:\\old.txt'));
  const flushed = await overlay.flush();
  assert.deepStrictEqual({ written: flushed.written, failed: flushed.failed },
    { written: 2, failed: 0 });

  // A new store object is a reload: no in-memory map is shared with the first.
  const second = new VirtualFS();
  second.files.set('c:\\old.txt', { data: bytes('base'), attrs: 0x20 });
  const replay = VfsOverlay.attach(second, {
    store: opfsStore('kept-disc-a', { root, locks }),
  });
  const hydrated = await replay.hydrate();
  assert.deepStrictEqual(
    { files: hydrated.files, whiteouts: hydrated.whiteouts, errors: hydrated.errors.length },
    { files: 1, whiteouts: 1, errors: 0 });
  assert.strictEqual(text(second.files.get('c:\\installed\\game.exe').data),
    'MZ\0browser overlay');
  assert.ok(!second.files.has('c:\\old.txt'), 'the OPFS whiteout resurrected after reload');

  const other = opfsStore('kept-disc-b', { root, locks });
  assert.deepStrictEqual(await other.list(), [],
    'one imported disc must not see another import\'s writable C: journal');
  assert.strictEqual(await removeOpfsScope('kept-disc-a', { root, locks }), true);
  assert.deepStrictEqual(await opfsStore('kept-disc-a', { root, locks }).list(), [],
    'removing a kept import must remove its otherwise-unreachable C: journal');
  assert.strictEqual(await removeOpfsScope('missing-disc', { root, locks }), false);
});

test('overlay metadata keeps safe-integer sizes instead of wrapping at 2GB', () => {
  const size = 0x80000001;
  assert.strictEqual(metaOf({ path: 'c:\\large.bin', kind: 'file', size }).size, size);
  assert.throws(() => metaOf({ path: 'c:\\bad.bin', kind: 'file', size: Number.MAX_SAFE_INTEGER + 1 }),
    /safe integer/);
});

// --------------------------------------------------------------- node store

test('the Node store round-trips a tree byte-exactly across processes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-overlay-'));
  const payloads = {
    'C:\\app\\app.exe': Buffer.alloc(3 * 1024 * 1024, 0xAB), // past the 2MB localStorage cap
    'C:\\app\\config.ini': Buffer.from('[Setup]\r\nDir=C:\\app\r\n', 'latin1'),
    'C:\\app\\data\\level.dat': Buffer.from([0, 1, 2, 253, 254, 255]),
  };

  const first = new VirtualFS();
  const overlay = VfsOverlay.attach(first, { store: nodeDirStore(dir) });
  for (const [guestPath, buffer] of Object.entries(payloads)) {
    const handle = first.createFile(guestPath, GENERIC_WRITE, CREATE_ALWAYS);
    assert.ok(handle, guestPath);
    const data = new Uint8Array(buffer);
    first.writeFile(handle, data, data.length);
    first.closeHandle(handle);
  }
  const report = await overlay.flush();
  assert.strictEqual(report.failed, 0, JSON.stringify(report.errors));
  assert.ok(fs.existsSync(path.join(dir, 'index.json')));

  // A brand new process: a new store object over the same directory.
  const second = new VirtualFS();
  const replay = VfsOverlay.attach(second, { store: nodeDirStore(dir) });
  const hydrated = await replay.hydrate();
  assert.strictEqual(hydrated.files, 3, JSON.stringify(replay.errors));
  assert.strictEqual(replay.errors.length, 0, JSON.stringify(replay.errors));
  for (const [guestPath, buffer] of Object.entries(payloads)) {
    const entry = second.files.get(second._resolvePath(guestPath));
    assert.ok(entry, `${guestPath} did not come back`);
    assert.ok(Buffer.from(entry.data).equals(buffer), `${guestPath} is not byte-exact`);
  }
  assert.ok(second.dirs.has('c:\\app\\data'),
    'hydration must recreate the parent directories the files need');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a short blob is reported, never mounted as a truncated file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-overlay-torn-'));
  const first = new VirtualFS();
  const overlay = VfsOverlay.attach(first, { store: nodeDirStore(dir) });
  writeGuestFile(first, 'C:\\torn.bin', 'abcdefghij');
  await overlay.flush();

  const blobs = fs.readdirSync(path.join(dir, 'blobs'));
  assert.strictEqual(blobs.length, 1);
  fs.writeFileSync(path.join(dir, 'blobs', blobs[0]), Buffer.from('abc'));

  const second = new VirtualFS();
  const replay = VfsOverlay.attach(second, { store: nodeDirStore(dir) });
  const report = await replay.hydrate();
  assert.strictEqual(report.files, 0);
  assert.strictEqual(replay.errors.length, 1);
  assert.match(replay.errors[0].message, /3 bytes, index says 10/);
  assert.ok(!second.files.has('c:\\torn.bin'),
    'a torn blob must not be mounted at all');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a failing store is held in errors, not swallowed', async () => {
  const vfs = new VirtualFS();
  const backing = memoryStore();
  let attempts = 0;
  const broken = {
    list: () => backing.list(),
    read: path => backing.read(path),
    writeBatch: records => (++attempts === 1
      ? Promise.reject(new Error('QuotaExceededError'))
      : backing.writeBatch(records)),
    remove: path => backing.remove(path),
  };
  const overlay = VfsOverlay.attach(vfs, { store: broken });
  writeGuestFile(vfs, 'C:\\save.dat', 'progress');
  const first = await overlay.flush();
  assert.strictEqual(first.written, 0);
  assert.strictEqual(first.failed, 1);
  assert.match(overlay.errors[0].message, /QuotaExceededError/);
  assert.deepStrictEqual(overlay.dirtyPaths(), ['c:\\save.dat'],
    'a failed store write must restore the consumed dirty mark');

  writeGuestFile(vfs, 'C:\\save.dat', 'new progress');
  const retry = await overlay.flush();
  assert.strictEqual(retry.written, 1);
  assert.strictEqual(retry.failed, 0);
  assert.deepStrictEqual(overlay.dirtyPaths(), []);
  assert.strictEqual(text(await backing.read('c:\\save.dat')), 'new progress',
    'the retry persists the current VFS state, not the failed snapshot');
});

test('a queued flush snapshots bytes before later guest writes', async () => {
  const vfs = new VirtualFS();
  const store = memoryStore();
  const overlay = VfsOverlay.attach(vfs, { store });
  const handle = vfs.createFile('C:\\slot.sav', GENERIC_WRITE, CREATE_ALWAYS);
  assert.ok(handle);
  assert.ok(vfs.writeFile(handle, bytes('old'), 3).ok);

  // recordFor() runs synchronously, but writeBatch() starts on the promise
  // chain. Mutate the same capacity buffer before that microtask consumes the
  // record; without a snapshot, the first flush stores "new" retroactively.
  const first = overlay.flush();
  assert.strictEqual(vfs.setFilePointer(handle, 0, 0), 0);
  assert.ok(vfs.writeFile(handle, bytes('new'), 3).ok);
  await first;
  assert.strictEqual(text(await store.read('c:\\slot.sav')), 'old',
    'an in-flight record is an immutable point-in-time snapshot');
  assert.deepStrictEqual(overlay.dirtyPaths(), ['c:\\slot.sav'],
    'the later write remains pending after the earlier snapshot lands');

  await overlay.flush();
  assert.strictEqual(text(await store.read('c:\\slot.sav')), 'new');
  vfs.closeHandle(handle);
});

test('detach flushes and restores the original VirtualFS methods', async () => {
  const vfs = new VirtualFS();
  const store = memoryStore();
  const before = vfs.writeFile;
  const overlay = VfsOverlay.attach(vfs, { store });
  assert.notStrictEqual(vfs.writeFile, before);
  writeGuestFile(vfs, 'C:\\late.txt', 'flushed by detach');
  await overlay.detach();
  assert.strictEqual(vfs.writeFile, before);
  assert.strictEqual((await store.list()).length, 1);
});

(async () => {
  for (const { name, fn } of cases) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (error) {
      failures++;
      console.log(`FAIL  ${name}`);
      console.log(`      ${error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n      ') : error}`);
    }
  }
  console.log(failures ? `\n${failures} failing` : `\nAll ${cases.length} overlay cases pass`);
  process.exit(failures ? 1 : 0);
})();
